/**
 * The sandbox seam: the platform-neutral types every caller above the backend sees, the shared
 * path canonicalisation, the run classifier, and `backendFor(platform)`.
 *
 * Node builtins only; nothing here knows what bwrap, Seatbelt or a mount is. A backend turns a
 * `Policy` plus an argv into another argv (`confine`) and proves it can enforce that policy on
 * this machine (`probe`). Silent unconfined passthrough is never a legal answer: a backend that
 * cannot enforce returns `{ ok: false }` and the caller refuses the tool call.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { LinuxBwrapBackend } from "./backends/linux-bwrap.ts";
import { UnsupportedBackend } from "./backends/unsupported.ts";

/** "full" is OFF: it never reaches a backend. */
export type Level = "read-only" | "workspace-write" | "full";
/** "host" only exists with level "full", so a backend never sees it either. */
export type NetworkMode = "none" | "proxy" | "host";
export type Enforcement = "full" | "partial";
export type BackendId = "linux-bwrap" | "darwin-seatbelt" | "windows-restricted-token" | "unsupported";

export interface Policy {
	level: Exclude<Level, "full">;
	/** Canonical (realpath) session cwd. Writable under workspace-write, readable under read-only. */
	workspaceRoot: string;
	/** Canonical writable roots, workspaceRoot included; ignored under read-only. Missing ones are skipped. */
	writable: string[];
	/** Canonical paths inside a writable root that stay read-only (e.g. <root>/.git/hooks).
	 * The backend adds the git ones by itself (see `gitProtectedPaths`); this list is extra. */
	readOnlyWithinWritable: string[];
	/** Canonical secrets and service paths: a directory becomes empty and read-only, a file cannot
	 * be opened at all (EACCES on Linux). The policy file itself belongs here. Missing ones are skipped. */
	hidden: string[];
	/** Per-session host directory that the sandbox sees as its temp dir (Linux: mounted at /tmp). */
	tmpDir: string;
	network: {
		mode: Exclude<NetworkMode, "host">;
		/** Mode "proxy": the host-side proxy's Unix socket (proxy.ts). Allowlisting happens there. */
		proxy?: { socket: string; allow: string[] };
		/** Not implemented yet (plan §8 option A); a non-empty list is reported in `notes`. */
		localPorts?: number[];
	};
	/** The already-scrubbed environment (env.ts `scrubEnv`). Backends add, never widen. */
	env: Record<string, string>;
	sessionId: string;
	/** Sandbox-owned stand-ins for host paths (caches): inside the sandbox `path` shows `source`,
	 * writable, so what a sandboxed tool writes there is never read by a host tool. Canonical.
	 * Build `source` with `shadowSource`. Ignored under read-only. */
	shadowed?: Shadow[];
}

export interface Shadow {
	path: string;
	source: string;
}

export interface ConfineRequest {
	/** What would run unconfined, e.g. [shell, "-c", command]. Never joined into a shell string. */
	argv: string[];
	cwd: string;
	policy: Policy;
	/** Per-call variables the caller has vetted (pi's PI_SESSION_ID and friends); merged over policy.env. */
	env?: Record<string, string>;
}

export interface RunnerFailureSpec {
	/** Output lines (line-anchored regex sources) that mean the runner failed and the command never ran. */
	fatalSignatures: string[];
	allowedExitCodes?: number[];
	/** Lines the runner prints that are not failures; removed before matching. */
	informationalLines?: string[];
}

export interface Confined {
	/** What to spawn instead of request.argv; spawn it directly, never through a shell. */
	argv: string[];
	/** Environment to spawn it with (policy env + request env + backend additions such as TMPDIR, proxy vars). */
	env: Record<string, string>;
	enforcement: Enforcement;
	partialReasons?: string[];
	/** The network mode actually applied: "proxy" degrades to "none", never to "host". */
	network: Exclude<NetworkMode, "host">;
	/** Tightening degradations and unimplemented options, for the tool result and session entry. */
	notes?: string[];
	/** Output substrings meaning "the sandbox refused something the command tried". */
	denialSignatures: string[];
	runnerFailure: RunnerFailureSpec;
	cleanup?: () => Promise<void>;
}

export type ConfineResult =
	| { ok: true; confined: Confined }
	| { ok: false; code: "SANDBOX_UNAVAILABLE"; reason: string };

export type ProbeResult =
	| { ok: true; enforcement: Enforcement; reasons?: string[]; network: Exclude<NetworkMode, "host">; notes?: string[] }
	| { ok: false; reason: string };

/** Platform lists the policy resolver starts from (plan v2 §2.4: the one leak of platform into policy). */
export interface PlatformDefaults {
	hidden: string[];
	writable: string[];
	readOnlyWithinWritable: string[];
	/** Host paths the sandbox gets a private writable copy of (caches); see Policy.shadowed. */
	shadowed: string[];
}

