// A toast's shape and its clock, kept apart from the stack's signal (ui-state.ts) and its renderer
// (ui.tsx) so the rules run under `tsx --test`.
//
// Every toast goes by itself. One with an action ("Undo") waits longer, 6s against 3s, and its
// countdown pauses while the pointer is over it or focus is inside it, so reaching Undo never
// races the clock. This deliberately overrides the design skill's older "never auto-dismiss a
// toast with an action": stuck Undo toasts piled up, one per archive.

export interface ToastAction {
  /** Title Case, one word where it can be: "Undo". */
  label: string;
  run(): void | Promise<void>;
}

export interface ToastOptions {
  action?: ToastAction;
  /** A new toast with the same key replaces the one on screen: one archive's Undo at a time. */
  key?: string;
}

export interface Toast {
  id: number;
  text: string;
  action?: ToastAction;
  key?: string;
  /** Milliseconds on screen, not counting time paused under the pointer or focus. */
  timeout: number;
}

export const TOAST_MS = 3000;
export const ACTION_TOAST_MS = 6000;

export function makeToast(id: number, text: string, options?: ToastOptions): Toast {
  const t: Toast = { id, text, timeout: options?.action ? ACTION_TOAST_MS : TOAST_MS };
  if (options?.action) t.action = options.action;
  if (options?.key) t.key = options.key;
  return t;
}

/** The stack with `t` added last, after dropping any toast that shares its key. */
export function placeToast(list: readonly Toast[], t: Toast): Toast[] {
  const kept = t.key ? list.filter((x) => x.key !== t.key) : list;
  return [...kept, t];
}

// ---------------------------------------------------------------------------
// The countdown: time left across any number of pauses. `now` is passed in, so the arithmetic is
// testable; the renderer passes performance.now().
// ---------------------------------------------------------------------------

export interface Countdown {
  /** Time left as of `since`. */
  left: number;
  /** When the clock last started running, or null while paused. */
  since: number | null;
}

export const startCountdown = (ms: number, now: number): Countdown => ({ left: ms, since: now });

/** Milliseconds left at `now`, never below 0. */
export const remaining = (c: Countdown, now: number): number => Math.max(0, c.since === null ? c.left : c.left - (now - c.since));

/** Stops the clock, keeping what was left. Pausing a paused clock changes nothing. */
export const pauseCountdown = (c: Countdown, now: number): Countdown => (c.since === null ? c : { left: remaining(c, now), since: null });

/** Starts the clock again from what was left, not from the full time. */
export const resumeCountdown = (c: Countdown, now: number): Countdown => (c.since === null ? { left: c.left, since: now } : c);
