/**
 * Pure helpers for coordinated teams (team-defaults.ts): successor naming, handover-note paths,
 * the roster's context column, the provider-usage lines a monitor reads, and the member
 * wake_nudge bounds. No process, UI or pi-runtime dependency; index.ts owns every effect.
 */
import * as path from "node:path";

// ── Successors and handover notes ──────────────────────────────────────────

/**
 * The successor role of `role`: an existing `-N` suffix is stripped, then `<base>-<n+1>`, the
 * first number not taken (case-insensitive) wins. builder → builder-2 → builder-3.
 */
export function successorRole(role: string, taken: Iterable<string>, maxChars = 64): string {
	const used = new Set([...taken].map((r) => r.trim().toLowerCase()));
	const match = /^(.*\S)-(\d+)$/.exec(role.trim());
	const base = match ? match[1] : role.trim();
	let n = match ? Number(match[2]) + 1 : 2;
	for (;;) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, Math.max(1, maxChars - suffix.length))}${suffix}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
		n++;
	}
}

/** A role as one safe file-name segment: anything outside [A-Za-z0-9._-] becomes "-". */
export function roleSlug(role: string): string {
	const slug = role.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
	return slug || "member";
}
/**
 * The parent session's id as one safe directory name. Team IDs restart at team_01 in every
 * parent session, so notes are keyed by the session as well; a session without an id (or one
 * that sanitises to nothing) uses `fallback`, which must be unique to this process.
 */
export function sessionDirKey(sessionId: string | undefined, fallback: string): string {
	const key = (sessionId ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 128);
	return key || fallback;
}
/** `<agentDir>/sova/teams/<session key>/<team_id>/handoffs`: one directory per parent session and team. */
export const handoffDir = (agentDir: string, sessionKey: string, teamId: string): string => path.join(agentDir, "sova", "teams", sessionKey, teamId, "handoffs");
export const handoffPath = (agentDir: string, sessionKey: string, teamId: string, role: string): string => path.join(handoffDir(agentDir, sessionKey, teamId), `${roleSlug(role)}.md`);

// ── Context column ─────────────────────────────────────────────────────────

/** The Claude Code window rule, claude-code's own (builtins-only, like the transcript adapter this extension already imports). */
export { claudeContextWindow } from "../claude-code/context-window.ts";

const compact = (n: number): string =>
	n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

/** Whole percent, rounded down; undefined when either side is unknown. */
export function contextPct(tokens: number | undefined, window: number | undefined): number | undefined {
	if (!tokens || tokens <= 0 || !window || window <= 0) return undefined;
	return Math.floor((tokens / window) * 100);
}

/** A wrap-up event's detail: `context 78% of 200k`; the tokens alone without a window; `context unknown` before the first reply. */
export function contextShare(tokens: number | undefined, window: number | undefined): string {
	const pct = contextPct(tokens, window);
	if (pct !== undefined) return `context ${pct}% of ${compact(window!)}`;
	return tokens && tokens > 0 ? `context ${compact(tokens)} tokens (window unknown)` : "context unknown";
}

/** `context 123k/200k (61%)`; `context —` before the first reply; `context 64k/?` without a window. */
export function contextText(tokens: number | undefined, window: number | undefined): string {
	if (!tokens || tokens <= 0) return "context —";
	if (!window || window <= 0) return `context ${compact(tokens)}/?`;
	return `context ${compact(tokens)}/${compact(window)} (${contextPct(tokens, window)}%)`;
}

// ── Provider usage (usage-status.json, written by the usage-status extension) ──

export type UsageProvider = "claude" | "openai" | "zai" | "ollama" | "deepseek";
interface Window { pct?: unknown; resetsAt?: unknown; label?: unknown }
interface ClaudeLike { state?: unknown; fiveHour?: Window; sevenDay?: Window; limits?: unknown }
/** The part of usage-status's CacheFile a monitor reads; anything else in it is ignored. */
export interface UsageCacheLike {
	fetchedAt?: unknown;
	claude?: ClaudeLike;
	/** Every other Claude login on this host, by login id; `skipped: "auth"` needs sign-in. */
	claudeAccounts?: Record<string, { data?: ClaudeLike; skipped?: unknown } | undefined>;
	openai?: { state?: unknown; windows?: unknown };
	zai?: { state?: unknown; fiveHour?: Window };
	ollama?: { state?: unknown; usedPct?: unknown };
	deepseek?: { state?: unknown };
}
/**
 * `reset`: the window's resetsAt has passed, so the cached pct predates the reset and says nothing now.
 * `login`: the Claude login it belongs to (`default` = Claude Code's own). `weekly`: a `7d…` window,
 * which blocks only at 100%.
 */
export interface UsageWindow { provider: UsageProvider; label: string; pct: number; resetsAt?: string; reset?: true; login?: string; weekly?: true }

