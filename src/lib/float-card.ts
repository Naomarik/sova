// Where a small floating readout card goes: always above the pointer, centred on it, never
// trailing it (§app.insights/velocity-scrub). The drag ghost keeps its own placement
// (`ghostPlacement` in drag-overlay.ts), which trails a mouse. Pure, so it is tested bare.

export interface FloatPoint {
  x: number;
  y: number;
}

/** How far the card's bottom edge sits above a mouse pointer's tip. */
export const FLOAT_GAP_MOUSE = 14;
/** And above a fingertip or pen: clear of the finger's own pad. */
export const FLOAT_GAP_TOUCH = 40;
/** The least room it keeps from the window's edges. */
export const FLOAT_MARGIN = 8;

/**
 * The card's top-left for a pointer at `p`: centred on its x and `gap` pixels above it, kept
 * `FLOAT_MARGIN` inside the window's left and right edges. Only when it can't fit above (the
 * window's top) does it go `gap` pixels below instead.
 */
export function floatAbove(p: FloatPoint, size: { width: number; height: number }, view: { width: number; height: number }, gap: number): FloatPoint {
  const x = Math.max(FLOAT_MARGIN, Math.min(p.x - size.width / 2, view.width - FLOAT_MARGIN - size.width));
  let y = p.y - gap - size.height;
  if (y < FLOAT_MARGIN) y = p.y + gap;
  return { x: Math.round(x), y: Math.round(y) };
}
