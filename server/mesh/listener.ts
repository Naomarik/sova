import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { refuse } from "../extensions";
import { DENIED } from "../../shared/mesh-access";
import { REFUSED_HEADER } from "./hello";
import { classifyRequest, classifyUpgrade, type Need } from "./access";
import { judgedPath } from "./paths";
import { callerNode } from "./gate";
import type { PeerEntry } from "./peers";

// The peer listener: a second HTTP server on this node's tailnet addresses, running only while
// the mesh is on. It has ONE check, on every request and every upgrade: the caller's Tailscale
// StableID (LocalAPI whois of the connection's source address, callerNode in ./gate, which the
// share ingress's gate uses too) must be a peer in peers.json; membership is re-checked on every
// request against the current peers.json, so a removed peer loses a kept-alive connection too.
// Everything else is 403. What passes is then held to this host's grant to that peer
// (§mesh.peers/grants, server/mesh/access.ts): a request or upgrade the grant doesn't cover is 403
// with X-Sova-Mesh: denied ("refused" keeps meaning "not a peer"). What passes both is dispatched
// into the same Hono app as the main listener, with the calling peer in `c.env.meshPeer`, so every
// route answers a peer exactly as it answers the local browser; a peer never reaches /api/mesh/*,
// /peer/*, /ext/* or the static files.

const RETRY_MS = 15_000;

export interface ListenerDeps {
  /** The Hono app's fetch. */
  fetch: (req: Request, env: Record<string, unknown>) => Response | Promise<Response>;
  /** The /ws/chat + /ws/watch upgrade handler (server/ws.ts). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The peer with this StableID, from the current peers.json, or null. */
  peerByNode: (nodeId: string) => PeerEntry | null;
  /** Whether this peer's grant covers what a request needs (§mesh.peers/grants); absent = always. */
  allows?: (peer: PeerEntry, need: Need) => boolean;
  /** The addresses to bind: SOVA_PEER_HOST, else this node's tailnet IPs. */
  addresses: () => Promise<string[]>;
  port: number;
}

export interface ListenerState {
  addresses: string[];
  port: number;
  error?: string;
}

/** Whether a peer may reach this path on the peer listener. */
export function peerMayReach(pathname: string): boolean {
  if (pathname === "/ws/chat" || pathname === "/ws/watch") return true;
  // Judged as the router will route it (decoded), never on the raw spelling: "/api/%6Desh" IS
  // /api/mesh to Hono. /api/peer/* stays reachable: those routes are for peers.
  const path = judgedPath(pathname);
  return !!path && path.startsWith("/api/") && !/^\/api\/mesh(?:\/|$)/.test(path);
}

const REFUSAL = { error: "not a peer" };
const DENIAL = { error: "not shared with this host" };

/** Who is calling on a request's connection: the peer, from the current peers.json, or null. */
export type Identify = (req: IncomingMessage) => Promise<PeerEntry | null> | PeerEntry | null;

export type GateDeps = Pick<ListenerDeps, "fetch" | "upgrade" | "allows">;

/**
 * Everything after "who is calling" (§mesh.peers/listener): what a peer may reach, the grant
 * check (§mesh.peers/grants), dispatch into the app with the caller in `c.env.meshPeer`, and the
 * record of what each connection was let through for, so a removed peer or a lowered grant ends
 * it. The tailnet listener and the dial-out pairings' streams (§mesh.lan/as-a-peer) share it; only
 * how the caller is known differs.
 */
export class PeerGate {
  /** Every connection that passed the gate, by the caller's node id (HTTP keep-alive and upgraded
      sockets alike: an upgrade keeps the same connection). */
  private admitted = new Map<Duplex, string>();
  /** What each admitted connection was last let through for: its last request's need, or its
      socket's (an upgrade keeps it for as long as the socket lives). */
  private admittedFor = new Map<Duplex, Need>();
  private readonly handle: (req: IncomingMessage, res: ServerResponse) => void;

  constructor(private readonly deps: GateDeps) {
    this.handle = getRequestListener((req, env) => {
      const peer = (env.incoming as IncomingMessage & { meshPeer?: PeerEntry }).meshPeer;
      return deps.fetch(req, { ...env, meshPeer: peer });
    });
  }

  private async identified(req: IncomingMessage, identify: Identify): Promise<PeerEntry | null> {
    const peer = await identify(req);
    if (peer && !this.admitted.has(req.socket)) {
      this.admitted.set(req.socket, peer.nodeId);
      req.socket.once("close", () => {
        this.admitted.delete(req.socket);
        this.admittedFor.delete(req.socket);
      });
    }
    return peer;
  }

  /** The grant check after identity; records what the connection was let through for. */
  private granted(req: IncomingMessage, peer: PeerEntry, need: Need): boolean {
    if (this.deps.allows && !this.deps.allows(peer, need)) return false;
    this.admittedFor.set(req.socket, need);
    return true;
  }

