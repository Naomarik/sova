// A workspace pane's Pane actions (§workspace.groups/a-pane "The tools are one menu"), as data: the
// rows its head's ⋯, a right-click or Shift+F10 on its head and one on its tab all draw
// (components/PaneMenu.tsx), and the props every door builds for a pane's path (`paneMenuFor`), so
// the head and the tab can't offer different menus for the same member.

import type { SessionSummary } from "../../shared/protocol";
import type { MenuRow } from "./menu-row";
import { quoted } from "./session-groups";

/** The menu's name, the ⋯ trigger's: named for the pane it acts on, so three on screen are three menus. */
export const paneMenuLabel = (name: string) => `Pane actions · ${name}`;

/** What the menu needs about one pane, and what its rows do. */
export interface PaneMenuProps {
  /** The pane's name, so every row here says which member it acts on. */
  name: string;
  /** The group's name, which the membership rows' titles quote. */
  groupName: string;
  /** Width and order only mean something in the split row. */
  split: boolean;
  first: boolean;
  last: boolean;
  /**
   * Eliminate's state: `null` when this session was not started in Sova (there is nothing to
   * archive, so the row is absent), `""` when it can be eliminated, and otherwise the reason it
   * can't — said before the press rather than discovered as a half-finished gesture.
   */
  eliminate: string | null;
  /** The member's label today, or null: what `Rename` starts the field from. */
  label: string | null;
  standaloneHref: string;
  onWider(): void;
  onNarrower(): void;
  onLeft(): void;
  onRight(): void;
  onFocus(): void;
  /** Set a label (`string`) or clear it (`null`) — the comparison's naming act. */
  onRename(label: string | null): void;
  onRemove(): void;
  onEliminate(): void;
  onPromote(): void;
}

/** Eliminate's state for a member (see `PaneMenuProps.eliminate`). Pure. */
export function paneEliminate(s: SessionSummary, running: boolean): string | null {
  if (s.origin !== "web") return null;
  if (s.live) return "This session is open in a terminal.";
  return running ? "It's mid-turn. Stop it or wait, then eliminate it." : "";
}

/** The workspace's side of every pane's menu: GroupView's own state and gestures. */
export interface PaneMenuWiring {
  nameOf(path: string): string;
  groupName(): string;
  split(): boolean;
  /** The members in display order. */
  panes(): readonly string[];
  labelOf(path: string): string | null;
  running(s: SessionSummary): boolean;
  /** The session on its own (`#/s/…`). */
  href(path: string): string;
  resize(path: string, direction: 1 | -1): void;
  move(path: string, direction: 1 | -1): void;
  focusPane(path: string, moveFocus: boolean): void;
  rename(path: string, label: string | null): void;
  /** Out of the group; `archive` archives it too (Eliminate). */
  detach(path: string, archive: boolean): void;
  promote(path: string): void;
}

/** One pane's menu props, for every door: read live, so an open menu follows the workspace. */
export function paneMenuFor(path: string, summary: () => SessionSummary, w: PaneMenuWiring): PaneMenuProps {
  return {
    get name() {
      return w.nameOf(path);
    },
    get groupName() {
      return w.groupName();
    },
    get split() {
      return w.split();
    },
    get first() {
      return w.panes()[0] === path;
    },
    get last() {
      const list = w.panes();
      return list[list.length - 1] === path;
    },
    get eliminate() {
      return paneEliminate(summary(), w.running(summary()));
    },
    get label() {
      return w.labelOf(path);
    },
    get standaloneHref() {
      return w.href(path);
    },
    onWider: () => w.resize(path, 1),
    onNarrower: () => w.resize(path, -1),
    onLeft: () => w.move(path, -1),
    onRight: () => w.move(path, 1),
    onFocus: () => w.focusPane(path, true),
    onRename: (label) => w.rename(path, label),
    onRemove: () => w.detach(path, false),
    onEliminate: () => w.detach(path, true),
    onPromote: () => w.promote(path),
  };
}

/** Where Open goes; the tests pass a stand-in. */
export interface PaneMenuActs {
  go(hash: string): void;
}

export const PANE_MENU_ACTS: PaneMenuActs = {
  go: (hash) => {
    location.hash = hash;
  },
};

/**
 * The rows, in their three groups: this member (its name), this pane (width, place, focus, open on
 * its own) and its membership — three separate words on purpose: Promote takes it out and opens
 * it, Eliminate takes it out and archives it, Remove From Group only takes it out. `startNaming`
 * swaps the rows for the name field.
 */
export function paneMenuRows(p: PaneMenuProps, startNaming: () => void, acts: PaneMenuActs = PANE_MENU_ACTS): { member: MenuRow[]; pane: MenuRow[]; membership: MenuRow[] } {
  const name = p.name;
  const group = quoted(p.groupName);
  const pane: MenuRow[] = [{ label: "Open", aria: `Open ${name}`, title: "Open this session on its own", icon: "external", keepFocus: true, run: () => acts.go(p.standaloneHref) }];
  if (p.split)
    pane.push(
      { label: "Wider", aria: `Make ${name} wider`, icon: "chevron-right", run: p.onWider },
      { label: "Narrower", aria: `Make ${name} narrower`, icon: "chevron-left", run: p.onNarrower },
      {
        label: "Move Left",
        aria: `Move ${name} left`,
        // The keyboard hint lives where it is first needed: order moves are mouseless by nature.
        title: `Swap ${name} with its left-hand neighbour. Ctrl+Alt+← moves focus, not the pane.`,
        icon: "chevron-left",
        disabled: p.first ? "It's already first." : "",
        run: p.onLeft,
      },
      {
        label: "Move Right",
        aria: `Move ${name} right`,
        title: `Swap ${name} with its right-hand neighbour. Ctrl+Alt+→ moves focus, not the pane.`,
        icon: "chevron-right",
        disabled: p.last ? "It's already last." : "",
        run: p.onRight,
      },
    );
  // Not in the copy deck's row list: a workspace needs a way to put the keyboard in a pane that
  // doesn't depend on reaching its composer, which a read-only member doesn't have.
  pane.push({ label: "Focus", aria: `Focus ${name}`, icon: "chat", keepFocus: true, run: p.onFocus });
  const membership: MenuRow[] = [
    { label: "Promote", aria: `Promote ${name}`, title: `Take it out of ${group} and open it on its own`, icon: "arrow-right", keepFocus: true, run: p.onPromote },
    {
      label: "Remove From Group",
      aria: `Remove ${name} from the group`,
      title:
        p.eliminate === null
          ? "This session wasn't started in Sova, so removing it is all we can do — nothing is archived"
          : `Take it out of ${group} and stay here. Nothing is archived and nothing is deleted`,
      icon: "close",
      keepFocus: true,
      run: p.onRemove,
    },
  ];
  // Absent, not disabled, when the session wasn't started in Sova: there is nothing to archive, and
  // it is a different gesture rather than a refusal.
  if (p.eliminate !== null)
    membership.push({
      label: "Eliminate",
      aria: `Eliminate ${name}`,
      title: `Take it out of ${group} and archive it. The transcript stays; unarchiving brings it back`,
      icon: "archive",
      disabled: p.eliminate,
      keepFocus: true,
      run: p.onEliminate,
    });
  return {
    member: [
      {
        label: "Rename…",
        aria: `Rename ${name}`,
        title: "Give this member your own name — the useful one is only known after reading its output",
        icon: "pencil",
        stayOpen: true,
        run: startNaming,
      },
    ],
    pane,
    membership,
  };
}
