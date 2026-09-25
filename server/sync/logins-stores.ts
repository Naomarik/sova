import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EntryKind, StoreId } from "./logins-merge";

/**
 * The two credential stores login sync reads and writes, each through its consumer's OWN lock:
 *
 * - pi `auth.json`: proper-lockfile's `auth.json.lock` directory, exactly as pi 0.87.1's
 *   `FileAuthStorageBackend` takes it (`realpath: false`). pi's sync path waits with `stale: 10s`
 *   and its async path holds with `stale: 30s` (so its mtime may lag 15s during a refresh, which
 *   has a 15s network timeout): we wait with 30s so we never steal a refresh in flight, and hold
 *   with a 2s update so pi's 10s waiter never steals ours.
 * - Claude Code `.credentials.json`: `<claudeDir>/.oauth_refresh.lock` then the legacy
 *   `<realpath claudeDir>.lock`, in Claude Code 2.1.282's order, both `stale: 60s, update: 5s`.
 *
 * Every write re-reads under the lock, changes only the entries it was asked to, and replaces the
 * file with tmp + fsync + rename at 0600, so a reader that ignores the lock never sees a torn file.
 * Nothing here runs at import: every path is passed in by the caller, and tests pass scratch dirs.
 */

// proper-lockfile is pi's own dependency (not Sova's): resolve it from pi's real path under pnpm
// so both sides run the very same lock implementation.
type Release = () => Promise<void>;
interface LockOptions {
  realpath: boolean;
  stale: number;
  update: number;
  retries: 0;
  lockfilePath?: string;
  onCompromised: (err: Error) => void;
}
interface ProperLockfile {
  lock(file: string, options: LockOptions): Promise<Release>;
}
let lockfileModule: ProperLockfile | undefined;
function properLockfile(): ProperLockfile {
  if (!lockfileModule) {
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    lockfileModule = createRequire(piEntry)("proper-lockfile") as ProperLockfile;
  }
  return lockfileModule;
}

export class LockBusyError extends Error {
  readonly code = "ELOCKED";
}

export interface LockSpec {
  /** The path handed to proper-lockfile; distinct per lock (its in-process map is keyed by it). */
  file: string;
  lockfilePath?: string;
  /** Our wait: a lock older than this is taken over. Must be >= the consumer's holding stale. */
  stale: number;
  /** Our hold: how often we touch the lock, below every consumer's waiting stale. */
  update: number;
}

export interface HeldLocks {
  compromised(): boolean;
  release(): Promise<void>;
}

/**
 * Take every lock in order, each retried on ELOCKED with backoff until `deadlineMs` (pi's own
 * async deadline is 30s). A lock that fails releases the ones already held. The compromise
 * callback only records the fact (proper-lockfile's default throws from a timer, which would
 * take the whole server down); a write checks it right before its rename.
 */
