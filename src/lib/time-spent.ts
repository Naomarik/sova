// Time Spent's page side (§app.subagents-pane/time-spent-counting, /time-spent-record): the app's one
// tracker. It listens to the document, feeds the clock in time-spent-core, keeps what is counted and not
// yet reported, reports it to the session's host, and gives the Session tab's section its live figures.
//
// Inert until App calls startTimeSpent, and App is the only caller: an owner's share page reaches the small
// hooks below through a shared component, and with no start they listen to nothing and count nothing. Hot paths read no layout: an event's pane comes
// from closest() on its target, what is on screen from one IntersectionObserver per transcript.

import { createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, onMount, type Accessor } from "solid-js";
import { TIME_SPENT_MAX_DOCS, TIME_SPENT_MAX_ID_CHARS, TIME_SPENT_REPORT_ROUTE, type TimeSpentReport } from "../../shared/time-spent";
import { hostOf, hostUrl } from "./mesh";
import {
  addSeconds,
  addSums,
  countWords,
  initialClock,
  MAX_UNSENT_SLICES,
  countedSession,
  reduce,
  reportOutcome,
  shownFraction,
  sessionsOnScreen,
  tick,
  type ClockEvent,
  type ClockState,
  type Foreground,
  type Slice,
  type Sums,
  type TimeRow,
  withRunIds,
} from "./time-spent-core";

export type { TimeRow } from "./time-spent-core";
export type TimeSpentWord = "Counting" | "Paused" | "Not Recording";
export interface TimeSpentLive {
  you: number;
  rows: Partial<Record<TimeRow, number>>;
  cards: Record<string, number>;
  word: TimeSpentWord;
}

const REPORT_EVERY_MS = 15_000;
/** One report's most: well inside the keepalive budget, which every report out shares. */
const REPORT_MAX_SLICES = 100;
/** A host that refuses is asked again this often: the word goes back once it accepts. */
const REFUSED_RETRY_MS = 60_000;
/** The attribute that says which session an element belongs to: a workspace's pane, the session pane. */
const SESSION_ATTR = "data-time-session";
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** The most often a resting pointer's stream of moves reaches the clock. */
const POINTER_STEP_MS = 250;
/** How long after a scroll what is on screen is asked again, every tick: a tall row crosses few thresholds. */
const REFRESH_AFTER_SCROLL_MS = 3_000;
/** How often what is on screen is asked again anyway: a row's text grows while it streams. */
const REFRESH_EVERY_MS = 15_000;

let started = false;
let clock: ClockState = initialClock(0);
const dispatch = (e: ClockEvent) => {
  clock = reduce(clock, e);
};

// ── The sessions on screen ──

const [mounted, setMounted] = createSignal<readonly { path: string; front?: () => boolean }[]>([]);

/** Called by a session view: this session is on screen while it is mounted and `front` says so. */
export function trackSessionView(path: string, front?: () => boolean): void {
  const me = { path, front };
  setMounted((m) => [...m, me]);
  if (getOwner()) onCleanup(() => setMounted((m) => m.filter((x) => x !== me)));
}

const [panesOpen, setPanesOpen] = createSignal<readonly string[]>([]);

/** Where the session pane begins; Infinity while it is shut. Beside the chat it hides nothing, the rows ending before it. */
let coverLeft = Infinity;
const coverWatchers = new Set<() => void>();
function setCover(x: number): void {
  if (x === coverLeft) return;
  coverLeft = x;
  for (const watcher of coverWatchers) watcher();
}

/** Called by the session pane with its element: drawn over the chat, it hides the rows behind it, which no observer
    can see. Measured when it opens, resizes or the window does, never per event. */
export function trackSessionPane(path: string, aside: () => HTMLElement): void {
  // Open from the Agents board there is no session view: the pane is this session on screen (sessionsOnScreen).
  setPanesOpen((p) => [...p, path]);
  onCleanup(() => setPanesOpen((p) => p.filter((x) => x !== path)));
  onMount(() => {
    const el = aside();
    const measure = () => setCover(el.getBoundingClientRect().left);
    measure();
    const sized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    sized?.observe(el);
    window.addEventListener("resize", measure);
    // It slides in: the first measure is off by the slide.
    el.addEventListener("animationend", measure);
    onCleanup(() => {
      sized?.disconnect();
      window.removeEventListener("resize", measure);
      el.removeEventListener("animationend", measure);
      setCover(Infinity);
    });
  });
}

// ── What a transcript has on screen ──

interface RowSeen {
  left: number;
  right: number;
  height: number;
  words: number;
  /** The alignment document whose content this row shows, if any. */
  doc: string | null;
}
const refreshers = new Set<(recount: boolean) => void>();