export interface PlatformContext {
	home: string;
	/** pi's agent dir (getAgentDir()/PI_CODING_AGENT_DIR), never assumed to be ~/.pi/agent. */
	agentDir: string;
}

export interface Backend {
	readonly id: BackendId;
	/** Runs the REAL profile for this policy against a no-op plus self-checks; cached per policy for the session. */
	probe(policy: Policy): Promise<ProbeResult>;
	confine(req: ConfineRequest): Promise<ConfineResult>;
	/** Canonical spelling of a path for the in-process file-tool checks. */
	canonicalize(path: string): Promise<string>;
	platformDefaults(ctx: PlatformContext): PlatformDefaults;
}

export function backendFor(platform: NodeJS.Platform = process.platform): Backend {
	if (platform === "linux") return new LinuxBwrapBackend();
	return new UnsupportedBackend(platform);
}

// ─── shared helpers (platform-neutral) ──────────────────────────────────────────────────────────

/**
 * realpath of the deepest existing ancestor, then the rest resolved lexically. So a symlink that
 * points out of a root is seen at its real location, and a path that does not exist yet still has
 * a canonical spelling.
 */
export function canonicalizePath(path: string, base = process.cwd()): string {
	let head = isAbsolute(path) ? resolve(path) : resolve(base, path);
	const rest: string[] = [];
	for (;;) {
		try {
			return rest.length ? join(realpathSync(head), ...rest.reverse()) : realpathSync(head);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			const parent = dirname(head);
			if (parent === head) return resolve(path);
			rest.push(head.slice(parent === sep ? 1 : parent.length + 1));
			head = parent;
		}
	}
}

