/**
 * A Lookbook card takes the height it needs, so the transcript's estimate for a card not drawn yet is
 * the height this browser last saw it at (per run), or a typical card's when it has never seen it. A
 * card first drawn off screen then lands near its real height, and the rows above it barely move.
 * No DOM beyond an optional localStorage, so it is unit-tested.
 */

const KEY = "sova.lookbook.heights";
/** The runs remembered, newest last. */
const KEEP = 64;
/** A card this browser hasn't drawn yet: a head, the brief's row, a row of 3 designs and the bar. */
export const DESIGN_CARD_TYPICAL = 640;

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

let held: Map<string, number> | null = null;

function heights(store: Store | null = storage()): Map<string, number> {
  if (held) return held;
  held = new Map();
  try {
    const raw = store?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(list)) for (const row of list) if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "number" && row[1] > 0) held.set(row[0], row[1]);
  } catch {
    // A broken entry is forgotten: the next card drawn writes a fresh one.
  }
  return held;
}

/** The px a run's card is estimated at before it is drawn. */
export function designCardEstimate(runId: string | undefined): number {
  return (runId && heights().get(runId)) || DESIGN_CARD_TYPICAL;
}

/** Remember a drawn card's height (whole px). Small changes aren't written: only a height worth estimating with. */
export function rememberDesignCardHeight(runId: string, px: number, store: Store | null = storage()): void {
  const h = Math.round(px);
  if (!runId || !(h > 0)) return;
  const map = heights(store);
  const was = map.get(runId);
  if (was !== undefined && Math.abs(was - h) < 8) return;
  map.delete(runId);
  map.set(runId, h);
  while (map.size > KEEP) map.delete(map.keys().next().value!);
  try {
    store?.setItem(KEY, JSON.stringify([...map]));
  } catch {
    // Storage full or refused: this tab still estimates from memory.
  }
}

/** Tests only: forget what was read. */
export function resetDesignCardHeights(): void {
  held = null;
}
