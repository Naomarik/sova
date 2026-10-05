// The accept process for an internet relay (§mesh.lan/accept-process): it owns the public port, runs
// the OUTER pinned handshake and admission (RelayListener with the internet scope, INTERNET_PROFILE),
// and hands each connection whose outer pin is an accepted pairing's to Sova over Sova's unix
// handoff socket, after one header line, as raw bytes. Sova then runs the inner handshake itself, so
// everything this process carries is ciphertext it can't read (§mesh.lan/handshake).
//
// It knows only what Sova says over its control connection, and only while that connection is up:
// the control connection closing closes the listener and ends every connection it carries (fail
// closed); it then dials again. It never parses what it carries and never names a source to Sova.
//
// Builtins only (bundled into one file for Node: relay-accept/main.ts). Logs counts, bans, fixed
// phrases and the port it listens on: never an address, a pin or a key.

import crypto from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import { dirname } from "node:path";
import { pipeline } from "node:stream";
import type { TLSSocket } from "node:tls";
import { type AdmissionProfile, INTERNET_PROFILE } from "./lan-admission";
import { type LanIdentity, mintLanIdentity, spkiPin } from "./lan-cert";
import { BEAT_MS, CONTROL_LINE_MAX, type FromAcceptor, headerLine, LineReader, type ListenTarget, parseToAcceptor } from "./lan-handoff-protocol";
import { RelayListener, type RelayPeer } from "./lan-relay";
import type { Channel } from "./lan-tls";

export interface AcceptorOptions {
  /** Sova's handoff socket, as this process sees it. */
  handoffPath: string;
  /** The outer key: this process's own, never Sova's. */
  identity: LanIdentity;
  build: string;
  profile?: AdmissionProfile;
  /** Wait between control dials. */
  redialMs?: number;
  beatMs?: number;
  /** Tests: Sova may name port 0. */
  zeroPort?: boolean;
  /** Sova said a newer build is installed: exit, so the service manager starts it. */
  onStale?: () => void;
  log?: (line: string) => void;
}

