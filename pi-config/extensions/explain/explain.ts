/**
 * `/explain` orchestration, with no dependency on pi's API: start one child per
 * topic, and when it settles, validate the store and record the result.
 *
 * Single writer, on purpose. The child writes `index.html` and `meta.json` and
 * nothing else; the PARENT process — this module, in the parent's own event
 * loop, exactly like the mode extension's align markers — is the only thing
 * that appends to the parent session. A child cannot append to a session it
 * does not own, and a forked child owns a *copy*, so any attempt from over
 * there would be written into the wrong file.
 */
import { buildChildPrompt } from "./prompt.ts";
import {
	ensureStoreDir,
	entryData,
	newId,
	normalizeMeta,
	storeDir,
	storeExists,
	validateStore,
	type ExplainEntryData,
	type ExplainMeta,
	type KnownMeta,
} from "./store.ts";
import {
	forkable,
	startExplainWorker,
	webAccessExtension,
	type ExplainWorkerHandle,
	type ExplainWorkerHandlers,
	type ExplainWorkerSpec,
} from "./worker.ts";

/** At most this many explanations run at once; each one is a whole pi process. */
export const MAX_LIVE = 3;
const MAX_TOPIC = 2000;
const MAX_ERROR = 600;

export interface ExplainHost {
	env?: NodeJS.ProcessEnv;
	/** Epoch ms. */
	now(): number;
	/** Append the `explain-doc` entry to the parent session. */
	appendEntry(data: ExplainEntryData): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** Deliver the completion message to the parent agent (and wake it when idle). */
	wake(text: string): void;
	/** Test seam; defaults to a real forked pi child. */
	start?(spec: ExplainWorkerSpec, handlers: ExplainWorkerHandlers): ExplainWorkerHandle;
}

export interface BeginRequest {
	topic: string;
	cwd: string;
	parentSessionId: string;
	/** Path of the parent's JSONL; forking is skipped when it is not on disk yet. */
	parentSessionFile?: string;
	model: string;
	effort?: string;
}

export interface BeginResult {
	id: string;
	dir: string;
	/** The child got a copy of the parent conversation. */
	forked: boolean;
	/** The child can search the web. */
	webSearch: boolean;
}

interface Run {
	known: KnownMeta;
	dir: string;
	handle: ExplainWorkerHandle;
}

/** customType of the completion message that wakes the parent agent. */
export const WAKE_MESSAGE_TYPE = "explain-complete";

/**
 * The completion message envelope.
 *
 * `display: false` on purpose. This text is addressed to the AGENT ("reply in at
 * most two sentences…"), not to the user, and a displayed custom message is
 * rendered as a transcript row by pi and by pi-web alike — which showed the user
 * our own prompt plumbing between the explanation card and the agent's reply.
 * Hiding it costs nothing: custom messages participate in LLM context regardless
 * of `display`, so the wake still happens, and the user already sees the
 * `explain-doc` entry plus the agent's answer. (Found in a real pi-web transcript
 * by backend-dev, not in a test.)
 */
export function wakeMessage(text: string): { customType: string; content: string; display: boolean } {
	return { customType: WAKE_MESSAGE_TYPE, content: text, display: false };
}

/** Two sentences, and the second one is the instruction that keeps it to two. */
export function wakeText(topic: string, dir: string): string {
	return [
		`[/explain] The explanation of "${topic}" is written: ${dir}/index.html (viewable in pi-web).`,
		"Reply in at most two sentences — the store path and that it is viewable in pi-web. Do not open a browser, do not re-explain the topic.",
	].join("\n");
}

export function failureWakeText(topic: string, error: string): string {
	return [
		`[/explain] The explanation of "${topic}" failed: ${error}`,
		"Say so in at most two sentences. Do not write the page yourself unless the user asks for it.",
	].join("\n");
}

/** The page is there and opens; the run around it did not end cleanly. */
export function noteWakeText(topic: string, dir: string, note: string): string {
	return [
		`[/explain] The explanation of "${topic}" is written: ${dir}/index.html (viewable in pi-web), but the run did not finish cleanly: ${note}`,
		"Reply in at most two sentences — the store path, that it is viewable in pi-web, and that it may be unfinished. Do not open a browser, do not re-explain the topic.",
	].join("\n");
}

