// Only the user scrolls the session list (§app.session-list/content-rules, "Only the user scrolls the list").
//
// The list is keyed (lib/for-key), so a refresh updates rows in place. This is the safety net under that, on every
// browser alike (iOS Safari has no CSS scroll anchoring of its own): the list remembers the first row on screen and
// where it sat, and after any change to the list's DOM — rows arriving or leaving above, a section opening or closing
// on its own, a search ending — puts that row back where it was. The browser's own anchoring is turned off on the
// list, so there is exactly one rule. A section head the user presses is what holds still through that toggle. A row
// that is gone leaves the list alone, and so does a list scrolled to its very top: it stays at the top. The side
// strip's region press scrolls with `scrollIntoView`: that is a scroll, and the list takes it as the new place.

/** What a correction needs, measured after a change. All px; offsets are from the list's top edge. */
export interface HoldReading {
  /** Where the anchor sat when it was last recorded. */
  offset: number;
  /** Where it sits now. */
  now: number;
  /** The list's scrollTop when the anchor was recorded, and now. */
  savedScrollTop: number;
  scrollTop: number;
  /** scrollHeight − clientHeight now. */
  maxScrollTop: number;
  /** The user is scrolling, or just did (a wheel, a finger and its fling, a scroll key, the scrollbar). */
  userScrolling: boolean;
}

/**
 * How far to scroll the list (added to scrollTop) to put the anchor back; 0 for nothing. A list recorded at its very
 * top stays there. While the user is scrolling, what the list has moved by since the anchor was recorded is theirs
 * (unless it is the browser clamping a shortened list at its end): the anchor is expected to have moved by exactly
 * that much, so only the rest is corrected. Otherwise any move is not the user's — a rebuild that shortened the list
 * for a moment and had the browser clamp it, say — and the anchor goes back all the way.
 */
export function holdCorrection(r: HoldReading): number {
  if (r.savedScrollTop <= 0) return 0;
  const moved = r.scrollTop - r.savedScrollTop;
  const clamped = moved < 0 && r.scrollTop >= r.maxScrollTop - 0.5;
  const want = r.offset - (r.userScrolling && !clamped ? moved : 0);
  const d = r.now - want;
  return Math.abs(d) < 0.5 ? 0 : d;
}

/** What can anchor: rows first, a section head only where no row is on screen. */
const ROWS = "a.list-row";
const HEADS = "summary";

const boxed = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.height > 0 || r.width > 0;
};

/** The first element of `all` (document order, so top to bottom) whose bottom is below `top`. Binary search, stepping
    over elements a closed section hides (no box). */
function firstBelow(all: readonly Element[], top: number): Element | null {
  const next = (i: number): number => {
    while (i < all.length && !boxed(all[i]!)) i++;
    return i;
  };
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const j = next(mid);
    if (j >= all.length) hi = mid;
    else if (all[j]!.getBoundingClientRect().bottom > top) hi = mid;
    else lo = j + 1;
  }
  const j = next(lo);
  return j < all.length ? all[j]! : null;
}

/** The list's child an element sits in: its region. */
function regionOf(list: HTMLElement, el: Element): Element | null {
  let r: Element | null = el;
  while (r && r.parentElement !== list) r = r.parentElement;
  return r;
}

/** Equal elements in one region: rows by href, heads by their words without the count. */
const sameAs = (el: Element): string => (el.matches(ROWS) ? `row ${el.getAttribute("href")}` : `head ${el.textContent?.replace(/[\d\s·]+$/, "").trim()}`);
function peersIn(region: Element, el: Element): Element[] {
  if (el.matches(ROWS)) {
    const href = el.getAttribute("href");
    return href ? [...region.querySelectorAll(`${ROWS}[href="${CSS.escape(href)}"]`)] : [];
  }
  const want = sameAs(el);
  return [...region.querySelectorAll(el.tagName.toLowerCase())].filter((x) => sameAs(x) === want);
}

/** A key that finds the element again if it was ever rebuilt: its region's class and place among its likes, what it
    is, and which of the equal ones in that region. */
function keyOf(list: HTMLElement, el: Element): string {
  const region = regionOf(list, el);
  if (!region) return "";
  const nth = [...list.children].filter((c) => c.className === region.className).indexOf(region);
  return `${region.className}#${nth}|${sameAs(el)}|${peersIn(region, el).indexOf(el)}`;
}
function findByKey(list: HTMLElement, key: string, like: Element): Element | null {
  for (const el of list.querySelectorAll(like.matches(ROWS) ? ROWS : like.tagName.toLowerCase())) if (keyOf(list, el) === key) return el;
  return null;
}

/** The row focus goes to when it comes back to the list without moving it: the open session's row if one is on
    screen, else the first row on screen; null when no row is. */
