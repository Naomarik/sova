/**
 * The review step: a fresh read-only reviewer per run reads exactly the commit being checked, with the project's
 * review kit (a skill-shaped folder the definition names; never loaded into ordinary chats), while the checks run.
 * It answers through the verb merge.review {run, verdict, text}, which the queue hands to `deliverReview` (or, when
 * nothing waits here, to the run's `awaitReview`; either answer counts). Its error
 * or a timeout is retried once with a fresh reviewer, then reported as the reviewer's failure (the queue pauses; the
 * branch is never blamed).
 */
import type { ReviewVerdict } from "../../shared/merge-queue";

export interface ReviewerStart {
  runId: string;
  projectId: string;
  root: string;
  /** The merge copy, at `commit`: the reviewer's working folder. */
  copy: string;
  base: string;
  /** The commit under review (the merge, plus its docs commit). */
  commit: string;
  branch: string;
  /** The review kit's folder, relative to the copy. */
  kit: string;
  /** The reviewer's first message. */
  text: string;
  attempt: number;
}
export interface ReviewerHandle {
  sessionId: string;
  /** Archive (or stop) the reviewer's chat. */
  stop(): Promise<void>;
}
export type StartReviewer = (o: ReviewerStart) => Promise<ReviewerHandle>;

export interface ReviewDeps {
  startReviewer?: StartReviewer;
  /** How long one reviewer has (default 20 min). */
  reviewTimeoutMs?: number;
  /** Reviewers tried before the step fails (default 2: once, then a fresh one). */
  reviewAttempts?: number;
}

let starter: StartReviewer | null = null;
/** The server wires how a reviewer chat starts (merge-thread's createChat on the reviewer profile). */
export function setReviewerStarter(fn: StartReviewer | null): void {
  starter = fn;
}

interface Waiting {
  sessionId: string | null;
  resolve: (v: { verdict: ReviewVerdict["verdict"]; text?: string }) => void;
}
const waiting = new Map<string, Waiting>();

/** The reviewer chat a run is waiting on, if any (merge.review's caller check: only it may answer for that run). */
export const reviewerOf = (runId: string): string | null => waiting.get(runId)?.sessionId ?? null;

/** merge.review's verdict for `runId`. False when no review of that run is waiting (late, or a stranger's). */
export function deliverReview(runId: string, v: { verdict: ReviewVerdict["verdict"]; text?: string }): boolean {
  const w = waiting.get(runId);
  if (!w || !["ok", "notes", "blocking"].includes(v.verdict)) return false;
  waiting.delete(runId);
  w.resolve({ verdict: v.verdict, ...(v.text ? { text: String(v.text).slice(0, 2000) } : {}) });
  return true;
}

/** The reviewer's first message: what to read, how, and how to answer. */
export function reviewerText(o: Omit<ReviewerStart, "text" | "attempt">, target = "the target"): string {
  return [
    `Review one change before it lands, with the review kit at ${o.kit}/ (read its PLAYBOOK.md first and follow it).`,
    "",
    `- Commit under review: ${o.commit} (branch ${o.branch} merged onto ${target} at ${o.base}).`,
    `- The change: git diff ${o.base}...${o.commit} (and git log ${o.base}..${o.commit}). Read files at that commit (git show ${o.commit}:<path>); the working folder may move while you read.`,
    "- You only read: change nothing, commit nothing, start nothing.",
    `- Answer once, with the merge.review verb: {run: "${o.runId}", verdict: "ok" | "notes" | "blocking", text: "<short; for notes or blocking, what and where>"}.`,
    "  ok: nothing to say. notes: worth knowing, never stops the landing. blocking: it should not land as is (the user decides).",
  ].join("\n");
}

/**
 * Run the review of one commit: a reviewer started, its merge.review awaited (bounded), retried once with a fresh one.
 * Never throws.
 */
export async function reviewStep(
  o: Omit<ReviewerStart, "text" | "attempt"> & { log: (s: string) => void; signal: AbortSignal; target?: string; awaitReview?: () => Promise<ReviewVerdict> },
  deps: ReviewDeps = {},
): Promise<{ ok: true; verdict: ReviewVerdict } | { ok: false; why: string }> {
  const start = deps.startReviewer ?? starter;
  if (!start) return { ok: false, why: "nothing here can start a reviewer" };
  const attempts = deps.reviewAttempts ?? 2;
  const timeoutMs = deps.reviewTimeoutMs ?? 20 * 60_000;
  let why = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (o.signal.aborted) return { ok: false, why: "aborted" };
    const text = reviewerText(o, o.target);
    let handle: ReviewerHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const w: Waiting = { sessionId: null, resolve: () => {} };
    const answer = new Promise<{ verdict: ReviewVerdict["verdict"]; text?: string } | { failed: string }>((resolve) => {
      w.resolve = resolve;
      timer = setTimeout(() => resolve({ failed: `no verdict within ${Math.round(timeoutMs / 60_000)} min` }), timeoutMs);
      onAbort = () => resolve({ failed: "aborted" });
      o.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Waiting before the reviewer exists: a fast answer is never lost. The queue's own waiter (merge.review when this
    // map has none) answers too.
    waiting.set(o.runId, w);
    o.awaitReview?.().then(
      (v) => w.resolve({ verdict: v.verdict, ...(v.text ? { text: v.text } : {}) }),
      () => undefined,
    );
    try {
      o.log(`starting reviewer ${attempt} of ${attempts}\n`);
      handle = await start({ ...o, text, attempt });
      w.sessionId = handle.sessionId;
      o.log(`reviewer chat ${handle.sessionId}\n`);
      const a = await answer;
      if ("failed" in a) {
        why = a.failed;
        o.log(`reviewer ${attempt}: ${a.failed}\n`);
        if (a.failed === "aborted") return { ok: false, why };
        continue;
      }
      o.log(`verdict: ${a.verdict}${a.text ? `\n${a.text}` : ""}\n`);
      return { ok: true, verdict: { verdict: a.verdict, ...(a.text ? { text: a.text } : {}), commit: o.commit, at: new Date().toISOString() } };
    } catch (err) {
      why = `the reviewer couldn't start: ${err instanceof Error ? err.message : String(err)}`;
      o.log(`${why}\n`);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) o.signal.removeEventListener("abort", onAbort);
      if (waiting.get(o.runId) === w) waiting.delete(o.runId);
      await handle?.stop().catch(() => undefined);
    }
  }
  return { ok: false, why: why || "the reviewer gave no verdict" };
}
