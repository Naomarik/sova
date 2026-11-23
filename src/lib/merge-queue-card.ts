// The merge queue's card in the chat that built a branch (shared/merge-queue.ts MergeCard): one card per
// branch from Land onward. It updates in place while queued and checking; each outcome is a new revision
// at the bottom, and earlier copies fold to one line. Pure words: no Solid, no DOM.
import type { MergeAnswer, MergeCard, MergeCardRevision, ReviewFinding } from "../../shared/merge-queue";
import type { TopicBatchInfo } from "../../shared/topic-message";
import { branchInPlace, type BranchPlaceRow } from "./branch-place";
import { reviewFoundWords } from "./merge-review-card";
import { newerWords, ordinal } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { mins, notesOf, sentence, short } from "./merge-queue";
import { isRequestState, requestChip } from "./merge-queue-requests";
import { DECISION_ACTION_LABEL, decisionActions, decisionWords, openDecision, standingWords, type CardDecision, type DecisionAction, type StandingFacts } from "./merge-standing";

/** The al_3 facts a card may carry (shared/merge-queue.ts MergeCard gains them): where the standing approval stands,
 *  a decision that waits for the user, and the fixes that landed with the user's Land. */
export type CardAutomation = Partial<Pick<StandingFacts, "standing" | "decision">> & { fixesLanded?: { sha: string; subject: string }[] };

/** The built-in card type the rows carry: drawn by Sova, never a project's or an extension's. */
export const MERGE_QUEUE_CARD = "sova.merge-queue";

/** The card as the thread draws it: the queue's own. */
export type QueueCard = MergeCard & CardAutomation;

/** One row's data: the card as it is now, and the revision this row is. */
export interface QueueCardRow {
  card: QueueCard;
  revision: MergeCardRevision;
}

export type CardTone = "success" | "warn" | "error" | "info" | "accent" | "neutral";

/** The card as a branch row its place line reads (§chat.worktrees/place). The card's own target is the clause, so it
 *  can never disagree with its "{branch} into {target}"; a card written before the line has no place and draws none. */
export function cardPlaceRow(d: Pick<MergeCard, "state" | "target" | "worktree" | "place" | "request">): BranchPlaceRow {
  return {
    ...(d.worktree ? { path: d.worktree } : {}),
    queue: { state: d.state, target: d.target, ...(d.request ? { request: d.request } : {}) },
    ...(d.place ? { place: { ...d.place, target: d.target } } : {}),
  };
}

/** The pill, from a state and place in line; a request's from its host facts when the card has them. */
export function cardPill(d: Pick<MergeCardRevision, "state" | "position"> & Partial<Pick<MergeCard, "request" | "reason" | "removed" | "waitingRuling">> & CardAutomation & { kind?: MergeCardRevision["kind"] }): { label: string; tone: CardTone; live?: boolean } {
  if (isRequestState(d.state)) return requestChip(d.state, d.request, d.reason);
  // A decision that waits for the user names it; a standing approval with its chat reads where it stands.
  const dec = d.state === "landed" || d.state === "cancelled" ? null : decisionWords(d);
  if (dec) return { label: dec.label, tone: dec.tone };
  const st = d.state === "landed" || d.state === "cancelled" ? null : standingWords(d);
  if (st) return { label: st.label, tone: st.tone };
  switch (d.state) {
    case "queued":
      return { label: d.position ? `Queued · ${ordinal(d.position)}` : "Queued", tone: "info" };
    case "checking":
      return { label: "Checking", tone: "accent", live: true };
    case "conflict":
      return { label: "Conflict", tone: "warn" };
    case "behaviour-differs":
      return { label: "Behaviour differs", tone: "warn" };
    case "review-flagged":
      return { label: "Review flagged", tone: "warn" };
    case "unattributed":
      // The merge thread rules on whose failure it is first: nothing asks you yet.
      return d.waitingRuling ? { label: "Waiting for the merge thread", tone: "info" } : { label: "Can't tell whose failure", tone: "warn" };
    case "drafts-changed":
      return { label: "Drafts changed", tone: "warn" };
    case "needs-fix":
      return { label: "Needs a fix", tone: "error" };
    case "landed":
      return { label: "Landed", tone: "success" };
    case "cancelled":
      // Remove from Queue: the card's last revision says so (the card, by its `removed`; a revision, by its kind).
      return d.removed || d.kind === "removed" ? { label: "Removed", tone: "neutral" } : { label: "Cancelled", tone: "neutral" };
  }
  return { label: "Unknown", tone: "neutral" };
}

