/**
 * How the review step's reviewer chat starts and ends on the server: a fresh chat per attempt, in
 * the merge copy, on the shipped `merge-reviewer` profile (no edit tools, no workers, web, timers or
 * worktrees) and the project's review model (models.ts; unset: the new-chat default), with the review step's own message (review-step.ts `reviewerText`); archived when the
 * step is done with it. The review step awaits the verdict, times out and retries; this file only
 * starts and stops chats.
 *
 * The kit is opened only through that message: it is never a skill and never loaded into another chat.
 *
 * Harness-neutral: the chat starts through Sova's own POST /api/sessions and ends through its archive.
 */
import type { ReviewerStart, StartReviewer } from "./review-step";
import { createChat, type AppRequest, type Result } from "./thread";

export const REVIEWER_PROFILE = "merge-reviewer";

export interface ReviewerDeps {
  /** `root`: the project's main checkout (whose review model it starts on). */
  create(cwd: string, text: string, title: string, root: string): Promise<Result<{ id: string; path: string }>>;
  archive(path: string): Promise<Result>;
}

/** The title a reviewer chat gets: what it reviews, and which attempt. */
export function reviewerTitle(o: Pick<ReviewerStart, "branch" | "commit" | "attempt">): string {
  return `Review · ${o.branch} · ${o.commit.slice(0, 7)}${o.attempt > 1 ? ` · attempt ${o.attempt}` : ""}`;
}

/** The review step's starter over `deps`. A refused start throws (the step counts it as the reviewer's failure). */
export function reviewerStarter(deps: ReviewerDeps): StartReviewer {
  return async (o) => {
    const r = await deps.create(o.copy, o.text, reviewerTitle(o), o.root);
    if (!r.ok) throw new Error(`couldn't start the reviewer: ${r.error}`);
    let stopped = false;
    return {
      sessionId: r.id,
      async stop() {
        if (stopped) return;
        stopped = true;
        const a = await deps.archive(r.path).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
        if (!a.ok) console.warn(`[merge-reviewer] ${r.id} not archived: ${a.error}`);
      },
    };
  };
}

/** Wire the review step's starter on the server: Sova's own session start and archive. */
export async function startMergeReviewer(request: AppRequest): Promise<void> {
  const [{ setReviewerStarter }, { archiveSession }] = await Promise.all([import("./review-step"), import("../sessions-index")]);
  setReviewerStarter(
    reviewerStarter({
      create: async (cwd, text, title, root) => createChat(request, cwd, REVIEWER_PROFILE, text, title, await (await import("./models")).startingModel(root, "review")),
      async archive(path) {
        const r = await archiveSession(path, true);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    }),
  );
}
