// A relay's listener for LAN hosts that dial in (§mesh.lan/relay-listener). It exists only while a
// host is paired, binds one given address (never every interface), admits each TCP connection
// before any TLS work (lan-admission.ts), and hands on only sockets whose client pin is a paired
// host's (§mesh.lan/handshake). What runs over that socket is the caller's (lan-reverse.ts).
//
// setSecureContext doesn't reliably replace a server's client-cert `ca` on Bun or Node, so a change
// of pairings rebuilds the server on the same address; the pin check after the handshake always
// reads the current pairings, so a removed host is refused even by a socket the old `ca` let through.
//
// Builtins only. Records counts and bans, never what a connection carried, a pin or a key.

import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import tls, { type Server, type TLSSocket } from "node:tls";
import type { LanIdentity } from "./lan-cert";
import { Admission, type AdmissionCounts, type AdmissionProfile } from "./lan-admission";
import { pairedPeerOf, relayServerOptions } from "./lan-tls";

export interface RelayPeer {
  id: string;
  label: string;
  certPem: string;
  pin: string;
}

export type RelayEvent = { kind: "ban"; ip: string } | { kind: "error"; message: string };

export interface RelayListenerOptions {
  host: string;
  port: number;
  identity: LanIdentity;
  profile: AdmissionProfile;
  /** A socket that proved to be `peer`. The caller owns it from here on. */
  onPeer: (sock: TLSSocket, peer: RelayPeer) => void;
  onEvent?: (e: RelayEvent) => void;
  now?: () => number;
}

const WILDCARD = new Set(["", "0.0.0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0"]);

interface Pending {
  ip: string;
  settled: boolean;
  raw: Socket;
}

export class RelayListener {
  private server: Server | null = null;
  private paired: RelayPeer[] = [];
  private readonly admission: Admission;
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private boundPort: number | null = null;

  constructor(private readonly opts: RelayListenerOptions) {
    if (WILDCARD.has(opts.host.trim())) throw new Error("a relay binds one address, never every interface");
    this.admission = new Admission(opts.profile);
    this.now = opts.now ?? Date.now;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  address(): AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a : null;
  }

  counts(): AdmissionCounts {
    return this.admission.counts(this.now());
  }

  /** The hosts paired with this relay: none closes the listener, a change rebuilds it. Serialized. */
  setPaired(peers: readonly RelayPeer[]): Promise<void> {
    this.chain = this.chain.then(() => this.apply([...peers]), () => this.apply([...peers]));
    return this.chain;
  }

  close(): Promise<void> {
    return this.setPaired([]);
  }

  private async apply(peers: RelayPeer[]): Promise<void> {
    const same = peers.length === this.paired.length && peers.every((p, i) => p.pin === this.paired[i]?.pin && p.certPem === this.paired[i]?.certPem);
    this.paired = peers; // the post-handshake check reads this at once, before any rebuild
    if (same && (this.server || !peers.length)) return;
    await this.stopServer();
    if (peers.length) await this.startServer();
  }

  private async stopServer(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    // Stop accepting; handshakes in progress end with it. Live sessions belong to the caller, so
    // this never waits for them (close's callback would, until the last one ends).
    for (const p of this.pending.values()) if (!p.settled) p.raw.destroy();
    s.close();
  }

  private async startServer(): Promise<void> {
    const server = tls.createServer(relayServerOptions(this.opts.identity, this.paired));
    server.prependListener("connection", (raw: Socket) => this.onRaw(raw));
    server.on("tlsClientError", (_err: Error, sock: TLSSocket) => {
      this.settle(sock, false);
      sock.destroy(); // with a listener here, the runtime leaves the socket open
    });
    server.on("secureConnection", (sock: TLSSocket) => this.onSecure(sock));
    server.on("error", (err: Error) => this.opts.onEvent?.({ kind: "error", message: (err as { code?: string }).code ?? "listener error" }));
    // A rebuild keeps the port the first listen bound (port 0 picks one only once).
    server.listen(this.boundPort ?? this.opts.port, this.opts.host);
    await once(server, "listening");
    this.boundPort = (server.address() as AddressInfo).port;
    this.server = server;
  }

  private key(s: { remoteAddress?: string; remotePort?: number }): string {
    return `${s.remoteAddress ?? "?"}|${s.remotePort ?? "?"}`;
  }

  private onRaw(raw: Socket): void {
    const ip = raw.remoteAddress ?? "";
    const verdict = this.admission.admit(ip, this.now());
    if (!verdict.ok) {
      raw.destroy();
      return;
    }
    const key = this.key(raw);
    const p: Pending = { ip, settled: false, raw };
    this.pending.set(key, p);
    raw.on("error", () => {});
    raw.once("close", () => {
      this.pending.delete(key);
      if (!p.settled) this.fail(p); // gave up mid-handshake: a failure, as a scanner's probe is
      this.admission.closed(ip);
    });
  }

  private onSecure(sock: TLSSocket): void {
    sock.on("error", () => {});
    const peer = pairedPeerOf(sock, this.paired);
    if (!peer) {
      this.settle(sock, false);
      sock.destroy();
      return;
    }
    this.settle(sock, true);
    this.opts.onPeer(sock, peer);
  }

  private settle(sock: TLSSocket, ok: boolean): void {
    const p = this.pending.get(this.key(sock));
    if (!p || p.settled) return;
    if (ok) {
      p.settled = true;
      this.admission.handshakeDone(p.ip, true, this.now());
    } else this.fail(p);
  }

  private fail(p: Pending): void {
    if (p.settled) return;
    p.settled = true;
    const now = this.now();
    const wasBanned = this.admission.isBanned(p.ip, now);
    this.admission.handshakeDone(p.ip, false, now);
    if (!wasBanned && this.admission.isBanned(p.ip, now)) {
      this.opts.onEvent?.({ kind: "ban", ip: p.ip });
      for (const q of this.pending.values()) if (q.ip === p.ip && !q.settled) q.raw.destroy();
    }
  }
}
