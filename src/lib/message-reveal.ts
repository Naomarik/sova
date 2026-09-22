// Reveal-on-intent for the message-action strips (spec/03 "Message actions").
//
// A strip is always in the DOM, always in the accessibility tree and always tabbable; what the
// reveal changes is whether it is PAINTED and hit-testable — `opacity` plus `pointer-events` in
// base.css, never `display`, so the row keeps its height and nothing moves when one appears.
//
// A mouse reveals a strip by being over the message region and a keyboard by focusing into it:
// both are pure CSS (`:hover` on the host, `:focus-within` on the strip). Touch has neither, so
// this module is the third door — a tap on a message reveals THAT message's strip and keeps it
// revealed until a tap lands on another message or outside every one.
//
// The first tap can never fire an invisible action, and that takes BOTH halves of the design: a
// hidden strip is `pointer-events: none` so the press misses it, and the reveal is applied on the
// `click` the tap produces rather than on `pointerup`. Measured, revealing at pointerup is not
// enough — a touch's compatibility mouse events are synthesised AFTER touchend, so a strip made
// interactive there is hit by the very tap that revealed it, and one tap copied the message.

/** Marks the one host whose strip a tap revealed. base.css reads it; nothing else writes it. */
export const REVEALED_ATTR = "data-actions-revealed";

/** A transcript row, and the wrapper a queued message uses (a queued row is not an `.entry`). */
export const HOST_SELECTOR = ".entry, .message-actions-host";

/** How far a finger may travel and still be a tap rather than the first pixels of a scroll. */
export const TAP_SLOP_PX = 10;

export interface TapPoint {
  /** The PointerEvent's `pointerType`: "mouse" hovers instead, so it never reveals this way. */
  pointerType?: string;
  x: number;
  y: number;
}

/**
 * Whether a press/release pair is a tap that should reveal. A mouse is excluded because hover
 * already answers for it, and a press that travelled was a scroll — a thread scrolled under the
 * thumb must not light up whatever message happened to be beneath it.
 */
export function isRevealTap(start: TapPoint, end: TapPoint): boolean {
  if (start.pointerType === "mouse") return false;
  return Math.abs(end.x - start.x) <= TAP_SLOP_PX && Math.abs(end.y - start.y) <= TAP_SLOP_PX;
}

/**
 * The host a tap should reveal, or null for "reveal nothing". A host only counts when it really
 * holds a strip, so a tap on a tool card or a wake nudge CLEARS the current reveal instead of
 * leaving a strip lit under a message the finger has left.
 */
export function revealHostFor(target: Element | null | undefined): Element | null {
  const host = target?.closest?.(HOST_SELECTOR) ?? null;
  return host && host.querySelector(".message-actions") ? host : null;
}

/** One reveal at a time, so two messages never offer two Remove buttons at once. */
export function setRevealed(root: ParentNode, host: Element | null): void {
  for (const el of Array.from(root.querySelectorAll(`[${REVEALED_ATTR}]`))) {
    if (el !== host) el.removeAttribute(REVEALED_ATTR);
  }
  host?.setAttribute(REVEALED_ATTR, "");
}

/**
 * Listen for taps on `doc` and keep the revealed host up to date. Listeners are passive and on
 * the capture phase: the reveal is a reading of the gesture, never an interception of it, so a
 * tap that was going to press a revealed button still presses it.
 */
export function installMessageReveal(doc: Document): () => void {
  let start: TapPoint | null = null;
  /** The host the finished tap decided on (null clears); `undefined` means no tap is waiting. */
  let pending: Element | null | undefined;
  const hostOf = (target: EventTarget | null) => {
    const el = target as Element | null;
    return revealHostFor(el && typeof el.closest === "function" ? el : null);
  };
  const down = (e: PointerEvent) => {
    start = { pointerType: e.pointerType, x: e.clientX, y: e.clientY };
    pending = undefined;
  };
  const cancel = () => {
    start = null;
    pending = undefined;
  };
  const up = (e: PointerEvent) => {
    const from = start;
    start = null;
    if (!from || !isRevealTap(from, { pointerType: e.pointerType, x: e.clientX, y: e.clientY })) return;
    pending = hostOf(e.target);
  };
  // A scroll ends without a click, so a decision no click came to collect simply expires.
  const click = () => {
    if (pending === undefined) return;
    setRevealed(doc, pending);
    pending = undefined;
  };
  const opts = { capture: true, passive: true } as const;
  doc.addEventListener("pointerdown", down as EventListener, opts);
  doc.addEventListener("pointerup", up as EventListener, opts);
  doc.addEventListener("pointercancel", cancel as EventListener, opts);
  doc.addEventListener("click", click as EventListener, opts);
  return () => {
    doc.removeEventListener("pointerdown", down as EventListener, opts);
    doc.removeEventListener("pointerup", up as EventListener, opts);
    doc.removeEventListener("pointercancel", cancel as EventListener, opts);
    doc.removeEventListener("click", click as EventListener, opts);
  };
}

/** One installation for however many strips are on screen, torn down with the last of them. */
let dispose: (() => void) | undefined;
let holders = 0;

export function acquireMessageReveal(doc: Document | undefined = typeof document === "undefined" ? undefined : document): () => void {
  if (!doc) return () => {};
  if (holders++ === 0) dispose = installMessageReveal(doc);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) {
      dispose?.();
      dispose = undefined;
    }
  };
}
