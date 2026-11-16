// A branch summary as a row draws it (components/BranchSummary.tsx): pure, so the rules run in the unit tier.
import type { BranchSummary } from "../../shared/merge-queue";

export interface BranchSummaryShown {
  /** The line over the bullets: "Summarizing…", "Couldn't summarize this branch" with Try Again, or none. */
  line: "writing" | "failed" | "none";
  bullets: string[];
  /** The bullets are an earlier commit's ("From an earlier commit"). */
  stale: boolean;
}

/** A Try Again the server took: the commit it writes again, when it was taken (ms epoch), and whether a read has
    shown it being written since. */
export interface SummaryRetry {
  commit: string;
  at: number;
  sawWriting: boolean;
}

/** A read that says "failed" this soon after a Try Again was taken may have left before it: it settles nothing. */
export const RETRY_SETTLE_MS = 1000;
/** With no read at all after a taken Try Again, the row stops saying "Summarizing…" after this long. */
export const RETRY_GRACE_MS = 12_000;

/**
 * A taken Try Again after a read of the summary at `now`: still waiting, or null once it is over. Over: the new
 * summary is there, the branch moved to another commit, or the failure is back. The server marks a taken Try Again as
 * being written before it answers, so a read made after that which says "failed" is the failure, back: whether a read
 * caught it being written or not (one that fails at once is never caught). Pure.
 */
export function retryAfter(s: BranchSummary | undefined, r: SummaryRetry | null, now: number): SummaryRetry | null {
  if (!r || !s || s.commit !== r.commit || s.state === "ready") return null;
  if (s.state === "writing") return r.sawWriting ? r : { ...r, sawWriting: true };
  return r.sawWriting || now - r.at >= RETRY_SETTLE_MS ? null : r;
}

/** What the row shows for a summary; null: nothing at all (none known yet). At most 5 bullets. While a taken Try
    Again waits (`retry`, for this commit), a failed summary reads as being written. Pure. */
export function branchSummaryShown(s: BranchSummary | undefined, retry: SummaryRetry | null = null): BranchSummaryShown | null {
  if (!s) return null;
  const bullets = (s.bullets ?? []).filter((b) => typeof b === "string" && b.trim()).slice(0, 5);
  const waiting = s.state === "failed" && retry?.commit === s.commit;
  const line = s.state === "writing" || waiting ? "writing" : s.state === "failed" ? "failed" : "none";
  if (line === "none" && !bullets.length) return null;
  return { line, bullets, stale: !!s.stale && bullets.length > 0 };
}
