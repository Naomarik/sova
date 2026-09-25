import { createSignal } from "solid-js";
import type { MeshInfo, MeshSessions, PeerStatus, SessionSummary, SyncCategory } from "../../shared/protocol";

// The client side of the peer mesh: which host a session lives on, and how a request for it
// reaches that host. A session is driven only by the host whose disk holds it, and the browser
// always talks to the host serving this page, which forwards `/peer/<id>/api/*` and
// `/peer/<id>/ws/*` to the peer. So routing a request is one prefix, chosen here.
//
// Everything is dormant until GET /api/mesh names a peer: with none, `hostOf` answers null for
// every path, no URL changes, and nothing polls.

export type { MeshCandidate, MeshInfo, MeshPeerEntry, MeshSessions, MeshSettings, PeerState, PeerStatus, SyncCategory, SyncStatus } from "../../shared/protocol";

export const SYNC_CATEGORIES: readonly SyncCategory[] = ["settings", "themes", "extensions", "logins"];

// ---- state ------------------------------------------------------------------------------------

const [state, setState] = createSignal<MeshInfo | null>(null);
/** The mesh as last read; null before the first answer, or when the server couldn't say (then the
    page is exactly as it is with the mesh off). */
export const meshState = state;
export const setMeshState = setState;

/** The peers the page may route to; empty means the mesh is off and nothing below does anything. */
export const meshPeers = (): PeerStatus[] => state()?.peers ?? [];
export const meshOn = (): boolean => meshPeers().length > 0;
export const peerInfo = (id: string): PeerStatus | undefined => meshPeers().find((p) => p.id === id);
/** What a host is called in the UI: its label, else its id. */
export const hostLabel = (id: string): string => peerInfo(id)?.label || id;
export const selfLabel = (): string => state()?.self.label || state()?.self.hostname || "This host";

/** A peer that can't be opened or driven right now, with the sentence that says why; null if it can. */
export function peerUnavailable(p: PeerStatus): string | null {
  const name = p.label || p.id;
  /** The server's reason as the end of our sentence: one full stop, whatever it brought. */
  const reason = p.error ? `: ${p.error.replace(/[.\s]+$/, "")}.` : ".";
  if (p.state === "up") return null;
  if (p.state === "down") return `${name} isn't answering${reason}`;
  if (p.state === "skewed") return `${name} runs a different Sova version${p.hello ? ` (${p.hello.version})` : ""}. Update one of them.`;
  return p.error ? `${name} refused this host${reason}` : `${name} refused this host. Add this host to its peers.`;
}

// ---- path → host --------------------------------------------------------------------------------

const hosts = new Map<string, string>();
/** Bumped when the map changes, so a row that reads `hostOf` re-renders with it. */
const [hostsVersion, setHostsVersion] = createSignal(0);

/** The peer a path lives on (a session file, a worker's session, an attachment), or null: here. */
export function hostOf(path: string): string | null {
  hostsVersion();
  return hosts.get(path) ?? null;
}

/** Record where `path` lives; `host` null forgets it (it is this host's). */
export function noteHost(path: string, host: string | null): void {
  if ((hosts.get(path) ?? null) === host) return;
  if (host) hosts.set(path, host);
  else hosts.delete(path);
  setHostsVersion((v) => v + 1);
}

/**
 * Record that `paths` live on `host`. Only ever adds: a path a peer's list leaves out may still be
 * its — a session just created there is not listed until its first message, and a link to one
 * names its host before any list arrives — and a path can't move between hosts (its name carries a
 * uuid), so a mapping that outlives its row is harmless.
 */
export function notePeerSessions(host: string, paths: readonly string[]): void {
  let changed = false;
  for (const p of paths) {
    if (hosts.get(p) !== host) {
      hosts.set(p, host);
      changed = true;
    }
  }
  if (changed) setHostsVersion((v) => v + 1);
}

/** Test hook: forget every path. */
export function resetHosts(): void {
  hosts.clear();
  setHostsVersion((v) => v + 1);
}

// ---- URLs ---------------------------------------------------------------------------------------

/** The prefix that sends a request to a peer through the serving host; "" for this host. */
export const peerBase = (host: string | null | undefined): string => (host ? `/peer/${encodeURIComponent(host)}` : "");

/** `url` sent to `host` (null: here). A URL already aimed at a peer is left alone. */
export const hostUrl = (host: string | null | undefined, url: string): string =>
  host && !url.startsWith("/peer/") ? `${peerBase(host)}${url}` : url;

