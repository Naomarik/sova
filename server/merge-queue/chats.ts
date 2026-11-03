/**
 * The merge queue's own chats, as the Merge Queue tab lists them (§app.merge-queue/view): every reviewer chat a
 * run started (its run, branch, attempt, verdict, when), recorded as the review step starts and ends it, and every
 * merge thread (the current one and each it replaced, thread.ts's record). Kept for good, until the user clears
 * one (Clear) or all ended ones (Clear All): clearing deletes the chat's file for good and marks the row
 * `cleared`, so a run keeps its verdict and findings with "Reviewer chat cleared". The current thread and a
 * running reviewer are never cleared.
 *
 * One JSON file per state root, keyed by project root. Harness-neutral: deleting goes through injected deps.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MergeQueueChat, ReviewVerdict } from "../../shared/merge-queue";
import type { ThreadHistoryItem, ThreadRecord } from "./thread";

/** One reviewer chat as recorded. */
export interface ReviewerRecord {
  session: string;
  path: string;
  run: string;
  entry?: string;
  branch: string;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  /** Its verdict, or why it gave none ("timeout", "failed", "aborted"). */
  verdict?: ReviewVerdict["verdict"] | "failed";
  why?: string;
  cleared?: string;
}

/** A cleared thread (its file deleted), by session id. */
type Stored = { reviewers: ReviewerRecord[]; clearedThreads?: Record<string, string> };

export class QueueChats {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): Record<string, Stored> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; projects?: Record<string, Stored> };
      return raw?.version === 1 && raw.projects && typeof raw.projects === "object" ? raw.projects : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, Stored>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, projects: all }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  private update(root: string, fn: (s: Stored) => void): void {
    const all = this.read();
    const s = all[root] ?? { reviewers: [] };
    fn(s);
    all[root] = s;
    this.write(all);
  }

  /** A reviewer chat started for a run. */
  reviewerStarted(root: string, r: Omit<ReviewerRecord, "startedAt" | "endedAt" | "verdict" | "why" | "cleared">): void {
    this.update(root, (s) => {
      if (!s.reviewers.some((x) => x.session === r.session)) s.reviewers.push({ ...r, startedAt: new Date(this.now()).toISOString() });
    });
  }

  /** A reviewer chat is done: its verdict, or why it gave none. */
  reviewerEnded(root: string, session: string, end: { verdict?: ReviewVerdict["verdict"]; why?: string }): void {
    this.update(root, (s) => {
      const r = s.reviewers.find((x) => x.session === session);
      if (!r || r.endedAt) return;
      r.endedAt = new Date(this.now()).toISOString();
      if (end.verdict) r.verdict = end.verdict;
      else {
        r.verdict = "failed";
        if (end.why) r.why = end.why.slice(0, 200);
      }
    });
  }

  reviewers(root: string): ReviewerRecord[] {
    return this.read()[root]?.reviewers ?? [];
  }

  /** The reviewer running now for `run` (the newest attempt with no end), or undefined. */
  running(root: string, run?: string): ReviewerRecord | undefined {
    return [...this.reviewers(root)].reverse().find((r) => !r.endedAt && (!run || r.run === run));
  }

  /**
   * The History's rows, newest first: the current thread, each earlier thread and every reviewer chat. `thread`:
   * thread.ts's record of `root` (absent: none now); `history`: its earlier threads.
   */
  list(root: string, thread: ThreadRecord | undefined, history: readonly ThreadHistoryItem[]): MergeQueueChat[] {
    const s = this.read()[root];
    const clearedThreads = s?.clearedThreads ?? {};
    const rows: MergeQueueChat[] = [];
    if (thread) rows.push({ kind: "thread", session: thread.sessionId, path: thread.path, startedAt: new Date(thread.startedAt).toISOString(), current: true, ...(thread.memory ? { memory: thread.memory.type } : {}) });
    for (const h of history)
      rows.push({
        kind: "thread",
        session: h.sessionId,
        path: h.path,
        startedAt: new Date(h.startedAt).toISOString(),
        endedAt: new Date(h.endedAt).toISOString(),
        why: h.why,
        ...(h.memory ? { memory: h.memory.type } : {}),
        ...(clearedThreads[h.sessionId] ? { cleared: clearedThreads[h.sessionId] } : {}),
      });
    for (const r of s?.reviewers ?? [])
      rows.push({
        kind: "reviewer",
        session: r.session,
        path: r.path,
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : { running: true }),
        run: r.run,
        branch: r.branch,
        attempt: r.attempt,
        ...(r.verdict ? { verdict: r.verdict } : {}),
        ...(r.why ? { why: r.why } : {}),
        ...(r.cleared ? { cleared: r.cleared } : {}),
      });
    return rows.sort((a, b) => Number(!!b.current) - Number(!!a.current) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /** What `which` (a session id, or "all") clears now: never the current thread, a running reviewer or a cleared row. */
  clearable(root: string, thread: ThreadRecord | undefined, history: readonly ThreadHistoryItem[], which: string): MergeQueueChat[] {
    return this.list(root, thread, history).filter((c) => !c.current && !c.running && !c.cleared && (which === "all" || c.session === which));
  }

  /** Mark rows cleared (their files are deleted by the caller). */
  markCleared(root: string, sessions: readonly string[]): void {
    const at = new Date(this.now()).toISOString();
    this.update(root, (s) => {
      for (const r of s.reviewers) if (sessions.includes(r.session) && !r.cleared) r.cleared = at;
      s.clearedThreads ??= {};
      for (const id of sessions) if (!s.reviewers.some((r) => r.session === id)) s.clearedThreads[id] ??= at;
    });
  }
}

export interface ClearDeps {
  /** Archive the chat (a replaced thread was never archived); ok when it already is. */
  archive(path: string): Promise<{ ok: boolean; error?: string }>;
  /** Delete the files for good (cleanupSessions paths mode, queue chats allowed); the paths really deleted. */
  remove(paths: string[]): Promise<string[]>;
}

/** Clear `which` (a session id, or "all"): archive, delete, mark. Resolves how many were deleted. */
export async function clearQueueChats(chats: QueueChats, root: string, thread: ThreadRecord | undefined, history: readonly ThreadHistoryItem[], which: string, deps: ClearDeps): Promise<number> {
  const rows = chats.clearable(root, thread, history, which);
  if (!rows.length) return 0;
  for (const r of rows) if (r.path) await deps.archive(r.path).catch(() => ({ ok: false }));
  const gone = new Set(await deps.remove(rows.map((r) => r.path).filter((p): p is string => !!p)));
  const cleared = rows.filter((r) => r.path && gone.has(r.path)).map((r) => r.session);
  chats.markCleared(root, cleared);
  return cleared.length;
}
