// The organizations page (§app/organizations): `#/orgs` lists the orgs attached to this host,
// `#/orgs/<id>` shows one on its Sessions tab, `#/orgs/<id>/<tab>` on a tab (sessions, people,
// projects, workspace; §app.organizations/org-page), `#/orgs/<id>/start/<person id>` on Sessions
// with the start form open and aimed at that person (spawn-for-person, §app.organizations/referrals),
// `#/orgs/<id>/projects/<project id>` is one project (its decisions, §app/requirements) and `…/overseer` is that project's overseer
// (§app/project-overseer). Ids are the server's (`org_…`, `p_…`, uuid session ids): plain
// characters that never need encoding, so anything else in the hash is not this route.

const ID_RE = /^[A-Za-z0-9_-]+$/;

export const ORG_TABS = ["sessions", "people", "projects", "workspace"] as const;
export type OrgTab = (typeof ORG_TABS)[number];

export type OrgsRoute =
  | { kind: "list" }
  /** No tab = Sessions; `start` implies Sessions. */
  | { kind: "org"; id: string; start?: string; tab?: OrgTab }
  | { kind: "project"; id: string; projectId: string }
  | { kind: "overseer"; id: string; projectId: string };

export const ORGS_HREF = "#/orgs";

export function orgsRouteFromHash(hash: string): OrgsRoute | null {
  if (hash === ORGS_HREF || hash === `${ORGS_HREF}/`) return { kind: "list" };
  const t = /^#\/orgs\/([^/]+)\/(sessions|people|projects|workspace)\/?$/.exec(hash);
  if (t) return ID_RE.test(t[1]!) ? { kind: "org", id: t[1]!, tab: t[2] as OrgTab } : null;
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

export const orgHref = (id: string): string => `${ORGS_HREF}/${id}`;
/** One tab of an org's page. */
export const orgTabHref = (id: string, tab: OrgTab): string => `${orgHref(id)}/${tab}`;
/** The org page with its start form aimed at one person. */
export const startForHref = (orgId: string, personId: string): string => `${ORGS_HREF}/${orgId}/start/${personId}`;
export const projectHref = (orgId: string, projectId: string): string => `${ORGS_HREF}/${orgId}/projects/${projectId}`;
export const projectOverseerHref = (orgId: string, projectId: string): string => `${projectHref(orgId, projectId)}/overseer`;

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
