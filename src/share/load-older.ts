import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * Earlier pages as the reader nears the top (§app.owner-page/content): a sentinel above the list's first row; when it
 * comes into view and there is more, the page loads the next earlier page and keeps what the reader was looking at
 * where it was (the scroll position grows by exactly what was added above). Works in the window (the owner page) and
 * in a scrolling box (the operator's preview modal).
 */

/** The nearest ancestor that scrolls, else the document's own scroller. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function createOlderLoader(opts: {
  /** The element above the first row. */
  sentinel: Accessor<HTMLElement | undefined>;
  /** Whether there is more to load. The view arms it only once it scrolled to its newest row, so the sentinel seen
      at the top of a page still being drawn loads nothing. */
  more: Accessor<boolean>;
  /** Load and show the next earlier page; false when it failed. */
  load(): Promise<boolean>;
}): { loading: Accessor<boolean>; failed: Accessor<boolean>; retry(): void } {
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let visible = false;
  const run = async () => {
    const el = opts.sentinel();
    if (!el || loading() || failed() || !opts.more()) return;
    const box = scrollerOf(el);
    const h0 = box.scrollHeight;
    const t0 = box.scrollTop;
    setLoading(true);
    const ok = await opts.load().catch(() => false);
    setLoading(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    // After the rows drew: what was on screen stays where it was.
    requestAnimationFrame(() => {
      box.scrollTop = t0 + (box.scrollHeight - h0);
      // Still at the top (a short page, or a fast scroll): the next page too.
      requestAnimationFrame(() => {
        if (visible) void run();
      });
    });
  };
  createEffect(() => {
    const el = opts.sentinel();
    // Re-observed whenever there is more again (armed, or after a page), so a sentinel already in view fires.
    if (!el || !opts.more() || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (visible) void run();
      },
      { rootMargin: "400px 0px 0px 0px" },
    );
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
  return {
    loading,
    failed,
    retry: () => {
      setFailed(false);
      void run();
    },
  };
}
