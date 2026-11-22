/**
 * The review step: a fresh reviewer per run reads exactly the commit being checked, with the project's review kit (a
 * skill-shaped folder the definition names; never loaded into ordinary chats), while the checks run. Read-only by
 * default; the kit may declare its model, passes, time limit and a shell, and the project may let it fix what it finds
 * (review-kit.ts): each pass is a fresh reviewer, the passes' verdicts joined (the strictest, findings together).
 * It answers through the verb merge.review {run, verdict, text}, which the queue hands to `deliverReview` (or, when
 * nothing waits here, to the run's `awaitReview`; either answer counts). Its error
 * or a timeout is retried once with a fresh reviewer, then reported as the reviewer's failure (the queue pauses; the
 * branch is never blamed).
 */
import type { ReviewFinding, ReviewKitDecl, ReviewVerdict } from "../../shared/merge-queue";
import type { ReviewChange } from "./review-change";
import { findingLine, reviewPrint } from "./review-record";
import { REVIEWER_PROFILE, TIME_LIMIT_DEFAULT_MIN } from "./review-kit";
import { MAX_FINDINGS, REVIEW_KINDS, SUMMARY_MAX } from "./review-verdict";

export interface ReviewerStart {
  runId: string;
  projectId: string;
  root: string;
  /** The reviewer's working folder: the merge copy at `commit`, or (`own`) a folder of its own. */
  copy: string;
  /** Its folder is its own (it has a shell, or may fix): at `commit`, or at the branch's commit when it may fix. */
  own?: { at: string; fixes: boolean };
  /** The profile it starts on (review-kit.ts reviewerProfileOf; default the read-only one). */
  profile?: string;
  /** The kit's declared model, used when this computer has none picked for the project's review. */
  kitModel?: { model?: string; thinking?: string };
  /** The kit's shell, when it asked for one (and the fixer always has one). */
  shell?: boolean;
  /** This pass and how many (the kit's `passes`; default 1 of 1). */
  pass?: { n: number; of: number };
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
  /** Its first message as a read-only reviewer: what starts instead when a shell can't be confined. */
  readOnlyText?: string;
  attempt: number;
}
export interface ReviewerHandle {
  sessionId: string;
  /** The model it started on ("provider/model"; absent: unknown) and its thinking. */
  model?: string;
  thinking?: string;
  /** It started read-only instead of with the shell or fixes asked for: why (its sandbox couldn't be turned on). */
  limited?: string;
  /** Its session file (the run's reviewer links). */
  path?: string;
  /** Archive the reviewer's chat once its turn is over (else stop it). The step never waits on it. */
  stop(): Promise<void>;
}
export type StartReviewer = (o: ReviewerStart) => Promise<ReviewerHandle>;

