/**
 * A session's resolved sandbox policy, from what the session is: its agent dir, cwd, session id,
 * active tracked worktrees and (in a worker) its parent's scope. The extension's `snapshot()` calls
 * it before the proxy and the probe; Sova's server calls it for a session it hosts or holds on disk
 * (linked-session file transfer, `server/link-sandbox.ts`), so the two never disagree.
 *
 * Node builtins only (with backend.ts, policy.ts, state.ts, env.ts and proxy.ts), no pi imports.
 * Resolution only reads policy files. `prepareSessionCommand` additionally owns a private tmp,
 * allowlisting proxy and backend launch resources until the caller disposes them.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Backend, type Confined, type Policy, backendFor, gitProtectedPaths, shadowSource } from "./backend.ts";
import { hostEnv, scrubEnv } from "./env.ts";
import { proxySocketPath, startProxy, type ProxyHandle, type ProxyOptions } from "./proxy.ts";
import { type ParentScope, type ResolvedPolicy, type Result, resolvePolicy } from "./policy.ts";
import { chatSharedFolder, ensureSharedFolder, sessionDirKey } from "./shared-folder.ts";

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
	/** false: the cwd is a stand-in (a home folder for a folder that is gone), never a writable root. */
	cwdWritable?: boolean;
	/** true: the read-only level whatever the policy file says (`--sandbox-read-only`); only ever tightens. */
	readOnly?: boolean;
	/** The session tmp, when the caller chose it; else `sessionTmpDir(sessionId)`. prepareSessionCommand keeps its proxy socket in its parent, and removes that parent on dispose. */
	tmpDir?: string;
	home?: string;
	platform?: NodeJS.Platform;
	/** Only its platform lists are read; defaults to `backendFor(platform)`. */
	backend?: Pick<Backend, "platformDefaults">;
	/** A top-level session's shared folder when the caller knows it (an unconfined worker's inherited `SOVA_SHARED_DIR`); else its own chat's. */
	shared?: string;
}

/**
 * The shared folder a session's policy makes writable: a worker's is its parent scope's (resolvePolicy
 * reads it there); a top-level session's is its own chat's, by its session id. None without an id.
 */
export function sessionSharedFolder(input: Pick<SessionPolicyInput, "sessionId" | "parent" | "home" | "shared">): string | undefined {
	if (input.parent) return input.parent.shared;
	if (input.shared) return input.shared;
	const key = sessionDirKey(input.sessionId, "");
	return key ? chatSharedFolder(key, input.home ?? homedir()) : undefined;
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
	// A worktree whose folder is gone (it retired) is no root: a missing path would stop every command from starting.
	const roots = (input.worktreeRoots ?? []).filter((r) => existsSync(r));
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
		...(input.cwdWritable === false ? { cwdWritable: false } : {}),
		...(input.readOnly === true ? { readOnly: true } : {}),
		extraWritable: roots,
		extraReadOnly: roots.map((r) => join(r, ".agent")),
		...(input.parent ? {} : { shared: sessionSharedFolder({ ...input, home }) }),
	});
}

export type PreparedSessionCommand = Confined & { dispose(): Promise<void> };

/**
 * Runtime-free whole-command launch for a hosted tool. Uses the same resolver, proxy and exact
 * backend probe as the extension. The caller must supply the session's effective parent scope;
 * a script never supplies any of this input. No fallback to an unconfined argv is possible.
 * A private attempt tmp/proxy avoid changing resources owned by the chat's extension.
 */
export async function prepareSessionCommand(
	input: SessionPolicyInput,
	argv: readonly string[],
	/** `proxy`: off-by-default options for this attempt's own proxy only (proxy.ts); the chat's proxy never gets them. */
	options: { env?: Record<string, string>; backend?: Backend; proxy?: Pick<ProxyOptions, "forbid" | "local" | "admit"> } = {},
): Promise<Result<PreparedSessionCommand>> {
	if (!argv.length || argv.some((s) => !s || s.includes("\0"))) return { ok: false, error: "invalid command argv" };
	let proxy: ProxyHandle | undefined;
	let tmp: string | undefined;
	let confined: Confined | undefined;
	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		try { await confined?.cleanup?.(); } finally {
			try { await proxy?.close(); } finally { if (tmp) rmSync(dirname(tmp), { recursive: true, force: true }); }
		}
	};
	try {
		const resourceId = `${input.sessionId || "session"}-tool-${randomUUID()}`;
		// A caller's own tmp (a tour recording on macOS, whose browser sockets need a short path): made here, and removed with its parent like the default.
		if (input.tmpDir) mkdirSync(input.tmpDir, { recursive: true, mode: 0o700 });
		tmp = input.tmpDir ?? ensureSessionTmpDir(resourceId);
		const backend = options.backend ?? backendFor(input.platform);
		const resolved = resolveSessionPolicy({ ...input, tmpDir: tmp, backend });
		if (!resolved.ok) { await dispose(); return resolved; }
		const p = resolved.value;
		if (p.outsideParent) { await dispose(); return { ok: false, error: "session cwd is outside its parent's sandbox" }; }
		// A writable root must exist to be bound.
		if (p.shared) ensureSharedFolder(p.shared);
		let network: Policy["network"] = { mode: p.writeOnly ? "host" : "none" };
		if (p.level === "workspace-write" && !p.writeOnly) {
			// Failure tightens to no network, just as snapshot() does.
			// Beside a caller's own tmp (private, gone with the attempt): that caller chose it for its short path, and a socket under a long TMPDIR would mean no network.
			const socket = input.tmpDir ? join(dirname(input.tmpDir), "p.sock") : proxySocketPath(resourceId);
			try { proxy = await startProxy({ socket, allow: p.proxyAllow, ...options.proxy }); } catch { /* no network */ }
			if (proxy) network = { mode: "proxy", proxy: { socket: proxy.socket, allow: p.proxyAllow } };
		}
		const policy: Policy = {
			level: p.level, workspaceRoot: p.workspaceRoot, writable: p.writable,
			readOnlyWithinWritable: p.readOnlyWithinWritable, hidden: p.hidden, tmpDir: p.tmpDir,
			shadowed: p.shadowed, network, sessionId: input.sessionId,
			env: p.writeOnly ? hostEnv(process.env) : scrubEnv(process.env, p.envAllow),
			// The policy's `browser` (a worker: its parent's), as the extension's snapshot() passes it.
			...(p.browser ? { browser: true } : {}),
		};
		const probe = await backend.probe(policy);
		if (!probe.ok) { await dispose(); return { ok: false, error: probe.reason }; }
		if (probe.enforcement === "partial" && !p.acceptPartial) {
			await dispose(); return { ok: false, error: `partial sandbox enforcement: ${(probe.reasons ?? []).join("; ")}` };
		}
		const result = await backend.confine({ argv: [...argv], cwd: input.cwd, policy, env: options.env });
		if (!result.ok) { await dispose(); return { ok: false, error: result.reason }; }
		confined = result.confined;
		if (confined.enforcement === "partial" && !p.acceptPartial) {
			await dispose(); return { ok: false, error: "partial sandbox enforcement is not accepted" };
		}
		return { ok: true, value: { ...confined, dispose } };
	} catch (error) {
		await dispose();
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
