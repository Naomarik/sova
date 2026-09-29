// Presentation rules for the insights surfaces (docs/insights-research.md "## UX"): labels,
// status words and chips, derived from the /api/insights/* payloads. No fetching here.

import type { AgentsInsight, TeamEvent, TeamInfo, TeamMember, UsageAuth, UsageBalance, UsageClaudeLogin, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import type { Tone } from "../components/ui";
import { accountGroups, type LoginFacts, loginName } from "./claude-login-groups";
import { clockTime, duration, relativeTime, shortDate, stampTime, thousands } from "./format";
import { isHostSession } from "./workers";

export const PROVIDER_NAME: Record<UsageProvider["id"], string> = {
  claude: "Claude",
  openai: "OpenAI",
  ollama: "Ollama Cloud",
  zai: "Z.ai",
  deepseek: "DeepSeek",
};

const WINDOW_LABEL: Record<string, string> = {
  "7d opus": "7-day Opus",
  month: "Monthly",
  pri: "Primary",
  plan: "Plan",
  mcp: "MCP uses",
};

const UNIT: Record<string, { word: string; minutes: number }> = {
  m: { word: "minute", minutes: 1 },
  h: { word: "hour", minutes: 60 },
  d: { word: "day", minutes: 1440 },
  w: { word: "week", minutes: 10_080 },
};

/** A model-scoped window ("7d scoped", scope "Fable") keeps its length; the scope names it. */
const SCOPED = / scoped$/;

/**
 * "5h" → 5-hour, "1d" → 1-day, "1w" → 1-week, "45m" → 45-minute; "7d scoped" with scope "Fable"
 * → 7-day Fable; named windows from the map.
 */
export function windowLabel(w: UsageWindow): string {
  const named = WINDOW_LABEL[w.label];
  if (named) return named;
  const base = w.label.replace(SCOPED, "");
  const m = /^(\d+)([mhdw])$/.exec(base);
  const length = m ? `${m[1]}-${UNIT[m[2]!]!.word}` : base;
  return base === w.label ? length : `${length} ${w.scope ?? "scoped"}`;
}

/** Window length in minutes when the label says it ("5h", "7d", "7d scoped", month); null when unknown ("pri", "plan"). */
function windowMinutes(label: string): number | null {
  if (label === "month") return 30 * 1440;
  const m = /^(\d+)([mhdw])$/.exec(label.replace(SCOPED, ""));
  return m ? Number(m[1]) * UNIT[m[2]!]!.minutes : null;
}

/** Short windows (hours, minutes) reset on their own; day-plus windows and quotas wait for the reset. */
const isShortWindow = (w: UsageWindow) => /^\d+[mh]$/.test(w.label);


export const pct = (w: UsageWindow) => Math.round(w.pct);

/** A credit balance as money: "$4.29". An unusable currency code falls back to "XYZ 4.29". */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * The same balance for the sidebar foot, in whole currency units: "$4" for 4.29, "$5" for 4.99.
 * The foot is a shorthand; the row's tooltip keeps the cents (money()). Both fraction-digit
 * options are required — with only `maximumFractionDigits: 0`, currency style throws.
 */
export function moneyCompact(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

export function meterTone(w: UsageWindow): "warn" | "error" | null {
  if (w.pct >= 100) return "error";
  if (w.pct >= 80) return "warn";
  return null;
}

/** Whether a window's reset has already passed at `now` (its reading describes a window that's gone). */
const resetPassed = (w: UsageWindow, now: number) => resetWhen(w.resetsAt, now)?.past === true;

/**
 * Card head chip for a provider: the worst window decides. Null when no limit applies.
 * A credit provider (DeepSeek) has a balance and no windows, so only the funding rule can fire.
 * With `now`, a window whose reset has passed decides nothing (its meter is a ghost).
 */
export function providerChip(p: UsageProvider, now?: number): { tone?: Tone; text: string } | null {
  if (p.balance && !p.balance.available) return { tone: "error", text: "Out of credit" };
  const windows = now === undefined ? p.windows : p.windows.filter((w) => !resetPassed(w, now));
  const full = windows.filter((w) => w.pct >= 100);
  if (full.some((w) => !isShortWindow(w))) return { tone: "error", text: "Quota used" };
  if (full.length > 0) return { tone: "warn", text: "Rate-limited" };
  if (windows.some((w) => w.pct >= 80)) return { tone: "warn", text: "Near limit" };
  return null;
}

const signIn = (id: UsageProvider["id"]) => (id === "openai" ? "pi /login" : "claude /login");
const keyWord = (id: UsageProvider["id"]) => (id === "zai" ? "API key" : "key");

/** A note or caption: `lead`, then `code` in `<code>`, then `rest`. */
export type UsageLine = { lead?: string; code?: string; rest: string };

/** Who renews a timed-out access token by running, per credential source. */
const RENEWER: Record<NonNullable<UsageAuth["source"]>, string> = {
  "claude-cli": "Claude Code runs",
  pi: "pi uses OpenAI",
  "codex-cli": "the Codex CLI runs",
};

const refreshDead = (a: UsageAuth, now: number) => (a.refreshExpiresAt !== undefined ? a.refreshExpiresAt <= now : a.refreshExpired === true);

/**
 * The access token passed its own expiry and nothing says the refresh token has: the CLI that owns
 * it renews it the next time it runs. The expired sentence for exactly that case, else null (a
 * token refused before its expiry was revoked, and only a new sign-in helps).
 */
function timedOut(p: UsageProvider, now: number): UsageLine | null {
  const a = p.auth;
  if (a?.kind !== "oauth" || !a.source || a.expiresAt === undefined || a.expiresAt > now || refreshDead(a, now)) return null;
  return { rest: `Sign-in token expired ${relativeTime(a.expiresAt, now)}. It renews the next time ${RENEWER[a.source]}; usage updates after that.` };
}

/** One caption replacing the meters when a provider has nothing to show. Null = render meters. */
export function providerProblem(p: UsageProvider, now = Date.now()): UsageLine | null {
  switch (p.state) {
    case "ok":
      return null;
    case "nologin":
      return { lead: "Not signed in. Run ", code: signIn(p.id), rest: " and it'll show at the next refresh." };
    case "expired":
      return timedOut(p, now) ?? { lead: "Sign-in expired. Run ", code: signIn(p.id), rest: " to renew it." };
    case "nokey":
      return { lead: `No ${PROVIDER_NAME[p.id]} ${keyWord(p.id)} in `, code: "~/.pi/agent/auth.json", rest: "." };
    case "badkey":
      return { lead: `${PROVIDER_NAME[p.id]} refused the ${keyWord(p.id)} in `, code: "~/.pi/agent/auth.json", rest: "." };
    case "na":
      return { rest: "This account doesn't report usage." };
    case "error":
      if (p.windows.length > 0) return null;
      return { rest: `Couldn't fetch usage: ${(p.error ?? "unknown error").replace(/\.$/, "")}. We'll try again at the next refresh.` };
  }
}

/**
 * The muted sign-in line at the foot of an OAuth card: when the access token renews by and when it
 * last did, or why it can't. Null for API keys, no sign-in data, or a card whose `expired` note
 * already says it.
 */
export function authCaption(p: UsageProvider, now: number): UsageLine | null {
  const a = p.auth;
  if (a?.kind !== "oauth" || p.state === "expired") return null;
  if (refreshDead(a, now)) return { lead: "Sign-in can't renew. Run ", code: signIn(p.id), rest: " to sign in again." };
  const late = timedOut(p, now);
  if (late) return late;
  const renewed = a.refreshedAt !== undefined ? `last renewed ${relativeTime(a.refreshedAt, now)}` : null;
  if (a.expiresAt !== undefined) return { rest: `Sign-in renews by ${stampTime(a.expiresAt, now)}${renewed ? ` · ${renewed}` : ""}` };
  return renewed ? { rest: `Sign-in ${renewed}` } : null;
}

/**
 * When a window resets, in the meter context's forms: "in 2h 17m" under 24h, else "Sep 25".
 * `past` when the reset already happened (the reading describes a window that's gone). Null
 * without a readable `resetsAt`: a reset is never estimated.
 */
export function resetWhen(resetsAt: string | undefined, now: number): { past: true } | { past: false; when: string } | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at)) return null;
  if (at <= now) return { past: true };
  const left = at - now;
  return { past: false, when: left < 86_400_000 ? `in ${duration(left)}` : shortDate(at, now) };
}

