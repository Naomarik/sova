/**
 * How the review step's reviewer chat starts and ends on the server: a fresh chat per attempt, in
 * the merge copy, on the shipped `merge-reviewer` profile (no edit tools, no workers, web, timers or
 * worktrees) and the project's review model (models.ts; unset: the new-chat default), with the review step's own message (review-step.ts `reviewerText`); archived when the
 * step is done with it: its turn is waited for (at most 2 min), else stopped, then archived with retries
 * (retire.ts). When Sova starts, every reviewer chat no review is waiting on is tidied away the same way
 * (sweepReviewers). The review step awaits the verdict, times out and retries; this file only starts and
 * stops chats.
 *
 * The kit is opened only through that message: it is never a skill and never loaded into another chat.
 *
 * Harness-neutral: the chat starts through Sova's own POST /api/sessions and ends through its archive.
 */
import type { SessionSummary } from "../../shared/protocol";
import type { ReviewerStart, StartReviewer } from "./review-step";
import { retireChat, type RetireDeps, type RetireOutcome } from "./retire";
import { createChat, type AppRequest, type Result } from "./thread";
import { reviewerTitle as sharedReviewerTitle } from "../../shared/fixed-names";

export const REVIEWER_PROFILE = "merge-reviewer";

export interface ReviewerDeps {
  /** `root`: the project's main checkout (whose review model it starts on). */
  create(cwd: string, text: string, title: string, root: string): Promise<Result<{ id: string; path: string }>>;
  archive(path: string): Promise<Result>;
  /** The chat is mid-turn; absent: never (the archive alone decides). */
  busy?(path: string): boolean;
  /** Stop its turn. */
  abort?(path: string): Promise<void>;
  /** retire.ts's clock, waits and log, for tests. */
  retire?: Pick<RetireDeps, "now" | "sleep" | "log" | "waitMs" | "pollMs" | "retryMs">;
}

/** retire.ts's deps over a reviewer's. */
const retireDeps = (deps: ReviewerDeps): RetireDeps => ({
  busy: (p) => deps.busy?.(p) ?? false,
  abort: (p) => deps.abort?.(p) ?? Promise.resolve(),
  archive: (p) => deps.archive(p),
  log: (l) => console.warn(`[merge-reviewer] ${l}`),
  ...deps.retire,
});

/** The title a reviewer chat gets: what it reviews, and which attempt (shared/fixed-names.ts, also used to rebuild it). */
export const reviewerTitle = (o: Pick<ReviewerStart, "branch" | "commit" | "attempt">): string => sharedReviewerTitle(o);

/** The review step's starter over `deps`. A refused start throws (the step counts it as the reviewer's failure). */
export function reviewerStarter(deps: ReviewerDeps): StartReviewer {
  return async (o) => {
    const r = await deps.create(o.copy, o.text, reviewerTitle(o), o.root);
    if (!r.ok) throw new Error(`couldn't start the reviewer: ${r.error}`);
    let retiring: Promise<RetireOutcome> | null = null;
    return {
      sessionId: r.id,
      path: r.path,
      /** Once: wait for its turn (else stop it), then archive. A second call answers the first's outcome. */
      stop() {
        retiring ??= retireChat(r.path, retireDeps(deps));
        return retiring.then(() => undefined);
      },
    };
  };
}

/**
 * Tidy away reviewer chats left open: every reviewer chat (SessionSummary.queueChat) not archived whose run no
 * review is waiting on now (`active`), each retired in turn. Resolves the paths it retired.
 */
export async function sweepReviewers(sessions: readonly Pick<SessionSummary, "id" | "path" | "archived" | "queueChat">[], active: ReadonlySet<string>, retire: (path: string) => Promise<RetireOutcome>): Promise<string[]> {
  const left = sessions.filter((s) => s.queueChat?.role === "reviewer" && !s.archived && !active.has(s.id));
  const done: string[] = [];
  for (const s of left) if ((await retire(s.path).catch(() => "not-archived" as const)) !== "not-archived") done.push(s.path);
  return done;
}

/** Wire the review step's starter on the server: Sova's own session start and archive; then the startup sweep. */
export async function startMergeReviewer(request: AppRequest): Promise<void> {
  const [{ setReviewerStarter, activeReviewers }, { listSessions }, { liveRetireDeps }] = await Promise.all([import("./review-step"), import("../sessions-index"), import("./retire")]);
  const live = await liveRetireDeps();
  setReviewerStarter(
    reviewerStarter({
      create: async (cwd, text, title, root) => createChat(request, cwd, REVIEWER_PROFILE, text, title, await (await import("./models")).startingModel(root, "review")),
      archive: live.archive,
      busy: live.busy,
      abort: live.abort,
    }),
  );
  // Not awaited, and not in the start's first moments: a listing then is reused by the requests right after it
  // (sessions-index's reuse window), so files written meanwhile would be missed. The sweep has no hurry.
  const t = setTimeout(() => {
    void listSessions()
      .then((all) => sweepReviewers(all, activeReviewers(), (p) => retireChat(p, { ...live, log: (l) => console.warn(`[merge-reviewer] ${l}`) })))
      .then((done) => {
        if (done.length) console.log(`[merge-reviewer] archived ${done.length} reviewer chat${done.length === 1 ? "" : "s"} left open`);
      })
      .catch((err) => console.warn(`[merge-reviewer] sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }, SWEEP_DELAY_MS);
  (t as { unref?: () => void }).unref?.();
}

/** How long after the server's start the reviewer sweep runs. */
export const SWEEP_DELAY_MS = 30_000;
