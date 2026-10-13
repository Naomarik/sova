/**
 * One watcher for a hidden chat's runs (al_3 stage 5): the feed a worker host serves for a worker chat,
 * folded into the run under way (its question, its last assistant message, its outcome), with the
 * frames that end a watch told apart from those that don't; and the same facts read from the chat's
 * session file, for a run that settled while nobody watched. Background forks (/explain,
 * /compact-handoff), /btw's side thread and ChatWorker's reattach read their runs through it.
 * Node built-ins and the host's types only.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { WorkerFeedFrame, WorkerHost, WorkerState } from "./worker-host.ts";

/** A pi message as a session file or the feed carries it. */
export interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
}

/** A pi event the chat fed (the wire-1 shape of pi's rpc events). */
export type FeedEvent = { type?: string; [key: string]: unknown };

/** The text of a message's text parts (pi's wire shape: a string or a part list), one per line. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => !!part && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** An assistant message with its entry id, and the question it answered. */
export interface Exchange {
	message: MessageLike;
	entryId?: string;
	question?: string;
}

/** The run under way, as its feed has told it so far. */
export interface FedRun {
	/** The last user message's text. */
	question?: string;
	/** The last assistant message, with the question before it. */
	last?: Exchange;
	/** The last assistant text that wasn't empty. */
	text: string;
	/** Why the run failed, as far as the feed says (cleared by a later good turn or retry). */
	error?: string;
	/** Its last assistant message was aborted. */
	aborted: boolean;
}

export interface RunWatchHandlers {
	/** The chat's state (sent first, and again after a gap or a reconnect). */
	state?(state: WorkerState): void;
	/** Each feed event, after the run took it in. */
	event?(event: FeedEvent): void;
	/** The run settled (`agent_settled`). */
	settled?(run: FedRun): void;
	/** The chat is gone: an end that is no idle stop, no reload and no crash resume. */
	ended?(frame: Extract<WorkerFeedFrame, { t: "ended" }>): void;
}

/** A hidden chat's feed, watched from its start (or from now, for a reattach) until `detach`. */
export class RunWatch {
	sessionId?: string;
	sessionFile?: string;
	/** "provider/model", as the chat last said. */
	model?: string;
	run: FedRun = { text: "", aborted: false };
	private unwatch: (() => void) | undefined;
	private readonly host: WorkerHost;
	private readonly handlers: RunWatchHandlers;

	constructor(host: WorkerHost, handlers: RunWatchHandlers) {
		this.host = host;
		this.handlers = handlers;
	}

	watch(ref: { chatId: string; sessionId?: string; sessionFile?: string }): void {
		if (ref.sessionId) this.sessionId = ref.sessionId;
		if (ref.sessionFile) this.sessionFile = ref.sessionFile;
		this.unwatch = this.host.watch(ref.chatId, null, (frame) => this.frame(frame));
	}

	detach(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	/** A new run begins (a question sent): the fold starts afresh with it. */
	restart(question?: string): void {
		this.run = { text: "", aborted: false, ...(question !== undefined ? { question } : {}) };
	}

	private frame(frame: WorkerFeedFrame): void {
		switch (frame.t) {
			case "state": {
				const s = frame.state;
				this.sessionId = s.sessionId || this.sessionId;
				this.sessionFile = s.sessionFile || this.sessionFile;
				if (s.model) this.model = s.model;
				this.handlers.state?.(s);
				return;
			}
			case "gap":
				return; // A `state` follows.
			case "ended":
				if (frame.cause === "idle" || frame.cause === "reload" || frame.resuming) return; // Still its chat; a `state` follows.
				this.handlers.ended?.(frame);
				return;
			case "event": {
				const event = frame.event as FeedEvent;
				this.fold(event);
				this.handlers.event?.(event);
				if (event.type === "agent_settled") this.handlers.settled?.(this.run);
				return;
			}
		}
	}

	private fold(event: FeedEvent): void {
		const run = this.run;
		if (event.type === "message_end") {
			const message = event.message as MessageLike | undefined;
			if (message?.role === "user") run.question = textOf(message.content);
			if (message?.role !== "assistant") return;
			run.last = { message, ...(typeof event.entryId === "string" ? { entryId: event.entryId } : {}), ...(run.question !== undefined ? { question: run.question } : {}) };
			const text = textOf(message.content).trim();
			if (text) run.text = text;
			if (message.provider && message.model) this.model = `${message.provider}/${message.model}`;
			if (message.errorMessage) run.error = String(message.errorMessage);
			else if (message.stopReason === "error") run.error = "assistant turn failed (stopReason: error)";
			else run.error = undefined;
			run.aborted = message.stopReason === "aborted";
		} else if (event.type === "auto_retry_end") {
			if (event.success === true) run.error = undefined;
			else if (event.success === false) run.error ??= event.finalError ? String(event.finalError) : "auto-retry failed after transient errors";
		}
	}
}

/** A session file entry that holds a message. */
export interface MessageEntry {
	id?: string;
	timestamp?: string;
	message: MessageLike;
}

/** A session file's message entries, oldest first: the whole file, or its last `tailBytes`. Empty when it can't be read. */
export function fileMessages(file: string, tailBytes?: number): MessageEntry[] {
	let text: string;
	try {
		if (tailBytes === undefined) text = readFileSync(file, "utf8");
		else {
			const fd = openSync(file, "r");
			try {
				const size = fstatSync(fd).size;
				const start = Math.max(0, size - tailBytes);
				const buf = Buffer.alloc(size - start);
				readSync(fd, buf, 0, buf.length, start);
				text = buf.toString("utf8");
				if (start > 0) text = text.slice(text.indexOf("\n") + 1);
			} finally {
				closeSync(fd);
			}
		}
	} catch {
		return [];
	}
	const out: MessageEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"message"')) continue;
		let entry: { type?: unknown; id?: unknown; timestamp?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		out.push({
			message: entry.message as MessageLike,
			...(typeof entry.id === "string" ? { id: entry.id } : {}),
			...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
		});
	}
	return out;
}

/** A session file's last user question and the assistant answer after it, or undefined when none follows the last question. */
export function lastExchange(file: string): Exchange | undefined {
	let answer: Exchange | undefined;
	let question: string | undefined;
	for (const e of fileMessages(file)) {
		if (e.message.role === "user") {
			question = textOf(e.message.content);
			answer = undefined;
		} else if (e.message.role === "assistant") {
			answer = { message: e.message, ...(e.id ? { entryId: e.id } : {}), ...(question !== undefined ? { question } : {}) };
		}
	}
	return answer;
}