/**
 * A meter's reset line: "Resets in 2h 17m", "Resets Sep 25", or, past, "Reset at " + the clock
 * time (mono) + ". New reading at the next refresh.". Null when the window sends no reset.
 */
export function meterReset(w: UsageWindow, now: number): { lead: string; time?: string; rest?: string } | null {
  const r = resetWhen(w.resetsAt, now);
  if (!r) return null;
  if (r.past) return { lead: "Reset at ", time: clockTime(w.resetsAt!), rest: ". New reading at the next refresh." };
  return { lead: `Resets ${r.when}` };
}

/** MCP quota counts, when the source reports them: "12 of 1,000 uses". */
export function usesLine(w: UsageWindow): string | null {
  const { used, limit } = w;
  return w.label === "mcp" && used !== undefined && limit !== undefined ? `${thousands(used)} of ${thousands(limit)} uses` : null;
}

/** A balance's context: the non-zero parts of "Granted $x" and "Topped up $y"; null when both are 0. */
export function balanceBreakdown(b: UsageBalance): string | null {
  const parts: string[] = [];
  if (b.granted > 0) parts.push(`Granted ${money(b.granted, b.currency)}`);
  if (b.toppedUp > 0) parts.push(`Topped up ${money(b.toppedUp, b.currency)}`);
  return parts.length ? parts.join(" \u00b7 ") : null;
}

