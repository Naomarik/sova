import { createSignal } from "solid-js";
import { groupHref } from "./group-route";

/**
 * In-app session links in markdown. The Overseer names sessions as `sova://s/<id>`: an id is what
 * every tool returns and what archive, groups and titles key on, and it is a fraction of a path's
 * length. The client resolves the id to the session's route from the list it already polls, so a
 * link opens in the same tab.
 * An id the list doesn't carry is NOT proof the session is gone (the list omits sessions with no
 * user message, like an empty one waiting on a dialog), so it still links, by id (`#/sid/<id>`),
 * and App asks the server; only the server's "not found" says gone.
 *
 * Workspaces link the same way: `sova://g/<groupId>` opens the group, `sova://g/<groupId>/s/<id>`
 * opens it with that session's pane focused (the group alone when the session can't be resolved).
 * A group this tab knows nothing about renders as its link text only.
 *
 * A same-origin `#/…` route is also an in-app link (a message may name a workspace or a page).
 */

const SESSION_LINK = /^sova:\/\/s\/([A-Za-z0-9_.:-]+)\/?$/;

const GROUP_LINK = /^sova:\/\/g\/([A-Za-z0-9_.:-]+)(?:\/s\/([A-Za-z0-9_.:-]+))?\/?$/;

/** The group (and optional session) a `sova://g/<id>[/s/<sid>]` href names, else null. */
export function groupLinkIds(href: string): { group: string; session: string | null } | null {
  const m = GROUP_LINK.exec(href.trim());
  return m ? { group: m[1]!, session: m[2] ?? null } : null;
}

/** The session id a `sova://s/<id>` href names, else null. */
export function sessionLinkId(href: string): string | null {
  return SESSION_LINK.exec(href.trim())?.[1] ?? null;
}

/** A same-origin route (`#/s/…`, `#/g/…`, `#/usage`…): opens in this tab. */
export const isAppRoute = (href: string): boolean => /^#\/[^\s"'<>]*$/.test(href);

export interface LinkedSession {
  path: string;
  title: string;
}

/** What an in-app link renders as: a route to follow (with a title when known), or its text alone. */
export type SessionLinkView = { kind: "route"; href: string; title?: string } | { kind: "text" };

/**
 * How an href renders, given the id→session index: null when it is not an in-app link at all
 * (the caller's own rules then decide — external links stay external).
 */
export function resolveAppLink(
  href: string,
  index: ReadonlyMap<string, LinkedSession> | null,
  groups: ReadonlyMap<string, string> | null = null,
): SessionLinkView | null {
  const g = groupLinkIds(href);
  if (g) {
    // Groups not loaded yet: link anyway, and the workspace route's own recheck decides.
    const name = groups ? groups.get(g.group) : undefined;
    if (groups && name === undefined) return { kind: "text" };
    const s = g.session ? index?.get(g.session) : undefined;
    return { kind: "route", href: groupHref(g.group, s?.path ?? null), ...(name ? { title: name } : {}) };
  }
  const id = sessionLinkId(href);
  if (id) {
    const s = index?.get(id);
    // Unlisted, or the list not loaded yet: link by id and let App's `#/sid/` route resolve it.
    if (!s) return { kind: "route", href: `#/sid/${encodeURIComponent(id)}` };
    return { kind: "route", href: `#/s/${encodeURIComponent(s.path)}`, title: s.title };
  }
  if (isAppRoute(href)) return { kind: "route", href };
  return null;
}

/** `#/sid/<id>`: the route a session link takes before the list is known; App swaps it for `#/s/<path>`. */
export function sessionIdFromHash(hash: string): string | null {
  const m = /^#\/sid\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

// The index the markdown renderer reads. Module state because the renderer is a module-level
// markdown-it instance; the version signal is what re-renders a message that holds a session link.
let index: Map<string, LinkedSession> | null = null;
const [version, setVersion] = createSignal(0);
export const sessionIndexVersion = version;
export const sessionIndex = (): ReadonlyMap<string, LinkedSession> | null => index;

// The groups the renderer resolves `sova://g/` against, null until loaded; same version signal.
let groupIndex: Map<string, string> | null = null;
export const groupLinkIndex = (): ReadonlyMap<string, string> | null => groupIndex;

/** Called by App whenever the group list changes. */
export function setGroupLinkIndex(list: readonly { id: string; name: string }[]): void {
  const next = new Map(list.map((g) => [g.id, g.name]));
  if (groupIndex && groupIndex.size === next.size && [...next].every(([id, name]) => groupIndex!.get(id) === name)) return;
  groupIndex = next;
  setVersion((v) => v + 1);
}

/** Called by App with every list load. Only a change of ids, paths or titles bumps the version. */
export function setSessionIndex(list: readonly { id: string; path: string; title: string }[]): void {
  const next = new Map(list.map((s) => [s.id, { path: s.path, title: s.title }]));
  if (index && sameIndex(index, next)) return;
  index = next;
  setVersion((v) => v + 1);
}

function sameIndex(a: Map<string, LinkedSession>, b: Map<string, LinkedSession>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, s] of a) {
    const o = b.get(id);
    if (!o || o.path !== s.path || o.title !== s.title) return false;
  }
  return true;
}
