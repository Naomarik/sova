import type { IncomingMessage } from "node:http";
import { statSync } from "node:fs";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import type { Context, Hono } from "hono";
import type {
  MeshCandidate,
  MeshInfo,
  MeshSessions,
  MeshSettings,
  PeerStatus,
  SessionSummary,
  SyncCategory,
  SyncStatus,
} from "../../shared/protocol";
import type { MeshLocalSettings } from "../../shared/mesh-local";
import {
  DENIED,
  grantCaps,
  type MeshAccessPeer,
  type MeshAccessPut,
  type MeshAccessView,
  type MeshCap,
  type MeshInfoView,
  type MeshPreset,
  MESH_PRESETS,
  type MeshSessionsView,
  type PeerStatusView,
} from "../../shared/mesh-access";
import { access, allows, capsOf, deniedBy, loginsOf, mayShareLoginNode, noteDenied, noteGranted, onAccessChange, restricted, updateAccess, validateGrant } from "./access";
import { frontDoorConfig, noBrowserIds } from "./front-door";
import { answered, ownHello, probeHello, probePeer, peerLastSeen, PROBE_TIMEOUT_MS } from "./hello";
import { type ListenerDeps, PeerListener } from "./listener";
import { addressIdentity, identityMode } from "./address-identity";
import { REFUSED_HEADER } from "./hello";
import { getIdentity, setIdentity, type TailnetStatus } from "./localapi";
import { defaultSelfId, nextLabelAt, type PeerEntry, type PeersConfig, peerPort, peerUrl, peersFile, readPeers, SYNC_CATEGORIES, validatePeers, writePeers } from "./peers";
import { localRequest, PROXIED_HEADER, peerSocketRoute, proxyTail, proxyPeer, upgradePeerSocket } from "./proxy";
import { fetchPeer, setLanClients } from "./dial";
import { ensureLanIdentity, LanRuntime } from "./lan";
import { lanRoutes } from "./lan-routes";
import { loginKindsPin } from "../sync/logins-merge";

// The mesh (brief: settled decisions). ON exactly while peers.json lists a peer; OFF, nothing
// here listens, polls, calls Tailscale or dials a peer, and every pre-existing route and socket
// is answered by its own unchanged code. See shared/protocol.ts "Mesh" for the routes.

type Dispatch = Pick<ListenerDeps, "fetch" | "upgrade"> & {
  /** The upgrade handler for a request that arrived on a stream (a dial-out pairing's); default `upgrade`. */
  streamUpgrade?: ListenerDeps["upgrade"];
};

interface MeshRuntime {
  /** The last good read of peers.json; null when missing or unusable. */
  config: PeersConfig | null;
  /** Why peers.json is unusable (missing is not an error). */
  error?: string;
  /** The tailnet peer listener: while at least one tailnet peer is listed. */
  listener: PeerListener | null;
  /** Dial-out pairings (§mesh/lan): while the mesh is on. */
  lan: LanRuntime | null;
  /** The mesh's start hooks have run (some peer is listed), and its stop hooks haven't since. */
  on: boolean;
  /** This node, from LocalAPI status, once the listener has asked. */
  self?: { nodeId: string; dnsName: string };
}

const rt: MeshRuntime = { config: null, listener: null, lan: null, on: false };

// A host without Tailscale LocalAPI (Android) opts into address identity (address-identity.ts).
// Nothing runs here: whois and status are only called while the mesh is on.
if (identityMode(process.env.SOVA_MESH_IDENTITY) === "addresses") {
  setIdentity(
    addressIdentity(() => {
      reloadIfChanged();
      return rt.config?.peers ?? [];
    }),
  );
}
let dispatch: Dispatch | null = null;

// Lifecycle hooks for server/sync. They fire only on transitions, so OFF they never fire.
const startHooks: Array<() => void> = [];
const stopHooks: Array<() => void> = [];
const peerUpHooks: Array<(peerId: string) => void> = [];
const settingsHooks: Array<(settings: MeshSettings) => void> = [];
/** Whether each peer was last seen up (by a probe, or by its own call through the gate). */
const upNow = new Map<string, boolean>();
/** When each peer's last-seen state (up or not) began, as this server saw it. */
const upSince = new Map<string, number>();

function runHooks<A extends unknown[]>(hooks: Array<(...a: A) => void>, ...args: A): void {
  for (const h of hooks) {
    try {
      h(...args);
    } catch (err) {
      console.error("[mesh] hook failed:", err);
    }
  }
}

/** Record what was just learnt about a peer; a peer that was not up and now is fires onPeerUp. */
function sawPeer(id: string, up: boolean): void {
  const was = upNow.get(id) ?? false;
  if (upNow.get(id) !== up) upSince.set(id, Date.now());
  upNow.set(id, up);
  if (up && !was) runHooks(peerUpHooks, id);
}

const emptyConfig = (): PeersConfig => ({ self: { id: defaultSelfId(), label: defaultSelfId() }, peers: [], sync: {}, frontDoor: null });

export const meshEnabled = (): boolean => (rt.config?.peers.length ?? 0) > 0;

