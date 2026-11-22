/**
 * Clean runs (pure): whether a run starts from an empty merge copy, and the queue's standing for the view. The copy is
 * reused by default (installed packages, build output, the setup cache); a run is clean when the user asked for it
 * (Clean Run), or when it is the first run a week after the last clean one (or with none recorded). A copy cut new is
 * clean by itself (run.ts reports it).
 */
import type { CleanWhy, MergeCleanInfo } from "../../shared/merge-queue-health";

export const CLEAN_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** What queue.json keeps (QueueFile.clean): Clean Run's ask (`branch`: asked on that branch's entry, so only its run
 *  takes it), and the last run that was clean. */
export type CleanState = { next?: { why: CleanWhy; at: string; entry?: string; branch?: string }; last?: { at: string; run: string; why: CleanWhy } } | undefined;

/** Does Clean Run's ask apply to a run of `branch`? An ask on a branch's entry waits for that branch's run. */
const askFits = (next: NonNullable<CleanState>["next"], branch: string | undefined): boolean => !!next && (!next.branch || next.branch === branch);

/** Why the run of `branch` starting at `now` (epoch ms) is clean, or undefined: it reuses the copy. */
export function cleanFor(c: CleanState, now: number, branch?: string): CleanWhy | undefined {
  if (askFits(c?.next, branch)) return c!.next!.why;
  const last = c?.last ? Date.parse(c.last.at) : NaN;
  if (!Number.isFinite(last) || now - last >= CLEAN_EVERY_MS) return "weekly";
  return undefined;
}

/** The standing after a run that reported `clean` (its why): the last clean run, and Clean Run's ask spent, unless it
 *  was asked after that run started or for another branch's run. A run that reused the copy changes nothing. */
export function afterRun(c: CleanState, run: { id: string; branch?: string; startedAt: string; clean?: CleanWhy }): CleanState {
  if (!run.clean) return c;
  const next = c?.next;
  const keep = !!next && (Date.parse(next.at) > Date.parse(run.startedAt) || !askFits(next, run.branch));
  return { ...(keep ? { next: { ...next! } } : {}), last: { at: run.startedAt, run: run.id, why: run.clean } };
}

/** The view's clean-run standing at `now`. */
export function cleanInfo(c: CleanState, now: number): MergeCleanInfo {
  const last = c?.last && Number.isFinite(Date.parse(c.last.at)) ? c.last : undefined;
  const dueAt = new Date(last ? Math.max(now, Date.parse(last.at) + CLEAN_EVERY_MS) : now).toISOString();
  return { ...(c?.next ? { next: { ...c.next } } : {}), ...(last ? { last: { ...last } } : {}), dueAt };
}
