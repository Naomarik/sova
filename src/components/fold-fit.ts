import { onCleanup } from "solid-js";
import { shouldFold } from "../lib/name-fit";

/**
 * Keeps a row's mode icons folded exactly while the unfolded row doesn't fit (src/lib/name-fit.ts).
 * `row` is the box watched for size and content changes; `target()` the element that carries
 * `data-folded` (its CSS hides every mode icon but the first and shows the "+N"); `boxes()` the
 * elements whose overflow counts (the name, the trigger, the row); `modes()` how many mode icons
 * the target draws. Each check unfolds, measures and refolds in one synchronous pass, before paint,
 * so nothing flickers and the decision is the same for the same width.
 */
export function foldFit(row: HTMLElement, opts: { target: () => HTMLElement | null; boxes: () => (HTMLElement | null)[]; modes: () => number }) {
  let busy = false;
  const check = () => {
    const target = opts.target();
    if (!target || busy) return;
    busy = true;
    target.removeAttribute("data-folded");
    if (shouldFold(opts.boxes(), opts.modes())) target.setAttribute("data-folded", "");
    busy = false;
  };
  const ro = new ResizeObserver(check);
  // Content changes (a model or mode switch, a login chip appearing) change what has to fit.
  // Attributes aren't watched, so setting data-folded never feeds the check back.
  const mo = new MutationObserver(check);
  ro.observe(row);
  mo.observe(row, { childList: true, subtree: true, characterData: true });
  void document.fonts?.ready.then(check);
  queueMicrotask(check);
  onCleanup(() => {
    ro.disconnect();
    mo.disconnect();
  });
}