/** The card's plan subtitle, from OpenAI's `plan` or Z.ai's `level`: "plus" → "Plus plan". */
export function planLabel(p: UsageProvider): string | null {
  const raw = (p.plan ?? p.level)?.trim();
  if (!raw) return null;
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  return /plan$/i.test(name) ? name : `${name} plan`;
}

// ---- Claude logins (§app.insights/usage-cards): one card per account, its logins inside ----------

/** An account card's title (and a login's, for the foot's words): its email, else its label, else what `default` is. */
export function claudeLoginTitle(l: UsageClaudeLogin): string {
  return l.email ?? l.label ?? (l.id === "default" ? "Claude Code's own login" : l.id);
}

/** What the grouping and naming read of a Usage login. */
export const usageLoginFacts = (l: UsageClaudeLogin): LoginFacts => ({
  id: l.id,
  ...(l.label ? { label: l.label } : {}),
  ...(l.addedAt !== undefined ? { addedAt: l.addedAt } : {}),
  ...(l.accountUuid ? { account: l.accountUuid } : {}),
});

/** The Usage page's Claude cards: one per account, in the order its first login has. */
export function claudeAccounts(logins: UsageClaudeLogin[]): UsageClaudeLogin[][] {
  return accountGroups(logins, usageLoginFacts).map((g) => g.logins);
}

/** A login's name inside its account (§app.claude-logins/registry, Names). */
export function claudeLoginName(l: UsageClaudeLogin, account: readonly UsageClaudeLogin[]): string {
  return loginName(usageLoginFacts(l), account.map(usageLoginFacts));
}

/**
 * The account's one reading: the freshest among its logins that has one (they all read the same
 * quota), else the reading of the login in use, else of its first login. `login` is whose it is.
 */
export function accountReading(account: readonly UsageClaudeLogin[]): { usage: UsageProvider; login: UsageClaudeLogin } {
  const read = account.filter((l) => l.usage.windows.length > 0 || l.usage.balance);
  const best = read.reduce<UsageClaudeLogin | undefined>((a, l) => (!a || (l.fetchedAt ?? -1) > (a.fetchedAt ?? -1) ? l : a), undefined);
  const login = best ?? account.find((l) => l.inUse) ?? account[0]!;
  return { usage: login.usage, login };
}

/**
 * The account card's caption: "Claude · {plan}", then, for an account of one login, that login's
 * name when it says something the title doesn't (`default`, or a label).
 */
export function claudeAccountSubtitle(account: readonly UsageClaudeLogin[]): string {
  const only = account.length === 1 ? account[0]! : null;
  const name = only && (only.id === "default" || only.label) ? claudeLoginName(only, account) : null;
  const plan = account.find((l) => l.planLabel)?.planLabel;
  return ["Claude", plan, only && name !== claudeLoginTitle(only) ? name : null].filter(Boolean).join(" \u00b7 ");
}

