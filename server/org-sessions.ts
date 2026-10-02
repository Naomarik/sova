import { basename } from "node:path";
import type { BatonSession } from "../shared/baton";
import type { SessionOrg, SessionOrgRef } from "../shared/protocol";
import { allBatons, batonSummaryField, isRetiredBaton } from "./baton";
import { contributeSessions } from "./sessions-index";
import { buildMerged } from "./build-merged";
import { orgOfSessionPath, readIndex, readOrg, readProjects } from "./orgs";
import { readEngineBuilds, type BuildKind, type BuildRow } from "./build-loadout";
import { projectOverseerPaths, readPoMarker, readPoState } from "./project-overseer-store";

/**
 * Which sessions are ORGANIZATIONAL (§app.session-list/organizations), from the org's own records,
 * never from a folder:
 * - every file in an attached org's workspace `sessions/`: a registered baton session (its baton statechart),
 *   a project overseer's conversation (its marker, for THAT org; current or cleared per its project statechart),
 *   or an unregistered file ("other");
 * - every coding session a project's build statechart records (`coding` from its overseer,
 *   `operator-coding` from Start coding session), by session id.
 * A fork or copy of any of these has its own id and lives in the pi sessions dir, so it is ordinary;
 * so is a session the operator opens by hand in a project root, and everything of an org that is
 * not attached on this host.
 */

/** The build kinds that make a session one of the project's coding sessions. */
export const ORG_CODING_KINDS: ReadonlySet<BuildKind> = new Set(["coding", "operator-coding"]);

export interface OrgLookup {
  /** `SessionSummary.org` for a file and its session id, or undefined (ordinary). */
  of(path: string, id: string): SessionOrg | undefined;
}

const NONE: OrgLookup = { of: () => undefined };

/**
 * One lookup per listing: each org's names, batons, overseer states and builds are read at
 * most once, and only when a file needs them.
 */
