// The reverse channel (§mesh.lan/reverse-channel). The LAN host dialed the relay, but at the HTTP
// layer the relay is the HTTP/2 client and the LAN host the server: every relay request is a
// CONNECT stream carrying ordinary HTTP/1.1 or a WebSocket upgrade, which the LAN host hands to an
// in-process HTTP server that never listens. The LAN host can't open a stream, and push is off.
//
// The relay treats the LAN host as a hostile HTTP/2 server: header, settings, memory and stream
// caps, and a deadline on every stream it opens. Identity comes from the TLS pins, never from
// anything inside a stream.
//
// Every stream is wrapped in a plain Duplex before an HTTP parser sees it: Node's HTTP server and
// client corrupt the HTTP/1.1 head on a raw Http2Stream (its native handle takes a path the parser
// doesn't expect). Likewise the LAN host's HTTP/2 session runs on a plain Duplex around its TLS
// socket: on Node, a server session reading a client-mode TLS socket's native handle misses the
// socket's EOF once two streams have been open at once, so a closed relay would look connected
// until the keepalive gave up. Bun has neither problem; the wrappers cost it nothing.

import http, { type Agent, type ClientRequestArgs, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import http2, { type ClientHttp2Session, type ClientHttp2Stream, type Http2Stream, type ServerHttp2Session } from "node:http2";
import { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { type CappedClientOptions, streamWebSocket } from "../runtime-quirks";

/** Streams the relay may have open at once on one LAN host. */
export const MAX_STREAMS = 100;
export const MAX_HEADER_LIST = 64 * 1024;
/** A stream the LAN host hasn't answered in this long fails. */
export const OPEN_STREAM_MS = 10_000;
/** Pings go out this often; a connection with no answer for SILENT_MS is closed. */
export const PING_MS = 30_000;
export const SILENT_MS = 90_000;

const AUTHORITY = "lan-peer";

/**
 * A header list's size as HTTP/2 counts it (RFC 9113 §6.5.2: each field's name and value octets
 * plus 32). Bun's HTTP/2 refuses a list past MAX_HEADER_LIST itself; Node's lets it through to the
 * stream handler (seen on Node 25), so both ends check here too.
 */
export function headerListSize(headers: Record<string, string | string[] | number | undefined>): number {
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) n += Buffer.byteLength(k) + Buffer.byteLength(String(one)) + 32;
  }
  return n;
}

// ─── Deadlines for the in-process HTTP server a stream is fed to ──────────────────────────────────
// That server never listens, so its own headersTimeout, requestTimeout and keepAliveTimeout never
// run (they are checked only for connections it accepted itself), and a stream has no socket
// timeout. These stand in for them, per stream: its request head must arrive within HEADER_MS, a
// request body within REQUEST_MS, and a kept-alive stream may sit idle between requests for IDLE_MS.
// An upgraded stream (a WebSocket) lives as long as its session.

export const HEADER_MS = 10_000;
export const REQUEST_MS = 300_000;
export const IDLE_MS = 30_000;

export interface StreamDeadlines {
  headerMs?: number;
  requestMs?: number;
  idleMs?: number;
}

const watched = new WeakSet<Server>();
const timers = new WeakMap<Duplex, { timer: NodeJS.Timeout | null }>();

function arm(d: Duplex, ms: number): void {
  const t = timers.get(d);
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  t.timer = setTimeout(() => d.destroy(), ms);
  t.timer.unref?.();
}

function disarm(d: Duplex): void {
  const t = timers.get(d);
  if (t?.timer) clearTimeout(t.timer);
  if (t) t.timer = null;
}

/** Hand `d` to `server` (`emit("connection")`) under the deadlines above. */
export function feedStream(server: Server, d: Duplex, opts: StreamDeadlines = {}): void {
  const headerMs = opts.headerMs ?? HEADER_MS;
  const requestMs = opts.requestMs ?? REQUEST_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  if (!watched.has(server)) {
    watched.add(server);
    // Before the server's own handler, which may finish the response at once.
    server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      const s = req.socket as Duplex;
      if (req.complete) disarm(s);
      else {
        arm(s, requestMs);
        // Bun may end the request after the response finished: the idle deadline stands then.
        req.once("end", () => {
          if (!res.writableFinished) disarm(s);
        });
      }
      res.once("finish", () => arm(s, idleMs)); // the next request head, or nothing, within idleMs
    });
    server.on("upgrade", (req: IncomingMessage) => disarm(req.socket as Duplex));
  }
  timers.set(d, { timer: null });
  arm(d, headerMs);
  d.once("close", () => disarm(d));
  server.emit("connection", d);
}

