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

/** An organization's or a project's own session: it lives in that region and never joins a group (the drag lock, bulk
    Move to Group, the archive toasts). A session only in a project's folder is not owned. */
export const isOwnedSession = (s: Pick<SessionSummary, "org" | "project">): boolean => isOrgSession(s) || isProjectOwned(s);

/**
 * The one check every ordinary surface reads (Recent, Needs you, Groups, Live & web, the Archive and
 * its cleanup, recent folders, the overview): a main thread that no organization and no registered
 * project owns (a standalone project's builds and overseer are the Projects region's; a session in its
 * folder is both; an archived standalone build is the Archive's). It is NOT folded into `isMainThread`, because the Organizations region, the Overseer
 * page and the Agents board still read org sessions.
 */
export const isOrdinarySession = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project"> & { archived?: boolean }): boolean =>
  isMainThread(s) && !isOrgSession(s) && (!isProjectOwned(s) || isArchivedStandaloneBuild(s));

/** Which of the pane's places a main thread lives in: org, then a project's (§app.projects/list), win over live, web and archived. A folder session's, and an archived standalone build's, is its ordinary place. */
export const sidebarRegion = (s: Pick<SessionSummary, "live" | "origin" | "archived" | "org" | "project">): "org" | "projects" | "top" | "archive" =>
  isOrgSession(s) ? "org" : isProjectOwned(s) && !isArchivedStandaloneBuild(s) ? "projects" : isTopSession(s) ? "top" : "archive";
