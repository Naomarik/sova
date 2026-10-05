// The handoff protocol between an internet relay's accept process and Sova (§mesh.lan/accept-process).
// Pure and builtins-only: the accept process's bundle and Sova both import it.
//
// The accept process opens every connection, to Sova's unix socket. Each starts with exactly one
// header line (at most HEADER_MAX bytes, within HEADER_MS), a JSON object with exactly the keys of
// one kind:
//   control  {"v":1,"kind":"control","build":<its build>,"pin":<its outer pin>}
//            then newline-delimited JSON both ways: Sova sends ToAcceptor, the accept process FromAcceptor.
//   conn     {"v":1,"kind":"conn","pin":<the outer pin it checked>,"channel":"answer"|"ask"}
//            then raw bytes both ways: the inner TLS handshake (§mesh.lan/handshake), end to end.
// Nothing here carries a source address. Pins aren't secret, but neither side logs one.

import type { Channel } from "./lan-tls";

export const PROTOCOL_VERSION = 1;
/** A header line's most bytes, newline excluded. */
export const HEADER_MAX = 256;
/** A header line must arrive within this long of the connection. */
export const HEADER_MS = 2_000;
/** A control message's most bytes, newline excluded. */
export const CONTROL_LINE_MAX = 64 * 1024;
/** The accept process says how it is every this long. */
export const BEAT_MS = 10_000;
/** Sova counts it gone when it hasn't been heard from in this long. */
export const SILENT_MS = 30_000;

const PIN_RE = /^[0-9A-F]{32}$/;
const BUILD_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type Header = { kind: "control"; build: string; pin: string } | { kind: "conn"; pin: string; channel: Channel };

export interface ListenTarget {
  host: string;
  port: number;
}

/** Sova → accept process. `config` replaces everything it knew; `stale` means exit, a newer build is installed. */
export type ToAcceptor = { t: "config"; pins: string[]; listen: ListenTarget | null } | { t: "stale" };

export interface AcceptCounts {
  open: number;
  banned: number;
  bans: number;
}

/** Accept process → Sova, after every config and every BEAT_MS. `bound`: the port it listens on, or null. */
export type FromAcceptor = { t: "beat"; bound: number | null; counts: AcceptCounts };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const have = Object.keys(o);
  return have.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The header line (without its newline), strictly: anything but exactly one known shape is null. */
export function parseHeader(line: string): Header | null {
  if (Buffer.byteLength(line) > HEADER_MAX) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== PROTOCOL_VERSION) return null;
  if (raw.kind === "control") {
    if (!exactKeys(raw, ["v", "kind", "build", "pin"])) return null;
    if (typeof raw.build !== "string" || !BUILD_RE.test(raw.build)) return null;
    if (typeof raw.pin !== "string" || !PIN_RE.test(raw.pin)) return null;
    return { kind: "control", build: raw.build, pin: raw.pin };
  }
  if (raw.kind === "conn") {
    if (!exactKeys(raw, ["v", "kind", "pin", "channel"])) return null;
    if (typeof raw.pin !== "string" || !PIN_RE.test(raw.pin)) return null;
    if (raw.channel !== "answer" && raw.channel !== "ask") return null;
    return { kind: "conn", pin: raw.pin, channel: raw.channel };
  }
  return null;
}

/** A header line, newline included. */
export function headerLine(h: Header): string {
  const body = h.kind === "control" ? { v: PROTOCOL_VERSION, kind: h.kind, build: h.build, pin: h.pin } : { v: PROTOCOL_VERSION, kind: h.kind, pin: h.pin, channel: h.channel };
  return `${JSON.stringify(body)}\n`;
}

/** A build stamp as the header carries it: anything else becomes "dev". */
export const cleanBuild = (s: string | undefined): string => (s && BUILD_RE.test(s) ? s : "dev");

const isPort = (v: unknown, zero: boolean): v is number => Number.isInteger(v) && (v as number) >= (zero ? 0 : 1) && (v as number) <= 65535;

/** A message from Sova, strictly; null if it isn't one. `zeroPort`: tests may name port 0. */
export function parseToAcceptor(line: string, zeroPort = false): ToAcceptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (raw.t === "stale") return exactKeys(raw, ["t"]) ? { t: "stale" } : null;
  if (raw.t !== "config" || !exactKeys(raw, ["t", "pins", "listen"])) return null;
  if (!Array.isArray(raw.pins) || raw.pins.length > 1024 || !raw.pins.every((p) => typeof p === "string" && PIN_RE.test(p))) return null;
  let listen: ListenTarget | null = null;
  if (raw.listen !== null) {
    if (!isObject(raw.listen) || !exactKeys(raw.listen, ["host", "port"])) return null;
    if (typeof raw.listen.host !== "string" || raw.listen.host.length > 64 || !isPort(raw.listen.port, zeroPort)) return null;
    listen = { host: raw.listen.host, port: raw.listen.port };
  }
  return { t: "config", pins: raw.pins as string[], listen };
}

/** A message from the accept process, strictly; null if it isn't one. */
export function parseFromAcceptor(line: string): FromAcceptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.t !== "beat" || !exactKeys(raw, ["t", "bound", "counts"])) return null;
  if (raw.bound !== null && !isPort(raw.bound, false)) return null;
  const c = raw.counts;
  if (!isObject(c) || !exactKeys(c, ["open", "banned", "bans"])) return null;
  const n = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 31;
  if (!n(c.open) || !n(c.banned) || !n(c.bans)) return null;
  return { t: "beat", bound: raw.bound, counts: { open: c.open, banned: c.banned, bans: c.bans } };
}

/**
 * Splits a byte stream into lines of at most `max` bytes. `push` returns the complete lines so far,
 * or null once a line ran past `max` (the caller closes the connection).
 */
export class LineReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly max: number) {}

  push(chunk: Buffer): string[] | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: string[] = [];
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) break;
      if (nl > this.max) return null;
      out.push(this.buf.subarray(0, nl).toString("utf8"));
      this.buf = this.buf.subarray(nl + 1);
    }
    if (this.buf.length > this.max) return null;
    return out;
  }
}
