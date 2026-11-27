// An entry that waits for the user, as every place that answers it reads it: the Needs you row, the run page's decision
// block and the sidebar's landing bar. One table of the answers it offers (a decision's own, else the state's from
// before decisions), the confirm the bar asks before it acts, and the words once an answer went through, read from the
// entry the queue answered with (a Land may leave it waiting for a fix, not in line). Pure: no Solid, no DOM.
import { entryStateWords, ordinal, WAITING_FOR_USER, type MergeEntry } from "../../shared/merge-queue";
import { isRequestState } from "./merge-queue-requests";
import { DECISION_ACTION_LABEL, DECISION_LABEL, decisionActions, openDecision, type DecisionAction } from "./merge-standing";

const short = (sha: string): string => sha.slice(0, 7);
const stripDot = (s: string): string => s.trim().replace(/[.\s]+$/, "");

/** The entry facts the answers read. */
export type AnswerFacts = Pick<MergeEntry, "state"> & Partial<Pick<MergeEntry, "decision" | "conflict" | "waitingRuling">>;

/** Does it wait for the user's answer now? A decision open, or a state that waits for them from before decisions; never
 *  while the merge thread is still ruling on whose failure it is, and never review findings (back with the chat). */
export const waitsForYou = (e: AnswerFacts): boolean => !e.waitingRuling && (!!openDecision(e) || (WAITING_FOR_USER.includes(e.state) && e.state !== "review-flagged"));

/** Answered with the queue's answer buttons (the Needs you row's decision block); a request waiting for your look has
 *  its own row (Publish). */
export const answersHere = (e: AnswerFacts): boolean => waitsForYou(e) && !isRequestState(e.state);

/** The answers an entry offers, in order, Remove from Queue last and once: the decision's, else its state's own. The
 *  Needs you row, the run page and the landing bar all read this one list. */
export function entryAnswers(e: AnswerFacts): DecisionAction[] {
  // The merge thread rules on whose failure it is first: nothing to answer yet.
  if (e.waitingRuling) return ["remove"];
  const d = openDecision(e);
  if (d) return decisionActions(d);
  switch (e.state) {
    case "behaviour-differs":
      // Accept only when the merge thread proposed a resolution; otherwise it is answered in the chat.
      return e.conflict?.proposal ? ["accept", "remove"] : ["remove"];
    case "unattributed":
      return ["land-anyway", "try-again", "remove"];
    case "drafts-changed":
      return ["land", "remove"];
    default:
      return ["remove"];
  }
}

/** Where the landing bar answers: in place, after one confirm, for every answer it offers. Remove from Queue stays on the
 *  Needs you row and the run page. A Record over every answer, so a new one is decided here before it compiles. */
export const BAR_ANSWERS: Record<DecisionAction, boolean> = {
  accept: true,
  "land-anyway": true,
  "try-again": true,
  land: true,
  allow: true,
  "send-back": true,
  "ask-thread": true,
  remove: false,
};

/** The title a waiting entry is known by: the decision's own words ("A fix needs your OK"), else its state's. */
export const waitingTitle = (e: AnswerFacts & Pick<MergeEntry, "position">): string => {
  const d = openDecision(e);
  return d ? DECISION_LABEL[d.kind] : stripDot(entryStateWords(e));
};

/** A button's full name: "Land feat/x", "Accept the resolution for feat/x". */
export function answerAria(a: DecisionAction, branch: string): string {
  switch (a) {
    case "accept":
      return `Accept the resolution for ${branch}`;
    case "land-anyway":
      return `Land ${branch} anyway`;
    case "try-again":
      return `Try ${branch} again`;
    case "land":
      return `Land ${branch}`;
    case "remove":
      return `Remove ${branch} from the merge queue`;
    case "allow":
      return `Allow the names found in ${branch}`;
    case "send-back":
      return `Send ${branch} back to its chat`;
    case "ask-thread":
      return `Ask the merge thread about ${branch}`;
  }
}