export function rowOnScreen(list: HTMLElement): HTMLElement | null {
  const box = list.getBoundingClientRect();
  const on = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (r.height > 0 || r.width > 0) && r.bottom > box.top + 1 && r.top < box.bottom - 1;
  };
  const current = [...list.querySelectorAll<HTMLElement>('a.session-row[aria-current="page"]')].find(on);
  return current ?? [...list.querySelectorAll<HTMLElement>("a.session-row")].find(on) ?? null;
}

/** Holds the list still (`list` is the scrolling element, `.sidebar-list`). Returns the disposer. */
export function holdListScroll(list: HTMLElement): () => void {
  list.style.overflowAnchor = "none";
  let anchor: { el: Element; key: string; offset: number } | null = null;
  let savedScrollTop = list.scrollTop;
  const top = () => list.getBoundingClientRect().top;
  /** Hidden (a phone's open session puts the list away): nothing to measure, and the place is kept for its return. */
  const hidden = () => !list.isConnected || list.clientHeight === 0;
  // The user's own scrolling, by its inputs: a scroll event alone can't say whose it is.
  let touching = false;
  let dragging = false;
  let intentUntil = 0;
  const intent = (ms: number) => (intentUntil = Math.max(intentUntil, performance.now() + ms));
  const userScrolling = () => touching || dragging || performance.now() < intentUntil;
  const record = (el: Element | null) => {
    savedScrollTop = list.scrollTop;
    anchor = el ? { el, key: keyOf(list, el), offset: el.getBoundingClientRect().top - top() } : null;
  };
  /** The first row on screen (a head where there is none). */
  const pick = () => {
    if (hidden()) return;
    const t = top();
    const row = firstBelow([...list.querySelectorAll(ROWS)], t);
    if (row && row.getBoundingClientRect().top < list.getBoundingClientRect().bottom) return record(row);
    record(firstBelow([...list.querySelectorAll(HEADS)], t));
  };

  /** The user's own toggle: the head they pressed holds still, not the first row. A project's fold button folds the
      project under its head. */
  const pressHead = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null;
    const head = el?.closest(".project-fold")?.closest(".org-project-head") ?? el?.closest(HEADS);
    if (head && list.contains(head)) record(head);
  };
  const onScroll = () => pick();
  const onPointerDown = (e: PointerEvent) => {
    // The list itself under the pointer is its scrollbar.
    if (e.target === list) dragging = true;
    pressHead(e.target);
  };
  const onPointerUp = () => {
    if (dragging) intent(250);
    dragging = false;
  };
  const onWheel = () => intent(300);
  const onTouchStart = () => (touching = true);
  // A fling keeps scrolling after the finger lifts.
  const onTouchEnd = () => {
    touching = false;
    intent(2500);
  };
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") pressHead(e.target);
    if (SCROLL_KEYS.has(e.key)) intent(600);
  };

  const restore = () => {
    if (hidden()) return;
    const a = anchor;
    if (!a) return pick();
    const el = a.el.isConnected && list.contains(a.el) ? a.el : findByKey(list, a.key, a.el);
    // The row is gone: nothing to hold, and nothing moves.
    if (!el) return pick();
    const d = holdCorrection({
      offset: a.offset,
      now: el.getBoundingClientRect().top - top(),
      savedScrollTop,
      scrollTop: list.scrollTop,
      maxScrollTop: list.scrollHeight - list.clientHeight,
      userScrolling: userScrolling(),
    });
    if (d !== 0) list.scrollTop += d;
    // Keep holding the same row: a burst of changes holds one place, not a drifting one.
    if (list.scrollTop <= 0) return pick();
    savedScrollTop = list.scrollTop;
    anchor = { el, key: a.el === el ? a.key : keyOf(list, el), offset: el.getBoundingClientRect().top - top() };
  };

  const mo = new MutationObserver(restore);
  mo.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "class", "hidden"] });
  // A narrower or wider list rewraps every row: what is on screen after that is the new place. A list coming back
  // from hidden is held where it was instead, whatever the browser kept of its scroll.
  let wasHidden = hidden();
  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const back = wasHidden && !hidden();
          wasHidden = hidden();
          if (back) restore();
          else pick();
        })
      : null;
  ro?.observe(list);
  const on: [string, EventListener, AddEventListenerOptions][] = [
    ["scroll", onScroll, { passive: true }],
    ["pointerdown", onPointerDown as EventListener, { capture: true, passive: true }],
    ["wheel", onWheel, { passive: true }],
    ["touchstart", onTouchStart, { passive: true }],
    ["touchend", onTouchEnd, { passive: true }],
    ["touchcancel", onTouchEnd, { passive: true }],
    ["keydown", onKeyDown as EventListener, { capture: true }],
  ];
  for (const [t, f, o] of on) list.addEventListener(t, f, o);
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  pick();
  return () => {
    mo.disconnect();
    ro?.disconnect();
    for (const [t, f, o] of on) list.removeEventListener(t, f, o);
    window.removeEventListener("pointerup", onPointerUp);
  };
}
