import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket } from "ws";
import { refuse } from "../extensions";
import { REFUSED_HEADER } from "../mesh/hello";
import { SHARE_WS_MAX_PAYLOAD } from "./edge";
import { hopLost, offlineUpgrade } from "./offline";
import { cappedWebSocket, cappedWebSocketServer } from "../runtime-quirks";

/**
 * A gateway's `/ws/h` hop (§mesh.public/routing, /offline): the page's socket at the gateway, one
 * socket to the routed host's ingress, and the messages between them.
 *
 * - The page's handshake is judged first (GET, `Upgrade: websocket`, `Connection: upgrade`, a key
 *   that is base64 of 16 bytes, version 13, well-formed subprotocol (none twice) and extension
 *   lists): anything else is 400 and nothing is dialed.
 * - Then the budgets: at most `total` hops open at the gateway (one more is 503) and `perKey` per
 *   key (one more is 429); neither dials.
 * - The upstream is dialed before the page is accepted: a host that is down, refuses the gateway,
 *   or answers 502/503/504 gets the page a 503. Any other answer (404, 410, 429) is passed on as
 *   that status; the origin stays the authority on its token.
 * - When the upstream opens, `authorized()` (sync or async) is asked again (the route, acceptance
 *   and target may have changed during the dial): false, a throw or a rejection terminates the
 *   upstream and the page gets 404. An answer arriving after the hop ended changes nothing.
 * - The page's side is accepted by a WebSocketServer with maxPayload = SHARE_WS_MAX_PAYLOAD, so a
 *   client message over it closes the page's socket (1009) and never reaches the upstream.
 * - Upstream messages to the page are not capped at 1 KB; the upstream client has its own cap
 *   (`upstreamMaxPayload`), and a message over it ends the hop like a lost host. The origin's own
 *   closes (4410 gone, 4000 opened elsewhere, 1000) are passed on; anything else closes the page's
 *   socket with HOP_LOST_CLOSE, and the page reconnects with backoff.
 * - A hop whose host withdrew its row (drainWhere, §mesh.public/withdrawn-hop) is not cut at once:
 *   the page's messages stop going up, the host's still come down, and the host's own close (4410
 *   after a revoke) passes through; with none within the grace, the page gets HOP_LOST_CLOSE.
 * - One idempotent cleanup per hop, attached before the dial, releases its slot and ends both
 *   sides on every path: a rejected or abandoned page handshake, a failed or closed upstream, a
 *   revocation (closeWhere) and dispose().
 *
 * The router decides the target (a literal address) and builds the headers (stripped, then set);
 * this file never looks up a token, never resolves a name, and never dials anything but the
 * target it is given.
 */

export const WS_HOPS_PER_KEY = 4;
/** Open hops (dialing included) the whole gateway holds at once. */
export const WS_HOPS_TOTAL = 256;
export const WS_HOP_DIAL_MS = 10_000;
/** The upstream client's message cap: not the page's 1 KB, but not unlimited either. */
export const WS_HOP_UPSTREAM_MAX_PAYLOAD = 16 * 1024 * 1024;
/** How long a hop whose host withdrew its row waits for that host's own close. */
export const WS_HOP_WITHDRAW_GRACE_MS = 3000;
/** Bytes a page may send while its upstream is dialed (it has no reason to send any). */
const EARLY_MAX = 64 * 1024;
/** Upstream messages held while the page's handshake completes. */
const PENDING_MAX = 64;
/** The upstream's closes passed on to the page as they are; any other is HOP_LOST_CLOSE. */
const ORIGIN_CLOSES = new Set([1000, 4000, 4410]);
/** An upstream status that means "the host is not there": the page gets the offline 503. */
const OFFLINE_STATUSES = new Set([502, 503, 504]);

export interface WsHopTarget {
  /** The routed host's ingress address (a literal IP, verified by the router) and its port. */
  host: string;
  port: number;
  /** The request target at the ingress: `/ws/h?token=…&v=…`. */
  path: string;
  /** The hop's request headers, already stripped and set by the router. */
  headers: Record<string, string>;
}

export interface WsHopOptions {
  perKey?: number;
  total?: number;
  dialMs?: number;
  upstreamMaxPayload?: number;
  /** The clock a draining hop's grace runs on; absent: setTimeout (unref'd) and clearTimeout. */
  timers?: HopTimers;
}

/** Arm and cancel one timer. */
export interface HopTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: HopTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A draining hop's deadline: the first `arm` sets it, a later one keeps it; `cancel` drops it. */
export function drainDeadline(timers: HopTimers = realTimers): { arm(graceMs: number, onEnd: () => void): void; cancel(): void; readonly armed: boolean } {
  let handle: unknown = null;
  return {
    arm(graceMs, onEnd) {
      if (handle !== null) return;
      handle = timers.set(onEnd, graceMs);
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
    },
    get armed() {
      return handle !== null;
    },
  };
}

