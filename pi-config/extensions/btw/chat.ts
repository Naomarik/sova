/**
 * /btw's side thread as a hidden chat (al_3 stage 4): a worker chat of kind `btw`, started by Sova's
 * worker host (`../subagents/worker-host.ts`) in a process of its own, and driven from here. No pi
 * session is created in this process: a question is a `send`, and its answer is the run's last
 * assistant message, read from the chat's feed (or from its session file, for a run that settled
 * while nobody watched).
 *
 * The chat starts from a seed (the main thread's conversation, then the thread so far), with the
 * read/bash/edit/write tools, the worker marker (so Sova keeps its session out of every list) and
 * `./child.ts`, which replaces the system prompt with the one the parent wrote to a file: the main
 * thread's prompt plus the aside instructions. The file lives in the thread's run directory (0700,
 * file 0600) and goes when the chat is stopped. Node built-ins and the host's types only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MARK_EXTENSION } from "../subagents/fork/background.ts";
import { claudeCodeProviderLoad } from "../subagents/runner.ts";
import type { WorkerFeedFrame, WorkerHost, WorkerRef } from "../subagents/worker-host.ts";
import { BTW_PROMPT_ENV } from "./child.ts";

/** The btw chat's own extension, loaded last. */
export const BTW_CHILD_EXTENSION = fileURLToPath(new URL("./child.ts", import.meta.url));
/** The side thread's tools: pi's default coding set. */
export const BTW_TOOLS = ["read", "bash", "edit", "write"];

export type BtwChatMode = "contextual" | "tangent" | "summarize";

/** A btw chat's worker id: its mode, then a per-start nonce, so a session's next start never reuses a key. */
export function btwWorkerId(mode: BtwChatMode, nonce: string): string {
	return `btw-${mode}-${nonce}`;
}

/** The mode a btw worker id names, or undefined for another id. */
export function btwChatMode(workerId: string): BtwChatMode | undefined {
	const mode = /^btw-(contextual|tangent|summarize)-/.exec(workerId)?.[1];
	return mode as BtwChatMode | undefined;
}

export interface BtwAssistant {
	role: "assistant";
	content: unknown;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	api?: string;
	usage?: unknown;
}

/** One answered question: the run's last assistant message, its entry id in the btw chat, and the question. */
export interface BtwAnswer {
	message: BtwAssistant;
	entryId?: string;
	question?: string;
}

/** A pi event the chat fed (the wire-1 shape of pi's rpc events). */
export type BtwFeedEvent = { type?: string; [key: string]: unknown };

export interface BtwChatStart {
	parent: { sessionId: string; path: string };
	mode: BtwChatMode;
	nonce: string;
	cwd: string;
	/** "provider/modelId". */
	model: string;
	thinking: string | null;
	/** The seed: pi messages written as the new session's branch. */
	messages: unknown[];
	/** The whole system prompt the chat runs with. */
	systemPrompt: string;
	/** `<agent dir>/btw`: the thread's run directory and its sessions go under it. */
	root: string;
	/** null = pi's default set. */
	tools: string[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => !!part && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => (part as { text: string }).text)
		.join("\n");
}

/** The last user question and assistant answer of a btw chat's session file, with the answer's entry id. */
export function lastExchange(sessionFile: string): BtwAnswer | undefined {
	let answer: BtwAnswer | undefined;
	let question: string | undefined;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"message"')) continue;
			let entry: { type?: string; id?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			if (entry.message.role === "user") {
				question = textOf(entry.message.content);
				answer = undefined;
			} else if (entry.message.role === "assistant") {
				answer = { message: entry.message as BtwAssistant, ...(entry.id ? { entryId: entry.id } : {}), ...(question !== undefined ? { question } : {}) };
			}
		}
	} catch {
		return undefined;
	}
	return answer;
}

/** A btw chat, started or reattached. One question at a time. */
export class BtwChat {
	readonly mode: BtwChatMode;
	sessionFile: string;
	private unwatch: (() => void) | undefined;
	private last: BtwAnswer | undefined;
	private lastQuestion: string | undefined;
	private sends = 0;
	private waiter: { key: string | null; resolve: (answer: BtwAnswer) => void; reject: (error: Error) => void } | undefined;
	private gone: Error | undefined;
	/** A reattached chat's last exchange (`attach`). */
	inFlight: Promise<BtwAnswer> | undefined;

	private constructor(
		private readonly host: WorkerHost,
		readonly ref: Pick<WorkerRef, "chatId" | "sessionFile" | "workerId">,
		private readonly runDir: string | undefined,
		private readonly onEvent: ((event: BtwFeedEvent) => void) | undefined,
	) {
		this.mode = btwChatMode(ref.workerId) ?? "contextual";
		this.sessionFile = ref.sessionFile;
	}