  /** An HTTP server answering through this gate, its callers known by `identify`. The tailnet
      listener listens on it; a pairing's is never listened on and is fed streams. */
  server(identify: Identify): Server {
    const server = createServer((req, res) => void this.request(req, res, identify));
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(req, socket, head, identify));
    return server;
  }

  async request(req: IncomingMessage, res: ServerResponse, identify: Identify): Promise<void> {
    const peer = await this.identified(req, identify);
    if (!peer) {
      res.writeHead(403, { "Content-Type": "application/json", [REFUSED_HEADER]: "refused" });
      res.end(JSON.stringify(REFUSAL));
      return;
    }
    const url = requestUrl(req);
    if (!url) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }
    if (!peerMayReach(url.pathname) || url.pathname.startsWith("/ws/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (!this.granted(req, peer, classifyRequest(req.method ?? "GET", url.pathname).need)) {
      res.writeHead(403, { "Content-Type": "application/json", [REFUSED_HEADER]: DENIED });
      res.end(JSON.stringify(DENIAL));
      return;
    }
    (req as IncomingMessage & { meshPeer?: PeerEntry }).meshPeer = peer;
    this.handle(req, res);
  }

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, identify: Identify): Promise<void> {
    socket.on("error", () => {});
    const peer = await this.identified(req, identify);
    if (!peer) {
      refuseWith(socket, 403, REFUSAL, { [REFUSED_HEADER]: "refused" });
      return;
    }
    const url = requestUrl(req);
    if (!url) {
      refuse(socket, 400, { error: "Bad request" });
      return;
    }
    if (url.pathname !== "/ws/chat" && url.pathname !== "/ws/watch") {
      refuse(socket, 404, { error: "Not found" });
      return;
    }
    if (!this.granted(req, peer, classifyUpgrade(url.pathname, url.searchParams).need)) {
      refuseWith(socket, 403, DENIAL, { [REFUSED_HEADER]: DENIED });
      return;
    }
    this.deps.upgrade(req, socket, head);
  }

  /** Drop every admitted connection whose caller is no longer allowed (a peer removed from
      peers.json): its kept-alive HTTP connections and its open sockets end now. */
  revoke(allowed: (nodeId: string) => boolean): void {
    for (const [socket, nodeId] of this.admitted) {
      if (allowed(nodeId)) continue;
      this.admitted.delete(socket);
      this.admittedFor.delete(socket);
      socket.destroy();
    }
  }

  /** Drop every admitted connection whose grant no longer covers what it was let through for (a
      lowered grant): its open sockets and kept-alive connections end now (§mesh.peers/grants). */
  revokeGrants(allows: (nodeId: string, need: Need) => boolean): void {
    for (const [socket, need] of this.admittedFor) {
      const nodeId = this.admitted.get(socket);
      if (nodeId === undefined || allows(nodeId, need)) continue;
      this.admitted.delete(socket);
      this.admittedFor.delete(socket);
      socket.destroy();
    }
  }
}

export class PeerListener {
  private servers: Server[] = [];
  private state: ListenerState;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly gate: PeerGate;

  constructor(private readonly deps: ListenerDeps) {
    this.state = { addresses: [], port: deps.port };
    this.gate = new PeerGate(deps);
  }

  info(): ListenerState {
    return { ...this.state, addresses: [...this.state.addresses] };
  }

  /** Bind every address; on failure (tailscaled not up yet) retry every 15 s until closed. */
  async start(): Promise<void> {
    if (this.closed) return;
    let addresses: string[];
    try {
      addresses = await this.deps.addresses();
      if (!addresses.length) throw new Error("this node has no tailnet address");
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }
    const bound: string[] = [];
    const errors: string[] = [];
    let port = this.deps.port;
    for (const address of addresses) {
      if (this.closed) return;
      const server = this.gate.server(async (req) => {
        const node = await callerNode(req.socket);
        return node ? this.deps.peerByNode(node) : null;
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, address, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", (err) => console.warn(`[mesh] peer listener ${address}: ${err.message}`));
        port = (server.address() as { port: number }).port; // PORT 0 (tests): every family on the one port
        this.servers.push(server);
        bound.push(address);
      } catch (err) {
        errors.push(`${address}: ${(err as Error).message}`);
      }
    }
    if (this.closed) {
      this.close();
      return;
    }
    if (!bound.length) {
      this.fail(errors.join("; "));
      return;
    }
    this.state = { addresses: bound, port, ...(errors.length ? { error: errors.join("; ") } : {}) };
    console.log(`[mesh] peer listener on ${bound.map((a) => (a.includes(":") ? `[${a}]` : a)).join(", ")} port ${port}`);
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const s of this.servers.splice(0)) {
      s.close();
      s.closeAllConnections();
    }
    // closeAllConnections leaves upgraded sockets alone: a mesh turned off cuts peers' sockets too.
    this.gate.revoke(() => false);
    this.state = { addresses: [], port: this.deps.port };
  }

  private fail(error: string): void {
    this.state = { addresses: [], port: this.deps.port, error };
    console.warn(`[mesh] peer listener not up (retrying in ${RETRY_MS / 1000}s): ${error}`);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, RETRY_MS);
    this.retry.unref();
  }

  revoke(allowed: (nodeId: string) => boolean): void {
    this.gate.revoke(allowed);
  }

  revokeGrants(allows: (nodeId: string, need: Need) => boolean): void {
    this.gate.revokeGrants(allows);
  }
}

/** The request target as a URL, or null when it doesn't parse (e.g. "//x%zz/api": a bad authority). */
function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://peer");
  } catch {
    return null;
  }
}

/** refuse() with extra headers (the gate's marker). */
function refuseWith(socket: Duplex, status: number, body: object, headers: Record<string, string>): void {
  if (socket.destroyed) return;
  const json = JSON.stringify(body);
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  socket.end(
    `HTTP/1.1 ${status} Forbidden\r\nContent-Type: application/json\r\n${extra}` + `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
  );
}