export interface WsHop {
  /** Answer one `/ws/h` upgrade by hopping to `target`. Owns `socket` from here; never throws.
      `authorized` is asked again when the upstream opens, before the page is accepted. */
  forward(req: IncomingMessage, socket: Duplex, head: Buffer, key: string, target: WsHopTarget, authorized?: () => boolean | Promise<boolean>): void;
  /** Open hops (dialing included) under `key`. */
  count(key: string): number;
  /** Open hops (dialing included) across every key. */
  total(): number;
  /** End every hop whose key matches: an open page gets HOP_LOST_CLOSE, a dialing one 503, and
      the upstream is terminated either way. */
  closeWhere(match: (key: string) => boolean): void;
  /** Every hop whose key matches waits up to `graceMs` for its host's own close, passing nothing
      more up from the page; then it ends as closeWhere does. A hop still dialing ends at once,
      and a hop already waiting keeps its first deadline. */
  drainWhere(match: (key: string) => boolean, graceMs: number): void;
  /** End every hop as closeWhere does, and answer every later forward 503 without dialing. */
  dispose(): void;
}

// ---- the page's handshake --------------------------------------------------------------------------

const KEY_RE = /^[+/0-9A-Za-z]{22}==$/;
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const PROTOCOLS_RE = new RegExp(`^${TOKEN}(?:[ \\t]*,[ \\t]*${TOKEN})*$`);
const PARAM = `${TOKEN}(?:[ \\t]*=[ \\t]*(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*"))?`;
const EXTENSION = `${TOKEN}(?:[ \\t]*;[ \\t]*${PARAM})*`;
const EXTENSIONS_RE = new RegExp(`^${EXTENSION}(?:[ \\t]*,[ \\t]*${EXTENSION})*$`);

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
};

/** Whether the page's upgrade is a well-formed RFC 6455 version-13 handshake. */
export function validHandshake(req: IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  if (header(req, "upgrade")?.trim().toLowerCase() !== "websocket") return false;
  if (!(header(req, "connection") ?? "").split(",").some((t) => t.trim().toLowerCase() === "upgrade")) return false;
  const key = header(req, "sec-websocket-key");
  if (!key || !KEY_RE.test(key) || Buffer.from(key, "base64").length !== 16) return false;
  if (header(req, "sec-websocket-version") !== "13") return false;
  const protocols = header(req, "sec-websocket-protocol");
  if (protocols !== undefined) {
    if (!PROTOCOLS_RE.test(protocols.trim())) return false;
    // ws refuses a subprotocol listed twice; refuse it here, before any dial.
    const list = protocols.split(",").map((p) => p.trim());
    if (new Set(list).size !== list.length) return false;
  }
  const extensions = header(req, "sec-websocket-extensions");
  if (extensions !== undefined && !EXTENSIONS_RE.test(extensions.trim())) return false;
  return true;
}

// ---- the pool ----------------------------------------------------------------------------------------

/** How a hop ends, for the page: its socket is gone (or dropped), 503, 404, an upstream status
    passed on, or a close code on its socket once accepted. */
type PageEnd = "gone" | "offline" | "not-found" | "lost" | { status: number } | { code: number; reason: Buffer };

interface Hop {
  key: string;
  end(page: PageEnd): void;
  drain(graceMs: number): void;
}

