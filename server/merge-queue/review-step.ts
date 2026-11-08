/**
 * The review step: a fresh read-only reviewer per run reads exactly the commit being checked, with the project's
 * review kit (a skill-shaped folder the definition names; never loaded into ordinary chats), while the checks run.
 * It answers through the verb merge.review {run, verdict, text}, which the queue hands to `deliverReview` (or, when
 * nothing waits here, to the run's `awaitReview`; either answer counts). Its error
 * or a timeout is retried once with a fresh reviewer, then reported as the reviewer's failure (the queue pauses; the
 * branch is never blamed).
 */
import type { ReviewFinding, ReviewVerdict } from "../../shared/merge-queue";
import type { ReviewChange } from "./review-change";
import { REVIEW_KINDS } from "./review-verdict";

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
  /** The change, written for it (review-change.ts): it has no shell to run git. */
  change?: ReviewChange;
  /** The reviewer's first message. */
  text: string;
  attempt: number;
}
export interface ReviewerHandle {
  sessionId: string;
  /** Its session file (the run's reviewer links). */
  path?: string;
  /** Archive the reviewer's chat once its turn is over (else stop it). The step never waits on it. */
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

/** Who keeps the run's reviewer chats (chats.ts on the server; none in tests): told as each starts and ends. */
export interface ReviewerRecorder {
  started(o: { root: string; run: string; branch: string; session: string; path: string; attempt: number }): void;
  ended(o: { root: string; session: string; verdict?: ReviewVerdict["verdict"]; why?: string }): void;
}
let recorder: ReviewerRecorder | null = null;
export function setReviewerRecorder(r: ReviewerRecorder | null): void {
  recorder = r;
}
const record = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    console.warn(`[merge-reviewer] not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
};
/** The server wires how a reviewer chat starts (merge-thread's createChat on the reviewer profile). */
export function setReviewerStarter(fn: StartReviewer | null): void {
  starter = fn;
}

/** A reviewer's answer as merge.review checked it: the text whole, its summary and parsed findings beside it. */
export type ReviewAnswer = { verdict: ReviewVerdict["verdict"]; text?: string; summary?: string; findings?: ReviewFinding[] };
/** The answer's report, whole: never cut, never re-parsed later. */
const reportOf = (v: ReviewAnswer) => ({ ...(v.text ? { text: String(v.text) } : {}), ...(v.summary !== undefined ? { summary: v.summary } : {}), ...(v.findings ? { findings: v.findings } : {}) });

interface Waiting {
  sessionId: string | null;
  resolve: (v: ReviewAnswer) => void;
}
const waiting = new Map<string, Waiting>();

/** The reviewer chat a run is waiting on, if any (merge.review's caller check: only it may answer for that run). */
export const reviewerOf = (runId: string): string | null => waiting.get(runId)?.sessionId ?? null;

/** `sessionId` is a reviewer chat some run waits on now. */
export const isReviewerChat = (sessionId: string): boolean => [...waiting.values()].some((w) => w.sessionId === sessionId);

/** Every reviewer chat a review is waiting on now (the startup sweep leaves these alone). */
export const activeReviewers = (): Set<string> => new Set([...waiting.values()].map((w) => w.sessionId).filter((id): id is string => !!id));

/** merge.review's verdict for `runId`. False when no review of that run is waiting (late, or a stranger's). */
export function deliverReview(runId: string, v: ReviewAnswer): boolean {
  const w = waiting.get(runId);
  if (!w || !["ok", "notes", "blocking"].includes(v.verdict)) return false;
  waiting.delete(runId);
  w.resolve({ verdict: v.verdict, ...reportOf(v) });
  return true;
}

/** The reviewer's first message: what to read, how, and how to answer. */
export function reviewerText(o: Omit<ReviewerStart, "text" | "attempt">, target = "the target"): string {
  return [
    `Review one change before it lands, with the review kit at ${o.kit}/ (read its PLAYBOOK.md first and follow it).`,
    "",
    `- Commit under review: ${o.commit} (branch ${o.branch} merged onto ${target} at ${o.base}).`,
    o.change
      ? `- The change, written for you: ${o.change.summary} (the commits and the changed paths) and ${o.change.diff} (the whole diff, git diff ${o.base}...${o.commit}). Your working folder is the merge copy at that commit: read the files around each hunk there.`
      : `- The change: git diff ${o.base}...${o.commit}. Your working folder is the merge copy at that commit: read the files there.`,
    "- You only read files (by path; the changed paths are listed for you): you have no shell. Change nothing, run nothing.",
    `- Answer once, with the merge.review verb: {run: "${o.runId}", verdict: "ok" | "notes" | "blocking", text}. text: a one-sentence summary, then one line per finding, "- [kind] file:line: text" (kinds: ${REVIEW_KINDS.join(", ")}; at most 10). Sova checks it and refuses a malformed one, saying what to fix: fix it and answer again.`,
    "  ok: nothing to say, no findings. notes: worth knowing, never stops the landing. blocking: it should not land as is (the user decides).",
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
    const answer = new Promise<ReviewAnswer | { failed: string }>((resolve) => {
      w.resolve = resolve;
      timer = setTimeout(() => resolve({ failed: `no verdict within ${Math.round(timeoutMs / 60_000)} min` }), timeoutMs);
      onAbort = () => resolve({ failed: "aborted" });
      o.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Waiting before the reviewer exists: a fast answer is never lost. The queue's own waiter (merge.review when this
    // map has none) answers too.
    waiting.set(o.runId, w);
    o.awaitReview?.().then(
      (v) => w.resolve({ verdict: v.verdict, ...reportOf(v) }),
      () => undefined,
    );
    try {
      o.log(`starting reviewer ${attempt} of ${attempts}\n`);
      handle = await start({ ...o, text, attempt });
      w.sessionId = handle.sessionId;
      o.log(`reviewer chat ${handle.sessionId}\n`);
      const h = handle;
      if (h.path) record(() => recorder?.started({ root: o.root, run: o.runId, branch: o.branch, session: h.sessionId, path: h.path!, attempt }));
      const a = await answer;
      record(() => recorder?.ended({ root: o.root, session: h.sessionId, ...("failed" in a ? { why: a.failed } : { verdict: a.verdict }) }));
      if ("failed" in a) {
        why = a.failed;
        o.log(`reviewer ${attempt}: ${a.failed}\n`);
        if (a.failed === "aborted") return { ok: false, why };
        continue;
      }
      o.log(`verdict: ${a.verdict}${a.text ? `\n${a.text}` : ""}\n`);
      return { ok: true, verdict: { verdict: a.verdict, ...reportOf(a), commit: o.commit, at: new Date().toISOString() } };
    } catch (err) {
      why = `the reviewer couldn't start: ${err instanceof Error ? err.message : String(err)}`;
      o.log(`${why}\n`);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) o.signal.removeEventListener("abort", onAbort);
      if (waiting.get(o.runId) === w) waiting.delete(o.runId);
      // Not awaited: the reviewer gave its verdict from inside its own turn, and archiving it waits for that turn
      // to end (at most 2 min, else it is stopped). The run goes on meanwhile.
      void handle?.stop().catch(() => undefined);
    }
  }
  return { ok: false, why: why || "the reviewer gave no verdict" };
}
