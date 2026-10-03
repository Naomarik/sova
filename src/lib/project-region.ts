// The sidebar's Projects region (§app.projects/list, §app.session-list): every standalone project's
// sessions (`SessionSummary.project` with no `org`), and only here. Shaped as one organization's
// project blocks in the Organizations region: each project's heading with its overseer's eye, then
// its Builds (active, then a Done tail). A placed project's sessions stay in the Organizations region.
//
// Pure on purpose, like `org-region`: the grouping, order and counts run under tsx --test.

import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { byRecentActivity } from "./recent";

/** Open by default; a collapse is remembered for the tab (the Organizations pattern). */
export const PROJECTS_KEY = "sova:projects-open";

export interface ProjectBlock {
  id: string;
  name: string;
  /** The current overseer conversation, drawn as the eye on the heading, never as a row. */
  overseer: SessionSummary | null;
  /** Coding sessions: running or waiting, then Done (merged per git, or archived). */
  builds: { active: SessionSummary[]; done: SessionSummary[] };
}

/** A standalone project's session (any kind): the Projects region's, and no ordinary surface's. */
export const isStandaloneProjectSession = (s: Pick<SessionSummary, "project" | "org">): boolean => !!s.project && !s.org;

/** What the region lists: a standalone project's sessions but its cleared overseer conversations (its History has them). */
export const inProjectsRegion = (s: Pick<SessionSummary, "project" | "org">): boolean => isStandaloneProjectSession(s) && !(s.project!.kind === "overseer" && s.project!.finished);

/** Done: a build merged per git, or one the operator archived. */
const projectDone = (s: Pick<SessionSummary, "project" | "archived">): boolean => !!s.project?.finished || s.archived === true;

/**
 * The region's blocks, by project name: every standalone project that is registered and not
 * archived (`projects`, when read) or that has a session in `sessions`. A project with neither is
 * not listed; an archived project's sessions are left out with it.
 */
export function projectBlocks(sessions: readonly SessionSummary[], projects?: readonly ProjectSummary[]): ProjectBlock[] {
  const blocks = new Map<string, ProjectBlock>();
  const block = (id: string, name: string) => {
    let b = blocks.get(id);
    if (!b) blocks.set(id, (b = { id, name, overseer: null, builds: { active: [], done: [] } }));
    return b;
  };
  const archived = new Set((projects ?? []).filter((p) => p.archived || p.space.kind !== "standalone").map((p) => p.id));
  for (const p of projects ?? []) if (!archived.has(p.id)) block(p.id, p.name);
  for (const s of sessions) {
    const p = s.project;
    if (!p || s.org || archived.has(p.projectId) || p.archived) continue;
    const b = block(p.projectId, blocks.get(p.projectId)?.name ?? p.projectName ?? p.projectId);
    if (p.kind === "overseer") {
      if (!p.finished) b.overseer = s;
    } else (projectDone(s) ? b.builds.done : b.builds.active).push(s);
  }
  const out = [...blocks.values()];
  for (const b of out) {
    b.builds.active.sort(byRecentActivity);
    b.builds.done.sort(byRecentActivity);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The region's count: its rows (a project's eye is not one). */
export const projectRowCount = (blocks: readonly ProjectBlock[]): number => blocks.reduce((n, b) => n + b.builds.active.length + b.builds.done.length, 0);