export interface ReviewDeps {
  startReviewer?: StartReviewer;
  /** How long one reviewer has (default: the kit's time limit, else 20 min). */
  reviewTimeoutMs?: number;
  /** Reviewers tried before the step fails (default 2: once, then a fresh one). */
  reviewAttempts?: number;
  /** The whole step's limit, every pass and attempt together (default 2 h). */
  reviewTotalMs?: number;
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
  const own = o.own;
  const where = own
    ? own.at !== o.commit
      ? `Your working folder is a copy of the branch ${o.branch} at its commit ${own.at}, not merged (the diff is of the merge; an earlier reviewer's fix commits may be on top): read the files around each hunk there.`
      : `Your working folder is a copy of your own at that commit (not the merge copy the checks run in): read the files around each hunk there.`
    : "Your working folder is the merge copy at that commit: read the files around each hunk there.";
  const tools = own?.fixes
    ? [
        "- You have a shell and edit tools. A blocking finding you can fix safely you may fix yourself, in your folder only: edit, then commit it there with git (one or more new commits on top; never amend, rebase or reset). Fix only what you would block on. Then answer blocking with every finding, as found: Sova puts your commits on the branch, the merge thread checks them and the checks run again before anything lands. Uncommitted edits are dropped.",
      ]
    : o.shell
      ? ["- You have a shell, in your own folder: run what the kit asks you to. Change no file: nothing you write is kept, and you fix nothing (findings only)."]
      : ["- You only read files (by path; the changed paths are listed for you): you have no shell. Change nothing, run nothing."];
  const pass = o.pass && o.pass.of > 1 ? [`- You are reviewer ${o.pass.n} of ${o.pass.of}, each on your own: the verdicts are joined (the strictest wins, findings together).`] : [];
  return [
    `Review one change before it lands, with the review kit at ${o.kit}/ (read its PLAYBOOK.md first and follow it${own || o.shell ? "; where it says you only read, this message wins" : ""}).`,
    "",
    `- Commit under review: ${o.commit} (branch ${o.branch} merged onto ${target} at ${o.base}).`,
    o.change
      ? `- The change, written for you: ${o.change.summary} (the commits and the changed paths) and ${o.change.diff} (the whole diff, git diff ${o.base}...${o.commit}). ${where}`
      : `- The change: git diff ${o.base}...${o.commit}. ${where}`,
    ...tools,
    ...pass,
    `- Answer once, with the merge.review verb: {run: "${o.runId}", verdict: "ok" | "notes" | "blocking", text}. text: a one-sentence summary, then one line per finding, "- [kind] file:line: text" (kinds: ${REVIEW_KINDS.join(", ")}; at most 10). Sova checks it and refuses a malformed one, saying what to fix: fix it and answer again.`,
    "  ok: nothing to say, no findings. notes: worth knowing, never stops the landing. blocking: it should not land as is (the user decides).",
  ].join("\n");
}

/**
 * Run the review of one commit: a reviewer started, its merge.review awaited (bounded), retried once with a fresh one.
 * Never throws.
 */
export async function reviewStep(
  o: Omit<ReviewerStart, "text" | "attempt"> & { log: (s: string) => void; signal: AbortSignal; target?: string; awaitReview?: () => Promise<ReviewVerdict>; decl?: ReviewKitDecl },
  deps: ReviewDeps = {},
): Promise<{ ok: true; verdict: ReviewVerdict; model?: string; thinking?: string; limited?: string } | { ok: false; why: string }> {
  const start = deps.startReviewer ?? starter;
  if (!start) return { ok: false, why: "nothing here can start a reviewer" };
  const passes = Math.max(1, o.decl?.passes ?? 1);
  const answers: ReviewAnswer[] = [];
  let ran: Pick<ReviewerHandle, "model" | "thinking" | "limited"> = {};
  const deadline = Date.now() + (deps.reviewTotalMs ?? REVIEW_TOTAL_MAX_MIN * 60_000);
  for (let n = 1; n <= passes; n++) {
    const r = await onePass({ ...o, ...(passes > 1 ? { pass: { n, of: passes } } : {}) }, start, deps, passes > 1 ? `pass ${n} of ${passes}: ` : "", deadline);
    if (!r.ok) return passes > 1 ? { ok: false, why: `pass ${n} of ${passes}: ${r.why}` } : r;
    answers.push(r.answer);
    if (n === 1) ran = r.ran;
    else if (r.ran.limited && !ran.limited) ran = { ...ran, limited: r.ran.limited };
  }
  const joined = joinAnswers(answers);
  if (passes > 1) o.log(`joined verdict: ${joined.verdict}\n`);
  return { ok: true, verdict: { verdict: joined.verdict, ...reportOf(joined), commit: o.commit, at: new Date().toISOString() }, ...(ran.model ? { model: ran.model } : {}), ...(ran.thinking ? { thinking: ran.thinking } : {}), ...(ran.limited ? { limited: ran.limited } : {}) };
}

/** The whole review step's limit, every pass and attempt together (minutes): the kit's passes and time limit stop here. */
export const REVIEW_TOTAL_MAX_MIN = 120;

