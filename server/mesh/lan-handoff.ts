// Sova's side of an internet relay (§mesh.lan/accept-process): the unix handoff socket the accept
// process connects to, its control connection, and the INNER pinned handshake (§mesh.lan/handshake)
// Sova runs itself, as the relay, on every connection the accept process hands over.
//
// Trust: the accept process is a separate, less trusted program. What it says (the pin it checked,
// the channel) only selects what Sova then demands; the connection must prove that pin itself, in
// the inner TLS 1.3 handshake with this host's own key, compared synchronously in `secure` before a
// byte is read (the q8 invariants in lan-tls.ts hold for the inner handshake too). A mismatch is
// refused and flagged: the accept process vouched for a host the connection didn't prove.
//
// The socket's directory must be Sova's own (its user and group, not a symlink, no group write, no
// access for others): Neither Node nor Bun can ask a unix socket who connected, so the filesystem is
// the gate, and only the accept process's user shares that group (SUDO.md §5). Sova takes a verified
// connection from nowhere else: never over TCP, never from another path.
//
// Never logs an address, a pin or a key.

import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import type { AcceptorState } from "../../shared/mesh-lan";
import { type LanIdentity, samePin } from "./lan-cert";
import { type AcceptCounts, CONTROL_LINE_MAX, HEADER_MAX, HEADER_MS, type Header, LineReader, type ListenTarget, parseFromAcceptor, parseHeader, SILENT_MS, type ToAcceptor } from "./lan-handoff-protocol";
import type { RelayPeer } from "./lan-relay";
import { socketDuplex } from "./lan-reverse";
import { type Channel, channelOf, HANDSHAKE_MS, livePeerPin, relayServerOptions } from "./lan-tls";

/** Inner handshakes at once, all pairings; and per pairing. */
export const MAX_INNER = 16;
export const MAX_INNER_PER_PIN = 2;

export interface HandoffOptions {
  path: string;
  /** This host's own key (the inner handshake's), or null while it has none. */
  identity: () => LanIdentity | null;
  /** The build an accept process must report: the one deployed with this process. */
  build: () => string;
  /** The accepted pairing with this pin while conn connections are taken (an internet relay is set), else null. */
  acceptedByPin: (pin: string) => RelayPeer | null;
  /** A handed-over connection that proved to be `peer` on `channel`. The caller owns it from here. */
  onPeer: (sock: Duplex, peer: RelayPeer, channel: Channel) => void;
  /** The accept process came up (true) or was lost (false). */
  onHealth?: (healthy: boolean) => void;
  /** Tests: the owner the directory must have (default: this process's). */
  owner?: { uid: number; gid: number };
  headerMs?: number;
  innerMs?: number;
  silentMs?: number;
  now?: () => number;
}

interface Control {
  sock: Socket;
  heardAt: number;
  bound: number | null;
  counts: AcceptCounts | null;
}

