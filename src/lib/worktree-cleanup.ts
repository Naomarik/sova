// Words for a new session's worktrees line and its Clean Up Merged dialog
// (§chat.transcript/empty-worktrees, §design.copy-deck/worktree-cleanup). Pure: the component
// renders these.
import type { WorktreeCleanupRemoved, WorktreesSummary } from "../../shared/protocol";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Counted = Extract<WorktreesSummary, { state: "ok" }>;

/** The line shows for a repository with at least one linked worktree. */
export const showsLine = (s: WorktreesSummary | null | undefined): s is Counted => !!s && s.state === "ok" && s.total > 0;

/** "{total} worktrees · {merged} merged", plus " · {empty} empty" when there are empty leftovers. */
export function summaryLine(s: Counted): string {
  const parts = [plural(s.total, "worktree"), `${s.merged} merged`];
  if (s.empty > 0) parts.push(`${s.empty} empty`);
  return parts.join(" · ");
}

/** The button shows while something could go: merged plus empty above 0. */
export const offersCleanup = (s: Counted): boolean => s.merged + s.empty > 0;

/** The dialog's title from the dry run. */
export const confirmTitle = (n: number): string => (n > 0 ? `Remove ${plural(n, "merged worktree")}?` : "Nothing to remove right now.");

/** The confirm button. */
export const removeLabel = (n: number): string => (n === 1 ? "Remove 1 Worktree" : `Remove ${n} Worktrees`);

/** The body's first sentence. */
export const confirmBody = (n: number, main: string | undefined): string =>
  n > 0
    ? `These folders go away. A branch git finds in ${main ?? "the main branch"} is deleted too; the others keep their commits.`
    : "Every worktree here stays, for the reasons below.";

/** What becomes of a going tree's branch. */
export function branchFate(r: WorktreeCleanupRemoved): string {
  if (!r.branch) return "";
  return r.branchDeleted ? `${r.branch} · branch deleted` : `${r.branch} · branch kept, merged by content`;
}

/** After a removal: the dialog's title, and the toast and screen-reader line. */
export const doneTitle = (removed: number, kept: number): string => `Removed ${removed} · kept ${kept}`;
export const doneText = (removed: number, kept: number): string => `Removed ${plural(removed, "worktree")}. Kept ${kept}.`;
