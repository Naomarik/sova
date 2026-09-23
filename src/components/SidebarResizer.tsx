import { onCleanup, onMount } from "solid-js";
import {
  applySidebarWidth,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
} from "../lib/sidebar-width";
import { rememberedWidth, rememberExpandedWidth } from "../lib/spine";

/** Drag handle on the right edge of the sessions pane (≥768px; CSS hides it below that).
 *  It writes `--sidebar-width` on <html> directly — no signal, no persistence, so every
 *  load starts at 320px. Mouse and touch only: there is deliberately no keyboard path.
 *  Unmounted while the pane is collapsed to the spine (App.tsx): its resize listener would
 *  re-clamp the 64px token up to the floor. Every write is remembered so expanding restores it. */
export function SidebarResizer() {
  const root = document.documentElement;

  /** The Subagents pane's own column, but only while it IS a static column (base.css:2705);
   *  below 1280px it overlays the main pane and reserves nothing. */
  const subagentsWidth = () => {
    if (window.innerWidth < 1280) return 0;
    const pane = document.querySelector<HTMLElement>(".app-subagents");
    return pane?.offsetWidth ?? 0;
  };

  /** Current width, read back from the token so a resize re-clamps what's on screen. */
  const currentWidth = () => {
    const raw = parseFloat(getComputedStyle(root).getPropertyValue("--sidebar-width"));
    return Number.isFinite(raw) ? raw : DEFAULT_SIDEBAR_WIDTH;
  };

  let applied = rememberedWidth();
  const setWidth = (width: number) => {
    const next = clampSidebarWidth(width, window.innerWidth, subagentsWidth());
    if (next === applied) return; // Don't thrash: only write when the rounded value changes.
    applied = next;
    applySidebarWidth(root, next);
    rememberExpandedWidth(applied);
  };

  // On mount, plant the remembered width (the default on a fresh load) so a stale inline value —
  // the spine's 64px, say — can never linger.
  onMount(() => applySidebarWidth(root, (applied = rememberedWidth())));

  let handle!: HTMLDivElement;
  let startX = 0;
  let startWidth = DEFAULT_SIDEBAR_WIDTH;
  let dragging = false;

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-resizing");
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault(); // Guard: CSS `touch-action: none` is what really stops touch scrolling.
    startX = e.clientX;
    startWidth = currentWidth();
    dragging = true;
    root.classList.add("is-resizing");
    handle.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    setWidth(startWidth + (e.clientX - startX));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    stop();
  };

  const onDoubleClick = () => setWidth(DEFAULT_SIDEBAR_WIDTH);

  // A shrunk window must not leave the pane past the new max.
  const onResize = () => setWidth(currentWidth());
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  onCleanup(() => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
    root.classList.remove("is-resizing");
  });

  return (
    <div
      ref={handle}
      class="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sessions pane"
      title="Drag to resize · Double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={stop}
      onDblClick={onDoubleClick}
    />
  );
}
