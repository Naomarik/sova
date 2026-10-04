// Dial-out pairings at runtime (§mesh.lan/pairing, §mesh.lan/as-a-peer): this host's key, the relay
// listener for the pairings it accepts, both channels to each relay it dials, the clients this host
// asks with, and the gate every pairing's requests go through. It follows peers.json: no pairing,
// nothing runs; a removed pairing loses every connection at once.
//
// Who calls is the pairing of the connection, from its pin, re-read from peers.json on every
// request; requests then pass the same PeerGate as a tailnet peer's (listener.ts): what a peer may
// reach, its grant, dispatch with `meshPeer`, revocation.
//
// Never logs a key, a pin or an address: pairings are named by their label.

import crypto from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import type { LanStatus, LanPairingStatus, LanChannelStatus } from "../../shared/mesh-lan";
import { stateRoot } from "../state-root";
import { fingerprint, type LanIdentity, mintLanIdentity, spkiPin } from "./lan-cert";
import { LAN_PROFILE } from "./lan-admission";
import { type DialerStatus, RelayDialer } from "./lan-dialer";
import { RelayListener, type RelayPeer } from "./lan-relay";
import { RelaySessions } from "./lan-relay-sessions";
import { connectReverse, feedStream, type ReverseClient, serveReverse } from "./lan-reverse";
import type { Channel } from "./lan-tls";
import { type GateDeps, PeerGate } from "./listener";
import type { Need } from "./access";
import type { PeerEntry, PeersConfig, RelaySetting } from "./peers";

// ---- this host's key --------------------------------------------------------------------------

export const lanIdentityFile = (): string => join(stateRoot(), "lan-identity.json");

let cached: { file: string; id: LanIdentity } | null = null;

/** This host's key, or null while none was made. A file that doesn't hold a usable key is null too. */
export function readLanIdentity(): LanIdentity | null {
  const file = lanIdentityFile();
  if (cached?.file === file) return cached.id;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; keyPem?: unknown; certPem?: unknown };
    if (raw.version !== 1 || typeof raw.keyPem !== "string" || typeof raw.certPem !== "string") return null;
    const pin = spkiPin(new crypto.X509Certificate(raw.certPem));
    if (spkiPin(crypto.createPrivateKey(raw.keyPem)) !== pin) return null; // a key and cert that don't belong together
    cached = { file, id: { keyPem: raw.keyPem, certPem: raw.certPem, pin } };
    return cached.id;
  } catch {
    return null;
  }
}

/** This host's key, made and written (0600, atomic) the first time it is asked for. */
export function ensureLanIdentity(): LanIdentity {
  const have = readLanIdentity();
  if (have) return have;
  const id = mintLanIdentity();
  const file = lanIdentityFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, keyPem: id.keyPem, certPem: id.certPem })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  cached = { file, id };
  return id;
}

/** Tests: forget the cached key (a test moves the state root). */
export const forgetLanIdentity = (): void => {
  cached = null;
};

// ---- the runtime ------------------------------------------------------------------------------

export interface LanDeps extends GateDeps {
  /** The pairing with this node id, from peers.json as it is now, or null. */
  pairingByNode: (nodeId: string) => PeerEntry | null;
  /** A pairing just reached this host or was reached: it is up. */
  sawPeer?: (peerId: string, up: boolean) => void;
}

interface DialPair {
  key: string;
  answer: RelayDialer;
  ask: RelayDialer;
}

