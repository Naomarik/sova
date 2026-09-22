/** Shared types for the topic-outline extension. */

/** Where a topic points in the conversation. */
export interface Anchor {
  entryId: string;
  role: "user" | "assistant";
  timestamp?: number;
  /** Normalized message text prefix used to verify transcript rows. Empty if unknown. */
  fingerprint: string;
}

export interface Topic {
  id: string;
  heading: string;
  anchor: Anchor;
  summary: string[];
  at: number;
  /** True when created instantly from a `#`-prefixed user message. */
  manual?: boolean;
}

export type OutlineStateName = "none" | "drafting" | "fresh" | "updating" | "stale" | "failed-keeping-last";

/** Data persisted in the session file via pi.appendEntry("topic-outline", data). */
export interface OutlineData {
  version: 2;
  topics: Topic[];
  now: string;
  overall: string;
  topicCounter: number;
  /** Session entry id of the last message covered by `topics`/`now`/`overall`. */
  basisLeafId?: string;
  generatedAt: number;
  state: Exclude<OutlineStateName, "updating" | "drafting">;
  /** Derived latest heading (see OutlineStore.lastHeading). Absent in older snapshots. */
  lastHeading?: string;
  /** Heading of the most recent user `#`-topic; source of truth for lastHeading. */
  lastManualHeading?: string;
  /** The earliest user request seen on the branch, clipped: the anchor `overall` describes.
   *  Kept here so it survives compaction and delta advance. Absent in older snapshots. */
  purpose?: string;
}

/** Wire format returned by summarizers (validated before use). */
export interface SummarizerResult {
  now: string;
  overall: string;
  topicUpdates: {
    kind: "new" | "update";
    heading: string;
    /** Existing topic id (t1, t2…) for kind "update"; omitted for "new". */
    topicId?: string;
    /** New-message ref like "m12". */
    anchor: string;
    summary: string[];
  }[];
}

export interface SummarizerSpec {
  backend: "claude-code" | "pi";
  model: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface OutlineConfig {
  summarizers: SummarizerSpec[];
  trigger: { debounceMs: number; minNewMessages: number };
  shareWithSessions: "off" | "now-only" | "summary";
  /** Include lastHeading (short user-authored `#` text) in the sessions broadcast. */
  shareLastHeading: boolean;
  claudeBin: string;
  limits: { maxTopics: number; maxBullets: number };
}

/** What the extension broadcasts on pi.events as "topic-outline:snapshot". */
export interface OutlineBroadcast {
  sessionId: string;
  state: OutlineStateName;
  generatedAt: number;
  now?: string;
  overall?: string;
  topics?: string[];
  /** Latest user `#` heading (or latest topic heading); omitted when empty or not shared. */
  lastHeading?: string;
  /**
   * "summary" mode only (additive, no version field; consumers ignore unknown keys):
   * up to 6 most recent topics, newest first, each with ≤3 bullets. Headings ≤60 chars,
   * bullets ≤120 chars, control characters stripped. Omitted under "now-only".
   */
  detail?: { heading: string; bullets: string[] }[];
}

/** Input handed to a summarizer backend. */
export interface SummarizeInput {
  /** Compact JSON of topics (id + heading + summary) handed to the summarizer. */
  existingOutline: string;
  /** New lines since the last run: "[m12] USER: ..." etc. */
  newLines: string[];
  /** refs (m12) that may appear in the result's anchor fields. */
  validRefs: Set<string>;
  /** The earliest user request still on the branch, clipped: the anchor for "overall".
   *  Empty when the branch holds no user text (or the session predates this field). */
  purpose?: string;
  signal: AbortSignal;
}

export interface Summarizer {
  name: string;
  summarize(input: SummarizeInput): Promise<SummarizerResult>;
}

export class SummarizerError extends Error {
  /** True for transient problems that should trigger the next summarizer. */
  readonly fallback = true;
}