/**
 * Over an account's list of logins: "2 logins in the pool" (its logins the pool has — never
 * `default`), else "2 logins on this device"; null for an account of one login outside the pool,
 * which lists none.
 */
export function claudeAccountLoginsCaption(account: readonly UsageClaudeLogin[]): string | null {
  const logins = (n: number) => `${n} login${n === 1 ? "" : "s"}`;
  const pooled = account.filter((l) => l.holder).length;
  if (pooled > 0) return `${logins(pooled)} in the pool`;
  return account.length > 1 ? `${logins(account.length)} on this device` : null;
}

/** Where a pool login is, in Settings → Accounts' words (claude-pool.ts holderChip); null for one no pool describes. */
export function claudeLoginHolder(l: UsageClaudeLogin): { tone: Tone | "accent"; text: string } | null {
  const h = l.holder;
  if (!h) return null;
  if (h.stuck) return { tone: "warn", text: `Stuck on ${h.label}` };
  if (h.free) return { tone: "success", text: "Free" };
  if (h.self) return { tone: "accent", text: "This device" };
  return { tone: "info", text: h.label };
}

const LIMIT_WINDOWS: Record<string, string> = { five_hour: "5h limit", seven_day: "Weekly limit", seven_day_opus: "Weekly Opus limit", seven_day_sonnet: "Weekly Sonnet limit" };

/** The window of `reading` at 100% whose reset is still ahead (the one resetting last), or null. */
function fullWindow(reading: UsageProvider | undefined, now: number): { w: UsageWindow; until: number } | null {
  let out: { w: UsageWindow; until: number } | null = null;
  for (const w of reading?.windows ?? []) {
    const until = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (w.pct >= 100 && until > now && (!out || until > out.until)) out = { w, until };
  }
  return out;
}

/**
 * The login's standing on this host, in Settings → Accounts' words. `reading` is its account's
 * reading: a login recorded as ready whose account has a window at 100%, reset still ahead, is
 * limited until then, like the card's head chip says — the host records a limit only once a spawn
 * runs into it, and the reading is the newer fact.
 */
export function claudeLoginStanding(l: UsageClaudeLogin, now: number, reading: UsageProvider = l.usage): { tone?: Tone; text: string; title?: string } {
  if (!l.signedIn && l.id !== "default") return { tone: "error", text: "Not signed in" };
  const s = l.standing;
  if (s.state === "limited") return { tone: "warn", text: `Limited until ${stampTime(s.until, now)}`, title: LIMIT_WINDOWS[s.window ?? ""] ?? "Usage limit" };
  if (s.state === "auth") return { tone: "error", text: "Sign in again", ...(s.message ? { title: s.message } : {}) };
  const full = fullWindow(reading, now);
  if (full) return { tone: "warn", text: `Limited until ${stampTime(full.until, now)}`, title: `Its ${windowLabel(full.w)} window is used up` };
  if (!l.enabled) return { text: "Off", title: "Never chosen automatically (Settings → Accounts)" };
  return { tone: "success", text: "Ready" };
}

/** Why an account card has no meters, when that is about its login rather than the provider's answer. */
export function claudeLoginNote(l: UsageClaudeLogin): string | null {
  if (l.usage.windows.length > 0) return null;
  if (l.standing.state === "auth") return "Not fetched while this login needs signing in again. Its usage shows once Claude Code has signed it in.";
  if (l.id !== "default" && l.fetchedAt === undefined && l.usage.state === "error" && l.usage.error === "not read yet") {
    if (l.holder?.free) return "Not read while it is free. Its usage shows once a device borrows it.";
    if (l.holder && !l.holder.self) return `Not read yet. Its usage shows once ${l.holder.label} publishes a reading.`;
    return "Not read yet. Its usage shows at the next refresh.";
  }
  return null;
}

/** Claude's extra-usage meter, when it's switched on: a quota fill when there's a reading, else "On". */
export function extraUsageMeter(p: UsageProvider): { pct: number } | { on: true } | null {
  const x = p.extraUsage;
  if (!x?.enabled) return null;
  return x.pct === undefined ? { on: true } : { pct: x.pct };
}

