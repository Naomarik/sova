// Holding the line the reader is on while rows change above it (Thread `ThreadScroller`): the row
// to hold, and how far to scroll to put it back. The correction is the row's own measured move,
// never one derived from `scrollHeight`, which is rounded to a whole CSS pixel and so leaves a
// fraction behind that differs from one change to the next: at a device pixel ratio that isn't
// whole, the view stepped by a device pixel at every chunk of rows built above it.

/** A row's box, as `getBoundingClientRect` gives it. */
export interface RowBox {
  top: number;
  bottom: number;
}

/**
 * The scroll that puts a row moved from `before` to `after` (its measured tops) back where it was:
 * the move itself, once it is at least half a device pixel at `dpr`, the least the screen can show;
 * 0 for less, so a view already in place is never written to.
 */
export function anchorCorrection(before: number, after: number, dpr: number): number {
  const delta = after - before;
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.abs(delta) * scale >= 0.5 ? delta : 0;
}

/**
 * The row to hold among `n` rows in page order: the last drawn one (with a height) whose top is at
 * or above `viewTop`, the row the view's top is in; failing that (the view's top is above every
 * row), the first drawn one. -1 when none is drawn. Read from the end, where a view being filled
 * from above sits, so it measures the rows below the view's top and stops; rows that draw nothing
 * (no box at all) are passed over.
 */
export function anchorIndex(n: number, box: (i: number) => RowBox, viewTop: number): number {
  let first = -1;
  for (let i = n - 1; i >= 0; i--) {
    const b = box(i);
    if (b.bottom - b.top <= 0) continue;
    if (b.top <= viewTop) return i;
    first = i;
  }
  return first;
}
