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

/** The muted badge's words, or null when there is none (or the chip speaks instead). The count is
    the follow-up check's named work only; a leftover worktree is in the title, never here. */
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
