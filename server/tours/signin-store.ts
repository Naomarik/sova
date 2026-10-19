import { inspect } from "node:util";
import type { TourCredentials } from "../../shared/tour";
import type { TourStorageState } from "./runner-protocol";

/** One hour from the first entry, never extended (§app.tours/recording). */
export const TOUR_SIGN_IN_TTL_MS = 60 * 60_000;
const STORAGE_CAP = 256 * 1024;
type Login = { account?: string; username: string; password: string };
export interface TourSignInTimers { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: TourSignInTimers = {
  now: () => Date.now(),
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One tour's sign-in state. Values live only in private fields; every printed form is a redaction. */
class Entry {
  readonly #logins = new Map<string, Login>();
  readonly #codes = new Map<string, string>();
  #storage: { origins: string[]; state: TourStorageState } | undefined;
  constructor(readonly expiresAt: number, readonly timer: unknown) {}
  setLogin(origin: string, login: Login): void { this.#logins.set(origin, { ...(login.account !== undefined ? { account: login.account } : {}), username: login.username, password: login.password }); }
  login(origin: string): Login | undefined { const l = this.#logins.get(origin); return l ? { ...l } : undefined; }
  forget(origin: string): void { this.#logins.delete(origin); this.#codes.delete(origin); }
  forgetStorage(): void { this.#storage = undefined; }
  setCode(origin: string, code: string): void { this.#codes.set(origin, code); }
  takeCode(origin: string): string | undefined { const c = this.#codes.get(origin); this.#codes.delete(origin); return c; }
  setStorage(origins: string[], state: TourStorageState): void { this.#storage = { origins: [...origins], state: structuredClone(state) }; }
  storage(): TourStorageState | undefined { return this.#storage ? structuredClone(this.#storage.state) : undefined; }
  wipe(): void { this.#logins.clear(); this.#codes.clear(); this.#storage = undefined; }
  toJSON(): string { return "[sign-in hidden]"; }
  [inspect.custom](): string { return "[sign-in hidden]"; }
}

/**
 * The per-tour sign-in memory (BRIEF q3/q4): logins per origin, a one-time code supplied with
 * credentials (held until the first code prompt), and the signed-in storage state of the sign-in
 * origins. Memory only, keyed by chat and tour, cleared after one hour from its first entry.
 */
export class TourSignInStore {
  readonly #entries = new Map<string, Entry>();
  readonly #timers: TourSignInTimers;
  readonly #ttl: number;
  readonly #expired = new Set<(sessionId: string, tourId: string) => void>();
  constructor(options: { timers?: TourSignInTimers; ttlMs?: number } = {}) {
    this.#timers = options.timers ?? realTimers; this.#ttl = options.ttlMs ?? TOUR_SIGN_IN_TTL_MS;
  }
  /** Called when a tour's hour is up, after its entry is gone: a recording still using it must stop. */
  onExpire(listener: (sessionId: string, tourId: string) => void): () => void { this.#expired.add(listener); return () => { this.#expired.delete(listener); }; }
  #key(sessionId: string, tourId: string): string { return `${sessionId}\u0000${tourId}`; }
  #entry(sessionId: string, tourId: string, create: boolean): Entry | undefined {
    const key = this.#key(sessionId, tourId);
    const found = this.#entries.get(key);
    if (found && this.#timers.now() >= found.expiresAt) { this.#expire(sessionId, tourId); return create ? this.#entry(sessionId, tourId, true) : undefined; }
    if (found || !create) return found;
    const timer = this.#timers.set(() => this.#expire(sessionId, tourId), this.#ttl);
    const entry = new Entry(this.#timers.now() + this.#ttl, timer);
    this.#entries.set(key, entry);
    return entry;
  }
  #expire(sessionId: string, tourId: string): void {
    if (!this.#entries.has(this.#key(sessionId, tourId))) return;
    this.clear(sessionId, tourId);
    for (const listener of this.#expired) { try { listener(sessionId, tourId); } catch { /* one stop failing cannot keep another running */ } }
  }
  setCredentials(sessionId: string, tourId: string, credentials: TourCredentials): void {
    const entry = this.#entry(sessionId, tourId, true)!;
    for (const [origin, c] of Object.entries(credentials)) {
      entry.setLogin(origin, { ...(c.account !== undefined ? { account: c.account } : {}), username: c.username, password: c.password });
      if (c.code !== undefined) entry.setCode(origin, c.code);
    }
  }
  setLogin(sessionId: string, tourId: string, origin: string, login: Login): void { this.#entry(sessionId, tourId, true)!.setLogin(origin, login); }
  login(sessionId: string, tourId: string, origin: string): Login | undefined { return this.#entry(sessionId, tourId, false)?.login(origin); }
  takeCode(sessionId: string, tourId: string, origin: string): string | undefined { return this.#entry(sessionId, tourId, false)?.takeCode(origin); }
  /** A wrong password: that origin's login goes, the rest stays. */
  forget(sessionId: string, tourId: string, origin: string): void { this.#entry(sessionId, tourId, false)?.forget(origin); }
  /** A held session the site no longer honours: it goes, the logins stay. */
  forgetStorage(sessionId: string, tourId: string): void { this.#entry(sessionId, tourId, false)?.forgetStorage(); }
  /** The signed-in session, only the sign-in origins' cookies and storage, bounded. */
  setStorage(sessionId: string, tourId: string, origins: string[], state: TourStorageState): void {
    const filtered = filterTourStorage(state, origins);
    if (!filtered) return;
    this.#entry(sessionId, tourId, true)!.setStorage(origins, filtered);
  }
  storage(sessionId: string, tourId: string): TourStorageState | undefined { return this.#entry(sessionId, tourId, false)?.storage(); }
  has(sessionId: string, tourId: string): boolean { return !!this.#entry(sessionId, tourId, false); }
  clear(sessionId: string, tourId: string): void {
    const key = this.#key(sessionId, tourId), entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key); this.#timers.clear(entry.timer); entry.wipe();
  }
  clearSession(sessionId: string): void { for (const key of [...this.#entries.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.clear(sessionId, key.slice(sessionId.length + 1)); }
  clearAll(): void { for (const key of [...this.#entries.keys()]) { const [s, t] = key.split("\u0000"); this.clear(s!, t!); } }
  toJSON(): string { return "[sign-ins hidden]"; }
  [inspect.custom](): string { return "[sign-ins hidden]"; }
}

const hostOf = (origin: string): string | null => { try { return new URL(origin).hostname; } catch { return null; } };
/** Cookies whose domain is a sign-in origin's host (or a parent of it) and those origins' storage; null when too large. */
export function filterTourStorage(state: TourStorageState, origins: readonly string[]): TourStorageState | null {
  const hosts = origins.map(hostOf).filter((h): h is string => !!h);
  const matches = (domain: string) => { const d = domain.replace(/^\./, "").toLowerCase(); return hosts.some(h => h === d || h.endsWith(`.${d}`)); };
  const out: TourStorageState = {
    cookies: (Array.isArray(state?.cookies) ? state.cookies : []).filter(c => c && typeof c.domain === "string" && matches(c.domain)),
    origins: (Array.isArray(state?.origins) ? state.origins : []).filter(o => o && origins.includes(o.origin)),
  };
  return Buffer.byteLength(JSON.stringify(out)) <= STORAGE_CAP ? out : null;
}
