/**
 * The sandbox policy: load and validate `<agentDir>/sandbox-policy/<platform>/policy.json`, apply a
 * project's tighten-only `<cwd>/.sova/sandbox.json`, canonicalise paths, and answer the in-process
 * file tools' two questions (may this canonical path be read? written?).
 *
 * Node builtins only, no pi imports: unit-testable with node --test and importable by Sova's
 * server later. The caller supplies the agent dir (pi's getAgentDir()), never a hard-coded path.
 *
 * Fail closed: a missing, unreadable or invalid policy file is an error, and the caller turns
 * every tool into a refusal. Unknown keys are errors too, so a typo ("hiden") can never silently
 * drop a protection.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isLevel, type SandboxLevel } from "./state.ts";

export const POLICY_DIR_NAME = "sandbox-policy";
export const POLICY_FILE_NAME = "policy.json";
/** The per-project tightening file, relative to the session cwd. */
export const PROJECT_FILE = join(".sova", "sandbox.json");

/** The policy file as written by the user. */
export interface PolicyFile {
	version: 1;
	level: SandboxLevel;
	defaultOn: boolean;
	/** Extra writable roots besides the cwd and the session tmp. Dropped under read-only. */
	writable: string[];
	/** Host paths (caches) the sandbox sees as a private writable copy. Dropped under read-only. */
	shadowed: string[];
	/** Read as empty inside the sandbox; refused by the file tools. */
	hidden: string[];
	/** Read-only overlays inside writable roots. Relative entries are relative to the cwd. */
	readOnlyWithinWritable: string[];
	proxy: { allow: string[] };
	env: { allow: string[] };
	acceptPartial: boolean;
}