/** A not-ok provider's sentence in the summary lead; null for `na` and for anything readable. */
function stateSentence(p: UsageProvider, name = PROVIDER_NAME[p.id]): string | null {
  switch (p.state) {
    case "nologin":
      return `${name} isn't signed in.`;
    case "expired":
      return `${name}'s sign-in expired.`;
    case "nokey":
      return `${name} needs an API key.`;
    case "badkey":
      return `${name}'s API key was refused.`;
    case "error":
      return p.windows.length > 0 || p.balance ? null : `${name}'s usage couldn't be fetched.`;
    default:
      return null;
  }
}

/** The one sentence a provider adds to the summary lead, by the head chip's order; null = nothing to say. */
function providerSentence(p: UsageProvider, now: number, name = PROVIDER_NAME[p.id]): string | null {
  const state = stateSentence(p, name);
  if (state) return state;
  if (p.state !== "ok" && p.state !== "error") return null;
  if (p.balance && !p.balance.available) return `${name} is out of credit.`;
  const resets = (w: UsageWindow) => {
    const r = resetWhen(w.resetsAt, now);
    return r && !r.past ? ` \u2014 resets ${r.when}` : "";
  };
  const full = p.windows.filter((w) => w.pct >= 100);
  const quota = full.find((w) => !isShortWindow(w));
  if (quota) return `${name}'s ${windowLabel(quota)} quota is used up${resets(quota)}.`;
  if (full[0]) return `${name}'s ${windowLabel(full[0])} window is rate-limited${resets(full[0])}.`;
  const near = p.windows.filter((w) => w.pct >= 80).sort((a, b) => b.pct - a.pct)[0];
  if (near) return `${name}'s ${windowLabel(near)} window is at ${pct(near)}%.`;
  if (p.limitReached) return `${name}'s usage limit is reached.`;
  return null;
}

/**
 * The Claude reading the foot and the summary lead speak for (§app.insights/sidebar-foot): the
 * login `loginId` names (the open chat's recorded login), else the one in use for new chats (the
 * first ready in this device's order), else `providers`' own claude — Claude Code's own login,
 * which is all an older server sends. The reading is that login's account card's (the account's
 * freshest: its logins share one quota). `name` is "Claude", or with several logins
 * "Claude ({the login's card title})", so the words say whose reading it is.
 */
export function claudeReading(u: UsageInsight, loginId?: string | null): { usage: UsageProvider; name: string } | null {
  const own = u.providers.find((p) => p.id === "claude");
  const logins = u.claudeLogins ?? [];
  const login = (loginId ? logins.find((l) => l.id === loginId) : undefined) ?? logins.find((l) => l.inUse);
  // Its account's card: the account's freshest reading (its logins share one quota).
  const usage = login ? accountReading(claudeAccounts(logins).find((a) => a.includes(login))!).usage : own;
  if (!usage) return null;
  const name = login && logins.length > 1 ? `${PROVIDER_NAME.claude} (${claudeLoginTitle(login)})` : PROVIDER_NAME.claude;
  return { usage, name };
}

/** `providers` with Claude's entry swapped for the reading `claudeReading` chose, and its name. */
function readings(u: UsageInsight, loginId?: string | null): { p: UsageProvider; name: string }[] {
  const claude = claudeReading(u, loginId);
  return u.providers.map((p) => (p.id === "claude" && claude ? { p: claude.usage, name: claude.name } : { p, name: PROVIDER_NAME[p.id] }));
}

/**
 * The Usage page's summary lead: one sentence per provider that needs attention, in payload
 * order, space-joined; "All providers under limits." when none does. Null without data. Claude's
 * sentence reads the login `claudeReading` chooses, never a login no chat is on.
 */
export function usageSummary(u: UsageInsight | undefined, now: number, loginId?: string | null): string | null {
  if (!u?.available) return null;
  const sentences = readings(u, loginId).map(({ p, name }) => providerSentence(p, now, name)).filter((x): x is string => x !== null);
  return sentences.length ? sentences.join(" ") : "All providers under limits.";
}

/** Sidebar-foot abbreviation per provider. */
export const PROVIDER_ABBR: Record<UsageProvider["id"], string> = { claude: "C", openai: "O", ollama: "OL", zai: "Z", deepseek: "DS" };

