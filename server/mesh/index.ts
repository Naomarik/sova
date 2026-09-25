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
import { frontDoorConfig } from "./front-door";
import { ownHello, probeHello, probePeer, peerLastSeen, PROBE_TIMEOUT_MS } from "./hello";
import { type ListenerDeps, PeerListener } from "./listener";
import { getIdentity, type TailnetStatus } from "./localapi";
import { defaultSelfId, type PeerEntry, type PeersConfig, peerPort, peerUrl, peersFile, readPeers, SYNC_CATEGORIES, validatePeers, writePeers } from "./peers";
import { PROXIED_HEADER, peerSocketRoute, proxyTail, proxyPeer, upgradePeerSocket } from "./proxy";

// The mesh (brief: settled decisions). ON exactly while peers.json lists a peer; OFF, nothing
// here listens, polls, calls Tailscale or dials a peer, and every pre-existing route and socket
// is answered by its own unchanged code. See shared/protocol.ts "Mesh" for the routes.

type Dispatch = Pick<ListenerDeps, "fetch" | "upgrade">;

interface MeshRuntime {
  /** The last good read of peers.json; null when missing or unusable. */
  config: PeersConfig | null;
  /** Why peers.json is unusable (missing is not an error). */
  error?: string;
  listener: PeerListener | null;
  /** This node, from LocalAPI status, once the listener has asked. */
  self?: { nodeId: string; dnsName: string };
}

const rt: MeshRuntime = { config: null, listener: null };
let dispatch: Dispatch | null = null;

// Lifecycle hooks for server/sync. They fire only on transitions, so OFF they never fire.
const startHooks: Array<() => void> = [];
const stopHooks: Array<() => void> = [];
const peerUpHooks: Array<(peerId: string) => void> = [];
const settingsHooks: Array<(settings: MeshSettings) => void> = [];
/** Whether each peer was last seen up (by a probe, or by its own call through the gate). */
const upNow = new Map<string, boolean>();

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

/** Start or stop the peer listener to match the config. */
function apply(): void {
  if (meshEnabled() && !rt.listener && dispatch) {
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
      addresses: async () => {
        const status = await getIdentity().status();
        rt.self = { nodeId: status.self.nodeId, dnsName: status.self.name };
        const pinned = process.env.SOVA_PEER_HOST?.split(",").map((a) => a.trim()).filter(Boolean);
        return pinned?.length ? pinned : status.self.addresses;
      },
    });
    void rt.listener.start();
    runHooks(startHooks);
  } else if (!meshEnabled() && rt.listener) {
    rt.listener.close();
    rt.listener = null;
    upNow.clear();
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
  if (!rt.listener) return;
  rt.listener.close();
  rt.listener = null;
  upNow.clear();
  runHooks(stopHooks);
}

/** Tests: the listener's bound state. */
export const listenerInfo = () => rt.listener?.info() ?? null;

// ---- sync status (filled by server/sync) ------------------------------------------------------

let syncProvider: (() => SyncStatus[]) | null = null;
/** server/sync registers its per-category status here; GET /api/mesh reports it while ON. */
export const onSyncStatus = (provider: () => SyncStatus[]): void => {
  syncProvider = provider;
};