/** The facts after the head: "8 commits", "+970 −45", then the estimate or "Checking · 4 of 7 steps". */
export function cardFacts(c: QueueCard): { text: string; lines?: { added: number; removed: number } }[] {
  const out: { text: string; lines?: { added: number; removed: number } }[] = [];
  if (c.stats) {
    out.push({ text: `${c.stats.commits} ${c.stats.commits === 1 ? "commit" : "commits"}` });
    out.push({ text: `+${c.stats.added} −${c.stats.removed}`, lines: { added: c.stats.added, removed: c.stats.removed } });
  }
  if (c.state === "queued" && c.eta) out.push({ text: `starts in ~${mins(c.eta.startsInMs)} · takes ~${mins(c.eta.takesMs)}` });
  if (c.state === "checking" && c.progress) out.push({ text: `Checking · ${c.progress.done} of ${c.progress.total} steps` });
  return out;
}

/** The sha in the head: what landed, else the approved commit. */
export const cardSha = (c: Pick<MergeCard, "landed" | "commit">): string => short(c.landed?.sha ?? c.commit);

/** "Not pushed: why." on a landed card that wasn't pushed. */
export function notPushed(c: Pick<MergeCard, "state" | "landed">): string | null {
  const l = c.landed;
  // The host merged it: nothing of Sova's was to push.
  if (c.state !== "landed" || !l || l.pushed === "pushed" || l.via === "host") return null;
  // The why may already say it ("not pushed: …", "push held: …"): said once, never "Not pushed: Push held: …".
  const why = (l.pushWhy ?? "").trim().replace(/^not pushed\s*[:,-]?\s*/i, "");
  if (!why) return "Not pushed: this project doesn't push from the queue.";
  if (/^push(ed)?\b/i.test(why)) return sentence(why);
  const tail = why.charAt(0).toLowerCase() + why.slice(1);
  return `Not pushed: ${/[.!?…]$/.test(tail) ? tail : `${tail}.`}`;
}

/** "1 newer commit not included", on a landed card (Land Again beside it). Nowhere else: while the chat fixes it,
 *  the user's Land stands and carries its checked fixes. */
export function cardNewer(c: Pick<MergeCard, "state" | "newerCommits">): string | null {
  return c.state === "landed" ? newerWords(c.newerCommits) : null;
}

/** A card action's button word; an action with no word reads as its id, never blank. */
export const cardActionLabel = (a: CardAction): string => CARD_ACTION_LABEL[a] || a;

/** Every action a card can offer has its word: a decision's are the queue's own (Allow, Send Back, Ask the Merge Thread…). */
export const CARD_ACTION_LABEL: Record<CardAction, string> = {
  ...DECISION_ACTION_LABEL,
  cancel: "Cancel",
  "land-again": "Land Again",
};

/** Where a click on a card action goes: Remove from Queue to merge.cancel; a decision's answers (Allow, Send Back and Ask
 *  the Merge Thread included) to merge.answer; merge.add only for a Land with no decision (the commit it was approved
 *  at) and Land Again (the branch's head). Anything else is refused and does nothing: never a Land. */
