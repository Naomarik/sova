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
