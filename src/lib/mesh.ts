import { createSignal } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";

// The client side of the peer mesh: which host a session lives on, and how a request for it
// reaches that host. A session is driven only by the host whose disk holds it, and the browser
// always talks to the host serving this page, which forwards `/peer/<id>/api/*` and
// `/peer/<id>/ws/*` to the peer. So routing a request is one prefix, chosen here.
//
// Everything is dormant until GET /api/mesh names a peer: with none, `hostOf` answers null for
// every path, no URL changes, and nothing polls.

/** A category of state the mesh can keep in step between hosts. */
export type SyncCategory = "settings" | "themes" | "extensions" | "logins";
export const SYNC_CATEGORIES: readonly SyncCategory[] = ["settings", "themes", "extensions", "logins"];

export type PeerStatus = "up" | "down" | "skewed" | "refused";

/** One entry of peers.json as the serving host sees it now. */
export interface PeerInfo {
  id: string;
  label: string;
  /** Its tailnet name (MagicDNS) or address, as peers.json has it. */
  node: string;
  status: PeerStatus;
  /** When it last answered, ms epoch; null if it never has. */
  lastSeen: number | null;
  /** Why it is down, skewed or refusing us, as a sentence. */
  error?: string;
  hello?: { version: string; protocol: string; hostname: string };
}

export interface SyncStatus {
  category: SyncCategory;
  enabled: boolean;
  state: "ok" | "pending" | "error" | "off";
  lastAt: number | null;
  error?: string;
}

/** GET /api/mesh: this host, its peers and what syncs. */
export interface MeshState {
  self: { id: string; label: string; node?: string };
  peers: PeerInfo[];
  sync: SyncStatus[];
  frontDoor: string | null;
}

/** GET/PUT /api/mesh/settings: Settings → Mesh. */
export interface MeshSettings {
  hostLabel: string;
  sync: Record<SyncCategory, boolean>;
  frontDoor: string | null;
}

/** A tailnet node the serving host can see, offered on #/mesh as a peer to add. */
export interface MeshCandidate {
  name: string;
  node: string;
  online: boolean;
  /** What it said to `hello`, or null when it isn't running Sova (or didn't answer). */
  sova: { version: string; hostname: string } | null;
}

/** GET /api/mesh/sessions: each peer's own session list, fetched through the proxy. */
export interface MeshSessions {
  peers: { id: string; status: PeerStatus; sessions?: SessionSummary[]; error?: string }[];
}

// ---- state ------------------------------------------------------------------------------------

const [state, setState] = createSignal<MeshState | null>(null);
/** The mesh as last read; null before the first answer or when the server has no mesh routes. */
export const meshState = state;
export const setMeshState = setState;

/** The peers the page may route to; empty means the mesh is off and nothing below does anything. */
export const meshPeers = (): PeerInfo[] => state()?.peers ?? [];
export const meshOn = (): boolean => meshPeers().length > 0;
export const peerInfo = (id: string): PeerInfo | undefined => meshPeers().find((p) => p.id === id);
/** What a host is called in the UI: its label, else its id. */
export const hostLabel = (id: string): string => peerInfo(id)?.label || id;
export const selfLabel = (): string => state()?.self.label || state()?.self.id || "This host";

/** A peer that can't be opened or driven right now, with the sentence that says why; null if it can. */
export function peerUnavailable(p: PeerInfo): string | null {
  const name = p.label || p.id;
  /** The server's reason as the end of our sentence: one full stop, whatever it brought. */
  const reason = p.error ? `: ${p.error.replace(/[.\s]+$/, "")}.` : ".";
  if (p.status === "up") return null;
  if (p.status === "down") return `${name} isn't answering${reason}`;
  if (p.status === "skewed") return `${name} runs a different Sova version${p.hello ? ` (${p.hello.version})` : ""}. Update one of them.`;
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

/** `#/p/<host>/s/<path>`: a peer's session. A local one keeps `#/s/<path>`, exactly as before. */
export function sessionHrefOn(host: string | null, path: string): string {
  return host ? `#/p/${encodeURIComponent(host)}/s/${encodeURIComponent(path)}` : `#/s/${encodeURIComponent(path)}`;
}

/** The session a hash names and the host it lives on, or null when it names none. */
export function sessionRouteFromHash(hash: string): { host: string | null; path: string } | null {
  const m = /^#\/(?:p\/([^/]+)\/)?s\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return { host: m[1] ? decodeURIComponent(m[1]) : null, path: decodeURIComponent(m[2]!) };
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
 * Remember each peer's last good list: a peer that is down keeps its rows (marked down by the
 * sidebar) rather than vanishing, and one that answers replaces them. A peer no longer in
 * peers.json is dropped.
 */
export function mergePeerLists(
  prev: ReadonlyMap<string, SessionSummary[]>,
  answer: MeshSessions,
  peers: readonly PeerInfo[],
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