/**
 * The one window a provider shows in the compact foot: the one the provider flags `active` (the
 * limit the current model counts against; first in source order), else the 7-day one, else its
 * longest (Ollama's month, Z.ai's plan window, OpenAI's "pri"/5h when that's all). Never the MCP
 * quota or Claude's Opus-only window. Null when the provider isn't ok or has no window — a
 * credit provider (DeepSeek, a balance and no windows) has no window to pick, and reaches the
 * foot through its balance instead (usageGlance).
 */
export function glanceWindow(p: UsageProvider): UsageWindow | null {
  if (p.state !== "ok") return null;
  const ws = p.windows.filter((w) => w.label !== "mcp" && w.label !== "7d opus");
  const preferred = ws.find((w) => w.active) ?? ws.find((w) => w.label === "7d");
  if (preferred) return preferred;
  // Longest known length first; windows of unknown length ("pri", "plan") after, in API order.
  return [...ws].sort((a, b) => (windowMinutes(b.label) ?? -1) - (windowMinutes(a.label) ?? -1))[0] ?? null;
}

export interface GlancePart {
  id: UsageProvider["id"];
  abbr: string;
  /** Percentage used of the glance window. Absent for a credit provider, which has `amount`. */
  pct?: number;
  /** Money left for a credit provider (DeepSeek): it has no quota, and inventing a percentage for
      it would be a lie. Already formatted, and rounded to whole units for the foot ("$4"); `full`
      carries the exact amount. A part carries `pct` or `amount`. */
  amount?: string;
  /** Emphasis: set in semibold ink (no hue: the foot has no word to pair a color with). ≥ 80%
      used for a window provider; out of credit for a credit one — its only bad state. */
  high: boolean;
  /** The whole cache file is old (`usage.stale`). A provider's own failed fetch doesn't set it. */
  stale: boolean;
  /** Full words for the tooltip and accessible name: "Claude 7-day 47%", "DeepSeek balance $4.29". */
  full: string;
}

/**
 * One part per provider with something to show — a readable window, or a credit provider's
 * balance — in provider order; providers without data are left out. Claude's part reads the
 * login `claudeReading` chooses for `loginId` (the open chat's recorded login, if any).
 */
export function usageGlance(u: UsageInsight | undefined, loginId?: string | null): GlancePart[] {
  if (!u?.available) return [];
  return readings(u, loginId).flatMap(({ p, name }): GlancePart[] => {
    const abbr = PROVIDER_ABBR[p.id];
    if (p.state === "ok" && p.balance) {
      const stale = u.stale;
      // Whole units in the row, the exact amount in the tooltip. No percentage: the only
      // emphasis a balance has is "this can't fund calls".
      const amount = moneyCompact(p.balance.total, p.balance.currency);
      const exact = money(p.balance.total, p.balance.currency);
      return [{ id: p.id, abbr, amount, high: !p.balance.available, stale, full: `${name} balance ${exact}` }];
    }
    const w = glanceWindow(p);
    if (!w) return [];
    const stale = u.stale;
    const full = `${name} ${windowLabel(w)} ${pct(w)}%`;
    return [{ id: p.id, abbr, pct: pct(w), high: w.pct >= 80, stale, full }];
  });
}

// ---------------------------------------------------------------------------
// Workers

export interface MemberStatus {
  text: string;
  tone?: Tone | "accent";
  /** Live-sourced and working: the chip may pulse. */
  live: boolean;
  /** When the status was last known, for reported (not live) states. */
  asOf?: number;
  failed: boolean;
}

const STATUS: Record<string, { text: string; tone?: Tone | "accent"; working?: boolean }> = {
  starting: { text: "Starting", tone: "accent", working: true },
  running: { text: "Working", tone: "accent", working: true },
  waiting: { text: "Idle" },
  stopping: { text: "Stopping" },
  done: { text: "Done", tone: "success" },
  error: { text: "Failed", tone: "error" },
  killed: { text: "Stopped" },
  // A server restart took it down; it is back on record, not running, until someone resumes it.
  restored: { text: "Restored" },
  // Old-format subagent-complete reports ("… finished its task.").
  finished: { text: "Done", tone: "success" },
  // A member's own records: its host died mid-turn ("lost").
  interrupted: { text: "Interrupted", tone: "warn" },
};

const INTERRUPTED: (typeof STATUS)[string] = { text: "Interrupted", tone: "warn" };