/** A plain Duplex over an HTTP/2 stream: no native handle for a consumer to bypass. */
export function streamDuplex(h2s: Http2Stream): Duplex {
  const d = new Duplex({
    read() {
      if (h2s.isPaused()) h2s.resume();
    },
    write(chunk, _enc, cb) {
      h2s.write(chunk, cb);
    },
    final(cb) {
      h2s.end();
      cb();
    },
    destroy(err, cb) {
      if (!h2s.destroyed) h2s.close(err ? http2.constants.NGHTTP2_CANCEL : http2.constants.NGHTTP2_NO_ERROR);
      cb(err);
    },
  });
  h2s.on("data", (c: Buffer) => {
    if (!d.push(c)) h2s.pause();
  });
  h2s.on("end", () => d.push(null));
  h2s.on("error", (e) => d.destroy(e));
  h2s.on("close", () => {
    if (!d.destroyed) d.destroy();
  });
  // What an HTTP server or client may read off a socket; nothing here names an address.
  Object.assign(d, { remoteAddress: undefined, remotePort: undefined, setTimeout: () => d, setNoDelay: () => d, setKeepAlive: () => d, ref: () => d, unref: () => d });
  return d;
}

/** A plain Duplex over a socket: its end, close and errors arrive as JS events, never via a native handle. */
export function socketDuplex(sock: Duplex): Duplex {
  const d = new Duplex({
    read() {
      if (sock.isPaused()) sock.resume();
    },
    write(chunk, _enc, cb) {
      sock.write(chunk, cb);
    },
    final(cb) {
      sock.end();
      cb();
    },
    destroy(err, cb) {
      sock.destroy();
      cb(err);
    },
  });
  sock.on("data", (c: Buffer) => {
    if (!d.push(c)) sock.pause();
  });
  sock.on("end", () => d.push(null));
  sock.on("error", (e) => d.destroy(e));
  sock.on("close", () => {
    if (!d.destroyed) d.destroy();
  });
  return d;
}

/** Ping every PING_MS; destroy the session once nothing has answered for SILENT_MS. */
function keepAlive(session: ServerHttp2Session | ClientHttp2Session, now: () => number, pingMs: number, silentMs: number): () => void {
  let lastHeard = now();
  const timer = setInterval(() => {
    if (session.destroyed) return clearInterval(timer);
    if (now() - lastHeard >= silentMs) {
      clearInterval(timer);
      session.destroy();
      return;
    }
    try {
      session.ping((err) => {
        if (!err) lastHeard = now();
      });
    } catch {
      /* closing */
    }
  }, pingMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface ChannelTimers {
  pingMs?: number;
  silentMs?: number;
  now?: () => number;
}

// ─── The LAN host's side ────────────────────────────────────────────────────────────────────────

export interface ReverseServer {
  readonly session: ServerHttp2Session;
  /** Ends the session and every stream and WebSocket inside it at once. */
  close(): void;
  readonly closed: Promise<void>;
}

/**
 * Answer the relay over `sock`, the pinned connection this host dialed. Each CONNECT stream reaches
 * `onStream` as a plain Duplex (feed it to the in-process server with `emit("connection", d)`);
 * any other request gets 405, an extended CONNECT 400.
 */
export function serveReverse(sock: Duplex, onStream: (d: Duplex) => void, timers: ChannelTimers = {}): ReverseServer {
  const session = http2.performServerHandshake(socketDuplex(sock), {
    settings: { enablePush: false, maxConcurrentStreams: MAX_STREAMS, maxHeaderListSize: MAX_HEADER_LIST },
    maxHeaderListPairs: 128,
    maxSettings: 32,
    maxSessionMemory: 10,
    maxSessionRejectedStreams: 10,
    maxSessionInvalidFrames: 100,
  });
  session.on("error", () => {});
  session.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    if (headers[":method"] !== "CONNECT") {
      stream.respond({ ":status": 405 }, { endStream: true });
      return;
    }
    // Plain CONNECT carries :authority only (RFC 9113 §8.5); anything else is not ours.
    if (headers[":path"] !== undefined || headers[":scheme"] !== undefined || headers[":protocol"] !== undefined) {
      stream.respond({ ":status": 400 }, { endStream: true });
      return;
    }
    if (headerListSize(headers) > MAX_HEADER_LIST) {
      stream.respond({ ":status": 431 }, { endStream: true });
      return;
    }
    stream.respond({ ":status": 200 });
    onStream(streamDuplex(stream));
  });
  const stop = keepAlive(session, timers.now ?? Date.now, timers.pingMs ?? PING_MS, timers.silentMs ?? SILENT_MS);
  const closed = new Promise<void>((resolve) => session.once("close", () => {
    stop();
    resolve();
  }));
  sock.once("close", () => {
    if (!session.destroyed) session.destroy();
  });
  return {
    session,
    close: () => {
      session.destroy();
      sock.destroy();
    },
    closed,
  };
}

// ─── The relay's side ───────────────────────────────────────────────────────────────────────────

