/**
 * The Chats folder move (Settings → General, "Chats · this computer"; §app.chat-homes/chats-folder): every chat home of
 * this state root, and everything else in the homes folder (compressed chats' `<id>.tar.gz` and their records), copied
 * to another folder, each file checked by sha256, then the marker written last and the running server switched to it.
 *
 * - Refused while the folder is set by a variable, while any chat or helper is working, and while another move runs.
 * - At the start: new chats and opens are held (moveHold), every program reading chats stops, and every chat process
 *   stops, idle ones included (each was handed the old folder). They start again on the new folder after the switch.
 * - Each file is copied in chunks to `<name>.sova-part`, flushed, read back and hashed, then renamed into place with its
 *   own mode and times; a path inside it naming the old folder (a helper's record, a conversation's header, a compressed
 *   chat's record) is rewritten to the new one (the conversation's words never are). Each checked file is journaled in
 *   the new folder (`.sova-move.journal`), so a move the server's stop interrupted resumes from the files already checked.
 * - Before the switch, the old folder is walked again (in one synchronous pass at the end, so no write of this process
 *   lands between it and the marker) and anything changed is copied again. The marker (`<state root>/chat-homes.json`)
 *   is then written atomically, naming the new folder and the old one (`movedFrom`), and the server takes the new folder
 *   (switchHomesRoot, then the deps' afterSwitch: helpers' records, the chat list, its watchers).
 * - The old folder is kept as it was: nothing in it is deleted. Cancel stops a move before its switch; the partial copy
 *   it made goes, the old folder stays in force.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statfsSync, symlinkSync, utimesSync, writeFileSync, writeSync, accessSync, appendFileSync, realpathSync, chmodSync } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, rm, symlink, utimes, chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ChatsFolderInfo, ChatsFolderMove, ChatsFolderPreview } from "../../shared/chats-folder";
import { JOBS_DIR_NAME, readAllJobs, runningJobs, type JobRecord } from "../../pi-config/extensions/subagents/job-store.ts";
import { WAKE_DIR_NAME } from "../../pi-config/extensions/subagents/wake-store.ts";
import { mapDeep, relocateConversation, type PathMap } from "../harness/pi/relocate";
import { agentRoot, stateRoot } from "../state-root";
import { markOwned, RECENT_WRITE_MS, recentForeignWriteAgeSec } from "../write-guard";
import { isDeviceLocalHomesFile } from "./changes";
import { homesRoot, homesRootInfo, isHomeId, listHomeIds, previousHomesRoots, switchHomesRoot, writeMarker } from "./root";

export const MOVE_STATE_FILE = "chat-homes-move.json";
export const JOURNAL_FILE = ".sova-move.journal";
const PART = ".sova-part";
/** The folder made inside a chosen folder that already holds files. */
export const SUBFOLDER = "sova-chats";
const CHUNK = 1 << 20;

export interface MoveDeps {
  /** The chats and helpers running a turn now: their titles (or paths). */
  working(): string[];
  /** Whether a background job whose record hasn't ended still runs (its unit or cgroup); left out, every such record counts. */
  jobAlive?(job: JobRecord): Promise<boolean>;
  /** Stop every chat process, idle ones included; resolves to how many are left. */
  stopChats(message: string): Promise<number>;
  /** Stop the programs that read chats, and start them again. */
  holdReaders(): Promise<string[]>;
  releaseReaders(): Promise<void>;
  /** After the marker names the new folder and the root memos are cleared: the server's own state of the homes. */
  afterSwitch(oldRoot: string, newRoot: string): Promise<void>;
  log(line: string): void;
}

// ---- the state file -----------------------------------------------------------------------------------------------

const stateFile = (): string => join(stateRoot(), MOVE_STATE_FILE);

