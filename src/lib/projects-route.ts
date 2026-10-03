// The projects pages (§app/projects): `#/projects` lists the projects registered on this host (and
// the peers'), `#/projects/<id>` is one project on its Overview, `…/requirements`, `…/branches`, `…/cost`
// and `…/settings` on its other tabs (Requirements only while an organization places it), and
// `…/overseer` is that project's overseer (§app/project-overseer). `?host=<id>` names the peer that
// holds the project (§mesh.remote-sessions/org-pages). Ids are the server's (`prj_…`): plain
// characters that never need encoding, so anything else in the hash is not this route.

import { hostOf, projectHostOf, sessionHrefOn } from "./mesh";

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** A project page's tabs; Overview is the bare address. Requirements exists only while placed. */
export const PROJECT_TABS = ["overview", "requirements", "branches", "cost", "settings"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type ProjectsRoute =
  | { kind: "list" }
  /** No tab = Overview. */
  | { kind: "project"; projectId: string; tab?: Exclude<ProjectTab, "overview">; host?: string }
  | { kind: "overseer"; projectId: string; host?: string };

export const PROJECTS_HREF = "#/projects";

/** The route, with the project's host when the hash names one (`…?host=<id>`, never on the list). */
export function projectsRouteFromHash(hash: string): ProjectsRoute | null {
  const q = /^(#\/projects\/[^?]+)\?host=([^&]*)$/.exec(hash);
  if (!q) return hashRoute(hash);
  let host = "";
  try {
    host = decodeURIComponent(q[2]!);
  } catch {
    return null;
  }
  const r = hashRoute(q[1]!);
  return host && r && r.kind !== "list" ? { ...r, host } : null;
}

function hashRoute(hash: string): ProjectsRoute | null {
  if (hash === PROJECTS_HREF || hash === `${PROJECTS_HREF}/`) return { kind: "list" };
  const m = /^#\/projects\/([^/]+)(?:\/(requirements|branches|cost|settings|overseer))?\/?$/.exec(hash);
  if (!m || !ID_RE.test(m[1]!)) return null;
  const projectId = m[1]!;
  if (m[2] === undefined) return { kind: "project", projectId };
  if (m[2] === "overseer") return { kind: "overseer", projectId };
  return { kind: "project", projectId, tab: m[2] as Exclude<ProjectTab, "overview"> };
}

/** An address inside project `id`'s pages; a project on a peer carries its host, so a reload opens it there. */
const onHost = (id: string, tail: string): string => {
  const host = projectHostOf(id);
  return `${PROJECTS_HREF}/${id}${tail}${host ? `?host=${encodeURIComponent(host)}` : ""}`;
};
export const projectHref = (projectId: string): string => onHost(projectId, "");
/** One tab of a project's page; Overview is the bare project address. */
export const projectTabHref = (projectId: string, tab: ProjectTab): string => onHost(projectId, tab === "overview" ? "" : `/${tab}`);
export const projectOverseerHref = (projectId: string): string => onHost(projectId, "/overseer");
/** A session a project's page links to, on the host that holds it: a peer's listed session by its
    path, else the project's own host (a session its page names before any list does). */
export const projectSessionHref = (projectId: string, path: string): string => sessionHrefOn(hostOf(path) ?? projectHostOf(projectId), path);
