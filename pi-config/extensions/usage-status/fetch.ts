// fetch: the provider fetchers, the shared cache file and the cross-process
// lock behind the usage-status extension, with nothing from the pi runtime in it.
// The extension (footer, /usage, /usage-refresh) imports this, and so does Sova's
// server for its Refresh Usage button: both refresh the same cache the same way.
//
// Refreshes are rate-limited machine-wide through the cache file plus an O_EXCL
// lockfile, so only one process fetches per ~3 minutes no matter how many pis are
// open. Credential files are only ever read, never written.
//
// Claude is fetched once per login on this host (../claude-code/accounts.ts): `claude` is always
// Claude Code's own login (`default`), as every older reader expects, and `claudeAccounts` holds
// each added login's reading, keyed by login id. A login this host marked as needing sign-in is
// never fetched.
//
// Node builtins and the global fetch only: keep it that way, it is imported from
// outside pi (like ../mode/state.ts). ../claude-code/accounts.ts is node builtins only too.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeLogins, DEFAULT_LOGIN_ID, claudeConfigDirEnv } from "../claude-code/accounts.ts";
import { readKeychainCredentials, type KeychainOptions } from "../claude-code/keychain.ts";

const HOME = os.homedir();
const PI_AUTH = path.join(HOME, ".pi/agent/auth.json"); // ollama-cloud key + openai-codex oauth + zai/deepseek keys
const CODEX_AUTH = path.join(HOME, ".codex/auth.json");
/** pi's agent dir: $PI_CODING_AGENT_DIR when set (as pi itself resolves it), else ~/.pi/agent. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".pi/agent");
export const CACHE_DIR = path.join(AGENT_DIR, "cache");
export const CACHE_FILE = path.join(CACHE_DIR, "usage-status.json");
const LOCK_FILE = `${CACHE_FILE}.lock`;

export const FRESH_MS = 150_000; // cache younger than this is used without fetching
export const FAILURE_RETRY_MS = 60_000; // retry floor after a failed fetch
export const RATE_LIMITED_RETRY_MS = 10 * 60_000; // a Claude login's retry after HTTP 429: the endpoint is refusing
export const LOCK_STALE_MS = 30_000; // lock older than this is considered abandoned
export const FETCH_TIMEOUT_MS = 10_000;
export const FORCE_WAIT_MS = 12_000; // a forced refresh waits this long for another holder
export const CACHE_SCHEMA = 3; // bump when a cached shape changes: older caches refetch once

export const PROVIDERS = ["ollama", "openai", "claude", "zai", "deepseek"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Normalized data (this is what goes into the shared cache; no secrets)

export type OllamaData =
	| { state: "ok"; usedPct: number }
	| { state: "nokey" }
	| { state: "badkey" }
	| { state: "na" };

export interface Window {
	pct: number;
	resetsAt?: string;
}

/** One entry of claude's `limits[]`: label "5h" / "7d" / "7d scoped" (+ scope model name). */
export interface ClaudeLimit extends Window {
	label: string;
	scope?: string;
	active?: boolean;
}

export type ClaudeData =
	| {
			state: "ok";
			fiveHour?: Window;
			sevenDay?: Window;
			sevenDayOpus?: Window;
			limits?: ClaudeLimit[];
			extraUsage?: { enabled: boolean; pct?: number };
	  }
	| { state: "nologin" }
	| { state: "expired" };

/** An OpenAI window: `seconds` is its own `limit_window_seconds` (additive; absent when the API
    sends none), which also picks its label. */
export type OpenAiWindow = Window & { label: string; seconds?: number };

export type OpenAiData =
	| { state: "ok"; plan?: string; limitReached?: boolean; windows: OpenAiWindow[] }
	| { state: "nologin" }
	| { state: "expired" }
	| { state: "na" };

export type ZaiData =
	| { state: "ok"; level?: string; fiveHour?: Window & { label: string }; mcp?: { used: number; limit: number; pct: number } }
	| { state: "nokey" }
	| { state: "badkey" }
	| { state: "na" };

/** One `balance_infos[]` entry, amounts parsed out of deepseek's decimal strings. */
export interface DeepSeekBalance {
	currency: string;
	total: number;
	granted: number;
	toppedUp: number;
}

export type DeepSeekData =
	| { state: "ok"; available: boolean; balances: DeepSeekBalance[] }
	| { state: "nokey" }
	| { state: "badkey" }
	| { state: "na" };

