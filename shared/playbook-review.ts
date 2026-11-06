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
  /** What the run proposes: a deploy-setup run's is its deploy recipe, a release-setup run's its release setup. */
  proposes?: "definition" | "deploy" | "release" | "pipeline";
}

const nothingValid = (r: PlaybookReviewWords) => (r.proposes === "deploy" ? "no valid deploy recipe" : r.proposes === "release" ? "no valid release setup" : r.proposes === "pipeline" ? "no valid setup" : "no valid definition");

export const hash12 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 12);

/** The Needs-you item's sentence. */
export function reviewDetail(r: PlaybookReviewWords): string {
  if (!r.hash) return `${r.label}: its branch ${r.branch} has ${nothingValid(r)}: read its report`;
  return `${r.label}: merge ${hash12(r.hash)} into ${r.target}`;
}

/** The banner: its title, and what to do. */
export function reviewBanner(r: PlaybookReviewWords): { title: string; body: string } {
  if (!r.hash) return { title: `${r.label} proposes changes on ${r.branch}.`, body: `Its branch has ${nothingValid(r)}: read its report.` };
  // A release setup's hash pins settings and playbook files together: no definition hash to show, so it is named.
  const what = r.proposes === "release" ? "a release setup" : r.proposes === "pipeline" ? "the project's setup" : hash12(r.hash);
  return { title: `${r.label} proposes ${what} on ${r.branch}.`, body: `Read it, then merge it into ${r.target}.` };
}

/** The one button's label: Merge Branch, none with nothing valid to merge. */
export const reviewAction = (r: Pick<PlaybookReviewWords, "hash">): string | null => (r.hash ? "Merge Branch" : null);
