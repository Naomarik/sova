// Settings → Extensions' words and small rules, apart from the
// component so a test can read them.
import type { ExtensionAsks, ExtensionRowState } from "../../shared/extension-loader";

export const EXT_INTRO = "On this computer, for every project and chat. Install only what you trust.";
export const EXT_CARDS_NOTE = "New chats can use an extension's cards. Open chats keep the cards they started with. Its page, chips and commands work everywhere right away.";
export const EXT_NONE = "No extensions yet. Add one by choosing its folder.";
export const EXT_LOAD_FAILED = "Couldn't read the extension list.";
export const EXT_PICK_TITLE = "Choose the extension's folder";
export const EXT_PICK_HINT = "Folders on the computer Sova runs on";
export const EXT_CHANGED_LEAD = "This extension changed, so it needs your approval again.";
export const EXT_PAGE_LINE = "Runs on Sova's own address and can do what you can, including adding other extensions.";
export const EXT_KEY_LINE = "Opens nearly all of Sova. Its calls are recorded under its name.";
export const EXT_NO_MANAGER = "If it stops while Sova isn't running, it comes back when Sova starts, not by itself at login.";
export const EXT_TRUST = "Install only what you trust.";
export const EXT_APPROVE_CHANGED = "This extension changed since you looked. Check what it asks for, then approve it again.";

export const STATE_WORD: Record<ExtensionRowState, string> = {
  "not-usable": "Not Usable",
  "folder-not-found": "Folder Not Found",
  "needs-newer": "Needs a Newer Sova",
  waiting: "Waiting for You",
  changed: "Changed",
  off: "Off",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
};

export type ExtTone = "success" | "warn" | "error" | "info" | undefined;
export const stateTone = (s: ExtensionRowState): ExtTone => (s === "running" ? "success" : s === "starting" ? "info" : s === "waiting" || s === "changed" || s === "needs-newer" ? "warn" : s === "off" ? undefined : "error");

export const found = (title: string): string => `Found an extension: ${title}`;
export const runsLine = (program: string[]): string => `${program.join(" ")}, on this computer, as you, with no sandbox.`;
export const rulesLine = (needs: string, has: string): string => `Needs extension rules ${needs}. This Sova has ${has}.`;
export const onToast = (title: string, cards: boolean): string => (cards ? `${title} is on. New chats can use its cards; open chats keep what they started with.` : `${title} is on.`);
export const removeQuestion = (title: string): string => `Remove ${title}? Its program stops and its key stops working. Old cards say it's no longer installed. Your folder stays.`;
export const throughWords = (computer: string): string => `These extensions are on ${computer}. To change them, open Sova on that computer.`;
export const asksCards = (a: ExtensionAsks): boolean => !!a.cards?.length;

/** What the row offers beside its switch, in its order. */
export type RowAction = "review" | "start" | "restart" | "log" | "choose-folder" | "updates" | "remove";
export function rowActions(state: ExtensionRowState, r: { hasProgram?: boolean; ownProgram?: boolean }): RowAction[] {
  const log: RowAction[] = r.hasProgram ? ["log"] : [];
  switch (state) {
    case "not-usable":
      return ["remove"];
    case "folder-not-found":
      return ["choose-folder", "remove"];
    case "needs-newer":
      return ["updates", "remove"];
    case "waiting":
      return ["review", "remove"];
    case "changed":
      return ["review", ...log, "remove"];
    case "off":
      return ["remove"];
    case "stopped":
      return [...(r.hasProgram ? (["start"] as RowAction[]) : []), ...log, "remove"];
    case "starting":
      return [...log, "remove"];
    case "running":
      return [...(r.hasProgram ? (["restart"] as RowAction[]) : []), ...log, "remove"];
  }
}

/** The page's own extension list: this tab's changes refresh it at once, any other page within its poll. */
let refreshList: () => void = () => {};
export const setExtensionListRefresh = (fn: () => void): void => {
  refreshList = fn;
};
export const extensionListChanged = (): void => refreshList();
