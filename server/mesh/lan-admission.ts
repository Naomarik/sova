// Pre-handshake admission for a relay's listener (§mesh.lan/relay-listener). Pure: the clock is
// passed in, nothing here touches a socket. It keeps counts per source address and never anything
// a connection carried.

export interface AdmissionProfile {
  /** Handshakes in progress from one address. */
  perIpHandshakes: number;
  /** New connections from one address in any 1 s window. */
  perIpPerSecond: number;
  /** Failed handshakes within `failWindowMs` that ban the address. */
  failuresToBan: number;
  failWindowMs: number;
  banMs: number;
  /** Connections open at once, all addresses. */
  maxConnections: number;
  /** Addresses tracked at once; past it an unknown address is refused until entries expire. */
  maxTracked: number;
}

const BASE = { perIpHandshakes: 4, perIpPerSecond: 10, failuresToBan: 5, failWindowMs: 60_000, maxConnections: 64, maxTracked: 4096 };
export const LAN_PROFILE: AdmissionProfile = { ...BASE, banMs: 5 * 60_000 };
// No internet profile: a relay on the internet waits for the separate accept process (§mesh.lan/pairing).

export type Refusal = "banned" | "too many handshakes" | "too fast" | "full" | "too many addresses";

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

export class Admission {
  private readonly ips = new Map<string, Entry>();
  private open = 0;
  private bans = 0;
  private readonly refused: Record<Refusal, number> = { banned: 0, "too many handshakes": 0, "too fast": 0, full: 0, "too many addresses": 0 };

  constructor(private readonly profile: AdmissionProfile) {}

  /** A new TCP connection from `ip`. On ok, the caller must later call `handshakeDone` and `closed`. */
  admit(ip: string, now: number): { ok: true } | { ok: false; why: Refusal } {
    let e = this.ips.get(ip);
    if (!e) {
      if (this.ips.size >= this.profile.maxTracked) this.sweep(now);
      if (this.ips.size >= this.profile.maxTracked) return this.refuse("too many addresses");
      e = { handshaking: 0, open: 0, recent: [], failures: [], bannedUntil: 0 };
      this.ips.set(ip, e);
    }
    if (e.bannedUntil > now) return this.refuse("banned");
    e.recent = e.recent.filter((t) => now - t < 1000);
    if (e.recent.length >= this.profile.perIpPerSecond) return this.refuse("too fast");
    e.recent.push(now); // a connection attempt counts toward the rate even if refused below
    if (this.open >= this.profile.maxConnections) return this.refuse("full");
    if (e.handshaking >= this.profile.perIpHandshakes) return this.refuse("too many handshakes");
    e.handshaking++;
    e.open++;
    this.open++;
    return { ok: true };
  }

  /** The handshake of an admitted connection ended: `ok` only once the peer's pin checked. */
  handshakeDone(ip: string, ok: boolean, now: number): void {
    const e = this.ips.get(ip);
    if (!e) return;
    e.handshaking = Math.max(0, e.handshaking - 1);
    if (ok) return;
    e.failures = e.failures.filter((t) => now - t < this.profile.failWindowMs);
    e.failures.push(now);
    if (e.failures.length >= this.profile.failuresToBan) {
      e.bannedUntil = now + this.profile.banMs;
      e.failures = [];
      this.bans++;
    }
  }

  /** An admitted connection closed. */
  closed(ip: string): void {
    const e = this.ips.get(ip);
    if (!e || e.open === 0) return;
    e.open--;
    this.open = Math.max(0, this.open - 1);
  }

  isBanned(ip: string, now: number): boolean {
    return (this.ips.get(ip)?.bannedUntil ?? 0) > now;
  }

  counts(now: number): AdmissionCounts {
    let banned = 0;
    for (const e of this.ips.values()) if (e.bannedUntil > now) banned++;
    return { open: this.open, tracked: this.ips.size, banned, refused: { ...this.refused }, bans: this.bans };
  }

  /** Forget addresses with nothing open, no ban and no recent history. */
  sweep(now: number): void {
    for (const [ip, e] of this.ips) {
      const quiet = e.open === 0 && e.handshaking === 0 && e.bannedUntil <= now
        && e.recent.every((t) => now - t >= 1000) && e.failures.every((t) => now - t >= this.profile.failWindowMs);
      if (quiet) this.ips.delete(ip);
    }
  }

  private refuse(why: Refusal): { ok: false; why: Refusal } {
    this.refused[why]++;
    return { ok: false, why };
  }
}
