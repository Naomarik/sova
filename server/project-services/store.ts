import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateRoot } from "../state-root";

/**
 * The instance registry and its locks (§app.project-services/instances, /lock): what Sova's state
 * root records about every instance, changed only under a file lock and written by atomic rename,
 * so two callers (two requests, or two servers on one state root) never get the same slot or port.
 * Node builtins only.
 */

export const servicesRoot = () => join(stateRoot(), "project-services");
export const registryFile = () => join(servicesRoot(), "registry.json");
export const dataRootOf = (id: string) => join(servicesRoot(), "data", id);
export const logsDir = () => join(servicesRoot(), "logs");
export const procsDir = () => join(servicesRoot(), "procs");
export const locksDir = () => join(servicesRoot(), "locks");
export const hostVarsFile = () => join(servicesRoot(), "host.json");
export const conformDir = () => join(servicesRoot(), "conform");

/** Host variables (`host` names) per project root: `{version: 1, projects: {<root>: {NAME: value}}}`, set by the operator by hand. */
export function hostVars(project: string, file = hostVarsFile()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; projects?: Record<string, Record<string, unknown>> };
    if (raw?.version !== 1) return {};
    const vars = raw.projects?.[project] ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Six hex of the state root's path: every unit name carries it, so two Sova servers on one user manager never touch each other's units. */
export const stateHash = () => createHash("sha256").update(stateRoot()).digest("hex").slice(0, 6);

export type CallerKind = "operator" | "overseer" | "project-overseer" | "session" | "conform";

export interface InstanceRecord {
  id: string;
  /** The project root (the main checkout). */
  project: string;
  checkout: string;
  branch: string | null;
  slot: number;
  generation: number;
  /** `operator`, `overseer:<id>`, `project-overseer:<id>`, `session:<id>` or `conform:<run>`. */
  createdBy: string;
  createdAt: string;
  /** Sova cut the worktree (teardown may remove it when clean). */
  cutWorktree: boolean;
  /** Per service: what the instance should be doing. */
  desired: Record<string, "running" | "stopped">;
  /** Setup step id (or `build:<service>`) → fingerprint of its last good run. */
  prints: Record<string, string>;
  /** Data resource → its ref (a path, or a hook's output). */
  data: Record<string, string>;
  /** Checkout-scoped ports this instance holds: `{service: {port: n}}`. */
  ports: Record<string, Record<string, number>>;
  /** Container service → the container its last start ran as, so a down can remove it after the service left the definition. */
  containers?: Record<string, { engine: string; name: string }>;
}

/** A project's shared services (§app.project-services/contract `scope: shared`): one per project. */
export interface SharedRecord {
  project: string;
  id: string;
  desired: Record<string, "running" | "stopped">;
  ports: Record<string, Record<string, number>>;
}

export interface Registry {
  version: 1;
  instances: InstanceRecord[];
  shared: SharedRecord[];
}

const empty = (): Registry => ({ version: 1, instances: [], shared: [] });

export function readRegistry(file = registryFile()): Registry {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Registry>;
    if (raw?.version !== 1 || !Array.isArray(raw.instances)) return empty();
    return { version: 1, instances: raw.instances, shared: Array.isArray(raw.shared) ? raw.shared : [] };
  } catch {
    return empty();
  }
}

function writeRegistry(r: Registry, file = registryFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(tmp, file);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** How long `mutateRegistry` waits for another writer. */
const LOCK_WAIT_MS = 5_000;
/**
 * A lock file without a pid (a crash between create and write, a full disk, or a lock made by code
 * that wrote the pid after creating the file) counts as held while it is younger than this, and as
 * stale debris after, so it never blocks an instance or the registry for good. Matches the wait.
 */
export const BLANK_LOCK_GRACE_MS = LOCK_WAIT_MS;

const uniq = () => `${process.pid}.${randomBytes(4).toString("hex")}`;

/** A lock file as read: its pid (null when it holds none) and its identity (device, inode, mtime in ns). */
export type Seen = { pid: number | null; dev: bigint; ino: bigint; mtimeNs: bigint; mtimeMs: number };

/** What a lock file holds, read through one descriptor so the pid and the identity belong together; null when it is gone. */
function readLock(file: string): Seen | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    let text = "";
    try {
      text = readFileSync(fd, "utf8").trim();
    } catch {
      /* unreadable: no pid */
    }
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    return { pid: Number.isSafeInteger(n) && n > 0 ? n : null, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs) };
  } finally {
    closeSync(fd);
  }
}