export class LanRuntime {
  private readonly gate: PeerGate;
  /** One never-listened server per pairing (by node id): its streams' requests go through the gate. */
  private readonly servers = new Map<string, Server>();
  /** The client this host asks each pairing with (by peer id). */
  private readonly clients = new Map<string, ReverseClient>();
  private readonly dials = new Map<string, DialPair>();
  private readonly answerSessions = new RelaySessions<ReverseClient>({ replaced: (_id, l) => console.log(`[mesh] dial-out pairing ${l}: a newer connection replaced the older`), cloneSuspected: (_id, l) => console.warn(`[mesh] dial-out pairing ${l}: connections keep replacing each other; two machines may hold its key`) });
  private readonly askSessions = new RelaySessions<{ close(): void }>({ replaced: (_id, l) => console.log(`[mesh] dial-out pairing ${l}: a newer connection replaced the older`), cloneSuspected: (_id, l) => console.warn(`[mesh] dial-out pairing ${l}: connections keep replacing each other; two machines may hold its key`) });
  private listener: RelayListener | null = null;
  private listenerKey = "";
  /** Every socket the relay listener handed on that is still open. */
  private readonly relayed = new Set<TLSSocket>();
  private accepted: PeerEntry[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LanDeps) {
    this.gate = new PeerGate(deps);
  }

  /** Follow peers.json (null: the mesh is off). Serialized; resolves once the listener is in place. */
  apply(config: PeersConfig | null): Promise<void> {
    // A fixed phrase and the error's code only: a listen error's message names the bind address.
    this.chain = this.chain.then(() => this.reconcile(config)).catch((err) => console.warn(`[mesh] dial-out pairings: couldn't apply the pairings (${(err as NodeJS.ErrnoException).code ?? "error"})`));
    return this.chain;
  }

  private async reconcile(config: PeersConfig | null): Promise<void> {
    const peers = config?.peers ?? [];
    const id = readLanIdentity();
    const dial = id ? peers.filter((p) => p.lan?.role === "dial") : [];
    this.accepted = id ? peers.filter((p) => p.lan?.role === "accept") : [];

    // Dial pairings: both channels each, restarted when what they dial changes.
    const want = new Map(dial.map((p) => [p.id, `${p.lan!.pin}|${p.lan!.host}|${p.lan!.port}|${p.nodeId}`]));
    for (const [peerId, d] of this.dials) {
      if (want.get(peerId) === d.key) continue;
      d.answer.stop();
      d.ask.stop();
      this.dials.delete(peerId);
      this.dropClient(peerId);
    }
    for (const p of dial) {
      if (this.dials.has(p.id)) continue;
      const target = { id: p.id, label: p.label, host: p.lan!.host!, port: p.lan!.port!, pin: p.lan!.pin };
      const node = p.nodeId;
      const answer = new RelayDialer({ identity: id!, relay: target, channel: "answer", onStream: (d) => this.feed(node, d), onStatus: (s) => this.noteDial(p.id, s) });
      const ask = new RelayDialer({
        identity: id!,
        relay: target,
        channel: "ask",
        onClient: (c) => (c ? this.clients.set(p.id, c) : this.clients.delete(p.id)),
        onStatus: (s) => this.noteDial(p.id, s),
      });
      this.dials.set(p.id, { key: want.get(p.id)!, answer, ask });
      answer.start();
      ask.start();
    }

    // Accepted pairings: the relay listener, while any exists and this host has a relay setting.
    const keep = this.accepted.map((p) => p.id);
    this.answerSessions.keepOnly(keep);
    this.askSessions.keepOnly(keep);
    for (const peerId of [...this.clients.keys()]) if (!this.dials.has(peerId) && !keep.includes(peerId)) this.dropClient(peerId);
    const relay = config?.self.relay;
    const key = relay && this.accepted.length ? `${relay.host}|${relay.port}` : "";
    if (key !== this.listenerKey) {
      await this.listener?.close();
      this.listener = null;
      // Stop Relaying, or another address or port: every connection the old listener let in ends
      // now, on both channels, with every request and socket inside (§mesh.lan/pairing). A pairing
      // kept as paired may dial the new listener; nothing of the old one stays up.
      if (this.listenerKey) this.endRelayed();
      this.listenerKey = key;
      if (key) this.listener = this.startListener(id!, relay!);
    }
    await this.listener?.setPaired(this.accepted.map((p): RelayPeer => ({ id: p.id, label: p.label, pin: p.lan!.pin })));

    // Every pairing no longer listed loses its streams' admitted connections.
    const nodes = new Set([...dial, ...this.accepted].map((p) => p.nodeId));
    this.gate.revoke((n) => nodes.has(n));
    for (const n of [...this.servers.keys()]) if (!nodes.has(n)) this.servers.delete(n);
  }

