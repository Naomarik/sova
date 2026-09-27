/**
 * A session's resolved sandbox policy, from what the session is: its agent dir, cwd, session id,
 * active tracked worktrees and (in a worker) its parent's scope. The extension's `snapshot()` calls
 * it before the proxy and the probe; Sova's server calls it for a session it hosts or holds on disk
 * (linked-session file transfer, `server/link-sandbox.ts`), so the two never disagree.
 *
 * Node builtins only (with backend.ts, policy.ts and state.ts), no pi imports. Pure apart from
 * reading the policy files: it never creates the session tmp (`ensureSessionTmpDir` does).
 */
import { lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Backend, backendFor, gitProtectedPaths, shadowSource } from "./backend.ts";
import { type ParentScope, type ResolvedPolicy, type Result, resolvePolicy } from "./policy.ts";

export interface SessionPolicyInput {
	/** pi's agent dir (getAgentDir()/PI_CODING_AGENT_DIR). */
	agentDir: string;
	cwd: string;
	/** The session id; empty (a runtime without one yet) falls back to the process id, as the extension does. */
	sessionId: string;
	/** The session's active tracked worktrees: writable roots, each with its `.agent` read-only. */
	worktreeRoots?: readonly string[];
	/** A worker's parent scope (`--sandbox-parent`); never set for a top-level session. */
	parent?: ParentScope;
	/** The session tmp, when the caller already made it; else `sessionTmpDir(sessionId)`. */
	tmpDir?: string;
	home?: string;
	platform?: NodeJS.Platform;
	/** Only its platform lists are read; defaults to `backendFor(platform)`. */
	backend?: Pick<Backend, "platformDefaults">;
}

/** The per-user base of every session tmp: `<os tmp>/pi-sandbox-<uid>`. */
export function sessionTmpBase(): string {
	return join(tmpdir(), `pi-sandbox-${process.getuid?.() ?? "u"}`);
}

/** The session's sandbox tmp (`<base>/<session id>/tmp`), as a path only. */
export function sessionTmpDir(sessionId: string): string {
	return join(sessionTmpBase(), (sessionId || `pid${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "_"), "tmp");
}

/** Makes the session tmp (0700), refusing a base that is not this user's own real directory. */
export function ensureSessionTmpDir(sessionId: string): string {
	const base = sessionTmpBase();
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const st = lstatSync(base);
	if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${base} is not a private directory of this user`);
	const tmp = sessionTmpDir(sessionId);
	mkdirSync(tmp, { recursive: true, mode: 0o700 });
	return tmp;
}

/** The policy the session's tools run under while the sandbox is on. Fails closed like `resolvePolicy`. */
export function resolveSessionPolicy(input: SessionPolicyInput): Result<ResolvedPolicy> {
	const home = input.home ?? homedir();
	const backend = input.backend ?? backendFor(input.platform);
	// The platform lists apply; which caches are shadowed is the policy file's `shadowed`.
	const defaults = backend.platformDefaults({ home, agentDir: input.agentDir });
	const roots = [...(input.worktreeRoots ?? [])];
	return resolvePolicy({
		agentDir: input.agentDir,
		cwd: input.cwd,
		tmpDir: input.tmpDir ?? sessionTmpDir(input.sessionId),
		home,
		...(input.platform ? { platform: input.platform } : {}),
		defaults,
		shadowSource,
		git: gitProtectedPaths,
		parent: input.parent,
		extraWritable: roots,
		extraReadOnly: roots.map((r) => join(r, ".agent")),
	});
}
