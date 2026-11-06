// Time Spent's clock (§app.subagents-pane/time-spent-counting), as data: what the page's listeners
// saw goes in as events with their own time, and a tick says which session and row each counted
// second belongs to. No DOM and no timers here: time-spent.ts feeds it, the tests feed it a fake clock.

import type { TimeSpentRow } from "../../shared/time-spent";

export type TimeRow = TimeSpentRow;

/** A foreground view: its kind, the alignment document its report shows, and the session it opened over. */
export interface Foreground {
  id: number;
  kind: "changes" | "tours" | "alignment";
  doc?: string;
  session: string | null;
}

/** What one transcript has on screen. Areas in px², so rows of the main transcript and the worker view compare. */
export interface MainView {
  transcript: number;
  alignments: number;
  words: number;
  docs: readonly string[];
}
export interface WorkerView {
  area: number;
  words: number;
}
export interface SessionView {
  main: MainView;
  worker: WorkerView;
  /** The session pane covers the whole chat (a phone): what the chat's transcript has "on screen" isn't seen. */
  covered: boolean;
}

export interface ClockState {
  visible: boolean;
  /** Settings is open over the page: nothing counts (it isn't a session). */
  elsewhere: boolean;
  /** The sessions on screen (a workspace's tabs behind the front one aren't). */
  sessions: readonly string[];
  /** The app's own open or focused session: the last word on which pane holds the keyboard. */
  focused: string | null;
  pointerPane: string | null;
  keyboardPane: string | null;
  lastActiveAt: number;
  typedAt: number;
  scrolledAt: number;
  /** Until when a raw scroll event is the user's: it follows their wheel, finger or scroll key. */
  intentUntil: number;
  /** The mouse is down: the scrollbar being dragged scrolls with no wheel. */
  pressed: boolean;
  dictating: number;
  foreground: readonly Foreground[];
  views: Readonly<Record<string, SessionView>>;
  lastTickAt: number;
  /** Counted milliseconds not yet a whole second. */
  carry: number;
}

export type ClockEvent =
  | { type: "visible"; on: boolean; at: number }
  | { type: "elsewhere"; on: boolean }
  | { type: "sessions"; paths: readonly string[] }
  | { type: "focused"; path: string | null }
  /** Any touch, click or mouse move; `pane` is the session under it, null outside every pane. */
  | { type: "pointer"; at: number; pane: string | null }
  /** A wheel or a finger dragging: the user's scroll by its input. */
  | { type: "wheel"; at: number; pane: string | null }
  /** The finger lifted: a fling keeps scrolling. */
  | { type: "fling"; at: number }
  | { type: "press"; on: boolean; at: number; pane: string | null }
  /** A scroll key outside any input. */
  | { type: "scroll-key"; at: number; pane: string | null }
  /** A key that is neither typing nor scrolling. */
  | { type: "key"; at: number; pane: string | null }
  /** A character into an input. */
  | { type: "typed"; at: number; pane: string | null }
  | { type: "focus"; pane: string | null }
  /** Some element scrolled: the user's only if their input is behind it. The chat following new text isn't. */
  | { type: "scrolled"; at: number }
  | { type: "dictating"; on: boolean; at: number }
  | { type: "foreground-open"; view: Foreground }
  | { type: "foreground-close"; id: number; at: number }
  | { type: "main-view"; session: string; view: MainView }
  | { type: "worker-view"; session: string; view: WorkerView }
  | { type: "covered"; session: string; on: boolean };

export const IDLE_BASE_MS = 60_000;
export const IDLE_MAX_MS = 180_000;
export const WORDS_PER_MINUTE = 250;
/** How long after the last user scroll a second is still Scrolling. */
export const SCROLL_HOLD_MS = 1_500;
/** How long after the last character a second is still Typing: the row keeps up within about 2 seconds. */
export const TYPING_HOLD_MS = 2_000;
/** How long after a wheel, a scroll key and a finger's lift a scroll event is the user's own. */
export const WHEEL_INTENT_MS = 300;
export const KEY_INTENT_MS = 600;
export const FLING_INTENT_MS = 2_500;
/** A gap this long between ticks is a frozen or sleeping page, not time spent. */
export const MAX_TICK_GAP_MS = 5_000;

const NO_MAIN: MainView = { transcript: 0, alignments: 0, words: 0, docs: [] };
const NO_WORKER: WorkerView = { area: 0, words: 0 };
const NO_VIEW: SessionView = { main: NO_MAIN, worker: NO_WORKER, covered: false };

/** The clock of a page opening: visible or not, and not yet active, so it waits for the first real input. */
export function initialClock(now: number, visible = true): ClockState {
  return {
    visible,
    elsewhere: false,
    sessions: [],
    focused: null,
    pointerPane: null,
    keyboardPane: null,
    lastActiveAt: -Infinity,
    typedAt: -Infinity,
    scrolledAt: -Infinity,
    intentUntil: -Infinity,
    pressed: false,
    dictating: 0,
    foreground: [],
    views: {},
    lastTickAt: now,
    carry: 0,
  };
}

