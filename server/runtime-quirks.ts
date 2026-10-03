// Runtime quirks: every workaround for a runtime that differs from Node, in one place
// (§app.server-runtime/quirks). The registry, with each quirk's runtime version, upstream issue,
// workaround and canary test, is docs/bun-quirks.md.
//
// Rules: workarounds detect the broken BEHAVIOUR (a probe), never the runtime's name or version, so
// a runtime that fixes a bug stops paying for its workaround; call sites never name a runtime.

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
