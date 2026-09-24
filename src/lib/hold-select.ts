// Press-and-hold on a session row: the
// gesture that turns one row into a selection, on a mouse and under a thumb alike. Framework-free
// and clock-injected, so the rules below are testable without a browser — the row wires real
// pointer events to `start`/`move`/`finish`/`cancel` and asks `suppressed()` what to do with the
// click and the context menu the hold leaves behind.

/** How long a press has to stay put to become a selection. Long enough not to fire on a click. */
export const HOLD_MS = 500;
/** How far the pointer may drift and still be the same press — a thumb is never perfectly still. */
export const HOLD_MOVE_PX = 10;
/**
 * How long AFTER THE PRESS IS RELEASED the click and context menu a fired hold produced are
 * ignored. A press-hold ends in a `click` (and on touch a `contextmenu` that arrives BEFORE the
 * pointerup), and neither must reach the row's link: the hold already did something, and
 * navigating on top of it would undo it. A window, not a one-shot consume, because how many of
 * those two events arrive — and in which order — differs per platform.
 *
 * It runs from the RELEASE, never from the moment the hold fired. A press may be held for as long
 * as the user likes; a window started when it fired would have run out by the time the finger came
 * up, and the click would reach the row and toggle it straight back off. A 3s press is an ordinary
 * press, not a special case.
 */
export const HOLD_SUPPRESS_MS = 1000;

export interface HoldPoint {
  x: number;
  y: number;
}

export interface HoldOptions {
  /** Fired once, in place, when the press has outlasted `delayMs` without moving. */
  onHold(): void;
  delayMs?: number;
  tolerance?: number;
  /** Injectable clock: the tests run the whole gesture without a timer or a browser. */
  now?(): number;
  schedule?(fn: () => void, ms: number): unknown;
  unschedule?(handle: unknown): void;
}

export interface HoldGesture {
  /** A press began at this point. Clears any suppression the previous press left. */
  start(at: HoldPoint): void;
  /** The pointer moved; past the tolerance this press can no longer become a hold. */
  move(at: HoldPoint): void;
  /** The press is off — a scroll, a pointercancel, a dragstart, the pointer leaving the row, the
      window losing focus, an unmount. A cancel AFTER the hold fired still opens the suppression
      window: some of those paths still deliver a click, and it is still the hold's echo. */
  cancel(): void;
  /** The press ended. True when it had already become a hold (so its click is to be ignored). */
  finish(): boolean;
  /** Whether the click or context menu arriving now belongs to a hold that already fired: true for
      as long as that press is still down, and for `HOLD_SUPPRESS_MS` after it is released. */
  suppressed(): boolean;
  /** Whether the hold has fired for the press in flight. */
  held(): boolean;
}

export function createHoldGesture(opts: HoldOptions): HoldGesture {
  const delayMs = opts.delayMs ?? HOLD_MS;
  const tolerance = opts.tolerance ?? HOLD_MOVE_PX;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = opts.unschedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let origin: HoldPoint | null = null;
  /** The hold fired for the press that is down — or was, until `releasedAt` was stamped. */
  let fired = false;
  /** A press is down right now. Kept apart from `origin`, which a move past the tolerance clears. */
  let pressing = false;
  /** When a FIRED press let go. The suppression window runs from here, and only from here. */
  let releasedAt: number | null = null;

  const stopTimer = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };
  /**
   * Every way a press ends, in one place: a press that fired leaves a window behind, one that
   * never did leaves nothing. IDEMPOTENT — a press ends once, however many of the events that can
   * end it arrive (a pointerup and a lostpointercapture, a cancel and then a finish). Re-stamping
   * `releasedAt` on the second one would quietly extend the suppression window past the click it
   * was opened for.
   */
  const release = (): boolean => {
    stopTimer();
    origin = null;
    if (pressing) {
      pressing = false;
      if (fired) releasedAt = now();
    }
    return fired;
  };

  return {
    start(at) {
      stopTimer();
      origin = at;
      pressing = true;
      fired = false;
      releasedAt = null; // a new press is not the old press's aftermath
      timer = schedule(() => {
        timer = null;
        if (!origin) return;
        fired = true;
        opts.onHold();
      }, delayMs);
    },
    move(at) {
      if (!origin || fired) return; // no press to speak of, or the hold already fired
      if (Math.abs(at.x - origin.x) <= tolerance && Math.abs(at.y - origin.y) <= tolerance) return;
      stopTimer();
      origin = null; // moved: this press is a drag or a scroll, never a selection
    },
    cancel() {
      release();
    },
    finish() {
      return release();
    },
    suppressed() {
      // While the press is still down there is no window to run out: a hold may be held all day.
      if (fired && pressing) return true;
      return releasedAt !== null && now() - releasedAt <= HOLD_SUPPRESS_MS;
    },
    held() {
      return fired && pressing;
    },
  };
}