/** One added Claude login's reading in `claudeAccounts`. */
export interface ClaudeAccountUsage {
	/** The last reading, kept through a failed or skipped fetch; absent until one succeeded. */
	data?: ClaudeData;
	/** When `data` was fetched. */
	fetchedAt?: number;
	/** This login's own next fetch: FRESH_MS after a reading, FAILURE_RETRY_MS after a failure
	    (RATE_LIMITED_RETRY_MS after an HTTP 429). A window of `data` resetting after `fetchedAt`
	    makes it due earlier (claudeReadingDue). */
	nextFetchAt: number;
	/** Why the last fetch failed; absent after a success. */
	error?: string;
	/** Not fetched: this host marked the login as needing sign-in (claude-accounts-state.json). */
	skipped?: "auth";
}

export interface CacheFile {
	schemaVersion?: number; // missing on caches written before CACHE_SCHEMA 2
	fetchedAt: number;
	nextFetchAt: number;
	ollama?: OllamaData;
	openai?: OpenAiData;
	/** Claude Code's own login (`default`): the one Claude reading every older reader knows. */
	claude?: ClaudeData;
	/** When `claude` was fetched, and its own next fetch: `default` keeps its own cadence like any
	    login, so its failure (`errors.claude`) never shortens the other providers' refresh.
	    Additive: absent in a file from an older writer, which fetched `claude` with the file
	    (`fetchedAt`) and leaves it due now. */
	claudeFetchedAt?: number;
	claudeNextFetchAt?: number;
	/** Every other Claude login assigned to this host, by login id (`l-…`). Absent in caches from
	    before logins, and from a writer that has none; never includes `default`. */
	claudeAccounts?: Record<string, ClaudeAccountUsage>;
	zai?: ZaiData;
	deepseek?: DeepSeekData;
	errors: { ollama?: string; openai?: string; claude?: string; zai?: string; deepseek?: string };
}

// ---------------------------------------------------------------------------
// Fetchers

async function readJson(file: string): Promise<any | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** No such file (not merely unreadable or malformed). */
async function missing(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

export async function fetchOllama(): Promise<OllamaData> {
	const auth = await readJson(PI_AUTH);
	const key = auth?.["ollama-cloud"]?.key;
	if (typeof key !== "string" || !key) return { state: "nokey" };

	const res = await fetch("https://ollama.com/api/usage", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "badkey" };
	if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);

	const body: any = await res.json();
	const usage = body?.limits?.monthly?.usage;
	if (typeof usage !== "number" || !Number.isFinite(usage)) return { state: "na" };
	return { state: "ok", usedPct: usage * 100 };
}

export async function fetchOpenAi(): Promise<OpenAiData> {
	// pi's own oauth entry first (pi keeps it refreshed), then the Codex CLI's.
	const pi = (await readJson(PI_AUTH))?.["openai-codex"];
	let token = pi?.access;
	let accountId = pi?.accountId;
	if (typeof token !== "string" || !token) {
		const codex = (await readJson(CODEX_AUTH))?.tokens;
		token = codex?.access_token;
		accountId = codex?.account_id;
	}
	if (typeof token !== "string" || !token) return { state: "nologin" };

	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (typeof accountId === "string" && accountId) headers["ChatGPT-Account-Id"] = accountId;
	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "expired" };
	if (!res.ok) throw new Error(`openai HTTP ${res.status}`);

	const body: any = await res.json();
	const limits = body?.rate_limit;
	if (!limits || typeof limits !== "object") return { state: "na" };
	const windows: OpenAiWindow[] = [];
	// Each window is labelled from its own length; with none sent, the secondary keeps "5h".
	const add = (w: any, fallback: string) => {
		if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) return;
		const secs = num(w.limit_window_seconds);
		const seconds = secs !== undefined && secs > 0 ? secs : undefined;
		const near = (target: number) => seconds !== undefined && Math.abs(seconds - target) <= target * 0.05;
		const label = near(604_800) ? "7d" : near(18_000) ? "5h" : seconds === undefined ? fallback : "pri";
		windows.push({ label, pct: w.used_percent, resetsAt: openAiReset(w), ...(seconds !== undefined ? { seconds } : {}) });
	};
	add(limits.secondary_window, "5h");
	add(limits.primary_window, "pri");
	windows.sort((a, b) => (a.label === "5h" ? -1 : b.label === "5h" ? 1 : 0)); // 5h before 7d, like claude
	if (!windows.length) return { state: "na" };
	const plan = typeof body.plan_type === "string" && body.plan_type ? body.plan_type : undefined;
	const limitReached = limits.limit_reached === true || limits.allowed === false ? true : undefined;
	return { state: "ok", plan, limitReached, windows };
}

