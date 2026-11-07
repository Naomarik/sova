// Time Spent's wire contract (§app.subagents-pane/time-spent-record): what a page reports to the
// computer hosting a session, and what that computer answers about the session's record.
// Every duration is in whole seconds unless its name says otherwise.

/** Every counted second is in exactly one of these. */
export type TimeSpentRow =
  | "reading-transcript"
  | "reading-alignments"
  | "reading-workers"
  | "typing"
  | "dictating"
  | "scrolling"
  | "changes"
  | "screenshots"
  | "tours"
  | "other";

export const TIME_SPENT_ROWS: readonly TimeSpentRow[] = [
  "reading-transcript",
  "reading-alignments",
  "reading-workers",
  "typing",
  "dictating",
  "scrolling",
  "changes",
  "screenshots",
  "tours",
  "other",
];

export const TIME_SPENT_REPORT_ROUTE = "/api/time-spent/report";
export const TIME_SPENT_READ_ROUTE = "/api/time-spent";

/** The most a report may carry, whatever a page sends; over them the route answers 400. A row this computer doesn't
    know, within the id limit, counts as `other`. */
export const TIME_SPENT_MAX_BODY_BYTES = 64 * 1024;
export const TIME_SPENT_MAX_SLICES = 300;
export const TIME_SPENT_MAX_DOCS = 32;
export const TIME_SPENT_MAX_ID_CHARS = 128;

/** A run of identical seconds a page counted. It sends how old the run is, never a time of its own clock. */
export interface TimeSpentSlice {
  row: TimeSpentRow;
  /** Alignment documents on screen during the run: AlignDocInfo.id. An old-style report has none. */
  docs: string[];
  /** Whole seconds counted, at least 1. */
  sec: number;
  /** Milliseconds from the run's last second to this report being sent. */
  ageMs: number;
  /** This run, unique within its pageId and the same on every try: a resend whose answer was lost counts once. The
      page gives it at the first send and adds no seconds to the run after. A page without it is counted as ever. */
  id?: number;
}

/** POST /api/time-spent/report (keepalive). Answers 200 {ok:true}; a report for a session whose file is
    gone is answered the same and kept nowhere. */
export interface TimeSpentReport {
  /** This page load's id: reports with the same one are one page's. */
  pageId: string;
  /** The session the seconds belong to. */
  path: string;
  /** Milliseconds since this page's newest real input. */
  inputAgeMs: number;
  /** Oldest first. */
  slices: TimeSpentSlice[];
}

export interface TimeSpentAlignment {
  /** AlignDocInfo.id: the document, across its revisions. */
  docId: string;
  /** The newest revision's title. */
  title: string;
  /** Counted seconds any card of this document was on screen. Overlaps the rows. */
  onScreen: number;
  /** The newest revision's estimated reading time, at about 250 words a minute. */
  toRead: number;
  /** Epoch ms this computer first recorded a card of it on screen; null with no such moment. */
  firstShownAt: number | null;
  /** Seconds from firstShownAt to the revision where its last question became decided. Null while a question
      is open, with no questions, or with no firstShownAt. */
  toDecided: number | null;
}

/** GET /api/time-spent?path=<session path>. */
export interface TimeSpentRecord {
  /** The sum of `rows`, always. */
  you: number;
  /** Only rows with time. */
  rows: Partial<Record<TimeSpentRow, number>>;
  /** Seconds the main thread's finished turns took over the session's whole active branch, plus the running turn's so far. */
  agent: number;
  /** Seconds of `agent` that are the turn still running at this answer, or null with none: the page adds what passes after it. */
  agentRunning: number | null;
  /** One per alignment document in the session, oldest first. */
  alignments: TimeSpentAlignment[];
  /** The session began before this computer kept Time Spent: its earlier time wasn't recorded. */
  older: boolean;
}