export type CardRoute = { verb: "cancel" } | { verb: "answer"; answer: MergeAnswer } | { verb: "land"; commit: "approved" | "head" } | { verb: "none"; why: string };
export function cardActionRoute(a: string, decided: boolean): CardRoute {
  switch (a) {
    case "cancel":
    case "remove":
      return { verb: "cancel" };
    case "accept":
    case "land-anyway":
    case "try-again":
    case "allow":
    case "send-back":
    case "ask-thread":
      return { verb: "answer", answer: a };
    case "land":
      // A decision's Land is answered on the queue: out of tries, a new standing approval at the branch's newest commit;
      // a fix that needs your OK, back in line; drafts changed, re-pinned as they are.
      return decided ? { verb: "answer", answer: "land" } : { verb: "land", commit: "approved" };
    case "land-again":
      return { verb: "land", commit: "head" };
  }
  return { verb: "none", why: `This card can't do "${a}": nothing was sent.` };
}

/** The words once an action went through. The private names' answers say what follows, as the run's step says them. */
export function cardActionDone(a: CardAction, branch: string): string {
  if (a === "allow") return "Marked fine for this project. The push goes on.";
  if (a === "send-back") return "Sent back: its chat removes them.";
  if (a === "ask-thread") return "The merge thread has the places. Open it to see the names.";
  return `${cardActionLabel(a)}: ${branch}.`;
}

/** The card's notes. A review's notes listed in full (the Landed card's folded "Review: {summary}") aren't repeated as
 *  the one-line "Review" note. */
export const cardNotes = (c: Pick<MergeCard, "notes"> & Partial<Pick<MergeCard, "review">>) => {
  const notes = notesOf(c.notes);
  return reviewNotes(c) ? notes.filter((n) => n.label !== "Review") : notes;
};

/** A Landed card's review notes, listed in full: "Review: {summary}" and its findings; null when there are none. */
export function reviewNotes(c: Partial<Pick<MergeCard, "review" | "state">>): { summary: string; findings: ReviewFinding[] } | null {
  const r = c.review;
  if (c.state !== "landed" || !r || r.verdict !== "notes" || !r.findings?.length) return null;
  return { summary: r.summary ?? "", findings: r.findings };
}

/** A blocking review's pointer on the card: "Review found 3 issues", with the try it was ("try 1 of 3"), or null. The
 *  card then shows no reason line and no Review failing check: the review card holds them. */
export function reviewPointer(c: Partial<Pick<MergeCard, "reviewFound" | "state">> & CardAutomation): { tries: string | null; words: string; id: string; session: string; path?: string } | null {
  const p = c.reviewFound;
  if (!p || c.state === "landed" || c.state === "cancelled") return null;
  const s = c.standing;
  const tries = s?.phase === "with-chat" && !s.checked && s.try > 0 ? `try ${s.try} of ${s.of}` : null;
  return { tries, words: reviewFoundWords(p.count), id: p.card, session: p.session, ...(p.path ? { path: p.path } : {}) };
}

/** What the card offers. Every one is a merge verb; none writes into the chat. No re-land and no Send Back of a
 *  failure: the user's one Land stands while the queue, the merge thread and the chat fix what blocks it (al_3). Remove
 *  from Queue at every stage of an approval that stands; a decision's own answers (Accept, Land Anyway, Try Again, Land;
 *  the scan's private names: Allow, Send Back, Ask the Merge Thread) only on a decision; Land Again only on a Landed
 *  card for work after landing. */
export type CardAction = DecisionAction | "cancel" | "land-again";
export function cardActions(c: Pick<MergeCard, "state" | "newerCommits"> & Partial<Pick<MergeCard, "settled" | "conflict" | "waitingRuling">> & CardAutomation): CardAction[] {
  // The server counts only real commits past the landing: a catch-up merge is none. Settled: its head is gone or a
  // later entry carries it.
  if (c.state === "landed") return c.newerCommits && !c.settled ? ["land-again"] : [];
  if (c.state === "cancelled" || isRequestState(c.state)) return [];
  const d = openDecision(c);
  if (d) return decisionActions(d);
  switch (c.state) {
    case "queued":
      // One name everywhere: Remove from Queue (merge.cancel) takes it off the line.
      return ["remove"];
    case "needs-fix":
      // Settled (superseded, already in the target, its branch or folder gone): nothing is left to remove.
      return c.settled ? [] : ["remove"];
    case "drafts-changed":
      return ["land", "remove"];
    case "behaviour-differs":
      // Accept only when the merge thread proposed a resolution; otherwise it is answered in the chat.
      return c.conflict?.proposal ? ["accept", "remove"] : ["remove"];
    case "unattributed":
      return c.waitingRuling ? ["remove"] : ["land-anyway", "try-again", "remove"];
    default:
      // Checking, a conflict being judged, review findings back with the chat, with its chat, waiting for a fix.
      return ["remove"];
  }
}

