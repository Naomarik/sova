// The merge queue's card in the chat that built a branch (shared/merge-queue.ts MergeCard): one card per
// branch from Land onward. It updates in place while queued and checking; each outcome is a new revision
// at the bottom, and earlier copies fold to one line. Pure words: no Solid, no DOM.
import type { MergeCard, MergeCardRevision } from "../../shared/merge-queue";
import { newerWords, ordinal } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { mins, notesOf, sentence, short } from "./merge-queue";
import { isRequestState, requestChip } from "./merge-queue-requests";

/** The built-in card type the rows carry: drawn by Sova, never a project's or an extension's. */
export const MERGE_QUEUE_CARD = "sova.merge-queue";

/** The card as the thread draws it: the queue's own. */
export type QueueCard = MergeCard;

/** One row's data: the card as it is now, and the revision this row is. */
export interface QueueCardRow {
  card: QueueCard;
  revision: MergeCardRevision;
}

export type CardTone = "success" | "warn" | "error" | "info" | "accent" | "neutral";

/** The pill, from a state and place in line; a request's from its host facts when the card has them. */
export function cardPill(d: Pick<MergeCardRevision, "state" | "position"> & Partial<Pick<MergeCard, "request" | "reason" | "removed">> & { kind?: MergeCardRevision["kind"] }): { label: string; tone: CardTone; live?: boolean } {
  if (isRequestState(d.state)) return requestChip(d.state, d.request, d.reason);
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
      return { label: "Can't tell whose failure", tone: "warn" };
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

/** "1 newer commit not included", on a landed card (Land Again beside it). */
export const cardNewer = (c: Pick<MergeCard, "state" | "newerCommits">): string | null => (c.state === "landed" ? newerWords(c.newerCommits) : null);

export const cardNotes = (c: Pick<MergeCard, "notes">) => notesOf(c.notes);

/** What the card offers, by state. Every one is a merge verb; none writes into the chat. Needs a fix: Land This Commit
 *  Again (a new approval of the same commit, every check from the start) and Remove from Queue; once its drafts are
 *  fixed (`redrafted`), Land at the same commit in place of the first. Drafts changed: Land (approves the drafts as
 *  they are now). */
export type CardAction = "cancel" | "accept" | "land-anyway" | "send-back" | "land-again" | "land" | "land-this-again" | "remove";
export function cardActions(c: Pick<MergeCard, "state" | "newerCommits"> & Partial<Pick<MergeCard, "redrafted">>): CardAction[] {
  switch (c.state) {
    case "queued":
      return ["cancel"];
    case "needs-fix":
      return [c.redrafted ? "land" : "land-this-again", "remove"];
    case "drafts-changed":
      return ["land"];
    case "behaviour-differs":
      return ["accept", "send-back"];
    case "review-flagged":
    case "unattributed":
      return ["land-anyway", "send-back"];
    case "landed":
      return c.newerCommits ? ["land-again"] : [];
    default:
      return [];
  }
}

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
