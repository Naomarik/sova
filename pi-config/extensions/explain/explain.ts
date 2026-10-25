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
 *
 * Two entries per run, same `id`: a provisional `status: "running"` entry once
 * the child is spawned (so the row is visible for the whole run), then the
 * final entry, without `status`, when it settles; the later entry supersedes
 * the earlier one for readers deduping by id.
 *
 * The child is a background fork (`../subagents/fork/`), a hidden chat of its own process: it
 * forks a copy of the parent's session (`copyForFork`), kept with the fork's own session in
 * `explanations/.forks/` for the run and deleted when it ends, on the parent's prompt cache, and
 * may write only into its own store directory. A parent session that closes (a reload, new code,
 * a crash) leaves it running and writes nothing: the next session `reattach`es it and records its
 * end. Only a run whose chat is gone (the server stopped it, or it died for good) is settled by
 * `reconcile`, at the session's next prompt, as `status: "interrupted"`.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeForkPoint } from "../claude-code/provider/fork-point.ts";
import {
	reattachBackgroundForks,
	startBackgroundFork,
	type BackgroundForkHandle,
	type BackgroundForkHandlers,
	type BackgroundForkSpec,
} from "../subagents/fork/background.ts";
import { copyForFork, forkable, sweepStale } from "../subagents/fork/copy.ts";
import type { ForkPolicy } from "../subagents/fork/mirror.ts";
import type { WorkerHost } from "../subagents/worker-host.ts";
import { buildChildPrompt } from "./prompt.ts";
import {
	agentDir,
	ensureStoreDir,
	entryData,
	explanationsRoot,
	interruptedEntryData,
	isExplanationId,
	newId,
	normalizeMeta,
	readMeta,
	runningEntryData,
	storeDir,
	storeExists,
	validateStore,
	type ExplainEntryData,
	type ExplainMeta,
	type KnownMeta,
} from "./store.ts";

/** Worker name, so a stray child is recognizable in `ps` output and in its own session list. */
export const WORKER_NAME = "explain";

/** The child's policy: read, look things up on the web, and write only the page and its meta. */
export function explainPolicy(storeDir: string): ForkPolicy {
	return { label: "The /explain worker", web: true, writeDir: storeDir, writeHint: "Write index.html and meta.json there; nothing else on disk." };
}

/**
 * Web search/fetch for the child, but only if the package pi already installed
 * for this user is sitting there: the point is "trivially available", never an
 * install on the critical path of a slash command.
 */
export function webAccessExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dir = join(agentDir(env), "npm", "node_modules", "pi-web-access");
	return existsSync(dir) ? dir : undefined;
}

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
	/** Sova's worker host for the parent's session; undefined where none serves it (the pi TUI). */
	workerHost?(): WorkerHost | undefined;
	/** Test seam; defaults to the shared background fork. */
	start?(spec: BackgroundForkSpec, handlers: BackgroundForkHandlers): BackgroundForkHandle;
	/** Test seam; defaults to the shared reattach. */
	reattach?: typeof reattachBackgroundForks;
}

export interface BeginRequest {
	topic: string;
	cwd: string;
	parentSessionId: string;
	/** Path of the parent's JSONL; forking is skipped when it is not on disk yet. */
	parentSessionFile?: string;
	model: string;
	effort?: string;
	/** The parent's live Claude CLI session (claude-code-cli models): the child resumes it. */
	claudeFork?: ClaudeForkPoint;
	/** The parent's active tool names: a forked child keeps exactly these (see prompt.ts searchTools). */
	parentTools?: readonly string[];
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
	/** Unset only while a reattached run's handle is being made. */
	handle?: BackgroundForkHandle;
	/** The session copy the child forked; deleted when the run ends. */
	forkCopy?: string;
	/** The fork's own session directory; deleted when the run ends. */
	sessionDir: string;
}

/** Where the per-run session copies live, beside the stores (a dot name is never an explanation id). */
export const FORK_DIR = ".forks";
/** A copy older than this was left by a parent that died mid-run. */
const STALE_FORK_MS = 24 * 60 * 60 * 1000;

function removeQuietly(path: string | undefined): void {
	if (!path) return;
	try {
		rmSync(path, { force: true, recursive: true });
	} catch {
		/* A leftover copy is swept by the next run. */
	}
}

