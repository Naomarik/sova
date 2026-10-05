// A relay's listener for dial-out hosts (§mesh.lan/relay-listener). It exists only while a host is
// paired, binds one given address (never every interface), admits each TCP connection before any
// TLS work (lan-admission.ts), and hands on only sockets whose client pin is a paired host's, with
// the channel they asked for (§mesh.lan/handshake). What runs over that socket is the caller's
// (lan-reverse.ts). The pin check reads the current pairings, so a pairing change needs no rebuild;
// only a different bind does.
//
// Builtins only. Records counts and bans, never what a connection carried, a pin or a key.

import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import tls, { type Server, type TLSSocket } from "node:tls";
import { relayAddress, relayBindAddress } from "../../shared/mesh-lan";
import type { LanIdentity } from "./lan-cert";
import { Admission, type AdmissionCounts, type AdmissionProfile, sourceOf } from "./lan-admission";
import { type Channel, pairedPeerOf, relayServerOptions } from "./lan-tls";

export interface RelayPeer {
  id: string;
  label: string;
  pin: string;
}

export type RelayEvent = { kind: "ban"; ip: string } | { kind: "error"; message: string };

export interface RelayListenerOptions {
  host: string;
  port: number;
  /** "internet": bind any one unicast address (relayBindAddress). Only the accept process passes it
      (relay-accept/main.ts, §mesh.lan/accept-process); Sova's own listener (lan.ts) never does, so it
      takes local-network addresses only. */
  scope?: "lan" | "internet";
  identity: LanIdentity;
  profile: AdmissionProfile;
  /** A socket that proved to be `peer`, on `channel`. The caller owns it from here on. */
  onPeer: (sock: TLSSocket, peer: RelayPeer, channel: Channel) => void;
  onEvent?: (e: RelayEvent) => void;
  now?: () => number;
}

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

  private readonly host: string;

  constructor(private readonly opts: RelayListenerOptions) {
    // The same rule as the relay setting (peers.ts), for any caller: one loopback, private or
    // link-local address, never every interface and never a public one (§mesh.lan/pairing). The
    // accept process alone may bind one public address.
    if (opts.scope === "internet") {
      const at = relayBindAddress(opts.host);
      if ("error" in at) throw new Error(`an internet relay binds one address: ${at.error}`);
      this.host = at.address;
    } else {
      const at = relayAddress(opts.host);
      if ("error" in at) throw new Error(`a relay binds one local-network address: ${at.error}`);
      this.host = at.address;
    }
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
    this.paired = peers; // the post-handshake check reads this at once
    if (!peers.length) await this.stopServer();
    else if (!this.server) await this.startServer();
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
    const server = tls.createServer(relayServerOptions(this.opts.identity));
    server.prependListener("connection", (raw: Socket) => this.onRaw(raw));
    server.on("tlsClientError", (_err: Error, sock: TLSSocket) => {
      this.settle(sock, false);
      sock.destroy(); // with a listener here, the runtime leaves the socket open
    });
    server.on("secureConnection", (sock: TLSSocket) => this.onSecure(sock));
    server.on("error", (err: Error) => this.opts.onEvent?.({ kind: "error", message: (err as { code?: string }).code ?? "listener error" }));
    // A rebuild keeps the port the first listen bound (port 0 picks one only once).
    server.listen(this.boundPort ?? this.opts.port, this.host);
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
    const hit = pairedPeerOf(sock, this.paired);
    if (!hit) {
      this.settle(sock, false);
      sock.destroy();
      return;
    }
    this.settle(sock, true);
    this.opts.onPeer(sock, hit.peer, hit.channel);
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
      const src = sourceOf(p.ip); // the ban is on the source: a global IPv6 address's whole /64
      for (const q of this.pending.values()) if (!q.settled && sourceOf(q.ip) === src) q.raw.destroy();
    }
  }
}
