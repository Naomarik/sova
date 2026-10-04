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
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Backend, backendFor, type FdPayload, type Policy, type Shadow } from "./backend.ts";
import { hostEnv, scrubEnv } from "./env.ts";
import { canonicalize, isWithin, type ParentScope, parseParentScope, workerCwdRefusal } from "./policy.ts";
import { type ProxyHandle, proxySocketPath, startProxy } from "./proxy.ts";
import { resolveSessionPolicy, sessionTmpBase, sessionTmpDir } from "./session-policy.ts";

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
	/** The sandbox tmp on the host, and as the program sees it (Linux `/tmp`, or the host path under a
	 * write-only scope, which keeps the host's /tmp; macOS the host path). */
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

/** A worker id as it may name a directory and a socket. */
export const OWNER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function encodeLaunchScope(scope: LaunchScope): string {
	return JSON.stringify(scope);
}

export function decodeLaunchScope(scope: string): { ok: true; value: LaunchScope } | { ok: false; error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(scope);
	} catch {
		return { ok: false, error: "the launch scope is not valid JSON" };
	}
	const r = raw as Partial<Record<keyof LaunchScope, unknown>> | null;
	if (!r || typeof r !== "object" || r.v !== 1 || typeof r.agentDir !== "string" || !isAbsolute(r.agentDir) || typeof r.sessionId !== "string" || typeof r.owner !== "string" || !OWNER_ID.test(r.owner) || r.owner === "." || r.owner === "..") {
		return { ok: false, error: "the launch scope is malformed" };
	}
	const parent = parseParentScope(r.parent);
	if (!parent.ok) return { ok: false, error: `the launch scope is malformed: ${parent.error}` };
	return { ok: true, value: { v: 1, agentDir: r.agentDir, sessionId: r.sessionId, owner: r.owner, parent: parent.value } };
}

function mustDecode(scope: string): LaunchScope {
	const d = decodeLaunchScope(scope);
	if (!d.ok) throw new Error(d.error);
	return d.value;
}

/** `<sandbox tmp base>/<parent session>/w-<owner>`: beside the parent's own tmp, never inside it. */
function workerDir(s: LaunchScope): string {
	return join(sessionTmpDir(s.sessionId), "..", `w-${s.owner}`);
}

