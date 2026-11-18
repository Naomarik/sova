// The Agents page's Time Spent tab's wire contract: your time (every session's Time Spent record on
// this computer, deleted sessions' kept as per-day totals) beside agent time (measured replies and
// tool runs). Types and constants only. Every duration is in seconds (whole or fractional) unless its
// name says otherwise.
//
// Route (main listener only, relayed unparsed from the usage helper, like shared/usage/wire.ts):
//   GET /api/usage/time?range=7d|30d|all[&project=<row key>]&tz=<zone> -> UsageTime
// `project` is a By Project row's `key` (UsageTimeProjectRow.key); an unknown key matches nothing.
// The helper not running: 503 `{error: "usage-unavailable"}`; a bad parameter: 400 `{error}`.

import type { TimeSpentRow } from "../time-spent";
import type { UsageDevice, UsageProjectKind, UsageRange } from "./wire";

export type { TimeSpentRow };

/** A message label as Your Messages totals it (server/message-labels.ts MessageLabel). */
export type UsageTimeLabel = "specifying" | "directing" | "reworking" | "asking" | "unsorted";
export const USAGE_TIME_LABELS: readonly UsageTimeLabel[] = ["specifying", "directing", "reworking", "asking", "unsorted"];

/** Who an agent second belongs to (the session's kind; a side call's time is its owner's). */
export type UsageTimeWho = "main" | "worker" | "overseer";
export const USAGE_TIME_WHO: readonly UsageTimeWho[] = ["worker", "main", "overseer"];

/** What an agent second was spent on. `waiting`: request sent to its first part, and any gap between
    parts; `thinking`/`writing`: the reply's thinking and text+tool-call windows; `tools`: tool runs. */
export type UsageTimeWhat = "waiting" | "thinking" | "writing" | "tools";
export const USAGE_TIME_WHAT: readonly UsageTimeWhat[] = ["thinking", "writing", "tools", "waiting"];

/** Top Sessions lists at most this many. */
export const USAGE_TIME_TOP_SESSIONS = 20;

/** One local day of the range, every day listed (zero days too), oldest first. */
export interface UsageTimeDay {
  /** `yyyy-mm-dd` in the asked zone. */
  day: string;
  you: number;
  /** Agent hours (parallel sessions each count), Waiting On Workers never included. */
  agents: number;
  /** A main thread's tool time spent waiting on its own workers: shown apart, never in `agents`. */
  workerWait: number;
}

/** When each kind of time began being recorded on this computer (ms epoch), or null when none yet. */
export interface UsageTimeSince {
  /** Your time (the Time Spent record's first run, or its `since` file). */
  you: number | null;
  /** Agent model time (the first measured reply). */
  agents: number | null;
  /** Tool-running time (the first tool-run record): days before it count model time only. */
  tools: number | null;
  /** The first label line carrying its message's send time; earlier labels are placed by when they were labelled. */
  labels: number | null;
}

export interface UsageTimeTotals {
  you: number;
  agents: number;
  workerWait: number;
  /** Agent seconds that fell in moments you were at no session on this computer (`agents` minus the
      overlap with the union of your runs). */
  away: number;
  /** Agent Hours Per Your Hour: `ratioAgents / ratioYou`, over the days your time was recorded
      (days with any of your time); null with no such day. */
  ratio: number | null;
  ratioAgents: number;
  ratioYou: number;
  /** Days with any of your time in the range (the headline's "a day you were here"). */
  daysYou: number;
}

/** Your Time: the same rows as a session's Time Spent tab, summed. Only rows with time. */
export type UsageTimeYou = Partial<Record<TimeSpentRow, number>>;

export interface UsageTimeModelRow {
  provider: string;
  /** As the Costs tab's rows name it. */
  model: string;
  /** Model time (waiting + thinking + writing) of its replies; tool time is not split by model. */
  seconds: number;
  replies: number;
}

export interface UsageTimeAgents {
  /** Each sums to `totals.agents`. */
  who: Record<UsageTimeWho, number>;
  what: Record<UsageTimeWhat, number>;
  /** Most seconds first. */
  models: UsageTimeModelRow[];
}

/** A By Project row: grouped exactly as the Costs tab's By project table (project-fold.ts). */
export interface UsageTimeProjectRow {
  /** The row's id: `p:<prj_…>`, `f:<checkout folder>`, `o` (Overseer), `x` (Other folders). The `project` filter's value. */
  key: string;
  kind: UsageProjectKind;
  name: string;
  path?: string;
  /** `prj_…` for a project row. */
  project?: string;
  archived?: true;
  /** How many distinct folders its time was in. */
  folders: number;
  you: number;
  agents: number;
  /** Its agent seconds on the days your time was recorded (the ratio's numerator). */
  agentsOnYourDays: number;
  /** This row's agents / you over the days your time was recorded; null with no such time. */
  ratio: number | null;
  /** Its owners' spend in the range at API prices (the Costs tab's figure). */
  usd: number;
  /** Tokens of its calls with no price (they add no dollars). */
  unpricedTokens: number;
}

/** A Top Sessions row: a top-level session (living only: a deleted one's time stays in its project's row).
    A worker has no row of its own: its time and spend are its top-level session's. */
export interface UsageTimeSessionRow {
  sid: string;
  kind: UsageTimeWho;
  /** Null for a top-level session (kept for the row's shape; a worker never has a row). */
  parent: string | null;
  worker: string | null;
  cwd: string | null;
  project: string | null;
  /** The By Project row it falls in. */
  row: string;
  /** Your time at the session and at its workers' own tabs. */
  you: number;
  /** Agent time of the session and its workers at any depth. */
  agents: number;
  /** Spend of the session and its workers in the range. */
  usd: number;
  /** Its newest moment of either time (ms). */
  lastAt: number;
}

export interface UsageTimeMessageRow {
  label: UsageTimeLabel;
  /** Labelled messages placed in the range. */
  count: number;
  /** The time credited to these messages: your seconds in each one's session since the message or action
      (a Land press, a button's press) before it, up to its send. */
  seconds: number;
}

export interface UsageTimeMessages {
  /** The message labels switch (features.messageLabels): off, the section isn't offered. */
  enabled: boolean;
  /** Only labels with messages, in USAGE_TIME_LABELS order. */
  rows: UsageTimeMessageRow[];
  /** Some messages had no send time recorded and were placed by when they were labelled. */
  byLabelTime: boolean;
}

/** GET /api/usage/time: the Agents page's Time Spent tab. */
export interface UsageTime {
  device: UsageDevice;
  range: UsageRange;
  /** First and last local day covered; `from` null when nothing is recorded yet. */
  from: string | null;
  to: string;
  /** ms: when the helper answered. */
  asOf: number;
  /** The project filter as applied (a row key), or null. */
  project: string | null;
  since: UsageTimeSince;
  /** Filtered. */
  days: UsageTimeDay[];
  totals: UsageTimeTotals;
  you: UsageTimeYou;
  /** Your Time's Reading rows' parent: these three rows sum to it. */
  agents: UsageTimeAgents;
  /** Every row with any time in the range, IGNORING the project filter (the filter's choices); most of your time first. */
  projects: UsageTimeProjectRow[];
  /** Filtered; most of your time first, at most USAGE_TIME_TOP_SESSIONS. */
  sessions: UsageTimeSessionRow[];
  /** Filtered. */
  messages: UsageTimeMessages;
}
