// A blocking review's own card in the chat (shared/merge-queue.ts MergeReviewCard, §chat.merge-queue/review-card):
// the reviewer's whole report, the merge thread's note and how the fix is going. One card per review that blocks;
// a later block of the same entry folds the earlier one to one line. Pure words: no Solid, no DOM.
import type { ReviewCard as MergeReviewCard, ReviewCardState, ReviewFinding, ReviewKind } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { short } from "./merge-queue";

/** The built-in card type the rows carry: drawn by Sova, never a project's or an extension's. */
export const MERGE_REVIEW_CARD = "sova.merge-review";

/** A finding's kind as a word: the one map, so a new kind needs only its word here. */
export const REVIEW_KIND_WORD: Record<ReviewKind, string> = {
  "dead-code": "Dead code",
  duplication: "Duplication",
  hack: "Hack",
  "missing-test": "Missing test",
  naming: "Naming",
  other: "Other",
};
/** An unknown kind (a newer server's) reads as Other, never as its raw id. */
export const kindWord = (k: string): string => REVIEW_KIND_WORD[k as ReviewKind] ?? "Other";

/** Each state's word, as the card's state line reads it. */
export const REVIEW_STATE_LABEL: Record<ReviewCardState, string> = {
  "with-thread": "With the merge thread",
  fixing: "Fixing",
  "re-reviewing": "Fix sent · re-reviewing",
  stopped: "Stopped before re-review",
  passed: "Passed on re-review",
  waiting: "Waiting for you",
  removed: "Removed",
};

export type ReviewTone = "warn" | "info" | "accent" | "success" | "neutral";

/** The state line: its words, the tone of its dot, and whether it points to the queue card's decision. */
export function reviewStateLine(c: Pick<MergeReviewCard, "state" | "stoppedFor">): { label: string; text: string; tone: ReviewTone; toDecision?: true } {
  const label = REVIEW_STATE_LABEL[c.state] ?? "With the merge thread";
  switch (c.state) {
    case "fixing":
      return { label, text: "Fixing · this chat answers when it's done", tone: "info" };
    case "re-reviewing":
      return { label, text: label, tone: "accent" };
    case "stopped":
      return { label, text: c.stoppedFor?.trim() ? `${label} · ${c.stoppedFor.trim()}` : label, tone: "warn" };
    case "passed":
      return { label, text: label, tone: "success" };
    case "waiting":
      return { label, text: label, tone: "warn", toDecision: true };
    case "removed":
      return { label, text: label, tone: "neutral" };
    default:
      return { label, text: label, tone: "info" };
  }
}

/** "3 issues", "1 issue". */
export const issuesWords = (k: number): string => `${k} ${k === 1 ? "issue" : "issues"}`;
/** The queue card's pointer: "Review found 3 issues". */
export const reviewFoundWords = (k: number): string => `Review found ${issuesWords(k)}`;

/** The head's facts: "feat/x into master · abc1234 · try 1 of 3". */
export const reviewHead = (c: Pick<MergeReviewCard, "branch" | "target" | "commit" | "try" | "of">): string =>
  `${c.branch} into ${c.target} · ${short(c.commit)} · try ${c.try} of ${c.of}`;

/** A folded earlier review's one line: "Review · try 1 · 3 issues · fixed". */
export const foldedReviewLine = (c: Pick<MergeReviewCard, "try" | "findings">): string => `Review · try ${c.try} · ${issuesWords(c.findings.length)} · fixed`;

/** A finding's place, "file.ts:42" or "file.ts"; null when it names no file. */
export const findingPlace = (f: Pick<ReviewFinding, "file" | "line">): string | null => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : null);

/** The reviews that fold: each one a later review of the same entry stands after. */
export function foldedIds(reviews: readonly MergeReviewCard[]): Set<string> {
  const newest = new Map<string, MergeReviewCard>();
  for (const r of reviews) {
    const n = newest.get(r.entry);
    if (!n || Date.parse(r.at) >= Date.parse(n.at)) newest.set(r.entry, r);
  }
  return new Set(reviews.filter((r) => newest.get(r.entry)?.id !== r.id).map((r) => r.id));
}

/** One row's data: the review and whether it is folded. */
export interface ReviewCardRow {
  review: MergeReviewCard;
  folded: boolean;
}

/** One chat's review cards as the thread's outside-card rows: one per review, placed where it blocked. */
export function reviewCardRows(reviews: readonly MergeReviewCard[]): CardInfo[] {
  const folded = foldedIds(reviews);
  return reviews.map(
    (r): CardInfo => ({
      id: `mr:${r.id}`,
      type: MERGE_REVIEW_CARD,
      title: `Review found issues · ${r.branch}`,
      draws: "status",
      answerMode: "none",
      // Each review is its own card: its own key, so a later review never moves or replaces this one.
      placement: "follow",
      key: `review:${r.id}`,
      revision: 1,
      data: { review: r, folded: folded.has(r.id) } satisfies ReviewCardRow,
      at: r.at,
      by: { kind: "script" },
      ...(r.after !== undefined ? { after: r.after } : {}),
      state: folded.has(r.id) ? "superseded" : "open",
    }),
  );
}

/** The row id a review card's row has in the thread (for the queue card's jump). */
export const reviewRowCardId = (reviewId: string): string => `mr:${reviewId}`;

/** A row's data, or null when it isn't a review card's. */
export function reviewRowOf(card: Pick<CardInfo, "type" | "data">): ReviewCardRow | null {
  if (card.type !== MERGE_REVIEW_CARD) return null;
  const d = card.data as Partial<ReviewCardRow> | null;
  const r = d?.review;
  return r && typeof r.branch === "string" && Array.isArray(r.findings) && typeof r.try === "number" ? (d as ReviewCardRow) : null;
}

/** The card's accessible name. */
export const reviewCardLabel = (c: MergeReviewCard): string => `Review found issues: ${c.branch} into ${c.target} at ${short(c.commit)}, ${issuesWords(c.findings.length)}`;

/** The reviewed commit is gone: the file opens on the branch as it is now. */
export const TIP_GONE_LINE = "The reviewed commit is gone: lines may have moved.";
