// Runtime quirks: every workaround for a runtime that differs from Node, in one place
// (§app.server-runtime/quirks). The registry, with each quirk's runtime version, upstream issue,
// workaround and canary test, is docs/bun-quirks.md.
//
// Rules: workarounds detect the broken BEHAVIOUR (a probe), never the runtime's name or version, so
// a runtime that fixes a bug stops paying for its workaround; call sites never name a runtime.

import { createRequire } from "node:module";
import path from "node:path";
import { createHistogram, monitorEventLoopDelay, type RecordableHistogram } from "node:perf_hooks";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type ClientOptions, type ServerOptions } from "ws";

// ─── WebSocket size cap ─────────────────────────────────────────────────────────────────────────
// Bun replaces the `ws` package with its own shim, which ignores `maxPayload`. The check below is
// applied on every runtime instead of being probed for: where ws enforces the cap itself, an
// oversized message is dropped before it is emitted, so the check costs one size read per message
// and never fires.

/** The close code for a message over the cap, as ws sends it itself (RFC 6455 "message too big"). */
export const MESSAGE_TOO_BIG = 1009;
/** ws's own default maxPayload (100 MiB), for a socket that names none. */
export const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;

/** A ws message's size in bytes, whatever form the runtime hands it over in. */
export function messageBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((n: number, part) => n + messageBytes(part), 0);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

const capped = new WeakSet<WebSocket>();

/**
 * Enforce `max` on one socket ourselves, before any `message` listener sees the data. The first
 * message over it calls `onOversize` (default: close with 1009), and from then on the socket emits
 * no message at all, so no listener, added before or after this call, forwards one. Idempotent.
 */
export function enforceMaxPayload(ws: WebSocket, max: number, onOversize: (ws: WebSocket) => void = closeTooBig): WebSocket {
  if (capped.has(ws)) return ws;
  capped.add(ws);
  let over = false;
  const emit = ws.emit;
  ws.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "message") {
      if (over) return false;
      if (messageBytes(args[0]) > max) {
        over = true;
        onOversize(ws);
        return false;
      }
    }
    return emit.call(this, event, ...args);
  } as WebSocket["emit"];
  return ws;
}

function closeTooBig(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(MESSAGE_TOO_BIG, "Message too big");
}

/** A WebSocketServer whose every accepted socket holds `maxPayload` (default ws's 100 MiB) on any runtime. */
export function cappedWebSocketServer(opts: ServerOptions): WebSocketServer {
  const max = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  const wss = new WebSocketServer({ ...opts, maxPayload: max });
  const handleUpgrade = wss.handleUpgrade;
  wss.handleUpgrade = function (this: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket, req: IncomingMessage) => void) {
    return handleUpgrade.call(this, req, socket, head, (ws: WebSocket, r: IncomingMessage) => cb(enforceMaxPayload(ws, max), r));
  } as WebSocketServer["handleUpgrade"];
  // A server that accepts on its own (`server`/`port`) emits `connection` too; first in line.
  wss.prependListener("connection", (ws: WebSocket) => void enforceMaxPayload(ws, max));
  return wss;
}

export interface CappedClientOptions extends ClientOptions {
  /** What a message over `maxPayload` does (default: close with 1009, as ws's own error path does). */
  onOversize?: (ws: WebSocket) => void;
}

/** How long after ws's own handshake timer ours fires: where ws keeps its timeout, its error comes first. */
const HANDSHAKE_GRACE_MS = 50;

/**
 * A client WebSocket that holds `maxPayload` (default ws's 100 MiB) and `handshakeTimeout` on any
 * runtime. Bun's ws shim ignores `handshakeTimeout`: a peer that accepts the TCP connection and never
 * answers the upgrade would leave the socket connecting forever. Our own timer, a little after ws's,
 * emits the error ws emits ("Opening handshake has timed out") and terminates the socket, unless the
 * handshake got an answer (open, upgrade, unexpected-response) or ended first.
 */