/** The usage-status provider a worker spends from, or undefined when none is tracked. */
export function usageProviderOf(backend: string, model: string | undefined): UsageProvider | undefined {
	if (backend === "claude-code") return "claude";
	if (backend !== "pi" || !model) return undefined;
	const provider = model.slice(0, Math.max(0, model.indexOf("/"))).toLowerCase();
	if (provider === "anthropic" || provider.startsWith("claude")) return "claude";
	if (provider.startsWith("openai")) return "openai";
	if (provider.startsWith("zai")) return "zai";
	if (provider.startsWith("ollama")) return "ollama";
	if (provider.startsWith("deepseek")) return "deepseek";
	return undefined;
}

const pctOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const resetOf = (value: unknown): string | undefined => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);
function windowAt(now: number, provider: UsageProvider, label: string, w: Window | undefined): UsageWindow[] {
	const pct = pctOf(w?.pct);
	if (pct === undefined) return [];
	const resetsAt = resetOf(w?.resetsAt);
	return [{ provider, label, pct, ...(resetsAt ? { resetsAt } : {}), ...(resetsAt && Date.parse(resetsAt) <= now ? { reset: true as const } : {}), ...(label.startsWith("7d") ? { weekly: true as const } : {}) }];
}
function claudeWindows(now: number, login: string, c: ClaudeLike | undefined): UsageWindow[] {
	if (c?.state !== "ok") return [];
	const windows = Array.isArray(c.limits) && c.limits.length
		? c.limits.flatMap((l: Window & { scope?: unknown }) =>
			windowAt(now, "claude", `${typeof l?.label === "string" ? l.label : "limit"}${typeof l?.scope === "string" ? ` ${l.scope}` : ""}`, l))
		: [...windowAt(now, "claude", "5h", c.fiveHour), ...windowAt(now, "claude", "7d", c.sevenDay)];
	return windows.map((w) => ({ ...w, login }));
}

/**
 * Every window the cache reports for `provider` (deepseek is a balance: none). A window whose
 * resetsAt is not after `now` is marked `reset`: a stale cache must never keep a team paused.
 */
export function usageWindows(cache: UsageCacheLike | undefined, provider: UsageProvider, now = Date.now()): UsageWindow[] {
	if (!cache) return [];
	const windowOf = (p: UsageProvider, label: string, w: Window | undefined) => windowAt(now, p, label, w);
	switch (provider) {
		case "claude": {
			// Claude Code's own login, then each added login with a reading that is not waiting on sign-in.
			const accounts = cache.claudeAccounts && typeof cache.claudeAccounts === "object" ? Object.entries(cache.claudeAccounts) : [];
			return [
				...claudeWindows(now, "default", cache.claude),
				...accounts.flatMap(([id, a]) => (a && a.skipped !== "auth" ? claudeWindows(now, id, a.data) : [])),
			];
		}
		case "openai": {
			const o = cache.openai;
			if (o?.state !== "ok" || !Array.isArray(o.windows)) return [];
			return o.windows.flatMap((w: Window) => windowOf("openai", typeof w?.label === "string" ? w.label : "window", w));
		}
		case "zai": {
			const z = cache.zai;
			return z?.state === "ok" ? windowOf("zai", typeof z.fiveHour?.label === "string" ? z.fiveHour.label : "5h", z.fiveHour) : [];
		}
		case "ollama": {
			const o = cache.ollama;
			return o?.state === "ok" ? windowOf("ollama", "usage", { pct: o.usedPct }) : [];
		}
		default:
			return [];
	}
}

/** Whether `w` puts its login out: a live window with a reset time, weekly at 100%, any other at `pausePct`. */
const blocks = (w: UsageWindow, pausePct: number): boolean =>
	!w.reset && !!w.resetsAt && w.pct >= (w.weekly ? 100 : pausePct);
/** `windows` by login (one group for a provider without logins), each with the windows that block it. */
function byLogin(windows: readonly UsageWindow[], pausePct: number): Map<string, UsageWindow[]> {
	const logins = new Map<string, UsageWindow[]>();
	for (const w of windows) {
		const blocking = logins.get(w.login ?? "") ?? [];
		logins.set(w.login ?? "", blocking);
		if (blocks(w, pausePct)) blocking.push(w);
	}
	return logins;
}
const latestReset = (ws: readonly UsageWindow[]): number => Math.max(...ws.map((w) => Date.parse(w.resetsAt!)));

/**
 * The windows that block `provider` now, or none while it can still be used: a provider is blocked
 * only when every login has a blocking window. Returns the blocking windows of the login that frees
 * soonest (the earliest latest-reset), which is when the provider can be used again.
 */
export function blockingWindows(cache: UsageCacheLike | undefined, provider: UsageProvider, pausePct: number, now = Date.now()): UsageWindow[] {
	return blockingOf(byLogin(usageWindows(cache, provider, now), pausePct));
}
function blockingOf(logins: Map<string, UsageWindow[]>): UsageWindow[] {
	const blocked = [...logins.values()];
	if (!blocked.length || blocked.some((b) => !b.length)) return [];
	return blocked.reduce((a, b) => (latestReset(b) < latestReset(a) ? b : a));
}