  private startListener(id: LanIdentity, relay: RelaySetting): RelayListener {
    const l = new RelayListener({
      host: relay.host,
      port: relay.port,
      identity: id,
      profile: LAN_PROFILE, // the only exposure until the separate accept process exists
      onPeer: (sock, peer, channel) => this.accept(sock, peer, channel),
      onEvent: (e) => {
        // Counts and bans only: never an address, a pin or what a connection carried.
        if (e.kind === "ban") console.warn("[mesh] relay: an address was banned after repeated failed handshakes");
        else console.warn(`[mesh] relay listener: ${e.message}`);
      },
    });
    return l;
  }

  /** End everything the relay listener let in: both channels of every accepted pairing, their
      clients, and every request and socket admitted through the gate on them. */
  private endRelayed(): void {
    this.answerSessions.closeAll();
    this.askSessions.closeAll();
    for (const s of this.relayed) s.destroy(); // handed on, but not admitted yet
    this.relayed.clear();
    const accepted = new Set(this.accepted.map((p) => p.nodeId));
    for (const peerId of [...this.clients.keys()]) if (!this.dials.has(peerId)) this.dropClient(peerId);
    this.gate.revoke((n) => !accepted.has(n));
  }

  /** A pinned connection from an accepted pairing, on one channel. */
  private accept(sock: TLSSocket, rp: RelayPeer, channel: Channel): void {
    const peer = this.accepted.find((p) => p.id === rp.id);
    if (!peer) {
      sock.destroy();
      return;
    }
    // Every socket the listener hands on is this listener's: a new bind or Stop Relaying ends it.
    const key = this.listenerKey;
    const current = () => this.listenerKey === key && this.accepted.some((p) => p.id === peer.id);
    this.relayed.add(sock);
    sock.once("close", () => this.relayed.delete(sock));
    if (channel === "ask") {
      const server = serveReverse(sock, (d) => this.feed(peer.nodeId, d));
      const held = { close: () => server.close() };
      // Admitted (replacing the pairing's older connection) only once its HTTP/2 session is up, as
      // on the answer channel: a connection its own dialer drops at once, such as one that pinned
      // another relay, never displaces a working one.
      server.session.once("remoteSettings", () => {
        if (!current()) return server.close(); // unpaired, or the listener moved, meanwhile
        this.askSessions.admit(peer.id, peer.label, held, Date.now());
        void server.closed.then(() => this.askSessions.ended(peer.id, held));
        this.deps.sawPeer?.(peer.id, true);
      });
      return;
    }
    void connectReverse(sock).then(
      (client) => {
        if (!current()) return client.close(); // unpaired, or the listener moved, meanwhile
        this.answerSessions.admit(peer.id, peer.label, client, Date.now());
        this.clients.set(peer.id, client);
        this.deps.sawPeer?.(peer.id, true);
        void client.closed.then(() => {
          this.answerSessions.ended(peer.id, client);
          if (this.clients.get(peer.id) === client) this.clients.delete(peer.id);
        });
      },
      () => sock.destroy(),
    );
  }

  /** A stream from pairing `nodeId`: its request goes through the gate as that pairing. */
  private feed(nodeId: string, d: Duplex): void {
    let server = this.servers.get(nodeId);
    if (!server) {
      server = this.gate.server(() => this.deps.pairingByNode(nodeId));
      this.servers.set(nodeId, server);
    }
    feedStream(server, d); // with the header, request and idle deadlines a listened server would have
  }

  private noteDial(peerId: string, s: DialerStatus): void {
    if (s.state === "connected") this.deps.sawPeer?.(peerId, true);
  }

  private dropClient(peerId: string): void {
    this.clients.get(peerId)?.close();
    this.clients.delete(peerId);
  }

