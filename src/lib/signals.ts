// The session row's marks: line 1's leading state mark (the turn-error mark, else the unread dot)
// and its "needs you" mark (attention signals), the tag status word on line 3 (session tags), plus
// the live feed's overlay of these onto the list (WS /ws/watch?feed=sessions). Pure: the sidebar
// reads these, the tests pin them.

import type { SessionMarks, SessionSummary, SessionTags, SignalKind } from "../../shared/protocol";

/** The mark's kinds, most urgent first: one mark per row, the first of these that applies. */
export const SIGNAL_PRECEDENCE: readonly SignalKind[] = ["asks-you", "looping"];

/** What a row's line-1 mark says: the kind, and whether it is about a subagent rather than the session. */
export interface NeedsYouMark {
  kind: SignalKind;
  worker: boolean;
}

/**
 * Line 1's leading state mark, or null: "error" when the last turn stopped with an error
 * (`turnError`), else "unread" for the unread dot. One mark in one slot: an errored reply since you
 * looked is new activity too, so the dot is implied. The server sends both only while they apply;
 * the open session never shows either (you're looking at it).
 */
export function rowLeadMark(s: Pick<SessionSummary, "path" | "turnError" | "unread">, selected: string | null): "error" | "unread" | null {
  if (s.path === selected) return null;
  if (s.turnError) return "error";
  return s.unread ? "unread" : null;
}

/** The turn-error mark's tooltip: the fact, then pi's own error message when there is one. */
export function turnErrorTitle(e: NonNullable<SessionSummary["turnError"]>): string {
  return e.message ? `The last turn stopped with an error: ${e.message}` : "The last turn stopped with an error.";
}

/**
 * The row's needs-you mark, or null. The server decides the kinds (its thresholds, never re-derived
 * here) and sends `signals` only while the mark should show; `seenAt ≥ at` is checked again because
 * it is the rule. This tab adds what it knows sooner than the last list: the open session never
 * shows it (you're looking at it), and neither does one this tab is running a turn in. The
 * session's own kinds win a tie with its subagents'.
 */
export function rowNeedsYou(
  s: Pick<SessionSummary, "path" | "signals" | "workerSignals" | "seenAt">,
  opts: { selected: string | null; busy: boolean },
): NeedsYouMark | null {
  if (s.path === opts.selected || opts.busy) return null;
  const own = s.signals && !(s.seenAt !== undefined && s.seenAt >= s.signals.at) ? s.signals.kinds : [];
  const w = s.workerSignals;
  const workers: SignalKind[] = w && w.stuck > 0 ? ["looping"] : [];
  for (const kind of SIGNAL_PRECEDENCE) {
    if (own.includes(kind)) return { kind, worker: false };
    if (workers.includes(kind)) return { kind, worker: true };
  }
  return null;
}

/** The mark's glyph and class (src/design/base.css, "DECISIONS"): the shape differs per kind, so hue isn't alone. */
export const SIGNAL_ICON = { "asks-you": "chat", looping: "refresh" } as const satisfies Record<SignalKind, string>;
export const SIGNAL_CLASS: Record<SignalKind, string> = {
  "asks-you": "session-signal session-signal-asks",
  looping: "session-signal session-signal-looping",
};

/** The mark's hidden words, read as part of the row's name (trailing space: the title follows). */
export function signalWords(m: NeedsYouMark): string {
  if (m.worker) return "A subagent may be stuck. ";
  return { "asks-you": "Asks you. ", looping: "May be looping. " }[m.kind];
}

/** The mark's tooltip: the same fact, one sentence. */
export function signalTitle(m: NeedsYouMark): string {
  if (m.worker) return "A subagent looks stuck.";
  return {
    "asks-you": "The last reply asks you something.",
    looping: "The last turn looks like it went in circles.",
  }[m.kind];
}

const STATUS_WORD: Record<NonNullable<SessionTags["status"]>, string> = {
  done: "done",
  in_progress: "in progress",
  abandoned: "abandoned",
  blocked: "blocked",
};
/** Topic display words; a topic not listed shows as its id. */
const TOPIC_WORD: Partial<Record<NonNullable<SessionTags["topic"]>, string>> = { bugfix: "bug fix" };

/** The status tag's word on line 3, or null with no status tag. */
export const tagStatusWord = (tags: SessionTags | undefined): string | null => (tags?.status ? STATUS_WORD[tags.status] ?? null : null);

