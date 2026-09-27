// The overview's Sessions card (§chat.transcript/landing-page): what the session list holds, at a
// glance, from data the page already has (the list and the attention digest; no server call).
import type { AttentionDigest, OverseerProactivity, SessionSummary } from "../../shared/protocol";
import { needsYouRows, needsYouShown } from "./needs-you";
import { byRecentActivity, recentEligible } from "./recent";
import { isMainThread, isOrdinarySession, sidebarRegion } from "./regions";

export interface SessionsGlance {
  /** Main threads, archived and org sessions included (the opening's "{n} sessions"). */
  total: number;
  /** Distinct folders of those. */
  folders: number;
  /** In Live & web: open in a terminal, or a web session not archived; never an org session. */
  live: number;
  /** Running a turn right now: a live record says working, or the server reports it busy. */
  working: number;
  /** Sessions the Needs-you region lists (0 while Overseer proactivity is Off or unknown). */
  needsYou: number;
  /** The first two of those, newest first. */
  needsYouFirst: SessionSummary[];
  /** The most recently active session Recent would list first; null with none. */
  last: SessionSummary | null;
}

export function sessionsGlance(
  list: readonly SessionSummary[],
  digest: Pick<AttentionDigest, "items"> | undefined,
  proactivity: OverseerProactivity | undefined,
): SessionsGlance {
  const main = list.filter(isMainThread);
  // Needs you, Live & web and Recent never hold an organization's session (§app.session-list/organizations).
  const ordinary = main.filter(isOrdinarySession);
  const rows = needsYouRows(digest, ordinary);
  const shown = needsYouShown(proactivity, rows.length);
  const eligible = ordinary.filter(recentEligible).sort(byRecentActivity);
  return {
    total: main.length,
    folders: new Set(main.map((s) => s.cwd)).size,
    live: main.filter((s) => sidebarRegion(s) === "top").length,
    working: main.filter((s) => s.activity?.state === "working" || (!s.live && !!s.busy)).length,
    needsYou: shown ? rows.length : 0,
    needsYouFirst: shown ? rows.slice(0, 2).map((r) => r.session) : [],
    last: eligible[0] ?? null,
  };
}
