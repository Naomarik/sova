import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { linkAccess } from "../baton";
import { TOKEN_RE } from "../baton-links";
import { refuse } from "../extensions";
import { addWatcher, viewForToken } from "./hub";
import { createShareApp } from "./routes";

/**
 * The share listener (§app.baton/share-listener): the ONE port an organization's home host exposes
 * to people outside the tailnet. A separate `http.Server` with its own Hono app (server/share/
 * routes.ts) and its own WebSocket server. Every request is judged against an allowlist of exact
 * shapes on the RAW path, before any routing: anything else is a 404 that never reaches a router,
 * so the operator app, /api/*, /ws/chat, /ws/watch, /peer/* and /ext/* do not exist here.
 *
 * Bound only when SOVA_SHARE_HOST and SOVA_SHARE_PORT are both set. Public exposure (a TLS reverse
 * proxy in front of it) is a deployment step outside Sova.
 */

const TOKEN = "[A-Za-z0-9_-]{43}";
const ROUTES: { method: string; re: RegExp }[] = [
  { method: "GET", re: new RegExp(`^/h/${TOKEN}$`) },
  { method: "GET", re: /^\/h\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/ },
  { method: "GET", re: new RegExp(`^/api/h/${TOKEN}$`) },
  { method: "POST", re: new RegExp(`^/api/h/${TOKEN}/message$`) },
];

/** Whether a request may reach the share app. Raw pathname, exact shapes, no escapes at all (a
    token or an asset name never needs one, and a decoded path is never re-judged). */
export function shareMayReach(method: string, pathname: string): boolean {
  if (pathname.includes("%")) return false;
  const m = method === "HEAD" ? "GET" : method;
  return ROUTES.some((r) => r.method === m && r.re.test(pathname));
}

export const BODY_MAX = 16 * 1024;
export const REQUESTS_PER_MINUTE = 60;
/** A request's headers must arrive within this, and its whole body within REQUEST_TIMEOUT_MS
    (else 408): a 16 KB body needs no more, and a slow client can't hold a socket for Node's
    default five minutes. */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The client's address for the per-address limit. Behind the reverse proxy every connection comes
 * from the proxy, so a loopback or tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) peer's last
 * X-Forwarded-For hop is used instead — the hop the proxy itself appended.
 */
export function clientAddress(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } }): string {
  const peer = req.socket.remoteAddress ?? "";
  const plain = peer.replace(/^::ffff:/, "");
  const proxied = plain === "127.0.0.1" || plain === "::1" || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(plain) || /^fd7a:115c:a1e0:/i.test(plain);
  const xff = req.headers["x-forwarded-for"];
  if (proxied && typeof xff === "string" && xff.trim()) return xff.split(",").pop()!.trim();
  return plain || "unknown";
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}
  /** Count one hit; true when over the limit. */
  limited(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const over = recent.length >= this.limit;
    if (!over) recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return over;
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

export interface ShareListenerState {
  host: string;
  port: number;
}

/** Build (not bind) the share server: tests bind it on port 0 (and may shorten the timeouts). */
export function createShareServer(timeouts: { headersMs?: number; requestMs?: number; checkMs?: number } = {}): Server {
  const app = createShareApp();
  const handle = getRequestListener(app.fetch);
  const perAddress = new RateLimiter(REQUESTS_PER_MINUTE);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const requestTimeout = timeouts.requestMs ?? REQUEST_TIMEOUT_MS;
  const options = {
    headersTimeout: Math.min(timeouts.headersMs ?? HEADERS_TIMEOUT_MS, requestTimeout),
    requestTimeout,
    // How often Node looks for requests past those limits (default 30 s).
    connectionsCheckingInterval: timeouts.checkMs ?? 1000,
  };
  const server = createServer(options, (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://share");
    } catch {
      json(res, 400, { error: "Bad request" });
      return;
    }
    if (!shareMayReach(req.method ?? "GET", url.pathname)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    if (perAddress.limited(clientAddress(req))) {
      json(res, 429, { error: "Too many requests" });
      return;
    }
    if (req.method === "POST") {
      const len = Number(req.headers["content-length"]);
      if (!Number.isFinite(len) || len > BODY_MAX) {
        json(res, 413, { error: "Request body too large" });
        req.resume();
        return;
      }
    }
    handle(req, res);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://share");
    } catch {
      refuse(socket, 400, { error: "Bad request" });
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/ws/h" || !TOKEN_RE.test(token)) {
      refuse(socket, 404, { error: "Not found" });
      return;
    }
    if (perAddress.limited(clientAddress(req))) {
      refuse(socket, 429, { error: "Too many requests" });
      return;
    }
    const access = linkAccess(token);
    if (!access.ok) {
      refuse(socket, access.status, { error: access.status === 410 ? "This link is no longer active." : "Unknown link." });
      return;
    }
    const sessionId = access.row.sessionId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Read-only: messages go through POST /api/h/<token>/message. Anything sent here is ignored.
      ws.on("message", () => {});
      // A frame over maxPayload (or any protocol error): ws closes the socket (1009 and the like);
      // without a listener the error would escape as an uncaughtException.
      ws.on("error", (err) => console.warn(`[share] socket error: ${err.message}`));
      addWatcher(sessionId, ws, token);
      void viewForToken(token).then((view) => {
        if (!("status" in view) && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "view", view }));
      });
    });
  });
  return server;
}

let bound: { server: Server; state: ShareListenerState } | null = null;

/** Bind from the environment; a no-op (and null) unless SOVA_SHARE_HOST and SOVA_SHARE_PORT are set. */
export function startShareListener(env: NodeJS.ProcessEnv = process.env): Promise<ShareListenerState | null> {
  const host = env.SOVA_SHARE_HOST?.trim();
  const port = Number(env.SOVA_SHARE_PORT);
  if (!host || !env.SOVA_SHARE_PORT || !Number.isInteger(port) || port < 0 || port > 65535) return Promise.resolve(null);
  const server = createShareServer();
  return new Promise((resolve) => {
    server.once("error", (err) => {
      console.warn(`[share] listener not up on ${host}:${port}: ${err.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      const actual = (server.address() as { port: number }).port;
      bound = { server, state: { host, port: actual } };
      console.log(`[share] share listener on http://${host}:${actual}`);
      resolve(bound.state);
    });
  });
}

export function stopShareListener(): void {
  if (!bound) return;
  bound.server.close();
  bound.server.closeAllConnections();
  bound = null;
}

/** Where the operator app builds full links: SOVA_SHARE_PUBLIC_URL, else the bound address. */
export function shareInfo(env: NodeJS.ProcessEnv = process.env): { bound: boolean; publicUrl: string | null } {
  const pub = env.SOVA_SHARE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (pub) return { bound: !!bound, publicUrl: pub };
  return { bound: !!bound, publicUrl: bound ? `http://${bound.state.host.includes(":") ? `[${bound.state.host}]` : bound.state.host}:${bound.state.port}` : null };
}