/** Each pass's verdict joined: the strictest, findings together (the same finding once, at most 10), summaries in turn. Pure. */
export function joinAnswers(answers: readonly ReviewAnswer[]): ReviewAnswer {
  if (answers.length === 1) return answers[0]!;
  const rank = { ok: 0, notes: 1, blocking: 2 } as const;
  const verdict = answers.reduce<ReviewAnswer["verdict"]>((v, a) => (rank[a.verdict] > rank[v] ? a.verdict : v), "ok");
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const a of answers)
    for (const f of a.findings ?? []) {
      const key = reviewPrint([f]);
      if (seen.has(key) || findings.length >= MAX_FINDINGS) continue;
      seen.add(key);
      findings.push(f);
    }
  if (verdict === "ok") return { verdict };
  const summaries = answers.map((a) => a.summary?.trim()).filter((x): x is string => !!x);
  let summary = summaries.join(" ");
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`;
  return { verdict, summary, findings, text: [summary, ...findings.map(findingLine)].filter(Boolean).join("\n") };
}

/** One pass: a reviewer started, its merge.review awaited (bounded), retried once with a fresh one. Never throws. */
async function onePass(
  o: Parameters<typeof reviewStep>[0],
  start: StartReviewer,
  deps: ReviewDeps,
  label: string,
  deadline: number,
): Promise<{ ok: true; answer: ReviewAnswer; ran: Pick<ReviewerHandle, "model" | "thinking" | "limited"> } | { ok: false; why: string }> {
  const attempts = deps.reviewAttempts ?? 2;
  const ownMs = deps.reviewTimeoutMs ?? (o.decl?.timeLimitMin ?? TIME_LIMIT_DEFAULT_MIN) * 60_000;
  let why = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, why: why ? `${why}; then the review passed its limit of ${REVIEW_TOTAL_MAX_MIN} min in all` : `the review passed its limit of ${REVIEW_TOTAL_MAX_MIN} min in all` };
    const timeoutMs = Math.min(ownMs, left);
    if (o.signal.aborted) return { ok: false, why: "aborted" };
    const text = reviewerText(o, o.target);
    const readOnlyText = o.own || o.shell ? reviewerText({ ...o, ...(o.own ? { own: { ...o.own, fixes: false } } : {}), shell: false }, o.target) : undefined;
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
      o.log(`${label}starting reviewer ${attempt} of ${attempts}${o.profile && o.profile !== REVIEWER_PROFILE ? ` (${o.profile})` : ""}\n`);
      handle = await start({ ...o, text, ...(readOnlyText ? { readOnlyText } : {}), attempt });
      w.sessionId = handle.sessionId;
      o.log(`reviewer chat ${handle.sessionId}${handle.model ? ` on ${handle.model}${handle.thinking ? ` (${handle.thinking})` : ""}` : ""}\n`);
      const h = handle;
      if (h.limited) o.log(`${label}${h.limited}\n`);
      if (h.path) record(() => recorder?.started({ root: o.root, run: o.runId, branch: o.branch, session: h.sessionId, path: h.path!, attempt }));
      const a = await answer;
      record(() => recorder?.ended({ root: o.root, session: h.sessionId, ...("failed" in a ? { why: a.failed } : { verdict: a.verdict }) }));
      if ("failed" in a) {
        why = a.failed;
        o.log(`reviewer ${attempt}: ${a.failed}\n`);
        if (a.failed === "aborted") return { ok: false, why };
        continue;
      }
      o.log(`${label}verdict: ${a.verdict}${a.text ? `\n${a.text}` : ""}\n`);
      return { ok: true, answer: { verdict: a.verdict, ...reportOf(a) }, ran: { ...(h.model ? { model: h.model } : {}), ...(h.thinking ? { thinking: h.thinking } : {}), ...(h.limited ? { limited: h.limited } : {}) } };
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