export async function acquireLocks(specs: readonly LockSpec[], deadlineMs = 30_000): Promise<HeldLocks> {
  const lf = properLockfile();
  let compromised = false;
  const held: Release[] = [];
  const releaseAll = async () => {
    for (const r of held.splice(0).reverse()) await r().catch(() => {});
  };
  const deadline = Date.now() + deadlineMs;
  try {
    for (const spec of specs) {
      let retry = 0;
      for (;;) {
        try {
          held.push(
            await lf.lock(spec.file, {
              realpath: false,
              retries: 0,
              stale: spec.stale,
              update: spec.update,
              ...(spec.lockfilePath ? { lockfilePath: spec.lockfilePath } : {}),
              onCompromised: () => {
                compromised = true;
              },
            }),
          );
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          const remaining = deadline - Date.now();
          if (code !== "ELOCKED") throw error;
          if (remaining <= 0) throw new LockBusyError(`${spec.lockfilePath ?? `${spec.file}.lock`} is held`);
          const base = Math.min(10 * 2 ** retry++, 1000);
          await new Promise((r) => setTimeout(r, Math.min(Math.round(base * (1 + Math.random())), remaining)));
        }
      }
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }
  return { compromised: () => compromised, release: releaseAll };
}

/** Replace `path` atomically: a same-dir temp at 0600, fsync, rename, fsync the directory. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.sova-sync.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  fsyncDir(dirname(path));
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every filesystem lets a directory be fsynced; the rename itself is still atomic.
  }
}

/** Canonical JSON (keys sorted at every depth), so equal entries fingerprint equally on every host. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const fingerprint = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** One syncable entry as a store holds it. `value` is the secret-bearing object: never logged. */
export interface StoreEntry {
  kind: EntryKind;
  expires?: number;
  /** The consumer's failed-refresh marker (empty tokens / zero expiry). */
  dead: boolean;
  /** A non-secret digest of the account the entry belongs to, when the entry names one. */
  account?: string;
  fingerprint: string;
  value: Record<string, unknown>;
}

export interface StoreSnapshot {
  /** `refused`: the store is not ours to touch (Claude's file is a symlink); nothing is read or written. */
  state: "ok" | "missing" | "invalid" | "refused";
  /** Why `invalid`/`refused` (no content, ever). */
  reason?: string;
  entries: Map<string, StoreEntry>;
  /** Providers present but never synced (device-bound config such as a `!command` api key). */
  localOnly: Set<string>;
}

/** Provider → new entry value, or `null` to remove it. Local-only providers are never touched. */
export type StoreChanges = Map<string, Record<string, unknown> | null>;

export interface CredentialStore {
  readonly id: StoreId;
  /** The file the consumer reads; the watcher watches its directory (writes are renames). */
  readonly path: string;
  /**
   * A new fingerprint on an entry this close to expiry (or past it) is the consumer refreshing,
   * not a login: pi refreshes only inside its 5-minute window.
   */
  readonly refreshWindowMs: number;
  /** Deleting the whole file is the consumer's logout (Claude Code), not just a lost file (pi). */
  readonly fileDeleteIsLogout: boolean;
  /**
   * Under the consumer's lock: read, let `fn` decide, write `changes` if any. A store that is
   * not `ok`/`missing` is never written, whatever `fn` returns.
   */
  transact<T>(fn: (snap: StoreSnapshot) => { result: T; changes?: StoreChanges }): Promise<T>;
}

type Parsed = { state: StoreSnapshot["state"]; reason?: string; data: Record<string, unknown> };

function readJsonObject(path: string, refuseSymlink: boolean): Parsed {
  if (refuseSymlink) {
    try {
      if (lstatSync(path).isSymbolicLink()) return { state: "refused", reason: "store is a symlink", data: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", data: {} };
      return { state: "invalid", reason: (error as NodeJS.ErrnoException).code ?? "unreadable", data: {} };
    }
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "missing", data: {} } : { state: "invalid", reason: code ?? "unreadable", data: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // Torn or hand-broken: never merged, never overwritten. The next change event re-reads.
    return { state: "invalid", reason: "not valid JSON", data: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "invalid", reason: "not a JSON object", data: {} };
  }
  return { state: "ok", data: parsed as Record<string, unknown> };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface FileStoreOptions {
  /** How long a write waits for the consumer's lock before giving up (pi's own async deadline: 30s). */
  lockDeadlineMs?: number;
}

abstract class FileStore implements CredentialStore {
  abstract readonly id: StoreId;
  abstract readonly refreshWindowMs: number;
  abstract readonly fileDeleteIsLogout: boolean;
  protected abstract readonly refuseSymlink: boolean;
  constructor(
    readonly path: string,
    protected readonly options: FileStoreOptions = {},
  ) {}
  protected abstract lockSpecs(): LockSpec[];
  /** The syncable entries and local-only providers of a parsed file. */
  protected abstract classify(data: Record<string, unknown>): Pick<StoreSnapshot, "entries" | "localOnly">;
  /** Serialize the whole next file, in the consumer's own format. */
  protected abstract serialize(data: Record<string, unknown>): string;
  /** When every entry is gone, remove the file instead (Claude's logout deletes it). */
  protected abstract deleteWhenEmpty: boolean;

  async transact<T>(fn: (snap: StoreSnapshot) => { result: T; changes?: StoreChanges }): Promise<T> {
    const locks = await acquireLocks(this.lockSpecs(), this.options.lockDeadlineMs);
    try {
      const parsed = readJsonObject(this.path, this.refuseSymlink);
      const snap: StoreSnapshot =
        parsed.state === "ok"
          ? { state: "ok", ...this.classify(parsed.data) }
          : { state: parsed.state, ...(parsed.reason ? { reason: parsed.reason } : {}), entries: new Map(), localOnly: new Set() };
      const { result, changes } = fn(snap);
      if (!changes || changes.size === 0 || (snap.state !== "ok" && snap.state !== "missing")) return result;
      const next: Record<string, unknown> = { ...parsed.data };
      let changed = false;
      for (const [provider, value] of changes) {
        if (snap.localOnly.has(provider)) continue;
        if (value === null) {
          if (provider in next) {
            delete next[provider];
            changed = true;
          }
        } else if (canonicalJson(next[provider]) !== canonicalJson(value)) {
          next[provider] = value;
          changed = true;
        }
      }
      if (!changed) return result;
      if (locks.compromised()) throw new LockBusyError(`lock on ${this.path} was compromised; write abandoned`);
      if (this.deleteWhenEmpty && Object.keys(next).length === 0) unlinkSync(this.path);
      else writeFileAtomic(this.path, this.serialize(next));
      return result;
    } finally {
      await locks.release();
    }
  }
}

/** pi's `auth.json`: many providers, oauth + api_key, per pi 0.87.1's `ReadOnlyAuthStorage.load` rules. */
export class PiAuthStore extends FileStore {
  readonly id = "pi" as const;
  readonly refreshWindowMs = PI_REFRESH_WINDOW_MS;
  readonly fileDeleteIsLogout = false;
  protected readonly refuseSymlink = false;
  protected readonly deleteWhenEmpty = false;
  /** `path` = `<agentDir>/auth.json`. */
  constructor(path: string, options?: FileStoreOptions) {
    super(path, options);
  }
  protected lockSpecs(): LockSpec[] {
    return [{ file: this.path, stale: 30_000, update: 2_000 }];
  }
  protected classify(data: Record<string, unknown>) {
    const entries = new Map<string, StoreEntry>();
    const localOnly = new Set<string>();
    for (const [provider, value] of Object.entries(data)) {
      const entry = isObject(value) ? classifyPiEntry(value) : undefined;
      if (entry) entries.set(provider, entry);
      else localOnly.add(provider);
    }
    return { entries, localOnly };
  }
  protected serialize(data: Record<string, unknown>): string {
    return JSON.stringify(data, null, 2); // pi's own format (no trailing newline)
  }
}

/**
 * A pi entry that may travel: a well-formed oauth entry, or an api_key whose `key` is a plain
 * literal. A `!command` or `$VAR` key and an `env` map resolve against THIS host's shell and
 * environment, so they are device configuration, not a secret to copy.
 */
export function classifyPiEntry(v: Record<string, unknown>): StoreEntry | undefined {
  if (v.type === "oauth") {
    if (typeof v.access !== "string" || typeof v.refresh !== "string") return undefined;
    if (typeof v.expires !== "number" || !Number.isFinite(v.expires)) return undefined;
    return {
      kind: "oauth",
      expires: v.expires,
      dead: v.access === "" || v.refresh === "" || v.expires <= 0,
      ...(typeof v.accountId === "string" && v.accountId ? { account: digest(v.accountId) } : {}),
      fingerprint: fingerprint(v),
      value: v,
    };
  }
  if (v.type === "api_key") {
    if (typeof v.key !== "string" || v.key === "" || v.key.startsWith("!") || v.key.includes("$")) return undefined;
    if (v.env !== undefined) return undefined;
    return { kind: "api_key", dead: false, fingerprint: fingerprint(v), value: v };
  }
  return undefined;
}

export const CLAUDE_OAUTH_KEY = "claudeAiOauth";

/**
 * Claude Code's `<claudeDir>/.credentials.json`. Only `claudeAiOauth` travels; every other key
 * (MCP server tokens and the like) is this device's and is preserved as it is. A symlinked file is
 * refused, as Claude Code refuses it. Deleting the file is Claude Code's logout.
 */
export class ClaudeCredentialStore extends FileStore {
  readonly id = "claude" as const;
  /** Claude Code's own window isn't observable from outside; any change to a live lineage counts as a refresh. */
  readonly refreshWindowMs = Number.POSITIVE_INFINITY;
  readonly fileDeleteIsLogout = true;
  protected readonly refuseSymlink = true;
  protected readonly deleteWhenEmpty = true;
  constructor(
    readonly claudeDir: string,
    options?: FileStoreOptions,
  ) {
    super(join(claudeDir, ".credentials.json"), options);
  }

  /** No config dir means no Claude Code here: nothing to read, and never created by us. */
  override transact<T>(fn: (snap: StoreSnapshot) => { result: T; changes?: StoreChanges }): Promise<T> {
    if (!existsSync(this.claudeDir)) {
      return Promise.resolve(fn({ state: "refused", reason: "no Claude Code config dir", entries: new Map(), localOnly: new Set() }).result);
    }
    return super.transact(fn);
  }
  protected lockSpecs(): LockSpec[] {
    let real = this.claudeDir;
    try {
      real = realpathSync(this.claudeDir);
    } catch {
      // A missing dir: Claude Code falls back to the literal path too.
    }
    return [
      { file: join(this.claudeDir, ".oauth_refresh"), lockfilePath: join(this.claudeDir, ".oauth_refresh.lock"), stale: 60_000, update: 5_000 },
      { file: real, lockfilePath: `${real}.lock`, stale: 60_000, update: 5_000 },
    ];
  }
  protected classify(data: Record<string, unknown>) {
    const entries = new Map<string, StoreEntry>();
    const localOnly = new Set<string>();
    const v = data[CLAUDE_OAUTH_KEY];
    if (v !== undefined) {
      const entry = isObject(v) ? classifyClaudeEntry(v) : undefined;
      if (entry) entries.set(CLAUDE_OAUTH_KEY, entry);
      else localOnly.add(CLAUDE_OAUTH_KEY);
    }
    for (const k of Object.keys(data)) if (k !== CLAUDE_OAUTH_KEY) localOnly.add(k);
    return { entries, localOnly };
  }
  protected serialize(data: Record<string, unknown>): string {
    return JSON.stringify(data);
  }
}

export function classifyClaudeEntry(v: Record<string, unknown>): StoreEntry | undefined {
  if (typeof v.accessToken !== "string" || typeof v.refreshToken !== "string") return undefined;
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return undefined;
  return {
    kind: "oauth",
    expires: v.expiresAt,
    dead: v.accessToken === "" || v.refreshToken === "" || v.expiresAt <= 0,
    fingerprint: fingerprint(v),
    value: v,
  };
}

/**
 * c-lite for pi: make pi itself refresh one provider now, through its own `modify` (its lock, its
 * re-check under the lock, its rotation and its write), by asking for more validity than is left.
 * Our watcher then sees the new entry and pushes it.
 */
export function piRefresher(authPath: string): (provider: string, minValidityMs: number) => Promise<void> {
  return async (provider, minValidityMs) => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    // pi refreshes anything inside its own 5-minute window unasked. An explicit minimum is only
    // needed beyond it, and pi then also demands the NEW token meet it, throwing after it has
    // already stored the rotation: a lifetime under the minimum is not a failed refresh.
    const overrides = minValidityMs > PI_REFRESH_WINDOW_MS ? { minOAuthValidityMs: minValidityMs } : {};
    try {
      await runtime.getAuth(provider, overrides);
    } catch (error) {
      if (!/expires too soon/.test((error as Error).message)) throw error;
    }
  };
}

/** pi-ai's `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` (`dist/auth/resolve.js`, 0.87.1). */
const PI_REFRESH_WINDOW_MS = 5 * 60_000;
