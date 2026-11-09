// What retirement last did, as the screens read it (§chat.worktrees/retirement): the ledger and the saved
// list, with no git. `retire-pending.json` is a report and a debounce, never authority: the service reads git
// and the chats afresh at every wake-up, and losing this file loses nothing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HeldRow, RetiredRow, RetirementView } from "../shared/protocol";
import { readLedger, type RemovedWorktree } from "./removed-worktrees";
import { stateRoot } from "./state-root";
import { type Gate, retirementAllowed } from "./worktree-retire-gate";

/** One tree that only waits: a reason that clears by itself. */
export interface WaitingRow {
  path: string;
  branch?: string;
  why: string;
}

export interface RepoReport {
  /** The main checkout. */
  main: string;
  commonDir: string;
  held: HeldRow[];
  waiting: WaitingRow[];
  /** When this repository was last read. */
  at: number;
  /** Cleanup couldn't start: its lock looks taken by this (the Held tab's one line). */
  lockTaken?: string;
}

/** One project's first pass, every worktree and leftover folder in exactly one group (`retire-first-pass.json`). */
export interface FirstPassGroups {
  retired: { path: string; branch: string; tip: string; merged: RemovedWorktree["merged"]; branchDeleted: boolean; rebuildable?: string[]; testCopy?: unknown; retired?: true }[];
  held: { path: string; branch?: string; reason: string }[];
  waiting: { path: string; branch?: string; reason: string }[];
  hasWork: { path: string; branch?: string }[];
  queueOwn: { path: string; branch?: string; tip?: string; retired?: true }[];
}

/** A removal the first pass was about to make, and what would go with it. A report: it counts only once the ledger says the removal happened. */
export interface FirstPassGoing {
  /** The main checkout. */
  main: string;
  tip: string;
  at: number;
  rebuildable?: string[];
  testCopy?: unknown;
}

export interface FirstPassRecord {
  at: number;
  /** Every branch's last commit, recorded before anything went. */
  list: { main: string; path: string; branch: string; tip: string; pinned: boolean }[];
  /** Each project's groups, by its main checkout, kept from the pass that first read it. */
  repos?: Record<string, FirstPassGroups>;
  /** By folder, written before each removal starts: a stop in mid-pass can't lose a row or what went. Gone once the pass is done. */
  going?: Record<string, FirstPassGoing>;
  /** Every project was read: later passes aren't the first pass. */
  done?: boolean;
  /** What the first pass did, kept until its one summary is posted. */
  summary?: { off?: string; skipped?: string; repos: { repo: string; retired: { path: string; branch: string; tip: string; merged: RemovedWorktree["merged"]; branchDeleted: boolean; finished?: true; queueMade?: true }[]; held: HeldRow[]; waiting: WaitingRow[]; leftovers: string[]; hasWork: { path: string; branch?: string }[]; queueOwn: { path: string; branch?: string }[]; lockTaken?: string }[] };
  /** The summary was posted: only one ever is. */
  posted?: boolean;
}

export interface PendingFile {
  v: 1;
  lastPassAt?: number;
  firstPass?: FirstPassRecord;
  /** By the repository's common dir. */
  repos: Record<string, RepoReport>;
}

export const pendingFile = (): string => join(stateRoot(), "retire-pending.json");

/** The saved list; anything missing or unreadable is an empty one. */
export function readPending(file = pendingFile()): PendingFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as PendingFile;
    if (raw?.v === 1 && raw.repos && typeof raw.repos === "object") return raw;
  } catch {
    // losing it loses nothing
  }
  return { v: 1, repos: {} };
}

export function writePending(p: PendingFile, file = pendingFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 1)}\n`);
  renameSync(tmp, file);
}

const NEWEST_SHOWN = 20;
const DAY_MS = 86_400_000;

const rowOf = (e: RemovedWorktree): RetiredRow => ({ path: e.path, branch: e.branch, tip: e.tip, merged: e.merged, at: e.at, branchDeleted: e.branchDeleted, ...(e.branchKept ? { branchKept: true as const } : {}), restorable: !!e.pinned && !!e.tip });

const reportOf = (pending: PendingFile, main: string): RepoReport | undefined => Object.values(pending.repos).find((r) => r.main === main);

/**
 * GET /api/worktrees/retirement and the queue view's `retirement`, for one main checkout: what retired
 * (newest first; the newest 20 unless `all`), what's held with its reason, how many only wait. No git.
 */
export function retirementViewOf(main: string, opts: { all?: boolean; pending?: PendingFile; ledger?: readonly RemovedWorktree[]; gate?: Gate } = {}): RetirementView {
  const pending = opts.pending ?? readPending();
  const report = reportOf(pending, main);
  const gate = opts.gate ?? retirementAllowed();
  const ledger = opts.ledger ?? readLedger();
  const commonDir = report?.commonDir ?? join(main, ".git");
  // Newest first by when it retired, whatever the file's order. One that's back, by Restore or a message, isn't retired any more.
  const mine = ledger.filter((e) => e.retired && !e.partial && !e.queueMade && !e.restoredAt && !e.backAt && e.commonDir === commonDir).sort((x, y) => y.at - x.at);
  const waiting = report?.waiting ?? [];
  return {
    retired: (opts.all ? mine : mine.slice(0, NEWEST_SHOWN)).map(rowOf),
    retiredTotal: mine.length,
    held: report?.held ?? [],
    waiting: waiting.length,
    ...(waiting.length ? { waitingWhy: [...new Set(waiting.map((w) => w.why))].slice(0, 3).join(" ") } : {}),
    ...(report?.lockTaken ? { lockTaken: report.lockTaken } : {}),
    // Read live: a server that's off writes nothing, and the screens say so rather than show nothing.
    ...(gate.on ? {} : { off: gate.why, offFor: gate.offFor }),
  };
}

/** The new session's line: how many are held, and how many retired in the last 7 days, for one repository. Zeroes are left out. No git. */
export function retirementCounts(commonDir: string, now: number, opts: { pending?: PendingFile; ledger?: readonly RemovedWorktree[] } = {}): { held?: number; retired?: number } {
  const pending = opts.pending ?? readPending();
  const held = pending.repos[commonDir]?.held.length ?? 0;
  const retired = (opts.ledger ?? readLedger()).filter((e) => e.retired && !e.partial && !e.queueMade && !e.restoredAt && !e.backAt && e.commonDir === commonDir && now - e.at < 7 * DAY_MS).length;
  return { ...(held ? { held } : {}), ...(retired ? { retired } : {}) };
}

/** The project card's line: the worktrees held and those retired in the last 7 days of one main checkout, as a new session's line counts them. No git. */
export function retirementGlance(main: string, opts: { pending?: PendingFile; ledger?: readonly RemovedWorktree[]; now?: number } = {}): { retired: number; held: number } {
  const pending = opts.pending ?? readPending();
  const commonDir = reportOf(pending, main)?.commonDir ?? join(main, ".git");
  const counts = retirementCounts(commonDir, opts.now ?? Date.now(), { pending, ...(opts.ledger ? { ledger: opts.ledger } : {}) });
  return { retired: counts.retired ?? 0, held: reportOf(pending, main)?.held.length ?? 0 };
}
