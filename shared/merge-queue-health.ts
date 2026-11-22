/**
 * The merge queue's known state and numbers: what a run reused (Clean Run), the flaky tests seen across landings, the
 * history's pages and the health summary on top of Landed. Types only; additive to shared/merge-queue.ts.
 */
import type { MergeEntryState, RunVerdict, SentBackFor } from "./merge-queue";

/** Why a run started from an empty merge copy. `operator`: Clean Run pressed; `weekly`: the first run a week after the
 *  last clean one; `new`: the copy was cut new (nothing was there to reuse). */
export type CleanWhy = "operator" | "weekly" | "new";

/** The queue's clean-run standing (MergeQueueView.clean). */
export interface MergeCleanInfo {
  /** The next run starts from an empty copy: asked for by the operator (`entry`: the entry it was asked on), or due weekly. */
  next?: { why: CleanWhy; at: string; entry?: string };
  /** The last run that started from an empty copy. */
  last?: { at: string; run: string; why: CleanWhy };
  /** When the weekly clean run is due (the first run after it is clean). */
  dueAt?: string;
}

/** One flaky test as the queue counts it across landings: it failed in a run, then passed on its rerun. */
export interface MergeFlakyTest {
  /** Stable id: check + file + name. */
  key: string;
  check: string;
  checkLabel: string;
  /** The test file, when the runner names it. */
  file?: string;
  /** The test's name, when the runner names it. */
  name?: string;
  /** Runs that saw it fail, then pass on its rerun. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** Those runs, newest first (at most FLAKY_RUNS_KEPT). */
  runs: { run: string; entry: string; branch: string; at: string }[];
  /** Fix in New Chat was started for it. */
  fix?: { at: string; session: string; path: string };
}
export const FLAKY_RUNS_KEPT = 20;

/** One finished entry as a history page lists it (newest first). */
export interface MergeHistorySlim {
  id: string;
  branch: string;
  commit: string;
  state?: MergeEntryState;
  finalAt: string;
  /** When the user's Land approved it. */
  approvedAt?: string;
  landedAt?: string;
  /** Approval to landing. */
  timeToLandMs?: number;
  /** How many runs it had. */
  runs: number;
  /** Each send-back's cause, oldest first. */
  sentBack?: SentBackFor[];
  /** Its last run (the Run detail page). */
  run?: string;
  verdict?: RunVerdict;
  /** The branch's chat, when known (the row's link). */
  session?: string;
  /** Its last one line (why it stood where it stood). */
  reason?: string;
  partial?: true;
}

/** GET /api/merge-queue/:project/history: one page, newest first; `next`: pass it as `before` for Show Older. */
export interface MergeHistoryPage {
  rows: MergeHistorySlim[];
  next?: string;
}

/** GET /api/merge-queue/:project/health: the summary over the last `days`. */
export interface MergeQueueHealth {
  since: string;
  until: string;
  /** Entries that landed (or were pushed) in the window, and every entry that finished in it. */
  landed: number;
  finished: number;
  /** Approval to landing, over the entries that landed. */
  timeToLand: { medianMs: number | null; p90Ms: number | null };
  /** Runs that passed, of the runs that reached a verdict (void and cancelled ones left out). */
  passRate: { passed: number; runs: number; rate: number | null };
  /** The slowest checks by median time over their passing steps (reused-pass steps left out), slowest first. */
  slowestChecks: { id: string; label: string; medianMs: number; runs: number }[];
  /** The flakiest tests seen in the window, most often first. */
  flaky: MergeFlakyTest[];
  /** Why entries were sent back to their chats, most common first. */
  sendBacks: { why: SentBackFor; count: number }[];
  /** Runs in the window that started from an empty copy. */
  cleanRuns: number;
}