/** Window reset as ISO: `reset_at` (unix seconds), else now + `reset_after_seconds`. */
function openAiReset(w: any): string | undefined {
	const at = num(w.reset_at);
	const after = num(w.reset_after_seconds);
	return isoTime(at !== undefined ? at * 1000 : after !== undefined ? Date.now() + after * 1000 : undefined);
}

function isoTime(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const d = new Date(ms);
	return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function toWindow(section: any): Window | undefined {
	if (!section || typeof section.utilization !== "number") return undefined;
	return {
		pct: section.utilization,
		resetsAt: typeof section.resets_at === "string" ? section.resets_at : undefined,
	};
}

/** The fetch a Claude reading uses; tests pass a fake. */
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "json">>;

/**
 * One Claude login's usage, read with the access token in `<dir>/.credentials.json` (only read,
 * never written or refreshed: Claude Code refreshes it). `dir` defaults to Claude Code's own
 * directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). On macOS, with no file there, the login's
 * keychain item is read instead, afresh for this one fetch (../claude-code/keychain.ts).
 */
export async function fetchClaude(dir: string = new ClaudeLogins().dirOf(DEFAULT_LOGIN_ID), fetchImpl: FetchImpl = fetch, keychain?: KeychainOptions): Promise<ClaudeData> {
	const file = path.join(dir, ".credentials.json");
	const creds = (await readJson(file)) ?? (await missing(file) ? ((await readKeychainCredentials(claudeConfigDirEnv(dir, keychain?.env), keychain)) as any) : undefined);
	const token = creds?.claudeAiOauth?.accessToken;
	if (typeof token !== "string" || !token) return { state: "nologin" };

	const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401) return { state: "expired" };
	if (!res.ok) throw new Error(`claude HTTP ${res.status}`);

	const body: any = await res.json();
	const extra = body?.extra_usage;
	return {
		state: "ok",
		fiveHour: toWindow(body?.five_hour),
		sevenDay: toWindow(body?.seven_day),
		sevenDayOpus: toWindow(body?.seven_day_opus),
		limits: claudeLimits(body?.limits),
		extraUsage: extra && typeof extra.is_enabled === "boolean" ? { enabled: extra.is_enabled, pct: num(extra.utilization) } : undefined,
	};
}

const CLAUDE_LIMIT_LABELS: Record<string, string> = { session: "5h", weekly_all: "7d", weekly_scoped: "7d scoped" };

/** The richer `limits[]` array; entries without a numeric percent (or null) are dropped. */
function claudeLimits(raw: unknown): ClaudeLimit[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: ClaudeLimit[] = [];
	for (const l of raw) {
		const pct = num(l?.percent);
		if (pct === undefined || typeof l.kind !== "string" || !l.kind) continue;
		const scope = l.scope?.model?.display_name;
		out.push({
			label: CLAUDE_LIMIT_LABELS[l.kind] ?? l.kind,
			pct,
			resetsAt: typeof l.resets_at === "string" ? l.resets_at : undefined,
			scope: typeof scope === "string" && scope ? scope : undefined,
			active: typeof l.is_active === "boolean" ? l.is_active : undefined,
		});
	}
	return out.length ? out : undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clampPct = (p: number) => Math.min(100, Math.max(0, p));
const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 }; // day, hour, minute, week

