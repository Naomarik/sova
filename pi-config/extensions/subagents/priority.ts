/**
 * Worker priority (Sova's §app.load-priority/workers): a server that hosts this extension sets the
 * niceness its agents' processes start at, and every worker spawn and tool command here lowers
 * itself to it. Unset (pi on its own, the TUI) nothing changes.
 *
 *   globalThis[Symbol.for("sova:worker-nice")] = () => number   // 0 = leave priority alone
 *
 * The hook is read at each use, so the host can change it without reloading anything. Builtins only.
 * Extensions that import nothing outside their own directory call the host's wrappers instead:
 * claude-code `Symbol.for("sova:lower-worker")` (pid) and the sandbox
 * `Symbol.for("sova:tool-command-prefix")` (prefix), both installed by Sova's server/process-priority.ts.
 */
import { getPriority, setPriority } from "node:os";

export const WORKER_NICE = Symbol.for("sova:worker-nice");

/** The highest niceness a process can have on Linux and macOS. */
const MAX_NICE = 19;

/** A niceness from anything: an integer 0..19, else undefined. */
export function parseNice(value: unknown): number | undefined {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_NICE ? n : undefined;
}

/** The niceness the host asks for, or 0 (leave alone) when there is no host or it fails. */
export function workerNice(): number {
	const hook = (globalThis as Record<symbol, unknown>)[WORKER_NICE];
	if (typeof hook !== "function") return 0;
	try {
		return parseNice(hook()) ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Lower a freshly spawned process to `nice`. Only ever lowers: a process already at that niceness
 * or above is left alone (raising needs privileges). Never throws: a process that cannot be
 * lowered (gone already, not ours, Windows) just keeps its priority. True when it was changed.
 */
export function lowerPriority(pid: number | undefined, nice = workerNice(), platform: NodeJS.Platform = process.platform): boolean {
	if (!nice || platform === "win32" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		if (getPriority(pid) >= nice) return false;
		setPriority(pid, nice);
		return true;
	} catch {
		return false;
	}
}

/**
 * The shell line that lowers a tool command's own shell (`$$`), so everything the command runs
 * inherits it, or undefined when nothing needs lowering. `own` is the niceness the shell starts at
 * (the spawning process's). util-linux `renice -n` sets the value (unless POSIXLY_CORRECT), BSD's
 * (macOS) adds it, so each gets the number that lands on `nice`.
 */
export function reniceLine(
	nice = workerNice(),
	platform: NodeJS.Platform = process.platform,
	own = safeOwnNice(),
	posixly = process.env.POSIXLY_CORRECT !== undefined,
): string | undefined {
	if (!nice || platform === "win32" || own >= nice) return undefined;
	const n = platform === "linux" && !posixly ? nice : nice - own;
	return `renice -n ${n} -p $$ >/dev/null 2>&1`;
}

/** A shell command prefix with the renice line in front of whatever prefix was configured. */
export function withPriorityPrefix(prefix: string | undefined, line = reniceLine()): string | undefined {
	if (!line) return prefix;
	return prefix ? `${line}\n${prefix}` : line;
}

function safeOwnNice(): number {
	try {
		return getPriority();
	} catch {
		return 0;
	}
}
