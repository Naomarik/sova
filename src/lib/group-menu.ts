// A sidebar group's actions menu (§app.session-list/groups "The actions menu"), as data: the rows
// its name row's ⋯ and a right-click or Shift+F10 on that row both draw (components/Groups.tsx
// GroupMenuBody), and the words of its Delete screen.

import { sessionsWord } from "./archive";
import { EMPTY_GROUP_REASON } from "./group-picker";
import { groupHref } from "./group-route";
import type { MenuRow } from "./menu-row";
import { quoted } from "./session-groups";

/** The menu's name, the ⋯ trigger's: both doors name it the same. */
export const groupMenuLabel = (name: string) => `Group actions · ${name}`;

/** Open workspace, Rename…, Delete group…. `show` swaps the rows for a screen ("rename", "delete"). */
export function groupMenuRows(group: { id: string; name: string }, count: number, show: (screen: "rename" | "delete") => void): MenuRow[] {
  const name = quoted(group.name);
  return [
    // The workspace: every session of this group on screen at once (#/g/<id>).
    { label: "Open workspace", aria: `Open ${name} as a workspace`, title: `Open ${name} as a workspace`, icon: "external", href: groupHref(group.id), disabled: count === 0 ? EMPTY_GROUP_REASON : "" },
    { label: "Rename…", aria: `Rename ${name}`, icon: "pencil", stayOpen: true, run: () => show("rename") },
    { label: "Delete group…", aria: `Delete ${name}`, icon: "close", stayOpen: true, run: () => show("delete") },
  ];
}

/** The Delete screen's question, one sentence, in both its forms: what goes away, then what doesn't. */
export const groupDeleteQuestion = (name: string, count: number) =>
  count === 0 ? `Delete ${quoted(name)}? Nothing is in it.` : `Delete ${quoted(name)}? Its ${sessionsWord(count)} stay${count === 1 ? "s" : ""} in the list.`;

/** What a delete says once it is done. */
export const groupDeletedToast = (name: string, count: number) =>
  count === 0 ? `Deleted ${quoted(name)}. It had no sessions.` : `Deleted ${quoted(name)}. Its ${sessionsWord(count)} ${count === 1 ? "is" : "are"} ungrouped.`;
