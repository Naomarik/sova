import { constants, existsSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HHeader } from "../../shared/harness";
import { lineHeader } from "../harness/pi/reader";
import { indexedSessionPaths, idOf } from "../sessions-index";
import { extraSessionRoots, resolveSessionPath, SESSIONS_DIR } from "../paths";
import { stateRoot } from "../state-root";
import { isTourSession } from "./store";
import { isTourSessionDeleted } from "./deleted";
import { containedPath, digest, readBounded, writePrivate } from "./assets";

export interface TourOwnerRoot { path: string; flat: boolean }
export interface TourOwnerScan { files: string[]; complete: boolean }
export interface TourOwnerDirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface TourOwnerScanOptions {
  /** Read-only filesystem seam; failures remain UNKNOWN, never an empty successful directory. */
  readDirectory?(path: string): Promise<readonly TourOwnerDirectoryEntry[]>;
}
const ownerFiles = new Map<string, string>();
export interface KnownTourOwner { v: 1; sessionId: string; file: string; parentRoot: string; scopeRoot: TourOwnerRoot }
export type KnownTourOwnerRead = { status: "known"; owner: KnownTourOwner } | { status: "absent" | "unknown" };
const ownerRecordPath = (root: string, id: string) => { if (!isTourSession(id)) throw new Error("Invalid tour owner scope."); return join(root, "tour-owners", `${digest(id)}.json`); };
function containsOwner(root: TourOwnerRoot, file: string): boolean {
  const part = relative(root.path, file);
  if (!part || isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`)) return false;
  const segments = part.split(sep);
  return file.endsWith(".jsonl") && (segments.length === 1 || !root.flat && segments.length === 2 && segments[0] !== "live");
}
export function readKnownTourOwner(id: string, root = stateRoot()): KnownTourOwnerRead {
  try {
    const file = ownerRecordPath(root, id); containedPath(root, file, true);
    try { if (!lstatSync(file).isFile()) return { status: "unknown" }; } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown" }; }
    const bytes = readBounded(root, file, 16 * 1024), v = bytes ? JSON.parse(bytes.toString("utf8")) as KnownTourOwner : null;
    if (!v || Object.keys(v).some(k => !["v", "sessionId", "file", "parentRoot", "scopeRoot"].includes(k)) || v.v !== 1 || v.sessionId !== id || typeof v.file !== "string" || v.file.length > 4096 || !isAbsolute(v.file) || v.parentRoot !== dirname(v.file) || !v.scopeRoot || Object.keys(v.scopeRoot).some(k => !["path", "flat"].includes(k)) || typeof v.scopeRoot.path !== "string" || !isAbsolute(v.scopeRoot.path) || typeof v.scopeRoot.flat !== "boolean" || !containsOwner(v.scopeRoot, v.file)) return { status: "unknown" };
    return { status: "known", owner: v };
  } catch { return { status: "unknown" }; }
}
/** This private recovery index never grants read access; only current containment + header proof can write it. */
export async function rememberTourOwner(id: string, file: string, options: { root?: string; sessionRoots?: readonly TourOwnerRoot[] } = {}): Promise<boolean> {
  const root = options.root ?? stateRoot();
  if (!isTourSession(id) || isTourSessionDeleted(root, id)) return false;
  const scopes = options.sessionRoots ?? captureTourOwnerRoots(), scope = scopes.find(r => containsOwner(r, file));
  if (!scope) return false;
  let temporary: string | undefined;
  try {
    containedPath(scope.path, file);
    if (!lstatSync(dirname(file)).isDirectory() || tourOwnerHeaderSync(file)?.id !== id || isTourSessionDeleted(root, id)) return false;
    if (!options.sessionRoots && resolveSessionPath(file) !== file) return false;
    const previous = readKnownTourOwner(id, root);
    if (previous.status === "unknown") return false;
    const owner: KnownTourOwner = { v: 1, sessionId: id, file, parentRoot: dirname(file), scopeRoot: { ...scope } };
    if (previous.status === "known" && JSON.stringify(previous.owner) === JSON.stringify(owner)) return true;
    const path = ownerRecordPath(root, id); temporary = `${path}-${randomUUID()}.tmp`;
    writePrivate(root, temporary, JSON.stringify(owner)); containedPath(root, path, true); renameSync(temporary, path); return true;
  } catch { return false; }
  finally { if (temporary) try { containedPath(root, temporary, true); rmSync(temporary, { force: true }); } catch { /* A failed private write must never expose its path. */ } }
}
export async function knownTourOwnerState(owner: KnownTourOwner, roots: readonly TourOwnerRoot[]): Promise<"present" | "missing" | "unknown"> {
  if (!roots.some(root => root.path === owner.scopeRoot.path && containsOwner(root, owner.file))) return "unknown";
  try {
    containedPath(owner.scopeRoot.path, owner.parentRoot);
    if (!(await lstat(owner.parentRoot)).isDirectory()) return "unknown";
    await readdir(owner.parentRoot);
    try { if (!(await lstat(owner.file)).isFile()) return "unknown"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
    containedPath(owner.scopeRoot.path, owner.file);
    return (await tourOwnerHeader(owner.file))?.id === owner.sessionId ? "present" : "unknown";
  } catch { return "unknown"; }
}
export function tourOwnerIndexesKnown(root = stateRoot()): boolean {
  for (const [file, key] of [["orgs.json", "orgs"], ["projects.json", "projects"]] as const) {
    const path = join(root, file);
    try { containedPath(root, path, true); lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return false; }
    try {
      const bytes = readBounded(root, path, 4 * 1024 * 1024), value = bytes ? JSON.parse(bytes.toString("utf8")) : null;
      const entries: unknown = value?.[key];
      if (value?.version !== 1 || !Array.isArray(entries) || !entries.every(row => row && typeof row === "object" && typeof row.id === "string" && !!row.id && typeof row.dir === "string" && isAbsolute(row.dir) && (key !== "projects" || /^prj_[a-z0-9]{8}$/.test(row.id) && row.importing === undefined)) || new Set(entries.map(row => row.id)).size !== entries.length) return false;
    } catch { return false; }
  }
  return true;
}
export function forgetTourOwner(id: string, root = stateRoot()): void { const file = ownerRecordPath(root, id); containedPath(root, file, true); rmSync(file, { force: true }); }
export function knownTourOwnerSessions(root = stateRoot()): { sessions: string[]; unknown: boolean } {
  const sessions: string[] = []; let unknown = false;
  try {
    const directory = join(root, "tour-owners"); containedPath(root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) { unknown = true; continue; }
      const bytes = readBounded(root, join(directory, entry.name), 16 * 1024);
      try { const id = bytes ? (JSON.parse(bytes.toString("utf8")) as KnownTourOwner).sessionId : undefined; if (!isTourSession(id) || `${digest(id)}.json` !== entry.name || readKnownTourOwner(id, root).status !== "known") unknown = true; else sessions.push(id); } catch { unknown = true; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown = true; }
  return { sessions, unknown };
}
/** A recovery pass must use this same immutable visibility snapshot for both confirmations. */
export function captureTourOwnerRoots(roots: readonly TourOwnerRoot[] = [{ path: SESSIONS_DIR, flat: false }, ...extraSessionRoots().map(path => ({ path, flat: true }))]): readonly TourOwnerRoot[] {
  return Object.freeze(roots.map(root => Object.freeze({ path: root.path, flat: root.flat })));
}
/** Unlike sidebar listing, includes zero-input chats; uncertainty must never authorize cleanup. */
export async function scanTourOwnerFiles(roots: readonly TourOwnerRoot[] = captureTourOwnerRoots(), options: TourOwnerScanOptions = {}): Promise<TourOwnerScan> {
  const result: TourOwnerScan = { files: [], complete: true };
  const readDirectory = options.readDirectory ?? ((path: string) => readdir(path, { withFileTypes: true }));
  const scan = async (path: string, flat: boolean): Promise<void> => {
    try {
      // A missing root may be detached, moved or offline; it never establishes owner absence.
      containedPath(path, path, true);
      if (!(await lstat(path)).isDirectory()) { result.complete = false; return; }
      const entries = await readDirectory(path);
      containedPath(path, path);
      for (const entry of entries) {
        const file = join(path, entry.name), transcript = entry.name.endsWith(".jsonl");
        if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) { result.complete = false; continue; }
        if (entry.isFile() && transcript) result.files.push(file);
        else if (transcript) result.complete = false;
        else if (!flat && entry.isDirectory() && entry.name !== "live") await scan(file, true);
      }
    } catch { result.complete = false; }
  };
  for (const root of roots) await scan(root.path, root.flat);
  return result;
}
function tourOwnerHeaderSync(file: string): HHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(16 * 1024), count = readSync(fd, buffer, 0, buffer.length, 0), end = buffer.subarray(0, count).indexOf(10);
    return lineHeader(buffer.subarray(0, end < 0 ? count : end));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Reads only the bounded neutral header, never a whole conversation or a caller-provided cwd. */
export async function tourOwnerHeader(file: string): Promise<HHeader | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(16 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    return lineHeader(buffer.subarray(0, end < 0 ? bytesRead : end));
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}
export function tourOwnerCurrent(sessionId: string, path = ownerFiles.get(`${stateRoot()}:${sessionId}`) ?? indexedSessionPaths().get(sessionId)): boolean {
  if (!isTourSession(sessionId) || !path || isTourSessionDeleted(stateRoot(), sessionId)) return false;
  return resolveSessionPath(path) === path && tourOwnerHeaderSync(path)?.id === sessionId && !isTourSessionDeleted(stateRoot(), sessionId);
}
export async function tourOwnerPath(sessionId: string, remember: typeof rememberTourOwner = rememberTourOwner): Promise<string | null> {
  if (!isTourSession(sessionId) || isTourSessionDeleted(stateRoot(), sessionId)) return null;
  const cacheKey = `${stateRoot()}:${sessionId}`;
  const cached = ownerFiles.get(cacheKey) ?? indexedSessionPaths().get(sessionId), paths = cached ? [cached] : [];
  const keep = async (path: string) => { await remember(sessionId, path); if (!tourOwnerCurrent(sessionId, path)) { ownerFiles.delete(cacheKey); return null; } ownerFiles.delete(cacheKey); ownerFiles.set(cacheKey, path); if (ownerFiles.size > 2000) { const oldest = ownerFiles.keys().next().value; if (oldest) ownerFiles.delete(oldest); } return path; };
  const check = async (path: string): Promise<string | null> => {
    const resolved = resolveSessionPath(path);
    if (!resolved || !existsSync(resolved)) return null;
    const header = await tourOwnerHeader(resolved);
    return header?.id === sessionId && !isTourSessionDeleted(stateRoot(), sessionId) && existsSync(resolved) && resolveSessionPath(path) === resolved ? resolved : null;
  };
  for (const path of paths) { const found = await check(path); if (found) return keep(found); }
  ownerFiles.delete(cacheKey);
  const scan = await scanTourOwnerFiles();
  for (const path of scan.files) if (idOf(path) === sessionId && path !== cached) { const found = await check(path); if (found) return keep(found); }
  return null;
}
