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
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Backend, type Confined, type Policy, backendFor, gitProtectedPaths, shadowSource } from "./backend.ts";
import { hostEnv, scrubEnv } from "./env.ts";
import { proxySocketPath, startProxy, type ProxyHandle, type ProxyOptions } from "./proxy.ts";
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
		tmp = ensureSessionTmpDir(resourceId);
		const backend = options.backend ?? backendFor(input.platform);
		const resolved = resolveSessionPolicy({ ...input, tmpDir: tmp, backend });
		if (!resolved.ok) { await dispose(); return resolved; }
		const p = resolved.value;
		if (p.outsideParent) { await dispose(); return { ok: false, error: "session cwd is outside its parent's sandbox" }; }
		let network: Policy["network"] = { mode: p.writeOnly ? "host" : "none" };
		if (p.level === "workspace-write" && !p.writeOnly) {
			// Failure tightens to no network, just as snapshot() does.
			try { proxy = await startProxy({ socket: proxySocketPath(resourceId), allow: p.proxyAllow, ...options.proxy }); } catch { /* no network */ }
			if (proxy) network = { mode: "proxy", proxy: { socket: proxy.socket, allow: p.proxyAllow } };
		}
		const policy: Policy = {
			level: p.level, workspaceRoot: p.workspaceRoot, writable: p.writable,
			readOnlyWithinWritable: p.readOnlyWithinWritable, hidden: p.hidden, tmpDir: p.tmpDir,
			shadowed: p.shadowed, network, sessionId: input.sessionId,
			env: p.writeOnly ? hostEnv(process.env) : scrubEnv(process.env, p.envAllow),
			...(p.writeOnly ? { hostTmp: true } : {}),
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