function readState(): ChatsFolderMove | null {
  try {
    const v = JSON.parse(readFileSync(stateFile(), "utf8")) as ChatsFolderMove;
    return v && typeof v.id === "string" && typeof v.from === "string" && typeof v.to === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeState(m: ChatsFolderMove): void {
  mkdirSync(stateRoot(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(tmp, stateFile());
}

/** The move running in this process, if any. */
let running: { move: ChatsFolderMove; cancel: boolean; done: Promise<void>; savedAt: number } | null = null;

const ACTIVE = new Set(["stopping", "copying", "switching"]);

/** Why a chat can't open or be made now: a move is running (until its switch or its cancel). */
export function moveHold(): string | null {
  const m = running?.move;
  return m && ACTIVE.has(m.phase) ? `Your chats are moving to ${m.to}. Chats open again when the move is done.` : null;
}

export const currentMove = (): ChatsFolderMove | null => running?.move ?? readState();

function save(force = false): void {
  if (!running) return;
  const now = Date.now();
  if (!force && now - running.savedAt < 1000) return;
  running.savedAt = now;
  writeState(running.move);
}

// ---- reading folders ----------------------------------------------------------------------------------------------

/** A path made canonical through its nearest existing ancestor. */
function canonical(p: string): string {
  const rest: string[] = [];
  let at = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(p);
      rest.push(basename(at));
      at = up;
    }
  }
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function nearestExisting(p: string): string {
  let at = p;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return at;
    at = up;
  }
  return at;
}

const emptyOrNew = (p: string): boolean => {
  try {
    return readdirSync(p).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
};

interface Entry {
  rel: string;
  kind: "file" | "link";
  size: number;
  mtimeMs: number;
}

/** Top-level names that are this device's alone (the change log and its index, rebuilt in the new folder by one walk;
    a move's own journal): never copied. */
const deviceLocal = (name: string): boolean => isDeviceLocalHomesFile(name) || name === JOURNAL_FILE;

/** Every file and link under the homes folder, by path relative to it (the device-local top-level files left out). */
function walkSync(root: string): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!rel && deviceLocal(name)) continue;
      if (name.endsWith(PART)) continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.push({ rel: r, kind: "file", size: st.size, mtimeMs: st.mtimeMs });
      else if (st.isSymbolicLink()) out.push({ rel: r, kind: "link", size: 0, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, "");
  return out;
}

async function walkAsync(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!rel && deviceLocal(name)) continue;
      if (name.endsWith(PART)) continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile()) out.push({ rel: r, kind: "file", size: st.size, mtimeMs: st.mtimeMs });
      else if (st.isSymbolicLink()) out.push({ rel: r, kind: "link", size: 0, mtimeMs: st.mtimeMs });
    }
  };
  await walk(root, "");
  return out;
}

/** The chats a folder holds: its homes and its compressed chats. */
function chatCount(root: string, entries: readonly Entry[]): number {
  const ids = new Set<string>();
  for (const e of entries) {
    const top = e.rel.split("/")[0]!;
    if (e.rel.includes("/") && isHomeId(top)) ids.add(top);
    else if (top.endsWith(".tar.gz") && isHomeId(top.slice(0, -7))) ids.add(top.slice(0, -7));
  }
  return root === homesRoot() ? Math.max(ids.size, listHomeIds().length) : ids.size;
}

// ---- where a folder may go ------------------------------------------------------------------------------------------

/** The live-sync service a folder is in, by its folders' names and markers (Syncthing's `.stfolder`). */
export function liveSyncOf(p: string): string | undefined {
  const parts = canonical(p).split(sep).filter(Boolean);
  for (const name of parts) {
    if (/^Dropbox(\b|$)/i.test(name) || name === ".dropbox") return "Dropbox";
    if (name === "Mobile Documents" || name === "com~apple~CloudDocs" || /^iCloud ?Drive/i.test(name)) return "iCloud Drive";
    if (/^OneDrive(\b|$)/i.test(name)) return "OneDrive";
    if (/^Google ?Drive/i.test(name) || name === "My Drive") return "Google Drive";
  }
  for (let i = parts.length; i >= 0; i--) {
    const dir = `/${parts.slice(0, i).join("/")}`;
    if (existsSync(join(dir, ".stfolder"))) return "Syncthing";
    if (existsSync(join(dir, ".dropbox")) || existsSync(join(dir, ".dropbox.cache"))) return "Dropbox";
  }
  return undefined;
}

function freeAt(p: string): number | null {
  try {
    const s = statfsSync(nearestExisting(p));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} bytes`);

/** The folder a move to `picked` copies into: `picked` when it is empty or new, else a new `sova-chats` inside it. */
export function targetOf(picked: string): string {
  const p = canonical(picked);
  // The folder in force itself: refused as it is, never a sova-chats inside it.
  if (emptyOrNew(p) || p === homesRoot()) return p;
  return join(p, SUBFOLDER);
}

/** Why the folder can't be changed here at all (a variable sets it), or null. */
function lockedWhy(): string | null {
  const info = homesRootInfo();
  return info.source === "env" ? `${info.env} sets your chats folder, so it can't be changed here. Change the variable and restart Sova instead.` : null;
}

