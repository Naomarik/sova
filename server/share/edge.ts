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
import { sessionShareUpgrade } from "./session-routes";
import { PREVIEW_LIMITS } from "../../shared/public-links";
import { previewAnswer, previewUpgradeAnswer } from "./preview-pages";
import { clientAddress, trustedClient } from "./security";
import { noteShareClient } from "../visitor-identity";
import { MB, PHOTO_MB } from "../../shared/baton";
import { UPLOAD_BODY_SLACK } from "../baton-images";
import { enforceMaxPayload } from "../ws-max-payload";

// The old client-address rule lives with the other trust helpers; its old import path stays.
export { clientAddress };

/**
 * The share edge (§app.baton/share-listener): what every share-serving `http.Server` does before a
 * request reaches whatever answers it. Every request is judged against an allowlist of exact
 * shapes on the RAW request target, before any URL parsing (which would resolve `..`, `%2e` and
 * the like): anything but an origin-form target whose path is one of those shapes is refused and
 * never reaches a router, so the operator app, /api/*, /ws/chat, /ws/watch, /peer/* and /ext/* do
 * not exist here. Then the per-address limit (keyed by trustedClient), the body cap and the
 * timeouts, then the `dispatch` / `upgrade` hook.
 *
 * The hooks default to the in-process share app (server/share/routes.ts) and its WebSocket server,
 * which is all today's listener runs. The public-links gateway replaces them with its router (a
 * token's hash → this host or the routed host that minted it), and a routed host's ingress adds
 * `admit` (only its gateway may connect). server/share/listener.ts binds.
 *
 * With `preview`, a request is first split by what `preview.match` says (§mesh.public/preview-address):
 * the gateway's listener matches a Host `<label>.<zone>`, a routed host's ingress the header its
 * admitted gateway set. A preview request skips the share allowlist (every path is the app's), its
 * raw target passes byte for byte, and it has its own per-address limit per preview
 * (§mesh.public/preview-limits); everything else keeps the share host's rules exactly.
 */

const TOKEN = "[A-Za-z0-9_-]{43}";
const ROUTES: { method: string; re: RegExp }[] = [
  { method: "GET", re: new RegExp(`^/h/${TOKEN}$`) },
  { method: "GET", re: /^\/h\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/ },
  { method: "GET", re: new RegExp(`^/api/h/${TOKEN}$`) },
  { method: "POST", re: new RegExp(`^/api/h/${TOKEN}/message$`) },
  // A person's photos (§app.baton/images): the upload, and one photo of the link's view.
  { method: "POST", re: new RegExp(`^/api/h/${TOKEN}/image$`) },
  { method: "GET", re: new RegExp(`^/api/h/${TOKEN}/img/(?:0|[1-9][0-9]{0,3})$`) },
  // The Owner page (§app.owner-page/link): read-only, GET only, no socket.
  { method: "GET", re: new RegExp(`^/i/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}/p/q_[a-z2-9]{8}$`) },
  { method: "GET", re: new RegExp(`^/api/i/${TOKEN}/c/k_[a-z2-9]{8}$`) },
  // Session shares (§app/session-share): read-only, GET only; their socket is /ws/s.
  { method: "GET", re: new RegExp(`^/s/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/s/${TOKEN}$`) },
  { method: "GET", re: new RegExp(`^/api/s/${TOKEN}/img/(?:0|[1-9][0-9]{0,4})$`) },
];

/** The share sockets, by path: `/ws/h` a hand-off's, `/ws/s` a session share's. */
export type ShareSocketKind = "h" | "s";
const SOCKETS: Readonly<Record<string, ShareSocketKind>> = { "/ws/h": "h", "/ws/s": "s" };

/** The raw request target split into path and query, or null unless it is origin-form: "/"
    then anything but a second "/" (absolute-form "http://…", authority-form "host:443", "*" and
    "//host/…" are all refused). Nothing is decoded or resolved. */
export function rawTarget(target: string | undefined): { path: string; query: string } | null {
  if (!target || target[0] !== "/" || target[1] === "/") return null;
  const q = target.indexOf("?");
  return q < 0 ? { path: target, query: "" } : { path: target.slice(0, q), query: target.slice(q + 1) };
}

