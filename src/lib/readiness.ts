import type { ReadinessState, SessionReadiness } from "../../shared/protocol";

/**
 * The row's merge-readiness badge (§chat.worktrees/readiness): the server decides which badge
 * holds; this only words it. Terse on purpose — it shares line 3 with the time and model.
 */

/** The badge's words, or null when there is none. */
export function readinessBadge(r: SessionReadiness | undefined): string | null {
  switch (r?.badge) {
    case "waiting":
      return "waiting for your OK";
    case "ready":
      return "ready ✓";
    case "restart":
      return "restart pending";
    case "merged": {
      const n = r.followUps ?? 0;
      return n > 0 ? `merged · ${n} follow-up${n === 1 ? "" : "s"}` : "merged";
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
  ready: "ready",
  "waiting-approval": "waiting for your OK",
};

/** A worktree's state word (the Session tab's rows and the badge's title). */
export const readinessWord = (state: ReadinessState): string => STATE_WORD[state];

/** The badge's `title`: one line per worktree, then each routine follow-up in words. */
export function readinessTitle(r: SessionReadiness | undefined): string | null {
  if (!r || r.trees.length === 0) return null;
  const lines = r.trees.map((t) => `${t.branch}: ${readinessWord(t.state)}${t.why ? `, ${t.why}` : ""}`);
  if (r.restartPending) lines.push("A merge changed the server since it started: restart it to run the new code.");
  if (r.pushPending) lines.push("The merge isn't pushed yet.");
  if (r.cleanup) lines.push(`${r.cleanup} merged worktree${r.cleanup === 1 ? " is" : "s are"} still tracked active.`);
  if (r.followUp) lines.push(`Open work (${r.followUp.weight}): ${r.followUp.cue}`);
  return lines.join("\n");
}
