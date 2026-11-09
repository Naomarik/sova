import { type ChecksDeclared, type MergeEntry, type MergeLanded, type MergeQueueView, type MergeRun, type MergeSettled, WAITING_FOR_USER, type WorktreeQueueInfo } from "../../shared/merge-queue";
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
  /** The queue serves the project (served.ts); default true. */
  served?: boolean;
  /** Sent-back entries git says need no fix any more, by entry id (the queue reads them: settledFacts). */
  settled?: ReadonlyMap<string, Exclude<MergeSettled, "superseded">>;
}): MergeQueueView {
  const takes = a.takesMs ?? DEFAULT_TAKES_MS;
  const queued = a.q.entries.filter((e) => e.state === "queued").sort((x, y) => x.seq - y.seq);
  // What is left of the run checking now, then each entry ahead.
  const left = a.current ? Math.max(0, takes - (a.now - Date.parse(a.current.startedAt))) : 0;
  const waiting = queued.map((e, i) => ({ ...strip(e), position: i + 1, eta: { startsInMs: left + i * takes, takesMs: takes } }));
  const byNewest = (x: { updatedAt: string }, y: { updatedAt: string }) => y.updatedAt.localeCompare(x.updatedAt);
  const checking = a.q.entries.filter((e) => e.state === "checking").map((e) => ({ ...strip(e), eta: { startsInMs: 0, takesMs: takes } }));
  // Can't tell whose failure is the user's once raised to them; while the merge thread rules first it isn't yet.
  const needsYou = a.q.entries.filter((e) => (WAITING_FOR_USER.includes(e.state) && !(e.state === "unattributed" && e.ruling?.unattributed)) || e.state === "conflict").map(strip).sort(byNewest);
  const needsFix = sentBack(a.q.entries, a.settled);
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
    served: a.served ?? true,
    ...(a.current ? { current: structuredClone(a.current) } : {}),
    checking,
    waiting,
    needsYou,
    needsFix,
    recent,
    heads: { target: a.head, ...pushedOf(a.q.heads.pushed, a.origin), ...(a.q.heads.pushWhy ? { pushWhy: a.q.heads.pushWhy } : {}), ...(a.q.heads.targetRed?.length ? { targetRed: [...a.q.heads.targetRed] } : {}), ...(a.q.heads.targetBroken?.length ? { targetBroken: structuredClone(a.q.heads.targetBroken) } : {}) },
    at: new Date(a.now).toISOString(),
  };
}

type Stored = QueueFile["entries"][number];

/** `b` came after `a`: by creation time, ties by the queue's sequence (not sequence first: putting an entry first in
 *  line lowers its seq below older entries'). */
const later = (b: Pick<Stored, "seq" | "createdAt">, a: Pick<Stored, "seq" | "createdAt">): boolean => {
  const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return d !== 0 ? d > 0 : typeof b.seq === "number" && typeof a.seq === "number" && b.seq > a.seq;
};

/** A sent-back entry whose branch has a later entry for the same target, in any state: that one stands for it. */
export function superseded(entries: readonly Stored[], e: Stored): boolean {
  return entries.some((o) => o.id !== e.id && o.branch === e.branch && o.target === e.target && later(o, e));
}

/**
 * The view's needsFix list, newest first, each marked `settled` when it no longer needs a fix (superseded here, merged
 * or gone from `facts`). The 20-row cap counts only entries that still need a fix, so settled ones never push a current
 * one out; settled ones ride along only from the 20 newest overall (what the list held before), so a run or card that
 * looks its entry up in needsFix still finds it.
 */
