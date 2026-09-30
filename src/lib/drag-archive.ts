// Dropping a sidebar row on the drop overlay's Archive tile archives it (§app.session-list/drop-overlay).
// What the drag may do is decided once, when it starts. Pure, so it runs under `tsx --test`;
// Sidebar.tsx does the archive.

import type { SessionSummary } from "../../shared/protocol";
import { isTopSession } from "./regions";
import { archiveBlockReason, type SelectableSession } from "./session-selection";

/**
 * What a drop on the Archive tile would do with this row. `none`: nothing at all, and nothing
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

/**
 * Why the drop overlay's Archive tile can't take this row, or null when it archives. Blocked:
 * archiveBlockReason's own words. Nothing to do: an archived row, or an external one the Archive
 * region already lists, is already where the gesture would put it.
 */
export function archiveTileReason(drag: ArchiveDrag, archived: boolean | undefined): string | null {
  if (drag.kind === "archive") return null;
  if (drag.kind === "blocked") return `Can't archive: ${drag.reason}`;
  return archived ? "Already archived." : "Already in the Archive.";
}

/**
 * What a drop that archived says, and whether it offers Undo. A never-sent session (no user
 * message, no stored draft) isn't archived at all: the server deletes the file instead
 * (`archiveSession`, server/sessions-index.ts), so there is nothing an Undo could bring back.
 * `deleted`: the session is gone from the list after the archive.
 */
export function archivedDropToast(deleted: boolean, project?: string | null): { text: string; undo: boolean } {
  if (deleted) return { text: "Deleted. It had no messages, so there was nothing to archive.", undo: false };
  // An organization's session never enters the Archive: it goes to its group's Done list in its project.
  return { text: project ? `Archived. Find it in ${project}, under Done.` : "Archived. Find it under Archive.", undo: true };
}

/** What Undo (or Unarchive) says: an org session goes back to its project, the rest to Live & web. */
export const unarchivedToast = (project?: string | null): string => (project ? `Moved back to ${project}.` : "Moved back to Live & web.");

/** The project an org row's archive and unarchive toasts name, or null for an ordinary session. */
export const orgProjectOf = (s: Pick<SessionSummary, "org">): string | null =>
  s.org ? (s.org.projectId ? s.org.projectName || "its project" : s.org.orgName || s.org.orgId) : null;

/** What a drop on a refused Archive tile says as a toast, or null when it archives (or does nothing). */
export function blockedDropSentence(drag: ArchiveDrag): string | null {
  return drag.kind === "blocked" ? `Can't archive this session: ${drag.reason}.` : null;
}
