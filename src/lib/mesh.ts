import { createSignal } from "solid-js";
import type { MeshInfo, MeshLoginEntry, MeshSessions, PeerStatus, SessionSummary, SyncCategory } from "../../shared/protocol";

// The client side of the peer mesh: which host a session lives on, and how a request for it
// reaches that host. A session is driven only by the host whose disk holds it, and the browser
// always talks to the host serving this page, which forwards `/peer/<id>/api/*` and
// `/peer/<id>/ws/*` to the peer. So routing a request is one prefix, chosen here.
//
// Everything is dormant until GET /api/mesh names a peer: with none, `hostOf` answers null for
// every path, no URL changes, and nothing polls.

export type { MeshCandidate, MeshInfo, MeshLoginEntry, MeshLogins, MeshPeerEntry, MeshSessions, MeshSettings, PeerState, PeerStatus, SyncCategory, SyncStatus } from "../../shared/protocol";

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
  return mappedHost(path);
}

/**
 * The peer a path is recorded on, unless that is the host serving this page: after a failover the
 * front door can land this tab on a host whose sessions it had recorded as a peer's, and a request
 * to `/peer/<self>` is one no host answers.
 */
function mappedHost(path: string): string | null {
  const h = hosts.get(path) ?? null;
  return h !== null && h === state()?.self.id ? null : h;
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
  const first = mappedHost(named[0]!);
  if (!named.every((p) => mappedHost(p) === first)) return url;
  return hostUrl(first, url);
}

// ---- hash route ---------------------------------------------------------------------------------

/** What the whole-pane session view is keyed on: its path, and the peer holding it (none: this
    host). A host id holds no newline, so the first one ends it. Mesh off: the path decides alone. */
export const sessionViewKey = (host: string | null, path: string): string => `${host ?? ""}\n${path}`;
export const pathOfViewKey = (key: string): string => key.slice(key.indexOf("\n") + 1);

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
 * This host's sessions, then every peer's, each path once. A session lives on one host, so a path
 * a peer lists is that peer's: this host's list can still carry it just after a front-door
 * failover (the list the tab loaded came from the host that is now a peer, and the re-read may
 * not have landed yet).
 */
export function joinHostLists(local: readonly SessionSummary[], peers: ReadonlyMap<string, SessionSummary[]>): SessionSummary[] {
  const peerRowsAll = [...peers.values()].flat();
  const onPeers = new Set(peerRowsAll.map((s) => s.path));
  return [...local.filter((s) => !onPeers.has(s.path)), ...peerRowsAll];
}

/**
 * The row a `#/sid/<id>` link names among the sidebar's rows, this host's and every peer's; null
 * sends the lookup to this host's server. "wait" while a miss could still be a peer's session: the
 * local list or the mesh's first answer (the peers' lists, when there are peers) hasn't landed. With
 * the mesh off `settled` is true once GET /api/mesh has answered, and only this host's list counts.
 */
export function linkedSessionRow(
  id: string,
  local: readonly SessionSummary[] | undefined,
  peers: ReadonlyMap<string, SessionSummary[]>,
  settled: boolean,
): SessionSummary | "wait" | null {
  if (!local) return "wait";
  const hit = (peers.size ? joinHostLists(local, peers) : local).find((s) => s.id === id);
  if (hit) return hit;
  return settled ? null : "wait";
}

/**
 * Each peer's rows. A peer that is down keeps its last rows (the server sends them as `stale`, and
 * a list this page already had stands in when it sends none), marked down by the sidebar rather
 * than vanishing. A peer no longer in peers.json is dropped.
 */
/**
 * After a confirmed host change: the old host's sessions, as this tab last listed them, stand in as
 * that peer's list until the peer answers, so they stay in the sidebar (marked down while it is)
 * instead of vanishing. A list the peer already sent wins.
 */
export function seedPeerList(
  lists: ReadonlyMap<string, SessionSummary[]>,
  host: string,
  rows: readonly SessionSummary[],
): Map<string, SessionSummary[]> {
  const next = new Map(lists);
  if (!next.has(host)) next.set(host, peerRows(rows));
  return next;
}

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

/** Waits between tries at GET /api/mesh after a failure that may pass (ms), the last one repeating. */
const MESH_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

/**
 * How long to wait before asking GET /api/mesh again after the `attempt`-th failure in a row (1 for
 * the first), or null to not ask again. A 4xx is an answer — a server without the route, or one
 * that refuses — so a page served by one makes exactly the one request it always did. A 5xx or no
 * answer at all (status 0) is a host mid-restart: the page would otherwise stay mesh-off until
 * reloaded, and a peer session it was opened on would read as unreachable.
 */
export function meshRetryDelay(status: number, attempt: number): number | null {
  if (status >= 400 && status < 500) return null;
  return MESH_RETRY_MS[Math.min(attempt, MESH_RETRY_MS.length) - 1]!;
}

// ---- the stale-tab check (the front door can move a tab between hosts) --------------------------

/** What a tab remembers of the host that served it: GET /api/mesh/hello at load. */
export interface HelloBaseline {
  id: string;
  label: string;
  protocol: string;
  build?: string;
}

