import type { SessionSummary } from "../../shared/protocol";

/**
 * Sidebar pane rule (shared/protocol.ts): live sessions always stay on
 * top, and so do web-spawned ones until the user archives them; the rest is archive. A server
 * that predates `origin` or `archived` sends none, which counts as external and not archived.
 */
export const isTopSession = (s: Pick<SessionSummary, "live" | "origin" | "archived">): boolean =>
  s.live !== null || (s.origin === "web" && s.archived !== true);

/**
 * Whether a session is a main thread — one the user started. A worker session is a subagent's or
 * team member's own session, never a thread the user started, so the sidebar lists only main
 * threads; worker transcripts stay reachable from the owner's row and the Agents/Subagents pane.
 * An Overseer file (current or old) is not one either: the Overseer lives at its own route and is
 * never a row. A server that predates `workerSession` or `overseer` sends none: a main thread.
 */
export const isMainThread = (s: Pick<SessionSummary, "workerSession" | "overseer">): boolean => s.workerSession !== true && s.overseer !== true;

/**
 * Whether a session belongs to an organization (`SessionSummary.org`, §app.session-list/organizations):
 * a file in an attached org's workspace, or a coding session that org's project started. Such a
 * session lives only in the Organizations region. A server that predates `org` sends none: ordinary.
 */
export const isOrgSession = (s: Pick<SessionSummary, "org">): boolean => !!s.org;

/**
 * Whether a registered project owns a session outright: its overseer's conversations and the coding sessions it
 * started. A session that is only in the project's folder (`project.kind` "folder")
 * is not owned: it stays ordinary and is listed with its project too.
 */
export const isProjectOwned = (s: Pick<SessionSummary, "project">): boolean => !!s.project && s.project.kind !== "folder";

/** A standalone project's build the operator archived: it leaves the project's block for the Archive (§app.projects/list).
    A placed project's builds carry `org` and keep going to their group's Done instead. */
export const isArchivedStandaloneBuild = (s: Pick<SessionSummary, "org" | "project"> & { archived?: boolean }): boolean =>
  !s.org && s.project?.kind === "coding" && s.archived === true;

/** A standalone project's coding session the operator started (`project.operator`), not one its overseer started: it lives in
    the project's block, and Recent lists it too (§app.session-list/recent). A server that sends no `operator` marks none. */
export const isOperatorBuild = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project">): boolean =>
  isMainThread(s) && !s.org && s.project?.kind === "coding" && s.project.operator === true;

/** An organization's or a project's own session: it lives in that region (the archive toasts). A session only in a
    project's folder is not owned. Whether it joins a group is `isGroupable`'s: the operator's own builds do. */
export const isOwnedSession = (s: Pick<SessionSummary, "org" | "project">): boolean => isOrgSession(s) || isProjectOwned(s);

/**
 * The one check every ordinary surface reads (Recent, Needs you, Groups, Folders, the Archive and
 * its cleanup, recent folders, the overview): a main thread that no organization and no registered
 * project owns (a standalone project's builds and overseer are the Projects region's; a session in its
 * folder is ordinary, though Folders leaves it to its project, `listedWithLocalProject`; an archived standalone build is the Archive's). It is NOT folded into `isMainThread`, because the Organizations region, the Overseer
 * page and the Agents board still read org sessions.
 */
export const isOrdinarySession = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project"> & { archived?: boolean }): boolean =>
  isMainThread(s) && !isOrgSession(s) && (!isProjectOwned(s) || isArchivedStandaloneBuild(s));

/**
 * Whether a session can be in a group (§app.session-list/groups): every ordinary session, and the operator's own coding
 * sessions (`isOperatorBuild`), as Recent adds them back. It widens only the groups — their sections, counts, the drag
 * lock, Move into group — never `isOrdinarySession`, so those builds stay out of Folders, Needs you and the Archive.
 * Organization sessions, a project's overseer conversations and the builds its overseer started on its own never are.
 */
