/**
 * Cleaning the sandbox's shadowed cache copies (<agentDir>/sova/sandbox/shadow/<name>, see
 * backend.ts `shadowSource`): by age, then by size, never anything used recently.
 *
 * The unit is one top-level entry of one shadow dir (home-.cache/pnpm, home-.npm/_cacache, an
 * entry of a copy left by an older layout); a shadow dir itself is a live bind source and is never
 * removed. The pure planner (`planPrune`) decides; `runPrune` scans, renames the chosen entries
 * into the trash dir, writes the stamp and deletes the trash. The heavy work runs in a child
 * process at low CPU and disk priority (`startPrune`, `shadow-prune-run.ts`), so a walk of a large
 * cache never blocks the chat's event loop.
 *
 * Settings live in an optional `<agentDir>/sandbox-policy/<platform>/caches.json`, never in
 * policy.json (whose strict validator older chats still run): missing means defaults, invalid means
 * cleanup off with a notice, and neither ever touches the sandbox itself.
 *
 * Node builtins only; imports nothing, not even its siblings, so the child loads one file.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const GiB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A run at most this often per agent dir, unless asked for (`/sandbox clean`). */
export const THROTTLE_MS = DAY;
/** An entry with a file written this recently is never removed. */
export const WRITE_PROTECT_MS = DAY;
/** An entry with a file read this recently is never removed (relatime updates atime at most daily). */
export const READ_PROTECT_MS = 2 * DAY;
/** `/sandbox clean all` keeps only what was used this recently. */
export const ALL_KEEP_MS = HOUR;
/** A lock older than this (by mtime; a live run touches it) or whose pid is gone no longer blocks. */
export const LOCK_STALE_MS = 2 * HOUR;
const HEARTBEAT_MS = 60_000;
export const FLOOR_BYTES = 2 * GiB;

// ---------------------------------------------------------------------------------------------
// Settings (caches.json)

export interface CacheSettings {
	on: boolean;
	maxSizeGB: number;
	scratchDays: number;
	toolCacheDays: number;
	/** Top-level names in ~/.cache kept as tool caches; every entry of ~/.npm and ~/.m2 is one too. */
	toolCaches: string[];
}

export const DEFAULT_TOOL_CACHES = ["pnpm", "ms-playwright", "pip", "uv", "go-build", "node-gyp", "yarn", "deno", "typescript", "puppeteer", "mise", "huggingface", "sova-voice-lab"];

export const DEFAULT_CACHE_SETTINGS: CacheSettings = { on: true, maxSizeGB: 50, scratchDays: 7, toolCacheDays: 30, toolCaches: DEFAULT_TOOL_CACHES };

const SETTINGS_KEYS = ["on", "maxSizeGB", "scratchDays", "toolCacheDays", "toolCaches"];

export const CACHES_FILE_NAME = "caches.json";

export function cachesFilePath(agentDir: string, platform: string = process.platform): string {
	return join(agentDir, "sandbox-policy", platform, CACHES_FILE_NAME);
}

/** A key left out takes its default; an unknown key or a wrong value makes the file invalid. */
export function validateCacheSettings(raw: unknown): Result<CacheSettings> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not a JSON object" };
	const r = raw as Record<string, unknown>;
	for (const key of Object.keys(r)) if (!SETTINGS_KEYS.includes(key)) return { ok: false, error: `unknown key ${JSON.stringify(key)}` };
	const out: CacheSettings = { ...DEFAULT_CACHE_SETTINGS, toolCaches: [...DEFAULT_CACHE_SETTINGS.toolCaches] };
	if ("on" in r) {
		if (typeof r.on !== "boolean") return { ok: false, error: "on must be true or false" };
		out.on = r.on;
	}
	for (const key of ["maxSizeGB", "scratchDays", "toolCacheDays"] as const) {
		if (!(key in r)) continue;
		const v = r[key];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { ok: false, error: `${key} must be a positive number` };
		out[key] = v;
	}
	if ("toolCaches" in r) {
		const v = r.toolCaches;
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.includes("/"))) return { ok: false, error: "toolCaches must be a list of folder names" };
		out.toolCaches = [...new Set(v as string[])];
	}
	return { ok: true, value: out };
}

