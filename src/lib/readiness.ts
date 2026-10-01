import type { ReadinessState, SessionReadiness } from "../../shared/protocol";

/**
 * The row's merge readiness (§chat.worktrees/readiness): the server decides which badge holds; this
 * only words it. Ready and waiting are a toned chip that leads line 3 (they're what you can act
 * on); every other badge stays terse muted text between the time and the model.
 */

/** The chip that leads line 3: ready or waiting for your OK, else null. */
export interface ReadinessRowChip {
  label: string;
  tone: "success" | "info";
}

export function readinessRowChip(r: SessionReadiness | undefined): ReadinessRowChip | null {
  switch (r?.badge) {
    case "ready":
      return { label: "Ready to merge", tone: "success" };
    case "waiting":
      return { label: "Waiting for your OK", tone: "info" };
    default:
      return null;
  }
}

/** The row's worktree count (§chat.worktrees/readiness): merged of the worktrees this session
    tracks, and whether one of them is ready to merge — the count lights up for that, with no glyph
    and no word of its own. Null when the session tracks none, and before the server's background
    git read has a set. */
export interface ReadinessCount {
  merged: number;
  total: number;
  ready: boolean;
}

export function readinessCount(r: SessionReadiness | undefined): ReadinessCount | null {
  if (!r || r.trees.length === 0) return null;
  return {
    merged: r.trees.filter((t) => t.state === "merged").length,
    total: r.trees.length,
    // Ready to merge is either state: a worktree that waits for your OK is still mergeable.
    ready: r.trees.some((t) => t.state === "ready" || t.state === "waiting-approval"),
  };
}

/** The count's words for a reader who can't see the glyph or the tone: "2 of 3 worktrees merged",
    and ", one is ready to merge" while one is. The row's accessible name carries it. */
export function readinessCountWords(c: ReadinessCount): string {
  const merged = `${c.merged} of ${c.total} worktrees merged`;
  return c.ready ? `${merged}, one is ready to merge` : merged;
}

/** The muted badge's words, or null when there is none. The count is the follow-up check's named
    work only; a leftover worktree is in the title, never here. */
export function readinessBadge(r: SessionReadiness | undefined): string | null {
  switch (r?.badge) {
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
  ready: "ready to merge",
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
