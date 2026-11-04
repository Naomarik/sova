// A branch summary as a row draws it (components/BranchSummary.tsx): pure, so the rules run in the unit tier.
import type { BranchSummary } from "../../shared/merge-queue";

export interface BranchSummaryShown {
  /** The line over the bullets: "Summarizing…", "Couldn't summarize this branch" with Try Again, or none. */
  line: "writing" | "failed" | "none";
  bullets: string[];
  /** The bullets are an earlier commit's ("From an earlier commit"). */
  stale: boolean;
}

/** What the row shows for a summary; null: nothing at all (none known yet). At most 5 bullets. Pure. */
export function branchSummaryShown(s: BranchSummary | undefined): BranchSummaryShown | null {
  if (!s) return null;
  const bullets = (s.bullets ?? []).filter((b) => typeof b === "string" && b.trim()).slice(0, 5);
  const line = s.state === "writing" ? "writing" : s.state === "failed" ? "failed" : "none";
  if (line === "none" && !bullets.length) return null;
  return { line, bullets, stale: !!s.stale && bullets.length > 0 };
}
