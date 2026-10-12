/**
 * Background forks: a hidden chat that works in a copy of the parent's conversation, on the
 * parent's prompt cache, under a policy, and reports back through `onSettled` — without opening a
 * session anyone sees. /explain runs one per page and /compact-handoff one per note; anything that
 * needs "the agent, with all this context, writes X on the side" starts one the same way. (Sova's
 * "Fork from here" is the other kind of fork: a new visible session, built by the server; its cache
 * identity is the same `./cache.ts`.)
 *
 * Hosting: Sova's worker host (`../worker-host.ts`). The fork is a worker chat of its own process,
 * started by the server from one loadout (kind `explain` or `handoff`), never a child of the
 * parent's process; the parent only watches its feed. So a parent that reloads, crashes or picks
 * up new code finds its forks still running: `reattachBackgroundForks` watches them again. Without
 * a host (the pi TUI) a fork can't start.
 *
 * The child is NOT a subagent in the `/agents` sense: it never appears in that monitor. It loads
 * the subagents worker marker (`../worker-mark.ts`) first, like every worker: its own session then
 * carries a `subagents-worker-session` entry, and Sova keeps it out of its session list.
 *
 * No tool restriction: the child's tools are the parent's, declared exactly as the parent declared
 * them, so the fork keeps the parent's prompt cache; `./child.ts` (loaded last) sets them up and
 * blocks every call its `ForkPolicy` does not allow. See mirror.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLAUDE_FORK_ENV, encodeForkPoint, parentForkPoint, type ClaudeForkPoint } from "../../claude-code/provider/fork-point.ts";
import { claudeCodeProviderLoad, rpcScopedModel } from "../runner.ts";
import {
	NO_WORKER_HOST,
	WORKER_HOST_DISCOVER_EVENT,
	WORKER_HOST_EVENT,
	type WorkerFeedFrame,
	type WorkerHost,
	type WorkerHostAnnouncement,
	type WorkerKind,
	type WorkerRef,
	type WorkerState,
} from "../worker-host.ts";
import { FORK_POLICY_ENV, type ForkPolicy } from "./mirror.ts";

export type BackgroundForkOutcome = "success" | "error" | "aborted";

/** The hidden-chat kinds a background fork runs as. */
export type BackgroundForkKind = Extract<WorkerKind, "explain" | "handoff">;

export interface BackgroundForkSpec {
	/** Sova's worker host for the parent's session (`workerHostOf`); none (the pi TUI) refuses the start. */
	host: WorkerHost | undefined;
	kind: BackgroundForkKind;
	/** The parent session; `path` is "" for a parent not on disk. */
	parent: { sessionId: string; path: string };
	/** Unique per run: the fork's worker id in its parent, and its start key. */
	id: string;
	/** Worker name, so a stray child is recognizable in its own session list. */
	name: string;
	/** The child's one prompt. */
	task: string;
	cwd: string;
	/** "provider/modelId"; a claude-code-cli model loads its provider into the child. */
	model?: string;
	effort?: string;
	/** Session file the child forks: a copy of the parent's (`copyForFork`); omitted for an unpersisted parent (the child starts fresh). */
	forkSession?: string;
	/** Where the child's own session file goes. */
	sessionDir: string;
	/** What the child may do beyond reading (child.ts enforces it per call). */
	policy: ForkPolicy;
	/** The parent's live Claude CLI session, for a claude-code-cli child to resume instead of folding. Only with `forkSession`. */
	claudeFork?: ClaudeForkPoint;
	/** Extra extension sources for the child (web search, …); loaded after the worker marker, before child.ts. */
	extensions?: string[];
}

export interface BackgroundForkResult {
	outcome: BackgroundForkOutcome;
	error?: string;
	/** The child's last assistant text. */
	finalOutput: string;
	/** Model the child reported for itself. */
	model?: string;
}

export interface BackgroundForkHandle {
	/** Model the child reported for itself, once its chat said. */
	readonly model?: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	/** Stop the child's chat. A run that had not settled settles once, as aborted. */
	stop(): Promise<void>;
	/** Stop watching, leaving the child running (the parent's session is closing; the next one reattaches). */
	detach(): void;
}

export interface BackgroundForkHandlers {
	/** The child finished its task (or definitively failed, or its chat is gone). Fires once per run. */
	onSettled(result: BackgroundForkResult): void;
}

/**
 * The subagents worker marker, loaded FIRST into the child — the same order subagents uses
 * (`MARKER_EXTENSION`). Its session_start entry is what hides the child's session from Sova's
 * Recent list; nothing else of the subagents extension comes with it.
 */
export const WORKER_MARK_EXTENSION = fileURLToPath(new URL("../worker-mark.ts", import.meta.url));

/** The child's own extension (child.ts), loaded LAST so its before_agent_start has the final word on the prompt. */
export const CHILD_EXTENSION = fileURLToPath(new URL("./child.ts", import.meta.url));

/**
 * Where a claude-code-cli parent's fork picks up: its live, idle CLI session in THIS process
 * (`claude --resume <parent> --fork-session`), so the child's first request is the prefix the
 * parent's last turn cached. Undefined for every other model, or when the parent's CLI session is
 * not live and in step; the child then folds the history (no cache).
 */
