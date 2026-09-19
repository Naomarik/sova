// Presentation rules for the insights surfaces (docs/insights-research.md "## UX"): labels,
// status words and chips, derived from the /api/insights/* payloads. No fetching here.

import type { AgentsInsight, TeamInfo, TeamMember, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import type { Tone } from "../components/ui";

export const PROVIDER_NAME: Record<UsageProvider["id"], string> = {
  claude: "Claude",
  openai: "OpenAI",
  ollama: "Ollama Cloud",
};

const WINDOW_LABEL: Record<string, string> = {
  "5h": "5-hour",
  "7d": "7-day",
  "7d opus": "7-day Opus",
  month: "Monthly",
  pri: "Primary",
};

export const windowLabel = (w: UsageWindow) => WINDOW_LABEL[w.label] ?? w.label;

/** Short windows reset on their own; weekly/monthly ones wait for the reset. */
const isShortWindow = (w: UsageWindow) => w.label === "5h";


export const pct = (w: UsageWindow) => Math.round(w.pct);

export function meterTone(w: UsageWindow): "warn" | "error" | null {
  if (w.pct >= 100) return "error";
  if (w.pct >= 80) return "warn";
  return null;
}

/** Card head chip for a provider: the worst window decides; "Stale" only when no limit applies. */
export function providerChip(p: UsageProvider): { tone?: Tone; text: string } | null {
  const full = p.windows.filter((w) => w.pct >= 100);
  if (full.some((w) => !isShortWindow(w))) return { tone: "error", text: "Quota used" };
  if (full.length > 0) return { tone: "warn", text: "Rate-limited" };
  if (p.windows.some((w) => w.pct >= 80)) return { tone: "warn", text: "Near limit" };
  if (p.error && p.windows.length > 0) return { text: "Stale" };
  return null;
}

const signIn = (id: UsageProvider["id"]) => (id === "openai" ? "pi /login" : "claude /login");

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
      return { lead: "No Ollama Cloud key in ", code: "~/.pi/agent/auth.json", rest: "." };
    case "badkey":
      return { lead: "Ollama Cloud refused the key in ", code: "~/.pi/agent/auth.json", rest: "." };
    case "na":
      return { rest: "This account doesn't report usage." };
    case "error":
      if (p.windows.length > 0) return null;
      return { rest: `Couldn't fetch usage: ${(p.error ?? "unknown error").replace(/\.$/, "")}. We'll try again at the next refresh.` };
  }
}

/** Highest window across providers, for the sidebar foot: label "Claude 5-hour", pct 96. */
export function worstWindow(u: UsageInsight | undefined): { label: string; pct: number } | null {
  if (!u?.available) return null;
  let best: { p: UsageProvider; w: UsageWindow } | null = null;
  for (const p of u.providers) for (const w of p.windows) if (!best || w.pct > best.w.pct) best = { p, w };
  return best ? { label: `${PROVIDER_NAME[best.p.id]} ${windowLabel(best.w)}`, pct: pct(best.w) } : null;
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

/** Teams of live pi processes, newest first. rpc-mode records (workers themselves) don't own teams. */
export function activeTeams(a: AgentsInsight | undefined): TeamInfo[] {
  if (!a) return [];
  return a.sessions
    .filter((s) => s.mode !== "rpc")
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