/** Re-read peers.json into the runtime (no side effects beyond the listener it implies). */
function reload(): void {
  peersStamp = stampOf(peersFile());
  const r = readPeers();
  if (r.ok) {
    rt.config = r.config;
    delete rt.error;
  } else {
    rt.config = null;
    if (r.missing) delete rt.error;
    else {
      if (rt.error !== r.error) console.warn(`[mesh] ${r.error}; the mesh is off`);
      rt.error = r.error;
    }
  }
  apply();
  // A peer that is no longer listed loses every connection it still holds, sockets included.
  const allowed = new Set((rt.config?.peers ?? []).map((p) => p.nodeId));
  rt.listener?.revoke((nodeId) => allowed.has(nodeId));
  rt.lan?.revoke((nodeId) => allowed.has(nodeId));
}

// peers.json's identity (inode, size, mtime), so the gate notices a hand edit with a stat, not a read.
let peersStamp = "";
function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** Re-read peers.json when it changed on disk since the last read (one stat). */
function reloadIfChanged(): void {
  if (stampOf(peersFile()) !== peersStamp) reload();
}

// A lowered grant (a write from the Mesh page, or a hand edit the next question notices) ends what
// each peer was let through for and no longer has, open sockets included (§mesh.peers/grants).
onAccessChange(() => {
  rt.listener?.revokeGrants((nodeId, need) => allows(nodeId, need));
  rt.lan?.revokeGrants((nodeId, need) => allows(nodeId, need));
});

/** A peer reached over the tailnet (not a dial-out pairing). */
const tailnetPeers = (): PeerEntry[] => (rt.config?.peers ?? []).filter((p) => !p.lan);

/** Start or stop the peer listener and the pairings to match the config. */
function apply(): void {
  if (dispatch && meshEnabled() && !rt.lan) {
    const d = dispatch;
    rt.lan = new LanRuntime({
      fetch: d.fetch,
      upgrade: d.streamUpgrade ?? d.upgrade,
      allows: (peer, need) => allows(peer.nodeId, need),
      pairingByNode: (nodeId) => {
        reloadIfChanged(); // a hand edit may have removed it since
        return rt.config?.peers.find((p) => p.lan && p.nodeId === nodeId) ?? null;
      },
      sawPeer,
    });
    setLanClients({ client: (peerId) => rt.lan?.client(peerId) ?? null });
  }
  if (rt.lan) void rt.lan.apply(meshEnabled() ? rt.config : null);
  if (!meshEnabled() && rt.lan) {
    rt.lan = null; // apply(null) above stops everything it ran
    setLanClients(null);
  }
  // The tailnet listener: only while a tailnet peer is listed, so a host whose only peers are
  // dial-out pairings never asks Tailscale for anything.
  if (tailnetPeers().length && !rt.listener && dispatch) {
    const d = dispatch;
    rt.listener = new PeerListener({
      ...d,
      port: peerPort(),
      peerByNode: (nodeId) => {
        reloadIfChanged(); // a hand edit may have added or removed it since
        const hit = rt.config?.peers.find((p) => p.nodeId === nodeId);
        if (hit) sawPeer(hit.id, true); // it just called us, so it is up
        return hit ?? null;
      },
      allows: (peer, need) => allows(peer.nodeId, need),
      addresses: async () => {
        const status = await getIdentity().status();
        rt.self = { nodeId: status.self.nodeId, dnsName: status.self.name };
        const pinned = process.env.SOVA_PEER_HOST?.split(",").map((a) => a.trim()).filter(Boolean);
        return pinned?.length ? pinned : status.self.addresses;
      },
    });
    void rt.listener.start();
  } else if (!tailnetPeers().length && rt.listener) {
    rt.listener.close();
    rt.listener = null;
  }
  if (meshEnabled() && !rt.on) {
    rt.on = true;
    runHooks(startHooks);
  } else if (!meshEnabled() && rt.on) {
    rt.on = false;
    upNow.clear();
    upSince.clear();
    runHooks(stopHooks);
  }
}

/**
 * At startup, after the main listener is up: read peers.json once. With no peers that read is
 * all that ever happens until a PUT (or a GET /api/mesh after a hand edit) turns the mesh on.
 */
export function startMesh(d: Dispatch): void {
  dispatch = d;
  reload();
}

export function stopMesh(): void {
  void rt.lan?.stop();
  rt.lan = null;
  setLanClients(null);
  rt.listener?.close();
  rt.listener = null;
  if (!rt.on) return;
  rt.on = false;
  upNow.clear();
  upSince.clear();
  runHooks(stopHooks);
}

/** Tests: the listener's bound state. */
export const listenerInfo = () => rt.listener?.info() ?? null;

// ---- sync status (filled by server/sync) ------------------------------------------------------

let syncProvider: (() => SyncStatus[]) | null = null;
let accessLogins: (() => MeshAccessView["logins"]) | null = null;
/** server/sync registers its per-category status here; GET /api/mesh reports it while ON. */
export const onSyncStatus = (provider: () => SyncStatus[]): void => {
  syncProvider = provider;
};

/**
 * SOVA_SYNC_LOGIN_KINDS pins this host's login kinds, read the way server/sync reads it: any value
 * but "all" pins "api-keys" (the variable keeps subscription logins off a host, so a typo must not
 * let them in). Null when unset.
 */
