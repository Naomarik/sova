/**
 * Paged lists on the owner page (§app.owner-page/content, §app.project-assistant/chat, Paged): the Project
 * Assistant's chat and a conversation open on their newest page and load earlier pages on the way up. A fresh read
 * or a pushed update carries only the newest page; these merge it into what is on screen and never drop what was
 * loaded before. Pure: no DOM, no Solid.
 */

/** What a list shows: its rows, oldest first, and how many come before the first (0: it starts at the beginning). */
export interface Paged<T> {
  rows: T[];
  older: number;
}

/** The empty list: nothing loaded yet. */
export const emptyPaged = <T>(): Paged<T> => ({ rows: [], older: 0 });

/**
 * The newest page merged into what is on screen, by each row's key (a message's `n`, an item's id). Rows loaded
 * earlier that come before the page stay, in their order; the page's rows replace their own keys, and a row that
 * didn't change keeps the object already on screen (`same`), so a keyed list redraws only what changed. `older`
 * stays the smaller of the two: what was loaded never shrinks back.
 */
export function mergeNewest<T>(prev: Paged<T>, page: Paged<T>, key: (row: T) => string | number, same: (a: T, b: T) => boolean = sameJson): Paged<T> {
  if (!prev.rows.length || !page.rows.length) return { rows: page.rows, older: page.older };
  const inPage = new Set(page.rows.map(key));
  // What was loaded before the page stays: every row before the page's first row, but those the page holds again (a
  // row that moved to the end, as a plan card does at its latest change). With the page's first row not loaded, the
  // loaded rows stay only when they reach where the page starts; past a gap the page starts afresh.
  const firstKey = key(page.rows[0]!);
  const at = prev.rows.findIndex((r) => key(r) === firstKey);
  const kept = (at >= 0 ? prev.rows.slice(0, at) : prev.older + prev.rows.length >= page.older ? prev.rows : []).filter((r) => !inPage.has(key(r)));
  const old = new Map(prev.rows.map((r) => [key(r), r] as const));
  const rows = page.rows.map((r) => {
    const o = old.get(key(r));
    return o !== undefined && same(o, r) ? o : r;
  });
  return { rows: [...kept, ...rows], older: kept.length ? prev.older : page.older };
}

/** An earlier page put before what is on screen: its rows not already shown, then the rest; `older` the page's. */
export function prependOlder<T>(prev: Paged<T>, page: Paged<T>, key: (row: T) => string | number): Paged<T> {
  const shown = new Set(prev.rows.map(key));
  return { rows: [...page.rows.filter((r) => !shown.has(key(r))), ...prev.rows], older: Math.min(prev.older, page.older) };
}

/** Whether there is more to load above. */
export const hasOlder = (p: Paged<unknown>): boolean => p.older > 0;

function sameJson<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
