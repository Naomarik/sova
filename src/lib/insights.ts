// Presentation rules for the insights surfaces (docs/insights-research.md "## UX"): labels,
// status words and chips, derived from the /api/insights/* payloads. No fetching here.

import type { AgentsInsight, TeamInfo, TeamMember, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import type { Tone } from "../components/ui";
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

/**
 * Card head chip for a provider: the worst window decides. Null when no limit applies.
 * A credit provider (DeepSeek) has a balance and no windows, so only the funding rule can fire.
 */
export function providerChip(p: UsageProvider): { tone?: Tone; text: string } | null {
  if (p.balance && !p.balance.available) return { tone: "error", text: "Out of credit" };
  const full = p.windows.filter((w) => w.pct >= 100);
  if (full.some((w) => !isShortWindow(w))) return { tone: "error", text: "Quota used" };
  if (full.length > 0) return { tone: "warn", text: "Rate-limited" };
  if (p.windows.some((w) => w.pct >= 80)) return { tone: "warn", text: "Near limit" };
  return null;
}

const signIn = (id: UsageProvider["id"]) => (id === "openai" ? "pi /login" : "claude /login");
const keyWord = (id: UsageProvider["id"]) => (id === "zai" ? "API key" : "key");

/** One caption replacing the meters when a provider has nothing to show. Null = render meters. */
export function providerProblem(p: UsageProvider): { lead?: string; code?: string; rest: string } | null {
  switch (p.state) {
    case "ok":
      return null;
    case "nologin":
      return { lead: "Not signed in. Run ", code: signIn(p.id), rest: " and it'll show at the next refresh." };
    case "expired":
      return { lead: "Sign-in expired. Run ", code: signIn(p.id), rest: " to renew it." };
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
 * balance — in provider order; providers without data are left out.
 */
export function usageGlance(u: UsageInsight | undefined): GlancePart[] {
  if (!u?.available) return [];
  return u.providers.flatMap((p): GlancePart[] => {
    const abbr = PROVIDER_ABBR[p.id];
    if (p.state === "ok" && p.balance) {
      const stale = u.stale;
      // Whole units in the row, the exact amount in the tooltip. No percentage: the only
      // emphasis a balance has is "this can't fund calls".
      const amount = moneyCompact(p.balance.total, p.balance.currency);
      const exact = money(p.balance.total, p.balance.currency);
      return [{ id: p.id, abbr, amount, high: !p.balance.available, stale, full: `${PROVIDER_NAME[p.id]} balance ${exact}` }];
    }
    const w = glanceWindow(p);
    if (!w) return [];
    const stale = u.stale;
    const full = `${PROVIDER_NAME[p.id]} ${windowLabel(w)} ${pct(w)}%`;
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
  // Old-format subagent-complete reports ("… finished its task.").
  finished: { text: "Done", tone: "success" },
};

/**
 * `liveSource`: the member's worker comes from a fresh live record. Otherwise nothing may claim to
 * be working: a reported "running" is shown as its word without the pulse.
 */
export function memberStatus(m: TeamMember, liveSource: boolean): MemberStatus {
  const w = m.worker;
  if (w) {
    const s = STATUS[w.status] ?? STATUS.running!;
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

/** Whether a team's parent record has a fresh heartbeat (its member statuses are live). */
export const teamFresh = (a: AgentsInsight | undefined, team: TeamInfo) =>
  !!a?.sessions.some((s) => s.fresh && s.teams.some((t) => t.id === team.id));

export const teamAnchor = (id: string) => `team-${id}`;
export const usageHref = () => "#/usage";
export const agentsHref = (teamId?: string) => (teamId ? `#/agents/${encodeURIComponent(teamId)}` : "#/agents");

/** The insights page in the hash, if any: `#/usage`, `#/agents`, `#/agents/<teamId>`. */
export type InsightsRoute = { page: "usage" } | { page: "agents"; team: string | null };

export function insightsRouteFromHash(hash: string): InsightsRoute | null {
  if (hash === "#/usage") return { page: "usage" };
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
