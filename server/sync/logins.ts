import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  admissible,
  advertisable,
  clockSkewed,
  entryKey,
  isKeyRecord,
  isLive,
  laterTombstone,
  parseEntryKey,
  plan,
  preSyncConflict,
  resolve,
  type EntryKey,
  type EntryMeta,
  type KeyRecord,
  type Records,
  type RejectReason,
  type StoreId,
  type Tombstone,
} from "./logins-merge";
import {
  classifyClaudeEntry,
  classifyPiEntry,
  fingerprint,
  writeFileAtomic,
  type CredentialStore,
  type StoreChanges,
  type StoreEntry,
  type StoreSnapshot,
} from "./logins-stores";

/**
 * Login sync for one host: keeps a sidecar of per-entry metadata (stamps and fingerprints, never
 * secrets) beside the consumers' own stores, watches those stores, and exchanges entries with
 * peers through whatever `SyncPeer` transport the mesh provides.
 *
 * Nothing here starts on its own: constructing the service reads nothing, and only `start()`
 * creates watchers and timers. The mesh calls `start()` only while peers are configured, so a
 * host with no peer never runs any of this and never writes a store.
 */

/** GET manifest reply. `now` is the sender's clock, for the skew guard. */
export interface CredentialManifest {
  hostId: string;
  now: number;
  entries: Records;
}

/** POST push body: records (tombstones travel alone), with the secret for each live entry. */
export interface CredentialPush {
  hostId: string;
  now: number;
  entries: Record<EntryKey, { record: KeyRecord; secret?: Record<string, unknown> }>;
}

export interface CredentialPushReply {
  accepted: EntryKey[];
  rejected: { key: EntryKey; reason: RejectReason }[];
}

/** GET entry reply: the secret-bearing object of one advertisable entry. */
export interface CredentialEntryReply {
  record: KeyRecord;
  secret: Record<string, unknown>;
}

/** The transport to one peer (the mesh's authenticated peer channel). */
export interface SyncPeer {
  readonly id: string;
  manifest(): Promise<CredentialManifest>;
  entry(key: EntryKey): Promise<CredentialEntryReply>;
  push(body: CredentialPush): Promise<CredentialPushReply>;
}

export type PeerSyncState = { state: "ok" | "clock-skew" | "error"; at: number; error?: string };

/** One key as the Mesh page may show it: no secret, no full fingerprint. */
export interface CredentialStatusEntry {
  key: EntryKey;
  store: StoreId;
  provider: string;
  kind?: "oauth" | "api_key";
  state: "live" | "expired" | "dead" | "logged-out";
  expires?: number;
  origin?: string;
  loginAt?: number;
  issuedAt?: number;
  fingerprint?: string;
  tombstone?: Tombstone;
  /** Peers holding a different pre-sync login for this key: nothing is synced until one is claimed. */
  conflictWith?: string[];
}

export type Refresher = (provider: string, minValidityMs: number) => Promise<void>;

export interface CredentialSyncOptions {
  hostId: string;
  stores: readonly CredentialStore[];
  /** The sidecar manifest (0600). */
  sidecarPath: string;
  /** The peers to talk to right now (the online members of peers.json). */
  peers?: () => readonly SyncPeer[];
  now?: () => number;
  log?: (message: string) => void;
  /** c-lite: make the consumer refresh one provider now, through its own lock and rotation. */
  refreshers?: Partial<Record<StoreId, Refresher>>;
  /** H8: whether deleting pi's whole `auth.json` by hand is a logout of every pi entry. */
  treatPiFileDeleteAsLogout?: boolean;
  /** Called after any local change of the records (for the UI's live status). */
  onChange?: () => void;
  /** Debounce for store change events, ms. */
  debounceMs?: number;
  /** The user's "logins" sync switch. Off: nothing is observed, offered, taken or refreshed. */
  enabled?: () => boolean;
}

