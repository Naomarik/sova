/**
 * A proposed verb playbook run, in words (§app.project-runtime/review): the Needs-you sentence (server) and the
 * project page's banner (web) say it the same way. Pure, imports nothing.
 */

export interface PlaybookReviewWords {
  /** The playbook's title ("Project verbs"). */
  label: string;
  branch: string;
  /** The branch the run's worktree merges into. */
  target: string;
  /** The definition its branch proposes; absent when it has none, or an invalid one. */
  hash?: string;
  approved: boolean;
}

export const hash12 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 12);

/** The Needs-you item's sentence. */
export function reviewDetail(r: PlaybookReviewWords): string {
  if (!r.hash) return `${r.label}: its branch ${r.branch} has no valid definition: read its report`;
  if (r.approved) return `${r.label}: ${hash12(r.hash)} is approved: merge it into ${r.target}`;
  return `${r.label}: approve ${hash12(r.hash)} and merge into ${r.target}`;
}

/** The banner: its title, and what to do. */
export function reviewBanner(r: PlaybookReviewWords): { title: string; body: string } {
  if (!r.hash) return { title: `${r.label} proposes changes on ${r.branch}.`, body: "Its branch has no valid definition: read its report." };
  const title = `${r.label} proposes ${hash12(r.hash)} on ${r.branch}.`;
  return { title, body: r.approved ? `It is approved: merge it into ${r.target}.` : `Approve it and merge it into ${r.target}.` };
}

/** The one button's label: Approve & Merge, Merge Branch once approved, none with nothing valid to approve. */
export const reviewAction = (r: Pick<PlaybookReviewWords, "hash" | "approved">): string | null => (!r.hash ? null : r.approved ? "Merge Branch" : "Approve & Merge");
