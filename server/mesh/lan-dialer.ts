// A dial-out host keeps its connections to each paired relay up (§mesh.lan/dialer): dial, pin, run
// the channel, and on any loss wait and dial again. On the `answer` channel it answers the relay's
// streams; on the `ask` channel it holds an HTTP/2 client for its own requests to the relay
// (lan-reverse.ts). Removing the pairing stops it at once, with every stream inside.
//
// Statuses carry fixed phrases only: never raw error text, a pin or an address.

import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import type { LanIdentity } from "./lan-cert";
import { type ChannelTimers, connectReverse, type ReverseClient, serveReverse } from "./lan-reverse";
import { type Channel, connectPinned, type DialFailure, dialFailure } from "./lan-tls";

export interface RelayTarget {
  id: string;
  label: string;
  host: string;
  port: number;
  /** The relay's pin. */
  pin: string;
}

export type DialerStatus =
  | { state: "connecting" }
  | { state: "connected"; since: number }
  | { state: "waiting"; reason: DialFailure; retryAt: number }
  | { state: "stopped" };

/** 1 s doubling to 60 s, each wait jittered by up to a quarter either way. */
export class Backoff {
  private n = 0;
  constructor(private readonly random: () => number = Math.random, private readonly baseMs = 1000, private readonly maxMs = 60_000) {}

  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.n, 30));
    this.n++;
    return Math.round(raw * (0.75 + 0.5 * this.random()));
  }

  reset(): void {
    this.n = 0;
  }
}

const PHRASES: ReadonlySet<string> = new Set<DialFailure>(["refused", "timed out", "relay's pin didn't match", "rejected by the relay", "TLS version refused", "closed"]);
const phraseOf = (err: unknown): DialFailure => {
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" && PHRASES.has(msg) ? (msg as DialFailure) : dialFailure(err);
};

export interface RelayDialerOptions {
  identity: LanIdentity;
  relay: RelayTarget;
  channel: Channel;
  /** `answer` channel: a relay request, a stream to hand to the in-process server. */
  onStream?: (d: Duplex, relay: RelayTarget) => void;
  /** `ask` channel: the client for requests to the relay while connected, null once it is lost. */
  onClient?: (client: ReverseClient | null, relay: RelayTarget) => void;
  onStatus?: (s: DialerStatus, relay: RelayTarget) => void;
  /** A connection up this long resets the backoff. */
  stableMs?: number;
  connectTimeoutMs?: number;
  timers?: ChannelTimers;
  random?: () => number;
  now?: () => number;
}

export class RelayDialer {
  private state: DialerStatus = { state: "stopped" };
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private close: (() => void) | null = null;
  private attempt = 0;
  private readonly backoff: Backoff;
  private readonly now: () => number;

  constructor(private readonly opts: RelayDialerOptions) {
    this.backoff = new Backoff(opts.random);
    this.now = opts.now ?? Date.now;
  }

  get status(): DialerStatus {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff.reset();
    void this.dial();
  }

  /** Stop at once: the session and every stream in it end, and nothing more is scheduled. */
  stop(): void {
    this.stopped = true;
    this.attempt++; // an in-flight dial finds itself stale
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.close?.();
    this.close = null;
    if (this.opts.channel === "ask") this.opts.onClient?.(null, this.opts.relay);
    this.set({ state: "stopped" });
  }

  private set(s: DialerStatus): void {
    this.state = s;
    this.opts.onStatus?.(s, this.opts.relay);
  }

  private stale(my: number): boolean {
    return my !== this.attempt || this.stopped;
  }

  private async dial(): Promise<void> {
    const my = ++this.attempt;
    const { relay, channel } = this.opts;
    this.set({ state: "connecting" });
    let sock: TLSSocket;
    try {
      sock = await connectPinned(this.opts.identity, relay.pin, relay.host, relay.port, channel, this.opts.connectTimeoutMs);
    } catch (err) {
      if (!this.stale(my)) this.retry(phraseOf(err));
      return;
    }
    if (this.stale(my)) {
      sock.destroy();
      return;
    }
    // TLS 1.3: a relay that refuses this host says so after this side finished; keep why.
    let why: DialFailure = "closed";
    sock.on("error", (err) => {
      why = phraseOf(err);
    });
    let connectedAt = 0;
    const up = () => {
      if (this.stale(my)) return;
      connectedAt = this.now();
      this.set({ state: "connected", since: connectedAt });
    };
    let closed: Promise<void>;
    if (channel === "answer") {
      const server = serveReverse(sock, (d) => this.opts.onStream?.(d, relay), this.opts.timers);
      this.close = () => server.close();
      server.session.once("remoteSettings", up);
      closed = server.closed;
    } else {
      this.close = () => sock.destroy();
      let client: ReverseClient;
      try {
        client = await connectReverse(sock, this.opts.timers);
      } catch {
        if (!this.stale(my)) this.retry(why);
        return;
      }
      if (this.stale(my)) {
        client.close();
        return;
      }
      this.close = () => client.close();
      up();
      this.opts.onClient?.(client, relay);
      closed = client.closed;
    }
    await closed;
    if (channel === "ask" && my === this.attempt) this.opts.onClient?.(null, relay);
    if (this.stale(my)) return;
    this.close = null;
    if (connectedAt && this.now() - connectedAt >= (this.opts.stableMs ?? 30_000)) this.backoff.reset();
    this.retry(why);
  }

  private retry(reason: DialFailure): void {
    const wait = this.backoff.next();
    this.set({ state: "waiting", reason, retryAt: this.now() + wait });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) void this.dial();
    }, wait);
    this.timer.unref?.();
  }
}
