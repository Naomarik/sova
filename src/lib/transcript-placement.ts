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

/** A row the page makes for a card raised from outside the chat: it never comes from the server. */
export const outsideCardRowId = (cardId: string): string => `card:${cardId}`;

/**
 * Cards raised from outside the chat (§chat.transcript-cards/raise-command), each placed after the
 * rows of the entry that was the transcript's last when it was raised (`after`; null: before every
 * row). One whose entry isn't on screen (above the rows loaded, or off this branch) stands by its
 * time instead: after every row older than it. Nothing moves once placed; the list never reorders.
 */
export function placeOutsideCards<T extends { id: string; at?: string }, C extends { id: string; at: string; after?: string | null }>(items: readonly T[], cards: readonly C[], rowOf: (card: C) => T): T[] {
  if (!cards.length) return items as T[];
  const lastOfEntry = new Map<string, number>();
  items.forEach((it, i) => {
    const entry = it.id.split(":")[0]!;
    lastOfEntry.set(entry, i);
  });
  const atIndex = (card: C): number => {
    if (card.after === null) return -1;
    if (card.after !== undefined) {
      const i = lastOfEntry.get(card.after);
      if (i !== undefined) return i;
    }
    const t = Date.parse(card.at);
    let last = items.length - 1;
    if (Number.isFinite(t)) {
      last = -1;
      items.forEach((it, i) => {
        const at = it.at ? Date.parse(it.at) : NaN;
        if (!(at > t)) last = i;
      });
    }
    return last;
  };
  const after = new Map<number, T[]>();
  for (const card of [...cards].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const i = atIndex(card);
    const list = after.get(i) ?? [];
    list.push(rowOf(card));
    after.set(i, list);
  }
  const out: T[] = [...(after.get(-1) ?? [])];
  items.forEach((it, i) => {
    out.push(it);
    const rows = after.get(i);
    if (rows) out.push(...rows);
  });
  return out;
}
