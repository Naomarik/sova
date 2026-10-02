// The project page's coding sessions (§app/project-overseer): their mode setting, their
// worktrees and the operator's Merge and Remove, and the commit a promotion makes. Pure rules the
// panel renders, so they run under tsx --test.

import type { PromoteResult } from "../../shared/decisions";
import type { CodingWorktree, ProjectCodingMode } from "../../shared/project-overseer";

/** One choice in the "Coding sessions' mode" select; `auto` is Automatic (null in the settings). */
export type CodingModeKey = "auto" | "normal" | "normal+spec" | "delegate" | "delegate+spec";

export const CODING_MODE_KEYS: readonly CodingModeKey[] = ["auto", "normal", "normal+spec", "delegate", "delegate+spec"];

/** A mode as the page says it: `normal`, `normal · spec`. */
export const modeWords = (m: ProjectCodingMode): string => [m.mode, ...m.minorModes].join(" · ");

export function codingModeKey(m: ProjectCodingMode | null): CodingModeKey {
  if (!m) return "auto";
  return (m.minorModes.includes("spec") ? `${m.mode}+spec` : m.mode) as CodingModeKey;
}

export function codingModeOf(key: CodingModeKey): ProjectCodingMode | null {
  if (key === "auto") return null;
  const [mode, minor] = key.split("+") as ["normal" | "delegate", string | undefined];
  return { mode, minorModes: minor ? [minor] : [] };
}

export const codingModeLabel = (key: CodingModeKey): string => (key === "auto" ? "Automatic" : modeWords(codingModeOf(key)!));

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
