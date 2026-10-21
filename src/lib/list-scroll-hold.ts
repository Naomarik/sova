// Only the user scrolls the session list (§app.session-list/content-rules, "Only the user scrolls the list").
//
// The list is keyed (lib/for-key), so a refresh updates rows in place. This is the safety net under that, on every
// browser alike (iOS Safari has no CSS scroll anchoring of its own): the list remembers the rows and heads on screen,
// top first, and where each sat, and after any change to the list's DOM — rows arriving or leaving above, a section
// opening or closing on its own, a search ending — puts the first of them that kept its place back where it was. A row
// that moved (into another state group, an open Done, or elsewhere in its own list) or is gone is never followed: the
// next one holds instead. The browser's own anchoring is turned off on the list, so there is exactly one rule. A
// section head the user presses is what holds still through that toggle. When nothing on screen kept its place the
// list is left alone, and so is a list scrolled to its very top: it stays at the top. The side
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

/** What can anchor: rows and section heads, in document order. */
const ROWS = "a.list-row";
const HEADS = "summary";
const ANCHORS = `${ROWS}, ${HEADS}`;
/** How many of what is on screen are remembered, top first: enough that one still in its place is always among them. */
const HELD = 12;

/** Where an item sits among its siblings: the ids of the ones before it and after it, nearest first. */
export interface Neighbours {
  before: readonly string[];
  after: readonly string[];
}

/**
 * Whether an item kept its place among its siblings: `now` is its container's ids today, `self` its own index there.
 * The nearest of its old neighbours still there must still be on the same side: one before it, one after it. Items
 * arriving or leaving around it don't move it; it moving past its old neighbours (a re-sort) does. One side with none
 * of its old neighbours left says nothing.
 */
export function keptPlace(was: Neighbours, now: readonly string[], self: number): boolean {
  const side = (ids: readonly string[], ok: (i: number) => boolean) => {
    for (const id of ids) {
      const i = now.indexOf(id);
      if (i >= 0 && i !== self) return ok(i);
    }
    return true;
  };
  return side(was.before, (i) => i < self) && side(was.after, (i) => i > self);
}

const boxed = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.height > 0 || r.width > 0;
};

/** The first element of `all` (document order, so top to bottom) whose bottom is below `top`. Binary search, stepping
    over elements a closed section hides (no box). Returns its index, `all.length` for none. */
function firstBelow(all: readonly Element[], top: number): number {
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
  return next(lo);
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
  const href = like.matches(ROWS) ? like.getAttribute("href") : null;
  const all = href ? list.querySelectorAll(`${ROWS}[href="${CSS.escape(href)}"]`) : list.querySelectorAll(like.tagName.toLowerCase());
  for (const el of all) if (keyOf(list, el) === key) return el;
  return null;
}

/** Words without counts, for telling heads and lists apart. */
const words = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/[\d·]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
const HEADING = "h1, h2, h3, h4, h5, h6, summary, [class*='head'], [class*='label']";
/** What moves as one among its siblings: a row's list item, a head's section. */
const itemOf = (el: Element): Element => (el.matches(ROWS) ? (el.closest("li") ?? el) : (el.parentElement ?? el));
/** A sibling's id: a row by its link, a section by its head's words, anything else by what it is and its words. */
function idOf(el: Element): string {
  const a = el.matches(ROWS) ? el : el.querySelector(`:scope > ${ROWS}, :scope > * > ${ROWS}`);
  if (el.tagName === "LI" && a) return `row ${a.getAttribute("href")}`;
  if (el.tagName === "DETAILS") return `section ${words(el.querySelector(":scope > summary"))}`;
  return `${el.tagName} ${el.className} ${el.matches(HEADING) ? words(el) : ""}`;
}
/** Which list an item is in, in words, for when that list itself was rebuilt: each container up to the list, with
    its head and the head just before it ("Not started", "Done", a project's name). */
