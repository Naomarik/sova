// A sidebar session row's own menu (§app.session-list): what it offers a session and why a row
// can't run. How the menu opens, sits and closes is every such menu's (lib/context-menu). Pure and
// DOM-free at import, so the rules run under `pnpm test`; components/SessionContextMenu.tsx draws it.

import type { SessionSummary } from "../../shared/protocol";
import { REGENERATE_TITLE_DESC, REGENERATING_LABEL } from "./auto-title";
import { type ArchiveDrag, archiveTileReason } from "./drag-archive";
import type { DropTiles } from "./drag-overlay";

// ---- what the menu offers ---------------------------------------------------------------------

/** The menu's rows for one session. A `disabled` string is the reason the row can't run; "" runs. */
export interface RowMenuModel {
  /** Rename…, Regenerate Title and Reset to Original Title; null for a chat Sova names itself,
      which keeps its name (the Agents board's rule): no title rows at all. */
  title: {
    /** Regenerate Title's second line, and why it can't run: "" runs (the session's own regenerate isn't in flight). */
    regenerateDesc: string;
    regenerateDisabled: string;
    /** The title it had before it was renamed, shown under Reset's row. */
    original: string | undefined;
    resetDisabled: string;
  } | null;
  /** Move to Group…: the drop panel's reason when no group can take it (an organization's or a peer's session). */
  moveDisabled: string;
  /** Archive, or Unarchive on an archived row; `act` null when Archive can't run (`disabled` says why). */
  archive: { label: "Archive" | "Unarchive"; act: "archive" | "unarchive" | null; disabled: string };
}

/**
 * The rows `s` gets. `drag` is the row's archive drag as the drop panel decides it (busy as the row
 * shows it), `tiles` the drop panel's tiles for it: the menu refuses exactly what the panel refuses,
 * in the panel's words. `regenerating`: this session's Regenerate Title is in flight (lib/auto-title).
 */
export function rowMenuOf(
  s: Pick<SessionSummary, "title" | "originalTitle" | "fixedName" | "archived" | "compressed" | "moved">,
  drag: ArchiveDrag,
  tiles: Pick<DropTiles, "groupNote">,
  regenerating = false,
): RowMenuModel {
  const title = s.fixedName
    ? null
    : {
        regenerateDesc: REGENERATE_TITLE_DESC,
        regenerateDisabled: regenerating ? REGENERATING_LABEL : "",
        original: s.originalTitle,
        resetDisabled: s.originalTitle === undefined ? "Not renamed." : "",
      };
  const moveDisabled = tiles.groupNote ?? "";
  const archive: RowMenuModel["archive"] = s.compressed
    ? // §app.session-list/archive-compression: a compressed chat has no Unarchive.
      { label: "Unarchive", act: null, disabled: "It is compressed: Sova keeps it for the record and doesn't open it." }
    : s.moved
    ? // §app.transport/moved-row: it runs on the other device now.
      { label: "Unarchive", act: null, disabled: `It moved to ${s.moved.to}; Move Back brings it here.` }
    : s.archived
    ? { label: "Unarchive", act: "unarchive", disabled: "" }
    : drag.kind === "archive"
      ? { label: "Archive", act: "archive", disabled: "" }
      : { label: "Archive", act: null, disabled: archiveTileReason(drag, s.archived) ?? "" };
  return { title, moveDisabled, archive };
}

/** One row of Move to Group's list: `id` null is No group. `current`: the row is there now (checked, runs nothing). */
export interface GroupChoice {
  id: string | null;
  name: string;
  current: boolean;
  disabled: string;
}

/** Move to Group's rows, from the drop panel's tiles: No group, then each group, in the panel's order and words. */
export function groupChoices(t: Pick<DropTiles, "groups" | "remove">): GroupChoice[] {
  return [
    { id: null, name: "No group", current: !t.remove, disabled: "" },
    ...t.groups.map((g) => ({ id: g.id, name: g.name, current: g.current, disabled: g.disabled ?? "" })),
  ];
}
