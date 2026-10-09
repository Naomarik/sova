// The project page's coding sessions (§app/project-overseer): what they start in, their
// worktrees and the operator's Merge and Remove, and the commit a promotion makes. Pure rules the
// panel renders, so they run under tsx --test.

import type { PromoteResult } from "../../shared/decisions";
import { codingModeWords, type CodingModeNow, type CodingWorktree } from "../../shared/project-overseer";

/** The read-only line under "Coding sessions' mode": what a coding session started now gets (this computer's
    defaults) and how to change it, split so the mode words go in mono. */
export function codingModeHint(now: CodingModeNow): { before: string; mode: string; after: string } {
  const mode = codingModeWords(now);
  return now.subagents
    ? { before: "Coding sessions start in ", mode, after: `, with the ${now.subagents.name} subagent profile: this computer's defaults. Save as default in any chat's mode menu changes them.` }
    : { before: "Coding sessions start in ", mode, after: ": this computer's default mode. Save as default in any chat's mode menu changes it." };
}

// ---- coding sessions and their worktrees ------------------------------------------------------------

type Row = Pick<CodingWorktree, "state" | "path" | "running" | "workers" | "merged" | "branchGone">;

/** Why a gesture can't run now (the disabled reason), or null when it can. */
export type Gate = string | null;

function busyGate(w: Row): Gate {
  if (w.path === null) return "On another host";
  if (w.running) return "Session working";
  if (w.workers > 0) return "Workers running";
  return null;
}

/** The merge line's words before its target (the caller adds the target and the last merge's time), or null:
    merged; merged before, with commits since (git, not the record, says it is merged). */
export function mergeNote(w: Pick<CodingWorktree, "state" | "merged" | "mergedAt" | "newSinceMerge">): string | null {
  if (w.merged) return w.state === "merged" || w.mergedAt ? "Merged into" : null;
  const n = w.newSinceMerge ?? 0;
  if (!w.mergedAt || n < 1) return null;
  return `${n} new commit${n === 1 ? "" : "s"} since the last merge into`;
}

/** Merge Branch is offered on a branch not yet in its target: open, or its folder gone (removed or missing) before a merge. */
export const offersMerge = (w: Row): boolean => (w.state === "open" || w.state === "removed" || w.state === "missing") && !w.merged && !w.branchGone;
/** Remove Worktree is offered while the worktree folder is there. */
export const offersRemove = (w: Row): boolean => w.state === "open" || w.state === "merged";

export const mergeGate = (w: Row): Gate => busyGate(w);
export const removeGate = (w: Row): Gate => busyGate(w);

/** The line about its worktree folder, or null: removed; on another host (its folder is there, not
    missing); missing only on the host that made it. */
export function folderNote(w: Pick<CodingWorktree, "state" | "path">): string | null {
  if (w.state === "removed") return "Worktree removed";
  if (w.state === "root") return null;
  if (w.path === null) return "On another host: its worktree is there.";
  return w.state === "missing" ? "Worktree folder missing" : null;
}

/** The row's meta line before its branch: "Started by you · idle · 2h ago" (time added by the caller). */
export const startedBy = (w: Pick<CodingWorktree, "startedBy" | "via" | "playbook">): string =>
  (w.playbook ? "Project verbs playbook run · " : "") +
  (w.startedBy === "overseer" ? "Started by the overseer" : w.via === "overseer" ? "Started by you, via the Overseer" : "Started by you");

/** Newest first. */
export const worktreeOrder = (ws: readonly CodingWorktree[]): CodingWorktree[] => [...ws].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---- the promotion's commit ----------------------------------------------------------------------

/**
 * What a promotion did to the project root's git history, as one line: the commit, or the
 * visible reason it made none. Null when the result carries no commit (a non-git root).
 */
export function promotionCommitLine(commit: PromoteResult["commit"]): { tone: "success" | "warn"; text: string; reason?: string } | null {
  if (!commit) return null;
  if ("skipped" in commit) {
    const reason = commit.skipped.trim();
    // The server words it as the claim does ("Not committed: …"); a bare reason gets the prefix.
    return { tone: "warn", text: /^Not committed/.test(reason) ? reason : `Not committed: ${reason.replace(/^[A-Z](?=[a-z\s])/, (c) => c.toLowerCase())}`, reason };
  }
  return { tone: "success", text: `Committed ${commit.sha.slice(0, 7)} on ${commit.branch}.` };
}
