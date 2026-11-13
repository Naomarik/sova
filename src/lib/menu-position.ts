// Where a menu panel goes (§app.context-menus/placement): under an ActionMenu trigger or with its corner
// at the pointer (a right-click). Pure, so the math runs under `pnpm test` with no window:
// ActionMenu's panel reads the viewport and its own measured box, and hands them here.

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
export const EDGE_GAP = 8;
export const TRIGGER_GAP = 4;
/** A panel squeezed below this scrolls and overlaps the trigger rather than becoming a sliver. */
export const MIN_PANEL_HEIGHT = 140;

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * What the panel hangs from. `rect`: an element's box, the panel below it (or above when it
 * doesn't fit), lined up with its `start` or `end` edge. `point`: a pointer, the panel's corner on
 * it, below and to its right when that fits, flipped up or left when it doesn't.
 */
export type MenuAnchor = { kind: "rect"; rect: RectLike; align: "start" | "end" } | { kind: "point"; x: number; y: number };

export interface Viewport {
  width: number;
  height: number;
}

/** The room to give the panel before it is measured (`--menu-max`): the larger side's. */
export function menuRoom(anchor: MenuAnchor, view: Viewport): number {
  const { below, above } = sides(anchor, view);
  return Math.round(Math.max(below, above, MIN_PANEL_HEIGHT));
}

/**
 * Where the measured panel goes (`--menu-top`, `--menu-left`). The preferred side when it fits,
 * else the other one, then clamped into the window on both axes: the clamps are what hold in the
 * cases a preference can't cover (an anchor near an edge, a window smaller than the panel).
 * `spanLeft`: the panel spans an element (ActionMenu's `span`) and starts at its left edge.
 */
export function menuSpot(anchor: MenuAnchor, box: { width: number; height: number }, view: Viewport, spanLeft?: number | null): { top: number; left: number } {
  const { below } = sides(anchor, view);
  let top: number;
  let left: number;
  if (anchor.kind === "rect") {
    const r = anchor.rect;
    top = box.height <= below ? r.bottom + TRIGGER_GAP : r.top - TRIGGER_GAP - box.height;
    left = spanLeft != null ? spanLeft + EDGE_GAP : anchor.align === "start" ? r.left : r.right - box.width;
  } else {
    top = box.height <= below ? anchor.y : anchor.y - box.height;
    left = box.width <= view.width - EDGE_GAP - anchor.x ? anchor.x : anchor.x - box.width;
  }
  const maxTop = Math.max(EDGE_GAP, view.height - EDGE_GAP - box.height);
  const maxLeft = Math.max(EDGE_GAP, view.width - EDGE_GAP - box.width);
  return { top: Math.round(Math.min(Math.max(top, EDGE_GAP), maxTop)), left: Math.round(Math.min(Math.max(left, EDGE_GAP), maxLeft)) };
}

function sides(anchor: MenuAnchor, view: Viewport): { below: number; above: number } {
  if (anchor.kind === "rect") return { below: view.height - EDGE_GAP - (anchor.rect.bottom + TRIGGER_GAP), above: anchor.rect.top - TRIGGER_GAP - EDGE_GAP };
  return { below: view.height - EDGE_GAP - anchor.y, above: anchor.y - EDGE_GAP };
}