/** How the host answering now differs from the one this tab was loaded from. */
export interface HelloChange {
  /** Another wire contract: this tab can't be trusted to talk to it. */
  protocol: boolean;
  /** Another build of the page: this tab is an older (or newer) app than the host serves. */
  build: boolean;
  /** Another host altogether (a failover): its label, and the one the tab came from. */
  host: { from: string; to: string } | null;
}

/**
 * The difference between the baseline and a fresh hello, or null when there is none. A build that
 * either side doesn't report (a dev server behind Vite serves none) is unknown, never different.
 */
export function helloChange(was: HelloBaseline, now: HelloBaseline): HelloChange | null {
  const protocol = was.protocol !== now.protocol;
  const build = !!was.build && !!now.build && was.build !== now.build;
  const host = was.id !== now.id ? { from: was.label || was.id, to: now.label || now.id } : null;
  return protocol || build || host ? { protocol, build, host } : null;
}

/**
 * The tab's baseline from its first hello and the host GET /api/mesh first named. That host served
 * the page, so it is the baseline's host even when the hello already comes from another (a failover
 * between load and the first hello); the first hello only supplies protocol and build.
 */
export function firstBaseline(servedBy: { id: string; label: string } | null, hello: HelloBaseline): HelloBaseline {
  return servedBy ? { ...hello, id: servedBy.id, label: servedBy.label } : hello;
}

/** A host change counts once a second hello, at least this much later, answers from the same new host. */
export const HOST_CONFIRM_MS = 1_000;
/** While the mesh is on, how often the tab asks which host serves it: a host that vanished (killed,
    cut off) leaves the open socket silent, so only this notices the front door moved the tab. */
export const HELLO_POLL_MS = 5_000;

/** How long after a host change the tab keeps re-reading GET /api/mesh with each hello. */
export const MOVE_WATCH_MS = 60_000;

/**
 * After the front door moved this tab, the old host's state comes from the new host's GET /api/mesh,
 * which the tab otherwise re-reads every 15 s: re-read it with each hello while the new host still
 * calls the old one up (a host that vanished takes it a while to notice), for MOVE_WATCH_MS at most.
 */
export function watchMove(moved: { from: string; at: number } | null, now: number, peers: readonly PeerStatus[]): boolean {
  if (!moved || now - moved.at > MOVE_WATCH_MS) return false;
  const p = peers.find((x) => x.id === moved.from);
  return !p || p.state === "up";
}

/** How long a mesh read (hello, peers, peer lists) may take while the mesh is on. A read in flight
    when a host vanishes can ride the front door's kept connection to it and wait 35 s; giving up
    frees the browser's connection, so the next read reaches the host now serving. */
export const MESH_READ_TIMEOUT_MS = 4_000;

/** The fetch options of a mesh read: a deadline with the mesh on; with it off, none (as before). */
export function meshReadInit(on: boolean): RequestInit | undefined {
  return on ? { signal: AbortSignal.timeout(MESH_READ_TIMEOUT_MS) } : undefined;
}

/** The stale-tab check, registered by the app: a view that saw a sign of a host change asks it now. */
let hostCheck: (() => void) | null = null;
export function setHostCheck(check: (() => void) | null): void {
  hostCheck = check;
}
export function recheckHost(): void {
  hostCheck?.();
}

/** The server's words for a transcript it doesn't hold (the chat socket's error before close 4404). */
export const FILE_NOT_FOUND = "Session file not found";
/** How long a "not found" that may be a host change waits before it is shown: the confirming
    hello comes HOST_CONFIRM_MS after the first, and the view is replaced when it does. */
export const HOST_MOVE_GRACE_MS = 3_000;

/**
 * A chat socket error that may only mean the front door moved this tab: with the mesh on, this
 * host's own session (no peer holds it) answered "not found" on a connection that had opened
 * before, which is what the next host says when the reconnect lands there. Anything else is shown
 * at once, as before.
 */
export function mayBeHostMove(err: { code?: string; message: string }, reopened: boolean, local: boolean, on: boolean): boolean {
  return on && reopened && local && err.code === "internal" && err.message === FILE_NOT_FOUND;
}

/** A host change seen once and not yet confirmed: which host, and when it first answered. */
export interface PendingHost {
  id: string;
  at: number;
}

/**
 * One hello against the baseline, with a host change held back until it is confirmed: the front
 * door may retry a single request on the next host while the first is healthy (a stalled tailnet
 * connect), and one such answer is not a failover. A protocol or build change on the same host is
 * reported at once. `pending` is what to remember for the next hello.
 */
export function helloStep(
  base: HelloBaseline,
  now: HelloBaseline,
  pending: PendingHost | null,
  t: number,
): { change: HelloChange | null; pending: PendingHost | null } {
  const change = helloChange(base, now);
  if (!change?.host) return { change, pending: null };
  if (pending?.id !== now.id) return { change: null, pending: { id: now.id, at: t } };
  if (t - pending.at < HOST_CONFIRM_MS) return { change: null, pending };
  return { change, pending: null };
}

