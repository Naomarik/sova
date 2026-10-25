import { SHARE_TEXT_MAX } from "../../shared/baton";
/** A conversation host's draft-only action. Never truncates existing words or sends a message. */
export function appendTourDraft(draft: string, question: string, canWrite: boolean): { status: "blocked" | "full" } | { status: "ready"; draft: string } {
  if (!canWrite) return { status: "blocked" };
  const next = `${draft}${draft ? "\n\n" : ""}${question}`;
  return next.length > SHARE_TEXT_MAX ? { status: "full" } : { status: "ready", draft: next };
}

export const TOUR_PREFILL_FAILED = "Couldn't add the question. Try again.";
export const TOUR_PREFILL_NOT_YOUR_TURN = "It's no longer your turn, so the question wasn't added.";
export const TOUR_DRAFT_FULL = "Your draft is full. Make room before adding a tour question.";
export type TourPrefillOutcome = { status: "ready"; draft: string } | { status: "full" } | { status: "failed"; reason: "recheck" | "turn" };
export interface TourPrefillDeps {
  /** The page's current view says this reader may write now. */
  canWrite(): boolean;
  /** Re-reads the conversation (and applies it); null when that failed. */
  recheck(): Promise<{ canWrite: boolean } | null>;
  /** The draft as it is now: read after the re-check, so text typed meanwhile is kept. */
  draft(): string;
}
/** Ask About This Step / Request More Coverage: never a silent no-op, never a change to the draft on failure. */
export async function prefillTourDraft(question: string, deps: TourPrefillDeps): Promise<TourPrefillOutcome> {
  if (!deps.canWrite()) return { status: "failed", reason: "turn" };
  const latest = await deps.recheck().catch(() => null);
  if (!latest) return { status: "failed", reason: "recheck" };
  if (!latest.canWrite || !deps.canWrite()) return { status: "failed", reason: "turn" };
  const next = appendTourDraft(deps.draft(), question, true);
  return next.status === "ready" ? next : { status: "full" };
}
/** The composer's error line for an outcome that added nothing; null when the question was added. */
export function tourPrefillMessage(outcome: TourPrefillOutcome): string | null {
  if (outcome.status === "ready") return null;
  if (outcome.status === "full") return TOUR_DRAFT_FULL;
  return outcome.reason === "turn" ? TOUR_PREFILL_NOT_YOUR_TURN : TOUR_PREFILL_FAILED;
}
/** Every line prefillTourDraft's outcomes can leave in the composer (cleared once a question is added). */
export const TOUR_PREFILL_LINES: readonly string[] = [TOUR_PREFILL_FAILED, TOUR_PREFILL_NOT_YOUR_TURN, TOUR_DRAFT_FULL];
