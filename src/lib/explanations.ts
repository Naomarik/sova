// The Explanations page (#/explanations): which cards it shows, in which order, and where each
// card's session is. Pure: the page feeds it the polled explanations, the session list and the
// answers of the by-id lookups it made.

import type { ExplanationInfo, SessionSummary } from "../../shared/protocol";
import { sessionHrefOn } from "./mesh";

export type ExplainRange = "today" | "7d" | "30d" | "all";
export type ExplainOrder = "newest" | "oldest";

/** The date filter's buttons, in the bar's order. */
export const EXPLAIN_RANGES: readonly { id: ExplainRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 Days" },
  { id: "30d", label: "30 Days" },
  { id: "all", label: "All" },
];

export const EXPLAIN_ORDERS: readonly { id: ExplainOrder; label: string }[] = [
  { id: "newest", label: "Newest First" },
  { id: "oldest", label: "Oldest First" },
];

const DAY_MS = 86_400_000;

/** Where a range starts, in ms: local midnight for Today, N days back from now otherwise; null for All. */
export function rangeStart(range: ExplainRange, now: number): number | null {
  if (range === "all") return null;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (range === "7d" ? 7 : 30) * DAY_MS;
}

/** An unreadable `createdAt` sorts as the oldest and only survives the All range. */
const timeOf = (e: ExplanationInfo) => {
  const t = Date.parse(e.createdAt);
  return Number.isNaN(t) ? -Infinity : t;
};

export interface ExplainFilter {
  /** A parent session id, or null for every session. */
  session: string | null;
  range: ExplainRange;
  order: ExplainOrder;
}

/** The cards the filters leave, in the chosen order (ties keep the list's order). Never mutates. */
export function filterExplanations(list: readonly ExplanationInfo[], f: ExplainFilter, now: number): ExplanationInfo[] {
  const from = rangeStart(f.range, now);
  const kept = list.filter((e) => (f.session === null || e.parentSessionId === f.session) && (from === null || timeOf(e) >= from));
  const sign = f.order === "newest" ? -1 : 1;
  return kept
    .map((e, i) => ({ e, i }))
    .sort((a, b) => sign * (timeOf(a.e) - timeOf(b.e)) || a.i - b.i)
    .map((x) => x.e);
}

/** The page's head meta: "12 explanations · newest first". */
export function explanationsMeta(n: number, order: ExplainOrder): string {
  return `${n} ${n === 1 ? "explanation" : "explanations"} · ${order === "newest" ? "newest first" : "oldest first"}`;
}

/** A session id as a person can tell it apart: its first 8 characters. */
export const shortSessionId = (id: string) => id.slice(0, 8);

/** What a by-id lookup (`GET /api/sessions/summary?id=`) answered for a session the list lacks. */
export type SessionLookup = SessionSummary | "pending" | "gone" | "failed";

/** Where a card's session is. */
export type ExplainSessionRef =
  /** Known: its title, whether it's archived, its file and the route that opens it. */
  | { kind: "known"; id: string; title: string; archived: boolean; path: string; href: string }
  /** Not known yet (unlisted, lookup pending or failed): linked by id, and `#/sid/` resolves it. */
  | { kind: "by-id"; id: string; title: string; href: string }
  /** This host says there is no such session. */
  | { kind: "gone"; id: string };

const byIdHref = (id: string) => `#/sid/${encodeURIComponent(id)}`;

/** A listed session opens by its path; one only the lookup found opens by id, because `#/s/<path>`
    only opens rows the list has and `#/sid/<id>` adds the looked-up row for the view. */
const known = (s: SessionSummary, listed: boolean): ExplainSessionRef => ({
  kind: "known",
  id: s.id,
  title: s.title,
  archived: !!s.archived,
  path: s.path,
  href: listed ? sessionHrefOn(null, s.path) : byIdHref(s.id),
});

/** A card's session: the list first, then what the lookup said. */
export function resolveExplainSession(
  id: string,
  sessions: readonly SessionSummary[] | undefined,
  lookups: Readonly<Record<string, SessionLookup>>,
): ExplainSessionRef {
  const listed = sessions?.find((s) => s.id === id);
  if (listed) return known(listed, true);
  const answer = lookups[id];
  if (answer === "gone") return { kind: "gone", id };
  if (answer && typeof answer === "object") return known(answer, false);
  return { kind: "by-id", id, title: `session ${shortSessionId(id)}`, href: byIdHref(id) };
}

/** Parent sessions the list doesn't carry and nobody has asked about yet, each once. Nothing
    until the list has loaded: most of them are in it. */
export function sessionsToLookUp(
  list: readonly ExplanationInfo[],
  sessions: readonly SessionSummary[] | undefined,
  lookups: Readonly<Record<string, SessionLookup>>,
): string[] {
  if (!sessions) return [];
  const listed = new Set(sessions.map((s) => s.id));
  return [...new Set(list.map((e) => e.parentSessionId))].filter((id) => id && !listed.has(id) && !(id in lookups));
}

/**
 * The session select's options: one per session with at least one explanation, the session with
 * the most recent explanation first, named by `name`. A `selected` id with none is kept (a
 * `#/explanations/<id>` link to a session without explanations), last, so the select can show it.
 */
export function explanationSessionOptions(
  list: readonly ExplanationInfo[],
  name: (id: string) => string,
  selected: string | null = null,
): { id: string; label: string; count: number }[] {
  const by = new Map<string, { latest: number; count: number }>();
  for (const e of list) {
    const cur = by.get(e.parentSessionId);
    const t = timeOf(e);
    if (cur) {
      cur.count++;
      cur.latest = Math.max(cur.latest, t);
    } else by.set(e.parentSessionId, { latest: t, count: 1 });
  }
  const out = [...by.entries()].sort((a, b) => b[1].latest - a[1].latest).map(([id, v]) => ({ id, label: name(id), count: v.count }));
  if (selected !== null && !by.has(selected)) out.push({ id: selected, label: name(selected), count: 0 });
  return out;
}

/** The overview card's figures: how many, and the newest one. */
export function explanationsGlance(list: readonly ExplanationInfo[]): { count: number; latest: ExplanationInfo | null } {
  let latest: ExplanationInfo | null = null;
  for (const e of list) if (!latest || timeOf(e) > timeOf(latest)) latest = e;
  return { count: list.length, latest };
}
