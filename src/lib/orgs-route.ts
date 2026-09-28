// The organizations page (§app/organizations): `#/orgs` lists the orgs attached to this host,
// `#/orgs/<id>` shows one on its Sessions tab, `#/orgs/<id>/<tab>` on a tab (sessions, people,
// projects, workspace; §app.organizations/org-page), `#/orgs/<id>/start/<person id>` on Sessions
// with the start form open and aimed at that person (spawn-for-person, §app.organizations/referrals),
// `#/orgs/<id>/projects/<project id>` is one project (its decisions, §app/requirements) and `…/overseer` is that project's overseer
// (§app/project-overseer), and `#/orgs/<id>/people/<person id>` is one person's page
// (§app.organizations/person-page). Ids are the server's (`org_…`, `p_…`, uuid session ids): plain
// characters that never need encoding, so anything else in the hash is not this route.

import { hostOf, orgHostOf, sessionHrefOn } from "./mesh";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export const ORG_TABS = ["sessions", "people", "projects", "workspace"] as const;
export type OrgTab = (typeof ORG_TABS)[number];

/** `host`: the peer the org is attached on (`?host=<id>`, §mesh.remote-sessions/org-pages); absent here. */
export type OrgsRoute =
  | { kind: "list" }
  /** No tab = Sessions; `start` implies Sessions. */
  | { kind: "org"; id: string; start?: string; tab?: OrgTab; host?: string }
  | { kind: "project"; id: string; projectId: string; host?: string }
  | { kind: "person"; id: string; personId: string; host?: string }
  | { kind: "overseer"; id: string; projectId: string; host?: string };

export const ORGS_HREF = "#/orgs";

/** The route, with the org's host when the hash names one (`…?host=<id>`, never on the list). */
export function orgsRouteFromHash(hash: string): OrgsRoute | null {
  const q = /^(#\/orgs\/[^?]+)\?host=([^&]*)$/.exec(hash);
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

function hashRoute(hash: string): OrgsRoute | null {
  if (hash === ORGS_HREF || hash === `${ORGS_HREF}/`) return { kind: "list" };
  const t = /^#\/orgs\/([^/]+)\/(sessions|people|projects|workspace)\/?$/.exec(hash);
  if (t) return ID_RE.test(t[1]!) ? { kind: "org", id: t[1]!, tab: t[2] as OrgTab } : null;
  const pp = /^#\/orgs\/([^/]+)\/people\/([^/]+)\/?$/.exec(hash);
  if (pp) return ID_RE.test(pp[1]!) && ID_RE.test(pp[2]!) ? { kind: "person", id: pp[1]!, personId: pp[2]! } : null;
  const m = /^#\/orgs\/([^/]+)(?:\/(start|projects)\/([^/]+)(\/overseer)?)?\/?$/.exec(hash);
  if (!m || !ID_RE.test(m[1]!)) return null;
  const id = m[1]!;
  if (m[2] === undefined) return { kind: "org", id };
  if (!ID_RE.test(m[3]!)) return null;
  if (m[4] !== undefined && m[2] !== "projects") return null;
  switch (m[2]) {
    case "start":
      return { kind: "org", id, start: m[3]! };
    default:
      return m[4] ? { kind: "overseer", id, projectId: m[3]! } : { kind: "project", id, projectId: m[3]! };
  }
}

/** An address inside org `id`'s pages; an org on a peer carries its host, so a reload opens it there. */
const onHost = (id: string, tail: string): string => {
  const host = orgHostOf(id);
  return `${ORGS_HREF}/${id}${tail}${host ? `?host=${encodeURIComponent(host)}` : ""}`;
};
export const orgHref = (id: string): string => onHost(id, "");
/** One tab of an org's page. */
export const orgTabHref = (id: string, tab: OrgTab): string => onHost(id, `/${tab}`);
/** The org page with its start form aimed at one person. */
export const startForHref = (orgId: string, personId: string): string => onHost(orgId, `/start/${personId}`);
export const projectHref = (orgId: string, projectId: string): string => onHost(orgId, `/projects/${projectId}`);
/** One person's page. */
export const personHref = (orgId: string, personId: string): string => onHost(orgId, `/people/${personId}`);
/** A session an org's page links to, on the host that holds it: a peer's listed session by its
    path, else the org's own host (a session its page names before any list does). */
export const orgSessionHref = (orgId: string | undefined, path: string): string => sessionHrefOn(hostOf(path) ?? (orgId ? orgHostOf(orgId) : null), path);
export const projectOverseerHref = (orgId: string, projectId: string): string => onHost(orgId, `/projects/${projectId}/overseer`);

// "Start a session for Bob" from a baton session: the start form records that session as the new
// one's parent. The hash carries only the person; the parent rides along here, for the one
// navigation that set it (a reload or a typed hash starts without a parent, which is harmless).
let startParent: { orgId: string; personId: string; sessionId: string } | null = null;
export const rememberStartParent = (orgId: string, personId: string, sessionId: string): void => {
  startParent = { orgId, personId, sessionId };
};
/** The parent session for this start form, once: it clears on read. */
export function takeStartParent(orgId: string, personId: string): string | undefined {
  const p = startParent;
  startParent = null;
  return p && p.orgId === orgId && p.personId === personId ? p.sessionId : undefined;
}