/**
 * The background jobs a chat started that still run in the chats folder (§app.chat-homes/chats-folder): a job keeps the
 * environment of the chat that started it (its home, its shared folder) and its record names the chat's file there, so
 * after the switch it would go on writing the old folder. Their commands, for the refusal.
 */
export async function jobsInFolder(from: string, alive?: (job: JobRecord) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const j of runningJobs(readAllJobs(join(stateRoot(), JOBS_DIR_NAME)))) {
    if (![j.path, j.cwd, j.output, j.scratch].some((p) => typeof p === "string" && within(p, from))) continue;
    if (alive && !(await alive(j).catch(() => true))) continue;
    out.push(j.command);
  }
  return out;
}

function refusalFor(target: string, bytes: number, deps: Pick<MoveDeps, "working"> | null, resuming: boolean, jobs: readonly string[] = []): string | null {
  const locked = lockedWhy();
  if (locked) return locked;
  if (running && ACTIVE.has(running.move.phase)) return `Your chats are already moving to ${running.move.to}.`;
  const from = homesRoot();
  if (!existsSync(from)) return `Your chats folder ${from} is missing, so there's nothing to move. Reconnect it, then try again.`;
  if (target === from) return "Your chats are in that folder already.";
  if (within(target, from)) return "That folder is inside your chats folder. Pick one outside it.";
  if (within(from, target)) return "Your chats folder is inside that folder. Pick an empty folder, or a new one.";
  const sessions = canonical(join(agentRoot(), "sessions"));
  if (within(target, sessions)) return "That folder is inside pi's own sessions folder, where every chat would be listed twice. Pick another.";
  if (!resuming && !emptyOrNew(target)) return `${target} already holds files. Pick an empty folder, or a new one.`;
  try {
    accessSync(nearestExisting(target), constants.W_OK);
  } catch {
    return `Sova can't write in ${nearestExisting(target)}. Pick a folder you own.`;
  }
  const free = freeAt(target);
  if (free !== null && free < bytes + 64 * 1024 * 1024) return `That disk has ${fmtBytes(free)} free, and your chats need ${fmtBytes(bytes)}. Nothing was moved.`;
  const busy = deps?.working() ?? [];
  if (busy.length) return `${busy.length === 1 ? "1 chat is" : `${busy.length} chats are`} working: ${busy.slice(0, 3).join(", ")}${busy.length > 3 ? "…" : ""}. Wait for ${busy.length === 1 ? "it" : "them"} to finish or stop ${busy.length === 1 ? "it" : "them"}, then move.`;
  if (jobs.length) {
    const one = jobs.length === 1;
    return `${one ? "1 background job" : `${jobs.length} background jobs`} that chats started ${one ? "is" : "are"} still running: ${jobs.slice(0, 3).map((c) => (c.length > 60 ? `${c.slice(0, 59)}…` : c)).join(", ")}${jobs.length > 3 ? "…" : ""}. ${one ? "It writes" : "They write"} in your chats folder, so stop ${one ? "it" : "them"} in ${one ? "its chat" : "their chats"}, then move.`;
  }
  return null;
}

const interruptedTo = (target: string): boolean => {
  const s = readState();
  return !!s && s.phase === "interrupted" && s.to === target && s.from === homesRoot();
};

export function chatsFolderInfo(): ChatsFolderInfo {
  const info = homesRootInfo();
  const move = currentMove();
  const locked = lockedWhy() ?? (running && ACTIVE.has(running.move.phase) ? "Your chats are moving now." : null);
  const prev = previousHomesRoots();
  return { path: info.root, source: info.source, ...(info.env ? { env: info.env } : {}), exists: info.exists, ...(locked ? { locked } : {}), ...(move ? { move } : {}), ...(prev.length ? { movedFrom: prev } : {}) };
}

