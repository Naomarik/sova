import type { ReadinessState, SessionReadiness } from "../../shared/protocol";

/**
 * The row's merge readiness (§chat.worktrees/readiness): the server decides which badge holds; this
 * only words it. The count of the worktrees the session tracks ("2 of 3", lit while one is ready to
 * merge) carries the state, and the muted badge after it adds only what a count cannot say — a merge
 * this server hasn't run yet, and the open work a follow-up check named.
 */

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
  const observations = specObservationSummary(r);
  if (observations) lines.push(observations);
  return lines.join("\n");
}

/** Neutral observations, never a derived readiness verdict or a successful-test claim. */
export function specObservationSummary(r: SessionReadiness | undefined): string | null {
  const o = r?.specObservations;
  if (!o) return null;
  if (!o.items.length) return `Spec observations: ${o.state === "incomplete" ? "incomplete, " : ""}no receipts · applicability unknown · verification unrecorded`;
  const counts = (key: "applicability" | "attributionState", value: string) => o.items.filter(i => i[key] === value).length;
  const parts = ["current", "stale", "unknown"].flatMap(v => counts("applicability", v) ? [`${counts("applicability", v)} ${v}`] : []);
  if (o.state === "incomplete") parts.unshift("incomplete");
  for (const v of ["unknown", "conflicting"]) if (counts("attributionState", v)) parts.push(`${counts("attributionState", v)} ${v} attribution`);
  const unresolved = o.items.reduce((n, i) => n + (i.unresolved ?? 0), 0);
  if (unresolved) parts.push(`${unresolved} unresolved`);
  if (o.items.some(i => i.unresolved === null || i.assessmentState === "unknown")) parts.push("assessment unknown");
  const results = o.items.flatMap(i => i.verification);
  const verification = ["passed", "failed", "unknown"].flatMap(v => {
    const n = results.filter(b => b.result === v).length;
    return n ? [`${n} ${v}`] : [];
  });
  parts.push(verification.length ? `recorded verification: ${verification.join(", ")}` : "verification unrecorded");
  if (results.length) {
    const bindings = ["matching", "mismatched", "unknown"].flatMap(v => {
      const n = results.filter(b => (b.revisionBinding?.inputApplicability ?? "unknown") === v).length;
      return n ? [`${n} ${v}`] : [];
    });
    parts.push(`verification inputs: ${bindings.join(", ")}`);
  }
  return `Spec observations: ${parts.join(" · ")}`;
}