export function oneLineError(...parts: (string | undefined)[]): string {
	const text = parts
		.map((part) => part?.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("; ");
	if (!text) return "the explain worker failed without reporting a reason";
	return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

export class ExplainRuns {
	private readonly runs = new Map<string, Run>();
	private readonly host: ExplainHost;

	constructor(host: ExplainHost) {
		this.host = host;
	}

	get live(): number {
		return this.runs.size;
	}

	/**
	 * Spawn the child for one topic. Throws only on bad input or a refused
	 * spawn; everything after this point is reported through the session entry.
	 */
	begin(request: BeginRequest): BeginResult {
		const topic = request.topic.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC);
		if (!topic) throw new Error("Nothing to explain: /explain <topic>");
		if (this.runs.size >= MAX_LIVE) throw new Error(`${MAX_LIVE} explanations are already running; wait for one to finish.`);

		const env = this.host.env ?? process.env;
		const createdAt = new Date(this.host.now());
		const id = newId(topic, createdAt.getTime(), (candidate) => this.runs.has(candidate) || storeExists(storeDir(candidate, env)));
		const dir = ensureStoreDir(storeDir(id, env));
		const known: KnownMeta = {
			id,
			topic,
			parentSessionId: request.parentSessionId,
			cwd: request.cwd,
			createdAt: createdAt.toISOString(),
			model: request.model,
		};

		const forkSession = forkable(request.parentSessionFile) ? request.parentSessionFile : undefined;
		const webAccess = webAccessExtension(env);
		const task = buildChildPrompt({
			...known,
			dir,
			indexPath: `${dir}/index.html`,
			metaPath: `${dir}/meta.json`,
			webSearch: Boolean(webAccess),
			forked: Boolean(forkSession),
		});

		const start = this.host.start ?? startExplainWorker;
		const handle = start(
			{
				id,
				task,
				cwd: request.cwd,
				model: request.model,
				...(request.effort ? { effort: request.effort } : {}),
				...(forkSession ? { forkSession } : {}),
				...(webAccess ? { extensions: [webAccess] } : {}),
			},
			{ onSettled: (result) => this.finish(id, result) },
		);
		this.runs.set(id, { known, dir, handle });
		return { id, dir, forked: Boolean(forkSession), webSearch: Boolean(webAccess) };
	}

	/** Validate the store, record the entry, wake the parent. Never throws. */
	private finish(id: string, result: { outcome: string; error?: string; finalOutput: string; model?: string }): void {
		const run = this.runs.get(id);
		if (!run) return;
		this.runs.delete(id);
		void run.handle.kill().catch(() => {});

		// The child's own model id wins: it is what actually wrote the page.
		const known: KnownMeta = { ...run.known, model: result.model || run.known.model };
		const check = validateStore(run.dir, known);
		const workerFailed = result.outcome !== "success";
		const reason = oneLineError(workerFailed ? `worker ${result.outcome}` : undefined, result.error, check.error);

		// FATAL: no page to open. The entry keeps the failed topic visible.
		if (!check.ok) {
			const meta: ExplainMeta = normalizeMeta({ summary: result.finalOutput }, known);
			this.record(entryData(meta, { kind: "error", text: reason }));
			this.host.notify(`/explain failed for "${known.topic}": ${reason}`, "warning");
			this.host.wake(failureWakeText(known.topic, reason));
			return;
		}

		const meta = check.meta!;
		if (check.warnings.length) this.host.notify(`/explain page warnings: ${check.warnings.join("; ")}`, "warning");

		// ADVISORY: the page is complete and opens; the run around it broke afterwards.
		if (workerFailed) {
			this.record(entryData(meta, { kind: "note", text: reason }));
			this.host.notify(`/explain wrote "${meta.topic}" but the run did not finish cleanly: ${reason}`, "warning");
			this.host.wake(noteWakeText(meta.topic, run.dir, reason));
			return;
		}

		this.record(entryData(meta));
		this.host.notify(`/explain ready: ${run.dir}/index.html`, "info");
		this.host.wake(wakeText(meta.topic, run.dir));
	}

	private record(data: ExplainEntryData): void {
		try {
			this.host.appendEntry(data);
		} catch (error) {
			// The page is on disk either way; a lost entry only costs this session's thread row.
			this.host.notify(`/explain could not record the session entry: ${String(error)}`, "warning");
		}
	}

	/** Stop every live child (session shutdown, reload). */
	async stopAll(): Promise<void> {
		const handles = [...this.runs.values()].map((run) => run.handle);
		this.runs.clear();
		await Promise.all(handles.map((handle) => handle.kill().catch(() => {})));
	}
}
