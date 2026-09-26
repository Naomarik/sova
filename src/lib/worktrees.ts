// Words for a session's tracked worktrees (§chat.worktrees/pane) and its merge cards
// (§chat.worktrees/merge-card). Pure: the Session tab and the transcript card render these.
import type { SessionWorktreeInfo, WorktreeMergeInfo } from "../../shared/protocol";

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** A chip on a worktree row: its words, its tone, and what hovering it says. */
export interface WorktreeChip {
  label: string;
  tone: "success" | "info" | "warn" | "neutral";
  title: string;
}

/**
 * The status: a chip word ("Active", "Dropped", "Merged") and, for a merge, its detail ("into
 * master at abc1234", kept out of the chip so the sha isn't uppercased). An active worktree the
 * server found already merged reads merged too, and its title says this session didn't record it.
 */
export function worktreeStatus(w: Pick<SessionWorktreeInfo, "status" | "merge" | "mergedInto">): WorktreeChip & { detail?: string } {
  if (w.status === "merged" && w.merge)
    return {
      label: "Merged",
      detail: `into ${w.merge.target} at ${shortSha(w.merge.sha)}`,
      tone: "success",
      title: w.merge.how === "detected" ? "Merged with git during one of this session's turns." : "Merged by this session's worktree tool.",
    };
  if (w.status === "dropped") return { label: "Dropped", tone: "neutral", title: "No longer tracked. Nothing on disk was deleted." };
  if (w.mergedInto)
    return {
      label: "Merged",
      detail: `into ${w.mergedInto.target} at ${shortSha(w.mergedInto.sha)}`,
      tone: "success",
      title: "Its branch is in the target, but this session didn't record the merge. Workers may still start here.",
    };
  return { label: "Active", tone: "info", title: "Workers of this session may start here." };
}

/** The other chips, in reading order: missing, .agent, running workers. */
export function worktreeChips(w: Pick<SessionWorktreeInfo, "exists" | "hasAgentDir" | "runningWorkers">): WorktreeChip[] {
  const out: WorktreeChip[] = [];
  if (!w.exists) out.push({ label: "Missing", tone: "warn", title: "The directory is gone. The session still lists it." });
  if (w.hasAgentDir) out.push({ label: ".agent", tone: "neutral", title: "Has its own agent dir: a worker can run on it with useWorktreeConfig." });
  if (w.runningWorkers > 0)
    out.push({
      label: `${w.runningWorkers} ${w.runningWorkers === 1 ? "worker" : "workers"}`,
      tone: "info",
      title: "This session's workers with a live process inside it.",
    });
  return out;
}

/** The pane's one-line summary under the heading: "2 active · 1 merged · 1 dropped". */
export function worktreesSummary(rows: Pick<SessionWorktreeInfo, "status">[]): string {
  const count = (s: SessionWorktreeInfo["status"]) => rows.filter((r) => r.status === s).length;
  return (["active", "merged", "dropped"] as const)
    .map((s) => [count(s), s] as const)
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${n} ${s}`)
    .join(" · ");
}

/** The merge card's numbers: "5 commits · +120 −30 · fast-forward". */
export function mergeNumbers(m: Pick<WorktreeMergeInfo, "commits" | "added" | "removed" | "fastForward">): string {
  return `${m.commits} ${m.commits === 1 ? "commit" : "commits"} · +${m.added} −${m.removed} · ${m.fastForward ? "fast-forward" : "merge commit"}`;
}
