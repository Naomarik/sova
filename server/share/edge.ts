import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { linkAccess } from "../baton";
import { TOKEN_RE } from "../baton-links";
import { refuse } from "../extensions";
import { REFUSED_HEADER } from "../mesh/hello";
import { addWatcher, viewForToken } from "./hub";
import { socketClosed, socketOpened } from "../visits";
import { createShareApp, logVisit, PAGE_CSP } from "./routes";
import { clientAddress } from "./security";

// Today's client-address rule lives with the other trust helpers; its old import path stays.
export { clientAddress };

/**
 * The share edge (§app.baton/share-listener): what every share-serving `http.Server` does before a
 * request reaches whatever answers it. Every request is judged against an allowlist of exact
 * shapes on the RAW path, before any routing: anything else is a 404 that never reaches a router,
 * so the operator app, /api/*, /ws/chat, /ws/watch, /peer/* and /ext/* do not exist here. Then the
 * per-address limit, the body cap and the timeouts, then the `dispatch` / `upgrade` hook.
 *
 * The hooks default to the in-process share app (server/share/routes.ts) and its WebSocket server,
 * which is all today's listener runs. The public-links gateway replaces them with its router (a
 * token's hash → this host or the routed host that minted it), and a routed host's ingress adds
 * `admit` (only its gateway may connect). server/share/listener.ts binds.
 */

const TOKEN = "[A-Za-z0-9_-]{43}";
const ROUTES: { method: string; re: RegExp }[] = [
  { method: "GET", re: new RegExp(`^/h/${TOKEN}$`) },
  { method: "GET", re: /^\/h\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/ },
  { method: "GET", re: new RegExp(`^/api/h/${TOKEN}$`) },
  { method: "POST", re: new RegExp(`^/api/h/${TOKEN}/message$`) },
  // The Owner page (§app.owner-page/link): read-only, GET only, no socket.
  { method: "GET", re: new RegExp(`^/i/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}/p/q_[a-z2-9]{8}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}/c/k_[a-z2-9]{8}$`) },
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

const PAGE_SHELL = new RegExp(`^/[hi]/${TOKEN}$`);
/** A phone past the address limit reloading its link gets a page, not raw JSON. Static: no token,
    no names. */
const TOO_MANY_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many requests</title></head>' +
  '<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5"><p>Too many requests from this network. Wait a minute, then reload.</p></body></html>';

function tooMany(res: ServerResponse, page: boolean): void {
  if (!page) return json(res, 429, { error: "Too many requests" });
  res.writeHead(429, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": PAGE_CSP,
    "Retry-After": "60",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(TOO_MANY_PAGE);
}

function json(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers });
  res.end(JSON.stringify(body));
}

/** A client→server `/ws/h` message larger than this closes the socket. Whatever answers a `/ws/h`
    upgrade enforces it BEFORE forwarding a message anywhere (the in-process upgrader does it with
    maxPayload; a gateway's hop must too); the edge itself sees no frames. Messages to the client
    (the filtered view) are not capped by it. */
export const SHARE_WS_MAX_PAYLOAD = 1024;

const NOT_ADMITTED = { error: "not the gateway" };

