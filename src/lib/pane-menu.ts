// A workspace pane's Pane actions (§workspace.groups/a-pane "The tools are one menu"), as one
// declaration (lib/menu-place): its head's ⋯ and a right-click on its head or tab all draw it,
// from the workspace's own state and gestures (`PaneMenuWiring`), so the head and the tab can't
// offer different menus for the same member.

import { GROUP_LABEL_MAX, type SessionSummary } from "../../shared/protocol";
import type { MenuAct, MenuDecl, MenuItem } from "./menu-place";
import { hostOf } from "./mesh";
import { quoted } from "./session-groups";

/** The workspace's side of every pane's menu: GroupView's own state and gestures. */
export interface PaneMenuWiring {
  nameOf(path: string): string;
  groupName(): string;
  /** Width and order only mean something in the split row. */
  split(): boolean;
  /** The members in display order. */
  panes(): readonly string[];
  labelOf(path: string): string | null;
  /** Out of the group (`send`: the command's request); the session itself stays untouched. */
  detach(path: string, send?: () => Promise<unknown>): void;
  /** The session on its own (`#/s/…`). */
  href(path: string): string;
  resize(path: string, direction: 1 | -1): void;
  move(path: string, direction: 1 | -1): void;
  focusPane(path: string, moveFocus: boolean): void;
  /** Set a label (`string`) or clear it (`null`) — the comparison's naming act. */
  rename(path: string, label: string | null): void;
  promote(path: string, send: () => Promise<unknown>): void;
}

/** What a pane's menu is about: the member's path, its session as the workspace reads it now, and the workspace. */
export interface PaneMenuSubject {
  path: string;
  summary: SessionSummary;
  w: PaneMenuWiring;
}

/**
 * The rows, in their three groups: this member (its name), this pane (width, place, focus, open on
 * its own) and its membership. Promote takes it out and opens it; Remove From Group only takes it
 * out, never archiving or deleting the session. A menu place, for a pane whose session is on this host.
 */
export const PANE_MENU: MenuDecl<PaneMenuSubject> = {
  label: ({ path, w }) => `Pane actions · ${w.nameOf(path)}`,
  extensions: { place: "pane", payload: ({ path, summary }) => (hostOf(path) === null ? { session: summary.id } : null), name: ({ path, w }) => quoted(w.nameOf(path)) },
  table: ({ path, summary, w }) => {
    const name = w.nameOf(path);
    const group = quoted(w.groupName());
    const list = w.panes();
    const out = { command: "session.group.assign", params: { session: path, group: null }, keepFocus: true } as const;
    const pane: MenuItem[] = [{ label: "Open", aria: `Open ${name}`, title: "Open this session on its own", icon: "external", act: { local: () => (location.hash = w.href(path)), keepFocus: true } }];
    if (w.split())
      pane.push(
        { label: "Wider", aria: `Make ${name} wider`, icon: "chevron-right", act: { local: () => w.resize(path, 1) } },
        { label: "Narrower", aria: `Make ${name} narrower`, icon: "chevron-left", act: { local: () => w.resize(path, -1) } },
        {
          label: "Move Left",
          aria: `Move ${name} left`,
          // The keyboard hint lives where it is first needed: order moves are mouseless by nature.
          title: `Swap ${name} with its left-hand neighbour. Ctrl+Alt+← moves focus, not the pane.`,
          icon: "chevron-left",
          disabled: list[0] === path ? "It's already first." : "",
          act: { local: () => w.move(path, -1) },
        },
        {
          label: "Move Right",
          aria: `Move ${name} right`,
          title: `Swap ${name} with its right-hand neighbour. Ctrl+Alt+→ moves focus, not the pane.`,
          icon: "chevron-right",
          disabled: list[list.length - 1] === path ? "It's already last." : "",
          act: { local: () => w.move(path, 1) },
        },
      );
    // Not in the copy deck's row list: a workspace needs a way to put the keyboard in a pane that
    // doesn't depend on reaching its composer, which a read-only member doesn't have.
    pane.push({ label: "Focus", aria: `Focus ${name}`, icon: "chat", act: { local: () => w.focusPane(path, true), keepFocus: true } });
    const membership: MenuItem[] = [
      { label: "Promote", aria: `Promote ${name}`, title: `Take it out of ${group} and open it on its own`, icon: "arrow-right", act: { ...out, via: (send) => w.promote(path, send) } },
      {
        label: "Remove From Group",
        aria: `Remove ${name} from the group`,
        title:
          summary.origin === "web"
            ? `Take it out of ${group} and stay here. Nothing is archived and nothing is deleted`
            : "This session wasn't started in Sova, so removing it is all we can do — nothing is archived",
        icon: "close",
        act: { ...out, via: (send) => w.detach(path, send) },
      },
    ];
    // Empty CLEARS the label: that is the gesture's other half, and a refused Save would hide it.
    const naming: MenuAct = {
      screen: { kind: "name", label: `Name ${name}`, initial: w.labelOf(path) ?? "", placeholder: name, max: GROUP_LABEL_MAX, hint: "Empty clears the label — the pane shows the title again.", save: (typed) => ({ local: () => w.rename(path, typed.trim() || null), keepFocus: true }) },
    };
    return [
      { name: "This member", rows: [{ label: "Rename…", aria: `Rename ${name}`, title: "Give this member your own name — the useful one is only known after reading its output", icon: "pencil", act: naming }] },
      { name: "This pane", rows: pane },
      { name: "This session's membership", rows: membership },
    ];
  },
};