export function sentBack(entries: readonly Stored[], facts?: ReadonlyMap<string, Exclude<MergeSettled, "superseded">>): MergeEntry[] {
  const all = entries
    // Back with its chat under the user's standing Land (with-chat) reads here too (al_3): the chat is fixing it.
    .filter((e) => e.state === "needs-fix" || e.state === "with-chat")
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
    .map((e): MergeEntry => {
      const settled: MergeSettled | undefined = superseded(entries, e) ? "superseded" : facts?.get(e.id);
      const out = strip(e);
      delete out.settled;
      return settled ? { ...out, settled } : out;
    });
  const window = new Set(all.slice(0, RECENT).map((e) => e.id));
  let current = 0;
  return all.filter((e) => (e.settled ? window.has(e.id) : ++current <= RECENT));
}

/** The newest of a branch's entries: by creation (a note bumps updatedAt, which must not bring an old entry back). */
export const byCreatedNewest = (x: Pick<MergeEntry, "createdAt" | "updatedAt">, y: Pick<MergeEntry, "createdAt" | "updatedAt">): number =>
  Date.parse(y.createdAt) - Date.parse(x.createdAt) || y.updatedAt.localeCompare(x.updatedAt);

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
  const mine = all.filter((e) => e.branch === branch).sort(byCreatedNewest);
  const e = mine[0];
  if (!e) return undefined;
  return {
    id: e.id,
    project: view.project,
    target: e.target,
    state: e.state,
    ...(e.position ? { position: e.position } : {}),
    commit: e.commit,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.newerCommits ? { newerCommits: e.newerCommits } : {}),
    ...(e.newerRewritten ? { newerRewritten: e.newerRewritten } : {}),
    ...(e.newerBlocked ? { newerBlocked: e.newerBlocked } : {}),
    ...(e.eta ? { eta: e.eta } : {}),
    notes: e.notes,
    ...(e.landed ? { landed: e.landed } : {}),
    ...(e.conflict ? { conflict: e.conflict } : {}),
    ...(e.review ? { review: e.review } : {}),
    ...(e.unclear?.length ? { unclear: e.unclear } : {}),
    ...(e.run ? { run: e.run } : {}),
    ...(e.request ? { request: e.request } : {}),
    ...(e.settled ? { settled: e.settled } : {}),
    ...(e.state === "needs-fix" && e.redrafted ? { redrafted: true as const } : {}),
    ...(e.standing ? { standing: e.standing } : {}),
    ...(e.decision && !e.decision.answered ? { decision: e.decision } : {}),
    ...(e.tries ? { tries: e.tries } : {}),
    ...(view.review ? { reviewKit: true } : {}),
  };
}

/**
 * A project card's cut of a queue view (§app.projects/home-glance): the Ready list's count, what is in line, the run
 * checking now and the release's hold. Pure: from the view alone, so the glance reads the kept view and nothing else.
 * null for a view of a queue that doesn't serve its project.
 */
export function queueGlanceOf(view: MergeQueueView): import("../../shared/projects").ProjectGlanceQueue | null {
  if (!view.served) return null;
  const hold = view.release;
  const run = view.current;
  const entry = run ? view.checking.find((e) => e.id === run.entry) : undefined;
  const branch = entry?.branch ?? run?.branch;
  const landing =
    run && branch && !run.endedAt
      ? {
          branch,
          startedAt: run.startedAt,
          takesMs: entry?.eta && entry.eta.takesMs > 0 ? entry.eta.takesMs : null,
          steps: run.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, result: s.result, ...(s.startedAt ? { startedAt: s.startedAt } : {}) })),
          checks: run.checks.map((c) => ({ id: c.id, label: c.label })),
          ...(hold && entry?.release === hold.id ? { release: true as const } : {}),
        }
      : undefined;
  return {
    ready: view.ready?.length ?? 0,
    inLine: view.waiting.length + view.checking.length,
    waiting: view.waiting.length,
    target: view.target,
    ...(landing ? { landing } : {}),
    ...(hold ? { frozen: { tag: hold.tag ?? null, version: hold.version, waiting: view.waiting.filter((w) => w.release !== hold.id).length } } : {}),
    at: view.at,
  };
}
