// The Overseer split button's ▾ list (§app.overseer/entry-button): one row per project of this
// computer whose overseer has started, by project name, each with at most one state in words. It
// reads the whole session list and this host's project list, never the search hits, so neither the
// query nor the host filter changes it.
//
// Pure on purpose, like `org-region`: the order, the org line, the state precedence, the current
// row and the ▾'s dot run under the unit tier; the sidebar only draws the result.

import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { overseerEye } from "./org-region";
import { byRecentActivity } from "./recent";

/** A row's one state: the project eye's mark (lib/org-region `overseerEye`), in words. */
export type OverseerMenuState = "working" | "error" | "unread";

export interface OverseerMenuRow {
  projectId: string;
  name: string;
  /** The organization that places it, or null for a standalone project. */
  org: string | null;
  /** The overseer's current conversation. */
  path: string;
  state: OverseerMenuState | null;
  /** Its conversation is the one open: tinted and checked, never "Last turn failed" or "New reply". */
  current: boolean;
}

export interface OverseerMenu {
  rows: OverseerMenuRow[];
  /** Rows with a new reply, and with a failed last turn: what ▾'s dot and name say. */
  unread: number;
  failed: number;
}

export const STATE_WORDS: Record<OverseerMenuState, string> = { working: "Working", error: "Last turn failed", unread: "New reply" };

/** The project a session is the current overseer conversation of, or null. */
function overseerOf(s: SessionSummary): string | null {
  if (s.org) return s.org.kind === "overseer" && !s.org.finished && s.org.projectId ? s.org.projectId : null;
  const p = s.project;
  return p && p.kind === "overseer" && !p.finished ? p.projectId : null;
}

/**
 * The list: every unarchived project in `projects` (this host's) whose current overseer
 * conversation is among `sessions`, by name (ties on id). Should two be current, the newest wins,
 * as on the project's heading.
 */
export function overseerMenu(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[] | null | undefined,
  input: { selected: string | null; busy(s: SessionSummary): boolean },
): OverseerMenu {
  const listed = new Map((projects ?? []).filter((p) => !p.archived).map((p) => [p.id, p]));
  const current = new Map<string, SessionSummary>();
  for (const s of sessions) {
    const id = overseerOf(s);
    if (!id || !listed.has(id)) continue;
    const had = current.get(id);
    if (!had || byRecentActivity(s, had) < 0) current.set(id, s);
  }
  const rows = [...current].map(([id, s]): OverseerMenuRow => {
    const p = listed.get(id)!;
    const eye = overseerEye(s, { selected: input.selected, busy: input.busy(s) });
    return { projectId: id, name: p.name, org: p.space.kind === "org" ? p.space.orgName : null, path: s.path, state: eye.mark, current: eye.current };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
  return { rows, unread: rows.filter((r) => r.state === "unread").length, failed: rows.filter((r) => r.state === "error").length };
}

/** ▾ is drawn only while the list has a row: it never opens onto nothing. */
export const hasOverseerRows = (m: OverseerMenu): boolean => m.rows.length > 0;

/** ▾'s accessible name and title: "Project overseers", and what its dot means in words. */
export function overseerMenuLabel(m: Pick<OverseerMenu, "unread" | "failed">): string {
  const parts = ["Project overseers"];
  if (m.unread) parts.push(m.unread === 1 ? "1 with a new reply" : `${m.unread} with new replies`);
  if (m.failed) parts.push(m.failed === 1 ? "1 with a failed last turn" : `${m.failed} with failed last turns`);
  return parts.join(" · ");
}

/** ▾'s dot: a new reply or a failed last turn somewhere in the list (Working never). */
export const overseerMenuDot = (m: Pick<OverseerMenu, "unread" | "failed">): boolean => m.unread + m.failed > 0;
