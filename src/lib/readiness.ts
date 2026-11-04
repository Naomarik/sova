import type { ReadinessState, SessionReadiness } from "../../shared/protocol";

/**
 * The row's merge readiness (§chat.worktrees/readiness): the server decides which badge holds; this
 * only words it. The row's branch status (src/lib/branch-status.ts: its chat's headline) carries the
 * state, and the muted badge after it adds only what that cannot say — a merge this server hasn't
 * run yet, and the open work a follow-up check named.
 */

/** The muted badge's words, or null when there is none. The count already says "merged", so this
    carries only what the count cannot: a merge this server has not run yet, and the open work the
    follow-up check named. A leftover worktree is in the title, never here. */
export function readinessBadge(r: SessionReadiness | undefined): string | null {
  switch (r?.badge) {
    case "restart":
      return "restart pending";
    case "merged": {
      const n = r.followUps ?? 0;
      return n > 0 ? `${n} follow-up${n === 1 ? "" : "s"}` : null;
    }
    default:
      return null;
  }
}

const STATE_WORD: Record<ReadinessState, string> = {
  merged: "merged",
  stale: "stale",
  "in-progress": "in progress",
  blocked: "blocked",
  ready: "ready to merge",
  "waiting-approval": "waiting for your OK",
  removed: "removed",
};

/** A worktree's state word (the Session tab's rows and the badge's title). */
export const readinessWord = (state: ReadinessState): string => STATE_WORD[state];

/** The branch status line (§chat.worktrees/readiness), counted in code: "merged a1b2c3d · pushed ·
    live · spec promoted". null with no merge. */
export function branchStatusLine(st: SessionReadiness["status"]): string | null {
  if (!st) return null;
  const parts = [`merged ${st.commit}`];
  if (st.pushed !== undefined) parts.push(st.pushed ? "pushed" : "not pushed");
  parts.push(st.live ? "live" : "restart owed");
  if (st.specDrafts !== undefined) parts.push(st.specDrafts === 0 ? "spec promoted" : `${st.specDrafts} spec draft${st.specDrafts === 1 ? "" : "s"} not promoted`);
  return `${st.branch}: ${parts.join(" · ")}`;
}

/** What follows a merge, in words: restart owed, not pushed, worktrees left to clean up, the open work the
    follow-up check named. [] with none. */
export function afterMergeLines(r: SessionReadiness | undefined): string[] {
  const lines: string[] = [];
  if (!r) return lines;
  if (r.restartPending) lines.push("A merge changed the server since it started: restart it to run the new code.");
  if (r.pushPending) lines.push("The merge isn't pushed yet.");
  if (r.cleanup) lines.push(`${r.cleanup} merged worktree${r.cleanup === 1 ? " is" : "s are"} still tracked active.`);
  if (r.followUp) lines.push(`Open work (${r.followUp.weight}): ${r.followUp.cue}`);
  return lines;
}

/** The badge's `title`: the branch status line, one line per worktree, then each routine follow-up in words. */
export function readinessTitle(r: SessionReadiness | undefined): string | null {
  if (!r || r.trees.length === 0) return null;
  const status = branchStatusLine(r.status);
  const lines = [...(status ? [status] : []), ...r.trees.map((t) => `${t.branch}: ${readinessWord(t.state)}${t.why ? `, ${t.why}` : ""}`)];
  return [...lines, ...afterMergeLines(r)].join("\n");
}
