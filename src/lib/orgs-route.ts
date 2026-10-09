// The organizations page (§app/organizations): `#/orgs` lists the orgs attached to this host,
// `#/orgs/<id>` shows one on its Sessions tab, `#/orgs/<id>/<tab>` on a tab (sessions, people,
// projects, workspace; §app.organizations/org-page), `#/orgs/<id>/start/<person id>` on Sessions
// with the start form open and aimed at that person (spawn-for-person, §app.organizations/referrals),
// and `#/orgs/<id>/people/<person id>` is one person's page (§app.organizations/person-page). A
// project's page is `#/projects/<id>` (lib/projects-route), placed or not. Ids are the server's (`org_…`, `p_…`, uuid session ids): plain
// characters that never need encoding, so anything else in the hash is not this route.

import { hostOf, orgHostOf, sessionHrefOn } from "./mesh";
import { historyQueryOf, historyTailOf, historyViewOf, type HistoryView } from "./org-history-route";

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** In the strip's order: History after Projects, before Workspace. The History tab's own address and
    filters are lib/org-history-route's. */
export const ORG_TABS = ["sessions", "people", "projects", "history", "workspace"] as const;
export type OrgTab = (typeof ORG_TABS)[number];

/** `host`: the peer the org is attached on (`?host=<id>`, §mesh.remote-sessions/org-pages); absent here. */
export type OrgsRoute =
  | { kind: "list" }
  /** No tab = Sessions; `start` implies Sessions. `history` is set exactly when `tab` is "history". */
  | { kind: "org"; id: string; start?: string; tab?: OrgTab; host?: string; history?: HistoryView }
  | { kind: "person"; id: string; personId: string; host?: string };

export const ORGS_HREF = "#/orgs";

/** The route, with the org's host when the hash names one (`…?host=<id>`, never on the list). Only
    the History tab takes more of a query (its filters, lib/org-history-route); anywhere else a query
    other than `host=` is no route. */
export function orgsRouteFromHash(hash: string): OrgsRoute | null {
  const qi = hash.indexOf("?");
  if (qi < 0) return hashRoute(hash);
  const path = hash.slice(0, qi);
  const query = hash.slice(qi + 1);
  const hist = /^#\/orgs\/([^/?]+)\/history(\/.*)?$/.exec(path);
  if (hist) {
    const params = new URLSearchParams(query);
    const r = historyRoute(hist[1]!, hist[2] ?? "", params);
    if (!r || !params.has("host")) return r;
    const host = params.get("host")!;
    return host ? { ...r, host } : null;
  }
  const q = /^(#\/orgs\/[^?]+)\?host=([^&]*)$/.exec(hash);
  if (!q) return null;
  let host = "";
  try {
    host = decodeURIComponent(q[2]!);
  } catch {
    return null;
  }
  const r = hashRoute(q[1]!);
  return host && r && r.kind !== "list" ? { ...r, host } : null;
}

function historyRoute(id: string, tail: string, params: URLSearchParams): Extract<OrgsRoute, { kind: "org" }> | null {
  if (!ID_RE.test(id)) return null;
  const history = historyViewOf(tail, params);
  return history ? { kind: "org", id, tab: "history", history } : null;
}

function hashRoute(hash: string): OrgsRoute | null {
  if (hash === ORGS_HREF || hash === `${ORGS_HREF}/`) return { kind: "list" };
  const h = /^#\/orgs\/([^/]+)\/history(\/.*)?$/.exec(hash);
  if (h) return historyRoute(h[1]!, h[2] ?? "", new URLSearchParams());
  const t = /^#\/orgs\/([^/]+)\/(sessions|people|projects|workspace)\/?$/.exec(hash);
  if (t) return ID_RE.test(t[1]!) ? { kind: "org", id: t[1]!, tab: t[2] as OrgTab } : null;
  const pp = /^#\/orgs\/([^/]+)\/people\/([^/]+)\/?$/.exec(hash);
  if (pp) return ID_RE.test(pp[1]!) && ID_RE.test(pp[2]!) ? { kind: "person", id: pp[1]!, personId: pp[2]! } : null;
  const m = /^#\/orgs\/([^/]+)(?:\/start\/([^/]+))?\/?$/.exec(hash);
  if (!m || !ID_RE.test(m[1]!)) return null;
  const id = m[1]!;
  if (m[2] === undefined) return { kind: "org", id };
  return ID_RE.test(m[2]) ? { kind: "org", id, start: m[2] } : null;
}

/** An address inside org `id`'s pages; an org on a peer carries its host, so a reload opens it there. */
const onHost = (id: string, tail: string): string => {
  const host = orgHostOf(id);
  return `${ORGS_HREF}/${id}${tail}${host ? `?host=${encodeURIComponent(host)}` : ""}`;
};
export const orgHref = (id: string): string => onHost(id, "");
/** One tab of an org's page. */
export const orgTabHref = (id: string, tab: OrgTab): string => onHost(id, `/${tab}`);
/** The History tab at one view: its selected event and filters in the address, the host last. */
export function orgHistoryHref(id: string, view: HistoryView): string {
  const host = orgHostOf(id);
  const query = [historyQueryOf(view), host ? `host=${encodeURIComponent(host)}` : ""].filter(Boolean).join("&");
  return `${ORGS_HREF}/${id}/history${historyTailOf(view)}${query ? `?${query}` : ""}`;
}
/** The org page with its start form aimed at one person. */
export const startForHref = (orgId: string, personId: string): string => onHost(orgId, `/start/${personId}`);
/** One person's page. */
export const personHref = (orgId: string, personId: string): string => onHost(orgId, `/people/${personId}`);
/** A session an org's page links to, on the host that holds it: a peer's listed session by its
    path, else the org's own host (a session its page names before any list does). */
export const orgSessionHref = (orgId: string | undefined, path: string): string => sessionHrefOn(hostOf(path) ?? (orgId ? orgHostOf(orgId) : null), path);

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
