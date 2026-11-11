/**
 * Context files and skills a folder's chats may load: the words and counts the new chat's setup card,
 * its composer and the project's Context Files and Skills cards share. Pure, so they're tested once.
 *
 * Two modes, Sova-wide (Settings → General, "Allow context files and skills without asking"):
 * - allowed without asking (the default): everything loads but what is disallowed. Nothing asks, so
 *   rows read Allowed or Disallowed, and only Disallow (and Allow on a disallowed row) is offered.
 * - ask first: an item with no decision waits, off, and a new chat can't send until each is decided.
 */

/** An item's decision as the server reports it. "changed": approved, but its content differs since. */
export type Approval = "approved" | "disallowed" | "waiting" | "changed";
export type ItemKind = "context" | "skill";
/** What a decision can set. "waiting" un-decides: Allow without asking (nothing is recorded as approved then). */
export type Decision = "approved" | "disallowed" | "waiting";

/** One item that can be decided, wherever it's listed. */
export interface Decidable {
  kind: ItemKind;
  key: string;
  approval?: Approval;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 context files and 1 skill", "3 skills", "1 context file". */
export function itemsPhrase(context: number, skills: number): string {
  const parts = [context > 0 ? plural(context, "context file", "context files") : "", skills > 0 ? plural(skills, "skill", "skills") : ""].filter(Boolean);
  return parts.join(" and ");
}

/** The items that wait for a decision, by kind, in their order. Only asking mode waits. */
export function waitingOf<T extends Decidable>(items: readonly T[], asking: boolean): T[] {
  return asking ? items.filter((i) => i.approval === "waiting") : [];
}

/** The new chat's notice over its setup card, or null when nothing waits (or nothing asks). */
export function approveNotice(n: number, folder: "project" | "adhoc"): string | null {
  if (n <= 0) return null;
  return `${n} to approve for this ${folder === "project" ? "project" : "folder"}.`;
}

/** The composer's one line while Send is held for decisions. */
export function holdLine(context: number, skills: number): string {
  const what = itemsPhrase(context, skills) || "the waiting items";
  return `Approve or disallow ${what} to send.`;
}

/** The composer's line while Send waits only for a decision made here to be saved. */
export const SAVING_LINE = "Saving…";

/** A Start from the page into a folder that asks first: its message waits as the new chat's draft. */
export function decideFirstLine(n: number): string {
  return `Its message waits in the composer: decide ${n === 1 ? "1 context file or skill" : `${n} context files and skills`} to send it.`;
}

/** Approve All / Disallow All: every given item set to one decision, in one change. */
export function decideAll(items: readonly Pick<Decidable, "key">[], to: Decision): Record<string, Decision> {
  return Object.fromEntries(items.map((i) => [i.key, to]));
}

/** A row's state word on a project's card. Without asking, an undecided item is simply Allowed. */
export function stateWord(a: Approval, asking: boolean): string {
  if (a === "disallowed") return "Disallowed";
  if (a === "changed") return "Changed";
  if (!asking) return "Allowed";
  return a === "approved" ? "Approved" : "Waiting";
}
export function stateChip(a: Approval, asking: boolean): string {
  if (a === "disallowed") return "chip-error";
  if (a === "changed" || (asking && a === "waiting")) return "chip-warn";
  return "chip-success";
}

/** Which buttons a row offers, in order. A card is the page's, so Allow (re-allowing) is offered there. */
export function rowActions(a: Approval, asking: boolean, where: "card" | "setup"): ("approve" | "reapprove" | "disallow" | "allow")[] {
  if (a === "changed") return ["reapprove", "disallow"];
  // Re-allowing is the project page's (the new chat's own switch still turns it on for that chat).
  if (a === "disallowed") return where === "card" ? [asking ? "approve" : "allow"] : [];
  if (a === "waiting" && asking) return ["approve", "disallow"];
  // Approved, or allowed without asking: it can still be disallowed.
  return where === "card" ? ["disallow"] : [];
}

export const ACTION_WORD = { approve: "Approve", reapprove: "Re-approve", disallow: "Disallow", allow: "Allow" } as const;
/** Approve sets "approved"; Allow (without asking) only lifts the Disallow, back to no decision. */
export const ACTION_DECISION: Record<keyof typeof ACTION_WORD, Decision> = { approve: "approved", reapprove: "approved", disallow: "disallowed", allow: "waiting" };

export const CHANGED_LINE = "Changed since you approved";
export const WAITING_LINE = "Waiting for your decision · off until you approve it";
export const ABOVE_PROJECT = "Above the project";
/** A skill whose folder can't be fully fingerprinted (very large, or holding links or files Sova can't read):
    changes there are caught from the listing only. A quiet note, not a warning. */
export const PARTIAL_FINGERPRINT_LINE = "Not fully checked for changes: the folder is very large, or holds links or files Sova can't read.";

export const APPROVE_ALL = "Approve All";
export const DISALLOW_ALL = "Disallow All";
export const REVIEW = "Review";

/** The setting, its words. */
export const SETTING_LABEL = "Allow context files and skills without asking";
export const SETTING_HINT =
  "On, new chats load every context file and skill a folder offers except the ones you disallow. Off, anything you haven't approved stays off and a new chat waits for you to decide before it sends. Kept on this computer.";