/** The session-shaped paths a request names: its `path`/`draft` query and its JSON body's `path`/`paths`. */
export function pathsNamed(url: string, body?: unknown): string[] {
  const out: string[] = [];
  const q = url.indexOf("?");
  if (q >= 0) {
    const params = new URLSearchParams(url.slice(q + 1));
    for (const k of ["path", "draft"]) {
      const v = params.get(k);
      if (v) out.push(v);
    }
  }
  if (typeof body === "string" && body.startsWith("{")) {
    try {
      const b = JSON.parse(body) as { path?: unknown; paths?: unknown };
      if (typeof b.path === "string") out.push(b.path);
      if (Array.isArray(b.paths)) for (const p of b.paths) if (typeof p === "string") out.push(p);
    } catch {
      // not JSON after all: nothing named
    }
  }
  return out;
}

/**
 * Where an `/api/…` request goes: to the peer that holds the first path it names, else here. A
 * request naming paths on two different hosts can't be answered by either, so it stays here and
 * the serving host refuses it the way it refuses any path it doesn't hold.
 */
export function routeUrl(url: string, body?: unknown): string {
  if (!url.startsWith("/api/") || hosts.size === 0) return url;
  const named = pathsNamed(url, body);
  if (named.length === 0) return url;
  const first = hosts.get(named[0]!) ?? null;
  if (!named.every((p) => (hosts.get(p) ?? null) === first)) return url;
  return hostUrl(first, url);
}

// ---- hash route ---------------------------------------------------------------------------------

/** `#/s/<path>?host=<id>`: a peer's session. A local one keeps `#/s/<path>`, exactly as before.
    The path is encoded, so the first `?` is always ours. */
export function sessionHrefOn(host: string | null, path: string): string {
  return `#/s/${encodeURIComponent(path)}${host ? `?host=${encodeURIComponent(host)}` : ""}`;
}

/** The session a hash names and the host it lives on, or null when it names none. */
export function sessionRouteFromHash(hash: string): { host: string | null; path: string } | null {
  const m = /^#\/s\/([^?]+)(?:\?host=([^&]+))?$/.exec(hash);
  if (!m) return null;
  try {
    return { host: m[2] ? decodeURIComponent(m[2]) : null, path: decodeURIComponent(m[1]!) };
  } catch {
    return null;
  }
}

export const MESH_HREF = "#/mesh";
export const isMeshHash = (hash: string): boolean => hash === MESH_HREF || hash === `${MESH_HREF}/`;

// ---- the federated list ------------------------------------------------------------------------

/**
 * A peer's rows as this page lists them. Groups are per host, so a peer's `groupId` names a group
 * this sidebar has never heard of (and would go looking for): it is dropped here, and the row sits
 * with the ungrouped sessions.
 */
export function peerRows(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.map((s) => (s.groupId === undefined ? s : { ...s, groupId: undefined }));
}

/**
 * Each peer's rows. A peer that is down keeps its last rows (the server sends them as `stale`, and
 * a list this page already had stands in when it sends none), marked down by the sidebar rather
 * than vanishing. A peer no longer in peers.json is dropped.
 */
export function mergePeerLists(
  prev: ReadonlyMap<string, SessionSummary[]>,
  answer: MeshSessions,
  peers: readonly PeerStatus[],
): Map<string, SessionSummary[]> {
  const next = new Map<string, SessionSummary[]>();
  const listed = new Set(peers.map((p) => p.id));
  for (const p of answer.peers) {
    if (!listed.has(p.id)) continue;
    if (p.sessions) next.set(p.id, peerRows(p.sessions));
    else if (prev.has(p.id)) next.set(p.id, prev.get(p.id)!);
  }
  for (const id of listed) if (!next.has(id) && prev.has(id)) next.set(id, prev.get(id)!);
  return next;
}

// ---- the sidebar's host filter -----------------------------------------------------------------

/** Where the sidebar's host filter is remembered. Absent: All. */
export const HOST_FILTER_KEY = "sova:host-filter";
/** The stored value for the host serving this page. A peer id can't contain ":", so it can't collide. */
export const SELF_FILTER = ":self";

/** The filter only exists while the mesh is on with at least one peer: two hosts or more. */
export const hostFilterShown = (): boolean => !!meshState()?.enabled && meshPeers().length > 0;

/**
 * The filter in effect: the remembered one while it still names a known host, else null (All).
 * A host dropped from peers.json, or the mesh going off, reads as All without touching the store.
 */
export function effectiveHostFilter(stored: string | null, peers: readonly { id: string }[], shown: boolean): string | null {
  if (!shown || !stored) return null;
  if (stored === SELF_FILTER) return stored;
  return peers.some((p) => p.id === stored) ? stored : null;
}

/** Whether a session at `path` passes `filter` (null: every session passes). */
export function passesHostFilter(filter: string | null, path: string): boolean {
  if (filter === null) return true;
  const host = hostOf(path);
  return filter === SELF_FILTER ? host === null : host === filter;
}