/** Compact window tag from its length: 300 -> "5h", 10080 -> "1w", 45 -> "45m". */
function zaiLabel(minutes: number): string {
	if (minutes % 10080 === 0) return `${minutes / 10080}w`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** Percent used; `percentage` unless usage + currentValue/remaining allow a recompute. */
function zaiPct(l: any): number | undefined {
	const usage = num(l.usage);
	const current = num(l.currentValue);
	const remaining = num(l.remaining);
	if (usage !== undefined && usage > 0 && (current !== undefined || remaining !== undefined)) {
		const used = Math.max(remaining !== undefined ? usage - remaining : -Infinity, current ?? -Infinity);
		return clampPct((used / usage) * 100);
	}
	const p = num(l.percentage);
	return p === undefined ? undefined : clampPct(p);
}

export async function fetchZai(): Promise<ZaiData> {
	const auth = await readJson(PI_AUTH);
	const key = auth?.zai?.key;
	if (typeof key !== "string" || !key) return { state: "nokey" };

	const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "badkey" };
	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const body: any = await res.json();
	if (body?.success !== true || body?.code !== 200) throw new Error(body?.msg ? String(body.msg) : "bad response");
	const limits: any[] = Array.isArray(body?.data?.limits) ? body.data.limits.filter((l: any) => l && typeof l === "object") : [];

	// Coding-plan window: TOKENS_LIMIT (older) or CREDIT_LIMIT (renamed); prefer the 5h one, else the shortest.
	const minutes = (l: any) => (ZAI_UNIT_MINUTES[l.unit] ?? NaN) * l.number;
	const plan = limits.filter((l) => l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT");
	const win =
		plan.find((l) => l.unit === 3 && l.number === 5) ??
		plan.filter((l) => Number.isFinite(minutes(l)) && minutes(l) > 0).sort((a, b) => minutes(a) - minutes(b))[0];
	let fiveHour: (Window & { label: string }) | undefined;
	const winPct = win && zaiPct(win);
	if (winPct !== undefined) {
		// Resets far beyond the window length are known-bad values: drop them.
		const reset = num(win.nextResetTime);
		const span = (Number.isFinite(minutes(win)) ? minutes(win) : 300) * 60_000 + 60_000;
		fiveHour = { pct: winPct, label: zaiLabel(minutes(win)), resetsAt: reset !== undefined && reset <= Date.now() + span ? new Date(reset).toISOString() : undefined };
	}

	let mcp: { used: number; limit: number; pct: number } | undefined;
	const t = limits.find((l) => l.type === "TIME_LIMIT");
	if (t) {
		const limit = num(t.usage);
		const remaining = num(t.remaining);
		const used = num(t.currentValue) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
		const p = num(t.percentage);
		if (limit !== undefined && limit > 0 && used !== undefined && used >= 0 && p !== undefined)
			mcp = { used, limit, pct: clampPct(p) };
	}

	const level = typeof body.data?.level === "string" && body.data.level ? body.data.level : undefined;
	return fiveHour || mcp ? { state: "ok", level, fiveHour, mcp } : { state: "na" };
}

/** deepseek reports amounts as decimal strings ("4.29"); undefined when missing or unparseable. */
function dsAmount(v: unknown): number | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v !== "string" || !v.trim()) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

export async function fetchDeepSeek(): Promise<DeepSeekData> {
	const auth = await readJson(PI_AUTH);
	const key = auth?.deepseek?.key;
	if (typeof key !== "string" || !key) return { state: "nokey" };

	const res = await fetch("https://api.deepseek.com/user/balance", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "badkey" };
	if (!res.ok) throw new Error(`deepseek HTTP ${res.status}`);

	const body: any = await res.json();
	const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
	const balances: DeepSeekBalance[] = [];
	for (const b of infos) {
		const total = dsAmount(b?.total_balance);
		if (total === undefined || typeof b.currency !== "string" || !b.currency) continue;
		balances.push({
			currency: b.currency,
			total,
			granted: dsAmount(b.granted_balance) ?? 0,
			toppedUp: dsAmount(b.topped_up_balance) ?? 0,
		});
	}
	if (!balances.length) return { state: "na" };
	return { state: "ok", available: body?.is_available !== false, balances };
}

export function errMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
		return err.message;
	}
	return String(err);
}

// ---------------------------------------------------------------------------
// Shared cache + cross-process lock

function isCacheFile(v: any): v is CacheFile {
	return v && typeof v === "object" && typeof v.fetchedAt === "number" && typeof v.errors === "object";
}