/** The topic's display word, or null with no topic tag. */
export const tagTopicWord = (tags: SessionTags | undefined): string | null => (tags?.topic ? TOPIC_WORD[tags.topic] ?? tags.topic : null);

/** Line 3's tooltip when the session is tagged: "Topic: bug fix · status: done (tagged automatically)". */
export function tagsTitle(tags: SessionTags | undefined): string | null {
  const topic = tagTopicWord(tags);
  const status = tagStatusWord(tags);
  if (!topic && !status) return null;
  const parts = [topic && `Topic: ${topic}`, status && `${topic ? "status" : "Status"}: ${status}`].filter(Boolean);
  return `${parts.join(" · ")} (tagged automatically)`;
}

/** What the session search matches in a row's tags: topic and status, by id and by display word, and the user's own tags. */
export function tagSearchText(tags: SessionTags | undefined): string {
  if (!tags) return "";
  return [tags.topic, tagTopicWord(tags), tags.status, tagStatusWord(tags), ...(tags.user ?? [])].filter(Boolean).join(" ");
}

// ---- The live feed's overlay ---------------------------------------------------------------------

/** The overlaid fields, one session's worth. */
type Marks = Pick<SessionSummary, "signals" | "workerSignals" | "tags" | "turnError">;
const MARK_FIELDS = ["signals", "workerSignals", "tags", "turnError"] as const;

/**
 * What the feed has said, keyed by session path. `complete` is true once a full snapshot arrived on
 * this connection: then a path the feed never named has no marks at all, whatever the last list
 * said. Before that (connecting, or down) the overlay holds nothing and the list is the truth.
 */
export interface MarksOverlay {
  complete: boolean;
  byPath: ReadonlyMap<string, Marks>;
}

export const EMPTY_OVERLAY: MarksOverlay = { complete: false, byPath: new Map() };

/** Folds one `marks` message in: `full` replaces everything; a delta sets a field, `null` clears it, absence keeps it. */
export function applyMarks(overlay: MarksOverlay, msg: { full?: true; sessions: SessionMarks[] }): MarksOverlay {
  const byPath = new Map(msg.full ? [] : overlay.byPath);
  for (const m of msg.sessions) {
    const next: Record<string, unknown> = { ...(byPath.get(m.path) ?? {}) };
    for (const k of MARK_FIELDS) {
      if (m[k] === null) delete next[k];
      else if (m[k] !== undefined) next[k] = m[k];
    }
    byPath.set(m.path, next as Marks);
  }
  return { complete: overlay.complete || !!msg.full, byPath };
}

/**
 * The row as the feed has it: the list's summary with the overlay's marks in place of its own. Rows
 * the feed doesn't speak for keep the list's fields — every row until the first full snapshot, and
 * always a peer's row (`foreign`: the feed is this host's). An untouched row comes back as the same
 * object; a caller keeps identity across feed messages with `reuseUnchanged`.
 */
export function overlaid(s: SessionSummary, overlay: MarksOverlay, foreign = false): SessionSummary {
  if (foreign || !overlay.complete) return s;
  const m = overlay.byPath.get(s.path);
  if (MARK_FIELDS.every((k) => JSON.stringify(m?.[k]) === JSON.stringify(s[k]))) return s;
  const out: SessionSummary = { ...s };
  for (const k of MARK_FIELDS) {
    const v = m?.[k];
    if (v === undefined) delete out[k];
    else Object.assign(out, { [k]: v });
  }
  return out;
}

// ---- List nudges -------------------------------------------------------------------------------

/** The least time between two list re-reads the feed asks for. */
export const LIST_NUDGE_GAP_MS = 1000;

export interface NudgeTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The feed's `list_changed` nudges, turned into list re-reads: the first runs at once, and any that
 * arrive within `gapMs` of the last run fold into ONE trailing run, `gapMs` after it. A burst (a TUI
 * starting, its first turn, a busy flip) costs two reads, not one per message, and the last nudge of
 * a burst is always followed by a read, so the list never stops short of the change that caused it.
 */
export function createNudgeThrottle(run: () => void, gapMs = LIST_NUDGE_GAP_MS, timers: NudgeTimers = globalTimers) {
  let last = -Infinity;
  let pending: unknown = null;
  const fire = () => {
    pending = null;
    last = timers.now();
    run();
  };
  return {
    nudge() {
      if (pending !== null) return;
      const wait = last + gapMs - timers.now();
      if (wait <= 0) fire();
      else pending = timers.setTimeout(fire, wait);
    },
    cancel() {
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
    },
  };
}

const globalTimers: NudgeTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