/** The rows the transcript's own empty screens and skeletons draw aren't rows. */
const isRow = (n: Node): n is HTMLElement => n.nodeType === 1 && !(n as HTMLElement).matches(".empty, .skeleton, :has(> .skeleton)");

/** The words a row shows: what a closed disclosure folds away isn't in view, though it is in the DOM. */
function wordsShown(row: Element): number {
  let words = countWords(row.textContent ?? "");
  for (const closed of row.querySelectorAll("details:not([open])")) {
    if (closed.parentElement?.closest("details:not([open])")) continue;
    words -= countWords(closed.textContent ?? "") - countWords(closed.querySelector(":scope > summary")?.textContent ?? "");
  }
  return words;
}

/** One IntersectionObserver over a transcript's rows. Observing changes nothing about a row: the box of a
    `content-visibility: auto` row keeps its estimated height, and nothing here may touch that property (app.css). */
function observeRows(thread: HTMLElement, publish: (rows: ReadonlyMap<Element, RowSeen>) => void): void {
  if (typeof IntersectionObserver !== "function") return;
  const seen = new Map<Element, RowSeen>();
  // A revision folded to its one line shows none of its content: that row is a transcript row like any other.
  const docOf = (row: Element): string | null => {
    const el = row.querySelector("[data-align-doc]");
    return el && !el.matches("details:not([open])") ? el.getAttribute("data-align-doc") : null;
  };
  const stale = new WeakSet<Element>();
  const wordCounts = new WeakMap<Element, number>();
  const io = new IntersectionObserver(
    (records) => {
      let changed = false;
      for (const r of records) {
        const area = r.isIntersecting ? r.intersectionRect.width * r.intersectionRect.height : 0;
        if (area <= 0) {
          if (seen.delete(r.target)) changed = true;
          wordCounts.delete(r.target);
          continue;
        }
        let words = wordCounts.get(r.target);
        if (words === undefined || stale.has(r.target)) {
          words = wordsShown(r.target);
          wordCounts.set(r.target, words);
          stale.delete(r.target);
        }
        const { left, right, height } = r.intersectionRect;
        seen.set(r.target, { left, right, height, words: words * r.intersectionRatio, doc: docOf(r.target) });
        changed = true;
      }
      if (changed) publish(seen);
    },
    { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
  );
  const mo = new MutationObserver((records) => {
    let removed = false;
    for (const r of records) {
      for (const n of r.addedNodes) if (isRow(n)) io.observe(n);
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue;
        io.unobserve(n as Element);
        if (seen.delete(n as Element)) removed = true;
      }
    }
    if (removed) publish(seen);
  });
  mo.observe(thread, { childList: true });
  // A row opening or closing what it folds may cross no threshold, and it changes what the row shows.
  const onToggle = (e: Event) => {
    let row = e.target instanceof Element ? e.target : null;
    while (row && row.parentElement !== thread) row = row.parentElement;
    if (!row || !seen.has(row)) return;
    stale.add(row);
    io.unobserve(row);
    io.observe(row);
  };
  thread.addEventListener("toggle", onToggle, true);
  for (const n of thread.childNodes) if (isRow(n)) io.observe(n);
  // Observing again answers with a fresh record, measured by the browser in its own rendering step: no layout read here.
  const refresh = (recount: boolean) => {
    for (const row of seen.keys()) {
      if (recount) stale.add(row);
      io.unobserve(row);
      io.observe(row);
    }
  };
  refreshers.add(refresh);
  onCleanup(() => {
    refreshers.delete(refresh);
    mo.disconnect();
    io.disconnect();
    thread.removeEventListener("toggle", onToggle, true);
    publish(new Map());
  });
}

/** Called with a session transcript's `.thread`, while it mounts. */
export function trackTranscript(path: string, thread: HTMLElement): void {
  if (!started) return;
  let last: ReadonlyMap<Element, RowSeen> = new Map();
  const publish = (rows: ReadonlyMap<Element, RowSeen>) => {
    last = rows;
    let transcript = 0;
    let alignments = 0;
    let words = 0;
    const docs = new Set<string>();
    for (const r of rows.values()) {
      const shown = shownFraction(r.left, r.right, coverLeft);
      if (shown <= 0) continue;
      const area = (r.right - r.left) * r.height * shown;
      words += r.words * shown;
      if (r.doc === null) transcript += area;
      else {
        alignments += area;
        if (r.doc && r.doc.length <= TIME_SPENT_MAX_ID_CHARS && docs.size < TIME_SPENT_MAX_DOCS) docs.add(r.doc);
      }
    }
    dispatch({ type: "main-view", session: path, view: { transcript, alignments, words, docs: [...docs].sort() } });
  };
  const again = () => publish(last);
  coverWatchers.add(again);
  onCleanup(() => coverWatchers.delete(again));
  observeRows(thread, publish);
}