function containerWords(list: HTMLElement, box: Element | null): string {
  const parts: string[] = [];
  for (let n = box; n && n !== list; n = n.parentElement) {
    const first = n.firstElementChild?.matches(HEADING) ? words(n.firstElementChild) : "";
    const prev = n.previousElementSibling?.matches(HEADING) ? words(n.previousElementSibling) : "";
    parts.push(`${n.tagName}.${n.className}|${first}|${prev}`);
  }
  return parts.join(" < ");
}
const NEAR = 3;
function neighboursOf(item: Element): Neighbours {
  const before: string[] = [];
  const after: string[] = [];
  for (let n = item.previousElementSibling; n && before.length < NEAR; n = n.previousElementSibling) before.push(idOf(n));
  for (let n = item.nextElementSibling; n && after.length < NEAR; n = n.nextElementSibling) after.push(idOf(n));
  return { before, after };
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

/** One thing held: where it sat from the list's top, the list it sat in, and its neighbours there. */
interface Held {
  el: Element;
  key: string;
  offset: number;
  box: Element | null;
  boxWords: string;
  near: Neighbours;
}

/** Holds the list still (`list` is the scrolling element, `.sidebar-list`). Returns the disposer. */
export function holdListScroll(list: HTMLElement): () => void {
  list.style.overflowAnchor = "none";
  /** What is on screen, top first, then the heads of the sections the first sits in: after a change, the first of
      these still in its place is put back where it was. */
  let held: Held[] = [];
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
  const measure = (el: Element, key = keyOf(list, el)): Held => {
    const item = itemOf(el);
    const box = item.parentElement;
    return { el, key, offset: el.getBoundingClientRect().top - top(), box, boxWords: containerWords(list, box), near: neighboursOf(item) };
  };
  /** `els`, then the heads of the sections the first one sits in, innermost first: those rarely move. */
  const record = (els: Element[]) => {
    savedScrollTop = list.scrollTop;
    const heads: Element[] = [];
    for (let d = els[0]?.parentElement?.closest("details"); d && list.contains(d); d = d.parentElement?.closest("details")) {
      const s = d.querySelector(":scope > summary");
      if (s && !els.includes(s)) heads.push(s);
    }
    held = [...els, ...heads].map((el) => measure(el));
  };
  /** What is on screen, top first. */
  const pick = () => {
    if (hidden()) return;
    const all = [...list.querySelectorAll(ANCHORS)];
    const bottom = list.getBoundingClientRect().bottom;
    const els: Element[] = [];
    for (let i = firstBelow(all, top()); i < all.length && els.length < HELD; i++) {
      const el = all[i]!;
      if (!boxed(el)) continue;
      if (el.getBoundingClientRect().top >= bottom) break;
      els.push(el);
    }
    record(els);
  };
  /** Where `h`'s element is now, if it kept its place: the same list (or one just like it, rebuilt) and the same
      neighbours on each side. A row that moved, or is gone, is null: it is never followed. */
  const findHeld = (h: Held, lists: Map<Element, string[]>): Element | null => {
    const el = h.el.isConnected && list.contains(h.el) ? h.el : findByKey(list, h.key, h.el);
    if (!el || !boxed(el)) return null;
    const item = itemOf(el);
    const box = item.parentElement;
    if (!box) return null;
    if (box !== h.box && (h.box?.isConnected || containerWords(list, box) !== h.boxWords)) return null;
    let ids = lists.get(box);
    if (!ids) lists.set(box, (ids = [...box.children].map(idOf)));
    return keptPlace(h.near, ids, [...box.children].indexOf(item)) ? el : null;
  };

  /** The user's own toggle: the head they pressed holds still, not the first row. A project's fold button folds the
      project under its head. */
  const pressHead = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null;
    const head = el?.closest(".project-fold")?.closest(".org-project-head") ?? el?.closest(HEADS);
    if (head && list.contains(head)) record([head]);
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
    const lists = new Map<Element, string[]>();
    // The first that kept its place. One that moved (into another group, or re-sorted in its own list) is passed
    // over: following it would carry everything else on screen along by however far it went.
    let i = 0;
    let el: Element | null = null;
    for (; i < held.length && !el; i++) el = findHeld(held[i]!, lists);
    // Nothing on screen kept its place: nothing to hold, and nothing moves.
    if (!el) return pick();
    const a = held[i - 1]!;
    const d = holdCorrection({
      offset: a.offset,
      now: el.getBoundingClientRect().top - top(),
      savedScrollTop,
      scrollTop: list.scrollTop,
      maxScrollTop: list.scrollHeight - list.clientHeight,
      userScrolling: userScrolling(),
    });
    if (d !== 0) list.scrollTop += d;
    // Keep holding the same place: a burst of changes holds one place, not a drifting one.
    if (list.scrollTop <= 0) return pick();
    savedScrollTop = list.scrollTop;
    const next = [measure(el, a.el === el ? a.key : undefined)];
    for (const h of held.slice(i)) {
      const at = findHeld(h, lists);
      if (at) next.push(measure(at, at === h.el ? h.key : undefined));
    }
    held = next;
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