export async function previewMove(picked: string, deps: Pick<MoveDeps, "working" | "jobAlive"> | null): Promise<ChatsFolderPreview> {
  if (!picked || !isAbsolute(picked)) return { target: picked, chats: 0, files: 0, bytes: 0, free: null, refusal: "Pick a folder." };
  const from = homesRoot();
  const target = interruptedTo(canonical(picked)) ? canonical(picked) : targetOf(picked);
  const entries = existsSync(from) ? await walkAsync(from) : [];
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  const sync = liveSyncOf(target);
  const jobs = existsSync(from) ? await jobsInFolder(from, deps?.jobAlive) : [];
  const refusal = refusalFor(target, bytes, deps, interruptedTo(target), jobs);
  return { target, chats: chatCount(from, entries), files: entries.length, bytes, free: freeAt(target), ...(sync ? { liveSync: sync } : {}), ...(refusal ? { refusal } : {}) };
}

// ---- copying one file -----------------------------------------------------------------------------------------------

interface JournalLine {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  /** The copy's size once its paths were rewritten. */
  out: number;
}

function readJournal(to: string): Map<string, JournalLine> {
  const out = new Map<string, JournalLine>();
  let text = "";
  try {
    text = readFileSync(join(to, JOURNAL_FILE), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const j = JSON.parse(line) as JournalLine;
      if (typeof j.rel === "string") out.set(j.rel, j);
    } catch {
      // a torn last line: that file is copied again
    }
  }
  return out;
}

/** Whether a copied file's text may name the homes folder, and how to rewrite it. */
function rewriteKind(rel: string): "conversation" | "json" | null {
  const parts = rel.split("/");
  if (parts.length === 1) return rel.endsWith(".json") ? "json" : null;
  if (!isHomeId(parts[0]!)) return null;
  if (parts[1] === "sessions" && parts.length === 3 && rel.endsWith(".jsonl")) return "conversation";
  if (!rel.endsWith(".json")) return null;
  if (parts.length === 2) return "json"; // home.json, index.json
  return ["workers", "teams", "wakes", "chat", "usage"].includes(parts[1]!) ? "json" : null;
}

/** The text of a copied file with every path under the old folder moved to the new one; null when nothing changes. */
function rewritten(kind: "conversation" | "json", text: string, map: PathMap): string | null {
  if (!text.includes(map[0]![0])) return null;
  if (kind === "conversation") return relocateConversation(text, map);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const next = mapDeep(v, map);
  if (JSON.stringify(next) === JSON.stringify(v)) return null;
  return `${JSON.stringify(next, null, text.includes('\n  "') ? 2 : undefined)}${text.endsWith("\n") ? "\n" : ""}`;
}