function pinnedLoginKinds(): "all" | "api-keys" | null {
  const pin = loginKindsPin();
  const raw = process.env.SOVA_SYNC_LOGIN_KINDS?.trim();
  if (pin && raw !== pin && !warnedLoginKinds) {
    console.warn(`[mesh] SOVA_SYNC_LOGIN_KINDS=${JSON.stringify(raw)} is not "all" or "api-keys": treating it as "api-keys"`);
    warnedLoginKinds = true;
  }
  return pin;
}
let warnedLoginKinds = false;

export function readMeshSettings(config: PeersConfig | null = rt.config): MeshLocalSettings {
  const c = config ?? emptyConfig();
  const pinned = pinnedLoginKinds();
  const loginKinds = pinned ?? c.loginKinds;
  const sync = Object.fromEntries(SYNC_CATEGORIES.map((k) => [k, c.sync[k] ?? true])) as Record<SyncCategory, boolean>;
  return {
    hostLabel: c.self.label,
    sync,
    frontDoor: c.frontDoor,
    ...(c.frontDoorOrder ? { frontDoorOrder: c.frontDoorOrder } : {}),
    ...(c.frontDoorExclude ? { frontDoorExclude: c.frontDoorExclude } : {}),
    ...(c.self.serveUrl ? { serveUrl: c.self.serveUrl } : {}),
    ...(loginKinds ? { loginKinds } : {}),
    ...(pinned ? { loginKindsPinned: true as const } : {}),
  };
}

/** The current allowlist (for server/sync). */
export const meshPeers = (): PeerEntry[] => rt.config?.peers ?? [];
export const meshSelf = (): { id: string; label: string } => (rt.config ?? emptyConfig()).self;

/**
 * A route under /api/peer/*: the calling peer (the peer listener put it there), else null. A
 * request a peer merely proxied for a browser (it carries X-Forwarded-Host, which proxyPeer always
 * sets and peerFetch never does) is not the peer speaking, so it is null too.
 */
export const requestPeer = (c: Context): PeerEntry | null => {
  const peer = (c.env as { meshPeer?: PeerEntry } | undefined)?.meshPeer ?? null;
  return peer && !c.req.header(PROXIED_HEADER) ? peer : null;
};

// ---- grants (§mesh.peers/grants) --------------------------------------------------------------

const peerById = (peerId: string): PeerEntry | undefined => rt.config?.peers.find((p) => p.id === peerId);

/**
 * Whether this host shares `cap` with peer `peerId` (by id, from the current peers.json): what it
 * lets that peer do here, and so what it sends that peer on its own initiative. Every cap with no
 * mesh-access.json or no entry for the peer (today's behaviour); false for an unknown peer.
 */
export function mayShareWith(peerId: string, cap: MeshCap): boolean {
  const peer = peerById(peerId);
  return !!peer && allows(peer.nodeId, cap);
}

/** Whether login `key` (`<store>:<provider>`) is exchanged with peer `peerId`, logouts included. */
export function mayShareLogin(peerId: string, key: string): boolean {
  const peer = peerById(peerId);
  return !!peer && mayShareLoginNode(peer.nodeId, key);
}

/** Whether a browser request relayed to `peerId` must carry nothing of this host or the browser:
    while this host's grant to that peer is anything but `full`. */
export function scrubFor(peerId: string): boolean {
  const peer = peerById(peerId);
  return !!peer && restricted(peer.nodeId);
}

/** Record a peer's answer to a call that needed `cap`: its `denied` (what it hides from this host,
    for the Mesh page) or anything else (it grants it). True when the answer was `denied`. */
export function noteAnswer(peerId: string, cap: MeshCap, res: Response): boolean {
  if (res.status === 403 && res.headers.get(REFUSED_HEADER) === DENIED) {
    noteDenied(peerId, cap);
    return true;
  }
  if (res.status !== 403 || res.headers.get(REFUSED_HEADER) !== "refused") noteGranted(peerId, cap);
  return false;
}

