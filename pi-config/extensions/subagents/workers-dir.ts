/**
 * On-disk registry of detachable workers:
 *
 *   <root>/<ownerSessionId>/<workerId>/
 *     meta.json     manager-owned: identity, spec, pids, socket, consumedOffset, state
 *     spawn.json    what the host must run (command, argv, cwd); no environment
 *     host.json     host-owned: host/worker pids and start times
 *     out.jsonl     every worker stdout line, appended by the host
 *     in.jsonl      every stdin frame a manager sent, appended by the host
 *     status.json   host-owned: { exitCode, signal, endedAt } once the worker exited
 *     adopt.lock    { pid, startTime } of the manager process driving the worker
 *   <root>/<ownerSessionId>/mailbox/   team mailbox root (survives restarts)
 *   <root>/dead/<ownerSessionId>-<workerId>-<ts>/   archived entries
 *
 * Node builtins only: host.ts imports this file and runs under plain Node type
 * stripping, so only erasable TypeScript syntax is allowed here.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_WORKERS_ROOT = path.join(os.homedir(), ".pi", "agent", "pi-web", "workers");
/** Entries without a living host are archived after this long. */
export const REAP_AFTER_MS = 24 * 60 * 60 * 1000;
/** Archived entries are deleted after this long. */
export const DEAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Linux sun_path is 108 bytes including the terminator; stay clear of it. */
const MAX_SOCKET_PATH = 100;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export type WorkerState = "starting" | "running" | "detached" | "exited" | "lost";

/** What an adopting manager needs to rebuild the worker (backend spec without the environment). */
export interface HostedSpec {
	prompt: string;
	backend: string;
	name: string;
	cwd: string;
	wake: boolean;
	model?: string;
	effort?: string;
	tools?: string[];
	backendOptions?: Record<string, unknown>;
	extensions?: string[];
}

export interface WorkerMeta {
	v: 1;
	id: string;
	groupId: string;
	groupLabel?: string;
	name: string;
	backend: string;
	ownerSessionId: string;
	ownerSessionFile?: string;
	hostPid?: number;
	/** Host process start time (/proc/<pid>/stat field 22) guarding against pid reuse. */
	pidStartTime?: number;
	workerPid?: number;
	/** The host starts the worker as a process-group leader. */
	workerPgid?: number;
	workerStartTime?: number;
	sock: string;
	outLog: string;
	spec: HostedSpec;
	team?: { teamId: string; role: string; orchestrator?: boolean };
	backendSessionId?: string;
	backendSessionFile?: string;
	/** Bytes of out.jsonl the manager has fully processed (side effects included). */
	consumedOffset: number;
	state: WorkerState;
	createdAt: number;
	updatedAt: number;
}

export interface HostInfo {
	hostPid: number;
	hostStartTime?: number;
	workerPid?: number;
	workerStartTime?: number;
	startedAt: number;
}

export interface WorkerStatus {
	exitCode: number | null;
	signal: string | null;
	endedAt: number;
	error?: string;
}

export const safeId = (value: string): boolean => SAFE_ID.test(value) && value !== "." && value !== "..";
export const ownerDir = (root: string, owner: string): string => path.join(root, owner);
export const workerDir = (root: string, owner: string, id: string): string => path.join(root, owner, id);
export const mailboxDir = (root: string, owner: string): string => path.join(root, owner, "mailbox");
export const deadDir = (root: string): string => path.join(root, "dead");
export const files = (dir: string) => ({
	meta: path.join(dir, "meta.json"),
	spawn: path.join(dir, "spawn.json"),
	host: path.join(dir, "host.json"),
	out: path.join(dir, "out.jsonl"),
	in: path.join(dir, "in.jsonl"),
	status: path.join(dir, "status.json"),
	lock: path.join(dir, "adopt.lock"),
	log: path.join(dir, "host.log"),
});

/**
 * Socket for one worker's host. Worker IDs repeat across owner sessions, so the
 * name carries a hash of the owner. Prefer $XDG_RUNTIME_DIR; fall back to a
 * private /tmp directory when the path would not fit in sun_path.
 */
export function socketPath(owner: string, id: string, env: NodeJS.ProcessEnv = process.env): string {
	const name = `${createHash("sha256").update(owner).digest("hex").slice(0, 12)}-${id}.sock`;
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const candidates = [
		...(env.XDG_RUNTIME_DIR ? [path.join(env.XDG_RUNTIME_DIR, "pi-web-workers")] : []),
		path.join(os.tmpdir(), `pi-web-workers-${uid}`),
		path.join("/tmp", `pi-web-workers-${uid}`),
	];
	for (const dir of candidates) {
		const full = path.join(dir, name);
		if (Buffer.byteLength(full) <= MAX_SOCKET_PATH) return full;
	}
	return path.join("/tmp", name);
}