const hashSync = (file: string): string => {
  const h = createHash("sha256");
  const fd = openSync(file, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
};

async function hashAsync(file: string, cancelled: () => boolean): Promise<string> {
  const h = createHash("sha256");
  const fh = await open(file, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      if (cancelled()) throw new Cancelled();
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead <= 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Copy one file (chunks, flushed), read it back, compare the hashes, then rewrite its paths and rename it in place. */
async function copyOne(from: string, to: string, e: Entry, map: PathMap, cancelled: () => boolean, onBytes: (n: number) => void): Promise<JournalLine> {
  const src = join(from, e.rel);
  const dst = join(to, e.rel);
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
  if (e.kind === "link") {
    const target = await readlink(src);
    await rm(dst, { force: true });
    await symlink(target, dst);
    return { rel: e.rel, size: 0, mtimeMs: e.mtimeMs, sha256: createHash("sha256").update(target).digest("hex"), out: 0 };
  }
  for (let attempt = 0; ; attempt++) {
    const before = await lstat(src);
    const part = dst + PART;
    const h = createHash("sha256");
    const r = await open(src, "r");
    const w = await open(part, "w", before.mode & 0o777);
    let size = 0;
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        if (cancelled()) throw new Cancelled();
        const { bytesRead } = await r.read(buf, 0, CHUNK, null);
        if (bytesRead <= 0) break;
        h.update(buf.subarray(0, bytesRead));
        await w.write(buf, 0, bytesRead);
        size += bytesRead;
        onBytes(bytesRead);
      }
      await w.sync();
    } finally {
      await r.close();
      await w.close();
    }
    const sha = h.digest("hex");
    const back = await hashAsync(part, cancelled);
    if (back !== sha) throw new Error(`${e.rel}: the copy doesn't match the original (sha256 ${back.slice(0, 12)} ≠ ${sha.slice(0, 12)})`);
    const after = await lstat(src);
    // Written while it was copied: copied again (a stopped chat writes nothing; the server's own records may).
    if ((after.size !== before.size || after.mtimeMs !== before.mtimeMs) && attempt < 3) continue;
    let out = size;
    const kind = rewriteKind(e.rel);
    if (kind && size < 256 * 1024 * 1024) {
      const next = rewritten(kind, readFileSync(part, "utf8"), map);
      if (next !== null) {
        writeFileSync(part, next);
        out = Buffer.byteLength(next);
      }
    }
    await chmod(part, before.mode & 0o777);
    await utimes(part, before.atime, before.mtime);
    await rename(part, dst);
    return { rel: e.rel, size: before.size, mtimeMs: before.mtimeMs, sha256: sha, out };
  }
}

/** The same, synchronously: the last pass before the marker, which no write of this process can interleave. */
function copyOneSync(from: string, to: string, e: Entry, map: PathMap): JournalLine {
  const src = join(from, e.rel);
  const dst = join(to, e.rel);
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  if (e.kind === "link") {
    const target = readlinkSync(src);
    rmSync(dst, { force: true });
    symlinkSync(target, dst);
    return { rel: e.rel, size: 0, mtimeMs: e.mtimeMs, sha256: createHash("sha256").update(target).digest("hex"), out: 0 };
  }
  const st = lstatSync(src);
  const part = dst + PART;
  const h = createHash("sha256");
  const r = openSync(src, "r");
  const w = openSync(part, "w", st.mode & 0o777);
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = readSync(r, buf, 0, CHUNK, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      writeSync(w, buf, 0, n);
    }
    fsyncSync(w);
  } finally {
    closeSync(r);
    closeSync(w);
  }
  const sha = h.digest("hex");
  if (hashSync(part) !== sha) throw new Error(`${e.rel}: the copy doesn't match the original`);
  let out = st.size;
  const kind = rewriteKind(e.rel);
  if (kind) {
    const next = rewritten(kind, readFileSync(part, "utf8"), map);
    if (next !== null) {
      writeFileSync(part, next);
      out = Buffer.byteLength(next);
    }
  }
  chmodSync(part, st.mode & 0o777);
  utimesSync(part, st.atime, st.mtime);
  renameSync(part, dst);
  return { rel: e.rel, size: st.size, mtimeMs: st.mtimeMs, sha256: sha, out };
}

/** Whether the journal's line for `e` still stands: the original unchanged and the copy there, as it was left. */
function stillCopied(to: string, e: Entry, j: JournalLine | undefined): boolean {
  if (!j || j.size !== e.size || j.mtimeMs !== e.mtimeMs) return false;
  try {
    const st = lstatSync(join(to, e.rel));
    return e.kind === "link" ? st.isSymbolicLink() : st.isFile() && st.size === j.out;
  } catch {
    return false;
  }
}

// ---- after the marker ---------------------------------------------------------------------------------------------

/**
 * The state root's records that name a chat's files by their place in the homes folder, rewritten to the new folder:
 * compressed chats (`compressed-sessions.json`), shares (`session-shares.json`), Transport's records, background jobs'
 * records, the state root's wake records and crash-resume markers. (`owned-writes.json` keeps the old files' stamps,
 * which guard only them; the moved conversations written moments ago are marked in the new folder.) Run after
 * the marker names it, and again at a start that finds a move switched but not finished: a second run changes nothing.
 */
export function rewriteStateRecords(from: string, to: string): number {
  const map: PathMap = [[from, to]];
  const state = stateRoot();
  const files = [join(state, "compressed-sessions.json"), join(state, "session-shares.json")];
  const jsonIn = (dir: string, depth = 1) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // none
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".json")) files.push(p);
      else if (depth > 1) jsonIn(p, depth - 1);
    }
  };
  // Transport's records, the background jobs' (by chat), the state root's own wake records (and their cancels), and
  // a crashed chat's resume marker: each names a chat's file by its place.
  jsonIn(join(state, "transport"));
  jsonIn(join(state, JOBS_DIR_NAME), 2);
  jsonIn(join(state, WAKE_DIR_NAME), 2);
  jsonIn(join(state, "chats", "inflight"));
  let n = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const next = rewritten("json", text, map);
    if (next === null) continue;
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, f);
    n++;
  }
  return n;
}

// ---- the move -----------------------------------------------------------------------------------------------------

