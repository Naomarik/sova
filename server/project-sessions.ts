import type { SessionProject } from "../shared/protocol";
import { readEngineBuilds, type BuildRow } from "./build-loadout";
import { buildMerged } from "./build-merged";
import { openEngineIds } from "./org-engine";
import { readPoMarker, readPoState } from "./project-overseer-store";
import { canonicalPath } from "./paths";
import { engineOf, isStandalone, listProjects, projectDir } from "./projects/spaces";
import { dirname, join } from "node:path";

/**
 * Which registered project a session file belongs to (§app/projects): its overseer's conversations (the
 * marker, in the `sessions/` of the engine that holds the project) and the coding sessions its builds name.
 * Read once per listing pass; nothing here is stored.
 */

const CODING_KINDS = new Set(["coding", "operator-coding"]);

export interface ProjectSessionLookup {
  of(path: string, id: string): SessionProject | undefined;
}

/** Session id → its build, in every open engine. */
function codingSessions(): Map<string, { projectId: string; row: BuildRow }> {
  const out = new Map<string, { projectId: string; row: BuildRow }>();
  for (const engine of openEngineIds()) for (const r of readEngineBuilds(engine)) if (CODING_KINDS.has(r.kind) && !out.has(r.sessionId)) out.set(r.sessionId, { projectId: r.projectId, row: r });
  return out;
}

/** The ids of every project's coding sessions (both kinds): Clean Up's husk sweep never deletes one, since a
    New Coding Session is empty until the operator writes in it. */
export const projectCodingIds = (): Set<string> => new Set(codingSessions().keys());

export function projectSessionLookup(): ProjectSessionLookup {
  const projects = new Map(listProjects().map((p) => [p.id, p]));
  if (!projects.size) return { of: () => undefined };
  let coding: Map<string, { projectId: string; row: BuildRow }> | null = null;
  const currents = new Map<string, string | null>();
  const currentOf = (projectId: string): string | null => {
    if (!currents.has(projectId)) currents.set(projectId, readPoState({ projectId })?.current ?? null);
    return currents.get(projectId) ?? null;
  };
  const ref = (projectId: string): Pick<SessionProject, "projectId" | "projectName" | "archived"> => {
    const p = projects.get(projectId)!;
    return { projectId, projectName: p.name, ...(p.archived ? { archived: true as const } : {}) };
  };
  return {
    of(path, id) {
      // The marker names the project; a file past the state's history cap is still its (cleared) conversation,
      // as long as it sits in the sessions dir of the engine that holds the project.
      const m = readPoMarker(path);
      if (m && projects.has(m.projectId)) {
        try {
          if (dirname(canonicalPath(path)) === canonicalPath(join(projectDir(m.projectId), "sessions")))
            return { ...ref(m.projectId), kind: "overseer", ...(currentOf(m.projectId) === id ? {} : { finished: true as const }) };
        } catch {
          // its engine closed between reads
        }
      }
      const c = (coding ??= codingSessions()).get(id);
      if (!c || !projects.has(c.projectId)) return undefined;
      // A build merged per git is finished.
      const merged = buildMerged(c.row, projects.get(c.projectId)!.root);
      return { ...ref(c.projectId), kind: "coding", ...(merged ? { finished: true as const } : {}) };
    },
  };
}

/** Why a session file may not be deleted (Clean Up, an empty husk's archive): it is a standalone project's
    overseer conversation, kept with the project; else null. */
export function projectKeeps(path: string): string | null {
  const m = readPoMarker(path);
  if (!m || !engineOf(m.projectId) || !isStandalone(m.projectId)) return null;
  try {
    return dirname(canonicalPath(path)) === canonicalPath(join(projectDir(m.projectId), "sessions")) ? "Belongs to a project — Clean Up never deletes it." : null;
  } catch {
    return null;
  }
}
