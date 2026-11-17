/**
 * Context files and skills a folder's chats may load: the words, counts and switch states the new
 * chat's setup card, the project's Context Files and Skills cards and the folder list dialog share.
 * Pure, so they're tested once.
 *
 * Each item is one switch, kept for the folder (a project, or a folder that isn't one): on, new chats
 * load it; off, they don't. A group (a kind on the setup card, a source on a project's card) has one
 * switch too: on when every row is on, off when every row is off, mixed between.
 *
 * Two modes, Sova-wide (Settings → General, "New context files and skills start on"):
 * - new items start on (the default): an item nobody has set is on. Turning a row off disallows it;
 *   turning it back on only lifts that, back to no decision. No row is ever marked.
 * - new items start off (asking): an item nobody has set is off and marked New; turning it on approves
 *   it as it is now. An approved item whose content changed since stays on and is marked Changed, with
 *   Accept Change. Nothing waits for these marks: Send never does.
 */

/** An item's decision as the server reports it. "changed": approved, but its content differs since. */
export type Approval = "approved" | "disallowed" | "waiting" | "changed";
export type ItemKind = "context" | "skill";
/** What a save can set. "waiting" un-decides: back to the Sova-wide default (on, while new items start on). */
export type Decision = "approved" | "disallowed" | "waiting";

/** One item that can be switched, wherever it's listed. */
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

/** Whether an item is on for the folder's new chats. Asking: only what was turned on (a changed item
    stays on). Otherwise everything but what was turned off. */
export function isOn(a: Approval, asking: boolean): boolean {
  if (a === "disallowed") return false;
  if (a === "waiting") return !asking;
  return true;
}

/** The mark under a row's name, drawn only while new items start off. */
export type Mark = "new" | "changed";
export function markOf(a: Approval, asking: boolean): Mark | null {
  if (!asking) return null;
  if (a === "waiting") return "new";
  if (a === "changed") return "changed";
  return null;
}

/** What one switch flip saves. Turning on approves the item as it is now while new items start off,
    and only lifts a Disallow while they start on (nothing is recorded as approved then). */
export const flipTo = (on: boolean, asking: boolean): Decision => (on ? (asking ? "approved" : "waiting") : "disallowed");

/** A group switch: on when every row is on, off when every row is off (or there are none), mixed between. */
export type GroupState = "on" | "off" | "mixed";
export function groupState(items: readonly Pick<Decidable, "approval">[], asking: boolean): GroupState {
  const on = items.filter((i) => isOn(i.approval ?? "approved", asking)).length;
  if (items.length === 0 || on === 0) return "off";
  return on === items.length ? "on" : "mixed";
}
/** The group switch's word beside it. */
export const GROUP_WORD: Record<GroupState, string> = { on: "On", off: "Off", mixed: "Mixed" };

/**
 * A press on a group switch: from off or mixed every row turns on, from on every row turns off. The
 * save names only the rows that change, so a row already on (a changed one included) is left out and
 * its approval is never rewritten: a group flip never accepts a change for you.
 */
export function groupFlip<T extends Decidable>(items: readonly T[], asking: boolean): { on: boolean; rows: T[]; to: Decision } {
  const on = groupState(items, asking) !== "on";
  const rows = items.filter((i) => isOn(i.approval ?? "approved", asking) !== on);
  return { on, rows, to: flipTo(on, asking) };
}

/** Every given item set to one decision, in one change. */
export function decideAll(items: readonly Pick<Decidable, "key">[], to: Decision): Record<string, Decision> {
  return Object.fromEntries(items.map((i) => [i.key, to]));
}

/** The line under a group's heading after its switch was pressed, until the next change in that group. */
export function groupDoneLine(n: number, kind: ItemKind, on: boolean): string {
  return `Turned ${plural(n, kind === "context" ? "context file" : "skill", kind === "context" ? "context files" : "skills")} ${on ? "on" : "off"}.`;
}

/** Where a new chat is kept: its words on the folded System context line, after "N files, M skills on". */
export const newOffPhrase = (n: number): string => `${n} new, off`;
export const changedPhrase = (n: number): string => `${n} changed`;
/** "3 files, 2 skills on": what a new chat would start with. */
export function onPhrase(files: number, skills: number): string {
  return `${plural(files, "file", "files")}, ${plural(skills, "skill", "skills")} on`;
}

/**
 * The New rows a chat's open list showed, settled when its first message goes in: each still New
 * counts as left off and is saved so (Disallow is open to every caller). Rows the person flipped,
 * or that are no longer New, are left out.
 */
export function seenNewToSettle(seen: ReadonlySet<string>, items: readonly Decidable[], asking: boolean): Decidable[] {
  if (!asking) return [];
  return items.filter((i) => seen.has(i.key) && markOf(i.approval ?? "approved", asking) === "new");
}

/** A row's marks and the one button left on any row. */
export const NEW_WORD = "New";
export const CHANGED_LINE = "Changed since you turned it on";
export const ACCEPT_CHANGE = "Accept Change";
export const UNDO = "Undo";
export const ABOVE_PROJECT = "Above the project";
/** A skill whose folder can't be fully fingerprinted (very large, or holding links or files Sova can't read):
    changes there are caught from the listing only. A quiet note, not a warning. */
export const PARTIAL_FINGERPRINT_LINE = "Not fully checked for changes: the folder is very large, or holds links or files Sova can't read.";

/** A project's (or a folder's) card: what its switches decide. */
export function cardLine(what: "context files" | "skills"): string {
  const base = `New chats load the ${what} you turn on. Open chats keep theirs.`;
  return what === "skills" ? `${base} Each figure is the skill's description, the part every chat carries.` : base;
}

/** The composer's line while a flip made here is still being saved (and the new chat rebuilt with it). */
export const SAVING_LINE = "Saving…";

/** A started chat's line for an item its fixed list keeps out, and its one button (the operator's page only). */
export function offInChatLine(file: string, folder: "project" | "folder"): string {
  return `${file} wasn't loaded: it is off for this ${folder}.`;
}
export const TURN_ON = "Turn On";
export const TURNED_ON_LINE = "Turned on. It loads at the agent's next step here.";

/** The Overseer's head button: how many new items its folder keeps off, else the list's name. */
export const overseerButtonWords = (n: number): string => (n > 0 ? newOffPhrase(n) : "Context Files and Skills");

/** The setting, its words (stored as `allowWithoutAsking`). */
export const SETTING_LABEL = "New context files and skills start on";
export const SETTING_HINT =
  "On, a context file or skill you haven't set loads in new chats. Off, it stays off, marked New, until you turn it on. Kept on this computer.";