/** Whether a request may reach the share app. Raw pathname, exact shapes, no escapes at all (a
    token or an asset name never needs one, and a decoded path is never re-judged). */
export function shareMayReach(method: string, pathname: string): boolean {
  if (pathname.includes("%")) return false;
  const m = method === "HEAD" ? "GET" : method;
  return ROUTES.some((r) => r.method === m && r.re.test(pathname));
}

export const BODY_MAX = 16 * 1024;
/** A photo upload's body cap at the edge: the largest photo any host may allow, plus room. The
    host that stages it refuses past its own setting (the edge may be a gateway, which never
    knows the minting host's setting). */
export const UPLOAD_BODY_MAX = PHOTO_MB.max * MB + UPLOAD_BODY_SLACK;
export const REQUESTS_PER_MINUTE = 60;
/** Photo reads have a per-address bucket of their own: a thread full of photos must not use up
    the page's 60 a minute. */
export const IMAGE_REQUESTS_PER_MINUTE = 240;
/** A request's headers must arrive within this, and its whole body within REQUEST_TIMEOUT_MS
    (else 408): a 16 KB body needs no more, and a slow client can't hold a socket for Node's
    default five minutes. A photo upload alone has UPLOAD_TIMEOUT_MS (a phone on mobile data). */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

const UPLOAD_PATH = new RegExp(`^/api/h/${TOKEN}/image$`);
const IMAGE_PATH = new RegExp(`^/api/h/${TOKEN}/img/`);
/** The body cap for a judged path: the photo upload's own, 16 KB for everything else. */
export const bodyMaxFor = (pathname: string): number => (UPLOAD_PATH.test(pathname) ? UPLOAD_BODY_MAX : BODY_MAX);

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

const PAGE_SHELL = new RegExp(`^/[his]/${TOKEN}$`);
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

/** A client→server `/ws/h` or `/ws/s` message larger than this closes the socket. Whatever answers
    a share socket's upgrade enforces it BEFORE forwarding a message anywhere (the in-process upgrader does it with
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
  if (pathname.startsWith("/api/")) return pathname.startsWith("/api/i/") ? "owner api" : pathname.startsWith("/api/s/") ? "session api" : "api";
  if (pathname === "/ws/h") return "socket";
  if (pathname === "/ws/s") return "session socket";
  return pathname.startsWith("/i/") ? "owner page" : pathname.startsWith("/s/") ? "session page" : "page";
}

/** What a request passed on its way through the edge. */
export interface ShareRequestContext {
  /** The request target, parsed. Its raw path passed shareMayReach before it was parsed, and
      parsing left it unchanged. */
  url: URL;
  /** The rate-limit key the request was counted under. */
  client: string;
}

/** A `/ws/h` or `/ws/s` upgrade that passed the edge: the path, the token's shape and the address limit. */
export interface ShareUpgradeContext extends ShareRequestContext {
  /** The `token` query parameter (exactly one), matching TOKEN_RE. */
  token: string;
  /** Which socket: from the path, never from anything else. */
  kind: ShareSocketKind;
}

/** Answers a request that passed the edge. It owns `res` from here; a throw or rejection becomes
    a 500 (or a destroyed socket once headers went out). */
export type ShareDispatch = (req: IncomingMessage, res: ServerResponse, ctx: ShareRequestContext) => void | Promise<void>;
/** Answers a `/ws/h` or `/ws/s` upgrade that passed the edge. It owns `socket` from here, and enforces
    SHARE_WS_MAX_PAYLOAD before forwarding any client message; a throw or rejection ends the
    socket (a 500 if nothing was written yet). */
export type ShareUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, ctx: ShareUpgradeContext) => void | Promise<void>;

/** A preview host's hooks: which preview a request is for (null: the share host), and what answers it. */
export interface PreviewHooks {
  match: (req: IncomingMessage) => string | null;
  dispatch: (req: IncomingMessage, res: ServerResponse, label: string, client: string) => void | Promise<void>;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, label: string, client: string) => void | Promise<void>;
}