// ---- the front door's hosts: which are in, which the user left out ------------------------------

/** The hosts the user left out of the front door, in host order (this host first), as rows for the
    order editor: the front door's own order lists only the hosts that are in. */
export function frontDoorLeftOut(
  hosts: readonly { id: string; label: string }[],
  exclude: readonly string[] | null | undefined,
  inOrder: readonly string[],
): { id: string; label: string }[] {
  return hosts.filter((h) => exclude?.includes(h.id) && !inOrder.includes(h.id));
}

/** `exclude` with `id` put in (left out) or taken out (back in); null once nobody is left out. */
export function withExclusion(exclude: readonly string[] | null | undefined, id: string, leaveOut: boolean): string[] | null {
  const rest = (exclude ?? []).filter((x) => x !== id);
  const next = leaveOut ? [...rest, id] : rest;
  return next.length ? next : null;
}

/** The failover order to store: the hosts that are in, as arranged, then the ones left out, so a
    host turned back on returns to the end instead of vanishing from the order. */
export const orderKeepingLeftOut = (inOrder: readonly string[], leftOut: readonly string[]): string[] => [
  ...inOrder,
  ...leftOut.filter((id) => !inOrder.includes(id)),
];

/** `items` with the one at `from` moved to `to`; a copy unchanged when either is out of range. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it!);
  return next;
}


/** What stops a generated Caddyfile from working as it stands, read from its upstreams. */
export interface FrontDoorProblems {
  /** Hosts whose upstream is the generator's placeholder (no MagicDNS name known, no serve URL set). */
  placeholders: string[];
  /** http and https mixed: Caddy refuses a reverse_proxy whose upstreams differ in scheme. */
  mixedSchemes: boolean;
}

export const PLACEHOLDER_HOST = "YOUR-TAILNET";

export function frontDoorProblems(order: readonly { id: string; upstream: string }[]): FrontDoorProblems {
  const schemes = new Set(order.map((h) => h.upstream.slice(0, h.upstream.indexOf(":")).toLowerCase()));
  return {
    placeholders: order.filter((h) => h.upstream.includes(PLACEHOLDER_HOST)).map((h) => h.id),
    mixedSchemes: schemes.has("http") && schemes.has("https"),
  };
}

/** Why a typed serve URL can't be saved, or null when it can. */
export function serveUrlProblem(value: string): string | null {
  const v = value.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(v)) return "Type the whole address, starting with https:// or http://.";
  try {
    new URL(v);
  } catch {
    return "That isn't an address a browser can open.";
  }
  return null;
}

// ---- login conflicts (GET /api/mesh/logins) ----------------------------------------------------

/** The logins waiting on a choice, in the server's order. */
export const loginConflicts = (entries: readonly MeshLoginEntry[]): MeshLoginEntry[] =>
  entries.filter((e) => (e.conflictWith?.length ?? 0) > 0);

/** A login's name on the page: `zai API key`, `openai-codex login`, `Claude Code login`. */
export function loginName(e: MeshLoginEntry): string {
  const who = e.store === "claude" ? "Claude Code" : e.provider;
  return `${who} ${e.kind === "api_key" ? "API key" : "login"}`;
}

/** `a`, `a and b`, `a, b, and c` (serial comma). */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Whether this host's copy can be kept everywhere: a live one, or an idle expired OAuth login (refreshed on claim). */
export const claimable = (e: MeshLoginEntry): boolean => e.state === "live" || e.state === "expired";

/** A conflicting login's line: which hosts hold another one, and that it waits on the user. */
export function conflictLine(e: MeshLoginEntry, label: (id: string) => string = (id) => id): string {
  const noun = e.kind === "api_key" ? "key" : "login";
  const others = (e.conflictWith ?? []).map(label);
  const who = others.length === 1 ? `${others[0]} has a different ${noun}` : `${listWords(others)} have different ${noun}s`;
  return `${who}, from before they synced. It doesn't sync until you keep one.`;
}

/** The Logins sync row while logins wait on a choice, in place of the server's raw line. */
export const conflictSummary = (n: number): string =>
  `${n} ${n === 1 ? "login differs" : "logins differ"} between hosts. Choose below which to keep.`;

/** What a refused claim means, in the page's words; the server's own message when it's none of these. */
export function claimRefusal(e: MeshLoginEntry, status: number, message: string): string {
  const noun = e.kind === "api_key" ? "key" : "login";
  if (status === 409 && /sync is off/i.test(message)) return "Login sync is off on this host. Turn it on in Settings → Mesh, then keep one.";
  if (status === 409 && /api keys only/i.test(message)) return "This host syncs API keys only, so its sign-ins stay here. Turn on “Sync subscriptions to this host” in Settings → Mesh to keep one everywhere.";
  if (status === 409) {
    return `This host's ${noun} is logged out or failed, so there's nothing to keep. ${e.kind === "api_key" ? "Add it again here" : "Log in again here"}, or keep another host's from its own Mesh page.`;
  }
  if (status === 400) return `This host doesn't hold the ${loginName(e)} any more.`;
  return message;
}