/** Called with the `.thread` of a worker's transcript in `parent`'s Agents tab: Reading Workers on the parent. */
export function trackWorkerTranscript(parent: string, thread: HTMLElement): void {
  if (!started) return;
  observeRows(thread, (rows) => {
    let area = 0;
    let words = 0;
    for (const r of rows.values()) {
      area += (r.right - r.left) * r.height;
      words += r.words;
    }
    dispatch({ type: "worker-view", session: parent, view: { area, words } });
  });
}

/** Called with the `.thread` of a linked session's transcript in `parent`'s Agents tab: rows on screen, like the chat's. */
export function trackLinkedTranscript(parent: string, thread: HTMLElement): void {
  if (!started) return;
  observeRows(thread, (rows) => {
    let area = 0;
    let words = 0;
    for (const r of rows.values()) {
      area += (r.right - r.left) * r.height;
      words += r.words;
    }
    dispatch({ type: "linked-view", session: parent, view: { area, words } });
  });
}

// ── Foreground views and dictating ──

let foregroundSeq = 0;

/** Called by a foreground view as it mounts: it counts for the session it opened over until it unmounts. */
export function trackForeground(kind: Foreground["kind"], doc?: string): void {
  if (!started) return;
  const id = ++foregroundSeq;
  dispatch({ type: "foreground-open", view: { id, kind, ...(doc ? { doc } : {}), session: countedSession(clock) } });
  onCleanup(() => dispatch({ type: "foreground-close", id }));
}

/** A foreground view whose open state lives elsewhere: `open` is called with whether it is on screen. */
export function foregroundSwitch(kind: Foreground["kind"]): (open: boolean) => void {
  let id = 0;
  return (open) => {
    if (!started) return;
    if (open && !id) {
      id = ++foregroundSeq;
      dispatch({ type: "foreground-open", view: { id, kind, session: countedSession(clock) } });
    } else if (!open && id) {
      dispatch({ type: "foreground-close", id });
      id = 0;
    }
  };
}

let recordingSeq = 0;

/** Voice input into `input` started recording: it holds the count until the returned call. */
export function holdDictating(input: Element | undefined): () => void {
  if (!started) return () => {};
  const recording = { id: ++recordingSeq, pane: paneOf(input ?? null) };
  dispatch({ type: "dictating", on: true, at: Date.now(), recording });
  return () => dispatch({ type: "dictating", on: false, at: Date.now(), recording });
}

// ── The ledger: counted and not yet in the host's record ──

interface Ledger {
  unsent: Slice[];
  /** Batches out and not yet answered. Normally one; a going page sends what's left beside them. */
  inflight: Set<Slice[]>;
  /** Accepted by the host, and not yet in a read the section finished. */
  acked: { seq: number; slices: readonly Slice[] }[];
  refused: boolean;
  /** No report for this session has come back yet: the first goes at once, so a refusal shows at once. */
  fresh: boolean;
  lastSentAt: number;
  subscribers: number;
}
const ledgers = new Map<string, Ledger>();
const ledgerOf = (path: string): Ledger => {
  let l = ledgers.get(path);
  if (!l) ledgers.set(path, (l = { unsent: [], inflight: new Set(), acked: [], refused: false, fresh: true, lastSentAt: -Infinity, subscribers: 0 }));
  return l;
};

const [countingNow, setCountingNow] = createSignal<string | null>(null);
const [figures, setFigures] = createSignal(0);
const bumpFigures = () => setFigures((n) => n + 1);
const [acks, setAcks] = createSignal(0);
let ackSeq = 0;

const pageId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
})();

function answered(l: Ledger, sent: Slice[], status: number | null): void {
  l.inflight.delete(sent);
  // Whatever came back: a failing network is retried on the 15-second rhythm, never every second.
  l.fresh = false;
  const outcome = reportOutcome(status);
  if (outcome === "accepted") {
    l.refused = false;
    // With no section open nothing will re-read, and a section opening reads it all.
    if (l.subscribers > 0) l.acked.push({ seq: ++ackSeq, slices: sent });
    setAcks((n) => n + 1);
    // What an outage left behind goes next, not in 15 seconds.
    if (l.unsent.length > REPORT_MAX_SLICES) l.lastSentAt = -Infinity;
  } else if (outcome !== "rejected") {
    if (outcome === "refused") l.refused = true;
    // Kept for the next try, oldest dropped past the bound.
    l.unsent = [...sent, ...l.unsent].slice(-MAX_UNSENT_SLICES);
  }
  bumpFigures();
}

