// The sidebar's "Needs you" region: the sessions the attention digest puts in its act tier
// (server/attention.ts — a dialog open, an errored turn, a subagent error, or a decision signal
// that asks you something, failed, or is stuck), said once more above Recent.
//
// Like Recent it is a SHORTCUT: every session it lists keeps its row wherever it lives. The digest,
// not the session list, is the source, because two act kinds (a hosted pending dialog, a worker
// error) and every detail sentence reach only the digest.
//
// Pure on purpose, like `recent` and `group-open`: the rules run under tsx --test, and the sidebar
// keeps the (sessionStorage) state.

import type { AttentionDigest, OverseerProactivity, SessionSummary } from "../../shared/protocol";

/** Open by default; a collapse is remembered for the tab, like the Archive's `sova:archive-open`. */
export const NEEDS_YOU_KEY = "sova:needs-you-open";

/** One session in the region: its row, and the digest's sentence that replaces the row's line 2. */
export interface NeedsYouRow {
  session: SessionSummary;
  /** The newest act item's detail ("Asks you: …", "Waiting on a dialog."); null when it has none. */
  detail: string | null;
  /** Every act item's detail for this session, newest first, for the line's tooltip. */
  details: string[];
  /** ms epoch of the session's newest act item; 0 unknown. */
  since: number;
}

/**
 * The region's rows: one per session with at least one act item, newest first by that session's
 * newest act item, joined by path to `sessions` — the sidebar's hit list, so a search or the host
 * filter narrows this region like every other and it never lists a row the rest of the pane hides.
 * A digest session the list doesn't carry is dropped: the count is the rows.
 */
export function needsYouRows(digest: Pick<AttentionDigest, "items"> | undefined, sessions: readonly SessionSummary[]): NeedsYouRow[] {
  if (!digest) return [];
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const acc = new Map<string, { session: SessionSummary; since: number; details: { at: number; text: string }[] }>();
  for (const it of digest.items) {
    if (it.tier !== "act") continue;
    const session = byPath.get(it.path);
    if (!session) continue;
    let a = acc.get(it.path);
    if (!a) acc.set(it.path, (a = { session, since: it.since, details: [] }));
    a.since = Math.max(a.since, it.since);
    if (it.detail) a.details.push({ at: it.since, text: it.detail });
  }
  return [...acc.values()]
    .map((a) => {
      // Newest first; the sort is stable, so one time keeps the digest's own order (most urgent kind first).
      const details = a.details.sort((x, y) => y.at - x.at).map((d) => d.text);
      return { session: a.session, since: a.since, details, detail: details[0] ?? null };
    })
    .sort((a, b) => b.since - a.since || a.session.path.localeCompare(b.session.path));
}

/** Whether the digest's 30-item cap dropped act items, so the region may be short. */
export const needsYouCut = (digest: Pick<AttentionDigest, "items" | "counts"> | undefined): boolean =>
  !!digest && digest.counts.act > digest.items.filter((i) => i.tier === "act").length;

/**
 * Whether the region is on screen: ONE rule, read by the region and by the spine's door to it.
 * Omitted at 0 rows, and while Overseer proactivity is Off — or not yet known, so it never flashes
 * in before the first Overseer read says Off.
 */
export const needsYouShown = (proactivity: OverseerProactivity | undefined, rows: number): boolean =>
  !!proactivity && proactivity !== "off" && rows > 0;

/** The stored choice: only "0" (the user collapsed it) closes the region; anything else is open. */
export const storedNeedsYouOpen = (raw: string | null): boolean => raw !== "0";

/** Open while a search is on (every hit visible), else the user's choice for the tab. */
export const needsYouOpen = (input: { stored: boolean; searching: boolean }): boolean => input.searching || input.stored;

/** The head's title: what the region is, with its count. */
export const needsYouTitle = (n: number): string =>
  n === 1 ? "The 1 session waiting on you." : `The ${n} sessions waiting on you, newest first.`;