export async function readCache(): Promise<CacheFile | undefined> {
	const data = await readJson(CACHE_FILE); // missing or corrupt -> undefined
	if (!isCacheFile(data)) return undefined;
	if (typeof data.nextFetchAt !== "number") data.nextFetchAt = data.fetchedAt + FRESH_MS;
	// Cache written before the openai / zai sources existed: refetch once.
	if (!data.openai && !data.errors.openai) data.nextFetchAt = 0;
	if (!data.zai && !data.errors.zai) data.nextFetchAt = 0;
	// Cached shapes older than CACHE_SCHEMA lack fields the /usage screen shows: refetch once.
	if (data.schemaVersion !== CACHE_SCHEMA) data.nextFetchAt = 0;
	// Written without this host's added logins (before they existed, or by an older extension that
	// dropped them): refetch once. `claudeAccounts` is additive, so CACHE_SCHEMA stays as it is and
	// an older reader keeps reading this file as it always did.
	const logins = new ClaudeLogins();
	const ids = claudeLoginIds(logins);
	if (!data.claudeAccounts && ids.length) data.nextFetchAt = 0;
	// A login held here with no reading yet (just taken or added), or one whose last reading has a
	// window that reset since: due now, with the whole cache, never at the next ordinary fetch.
	// The fetch moves the reading past the reset, and a failed one waits out its own retry
	// (`error` set), so neither loops.
	if (claudeReadingsDue(data, ids, Date.now(), (id) => needsSignIn(logins, id))) data.nextFetchAt = 0;
	return data;
}

/** Every window reset (ms) a Claude reading names. */
function claudeResets(data: ClaudeData | undefined): number[] {
	if (data?.state !== "ok") return [];
	const windows: (Window | undefined)[] = [data.fiveHour, data.sevenDay, data.sevenDayOpus, ...(data.limits ?? [])];
	return windows.map((w) => (w?.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((t) => !Number.isNaN(t));
}

/** A window of `data` (read at `fetchedAt`) has reset since: the reading describes a window that's gone. */
function resetSinceRead(data: ClaudeData | undefined, fetchedAt: number | undefined, now: number): boolean {
	return fetchedAt !== undefined && claudeResets(data).some((t) => t > fetchedAt && t <= now);
}

/**
 * Whether a Claude login's reading is due: its own `nextFetchAt` has come, or its last fetch
 * succeeded and a window of that reading has reset since. A failed fetch (`error`) waits out its
 * retry; a skipped one (needs sign-in) is never due here.
 */
export function claudeReadingDue(r: { data?: ClaudeData; fetchedAt?: number; nextFetchAt: number; error?: string; skipped?: "auth" }, now: number): boolean {
	if (r.skipped) return false;
	if (now >= r.nextFetchAt) return true;
	return !r.error && resetSinceRead(r.data, r.fetchedAt, now);
}

/** `default`'s reading in the cache, in the shape claudeReadingDue reads. */
function ownReading(c: CacheFile): { data?: ClaudeData; fetchedAt?: number; nextFetchAt: number; error?: string } {
	return {
		...(c.claude ? { data: c.claude } : {}),
		fetchedAt: c.claudeFetchedAt ?? c.fetchedAt,
		nextFetchAt: c.claudeNextFetchAt ?? 0,
		...(c.errors.claude ? { error: c.errors.claude } : {}),
	};
}

/**
 * Whether the cache must be fetched now for a Claude login (readCache): a login in `ids` (held
 * here) with no `claudeAccounts` entry, or a held login's — or `default`'s — last good reading
 * with a window reset since it was read. A login's own retry never brings the whole cache
 * forward, and a login that needs sign-in (`skip`) is never fetched, so it never makes it due.
 */
export function claudeReadingsDue(c: CacheFile, ids: readonly string[], now: number, skip: (id: string) => boolean = () => false): boolean {
	if (c.claudeAccounts && ids.some((id) => !c.claudeAccounts![id])) return true;
	const resetDue = (r: { data?: ClaudeData; fetchedAt?: number; error?: string; skipped?: "auth" }) => !r.skipped && !r.error && resetSinceRead(r.data, r.fetchedAt, now);
	if (ids.some((id) => !skip(id) && c.claudeAccounts?.[id] && resetDue(c.claudeAccounts[id]!))) return true;
	return !skip(DEFAULT_LOGIN_ID) && resetDue(ownReading(c));
}

/** The earliest Claude window reset still ahead of `now` in the cache (`default` or a login), or undefined. */
export function nextClaudeReset(c: CacheFile, now: number): number | undefined {
	const all = [c.claude, ...Object.values(c.claudeAccounts ?? {}).map((a) => a.data)].flatMap(claudeResets).filter((t) => t > now);
	return all.length ? Math.min(...all) : undefined;
}

/** A failed Claude fetch's retry: longer when the usage endpoint answered HTTP 429. */
function claudeRetryMs(error: string): number {
	return /\bHTTP 429\b/.test(error) ? RATE_LIMITED_RETRY_MS : FAILURE_RETRY_MS;
}

export async function writeCache(data: CacheFile): Promise<void> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	const tmp = `${CACHE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify(data), "utf8");
		await fs.rename(tmp, CACHE_FILE);
	} catch (err) {
		await fs.unlink(tmp).catch(() => {});
		throw err;
	}
}

function pidAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

/** Returns a release function if the lock was acquired, otherwise undefined. */
export async function acquireLock(): Promise<(() => Promise<void>) | undefined> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
	const content = JSON.stringify({ pid: process.pid, ts: Date.now(), token });

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fh = await fs.open(LOCK_FILE, "wx");
			try {
				await fh.writeFile(content, "utf8");
			} finally {
				await fh.close();
			}
			return async () => {
				// Only remove the lock if it is still ours.
				try {
					const current = await fs.readFile(LOCK_FILE, "utf8");
					if (current === content) await fs.unlink(LOCK_FILE);
				} catch {
					// already gone
				}
			};
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
		}

		if (attempt > 0 || !(await breakStaleLock())) return undefined;
	}
	return undefined;
}

/** Removes the lock if abandoned. Returns true if it was removed. */
async function breakStaleLock(): Promise<boolean> {
	let raw: string;
	let mtimeMs: number;
	try {
		raw = await fs.readFile(LOCK_FILE, "utf8");
		mtimeMs = (await fs.stat(LOCK_FILE)).mtimeMs;
	} catch (err: any) {
		return err?.code === "ENOENT"; // vanished meanwhile -> retry
	}

	let info: any;
	try {
		info = JSON.parse(raw);
	} catch {
		info = undefined; // half-written or garbage: rely on mtime only
	}
	const ts = typeof info?.ts === "number" ? info.ts : mtimeMs;
	const abandoned = Date.now() - ts > LOCK_STALE_MS || (info && !pidAlive(info.pid));
	if (!abandoned) return false;

	// Move it aside atomically so only one process wins, then make sure we
	// moved the stale lock and not a fresh one created in between.
	const aside = `${LOCK_FILE}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		await fs.rename(LOCK_FILE, aside);
	} catch {
		return false;
	}
	try {
		const moved = await fs.readFile(aside, "utf8");
		if (moved !== raw) {
			// Someone else's fresh lock: put it back without clobbering.
			await fs.link(aside, LOCK_FILE).catch(() => {});
			return false;
		}
		return true;
	} finally {
		await fs.unlink(aside).catch(() => {});
	}
}

