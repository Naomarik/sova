// The organizations page (§app/organizations): `#/orgs` lists the orgs attached to this host,
// `#/orgs/<id>` shows one, `#/orgs/<id>/start/<person id>` shows it with the start form aimed at
// that person (spawn-for-person, §app.organizations/referrals), `#/orgs/<id>/replay/<session id>`
// plays one of its baton sessions back (§app.baton/replay), `#/orgs/<id>/projects/<project id>`
// is one project (its decisions, §app/requirements) and `…/overseer` is that project's overseer
// (§app/project-overseer). Ids are the server's (`org_…`, `p_…`, uuid session ids): plain
// characters that never need encoding, so anything else in the hash is not this route.

const ID_RE = /^[A-Za-z0-9_-]+$/;

export type OrgsRoute =
  | { kind: "list" }
  | { kind: "org"; id: string; start?: string }
  | { kind: "replay"; id: string; sessionId: string }
  | { kind: "project"; id: string; projectId: string }
  | { kind: "overseer"; id: string; projectId: string };

export const ORGS_HREF = "#/orgs";

export function orgsRouteFromHash(hash: string): OrgsRoute | null {
  if (hash === ORGS_HREF || hash === `${ORGS_HREF}/`) return { kind: "list" };
  const m = /^#\/orgs\/([^/]+)(?:\/(replay|start|projects)\/([^/]+)(\/overseer)?)?\/?$/.exec(hash);
  if (!m || !ID_RE.test(m[1]!)) return null;
  const id = m[1]!;
  if (m[2] === undefined) return { kind: "org", id };
  if (!ID_RE.test(m[3]!)) return null;
  if (m[4] !== undefined && m[2] !== "projects") return null;
  switch (m[2]) {
    case "replay":
      return { kind: "replay", id, sessionId: m[3]! };
    case "start":
      return { kind: "org", id, start: m[3]! };
    default:
      return m[4] ? { kind: "overseer", id, projectId: m[3]! } : { kind: "project", id, projectId: m[3]! };
  }
}

export const orgHref = (id: string): string => `${ORGS_HREF}/${id}`;
export const replayHref = (orgId: string, sessionId: string): string => `${ORGS_HREF}/${orgId}/replay/${sessionId}`;
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
