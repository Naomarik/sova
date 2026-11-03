import { type ChecksDeclared, type MergeEntry, type MergeLanded, type MergeQueueView, type MergeRun, WAITING_FOR_USER, type WorktreeQueueInfo } from "../../shared/merge-queue";
import type { QueueFile } from "./store";

/**
 * The queue as the screens read it (merge.status, the `merge_queue` feed event, the worktree rows). Pure: the queue
 * hands in its records, its current run and the estimate.
 */

/** The fallback for a run's length before any history exists. */
export const DEFAULT_TAKES_MS = 10 * 60_000;
const RECENT = 20;

const strip = (e: QueueFile["entries"][number]): MergeEntry => {
  const { seq: _seq, ...rest } = e;
  return structuredClone(rest);
};

export function buildView(a: {
  q: QueueFile;
  root: string;
  current: MergeRun | null;
  checks: ChecksDeclared;
  review: boolean;
  head: string;
  takesMs: number | null;
  now: number;
  readRun: (id: string) => MergeRun | null;
  /** Whether the project has origin, and origin's copy of the target as last fetched (refs/remotes/origin/<target>). */
  origin?: { has: boolean; tracking: string | null };
}): MergeQueueView {
  const takes = a.takesMs ?? DEFAULT_TAKES_MS;
  const queued = a.q.entries.filter((e) => e.state === "queued").sort((x, y) => x.seq - y.seq);
  // What is left of the run checking now, then each entry ahead.
  const left = a.current ? Math.max(0, takes - (a.now - Date.parse(a.current.startedAt))) : 0;
  const waiting = queued.map((e, i) => ({ ...strip(e), position: i + 1, eta: { startsInMs: left + i * takes, takesMs: takes } }));
  const byNewest = (x: { updatedAt: string }, y: { updatedAt: string }) => y.updatedAt.localeCompare(x.updatedAt);
  const checking = a.q.entries.filter((e) => e.state === "checking").map((e) => ({ ...strip(e), eta: { startsInMs: 0, takesMs: takes } }));
  const needsYou = a.q.entries.filter((e) => WAITING_FOR_USER.includes(e.state) || e.state === "conflict").map(strip).sort(byNewest);
  const needsFix = a.q.entries.filter((e) => e.state === "needs-fix").map(strip).sort(byNewest).slice(0, RECENT);
  const recent: MergeLanded[] = a.q.entries
    .filter((e) => e.state === "landed")
    .map(strip)
    .sort((x, y) => (y.landed?.at ?? y.updatedAt).localeCompare(x.landed?.at ?? x.updatedAt))
    .slice(0, RECENT)
    .map((entry) => {
      const r = entry.run ? a.readRun(entry.run) : null;
      return { entry, ...(r ? { run: { id: r.id, verdict: r.verdict, startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}), ...(r.noChecks ? { noChecks: true as const } : {}) } } : {}) };
    });
  const state: MergeQueueView["state"] = a.q.paused ? "paused" : a.current ? "running" : "idle";
  return {
    project: a.q.project,
    root: a.root,
    target: a.q.target,
    batch: 1,
    state,
    ...(a.q.paused ? { paused: { ...a.q.paused } } : {}),
    checks: a.checks,
    review: a.review,
    ...(a.current ? { current: structuredClone(a.current) } : {}),
    checking,
    waiting,
    needsYou,
    needsFix,
    recent,
    heads: { target: a.head, ...pushedOf(a.q.heads.pushed, a.origin), ...(a.q.heads.pushWhy ? { pushWhy: a.q.heads.pushWhy } : {}), ...(a.q.heads.targetRed?.length ? { targetRed: [...a.q.heads.targetRed] } : {}) },
    at: new Date(a.now).toISOString(),
  };
}

/**
 * origin's copy of the target as the strip shows it: the queue's own push when it made one, else the remote-tracking
 * ref (a project whose record started after its last push still reads Pushed); `hasOrigin` false only when the project
 * has no origin (No remote). Pure.
 */
export function pushedOf(recorded: string | undefined, origin: { has: boolean; tracking: string | null } | undefined): { pushed?: string; hasOrigin?: boolean } {
  const pushed = recorded ?? (origin?.has ? (origin.tracking ?? undefined) : undefined);
  return { ...(pushed ? { pushed } : {}), ...(origin ? { hasOrigin: origin.has } : {}) };
}

/** The worktree row's slice of the newest entry for `branch` (SessionWorktreeInfo.queue). */
export function worktreeQueueInfo(view: MergeQueueView, branch: string): WorktreeQueueInfo | undefined {
  const all: MergeEntry[] = [...view.checking, ...view.waiting, ...view.needsYou, ...view.needsFix, ...(view.waitingOnHost ?? []), ...view.recent.map((r) => r.entry)];
  const mine = all.filter((e) => e.branch === branch).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const e = mine[0];
  if (!e) return undefined;
  return {
    id: e.id,
    project: view.project,
    state: e.state,
    ...(e.position ? { position: e.position } : {}),
    commit: e.commit,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.newerCommits ? { newerCommits: e.newerCommits } : {}),
    ...(e.eta ? { eta: e.eta } : {}),
    notes: e.notes,
    ...(e.landed ? { landed: e.landed } : {}),
    ...(e.conflict ? { conflict: e.conflict } : {}),
    ...(e.review ? { review: e.review } : {}),
    ...(e.unclear?.length ? { unclear: e.unclear } : {}),
    ...(e.run ? { run: e.run } : {}),
    ...(e.request ? { request: e.request } : {}),
    ...(view.review ? { reviewKit: true } : {}),
  };
}
