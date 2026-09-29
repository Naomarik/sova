import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { refuse } from "../extensions";
import { REFUSED_HEADER } from "../mesh/hello";
import { SHARE_WS_MAX_PAYLOAD } from "./edge";
import { hopLost, offlineUpgrade } from "./offline";

/**
 * A gateway's `/ws/h` hop (§mesh.public/routing, /offline): the page's socket at the gateway, one
 * socket to the routed host's ingress, and the messages between them.
 *
 * - The upstream is dialed first: a host that is down, refuses the gateway, or answers 502/504
 *   gets the page a 503 before any handshake with it. Any other answer (404, 410, 429) is passed on
 *   as that status; the origin stays the authority on its token.
 * - The page's side is accepted by a WebSocketServer with maxPayload = SHARE_WS_MAX_PAYLOAD, so a
 *   client message over it closes the page's socket (1009) and never reaches the upstream.
 * - Upstream messages to the page are not capped. The origin's own closes (4410 gone, 4000 opened
 *   elsewhere, 1000) are passed on; anything else (the host went away) closes the page's socket
 *   with HOP_LOST_CLOSE, and the page reconnects with backoff.
 * - At most `perKey` hops per key (the router passes the token's hash) are open at once; one more
 *   is 429. The origin keeps one socket per token anyway, so more only ties up the gateway.
 *
 * The router decides the target and builds the headers (stripped, then set); this file never
 * looks up a token and never dials anything but the target it is given.
 */

export const WS_HOPS_PER_KEY = 4;
export const WS_HOP_DIAL_MS = 10_000;
/** The upstream's closes passed on to the page as they are; any other is HOP_LOST_CLOSE. */
const ORIGIN_CLOSES = new Set([1000, 4000, 4410]);
/** An upstream status that means "the host is not there": the page gets the offline 503. */
const OFFLINE_STATUSES = new Set([502, 503, 504]);

export interface WsHopTarget {
  /** The routed host's ingress address, from peers.json, and its registered ingress port. */
  host: string;
  port: number;
  /** The request target at the ingress: `/ws/h?token=…&v=…`. */
  path: string;
  /** The hop's request headers, already stripped and set by the router. */
  headers: Record<string, string>;
}

export interface WsHopOptions {
  perKey?: number;
  dialMs?: number;
}

export interface WsHop {
  /** Answer one `/ws/h` upgrade by hopping to `target`. Owns `socket` from here; never throws. */
  forward(req: IncomingMessage, socket: Duplex, head: Buffer, key: string, target: WsHopTarget): void;
  /** Open hops (dialing included) under `key`. */
  count(key: string): number;
  /** Close every hop whose key matches with HOP_LOST_CLOSE (a peer removed, a row dropped). */
  closeWhere(match: (key: string) => boolean): void;
}

interface Hop {
  up: WebSocket;
  page: WebSocket | null;
}

export function createWsHop(opts: WsHopOptions = {}): WsHop {
  const perKey = opts.perKey ?? WS_HOPS_PER_KEY;
  const dialMs = opts.dialMs ?? WS_HOP_DIAL_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: SHARE_WS_MAX_PAYLOAD });
  const hops = new Map<string, Set<Hop>>();

  const add = (key: string, hop: Hop): (() => void) => {
    let set = hops.get(key);
    if (!set) hops.set(key, (set = new Set()));
    set.add(hop);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set!.delete(hop);
      if (!set!.size) hops.delete(key);
    };
  };

  const forward: WsHop["forward"] = (req, socket, head, key, target) => {
    if (socket.destroyed) return;
    if ((hops.get(key)?.size ?? 0) >= perKey) {
      refuse(socket, 429, { error: "Too many requests" });
      return;
    }
    let up: WebSocket;
    try {
      up = new WebSocket(`ws://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}${target.path}`, {
        headers: target.headers,
        handshakeTimeout: dialMs,
        followRedirects: false,
        perMessageDeflate: false,
      });
    } catch {
      offlineUpgrade(socket);
      return;
    }
    const hop: Hop = { up, page: null };
    const release = add(key, hop);
    // The page left while the upstream was being dialed.
    const onPageGone = () => {
      if (hop.page) return;
      release();
      up.terminate();
    };
    socket.once("close", onPageGone);

    up.once("unexpected-response", (_r, res) => {
      release();
      socket.off("close", onPageGone);
      const status = res.statusCode ?? 502;
      const refused = status === 403 && res.headers[REFUSED_HEADER.toLowerCase()] === "refused";
      res.resume();
      up.terminate();
      if (refused || OFFLINE_STATUSES.has(status)) offlineUpgrade(socket);
      else refuse(socket, status, { error: status === 410 ? "This link is no longer active." : status === 429 ? "Too many requests" : "Unknown link." });
    });
    up.on("error", () => {
      if (hop.page) return; // the close below handles a live hop
      release();
      socket.off("close", onPageGone);
      offlineUpgrade(socket);
    });
    up.once("open", () => {
      socket.off("close", onPageGone);
      if (socket.destroyed) {
        release();
        up.terminate();
        return;
      }
      wss.handleUpgrade(req, socket, head, (page) => {
        hop.page = page;
        page.on("error", () => {}); // an oversized frame: ws closes with 1009 by itself
        page.on("message", (data: RawData, isBinary: boolean) => {
          if (up.readyState === up.OPEN) up.send(data, { binary: isBinary });
        });
        up.on("message", (data: RawData, isBinary: boolean) => {
          if (page.readyState === page.OPEN) page.send(data, { binary: isBinary });
        });
        page.on("close", () => {
          release();
          if (up.readyState === up.OPEN || up.readyState === up.CONNECTING) up.close(1000);
        });
        up.on("close", (code: number, reason: Buffer) => {
          release();
          if (page.readyState !== page.OPEN) return;
          if (ORIGIN_CLOSES.has(code)) page.close(code, reason);
          else hopLost(page);
        });
      });
    });
  };

  return {
    forward,
    count: (key) => hops.get(key)?.size ?? 0,
    closeWhere(match) {
      for (const [key, set] of [...hops])
        if (match(key))
          for (const hop of [...set]) {
            if (hop.page) hopLost(hop.page);
            hop.up.terminate();
          }
    },
  };
}

