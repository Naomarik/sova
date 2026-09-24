// Dragging a sidebar row out of the sidebar archives it (spec/02-session-list.md §2 "Groups",
// "Dragging"). What the drag may do is decided once, when it starts; where the pointer is decides
// whether that is showing. Pure, so it runs under `tsx --test`; Sidebar.tsx owns the listeners.

import { isTopSession } from "./regions";
import { archiveBlockReason, type SelectableSession } from "./session-selection";

/**
 * What a drop outside the sidebar would do with this row. `none`: nothing at all, and nothing
 * shown — an archived row (even one a TUI keeps on top), or an external one the Archive region
 * already lists, is already where the gesture would put it. `blocked`: the rules refuse it, and `reason` is
 * archiveBlockReason's own words.
 */
export type ArchiveDrag = { kind: "archive" } | { kind: "blocked"; reason: string } | { kind: "none" };

export function archiveDragOf(s: SelectableSession): ArchiveDrag {
  if (s.archived || !isTopSession(s)) return { kind: "none" };
  const reason = archiveBlockReason(s);
  return reason ? { kind: "blocked", reason } : { kind: "archive" };
}

/** The drop state while the pointer is outside the sidebar; null inside it, or for an archived row. */
export type OutsideTarget = "archive" | "archive-blocked" | null;

export function outsideTarget(drag: ArchiveDrag, insideSidebar: boolean): OutsideTarget {
  if (insideSidebar || drag.kind === "none") return null;
  return drag.kind === "archive" ? "archive" : "archive-blocked";
}

/** The cursor a dragover outside the sidebar asks for: only an archive that would happen moves. */
export const outsideDropEffect = (target: OutsideTarget): "move" | "none" => (target === "archive" ? "move" : "none");

/** The indicator's words for each outside state, or null when nothing shows. */
export function outsideLabel(target: OutsideTarget, drag: ArchiveDrag, title: string): string | null {
  if (target === "archive") return `Archive “${title}”`;
  if (target === "archive-blocked" && drag.kind === "blocked") return `Can't archive: ${drag.reason}`;
  return null;
}

/**
 * What a drop that archived says, and whether it offers Undo. A never-sent session (no user
 * message, no stored draft) isn't archived at all: the server deletes the file instead
 * (`archiveSession`, server/sessions-index.ts), so there is nothing an Undo could bring back.
 * `deleted`: the session is gone from the list after the archive.
 */
export function archivedDropToast(deleted: boolean): { text: string; undo: boolean } {
  return deleted
    ? { text: "Deleted. It had no messages, so there was nothing to archive.", undo: false }
    : { text: "Archived. Find it under Archive.", undo: true };
}

/** What a drop outside the sidebar says when it can't archive, or null when it archives (or does nothing). */
export function blockedDropSentence(drag: ArchiveDrag): string | null {
  return drag.kind === "blocked" ? `Can't archive this session: ${drag.reason}.` : null;
}

/**
 * Whether a dragleave took the pointer out of the window itself. Leaving the window never fires a
 * dragover outside the sidebar, so without this the indicator would promise an archive for a
 * drop that lands on the desktop. Between two elements `relatedTarget` names the next one; off
 * the window it is null and the point sits on or past the viewport's edge.
 */
export function leftWindow(p: { relatedTarget: unknown; clientX: number; clientY: number }, view: { width: number; height: number }): boolean {
  if (p.relatedTarget) return false;
  return p.clientX <= 0 || p.clientY <= 0 || p.clientX >= view.width || p.clientY >= view.height;
}
