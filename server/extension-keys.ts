// Each installed extension's own key (§app.extensions/backend-key, ext-contract-v1.16): how its
// backend calls Sova back, with the power of the token but the credential routes, and recorded as
// `ext:<id>` (server/command-audit.ts).
//
// The plaintext is written once, for the backend, to `<state root>/extension-keys/<lower id>-<8 hex>.key`
// (dir 0700, file 0600; the name is case-free, so `Foo` and `foo` never share one). The server keeps
// only sha256 hashes, in `<state root>/extension-key-hashes.json`, written BEFORE the key file, and it
// never accepts a key because a file holds it: acceptance is the hash map alone.
//
// sync() (at start, then every SYNC_MS while anything is installed or held, never on a request path;
// idle, it waits on the manifest's folder: startExtensionKeys) follows the manifest: a key for each
// installed id that has none, has lost its file or whose file no longer matches its hash; the file and
// hash of every id missing from two whole reads in a row removed, and the sockets those keys opened closed. A manifest
// that can't be read whole changes nothing. At call time, idOf() admits a key only while its id is
// installed and its file is there, so an uninstall or a deleted file refuses it at once.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import type { ExtensionKeyCheck } from "./auth";
import { extensionKeyDir, extensionKeyHashFile, extensionsFile, findExtension, installedIdsForKeys } from "./extensions";

export const SYNC_MS = 3000;
/** Syncs in a row an id must be missing from a whole manifest before its key and sockets go. */
export const REVOKE_AFTER = 2;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A key's file name: the id in lower case, `-`, 8 hex of the sha256 of the id as written, and `.key`,
    a name the Overseer's file tools never read, list or match (server/overseer-deny.ts). */
export const keyFileName = (id: string): string => `${id.toLowerCase()}-${sha256(id).slice(0, 8)}.key`;

interface KeyRecord {
  hash: string;
  issuedAt: string;
}

/** The file operations sync uses, so a test can make one fail. */
export interface KeyIo {
  writeFileSync: typeof fs.writeFileSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

export interface ExtensionKeysOptions {
  dir?: () => string;
  hashFile?: () => string;
  /** The installed ids, or null when the manifest can't be read whole. */
  installed?: () => string[] | null;
  /** Whether `id` is installed now (the call-time check). */
  isInstalled?: (id: string) => boolean;
  io?: Partial<KeyIo>;
  log?: (line: string) => void;
}

export class ExtensionKeys implements ExtensionKeyCheck {
  /** id → record, loaded from the hash file at the first use. */
  private recs: Map<string, KeyRecord> | null = null;
  private readonly byHash = new Map<string, string>();
  private readonly sockets = new Map<string, Set<Duplex>>();
  /** id → the key file's `mtime:size:ino` when it last matched its hash (sync reads it only when that moves). */
  private readonly matched = new Map<string, string>();
  /** id → how many syncs in a row read the manifest whole without it (revoked at REVOKE_AFTER). */
  private readonly absent = new Map<string, number>();
  private readonly io: KeyIo;
  private lastWarn = 0;

  constructor(private readonly o: ExtensionKeysOptions = {}) {
    this.io = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync, ...o.io };
  }

  private dir(): string {
    return (this.o.dir ?? extensionKeyDir)();
  }
  private hashFile(): string {
    return (this.o.hashFile ?? extensionKeyHashFile)();
  }
  /** Where `id`'s key is written for its backend. */
  fileOf(id: string): string {
    return join(this.dir(), keyFileName(id));
  }

  private warn(line: string): void {
    const t = Date.now();
    if (t - this.lastWarn < 60_000) return;
    this.lastWarn = t;
    (this.o.log ?? ((l) => console.warn(`[extension-keys] ${l}`)))(line);
  }

  private loaded(): Map<string, KeyRecord> {
    if (this.recs) return this.recs;
    this.recs = new Map();
    try {
      const doc = JSON.parse(fs.readFileSync(this.hashFile(), "utf8")) as { version?: unknown; keys?: Record<string, KeyRecord> };
      if (doc?.version === 1 && doc.keys && typeof doc.keys === "object") {
        for (const [id, r] of Object.entries(doc.keys)) {
          if (typeof r?.hash !== "string" || !/^[0-9a-f]{64}$/.test(r.hash)) continue;
          this.recs.set(id, { hash: r.hash, issuedAt: typeof r.issuedAt === "string" ? r.issuedAt : "" });
          this.byHash.set(r.hash, id);
        }
      }
    } catch {
      // none yet, or damaged: every installed id gets a new key at the next sync
    }
    return this.recs;
  }

