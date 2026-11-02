/**
 * The review step's reviewer: a fresh chat per run, started in the merge copy at exactly the commit
 * being checked, told to follow the project's review kit and to answer with `merge.review`. It runs
 * on the shipped `merge-reviewer` profile (no edit tools, no workers, web, timers or worktrees) and is
 * archived when the step ends. The review step (review-step.ts) awaits the verdict with its own
 * timeout and retries; this file only starts and stops the chat.
 *
 * The kit is opened only here: it is never a skill and never loaded into another chat.
 *
 * Harness-neutral: the chat starts through Sova's own POST /api/sessions and ends through its archive.
 */
import { join } from "node:path";
import { createChat, type AppRequest, type Result } from "./thread";

export const REVIEWER_PROFILE = "merge-reviewer";

export interface ReviewerInput {
  /** The project's main checkout (for the title). */
  root: string;
  /** The merge copy, checked out at `commit`: the reviewer's working folder. */
  copy: string;
  /** The commit under review (the merge tip) and the target commit it sits on. */
  commit: string;
  base: string;
  /** The review kit's folder, absolute (the definition's merge.review, under the copy). */
  kitDir: string;
  /** The run whose review this is: merge.review answers it. */
  runId: string;
  /** A file listing the changed paths, one per line, when the run has one. */
  changedFile?: string;
}

export interface StartedReviewer {
  sessionId: string;
  path: string;
  /** Archive the chat (stops it); safe to call twice. */
  stop(): Promise<void>;
}

export interface ReviewerDeps {
  create(cwd: string, text: string, title: string): Promise<Result<{ id: string; path: string }>>;
  archive(path: string): Promise<Result>;
}

/** The reviewer's one message: the kit to follow, what to review, and the verb to answer with. */
export function reviewerText(i: ReviewerInput): string {
  return [
    `You are the merge queue's reviewer for run ${i.runId}. Read ${join(i.kitDir, "PLAYBOOK.md")} now and follow it; read its references as it says.`,
    `Review exactly commit ${i.commit} on top of ${i.base}, in this folder (${i.copy}): \`git diff ${i.base}...${i.commit}\`.${i.changedFile ? ` The changed paths are listed in ${i.changedFile}.` : ""}`,
    "Read only: change no file, commit nothing, start nothing.",
    `Answer once, with merge.review {run: "${i.runId}", verdict, text} (the project verbs tool); the kit's scripts/verdict.mjs checks your verdict and prints the text to send. Then stop.`,
  ].join("\n");
}

/** Start a reviewer chat for one run. Throws when Sova can't start it (the step counts that as a reviewer failure). */
export async function startReviewer(i: ReviewerInput, deps: ReviewerDeps): Promise<StartedReviewer> {
  const name = i.root.split("/").filter(Boolean).pop() ?? i.root;
  const r = await deps.create(i.copy, reviewerText(i), `Review · ${name} · ${i.commit.slice(0, 7)}`);
  if (!r.ok) throw new Error(`couldn't start the reviewer: ${r.error}`);
  let stopped = false;
  return {
    sessionId: r.id,
    path: r.path,
    async stop() {
      if (stopped) return;
      stopped = true;
      const a = await deps.archive(r.path).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
      if (!a.ok) console.warn(`[merge-reviewer] ${r.id} not archived: ${a.error}`);
    },
  };
}

/** The server's deps: Sova's own session start and archive. */
export function liveReviewerDeps(request: AppRequest): ReviewerDeps {
  return {
    create: (cwd, text, title) => createChat(request, cwd, REVIEWER_PROFILE, text, title),
    async archive(path) {
      const { archiveSession } = await import("../sessions-index");
      const r = await archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  };
}