/** The sandbox tmp of a scope's worker (made 0700): write launch files here before `confineLaunch`. */
export function workerTmpDir(scope: string, needs?: Pick<LaunchNeeds, "tmpDir">, platform: NodeJS.Platform = process.platform): { host: string; inside: string } {
	const s = mustDecode(scope);
	let host: string;
	if (needs?.tmpDir) {
		host = needs.tmpDir;
		mkdirSync(host, { recursive: true, mode: 0o700 });
	} else {
		const base = sessionTmpBase();
		mkdirSync(base, { recursive: true, mode: 0o700 });
		const st = lstatSync(base);
		if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${base} is not a private directory of this user`);
		host = join(workerDir(s), "tmp");
		mkdirSync(host, { recursive: true, mode: 0o700 });
	}
	host = canonicalize(host);
	// A write-only scope keeps the host's /tmp, and its tmp is writable at its own path (also when
	// the backend falls back to a private /tmp: the tmp is a writable root, bound in place too).
	return { host, inside: platform === "linux" && !s.parent.writeOnly ? "/tmp" : host };
}

/** Remove the default sandbox tmp when the worker is gone for good (never a `needs.tmpDir`). */
export function releaseWorkerTmp(scope: string): void {
	const d = decodeLaunchScope(scope);
	if (!d.ok) return;
	try {
		rmSync(workerDir(d.value), { recursive: true, force: true });
	} catch {
		// A leftover is harmless: the parent's session dir goes at its shutdown.
	}
}

function validateNeeds(needs: LaunchNeeds): string | undefined {
	const paths = [...(needs.writable ?? []), ...(needs.binds ?? []).flatMap((b) => [b.source, b.target]), ...(needs.tmpDir ? [needs.tmpDir] : [])];
	const rel = paths.find((p) => typeof p !== "string" || !isAbsolute(p));
	if (rel !== undefined) return `needs a path that is absolute: ${String(rel)}`;
	const fds = (needs.fds ?? []).map((f) => f.fd);
	if (fds.some((fd) => !Number.isInteger(fd) || fd < 3) || new Set(fds).size !== fds.length) return "needs fds that are distinct integers >= 3";
	const names = [...Object.keys(needs.env ?? {}), ...Object.keys(needs.secretEnv ?? {})];
	if (names.some((n) => !ENV_NAME.test(n))) return "needs variable names of letters, digits and _";
	if ((needs.proxyHosts ?? []).some((h) => typeof h !== "string" || !h.trim())) return "needs proxy hosts that are non-empty strings";
	return undefined;
}

export interface ConfineLaunchOptions {
	/** Test seam; defaults to `backendFor(platform)`. */
	backend?: Backend;
	platform?: NodeJS.Platform;
}

/**
 * The launch, confined: the policy resolved as a pi worker's (the parent's scope), the backend
 * probed once, a proxy of its own (the policy's hosts plus `needs.proxyHosts`; only the latter under
 * read-only; the host network under a write-only scope), the environment scrubbed plus
 * `needs.env`, secrets on an fd. Refuses rather than run unconfined.
 */
export async function confineLaunch(scope: string, needs: LaunchNeeds, launch: LaunchCommand, opts: ConfineLaunchOptions = {}): Promise<ConfineLaunchResult> {
	const decoded = decodeLaunchScope(scope);
	if (!decoded.ok) return { refused: `Sandbox: ${decoded.error}; the worker cannot start sandboxed.` };
	const s = decoded.value;
	const bad = validateNeeds(needs);
	if (bad) return { refused: `Sandbox: a confined launch ${bad}.` };
	const platform = opts.platform ?? process.platform;
	const backend = opts.backend ?? backendFor(platform);
	const unavailable = (why: string) => ({ refused: `Sandbox unavailable: ${why}. A worker cannot start sandboxed.` });

	let tmp: { host: string; inside: string };
	try {
		tmp = workerTmpDir(scope, needs, platform);
	} catch (e) {
		return unavailable(`cannot create the worker's tmp: ${(e as Error).message}`);
	}
	// The same resolution a pi worker's own extension makes under this parent scope.
	const resolved = resolveSessionPolicy({ agentDir: s.agentDir, cwd: launch.cwd, sessionId: s.sessionId, tmpDir: tmp.host, parent: s.parent, platform, backend });
	if (!resolved.ok) return unavailable(resolved.error);
	const policy = resolved.value;
	if (policy.outsideParent) return { refused: workerCwdRefusal(s.parent, launch.cwd) ?? "Sandbox: worker cwd is outside the parent's sandbox" };

	// The program's own state. Never under a hidden path or the policy dir, never over the agent dir.
	const binds: Shadow[] = [
		...(needs.writable ?? []).map((p) => ({ path: canonicalize(p), source: canonicalize(p) })),
		...(needs.binds ?? []).map((b) => ({ path: canonicalize(b.target), source: canonicalize(b.source) })),
	];
	for (const b of binds) {
		if (!existsSync(b.source)) return unavailable(`${b.source} does not exist`);
		for (const p of new Set([b.path, b.source])) {
			if (isWithin(p, policy.policyDir) || isWithin(policy.agentDir, p)) return unavailable(`${p} would make the agent dir or the policy writable`);
			if (policy.hidden.some((h) => isWithin(p, h) || isWithin(h, p))) return unavailable(`${p} holds or is inside a path the policy hides`);
		}
	}

	const notes: string[] = [];
	let proxy: ProxyHandle | undefined;
	let network: Policy["network"] = { mode: policy.writeOnly ? "host" : "none" };
	if (!policy.writeOnly) {
		const extra = (needs.proxyHosts ?? []).map((h) => h.trim().toLowerCase());
		const allow = [...new Set(policy.level === "workspace-write" ? [...policy.proxyAllow, ...extra] : extra)];
		if (policy.level === "workspace-write" || allow.length) {
			try {
				// One proxy per launch: a relaunch never shares a socket with a process still closing.
				proxy = await startProxy({ socket: proxySocketPath(`w:${s.sessionId}:${s.owner}:${randomBytes(6).toString("hex")}`), allow });
				network = { mode: "proxy", proxy: { socket: proxy.socket, allow } };
			} catch (e) {
				notes.push(`network: the proxy did not start (${(e as Error).message}); the sandbox has no network`);
			}
		}
	}
	const refuse = async (r: { refused: string }) => {
		await proxy?.close().catch(() => {});
		return r;
	};

	const backendPolicy: Policy = {
		level: policy.level,
		workspaceRoot: policy.workspaceRoot,
		writable: policy.writable,
		readOnlyWithinWritable: policy.readOnlyWithinWritable,
		hidden: policy.hidden,
		tmpDir: policy.tmpDir,
		shadowed: policy.shadowed,
		network,
		env: policy.writeOnly ? hostEnv(launch.env) : scrubEnv(launch.env, policy.envAllow),
		sessionId: `${s.sessionId}.w-${s.owner}`,
		...(binds.length ? { binds } : {}),
		...(policy.writeOnly ? { hostTmp: true } : {}),
	};
	const probe = await backend.probe(backendPolicy);
	if (!probe.ok) return refuse(unavailable(probe.reason));
	if (probe.enforcement === "partial" && !policy.acceptPartial) {
		return refuse({ refused: `Sandbox enforcement is partial (${probe.reasons?.join("; ") ?? "unknown reason"}); set acceptPartial in the sandbox policy to start unattended workers.` });
	}
	const secretEnv = needs.secretEnv ?? {};
	const hasSecrets = Object.keys(secretEnv).length > 0;
	// The whole environment goes on an fd where a backend would put it on argv (a write-only one is
	// the host's, with whatever tokens it holds).
	const secretFd = Math.max(2, ...(needs.fds ?? []).map((f) => f.fd)) + 1;
	const res = await backend.confine({
		argv: [launch.command, ...launch.args],
		cwd: launch.cwd,
		policy: backendPolicy,
		env: { ...(needs.env ?? {}) },
		secretFd,
		envOnFd: true,
		...(hasSecrets ? { secretEnv } : {}),
	});
	if (!res.ok) return refuse(unavailable(res.reason));
	const c = res.confined;
	const inside = { ...c.env };
	for (const k of Object.keys(secretEnv)) delete inside[k];
	// bwrap clears the environment inside, so its own process carries only what outside readers
	// need. Elsewhere the spawned process is the confined one: what it sees wins.
	const spawnEnv = backend.id === "linux-bwrap" ? { ...(needs.spawnEnv ?? {}) } : { ...(needs.spawnEnv ?? {}), ...inside };
	const allNotes = [...notes, ...(probe.notes ?? []), ...(c.notes ?? [])];
	let closed = false;
	return {
		command: c.argv[0]!,
		args: c.argv.slice(1),
		env: inside,
		spawnEnv,
		fds: [...(needs.fds ?? []), ...(c.fds ?? [])],
		tmpDir: tmp.host,
		tmpInside: tmp.inside,
		enforcement: probe.enforcement,
		...(allNotes.length ? { notes: [...new Set(allNotes)] } : {}),
		async cleanup() {
			if (closed) return;
			closed = true;
			await proxy?.close().catch(() => {});
			await c.cleanup?.().catch(() => {});
		},
	};
}
