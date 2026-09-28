import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";

/**
 * The width a View has to draw in, from a ResizeObserver on its wrapper: 0 until measured. Flow and
 * sequence re-lay out for a narrow pane instead of only shrinking and scrolling.
 */
export function useWidth(): [Accessor<number>, (el: HTMLElement) => void] {
  const [width, setWidth] = createSignal(0);
  let el: HTMLElement | undefined;
  onMount(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el!.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    onCleanup(() => ro.disconnect());
  });
  return [width, (e) => (el = e)];
}

// Bumped when a web font finishes loading. canvasMeasure drops its cached widths then
// (core/text.ts), so a layout that reads this re-measures its text in the real font.
const [fonts, setFonts] = createSignal(0);
if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", () => setFonts((n) => n + 1));
/** Read inside a layout memo: it re-runs once the fonts its text is measured in have loaded. */
export const fontsLoaded = fonts;
