/**
 * Event-bus contracts (pi.events) between the mode extension and the subagents extension. Imports
 * nothing: both sides import this file, and so can an older or newer copy of either (a worktree's
 * own mode extension talks to the parent's worker marker), so every payload is versioned and a
 * listener ignores what it doesn't recognise.
 */

/**
 * The parent's side (§chat.mode-menu/workers). The mode extension emits `mode:worker` whenever its
 * session's state is (re)resolved or switched, and again whenever someone emits the discover event;
 * the subagents extension caches the newest one and appends `prompt` to each worker it starts,
 * without interpreting it. Like the sandbox's state event (sandbox/state.ts).
 */
export const MODE_WORKER_EVENT = "mode:worker";
export const MODE_WORKER_DISCOVER_EVENT = "mode:worker-discover";

export interface ModeWorkerEvent {
	version: 1;
	/** The worker-scope minor modes the session has on now, in registry order; what a worker is given. */
	minorModes: string[];
	/** The text to append to a worker's system prompt; absent when none of its modes reaches workers. */
	prompt?: string;
}

/** The event as a listener should trust it, or undefined for anything malformed or of another version. */
export function parseModeWorkerEvent(data: unknown): ModeWorkerEvent | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const e = data as Record<string, unknown>;
	if (e.version !== 1 || !Array.isArray(e.minorModes) || e.minorModes.some((m) => typeof m !== "string" || m === "")) return undefined;
	if (e.prompt !== undefined && (typeof e.prompt !== "string" || e.prompt.trim() === "")) return undefined;
	return { version: 1, minorModes: [...(e.minorModes as string[])], ...(e.prompt === undefined ? {} : { prompt: e.prompt as string }) };
}

/**
 * The worker's side. Every pi worker loads the subagents worker marker first; it emits
 * `subagents:worker` at load and answers `subagents:worker-discover` with it. A mode extension
 * loaded into that worker (a worker on its worktree's own agent dir, §chat.worktrees/worktree-config)
 * asks at load and, when answered, takes the worker role: branch snapshots a fork copied from the
 * parent and mode.json are ignored, only its worker-scope `--minor` modes apply, and it offers no spec
 * writer. A bus signal rather than a flag or an env variable: an older mode extension ignores it (an
 * unknown flag is a startup error), and nothing leaks into the worker's own shells.
 */
export const WORKER_ROLE_EVENT = "subagents:worker";
export const WORKER_ROLE_DISCOVER_EVENT = "subagents:worker-discover";

export interface WorkerRoleEvent {
	version: 1;
}
