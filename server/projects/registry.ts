import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { projectOf } from "../project-root";
import { stateRoot } from "../state-root";

/**
 * The standalone projects registered on this host (§app/projects): `<stateRoot>/projects.json`
 * `{version: 1, projects: [{id, dir, registeredAt, importing?}]}`, each entry's state under
 * `<stateRoot>/projects/<pid>/` in the workspace layout. Host state, never committed. A project placed
 * in an org has no entry here: its engine is the org's.
 *
 * Registration is explicit (a folder, a session's folder, or a clone): the folder is normalized to its
 * checkout root, one project per checkout root, and reserved roots (Sova's state, plus what another
 * layer contributes) are refused. Opening the engine and starting `project/<pid>` is the caller's.
 */

const INDEX_VERSION = 1;
const indexFile = () => join(stateRoot(), "projects.json");
export const projectsDir = () => join(stateRoot(), "projects");
export const projectDirOf = (pid: string) => join(projectsDir(), pid);

export interface RegistryEntry {
  id: string;
  dir: string;
  registeredAt: string;
  /** Set while an import into an org is under way (slice B); boot rolls it forward. */
  importing?: { org: string; at: string };
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PID = /^prj_[a-z0-9]{8}$/;

function parseEntry(v: unknown): RegistryEntry | null {
  if (!isObj(v) || typeof v.id !== "string" || !PID.test(v.id) || typeof v.dir !== "string" || !v.dir) return null;
  const entry: RegistryEntry = { id: v.id, dir: v.dir, registeredAt: typeof v.registeredAt === "string" ? v.registeredAt : "" };
  if (isObj(v.importing) && typeof v.importing.org === "string" && typeof v.importing.at === "string") entry.importing = { org: v.importing.org, at: v.importing.at };
  return entry;
}

let cache: { mtimeMs: number; entries: RegistryEntry[] } | null = null;

/** The registered standalone projects, re-read when the file changed. A missing file is an empty registry. */
export function readRegistry(): RegistryEntry[] {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(indexFile()).mtimeMs;
  } catch {}
  if (!cache || cache.mtimeMs !== mtimeMs) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(indexFile(), "utf8"));
    } catch {}
    const entries: RegistryEntry[] = [];
    if (isObj(raw) && Array.isArray(raw.projects))
      for (const v of raw.projects) {
        const e = parseEntry(v);
        if (e && !entries.some((o) => o.id === e.id)) entries.push(e);
      }
    cache = { mtimeMs, entries };
  }
  return cache.entries.map((e) => ({ ...e }));
}

export const registryEntry = (pid: string): RegistryEntry | undefined => readRegistry().find((e) => e.id === pid);

function writeRegistry(entries: RegistryEntry[]): void {
  const file = indexFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: INDEX_VERSION, projects: entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
}

// ---- ids ---------------------------------------------------------------------------------------------

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A fresh `prj_` id that is neither registered here nor in `taken` (the ids of placed projects). */
export function mintProjectId(taken: Iterable<string> = []): string {
  const used = new Set([...readRegistry().map((e) => e.id), ...taken]);
  for (;;) {
    let s = "prj_";
    for (const b of randomBytes(8)) s += ID_ALPHABET[b % ID_ALPHABET.length];
    if (!used.has(s) && !existsSync(projectDirOf(s))) return s;
  }
}

// ---- registration ------------------------------------------------------------------------------------

const canonical = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

export interface RegistrationDeps {
  /** Every project known here, standalone or placed, with its root. */
  rootsInUse: () => { id: string; name?: string; root: string }[] | Promise<{ id: string; name?: string; root: string }[]>;
  /** Folders a project may not be inside of or hold, beyond Sova's own state (contributed: attached workspaces). */
  reservedRoots?: () => string[];
}

export interface PreparedRoot {
  root: string;
  name: string;
  git: boolean;
  /** The folder asked for, when the checkout root differs from it. */
  normalizedFrom?: string;
}

/** Why `root` may not be a project root, or null: inside or holding a reserved folder. */
export function reservedRootProblem(root: string, reserved: string[]): string | null {
  for (const r of [stateRoot(), ...reserved]) {
    const dir = canonical(r);
    if (within(root, dir)) return `${root} is inside ${dir}, which Sova keeps for itself; pick a project folder outside it`;
    if (within(dir, root)) return `${root} holds ${dir}, which Sova keeps for itself; pick a folder that doesn't contain it`;
  }
  return null;
}

/**
 * The checkout root `rawRoot` registers as, or a RegistryError: not an absolute local folder, a
 * reserved root, or a root that is already a project here.
 */
export async function prepareRegistration(rawRoot: unknown, deps: RegistrationDeps): Promise<PreparedRoot> {
  if (typeof rawRoot !== "string" || !rawRoot.trim()) throw new RegistryError("root must be a folder path");
  const asked = rawRoot.trim();
  const p = await projectOf(asked);
  if (p.state === "none") throw new RegistryError("root must be a folder path");
  if (p.state !== "ok") throw new RegistryError(p.message);
  const reserved = reservedRootProblem(p.root, deps.reservedRoots?.() ?? []);
  if (reserved) throw new RegistryError(reserved);
  const taken = (await deps.rootsInUse()).find((o) => canonical(o.root) === p.root);
  if (taken) throw new RegistryError(`${p.root} is already a project here${taken.name ? `: ${taken.name}` : ""}`, 409);
  const prepared: PreparedRoot = { root: p.root, name: p.name, git: p.git };
  if (canonical(asked) !== p.root) prepared.normalizedFrom = asked;
  return prepared;
}

/** Mint an id, create its dir and write its entry. `taken`: the ids of projects placed in orgs here. */
export function addRegistryEntry(taken: Iterable<string> = []): RegistryEntry {
  const id = mintProjectId(taken);
  const dir = projectDirOf(id);
  mkdirSync(dir, { recursive: true });
  const entry: RegistryEntry = { id, dir, registeredAt: new Date().toISOString() };
  writeRegistry([...readRegistry(), entry]);
  return entry;
}

/** Replace an entry's `importing` mark (slice B), or clear it with null. */
export function markImporting(pid: string, importing: RegistryEntry["importing"] | null): void {
  const entries = readRegistry();
  const e = entries.find((o) => o.id === pid);
  if (!e) throw new RegistryError("Unknown project", 404);
  if (importing) e.importing = importing;
  else delete e.importing;
  writeRegistry(entries);
}

/**
 * Drop an entry. With `removeEmptyDir` (rolling back a registration whose engine never started), its
 * dir goes too, but only while it holds nothing but empty folders.
 */
export function removeRegistryEntry(pid: string, { removeEmptyDir = false } = {}): void {
  const entries = readRegistry();
  const e = entries.find((o) => o.id === pid);
  if (!e) return;
  writeRegistry(entries.filter((o) => o.id !== pid));
  if (removeEmptyDir && within(resolve(e.dir), projectsDir())) removeEmptyTree(e.dir);
}

function removeEmptyTree(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true;
  }
  let empty = true;
  for (const n of names) {
    const p = join(dir, n);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {}
    if (!isDir || !removeEmptyTree(p)) empty = false;
  }
  if (empty)
    try {
      rmdirSync(dir);
    } catch {
      return false;
    }
  return empty;
}

