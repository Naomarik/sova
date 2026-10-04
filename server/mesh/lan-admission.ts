// Pre-handshake admission for a relay's listener (§mesh.lan/relay-listener). Pure: the clock is
// passed in, nothing here touches a socket. It keeps counts per source and never anything a
// connection carried.
//
// A "source" is an address, except that a global IPv6 address counts with its whole /64: one
// subscriber usually holds a /64, so per-address counts would give an attacker 2^64 fresh starts.
// (Private and link-local IPv6 stay per address: a whole LAN, and every link-local address, shares
// one /64.) A source that completed a paired handshake recently keeps a reserve of connection slots
// and its own small table, so a flood of fresh failing sources can't lock a paired host out, and a
// ban on it (a neighbour behind the same NAT failing) is short. When the main table is full, the
// least recently seen entry with nothing open and no ban makes room.

import { addressScope, parseIp } from "../../shared/mesh-lan";

export interface AdmissionProfile {
  /** Handshakes in progress from one source. */
  perIpHandshakes: number;
  /** New connections from one source in any 1 s window. */
  perIpPerSecond: number;
  /** Failed handshakes within `failWindowMs` that ban the source. */
  failuresToBan: number;
  failWindowMs: number;
  banMs: number;
  /** Connections open at once, all sources. */
  maxConnections: number;
  /** Of those, kept for sources that paired recently: others get maxConnections minus this. */
  reservedConnections: number;
  /** Sources tracked at once; past it the least recently seen idle one is forgotten. */
  maxTracked: number;
  /** Sources that completed a paired handshake within `trustMs` are remembered (at most
      `maxTrusted`, least recent forgotten first) and banned only for `trustedBanMs`. */
  trustMs: number;
  maxTrusted: number;
  trustedBanMs: number;
  /** New handshakes a second, all sources together, from sources that didn't pair recently
      (absent: no such cap). Trusted sources are never counted or refused by it. */
  untrustedPerSecond?: number;
}

const BASE = {
  perIpHandshakes: 4,
  perIpPerSecond: 10,
  failuresToBan: 5,
  failWindowMs: 60_000,
  maxConnections: 64,
  reservedConnections: 8,
  maxTracked: 4096,
  trustMs: 24 * 60 * 60_000,
  maxTrusted: 256,
  trustedBanMs: 30_000,
};
export const LAN_PROFILE: AdmissionProfile = { ...BASE, banMs: 5 * 60_000 };
/** An internet relay's listener, which only the accept process runs (§mesh.lan/relay-listener). */
export const INTERNET_PROFILE: AdmissionProfile = { ...BASE, banMs: 15 * 60_000, maxTracked: 16_384, untrustedPerSecond: 64 };

export type Refusal = "banned" | "too many handshakes" | "too fast" | "full" | "too many addresses" | "busy";

interface Entry {
  handshaking: number;
  open: number;
  recent: number[]; // connection times in the last second
  failures: number[]; // failure times in the fail window
  bannedUntil: number;
}

export interface AdmissionCounts {
  open: number;
  tracked: number;
  banned: number;
  refused: Record<Refusal, number>;
  bans: number;
}

