// A relay's live connections from LAN hosts (§mesh.lan/relay-sessions): at most one per host. A
// newer authenticated connection replaces the older, and replacements in quick succession mean two
// machines hold one host's key, so the host is flagged as possibly cloned. Pure apart from calling
// `close()` on what it drops; the clock is passed in. Logs name a host by its label only.

export interface Closable {
  close(): void;
}

export interface SessionEvents {
  replaced?: (hostId: string, label: string) => void;
  cloneSuspected?: (hostId: string, label: string) => void;
}

/** Replacements within FLAP_WINDOW_MS that flag a host. */
export const FLAP_COUNT = 3;
export const FLAP_WINDOW_MS = 60_000;
export const CLONE_FLAG_MS = 10 * 60_000;

interface Held<T> {
  label: string;
  session: T;
  since: number;
}

export class RelaySessions<T extends Closable> {
  private readonly held = new Map<string, Held<T>>();
  private readonly flags = new Map<string, { label: string; until: number; replacements: number[] }>();

  constructor(private readonly events: SessionEvents = {}) {}

  /** `session` is now host `hostId`'s live connection; an older one is closed. */
  admit(hostId: string, label: string, session: T, now: number): { replaced: boolean } {
    const old = this.held.get(hostId);
    const f = this.flags.get(hostId) ?? { label, until: 0, replacements: [] };
    let replaced = false;
    if (old && old.session !== session) {
      replaced = true;
      old.session.close();
      f.replacements = f.replacements.filter((t) => now - t < FLAP_WINDOW_MS);
      f.replacements.push(now);
      this.events.replaced?.(hostId, label);
      if (f.replacements.length >= FLAP_COUNT) {
        const fresh = f.until <= now;
        f.until = now + CLONE_FLAG_MS; // still flapping: the flag runs on from now
        if (fresh) this.events.cloneSuspected?.(hostId, label);
      }
    }
    f.label = label;
    this.flags.set(hostId, f);
    this.held.set(hostId, { label, session, since: now });
    return { replaced };
  }

  /** The connection ended on its own: forget it, unless a newer one already replaced it. */
  ended(hostId: string, session: T): void {
    if (this.held.get(hostId)?.session === session) this.held.delete(hostId);
  }

  /** The host was unpaired: close its connection at once and forget it. */
  drop(hostId: string): void {
    this.held.get(hostId)?.session.close();
    this.held.delete(hostId);
    this.flags.delete(hostId);
  }

  /** Keep only these hosts; close the rest (the pairing list changed). */
  keepOnly(hostIds: Iterable<string>): void {
    const keep = new Set(hostIds);
    for (const id of [...this.held.keys(), ...this.flags.keys()]) if (!keep.has(id)) this.drop(id);
  }

  get(hostId: string): T | null {
    return this.held.get(hostId)?.session ?? null;
  }

  status(hostId: string, now: number): { connected: boolean; since: number | null; cloneSuspected: boolean } {
    const h = this.held.get(hostId);
    const f = this.flags.get(hostId);
    return { connected: !!h, since: h?.since ?? null, cloneSuspected: (f?.until ?? 0) > now };
  }

  closeAll(): void {
    for (const id of [...this.held.keys()]) this.drop(id);
  }
}
