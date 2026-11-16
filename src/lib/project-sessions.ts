// The project page's Sessions tab: every coding session in one full-width list, grouped by what needs you first
// (Needs you, Working, Ready to land, Idle, Old, Landed), each row saying its branches' landing state in words.
// Pure: no Solid, no DOM, so the rules run under the unit runner.

import type { AttentionDigest, SessionSummary } from "../../shared/protocol";
import type { CodingRow } from "./coding-worktrees";
import { ordinal, queueRow, type QueueRow, type QueueRowInput } from "./merge-queue";
import { chatRowsOf } from "./branch-status";
import { needsYouRows } from "./needs-you";

// ---- groups ---------------------------------------------------------------------------------------

export type SessionGroupKey = "needs-you" | "working" | "ready" | "idle" | "old" | "landed";

/** The list's order: what needs you first. */
export const GROUP_ORDER: readonly SessionGroupKey[] = ["needs-you", "working", "ready", "idle", "old", "landed"];

export const GROUP_NAME: Record<SessionGroupKey, string> = {
  "needs-you": "Needs you",
  working: "Working",
  ready: "Ready to land",
  idle: "Idle",
  old: "Old",
  landed: "Landed",
};

/** No activity for this many days makes an idle session Old (and marks its row quiet). */
export const OLD_DAYS = 7;
const DAY_MS = 86_400_000;

/** Where a branch stands on its way to the target. `done`: nothing is left to land, but it didn't land here: its
    worktree removed or missing, or its work already in its target. */
export type BranchStage = "ready" | "in-line" | "checking" | "stuck" | "landed" | "done" | "other";

/** A branch with nothing left live: landed, or done another way. */
export const FINISHED: readonly BranchStage[] = ["landed", "done"];
/** A session is finished once it has a branch and none is still live. */
export const isFinished = (stages: readonly BranchStage[]): boolean => stages.length > 0 && stages.every((s) => FINISHED.includes(s));

/** The stages that put a session in Ready to land: it is on its way in, or waits for your Land. */
const ON_ITS_WAY: readonly BranchStage[] = ["ready", "in-line", "checking", "stuck"];

/** What the grouping reads of one session. */
export interface SessionFacts {
  /** The sidebar's Needs you rule lists it (the attention digest), or, with no digest, it waits on your answer. */
  needsYou: boolean;
  /** The session (or one of its workers) is working now. */
  working: boolean;
  /** ms epoch of its last activity; 0 unknown. */
  lastActive: number;
  /** Its branches' stages, in its own order; empty when it has none. */
  stages: readonly BranchStage[];
}

/**
 * The one group a session lists in, first rule that holds: Needs you; Working; Ready to land (a branch is ready,
 * in line, checking or stuck in the queue); Landed (it has branches and none is still live: each landed, removed,
 * missing or already in its target); Old (no activity for OLD_DAYS or more); else Idle.
 */
export function sessionGroup(f: SessionFacts, now: number): SessionGroupKey {
  if (f.needsYou) return "needs-you";
  if (f.working) return "working";
  if (f.stages.some((s) => ON_ITS_WAY.includes(s))) return "ready";
  if (isFinished(f.stages)) return "landed";
  if (isQuiet(f.lastActive, now)) return "old";
  return "idle";
}

/** No activity for OLD_DAYS or more (an unknown time is never quiet). */
export const isQuiet = (lastActive: number, now: number): boolean => lastActive > 0 && now - lastActive >= OLD_DAYS * DAY_MS;

/** Within Ready to land: ready first, then checking, in line (by place), stuck. */
const STAGE_RANK: Record<BranchStage, number> = { ready: 0, checking: 1, "in-line": 2, stuck: 3, landed: 4, done: 5, other: 6 };

const LAST = Number.MAX_SAFE_INTEGER;

export interface Grouped<T> {
  key: SessionGroupKey;
  items: T[];
}

/**
 * The groups in GROUP_ORDER, empty ones left out. Within a group, newest activity first; Ready to land by its best
 * stage first (ready, checking, in line, stuck), then its place in line, then newest activity.
 */