/** refuse() with the gate's marker, so the gateway tells "this host refused you" from a route's 403. */
function refuseMarked(socket: Duplex): void {
  if (socket.destroyed) return;
  const body = JSON.stringify(NOT_ADMITTED);
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n${REFUSED_HEADER}: refused\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** What a request is, for a log line: its route family, never its path (a path carries a token). */
function routeKind(pathname: string): string {
  if (pathname.startsWith("/h/assets/")) return "asset";
  if (pathname.startsWith("/api/")) return pathname.startsWith("/api/i/") ? "owner api" : "api";
  if (pathname === "/ws/h") return "socket";
  return pathname.startsWith("/i/") ? "owner page" : "page";
}

/** What a request passed on its way through the edge. */
export interface ShareRequestContext {
  /** The request target, parsed. Its pathname passed shareMayReach; note that URL parsing has
      already resolved dot segments (judging the raw target is the security milestone's). */
  url: URL;
  /** The rate-limit key the request was counted under. */
  client: string;
}

/** A `/ws/h` upgrade that passed the edge: the path, the token's shape and the address limit. */
export interface ShareUpgradeContext extends ShareRequestContext {
  /** The `token` query parameter, matching TOKEN_RE. */
  token: string;
}

/** Answers a request that passed the edge. It owns `res` from here; a throw or rejection becomes
    a 500 (or a destroyed socket once headers went out). */
export type ShareDispatch = (req: IncomingMessage, res: ServerResponse, ctx: ShareRequestContext) => void | Promise<void>;
/** Answers a `/ws/h` upgrade that passed the edge. It owns `socket` from here, and enforces
    SHARE_WS_MAX_PAYLOAD before forwarding any client message; a throw or rejection ends the
    socket (a 500 if nothing was written yet). */
export type ShareUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, ctx: ShareUpgradeContext) => void | Promise<void>;

export interface ShareServerOptions {
  headersMs?: number;
  requestMs?: number;
  checkMs?: number;
  /** Runs first, on every request and every upgrade, before the allowlist: false, a throw or a
      rejection is 403 with REFUSED_HEADER and `Connection: close`. Absent (the default): every
      connection is admitted, with no async step. */
  admit?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /** The per-address limit's key. Default: clientAddress. A throw is a 500. */
  client?: (req: IncomingMessage) => string;
  /** Default: the in-process share app. */
  dispatch?: ShareDispatch;
  /** Default: the in-process `/ws/h` (the link's session, read-only). */
  upgrade?: ShareUpgrade;
}

/** The in-process share app and its `/ws/h`: the hooks' defaults, and what a gateway's router
    runs for a token this host minted itself. Each call builds a new app and WebSocket server, so
    call it once per server, never per request. */
export function inProcessShare(): { dispatch: ShareDispatch; upgrade: ShareUpgrade } {
  const handle = getRequestListener(createShareApp().fetch);
  const wss = new WebSocketServer({ noServer: true, maxPayload: SHARE_WS_MAX_PAYLOAD });
  const dispatch: ShareDispatch = (req, res) => {
    handle(req, res);
  };
  const upgrade: ShareUpgrade = (req, socket, head, { url, token }) => {
    const access = linkAccess(token);
    if (!access.ok) {
      refuse(socket, access.status, { error: access.status === 410 ? "This link is no longer active." : "Unknown link.", ...(access.why ? { why: access.why } : {}) });
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
      // A socket continues the tab's visit (never starts one); its close is the visit's last seen.
      logVisit(token, "socket", () => {
        const visit = socketOpened(access.link, { tab: url.searchParams.get("v"), userAgent: req.headers["user-agent"] });
        if (visit) ws.on("close", () => logVisit(token, "socket close", () => socketClosed(visit)));
      });
      void viewForToken(token).then((view) => {
        if (!("status" in view) && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "view", view }));
      });
    });
  };
  return { dispatch, upgrade };
}

/** Run a hook: a synchronous throw and an asynchronous rejection both reach `failed`. */
function guarded(run: () => void | Promise<void>, failed: (err: unknown) => void): void {
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (err) {
    failed(err);
    return;
  }
  if (result instanceof Promise) result.catch(failed);
}