export interface ShareServerOptions {
  headersMs?: number;
  /** The whole-request timer every request but a photo upload has. */
  requestMs?: number;
  /** A photo upload's (Node's own request timeout, which it also bounds every request by). */
  uploadMs?: number;
  checkMs?: number;
  /** Runs first, on every request and every upgrade, before the allowlist: false, a throw or a
      rejection is 403 with REFUSED_HEADER and `Connection: close`. Absent (the default): every
      connection is admitted, with no async step. */
  admit?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /** The per-address limit's key. Default: trustedClient with `local-proxy` trust (the loopback
      front's last X-Forwarded-For hop, else the socket address). A throw is a 500. */
  client?: (req: IncomingMessage) => string;
  /** Default: the in-process share app. */
  dispatch?: ShareDispatch;
  /** Default: the in-process `/ws/h` (the link's session, read-only) and `/ws/s` (a session share's
      presence and view pushes). */
  upgrade?: ShareUpgrade;
  /** Preview hosts (§mesh.public/preview-address); absent: none. */
  preview?: PreviewHooks;
}

/** The in-process share app and its `/ws/h`: the hooks' defaults, and what a gateway's router
    runs for a token this host minted itself. Each call builds a new app and WebSocket server, so
    call it once per server, never per request. */
export function inProcessShare(): { dispatch: ShareDispatch; upgrade: ShareUpgrade } {
  const handle = getRequestListener(createShareApp().fetch);
  const wss = new WebSocketServer({ noServer: true, maxPayload: SHARE_WS_MAX_PAYLOAD });
  const dispatch: ShareDispatch = (req, res, ctx) => {
    // The share routes read the client off the request (§mesh.public/visitor-log).
    noteShareClient(req, ctx.client);
    handle(req, res);
  };
  const sessionUpgrade = sessionShareUpgrade();
  const upgrade: ShareUpgrade = (req, socket, head, ctx) => {
    if (ctx.kind === "s") return sessionUpgrade(req, socket, head, ctx);
    const { url, token } = ctx;
    const access = linkAccess(token);
    if (!access.ok) {
      refuse(socket, access.status, { error: access.status === 410 ? "This link is no longer active." : "Unknown link.", ...(access.why ? { why: access.why } : {}) });
      return;
    }
    const sessionId = access.row.sessionId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The 1 KB cap on both runtimes: Bun's ws ignores maxPayload (server/ws-max-payload.ts).
      enforceMaxPayload(ws, SHARE_WS_MAX_PAYLOAD);
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

/** The edge's whole-request timer for a request that isn't a photo upload: a body still not in
    after `ms` is answered 408 and its connection closed, as Node's own timeout would. */
function bodyTimer(req: IncomingMessage, res: ServerResponse, ms: number): void {
  if (req.complete) return;
  const timer = setTimeout(() => {
    if (req.complete || res.destroyed) return;
    if (res.headersSent) return void req.socket.destroy();
    const body = JSON.stringify({ error: "Request timeout" });
    res.writeHead(408, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end(body, () => req.socket.destroy());
  }, ms);
  const clear = () => clearTimeout(timer);
  req.once("end", clear);
  res.once("finish", clear);
  res.once("close", clear);
}

/** Build (not bind) a share server: tests bind it on port 0 (and may shorten the timeouts). */
export function createShareServer(opts: ShareServerOptions = {}): Server {
  const local = opts.dispatch && opts.upgrade ? null : inProcessShare();
  const dispatch = opts.dispatch ?? local!.dispatch;
  const upgrade = opts.upgrade ?? local!.upgrade;
  const clientOf = opts.client ?? ((req: IncomingMessage) => trustedClient(req, { trust: "local-proxy" }));
  const perAddress = new RateLimiter(REQUESTS_PER_MINUTE);
  const perAddressImages = new RateLimiter(IMAGE_REQUESTS_PER_MINUTE);
  const perPreview = new RateLimiter(PREVIEW_LIMITS.requestsPerMinute);
  const preview = opts.preview;
  /** The preview a request is for; a throw is the share host's. */
  const previewOf = (req: IncomingMessage): string | null => {
    try {
      return preview?.match(req) ?? null;
    } catch {
      return null;
    }
  };
  const servePreview = (req: IncomingMessage, res: ServerResponse, label: string): void => {
    // Origin-form only; the path itself is the app's, never judged or parsed here.
    if (!req.url || req.url[0] !== "/") return json(res, 400, { error: "Bad request" });
    let client: string;
    try {
      client = clientOf(req);
    } catch {
      return json(res, 500, { error: "Internal error" });
    }
    if (perPreview.limited(`${client} ${label}`)) return previewAnswer(req, res, "tooMany");
    guarded(
      () => preview!.dispatch(req, res, label, client),
      (err) => {
        console.warn(`[share] preview dispatch failed (${err instanceof Error ? err.name : typeof err})`);
        if (!res.headersSent && !res.destroyed) json(res, 500, { error: "Internal error" });
        else res.destroy();
      },
    );
  };
  const upgradePreview = (req: IncomingMessage, socket: Duplex, head: Buffer, label: string): void => {
    if (!req.url || req.url[0] !== "/") return refuse(socket, 400, { error: "Bad request" });
    let client: string;
    try {
      client = clientOf(req);
    } catch {
      return void socket.destroy();
    }
    if (perPreview.limited(`${client} ${label}`)) return previewUpgradeAnswer(socket, "tooMany");
    guarded(
      () => preview!.upgrade(req, socket, head, label, client),
      () => socket.destroy(),
    );
  };
  const requestTimeout = opts.requestMs ?? REQUEST_TIMEOUT_MS;
  const uploadTimeout = Math.max(opts.uploadMs ?? UPLOAD_TIMEOUT_MS, requestTimeout);
  const options = {
    headersTimeout: Math.min(opts.headersMs ?? HEADERS_TIMEOUT_MS, requestTimeout),
    // Node's own timer is the upload's; every other request gets the edge's shorter one (below),
    // so slow-body protection is unchanged outside the upload route.
    requestTimeout: uploadTimeout,
    // How often Node looks for requests past those limits (default 30 s).
    connectionsCheckingInterval: opts.checkMs ?? 1000,
  };
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    const label = previewOf(req);
    if (label) return servePreview(req, res, label);
    const target = rawTarget(req.url);
    if (!target) {
      json(res, 400, { error: "Bad request" });
      return;
    }
    const url = shareMayReach(req.method ?? "GET", target.path) ? parsedTarget(target) : null;
    if (!url) {
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
    if ((IMAGE_PATH.test(url.pathname) ? perAddressImages : perAddress).limited(client)) {
      tooMany(res, PAGE_SHELL.test(url.pathname));
      return;
    }
    if (req.method === "POST") {
      const len = Number(req.headers["content-length"]);
      if (!Number.isFinite(len) || len > bodyMaxFor(url.pathname)) {
        json(res, 413, { error: "Request body too large" });
        req.resume();
        return;
      }
      if (!UPLOAD_PATH.test(url.pathname)) bodyTimer(req, res, requestTimeout);
    }
    guarded(() => dispatch(req, res, { url, client }), failed("dispatch"));
  };
  const serveUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const label = previewOf(req);
    if (label) return upgradePreview(req, socket, head, label);
    const target = rawTarget(req.url);
    if (!target) {
      refuse(socket, 400, { error: "Bad request" });
      return;
    }
    const kind = Object.hasOwn(SOCKETS, target.path) ? SOCKETS[target.path]! : null;
    const url = kind && req.method === "GET" ? parsedTarget(target) : null;
    const tokens = url?.searchParams.getAll("token") ?? [];
    const token = tokens.length === 1 ? tokens[0]! : "";
    if (!url || !kind || !TOKEN_RE.test(token)) {
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
    guarded(() => upgrade(req, socket, head, { url, token, client, kind }), failed("upgrade"));
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
  // A CONNECT (authority-form target) is never a share request; Node would drop it silently. It
  // is refused before `admit` runs, the one exception to "admit first": nothing is served or
  // forwarded, so a gated ingress answers it 405 too, without the refused marker.
  server.on("connect", (_req: IncomingMessage, socket: Duplex) => {
    socket.on("error", () => {});
    if (!socket.destroyed) socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  return server;
}

/** A judged raw target as a URL, or null when it doesn't parse or parsing would change its path
    (the path the allowlist judged must be the path that is routed). */
function parsedTarget(target: { path: string; query: string }): URL | null {
  try {
    const url = new URL(target.query ? `${target.path}?${target.query}` : target.path, "http://share");
    return url.pathname === target.path ? url : null;
  } catch {
    return null;
  }
}