export class Acceptor {
  private control: Socket | null = null;
  private controlUp = false;
  private stopped = true;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private listener: RelayListener | null = null;
  private listenKey = "";
  private pins: string[] = [];
  private target: ListenTarget | null = null;
  private retryListen: ReturnType<typeof setTimeout> | null = null;
  /** Every carried connection: its outer socket, its handoff socket, and the pin it was let in on. */
  private readonly carried = new Set<{ outer: TLSSocket; handoff: Socket; pin: string }>();
  private chain: Promise<void> = Promise.resolve();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AcceptorOptions) {
    this.log = opts.log ?? ((l) => console.log(`[relay-accept] ${l}`));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dialControl();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.redial) clearTimeout(this.redial);
    this.redial = null;
    this.control?.destroy();
    this.control = null;
    this.controlUp = false;
    await this.serialize(() => this.closeListener());
  }

  /** Listening now, and on which port (tests, the beat). */
  get boundPort(): number | null {
    return this.listener?.listening ? (this.listener.address()?.port ?? null) : null;
  }

  get carriedCount(): number {
    return this.carried.size;
  }

  private serialize(f: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(f, f);
    return this.chain;
  }

  // ─── control ─────────────────────────────────────────────────────────────────────────────────

  private dialControl(): void {
    if (this.stopped) return;
    const s = net.connect(this.opts.handoffPath);
    this.control = s;
    const reader = new LineReader(CONTROL_LINE_MAX);
    s.on("error", () => {});
    s.once("connect", () => {
      if (this.control !== s) return s.destroy();
      this.controlUp = true;
      this.log("control connected");
      s.write(headerLine({ kind: "control", build: this.opts.build, pin: this.opts.identity.pin }));
      this.beat = setInterval(() => this.sendBeat(), this.opts.beatMs ?? BEAT_MS);
      this.beat.unref?.();
    });
    s.on("data", (chunk: Buffer) => {
      const lines = reader.push(chunk);
      if (!lines) return s.destroy(); // a line past the cap: not Sova speaking this protocol
      for (const line of lines) {
        const msg = parseToAcceptor(line, this.opts.zeroPort);
        if (!msg) return s.destroy();
        if (msg.t === "stale") {
          this.log("a newer build is installed: exiting");
          s.destroy();
          this.opts.onStale?.();
          return;
        }
        void this.serialize(() => this.configure(msg.pins, msg.listen));
      }
    });
    s.once("close", () => {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      const was = this.controlUp;
      if (this.control === s) {
        this.control = null;
        this.controlUp = false;
      }
      if (was) this.log("control lost: refusing everyone until it is back");
      // Fail closed: no control, no listener and nothing carried.
      void this.serialize(() => this.configure([], null));
      if (!this.stopped) {
        this.redial = setTimeout(() => {
          this.redial = null;
          this.dialControl();
        }, this.opts.redialMs ?? 2_000);
        this.redial.unref?.();
      }
    });
  }

  private sendBeat(): void {
    if (!this.control || !this.controlUp) return;
    const c = this.listener?.counts();
    const msg: FromAcceptor = { t: "beat", bound: this.boundPort, counts: { open: c?.open ?? 0, banned: c?.banned ?? 0, bans: c?.bans ?? 0 } };
    this.control.write(`${JSON.stringify(msg)}\n`);
  }

  // ─── the listener ────────────────────────────────────────────────────────────────────────────

  private async configure(pins: string[], listen: ListenTarget | null): Promise<void> {
    this.pins = pins;
    this.target = listen;
    if (this.retryListen) clearTimeout(this.retryListen);
    this.retryListen = null;
    // A pairing no longer accepted loses what it has here at once (Sova ends its side too).
    for (const c of [...this.carried]) if (!pins.includes(c.pin)) this.end(c);
    if (!listen || !pins.length || !this.controlUp) {
      await this.closeListener();
      this.sendBeat();
      return;
    }
    const key = `${listen.host}|${listen.port}`;
    if (key !== this.listenKey) await this.closeListener();
    if (!this.listener) {
      try {
        this.listener = new RelayListener({
          scope: "internet",
          host: listen.host,
          port: listen.port,
          identity: this.opts.identity,
          profile: this.opts.profile ?? INTERNET_PROFILE,
          onPeer: (sock, peer, channel) => this.handOff(sock, peer, channel),
          onEvent: (e) => {
            if (e.kind === "ban") this.log("a source was banned after repeated failed handshakes");
            else this.log(`listener: ${e.message}`);
          },
        });
        this.listenKey = key;
      } catch {
        this.log("Sova named an address this process won't bind");
        this.sendBeat();
        return;
      }
    }
    try {
      await this.listener.setPaired(pins.map((pin): RelayPeer => ({ id: pin, label: "pairing", pin })));
      this.log(`listening on port ${this.boundPort ?? "?"} for ${pins.length} pairing${pins.length === 1 ? "" : "s"}`);
    } catch (err) {
      // A fixed phrase and the code only: a listen error's message names the address.
      this.log(`couldn't listen (${(err as NodeJS.ErrnoException).code ?? "error"}); trying again in 5 s`);
      await this.closeListener();
      this.retryListen = setTimeout(() => void this.serialize(() => this.configure(this.pins, this.target)), 5_000);
      this.retryListen.unref?.();
    }
    this.sendBeat();
  }

  private async closeListener(): Promise<void> {
    const l = this.listener;
    this.listener = null;
    this.listenKey = "";
    for (const c of [...this.carried]) this.end(c);
    if (l) {
      await l.close();
      this.log("not listening");
    }
  }

  // ─── handing a connection to Sova ────────────────────────────────────────────────────────────

  /** `outer` proved to be `peer` (its pin compared in RelayListener.onSecure): hand it to Sova. */
  private handOff(outer: TLSSocket, peer: RelayPeer, channel: Channel): void {
    if (!this.controlUp || !this.pins.includes(peer.pin)) {
      outer.destroy();
      return;
    }
    const handoff = net.connect(this.opts.handoffPath);
    // Two pipelines plus this process's own watchers: past the default warning count, never a leak.
    outer.setMaxListeners(32);
    handoff.setMaxListeners(32);
    const c = { outer, handoff, pin: peer.pin };
    this.carried.add(c);
    const end = () => this.end(c);
    outer.once("close", end);
    handoff.once("close", end);
    handoff.on("error", end);
    handoff.once("connect", () => {
      if (!this.carried.has(c)) return;
      handoff.write(headerLine({ kind: "conn", pin: peer.pin, channel }));
      // Bytes only, both ways: nothing here reads what they say.
      pipeline(outer, handoff, end);
      pipeline(handoff, outer, end);
    });
  }

  private end(c: { outer: TLSSocket; handoff: Socket }): void {
    if (!this.carried.delete(c as never)) return;
    c.outer.destroy();
    c.handoff.destroy();
  }
}

/** The outer key at `file`, made (0600, atomic) the first time. Never logged. */
export function loadOrMintIdentity(file: string): LanIdentity {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; keyPem?: unknown; certPem?: unknown };
    if (raw.version === 1 && typeof raw.keyPem === "string" && typeof raw.certPem === "string") {
      const pin = spkiPin(new crypto.X509Certificate(raw.certPem));
      if (spkiPin(crypto.createPrivateKey(raw.keyPem)) === pin) return { keyPem: raw.keyPem, certPem: raw.certPem, pin };
    }
  } catch {
    /* none yet, or unusable: make one */
  }
  const id = mintLanIdentity();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, keyPem: id.keyPem, certPem: id.certPem })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return id;
}
