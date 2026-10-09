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
  /** What the run proposes: a deploy-setup run's is its deploy recipe. */
  proposes?: "definition" | "deploy";
}

const nothingValid = (r: PlaybookReviewWords) => (r.proposes === "deploy" ? "no valid deploy recipe" : "no valid definition");

export const hash12 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 12);

/** The Needs-you item's sentence. */
export function reviewDetail(r: PlaybookReviewWords): string {
  if (!r.hash) return `${r.label}: its branch ${r.branch} has ${nothingValid(r)}: read its report`;
  return `${r.label}: merge ${hash12(r.hash)} into ${r.target}`;
}

/** The banner: its title, and what to do. */
export function reviewBanner(r: PlaybookReviewWords): { title: string; body: string } {
  if (!r.hash) return { title: `${r.label} proposes changes on ${r.branch}.`, body: `Its branch has ${nothingValid(r)}: read its report.` };
  return { title: `${r.label} proposes ${hash12(r.hash)} on ${r.branch}.`, body: `Read it, then merge it into ${r.target}.` };
}

/** The one button's label: Merge Branch, none with nothing valid to merge. */
export const reviewAction = (r: Pick<PlaybookReviewWords, "hash">): string | null => (r.hash ? "Merge Branch" : null);