/** customType of the completion message that wakes the parent agent. */
export const WAKE_MESSAGE_TYPE = "explain-complete";

/**
 * The completion message envelope.
 *
 * `display: false` on purpose. This text is addressed to the AGENT ("reply in at
 * most two sentences…"), not to the user, and a displayed custom message is
 * rendered as a transcript row by pi and by Sova alike — which showed the user
 * our own prompt plumbing between the explanation card and the agent's reply.
 * Hiding it costs nothing: custom messages participate in LLM context regardless
 * of `display`, so the wake still happens, and the user already sees the
 * `explain-doc` entry plus the agent's answer. (Found in a real Sova transcript
 * by backend-dev, not in a test.)
 */
export function wakeMessage(text: string): { customType: string; content: string; display: boolean } {
	return { customType: WAKE_MESSAGE_TYPE, content: text, display: false };
}

/** Two sentences, and the second one is the instruction that keeps it to two. */
export function wakeText(topic: string, dir: string): string {
	return [
		`[/explain] The explanation of "${topic}" is written: ${dir}/index.html (viewable in Sova).`,
		"Reply in at most two sentences — the store path and that it is viewable in Sova. Do not open a browser, do not re-explain the topic.",
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
		`[/explain] The explanation of "${topic}" is written: ${dir}/index.html (viewable in Sova), but the run did not finish cleanly: ${note}`,
		"Reply in at most two sentences — the store path, that it is viewable in Sova, and that it may be unfinished. Do not open a browser, do not re-explain the topic.",
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

/** What a running entry knew about its run (its cwd from the store's meta, when written). */
function knownOf(entry: ExplainEntryData, env: NodeJS.ProcessEnv): KnownMeta {
	const raw = readMeta(storeDir(entry.id, env)) as { cwd?: unknown } | undefined;
	return {
		id: entry.id,
		topic: entry.topic,
		parentSessionId: entry.parentSessionId,
		cwd: raw && typeof raw.cwd === "string" ? raw.cwd : "",
		createdAt: entry.createdAt,
		model: entry.model ?? "",
	};
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

		const forkSession = forkable(request.parentSessionFile) ? this.copyParent(request.parentSessionFile, id, env) : undefined;
		const sessionDir = join(explanationsRoot(env), FORK_DIR, id);
		const webAccess = webAccessExtension(env);
		const task = buildChildPrompt({
			...known,
			dir,
			indexPath: `${dir}/index.html`,
			metaPath: `${dir}/meta.json`,
			webSearch: Boolean(webAccess),
			forked: Boolean(forkSession),
			...(request.parentTools ? { parentTools: request.parentTools } : {}),
		});

		const start = this.host.start ?? startBackgroundFork;
		let handle: BackgroundForkHandle;
		try {
			handle = start(
				{
					host: this.host.workerHost?.(),
					kind: "explain",
					parent: { sessionId: request.parentSessionId, path: request.parentSessionFile ?? "" },
					sessionDir,
					id,
					name: WORKER_NAME,
					task,
					cwd: request.cwd,
					model: request.model,
					policy: explainPolicy(dir),
					...(request.effort ? { effort: request.effort } : {}),
					...(forkSession ? { forkSession } : {}),
					// Only a forked child has the parent's conversation to resume.
					...(forkSession && request.claudeFork ? { claudeFork: request.claudeFork } : {}),
					...(webAccess ? { extensions: [webAccess] } : {}),
				},
				{ onSettled: (result) => this.finish(id, result) },
			);
		} catch (error) {
			removeQuietly(forkSession);
			throw error;
		}
		this.runs.set(id, { known, dir, handle, sessionDir, ...(forkSession ? { forkCopy: forkSession } : {}) });
		// Only now: a refused spawn threw above and must leave no phantom running row.
		this.record(runningEntryData(known));
		return { id, dir, forked: Boolean(forkSession), webSearch: Boolean(webAccess) };
	}

	/** Validate the store, record the entry, wake the parent. Never throws. */
	private finish(id: string, result: { outcome: string; error?: string; finalOutput: string; model?: string }): void {
		const run = this.runs.get(id);
		if (!run) return;
		this.runs.delete(id);
		void run.handle
			?.stop()
			.catch(() => {})
			.finally(() => removeQuietly(run.sessionDir));
		removeQuietly(run.forkCopy);

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

	/**
	 * The session is closing (a reload, new code, shutdown): stop watching every child and leave it
	 * running. The next session over the same file `reattach`es it; nothing is written now.
	 */
	detachAll(): void {
		const runs = [...this.runs.values()];
		this.runs.clear();
		for (const run of runs) run.handle?.detach();
	}

	/**
	 * Watch again the children the worker host still runs for this session, from `entries` (the
	 * branch's `explain-doc` data, oldest first): each id whose newest entry is running and whose
	 * chat is listed is a live run again, and records its end when it settles (at once, when it
	 * settled meanwhile). A listed chat no running entry claims is stopped; one this session already
	 * watches is left alone, so a second call is harmless. A running entry with no chat behind it is
	 * left to `reconcile`. Returns how many runs are live again.
	 */
	async reattach(entries: readonly ExplainEntryData[]): Promise<number> {
		const host = this.host.workerHost?.();
		if (!host) return 0;
		const latest = new Map<string, ExplainEntryData>();
		for (const entry of entries) if (entry && typeof entry.id === "string") latest.set(entry.id, entry);
		const env = this.host.env ?? process.env;
		const forks = join(explanationsRoot(env), FORK_DIR);
		const claimed = new Set<string>();
		const handles = await (this.host.reattach ?? reattachBackgroundForks)(host, "explain", WORKER_NAME, (id) => {
			if (this.runs.has(id)) return null; // Already watched by this session.
			const entry = latest.get(id);
			if (!entry || entry.status !== "running" || !isExplanationId(id)) return undefined;
			const forkCopy = join(forks, `${id}.jsonl`);
			this.runs.set(id, { known: knownOf(entry, env), dir: storeDir(id, env), sessionDir: join(forks, id), ...(existsSync(forkCopy) ? { forkCopy } : {}) });
			claimed.add(id);
			return { onSettled: (result) => this.finish(id, result) };
		});
		for (const [id, handle] of handles) {
			const run = this.runs.get(id);
			if (run) run.handle = handle;
			// It settled while its handle was being made: its run is recorded, its chat is done.
			else
				void handle
					.stop()
					.catch(() => {})
					.finally(() => removeQuietly(join(forks, id)));
		}
		return claimed.size;
	}

	/**
	 * Settle the running entries no live child is behind (after `reattach`): the runs whose chat is
	 * gone (the server stopped it, or it died for good) before they recorded their end. `entries` is the `explain-doc`
	 * data on the session's branch, oldest first; for each id whose newest entry is still
	 * running, append a final `status: "interrupted"` entry. A child can finish its page right
	 * before the kill, so a complete store is validated and linked (`note`); otherwise the entry
	 * is `error`: there is nothing to open. Returns how many were settled.
	 *
	 * Call it when the session is about to be written anyway (its first prompt, or /explain),
	 * never on open: opening a runtime must not write.
	 */
	reconcile(entries: readonly ExplainEntryData[]): number {
		const latest = new Map<string, ExplainEntryData>();
		for (const entry of entries) if (entry && typeof entry.id === "string") latest.set(entry.id, entry);
		const env = this.host.env ?? process.env;
		let settled = 0;
		for (const entry of latest.values()) {
			if (entry.status !== "running" || this.runs.has(entry.id) || !isExplanationId(entry.id)) continue;
			const dir = storeDir(entry.id, env);
			const known = knownOf(entry, env);
			const check = storeExists(dir) ? validateStore(dir, known) : undefined;
			this.record(check?.ok && check.meta ? interruptedEntryData(check.meta, true) : interruptedEntryData({ ...known, summary: "" }, false));
			settled++;
		}
		return settled;
	}

	/** Copy the parent's session for the child to fork, after sweeping copies older runs left behind. */
	private copyParent(source: string, id: string, env: NodeJS.ProcessEnv): string | undefined {
		const dir = join(explanationsRoot(env), FORK_DIR);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			sweepStale(dir, STALE_FORK_MS, this.host.now(), (name) => this.runs.has(name.replace(/\.jsonl$/, "")));
			const target = join(dir, `${id}.jsonl`);
			return copyForFork(source, target) ? target : undefined;
		} catch {
			return undefined; // No copy, no fork: the child starts fresh, and says so.
		}
	}
}