/**
 * The roster's usage section for the providers a team uses: one line per window (per login for
 * Claude), the cache's age, and which windows block their provider at `pausePct`.
 */
export function usageLines(cache: UsageCacheLike | undefined, providers: readonly UsageProvider[], pausePct: number | undefined, now = Date.now()): string[] {
	const wanted = [...new Set(providers)];
	if (!wanted.length) return ["  Provider usage: no tracked provider among this team's models."];
	if (!cache) return ["  Provider usage: unavailable (no usage-status cache yet)."];
	const age = typeof cache.fetchedAt === "number" ? ` (cache fetched ${Math.max(0, Math.round((now - cache.fetchedAt) / 60_000))} min ago)` : "";
	const lines = [`  Provider usage${age}:`];
	for (const provider of wanted) {
		const windows = usageWindows(cache, provider, now);
		if (!windows.length) { lines.push(`    ${provider}: no window data`); continue; }
		const logins = pausePct !== undefined ? byLogin(windows, pausePct) : new Map<string, UsageWindow[]>();
		const blocking = blockingOf(logins);
		const named = new Set(windows.map((w) => w.login)).size > 1;
		for (const w of windows) {
			const name = `${provider} ${w.label}${named ? ` [${w.login}]` : ""}`;
			if (w.reset) {
				lines.push(`    ${name}: reset at ${w.resetsAt} — current usage unknown (the cached ${Math.round(w.pct)}% predates the reset); not a reason to pause`);
				continue;
			}
			const weekly = w.weekly ? " (weekly, informational below 100%)" : "";
			const over = blocking.includes(w) ? ` — AT/OVER the ${w.weekly ? 100 : pausePct}% pause threshold` : "";
			lines.push(`    ${name}: ${Math.round(w.pct)}%${w.resetsAt ? `, resets ${w.resetsAt}` : ""}${weekly}${over}`);
		}
		const free = [...logins.values()].filter((b) => !b.length).length;
		if (logins.size > 1 && free && free < logins.size)
			lines.push(`    ${provider}: headroom on ${free} of ${logins.size} logins — not a reason to pause`);
	}
	return lines;
}

// ── Member wake_nudge (the wake-nudge extension's semantics, held by the parent) ──

export const NUDGE_MIN_DELAY_MS = 10_000;
export const NUDGE_MAX_DELAY_MS = 24 * 3600_000;
export const NUDGE_MAX_ACTIVE = 5;
/** Consecutive fires while no other member is working; a working teammate resets the count. */
export const NUDGE_MAX_IDLE_FIRES = 30;
export const NUDGE_PAST_TOLERANCE_MS = 60_000;

export function fmtDur(ms: number): string {
	let s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	if (h) return m ? `${h}h${m}m` : `${h}h`;
	if (m) return s ? `${m}m${s}s` : `${m}m`;
	return `${s}s`;
}

/** "30s", "5m", "1h30m" → milliseconds; anything else throws (as ../wake-nudge.ts parses it). */
export function parseDelay(text: string): number {
	const t = text.trim().toLowerCase();
	let total = 0;
	let consumed = "";
	for (const match of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/g)) {
		total += Number(match[1]) * { h: 3600_000, m: 60_000, s: 1000 }[match[2] as "h" | "m" | "s"];
		consumed += match[0];
	}
	if (!consumed || consumed.replace(/\s/g, "") !== t.replace(/\s/g, "")) throw new Error(`Invalid delay "${text}"; use e.g. 30s, 5m, 1h30m.`);
	return total;
}

/**
 * When a schedule request fires, or why it is refused: delay XOR at; at least 10 s ahead (an `at`
 * up to 60 s in the past is clamped to 10 s from now), at most 24 h ahead.
 */
export function nudgeFireAt(request: { delay?: string; at?: string }, now: number): number {
	if (request.delay && request.at) throw new Error("Give delay or at, not both.");
	let fireAt: number;
	if (request.delay) {
		fireAt = now + parseDelay(request.delay);
		if (fireAt - now < NUDGE_MIN_DELAY_MS) throw new Error("Delay must be at least 10s.");
	} else if (request.at) {
		fireAt = Date.parse(request.at);
		if (Number.isNaN(fireAt)) throw new Error(`Invalid at "${request.at}"; use ISO-8601.`);
		if (fireAt < now - NUDGE_PAST_TOLERANCE_MS) throw new Error(`at "${request.at}" is in the past.`);
		if (fireAt - now < NUDGE_MIN_DELAY_MS) fireAt = now + NUDGE_MIN_DELAY_MS;
	} else {
		throw new Error("schedule needs delay or at.");
	}
	if (fireAt - now > NUDGE_MAX_DELAY_MS) throw new Error("Delay must be at most 24h.");
	return fireAt;
}