/** Runs are numbered across this page's sessions: an id is unique within the page id. */
let nextRunId = 1;

function report(path: string, now: number, going = false): void {
  const l = ledgerOf(path);
  if ((l.inflight.size > 0 && !going) || l.unsent.length === 0) return;
  const numbered = withRunIds(l.unsent.slice(0, REPORT_MAX_SLICES), nextRunId);
  nextRunId = numbered.nextId;
  const sent = numbered.slices;
  l.inflight.add(sent);
  l.unsent = l.unsent.slice(sent.length);
  l.lastSentAt = now;
  const inputAgeMs = Number.isFinite(clock.lastActiveAt) ? Math.max(0, now - clock.lastActiveAt) : 0;
  const message: TimeSpentReport = {
    pageId,
    path,
    inputAgeMs: clock.recordings.length > 0 ? 0 : inputAgeMs,
    slices: sent.map((s) => ({ row: s.row, docs: [...s.docs], sec: s.sec, ageMs: Math.max(0, now - s.endAt), id: s.id })),
  };
  const body = JSON.stringify(message);
  // keepalive: a report handed over as the page goes still arrives (64 KB budget; the ledger's bound stays under it).
  void fetch(hostUrl(hostOf(path), TIME_SPENT_REPORT_ROUTE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).then(
    (res) => answered(l, sent, res.status),
    () => answered(l, sent, null),
  );
}

/** The page is going or hiding: everything now, beside what is already out. */
function reportAll(now: number): void {
  for (const [path] of ledgers) report(path, now, true);
}

// ── The section's reads ──

/** The seconds a session has counted and its record doesn't hold yet, and the word. Call under an owner (the section). */
export function timeSpentLive(path: string): Accessor<TimeSpentLive> {
  if (getOwner()) {
    const l = ledgerOf(path);
    l.subscribers++;
    onCleanup(() => {
      l.subscribers--;
      if (l.subscribers === 0) l.acked = [];
    });
  }
  return createMemo(() => {
    figures();
    const counting = countingNow();
    const l = ledgers.get(path);
    if (l?.refused) return { you: 0, rows: {}, cards: {}, word: "Not Recording" as const };
    const sums: Sums = { you: 0, rows: {}, cards: {} };
    if (l) {
      addSums(sums, l.unsent);
      for (const out of l.inflight) addSums(sums, out);
      for (const a of l.acked) addSums(sums, a.slices);
    }
    return { ...sums, word: counting === path ? ("Counting" as const) : ("Paused" as const) };
  });
}

/** Bumps when the host accepts a report: a good moment to read the record again. */
export const timeSpentAcked: Accessor<number> = acks;

/** Right before reading the record: the token for timeSpentReadDone. */
export const timeSpentReadStart = (_path: string): number => ackSeq;

/** The read is in the section's hands: what the host had accepted before it began now shows in the record. */
export function timeSpentReadDone(path: string, token: number): void {
  const l = ledgers.get(path);
  if (!l) return;
  l.acked = l.acked.filter((a) => a.seq > token);
  bumpFigures();
}

/** The section's own read was refused or the route is unknown there. A network failure doesn't come here. */
export function noteTimeSpentRefused(path: string): void {
  ledgerOf(path).refused = true;
  bumpFigures();
}

// ── The listeners ──

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === "TEXTAREA") return true;
  if (t.tagName === "INPUT") return !/^(button|checkbox|color|file|image|radio|range|reset|submit)$/.test((t as HTMLInputElement).type);
  return t.isContentEditable;
}

let paneTarget: EventTarget | null = null;
let paneValue: string | null = null;
/** The session an event's target belongs to, null outside every pane: a menu in a portal, the sidebar. */
function paneOf(t: EventTarget | null): string | null {
  if (t === paneTarget) return paneValue;
  paneTarget = t;
  paneValue = t instanceof Element ? (t.closest(`[${SESSION_ATTR}]`)?.getAttribute(SESSION_ATTR) ?? null) : null;
  return paneValue;
}