const SIDECAR_VERSION = 1;
/** A fingerprint change this soon after we asked the consumer to refresh is that refresh. */
const REFRESH_EXPECT_MS = 60_000;
/** c-lite never refreshes the same key again sooner than this, whatever the lifetimes say. */
const MIN_REFRESH_SPACING_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class CredentialSync {
  private records: Records = {};
  private readonly stores = new Map<StoreId, CredentialStore>();
  private readonly storeState = new Map<StoreId, StoreSnapshot["state"]>();
  private readonly queues = new Map<StoreId, Promise<unknown>>();
  private readonly expectRefresh = new Map<EntryKey, number>();
  private readonly lastRefreshAt = new Map<EntryKey, number>();
  private readonly refreshTimers = new Map<EntryKey, NodeJS.Timeout>();
  private readonly debounce = new Map<StoreId, NodeJS.Timeout>();
  private readonly peerState = new Map<string, PeerSyncState>();
  /** Keys where a peer holds a different pre-sync login than ours (the user must pick). */
  private readonly conflicts: Record<EntryKey, Set<string>> = {};
  private watchers: FSWatcher[] = [];
  private started = false;
  private loaded = false;
  /** No sidecar existed at start: entries found by the first scan predate sync (loginAt 0). */
  private firstRun = false;
  private initialScan = false;
  private syncTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: CredentialSyncOptions) {
    for (const s of opts.stores) this.stores.set(s.id, s);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[login-sync] ${m}`));
  }

  get hostId(): string {
    return this.opts.hostId;
  }

  private get enabled(): boolean {
    return this.opts.enabled?.() ?? true;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load the sidecar, observe every store once, then watch them and arm c-lite. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loadSidecar();
    this.initialScan = true;
    try {
      for (const id of this.stores.keys()) await this.observe(id).catch((e) => this.log(`observe ${id}: ${errText(e)}`));
    } finally {
      this.initialScan = false;
    }
    if (!this.started) return; // stopped meanwhile
    for (const store of this.stores.values()) this.watchStore(store);
    this.armRefreshTimers();
  }

  /** Drop every watcher and timer. Stores and sidecar stay as they are. */
  stop(): void {
    this.started = false;
    for (const w of this.watchers.splice(0)) w.close();
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  /** Coalesce "something changed, reconcile with the peers" requests. */
  private scheduleSync(): void {
    if (!this.started || this.syncTimer || !this.enabled) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncAll().catch((e) => this.log(`sync: ${errText(e)}`));
    }, this.opts.debounceMs ?? 500);
    this.syncTimer.unref?.();
  }

  private watchStore(store: CredentialStore): void {
    const name = basename(store.path);
    try {
      // The directory, not the file: pi rewrites in place, Claude Code too, we rename; a watch on
      // the file itself would follow the old inode after the first rename.
      const w = watch(dirname(store.path), { persistent: false }, (_event, file) => {
        if (file !== null && file !== name) return;
        this.scheduleObserve(store.id);
      });
      w.on("error", (e) => this.log(`watch ${store.id}: ${errText(e)}`));
      this.watchers.push(w);
    } catch (e) {
      this.log(`watch ${store.id} unavailable: ${errText(e)}`);
    }
  }

  private scheduleObserve(id: StoreId): void {
    if (!this.started || !this.enabled) return;
    clearTimeout(this.debounce.get(id));
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        void this.observe(id).catch((e) => this.log(`observe ${id}: ${errText(e)}`));
      }, this.opts.debounceMs ?? 500),
    );
  }

  // ---------------------------------------------------------------- sidecar

  private loadSidecar(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.firstRun = true;
    try {
      const raw = JSON.parse(readFileSync(this.opts.sidecarPath, "utf8")) as { version?: unknown; records?: unknown };
      this.firstRun = false;
      if (raw.version !== SIDECAR_VERSION || !raw.records || typeof raw.records !== "object") return;
      for (const [key, rec] of Object.entries(raw.records as Record<string, unknown>)) {
        if (parseEntryKey(key) && isKeyRecord(rec)) this.records[key] = rec;
      }
    } catch {
      // Missing or unreadable: every entry is observed afresh (loginAt 0: predates sync).
    }
  }

  private saveSidecar(): void {
    writeFileAtomic(this.opts.sidecarPath, `${JSON.stringify({ version: SIDECAR_VERSION, records: this.records }, null, 2)}\n`);
  }

  private setRecord(key: EntryKey, rec: KeyRecord): boolean {
    const prev = this.records[key];
    if (JSON.stringify(prev ?? {}) === JSON.stringify(rec)) return false;
    if (!rec.meta && !rec.tombstone) delete this.records[key];
    else this.records[key] = rec;
    return true;
  }

  // ---------------------------------------------------------------- local stores

  /** Serialize every operation on one store in this process (the file lock orders processes). */
  private withStore<T>(id: StoreId, fn: (store: CredentialStore) => Promise<T>): Promise<T> {
    const store = this.stores.get(id);
    if (!store) return Promise.reject(new Error(`no ${id} store on this host`));
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn(store));
    this.queues.set(id, next);
    return next;
  }

  /**
   * Fold what the store holds now into the records (called under its lock by every operation, so
   * a decision is always made against the file as it is). A new fingerprint is stamped here: a
   * refresh when it continues a lineage the consumer was due to refresh, a login otherwise.
   * Returns the keys whose change should be pushed, and whether a pull is due (a dead marker).
   */
  private reconcile(store: CredentialStore, snap: StoreSnapshot): { pushed: EntryKey[]; pull: boolean; dirty: boolean } {
    const out = { pushed: [] as EntryKey[], pull: false, dirty: false };
    this.storeState.set(store.id, snap.state);
    if (snap.state === "invalid" || snap.state === "refused") return out;
    const now = this.now();
    const prefix = `${store.id}:`;
    for (const [provider, entry] of snap.entries) {
      const key = entryKey(store.id, provider);
      const rec = this.records[key] ?? {};
      if (rec.meta?.fingerprint === entry.fingerprint) {
        // Same entry; only its liveness may have changed (a dead marker is found by fingerprint).
        continue;
      }
      const meta = this.stamp(store, key, entry, rec.meta, now);
      out.dirty = this.setRecord(key, { ...rec, meta }) || out.dirty;
      if (meta.dead || !isLive(meta, now)) out.pull = true;
      else if (advertisable({ ...rec, meta }, now)) out.pushed.push(key);
      // else: a refresh of a lineage a known logout rules out; `locked` removes it below.
    }
    for (const key of Object.keys(this.records)) {
      if (!key.startsWith(prefix)) continue;
      const provider = key.slice(prefix.length);
      const rec = this.records[key]!;
      if (!rec.meta || snap.entries.has(provider) || snap.localOnly.has(provider)) continue;
      // The entry is gone and we didn't remove it: a logout when the consumer removed a login
      // (or deleted a file whose deletion is its logout). An expired entry is still a login (pi
      // refreshes it on its next use), so removing it is a logout too; only a dead marker's
      // removal is nothing to tell anyone.
      const fileGone = snap.state === "missing";
      const logout =
        !rec.meta.dead &&
        (!fileGone || store.fileDeleteIsLogout || (store.id === "pi" && !!this.opts.treatPiFileDeleteAsLogout));
      const tombstone = logout ? tombstoneFor(rec.meta, now, this.hostId) : rec.tombstone;
      out.dirty = this.setRecord(key, tombstone ? { tombstone } : {}) || out.dirty;
      if (logout) out.pushed.push(key);
      else out.pull = true;
    }
    return out;
  }

  private stamp(store: CredentialStore, key: EntryKey, entry: StoreEntry, prev: EntryMeta | undefined, now: number): EntryMeta {
    const expected = (this.expectRefresh.get(key) ?? 0) >= now;
    let refresh = false;
    if (prev && !prev.dead && prev.kind === "oauth" && entry.kind === "oauth") {
      const sameAccount = !prev.account || !entry.account || prev.account === entry.account;
      const due = (prev.expires ?? 0) - now <= store.refreshWindowMs;
      refresh = sameAccount && (due || expected);
    }
    if (entry.dead && prev) refresh = true; // a failed refresh is not a login either
    return {
      kind: entry.kind,
      ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
      issuedAt: now,
      loginAt: refresh ? prev!.loginAt : !prev && this.firstRun && this.initialScan ? 0 : now,
      fingerprint: entry.fingerprint,
      origin: this.hostId,
      ...(entry.dead ? { dead: true } : {}),
      ...(entry.account ? { account: entry.account } : {}),
    };
  }

  /**
   * The one way into a store: under its lock, fold the file into the records, let `fn` decide,
   * remove any entry a known tombstone rules out, persist the sidecar BEFORE the store is written
   * (a crash between the two re-stamps the entry on the next read, it never loses a record), then
   * write. Local changes found on the way are pushed whichever operation found them.
   */
  private locked<T>(id: StoreId, fn: (store: CredentialStore, snap: StoreSnapshot, changes: StoreChanges) => T): Promise<T> {
    let dirty = false;
    let found = { pushed: [] as EntryKey[], pull: false };
    return this.withStore(id, (store) =>
      store.transact((snap) => {
        const r = this.reconcile(store, snap);
        found = r;
        const changes: StoreChanges = new Map();
        const before = JSON.stringify(this.records);
        const result = fn(store, snap, changes);
        if (snap.state === "ok" || snap.state === "missing") {
          for (const [provider, entry] of snap.entries) {
            const key = entryKey(id, provider);
            const rec = this.records[key];
            if (changes.has(provider) || !rec?.tombstone || rec.meta?.fingerprint !== entry.fingerprint) continue;
            if (admissible(rec.meta, rec.tombstone)) continue;
            changes.set(provider, null);
            this.setRecord(key, { tombstone: rec.tombstone });
          }
        }
        dirty = r.dirty || JSON.stringify(this.records) !== before;
        if (dirty) this.persist();
        return { result, changes };
      }),
    ).then((result) => {
      if (dirty) this.afterChange();
      if (found.pushed.length || found.pull) this.scheduleSync();
      return result;
    });
  }

  /** Read one store under its lock and fold it into the records; removes tombstoned entries. */
  async observe(id: StoreId): Promise<void> {
    await this.locked(id, () => undefined);
  }

  private persist(): void {
    try {
      this.saveSidecar();
    } catch (e) {
      this.log(`sidecar write failed: ${errText(e)}`);
    }
  }

  private afterChange(): void {
    this.armRefreshTimers();
    this.opts.onChange?.();
  }

  /**
   * Apply one peer record (and its secret, when the peer's entry should win) to the local store,
   * deciding against the store as read under its lock.
   */
  async applyRemote(key: EntryKey, remote: KeyRecord, secret?: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    const parsed = parseEntryKey(key);
    if (!parsed || !this.stores.has(parsed.store)) return { ok: false, reason: "unknown-store" };
    const { store: id, provider } = parsed;
    type Out = { ok: true } | { ok: false; reason: RejectReason };
    return this.locked(id, (_store, snap, changes): Out => {
      if (snap.state === "invalid" || snap.state === "refused") return { ok: false, reason: "invalid" };
      if (snap.localOnly.has(provider)) return { ok: false, reason: "local-only" };
      const local = this.records[key] ?? {};
      const res = resolve(local, remote, this.now());
      if (res.action === "adopt") {
        if (!secret || !verifySecret(id, secret, res.record.meta!)) {
          // Only the tombstone half of the record can still count.
          const tombstone = res.record.tombstone;
          this.setRecord(key, tombstone ? { ...local, tombstone } : local);
          return { ok: false, reason: "invalid" };
        }
        changes.set(provider, secret);
      } else if (res.action === "delete") {
        changes.set(provider, null);
      }
      this.setRecord(key, res.record);
      return res.action === "keep" && res.rejected && remote.meta ? { ok: false, reason: res.rejected } : { ok: true };
    });
  }

  /** "Log out everywhere" for one key: tombstone it here, remove it from the store, tell peers. */
  async logout(key: EntryKey): Promise<void> {
    const parsed = parseEntryKey(key);
    if (!parsed || !this.stores.has(parsed.store)) throw new Error(`unknown credential key ${key}`);
    const tombstone = tombstoneFor(this.records[key]?.meta, this.now(), this.hostId);
    await this.applyRemote(key, { tombstone });
    await this.syncAll();
  }

  /**
   * "Use this host's login everywhere": re-stamp the entry this host holds as a login made now, so
   * it wins over every other host's (the way out of a pre-sync conflict, or any "no, THIS one").
   * The store is not written; only the stamp changes. An idle login (access token expired, not
   * dead) can be claimed too: it is refreshed at once where this host can (pi), else it spreads on
   * its consumer's next refresh. False when there is nothing (or only a dead marker) to claim.
   */
  async claim(key: EntryKey): Promise<boolean> {
    const parsed = parseEntryKey(key);
    if (!parsed || !this.stores.has(parsed.store)) return false;
    const claimed = await this.locked(parsed.store, (_store, snap) => {
      const rec = this.records[key];
      const entry = snap.entries.get(parsed.provider);
      const now = this.now();
      if (!rec?.meta || !entry || entry.fingerprint !== rec.meta.fingerprint || rec.meta.dead) return false;
      this.setRecord(key, { ...rec, meta: { ...rec.meta, loginAt: now, issuedAt: now, origin: this.hostId } });
      return true;
    });
    if (claimed) {
      delete this.conflicts[key];
      const meta = this.records[key]?.meta;
      if (meta && !isLive(meta, this.now())) await this.refreshNow(key);
      await this.syncAll();
    }
    return claimed;
  }

  // ---------------------------------------------------------------- peer-facing (server side)

  manifest(): CredentialManifest {
    return { hostId: this.hostId, now: this.now(), entries: this.recordsView(advertisable) };
  }

  /**
   * The records a peer may know of (tombstones always; an entry per `include`) in stores this host
   * advertises. The manifest offers live entries only; planning also counts an idle one (rule 2).
   */
  private recordsView(include: (rec: KeyRecord, now: number) => boolean): Records {
    const entries: Records = {};
    const now = this.now();
    if (!this.enabled) return entries;
    for (const [key, rec] of Object.entries(this.records)) {
      const store = parseEntryKey(key)?.store;
      if (!store || !this.advertisesStore(store)) continue;
      const meta = include(rec, now) ? rec.meta : undefined;
      if (meta || rec.tombstone) entries[key] = { ...(meta ? { meta } : {}), ...(rec.tombstone ? { tombstone: rec.tombstone } : {}) };
    }
    return entries;
  }

  private advertisesStore(id: StoreId): boolean {
    const st = this.storeState.get(id);
    return this.stores.has(id) && st !== "refused" && st !== "invalid";
  }

  /** The secret for one advertised key, read under the lock; refused if it moved since the manifest. */
  async entry(key: EntryKey): Promise<CredentialEntryReply | null> {
    const parsed = parseEntryKey(key);
    if (!parsed || !this.stores.has(parsed.store) || !this.enabled) return null;
    return this.locked(parsed.store, (_store, snap) => {
      const rec = this.records[key];
      const entry = snap.entries.get(parsed.provider);
      if (!rec || !entry || !advertisable(rec, this.now()) || rec.meta!.fingerprint !== entry.fingerprint) return null;
      return { record: structuredClone(rec), secret: entry.value };
    });
  }

  /** A peer pushed records (and secrets). `from` is the caller identity the mesh verified. */
  async receivePush(from: string, body: unknown): Promise<CredentialPushReply> {
    const reply: CredentialPushReply = { accepted: [], rejected: [] };
    const b = body as Partial<CredentialPush> | null;
    if (!b || typeof b !== "object" || typeof b.now !== "number" || !b.entries || typeof b.entries !== "object") {
      return reply;
    }
    const skewed = clockSkewed(b.now, this.now());
    if (skewed) this.peerState.set(from, { state: "clock-skew", at: this.now() });
    const enabled = this.enabled;
    for (const [key, item] of Object.entries(b.entries as Record<string, unknown>)) {
      const it = item as { record?: unknown; secret?: unknown } | null;
      if (!enabled || skewed) {
        reply.rejected.push({ key, reason: enabled ? "clock-skew" : "disabled" });
        continue;
      }
      if (!it || !isKeyRecord(it.record)) {
        reply.rejected.push({ key, reason: "invalid" });
        continue;
      }
      const secret = it.secret && typeof it.secret === "object" && !Array.isArray(it.secret) ? (it.secret as Record<string, unknown>) : undefined;
      const res = await this.applyRemote(key, it.record, secret).catch((e) => {
        this.log(`push ${key} from ${from}: ${errText(e)}`);
        return { ok: false as const, reason: "invalid" as const };
      });
      if (res.ok) reply.accepted.push(key);
      else reply.rejected.push({ key, reason: res.reason });
      this.noteConflict(key, from, !res.ok && res.reason === "conflict");
    }
    return reply;
  }

  // ---------------------------------------------------------------- peer-facing (client side)

  /**
   * Reconcile with one peer both ways: pull what beats ours, push what beats theirs, send our
   * newer tombstones. Refuses to merge at all across a clock skew (every stamp is a wall time).
   */
  async syncWith(peer: SyncPeer): Promise<PeerSyncState> {
    let state: PeerSyncState;
    if (!this.enabled) return { state: "ok", at: this.now() };
    try {
      const remote = await peer.manifest();
      const now = this.now();
      if (clockSkewed(remote.now, now)) {
        state = { state: "clock-skew", at: now };
      } else {
        const theirs: Records = {};
        for (const [k, rec] of Object.entries(remote.entries ?? {})) {
          const p = parseEntryKey(k);
          if (p && this.stores.has(p.store) && isKeyRecord(rec)) theirs[k] = rec;
        }
        // What this host holds, an idle (expired, not dead) login included: it is compared, not
        // replaced by any live peer entry, and never re-pulled round after round.
        const mine = this.recordsView(held);
        // Conflicts to tell the peer about: it may not exchange with this host again for minutes.
        const notices: EntryKey[] = [];
        for (const key of new Set([...Object.keys(mine), ...Object.keys(this.conflicts)])) {
          const m = mine[key]?.meta;
          const t = theirs[key]?.meta;
          const conflict = !!m && !!t && isLive(t, now) && preSyncConflict(m, t);
          this.noteConflict(key, peer.id, conflict);
          if (conflict && isLive(m!, now)) notices.push(key);
        }
        const todo = plan(mine, theirs, now);
        for (const key of todo.pull) {
          const got = await peer.entry(key).catch(() => null);
          if (got && isKeyRecord(got.record)) await this.applyRemote(key, got.record, got.secret);
        }
        for (const key of todo.delete) await this.applyRemote(key, theirs[key]!);
        // Tombstones we learnt from the peer but held no entry for still belong in our records.
        for (const [key, rec] of Object.entries(theirs)) {
          const mineTomb = this.records[key]?.tombstone;
          if (!rec.tombstone || todo.pull.includes(key) || todo.delete.includes(key)) continue;
          if (laterTombstone(mineTomb, rec.tombstone) === mineTomb) continue;
          await this.applyRemote(key, { tombstone: rec.tombstone });
        }
        const pushKeys = [...new Set([...todo.push, ...todo.tombstones])];
        if (pushKeys.length || notices.length) {
          const body: CredentialPush = { hostId: this.hostId, now: this.now(), entries: {} };
          for (const key of pushKeys) {
            const rec = this.records[key];
            if (!rec) continue;
            if (todo.push.includes(key)) {
              const got = await this.entry(key);
              if (got) body.entries[key] = got;
            } else if (rec.tombstone) {
              body.entries[key] = { record: { tombstone: rec.tombstone } };
            }
          }
          // A notice is the metadata alone, never the secret: the peer only notes the conflict.
          for (const key of notices) body.entries[key] ??= { record: { meta: mine[key]!.meta! } };
          if (Object.keys(body.entries).length) {
            const reply = await peer.push(body);
            for (const r of reply.rejected ?? []) if (r.reason !== "conflict") this.log(`${peer.id} rejected ${r.key}: ${r.reason}`);
          }
        }
        state = { state: "ok", at: this.now() };
      }
    } catch (e) {
      state = { state: "error", at: this.now(), error: errText(e) };
    }
    this.peerState.set(peer.id, state);
    return state;
  }

  /** Reconcile with every current peer (on hello, reconnect, and after a local change). */
  async syncAll(): Promise<void> {
    if (!this.enabled) return;
    const peers = this.opts.peers?.() ?? [];
    await Promise.all(peers.map((p) => this.syncWith(p)));
  }

  private noteConflict(key: EntryKey, peer: string, on: boolean): void {
    const set = this.conflicts[key];
    if (on) (this.conflicts[key] ??= new Set()).add(peer);
    else if (set) {
      set.delete(peer);
      if (!set.size) delete this.conflicts[key];
    }
  }

  // ---------------------------------------------------------------- c-lite

  /**
   * The host that last refreshed (or logged in) an oauth entry refreshes it early, at half its
   * access token's life, so the other hosts never reach their consumer's own refresh window and
   * never race it. Nobody else does anything special; the timer moves with `origin`.
   */
  private armRefreshTimers(): void {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    if (!this.started || !this.enabled) return;
    const now = this.now();
    for (const [key, rec] of Object.entries(this.records)) {
      const m = rec.meta;
      const p = parseEntryKey(key);
      if (!m || !p || m.kind !== "oauth" || m.origin !== this.hostId || !isLive(m, now) || !advertisable(rec, now)) continue;
      if (!this.opts.refreshers?.[p.store]) continue;
      const life = (m.expires ?? 0) - m.issuedAt;
      const at = Math.max(m.issuedAt + life / 2, (this.lastRefreshAt.get(key) ?? 0) + MIN_REFRESH_SPACING_MS);
      // setTimeout overflows past 2^31-1 ms (~24.8 days) and would fire at once: wait in steps.
      const delay = Math.max(0, at - now);
      const t = delay > MAX_TIMER_MS ? setTimeout(() => this.armRefreshTimers(), MAX_TIMER_MS) : setTimeout(() => void this.refreshNow(key), delay);
      t.unref?.();
      this.refreshTimers.set(key, t);
    }
  }

  /** Ask the consumer to refresh one key now (c-lite, or the harness's `refresh <host>`). */
  async refreshNow(key: EntryKey): Promise<void> {
    const p = parseEntryKey(key);
    const refresher = p && this.opts.refreshers?.[p.store];
    const m = this.records[key]?.meta;
    if (!p || !refresher || !m) return;
    const now = this.now();
    this.lastRefreshAt.set(key, now);
    this.expectRefresh.set(key, now + REFRESH_EXPECT_MS);
    try {
      // Just more than the time left: the consumer's own expiry check says "refresh now", and any
      // fresh token (a full lifetime) satisfies it, so pi does not reject what it just stored.
      await refresher(p.provider, Math.max(0, (m.expires ?? now) - now) + 1_000);
    } catch (e) {
      this.log(`refresh ${key} failed: ${errText(e)}`);
    }
    await this.observe(p.store).catch((e) => this.log(`observe ${p.store}: ${errText(e)}`));
    this.armRefreshTimers();
  }

  // ---------------------------------------------------------------- status

  status(): { hostId: string; entries: CredentialStatusEntry[]; peers: Record<string, PeerSyncState> } {
    const now = this.now();
    const entries: CredentialStatusEntry[] = [];
    for (const [key, rec] of Object.entries(this.records)) {
      const p = parseEntryKey(key);
      if (!p) continue;
      const m = rec.meta;
      entries.push({
        key,
        store: p.store,
        provider: p.provider,
        ...(m
          ? {
              kind: m.kind,
              ...(m.expires !== undefined ? { expires: m.expires } : {}),
              origin: m.origin,
              loginAt: m.loginAt,
              issuedAt: m.issuedAt,
              fingerprint: m.fingerprint.slice(0, 19),
            }
          : {}),
        state: !m ? "logged-out" : m.dead ? "dead" : isLive(m, now) ? "live" : "expired",
        ...(rec.tombstone ? { tombstone: rec.tombstone } : {}),
        ...(this.conflicts[key] ? { conflictWith: [...this.conflicts[key]].sort() } : {}),
      });
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return { hostId: this.hostId, entries, peers: Object.fromEntries(this.peerState) };
  }

  /** Test/harness view of the raw records (metadata only). */
  recordsSnapshot(): Records {
    return structuredClone(this.records);
  }
}

/** A login this host still holds: admissible and not dead, live or idle (access token expired). */
const held = (rec: KeyRecord): boolean => !!rec.meta && !rec.meta.dead && admissible(rec.meta, rec.tombstone);

/** A peer's secret must be exactly the entry its meta describes, and a live one. */
function verifySecret(store: StoreId, secret: Record<string, unknown>, meta: EntryMeta): boolean {
  const entry = store === "pi" ? classifyPiEntry(secret) : classifyClaudeEntry(secret);
  if (!entry || entry.dead || entry.kind !== meta.kind) return false;
  if (fingerprint(secret) !== meta.fingerprint) return false;
  return meta.kind !== "oauth" || entry.expires === meta.expires;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A logout's tombstone, naming what was logged out (a different pre-sync login survives it). */
function tombstoneFor(meta: EntryMeta | undefined, at: number, by: string): Tombstone {
  return meta ? { at, by, of: { fingerprint: meta.fingerprint, ...(meta.account ? { account: meta.account } : {}) } } : { at, by };
}
