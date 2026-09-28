// What a session view knows about its session before its own reads land (the insight load, the
// chat's hello), from what the client already holds: the session list's row and App's
// explanations poll. A view opening another session shows its "Current goal" strip and its
// composer status row from these at the first frame, so neither pops in and shifts the transcript.
// Each is this session's own fact, and each gives way to the view's own read once it lands.
// Pure: no reactive state, so the rules are testable (known-before-mount.test.ts).

import type { ExplanationInfo, SessionSummary, TranscriptItem } from "../../shared/protocol";
import { isInput } from "../../shared/row-counts";

/** The strip's collapsed row as the session list has it: the newest outline snapshot's lines. */
export interface KnownOutline {
  now: string;
  /** Topics in that snapshot. */
  topics: number;
  /** The snapshot's "overall" line; "" when the list doesn't carry one. */
  gist: string;
}

/** The session's outline, from its list row: null when the row has no snapshot. */
export function knownOutline(s: Pick<SessionSummary, "outlineNow" | "outlineTopics" | "outlineGist">): KnownOutline | null {
  if (s.outlineNow === undefined) return null;
  return { now: s.outlineNow, topics: s.outlineTopics ?? 0, gist: s.outlineGist ?? "" };
}

/** The session's /explain pages among App's polled list (the store's; the insight adds any the
    file alone records). */
export const knownExplanations = (all: readonly ExplanationInfo[] | undefined, sessionId: string): ExplanationInfo[] =>
  (all ?? []).filter((x) => x.parentSessionId === sessionId);

/**
 * The file holds a typed user message: its derived title (the first one that isn't a wake nudge or
 * a link message) is not the list's "Untitled", whatever the user renamed it to. Such a message is
 * an input, so the status row's inputs trigger will show; false says nothing (a first message past
 * the head read, or none yet).
 */
export const knownInputs = (s: Pick<SessionSummary, "title" | "originalTitle">): boolean => (s.originalTitle ?? s.title) !== "Untitled";

/** How many subagents the session's live record counts: the settled-workers row's number. */
export const knownWorkers = (s: Pick<SessionSummary, "workers" | "live">): number => (s.workers ?? s.live?.workers)?.total ?? 0;

/**
 * The settled-workers trigger's count: the socket's list once it has said, else the list's
 * (`known`). A runtime's first "workers" message can come before its subagents extension has
 * restored its workers (it lists none yet, and the next look is seconds later), so a said-empty
 * list doesn't override a known count: the live record says the runtime will list them.
 */
export const workersShown = (said: boolean, listed: number, known: number): number => (said && (listed > 0 || known === 0) ? listed : known);

/**
 * The inputs trigger will show, but its count is not known yet: the count needs what is above the
 * rows (the hello's, or the pair kept with them), and until then the trigger's box is held.
 * `count` is null until it is known. The rows on screen are this session's own, so an input among
 * them says so too.
 */
export const inputsPending = (count: number | null, list: readonly TranscriptItem[] | null, known: boolean): boolean =>
  count === null && (known || (list ?? []).some(isInput));