export function cappedWebSocket(url: string, protocols: string | string[] | undefined, opts: CappedClientOptions = {}): WebSocket {
  const { onOversize, ...rest } = opts;
  const max = rest.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  const ws = protocols === undefined ? new WebSocket(url, { ...rest, maxPayload: max }) : new WebSocket(url, protocols, { ...rest, maxPayload: max });
  // Once ours timed out, the terminate's own errors are noise; and a socket closes once (Bun's can
  // report a terminated handshake's close twice).
  let timedOut = false;
  let closed = false;
  const timeoutError = new Error("Opening handshake has timed out");
  const emit = ws.emit;
  ws.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && timedOut && args[0] !== timeoutError) return false;
    if (event === "close") {
      if (closed) return false;
      closed = true;
    }
    return emit.call(this, event, ...args);
  } as WebSocket["emit"];
  if (rest.handshakeTimeout && rest.handshakeTimeout > 0) {
    const timer = setTimeout(() => {
      if (ws.readyState !== ws.CONNECTING) return;
      timedOut = true;
      ws.emit("error", timeoutError);
      ws.terminate();
    }, rest.handshakeTimeout + HANDSHAKE_GRACE_MS);
    timer.unref?.();
    const answered = () => clearTimeout(timer);
    for (const ev of ["open", "upgrade", "unexpected-response", "error", "close"]) ws.once(ev, answered);
  }
  return enforceMaxPayload(ws, max, onOversize);
}

// ─── WebSockets over a stream ───────────────────────────────────────────────────────────────────
// A LAN host's sockets run inside HTTP/2 CONNECT streams (§mesh.lan/reverse-channel), not on a
// socket the runtime accepted or dialed. Bun's ws shim can't do that: its server's handleUpgrade
// needs Bun's own server socket (it throws on any other stream), and its client ignores
// `createConnection`. The pure-JS implementation inside the ws package does both, on every runtime,
// so stream sockets always use it (by design, no probe: on Node it is what `ws` is anyway). It
// enforces maxPayload and handshakeTimeout itself; the capped checks are kept for uniformity.

type WsClasses = { WebSocket: typeof WebSocket; WebSocketServer: typeof WebSocketServer };
let pureWs: WsClasses | null = null;

function pureWsClasses(): WsClasses {
  if (pureWs) return pureWs;
  const req = createRequire(import.meta.url);
  // `ws` itself resolves to Bun's builtin shim there; its package.json is exported everywhere.
  const dir = path.dirname(req.resolve("ws/package.json"));
  pureWs = { WebSocket: req(path.join(dir, "lib/websocket.js")), WebSocketServer: req(path.join(dir, "lib/websocket-server.js")) };
  return pureWs;
}

/** A noServer WebSocketServer that can upgrade a request arriving on any Duplex, capped like the rest. */
export function streamWebSocketServer(opts: Omit<ServerOptions, "noServer" | "server" | "port" | "host"> = {}): WebSocketServer {
  const max = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  const wss = new (pureWsClasses().WebSocketServer)({ ...opts, noServer: true, maxPayload: max });
  const handleUpgrade = wss.handleUpgrade;
  wss.handleUpgrade = function (this: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket, req: IncomingMessage) => void) {
    return handleUpgrade.call(this, req, socket, head, (ws: WebSocket, r: IncomingMessage) => cb(enforceMaxPayload(ws, max), r));
  } as WebSocketServer["handleUpgrade"];
  return wss;
}

/** A client WebSocket whose connection is `stream` (one that already reaches the server), capped like the rest. */
export function streamWebSocket(url: string, stream: Duplex, protocols: string | string[] | undefined, opts: CappedClientOptions = {}): WebSocket {
  const { onOversize, ...rest } = opts;
  const max = rest.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  const Pure = pureWsClasses().WebSocket;
  // createConnection is typed as returning a net.Socket; any Duplex that reaches the server works.
  const o = { ...rest, maxPayload: max, createConnection: () => stream } as unknown as ClientOptions;
  const ws = protocols === undefined ? new Pure(url, o) : new Pure(url, protocols, o);
  return enforceMaxPayload(ws, max, onOversize);
}