/** The policy one tool call runs under: every path absolute and canonical. */
export interface ResolvedPolicy {
	level: SandboxLevel;
	defaultOn: boolean;
	/** Canonical session cwd. */
	workspaceRoot: string;
	writable: string[];
	readOnlyWithinWritable: string[];
	hidden: string[];
	proxyAllow: string[];
	envAllow: string[];
	acceptPartial: boolean;
	/** Canonical policy root (`<agentDir>/sandbox-policy`): always read-only, its policy.json files hidden. */
	policyDir: string;
	/** Canonical agent dir: always read-only (sessions, settings and extensions live there). */
	agentDir: string;
	/** Per-session tmp (host path), writable; bash sees it as /tmp. */
	tmpDir: string;
	/** Host paths the sandbox sees as a private writable copy (`path` shows `source`). Empty under read-only. */
	shadowed: { path: string; source: string }[];
	/** Visible notices (ignored project keys and the like), for the UI; never model context. */
	notices: string[];
	/** A worker whose cwd is outside its parent's writable roots: every tool refuses. */
	outsideParent?: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const KEYS = ["version", "level", "defaultOn", "writable", "shadowed", "hidden", "readOnlyWithinWritable", "proxy", "env", "acceptPartial"] as const;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

export function policyDir(agentDir: string, platform: string = process.platform): string {
	return join(agentDir, POLICY_DIR_NAME, platform);
}

export function policyFilePath(agentDir: string, platform: string = process.platform): string {
	return join(policyDir(agentDir, platform), POLICY_FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringList(v: unknown, what: string, check?: (s: string) => boolean): Result<string[]> {
	if (!Array.isArray(v)) return { ok: false, error: `${what} must be an array of strings` };
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== "string" || !x.trim()) return { ok: false, error: `${what} must hold non-empty strings` };
		if (check && !check(x.trim())) return { ok: false, error: `${what}: invalid entry ${JSON.stringify(x)}` };
		out.push(x.trim());
	}
	return { ok: true, value: out };
}

/** Validate a parsed policy file. Every key is required and no other key is allowed. */
export function validatePolicyFile(raw: unknown): Result<PolicyFile> {
	if (!isRecord(raw)) return { ok: false, error: "policy must be a JSON object" };
	for (const key of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(key)) return { ok: false, error: `unknown key ${JSON.stringify(key)}` };
	for (const key of KEYS) if (!(key in raw)) return { ok: false, error: `missing key ${JSON.stringify(key)}` };
	if (raw.version !== 1) return { ok: false, error: "version must be 1" };
	if (!isLevel(raw.level)) return { ok: false, error: `level must be "workspace-write" or "read-only"` };
	if (typeof raw.defaultOn !== "boolean") return { ok: false, error: "defaultOn must be a boolean" };
	if (typeof raw.acceptPartial !== "boolean") return { ok: false, error: "acceptPartial must be a boolean" };
	const writable = stringList(raw.writable, "writable");
	if (!writable.ok) return writable;
	const shadowed = stringList(raw.shadowed, "shadowed");
	if (!shadowed.ok) return shadowed;
	// A writable root at or inside a shadowed path is bound from the host over the shadow and would
	// reopen the host cache (deeper wins). Checked again on canonical paths in resolvePolicy.
	for (const w of writable.value) {
		const sh = shadowed.value.find((p) => w === p || w.startsWith(p.endsWith("/") ? p : `${p}/`));
		if (sh) return { ok: false, error: `writable ${JSON.stringify(w)} cannot be at or inside shadowed ${JSON.stringify(sh)}` };
	}
	const hidden = stringList(raw.hidden, "hidden");
	if (!hidden.ok) return hidden;
	const ro = stringList(raw.readOnlyWithinWritable, "readOnlyWithinWritable");
	if (!ro.ok) return ro;
	if (!isRecord(raw.proxy) || Object.keys(raw.proxy).some((k) => k !== "allow")) return { ok: false, error: "proxy must be { allow: [...] }" };
	const allow = stringList(raw.proxy.allow, "proxy.allow", (h) => HOST.test(h.toLowerCase()));
	if (!allow.ok) return allow;
	if (!isRecord(raw.env) || Object.keys(raw.env).some((k) => k !== "allow")) return { ok: false, error: "env must be { allow: [...] }" };
	const envAllow = stringList(raw.env.allow, "env.allow", (n) => ENV_NAME.test(n));
	if (!envAllow.ok) return envAllow;
	return {
		ok: true,
		value: {
			version: 1,
			level: raw.level,
			defaultOn: raw.defaultOn,
			writable: writable.value,
			shadowed: shadowed.value,
			hidden: hidden.value,
			readOnlyWithinWritable: ro.value,
			proxy: { allow: allow.value.map((h) => h.toLowerCase()) },
			env: { allow: envAllow.value },
			acceptPartial: raw.acceptPartial,
		},
	};
}

const fileCache = new Map<string, { mtimeMs: number; size: number; result: Result<PolicyFile> }>();

/** Read and validate the policy file, cached on (mtime, size): re-read on every tool call is cheap. */
export function loadPolicyFile(path: string): Result<PolicyFile> {
	let st;
	try {
		st = statSync(path);
	} catch {
		return { ok: false, error: `no policy file at ${path} (run pi-config/install.sh to seed it)` };
	}
	const cached = fileCache.get(path);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result;
	let result: Result<PolicyFile>;
	try {
		const parsed = validatePolicyFile(JSON.parse(readFileSync(path, "utf8")));
		result = parsed.ok ? parsed : { ok: false, error: `invalid policy ${path}: ${parsed.error}` };
	} catch (e) {
		result = { ok: false, error: `unreadable policy ${path}: ${(e as Error).message}` };
	}
	fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, result });
	return result;
}

/**
 * Apply a project's `.sova/sandbox.json`. It may only tighten: `level: "read-only"` lowers,
 * `hidden` and `readOnlyWithinWritable` add, `writable` and `proxy.allow` intersect. Anything else
 * (defaultOn, env, acceptPartial, unknown keys, a malformed value) is ignored with a notice.
 * The file sits in the writable tree, so it can never be a boundary: tighten-only is what makes
 * reading it safe.
 */
export function applyProjectTightening(base: PolicyFile, raw: unknown): { policy: PolicyFile; ignored: string[] } {
	const policy: PolicyFile = structuredClone(base);
	const ignored: string[] = [];
	if (!isRecord(raw)) return { policy, ignored: ["(not a JSON object)"] };
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "version":
				break;
			case "level":
				if (value === "read-only") policy.level = "read-only";
				else if (value !== base.level) ignored.push("level");
				break;
			case "hidden":
			case "readOnlyWithinWritable": {
				const list = stringList(value, key);
				if (list.ok) policy[key] = [...policy[key], ...list.value];
				else ignored.push(key);
				break;
			}
			case "writable":
			case "shadowed": {
				const list = stringList(value, key);
				if (!list.ok) ignored.push(key);
				else {
					const keep = new Set(list.value);
					if (list.value.some((w) => !base[key].includes(w))) ignored.push(`${key} (entries not in the global policy)`);
					policy[key] = base[key].filter((w) => keep.has(w));
				}
				break;
			}
			case "proxy": {
				const list = isRecord(value) ? stringList(value.allow, "proxy.allow") : undefined;
				if (!list?.ok || Object.keys(value as object).some((k) => k !== "allow")) ignored.push("proxy");
				else {
					const keep = new Set(list.value.map((h) => h.toLowerCase()));
					if (list.value.some((h) => !base.proxy.allow.includes(h.toLowerCase()))) ignored.push("proxy.allow (hosts not in the global policy)");
					policy.proxy = { allow: base.proxy.allow.filter((h) => keep.has(h)) };
				}
				break;
			}
			default:
				ignored.push(key);
		}
	}
	return { policy, ignored };
}

