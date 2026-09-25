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
