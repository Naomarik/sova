// The sidebar's Projects region (§app.projects/list, §app.session-list): every standalone project's
// sessions (`SessionSummary.project` with no `org`), its builds and overseer only here, the sessions in its folder
// here and not in Folders (the shortcut surfaces and the Archive still list them). Shaped as one organization's
// project blocks in the Organizations region: each project's heading with its overseer's eye, then
// its Sessions (active, then a Done tail). An archived session is never here: it is the Archive's. A placed project's sessions stay in the Organizations region.
//
// Pure on purpose, like `org-region`: the grouping, order and counts run under tsx --test.

import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { byRecentActivity } from "./recent";
import { isTopSession } from "./regions";

/** Open by default; a collapse is remembered for the tab (the Organizations pattern). */
export const PROJECTS_KEY = "sova:projects-open";

export interface ProjectBlock {
  id: string;
  name: string;
  /** The current overseer conversation, drawn as the eye on the heading, never as a row. */
  overseer: SessionSummary | null;
  /** Coding sessions it started and the sessions in its folder, none archived: running or waiting, then Done (a build
      merged per git; a folder session that is neither live nor a web session). */
  builds: { active: SessionSummary[]; done: SessionSummary[] };
}

/** A standalone project's session (any kind; a placed project's folder session carries `folderOrg`): the Projects region's. */
export const isStandaloneProjectSession = (s: Pick<SessionSummary, "project" | "org" | "folderOrg">): boolean => !!s.project && !s.org && !s.folderOrg;

/** What the region lists: a standalone project's sessions but its cleared overseer conversations (its History has them)
    and its archived sessions (the Archive has them; the overseer's eye stays). */
export const inProjectsRegion = (s: Pick<SessionSummary, "project" | "org" | "folderOrg"> & { archived?: boolean }): boolean =>
  isStandaloneProjectSession(s) && (s.project!.kind === "overseer" ? !s.project!.finished : s.archived !== true);

/** What the region lists on this computer: `inProjectsRegion`, but never a mesh peer's folder session (`here` false): that
    one carries the peer's own `project` and stays in Folders (§app.projects/folder-sessions). */
export const inLocalProjectsRegion = (s: Pick<SessionSummary, "project" | "org" | "folderOrg"> & { archived?: boolean }, here: boolean): boolean =>
  inProjectsRegion(s) && (here || s.project!.kind !== "folder");

/** Done, for a row that isn't archived (an archived one is in no block): a build merged per git; a folder session that is
    neither live nor a web session. */
export const projectDone = (s: Pick<SessionSummary, "project" | "archived" | "live" | "origin">): boolean =>
  s.project?.kind === "folder" ? !isTopSession(s) : !!s.project?.finished;

/**
 * The region's blocks, by project name: every standalone project that is registered and not
 * archived (`projects`, when read) or that has a session in `sessions`. A project with neither is
 * not listed; an archived project's sessions are left out with it, and so is every archived session (the Archive's).
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
    if (!p || s.org || s.folderOrg || archived.has(p.projectId) || p.archived) continue;
    if (p.kind !== "overseer" && s.archived === true) continue; // the Archive's, never a block's row
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

/** A project heading's count: its open rows (running or waiting); Done counts its own, and the eye is not a row. */
export const projectOpenCount = (b: ProjectBlock): number => b.builds.active.length;