export function groupSessions<T>(items: readonly T[], facts: (t: T) => SessionFacts & { position?: number }, now: number): Grouped<T>[] {
  const by = new Map<SessionGroupKey, { t: T; f: SessionFacts & { position?: number } }[]>();
  for (const t of items) {
    const f = facts(t);
    const k = sessionGroup(f, now);
    let list = by.get(k);
    if (!list) by.set(k, (list = []));
    list.push({ t, f });
  }
  const best = (f: SessionFacts) => Math.min(...f.stages.map((s) => STAGE_RANK[s]), STAGE_RANK.other);
  return GROUP_ORDER.filter((k) => by.has(k)).map((key) => {
    const list = by.get(key)!;
    list.sort((a, b) => {
      if (key === "ready") {
        const d = best(a.f) - best(b.f) || (a.f.position ?? LAST) - (b.f.position ?? LAST);
        if (d) return d;
      }
      return b.f.lastActive - a.f.lastActive;
    });
    return { key, items: list.map((x) => x.t) };
  });
}

/** The count under a group's name. */
export function groupCount(key: SessionGroupKey, stages: readonly (readonly BranchStage[])[]): string {
  const n = stages.length;
  const sessions = `${n} ${n === 1 ? "session" : "sessions"}`;
  switch (key) {
    case "needs-you":
      return `${n} waiting on you`;
    case "ready": {
      // Each session counts once, by its best stage.
      const best = stages.map((s) => [...s].sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b])[0]);
      const c = (s: BranchStage) => best.filter((b) => b === s).length;
      const parts = [
        [c("ready"), "ready"],
        [c("checking"), "checking"],
        [c("in-line"), "in line"],
        [c("stuck"), "stuck"],
      ] as const;
      return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(" · ") || sessions;
    }
    case "old":
      return `${n} idle for ${OLD_DAYS} days or more`;
    default:
      return sessions;
  }
}

// ---- a branch's landing state in words --------------------------------------------------------------

export type BranchTone = "success" | "info" | "error" | "muted";

/** One branch as a row says it: its stage, the words for it and why when stuck. Never a bare "Not ready". */
export interface BranchState {
  branch: string;
  stage: BranchStage;
  /** "Ready to land", "In line · 2nd", "Checking", "Stuck in the queue", "Landed" (the row adds the time), or the
      branch's own state ("2 files not committed", "No commits yet", "Conflicts with master"). */
  word: string;
  tone: BranchTone;
  /** Stuck: what holds it ("Needs a fix: the last check failed"). */
  why?: string;
  /** Landed: when, ISO, when known. */
  landedAt?: string;
  /** Ready with the queue's Land: what Land queues (its folder and the commit the read saw). */
  land?: { worktree: string; commit?: string; target?: string };
  /** Its queue place, for the order inside Ready to land. */
  position?: number;
}

const STUCK_KEYS = new Set<QueueRow["key"]>(["with-chat", "needs-fix", "needs-you", "behaviour-differs", "unattributed", "review-flagged", "drafts-changed", "conflict"]);
const LANDED_KEYS = new Set<QueueRow["key"]>(["landed", "cleaned-up", "merged"]);
const DONE_KEYS = new Set<QueueRow["key"]>(["removed", "dropped"]);

const firstLine = (s: string | undefined): string | undefined => s?.split("\n")[0]?.trim() || undefined;

/** A queue row (merge-queue.ts queueRow, the one rule every branch row reads) in the Sessions tab's words. */
export function branchStateOf(branch: string, row: QueueRow, extra: { position?: number; landedAt?: string; worktree?: string; commit?: string; target?: string } = {}): BranchState {
  const k = row.key;
  if (k === "ready") {
    const land = row.action === "land" && extra.worktree ? { land: { worktree: extra.worktree, ...(extra.commit ? { commit: extra.commit } : {}), ...(extra.target ? { target: extra.target } : {}) } } : {};
    return { branch, stage: "ready", word: "Ready to land", tone: "success", ...land };
  }
  if (k === "queued") return { branch, stage: "in-line", word: extra.position ? `In line · ${ordinal(extra.position)}` : "In line", tone: "muted", ...(extra.position ? { position: extra.position } : {}) };
  if (k === "checking" || k === "request-review") return { branch, stage: "checking", word: k === "checking" ? "Checking" : row.label, tone: "info" };
  if (k === "requested" || k === "pushed") return { branch, stage: "in-line", word: row.label, tone: "muted" };
  if (STUCK_KEYS.has(k)) {
    const reason = firstLine(row.reason);
    return { branch, stage: "stuck", word: "Stuck in the queue", tone: "error", why: reason && reason !== row.label ? `${row.label}: ${reason}` : row.label };
  }
  if (LANDED_KEYS.has(k)) return { branch, stage: "landed", word: "Landed", tone: "success", ...(extra.landedAt ? { landedAt: extra.landedAt } : {}) };
  if (DONE_KEYS.has(k)) return { branch, stage: "done", word: row.label, tone: "muted" };
  // Not on its way: the branch's own state, in its own words, never a bare "Not ready".
  return { branch, stage: "other", word: k === "uncommitted" && row.detail ? row.detail : row.label, tone: "muted" };
}

