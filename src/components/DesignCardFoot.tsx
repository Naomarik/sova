import { onCleanup, onMount, type JSX } from "solid-js";

/**
 * The transcript's floating controls (Jump to Latest, the wait note, Focus) lift above a pinned bar,
 * so none of them ever covers it. Per transcript, the tallest pinned bar wins.
 */
const pinned = new WeakMap<HTMLElement, Map<HTMLElement, number>>();
/** How far up from the chat's bottom edge its floating controls reach (Jump to Latest: 16px + 44px, and room). */
const FLOAT_BAND = 96;

function lift(wrap: HTMLElement, foot: HTMLElement, px: number | null): void {
  let bars = pinned.get(wrap);
  if (!bars) pinned.set(wrap, (bars = new Map()));
  if (px === null) bars.delete(foot);
  else bars.set(foot, px);
  const most = Math.max(0, ...bars.values());
  if (most > 0) {
    wrap.style.setProperty("--design-pinned-h", `${Math.round(most)}px`);
    wrap.setAttribute("data-design-pinned", "");
  } else {
    wrap.style.removeProperty("--design-pinned-h");
    wrap.removeAttribute("data-design-pinned");
  }
}

/**
 * A Lookbook card's bottom bar. It sticks to the bottom of the transcript while the card is in view
 * (the card grows to fit, so it can be taller than the screen) and sits at the card's end otherwise.
 * `data-pinned` says which, for its shadow; nothing about its size changes.
 */
export function DesignCardFoot(props: { class?: string; label?: string; children: JSX.Element }) {
  let foot!: HTMLDivElement;
  onMount(() => {
    const card = foot.closest<HTMLElement>(".design-card");
    const wrap = foot.closest<HTMLElement>(".transcript-wrap");
    if (!card) return;
    let frame = 0;
    let was: boolean | null = null;
    const check = () => {
      frame = 0;
      if (!foot.isConnected) return;
      const f = foot.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      // Stuck: the bar sits above the card's own end.
      const now = f.height > 0 && c.bottom - f.bottom > 1;
      if (now !== was) foot.toggleAttribute("data-pinned", now);
      was = now;
      // The floating controls lift whenever the bar is in their band at the bottom of the chat, stuck
      // there or simply scrolled to it, so they never cover it.
      if (wrap) {
        const w = wrap.getBoundingClientRect();
        const inBand = f.height > 0 && f.top < w.bottom && f.bottom > w.bottom - FLOAT_BAND;
        lift(wrap, foot, inBand ? w.bottom - f.top : null);
      }
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    document.addEventListener("scroll", soon, { capture: true, passive: true });
    const ro = new ResizeObserver(soon);
    ro.observe(card);
    if (wrap) ro.observe(wrap);
    soon();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", soon, true);
      ro.disconnect();
      if (wrap) lift(wrap, foot, null);
    });
  });
  return (
    <div ref={foot} class={`card-foot design-card-foot${props.class ? ` ${props.class}` : ""}`} role={props.label ? "group" : undefined} aria-label={props.label}>
      {props.children}
    </div>
  );
}