/** Read `<cwd>/.sova/sandbox.json` if present. Absent: no change. Malformed: no change, one notice. */
export function loadProjectTightening(cwd: string, base: PolicyFile): { policy: PolicyFile; notices: string[] } {
	let text: string;
	try {
		text = readFileSync(join(cwd, PROJECT_FILE), "utf8");
	} catch {
		return { policy: base, notices: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { policy: base, notices: ["Sandbox: `.sova/sandbox.json` is not valid JSON; ignored."] };
	}
	const { policy, ignored } = applyProjectTightening(base, raw);
	return { policy, notices: ignored.map((k) => `Sandbox: \`.sova/sandbox.json\` can only tighten; ignored \`${k}\`.`) };
}

export interface ExpandContext {
	home: string;
	agentDir: string;
	cwd: string;
}

/** `~`, `~/x`, `$AGENT_DIR/x` and cwd-relative paths to absolute ones. */
export function expandPath(p: string, c: ExpandContext): string {
	if (p === "~") return c.home;
	if (p.startsWith("~/")) return join(c.home, p.slice(2));
	if (p === "$AGENT_DIR") return c.agentDir;
	if (p.startsWith("$AGENT_DIR/")) return join(c.agentDir, p.slice("$AGENT_DIR/".length));
	return isAbsolute(p) ? resolve(p) : resolve(c.cwd, p);
}

/**
 * Canonical spelling of a path that may not exist yet: realpath of the deepest existing ancestor,
 * then the rest appended. A symlink anywhere in the existing part resolves to where it points, so
 * a link inside the workspace that leads outside it is judged by where it leads. A dangling
 * symlink as the last component resolves to its target too, so a write through it is judged by
 * where it would land.
 */
export function canonicalize(path: string): string {
	const abs = resolve(path);
	let head = abs;
	const rest: string[] = [];
	for (let hops = 0; ; ) {
		try {
			const real = realpathSync.native(head);
			return rest.length ? join(real, ...rest.reverse()) : real;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				// A dangling link: follow it by hand (bounded), else step up one component.
				let target: string | undefined;
				try {
					target = readlinkIfLink(head);
				} catch {
					target = undefined;
				}
				if (target !== undefined && hops++ < 40) {
					head = resolve(dirname(head), target);
					continue;
				}
			}
			const parent = dirname(head);
			if (parent === head) return rest.length ? join(head, ...rest.reverse()) : head;
			rest.push(basename(head));
			head = parent;
		}
	}
}

function readlinkIfLink(p: string): string | undefined {
	return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : undefined;
}

/** Every platform's policy.json under the policy root: the ones present, plus the known and current platforms. */
function policyFiles(root: string, platform: string): string[] {
	let present: string[] = [];
	try {
		present = readdirSync(root);
	} catch {
		present = [];
	}
	return [...new Set([...present, "linux", "darwin", "win32", platform])].map((p) => join(root, p, POLICY_FILE_NAME));
}

/** True when `child` is `parent` or below it. Both canonical. */
export function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const p = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(p);
}

/**
 * What a sandboxed parent hands its workers (`--sandbox-parent <json>`): its level and the writable
 * roots of its resolved policy, without its own session tmp. A worker writes there and nowhere
 * else, whatever its cwd.
 */
export interface ParentScope {
	version: 1;
	level: SandboxLevel;
	workspaceRoot: string;
	writable: string[];
}

export function parentScopeOf(policy: Pick<ResolvedPolicy, "level" | "workspaceRoot" | "writable" | "tmpDir">): ParentScope {
	return {
		version: 1,
		level: policy.level,
		workspaceRoot: policy.workspaceRoot,
		writable: policy.level === "read-only" ? [] : policy.writable.filter((w) => w !== policy.tmpDir),
	};
}