/** Run `admit`: true only for a resolved true; a throw or rejection is a refusal. */
function admitted(admit: (req: IncomingMessage) => boolean | Promise<boolean>, req: IncomingMessage): Promise<boolean> {
  try {
    return Promise.resolve(admit(req)).then(
      (ok) => ok === true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** While admission is pending on an upgrade, notice a client that leaves: its EOF only shows on a
    flowing socket, so read into a buffer (at most 64 KB, else it's gone). Returns "stop
    watching": whether it left, and the bytes it sent meanwhile (they belong after `head`). The
    socket goes back as Node hands it to an upgrade handler: not flowing, so the next `data`
    listener (ws's, a proxy's) starts it. */
function watchLeaving(socket: Duplex): () => { gone: boolean; early: Buffer } {
  const chunks: Buffer[] = [];
  let size = 0;
  let gone = false;
  const onData = (d: Buffer) => {
    size += d.length;
    if (size > 64 * 1024) {
      gone = true;
      socket.destroy();
    } else chunks.push(d);
  };
  const onEnd = () => {
    gone = true;
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  return () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.pause();
    (socket as { readableFlowing: boolean | null }).readableFlowing = null;
    return { gone: gone || socket.destroyed, early: Buffer.concat(chunks) };
  };
}

/** A hook failed: log what kind of request and error it was, never the path, query or message. */
function logFailure(where: string, pathname: string, err: unknown): void {
  const kind = err instanceof Error ? err.name : typeof err;
  console.warn(`[share] ${where} failed on a ${routeKind(pathname)} request (${kind})`);
}

/** Build (not bind) a share server: tests bind it on port 0 (and may shorten the timeouts). */
export function createShareServer(opts: ShareServerOptions = {}): Server {
  const local = opts.dispatch && opts.upgrade ? null : inProcessShare();
  const dispatch = opts.dispatch ?? local!.dispatch;
  const upgrade = opts.upgrade ?? local!.upgrade;
  const clientOf = opts.client ?? clientAddress;
  const perAddress = new RateLimiter(REQUESTS_PER_MINUTE);
  const requestTimeout = opts.requestMs ?? REQUEST_TIMEOUT_MS;
  const options = {
    headersTimeout: Math.min(opts.headersMs ?? HEADERS_TIMEOUT_MS, requestTimeout),
    requestTimeout,
    // How often Node looks for requests past those limits (default 30 s).
    connectionsCheckingInterval: opts.checkMs ?? 1000,
  };
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
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
    const failed = (where: string) => (err: unknown) => {
      logFailure(where, url.pathname, err);
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: "Internal error" });
      else res.destroy();
    };
    let client: string;
    try {
      client = clientOf(req);
    } catch (err) {
      failed("client")(err);
      return;
    }
    if (perAddress.limited(client)) {
      tooMany(res, PAGE_SHELL.test(url.pathname));
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
    guarded(() => dispatch(req, res, { url, client }), failed("dispatch"));
  };
  const serveUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
    const failed = (where: string) => (err: unknown) => {
      logFailure(where, url.pathname, err);
      if (!socket.destroyed && socket.writable) refuse(socket, 500, { error: "Internal error" });
      else socket.destroy();
    };
    let client: string;
    try {
      client = clientOf(req);
    } catch (err) {
      failed("client")(err);
      return;
    }
    if (perAddress.limited(client)) {
      refuse(socket, 429, { error: "Too many requests" });
      return;
    }
    guarded(() => upgrade(req, socket, head, { url, token, client }), failed("upgrade"));
  };
  const admit = opts.admit;
  const server = createServer(options, (req, res) => {
    if (!admit) return serve(req, res);
    void admitted(admit, req).then((ok) => {
      if (res.destroyed || req.socket.destroyed) return; // the client left while we decided
      if (ok) return serve(req, res);
      json(res, 403, NOT_ADMITTED, { [REFUSED_HEADER]: "refused", Connection: "close" });
      req.resume();
    }).catch(() => res.destroy());
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    if (!admit) return serveUpgrade(req, socket, head);
    const watched = watchLeaving(socket);
    void admitted(admit, req).then((ok) => {
      const { gone, early } = watched();
      if (gone) return void socket.destroy(); // the client left while we decided
      if (ok) serveUpgrade(req, socket, early.length ? Buffer.concat([head, early]) : head);
      else refuseMarked(socket);
    }).catch(() => socket.destroy());
  });
  return server;
}