  /** The client this host asks pairing `peerId` with, while connected; else null. */
  client(peerId: string): ReverseClient | null {
    const c = this.clients.get(peerId);
    return c && !c.destroyed ? c : null;
  }

  /** Not connected: a probe or request to it fails at once, never waits. */
  connected(peerId: string): boolean {
    return this.client(peerId) !== null;
  }

  revoke(allowed: (nodeId: string) => boolean): void {
    this.gate.revoke(allowed);
  }

  revokeGrants(allows: (nodeId: string, need: Need) => boolean): void {
    this.gate.revokeGrants(allows);
  }

  /** What the Mesh page shows: this host's pin (no key), the relay listener, each pairing's channels. */
  status(config: PeersConfig | null): LanStatus {
    const id = readLanIdentity();
    const relay = config?.self.relay;
    const pairings = (config?.peers ?? []).filter((p) => p.lan).map((p): LanPairingStatus => {
      const role = p.lan!.role;
      const channels: Record<Channel, LanChannelStatus> =
        role === "dial"
          ? { answer: dialView(this.dials.get(p.id)?.answer.status), ask: dialView(this.dials.get(p.id)?.ask.status) }
          : {
              answer: this.answerSessions.status(p.id, Date.now()).connected ? { state: "connected", since: this.answerSessions.status(p.id, Date.now()).since! } : { state: "not connected" },
              ask: this.askSessions.status(p.id, Date.now()).connected ? { state: "connected", since: this.askSessions.status(p.id, Date.now()).since! } : { state: "not connected" },
            };
      const clone = role === "accept" && (this.answerSessions.status(p.id, Date.now()).cloneSuspected || this.askSessions.status(p.id, Date.now()).cloneSuspected);
      return {
        id: p.id,
        label: p.label,
        role,
        fingerprint: fingerprint(p.lan!.pin),
        ...(role === "dial" ? { host: p.lan!.host!, port: p.lan!.port! } : {}),
        channels,
        ...(clone ? { cloneSuspected: true } : {}),
      };
    });
    const addr = this.listener?.address();
    return {
      ...(id ? { fingerprint: fingerprint(id.pin) } : {}),
      ...(relay ? { relay: { host: relay.host, port: relay.port, exposure: "lan" as const, listening: !!this.listener?.listening, ...(addr ? { boundPort: addr.port } : {}), ...(this.listener ? { counts: pick(this.listener.counts()) } : {}) } } : {}),
      pairings,
    };
  }

  /** The view while nothing runs (the mesh is off): this host's pin and relay setting, no connections. */
  static idleStatus(config: PeersConfig | null): LanStatus {
    const id = readLanIdentity();
    const relay = config?.self.relay;
    const idle: LanChannelStatus = { state: "not connected" };
    return {
      ...(id ? { fingerprint: fingerprint(id.pin) } : {}),
      ...(relay ? { relay: { host: relay.host, port: relay.port, exposure: "lan" as const, listening: false } } : {}),
      pairings: (config?.peers ?? [])
        .filter((p) => p.lan)
        .map((p) => ({
          id: p.id,
          label: p.label,
          role: p.lan!.role,
          fingerprint: fingerprint(p.lan!.pin),
          ...(p.lan!.role === "dial" ? { host: p.lan!.host!, port: p.lan!.port! } : {}),
          channels: { answer: idle, ask: idle },
        })),
    };
  }

  /** Everything off (the mesh turned off, or shutdown). */
  async stop(): Promise<void> {
    await this.apply(null);
  }
}

function dialView(s: DialerStatus | undefined): LanChannelStatus {
  if (!s || s.state === "stopped") return { state: "not connected" };
  if (s.state === "waiting") return { state: "waiting", reason: s.reason, retryAt: s.retryAt };
  return s;
}

const pick = (c: ReturnType<RelayListener["counts"]>) => ({ open: c.open, banned: c.banned, bans: c.bans });