/** Parse the `--sandbox-parent` flag. Anything malformed is an error: the worker then refuses every tool. */
export function parseParentScope(value: unknown): Result<ParentScope> {
	let raw: unknown = value;
	if (typeof value === "string") {
		try {
			raw = JSON.parse(value);
		} catch {
			return { ok: false, error: "--sandbox-parent is not valid JSON" };
		}
	}
	if (!isRecord(raw) || raw.version !== 1 || !isLevel(raw.level) || typeof raw.workspaceRoot !== "string" || !isAbsolute(raw.workspaceRoot)) {
		return { ok: false, error: "--sandbox-parent is malformed" };
	}
	const writable = stringList(raw.writable, "--sandbox-parent writable", (p) => isAbsolute(p));
	if (!writable.ok) return writable;
	return { ok: true, value: { version: 1, level: raw.level, workspaceRoot: raw.workspaceRoot, writable: writable.value } };
}

/**
 * Why a worker must not start (or run tools) in `cwd` under this parent scope: a cwd outside the
 * parent's writable roots would make the worker's own sandbox writable where the parent's is not.
 * Under read-only nothing is writable, so any cwd is fine. `cwd` may be relative to the parent's.
 */
export function workerCwdRefusal(scope: ParentScope, cwd: string): string | undefined {
	if (scope.level === "read-only") return undefined;
	const c = canonicalize(isAbsolute(cwd) ? cwd : resolve(scope.workspaceRoot, cwd));
	if (scope.writable.some((r) => isWithin(c, canonicalize(r)))) return undefined;
	return `Sandbox: worker cwd ${c} is outside the parent's sandbox`;
}

export interface ResolveInput {
	agentDir: string;
	cwd: string;
	tmpDir: string;
	platform?: string;
	home?: string;
	/** The backend's platform lists (absolute paths), merged under the file's own. */
	defaults?: { hidden: string[]; writable: string[]; readOnlyWithinWritable: string[] };
	/**
	 * The git paths of a writable root (backend `gitProtectedPaths`): read-only ones (hooks, config,
	 * gitfile, commondir, a missing `.git`) and extra writable ones (a linked worktree's git dirs),
	 * so the file tools agree with what the OS backend mounts.
	 */
	git?: (root: string) => { writable: string[]; readOnly: string[] };
	/** Set in a worker of a sandboxed parent (`--sandbox-parent`): its writable roots replace this session's own. */
	parent?: ParentScope;
	/** Where a shadowed path's private copy lives (backend `shadowSource`). Without it nothing is shadowed. */
	shadowSource?: (agentDir: string, path: string) => string;
}

