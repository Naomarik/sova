/**
 * Confined launches: a worker process that runs INSIDE the sandbox as a whole (every tool, shell
 * and server it starts included), under the policy a pi worker in the same cwd and scope gets.
 * `workerLaunch` (index.ts) hands the spawner an opaque `scope`; whoever spawns the process (the
 * parent, or a hosting process after a restart) calls `confineLaunch(scope, needs, launch)` at
 * every launch and spawns what it returns.
 *
 * `needs` is plain data about the launched program's own state (writable paths and binds, proxy
 * hosts, variables, fd payloads); this module knows nothing about any particular program.
 *
 * Node builtins only (with policy.ts, session-policy.ts, backend.ts, backends/*, env.ts and
 * proxy.ts), no pi imports: a hosting process imports it by path.
 */
import type { FdPayload } from "./backend.ts";
import type { ParentScope } from "./policy.ts";

/** What the launched program needs besides the policy. Every path absolute. */
export interface LaunchNeeds {
	/** Paths (files or directories, existing) writable inside at their own place, whatever the level. */
	writable?: string[];
	/** `source` (existing, on the host) writable inside at `target`; a missing directory target is created. */
	binds?: { source: string; target: string }[];
	/** Hosts the worker's own proxy allows besides the policy's; under read-only, the only ones. */
	proxyHosts?: string[];
	/** Variables set inside, over the scrubbed environment (the host's, for a write-only scope). */
	env?: Record<string, string>;
	/** Variables set inside that must never appear on argv or in a spawn environment. */
	secretEnv?: Record<string, string>;
	/** Payloads handed to the program on inherited fds (each ≥ 3, distinct), e.g. a credential. */
	fds?: FdPayload[];
	/** Variables of the spawned (outer) process only, e.g. what an outside scanner reads from
	 * /proc/<pid>/environ. Never seen inside where the backend has an outer process (bwrap). */
	spawnEnv?: Record<string, string>;
	/** The sandbox tmp on the host (a hosted worker's own dir); default `workerTmpDir(scope)`. */
	tmpDir?: string;
}

/** What would run unconfined. */
export interface LaunchCommand {
	command: string;
	args: string[];
	cwd: string;
	/** The environment it would have run with: the source the scrubbed one is picked from. */
	env: Record<string, string>;
}

export interface ConfinedLaunch {
	/** Spawn this, with `args`, `spawnEnv` exactly (nothing merged in) and cwd unchanged, never through a shell. */
	command: string;
	args: string[];
	/** What the program sees inside, for display and tests (secret values left out). Not a spawn env. */
	env: Record<string, string>;
	spawnEnv: Record<string, string>;
	/** Open a pipe at `stdio[fd]` for each, write `data`, then close the parent's end. */
	fds: FdPayload[];
	/** The sandbox tmp on the host, and as the program sees it (Linux `/tmp`; macOS the host path). */
	tmpDir: string;
	tmpInside: string;
	enforcement: "full" | "partial";
	notes?: string[];
	/** Call when the process has exited: stops this launch's proxy. The tmp stays (`releaseWorkerTmp`). */
	cleanup(): Promise<void>;
}

export type ConfineLaunchResult = ConfinedLaunch | { refused: string };

/** The decoded `scope` (internal; callers treat the string as opaque). */
export interface LaunchScope {
	v: 1;
	/** The parent's agent dir: its policy file is the one read. */
	agentDir: string;
	/** The parent session id: the default tmp lives under its sandbox dir. */
	sessionId: string;
	/** `WorkerLaunchRequest.owner`. */
	owner: string;
	/** The parent's scope as a pi worker gets it (full, narrowed, or write-only). */
	parent: ParentScope;
}

export function encodeLaunchScope(_scope: LaunchScope): string {
	throw new Error("not implemented");
}

export function decodeLaunchScope(_scope: string): { ok: true; value: LaunchScope } | { ok: false; error: string } {
	throw new Error("not implemented");
}

/** The default sandbox tmp of a scope's worker (made 0700): write launch files here before `confineLaunch`. */
export function workerTmpDir(_scope: string, _needs?: Pick<LaunchNeeds, "tmpDir">): { host: string; inside: string } {
	throw new Error("not implemented");
}

/** Remove the default sandbox tmp when the worker is gone for good (never a `needs.tmpDir`). */
export function releaseWorkerTmp(_scope: string): void {
	throw new Error("not implemented");
}

/**
 * The launch, confined: the policy resolved as a pi worker's (the parent's scope), the backend
 * probed once, a proxy of its own (the policy's hosts plus `needs.proxyHosts`; only the latter under
 * read-only; the host network under a write-only scope), the environment scrubbed plus
 * `needs.env`, secrets on an fd. Refuses rather than run unconfined.
 */
export async function confineLaunch(_scope: string, _needs: LaunchNeeds, _launch: LaunchCommand): Promise<ConfineLaunchResult> {
	throw new Error("not implemented");
}
