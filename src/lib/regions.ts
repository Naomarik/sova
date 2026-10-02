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
 * The one check every ordinary surface reads (Recent, Needs you, Groups, Live & web, the Archive and
 * its cleanup, recent folders, the overview): a main thread that no organization and no registered
 * project owns (a standalone project's sessions are the Projects region's). It is NOT
 * folded into `isMainThread`, because the Organizations region, the Overseer page and the Agents
 * board still read org sessions.
 */
export const isOrdinarySession = (s: Pick<SessionSummary, "workerSession" | "overseer" | "org" | "project">): boolean => isMainThread(s) && !isOrgSession(s) && !s.project;

/** Which of the pane's places a main thread lives in: org, then a project's (§app.projects/list), win over live, web and archived. */
export const sidebarRegion = (s: Pick<SessionSummary, "live" | "origin" | "archived" | "org" | "project">): "org" | "projects" | "top" | "archive" =>
  isOrgSession(s) ? "org" : s.project ? "projects" : isTopSession(s) ? "top" : "archive";