// ─── Event-loop delay ───────────────────────────────────────────────────────────────────────────
// Node's monitorEventLoopDelay records each timer interval (resolution + lateness). Bun 1.4.2's
// records only the lateness, so `sample - resolution` reads 0 there. Probe once: where the
// histogram doesn't measure what Node's does, a timer-drift sampler measures it instead.

/** Event-loop delay readings, in nanoseconds, in Node's histogram form (each sample includes the resolution). */
export interface LoopDelaySampler {
  percentile(p: number): number;
  readonly max: number;
  reset(): void;
  disable(): void;
}

let histogramWorks: Promise<boolean> | null = null;

/** Does monitorEventLoopDelay record whole timer intervals? Probed once (~60 ms), then cached. */
export function loopHistogramMeasuresIntervals(): Promise<boolean> {
  histogramWorks ??= new Promise((resolve) => {
    const RES = 10;
    let h: ReturnType<typeof monitorEventLoopDelay>;
    try {
      h = monitorEventLoopDelay({ resolution: RES });
      h.enable();
    } catch {
      return resolve(false);
    }
    const t = setTimeout(() => {
      h.disable();
      // Node: every sample is ≥ the 10 ms interval. Lateness-only samples sit near 0.
      resolve(h.count > 0 && h.percentile(50) >= (RES / 2) * 1e6);
    }, RES * 6);
    t.unref?.();
  });
  return histogramWorks;
}

/** A timer-drift sampler: every `resolutionMs`, the time since the last tick, recorded like Node's histogram. */
function driftSampler(resolutionMs: number): LoopDelaySampler {
  const h: RecordableHistogram = createHistogram();
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    h.record(Math.max(1, Math.round((now - last) * 1e6)));
    last = now;
  }, resolutionMs);
  timer.unref?.();
  return {
    percentile: (p) => (h.count ? h.percentile(p) : 0),
    get max() {
      return h.count ? h.max : 0;
    },
    reset: () => h.reset(),
    disable: () => clearInterval(timer),
  };
}

/**
 * The event-loop delay at `resolutionMs`: monitorEventLoopDelay where it measures whole intervals,
 * else a timer-drift sampler. The drift sampler runs until the probe answers, so the first readings
 * are never empty.
 */
export function loopDelaySampler(resolutionMs: number): LoopDelaySampler {
  let active: LoopDelaySampler = driftSampler(resolutionMs);
  let disabled = false;
  void loopHistogramMeasuresIntervals().then((ok) => {
    if (!ok || disabled) return;
    const h = monitorEventLoopDelay({ resolution: resolutionMs });
    h.enable();
    active.disable();
    active = { percentile: (p) => h.percentile(p), get max() { return h.max; }, reset: () => h.reset(), disable: () => h.disable() };
  });
  return {
    percentile: (p) => active.percentile(p),
    get max() {
      return active.max;
    },
    reset: () => active.reset(),
    disable: () => {
      disabled = true;
      active.disable();
    },
  };
}

// ─── permessage-deflate ─────────────────────────────────────────────────────────────────────────
// Bun 1.4.2's ws server never negotiates permessage-deflate, whatever its options: messages go
// uncompressed (correct, just bigger). No workaround; this probe tells the compression tests which
// behaviour to expect.

let deflateWorks: Promise<boolean> | null = null;