/** What admission counts a connection from `ip` under: the address, or a global IPv6 address's /64. */
export function sourceOf(ip: string): string {
  const p = parseIp(ip);
  if (!p) return ip;
  if (p.bytes.length === 4 || addressScope(p.bytes) !== "public") return p.text;
  const hex = p.bytes.slice(0, 8).map((b) => b.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}:${hex[2]}${hex[3]}:${hex[4]}${hex[5]}:${hex[6]}${hex[7]}::/64`;
}

export class Admission {
  /** Least recently seen first (an entry is moved to the end whenever it is seen). */
  private readonly ips = new Map<string, Entry>();
  /** Sources that paired recently: when, least recent first. */
  private readonly trusted = new Map<string, number>();
  private open = 0;
  private bans = 0;
  /** When each of the last second's admitted handshakes from untrusted sources started. */
  private untrustedStarts: number[] = [];
  private readonly refused: Record<Refusal, number> = { banned: 0, "too many handshakes": 0, "too fast": 0, full: 0, "too many addresses": 0, busy: 0 };

  constructor(private readonly profile: AdmissionProfile) {}

  /** A new TCP connection from `ip`. On ok, the caller must later call `handshakeDone` and `closed`. */
  admit(ip: string, now: number): { ok: true } | { ok: false; why: Refusal } {
    const src = sourceOf(ip);
    const trusted = this.isTrusted(src, now);
    let e = this.ips.get(src);
    if (e) {
      this.ips.delete(src); // seen now: to the end of the LRU order
      this.ips.set(src, e);
    } else {
      if (this.ips.size >= this.profile.maxTracked) this.makeRoom(now);
      const room = this.profile.maxTracked + (trusted ? this.profile.maxTrusted : 0);
      if (this.ips.size >= room) return this.refuse("too many addresses");
      e = { handshaking: 0, open: 0, recent: [], failures: [], bannedUntil: 0 };
      this.ips.set(src, e);
    }
    if (e.bannedUntil > now) return this.refuse("banned");
    e.recent = e.recent.filter((t) => now - t < 1000);
    if (e.recent.length >= this.profile.perIpPerSecond) return this.refuse("too fast");
    e.recent.push(now); // a connection attempt counts toward the rate even if refused below
    const slots = this.profile.maxConnections - (trusted ? 0 : this.profile.reservedConnections);
    if (this.open >= slots) return this.refuse("full");
    if (e.handshaking >= this.profile.perIpHandshakes) return this.refuse("too many handshakes");
    const cap = this.profile.untrustedPerSecond;
    if (cap !== undefined && !trusted) {
      this.untrustedStarts = this.untrustedStarts.filter((t) => now - t < 1000);
      if (this.untrustedStarts.length >= cap) return this.refuse("busy");
      this.untrustedStarts.push(now);
    }
    e.handshaking++;
    e.open++;
    this.open++;
    return { ok: true };
  }

  /** The handshake of an admitted connection ended: `ok` only once the peer's pin checked. */
  handshakeDone(ip: string, ok: boolean, now: number): void {
    const src = sourceOf(ip);
    const e = this.ips.get(src);
    if (!e) return;
    e.handshaking = Math.max(0, e.handshaking - 1);
    if (ok) {
      this.trust(src, now);
      return;
    }
    e.failures = e.failures.filter((t) => now - t < this.profile.failWindowMs);
    e.failures.push(now);
    if (e.failures.length >= this.profile.failuresToBan) {
      e.bannedUntil = now + (this.isTrusted(src, now) ? this.profile.trustedBanMs : this.profile.banMs);
      e.failures = [];
      this.bans++;
    }
  }

  /** An admitted connection closed. */
  closed(ip: string): void {
    const e = this.ips.get(sourceOf(ip));
    if (!e || e.open === 0) return;
    e.open--;
    this.open = Math.max(0, this.open - 1);
  }

  isBanned(ip: string, now: number): boolean {
    return (this.ips.get(sourceOf(ip))?.bannedUntil ?? 0) > now;
  }

  counts(now: number): AdmissionCounts {
    let banned = 0;
    for (const e of this.ips.values()) if (e.bannedUntil > now) banned++;
    return { open: this.open, tracked: this.ips.size, banned, refused: { ...this.refused }, bans: this.bans };
  }

  /** Forget sources with nothing open, no ban and no recent history. */
  sweep(now: number): void {
    for (const [src, e] of this.ips) if (this.idle(e, now) && this.quiet(e, now)) this.ips.delete(src);
  }

  private idle(e: Entry, now: number): boolean {
    return e.open === 0 && e.handshaking === 0 && e.bannedUntil <= now;
  }

  private quiet(e: Entry, now: number): boolean {
    return e.recent.every((t) => now - t >= 1000) && e.failures.every((t) => now - t >= this.profile.failWindowMs);
  }

  /** The table is full: sweep, and if that freed nothing, forget the least recently seen idle
      source (failures only, no ban), so a flood of fresh sources never locks new ones out. */
  private makeRoom(now: number): void {
    this.sweep(now);
    if (this.ips.size < this.profile.maxTracked) return;
    for (const [src, e] of this.ips) {
      if (!this.idle(e, now)) continue;
      this.ips.delete(src);
      return;
    }
  }

  private isTrusted(src: string, now: number): boolean {
    const at = this.trusted.get(src);
    if (at === undefined) return false;
    if (now - at < this.profile.trustMs) return true;
    this.trusted.delete(src);
    return false;
  }

  private trust(src: string, now: number): void {
    this.trusted.delete(src);
    this.trusted.set(src, now);
    while (this.trusted.size > this.profile.maxTrusted) this.trusted.delete(this.trusted.keys().next().value!);
  }

  private refuse(why: Refusal): { ok: false; why: Refusal } {
    this.refused[why]++;
    return { ok: false, why };
  }
}