export class HandoffServer {
  private server: Server | null = null;
  private problem: string | null = null;
  private control: Control | null = null;
  private stale = false;
  private config: { pins: string[]; listen: ListenTarget | null } = { pins: [], listen: null };
  private readonly inner = new Map<TLSSocket, string>(); // in their inner handshake → attested pin
  private readonly raw = new Set<Socket>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private mismatch: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: HandoffOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Bind the socket, if its directory is Sova's own. Resolves with why not, or null. */
  async start(): Promise<string | null> {
    if (this.server) return null;
    this.problem = this.checkPath();
    if (this.problem) {
      console.warn(`[mesh] internet relay: no handoff socket (${this.problem})`);
      return this.problem;
    }
    const server = net.createServer((s) => this.onConnection(s));
    server.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.opts.path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(this.opts.path, 0o660); // the accept process reaches it through Sova's group alone
    } catch (err) {
      server.close();
      this.problem = `couldn't listen (${(err as NodeJS.ErrnoException).code ?? "error"})`;
      console.warn(`[mesh] internet relay: no handoff socket (${this.problem})`);
      return this.problem;
    }
    this.server = server;
    this.sweep = setInterval(() => this.checkSilent(), 1_000);
    this.sweep.unref?.();
    return null;
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    this.loseControl();
    for (const s of this.raw) s.destroy();
    this.raw.clear();
    const s = this.server;
    this.server = null;
    if (!s) return;
    // Stop accepting. Connections already handed on belong to the caller, so this never waits for
    // them (close's callback would, until the last one ends).
    s.close();
    try {
      if (lstatSync(this.opts.path).isSocket()) unlinkSync(this.opts.path);
    } catch {
      /* already gone */
    }
  }

  /** What the accept process should do now: the pins it accepts and where to listen. */
  configure(pins: string[], listen: ListenTarget | null): void {
    this.config = { pins: [...pins], listen };
    // A pairing no longer accepted: its inner handshakes end too.
    for (const [sock, pin] of this.inner) if (!pins.some((p) => samePin(p, pin))) sock.destroy();
    this.send({ t: "config", pins: this.config.pins, listen });
  }

  /** Running: control up, this protocol and build, heard from within SILENT_MS. */
  healthy(): boolean {
    return !!this.control && this.now() - this.control.heardAt < (this.opts.silentMs ?? SILENT_MS);
  }

  state(): AcceptorState {
    if (!this.server) return "not configured";
    if (this.healthy()) return "running";
    return this.stale ? "wrong version" : "not running";
  }

  /** The port the accept process listens on, and its counts, while it is running. */
  listening(): { bound: number | null; counts: AcceptCounts | null } {
    return this.healthy() ? { bound: this.control!.bound, counts: this.control!.counts } : { bound: null, counts: null };
  }

  /** When it last vouched for a host the connection didn't prove (since this process started). */
  get mismatchAt(): number | null {
    return this.mismatch;
  }

  // ─── the path ────────────────────────────────────────────────────────────────────────────────

  private checkPath(): string | null {
    const uid = this.opts.owner?.uid ?? process.getuid?.() ?? -1;
    const gid = this.opts.owner?.gid ?? process.getgid?.() ?? -1;
    let dir: ReturnType<typeof lstatSync>;
    try {
      dir = lstatSync(dirname(this.opts.path));
    } catch {
      return "its directory doesn't exist";
    }
    if (dir.isSymbolicLink() || !dir.isDirectory()) return "its directory is a symlink or not a directory";
    if (dir.uid !== uid || dir.gid !== gid) return "its directory isn't owned by this user and group";
    if (dir.mode & 0o027) return "its directory is open to other users or to group writes";
    try {
      const at = lstatSync(this.opts.path);
      if (!at.isSocket()) return "something other than a socket is at its path";
      unlinkSync(this.opts.path); // a stale socket from an earlier run
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "its path can't be read";
    }
    return null;
  }

  // ─── connections ─────────────────────────────────────────────────────────────────────────────

  private onConnection(s: Socket): void {
    this.raw.add(s);
    s.on("error", () => {});
    s.once("close", () => this.raw.delete(s));
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => s.destroy(), this.opts.headerMs ?? HEADER_MS);
    timer.unref?.();
    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > HEADER_MAX) done(null, Buffer.alloc(0));
        return;
      }
      done(nl > HEADER_MAX ? null : parseHeader(buf.subarray(0, nl).toString("utf8")), buf.subarray(nl + 1));
    };
    const done = (h: Header | null, rest: Buffer) => {
      clearTimeout(timer);
      s.off("data", onData);
      s.pause();
      if (!h) return s.destroy();
      this.raw.delete(s);
      if (h.kind === "control") this.onControl(s, h, rest);
      else this.onConn(s, h, rest);
    };
    s.on("data", onData);
  }

  private onControl(s: Socket, h: Extract<Header, { kind: "control" }>, rest: Buffer): void {
    if (h.build !== this.opts.build()) {
      // Another build: it exits and its unit starts the one deployed with this Sova.
      this.stale = true;
      s.end(`${JSON.stringify({ t: "stale" } satisfies ToAcceptor)}\n`);
      setTimeout(() => s.destroy(), 1_000).unref?.();
      console.warn("[mesh] internet relay: the accept process runs another build; told it to restart");
      return;
    }
    // A newer control connection replaces the older, which counts as losing it.
    if (this.control) this.loseControl();
    const c: Control = { sock: s, heardAt: this.now(), bound: null, counts: null };
    this.control = c;
    this.stale = false;
    const reader = new LineReader(CONTROL_LINE_MAX);
    const onLines = (chunk: Buffer) => {
      const lines = reader.push(chunk);
      if (!lines) return s.destroy();
      for (const line of lines) {
        const msg = parseFromAcceptor(line);
        if (!msg) return s.destroy();
        c.heardAt = this.now();
        c.bound = msg.bound;
        c.counts = msg.counts;
      }
    };
    s.once("close", () => {
      if (this.control === c) this.loseControl();
    });
    s.on("data", onLines);
    if (rest.length) onLines(rest);
    s.resume();
    console.log("[mesh] internet relay: the accept process connected");
    this.send({ t: "config", pins: this.config.pins, listen: this.config.listen });
    this.opts.onHealth?.(true);
  }

  private loseControl(): void {
    const c = this.control;
    if (!c) return;
    this.control = null;
    c.sock.destroy();
    for (const sock of this.inner.keys()) sock.destroy();
    this.inner.clear();
    console.warn("[mesh] internet relay: lost the accept process; its connections ended");
    this.opts.onHealth?.(false);
  }

  private checkSilent(): void {
    if (this.control && !this.healthy()) this.loseControl();
  }

  private send(msg: ToAcceptor): void {
    if (this.control && !this.control.sock.destroyed) this.control.sock.write(`${JSON.stringify(msg)}\n`);
  }

  private onConn(s: Socket, h: Extract<Header, { kind: "conn" }>, rest: Buffer): void {
    const id = this.opts.identity();
    const peer = this.healthy() && id ? this.opts.acceptedByPin(h.pin) : null;
    if (!peer || !samePin(peer.pin, h.pin)) return void s.destroy();
    let samePinPending = 0;
    for (const pin of this.inner.values()) if (samePin(pin, h.pin)) samePinPending++;
    if (this.inner.size >= MAX_INNER || samePinPending >= MAX_INNER_PER_PIN) return void s.destroy();

    const d = socketDuplex(s);
    // The carrier's errors (EPIPE, ECONNRESET: the accept process gone mid-connection) arrive on d,
    // which on Bun nothing else listens to (a TLS socket over a JS stream doesn't); kill() below
    // runs on its close either way. Without this they are uncaught.
    d.on("error", () => {});
    if (rest.length) d.unshift(rest);
    const inner = new tls.TLSSocket(d as never, { isServer: true, ...relayServerOptions(id!) } as never);
    // Ending the inner socket must end the unix connection under it: on Bun, destroying a TLS
    // socket over a JS stream leaves that stream open.
    const kill = () => {
      inner.destroy();
      d.destroy();
      s.destroy();
    };
    this.inner.set(inner, h.pin);
    const timer = setTimeout(kill, this.opts.innerMs ?? HANDSHAKE_MS);
    timer.unref?.();
    const settle = () => {
      clearTimeout(timer);
      this.inner.delete(inner);
    };
    inner.on("error", () => kill());
    inner.once("close", () => {
      settle();
      kill();
    });
    s.once("close", () => inner.destroy());
    inner.once("secure", () => {
      settle();
      // Synchronous, before anything reads the connection (the q8 invariants): the pin the
      // connection proved must be the one the accept process vouched for, on the same channel,
      // and still a pairing this host accepts.
      const pin = livePeerPin(inner);
      const channel = channelOf(inner);
      if (!pin || !samePin(pin, h.pin) || channel !== h.channel) {
        kill();
        this.mismatch = this.now();
        console.warn("[mesh] internet relay: the accept process vouched for a host the connection didn't prove: it may be compromised");
        return;
      }
      const now = this.healthy() ? this.opts.acceptedByPin(pin) : null;
      if (!now) return kill();
      this.opts.onPeer(inner, now, channel);
    });
  }
}