/**
 * `liveSource`: the member's worker comes from a fresh live record. Otherwise nothing may claim to
 * be working: a reported "running" is shown as its word without the pulse.
 */
export function memberStatus(m: TeamMember, liveSource: boolean): MemberStatus {
  // Retired by a handover: the word says what happened, as of the retirement, whatever the
  // worker's own last state was.
  if (m.retired) {
    const at = Date.parse(m.retired.at);
    return { text: "Retired", live: false, asOf: Number.isNaN(at) ? undefined : at, failed: false };
  }
  const w = m.worker;
  if (w) {
    // Restored mid-turn: the turn it was on never finished, which is the fact worth the chip.
    const s = w.status === "restored" && w.interruptedAt !== undefined ? INTERRUPTED : (STATUS[w.status] ?? STATUS.running!);
    const live = liveSource && !!s.working;
    return {
      text: s.text,
      tone: live ? s.tone : s.tone === "accent" ? undefined : s.tone,
      live,
      asOf: liveSource ? undefined : w.lastActivity,
      failed: w.status === "waiting" && !!w.outcome && w.outcome !== "success",
    };
  }
  const r = m.lastReport;
  if (!r) return { text: "No report yet", live: false, failed: false };
  const s = STATUS[r.status];
  const at = Date.parse(r.at);
  return {
    text: s?.text ?? r.status.charAt(0).toUpperCase() + r.status.slice(1),
    tone: s?.tone === "accent" ? undefined : s?.tone,
    live: false,
    asOf: Number.isNaN(at) ? undefined : at,
    failed: r.status === "waiting" && !!r.outcome && r.outcome !== "success",
  };
}

/** Teams of live pi processes, newest first. Headless workers (rpc, not embedded) don't own teams. */
export function activeTeams(a: AgentsInsight | undefined): TeamInfo[] {
  if (!a) return [];
  return a.sessions
    .filter(isHostSession)
    .flatMap((s) => s.teams)
    .sort((x, y) => y.createdAt - x.createdAt);
}

/** Whether a team's parent record has a fresh heartbeat (its member statuses are live). Team ids
    restart in every session, so the team is matched with its parent session too. */
export const teamFresh = (a: AgentsInsight | undefined, team: TeamInfo) =>
  !!a?.sessions.some((s) => s.fresh && s.teams.some((t) => t.id === team.id && t.parentPath === team.parentPath));

/**
 * What of one session's teams the head chip shows, as one comparable string from the #/agents
 * data: each team's id, working count and newest event (a pause or resume is an event). Null
 * when the session has no team there. A change means the session's own insight is stale.
 */
export function teamPulse(a: AgentsInsight | undefined, path: string): string | null {
  const teams = (a?.sessions ?? []).flatMap((s) => s.teams).filter((t) => t.parentPath === path);
  return teams.length ? teams.map((t) => `${t.id}:${t.working}:${t.events?.at(-1)?.id ?? ""}`).sort().join("|") : null;
}