/** What the recorded facts (the project's branch read) say of a session's one branch, when the session list has no
    reading of it: a session on another host, before its first read, or one whose worktree the server cut (New Coding
    Session), which the session list's readiness never covers. */
export interface RecordedBranch {
  branch: string;
  state?: "open" | "merged" | "removed" | "missing" | "root";
  merged?: boolean;
  mergedAt?: string;
  /** The branch it merges into. */
  target?: string | null;
  dirty?: boolean;
  ahead?: number;
}

export function recordedBranchState(r: RecordedBranch, queued: BranchState | null): BranchState {
  if (queued && queued.stage !== "other") return queued;
  // Landed only when a merge was recorded (Merge Branch, or the queue above): git finding the tip in the target is also
  // true of a branch with no commit of its own that took the target's newest commits.
  if (r.mergedAt) return { branch: r.branch, stage: "landed", word: "Landed", tone: "success", landedAt: r.mergedAt };
  if (r.merged || r.state === "merged") return { branch: r.branch, stage: "done", word: r.target ? `Already in ${r.target}` : "Already in its target", tone: "muted" };
  if (r.state === "removed") return { branch: r.branch, stage: "done", word: "Removed", tone: "muted" };
  if (r.state === "missing") return { branch: r.branch, stage: "done", word: "Worktree folder missing", tone: "muted" };
  if (r.dirty) return { branch: r.branch, stage: "other", word: "Uncommitted changes", tone: "muted" };
  if (r.ahead === 0) return { branch: r.branch, stage: "other", word: "No commits yet", tone: "muted" };
  if (r.state === undefined || r.ahead === undefined) return { branch: r.branch, stage: "other", word: "Reading its branch", tone: "muted" };
  return { branch: r.branch, stage: "other", word: `${r.ahead} ${r.ahead === 1 ? "commit" : "commits"} ahead`, tone: "muted" };
}

// ---- one session's row --------------------------------------------------------------------------------

/** The queue facts a page holds for a branch beyond the session list's cut (its place and landing time). */
export interface QueueExtra {
  position?: number;
  landedAt?: string;
}

/**
 * A session's branches: the session list's own (each the chat's row, read by the one rule), which is the chat's
 * `worktrees` entry as its Worktrees window reads it. The recorded branch (the project's own record of the worktree
 * it cut or adopted, with the queue's word for it) only stands in where the chat tracks no worktree for that branch:
 * a session on another host, before its first read, or one started before Sova wrote the entry for the worktree it
 * cut. It then lists first, as the session's own branch. `queueOf` gives what the page's queue read adds (place,
 * landing time).
 */
