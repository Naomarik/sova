import type { StartedRow } from "./project-overseer-store";
import { readWorktree } from "./project-worktrees";

/**
 * Whether a project's coding session (a build) is merged, for the session list's `org.finished`
 * (§app.organizations/org-sessions): the project page's own answer — git's while the branch exists
 * and can be read, else the recorded merge or the branch's removal — read in the background at most
 * every BUILD_TTL_MS per session, so a listing never waits on git. Until git has answered once, the
 * list says what started.json recorded; a Merge Branch here updates it at once.
 */
export const BUILD_TTL_MS = 30_000;

type Reading = { merged: boolean; branch: boolean; error?: string };
type Reader = (row: StartedRow & { worktree: NonNullable<StartedRow["worktree"]> }, root: string) => Promise<Reading>;

let reader: Reader = (row, root) => readWorktree(row.worktree, root);
const known = new Map<string, { merged: boolean; at: number }>();
const reading = new Set<string>();

const recorded = (row: StartedRow): boolean => !!row.merged || !!row.branchDeleted;

export function buildMerged(row: StartedRow, root: string | null, now = Date.now()): boolean {
  const w = row.worktree;
  if (!w) return false; // it runs in the project root: nothing to merge
  const had = known.get(row.sessionId);
  if (root && (!had || now - had.at >= BUILD_TTL_MS) && !reading.has(row.sessionId)) {
    reading.add(row.sessionId);
    void reader({ ...row, worktree: w }, root)
      .then(
        (r) => known.set(row.sessionId, { merged: r.branch && !r.error ? r.merged : r.merged || recorded(row), at: now }),
        () => known.set(row.sessionId, { merged: recorded(row), at: now }),
      )
      .finally(() => reading.delete(row.sessionId));
  }
  return had ? had.merged : recorded(row);
}

/** Merge Branch just ran (or git was read elsewhere): the list knows now. */
export function noteBuildMerged(sessionId: string, merged: boolean, now = Date.now()): void {
  known.set(sessionId, { merged, at: now });
}

/** Tests: a fresh process, and git's stand-in. */
export function resetBuildMerged(): void {
  known.clear();
  reading.clear();
  reader = (row, root) => readWorktree(row.worktree, root);
}
export function setBuildReader(r: Reader): void {
  reader = r;
}
