// The session menu (§app.extensions/session-menu, §app.insights/team-cards "⋯ menu"), as one
// declaration (lib/menu-place): for every door — the Agents board row's ⋯, a right-click (or
// Shift+F10) on a board row or on a session row in any section of the sidebar — so the doors can't
// drift. Each door differs only in its `SessionMenuCtx`: where Session Details and Open Subagents
// lead from there.

import { SESSION_TITLE_MAX, type SessionSummary } from "../../shared/protocol";
import { gistTitle } from "./agents-board";
import { archiveBlockReason } from "./archive-block";
import { archivedProjectOf, unarchivedProjectOf } from "./drag-archive";
import { hostOf } from "./mesh";
import { groupRefusal } from "./regions";
import { archiveSession, renameSession } from "./session-actions";
import type { MenuAct, MenuDecl, MenuItem } from "./menu-place";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups, setSessionGroup } from "./session-groups";
import { summaryLineOf } from "./summary-row";
import { announce, copyText, toast } from "./ui-state";

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

/** What the session menu is about, and the door's context. */
export interface SessionMenuSubject {
  session: SessionSummary;
  ctx: SessionMenuCtx;
  archive: SessionArchiveRow;
}

/** The session menu: every door's, so the doors can't drift. A menu place: extensions add to it, for a session on this host only. */
export const SESSION_MENU: MenuDecl<SessionMenuSubject> = {
  label: ({ session: s }) => `Actions for ${quoted(s.title)}`,
  extensions: { place: "session", payload: ({ session: s }) => (hostOf(s.path) === null ? { session: s.id } : null), name: ({ session: s }) => quoted(s.title) },
  table: ({ session: s, ctx, archive }) => {
    const name = quoted(s.title);
    const gist = gistTitle(s);
    const detailsOpen = ctx.detailsPath === s.path;
    const titled = async (to: string | null, send: () => Promise<unknown>) => (await renameSession(s, to, send)) && ctx.onRefresh();
    const set = (to: string): MenuAct => ({ command: "session.title.set", params: { session: s.path, title: to }, via: (send) => titled(to, send) });
    const reset: MenuAct = { command: "session.title.reset", params: { session: s.path }, via: (send) => titled(null, send) };
    /** Into a group (or out of it, null), and say where it went. */
    const move = async (id: string | null, send: () => Promise<unknown>) => {
      const before = groupNameOf(sessionGroups(), s.groupId);
      if (id === (s.groupId ?? null) || !(await setSessionGroup(s.path, id, undefined, send))) return;
      const after = groupNameOf(sessionGroups(), id ?? undefined);
      const done = id === null ? `Removed from ${before ? quoted(before) : "the group"}.` : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
      toast(done);
      announce(done);
      ctx.onRefresh();
    };
    const groups = [{ id: null as string | null, name: "No group" }, ...sessionGroups().map((g) => ({ id: g.id as string | null, name: g.name }))].map(
      (g): MenuItem => ({
        label: g.name,
        aria: g.id ? `Move ${name} to ${quoted(g.name)}` : `Take ${name} out of its group`,
        icon: g.id === (s.groupId ?? null) ? "check" : "folder",
        act: { command: "session.group.assign", params: { session: s.path, group: g.id }, via: (send) => move(g.id, send) },
      }),
    );
    const next = !s.archived;
    const organize: MenuItem[] = [
      // The drag's own refusal: an organization's session stays with its project.
      {
        label: "Move to Group…",
        aria: `Move ${name} into a group`,
        icon: "folder",
        description: groupNameOf(sessionGroups(), s.groupId) ?? undefined,
        disabled: groupRefusal(s) ?? "",
        act: { screen: { kind: "rows", label: "Move to group", load: () => void loadSessionGroups(), sections: [{ name: "Groups", heading: "Groups", rows: groups }] } },
      },
      ...(archive
        ? [
            {
              label: archive.label,
              aria: `${archive.label} ${name}`,
              icon: "archive",
              disabled: archive.blocked ?? "",
              act: {
                command: next ? "session.archive" : "session.unarchive",
                params: { session: s.path },
                via: async (send) => (await archiveSession(s.path, next, next ? archivedProjectOf(s) : unarchivedProjectOf(s, hostOf(s.path) === null), send)) && ctx.onArchiveChanged(s.path, next),
              },
            } satisfies MenuItem,
          ]
        : []),
      { label: "Copy Path", aria: `Copy the path of ${name}`, icon: "copy", act: { local: () => copyText(s.path, "Copied path.") } },
    ];
    // Asks for the name inside the menu, whichever door opened it; empty restores the derived title.
    const rename: MenuAct = {
      screen: {
        kind: "name",
        label: `Rename ${name}`,
        initial: s.title,
        placeholder: "Session title",
        max: SESSION_TITLE_MAX,
        hint: `Kept in Sova only. Empty restores ${quoted(s.originalTitle ?? s.title)}.`,
        save: (typed, opened) => {
          const to = renameValue(opened, typed);
          return to === undefined ? null : to === null ? reset : set(to);
        },
      },
    };
    return [
      {
        name: "Open",
        rows: [
          { label: detailsOpen ? "Close Session Details" : "Session Details", aria: `${detailsOpen ? "Close the session details" : "Session details"} of ${name}`, icon: "info", act: { local: () => ctx.onOpenDetails(s.path) } },
          { label: "Open Subagents", aria: `Open the subagents pane of ${name}`, icon: "worker", act: { local: () => ctx.onOpenSubagents(s.path), keepFocus: true } },
        ],
      },
      {
        name: "Title",
        // A chat Sova names itself keeps that name: no title actions at all, from any door.
        rows: s.fixedName
          ? []
          : [
              { label: "Rename…", aria: `Rename ${name}`, icon: "pencil", act: rename },
              { label: "Use Gist as Title", aria: `Use the gist as the title of ${name}`, icon: "pencil", description: gist ?? undefined, disabled: gist ? "" : summaryLineOf(s) ? "The gist is already the title." : "No gist yet.", act: set(gist ?? "") },
              { label: "Reset to Original Title", aria: `Reset ${name} to its original title`, icon: "undo", description: s.originalTitle, disabled: s.originalTitle === undefined ? "Not renamed." : "", act: reset },
            ],
      },
      { name: "Organize", rows: organize },
    ];
  },
};

/**
 * What the rename box saves: the trimmed name, `null` (empty: back to the derived title), or
 * `undefined` for a cancel — the title the box opened with, which is never a write, even when
 * the session's title moved while the box was open. Pure.
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