function listen(): void {
  let moveAt = 0;
  let moveX = NaN;
  let moveY = NaN;
  let moveTarget: EventTarget | null = null;
  const opts = { capture: true, passive: true } as const;
  const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => document.addEventListener(type, fn, opts);

  on("pointermove", (e) => {
    // The browser sends a move under a resting mouse when the page shifts beneath it (the chat following new text).
    if (e.screenX === moveX && e.screenY === moveY) return;
    moveX = e.screenX;
    moveY = e.screenY;
    const at = Date.now();
    if (e.target === moveTarget && at - moveAt < POINTER_STEP_MS) return;
    moveTarget = e.target;
    moveAt = at;
    dispatch({ type: "pointer", at, pane: paneOf(e.target) });
  });
  on("pointerdown", (e) => {
    const at = Date.now();
    const pane = paneOf(e.target);
    dispatch(e.pointerType === "mouse" ? { type: "press", on: true, at, pane } : { type: "pointer", at, pane });
  });
  const release = (e: PointerEvent) => {
    if (e.pointerType === "mouse") dispatch({ type: "press", on: false, at: Date.now(), pane: null });
  };
  on("pointerup", release);
  on("pointercancel", release);
  on("wheel", (e) => {
    if (!e.ctrlKey) dispatch({ type: "wheel", at: Date.now(), pane: paneOf(e.target) });
  });
  on("touchstart", (e) => dispatch({ type: "pointer", at: Date.now(), pane: paneOf(e.target) }));
  on("touchmove", (e) => dispatch({ type: "wheel", at: Date.now(), pane: paneOf(e.target) }));
  const lifted = () => dispatch({ type: "fling", at: Date.now() });
  on("touchend", lifted);
  on("touchcancel", lifted);
  on("keydown", (e) => {
    const at = Date.now();
    const pane = paneOf(e.target);
    if (isTextInput(e.target)) {
      const char = !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter");
      dispatch(char ? { type: "typed", at, pane } : { type: "key", at, pane });
    } else if (SCROLL_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof Element && e.target.closest("button, a, summary, select"))) {
      dispatch({ type: "scroll-key", at, pane });
    } else dispatch({ type: "key", at, pane });
  });
  // A phone's keyboard, a paste, an IME: characters with no useful key event.
  on("input", (e) => {
    if (isTextInput(e.target)) dispatch({ type: "typed", at: Date.now(), pane: paneOf(e.target) });
  });
  on("focusin", (e) => dispatch({ type: "focus", pane: paneOf(e.target) }));
  on("scroll", () => dispatch({ type: "scrolled", at: Date.now() }));

  const beat = () => {
    const now = Date.now();
    const t = tick(clock, now);
    clock = t.state;
    setCountingNow(t.counted?.session ?? null);
    if (t.seconds > 0 && t.counted) {
      const l = ledgerOf(t.counted.session);
      l.unsent = addSeconds(l.unsent, t.counted, t.seconds, now);
      bumpFigures();
      if (l.fresh) report(t.counted.session, now);
    }
    const recount = now - refreshedAt >= REFRESH_EVERY_MS;
    if (recount) refreshedAt = now;
    if (recount || now - clock.scrolledAt < REFRESH_AFTER_SCROLL_MS) for (const refresh of refreshers) refresh(recount);
    for (const [path, l] of ledgers) {
      if (now - l.lastSentAt >= (l.refused ? REFUSED_RETRY_MS : REPORT_EVERY_MS)) report(path, now);
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const run = (on: boolean) => {
    clearInterval(timer);
    timer = on ? setInterval(beat, 1000) : undefined;
  };
  const visibility = () => {
    const shown = document.visibilityState === "visible";
    if (!shown) beat();
    dispatch({ type: "visible", on: shown, at: Date.now() });
    run(shown);
    if (!shown) {
      setCountingNow(null);
      reportAll(Date.now());
    }
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", () => {
    beat();
    reportAll(Date.now());
  });
  run(document.visibilityState === "visible");
}

let refreshedAt = 0;

/** App starts the one tracker. `focused` is its open or focused session; `elsewhere` is true over Settings. */
export function startTimeSpent(opts: { focused: Accessor<string | null>; elsewhere: Accessor<boolean> }): void {
  if (started) return;
  started = true;
  const now = Date.now();
  refreshedAt = now;
  clock = initialClock(now, document.visibilityState === "visible");
  createRoot(() => {
    createEffect(() => dispatch({ type: "sessions", paths: sessionsOnScreen(mounted().filter((m) => !m.front || m.front()).map((m) => m.path), panesOpen()) }));
    createEffect(() => dispatch({ type: "focused", path: opts.focused() }));
    createEffect(() => dispatch({ type: "elsewhere", on: opts.elsewhere() }));
  });
  listen();
  dispatch({ type: "focus", pane: paneOf(document.activeElement) });
}
