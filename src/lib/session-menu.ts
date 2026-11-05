// The session menu's own rows (§app.extensions/session-menu, §app.insights/team-cards "⋯ menu"), as
// data: what each row says, why it can't run, and what pressing it does. One list for every door
// — the Agents board row's ⋯, a right-click (or Shift+F10) on a board row or on a session row in
// any section of the sidebar — so the doors can't drift. components/SessionRowMenu.tsx draws it,
// then the place's built-ins and what extensions add. Each door differs only in its
// `SessionMenuCtx`: where Session Details and Open Subagents lead from there.

import type { SessionSummary } from "../../shared/protocol";
import type { IconName } from "../components/ui";
import { gistTitle } from "./agents-board";
import { archiveBlockReason } from "./archive-block";
import { archivedProjectOf, unarchivedProjectOf } from "./drag-archive";
import { hostOf } from "./mesh";
import { groupRefusal } from "./regions";
import { archiveSession, renameSession } from "./session-actions";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups } from "./session-groups";
import { summaryLineOf } from "./summary-row";

/** What the menu needs from the door that opened it: the gestures that reach past it. */
export interface SessionMenuCtx {
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
  /** The session whose Session details pane this door's Session Details would close, if any. */
  detailsPath: string | null;
  onOpenDetails(path: string): void;
}

/** Archive or Unarchive, with the reason it can't run; null where neither applies. */
export type SessionArchiveRow = { label: string; blocked: string | null } | null;

/**
 * The Archive row (§app.insights/team-cards "Archive"): only for sessions started in Sova, or
 * already archived; refused with its reason before the press. Busy as the row reads it: this
 * tab's own run (`running`, ui-state's localRunning) is newer than the last fetched list. Pure.
 */
export function sessionArchiveRow(s: SessionSummary, running: Readonly<Record<string, boolean>>): SessionArchiveRow {
  if (!s.archived && s.origin !== "web") return null;
  const reason = archiveBlockReason({ ...s, busy: !s.live && !!(running[s.path] ?? s.busy) });
  return { label: s.archived ? "Unarchive" : "Archive", blocked: reason ? `Can't archive: ${reason}.` : null };
}

/** What the rows reach the server through; the tests pass stand-ins. */
export interface SessionMenuActs {
  setTitle(s: SessionSummary, title: string | null): Promise<boolean | undefined>;
  setArchived(s: SessionSummary, archived: boolean): Promise<boolean>;
  loadGroups(): void;
}

export const SESSION_MENU_ACTS: SessionMenuActs = {
  setTitle: (s, title) => renameSession(s, title),
  setArchived: (s, next) => archiveSession(s.path, next, next ? archivedProjectOf(s) : unarchivedProjectOf(s, hostOf(s.path) === null)),
  loadGroups: () => void loadSessionGroups(),
};

/** One of Sova's rows: an ActionMenu Item's props, its icon named. */
export interface SessionMenuRow {
  label: string;
  aria: string;
  icon: IconName;
  description?: string;
  /** Why it can't run, or "" when it can. */
  disabled?: string;
  keepFocus?: boolean;
  stayOpen?: boolean;
  run(): void;
}

/** Sova's rows, in their groups and order. `show` swaps the menu's rows for a screen ("rename", "groups"). */
export function sessionMenuRows(
  s: SessionSummary,
  ctx: SessionMenuCtx,
  archive: SessionArchiveRow,
  show: (screen: string) => void,
  acts: SessionMenuActs = SESSION_MENU_ACTS,
): { open: SessionMenuRow[]; title: SessionMenuRow[]; organize: SessionMenuRow[] } {
  const name = quoted(s.title);
  const gist = gistTitle(s);
  const detailsOpen = ctx.detailsPath === s.path;
  const setTitle = async (title: string | null) => {
    if (await acts.setTitle(s, title)) ctx.onRefresh();
  };
  const organize: SessionMenuRow[] = [
    {
      label: "Move to Group…",
      aria: `Move ${name} into a group`,
      icon: "folder",
      description: groupNameOf(sessionGroups(), s.groupId) ?? undefined,
      // The drag's own refusal: an organization's session stays with its project.
      disabled: groupRefusal(s) ?? "",
      stayOpen: true,
      run: () => {
        acts.loadGroups();
        show("groups");
      },
    },
  ];
  if (archive)
    organize.push({
      label: archive.label,
      aria: `${archive.label} ${name}`,
      icon: "archive",
      disabled: archive.blocked ?? "",
      run: () => {
        const next = !s.archived;
        void acts.setArchived(s, next).then((ok) => ok && ctx.onArchiveChanged(s.path, next));
      },
    });
  return {
    open: [
      {
        label: detailsOpen ? "Close Session Details" : "Session Details",
        aria: `${detailsOpen ? "Close the session details" : "Session details"} of ${name}`,
        icon: "info",
        run: () => ctx.onOpenDetails(s.path),
      },
      { label: "Open Subagents", aria: `Open the subagents pane of ${name}`, icon: "worker", keepFocus: true, run: () => ctx.onOpenSubagents(s.path) },
    ],
    // A chat Sova names itself keeps that name: no title actions at all, from any door.
    title: s.fixedName
      ? []
      : [
          // Asks for the name inside the menu, whichever door opened it.
          { label: "Rename…", aria: `Rename ${name}`, icon: "pencil", stayOpen: true, run: () => show("rename") },
          {
            label: "Use Gist as Title",
            aria: `Use the gist as the title of ${name}`,
            icon: "pencil",
            description: gist ?? undefined,
            disabled: gist ? "" : summaryLineOf(s) ? "The gist is already the title." : "No gist yet.",
            run: () => void setTitle(gist),
          },
          {
            label: "Reset to Original Title",
            aria: `Reset ${name} to its original title`,
            icon: "undo",
            description: s.originalTitle,
            disabled: s.originalTitle === undefined ? "Not renamed." : "",
            run: () => void setTitle(null),
          },
        ],
    organize,
  };
}

/**
 * What the rename screen saves: the trimmed name, `null` (empty: back to the derived title), or
 * `undefined` for a cancel — the title the field opened with, which is never a write, even when
 * the session's title moved while the field was open. Pure.
 */
export function renameValue(opened: string, typed: string | null): string | null | undefined {
  const t = typed?.trim() ?? "";
  if (!t) return null;
  return t === opened ? undefined : t;
}

/**
 * The sidebar's door (§app.session-list/accessibility "The session menu"): Session Details opens the
 * session with its Session details pane on the Session tab (and closes it when that pane already
 * shows it there); Open Subagents opens it on the Agents tab. Route first: the pane only opens
 * beside a session that is on screen. `app` is App's pane wiring.
 */
export function sidebarSessionMenuCtx(app: {
  route(path: string): void;
  paneOn(path: string, tab: "session" | "agents"): boolean;
  openPane(path: string, tab: "session" | "agents"): void;
  closePane(): void;
  /** The session whose Session details pane is on its Session tab, if any. */
  detailsOnSession(): string | null;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
}): SessionMenuCtx {
  return {
    get detailsPath() {
      return app.detailsOnSession();
    },
    onOpenDetails: (path) => {
      if (app.paneOn(path, "session")) return app.closePane();
      app.route(path);
      if (!app.paneOn(path, "session")) app.openPane(path, "session");
    },
    onOpenSubagents: (path) => {
      app.route(path);
      if (!app.paneOn(path, "agents")) app.openPane(path, "agents");
    },
    onRefresh: () => app.onRefresh(),
    onArchiveChanged: (path, archived) => app.onArchiveChanged(path, archived),
  };
}