// What this host sends a peer on its own initiative, by path: never what it doesn't grant that peer.
// Reads of the peer's own things (its hello, details, sessions, outreach relay, gateway) are the
// peer's grant to this host, so they are not here.
const OUTBOUND: Array<[RegExp, (peerId: string) => boolean]> = [
  [/^\/api\/peer\/(?:label|browser-access)(?:\?|$)/, (id) => mayShareWith(id, "presence")],
  [/^\/api\/peer\/links(?:[/?]|$)/, (id) => mayShareWith(id, "links")],
  [/^\/api\/peer\/sync\/extensions(?:\?|$)/, (id) => mayShareWith(id, "sync.extensions")],
  [/^\/api\/peer\/sync\/(?:manifest|doc|push)(?:\?|$)/, (id) => mayShareWith(id, "sync.settings") || mayShareWith(id, "sync.themes")],
  [/^\/api\/peer\/credentials\//, (id) => mayShareWith(id, "sync.logins")],
  [/^\/api\/peer\/claude-pool\//, (id) => mayShareWith(id, "sync.logins")],
];

/** Why this host may not send `path` to `peerId` on its own initiative, or null when it may. */
export function outboundRefusal(peerId: string, path: string): string | null {
  const p = path.toLowerCase();
  for (const [re, ok] of OUTBOUND) if (re.test(p)) return ok(peerId) ? null : `not shared with ${peerId}`;
  return null;
}

/**
 * GET/POST/… <peer>/<path> over the peer hop (the peer's gate sees this host's node). Throws when
 * the mesh is off or the peer is unknown, or when `path` sends the peer what this host doesn't grant
 * it (outboundRefusal); otherwise it is fetch: a down peer rejects, a refusal is a 403 with
 * X-Sova-Mesh: refused, and a grant's refusal a 403 with X-Sova-Mesh: denied. `path` starts with "/api/".
 */
export function peerFetch(peerId: string, path: string, init?: RequestInit): Promise<Response> {
  const peer = rt.config?.peers.find((p) => p.id === peerId);
  if (!meshEnabled() || !peer) return Promise.reject(new Error(`unknown peer ${peerId}`));
  const refusal = outboundRefusal(peerId, path);
  if (refusal) return Promise.reject(new Error(refusal));
  const headers = new Headers(init?.headers);
  headers.delete(PROXIED_HEADER); // it would make the peer treat this host's own call as a browser's
  return fetchPeer(peer, path, { ...init, headers });
}

/**
 * Change peers.json: `change` gets the file as it is now and returns the next config (or why not);
 * the result is validated, written atomically and reloaded. A malformed file is never overwritten.
 */
export function updatePeers(change: (config: PeersConfig) => PeersConfig | { error: string }): { config: PeersConfig } | { error: string; status: 400 | 409 } {
  const base = baseForWrite();
  if ("error" in base) return { error: base.error, status: 409 };
  const next = change(base.config);
  if ("error" in next) return { error: next.error, status: 400 };
  if (next === base.config) return { config: base.config }; // nothing changed: no write
  const v = validatePeers(next);
  if ("error" in v) return { error: v.error, status: 400 };
  writePeers(v.config);
  reload();
  return v;
}

/** The surface server/sync builds on (mountSync(app, meshApi)). */
export const meshApi = {
  enabled: meshEnabled,
  peers: meshPeers,
  self: meshSelf,
  settings: () => readMeshSettings(),
  peerFetch,
  /** The verified caller of a route under /api/peer/*; null never reaches such a route (it is 404). */
  requestPeer,
  /** Fires when peers.json goes from no peer to some (at startup too); at once if already on. */
  onMeshStart: (fn: () => void): void => {
    startHooks.push(fn);
    if (rt.on) runHooks([fn]);
  },
  /** Fires when the last peer is removed, or at shutdown while on. */
  onMeshStop: (fn: () => void): void => {
    stopHooks.push(fn);
  },
  /** Fires when a peer not known to be up is seen up: a hello probe, or its own call through the gate. */
  onPeerUp: (fn: (peerId: string) => void): void => {
    peerUpHooks.push(fn);
  },
  /** Fires after each successful PUT /api/mesh/settings (also while off: the user's own action). */
  onSettingsChange: (fn: (settings: MeshSettings) => void): void => {
    settingsHooks.push(fn);
  },
  onSyncStatus,
  /** Each sync category's status now; empty while off or before server/sync registered. */
  syncStatus: (): SyncStatus[] => (meshEnabled() && syncProvider ? syncProvider() : []),
  /** This node as the listener learnt it (while on), and the addresses it listens on. */
  selfNode: (): { nodeId?: string; dnsName?: string; addresses: string[] } => ({
    ...(rt.self?.nodeId ? { nodeId: rt.self.nodeId } : {}),
    ...(rt.self?.dnsName ? { dnsName: rt.self.dnsName } : {}),
    addresses: rt.listener?.info().addresses ?? [],
  }),
  /** When a peer's current up/down state began (this server's view), or null. */
  peerSince: (id: string): number | null => upSince.get(id) ?? null,
  /** Record a peer's up/down state learnt elsewhere (the details route's own calls). */
  sawPeer,
  updatePeers,
  /** The config as peers.json has it now (a hand edit is picked up with one stat). */
  config: (): PeersConfig | null => {
    reloadIfChanged();
    return rt.config;
  },
  /** Whether this host shares `cap` with a peer (§mesh.peers/grants; every cap without mesh-access.json). */
  mayShareWith,
  /** Whether one login is exchanged with a peer. */
  mayShareLogin,
  /** Record a peer's answer to a call needing `cap`; true when it was `denied`. */
  noteAnswer,
  /** server/sync registers the logins the Mesh page's per-login switches list. */
  onAccessLogins: (provider: () => MeshAccessView["logins"]): void => {
    accessLogins = provider;
  },
};
export type MeshApi = typeof meshApi;

// ---- state ------------------------------------------------------------------------------------

async function peerStatuses(): Promise<PeerStatusView[]> {
  const peers = rt.config?.peers ?? [];
  const probes = await Promise.all(peers.map((p) => probePeer(p)));
  peers.forEach((p, i) => sawPeer(p.id, answered(probes[i]!)));
  return peers.map((p, i) => ({
    id: p.id,
    label: p.label,
    nodeId: p.nodeId,
    name: p.dnsName,
    // A dial-out pairing has no URL of its own: it is reached over its connection (§mesh/lan).
    url: p.lan ? `lan:${p.id}` : peerUrl(p),
    ...(p.priority !== undefined ? { priority: p.priority } : {}),
    state: probes[i]!.state,
    ...(probes[i]!.error ? { error: probes[i]!.error } : {}),
    ...(probes[i]!.hello ? { hello: probes[i]!.hello } : {}),
    lastSeen: peerLastSeen(p.id),
  }));
}

async function meshInfo(): Promise<MeshInfoView> {
  const c = rt.config ?? emptyConfig();
  const on = meshEnabled();
  const info: MeshInfoView = {
    enabled: on,
    self: { id: c.self.id, label: c.self.label, hostname: hostname() },
    peers: on ? await peerStatuses() : [],
    sync: on && syncProvider ? syncProvider() : [],
    frontDoor: c.frontDoor,
    ...(rt.error ? { error: rt.error } : {}),
  };
  if (on && rt.self) Object.assign(info.self, { nodeId: rt.self.nodeId, dnsName: rt.self.dnsName });
  if (on && rt.listener) info.self.listen = rt.listener.info();
  return info;
}

// ---- mesh sessions ----------------------------------------------------------------------------

const lastGood = new Map<string, SessionSummary[]>();

async function meshSessions(): Promise<MeshSessionsView> {
  const peers = rt.config?.peers ?? [];
  const rows = await Promise.all(
    peers.map(async (p): Promise<MeshSessionsView["peers"][number]> => {
      const head = { id: p.id, label: p.label };
      try {
        const res = await fetchPeer(p, "/api/sessions", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const denied = noteAnswer(p.id, "sessions", res);
        if (res.ok) {
          const sessions = (await res.json()) as SessionSummary[];
          if (!Array.isArray(sessions)) throw new Error("not a session list");
          lastGood.set(p.id, sessions);
          return { ...head, state: "up", sessions };
        }
        await res.body?.cancel();
        // It reached the host, which keeps its sessions from this one: no rows, none kept (§mesh.peers/grants).
        if (denied) {
          lastGood.delete(p.id);
          return { ...head, state: "hidden", error: `hidden by ${p.label}` };
        }
        if (res.status === 403) return { ...head, state: "refused", error: "this host is not in its peers.json" };
        throw new Error(`answered ${res.status}`);
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        const error = e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.message);
        const kept = lastGood.get(p.id);
        return { ...head, state: "down", error, ...(kept ? { sessions: kept, stale: true } : {}) };
      }
    }),
  );
  for (const r of rows) sawPeer(r.id, r.state === "up" || r.state === "hidden");
  return { peers: rows };
}

// ---- candidates -------------------------------------------------------------------------------

async function candidates(): Promise<MeshCandidate[]> {
  const status = await getIdentity().status();
  const known = new Map((rt.config?.peers ?? []).map((p) => [p.nodeId, p.id]));
  return Promise.all(
    status.peers.map(async (n): Promise<MeshCandidate> => {
      const base: MeshCandidate = {
        nodeId: n.nodeId,
        name: n.name,
        hostName: n.hostName,
        os: n.os,
        online: n.online,
        tags: n.tags,
        login: n.login,
        addresses: n.addresses,
        ...(known.has(n.nodeId) ? { peerId: known.get(n.nodeId)! } : {}),
        sova: "no",
      };
      if (!n.online || !n.name) return base;
      const probe = await probeHello(peerUrl({ id: "x", label: "x", nodeId: n.nodeId, dnsName: n.name }));
      if (probe.state === "refused") return { ...base, sova: "refused" };
      if (probe.state === "hidden") return { ...base, sova: "yes" }; // it lists this host and shows it nothing
      if (probe.hello) return { ...base, sova: "yes", hello: probe.hello };
      return base;
    }),
  );
}

// ---- writes -----------------------------------------------------------------------------------

/** The config a write starts from: the file as it is now; a malformed file is never overwritten. */
function baseForWrite(): { config: PeersConfig } | { error: string } {
  const r = readPeers();
  if (r.ok) return { config: r.config };
  if (r.missing) return { config: emptyConfig() };
  return { error: `${r.error}; fix or remove it first` };
}

function resolveNode(status: TailnetStatus, name: string) {
  const n = name.replace(/\.$/, "").toLowerCase();
  return status.peers.find(
    (p) => p.nodeId === name || p.name.toLowerCase() === n || p.hostName.toLowerCase() === n || p.name.toLowerCase().split(".")[0] === n || p.addresses.includes(name),
  );
}

async function putPeers(c: Context): Promise<Response> {
  let body: { peers?: unknown; grants?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { peers: MeshPeerEntry[] }" }, 400);
  }
  if (!Array.isArray(body?.peers)) return c.json({ error: "peers must be an array" }, 400);
  const base = baseForWrite();
  if ("error" in base) return c.json({ error: base.error }, 409);
  const entries = body.peers as Array<Record<string, unknown>>;
  for (const [i, e] of entries.entries()) {
    if (typeof e !== "object" || e === null || typeof e.name !== "string" || !e.name.trim()) return c.json({ error: `peers[${i}].name is required` }, 400);
  }
  const unresolved = entries.filter((e) => typeof e.nodeId !== "string" || !e.nodeId);
  let status: TailnetStatus | null = null;
  if (unresolved.length) {
    try {
      status = await getIdentity().status();
    } catch (err) {
      return c.json({ error: `can't resolve peer names: ${(err as Error).message}` }, 400);
    }
  }
  const peers: unknown[] = [];
  for (const [i, e] of entries.entries()) {
    const name = (e.name as string).trim();
    let nodeId = typeof e.nodeId === "string" && e.nodeId ? e.nodeId : null;
    let dnsName = name;
    if (!nodeId) {
      const n = resolveNode(status!, name);
      if (!n) return c.json({ error: `peers[${i}]: ${name} is not a node on this tailnet` }, 400);
      if (n.nodeId === status!.self.nodeId) return c.json({ error: `peers[${i}]: ${name} is this host` }, 400);
      nodeId = n.nodeId;
      dnsName = n.name || name;
    }
    const prior = base.config.peers.find((p) => p.id === e.id);
    // A dial-out pairing (§mesh.lan/pairing) is edited by this PUT only in its id and label; its
    // link stays as paired, and it has no url, serveUrl or tailnet name.
    const paired = base.config.peers.find((p) => p.lan && p.nodeId === e.nodeId);
    if (paired) {
      peers.push({
        id: e.id,
        label: e.label !== undefined ? e.label : paired.label,
        nodeId: paired.nodeId,
        lan: paired.lan,
        ...(e.priority !== undefined ? { priority: e.priority } : paired.priority !== undefined ? { priority: paired.priority } : {}),
        ...(paired.pairedAt !== undefined ? { pairedAt: paired.pairedAt } : {}),
        ...(paired.labelAt !== undefined ? { labelAt: paired.labelAt } : {}),
      });
      continue;
    }
    // Stamped when a node is first paired; kept across edits (matched by node, the id may change).
    const known = base.config.peers.find((p) => p.nodeId === nodeId);
    const pairedAt = known ? known.pairedAt : Date.now();
    peers.push({
      id: e.id,
      ...(e.label !== undefined ? { label: e.label } : prior ? { label: prior.label } : {}),
      nodeId,
      dnsName,
      ...(e.url !== undefined ? { url: e.url } : prior?.url ? { url: prior.url } : {}),
      ...(e.priority !== undefined ? { priority: e.priority } : prior?.priority !== undefined ? { priority: prior.priority } : {}),
      ...(e.serveUrl !== undefined ? { serveUrl: e.serveUrl } : prior?.serveUrl ? { serveUrl: prior.serveUrl } : {}),
      ...(pairedAt !== undefined ? { pairedAt } : {}),
      // The stamp of the last name the peer gave itself, kept through a local edit: only a newer
      // rename by that host replaces what the user typed here.
      ...(known?.labelAt !== undefined ? { labelAt: known.labelAt } : {}),
      // What the peer said about its own browser address: only the peer changes it.
      ...(known?.browserAccess === false ? { browserAccess: false } : {}),
      ...(known?.browserAccessAt !== undefined ? { browserAccessAt: known.browserAccessAt } : {}),
    });
  }
  const v = validatePeers({ ...base.config, peers });
  if ("error" in v) return c.json({ error: v.error }, 400);
  const grants = pairingGrants(body.grants, base.config, v.config);
  if ("error" in grants) return c.json({ error: grants.error }, 400);
  writePeers(v.config);
  reload();
  applyPairingGrants(grants.set, grants.removed);
  return c.json(await meshInfo());
}

/**
 * The grants a peers PUT implies (§mesh.peers/grants): each peer it newly pairs that `raw` names
 * (MeshPeersPut.grants, by peer id) gets that preset; one it doesn't name gets none (= full, as
 * before grants). Nodes it unpairs lose theirs. Peers already paired keep what they have.
 */
function pairingGrants(raw: unknown, before: PeersConfig, after: PeersConfig): { set: Record<string, MeshPreset>; removed: string[] } | { error: string } {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) return { error: "grants must be an object of peer id → preset" };
  const named = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(before.peers.map((p) => p.nodeId));
  const set: Record<string, MeshPreset> = {};
  for (const [id, preset] of Object.entries(named)) {
    if (!(MESH_PRESETS as readonly unknown[]).includes(preset)) return { error: `grants.${id} must be one of ${MESH_PRESETS.join(", ")}` };
    const peer = after.peers.find((p) => p.id === id);
    if (!peer) return { error: `grants.${id}: not a peer in this list` };
    if (!known.has(peer.nodeId)) set[peer.nodeId] = preset as MeshPreset;
  }
  const kept = new Set(after.peers.map((p) => p.nodeId));
  return { set, removed: before.peers.map((p) => p.nodeId).filter((n) => !kept.has(n)) };
}

function applyPairingGrants(set: Record<string, MeshPreset>, removed: string[]): void {
  const now = access();
  if (!Object.keys(set).length && !(now.kind === "ok" && removed.some((n) => n in now.file.peers))) return;
  const r = updateAccess((doc) => {
    for (const n of removed) delete doc.peers[n];
    for (const [n, preset] of Object.entries(set)) doc.peers[n] = { preset };
    return doc;
  });
  // A broken file stays as it is: every peer, the new one included, gets hello only until it is fixed.
  if ("error" in r) console.warn(`[mesh] grants not written: ${r.error}`);
}

/** The pairings' view for the Mesh page; also while off (this host's key and relay setting). */
function lanStatus() {
  reloadIfChanged();
  if (rt.lan) return rt.lan.status(rt.config);
  return LanRuntime.idleStatus(rt.config);
}

// ---- grants editor (/api/mesh/access: this host's own browser only) -----------------------------

function accessView(): MeshAccessView {
  const a = access();
  const peers = (rt.config?.peers ?? []).map((p): MeshAccessPeer => {
    const grant = a.kind === "ok" ? a.file.peers[p.nodeId] : undefined;
    const caps = capsOf(p.nodeId);
    const effective = caps === "hello-only" ? grantCaps({ preset: "none" }) : caps;
    const theirs = deniedBy(p.id);
    return {
      id: p.id,
      label: p.label,
      nodeId: p.nodeId,
      ...(grant ? { grant } : {}),
      effective,
      logins: loginsOf(p.nodeId),
      ...(theirs ? { theirs } : {}),
    };
  });
  return {
    exists: a.kind !== "missing",
    ...(a.kind === "error" ? { error: a.error } : {}),
    peers,
    logins: meshEnabled() && accessLogins ? accessLogins() : [],
  };
}

async function putAccess(c: Context): Promise<Response> {
  let body: Partial<MeshAccessPut>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { peer, grant }" }, 400);
  }
  const peer = typeof body?.peer === "string" ? peerById(body.peer) : undefined;
  if (!peer) return c.json({ error: "Unknown peer" }, 404);
  let grant: MeshAccessPut["grant"] = null;
  if (body.grant !== null) {
    const v = validateGrant(body.grant);
    if ("error" in v) return c.json({ error: v.error }, 400);
    grant = v.grant;
  }
  const r = updateAccess((doc) => {
    if (grant) doc.peers[peer.nodeId] = grant;
    else delete doc.peers[peer.nodeId];
    return doc;
  });
  if ("error" in r) return c.json({ error: r.error }, 409);
  return c.json(accessView());
}

