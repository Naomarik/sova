// A sidebar group's actions menu (§app.session-list/groups "The actions menu"), as one declaration
// (lib/menu-place): its name row's ⋯ and a right-click on that row both draw it.

import { GROUP_NAME_MAX, type SessionGroup } from "../../shared/protocol";
import { sessionsWord } from "./archive";
import { EMPTY_GROUP_REASON } from "./group-picker";
import { groupHref } from "./group-route";
import type { MenuDecl } from "./menu-place";
import { quoted, removeGroup, renameGroup } from "./session-groups";
import { toast } from "./ui-state";

/** What the group menu is about: the group, how many sessions it holds, and who refreshes the list after a delete. */
export interface GroupMenuSubject {
  group: SessionGroup;
  count: number;
  onChanged(): void;
}

/** Open workspace, Rename…, Delete group…, as bare rows: one question at a time, in the menu the press came from.
    A menu place, for every group: a group is this computer's own, even one holding another computer's sessions. */
export const GROUP_MENU: MenuDecl<GroupMenuSubject> = {
  label: ({ group }) => `Group actions · ${group.name}`,
  extensions: { place: "group", payload: ({ group }) => ({ group: group.id }), name: ({ group }) => quoted(group.name) },
  table: ({ group: g, count, onChanged }) => {
    const name = quoted(g.name);
    return [
      {
        rows: [
          // The workspace: every session of this group on screen at once (#/g/<id>).
          { label: "Open workspace", aria: `Open ${name} as a workspace`, title: `Open ${name} as a workspace`, icon: "external", disabled: count === 0 ? EMPTY_GROUP_REASON : "", act: { href: groupHref(g.id) } },
          // Clicking away after typing a name must not lose it. Empty, or the name it has: nothing to write.
          {
            label: "Rename…",
            aria: `Rename ${name}`,
            icon: "pencil",
            act: {
              screen: {
                kind: "name", label: `Rename ${name}`, initial: g.name, placeholder: "Group name", max: GROUP_NAME_MAX, leaveSaves: true,
                save: (typed) => {
                  const to = typed.trim();
                  return to && to !== g.name ? { command: "session.group.rename", params: { group: g.id, name: to }, via: (send) => renameGroup(g.id, to, send) } : null;
                },
              },
            },
          },
          {
            label: "Delete group…",
            aria: `Delete ${name}`,
            icon: "close",
            act: {
              screen: {
                kind: "confirm",
                note: groupDeleteQuestion(g.name, count),
                confirm: "Delete group",
                act: {
                  command: "session.group.delete",
                  params: { group: g.id },
                  via: async (send) => {
                    if (!(await removeGroup(g.id, send))) return;
                    toast(groupDeletedToast(g.name, count));
                    onChanged(); // the rows it held carry a groupId that is gone
                  },
                },
              },
            },
          },
        ],
      },
    ];
  },
};

/** The Delete screen's question, one sentence, in both its forms: what goes away, then what doesn't. */
export const groupDeleteQuestion = (name: string, count: number) =>
  count === 0 ? `Delete ${quoted(name)}? Nothing is in it.` : `Delete ${quoted(name)}? Its ${sessionsWord(count)} stay${count === 1 ? "s" : ""} in the list.`;

/** What a delete says once it is done. */
export const groupDeletedToast = (name: string, count: number) =>
  count === 0 ? `Deleted ${quoted(name)}. It had no sessions.` : `Deleted ${quoted(name)}. Its ${sessionsWord(count)} ${count === 1 ? "is" : "are"} ungrouped.`;
