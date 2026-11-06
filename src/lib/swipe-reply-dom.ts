// Swipe a message to reply (§chat.transcript/reply), the DOM half: one set of pointer listeners on a
// chat's transcript. A swipe that commits presses that message's own Reply button, so it stages
// exactly what Reply does and never acts where Reply is off. The math is lib/swipe-reply.ts.

import { entrySelectors, entryIdOf } from "./jump";
import { canStartSwipe, justArmed, moveSwipe, startSwipe, swipeCommits, swipeOffset, type SwipeTrack } from "./swipe-reply";

/** The class on the bubble while it follows a finger, and the one it adds once the swipe will stage. */
export const SWIPING_CLASS = "message-swiping";
export const SWIPE_ARMED_CLASS = "message-swipe-armed";

/** The Reply button under the entry this row belongs to: its strip hangs off the entry's last text row. */
function replyButtonOf(row: HTMLElement, root: HTMLElement): HTMLButtonElement | null {
  const id = entryIdOf(row.dataset.entry ?? "");
  if (!id) return null;
  const rows = [...root.querySelectorAll<HTMLElement>(entrySelectors(id)[0]!)];
  for (const r of rows.reverse()) {
    const b = r.querySelector<HTMLButtonElement>('.message-action[data-action="reply"]');
    if (b) return b;
  }
  return null;
}

const replyOn = (b: HTMLButtonElement | null): b is HTMLButtonElement => !!b && b.getAttribute("aria-disabled") !== "true";

/** Whether `el`, or anything between it and `stop`, scrolls sideways: a code block, a table, wide math. */
function inSideScroller(el: Element, stop: Element | null): boolean {
  for (let n: Element | null = el; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

/** Follows touch presses on `root`'s message bubbles; returns the teardown. */
export function attachSwipeReply(root: HTMLElement): () => void {
  let track: SwipeTrack | null = null;
  let bubble: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let pointer = -1;
  const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const reset = () => {
    bubble?.classList.remove(SWIPING_CLASS, SWIPE_ARMED_CLASS);
    bubble?.style.removeProperty("--swipe-dx");
    track = null;
    bubble = null;
    button = null;
    pointer = -1;
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || track || !(e.target instanceof Element)) return;
    const target = e.target;
    const row = target.closest<HTMLElement>(".entry[data-entry]");
    const article = target.closest<HTMLElement>("article.message");
    if (!row || !article || !row.contains(article) || !root.contains(row)) return;
    const b = replyButtonOf(row, root);
    const sel = window.getSelection();
    const ok = canStartSwipe({
      pointerType: e.pointerType,
      x: e.clientX,
      width: window.innerWidth,
      replyOn: replyOn(b),
      inField: !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
      inScroller: inSideScroller(target, row),
      selecting: !!sel && !sel.isCollapsed,
    });
    if (!ok) return;
    track = startSwipe(e.clientX, e.clientY);
    bubble = article;
    button = b;
    pointer = e.pointerId;
  };

  const move = (e: PointerEvent) => {
    if (!track || e.pointerId !== pointer || !bubble) return;
    const next = moveSwipe(track, e.clientX, e.clientY);
    if (next.mode === "scroll") return reset();
    if (next.mode === "swipe") {
      bubble.classList.add(SWIPING_CLASS);
      bubble.classList.toggle(SWIPE_ARMED_CLASS, next.armed);
      // With reduced motion the bubble stays put; the icon still says the swipe will stage.
      if (!still()) bubble.style.setProperty("--swipe-dx", `${swipeOffset(next)}px`);
      if (justArmed(track, next)) {
        try {
          navigator.vibrate?.(10);
        } catch {
          // No vibration motor, or not allowed: the icon is the feedback.
        }
      }
    }
    track = next;
  };

  const up = (e: PointerEvent) => {
    if (!track || e.pointerId !== pointer) return;
    const commit = swipeCommits(track);
    const b = button;
    reset();
    // Pressing the message's own Reply: the same staging, focus and announcement, and its reason
    // still holds if it turned off mid-swipe.
    if (commit && replyOn(b)) b.click();
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerId === pointer) reset();
  };

  root.addEventListener("pointerdown", down, { passive: true });
  root.addEventListener("pointermove", move, { passive: true });
  root.addEventListener("pointerup", up, { passive: true });
  root.addEventListener("pointercancel", cancel, { passive: true });
  return () => {
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", up);
    root.removeEventListener("pointercancel", cancel);
    reset();
  };
}
