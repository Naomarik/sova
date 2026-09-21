/**
 * The Archive's date sections and cleanup results (spec/02-session-list.md §2 "Archive by date" and
 * "Archive cleanup"). Pure, so it runs under tsx --test.
 */

export type ArchiveGroupId = "today" | "yesterday" | "week" | "month" | "older";

/** Display order, newest first. */
export const ARCHIVE_GROUPS: readonly { id: ArchiveGroupId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
  { id: "older", label: "Older" },
];

const DAY_MS = 86_400_000;

/** Local calendar days between `then` and `now` (0 = same day). Future times count as today. */
function calendarDaysAgo(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Round, because a day across a DST change is 23 or 25 hours long.
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/**
 * The section a session with this `lastActiveAt` falls in, by local calendar day (browser TZ):
 * today, yesterday, 2–7 days ago, 8–30 days ago, or more than 30. Unparseable times go to Older.
 */
export function archiveGroupOf(lastActiveAt: string, now = new Date()): ArchiveGroupId {
  const then = new Date(lastActiveAt);
  if (Number.isNaN(then.getTime())) return "older";
  const days = calendarDaysAgo(then, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "older";
}

/**
 * Splits `items` into the non-empty sections in display order. Order within a section is the
 * input order, so sort before calling.
 */
export function groupByArchiveDate<T extends { lastActiveAt: string }>(
  items: readonly T[],
  now = new Date(),
): { id: ArchiveGroupId; label: string; items: T[] }[] {
  const by = new Map<ArchiveGroupId, T[]>();
  for (const it of items) {
    const id = archiveGroupOf(it.lastActiveAt, now);
    const list = by.get(id);
    if (list) list.push(it);
    else by.set(id, [it]);
  }
  return ARCHIVE_GROUPS.filter((g) => by.has(g.id)).map((g) => ({ ...g, items: by.get(g.id)! }));
}

// ---------------------------------------------------------------------------
// Cleanup (POST /api/sessions/cleanup)
// ---------------------------------------------------------------------------

export type CleanupRequest = { mode: "age"; minAgeDays: 7 | 30 } | { mode: "husks" };

export interface CleanupResult {
  /** Files deleted (0 on a dry run). */
  deletedCount: number;
  /** Ids deleted, or on a dry run the ids that would be; null when the server sent none. */
  deletedIds: string[] | null;
  skipped: { live: number; busy: number; recent: number };
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a cleanup response leniently: missing or malformed fields become 0 / null, never a throw. */
export function parseCleanupResult(raw: unknown): CleanupResult {
  const r = isObj(raw) ? raw : {};
  const skipped = isObj(r.skipped) ? r.skipped : {};
  return {
    deletedCount: count(r.deletedCount),
    deletedIds: Array.isArray(r.deletedIds) ? r.deletedIds.filter((x): x is string => typeof x === "string") : null,
    skipped: { live: count(skipped.live), busy: count(skipped.busy), recent: count(skipped.recent) },
  };
}

/** Sessions a dry run would delete: the id list when sent (deletedCount is 0 on a dry run), else deletedCount. */
export const cleanupCandidates = (r: CleanupResult): number => r.deletedIds?.length ?? r.deletedCount;

export const skippedTotal = (r: CleanupResult): number => r.skipped.live + r.skipped.busy + r.skipped.recent;

/** "3 skipped: 1 open in a TUI, 2 just written", or null when nothing was skipped. */
export function skippedText(r: CleanupResult): string | null {
  const total = skippedTotal(r);
  if (total === 0) return null;
  const parts: string[] = [];
  if (r.skipped.live) parts.push(`${r.skipped.live} open in a TUI`);
  if (r.skipped.busy) parts.push(`${r.skipped.busy} mid-turn`);
  if (r.skipped.recent) parts.push(`${r.skipped.recent} just written`);
  return `${total} skipped: ${parts.join(", ")}`;
}

export const sessionsWord = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/** What an action targets, for the confirm dialog body. */
export function cleanupScope(req: CleanupRequest): string {
  return req.mode === "husks"
    ? "Empty sessions: nothing was ever sent in them."
    : `Sessions last active more than ${req.minAgeDays} days ago.`;
}
