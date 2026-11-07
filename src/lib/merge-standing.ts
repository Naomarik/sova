// A standing approval as every screen draws it (al_3): the user's one Land stands while the merge queue, its merge
// thread and the branch's chat fix what blocks it. Its in-place words ("Back with the chat · try 2 of 3 · Unit tests
// failed", "Waiting for the merge thread", "Paused: you stopped the chat", "Approved · waiting for a fix"), the chat's
// answer ("Fixed: commit a1b2c3d"), and a decision that waits for the user (its question, its choices that fill the
// message box, the queue's held note "not sent yet", and the answers that act at once). Pure words: no Solid, no DOM.
import type { MergeChatAnswer, MergeDecision, MergeDecisionAction, MergeStanding } from "../../shared/merge-queue";

const short = (sha: string): string => sha.slice(0, 7);

/** One decision that waits for the user (§chat.merge-queue/decision): the queue's own shape. */
export type CardDecision = MergeDecision;
export type DecisionAction = MergeDecisionAction;

/** What a card, a row or the landing bar reads: an entry or card with the al_3 facts it may carry. */
export interface StandingFacts {
  state: string;
  standing?: MergeStanding | null;
  decision?: CardDecision | null;
}

export type StandingTone = "info" | "warn" | "neutral" | "error";

/** The decision that waits for the user now, or null (none, or already answered). */
export const openDecision = (f: Partial<Pick<StandingFacts, "decision">>): CardDecision | null => (f.decision && !f.decision.answered ? f.decision : null);

/** A decision's chip word, by its kind (the copy deck's state chips). */
export const DECISION_LABEL: Record<CardDecision["kind"], string> = {
  "behaviour-differs": "Behaviour differs",
  "needs-you": "Needs you",
  unattributed: "Can't tell whose failure",
  "out-of-tries": "Out of tries",
  "fix-ok": "A fix needs your OK",
  "drafts-changed": "Drafts changed",
};

export const DECISION_ACTION_LABEL: Record<DecisionAction, string> = {
  accept: "Accept",
  "land-anyway": "Land Anyway",
  "try-again": "Try Again",
  land: "Land",
  remove: "Remove from Queue",
};

/** A decision's answers on the queue, in order, Remove from Queue always last and once. */
export const decisionActions = (d: Pick<CardDecision, "actions">): DecisionAction[] => [...new Set(d.actions.filter((a) => a !== "remove")), "remove"];

/** The chat's answer in one line: "Fixed: commit a1b2c3d", "Fixed: drafts", "Fixed: commit a1b2c3d and drafts",
 *  "Needs you: …", "Can't: …". */
export function answerWords(a: MergeChatAnswer | undefined | null): string | null {
  if (!a) return null;
  switch (a.kind) {
    case "fixed": {
      const commit = a.commit ? `commit ${short(a.commit)}` : null;
      const drafts = a.changed === "drafts" || a.changed === "both" || a.drafts ? "drafts" : null;
      const what = [commit, drafts].filter(Boolean).join(" and ") || (a.changed === "commit" ? "a commit" : "drafts");
      return `Fixed: ${what}`;
    }
    case "needs-you":
      return `Needs you: ${a.question}`;
    case "cant":
      return `Can't: ${a.why}`;
  }
  return null;
}

/** The line every with-its-chat row adds: the user's Land stands. */
export const STANDING_LINE = "Your Land stands: it goes back in line by itself once its chat's fix is checked.";

/** A standing approval's chip and its in-place line, or null when the entry isn't with its chat (it reads by its
 *  plain state then). "Back with the chat" with "try 2 of 3 · Unit tests failed"; checked: "Fix checked · back in line". */
export function standingWords(f: StandingFacts): { label: string; tone: StandingTone; detail?: string; answer?: string } | null {
  const s = f.standing;
  if (!s) return f.state === "with-chat" ? { label: "Back with the chat", tone: "info" } : null;
  switch (s.phase) {
    case "waiting-fix":
      return { label: "Approved · waiting for a fix", tone: "info", detail: s.why || undefined };
    case "with-chat": {
      const answer = answerWords(s.answer) ?? undefined;
      if (s.checked) return { label: "Back with the chat", tone: "info", detail: "Fix checked · back in line", answer };
      return { label: "Back with the chat", tone: "info", detail: [`try ${s.try} of ${s.of}`, s.why].filter(Boolean).join(" · "), answer };
    }
    case "waiting-thread":
      return { label: "Waiting for the merge thread", tone: "info", answer: answerWords(s.answer) ?? undefined };
    case "waiting-run":
      return { label: "Back with the chat", tone: "info", detail: "Fix waits for the run checking now", answer: answerWords(s.answer) ?? undefined };
    case "paused":
      return { label: "Paused: you stopped the chat", tone: "neutral" };
  }
  return null;
}

/** The whole state in one line, as the card's pill and a row's chip read: "Back with the chat · try 2 of 3 · Unit
 *  tests failed". */
export function standingLine(f: StandingFacts): string | null {
  const w = standingWords(f);
  return w ? [w.label, w.detail].filter(Boolean).join(" · ") : null;
}

/** A decision's chip and its why, or null when none waits. */
export function decisionWords(f: Partial<Pick<StandingFacts, "decision">>): { label: string; tone: "warn"; question: string; cantSettle: boolean } | null {
  const d = openDecision(f);
  if (!d) return null;
  return { label: DECISION_LABEL[d.kind] ?? "Needs you", tone: "warn", question: d.question, cantSettle: !!d.cantSettle };
}

/** Under a held note: the user's own answer goes with it. */
export const HELD_NOTE_LINE = "Not sent yet: your answer goes with it";

/** The composer's line while a decision's note is held (§chat.merge-queue/decision). */
export const heldComposerLine = (branch: string): string => `Merge queue · ${branch} · not sent yet: your answer goes with it`;

/** The merge thread's own chat, while its question waits on the user there (§chat.merge-queue/asks). */
export const heldAskLine = (question: string): string => `Merge thread asks: ${question.trim()} · not sent yet: your answer goes with it`;

/** A decision answered in words (it has choices or a held note): answered in the chat's message box. */
export const answeredInChat = (d: Pick<CardDecision, "choices" | "heldNote" | "kind">): boolean => !!d.heldNote || d.choices.length > 0 || d.kind === "needs-you" || d.kind === "behaviour-differs" || d.kind === "fix-ok";