/** Missing: the defaults. Unreadable, not JSON or invalid: an error (cleanup off, `invalidNotice`). */
export function loadCacheSettings(agentDir: string, platform: string = process.platform): Result<CacheSettings> {
	let text: string;
	try {
		text = readFileSync(cachesFilePath(agentDir, platform), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: DEFAULT_CACHE_SETTINGS };
		return { ok: false, error: `cannot read it: ${(e as Error).message}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: "not valid JSON" };
	}
	return validateCacheSettings(raw);
}

export function invalidNotice(error: string): string {
	return `Sandbox: \`caches.json\` is invalid (${error}); cache cleanup is off. The sandbox is unaffected.`;
}

// ---------------------------------------------------------------------------------------------
// Paths

export const shadowDir = (agentDir: string) => join(agentDir, "sova", "sandbox", "shadow");
export const trashDir = (agentDir: string) => join(agentDir, "sova", "sandbox", "shadow-trash");
export const stampPath = (agentDir: string) => join(agentDir, "sova", "sandbox", "shadow-prune.json");
export const lockPath = (agentDir: string) => join(agentDir, "sova", "sandbox", "shadow-prune.lock");

/**
 * The shadow dirs whose every entry is a tool cache (backend.ts names them home-<path>): npm's and
 * Maven's, and the private copies of mise's and pnpm's own state (the platforms' `privateState`).
 */
const ALL_TOOL_ROOTS = new Set([
	"home-.npm",
	"home-.m2",
	"home-.local%2Fstate%2Fmise",
	"home-.local%2Fstate%2Fpnpm",
	"home-.local%2Fshare%2Fpnpm%2Fstore",
	"home-.local%2Fshare%2Fpnpm%2Fpackage-manager-store",
]);
const CACHE_ROOT = "home-.cache";

export type Tier = "scratch" | "tool";

export function tierOf(root: string, name: string, settings: CacheSettings): Tier {
	if (ALL_TOOL_ROOTS.has(root)) return "tool";
	if (root === CACHE_ROOT && settings.toolCaches.includes(name)) return "tool";
	return "scratch";
}

// ---------------------------------------------------------------------------------------------
// The planner (pure)

export interface PlanEntry {
	/** The shadow dir's name (home-.cache) and the entry's name in it. */
	root: string;
	name: string;
	tier: Tier;
	/** Allocated bytes, a hard-linked file counted once over the whole scan. */
	bytes: number;
	/**
	 * Newest write (a regular file's mtime) and newest read (a regular file's atime) inside, in ms.
	 * Directory atimes never count (the scan's own readdir moves them). An entry with no regular file
	 * at all takes its dirs' and links' mtimes instead, so a folder made a moment ago is not "unused".
	 */
	lastWrite: number;
	lastRead: number;
	/** The entry's own mtime at the scan: changed by the time of the move, it was used meanwhile. */
	topMtime?: number;
}

export type CapReason = "setting" | "disk" | "free" | "floor";
export type PruneMode = "auto" | "clean" | "all";

export interface PlanInput {
	entries: PlanEntry[];
	now: number;
	settings: CacheSettings;
	/** statfs of the shadow dir: total size and space available, in bytes. */
	disk: { total: number; free: number };
	mode: PruneMode;
}

export interface Plan {
	remove: (PlanEntry & { why: "age" | "size" | "all" })[];
	cap: number;
	capReason: CapReason;
	/** Bytes before, and what is left once `remove` is gone. */
	size: number;
	left: number;
	freed: number;
	/** Still over the cap because everything left is protected. */
	overCap: boolean;
}

/** max(2 GB, min(maxSizeGB, 5% of the disk, 5% of its free space)), and which bound set it. */
export function effectiveCap(settings: Pick<CacheSettings, "maxSizeGB">, disk: { total: number; free: number }): { cap: number; reason: CapReason } {
	const bounds: [number, CapReason][] = [
		[settings.maxSizeGB * GiB, "setting"],
		[0.05 * disk.total, "disk"],
		[0.05 * disk.free, "free"],
	];
	let cap = Number.POSITIVE_INFINITY;
	let reason: CapReason = "setting";
	for (const [b, r] of bounds) if (b < cap) [cap, reason] = [b, r];
	if (cap < FLOOR_BYTES) return { cap: FLOOR_BYTES, reason: "floor" };
	return { cap: Math.floor(cap), reason };
}

const lastUsed = (e: PlanEntry) => Math.max(e.lastWrite, e.lastRead);

export function isProtected(e: PlanEntry, now: number, mode: PruneMode): boolean {
	if (mode === "all") return now - e.lastWrite < ALL_KEEP_MS || now - e.lastRead < ALL_KEEP_MS;
	return now - e.lastWrite < WRITE_PROTECT_MS || now - e.lastRead < READ_PROTECT_MS;
}

export function planPrune(input: PlanInput): Plan {
	const { entries, now, settings, disk, mode } = input;
	const { cap, reason } = effectiveCap(settings, disk);
	const size = entries.reduce((n, e) => n + e.bytes, 0);
	const remove: Plan["remove"] = [];
	const gone = new Set<PlanEntry>();
	let left = size;
	const drop = (e: PlanEntry, why: "age" | "size" | "all") => {
		remove.push({ ...e, why });
		gone.add(e);
		left -= e.bytes;
	};
	if (mode === "all") {
		for (const e of entries) if (!isProtected(e, now, mode)) drop(e, "all");
	} else {
		// By age: scratch after scratchDays unused, tool caches after toolCacheDays.
		for (const e of entries) {
			if (isProtected(e, now, mode)) continue;
			const days = e.tier === "tool" ? settings.toolCacheDays : settings.scratchDays;
			if (now - lastUsed(e) > days * DAY) drop(e, "age");
		}
		// By size: least recently used first, every scratch entry before any tool cache.
		if (left > cap) {
			const order = entries
				.filter((e) => !gone.has(e) && !isProtected(e, now, mode))
				.sort((a, b) => (a.tier === b.tier ? lastUsed(a) - lastUsed(b) : a.tier === "scratch" ? -1 : 1));
			for (const e of order) {
				if (left <= cap) break;
				drop(e, "size");
			}
		}
	}
	return { remove, cap, capReason: reason, size, left, freed: size - left, overCap: left > cap };
}

// ---------------------------------------------------------------------------------------------
// The scan (lstat only, one filesystem, hard links once)

export interface ScanOptions {
	/** Called now and then during a long walk (the lock's heartbeat). */
	tick?: () => void;
}

/** Every top-level entry of every shadow dir under `root` (shadowDir(agentDir)), measured. */
export function scanShadows(root: string, settings: CacheSettings, opts: ScanOptions = {}): PlanEntry[] {
	const out: PlanEntry[] = [];
	const seen = new Set<string>();
	let rootDirs: string[];
	try {
		rootDirs = readdirSync(root);
	} catch {
		return out;
	}
	let n = 0;
	const tick = () => {
		if (++n % 2048 === 0) opts.tick?.();
	};
	for (const rootName of rootDirs.sort()) {
		const dir = join(root, rootName);
		let st;
		try {
			st = lstatSync(dir);
		} catch {
			continue;
		}
		// A shadow dir is a real directory; a link or a file here is nothing of ours to walk.
		if (!st.isDirectory()) continue;
		const dev = st.dev;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names.sort()) {
			const m = measure(join(dir, name), dev, seen, tick);
			if (!m) continue;
			out.push({ root: rootName, name, tier: tierOf(rootName, name, settings), ...m });
		}
	}
	return out;
}

/** One entry: allocated bytes, newest file write, newest file read. Never follows a link or leaves `dev`. */
export function measure(path: string, dev: number, seen: Set<string>, tick: () => void = () => {}): { bytes: number; lastWrite: number; lastRead: number; topMtime: number } | undefined {
	let top;
	try {
		top = lstatSync(path);
	} catch {
		return undefined;
	}
	if (top.dev !== dev) return undefined;
	let bytes = 0;
	let lastWrite = 0;
	let lastRead = 0;
	let files = 0;
	/** Dirs' and links' mtimes: the recency of an entry holding no regular file. */
	let otherWrite = 0;
	const stack = [path];
	let first = true;
	while (stack.length) {
		const p = stack.pop()!;
		let st;
		try {
			st = first ? top : lstatSync(p);
		} catch {
			continue;
		}
		first = false;
		tick();
		if (st.dev !== dev) continue;
		const key = `${st.dev}:${st.ino}`;
		if (st.nlink > 1 && !st.isDirectory()) {
			if (seen.has(key)) {
				// Counted once already, but its use still counts for this entry.
				if (st.isFile()) {
					files++;
					lastWrite = Math.max(lastWrite, st.mtimeMs);
					lastRead = Math.max(lastRead, st.atimeMs);
				}
				continue;
			}
			seen.add(key);
		}
		bytes += (st.blocks ?? 0) * 512;
		if (st.isFile()) {
			files++;
			lastWrite = Math.max(lastWrite, st.mtimeMs);
			lastRead = Math.max(lastRead, st.atimeMs);
		} else if (st.isDirectory()) {
			// Its atime is only our own walk; its mtime counts only for an entry with no file.
			otherWrite = Math.max(otherWrite, st.mtimeMs);
			let kids: string[];
			try {
				kids = readdirSync(p);
			} catch {
				continue;
			}
			for (const k of kids) stack.push(join(p, k));
		} else {
			// A link, socket or fifo: its own time, never what it points at.
			otherWrite = Math.max(otherWrite, st.mtimeMs);
		}
	}
	if (files === 0) lastWrite = otherWrite;
	return { bytes, lastWrite, lastRead, topMtime: top.mtimeMs };
}

// ---------------------------------------------------------------------------------------------
// The stamp

export interface PruneStamp {
	version: 1;
	/** When the last finished run ran, and when the last one started (the throttle uses both). */
	lastRun?: number;
	lastAttempt?: number;
	mode?: PruneMode;
	freed?: number;
	/** Bytes before and after the last run. */
	sizeBefore?: number;
	size?: number;
	cap?: number;
	capReason?: CapReason;
	overCap?: boolean;
	removed?: number;
	errors?: string[];
}

export function readStamp(agentDir: string): PruneStamp | undefined {
	try {
		const raw = JSON.parse(readFileSync(stampPath(agentDir), "utf8")) as PruneStamp;
		return raw && typeof raw === "object" && raw.version === 1 ? raw : undefined;
	} catch {
		return undefined;
	}
}

function writeStamp(agentDir: string, stamp: PruneStamp): void {
	const path = stampPath(agentDir);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`);
	renameSync(tmp, path);
}

/** Whether an automatic run is due: nothing ran or started in the last 24 hours. */
export function isDue(stamp: PruneStamp | undefined, now: number): boolean {
	const last = Math.max(stamp?.lastRun ?? 0, stamp?.lastAttempt ?? 0);
	return now - last >= THROTTLE_MS || last > now;
}

// ---------------------------------------------------------------------------------------------
// The lock (O_EXCL; stale after 2 h without a heartbeat, or once its pid is gone)

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether the lock file at `path` still blocks: present, fresh and its pid alive. */
export function lockHeld(path: string, now: number = Date.now()): boolean {
	let st;
	let text = "";
	try {
		st = statSync(path);
		text = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	if (now - st.mtimeMs > LOCK_STALE_MS) return false;
	const pid = Number.parseInt(text.trim(), 10);
	// An empty file is one being written this instant: it holds.
	if (!text.trim()) return true;
	return pidAlive(pid);
}

export interface Lock {
	touch(): void;
	release(): void;
}

/** Take the lock, breaking a stale one; undefined when another run holds it. */
export function acquireLock(path: string, now: number = Date.now()): Lock | undefined {
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number;
		try {
			fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			if (lockHeld(path, now)) return undefined;
			// Stale: remove that very file, never one another run made since we looked.
			try {
				const before = statSync(path);
				if (lockHeld(path, now)) return undefined;
				const again = statSync(path);
				if (again.ino !== before.ino) continue;
				unlinkSync(path);
			} catch {
				// Gone already: try again.
			}
			continue;
		}
		writeSync(fd, `${process.pid}\n`);
		closeSync(fd);
		let released = false;
		return {
			touch() {
				if (released) return;
				try {
					const t = new Date();
					utimesSync(path, t, t);
				} catch {}
			},
			release() {
				if (released) return;
				released = true;
				try {
					if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
				} catch {}
			},
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// The run

export interface RunOptions {
	agentDir: string;
	mode: PruneMode;
	settings: CacheSettings;
	now?: number;
	/** For tests: the disk numbers instead of statfs. */
	disk?: { total: number; free: number };
	/** Called once the stamp is written, before the trash is deleted (the child reports here). */
	onResult?: (r: RunResult) => void;
	/** For tests: called between the scan and the moves (use that races a run). */
	afterScan?: () => void;
}

export type RunResult =
	| { kind: "busy" }
	| { kind: "skipped" }
	| { kind: "done"; stamp: PruneStamp };

function diskOf(path: string): { total: number; free: number } {
	const s = statfsSync(path);
	return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

function nearestExisting(path: string): string {
	let p = path;
	while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
	return p;
}

function emptyTrash(trash: string): void {
	let names: string[];
	try {
		names = readdirSync(trash);
	} catch {
		return;
	}
	for (const n of names) {
		try {
			rmSync(join(trash, n), { recursive: true, force: true });
		} catch {}
	}
}

/**
 * One cleanup, start to end: lock, empty the old trash, scan, plan, move the chosen entries into
 * the trash, write the stamp, report, delete the trash, unlock. `auto` runs only when due.
 */
export function runPrune(opts: RunOptions): RunResult {
	const { agentDir, mode, settings } = opts;
	const now = opts.now ?? Date.now();
	const report = (r: RunResult) => {
		opts.onResult?.(r);
		return r;
	};
	// No agent dir (removed meanwhile): nothing to clean, and nothing of ours is made there.
	if (!existsSync(agentDir)) return report({ kind: "skipped" });
	if (mode === "auto" && !isDue(readStamp(agentDir), now)) return report({ kind: "skipped" });
	const lock = acquireLock(lockPath(agentDir), now);
	if (!lock) return report({ kind: "busy" });
	const trash = trashDir(agentDir);
	const moved: string[] = [];
	try {
		const old = readStamp(agentDir);
		if (mode === "auto" && !isDue(old, now)) return report({ kind: "skipped" });
		writeStamp(agentDir, { ...(old ?? { version: 1 }), version: 1, lastAttempt: now });
		emptyTrash(trash);
		lock.touch();
		const root = shadowDir(agentDir);
		let heartbeat = Date.now();
		const entries = scanShadows(root, settings, {
			tick: () => {
				if (Date.now() - heartbeat < HEARTBEAT_MS) return;
				heartbeat = Date.now();
				lock.touch();
			},
		});
		const disk = opts.disk ?? diskOf(nearestExisting(root));
		const plan = planPrune({ entries, now, settings, disk, mode });
		opts.afterScan?.();
		const errors: string[] = [];
		let freed = 0;
		let removed = 0;
		if (plan.remove.length) mkdirSync(trash, { recursive: true, mode: 0o700 });
		plan.remove.forEach((e, i) => {
			const from = join(root, e.root, e.name);
			try {
				// Used since the scan (something made or removed at its top): keep it.
				const st = lstatSync(from);
				if (e.topMtime !== undefined && st.mtimeMs !== e.topMtime) return;
				const to = join(trash, `${now}-${i}-${e.name.slice(0, 120)}`);
				renameSync(from, to);
				moved.push(to);
				freed += e.bytes;
				removed++;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") errors.push(`${e.root}/${e.name}: ${code ?? (err as Error).message}`);
			}
		});
		const size = plan.size - freed;
		const stamp: PruneStamp = {
			version: 1,
			lastRun: now,
			lastAttempt: now,
			mode,
			freed,
			sizeBefore: plan.size,
			size,
			cap: plan.cap,
			capReason: plan.capReason,
			overCap: size > plan.cap,
			removed,
			...(errors.length ? { errors: errors.slice(0, 20) } : {}),
		};
		writeStamp(agentDir, stamp);
		report({ kind: "done", stamp });
		// The background part: the moved entries go for good.
		for (const m of moved) {
			lock.touch();
			try {
				rmSync(m, { recursive: true, force: true });
			} catch {}
		}
		return { kind: "done", stamp };
	} finally {
		lock.release();
	}
}

// ---------------------------------------------------------------------------------------------
// Starting a run from the extension: a child process at low priority

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "shadow-prune-run.ts");

function onPath(bin: string): string | undefined {
	for (const dir of [...(process.env.PATH ?? "").split(":"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
		if (!dir) continue;
		const p = join(dir, bin);
		try {
			if (statSync(p).isFile()) return p;
		} catch {}
	}
	return undefined;
}

/** `nice -n 19` and, on Linux, `ionice -c3` (idle disk class) in front of a command, where found. */
export function lowPriorityPrefix(platform: string = process.platform): string[] {
	const out: string[] = [];
	const nice = onPath("nice");
	if (nice) out.push(nice, "-n", "19");
	const ionice = platform === "linux" ? onPath("ionice") : undefined;
	if (ionice) out.push(ionice, "-c3");
	return out;
}

/** The runtime that runs this file: bun runs TypeScript; node needs type stripping where it isn't on. */
function runtimeArgv(): string[] {
	const isBun = Boolean((process.versions as Record<string, string | undefined>).bun);
	if (isBun) return [process.execPath];
	const ts = (process as { features?: { typescript?: unknown } }).features?.typescript;
	return ts ? [process.execPath] : [process.execPath, "--experimental-strip-types", "--no-warnings"];
}

export interface StartOptions {
	agentDir: string;
	mode: PruneMode;
	settings: CacheSettings;
	/** Wait for the result (`/sandbox clean`); otherwise the child is left to run on its own. */
	wait?: boolean;
}

/**
 * Start a run in a child process. `wait`: resolves with its result once the stamp is written (the
 * trash is deleted after). Otherwise resolves at once; the child runs detached and outlives the chat.
 */
export function startPrune(opts: StartOptions): Promise<RunResult | { kind: "error"; error: string }> {
	return new Promise((resolve) => {
		const argv = [...lowPriorityPrefix(), ...runtimeArgv(), RUNNER, JSON.stringify({ agentDir: opts.agentDir, mode: opts.mode, settings: opts.settings })];
		let child: ChildProcess;
		try {
			// Detached either way: its own process group, so nothing aimed at the chat's reaches it, and
			// the trash is deleted after the result even if the chat exits meanwhile.
			child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: opts.wait ? ["ignore", "pipe", "pipe"] : "ignore" });
		} catch (e) {
			resolve({ kind: "error", error: (e as Error).message });
			return;
		}
		if (!opts.wait) {
			child.on("error", () => {});
			child.unref();
			resolve({ kind: "skipped" });
			return;
		}
		let out = "";
		let err = "";
		let done = false;
		const finish = (r: RunResult | { kind: "error"; error: string }) => {
			if (done) return;
			done = true;
			resolve(r);
			// The rest (deleting the trash) is the child's own business.
			try {
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
			} catch {}
		};
		child.stdout!.on("data", (d: Buffer) => {
			out += d.toString();
			const nl = out.indexOf("\n");
			if (nl < 0) return;
			try {
				finish(JSON.parse(out.slice(0, nl)) as RunResult);
			} catch {
				finish({ kind: "error", error: "unreadable result" });
			}
		});
		child.stderr!.on("data", (d: Buffer) => {
			if (err.length < 4096) err += d.toString();
		});
		child.on("error", (e) => finish({ kind: "error", error: e.message }));
		child.on("close", (code) => finish({ kind: "error", error: err.trim().split("\n")[0] || `exited with code ${code}` }));
	});
}

/**
 * How the extension starts a run: `start` is `startPrune` (a real child process). A unit test swaps
 * it for an in-process fake, so it starts no process.
 */
export const pruneRunner: { start: typeof startPrune } = { start: (opts) => startPrune(opts) };

/** The child's side: low priority, one run, its result as one JSON line on stdout. Never throws. */
export function runChild(arg: string): void {
	try {
		setPriority(19);
	} catch {}
	let reported = false;
	const say = (r: RunResult | { kind: "error"; error: string }) => {
		if (reported) return;
		reported = true;
		try {
			process.stdout.write(`${JSON.stringify(r)}\n`);
		} catch {}
	};
	try {
		const { agentDir, mode, settings } = JSON.parse(arg) as { agentDir: string; mode: PruneMode; settings: CacheSettings };
		if (typeof agentDir !== "string" || !agentDir.startsWith("/") || !["auto", "clean", "all"].includes(mode)) throw new Error("bad arguments");
		const v = validateCacheSettings(settings);
		if (!v.ok) throw new Error(v.error);
		runPrune({ agentDir, mode, settings: v.value, onResult: say });
	} catch (e) {
		say({ kind: "error", error: (e as Error).message });
	}
}

// ---------------------------------------------------------------------------------------------
// What /sandbox says

export function formatBytes(n: number): string {
	if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
	if (n < GiB) return `${Math.round(n / 1024 ** 2)} MB`;
	const g = n / GiB;
	return `${g < 10 ? g.toFixed(1).replace(/\.0$/, "") : Math.round(g)} GB`;
}

export function reasonText(r: CapReason): string {
	switch (r) {
		case "setting":
			return "your maxSizeGB setting";
		case "disk":
			return "5% of the disk";
		case "free":
			return "5% of free space";
		case "floor":
			return "the 2 GB minimum";
	}
}

export function agoText(ms: number, now: number): string {
	const d = Math.max(0, now - ms);
	if (d < 60_000) return "just now";
	const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
	if (d < HOUR) return unit(Math.floor(d / 60_000), "minute");
	if (d < DAY) return unit(Math.floor(d / HOUR), "hour");
	return unit(Math.floor(d / DAY), "day");
}

/** The line bare /sandbox adds after its status line: from the stamp, never a walk. */
export function cachesLine(settings: Result<CacheSettings>, stamp: PruneStamp | undefined, now: number = Date.now()): string {
	if (!settings.ok || !settings.value.on) return "Caches: automatic cleanup off";
	if (!stamp || stamp.lastRun === undefined || stamp.size === undefined || stamp.cap === undefined || !stamp.capReason) return "Caches: not cleaned yet";
	const size = formatBytes(stamp.size);
	const limit = formatBytes(stamp.cap);
	const reason = reasonText(stamp.capReason);
	if (stamp.overCap) return `Caches ${size}, over the ${limit} limit (${reason}): everything left was used recently`;
	return `Caches ${size} of ${limit} (${reason}) · cleaned ${agoText(stamp.lastRun, now)}, freed up to ${formatBytes(stamp.freed ?? 0)}`;
}

export function cleanResultText(stamp: PruneStamp, mode: PruneMode): string {
	if (mode === "all") return `Caches cleared: freed up to ${formatBytes(stamp.freed ?? 0)}; kept only what was used in the last hour`;
	return `Caches cleaned: freed up to ${formatBytes(stamp.freed ?? 0)}; ${formatBytes(stamp.size ?? 0)} left of ${formatBytes(stamp.cap ?? 0)}`;
}

export const BUSY_TEXT = "Caches: a cleanup is already running. Nothing was removed; try again later.";