/** True when `child` is `root` or below it; both must already be canonical. */
export function isWithin(child: string, root: string): boolean {
	if (child === root) return true;
	return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A stable key for probe caching: the policy with its lists sorted. */
export function policyKey(policy: Policy): string {
	const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
	return JSON.stringify({
		level: policy.level,
		workspaceRoot: policy.workspaceRoot,
		writable: sorted(policy.writable),
		readOnlyWithinWritable: sorted(policy.readOnlyWithinWritable),
		hidden: sorted(policy.hidden),
		tmpDir: policy.tmpDir,
		network: { mode: policy.network.mode, socket: policy.network.proxy?.socket, localPorts: policy.network.localPorts ?? [] },
		env: Object.keys(policy.env).sort(),
		shadowed: (policy.shadowed ?? []).map((sh) => `${sh.path}=${sh.source}`).sort(),
	});
}

/**
 * The git paths that run code later on the host, for a root that may hold a repo or a linked
 * worktree: hooks, config (core.hooksPath, fsmonitor, textconv, aliases…), config.worktree,
 * a `.git` gitfile and a worktree's `commondir` (both redirect git to another directory), and
 * the linked-worktree admin dir (so one worktree cannot redirect another). A linked worktree's
 * own git dir and the common dir are outside the root, so they are returned as extra writable
 * roots; without them nothing can be committed.
 */
export function gitProtectedPaths(root: string): { writable: string[]; readOnly: string[]; ensureDirs: string[] } {
	const writable: string[] = [];
	const readOnly: string[] = [];
	const ensureDirs: string[] = [];
	const dotGit = join(root, ".git");
	let st;
	try {
		st = lstatSync(dotGit);
	} catch {
		// Not a repo: a `.git` created here (git init, or a file tool writing .git/hooks/x) would
		// be run by the host's git later. The in-process tools refuse it; bwrap cannot bind a
		// path that does not exist, so under bash this stays a stated gap.
		readOnly.push(dotGit);
		return { writable, readOnly, ensureDirs };
	}
	// A linked worktree's admin dir has no hooks of its own (git uses the common dir's), so only a
	// full git dir gets a missing hooks dir created before it is bound read-only.
	const protectGitDir = (g: string, full: boolean) => {
		if (full) ensureDirs.push(join(g, "hooks"));
		readOnly.push(join(g, "hooks"), join(g, "config"), join(g, "config.worktree"), join(g, "commondir"), join(g, "worktrees"));
		for (const m of subdirs(join(g, "modules"))) readOnly.push(join(g, "modules", m, "hooks"), join(g, "modules", m, "config"));
	};
	if (st.isDirectory()) {
		protectGitDir(canonicalizePath(dotGit), true);
	} else if (st.isFile()) {
		readOnly.push(canonicalizePath(dotGit));
		const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
		if (m) {
			const gitDir = canonicalizePath(resolve(root, m[1]!));
			writable.push(gitDir);
			let common: string | undefined;
			try {
				common = canonicalizePath(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
			} catch {}
			protectGitDir(gitDir, !common || common === gitDir);
			// The admin dir's back-pointer to this worktree: host `git worktree prune/repair` trusts it
			// (prune deletes the admin dir if it points nowhere; repair writes a gitfile where it
			// points). Only `git worktree move/repair` write it. The admin dir's own HEAD stays
			// writable: it is this session's branch, and commit/checkout/switch must update it.
			if (common && common !== gitDir) readOnly.push(join(gitDir, "gitdir"));
			if (common && common !== gitDir) {
				writable.push(common);
				// <common>/worktrees becomes read-only; this worktree's own admin dir sits inside it
				// and is re-exposed writable by its deeper bind.
				protectGitDir(common, true);
				// The main checkout's own HEAD and index live in the common dir: not this session's.
				readOnly.push(join(common, "HEAD"), join(common, "index"));
			}
		}
	}
	return { writable, readOnly, ensureDirs };
}

function subdirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
}

/**
 * Host trust stores: a directory whose entries tell a host tool to run a project's config
 * unasked (mise runs a trusted .mise.toml's env and hooks on cd; direnv loads an allowed .envrc).
 * Always read-only when a writable root holds them, and created first so an absent one cannot be
 * planted. Not a policy option: the policy file cannot turn this off.
 */
export function trustStores(env: Record<string, string | undefined>): string[] {
	// Every location the tool might use: the configured one and the default, since the host
	// shell that later reads the store may not share this process's variables.
	const home = env.HOME || homedir();
	const states = uniq([env.XDG_STATE_HOME, join(home, ".local", "state")].filter((x): x is string => !!x));
	const datas = uniq([env.XDG_DATA_HOME, join(home, ".local", "share")].filter((x): x is string => !!x));
	const mises = uniq([env.MISE_STATE_DIR, ...states.map((s) => join(s, "mise"))].filter((x): x is string => !!x));
	return [
		...mises.flatMap((m) => [join(m, "trusted-configs"), join(m, "tracked-configs")]),
		...datas.flatMap((d) => [join(d, "direnv", "allow"), join(d, "direnv", "deny")]),
	];
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * What a policy lets a sandboxed tool write, as host paths: the one source for the OS backend's
 * mounts and the in-process file tools' checks, so the two cannot drift. All canonical.
 * - `writable`: existing writable roots (workspace-write only), plus a linked worktree's git dirs.
 * - `readOnly`: paths inside those roots that stay read-only: git's (`gitProtectedPaths`), the
 *   host trust stores (`trustStores`) and the policy's `readOnlyWithinWritable`. Missing paths
 *   are kept: a write that would create one is refused too.
 * - `hidden`: the policy's hidden paths.
 * - `ensureDirs`: dirs a mounting backend creates first so they can be bound read-only.
 */
export interface WriteSet {
	/** Real writable roots plus the shadowed paths (as the sandbox sees them). */
	writable: string[];
	readOnly: string[];
	hidden: string[];
	ensureDirs: string[];
	/** Canonical, workspace-write only; a shadow whose host path is missing is created on use. */
	shadowed: Shadow[];
}

/**
 * Where a shadowed path's contents live: <agentDir>/sova/sandbox/shadow/<name>, with <name> the
 * path relative to home ("home-.cache") or to / ("root-…"), "%" and "/" percent-encoded so two
 * paths never share a name. Shared by every sandboxed session and kept between them.
 */
export function shadowSource(agentDir: string, path: string, home = homedir()): string {
	const abs = resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
	const enc = (x: string) => x.replaceAll("%", "%25").replaceAll("/", "%2F");
	const name = isWithin(abs, home) && abs !== home ? `home-${enc(abs.slice(home.length + 1))}` : `root-${enc(abs.slice(1))}`;
	return join(agentDir, "sova", "sandbox", "shadow", name);
}

function shadowsOf(policy: Policy): Shadow[] {
	if (policy.level !== "workspace-write") return [];
	const seen = new Set<string>();
	const out: Shadow[] = [];
	for (const s of policy.shadowed ?? []) {
		const path = canonicalizePath(s.path);
		if (seen.has(path)) continue;
		seen.add(path);
		out.push({ path, source: canonicalizePath(s.source) });
	}
	return out;
}

/**
 * A path as the sandbox sees it → where it lives on the host: under a shadowed path it moves to
 * the shadow's source, unless a deeper real writable root holds it (a workspace inside ~/.cache).
 * Everything else is unchanged. File tools check the VIEW path with checkWrite, then act on this.
 */
export function mapShadowed(policy: Policy, path: string, base = policy.workspaceRoot): string {
	const p = canonicalizePath(path, base);
	const shadow = shadowsOf(policy).filter((s) => isWithin(p, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
	if (!shadow) return p;
	const real = uniq([policy.workspaceRoot, ...policy.writable].map((w) => canonicalizePath(w))).filter((w) => isWithin(p, w) && w.length > shadow.path.length);
	if (real.length) return p;
	return p === shadow.path ? shadow.source : join(shadow.source, p.slice(shadow.path.length + 1));
}

export function writeSet(policy: Policy): WriteSet {
	const hidden = uniq(policy.hidden.map((p) => canonicalizePath(p)));
	if (policy.level !== "workspace-write") return { writable: [], readOnly: [], hidden, ensureDirs: [], shadowed: [] };
	const shadowed = shadowsOf(policy);
	const writable = uniq([policy.workspaceRoot, ...policy.writable].map((p) => canonicalizePath(p))).filter(isDir);
	const readOnly: string[] = [];
	const ensureDirs: string[] = [];
	for (const root of [...writable]) {
		const git = gitProtectedPaths(root);
		writable.push(...git.writable.filter(isDir));
		readOnly.push(...git.readOnly);
		ensureDirs.push(...git.ensureDirs);
	}
	const stores = trustStores({ ...process.env, ...policy.env }).map((p) => canonicalizePath(p));
	readOnly.push(...policy.readOnlyWithinWritable.map((p) => canonicalizePath(p)), ...stores);
	ensureDirs.push(...stores);
	// Git detection reads the host tree, so it runs on real roots only; a shadow is sandbox-private
	// (no host tool reads it), and the policy's own read-only and hidden paths still apply inside.
	const finalWritable = uniq([...writable, ...shadowed.map((s) => s.path)]);
	const inWritable = (p: string) => finalWritable.some((w) => isWithin(p, w));
	return { writable: finalWritable, readOnly: uniq(readOnly).filter(inWritable), hidden, ensureDirs: uniq(ensureDirs), shadowed };
}

export type WriteCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

/**
 * The in-process write/edit check, same rules as the OS backend: `path` (any spelling) may be
 * written iff its canonical location is in the session tmp dir, or in a writable root and in no
 * read-only or hidden path. A symlink is judged at its target.
 */
export function checkWrite(policy: Policy, path: string, base = policy.workspaceRoot): WriteCheck {
	const p = canonicalizePath(path, base);
	const set = writeSet(policy);
	const hit = (xs: string[]) => xs.find((x) => isWithin(p, x));
	const hidden = hit(set.hidden);
	if (hidden) return { ok: false, path: p, reason: `sandbox: ${p} is hidden by the policy (${hidden})` };
	// A deeper writable root (a linked worktree's own admin dir inside <common>/worktrees) wins
	// over a shallower read-only path, exactly as the mounts stack.
	const ro = set.readOnly.filter((r) => isWithin(p, r)).sort((a, b) => b.length - a.length)[0];
	const rw = set.writable.filter((w) => isWithin(p, w)).sort((a, b) => b.length - a.length)[0];
	if (ro && !(rw && rw.length > ro.length)) return { ok: false, path: p, reason: `sandbox: ${p} is read-only inside the workspace (${ro})` };
	if (rw || isWithin(p, canonicalizePath(policy.tmpDir))) return { ok: true, path: p };
	return { ok: false, path: p, reason: `sandbox: ${p} is outside the writable roots` };
}

export type RunClass =
	/** Exit 0, or a nonzero exit with nothing sandbox-shaped in the output: the command's own result. */
	| { kind: "ok" | "failed" }
	/** The command ran and something it tried was refused by the policy; show output plus the note. */
	| { kind: "denied"; note: string }
	/** The runner failed before the command ran: a tool error naming the sandbox, never command output. */
	| { kind: "runner-failure"; message: string };

export const DENIAL_NOTE = "[sandbox: a write or connection outside the policy was refused]";

/**
 * Classify a finished confined run (plan v2 §2.2). Runner failure wins over denial: a runner
 * that never started the command cannot have been denied anything.
 */
export function classifyRun(confined: Confined, run: { exitCode: number | null; output: string }): RunClass {
	if (run.exitCode === 0) return { kind: "ok" };
	const spec = confined.runnerFailure;
	if (run.exitCode === null || !spec.allowedExitCodes?.includes(run.exitCode)) {
		const informational = (spec.informationalLines ?? []).map((s) => new RegExp(s));
		const fatal = spec.fatalSignatures.map((s) => new RegExp(s));
		const lines = run.output.split(/\r?\n/).filter((l) => !informational.some((re) => re.test(l)));
		const hit = lines.find((l) => fatal.some((re) => re.test(l)));
		if (hit !== undefined) return { kind: "runner-failure", message: `sandbox runner failed, the command did not run: ${hit.trim()}` };
	}
	if (confined.denialSignatures.some((s) => run.output.includes(s))) return { kind: "denied", note: DENIAL_NOTE };
	return { kind: "failed" };
}
