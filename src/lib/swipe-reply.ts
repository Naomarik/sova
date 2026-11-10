// Swipe a message to reply, on a touch screen (§chat.transcript/reply): the gesture's math, pure,
// so the thresholds and the cases it must leave alone are tested without a browser. The DOM half is
// lib/swipe-reply-dom.ts.

/** How far right the finger must go to stage the reply; the bubble follows no further. */
export const SWIPE_COMMIT_PX = 64;
/** A touch this close to either screen edge is the system's back gesture, never ours. */
export const SWIPE_EDGE_PX = 24;
/** Movement under this is still a press: the gesture hasn't said which way it goes. */
export const SWIPE_SLOP_PX = 8;

/** What is known where the finger went down. */
export interface SwipeStartFacts {
  pointerType: string;
  x: number;
  /** The viewport's width. */
  width: number;
  /** The message offers Reply, and it is on. */
  replyOn: boolean;
  /** Inside an input, a textarea or anything editable. */
  inField: boolean;
  /** Inside an element that scrolls sideways (a code block, a table, wide math). */
  inScroller: boolean;
  /** Text is selected on the page. */
  selecting: boolean;
}

/** Whether a press may become a swipe at all. */
export function canStartSwipe(f: SwipeStartFacts): boolean {
  return (
    f.pointerType === "touch" &&
    f.replyOn &&
    !f.inField &&
    !f.inScroller &&
    !f.selecting &&
    f.x >= SWIPE_EDGE_PX &&
    f.x <= f.width - SWIPE_EDGE_PX
  );
}

/** One press being followed. `mode` is decided once, by the first movement past the slop. */
export interface SwipeTrack {
  x0: number;
  y0: number;
  /** How far right the finger is, never below 0. */
  dx: number;
  mode: "undecided" | "swipe" | "scroll";
  /** Far enough, and sideways enough, that lifting the finger stages the reply. */
  armed: boolean;
}

export const startSwipe = (x: number, y: number): SwipeTrack => ({ x0: x, y0: y, dx: 0, mode: "undecided", armed: false });

/** Sideways enough: more than twice as far across as up or down. */
const sideways = (dx: number, dy: number) => Math.abs(dx) > 2 * Math.abs(dy);

/** The track after the finger moved to (x, y). A gesture that began as anything but a rightward,
    sideways move is a scroll for the rest of the press. */
export function moveSwipe(t: SwipeTrack, x: number, y: number): SwipeTrack {
  if (t.mode === "scroll") return t;
  const dx = x - t.x0;
  const dy = y - t.y0;
  if (t.mode === "undecided") {
    if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return t;
    if (!(dx > 0 && sideways(dx, dy))) return { ...t, mode: "scroll", dx: 0, armed: false };
  }
  const right = Math.max(0, dx);
  return { ...t, mode: "swipe", dx: right, armed: right >= SWIPE_COMMIT_PX && sideways(dx, dy) };
}

/** How far the bubble is drawn to the right: it follows the finger up to the threshold. */
export const swipeOffset = (t: SwipeTrack): number => (t.mode === "swipe" ? Math.min(t.dx, SWIPE_COMMIT_PX) : 0);

/** Whether lifting the finger now stages the reply. */
export const swipeCommits = (t: SwipeTrack): boolean => t.mode === "swipe" && t.armed;

/** Whether this move is the one that reached the threshold: the moment for the short buzz. */
export const justArmed = (before: SwipeTrack, after: SwipeTrack): boolean => !before.armed && after.armed;