/** The global file, tightened by the project file, with every path canonical. Fail closed. */
export function resolvePolicy(input: ResolveInput): Result<ResolvedPolicy> {
	const platform = input.platform ?? process.platform;
	const home = input.home ?? homedir();
	const loaded = loadPolicyFile(policyFilePath(input.agentDir, platform));
	if (!loaded.ok) return loaded;
	const workspaceRoot = canonicalize(input.cwd);
	const { policy, notices } = loadProjectTightening(workspaceRoot, loaded.value);
	const ctx: ExpandContext = { home, agentDir: input.agentDir, cwd: workspaceRoot };
	const canon = (list: string[]) => [...new Set(list.map((p) => canonicalize(expandPath(p, ctx))))];
	const agentDir = canonicalize(input.agentDir);
	// The whole policy root (every platform's file), not just this platform's directory.
	const pDir = canonicalize(join(input.agentDir, POLICY_DIR_NAME));
	const tmpDir = canonicalize(input.tmpDir);
	const d = input.defaults ?? { hidden: [], writable: [], readOnlyWithinWritable: [] };
	// A worker never gets a wider level than its parent (the policy file may still lower it).
	const level: SandboxLevel = input.parent?.level === "read-only" ? "read-only" : policy.level;
	// No real writable root at or inside a shadowed path: the file's own entries fail closed (they
	// passed validation only in their written spelling), a platform default is just dropped. The
	// session cwd may sit inside a shadow; there the real cwd wins, as in the mounts.
	const shadowCanon = canon(policy.shadowed);
	const inShadow = (w: string) => shadowCanon.some((sh) => isWithin(w, sh));
	if (level !== "read-only") {
		const bad = canon(policy.writable).find(inShadow);
		if (bad) return { ok: false, error: `invalid policy: writable ${bad} is at or inside a shadowed path` };
	}
	// A worker of a sandboxed parent writes exactly where the parent may (never its own cwd by
	// right: a worker started in /b by a parent in /a must not widen the sandbox to /b).
	const parentRoots = input.parent ? [...new Set(input.parent.writable.map(canonicalize))].filter((w) => !inShadow(w)) : undefined;
	const writable =
		level === "read-only"
			? [tmpDir]
			: parentRoots
				? [tmpDir, ...parentRoots]
				: [workspaceRoot, tmpDir, ...canon([...d.writable, ...policy.writable]).filter((w) => !inShadow(w))];
	const outsideParent = level !== "read-only" && parentRoots !== undefined && !parentRoots.some((r) => isWithin(workspaceRoot, r));
	const gitReadOnly: string[] = [];
	if (level !== "read-only" && input.git) {
		for (const root of writable.filter((w) => w !== tmpDir)) {
			const g = input.git(root);
			for (const w of g.writable.map(canonicalize)) if (!writable.includes(w)) writable.push(w);
			gitReadOnly.push(...g.readOnly.map(canonicalize));
		}
	}
	// The policy files themselves are hidden; the directory (and each CLAUDE.md, written for an agent
	// to read) stays readable and read-only.
	const hiddenFinal = [...new Set([...canon([...d.hidden, ...policy.hidden]), ...policyFiles(pDir, platform)])];
	return {
		ok: true,
		value: {
			level: level,
			defaultOn: policy.defaultOn,
			workspaceRoot,
			writable: [...new Set(writable)],
			// The agent dir and the policy dir are never writable, even inside the cwd.
			readOnlyWithinWritable: [...new Set([...canon([...d.readOnlyWithinWritable, ...policy.readOnlyWithinWritable]), ...gitReadOnly, agentDir, pDir])],
			hidden: hiddenFinal,
			proxyAllow: [...policy.proxy.allow],
			envAllow: [...policy.env.allow],
			acceptPartial: policy.acceptPartial,
			policyDir: pDir,
			agentDir,
			tmpDir,
			shadowed:
				level === "read-only"
					? []
					: input.shadowSource
						? canon(policy.shadowed)
								.filter((p) => !readDenialIn(hiddenFinal, p))
								.map((p) => ({ path: p, source: canonicalize(input.shadowSource!(input.agentDir, p)) }))
						: [],
			notices,
			...(outsideParent ? { outsideParent: true } : {}),
		},
	};
}

function readDenialIn(hidden: string[], canonical: string): boolean {
	return hidden.some((h) => isWithin(canonical, h));
}

/** Why a read of this canonical path is refused, or undefined when it is allowed. */
export function readDenial(policy: Pick<ResolvedPolicy, "hidden">, canonical: string): string | undefined {
	const h = policy.hidden.find((p) => isWithin(canonical, p));
	return h === undefined ? undefined : `${canonical} is hidden by the sandbox policy`;
}

/** Why a write of this canonical path is refused, or undefined when it is allowed. */
export function writeDenial(
	policy: Pick<ResolvedPolicy, "hidden" | "writable" | "readOnlyWithinWritable"> & { shadowed?: ResolvedPolicy["shadowed"] },
	canonical: string,
	opts: { creating?: boolean } = {},
): string | undefined {
	if (policy.hidden.some((p) => isWithin(canonical, p))) return `${canonical} is hidden by the sandbox policy`;
	// A shadow's private source is the sandbox's own copy: writable even though it lives in the agent dir.
	if (policy.shadowed?.some((sh) => isWithin(canonical, sh.source))) return undefined;
	// The deepest match decides, as the mounts stack: a linked worktree's own admin dir (writable)
	// inside the common dir's read-only `worktrees/` stays writable.
	const deepest = (xs: string[]) => xs.filter((p) => isWithin(canonical, p)).sort((a, b) => b.length - a.length)[0];
	const ro = deepest(policy.readOnlyWithinWritable);
	const rw = deepest(policy.writable);
	if (ro && !(rw && rw.length > ro.length)) return `${canonical} is read-only in the sandbox`;
	if (!rw) return `${canonical} is outside the sandbox's writable roots`;
	// Creating an ancestor of a protected path (while that path is missing) would let it be planted.
	if (opts.creating && [...policy.hidden, ...policy.readOnlyWithinWritable].some((p) => isWithin(p, canonical))) return `${canonical} holds a path the sandbox protects`;
	return undefined;
}

/** Hidden paths strictly below a search root: what find/grep/ls must filter out of their output. */
export function hiddenBelow(policy: Pick<ResolvedPolicy, "hidden">, root: string): string[] {
	return policy.hidden.filter((h) => h !== root && isWithin(h, root));
}
