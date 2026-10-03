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
export function worktreeStatus(w: Pick<SessionWorktreeInfo, "status" | "merge" | "mergedInto"> & Partial<Pick<SessionWorktreeInfo, "gone">>): WorktreeChip & { detail?: string } {
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
  // Tracked active, folder gone: what its work came to (§chat.worktrees/pane), never "Active".
  switch (w.gone) {
    case "merged":
      return { label: "Merged", tone: "success", title: "Its branch is in the main branch and its folder was cleaned up. This session still lists it." };
    case "unmerged":
      return { label: "Removed", tone: "warn", title: "The folder is gone and its branch has commits the main branch doesn't." };
    case "unknown":
      return { label: "Removed", tone: "warn", title: "The folder and its branch are gone, and nothing records a merge." };
    case "empty":
      return { label: "Removed", tone: "neutral", title: "The folder is gone. Its branch had no commits of its own." };
  }
  return { label: "Active", tone: "info", title: "Workers of this session may start here." };
}

/** The other chips, in reading order: cleaned up or removed (a gone folder the status chip doesn't
    already call Removed), .agent, running workers. */
export function worktreeChips(
  w: Pick<SessionWorktreeInfo, "exists" | "hasAgentDir" | "runningWorkers"> & Partial<Pick<SessionWorktreeInfo, "status" | "merge" | "mergedInto" | "gone">>,
): WorktreeChip[] {
  const out: WorktreeChip[] = [];
  if (!w.exists) {
    const label = w.status ? worktreeStatus({ status: w.status, merge: w.merge, mergedInto: w.mergedInto, gone: w.gone }).label : "";
    if (label === "Merged") out.push({ label: "Cleaned up", tone: "neutral", title: "The folder was removed after its work was merged." });
    else if (label !== "Removed") out.push({ label: "Removed", tone: "neutral", title: "The directory is gone. The session still lists it." });
  }
  if (w.hasAgentDir) out.push({ label: ".agent", tone: "neutral", title: "Has its own agent dir: a worker can run on it with useWorktreeConfig." });
  if (w.runningWorkers > 0)
    out.push({
      label: `${w.runningWorkers} ${w.runningWorkers === 1 ? "worker" : "workers"}`,
      tone: "info",
      title: "This session's workers with a live process inside it.",
    });
  return out;
}

/** The merge-readiness chip after the status chip (§chat.worktrees/readiness); none while merged,
    which the status chip already says, and none before the server has read git. */
export function readinessChip(w: Pick<SessionWorktreeInfo, "readiness">): WorktreeChip | null {
  const r = w.readiness;
  if (!r || r.state === "merged") return null;
  const why = r.why ? `${r.why[0]!.toUpperCase()}${r.why.slice(1)}.` : "";
  switch (r.state) {
    case "ready":
      return { label: "Ready to merge", tone: "success", title: why || "Nothing stands in the way of a merge." };
    case "waiting-approval":
      return { label: "Waiting for your OK", tone: "info", title: `Ready to merge, and the last reply asks you. ${why}`.trim() };
    case "in-progress":
      return { label: "In progress", tone: "neutral", title: why || "Work is still going on here." };
    case "blocked":
      return { label: "Blocked", tone: "warn", title: why || "Waiting on your answers." };
    case "stale":
      return { label: "Stale", tone: "warn", title: why || "Merged, but not clean." };
    case "removed":
      return null; // the status chip already says Removed
  }
}

/** The visible muted line under a worktree with a readiness, so a phone gets the reason without
    hover: the server's `reason` ("Ready to merge · checks passed · 19 commits ahead"), else its
    state and why. None with neither: the chip alone already says the state. */
export function readinessReason(w: Pick<SessionWorktreeInfo, "readiness">): string | null {
  const r = w.readiness;
  if (r?.reason) return r.reason;
  if (!r?.why) return null;
  const label = r.state === "merged" ? "Merged" : readinessChip(w)!.label;
  return `${label} · ${r.why}`;
}

/** The Session tab's line for a branch that tracks none: the section stays, and says so. */
export const NO_WORKTREES = "This session tracks no worktrees.";

/** The pane's one-line summary under the heading: "2 active · 1 merged · 1 removed · 1 dropped", or
    NO_WORKTREES for an empty set. A worktree tracked active whose folder is gone counts as its
    status chip reads: merged or removed (§chat.worktrees/pane). */
export function worktreesSummary(rows: (Pick<SessionWorktreeInfo, "status"> & Partial<Pick<SessionWorktreeInfo, "gone">>)[]): string {
  if (rows.length === 0) return NO_WORKTREES;
  const shown = (r: (typeof rows)[number]) => (r.status === "active" && r.gone ? (r.gone === "merged" ? "merged" : "removed") : r.status);
  const count = (s: string) => rows.filter((r) => shown(r) === s).length;
  return (["active", "merged", "removed", "dropped"] as const)
    .map((s) => [count(s), s] as const)
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${n} ${s}`)
    .join(" · ");
}

/** The merge card's numbers: "5 commits · +120 −30 · fast-forward". */
export function mergeNumbers(m: Pick<WorktreeMergeInfo, "commits" | "added" | "removed" | "fastForward">): string {
  return `${m.commits} ${m.commits === 1 ? "commit" : "commits"} · +${m.added} −${m.removed} · ${m.fastForward ? "fast-forward" : "merge commit"}`;
}
