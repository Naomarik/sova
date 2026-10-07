// A touch press on a voice control (§chat.voice/button) moves no focus. Android Chrome re-shows a
// focused textarea's keyboard after any tap the page lets through, even one whose pointerdown was
// cancelled. A cancelled touchstart means no tap at all (no focus step, no click), so the control
// runs its action on touchend itself. Mouse and keyboard keep the plain click.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether a finger lifted at (x, y) is still on the control: a tap, not a slide off it. */
export const liftedInside = (box: Box, x: number, y: number): boolean => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/**
 * Wires `el`'s touch path: `run` fires once per one-finger touch that lifts inside it. Listeners
 * are on the element itself and non-passive, since Solid delegates to the document, where Chrome
 * makes touch listeners passive. Returns the detach.
 */
export function touchPress(el: HTMLElement, run: () => void): () => void {
  let armed = false;
  const start = (e: TouchEvent) => {
    e.preventDefault();
    armed = e.touches.length === 1;
  };
  const end = (e: TouchEvent) => {
    e.preventDefault();
    if (!armed || e.touches.length > 0) return;
    armed = false;
    const t = e.changedTouches[0];
    if (t && liftedInside(el.getBoundingClientRect(), t.clientX, t.clientY)) run();
  };
  const cancel = () => {
    armed = false;
  };
  el.addEventListener("touchstart", start, { passive: false });
  el.addEventListener("touchend", end, { passive: false });
  el.addEventListener("touchcancel", cancel);
  return () => {
    el.removeEventListener("touchstart", start);
    el.removeEventListener("touchend", end);
    el.removeEventListener("touchcancel", cancel);
  };
}

/** A click's press kind: a touch click only reaches here if the touch path didn't take it. */
export const clickWasTouch = (e: MouseEvent): boolean => (e as PointerEvent).pointerType === "touch";