async function putSettings(c: Context): Promise<Response> {
  let body: Partial<MeshLocalSettings>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body Partial<MeshSettings>" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Expected an object" }, 400);
  const base = baseForWrite();
  if ("error" in base) return c.json({ error: base.error }, 409);
  if (body.frontDoorOrder !== undefined && body.frontDoorOrder !== null) {
    const hosts = new Set([base.config.self.id, ...base.config.peers.map((p) => p.id)]);
    const unknown = Array.isArray(body.frontDoorOrder) ? body.frontDoorOrder.filter((id) => !hosts.has(id)) : [];
    if (unknown.length) return c.json({ error: `frontDoorOrder: not a host here: ${unknown.join(", ")}` }, 400);
  }
  if (Array.isArray(body.frontDoorExclude) && body.frontDoorExclude.length) {
    const hosts = [base.config.self.id, ...base.config.peers.map((p) => p.id)];
    const unknown = body.frontDoorExclude.filter((id) => !hosts.includes(id));
    if (unknown.length) return c.json({ error: `frontDoorExclude: not a host here: ${unknown.join(", ")}` }, 400);
    if (hosts.every((id) => body.frontDoorExclude!.includes(id))) return c.json({ error: "frontDoorExclude: the front door needs at least one host" }, 400);
    // Hosts with no browser address are never upstreams, so one with an address must stay in.
    const noBrowser = meshEnabled() ? noBrowserIds(base.config) : new Set<string>();
    const served = hosts.filter((id) => !noBrowser.has(id));
    if (served.length && served.length < hosts.length && served.every((id) => body.frontDoorExclude!.includes(id)))
      return c.json({ error: "frontDoorExclude: the front door needs at least one host with a browser address" }, 400);
  }
  const pinned = pinnedLoginKinds();
  if (body.loginKinds !== undefined && pinned && (body.loginKinds ?? "all") !== pinned) {
    return c.json({ error: "loginKinds is pinned by SOVA_SYNC_LOGIN_KINDS on this host" }, 409);
  }
  const self = { ...base.config.self };
  // A new name is stamped (this host's clock), so peers take it (server/mesh/details.ts) and never an older one.
  if (body.hostLabel !== undefined && body.hostLabel !== self.label) self.labelAt = nextLabelAt(self.labelAt);
  if (body.hostLabel !== undefined) self.label = body.hostLabel;
  if (body.serveUrl === null) delete self.serveUrl;
  else if (body.serveUrl !== undefined) self.serveUrl = body.serveUrl;
  const next: Record<string, unknown> = {
    ...base.config,
    self,
    sync: body.sync !== undefined ? { ...base.config.sync, ...body.sync } : base.config.sync,
    frontDoor: body.frontDoor !== undefined ? body.frontDoor : base.config.frontDoor,
  };
  if (body.frontDoorOrder === null) delete next.frontDoorOrder;
  else if (body.frontDoorOrder !== undefined) next.frontDoorOrder = body.frontDoorOrder;
  if (body.frontDoorExclude === null) delete next.frontDoorExclude; // [] is dropped by validation too
  else if (body.frontDoorExclude !== undefined) next.frontDoorExclude = body.frontDoorExclude;
  if (body.loginKinds !== undefined) next.loginKinds = body.loginKinds;
  const v = validatePeers(next);
  if ("error" in v) return c.json({ error: v.error }, 400);
  writePeers(v.config);
  reload();
  const settings = readMeshSettings(v.config);
  runHooks(settingsHooks, settings);
  return c.json(settings);
}