/** The idle cutoff for this many words in view: base, plus their reading time, capped. */
export function idleCutoffMs(words: number): number {
  return Math.min(IDLE_MAX_MS, IDLE_BASE_MS + (Math.max(0, words) / WORDS_PER_MINUTE) * 60_000);
}

/** Whitespace-separated words, with no allocation: this runs on whole rows of text. */
export function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = c === 32 || (c >= 9 && c <= 13) || c === 160;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function withPane(s: ClockState, pane: string | null): ClockState {
  return pane && pane !== s.pointerPane && s.sessions.includes(pane) ? { ...s, pointerPane: pane } : s;
}
function withKeyboard(s: ClockState, pane: string | null): ClockState {
  return pane && pane !== s.keyboardPane && s.sessions.includes(pane) ? { ...s, keyboardPane: pane } : s;
}
function viewOf(s: ClockState, session: string): SessionView {
  return s.views[session] ?? NO_VIEW;
}

export function reduce(s: ClockState, e: ClockEvent): ClockState {
  switch (e.type) {
    case "visible":
      // Hiding stops the count now; coming back alone is no input, so it leaves the idle clock as it was.
      return { ...s, visible: e.on, lastTickAt: e.at, carry: 0 };
    case "elsewhere":
      return { ...s, elsewhere: e.on };
    case "sessions": {
      const keep = (p: string | null) => (p && e.paths.includes(p) ? p : null);
      return {
        ...s,
        sessions: e.paths,
        pointerPane: keep(s.pointerPane),
        keyboardPane: keep(s.keyboardPane),
      };
    }
    case "focused":
      return { ...s, focused: e.path };
    case "pointer":
      return withPane({ ...s, lastActiveAt: e.at }, e.pane);
    case "wheel":
      return withPane({ ...s, lastActiveAt: e.at, scrolledAt: e.at, intentUntil: Math.max(s.intentUntil, e.at + WHEEL_INTENT_MS) }, e.pane);
    case "fling":
      return { ...s, lastActiveAt: e.at, intentUntil: Math.max(s.intentUntil, e.at + FLING_INTENT_MS) };
    case "press":
      return withPane({ ...s, pressed: e.on, lastActiveAt: e.at }, e.pane);
    case "scroll-key":
      return withKeyboard({ ...s, lastActiveAt: e.at, scrolledAt: e.at, intentUntil: Math.max(s.intentUntil, e.at + KEY_INTENT_MS) }, e.pane);
    case "key":
      return withKeyboard({ ...s, lastActiveAt: e.at }, e.pane);
    case "typed":
      return withKeyboard({ ...s, lastActiveAt: e.at, typedAt: e.at }, e.pane);
    case "focus":
      return withKeyboard(s, e.pane);
    case "scrolled":
      return s.pressed || e.at < s.intentUntil ? { ...s, lastActiveAt: e.at, scrolledAt: e.at } : s;
    case "dictating": {
      const dictating = Math.max(0, s.dictating + (e.on ? 1 : -1));
      // The end of a recording is the last thing the user did, so the cutoff runs from there.
      return { ...s, dictating, lastActiveAt: e.at };
    }
    case "foreground-open":
      return { ...s, foreground: [...s.foreground, e.view] };
    case "foreground-close":
      return { ...s, foreground: s.foreground.filter((f) => f.id !== e.id), lastActiveAt: e.at };
    case "main-view":
      return { ...s, views: { ...s.views, [e.session]: { ...viewOf(s, e.session), main: e.view } } };
    case "worker-view":
      return { ...s, views: { ...s.views, [e.session]: { ...viewOf(s, e.session), worker: e.view } } };
    case "covered":
      return { ...s, views: { ...s.views, [e.session]: { ...viewOf(s, e.session), covered: e.on } } };
  }
}

/** The session this moment would count for: a foreground view's own, the pane under the latest pointer, wheel or
    touch, the pane holding the keyboard, then the app's focused or only session. */
export function countedSession(s: ClockState): string | null {
  const on = (p: string | null | undefined): p is string => !!p && s.sessions.includes(p);
  const top = s.foreground[s.foreground.length - 1];
  if (on(top?.session)) return top.session;
  if (on(s.pointerPane)) return s.pointerPane;
  if (on(s.keyboardPane)) return s.keyboardPane;
  if (on(s.focused)) return s.focused;
  return s.sessions.length === 1 ? s.sessions[0]! : null;
}

