// Words for a new session's worktrees line and the project page's Remove Anyway listing
// (§chat.transcript/empty-worktrees, §design.copy-deck/worktree-cleanup). Pure: the components
// render these.
import type { WorktreeRemoveAnyway, WorktreesSummary } from "../../shared/protocol";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Counted = Extract<WorktreesSummary, { state: "ok" }>;

/** The line shows for a repository with at least one linked worktree. */
export const showsLine = (s: WorktreesSummary | null | undefined): s is Counted => !!s && s.state === "ok" && s.total > 0;

/** "{total} worktrees", plus " · {held} held" and " · {retired} retired" (the last 7 days) when there are any. */
export function summaryLine(s: Counted): string {
  const parts = [plural(s.total, "worktree")];
  if (s.held) parts.push(`${s.held} held`);
  if (s.retired) parts.push(`${s.retired} retired`);
  // Only an install on an agent directory of its own says so here: every other reason shows on the Merge Queue tab.
  if (s.offFor === "install") parts.push("automatic cleanup is off for this install");
  return parts.join(" · ");
}

/** The Held tab's leading line when this project's cleanup lock looks taken: not a row, not counted. */
export const lockLine = (who: string): string => `Cleanup couldn't start here: its lock looks taken (${who}). It tries again at the next wake-up.`;

/** What became of a retired row's branch, for the end of its Retired line. Neither known (git refused, an old record): nothing. */
export const branchFateWords = (r: { branchDeleted: boolean; branchKept?: true }): string | null => (r.branchKept ? "branch kept" : r.branchDeleted ? "branch deleted" : null);

/** Remove Worktree's confirm, by what the project's setting will do with the branch. */
export const removeConfirmLine = (path: string, keepsBranch: boolean): string =>
  keepsBranch ? `The folder ${path} goes away and its branch stays. Restore brings the folder back.` : `The folder ${path} and its branch go away. Its last commit stays, and Restore brings them back.`;

// ---- Remove Anyway (§chat.worktrees/cleanup): a tree kept only for what it holds ----------------

/** The listing's first sentence: what goes that git can't bring back. */
export function anywayBody(a: WorktreeRemoveAnyway): string {
  const parts: string[] = [];
  const files = a.counts.uncommitted + a.counts.ignored;
  if (files) parts.push(plural(files, "file"));
  if (a.counts.nested) parts.push(plural(a.counts.nested, "nested repository", "nested repositories"));
  const one = files + a.counts.nested === 1;
  return `${parts.join(" and ")} ${one ? "is" : "are"} deleted with it. Git can't bring ${one ? "it" : "them"} back.`;
}

/** A list's heading with its exact total. */
export const anywayHeading = (label: string, n: number): string => `${label} · ${n}`;

/** Below a list cut at the server's limit. */
export const anywayMore = (shown: number, total: number): string | null => (total > shown ? `and ${total - shown} more` : null);

/** A nested repository's row: its path, and the repository a worktree belongs to. */
export const nestedLine = (n: WorktreeRemoveAnyway["nested"][number]): string =>
  n.kind === "worktree" ? `Worktree${n.of ? ` of ${n.of}` : ""}: its uncommitted work goes, its commits stay there.` : "Repository: deleted whole, its commits and uncommitted work with it.";
