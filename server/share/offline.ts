import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { HOP_LOST_CLOSE, OFFLINE_PAGE, OFFLINE_RETRY_AFTER_S, type OfflineBody } from "../../shared/public-links";
import { PAGE_CSP } from "./routes";

/**
 * A gateway's answers for a known link whose host is down or refuses, or a hop that failed with
 * 502/504 (§mesh.public/offline). Static: they name no host and repeat no token, and are never
 * buffered or replayed. The router calls them only for a hash it knows (a registered row whose hop
 * failed); an unknown hash is its 404, never asked of any host. Nothing here looks anything up.
 */

/** What an offline answer is for: the page shell `/h|i/<t>`, an `/api/h|i/…` call, or a hashed
    asset no host could serve. */
export type OfflineKind = "page" | "api" | "asset";

const COMMON = {
  "Retry-After": String(OFFLINE_RETRY_AFTER_S),
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The offline page shell: the copy deck's text, inline style only (the CSP allows it), no script. */
export const OFFLINE_HTML =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(OFFLINE_PAGE.title)}</title></head>` +
  `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">` +
  `<h1 style="font-size: 1.25rem">${esc(OFFLINE_PAGE.heading)}</h1><p>${esc(OFFLINE_PAGE.body)}</p></body></html>`;

export const OFFLINE_BODY: OfflineBody = { error: "offline", retryAfter: OFFLINE_RETRY_AFTER_S };

/** Which offline answer a share path gets, by its route family (the edge already judged the path). */
export function offlineKind(pathname: string): OfflineKind {
  if (pathname.startsWith("/h/assets/")) return "asset";
  if (pathname.startsWith("/api/")) return "api";
  return "page";
}

/** Write the 503 for `kind`. A response whose headers already went out (a hop that died mid-body)
    can't become a 503: it is destroyed instead, so the client sees a failed load, never a partial
    answer passed off as whole. The request body, if any, is drained and dropped: never replayed. */
export function offlineResponse(res: ServerResponse, kind: OfflineKind): void {
  res.req?.resume();
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (kind === "page") {
    res.writeHead(503, { ...COMMON, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP });
    res.end(res.req?.method === "HEAD" ? undefined : OFFLINE_HTML);
  } else if (kind === "api") {
    res.writeHead(503, { ...COMMON, "Content-Type": "application/json" });
    res.end(res.req?.method === "HEAD" ? undefined : JSON.stringify(OFFLINE_BODY));
  } else {
    res.writeHead(503, { ...COMMON, "Content-Type": "text/plain; charset=utf-8" });
    res.end(res.req?.method === "HEAD" ? undefined : "Offline");
  }
}

/** A `/ws/h` upgrade to a known link whose host is down: a 503 on the raw socket, before any
    handshake, and the socket ends. */
export function offlineUpgrade(socket: Duplex): void {
  if (socket.destroyed) return;
  const body = JSON.stringify(OFFLINE_BODY);
  socket.end(
    `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nRetry-After: ${OFFLINE_RETRY_AFTER_S}\r\n` +
      `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** A live `/ws/h` hop whose host went away: close the page's socket with HOP_LOST_CLOSE, so the
    page reconnects with backoff instead of calling the link dead. */
export function hopLost(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) ws.close(HOP_LOST_CLOSE, "offline");
  else if (ws.readyState === ws.CONNECTING) ws.terminate();
}
