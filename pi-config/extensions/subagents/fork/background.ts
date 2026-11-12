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
import { fileURLToPath } from "node:url";
import { CLAUDE_FORK_ENV, encodeForkPoint, parentForkPoint, type ClaudeForkPoint } from "../../claude-code/provider/fork-point.ts";
import { claudeCodeProviderLoad, rpcScopedModel } from "../runner.ts";
import {
	NO_WORKER_HOST,
	WORKER_HOST_DISCOVER_EVENT,
	WORKER_HOST_EVENT,
	type WorkerHost,
	type WorkerHostAnnouncement,
	type WorkerKind,
	type WorkerRef,
	type WorkerState,
} from "../worker-host.ts";
import { fileMessages, type MessageLike, RunWatch, textOf } from "../run-watch.ts";
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
 * an announcement once). `current()` is undefined where nothing hosts the session. Sova announces
 * the host at its own session_start, which may run after the caller's: `onAnnounce` hears each
 * announcement, so a caller that found no host at its session_start can act when it arrives.
 */
export function workerHostOf(
	events: EventBusLike,
	onAnnounce?: (host: WorkerHost) => void,
): { current(): WorkerHost | undefined; dispose(): void } {
	let host: WorkerHost | undefined;
	const off = events.on(WORKER_HOST_EVENT, (data) => {
		const announced = data as Partial<WorkerHostAnnouncement> | undefined;
		if (announced?.version !== 1 || !announced.host) return;
		host = announced.host;
		onAnnounce?.(host);
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

/** The run's result as its session file holds it: the last assistant message. For a fork that settled while nobody watched. */
export function forkResultFromFile(sessionFile: string, settled: WorkerState["lastSettled"]): BackgroundForkResult {
	let last: MessageLike | undefined;
	let lastText = "";
	for (const e of fileMessages(sessionFile)) {
		if (e.message.role !== "assistant") continue;
		last = e.message;
		const text = textOf(last.content).trim();
		if (text) lastText = text;
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
 * The fork's one run, from its feed (RunWatch): settles at `agent_settled`, from its file when it
 * settled while nobody watched, or by its cause when its chat ends first. Settles once.
 */
class ForkWatch {
	settled = false;
	private stopping = false;
	private readonly run: RunWatch;
	private readonly name: string;
	private readonly handlers: BackgroundForkHandlers;

	constructor(host: WorkerHost, name: string, handlers: BackgroundForkHandlers) {
		this.name = name;
		this.handlers = handlers;
		this.run = new RunWatch(host, {
			state: (state) => {
				// Settled while nobody watched (or across a gap): the file has the answer.
				if (!state.lastSettled || state.status === "running" || state.status === "starting" || !this.run.sessionFile) return;
				const result = forkResultFromFile(this.run.sessionFile, state.lastSettled);
				this.settle({ ...result, ...(result.model || this.model ? { model: result.model ?? this.model } : {}) });
			},
			ended: (frame) => {
				const aborted = frame.cause === "killed" || this.stopping;
				this.settle({
					outcome: aborted ? "aborted" : "error",
					...(aborted
						? {}
						: { error: frame.detail ?? `the ${this.name} worker ended before it finished` }),
					finalOutput: this.run.run.text,
					...(this.model ? { model: this.model } : {}),
				});
			},
			settled: (run) => {
				const outcome: BackgroundForkOutcome = run.aborted ? "aborted" : run.error ? "error" : "success";
				this.settle({ outcome, ...(outcome === "error" ? { error: run.error } : {}), finalOutput: run.text, ...(this.model ? { model: this.model } : {}) });
			},
		});
	}

	get model(): string | undefined {
		return this.run.model;
	}
	get sessionId(): string | undefined {
		return this.run.sessionId;
	}
	get sessionFile(): string | undefined {
		return this.run.sessionFile;
	}

	watch(ref: Pick<WorkerRef, "chatId" | "sessionId" | "sessionFile">): void {
		if (this.settled) {
			this.run.sessionId = ref.sessionId;
			this.run.sessionFile = ref.sessionFile;
			return;
		}
		this.run.watch(ref);
	}

	markStopping(): void {
		this.stopping = true;
	}

	detach(): void {
		this.run.detach();
	}

	settle(result: BackgroundForkResult): void {
		if (this.settled) return;
		this.settled = true;
		this.detach();
		this.handlers.onSettled(result);
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
 * started), each watched again: `handlersFor(workerId)` returns the run's handlers, undefined for
 * a run the parent no longer knows (that chat is stopped), or null for one it already watches (left
 * alone). Returns the reattached handles by worker
 * id. A fork that settled meanwhile settles at once, from its file.
 */
export async function reattachBackgroundForks(
	host: WorkerHost,
	kind: BackgroundForkKind,
	name: string,
	handlersFor: (workerId: string) => BackgroundForkHandlers | undefined | null,
): Promise<Map<string, BackgroundForkHandle>> {
	const handles = new Map<string, BackgroundForkHandle>();
	for (const ref of await host.list()) {
		if (ref.kind !== kind || ref.state === "ended") continue;
		const handlers = handlersFor(ref.workerId);
		if (handlers === null) continue;
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