export const isGroupable = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project"> & { archived?: boolean }): boolean =>
  isOrdinarySession(s) || isOperatorBuild(s);

export const ORG_GROUP_REASON = "Organization sessions stay with their project.";
export const PROJECT_GROUP_REASON = "Project sessions stay with their project.";

/** Why a row can't join a group, in the words the controls say (the server's 400 says the same); null when it can.
    Taking one out of a group always works. */
export const groupRefusal = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project"> & { archived?: boolean }): string | null =>
  isOrgSession(s) ? ORG_GROUP_REASON : isGroupable(s) || !isProjectOwned(s) ? null : PROJECT_GROUP_REASON;

/**
 * A session a project of this computer lists (§app.projects/folder-sessions): in a registered, not archived project's
 * folder (`project.kind` "folder", standalone or placed), and not archived itself. Its project's block is its place in
 * the pane, so Folders leaves it out. `here`: the row is this computer's; a mesh peer's row carries the peer's own
 * `project` and always stays in Folders. A remote target's session never carries a folder project (the server's rule).
 */
export const listedWithLocalProject = (s: Pick<SessionSummary, "org" | "project" | "folderOrg"> & { archived?: boolean }, here: boolean): boolean =>
  here && !s.org && s.project?.kind === "folder" && s.project.archived !== true && s.folderOrg?.projectArchived !== true && s.archived !== true;

/** Folders, the top region (§app.session-list/regions-top-and-archive): an ordinary session that is live or a web session
    not archived, unless a project of this computer lists it. */
export const inFolders = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project" | "folderOrg" | "live" | "origin" | "archived">, here: boolean): boolean =>
  isOrdinarySession(s) && isTopSession(s) && !listedWithLocalProject(s, here);

/** Folders' stored choice (`sova:top-open`): open by default, only "0" (the user collapsed it) closes it. */
export const storedFoldersOpen = (raw: string | null): boolean => raw !== "0";

/** Whether Folders is open: forced open, the stored choice left alone, while a search has matches in it; opened for the
    open session inside it unless the user collapsed it on this visit (`dismissed`, lib/section-reveal); otherwise the
    tab's choice (the Projects region's rule). */
export const foldersOpen = (input: { stored: boolean; searching: boolean; hits: number; holdsSelected: boolean; dismissed: boolean }): boolean =>
  (input.searching && input.hits > 0) || (input.holdsSelected && !input.dismissed) || input.stored;

/** Whether the Archive is open: collapsed by default; forced open while searching or while Folders is empty; opened for
    the open session inside it unless the user collapsed it on this visit; otherwise the tab's choice. */
export const archiveOpen = (input: { stored: boolean; searching: boolean; topEmpty: boolean; holdsSelected: boolean; dismissed: boolean }): boolean =>
  input.searching || input.topEmpty || (input.holdsSelected && !input.dismissed) || input.stored;

/** Whether an Archive date section is open: forced open while searching; opened for the open session inside it unless
    the user collapsed it on this visit; otherwise its stored choice. */
export const archiveDateOpen = (input: { stored: boolean; searching: boolean; holdsSelected: boolean; dismissed: boolean }): boolean =>
  input.searching || (input.holdsSelected && !input.dismissed) || input.stored;

/** Which of the pane's places a main thread lives in (the overview's live count reads "top": every open session, whether
    Folders or its project's block lists it): org, then a project's (§app.projects/list), win over live, web and archived. A folder session's, and an archived standalone build's, is its ordinary place. */
export const sidebarRegion = (s: Pick<SessionSummary, "live" | "origin" | "archived" | "org" | "project">): "org" | "projects" | "top" | "archive" =>
  isOrgSession(s) ? "org" : isProjectOwned(s) && !isArchivedStandaloneBuild(s) ? "projects" : isTopSession(s) ? "top" : "archive";