/** How `fetchAll` reaches Claude's logins; tests pass their own. */
export interface ClaudeFetchOptions {
	/** This host's logins (default: the real agent dir's). */
	logins?: Pick<ClaudeLogins, "order" | "dirOf" | "readinessOf">;
	/** One login's reading, from its directory (default: fetchClaude). */
	fetchLogin?: (dir: string) => Promise<ClaudeData>;
	now?: () => number;
}

/** The added logins this host would fetch (its order, `default` left out), or [] when the registry can't say. */
export function claudeLoginIds(logins: Pick<ClaudeLogins, "order"> = new ClaudeLogins()): string[] {
	try {
		return logins.order().filter((id) => id !== DEFAULT_LOGIN_ID);
	} catch {
		return [];
	}
}

/**
 * The login a session that recorded none yet will start on: the first ready one in this device's
 * order (what the footer reads before the first Claude turn), or undefined when the registry can't
 * say — the footer then reads Claude Code's own login, as before.
 */
export function firstReadyLogin(logins: Pick<ClaudeLogins, "selectId"> = new ClaudeLogins()): string | undefined {
	try {
		return logins.selectId();
	} catch {
		return undefined;
	}
}

/** Whether this host marked a login as needing sign-in: such a login is never fetched. */
function needsSignIn(logins: Pick<ClaudeLogins, "readinessOf">, id: string): boolean {
	try {
		return logins.readinessOf(id).state === "auth";
	} catch {
		return false;
	}
}

/**
 * Every added login's reading, starting from `prev` (the cache's last `claudeAccounts`). A login is
 * fetched when its own `nextFetchAt` is due, or with `force`; never while this host marks it as
 * needing sign-in (it keeps its last reading, `skipped: "auth"`). A failed fetch keeps the last
 * reading, says why, and retries after FAILURE_RETRY_MS (RATE_LIMITED_RETRY_MS after an HTTP 429).
 * A window that reset since a good reading makes the login due early. Logins no longer on this
 * host drop out.
 * Undefined when this host has no added login.
 */
