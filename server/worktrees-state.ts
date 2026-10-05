// A session's tracked worktrees for the Session tab (§chat.worktrees/pane) and its merge cards in
// the transcript (§chat.worktrees/merge-card). The set and the card details are the worktrees
// extension's own (pi-config/extensions/worktrees/state.ts, builtins only), read by the same fold
// the extension restores with; the "already merged" check is its own probeMerge (git.ts, argv only).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionWorktreeInfo, WorkerStatus, WorktreeMergeInfo } from "../shared/protocol";
import { probeMerge, runGit } from "../pi-config/extensions/worktrees/git.ts";
import {
  canonical,
  isWithin,
  normalizeMergeDetails,
  sharedWith,
  type TrackedWorktree,
  WORKTREE_MERGE_MESSAGE,
  type WorktreesActive,
} from "../pi-config/extensions/worktrees/state.ts";
import { stateViewOf } from "./harness/pi/state";
import { WORKTREES } from "./harness/state-kinds";

export { WORKTREE_MERGE_MESSAGE };

/** The newest usable `worktrees` record on a branch (raw entries or HEntries), as the extension restores it.
    Never throws. */
export function worktreesOf(branch: readonly unknown[]): WorktreesActive | undefined {
  try {
    return stateViewOf(branch).latest(WORKTREES)?.data;
  } catch {
    return undefined;
  }
}

/** A `worktree-merge` extension message's details, or null when they can't be read. */
export function mergeInfoOf(details: unknown): WorktreeMergeInfo | null {
  const d = normalizeMergeDetails(details);
  if (!d) return null;
  const { version: _v, ...info } = d;
  return info;
}

/** A worker process that is still there: what "running workers" counts. */
const ALIVE: ReadonlySet<WorkerStatus> = new Set(["starting", "running", "waiting", "stopping"]);

/** The "already merged" answer per tree, briefly cached: the insight is polled every few seconds. */
const MERGE_TTL_MS = 10_000;
const mergeCache = new Map<string, { at: number; value: SessionWorktreeInfo["mergedInto"] | null }>();

async function mergedInto(t: TrackedWorktree, now: number): Promise<SessionWorktreeInfo["mergedInto"] | undefined> {
  const key = `${t.path}\0${t.branch}\0${t.base}\0${t.baseBranch ?? ""}`;
  const hit = mergeCache.get(key);
  if (hit && now - hit.at < MERGE_TTL_MS) return hit.value ?? undefined;
  let value: SessionWorktreeInfo["mergedInto"] | null = null;
  try {
    const p = await probeMerge(runGit, t);
    if (p?.merged) value = { target: p.target, sha: p.targetSha };
  } catch {
    value = null;
  }
  mergeCache.set(key, { at: now, value });
  if (mergeCache.size > 500) mergeCache.delete(mergeCache.keys().next().value!);
  return value ?? undefined;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The pane's rows: each tracked worktree with what the file does not say — whether it still
 * exists, has a `.agent`, is already merged (active ones), and how many of this session's live
 * workers run inside it. `workers` pairs each worker's status with its cwd from its record.
 */
export async function describeWorktrees(
  set: WorktreesActive | undefined,
  sessionId: string | null,
  workers: { status: WorkerStatus; cwd?: string }[],
  now = Date.now(),
): Promise<SessionWorktreeInfo[] | undefined> {
  if (!set || set.trees.length === 0) return undefined;
  const alive = workers.filter((w) => ALIVE.has(w.status) && w.cwd).map((w) => canonical(w.cwd!));
  return Promise.all(
    set.trees.map(async (t) => {
      const exists = existsSync(t.path);
      const root = canonical(t.path);
      const shared = sharedWith(t, sessionId ?? undefined);
      const merged = t.status === "active" && exists ? await mergedInto(t, now) : undefined;
      const row: SessionWorktreeInfo = {
        path: t.path,
        branch: t.branch,
        status: t.status,
        ...(t.merge ? { merge: { target: t.merge.target, sha: t.merge.sha, how: t.merge.how, at: t.merge.at } } : {}),
        ...(merged ? { mergedInto: merged } : {}),
        how: t.how,
        ...(shared ? { sharedWith: shared } : {}),
        exists,
        hasAgentDir: exists && isDir(join(t.path, ".agent")),
        runningWorkers: alive.filter((c) => isWithin(c, root)).length,
      };
      return row;
    }),
  );
}