/** The bar's one confirm before an answer acts: what it does, then the answer's own word on the button. */
export function answerConfirm(a: DecisionAction, e: AnswerFacts & Pick<MergeEntry, "branch" | "commit"> & Partial<Pick<MergeEntry, "requests">>, target: string): { title: string; line: string; confirm: string } {
  const b = e.branch;
  const at = short(e.commit);
  const d = openDecision(e);
  const confirm = DECISION_ACTION_LABEL[a];
  switch (a) {
    case "land": {
      if (d?.kind === "out-of-tries") return { title: `Land ${b} again?`, line: "A new Land at its newest commit, with new tries. It goes in line once nothing blocks it.", confirm };
      // A fix that needs your OK goes in at the fix's commit; drafts changed, re-pinned as they are now.
      const fixed = [...(e.requests ?? [])].reverse().find((r) => r.answer?.kind === "fixed")?.answer;
      const sha = fixed?.kind === "fixed" && fixed.commit ? short(fixed.commit) : at;
      if (d?.kind === "drafts-changed" || (!d && e.state === "drafts-changed")) return { title: `Land ${b} at ${sha}?`, line: "Its spec drafts are approved as they are now. It goes in line once nothing blocks it.", confirm };
      return { title: `Land ${b} at ${sha}?`, line: `It goes in line once nothing blocks it; ${target} moves once checks pass.`, confirm };
    }
    case "land-anyway":
      return { title: `Land ${b} anyway at ${at}?`, line: `A check failed on ${target} alone too, so nobody is blamed. ${target} moves once the landing's checks pass.`, confirm };
    case "try-again":
      return { title: `Check ${b} again at ${at}?`, line: "It goes to the front of the line and every check runs afresh. No try is counted.", confirm };
    case "accept":
      return { title: `Accept the resolution for ${b}?`, line: `The merge thread's resolution goes in with it, and it goes to the front of the line.`, confirm };
    case "allow":
      return { title: `Allow the names found in ${b}?`, line: "They're marked fine for this project, and the push goes on.", confirm };
    case "send-back":
      return { title: `Send ${b} back to its chat?`, line: "Its chat removes the names. Nothing is pushed meanwhile.", confirm };
    case "ask-thread":
      return { title: `Ask the merge thread about ${b}?`, line: "The merge thread gets the places the names were found. Nothing is pushed meanwhile.", confirm };
    case "remove":
      return { title: `Remove ${b} from the merge queue?`, line: "Its branch, folder, commits and drafts stay.", confirm };
  }
}

/** Where the entry stands now, in a few words: "2nd in line", "waiting for a fix: …", "back with its chat"; "in line" when
 *  the answer names no place (true of a first Land and of one back in line alike). */
export function standsNow(after: Pick<MergeEntry, "state"> & Partial<Pick<MergeEntry, "position" | "standing" | "reason">>): string {
  switch (after.state) {
    case "queued":
      return after.position === 1 ? "next in line" : after.position ? `${ordinal(after.position)} in line` : "in line";
    case "checking":
      return "checking now";
    case "landed":
      return "landed";
    case "with-chat": {
      const s = after.standing;
      if (s?.phase === "waiting-fix") return `waiting for a fix${s.why || after.reason ? `: ${stripDot(s.why || after.reason || "")}` : ""}`;
      if (s?.phase === "dry-run") return "its dry run runs first";
      return "back with its chat";
    }
  }
  const w = stripDot(entryStateWords(after as Pick<MergeEntry, "state" | "position">));
  return w.charAt(0).toLowerCase() + w.slice(1);
}

/** The words once an answer went through, from the entry the queue answered with: a Land back in line reads "Queued
 *  feat/x · 2nd in line"; one its chat must fix first, "Approved feat/x · waiting for a fix: …". No entry: the answer
 *  alone. */
export function answerDone(a: DecisionAction, branch: string, after?: (Pick<MergeEntry, "state"> & Partial<Pick<MergeEntry, "position" | "standing" | "reason">>) | null): string {
  if (a === "remove") return `Removed ${branch} from the merge queue.`;
  if (a === "allow") return "Marked fine for this project. The push goes on.";
  if (a === "send-back") return "Sent back: its chat removes them.";
  if (a === "ask-thread") return "The merge thread has the places. Open it to see the names.";
  const lead = a === "accept" ? `Accepted the resolution for ${branch}` : a === "land-anyway" ? `Landing ${branch} anyway` : a === "try-again" ? `Checking ${branch} again` : after && after.state !== "queued" ? `Approved ${branch}` : `Queued ${branch}`;
  if (!after) return `${lead}.`;
  const now = standsNow(after);
  // "Checking feat/x again now.", never "Checking feat/x again · checking now."
  return a === "try-again" && now === "checking now" ? `${lead} now.` : `${lead} · ${now}.`;
}

/** What became of a run's entry since, in one sentence for its run page: "It waits for your answer below.", "Now 2nd in
 *  line.", "Now waiting for a fix: …". Empty when the queue no longer lists it. */
export function nowWords(e: (AnswerFacts & Partial<Pick<MergeEntry, "position" | "standing" | "reason">>) | null | undefined): string {
  if (!e) return "";
  if (answersHere(e)) return "It waits for your answer below.";
  if (e.state === "cancelled") return "It was taken off the queue since.";
  return `Now ${standsNow(e)}.`;
}

/** A plain Land's words (no decision), from the entry merge.add answered with; `how` the Land's option words. */
export function landDone(branch: string, after: (Pick<MergeEntry, "state"> & Partial<Pick<MergeEntry, "position" | "standing" | "reason">>) | null | undefined, how = ""): string {
  const lead = `${after && after.state !== "queued" ? "Approved" : "Queued"} ${branch}${how}`;
  return after ? `${lead} · ${standsNow(after)}.` : `${lead}.`;
}