export async function fetchClaudeAccounts(prev: CacheFile["claudeAccounts"], force: boolean, options: ClaudeFetchOptions = {}): Promise<CacheFile["claudeAccounts"]> {
	const logins = options.logins ?? new ClaudeLogins();
	const fetchLogin = options.fetchLogin ?? ((dir: string) => fetchClaude(dir));
	const now = options.now ?? Date.now;
	const ids = claudeLoginIds(logins);
	if (!ids.length) return undefined;
	const entries = await Promise.all(
		ids.map(async (id): Promise<[string, ClaudeAccountUsage]> => {
			const last = prev?.[id];
			const kept = { ...(last?.data ? { data: last.data } : {}), ...(last?.fetchedAt !== undefined ? { fetchedAt: last.fetchedAt } : {}) };
			if (needsSignIn(logins, id)) return [id, { ...kept, nextFetchAt: now() + FRESH_MS, skipped: "auth" }];
			if (!force && last && !last.skipped && !claudeReadingDue(last, now())) return [id, last];
			try {
				const data = await fetchLogin(logins.dirOf(id));
				const at = now();
				return [id, { data, fetchedAt: at, nextFetchAt: at + FRESH_MS }];
			} catch (err) {
				const error = errMessage(err);
				return [id, { ...kept, nextFetchAt: now() + claudeRetryMs(error), error }];
			}
		}),
	);
	return Object.fromEntries(entries);
}