  /** Write `text` to `file` whole: a temp file beside the key folder (never inside it), renamed in. */
  private atomic(file: string, text: string): void {
    const tmp = join(dirname(this.dir()), `.extension-key.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      this.io.writeFileSync(tmp, text, { mode: 0o600 });
      this.io.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      throw err;
    }
  }

  private writeHashes(): void {
    const keys: Record<string, KeyRecord> = {};
    for (const [id, r] of this.loaded()) keys[id] = r;
    fs.mkdirSync(dirname(this.hashFile()), { recursive: true });
    this.atomic(this.hashFile(), `${JSON.stringify({ version: 1, keys }, null, 2)}\n`);
  }

  private closeSockets(id: string): void {
    const set = this.sockets.get(id);
    if (!set) return;
    this.sockets.delete(id);
    for (const s of set) {
      try {
        s.destroy();
      } catch {
        // already gone
      }
    }
  }

  /** The installed extension `key` admits now: its hash is known, its id installed, its file there. */
  idOf(key: string): string | null {
    if (!KEY_RE.test(key)) return null;
    const id = (this.loaded(), this.byHash.get(sha256(key)));
    if (id === undefined) return null;
    if (!(this.o.isInstalled ?? ((i: string) => findExtension(i) !== undefined))(id)) return null;
    return fs.existsSync(this.fileOf(id)) ? id : null;
  }

  isKey(value: string): boolean {
    return KEY_RE.test(value) && (this.loaded(), this.byHash.has(sha256(value)));
  }

  socket(id: string, socket: Duplex): void {
    if (socket.destroyed) return;
    let set = this.sockets.get(id);
    if (!set) this.sockets.set(id, (set = new Set()));
    set.add(socket);
    // Also when the route refuses it before any upgrade: nothing is kept for a socket that ended.
    socket.once("close", () => {
      const s = this.sockets.get(id);
      if (!s) return;
      s.delete(socket);
      if (!s.size) this.sockets.delete(id);
    });
  }

  /** How many sockets are held open for `id`'s key (tests). */
  openSockets(id: string): number {
    return this.sockets.get(id)?.size ?? 0;
  }

  /** A new key for `id`: the hash recorded first, then the file. False when the hash couldn't be kept. */
  private mint(id: string): boolean {
    const recs = this.loaded();
    const before = recs.get(id);
    const key = randomBytes(32).toString("base64url");
    const rec: KeyRecord = { hash: sha256(key), issuedAt: new Date().toISOString() };
    recs.set(id, rec);
    try {
      this.writeHashes();
    } catch (err) {
      if (before) recs.set(id, before);
      else recs.delete(id);
      this.warn(`${id}: the key's hash was not written: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (before) this.byHash.delete(before.hash);
    this.byHash.set(rec.hash, id);
    this.matched.delete(id);
    // The old key's sockets end with it, whether or not the new file lands.
    this.closeSockets(id);
    try {
      fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      this.atomic(this.fileOf(id), `${key}\n`);
    } catch (err) {
      // No file: idOf refuses the new key, and the next sync makes another.
      this.warn(`${id}: the key file was not written: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  private revoke(id: string): void {
    const recs = this.loaded();
    const rec = recs.get(id);
    if (rec) this.byHash.delete(rec.hash);
    recs.delete(id);
    this.matched.delete(id);
    this.closeSockets(id);
    try {
      this.writeHashes();
    } catch (err) {
      this.warn(`${id}: the hashes were not rewritten: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.io.rmSync(this.fileOf(id), { force: true });
    } catch (err) {
      this.warn(`${id}: the key file was not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Installed ids the last sync read whole, null before one or after a read that wasn't whole. */
  private lastIds: number | null = null;

  /** Nothing to follow: the last read was whole and named no extension, and no key or socket is held.
      The sync timer may stop until the manifest changes (startExtensionKeys). */
  idle(): boolean {
    return this.lastIds === 0 && this.loaded().size === 0 && this.absent.size === 0 && this.sockets.size === 0;
  }

  /** Follow the manifest (see the head of this file). Never throws. */
  sync(): void {
    this.lastIds = null;
    try {
      const ids = (this.o.installed ?? installedIdsForKeys)();
      if (ids === null) return; // a manifest that can't be read whole changes no key
      this.lastIds = ids.length;
      const recs = this.loaded();
      const want = new Set(ids);
      // Gone from two whole reads in a row, never one: a save that moves the file away for a moment
      // (or a user moving it back) keeps every key. The call-time check refuses it at once anyway.
      for (const id of [...this.absent.keys()]) if (want.has(id) || !recs.has(id)) this.absent.delete(id);
      for (const id of [...recs.keys()]) {
        if (want.has(id)) continue;
        const n = (this.absent.get(id) ?? 0) + 1;
        if (n >= REVOKE_AFTER) {
          this.absent.delete(id);
          this.revoke(id);
        } else this.absent.set(id, n);
      }
      for (const id of want) {
        const rec = recs.get(id);
        if (!rec) {
          this.mint(id);
          continue;
        }
        const st = fs.statSync(this.fileOf(id), { throwIfNoEntry: false });
        if (!st) {
          this.mint(id);
          continue;
        }
        const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
        if (this.matched.get(id) === sig) continue;
        let text = "";
        try {
          text = fs.readFileSync(this.fileOf(id), "utf8").trim();
        } catch {
          // unreadable: replaced below
        }
        if (KEY_RE.test(text) && sha256(text) === rec.hash) this.matched.set(id, sig);
        else this.mint(id);
      }
      // Any socket still held for an id that has no key now (a mint that couldn't record its hash leaves the old one).
      for (const id of [...this.sockets.keys()]) if (!recs.has(id)) this.closeSockets(id);
    } catch (err) {
      this.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The server's keys. */
export const extensionKeys = new ExtensionKeys();

/** What the sync's schedule uses, so a test can drive it. */
export interface KeySyncClock {
  /** Run `fn` every `ms` until the returned stop is called. */
  every(fn: () => void, ms: number): () => void;
  /** Call `onChange` whenever the manifest's file may have changed; null when it can't be watched. */
  watch(onChange: () => void): (() => void) | null;
}

const realClock = (file: () => string = extensionsFile): KeySyncClock => ({
  every(fn, ms) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return () => clearInterval(t);
  },
  watch(onChange) {
    const path = file();
    const name = basename(path);
    try {
      // The folder, not the file: the manifest may not exist yet, and a save renames a new one in.
      const w = fs.watch(dirname(path), { persistent: false }, (_ev, f) => {
        if (f == null || String(f) === name) onChange();
      });
      w.on("error", () => {});
      return () => w.close();
    } catch {
      return null;
    }
  },
});

let running: (() => void) | null = null;
/**
 * At server start: a sync now, then every SYNC_MS while there is anything to follow. With nothing
 * installed and no key held (`idle`), the timer stops and nothing runs until the manifest's folder
 * says the file changed: then a sync at once, and the timer again while it has anything to follow.
 * So a new manifest's keys appear at once, a revocation still takes two whole reads in a row (the
 * timer runs while any key is held), and an idle server reads nothing. A manifest that can't be
 * watched keeps the timer always on. Returns the stop (tests).
 */
export function startExtensionKeys(keys: ExtensionKeys = extensionKeys, clock: KeySyncClock = realClock()): () => void {
  keys.sync();
  if (keys === extensionKeys && running) return running;
  let stopTimer: (() => void) | null = null;
  let watching = false;
  const tick = () => {
    keys.sync();
    if (watching && keys.idle()) stopTimer?.(), (stopTimer = null);
  };
  const ensureTimer = () => {
    if (!stopTimer) stopTimer = clock.every(tick, SYNC_MS);
  };
  const unwatch = clock.watch(() => {
    if (stopTimer) return; // the timer is following it already
    keys.sync();
    if (!keys.idle()) ensureTimer();
  });
  watching = unwatch !== null;
  if (!watching || !keys.idle()) ensureTimer();
  const stop = () => {
    stopTimer?.();
    stopTimer = null;
    unwatch?.();
    if (running === stop) running = null;
  };
  if (keys === extensionKeys) running = stop;
  return stop;
}
