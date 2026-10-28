/**
 * Where a card stands in the transcript (§chat.transcript-cards/placement). Every row stands where
 * it was raised, and the list never reorders: nothing is pinned at the end, so the next reply always
 * draws below the newest card.
 *
 * - **Anchored** rows: each is its own card.
 * - **Following** rows: a card raised again is a new revision at its own point in the chat, sharing
 *   a key; only its newest row draws the card, earlier ones are its trail. This is how an open
 *   alignment follows the chat (each `align` call is a new row, lib/align.ts `newestAlignRows`).
 */

/** The id of the newest row of each card, by its key (a card's revisions share one): those draw whole, the rest as their trail. */
export function newestByKey<T>(rows: Iterable<T>, keyOf: (row: T) => string | undefined, idOf: (row: T) => string): Set<string> {
  const newest = new Map<string, string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== undefined) newest.set(key, idOf(row));
  }
  return new Set(newest.values());
}
