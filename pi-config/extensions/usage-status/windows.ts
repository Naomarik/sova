// windows: the usage windows a provider doesn't report, declared by the user. Today that is
// Ollama Cloud's monthly reset day: Ollama sends only the share of the month used, never when the
// month resets. The file is `usage-windows.json` in pi's agent dir, `{version: 1, ollama?:
// {resetDay: 1..31}}` (missing or unreadable = unknown), written by `/usage reset-day` and by
// Sova's Usage page, and synced between hosts as a setting. Not in auth.json beside the key: pi
// replaces a provider's whole entry there on a new sign-in.
//
// Node builtins only: Sova's server imports this (server/insights.ts, server/index.ts,
// server/sync/docs.ts), like ./fetch.ts.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const USAGE_WINDOWS_FILE = "usage-windows.json";

export interface UsageWindows {
	version: 1;
	ollama?: { resetDay: number };
}

const isDay = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 31;

/** Strict parse of the file's text (or its parsed value): `{version: 1, ollama?: {resetDay: 1..31}}` and nothing else. */
export function parseUsageWindows(input: unknown): { ok: true; value: UsageWindows } | { ok: false; error: string } {
	let v = input;
	if (typeof input === "string") {
		try {
			v = JSON.parse(input);
		} catch {
			return { ok: false, error: "not JSON" };
		}
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "not an object" };
	const o = v as Record<string, unknown>;
	if (o.version !== 1) return { ok: false, error: "version must be 1" };
	const extra = Object.keys(o).filter((k) => k !== "version" && k !== "ollama");
	if (extra.length) return { ok: false, error: `unknown key ${extra[0]}` };
	if (o.ollama === undefined) return { ok: true, value: { version: 1 } };
	const ol = o.ollama;
	if (!ol || typeof ol !== "object" || Array.isArray(ol)) return { ok: false, error: "ollama must be an object" };
	const keys = Object.keys(ol);
	const day = (ol as Record<string, unknown>).resetDay;
	if (keys.length !== 1 || !isDay(day)) return { ok: false, error: "ollama.resetDay must be a whole day 1..31" };
	return { ok: true, value: { version: 1, ollama: { resetDay: day } } };
}

/** pi's agent dir: $PI_CODING_AGENT_DIR when set (as pi itself resolves it), else ~/.pi/agent. */
export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
}

export const usageWindowsPath = (agentDir = defaultAgentDir()) => path.join(agentDir, USAGE_WINDOWS_FILE);

/** The file's windows; `{version: 1}` (nothing declared) when it is missing or unreadable. */
export function readUsageWindows(agentDir = defaultAgentDir()): UsageWindows {
	let text: string;
	try {
		text = fs.readFileSync(usageWindowsPath(agentDir), "utf8");
	} catch {
		return { version: 1 };
	}
	const r = parseUsageWindows(text);
	return r.ok ? r.value : { version: 1 };
}

/** Writes the file atomically (temp file + rename). Throws on an invalid value or a failed write. */
export function writeUsageWindows(value: UsageWindows, agentDir = defaultAgentDir()): void {
	const r = parseUsageWindows(value);
	if (!r.ok) throw new Error(`usage-windows.json: ${r.error}`);
	const file = usageWindowsPath(agentDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(r.value, null, 2)}\n`, { mode: 0o644 });
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

/** Sets (1..31) or clears (null) Ollama Cloud's reset day, keeping the rest of the file. */
export function setOllamaResetDay(day: number | null, agentDir = defaultAgentDir()): UsageWindows {
	if (day !== null && !isDay(day)) throw new Error("The reset day must be a whole day from 1 to 31.");
	const { ollama: _old, ...rest } = readUsageWindows(agentDir);
	const next: UsageWindows = day === null ? rest : { ...rest, ollama: { resetDay: day } };
	writeUsageWindows(next, agentDir);
	return next;
}

/** Local midnight of day `day` of month `month` (0-based, may overflow into the next/previous year), clamped to the month's last day. */
function anchor(year: number, month: number, day: number): Date {
	const last = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(day, last));
}

/**
 * The monthly window around `now` for reset day `resetDay`: from local midnight of that day
 * (clamped to the month's last day: 31 is Feb 28/29 and Apr 30) to the same clamped day of the
 * next month. `now` on the reset day itself is the window's first day.
 */
export function monthlyWindow(resetDay: number, now: number): { startsAt: string; resetsAt: string } {
	const d = new Date(now);
	const y = d.getFullYear();
	const m = d.getMonth();
	const thisMonth = anchor(y, m, resetDay);
	const [start, end] = now >= thisMonth.getTime() ? [thisMonth, anchor(y, m + 1, resetDay)] : [anchor(y, m - 1, resetDay), thisMonth];
	return { startsAt: start.toISOString(), resetsAt: end.toISOString() };
}

/** `/usage reset-day` arguments after "reset-day": `ollama <1-31|clear>`. */
export function parseResetDayArgs(args: string): { day: number | null } | { error: string } {
	const usage = "Usage: /usage reset-day ollama <1-31|clear>";
	const m = /^ollama\s+(\S+)$/i.exec(args.trim());
	if (!m) return { error: usage };
	if (m[1]!.toLowerCase() === "clear") return { day: null };
	if (!/^\d{1,2}$/.test(m[1]!)) return { error: usage };
	const day = Number(m[1]);
	return isDay(day) ? { day } : { error: usage };
}

/**
 * Runs `/usage reset-day <args>` against the file: the message to show and its level. Writes only
 * on a valid argument.
 */
export function runResetDay(args: string, agentDir = defaultAgentDir()): { message: string; level: "info" | "warning" | "error" } {
	const parsed = parseResetDayArgs(args);
	if ("error" in parsed) return { message: parsed.error, level: "warning" };
	try {
		setOllamaResetDay(parsed.day, agentDir);
	} catch (err) {
		return { message: `usage reset-day: ${err instanceof Error ? err.message : String(err)}`, level: "error" };
	}
	return parsed.day === null
		? { message: "Ollama Cloud's reset day is cleared.", level: "info" }
		: { message: `Ollama Cloud resets on day ${parsed.day} of each month.`, level: "info" };
}