	/** Start the chat: write the prompt file, start the hidden chat from the seed, idle. Throws what the host refuses. */
	static async start(host: WorkerHost, start: BtwChatStart, onEvent?: (event: BtwFeedEvent) => void): Promise<BtwChat> {
		const workerId = btwWorkerId(start.mode, start.nonce);
		const runDir = join(start.root, ".runs", workerId);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const promptFile = join(runDir, "system-prompt.md");
		writeFileSync(promptFile, start.systemPrompt, { mode: 0o600 });
		const load = claudeCodeProviderLoad(start.model, [WORKER_MARK_EXTENSION], undefined);
		let ref: WorkerRef;
		try {
			ref = await host.start({
				key: `${start.parent.sessionId}:${workerId}`,
				spec: {
					kind: "btw",
					parent: { sessionId: start.parent.sessionId, path: start.parent.path, workerId },
					cwd: start.cwd,
					model: start.model,
					thinking: start.thinking,
					builtins: start.tools,
					extensions: [...load.extensions, BTW_CHILD_EXTENSION],
					flags: load.flags ?? {},
					appendSystemPrompt: null,
					env: { [BTW_PROMPT_ENV]: promptFile },
					agentDir: null,
					lowered: true,
				},
				session: { seed: { dir: join(start.root, ".sessions"), messages: start.messages } },
				task: null,
			});
		} catch (error) {
			rmSync(runDir, { recursive: true, force: true });
			throw error;
		}
		const chat = new BtwChat(host, ref, runDir, onEvent);
		chat.watch();
		return chat;
	}

	/**
	 * Watch a chat a closed session left (a reload, new code, a crash). `inFlight` resolves with its
	 * last exchange, from its file: at once when it is idle, else when the run under way settles.
	 */
	static attach(host: WorkerHost, ref: WorkerRef, root: string, onEvent?: (event: BtwFeedEvent) => void): BtwChat {
		const chat = new BtwChat(host, ref, join(root, ".runs", ref.workerId), onEvent);
		chat.inFlight = new Promise<BtwAnswer>((resolve, reject) => {
			chat.waiter = { key: null, resolve, reject };
		});
		// Nothing awaits it unless the run was under way.
		chat.inFlight.catch(() => {});
		chat.watch();
		return chat;
	}

	/** Ask one question; resolves with the run's answer (an error or aborted message included). */
	async ask(question: string): Promise<BtwAnswer> {
		if (this.gone) throw this.gone;
		if (this.waiter) throw new Error("BTW is still answering the previous question.");
		const key = `${this.ref.workerId}:q${++this.sends}:${Date.now().toString(36)}`;
		const answered = new Promise<BtwAnswer>((resolve, reject) => {
			this.waiter = { key, resolve, reject };
		});
		this.last = undefined;
		this.lastQuestion = question;
		try {
			await this.host.send(this.ref.chatId, { text: question, delivery: "prompt", key });
		} catch (error) {
			this.waiter = undefined;
			throw error;
		}
		return answered;
	}

	/** Stop the chat and remove its run directory. A question under way rejects. */
	async stop(reason: string): Promise<void> {
		this.detach();
		this.fail(new Error("BTW thread stopped."));
		await this.host.stop(this.ref.chatId, reason).catch(() => {});
		if (this.runDir) rmSync(this.runDir, { recursive: true, force: true });
	}

	/** Stop watching; the chat keeps running for the next session to reattach. */
	detach(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	private watch(): void {
		this.unwatch = this.host.watch(this.ref.chatId, null, (frame) => this.frame(frame));
	}

	private settle(answer: BtwAnswer | undefined): void {
		const waiter = this.waiter;
		if (!waiter) return;
		this.waiter = undefined;
		this.inFlight = undefined;
		// A reattached run began before this watch: its question and answer are in the file.
		if (waiter.key === null) answer = lastExchange(this.sessionFile) ?? answer;
		if (answer) waiter.resolve(answer);
		else waiter.reject(new Error("BTW request finished without a response."));
	}

	private fail(error: Error): void {
		const waiter = this.waiter;
		this.waiter = undefined;
		this.inFlight = undefined;
		waiter?.reject(error);
	}

	private frame(frame: WorkerFeedFrame): void {
		switch (frame.t) {
			case "state": {
				const state = frame.state;
				if (state.sessionFile) this.sessionFile = state.sessionFile;
				const waiter = this.waiter;
				if (!waiter || state.status === "running" || state.status === "starting") return;
				// Reattached to an idle chat: its last answer is in the file (the caller records it once).
				if (waiter.key === null) return this.settle(undefined);
				// Settled while nobody watched (or across a gap): the file has the answer. The host names a
				// settle by the send delivered before it, then `#<n-th settle in that process>`.
				const settled = state.lastSettled?.key;
				if (settled === waiter.key || settled?.startsWith(`${waiter.key}#`)) this.settle(lastExchange(this.sessionFile));
				return;
			}
			case "gap":
				return;
			case "ended":
				if (frame.cause === "idle" || frame.cause === "reload" || frame.resuming) return;
				this.gone = new Error(frame.cause === "killed" ? "BTW thread stopped." : `BTW thread ended: ${frame.detail ?? frame.cause}`);
				this.detach();
				this.fail(this.gone);
				return;
			case "event": {
				const event = frame.event as BtwFeedEvent;
				if (event.type === "message_end") {
					const message = event.message as { role?: string; content?: unknown } | undefined;
					if (message?.role === "user") this.lastQuestion = textOf(message.content);
					else if (message?.role === "assistant")
						this.last = {
							message: message as BtwAssistant,
							...(typeof event.entryId === "string" ? { entryId: event.entryId } : {}),
							...(this.lastQuestion !== undefined ? { question: this.lastQuestion } : {}),
						};
				}
				this.onEvent?.(event);
				if (event.type === "agent_settled") this.settle(this.last);
				return;
			}
		}
	}
}