export async function fetchAll(prev: CacheFile | undefined, force = false, options: ClaudeFetchOptions = {}): Promise<CacheFile> {
	const logins = options.logins ?? new ClaudeLogins();
	const clock = options.now ?? Date.now;
	// Claude Code's own login is skipped like any other while this host marks it as needing
	// sign-in, and keeps its own cadence like any other: not due, it keeps its reading and error.
	const ownSkipped = needsSignIn(logins, DEFAULT_LOGIN_ID);
	const ownDue = !ownSkipped && (force || !prev || claudeReadingDue(ownReading(prev), clock()));
	const claudeDefault = ownDue ? (options.fetchLogin ?? ((dir: string) => fetchClaude(dir)))(logins.dirOf(DEFAULT_LOGIN_ID)) : Promise.resolve(prev?.claude);
	const [o, x, c, z, d, a] = await Promise.allSettled([
		fetchOllama(),
		fetchOpenAi(),
		claudeDefault,
		fetchZai(),
		fetchDeepSeek(),
		fetchClaudeAccounts(prev?.claudeAccounts, force, { ...options, logins }),
	]);
	const now = clock();
	const errors: CacheFile["errors"] = {};
	let ollama = prev?.ollama;
	let openai = prev?.openai;
	let claude = prev?.claude;
	let zai = prev?.zai;
	let deepseek = prev?.deepseek;
	if (o.status === "fulfilled") ollama = o.value;
	else errors.ollama = errMessage(o.reason);
	if (x.status === "fulfilled") openai = x.value;
	else errors.openai = errMessage(x.reason);
	let claudeFetchedAt = prev ? (prev.claudeFetchedAt ?? prev.fetchedAt) : undefined;
	let claudeNextFetchAt = prev?.claudeNextFetchAt;
	if (!ownDue) {
		// Not fetched: a skipped login is checked again at the ordinary cadence; one waiting out its
		// retry keeps its error, so readers still see why its reading is old.
		if (ownSkipped) claudeNextFetchAt = now + FRESH_MS;
		else if (prev?.errors.claude) errors.claude = prev.errors.claude;
	} else if (c.status === "fulfilled") {
		claude = c.value;
		claudeFetchedAt = now;
		claudeNextFetchAt = now + FRESH_MS;
	} else {
		errors.claude = errMessage(c.reason);
		claudeNextFetchAt = now + claudeRetryMs(errors.claude);
	}
	// Each login carries its own error and retry: one failing login never shortens everyone's refresh.
	const claudeAccounts = a.status === "fulfilled" ? a.value : prev?.claudeAccounts;
	if (z.status === "fulfilled") zai = z.value;
	else errors.zai = errMessage(z.reason);
	if (d.status === "fulfilled") deepseek = d.value;
	else errors.deepseek = errMessage(d.reason);

	// Claude logins, `default` included, carry their own retry: one failing never shortens everyone's refresh.
	const failed = Boolean(errors.ollama || errors.openai || errors.zai || errors.deepseek);
	return {
		schemaVersion: CACHE_SCHEMA,
		fetchedAt: now,
		nextFetchAt: now + (failed ? FAILURE_RETRY_MS : FRESH_MS),
		ollama,
		openai,
		claude,
		...(claudeFetchedAt !== undefined ? { claudeFetchedAt } : {}),
		...(claudeNextFetchAt !== undefined ? { claudeNextFetchAt } : {}),
		...(claudeAccounts ? { claudeAccounts } : {}),
		zai,
		deepseek,
		errors,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Refresh: one fetch per machine per window, whoever asks

export interface RefreshHooks {
	/** The cache the caller should show now: after the first read, on adopting another holder's result, after our own fetch. */
	onCache?(cache: CacheFile): void;
	/** The points at which the extension re-renders. */
	onShow?(): void;
	/** True abandons the wait for another holder (the extension's session went away). */
	cancelled?(): boolean;
}

export interface RefreshResult {
	/** The cache that is current after the call: fresh from the file, adopted from another process, or just fetched. */
	cache: CacheFile;
	/** True when this call fetched and wrote the cache itself. */
	fetched: boolean;
	/** Per-provider failures of the fetch this call made (`{}` when it fetched nothing, or all sources succeeded). */
	errors: Partial<Record<ProviderId, string>>;
}

/**
 * Bring the shared cache up to date, fetching only if it is stale and we win the lock. With
 * `force`, bypass freshness but still take the lock. If another process holds the lock, don't
 * fetch: wait (file reads only) up to FORCE_WAIT_MS for it to publish a newer cache and adopt
 * that. `prev` is the caller's last known cache, the fallback when the file is unreadable.
 *
 * Returns undefined only without `force`, when the holder published nothing in time (try again
 * on the next tick). With `force` that is an error instead.
 */
export async function refreshCache(force: boolean, prev: CacheFile | undefined, hooks: RefreshHooks = {}): Promise<RefreshResult | undefined> {
	const cached = await readCache();
	if (cached) hooks.onCache?.(cached);
	if (!force && cached && Date.now() < cached.nextFetchAt) {
		hooks.onShow?.();
		return { cache: cached, fetched: false, errors: {} };
	}

	const release = await acquireLock();
	if (!release) {
		hooks.onShow?.();
		const since = cached?.fetchedAt ?? 0;
		const deadline = Date.now() + FORCE_WAIT_MS;
		while (Date.now() < deadline && !hooks.cancelled?.()) {
			await sleep(250);
			const after = await readCache();
			if (after && after.fetchedAt > since) {
				hooks.onCache?.(after);
				hooks.onShow?.();
				return { cache: after, fetched: false, errors: {} };
			}
		}
		if (force) throw new Error("another session holds the refresh lock; showing cached data");
		return undefined;
	}

	try {
		// Double-check: another process may have refreshed before we got the lock.
		const latest = (await readCache()) ?? cached ?? prev;
		if (!force && latest && Date.now() < latest.nextFetchAt) {
			hooks.onCache?.(latest);
			return { cache: latest, fetched: false, errors: {} };
		}
		const next = await fetchAll(latest, force);
		hooks.onCache?.(next);
		await writeCache(next);
		const errors: RefreshResult["errors"] = {};
		for (const id of PROVIDERS) if (next.errors[id]) errors[id] = next.errors[id];
		return { cache: next, fetched: true, errors };
	} finally {
		await release();
		hooks.onShow?.();
	}
}

/** `errors` as one line in provider order: "ollama: timeout; claude: HTTP 500". Undefined when empty. */
export function describeErrors(errors: RefreshResult["errors"]): string | undefined {
	const parts = PROVIDERS.filter((id) => errors[id]).map((id) => `${id}: ${errors[id]}`);
	return parts.length ? parts.join("; ") : undefined;
}

/**
 * Refresh now, whatever the cache's age, the way the extension's /usage-refresh does: take the
 * lock (breaking an abandoned one), fetch every provider, write the cache, release. When another
 * process is mid-fetch, adopt its result instead (waiting up to FORCE_WAIT_MS). A provider
 * failing does not reject: it is in `errors`, and the cache keeps that provider's last data.
 * Rejects when the lock holder publishes nothing in time, or the cache can't be written.
 */
export async function forceRefresh(): Promise<RefreshResult> {
	const result = await refreshCache(true, undefined);
	if (!result) throw new Error("usage refresh produced no result"); // unreachable: force never yields undefined
	return result;
}