const STOP_MESSAGE = "Sova is moving your chats to a new folder. This chat opens again when the move is done.";

export type StartAnswer = { ok: true; move: ChatsFolderMove } | { ok: false; status: 409 | 400; error: string };

/** Start a move to `picked` (or resume an interrupted one to it). The copy runs on; its progress is currentMove(). */
export async function startMove(picked: string, deps: MoveDeps): Promise<StartAnswer> {
  if (!picked || !isAbsolute(picked)) return { ok: false, status: 400, error: "Pick a folder." };
  const resuming = interruptedTo(canonical(picked));
  const to = resuming ? canonical(picked) : targetOf(picked);
  const from = homesRoot();
  const entries = existsSync(from) ? await walkAsync(from) : [];
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  const jobs = existsSync(from) ? await jobsInFolder(from, deps.jobAlive) : [];
  const why = refusalFor(to, bytes, deps, resuming, jobs);
  if (why) return { ok: false, status: 409, error: why };
  const prior = resuming ? readState() : null;
  const move: ChatsFolderMove = {
    id: prior?.id ?? randomUUID(),
    from,
    to,
    phase: "stopping",
    startedAt: new Date().toISOString(),
    chats: chatCount(from, entries),
    files: entries.length,
    bytes,
    copiedFiles: 0,
    copiedBytes: 0,
  };
  let resolveDone!: () => void;
  running = { move, cancel: false, done: new Promise((r) => (resolveDone = r)), savedAt: 0 };
  // The folder made by this move (not one that was there, empty): a cancel removes it again.
  const made = !existsSync(to) || prior?.made === true;
  move.made = made;
  save(true);
  void run(move, deps, made)
    .catch((err: unknown) => deps.log(`chats folder move failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(resolveDone);
  return { ok: true, move };
}

/** Cancel the running move before its switch. False when there is none to cancel (or it is switching). */
export function cancelMove(): boolean {
  if (!running || (running.move.phase !== "stopping" && running.move.phase !== "copying")) return false;
  running.cancel = true;
  return true;
}

/** Tests: the running move's end. */
export const moveSettled = (): Promise<void> => running?.done ?? Promise.resolve();

async function run(move: ChatsFolderMove, deps: MoveDeps, made: boolean): Promise<void> {
  const cancelled = () => running?.cancel === true;
  const { from, to } = move;
  const map: PathMap = [[from, to]];
  let readersHeld = false;
  const finish = async (phase: "done" | "cancelled" | "failed", error?: string) => {
    move.phase = phase;
    move.finishedAt = new Date().toISOString();
    if (error) move.error = error;
    else delete move.error;
    save(true);
    if (readersHeld) await deps.releaseReaders().catch((err: unknown) => deps.log(`programs reading chats didn't start again: ${String(err)}`));
  };
  try {
    readersHeld = true;
    const held = await deps.holdReaders();
    if (held.length) deps.log(`stopped ${held.length} program(s) reading chats for the move: ${held.join(", ")}`);
    const left = await deps.stopChats(STOP_MESSAGE);
    if (left > 0) throw new Error(`${left} chat process${left === 1 ? "" : "es"} didn't stop, so nothing was moved.`);
    // Something may have started working between the check and the stop: it was stopped, its turn interrupted.
    if (cancelled()) throw new Cancelled();
    move.phase = "copying";
    save(true);
    await mkdir(to, { recursive: true, mode: 0o700 });
    const journal = readJournal(to);
    const journalFile = join(to, JOURNAL_FILE);
    const copyPass = async (entries: Entry[]): Promise<number> => {
      let copied = 0;
      for (const e of entries) {
        if (cancelled()) throw new Cancelled();
        if (stillCopied(to, e, journal.get(e.rel))) continue;
        const line = await copyOne(from, to, e, map, cancelled, (n) => {
          move.copiedBytes += n;
          save();
        });
        journal.set(e.rel, line);
        appendFileSync(journalFile, `${JSON.stringify(line)}\n`);
        copied++;
      }
      return copied;
    };
    // The first pass, counting what an earlier, interrupted run already checked.
    const first = await walkAsync(from);
    move.files = first.length;
    move.bytes = first.reduce((n, e) => n + e.size, 0);
    move.copiedFiles = 0;
    move.copiedBytes = 0;
    for (const e of first)
      if (stillCopied(to, e, journal.get(e.rel))) {
        move.copiedFiles++;
        move.copiedBytes += e.size;
      }
    save(true);
    for (const e of first) {
      if (cancelled()) throw new Cancelled();
      if (stillCopied(to, e, journal.get(e.rel))) continue;
      const line = await copyOne(from, to, e, map, cancelled, (n) => {
        move.copiedBytes += n;
        save();
      });
      journal.set(e.rel, line);
      appendFileSync(journalFile, `${JSON.stringify(line)}\n`);
      move.copiedFiles++;
    }
    // Again, until a pass finds nothing changed (the server's own records may have been written meanwhile).
    for (let i = 0; i < 3 && (await copyPass(await walkAsync(from))) > 0; i++);
    if (cancelled()) throw new Cancelled();
    // The switch, in one synchronous run: the last check of the old folder, the marker, the root memos.
    move.phase = "switching";
    save(true);
    const last = walkSync(from);
    const seen = new Set(last.map((e) => e.rel));
    for (const e of last) {
      if (stillCopied(to, e, journal.get(e.rel))) continue;
      const line = copyOneSync(from, to, e, map);
      journal.set(e.rel, line);
      appendFileSync(journalFile, `${JSON.stringify(line)}\n`);
    }
    // A file gone from the old folder since its copy (a helper's temporary file): gone from the new one too.
    for (const rel of journal.keys()) if (!seen.has(rel)) rmSync(join(to, rel), { force: true });
    move.files = last.length;
    move.copiedFiles = last.length;
    move.copiedBytes = move.bytes = last.reduce((n, e) => n + e.size, 0);
    writeMarker(to, [from, ...previousHomesRoots()]);
    switchHomesRoot();
    // A conversation Sova's own chat wrote moments ago is Sova's in the new folder too: its next open isn't taken for
    // another program's write (the foreign-write guard keys on the file's place).
    const recent = Date.now() - RECENT_WRITE_MS;
    for (const e of last)
      if (rewriteKind(e.rel) === "conversation" && e.mtimeMs > recent) {
        try {
          if (recentForeignWriteAgeSec(join(from, e.rel)) === null) markOwned(join(to, e.rel));
        } catch {
          // gone meanwhile
        }
      }
    rmSync(journalFile, { force: true });
    save(true);
    deps.log(`chats folder: ${from} → ${to} (${last.length} files checked); the old folder is kept`);
    const records = rewriteStateRecords(from, to);
    if (records) deps.log(`chats folder: ${records} state record(s) now name the new folder`);
    await deps.afterSwitch(from, to);
    await finish("done");
  } catch (err) {
    if (err instanceof Cancelled) {
      if (made) await rm(to, { recursive: true, force: true }).catch(() => {});
      else for (const e of await readdir(to).catch(() => [] as string[])) await rm(join(to, e), { recursive: true, force: true }).catch(() => {});
      deps.log(`chats folder move to ${to} cancelled; your chats stay in ${from}`);
      await finish("cancelled");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Past the marker, the new folder is in force: what failed after it is said, never undone.
    if (homesRoot() === to) {
      deps.log(`chats folder: switched to ${to}, then: ${msg}`);
      await finish("done", msg);
      return;
    }
    await finish("failed", `${msg} Your chats stay in ${from}.`);
  }
}

/**
 * At a server start: a move the last server was running when it stopped. Past its marker it is done (the state
 * records rewritten again, idempotently); before it, the old folder is still in force, and the move is interrupted:
 * Resume (the same Move Chats to the same folder) goes on from the files its journal checked.
 */
export function recoverMove(log: (line: string) => void): void {
  const s = readState();
  if (!s || !ACTIVE.has(s.phase)) return;
  if (homesRoot() === canonical(s.to)) {
    rewriteStateRecords(s.from, s.to);
    rmSync(join(s.to, JOURNAL_FILE), { force: true });
    writeState({ ...s, phase: "done", finishedAt: new Date().toISOString() });
    log(`chats folder: the move to ${s.to} had switched before the stop; it is done`);
    return;
  }
  writeState({ ...s, phase: "interrupted", error: `Sova stopped while your chats were being copied. They're still in ${s.from}.` });
  log(`chats folder: the move to ${s.to} was interrupted; your chats stay in ${s.from}`);
}

/** Tests only. */
export function resetMoveForTests(): void {
  running = null;
}