// ---- routes -----------------------------------------------------------------------------------

/** Mount the mesh routes; call before the `/api/*` 404. */
export function meshRoutes(app: Hono): void {
  app.get("/api/mesh", async (c) => {
    reload(); // cheap, and it picks up a hand edit of peers.json
    return c.json(await meshInfo());
  });
  app.put("/api/mesh/peers", putPeers);
  app.get("/api/mesh/candidates", async (c) => {
    try {
      return c.json(await candidates());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });
  app.get("/api/mesh/sessions", async (c) => c.json(meshEnabled() ? await meshSessions() : { peers: [] }));
  app.get("/api/mesh/settings", (c) => c.json(readMeshSettings()));
  app.put("/api/mesh/settings", putSettings);
  // Generated only, from local state: no Tailscale call (this node's name is the one the listener
  // already learnt, while on), no file written.
  app.get("/api/mesh/front-door", (c) => {
    reload();
    const config = rt.config ?? emptyConfig();
    // Browser access is a mesh fact: while off, the answer is exactly what it was without it.
    return c.json(meshEnabled() ? frontDoorConfig(config, rt.self?.dnsName ?? null, noBrowserIds(config)) : frontDoorConfig(config, null));
  });
  app.get("/api/mesh/hello", (c) => c.json(ownHello(meshSelf(), rt.self?.nodeId)));
  // The grants (§mesh.peers/grants): this host's own browser only. The peer listener and the /peer
  // proxy never reach /api/mesh/*, and localRequest also refuses a relayed browser, so a peer can
  // never raise its own grant. Also while off (a grant may be set before pairing completes).
  app.get("/api/mesh/access", (c) => (localRequest(c) ? c.json(accessView()) : c.json({ error: "Not found" }, 404)));
  app.put("/api/mesh/access", (c) => (localRequest(c) ? putAccess(c) : c.json({ error: "Not found" }, 404)));
  // Dial-out pairings (§mesh.lan/pairing): the same local-browser-only rule.
  lanRoutes(app, {
    status: () => lanStatus(),
    ensureKey: () => ensureLanIdentity(),
    updatePeers,
    applyGrants: applyPairingGrants,
  });

  // Peer-only routes: reached through the peer listener alone. On the main listener they are the
  // same 404 as any unknown /api route.
  app.use("/api/peer/*", async (c, next) => (requestPeer(c) ? next() : c.json({ error: "Not found" }, 404)));
  app.get("/api/peer/hello", (c) => c.json(ownHello(meshSelf(), rt.self?.nodeId)));

  // The proxy. While OFF these paths fall through to exactly what answered them before.
  // Strip the raw "/peer/<segment>" by shape, never by the decoded id's length: an encoded id
  // ("/peer/%62/…") must not shift what is left.
  const peerTail = (c: Context) => new URL(c.req.url).pathname.replace(/^\/peer\/[^/]+/, "");
  app.all("/peer/:id/api/*", async (c, next) => {
    if (!meshEnabled()) return next();
    const peer = rt.config!.peers.find((p) => p.id === c.req.param("id"));
    if (!peer) return c.json({ error: "Unknown peer" }, 404);
    const tail = proxyTail(peerTail(c));
    // The same 404 as any unknown /api route: never proxied, never distinguishable.
    return tail ? proxyPeer(c, peer, tail, scrubFor(peer.id)) : c.json({ error: "Not found" }, 404);
  });
  app.all("/peer/:id/ws/*", async (c, next) => {
    if (!meshEnabled()) return next();
    const known = rt.config!.peers.some((p) => p.id === c.req.param("id"));
    return known ? c.json({ error: "WebSocket upgrade required" }, 426) : c.json({ error: "Unknown peer" }, 404);
  });
}

/**
 * A /peer/<id>/ws/chat|watch upgrade on the main listener → true when handled. While OFF it
 * handles nothing, so the caller's existing handling (socket.destroy) runs as before.
 */
export function meshUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
  if (!meshEnabled()) return false;
  const route = peerSocketRoute(url.pathname);
  if (!route) return false;
  const peer = rt.config!.peers.find((p) => p.id === route[0]) ?? null;
  upgradePeerSocket(req, socket, head, peer, route[1], url.search, !!peer && scrubFor(peer.id));
  return true;
}