export function createWsHop(opts: WsHopOptions = {}): WsHop {
  const perKey = opts.perKey ?? WS_HOPS_PER_KEY;
  const totalMax = opts.total ?? WS_HOPS_TOTAL;
  const dialMs = opts.dialMs ?? WS_HOP_DIAL_MS;
  const upstreamMaxPayload = opts.upstreamMaxPayload ?? WS_HOP_UPSTREAM_MAX_PAYLOAD;
  const timers = opts.timers ?? realTimers;
  const wss = cappedWebSocketServer({ noServer: true, maxPayload: SHARE_WS_MAX_PAYLOAD });
  const hops = new Map<string, Set<Hop>>();
  let open = 0;
  let disposed = false;

  const forward: WsHop["forward"] = (req, socket, head, key, target, authorized = () => true) => {
    if (socket.destroyed) return;
    if (disposed) return offlineUpgrade(socket);
    if (!validHandshake(req)) return refuse(socket, 400, { error: "Bad request" });
    if (open >= totalMax) return offlineUpgrade(socket);
    if ((hops.get(key)?.size ?? 0) >= perKey) return refuse(socket, 429, { error: "Too many requests" });

    let up: WebSocket | null = null;
    let page: WebSocket | null = null;
    let ended = false;
    const draining = drainDeadline(timers);
    const pending: { data: RawData; binary: boolean }[] = [];
    const early: Buffer[] = [];
    let earlySize = 0;

    // While dialing, the page's socket flows (a paused socket never shows its EOF), and anything
    // it sends is kept for after `head`.
    const onEarly = (d: Buffer) => {
      earlySize += d.length;
      if (earlySize > EARLY_MAX) hop.end("gone");
      else early.push(d);
    };
    const onGone = () => hop.end("gone");
    const unwatch = () => {
      socket.off("data", onEarly);
      socket.off("end", onGone);
      socket.pause();
      (socket as { readableFlowing: boolean | null }).readableFlowing = null;
    };

    const hop: Hop = {
      key,
      end(how) {
        if (ended) return;
        ended = true;
        draining.cancel();
        const set = hops.get(key);
        if (set?.delete(hop)) {
          open--;
          if (!set.size) hops.delete(key);
        }
        socket.off("data", onEarly);
        socket.off("end", onGone);
        socket.off("close", onGone);
        if (up && up.readyState !== up.CLOSED) up.terminate();
        if (page) {
          if (typeof how === "object" && "code" in how) {
            if (page.readyState === page.OPEN) page.close(how.code, how.reason);
          } else if (how === "lost" || how === "offline") hopLost(page);
          else if (page.readyState !== page.CLOSED) page.terminate();
          return;
        }
        if (how === "offline" || how === "lost") offlineUpgrade(socket);
        else if (how === "not-found") refuse(socket, 404, { error: "Unknown link." });
        else if (typeof how === "object" && "status" in how)
          refuse(socket, how.status, { error: how.status === 410 ? "This link is no longer active." : how.status === 429 ? "Too many requests" : "Unknown link." });
        else socket.destroy();
      },
      drain(graceMs) {
        if (ended || draining.armed) return;
        if (!page) return hop.end("lost");
        draining.arm(graceMs, () => hop.end("lost"));
      },
    };
    let set = hops.get(key);
    if (!set) hops.set(key, (set = new Set()));
    set.add(hop);
    open++;

    socket.on("data", onEarly);
    socket.once("end", onGone);
    socket.once("close", onGone);

    try {
      up = cappedWebSocket(`ws://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}${target.path}`, undefined, {
        headers: target.headers,
        handshakeTimeout: dialMs,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: upstreamMaxPayload,
        // A message over it ends the hop like a lost host, as ws's own 1009 error does.
        onOversize: () => hop.end("lost"),
      });
    } catch {
      return hop.end("offline");
    }
    const u = up;

    u.once("unexpected-response", (_r, res) => {
      const status = res.statusCode ?? 502;
      const refused = status === 403 && res.headers[REFUSED_HEADER.toLowerCase()] === "refused";
      res.resume();
      hop.end(refused || OFFLINE_STATUSES.has(status) ? "offline" : { status });
    });
    u.on("error", () => hop.end("lost"));
    u.on("close", (code: number, reason: Buffer) => hop.end(page && ORIGIN_CLOSES.has(code) ? { code, reason } : "lost"));
    u.on("message", (data: RawData, binary: boolean) => {
      if (page) {
        if (page.readyState === page.OPEN) page.send(data, { binary });
      } else if (pending.length < PENDING_MAX) pending.push({ data, binary });
      else hop.end("lost");
    });
    u.once("open", async () => {
      if (ended) return;
      // The check may be async. Meanwhile the hop stays as it was while dialing: counted, the page
      // watched, upstream messages held; and once it ended, no answer revives it.
      let ok = false;
      try {
        ok = !disposed && (await authorized()) === true;
      } catch {
        ok = false;
      }
      if (ended) return;
      if (!ok || disposed) return hop.end("not-found");
      if (socket.destroyed) return hop.end("gone");
      unwatch();
      const rest = early.length ? Buffer.concat([head, ...early]) : head;
      // `close` stays on: if ws rejects or drops the handshake without calling back, the socket's
      // close still ends the hop.
      wss.handleUpgrade(req, socket, rest, (ws) => {
        if (ended) return void ws.terminate();
        page = ws;
        socket.off("close", onGone);
        ws.on("error", () => {}); // an oversized frame: ws closes with 1009 by itself
        ws.on("message", (data: RawData, binary: boolean) => {
          if (!draining.armed && u.readyState === u.OPEN) u.send(data, { binary });
        });
        ws.on("close", () => hop.end("gone"));
        for (const m of pending.splice(0)) ws.send(m.data, { binary: m.binary });
      });
    });
  };

  const closeWhere: WsHop["closeWhere"] = (match) => {
    for (const [key, set] of [...hops]) if (match(key)) for (const hop of [...set]) hop.end("lost");
  };

  const drainWhere: WsHop["drainWhere"] = (match, graceMs) => {
    for (const [key, set] of [...hops]) if (match(key)) for (const hop of [...set]) hop.drain(graceMs);
  };

  return {
    forward,
    count: (key) => hops.get(key)?.size ?? 0,
    total: () => open,
    closeWhere,
    drainWhere,
    dispose() {
      disposed = true;
      closeWhere(() => true);
    },
  };
}