/** Put a file holding our pid at `file` only if nothing is there (a hard link never overwrites); the whole content is there from the first moment. */
function linkLock(file: string): Seen | null {
  const tmp = `${file}.${uniq()}.new`;
  writeFileSync(tmp, String(process.pid));
  try {
    const st = statSync(tmp, { bigint: true });
    linkSync(tmp, file);
    return { pid: process.pid, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The same lock file: identity and pid alike, so a new lock that reused a freed inode is never taken for the old one. */
const same = (a: Seen | null, b: Seen) => !!a && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.pid === b.pid;

/** Stale: its pid is dead, or it holds no pid and is older than `BLANK_LOCK_GRACE_MS`. */
const stale = (s: Seen) => (s.pid !== null ? !alive(s.pid) : Date.now() - s.mtimeMs > BLANK_LOCK_GRACE_MS);

/**
 * Move the stale lock `seen` out of the way, only if the file at `file` is still that lock and is
 * still stale now. Takeovers go one at a time through `<file>.takeover` (held for a few syscalls):
 * without it, a caller that judged the old lock stale could rename away the fresh lock another taker
 * just linked in its place. `heldBy` when another caller is taking over right now. Exported for tests.
 */
export function takeOver(file: string, seen: Seen): { heldBy: number } | null {
  const guard = `${file}.takeover`;
  const g = linkLock(guard);
  if (!g) {
    const other = readLock(guard);
    // A guard is held only for a few syscalls: an old one is a crashed taker's debris.
    const old = (s: Seen | null) => !!s && Date.now() - s.mtimeMs > BLANK_LOCK_GRACE_MS;
    if (other && old(other)) moveAside(guard, (now) => same(now, other) && old(now));
    return { heldBy: other?.pid ?? -1 };
  }
  try {
    const now = readLock(file);
    if (now && same(now, seen) && stale(now)) moveAside(file, (moved) => same(moved, now) && stale(moved!));
    return null;
  } finally {
    if (same(readLock(guard), g)) rmSync(guard, { force: true });
  }
}

/** Rename `file` aside and remove it when `ok` says what was moved may go; anything else is put back. */
function moveAside(file: string, ok: (moved: Seen | null) => boolean): void {
  const aside = `${file}.stale.${uniq()}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // someone else moved it
    throw err;
  }
  if (!ok(readLock(aside))) {
    try {
      linkSync(aside, file);
    } catch {
      /* a new lock is already there */
    }
  }
  rmSync(aside, { force: true });
}

/**
 * Take a lock file (created whole, holding our pid) or say who holds it (`-1`: not known). A lock
 * whose pid is dead is stale and taken over, and so is one without a pid once it is older than
 * `BLANK_LOCK_GRACE_MS`. Our own pid's lock is held (by another call in this process). Release
 * removes the lock only while it is still the one this call made.
 */
export function tryLock(file: string): { release: () => void } | { heldBy: number } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const mine = linkLock(file);
    if (mine) {
      let done = false;
      return {
        release: () => {
          if (done) return;
          done = true;
          if (same(readLock(file), mine)) rmSync(file, { force: true });
        },
      };
    }
    const seen = readLock(file);
    if (!seen) continue; // released meanwhile
    // A live pid holds it; so does one without a pid while young (being written by older code).
    if (!stale(seen)) return { heldBy: seen.pid ?? -1 };
    const busy = takeOver(file, seen);
    if (busy) return busy;
  }
  return { heldBy: -1 };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Read, change and write the registry under its lock (waits up to 5 s for another writer). */
export function mutateRegistry<T>(fn: (r: Registry) => T, file = registryFile()): T {
  const lockFile = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const l = tryLock(lockFile);
    if ("release" in l) {
      try {
        const r = readRegistry(file);
        const out = fn(r);
        writeRegistry(r, file);
        return out;
      } finally {
        l.release();
      }
    }
    if (Date.now() > until) throw new Error(`the project registry stayed locked by pid ${l.heldBy}`);
    sleepSync(20);
  }
}

/** One lock per instance (per project + checkout, so it exists before the instance does). */
export function instanceLockFile(project: string, checkout: string): string {
  return join(locksDir(), `${createHash("sha256").update(`${project}\0${checkout}`).digest("hex").slice(0, 16)}.lock`);
}

/** A folder name's slug for ids: lowercase letters, digits and hyphens, at most 20. */
export function slugOf(path: string): string {
  const s = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return s || "project";
}

export const newInstanceId = (project: string) => `${slugOf(project)}-${randomBytes(4).toString("hex")}`;
export const sharedIdOf = (project: string) => `${slugOf(project)}-shared-${createHash("sha256").update(project).digest("hex").slice(0, 6)}`;

/**
 * The slot for a new instance of `project` (§app.project-services/instances). `want` is taken when
 * free; otherwise the lowest free slot in `range`. A slot is free when no instance of the project
 * holds it, and none of its ports is held by another instance on this host or `listening(port)`.
 */
export function pickSlot(
  r: Registry,
  project: string,
  portsOf: (slot: number) => number[],
  range: number[],
  listening: (port: number) => boolean,
  want?: number,
): { slot: number } | { refused: string } {
  const taken = new Set(r.instances.filter((i) => i.project === project).map((i) => i.slot));
  const claimed = new Map<number, string>();
  for (const i of r.instances) for (const [svc, ps] of Object.entries(i.ports)) for (const [k, n] of Object.entries(ps)) claimed.set(n, `${i.id} (${svc}.${k})`);
  for (const s of r.shared) if (s.project !== project) for (const [svc, ps] of Object.entries(s.ports)) for (const [k, n] of Object.entries(ps)) claimed.set(n, `${s.id} (${svc}.${k})`);
  const why = (slot: number): string | null => {
    if (taken.has(slot)) return `slot ${slot} is held by another instance of this project`;
    for (const p of portsOf(slot)) {
      const c = claimed.get(p);
      if (c) return `slot ${slot} needs port ${p}, which ${c} holds`;
      if (listening(p)) return `slot ${slot} needs port ${p}, which something is listening on`;
    }
    return null;
  };
  if (want !== undefined) {
    const w = why(want);
    return w ? { refused: w } : { slot: want };
  }
  const reasons: string[] = [];
  for (const slot of range) {
    const w = why(slot);
    if (!w) return { slot };
    reasons.push(w);
  }
  return { refused: reasons.length ? `no free slot: ${reasons.join("; ")}` : "no slot in range" };
}
