import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { refuse } from "../extensions";
import { REFUSED_HEADER } from "./hello";
import { getIdentity, whoisAddr } from "./localapi";
import type { PeerEntry } from "./peers";

// The peer listener: a second HTTP server on this node's tailnet addresses, running only while
// the mesh is on. It has ONE check, on every request and every upgrade: the caller's Tailscale
// StableID (LocalAPI whois of the connection's source address) must be a peer in peers.json.
// Everything else is 403. What passes is dispatched into the same Hono app as the main listener,
// with the calling peer in `c.env.meshPeer`, so every route answers a peer exactly as it answers
// the local browser; a peer never reaches /api/mesh/*, /peer/*, /ext/* or the static files.

const RETRY_MS = 15_000;

export interface ListenerDeps {
  /** The Hono app's fetch. */
  fetch: (req: Request, env: Record<string, unknown>) => Response | Promise<Response>;
  /** The /ws/chat + /ws/watch upgrade handler (server/ws.ts). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The peer with this StableID, from the current peers.json, or null. */
  peerByNode: (nodeId: string) => PeerEntry | null;
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
  if (!pathname.startsWith("/api/")) return false;
  return pathname !== "/api/mesh" && !pathname.startsWith("/api/mesh/");
}

// The caller's StableID per TCP connection (null: not a tailnet node). Membership is re-checked
// on every request against the current peers.json, so a removed peer loses a kept-alive
// connection too.
const whoisBySocket = new WeakMap<Socket, Promise<string | null>>();

function callerNode(socket: Socket): Promise<string | null> {
  let hit = whoisBySocket.get(socket);
  if (!hit) {
    const addr = socket.remoteAddress;
    const port = socket.remotePort;
    hit =
      addr && port
        ? getIdentity()
            .whois(whoisAddr(addr, port))
            .then((w) => w?.nodeId ?? null)
            .catch((err) => {
              console.warn(`[mesh] whois ${addr}:${port} failed: ${(err as Error).message}`);
              return null;
            })
        : Promise.resolve(null);
    whoisBySocket.set(socket, hit);
  }
  return hit;
}

const REFUSAL = { error: "not a peer" };

export class PeerListener {
  private servers: Server[] = [];
  private state: ListenerState;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly handle: (req: IncomingMessage, res: ServerResponse) => void;

  constructor(private readonly deps: ListenerDeps) {
    this.state = { addresses: [], port: deps.port };
    this.handle = getRequestListener((req, env) => {
      const peer = (env.incoming as IncomingMessage & { meshPeer?: PeerEntry }).meshPeer;
      return deps.fetch(req, { ...env, meshPeer: peer });
    });
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
      const server = this.createServer();
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

  private async gate(req: IncomingMessage): Promise<PeerEntry | null> {
    const node = await callerNode(req.socket);
    return node ? this.deps.peerByNode(node) : null;
  }

  private createServer(): Server {
    const server = createServer(async (req, res) => {
      const peer = await this.gate(req);
      if (!peer) {
        res.writeHead(403, { "Content-Type": "application/json", [REFUSED_HEADER]: "refused" });
        res.end(JSON.stringify(REFUSAL));
        return;
      }
      const url = new URL(req.url ?? "/", "http://peer");
      if (!peerMayReach(url.pathname) || url.pathname.startsWith("/ws/")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      (req as IncomingMessage & { meshPeer?: PeerEntry }).meshPeer = peer;
      this.handle(req, res);
    });
    server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => {});
      const peer = await this.gate(req);
      if (!peer) {
        refuseWith(socket, 403, REFUSAL, { [REFUSED_HEADER]: "refused" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://peer");
      if (url.pathname !== "/ws/chat" && url.pathname !== "/ws/watch") {
        refuse(socket, 404, { error: "Not found" });
        return;
      }
      this.deps.upgrade(req, socket, head);
    });
    return server;
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