export function orgLookup(): OrgLookup {
  const orgs = readIndex().orgs;
  if (!orgs.length) return NONE;
  const names = new Map<string, { orgName: string; projects: Map<string, string>; roots: Map<string, string>; archived: Set<string> }>();
  const namesOf = (orgId: string, dir: string) => {
    let n = names.get(orgId);
    if (!n) {
      let orgName = basename(dir);
      let projects = new Map<string, string>();
      let roots = new Map<string, string>();
      let archived = new Set<string>();
      try {
        orgName = readOrg(orgId).name;
      } catch {
        // no readable org.json: the folder's name
      }
      try {
        const listed = readProjects(orgId);
        projects = new Map(listed.map((p) => [p.id, p.name]));
        roots = new Map(listed.map((p) => [p.id, p.root]));
        archived = new Set(listed.filter((p) => p.archived).map((p) => p.id));
      } catch {
        // detached between reads
      }
      names.set(orgId, (n = { orgName, projects, roots, archived }));
    }
    return n;
  };
  const ref = (orgId: string, dir: string, projectId: string | undefined): SessionOrgRef => {
    const n = namesOf(orgId, dir);
    const projectName = projectId ? n.projects.get(projectId) : undefined;
    return {
      orgId,
      orgName: n.orgName,
      ...(projectId ? { projectId } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
      // The Organizations region leaves an archived project out (§app.organizations/archive).
      ...(projectId && n.archived.has(projectId) ? { projectArchived: true as const } : {}),
    };
  };

  let batons: Map<string, BatonSession> | null = null;
  const batonOf = (id: string) => (batons ??= new Map(allBatons().map((b) => [b.sessionId, b]))).get(id);

  const currents = new Map<string, string | null>();
  const currentOf = (orgId: string, projectId: string, dir: string): string | null => {
    const k = `${orgId}\0${projectId}`;
    if (!currents.has(k)) {
      let cur: string | null = null;
      try {
        cur = readPoState(projectOverseerPaths(projectId, dir))?.current ?? null;
      } catch {
        // not a store id shape
      }
      currents.set(k, cur);
    }
    return currents.get(k) ?? null;
  };

  let coding: Map<string, { orgId: string; dir: string; projectId: string; row: BuildRow }> | null = null;
  const codingOf = (id: string) => (coding ??= codingSessions(orgs)).get(id);

  return {
    of(path, id) {
      const ws = orgOfSessionPath(path);
      if (ws) {
        const b = batonOf(id);
        if (b && b.orgId === ws.orgId) {
          const finished = b.state === "done" || b.state === "closed";
          return { ...ref(ws.orgId, ws.dir, b.projectId), kind: b.offers?.length ? "offer" : "gathering", ...(finished ? { finished: true as const } : {}) };
        }
        // r11: a gathering its project retired is no longer organizational.
        if (isRetiredBaton(ws.orgId, id)) return undefined;
        // The marker names the project; a file past the state's history cap is still that project's
        // (cleared) conversation — it sits in the org's own workspace, where no fork is ever written.
        const m = readPoMarker(path);
        if (m && namesOf(ws.orgId, ws.dir).projects.has(m.projectId)) {
          const current = currentOf(ws.orgId, m.projectId, ws.dir) === id;
          return { ...ref(ws.orgId, ws.dir, m.projectId), kind: "overseer", ...(current ? {} : { finished: true as const }) };
        }
        return { ...ref(ws.orgId, ws.dir, undefined), kind: "other" };
      }
      const c = codingOf(id);
      if (!c) return undefined;
      // A build merged per git is finished: the Organizations region's Builds → Done.
      const merged = buildMerged(c.row, namesOf(c.orgId, c.dir).roots.get(c.projectId) ?? null);
      return { ...ref(c.orgId, c.dir, c.projectId), kind: "coding", ...(merged ? { finished: true as const } : {}) };
    },
  };
}

/** The ids of every attached org project's coding sessions (both kinds): Clean Up's husk sweep
    never deletes one, since a New Coding Session is empty until the operator writes in it. */
export function orgCodingIds(): Set<string> {
  const orgs = readIndex().orgs;
  return orgs.length ? new Set(codingSessions(orgs).keys()) : new Set();
}

/** Session id → project, for every build of the attached orgs (a project removed from the org's
    list keeps its builds, so its sessions stay organizational). */
function codingSessions(orgs: readonly { id: string; dir: string }[]): Map<string, { orgId: string; dir: string; projectId: string; row: BuildRow }> {
  const out = new Map<string, { orgId: string; dir: string; projectId: string; row: BuildRow }>();
  for (const o of orgs) {
    for (const r of readEngineBuilds(o.id)) if (ORG_CODING_KINDS.has(r.kind) && !out.has(r.sessionId)) out.set(r.sessionId, { orgId: o.id, dir: o.dir, projectId: r.projectId, row: r });
  }
  return out;
}

/** Whether one file is organizational (the group routes' refusal). */
export const isOrgSession = (path: string, id: string): boolean => orgLookup().of(path, id) !== undefined;

export const ORG_NOT_GROUPED = "Organization sessions stay with their project.";

// ---- what the org adds to the session list (server/sessions-index.ts) ---------------------------------------

contributeSessions({
  lookup() {
    const orgs = orgLookup();
    return {
      of(path, id) {
        const baton = batonSummaryField(path);
        const org = orgs.of(path, id);
        return baton || org ? { ...(baton ? { baton } : {}), ...(org ? { org } : {}) } : undefined;
      },
    };
  },
  // An attached org's workspace sessions (batons, project-overseer conversations) belong to the org: baton.json
  // and overseer state name them, so neither Clean Up nor an empty husk's archive ever deletes one.
  keeps: (path) => (orgOfSessionPath(path) ? "Belongs to an organization's workspace — Clean Up never deletes it." : null),
});