export function sessionBranches(
  row: Pick<CodingRow, "branch"> & Partial<Pick<CodingRow, "state" | "merged" | "mergedAt" | "target" | "dirty" | "ahead" | "head" | "worktree">>,
  s: Pick<SessionSummary, "branches" | "readiness"> | undefined,
  queueOf: (branch: string) => (QueueExtra & { row?: QueueRow }) | undefined,
): BranchState[] {
  const inputs: QueueRowInput[] = s ? chatRowsOf(s) : [];
  const tracked = inputs.map((w, i) => {
    const q = queueOf(w.branch);
    const path = s?.branches?.[i]?.path;
    return branchStateOf(w.branch, queueRow(w), {
      position: w.queue?.position ?? q?.position,
      landedAt: q?.landedAt ?? (w.readiness?.merged && s?.readiness?.badge === "merged" ? new Date(s.readiness.since).toISOString() : undefined),
      worktree: w.exists ? path : undefined,
      commit: w.readiness?.landing?.commit,
      target: w.mergeProject?.target,
    });
  });
  // The chat's own reading of the branch is there: the recorded one says nothing more.
  if (!row.branch || inputs.some((w) => w.branch === row.branch)) return tracked;
  const q = queueOf(row.branch);
  const queued = q?.row ? branchStateOf(row.branch, q.row, { position: q.position, landedAt: q.landedAt ?? row.mergedAt, worktree: row.worktree ?? undefined, commit: row.head }) : null;
  return [recordedBranchState({ branch: row.branch, state: row.state, merged: row.merged, mergedAt: row.mergedAt, target: row.target, dirty: row.dirty, ahead: row.ahead }, queued), ...tracked];
}

/** The ids of the sessions the sidebar's Needs you lists (§app.session-list/needs-you), among `sessions`. */
export function needsYouIds(digest: Pick<AttentionDigest, "items" | "newestListed"> | undefined, sessions: readonly SessionSummary[]): Set<string> {
  return new Set(needsYouRows(digest, sessions).map((r) => r.session.id));
}

/** With no digest read: the session waits on your answer (open alignment questions, a dialog, a failed turn). */
export const waitsOnYou = (s: Pick<SessionSummary, "align" | "pendingDialogs" | "turnError" | "busy">): boolean =>
  !s.busy && (!!s.align?.openQuestions || !!s.pendingDialogs || !!s.turnError);

/** Shown branches: up to 3, or all once opened ("+N more" / "Show fewer"). */
export const BRANCHES_SHOWN = 3;
export function shownBranches<T>(all: readonly T[], open: boolean): { shown: readonly T[]; more: number } {
  return open || all.length <= BRANCHES_SHOWN ? { shown: all, more: 0 } : { shown: all.slice(0, BRANCHES_SHOWN), more: all.length - BRANCHES_SHOWN };
}

/** One line of a row's branch column: a branch with its landing words, or its name alone. */
export interface BranchLine {
  b: BranchState;
  /** Its landing words show on the line. */
  said: boolean;
}

/**
 * A row's branch column, each branch once: one branch reads its words, then its name. Several: those on their way in
 * (or landed) read "{words} · {branch}" first, then the rest by name alone (with none on its way, the first says its
 * own state, so the row always has words). Closed, BRANCHES_SHOWN lines, then "+N more".
 */
export function branchLines(all: readonly BranchState[], open: boolean): { lines: BranchLine[]; more: number } {
  let lines: BranchLine[];
  if (all.length <= 1) lines = all.map((b) => ({ b, said: true }));
  else {
    const notable = all.filter((b) => b.stage !== "other");
    const rest = all.filter((b) => b.stage === "other");
    lines = notable.length ? [...notable.map((b) => ({ b, said: true })), ...rest.map((b) => ({ b, said: false }))] : rest.map((b, i) => ({ b, said: i === 0 }));
  }
  const { shown, more } = shownBranches(lines, open);
  return { lines: [...shown], more };
}

/** The row's Land: only when exactly one branch reads Ready to land with the queue's Land, so it is plain which. */
export function rowLand(all: readonly BranchState[]): BranchState | undefined {
  const ready = all.filter((b) => b.stage === "ready");
  return ready.length === 1 && ready[0]!.land ? ready[0] : undefined;
}

/** The age cell's second line: "started today", or "3d old · Nov 13". */
export function ageWords(createdAt: string, now: number, date: (ms: number) => string): string {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / DAY_MS);
  return days < 1 ? "started today" : `${days}d old · ${date(t)}`;
}

/** The folded Landed group's line, over every finished session (landed, removed or already in its target):
    "Latest: {title} · landed 6d ago, and 185 more"; the time only when the latest one landed. */
export function landedFoldWords(latest: { title: string; when: string } | undefined, n: number): string {
  if (!latest) return `${n} ${n === 1 ? "session" : "sessions"}`;
  const rest = n - 1;
  return `Latest: ${latest.title}${latest.when ? ` · landed ${latest.when}` : ""}${rest > 0 ? `, and ${rest} more` : ""}`;
}