export function claudeForkPointFor(model: string | undefined, parentSessionId: string): ClaudeForkPoint | undefined {
	return rpcScopedModel(model) ? parentForkPoint(parentSessionId) : undefined;
}

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

/**
 * Sova's worker host for this session, as announced on its `pi.events` (either load order: asks for
 * an announcement once). `current()` is undefined where nothing hosts the session (the pi TUI).
 */
export function workerHostOf(events: EventBusLike): { current(): WorkerHost | undefined; dispose(): void } {
	let host: WorkerHost | undefined;
	const off = events.on(WORKER_HOST_EVENT, (data) => {
		const announced = data as Partial<WorkerHostAnnouncement> | undefined;
		if (announced?.version === 1 && announced.host) host = announced.host;
	});
	try {
		events.emit(WORKER_HOST_DISCOVER_EVENT, {});
	} catch {
		/* Nobody listening: no host. */
	}
	return {
		current: () => host,
		dispose: () => off(),
	};
}

/** The text of an assistant message's text parts (pi's wire shape: a string or a part list). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => !!part && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

interface AssistantLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
}

/** The run's result as its session file holds it: the last assistant message. For a fork that settled while nobody watched. */
export function forkResultFromFile(sessionFile: string, settled: WorkerState["lastSettled"]): BackgroundForkResult {
	let last: AssistantLike | undefined;
	let lastText = "";
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"assistant"')) continue;
			let entry: { type?: string; message?: AssistantLike };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			last = entry.message;
			const text = textOf(last.content).trim();
			if (text) lastText = text;
		}
	} catch {
		/* No file: no output. */
	}
	const outcome = settled?.outcome ?? "error";
	return {
		outcome,
		...(outcome === "error" ? { error: settled?.error ?? last?.errorMessage ?? "the fork ended without a result" } : {}),
		finalOutput: lastText,
		...(last?.provider && last.model ? { model: `${last.provider}/${last.model}` } : {}),
	};
}

/**
 * The fork's run, folded from its feed: the events a single-task worker needs (the runner's fold,
 * minus steers). Settles at `agent_settled`; a chat that ends first settles by its cause.
 */
class ForkWatch {
	settled = false;
	model?: string;
	sessionId?: string;
	sessionFile?: string;
	private finalText = "";
	private taskError: string | undefined;
	private aborted = false;
	private stopping = false;
	private unwatch: (() => void) | undefined;

	constructor(
		private readonly host: WorkerHost,
		private readonly name: string,
		private readonly handlers: BackgroundForkHandlers,
	) {}

	watch(ref: Pick<WorkerRef, "chatId" | "sessionId" | "sessionFile">): void {
		this.sessionId = ref.sessionId;
		this.sessionFile = ref.sessionFile;
		if (this.settled) return;
		this.unwatch = this.host.watch(ref.chatId, null, (frame) => this.frame(frame));
	}

	markStopping(): void {
		this.stopping = true;
	}

