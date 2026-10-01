import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
export const approvalsFile = () => join(servicesRoot(), "approvals.json");
export const hostVarsFile = () => join(servicesRoot(), "host.json");
export const conformDir = () => join(servicesRoot(), "conform");

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

/**
 * Take a lock file (`O_EXCL`, holding our pid) or say who holds it. A lock whose pid is dead is
 * stale and taken over. Our own pid's lock is held (by another call in this process).
 */
export function tryLock(file: string): { release: () => void } | { heldBy: number } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let done = false;
      return {
        release: () => {
          if (done) return;
          done = true;
          rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let pid = NaN;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {
        continue; // released meanwhile
      }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { heldBy: pid };
      rmSync(file, { force: true });
    }
  }
  return { heldBy: -1 };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Read, change and write the registry under its lock (waits up to 5 s for another writer). */
export function mutateRegistry<T>(fn: (r: Registry) => T, file = registryFile()): T {
  const lockFile = `${file}.lock`;
  const until = Date.now() + 5_000;
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
