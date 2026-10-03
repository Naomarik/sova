/**
 * Detached workers no manager has adopted (README.md). A hosted worker keeps running under its
 * host process when the session that ran it goes away (a restart); until a manager adopts it again,
 * no process counts its calls. This reader finds such workers in the hosted-workers registry
 * (`<agent dir>/sova/workers/<owner>/<id>/`) so Sova's server counts them once:
 *
 * - **adopted**: `adopt.lock` names a live process (any process, the caller included). That
 *   process's own count already includes the worker (its runner's child counts): skipped.
 * - **unadopted**: the worker is starting, running or detached, its host lives, and nobody holds
 *   the lock. Its counts are the host's `llm.json` (the worker's latest report), or `null` when
 *   there is none (a Claude Code worker, a host from before the counter, a worker that hasn't
 *   reported yet): the caller counts that as unknown, never 0.
 * - a dead host, an exited worker, an unreadable entry: nothing.
 *
 * Cheap enough to call on every change: a directory listing per owner, a stat of three small files
 * per worker, file reads only when a stat changed, and /proc checks for the pids. Builtins only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCounts, type LlmCounts } from "./tracker.ts";

export interface UnadoptedWorker {
	/** `${owner}/${id}`. */
	key: string;
	/** The worker's own producer id, when it reported one. */
	producer?: string;
	/** Its latest counts, or null: unknown (count it as partial, never as 0). */
	counts: LlmCounts | null;
	/** Producers its counts already include (its own workers'). */
	folded?: string[];
}

const ADOPTABLE = new Set(["starting", "running", "detached"]);
const MAX_DIRS = 512;
/** The entry standing for every worker directory past MAX_DIRS (unknown, so partial). */
export const OVERFLOW_KEY = "…overflow";

interface Meta {
	state?: unknown;
	hostPid?: unknown;
	pidStartTime?: unknown;
}
interface Lock {
	pid?: unknown;
	startTime?: unknown;
}
interface Cached {
	sig: string;
	meta?: Meta;
	lock?: Lock;
	llm?: ReturnType<typeof parseCounts>;
}

const CACHE_KEY = Symbol.for("sova.llm-inflight.hosted.v1");
const cache = ((globalThis as unknown as Record<symbol, Map<string, Cached>>)[CACHE_KEY] ??= new Map());

function agentDir(): string {
	const raw = process.env.PI_CODING_AGENT_DIR;
	if (raw) return raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.join(os.homedir(), ".pi", "agent");
}

export const defaultWorkersRoot = (): string => path.join(agentDir(), "sova", "workers");

function stamp(file: string): string {
	try {
		const s = fs.statSync(file);
		return `${s.ino}:${s.mtimeMs}:${s.size}`;
	} catch {
		return "-";
	}
}

function read<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function startTime(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const value = Number(fields[19]);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Alive and, when its start time is known, not a reused pid. */
function alive(pid: unknown, start: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (typeof start !== "number") return true;
	const actual = startTime(pid);
	return actual === undefined ? process.platform !== "linux" : actual === start;
}

function entry(dir: string): Cached {
	const files = { meta: path.join(dir, "meta.json"), lock: path.join(dir, "adopt.lock"), llm: path.join(dir, "llm.json") };
	const sig = `${stamp(files.meta)}|${stamp(files.lock)}|${stamp(files.llm)}`;
	const hit = cache.get(dir);
	if (hit && hit.sig === sig) return hit;
	const next: Cached = { sig, meta: read<Meta>(files.meta), lock: read<Lock>(files.lock), llm: parseCounts(read(files.llm)) };
	cache.set(dir, next);
	return next;
}

function list(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "dead" && d.name !== "mailbox").map((d) => d.name);
	} catch {
		return [];
	}
}

export function readUnadoptedWorkers(root: string = defaultWorkersRoot()): UnadoptedWorker[] {
	const out: UnadoptedWorker[] = [];
	const seen = new Set<string>();
	let scanned = 0;
	let cut = false;
	for (const owner of list(root)) {
		if (cut) break;
		for (const id of list(path.join(root, owner))) {
			if (++scanned > MAX_DIRS) {
				cut = true;
				break;
			}
			const dir = path.join(root, owner, id);
			seen.add(dir);
			const e = entry(dir);
			if (!e.meta || !ADOPTABLE.has(e.meta.state as string)) continue;
			if (!alive(e.meta.hostPid, e.meta.pidStartTime)) continue;
			if (e.lock && alive(e.lock.pid, e.lock.startTime)) continue;
			const counts = e.llm ? { active: e.llm.active, approximate: e.llm.approximate, claudeTurns: e.llm.claudeTurns, degraded: e.llm.degraded } : null;
			out.push({
				key: `${owner}/${id}`,
				...(e.llm?.producer ? { producer: e.llm.producer } : {}),
				counts,
				...(e.llm?.folded?.length ? { folded: e.llm.folded } : {}),
			});
		}
	}
	for (const dir of cache.keys()) if (!seen.has(dir) && dir.startsWith(root)) cache.delete(dir);
	// Workers past the bound were not looked at: unknown, never silently 0.
	if (cut) out.push({ key: OVERFLOW_KEY, counts: null });
	return out;
}