export interface ReverseClient {
  /** A new stream into the LAN host's HTTP server; rejects if it isn't answered with 200 in time. */
  openStream(timeoutMs?: number): Promise<Duplex>;
  /** An http.Agent whose every connection is a new stream (for http.request and friends). */
  readonly agent: Agent;
  /** A WebSocket to `path` on the LAN host, over a new stream. */
  webSocket(path: string, protocols?: string | string[], opts?: CappedClientOptions): Promise<WebSocket>;
  readonly openStreams: number;
  /** Ends the session and every stream and WebSocket inside it at once. */
  close(): void;
  readonly closed: Promise<void>;
  readonly destroyed: boolean;
}

/**
 * Run the HTTP/2 client over `sock`, a connection whose LAN host already proved its pin (a TLS
 * socket, or the decrypted stream a relay process hands over). Resolves once SETTINGS are exchanged.
 * The h2 scheme is `http`: it only labels the session, the bytes are inside `sock`'s TLS.
 */
export function connectReverse(sock: Duplex, timers: ChannelTimers = {}, settleMs = OPEN_STREAM_MS): Promise<ReverseClient> {
  return new Promise((resolve, reject) => {
    // The session runs on a plain Duplex here too (see the top of this file); TLS is below it.
    const session = http2.connect(`http://${AUTHORITY}`, {
      createConnection: () => socketDuplex(sock) as never, // typed as a net.Socket; any Duplex works
      // What the LAN host may send us: header lists of at most 64 KiB and 128 pairs, 32 SETTINGS
      // entries, 10 MB of session memory, 10 unanswered pings, 100 streams.
      settings: { enablePush: false, maxHeaderListSize: MAX_HEADER_LIST },
      maxHeaderListPairs: 128,
      maxSettings: 32,
      maxSessionMemory: 10,
      maxOutstandingPings: 10,
      peerMaxConcurrentStreams: MAX_STREAMS,
    });
    let open = 0;
    let settled = false;
    const stop = keepAlive(session, timers.now ?? Date.now, timers.pingMs ?? PING_MS, timers.silentMs ?? SILENT_MS);
    const closed = new Promise<void>((r) => session.once("close", () => {
      stop();
      r();
    }));
    session.on("error", () => {});
    // The LAN host must never push or open anything; nghttp2 refuses push with enablePush off.
    session.on("stream", (s: ClientHttp2Stream) => s.close(http2.constants.NGHTTP2_REFUSED_STREAM));
    sock.once("close", () => {
      if (!session.destroyed) session.destroy();
    });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.destroy();
      reject(new Error("timed out"));
    }, settleMs);
    deadline.unref?.();

    const openStream = (timeoutMs = OPEN_STREAM_MS): Promise<Duplex> => new Promise((ok, fail) => {
      if (session.destroyed || session.closed) return fail(new Error("closed"));
      if (open >= MAX_STREAMS) return fail(new Error("busy"));
      let req: ClientHttp2Stream;
      try {
        req = session.request({ ":method": "CONNECT", ":authority": AUTHORITY }, { endStream: false });
      } catch {
        return fail(new Error("closed"));
      }
      open++;
      let counted = true;
      const uncount = () => {
        if (counted) open--;
        counted = false;
      };
      req.on("close", uncount);
      req.on("error", () => {});
      const timer = setTimeout(() => {
        uncount();
        req.close(http2.constants.NGHTTP2_CANCEL);
        fail(new Error("timed out"));
      }, timeoutMs);
      timer.unref?.();
      req.once("response", (headers) => {
        clearTimeout(timer);
        if (headers[":status"] !== 200 || headerListSize(headers) > MAX_HEADER_LIST) {
          uncount();
          req.close(http2.constants.NGHTTP2_CANCEL);
          return fail(new Error("refused"));
        }
        ok(streamDuplex(req));
      });
      req.once("close", () => {
        clearTimeout(timer);
        fail(new Error("closed")); // no-op once resolved
      });
    });

    class StreamAgent extends http.Agent {
      override createConnection(_opts: ClientRequestArgs, cb?: (err: Error | null, s: Duplex) => void): Duplex | null | undefined {
        openStream().then((d) => cb?.(null, d), (e: Error) => cb?.(e, undefined as unknown as Duplex));
        return undefined;
      }
    }
    const agent = new StreamAgent({ keepAlive: false });

    const client: ReverseClient = {
      openStream,
      agent,
      async webSocket(path, protocols, opts = {}) {
        const d = await openStream();
        return streamWebSocket(`ws://${AUTHORITY}${path.startsWith("/") ? path : `/${path}`}`, d, protocols, { handshakeTimeout: OPEN_STREAM_MS, ...opts });
      },
      get openStreams() {
        return open;
      },
      close: () => {
        session.destroy();
        sock.destroy();
      },
      closed,
      get destroyed() {
        return session.destroyed;
      },
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(client);
    };
    // Ready when the dial-out host has spoken (its SETTINGS), not at the local `connect`: a host
    // that drops the connection right after the handshake (it pinned another relay) is never handed on.
    session.once("remoteSettings", onReady);
    session.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error("closed"));
    });
  });
}