/** FNV-1a, 32 bits, base 36: a short stable tag for a parent session path. */
function pathTag(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
/** One team across every session: `<team id>.<tag of its parent session>`. Team ids restart at
    team_01 in every session, so the id alone names several teams on #/agents. */
export const teamKey = (team: { id: string; parentPath: string }) => `${team.id}.${pathTag(team.parentPath)}`;
/** The team group's element id, from its teamKey (or a bare team id, for older links). */
export const teamAnchor = (key: string) => `team-${key}`;
/** The team group's heading id (its section's aria-labelledby). */
export const teamHeadingId = (key: string) => `tt-${key}`;
/** The group a `#/agents/<key>` link means: its exact key, or, for a bare team id from an older
    link, the newest team with that id (groups are rendered newest first). */
export function findTeamGroup(doc: Pick<Document, "getElementById" | "querySelectorAll">, key: string): HTMLElement | null {
  const exact = doc.getElementById(teamAnchor(key));
  if (exact || key.includes(".")) return exact;
  return Array.from(doc.querySelectorAll<HTMLElement>(".team-group")).find((el) => el.id.startsWith(`${teamAnchor(key)}.`)) ?? null;
}
export const usageHref = () => "#/usage";
export const agentsHref = (teamId?: string) => (teamId ? `#/agents/${encodeURIComponent(teamId)}` : "#/agents");
/** The Explanations page, or that page with one session's filter set. */
export const explanationsHref = (sessionId?: string | null) =>
  sessionId ? `#/explanations/${encodeURIComponent(sessionId)}` : "#/explanations";

/** The insights page in the hash, if any: `#/usage`, `#/agents`, `#/agents/<teamKey>` (a bare team
    id from older links too), `#/explanations`, `#/explanations/<sessionId>`. */
export type InsightsRoute = { page: "usage" } | { page: "agents"; team: string | null } | { page: "explanations"; session: string | null };

export function insightsRouteFromHash(hash: string): InsightsRoute | null {
  if (hash === "#/usage") return { page: "usage" };
  const x = /^#\/explanations(?:\/(.*))?$/.exec(hash);
  if (x) {
    try {
      return { page: "explanations", session: x[1] ? decodeURIComponent(x[1]) : null };
    } catch {
      return { page: "explanations", session: null };
    }
  }
  const m = /^#\/agents(?:\/(.+))?$/.exec(hash);
  if (!m) return null;
  try {
    return { page: "agents", team: m[1] ? decodeURIComponent(m[1]) : null };
  } catch {
    return { page: "agents", team: null };
  }
}

/** Where a pre-split `#/insights` link now points: usage, or the team's agents card. Null if not one. */
export function legacyInsightsTarget(hash: string): string | null {
  const m = /^#\/insights(?:\/(.+))?$/.exec(hash);
  if (!m) return null;
  if (!m[1]) return usageHref();
  try {
    return agentsHref(decodeURIComponent(m[1]));
  } catch {
    return agentsHref();
  }
}

// ---------------------------------------------------------------------------
// Coordinated teams: duties, succession, events

/** The one badge beside a member's name: its duty, else its successor tie, else orchestrator.
    A coordinator is always an orchestrator too; the duty's word replaces that one, never adds. */
export function memberBadges(m: TeamMember, team: Pick<TeamInfo, "members">): { label: string; title?: string }[] {
  const out: { label: string; title?: string }[] = [];
  if (m.duty === "coordinator") out.push({ label: "Coordinator", title: "Members report to it; only it reports to you." });
  else if (m.duty === "monitor") out.push({ label: "Monitor", title: "Watches context and usage, and starts handovers." });
  else if (m.orchestrator) out.push({ label: "Orchestrator" });
  if (m.successorOf) {
    const from = team.members.find((x) => x.workerId === m.successorOf);
    const who = from?.role ?? m.successorOf;
    out.push({ label: `Succeeds ${who}`, title: `Took over from ${who} (${m.successorOf}).` });
  }
  return out;
}

/** Coordinator first, then the working members in roster order, the monitor, and retired members
    last (each group keeps roster order). */
export function orderedMembers(team: Pick<TeamInfo, "members">): TeamMember[] {
  const rank = (m: TeamMember) => (m.retired ? 3 : m.duty === "coordinator" ? 0 : m.duty === "monitor" ? 2 : m.orchestrator ? 0 : 1);
  return team.members.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

/** The pause in force: the newest pause/resume event, when it is a pause. */
export function teamPause(team: Pick<TeamInfo, "events">): TeamEvent | null {
  const events = team.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "resume") return null;
    if (e.kind === "pause") return e;
  }
  return null;
}

/** How many events the team group lists before the rest fold under "Earlier events". */
export const TEAM_EVENTS_SHOWN = 20;

/** Oldest first, split: the newest TEAM_EVENTS_SHOWN, and the older ones before them. */
export function splitTeamEvents(team: Pick<TeamInfo, "events">): { earlier: TeamEvent[]; recent: TeamEvent[] } {
  const all = team.events ?? [];
  const cut = Math.max(0, all.length - TEAM_EVENTS_SHOWN);
  return { earlier: all.slice(0, cut), recent: all.slice(cut) };
}

/** The newest event, as one caption line: "7:06 PM · monitor-2 paused the team: …". */
export function newestEventLine(team: Pick<TeamInfo, "events">): { at: string; text: string; detail?: string } | null {
  const e = team.events?.[team.events.length - 1];
  return e ? { at: clockTime(e.at), text: e.text, ...(e.detail ? { detail: e.detail } : {}) } : null;
}