/** Does a ws server here negotiate permessage-deflate with a client that offers it? Probed once. */
export function wsNegotiatesDeflate(): Promise<boolean> {
  deflateWorks ??= new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: true });
    const done = (ok: boolean) => {
      // ws's close() leaves accepted sockets open, and an open one keeps the process alive.
      for (const s of wss.clients) s.terminate();
      wss.close();
      resolve(ok);
    };
    wss.on("error", () => done(false));
    wss.on("listening", () => {
      const { port } = wss.address() as { port: number };
      const c = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
      c.on("open", () => {
        const ok = /permessage-deflate/.test(c.extensions);
        c.terminate();
        done(ok);
      });
      c.on("error", () => done(false));
    });
  });
  return deflateWorks;
}

// ─── Connection errors ──────────────────────────────────────────────────────────────────────────
// A refused connection reaches fetch's caller as `cause.code: "ECONNREFUSED"` on Node (undici wraps
// the socket error) and as `code: "ConnectionRefused"` on Bun 1.4.2, with other wording all round.
// Classify by code, never by message.

const REFUSED_CODES = new Set(["ECONNREFUSED", "ConnectionRefused"]);

/** The error's code: its own, else its cause's (fetch wraps the socket error; ws hands it over as is). */
export function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** Was this a refused connection (nothing listening), on any runtime? */
export const connectionRefused = (err: unknown): boolean => REFUSED_CODES.has(errorCode(err) ?? "");

// ─── Provider response reads ────────────────────────────────────────────────────────────────────
// Bun 1.4.2's fetch hands a streamed body over in reads of 128–256 KiB where Node's are 64 KiB. pi-ai
// handles every SSE event of a read before it looks at the abort signal again, and re-parses a tool
// call's whole argument string on each delta (O(n) per delta). So after the stream guard stops a
// runaway tool call, Bun kept parsing ~670 more deltas where Node parsed ~75: ~4x the stall. This
// fetch re-slices the body to at most 64 KiB per read (Node's own size, so nothing changes there),
// passes every byte through unchanged, and refuses the next read once the request was aborted.

/** Node's own streamed-body read size, and the most this fetch hands over at once. */
export const PROVIDER_READ_MAX = 64 * 1024;

type Fetch = typeof globalThis.fetch;

/** `inner`, with every response body re-sliced to reads of at most `max` bytes that stop at an abort. */
export function slicingFetch(inner: Fetch = (...a) => globalThis.fetch(...a), max = PROVIDER_READ_MAX): Fetch {
  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const res = await inner(input, init);
    if (!res.body) return res;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const reader = res.body.getReader();
    let chunk: Uint8Array | null = null;
    let at = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
            void reader.cancel().catch(() => {});
            return;
          }
          if (!chunk || at >= chunk.length) {
            const { value, done } = await reader.read();
            if (done) return controller.close();
            chunk = value;
            at = 0;
          }
          const end = Math.min(chunk.length, at + max);
          controller.enqueue(chunk.subarray(at, end));
          at = end;
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    const sliced = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(sliced, "url", { value: res.url });
    return sliced;
  }) as Fetch;
}

/** The provider APIs whose pi-ai adapters refuse a custom fetch (they throw). */
const OWN_FETCH_APIS = /^google/;
const sliced = Symbol.for("sova.slicedProviderFetch");

/**
 * Give an agent's provider requests the slicing fetch: wraps `agent.streamFunction` once. A request
 * that already names a fetch, or whose adapter refuses one (google-*), goes through unchanged.
 */
export function useSlicedProviderReads(agent: { streamFunction: (...args: any[]) => unknown }): void {
  type Stream = ((model: { api?: string }, context: unknown, options?: { fetch?: Fetch }) => unknown) & { [sliced]?: true };
  const orig = agent.streamFunction as Stream;
  if (orig[sliced]) return;
  const fetch = slicingFetch();
  const wrapped: Stream = (model, context, options) =>
    options?.fetch || OWN_FETCH_APIS.test(model.api ?? "") ? orig(model, context, options) : orig(model, context, { ...options, fetch });
  wrapped[sliced] = true;
  agent.streamFunction = wrapped;
}
