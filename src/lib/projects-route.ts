// The projects pages (§app/projects): `#/projects` lists the projects registered on this host (and
// the peers'), `#/projects/<id>` is one project on its Overview, `…/requirements`, `…/branches`,
// `…/merge-queue` (one of its tabs, `…/merge-queue/<tab>`, and one run of it, `…/merge-queue[/<tab>]/<run>`), `…/releases`, `…/cost` and `…/settings` on its other tabs (Requirements only while an organization places it), and
// `…/overseer` is that project's overseer (§app/project-overseer). `?host=<id>` names the peer that
// holds the project (§mesh.remote-sessions/org-pages). Ids are the server's (`prj_…`): plain
// characters that never need encoding, so anything else in the hash is not this route.

import { hostOf, projectHostOf, sessionHrefOn } from "./mesh";

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** A project page's tabs; Overview is the bare address. Requirements exists only while placed. */
export const PROJECT_TABS = ["overview", "requirements", "branches", "merge-queue", "releases", "cost", "settings"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

/**
 * The Merge Queue tab's own tabs, by the word each takes in the address; the first, Ready to land, is the bare
 * `…/merge-queue`. A run opened from a tab keeps that tab's word before its id, so Back to Queue returns there. The
 * words are fixed and carry no `_`, so none is ever a run's id (`mr_…`). A new tab adds its word here.
 */
export const QUEUE_TABS = ["ready", "needs-you", "with-its-chat", "waiting-on-host", "landed", "queue-chats"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
const QUEUE_TAB_WORDS: readonly string[] = QUEUE_TABS.slice(1);
const isQueueTab = (s: string): s is QueueTab => (QUEUE_TABS as readonly string[]).includes(s);

export type ProjectsRoute =
  | { kind: "list" }
  /** No tab = Overview. */
  | { kind: "project"; projectId: string; tab?: Exclude<ProjectTab, "overview">; host?: string; /** On the Merge Queue tab: one run's page. */ run?: string; /** On the Merge Queue tab: which of its tabs (absent: Ready to land). On a run's page: the tab it was opened from. */ queueTab?: QueueTab }
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
  const m = /^#\/projects\/([^/]+)(?:\/(requirements|branches|merge-queue|releases|cost|settings|overseer))?(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(hash);
  if (!m || !ID_RE.test(m[1]!)) return null;
  const projectId = m[1]!;
  // Only the Merge Queue tab has pages under it: one of its tabs by its word, one run by its id, or both (a run opened
  // from that tab).
  if (m[3] !== undefined) {
    if (m[2] !== "merge-queue") return null;
    // `ready` names Ready to land, whose address is the bare one: it is read as no tab (canonicalQueueHash drops it).
    const word = QUEUE_TAB_WORDS.includes(m[3]) ? (m[3] as QueueTab) : undefined;
    const named = word !== undefined || m[3] === "ready";
    if (!named && m[4] !== undefined) return null;
    const run = named ? m[4] : m[3];
    if (run !== undefined && (!ID_RE.test(run) || isQueueTab(run))) return null;
    return { kind: "project", projectId, tab: "merge-queue", ...(word ? { queueTab: word } : {}), ...(run ? { run } : {}) };
  }
  if (m[2] === undefined) return { kind: "project", projectId };
  if (m[2] === "overseer") return { kind: "overseer", projectId };
  return { kind: "project", projectId, tab: m[2] as Exclude<ProjectTab, "overview"> };
}

/** A typed or pasted `…/merge-queue/ready[/<run>]` as its one address, the bare `…/merge-queue[/<run>]`; null when
    the hash is already canonical. */
export function canonicalQueueHash(hash: string): string | null {
  const to = hash.replace(/^(#\/projects\/[^/?]+\/merge-queue)\/ready(?=[/?]|$)/, "$1");
  return to === hash ? null : to;
}

/** An address inside project `id`'s pages; a project on a peer carries its host, so a reload opens it there. */
const onHost = (id: string, tail: string): string => {
  const host = projectHostOf(id);
  return `${PROJECTS_HREF}/${id}${tail}${host ? `?host=${encodeURIComponent(host)}` : ""}`;
};
export const projectHref = (projectId: string): string => onHost(projectId, "");
/** One tab of a project's page; Overview is the bare project address. */
export const projectTabHref = (projectId: string, tab: ProjectTab): string => onHost(projectId, tab === "overview" ? "" : `/${tab}`);
/** One of the Merge Queue tab's tabs; Ready to land is the bare tab address. */
export const mergeQueueTabHref = (projectId: string, tab: QueueTab = "ready"): string => onHost(projectId, `/merge-queue${tab === "ready" ? "" : `/${tab}`}`);
/** One run of a project's merge queue: its steps, why each ran, and their logs. `from`: the queue's tab it is opened
    from, which its Back to Queue returns to (absent or Ready to land: the bare run address). */
export const mergeRunHref = (projectId: string, run: string, from?: QueueTab): string => onHost(projectId, `/merge-queue${from && from !== "ready" ? `/${from}` : ""}/${run}`);
export const projectOverseerHref = (projectId: string): string => onHost(projectId, "/overseer");
/** A session a project's page links to, on the host that holds it: a peer's listed session by its
    path, else the project's own host (a session its page names before any list does). */
export const projectSessionHref = (projectId: string, path: string): string => sessionHrefOn(hostOf(path) ?? projectHostOf(projectId), path);