export function readMeshSettings(config: PeersConfig | null = rt.config): MeshSettings {
  const c = config ?? emptyConfig();
  const sync = Object.fromEntries(SYNC_CATEGORIES.map((k) => [k, c.sync[k] ?? true])) as Record<SyncCategory, boolean>;
  return {
    hostLabel: c.self.label,
    sync,
    frontDoor: c.frontDoor,
    ...(c.frontDoorOrder ? { frontDoorOrder: c.frontDoorOrder } : {}),
    ...(c.self.serveUrl ? { serveUrl: c.self.serveUrl } : {}),
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

/**
 * GET/POST/… <peer>/<path> over the peer hop (the peer's gate sees this host's node). Throws when
 * the mesh is off or the peer is unknown; otherwise it is fetch: a down peer rejects, a refusal
 * is a 403 with X-Sova-Mesh: refused. `path` starts with "/api/".
 */
export function peerFetch(peerId: string, path: string, init?: RequestInit): Promise<Response> {
  const peer = rt.config?.peers.find((p) => p.id === peerId);
  if (!meshEnabled() || !peer) return Promise.reject(new Error(`unknown peer ${peerId}`));
  const headers = new Headers(init?.headers);
  headers.delete(PROXIED_HEADER); // it would make the peer treat this host's own call as a browser's
  return fetch(`${peerUrl(peer)}${path}`, { ...init, headers });
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
    if (rt.listener) runHooks([fn]);
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
};
export type MeshApi = typeof meshApi;

// ---- state ------------------------------------------------------------------------------------

async function peerStatuses(): Promise<PeerStatus[]> {
  const peers = rt.config?.peers ?? [];
  const probes = await Promise.all(peers.map((p) => probePeer(p)));
  peers.forEach((p, i) => sawPeer(p.id, probes[i]!.state === "up"));
  return peers.map((p, i) => ({
    id: p.id,
    label: p.label,
    nodeId: p.nodeId,
    name: p.dnsName,
    url: peerUrl(p),
    ...(p.priority !== undefined ? { priority: p.priority } : {}),
    state: probes[i]!.state,
    ...(probes[i]!.error ? { error: probes[i]!.error } : {}),
    ...(probes[i]!.hello ? { hello: probes[i]!.hello } : {}),
    lastSeen: peerLastSeen(p.id),
  }));
}

async function meshInfo(): Promise<MeshInfo> {
  const c = rt.config ?? emptyConfig();
  const on = meshEnabled();
  const info: MeshInfo = {
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

async function meshSessions(): Promise<MeshSessions> {
  const peers = rt.config?.peers ?? [];
  const rows = await Promise.all(
    peers.map(async (p): Promise<MeshSessions["peers"][number]> => {
      const head = { id: p.id, label: p.label };
      try {
        const res = await fetch(`${peerUrl(p)}/api/sessions`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.ok) {
          const sessions = (await res.json()) as SessionSummary[];
          if (!Array.isArray(sessions)) throw new Error("not a session list");
          lastGood.set(p.id, sessions);
          return { ...head, state: "up", sessions };
        }
        await res.body?.cancel();
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
  for (const r of rows) sawPeer(r.id, r.state === "up");
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
  let body: { peers?: unknown };
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
    peers.push({
      id: e.id,
      ...(e.label !== undefined ? { label: e.label } : prior ? { label: prior.label } : {}),
      nodeId,
      dnsName,
      ...(e.url !== undefined ? { url: e.url } : prior?.url ? { url: prior.url } : {}),
      ...(e.priority !== undefined ? { priority: e.priority } : prior?.priority !== undefined ? { priority: prior.priority } : {}),
      ...(e.serveUrl !== undefined ? { serveUrl: e.serveUrl } : prior?.serveUrl ? { serveUrl: prior.serveUrl } : {}),
    });
  }
  const v = validatePeers({ ...base.config, peers });
  if ("error" in v) return c.json({ error: v.error }, 400);
  writePeers(v.config);
  reload();
  return c.json(await meshInfo());
}

async function putSettings(c: Context): Promise<Response> {
  let body: Partial<MeshSettings>;
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
  const self = { ...base.config.self };
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
    return c.json(frontDoorConfig(rt.config ?? emptyConfig(), meshEnabled() ? (rt.self?.dnsName ?? null) : null));
  });
  app.get("/api/mesh/hello", (c) => c.json(ownHello(meshSelf(), rt.self?.nodeId)));

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
    return tail ? proxyPeer(c, peer, tail) : c.json({ error: "Not found" }, 404);
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
  upgradePeerSocket(req, socket, head, peer, route[1], url.search);
  return true;
}
