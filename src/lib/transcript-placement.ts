/**
 * Where a card stands in the transcript (§chat.transcript-cards/placement). Pure: the thread asks
 * it for the order its rows draw in, so a placement can never make one card cover another, the
 * composer, or move what the reader is looking at by itself (the thread's own scroll anchoring holds
 * the view across the change, as for any row that arrives).
 *
 * - **Anchored** rows stand where they were raised: their place in the list.
 * - A **following** row stands at the end, below the newest row, while its kind's condition holds
 *   (`followsNow`); once it stops holding, it settles back at its own place in the list, which is
 *   where it was raised, since the list itself never reorders.
 * - A card raised again (a new revision of the same card, by `key`) follows by revision: only its
 *   newest row draws the card; earlier ones are its trail. This is how an open alignment follows the
 *   chat today (each `align` call is a new row, lib/align.ts `newestAlignRows`).
 */

/** The rows in drawing order: every row `follows` holds for moved to the end, in their own order. The same array when none follows. */
export function placeRows<T>(rows: T[], follows: (row: T) => boolean): T[] {
  let moved: T[] | undefined;
  for (const row of rows) if (follows(row)) (moved ??= []).push(row);
  if (!moved) return rows;
  const set = new Set(moved);
  return [...rows.filter((r) => !set.has(r)), ...moved];
}

/** The id of the newest row of each card, by its key (a card's revisions share one): those draw whole, the rest as their trail. */
export function newestByKey<T>(rows: Iterable<T>, keyOf: (row: T) => string | undefined, idOf: (row: T) => string): Set<string> {
  const newest = new Map<string, string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== undefined) newest.set(key, idOf(row));
  }
  return new Set(newest.values());
}
