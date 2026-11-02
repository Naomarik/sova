// A project's merge queue as the project page's other rows read it (coding-session worktrees, a
// proposed playbook run): is the queue set up, and what state each branch is in. One read per
// project id at a time; read again on any queue action and adopted from the session feed.
import { createEffect, createResource, on, type Accessor } from "solid-js";
import type { MergeEntry, MergeQueueView, WorktreeQueueInfo } from "../../shared/merge-queue";
import { getProject } from "./api";
import { mergeChanged, mergeFeed, readQueue } from "./merge-queue-client";

const roots = new Map<string, Promise<string>>();
/** The project's root, read once per id. */
const rootOf = (projectId: string): Promise<string> => {
  let r = roots.get(projectId);
  if (!r) {
    r = getProject(projectId).then((p) => p.root);
    r.catch(() => roots.delete(projectId));
    roots.set(projectId, r);
  }
  return r;
};

/** The newest entry for a branch in a view, from whichever list holds it. */
export function entryForBranch(v: Pick<MergeQueueView, "checking" | "waiting" | "needsYou" | "needsFix" | "recent">, branch: string | null | undefined): MergeEntry | undefined {
  if (!branch) return undefined;
  const all = [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix, ...v.recent.map((l) => l.entry)].filter((e) => e.branch === branch);
  return all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

/** An entry as a worktree row reads it (SessionWorktreeInfo.queue's shape). */
export const queueInfoOf = (e: MergeEntry): WorktreeQueueInfo => ({
  id: e.id,
  state: e.state,
  position: e.position,
  commit: e.commit,
  reason: e.reason,
  newerCommits: e.newerCommits,
  eta: e.eta,
  notes: e.notes,
  landed: e.landed,
  conflict: e.conflict,
  review: e.review,
  project: e.project,
  run: e.run,
});

export interface ProjectQueue {
  view: Accessor<MergeQueueView | undefined>;
  root: Accessor<string | undefined>;
  /** Its queue is set up: Land replaces Merge Branch. False until known. */
  setUp: Accessor<boolean>;
  /** A branch's queue state, or undefined when it has no entry. */
  info(branch: string | null | undefined): WorktreeQueueInfo | undefined;
}

/** Reads `projectId`'s queue for as long as the caller lives. */
export function createProjectQueue(projectId: Accessor<string | null | undefined>): ProjectQueue {
  const [root] = createResource(projectId, (id) => rootOf(id));
  const [view, { refetch, mutate }] = createResource(root, (r) => readQueue(r));
  createEffect(on(mergeChanged, () => root() && void refetch(), { defer: true }));
  createEffect(on(mergeFeed, (f) => f && f.project === projectId() && mutate(f.view), { defer: true }));
  const latest = () => (view.error ? undefined : view.latest);
  return {
    view: latest,
    root: () => root.latest,
    // Not while the definition doesn't parse: the queue refuses every Land then, so Merge Branch stays
    // (it is how a branch that fixes .sova/project.json gets in).
    setUp: () => !!latest() && !latest()!.invalid && latest()!.checks !== "unset",
    info: (branch) => {
      const v = latest();
      const e = v && entryForBranch(v, branch);
      return e && e.state !== "cancelled" ? queueInfoOf(e) : undefined;
    },
  };
}