	detach(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	settle(result: BackgroundForkResult): void {
		if (this.settled) return;
		this.settled = true;
		this.detach();
		this.handlers.onSettled(result);
	}

	private frame(frame: WorkerFeedFrame): void {
		if (this.settled) return;
		switch (frame.t) {
			case "state": {
				const state = frame.state;
				this.sessionId = state.sessionId || this.sessionId;
				this.sessionFile = state.sessionFile || this.sessionFile;
				if (state.model) this.model = state.model;
				// Settled while nobody watched (or across a gap): the file has the answer.
				if (state.lastSettled && state.status !== "running" && state.status !== "starting" && this.sessionFile) {
					const result = forkResultFromFile(this.sessionFile, state.lastSettled);
					this.settle({ ...result, ...(result.model || this.model ? { model: result.model ?? this.model } : {}) });
				}
				return;
			}
			case "gap":
				return; // A `state` follows.
			case "ended":
				if (frame.cause === "idle" || frame.cause === "reload" || frame.resuming) return; // Still its chat; a `state` follows.
				this.settle({
					outcome: frame.cause === "killed" || this.stopping ? "aborted" : "error",
					...(frame.cause === "killed" || this.stopping
						? {}
						: { error: frame.detail ?? (frame.cause === "server-stopped" ? `the ${this.name} worker was stopped with the server` : `the ${this.name} worker ended before it finished`) }),
					finalOutput: this.finalText,
					...(this.model ? { model: this.model } : {}),
				});
				return;
			case "event":
				this.event(frame.event as { type?: string; [key: string]: unknown });
				return;
		}
	}

	private event(event: { type?: string; [key: string]: unknown }): void {
		switch (event.type) {
			case "message_end": {
				const message = event.message as AssistantLike | undefined;
				if (message?.role !== "assistant") return;
				const text = textOf(message.content).trim();
				if (text) this.finalText = text;
				if (message.provider && message.model) this.model = `${message.provider}/${message.model}`;
				if (message.errorMessage) this.taskError = String(message.errorMessage);
				else if (message.stopReason === "error") this.taskError = "assistant turn failed (stopReason: error)";
				else this.taskError = undefined;
				this.aborted = message.stopReason === "aborted";
				return;
			}
			case "auto_retry_end":
				if (event.success === true) this.taskError = undefined;
				else if (event.success === false) this.taskError ??= event.finalError ? String(event.finalError) : "auto-retry failed after transient errors";
				return;
			case "agent_settled": {
				const outcome: BackgroundForkOutcome = this.aborted ? "aborted" : this.taskError ? "error" : "success";
				this.settle({ outcome, ...(outcome === "error" ? { error: this.taskError } : {}), finalOutput: this.finalText, ...(this.model ? { model: this.model } : {}) });
				return;
			}
		}
	}
}

function handleOf(watch: ForkWatch, stop: () => Promise<void>): BackgroundForkHandle {
	return {
		get model() {
			return watch.model;
		},
		get sessionId() {
			return watch.sessionId;
		},
		get sessionFile() {
			return watch.sessionFile;
		},
		stop,
		detach: () => watch.detach(),
	};
}

/** The fork's start key: one per parent session and run, so a re-sent start never opens a second chat. */
export function forkKey(parentSessionId: string, kind: BackgroundForkKind, id: string): string {
	return `${parentSessionId}:${kind}-${id}`;
}

/**
 * Start the child. Throws at once where no worker host serves the session; a start the host refuses
 * later settles the run as an error. The caller owns the handle: `stop` ends the fork, `detach` leaves
 * it running for the parent's next session to reattach.
 */
export function startBackgroundFork(spec: BackgroundForkSpec, handlers: BackgroundForkHandlers): BackgroundForkHandle {
	const host = spec.host;
	if (!host) throw new Error(`a background fork ${NO_WORKER_HOST}`);
	// A claude-code-cli model needs its provider's extension and switch in the child.
	const load = claudeCodeProviderLoad(spec.model, [WORKER_MARK_EXTENSION, ...(spec.extensions ?? [])], undefined);
	const env: Record<string, string> = { [FORK_POLICY_ENV]: JSON.stringify(spec.policy) };
	// Only a forked child has the parent's conversation to resume.
	if (spec.claudeFork && spec.forkSession) env[CLAUDE_FORK_ENV] = encodeForkPoint(spec.claudeFork);
	const watch = new ForkWatch(host, spec.name, handlers);
	let chatId: string | undefined;
	const started = host
		.start({
			key: forkKey(spec.parent.sessionId, spec.kind, spec.id),
			spec: {
				kind: spec.kind,
				parent: { sessionId: spec.parent.sessionId, path: spec.parent.path, workerId: spec.id },
				cwd: spec.cwd,
				model: spec.model || null,
				thinking: spec.effort || null,
				builtins: null,
				extensions: [...load.extensions, CHILD_EXTENSION],
				flags: load.flags ?? {},
				appendSystemPrompt: null,
				env,
				agentDir: null,
				lowered: true,
			},
			session: spec.forkSession ? { fork: { from: spec.forkSession, dir: spec.sessionDir } } : { new: { dir: spec.sessionDir } },
			task: spec.task,
		})
		.then(
			(ref) => {
				chatId = ref.chatId;
				watch.watch(ref);
			},
			(error: unknown) => {
				watch.settle({ outcome: "error", error: error instanceof Error ? error.message : String(error), finalOutput: "" });
			},
		);
	return handleOf(watch, async () => {
		watch.markStopping();
		await started;
		if (chatId) await host.stop(chatId, `${spec.name} stopped`).catch(() => {});
		watch.settle({ outcome: "aborted", finalOutput: "", ...(watch.model ? { model: watch.model } : {}) });
	});
}

/**
 * The parent's forks of `kind` the host still runs (a reload, a crash or new code since they
 * started), each watched again: `handlersFor(workerId)` returns the run's handlers, or undefined for
 * a run the parent no longer knows (that chat is stopped). Returns the reattached handles by worker
 * id. A fork that settled meanwhile settles at once, from its file.
 */
export async function reattachBackgroundForks(
	host: WorkerHost,
	kind: BackgroundForkKind,
	name: string,
	handlersFor: (workerId: string) => BackgroundForkHandlers | undefined,
): Promise<Map<string, BackgroundForkHandle>> {
	const handles = new Map<string, BackgroundForkHandle>();
	for (const ref of await host.list()) {
		if (ref.kind !== kind || ref.state === "ended") continue;
		const handlers = handlersFor(ref.workerId);
		if (!handlers) {
			await host.stop(ref.chatId, `no ${name} run records it`).catch(() => {});
			continue;
		}
		const watch = new ForkWatch(host, name, handlers);
		watch.watch(ref);
		handles.set(
			ref.workerId,
			handleOf(watch, async () => {
				watch.markStopping();
				await host.stop(ref.chatId, `${name} stopped`).catch(() => {});
				watch.settle({ outcome: "aborted", finalOutput: "", ...(watch.model ? { model: watch.model } : {}) });
			}),
		);
	}
	return handles;
}
