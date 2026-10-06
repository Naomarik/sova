/**
 * Adversarial review on the alignment card (§chat.alignment-review/card): whether the feature is
 * on, the per-phase lines the card body shows, and what the card's foot offers — a Review Plan /
 * Review Implementation button, or the phase's verdict line once it ran. The words match the extension's
 * own (pi-config/extensions/mode/align.ts `reviewPhaseName`, `reviewVerdictLine`, `reviewRequestMessage`); both
 * sides' tests pin them.
 */
import { createSignal } from "solid-js";
import type { AlignDocInfo, AlignReviewEntryInfo, AlignReviewPhaseInfo } from "../../shared/protocol";

/**
 * Whether adversarial review is on (Settings → Experimental, the `adversarial-review` flag). Off
 * until something sets it: with it off no review line, button or Reviewer row renders anywhere.
 */
const [adversarialReview, setAdversarialReview] = createSignal(false);
export { adversarialReview, setAdversarialReview };

/**
 * A phase as the user reads it: "Plan" or "Implementation" (the chip, the lines, the button). `diff`
 * stays the id; the user decides about the implementation, the diff is only what the reviewer reads.
 */
export const reviewPhaseName = (phase: AlignReviewPhaseInfo): string => (phase === "plan" ? "Plan" : "Implementation");

/** The message the card's button sends: the same words as the TUI's /review, its phase token always the id. */
export const reviewRequestMessage = (doc: string, phase: AlignReviewPhaseInfo): string =>
  `${doc}: run the adversarial ${reviewPhaseName(phase).toLowerCase()} review now (align review, phase ${phase}), whatever the rule says.`;

/** One phase's verdict line ("Implementation review: 2 blocking (1 open)", "Plan reviewed · 1 constraint added"). */
export function reviewVerdictLine(phase: AlignReviewPhaseInfo, entry: AlignReviewEntryInfo): string {
  const Phase = reviewPhaseName(phase);
  switch (entry.state) {
    case "skipped":
      return `${Phase} review skipped: ${entry.reason}`;
    case "running":
      return `Reviewing the ${Phase.toLowerCase()}`;
    case "incomplete":
      return `${Phase} review incomplete: ${entry.reason}`;
    case "clear":
      return phase === "plan" ? `Plan reviewed · ${entry.reason}` : `${Phase} review: no blocking issues`;
    case "blocking": {
      const n = entry.blockers?.length ?? 0;
      if (phase === "plan" && n === 0) return `Plan reviewed · ${entry.reason}`;
      const open = entry.blockers?.filter((b) => !b.closed).length ?? 0;
      return `${Phase} review: ${n} blocking${open < n ? ` (${open} open)` : ""}`;
    }
  }
}

/** A chip tone (ui.tsx Chip); undefined is neutral. */
export type ReviewTone = "accent" | "success" | "warn" | "error" | undefined;

export interface ReviewLine {
  phase: AlignReviewPhaseInfo;
  text: string;
  tone: ReviewTone;
  /** "backend · model · effort" of the reviewer, when one ran. */
  model?: string;
  /** The blockers still open, each with its check. */
  open: { id: string; title: string; check: string }[];
}

const TONE: Record<AlignReviewEntryInfo["state"], ReviewTone> = { skipped: undefined, running: "accent", clear: "success", blocking: "error", incomplete: "warn" };

/** The card body's lines: one per recorded phase, plan first. Empty without a record. */
export function reviewLinesOf(doc: Pick<AlignDocInfo, "review">): ReviewLine[] {
  const out: ReviewLine[] = [];
  for (const phase of ["plan", "diff"] as const) {
    const entry = doc.review?.[phase];
    if (!entry) continue;
    const open = (entry.blockers ?? []).filter((b) => !b.closed).map(({ id, title, check }) => ({ id, title, check }));
    // A blocking review whose blockers are all closed reads settled, not alarming.
    const tone = entry.state === "blocking" && open.length === 0 ? "success" : TONE[entry.state];
    out.push({ phase, text: reviewVerdictLine(phase, entry), tone, ...(entry.model ? { model: entry.model } : {}), open });
  }
  return out;
}

/** A phase is used once it ran in any way; a skip leaves it usable. */
const used = (entry: AlignReviewEntryInfo | undefined): boolean => !!entry && entry.state !== "skipped";

/**
 * What the foot offers for review: the phase the alignment is in, as a button while that phase is
 * missing or skipped, else its verdict line (never a second round). Plan while aligning or
 * confirmed; diff while implementing, and after done only when the diff review was skipped.
 * null: nothing (dropped, or done with the diff reviewed or never recorded).
 */
export function reviewFoot(doc: Pick<AlignDocInfo, "phase" | "review">): { kind: "button"; phase: AlignReviewPhaseInfo; label: string } | { kind: "line"; phase: AlignReviewPhaseInfo; text: string } | null {
  const phase: AlignReviewPhaseInfo | null = doc.phase === "open" ? "plan" : doc.phase === "implementing" || doc.phase === "done" ? "diff" : null;
  if (phase === null) return null;
  const entry = doc.review?.[phase];
  if (doc.phase === "done" && entry?.state !== "skipped") return null;
  if (!used(entry)) return { kind: "button", phase, label: `Review ${reviewPhaseName(phase)}` };
  return { kind: "line", phase, text: reviewVerdictLine(phase, entry!) };
}

/** While the plan review runs, Go With Recommendations waits. */
export const planReviewRunning = (doc: Pick<AlignDocInfo, "review">): boolean => doc.review?.plan?.state === "running";
export const PLAN_REVIEW_WAIT = "Wait for the plan review.";
/** Under a review button: what a review is. */
export const REVIEW_ABOUT = "An independent reviewer reads it and reports problems. It can't change code or run anything.";
export const NO_REVIEWER = "No reviewer is set for this chat's subagent profile (Settings → Subagents → Reviewer).";