/** The decision a card waits on, or null. */
export const cardDecision = (c: CardAutomation): CardDecision | null => openDecision(c);

/** A folded earlier copy's one line, from its own frozen state: "feat/x · Queued 2nd". */
export const foldedLine = (branch: string, r: Pick<MergeCardRevision, "state" | "position"> & Partial<Pick<MergeCardRevision, "kind">>): string => `${branch} · ${isRequestState(r.state) ? FROZEN_REQUEST[r.state] : cardPill(r).label.replace(" · ", " ")}`;
/** A request revision's own frozen word: the host facts it was raised at aren't kept on the revision. */
const FROZEN_REQUEST = { "request-review": "Request ready for your look", requested: "Request opened", pushed: "Pushed", closed: "Closed on the host" } as const;

/** The card's accessible name. */
export const cardLabel = (c: QueueCard): string => `${cardPill(c).label}: ${c.branch} into ${c.target} at ${cardSha(c)}`;

/** The newest revision is the card itself; the others fold. */
export const isNewest = (row: QueueCardRow): boolean => row.card.revisions[row.card.revisions.length - 1]?.id === row.revision.id;

/** One chat's cards as the thread's outside-card rows: one per revision, keyed by the entry, placed where it was raised. */
export function queueCardRows(cards: readonly QueueCard[]): CardInfo[] {
  return cards.flatMap((c) =>
    c.revisions.map(
      (r, i): CardInfo => ({
        id: `mq:${r.id}`,
        type: MERGE_QUEUE_CARD,
        title: c.branch,
        draws: "status",
        answerMode: "none",
        placement: "follow",
        key: c.id,
        revision: i + 1,
        data: { card: c, revision: r } satisfies QueueCardRow,
        at: r.at,
        by: { kind: "script" },
        ...(r.after !== undefined ? { after: r.after } : {}),
        state: i === c.revisions.length - 1 ? "open" : "superseded",
      }),
    ),
  );
}

/** A row's data, or null when it isn't a queue card's. */
export function queueRowOf(card: Pick<CardInfo, "type" | "data">): QueueCardRow | null {
  if (card.type !== MERGE_QUEUE_CARD) return null;
  const d = card.data as Partial<QueueCardRow> | null;
  return d && d.card && d.revision && typeof d.card.branch === "string" && Array.isArray(d.card.revisions) ? (d as QueueCardRow) : null;
}

/** The merge queue's batch (§chat.merge-queue/requests, §chat.topics/row): "Merge queue · {branch} in {place} ·
    {n} requests" ("· {k} branches ·" when several), a branch icon, never a link to a session; open,
    each request with its id, its branch in its place and its text. */
export function mergeQueueBatchLabel(batch: TopicBatchInfo): string {
  const n = batch.notes.length;
  const branches = [...new Set(batch.notes.map((it) => it.request?.branch).filter((b): b is string => !!b))];
  const place = batch.notes.find((it) => it.request?.branch === branches[0] && it.request?.place)?.request?.place;
  const about = branches.length === 1 ? branchInPlace(branches[0]!, place) : branches.length > 1 ? `${branches.length} branches` : null;
  return ["Merge queue", ...(about ? [about] : []), `${n} ${n === 1 ? "request" : "requests"}`].join(" · ");
}