export function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Atomic replace: readers never observe a half-written file. */
export function writeJson(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function readMeta(dir: string): WorkerMeta | undefined {
	const meta = readJson<WorkerMeta>(files(dir).meta);
	if (!meta || meta.v !== 1 || typeof meta.id !== "string" || typeof meta.sock !== "string" || !meta.spec) return undefined;
	// The host may have learned pids the manager never saw (it died before the host's hello).
	const host = readJson<HostInfo>(files(dir).host);
	if (host) {
		meta.hostPid ??= host.hostPid;
		meta.pidStartTime ??= host.hostStartTime;
		meta.workerPid ??= host.workerPid;
		meta.workerPgid ??= host.workerPid;
		meta.workerStartTime ??= host.workerStartTime;
	}
	return meta;
}

export function writeMeta(dir: string, meta: WorkerMeta): void {
	meta.updatedAt = Date.now();
	writeJson(files(dir).meta, meta);
}

export function readStatus(dir: string): WorkerStatus | undefined {
	return readJson<WorkerStatus>(files(dir).status);
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks); undefined when unavailable. */
export function procStartTime(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parentheses; fields resume after the LAST ')'.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const value = Number(rest[22 - 3]);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Alive, and (when known) the same process that started at startTime rather than a pid reuse. */
export function pidAlive(pid: number | undefined, startTime?: number): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (startTime === undefined) return true;
	const actual = procStartTime(pid);
	// Without /proc (non-Linux) the start time cannot be checked; trust kill(0).
	return actual === undefined ? process.platform !== "linux" : actual === startTime;
}

interface LockData { pid: number; startTime?: number }

/**
 * Exclusive adoption lock. Re-entrant for this process; a lock held by a dead
 * (or reused) pid is stale and taken over.
 */
export function acquireLock(dir: string): boolean {
	const file = files(dir).lock;
	const mine: LockData = { pid: process.pid, startTime: procStartTime(process.pid) };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const held = readJson<LockData>(file);
		if (held && held.pid === mine.pid && held.startTime === mine.startTime) return true;
		if (held && pidAlive(held.pid, held.startTime)) return false;
		try { fs.unlinkSync(file); } catch { /* raced another taker; retry once */ }
	}
	return false;
}

export function releaseLock(dir: string): void {
	const file = files(dir).lock;
	const held = readJson<LockData>(file);
	if (held?.pid !== process.pid) return;
	try { fs.unlinkSync(file); } catch { /* already gone */ }
}

export function lockHeldByOther(dir: string): boolean {
	const held = readJson<LockData>(files(dir).lock);
	return !!held && held.pid !== process.pid && pidAlive(held.pid, held.startTime);
}

/** Worker directories (with a readable meta.json) of one owner session. */
export function listOwner(root: string, owner: string): { dir: string; meta: WorkerMeta }[] {
	if (!safeId(owner)) return [];
	let names: string[];
	try {
		names = fs.readdirSync(ownerDir(root, owner));
	} catch {
		return [];
	}
	const out: { dir: string; meta: WorkerMeta }[] = [];
	for (const name of names.sort()) {
		if (name === "mailbox" || !safeId(name)) continue;
		const dir = workerDir(root, owner, name);
		const meta = readMeta(dir);
		if (meta && meta.id === name) out.push({ dir, meta });
	}
	return out;
}

/** Move one worker directory into dead/. Returns the new path, or undefined if it could not move. */
export function archive(root: string, dir: string, owner: string, id: string): string | undefined {
	const target = path.join(deadDir(root), `${owner}-${id}-${Date.now().toString(36)}`);
	try {
		ensurePrivateDir(deadDir(root));
		fs.renameSync(dir, target);
		return target;
	} catch {
		return undefined;
	}
}

/**
 * Archive entries older than maxAgeMs that have no living host and no adopter,
 * then delete archives past their retention. Returns archived worker dirs.
 */
export function reap(root: string, now = Date.now(), maxAgeMs = REAP_AFTER_MS, deadRetentionMs = DEAD_RETENTION_MS): string[] {
	const archived: string[] = [];
	let owners: string[];
	try {
		owners = fs.readdirSync(root);
	} catch {
		return archived;
	}
	for (const owner of owners) {
		if (owner === "dead" || !safeId(owner)) continue;
		for (const { dir, meta } of listOwner(root, owner)) {
			const age = now - (meta.updatedAt || meta.createdAt || 0);
			if (age < maxAgeMs) continue;
			if (pidAlive(meta.hostPid, meta.pidStartTime) || lockHeldByOther(dir)) continue;
			if (archive(root, dir, owner, meta.id)) archived.push(dir);
		}
		// Owner directories left with nothing but an empty mailbox go too.
		try {
			const rest = fs.readdirSync(ownerDir(root, owner)).filter((n) => n !== "mailbox");
			const mailbox = mailboxDir(root, owner);
			const mailboxEmpty = !fs.existsSync(mailbox) || fs.readdirSync(mailbox).length === 0;
			if (!rest.length && mailboxEmpty) fs.rmSync(ownerDir(root, owner), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	try {
		for (const name of fs.readdirSync(deadDir(root))) {
			const full = path.join(deadDir(root), name);
			try {
				if (now - fs.statSync(full).mtimeMs > deadRetentionMs) fs.rmSync(full, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	} catch {
		/* no dead/ yet */
	}
	return archived;
}
