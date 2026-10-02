// The group picker the Groups head's `Open Groups` opens: every group as a drop-overlay tile, and a
// press on one opens its workspace. Nothing is in flight, so none of the drag's targets (New group,
// Remove, Archive, Cancel) are here, and a tile never makes, moves or removes anything.
// Framework-free like drag-overlay: GroupPicker.tsx draws what `pickerTiles` returns.

import type { SessionGroup } from "../../shared/protocol";
import { groupCountLabel } from "./drag-overlay";
import { groupHref } from "./group-route";

/** Why an empty group can't be opened: the group menu's `Open workspace` says the same. */
export const EMPTY_GROUP_REASON = "Nothing is in it yet. Drag a session into it first.";
/** With no group at all: the region's note, the head button's reason and the picker's note. */
export const NO_GROUPS_NOTE = "No groups yet. Drag a session to start one.";

export interface PickerTile {
  id: string;
  name: string;
  count: number;
  /** The workspace link, or null for an empty group, which can't be opened. */
  href: string | null;
  /** The second line: the session count, or the reason it can't be opened. */
  line: string;
  disabled: string | null;
}

/** One tile per group, in the order given (the server's creation order), counted as the drop overlay counts. */
export function pickerTiles(groups: readonly SessionGroup[], counts: ReadonlyMap<string, number>): PickerTile[] {
  return groups.map((g) => {
    const count = counts.get(g.id) ?? 0;
    const disabled = count === 0 ? EMPTY_GROUP_REASON : null;
    return { id: g.id, name: g.name, count, href: disabled ? null : groupHref(g.id), line: disabled ?? groupCountLabel(count), disabled };
  });
}

/** Where focus lands when the picker opens: the first group that opens, else the first tile, else none (-1). */
export const firstFocusTile = (tiles: readonly PickerTile[]): number => {
  const open = tiles.findIndex((t) => t.href !== null);
  return open >= 0 ? open : tiles.length > 0 ? 0 : -1;
};