/** What the view says when nothing nearer does: the largest share of the screen, a tie to the alignment. */
function viewRow(v: SessionView): TimeRow {
  const alignments = v.covered ? 0 : v.main.alignments;
  const transcript = v.covered ? 0 : v.main.transcript;
  const workers = v.worker.area;
  if (alignments > 0 && alignments >= transcript && alignments >= workers) return "reading-alignments";
  if (workers > 0 && workers >= transcript) return "reading-workers";
  if (transcript > 0) return "reading-transcript";
  return "other";
}

export function wordsInView(v: SessionView): number {
  return v.worker.words + (v.covered ? 0 : v.main.words);
}

export interface Counted {
  session: string;
  row: TimeRow;
  /** Alignment documents on screen this second: a separate, overlapping count from `row`. */
  docs: readonly string[];
}

/** What this moment counts as, or null when it doesn't: the rules of one row per second. */
export function decide(s: ClockState, now: number): Counted | null {
  if (!s.visible || s.elsewhere) return null;
  const session = countedSession(s);
  if (!session) return null;
  const v = viewOf(s, session);
  if (!s.dictating && now - s.lastActiveAt >= idleCutoffMs(wordsInView(v))) return null;
  const top = s.foreground[s.foreground.length - 1];
  // A foreground view is drawn over the chat: the cards under it aren't on screen, its own document is.
  const docs = top ? (top.doc ? [top.doc] : []) : v.covered ? [] : v.main.docs;
  const row: TimeRow = s.dictating
    ? "dictating"
    : now - s.typedAt < TYPING_HOLD_MS
      ? "typing"
      : now - s.scrolledAt < SCROLL_HOLD_MS
        ? "scrolling"
        : top
          ? top.kind === "alignment"
            ? "reading-alignments"
            : top.kind
          : viewRow(v);
  return { session, row, docs };
}

export interface Tick {
  state: ClockState;
  /** How many whole seconds this tick counted (normally 0 or 1), all of `counted`. */
  seconds: number;
  counted: Counted | null;
}

/** Time moved on to `now`. Only whole seconds count, so the rows add up to the total exactly. */
export function tick(s: ClockState, now: number): Tick {
  const counted = decide(s, now);
  const dt = now - s.lastTickAt;
  if (!counted || dt < 0 || dt > MAX_TICK_GAP_MS) return { state: { ...s, lastTickAt: now, carry: 0 }, seconds: 0, counted };
  const carry = s.carry + dt;
  const seconds = Math.floor(carry / 1000);
  return { state: { ...s, lastTickAt: now, carry: carry - seconds * 1000 }, seconds, counted };
}

// ── The ledger: seconds counted and not yet in the host's record, per session ──

/** A run of identical seconds. `endAt` is this page's clock at its last second (the wire sends its age, never this). */
export interface Slice {
  row: TimeRow;
  docs: readonly string[];
  sec: number;
  endAt: number;
}

/** The most kept per session while reports fail: about an hour of a row a minute. A long outage drops the oldest. */
export const MAX_UNSENT_SLICES = 240;

const sameDocs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** Adds seconds to a run list: merged into its last run when they continue it, the oldest dropped over the bound. */
export function addSeconds(slices: readonly Slice[], c: Pick<Counted, "row" | "docs">, seconds: number, at: number, max: number = MAX_UNSENT_SLICES): Slice[] {
  if (seconds <= 0) return [...slices];
  const last = slices[slices.length - 1];
  // Adjacent: a run can only continue within a couple of seconds of its end.
  if (last && last.row === c.row && sameDocs(last.docs, c.docs) && at - last.endAt <= seconds * 1000 + 2000) {
    return [...slices.slice(0, -1), { ...last, sec: last.sec + seconds, endAt: at }];
  }
  const next = [...slices, { row: c.row, docs: c.docs, sec: seconds, endAt: at }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** What a list of runs adds up to, for the figures on screen. */
export interface Sums {
  you: number;
  rows: Partial<Record<TimeRow, number>>;
  cards: Record<string, number>;
}
export function addSums(into: Sums, slices: readonly Slice[]): Sums {
  for (const s of slices) {
    into.you += s.sec;
    into.rows[s.row] = (into.rows[s.row] ?? 0) + s.sec;
    for (const d of s.docs) into.cards[d] = (into.cards[d] ?? 0) + s.sec;
  }
  return into;
}

/** A report's answer, as what it means for the word. */
export type ReportOutcome = "accepted" | "refused" | "rejected" | "failed";
/** 401, 403 and 404: the host refuses or doesn't know the route (too old). 400 and 413: this report will never fit, so it
    is dropped rather than tried forever. Anything else not ok, or no answer, is a network trouble, which changes no word. */
export function reportOutcome(status: number | null): ReportOutcome {
  if (status === null) return "failed";
  if (status >= 200 && status < 300) return "accepted";
  if (status === 400 || status === 413) return "rejected";
  return status === 401 || status === 403 || status === 404 || status === 405 ? "refused" : "failed";
}
