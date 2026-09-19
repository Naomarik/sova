import type { SessionSummary } from "../../shared/protocol";

/**
 * Sidebar pane rule (shared/protocol.ts, DESIGN_NOTES §2 "Regions"): live sessions always stay on
 * top, and so do web-spawned ones until the user archives them; the rest is archive. A server
 * that predates `origin` or `archived` sends none, which counts as external and not archived.
 */
export const isTopSession = (s: Pick<SessionSummary, "live" | "origin" | "archived">): boolean =>
  s.live !== null || (s.origin === "web" && s.archived !== true);
