/**
 * A card's bottom bar that sticks to the bottom of the transcript while its card is in view (CSS:
 * `position: sticky; bottom: 0`), for a card that grows taller than the screen: a Lookbook card's
 * bar, a playbook setup card's buttons. This watches it: `data-pinned` on the bar while it sits above
 * its card's own end (for its shadow), and the transcript's floating controls (Jump to Latest, the
 * wait note, Focus) lift above it, so none of them ever covers it. Per transcript, the tallest
 * pinned bar wins. DOM only; no Solid.
 */
const pinned = new WeakMap<HTMLElement, Map<HTMLElement, number>>();
/** How far up from the chat's bottom edge its floating controls reach (Jump to Latest: 16px + 44px, and room). */
const FLOAT_BAND = 96;

function lift(wrap: HTMLElement, bar: HTMLElement, px: number | null): void {
  let bars = pinned.get(wrap);
  if (!bars) pinned.set(wrap, (bars = new Map()));
  if (px === null) bars.delete(bar);
  else bars.set(bar, px);
  const most = Math.max(0, ...bars.values());
  if (most > 0) {
    wrap.style.setProperty("--design-pinned-h", `${Math.round(most)}px`);
    wrap.setAttribute("data-design-pinned", "");
  } else {
    wrap.style.removeProperty("--design-pinned-h");
    wrap.removeAttribute("data-design-pinned");
  }
}

/** Watches `bar`, the bottom bar of `card`, until the returned function is called. */
export function watchPinnedBar(bar: HTMLElement, card: HTMLElement): () => void {
  const wrap = bar.closest<HTMLElement>(".transcript-wrap");
  let frame = 0;
  let was: boolean | null = null;
  const check = () => {
    frame = 0;
    if (!bar.isConnected) return;
    const f = bar.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    // Stuck: the bar sits above the card's own end.
    const now = f.height > 0 && c.bottom - f.bottom > 1;
    if (now !== was) bar.toggleAttribute("data-pinned", now);
    was = now;
    // The floating controls lift whenever the bar is in their band at the bottom of the chat, stuck
    // there or simply scrolled to it, so they never cover it.
    if (wrap) {
      const w = wrap.getBoundingClientRect();
      const inBand = f.height > 0 && f.top < w.bottom && f.bottom > w.bottom - FLOAT_BAND;
      lift(wrap, bar, inBand ? w.bottom - f.top : null);
    }
  };
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  document.addEventListener("scroll", soon, { capture: true, passive: true });
  const ro = new ResizeObserver(soon);
  ro.observe(card);
  ro.observe(bar);
  if (wrap) ro.observe(wrap);
  soon();
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("scroll", soon, true);
    ro.disconnect();
    bar.removeAttribute("data-pinned");
    if (wrap) lift(wrap, bar, null);
  };
}
