// The `.tabs` edge fade, for a browser with no scroll timelines (Firefox). base.css draws the fade
// from the strip's own scroll where it can; here it draws from `data-overflow-start` and
// `data-overflow-end`, which this sets on every `.tabs` strip while tabs are hidden past that edge.
// Installed once at start; where scroll timelines exist it does nothing. Pure but for
// `installTabsOverflow`.

/** Which edges of a strip have content hidden past them (1px of slack for subpixel widths). */
export function tabsOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  const left = Math.abs(scrollLeft);
  return { start: left > 1, end: scrollWidth - clientWidth - left > 1 };
}

function measure(strip: Element): void {
  const { start, end } = tabsOverflow(strip.scrollLeft, strip.scrollWidth, strip.clientWidth);
  strip.toggleAttribute("data-overflow-start", start);
  strip.toggleAttribute("data-overflow-end", end);
}

/** Track every `.tabs` strip, now and as they mount; once at start. */
export function installTabsOverflow(doc: Document = document): void {
  if (typeof CSS === "undefined" || CSS.supports("animation-timeline: scroll()")) return;
  const tracked = new WeakSet<Element>();
  // A strip or one of its tabs changing size: the strip's width or its content's.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const strip = e.target.closest(".tabs");
      if (strip) measure(strip);
    }
  });
  const track = (strip: Element) => {
    for (const tab of strip.children) ro.observe(tab);
    if (tracked.has(strip)) return measure(strip);
    tracked.add(strip);
    ro.observe(strip);
    measure(strip);
  };
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    const strip = node.closest(".tabs");
    if (strip) track(strip);
    for (const s of node.querySelectorAll(".tabs")) track(s);
  };
  // Scroll doesn't bubble; a capturing listener on the document hears every strip's.
  doc.addEventListener("scroll", (e) => e.target instanceof Element && e.target.matches(".tabs") && measure(e.target), { capture: true, passive: true });
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) scan(n);
  }).observe(doc.documentElement, { childList: true, subtree: true });
  scan(doc.documentElement);
}
