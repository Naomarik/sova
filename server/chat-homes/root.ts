/**
 * Where chat homes live (§app.chat-homes/location), and the path rules every reader of a home shares.
 *
 * A home is `<homes root>/<chat id>/`. The homes root is, in order:
 *   1. `$SOVA_CHAT_HOMES` when it is absolute (test harnesses, hermetic copies; never writes a marker),
 *   2. the folder the state root's marker (`<state root>/chat-homes.json`) names,
 *   3. `~/.local/state/sova/chats/<12 hex of sha256(canonical state root)>`.
 * Never keyed by `$HOME` alone: two agent dirs never share homes.
 *
 * Everything here except ensureChatHome, hasHome and listHomeIds is string-only (no syscall per call), so the path
 * checks on the session list's hot path stay as cheap as today's. The server is a home's only writer
 * (§app.chat-homes/sole-writer); isHomeOwnState is the shape rule Sova's own-state write guards use.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { chatStateRoot } from "../state-root";

/** The override's name (harnesses and hermetic copies set it for a server). */
export const HOMES_ENV = "SOVA_CHAT_HOMES";
/**
 * The resolved root a server hands each chat process it starts (CHAT_PROCESS_ENV: a server scrubs it at boot, so it
 * never reaches a server a chat's command starts). A chat process takes it first: a worker on its worktree's own agent
 * dir still finds its parent's home.
 */
export const CHAT_HOMES_ROOT_ENV = "SOVA_CHAT_HOMES_ROOT";
/**
 * The home a chat process's conversation is in (its own, or for a helper its top chat's: a helper's file is in the
 * same home), handed to each chat process whose conversation is in a home; unset otherwise. CHAT_PROCESS_ENV.
 */
export const CHAT_HOME_ENV = "SOVA_CHAT_HOME";
/** The state root's marker, naming its homes folder once the first home is made. */
export const MARKER_FILE = "chat-homes.json";
/** A home's own manifest. */
export const MANIFEST_FILE = "manifest.json";
export const LAYOUT_VERSION = 1;

export interface HomeManifest {
  v: 1;
  id: string;
  /** The canonical state root this home belongs to. */
  stateRoot: string;
  layout: number;
  /** The host the chat began on (org-holder.ts `hostIdentity`'s id when it has one, else the machine name). */
  device: { id: string; name: string };
  createdAt: string;
}

/** A path made canonical through its nearest existing ancestor, so a root that doesn't exist yet keeps one spelling. */
function canonicalDeep(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return abs;
      rest.push(basename(at));
      at = up;
    }
  }
}

/** The canonical state root (a chat process: its server's), memoized on its literal spelling (realpath once per spelling). */
let stateMemo: { literal: string; canonical: string } | null = null;
function canonicalStateRoot(): string {
  const literal = chatStateRoot();
  if (stateMemo?.literal !== literal) stateMemo = { literal, canonical: canonicalDeep(literal) };
  return stateMemo.canonical;
}

/** The default homes folder for a state root: its short hash under ~/.local/state/sova/chats. */
export function defaultHomesRoot(canonicalState: string, home: string = homedir()): string {
  const key = createHash("sha256").update(canonicalState).digest("hex").slice(0, 12);
  return join(home, ".local", "state", "sova", "chats", key);
}

const missingLogged = new Set<string>();
function readMarker(state: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(state, MARKER_FILE), "utf8")) as { homes?: unknown };
    if (typeof raw.homes !== "string" || !isAbsolute(raw.homes)) return null;
    if (!existsSync(raw.homes) && !missingLogged.has(raw.homes)) {
      missingLogged.add(raw.homes);
      console.warn(`[chat-homes] ${join(state, MARKER_FILE)} names ${raw.homes}, which is missing: chats with a home are not listed until it is back`);
    }
    return raw.homes;
  } catch {
    return null;
  }
}

/** Memo of the resolved root, keyed on what decides it (the override and the state root), so tests can move both. */
let rootMemo: { key: string; root: string; fromMarker: boolean } | null = null;

function resolveRoot(): { root: string; fromMarker: boolean; overridden: boolean } {
  const fromServer = process.env[CHAT_HOMES_ROOT_ENV];
  const override = fromServer && isAbsolute(fromServer) ? fromServer : process.env[HOMES_ENV];
  const state = canonicalStateRoot();
  const key = `${override ?? ""}\0${state}`;
  if (rootMemo?.key === key) return { root: rootMemo.root, fromMarker: rootMemo.fromMarker, overridden: !!override && isAbsolute(override) };
  let root: string;
  let fromMarker = false;
  if (override && isAbsolute(override)) root = canonicalDeep(override);
  else {
    const marked = readMarker(state);
    fromMarker = marked !== null;
    root = canonicalDeep(marked ?? defaultHomesRoot(state));
  }
  rootMemo = { key, root, fromMarker };
  return { root, fromMarker, overridden: !!override && isAbsolute(override) };
}

/** The homes root for this server's state root (canonical; may not exist yet). */
export const homesRoot = (): string => resolveRoot().root;

/** A chat's home folder. String only. */
export const chatHome = (id: string): string => join(homesRoot(), id);
/** A home's flat conversations folder: every conversation of the chat, under pi's own file names. */
export const homeSessionsDir = (id: string): string => join(homesRoot(), id, "sessions");

/** A session id that may name a home folder: pi's own id alphabet, no dots at the ends, no separators. */
const ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
export const isHomeId = (id: string): boolean => ID_RE.test(id) && id.length <= 128;

/** The path's parts below the homes root, or null when it isn't inside it. String only. */
function below(p: string): string[] | null {
  const root = homesRoot();
  if (!p.startsWith(root + sep)) return null;
  return p.slice(root.length + 1).split(sep);
}

/** The chat id whose home holds `p` (an absolute, canonical path), or null. String only. */
export function homeIdOfPath(p: string): string | null {
  const parts = below(p);
  return parts && parts[0] && isHomeId(parts[0]) ? parts[0] : null;
}

/** Exactly `<homes root>/<id>/sessions/<name>.jsonl`: a conversation of a homed chat. String only. */
export function isHomeSessionFile(p: string): boolean {
  const parts = below(p);
  return !!parts && parts.length === 3 && isHomeId(parts[0]!) && parts[1] === "sessions" && parts[2]!.endsWith(".jsonl") && !parts[2]!.startsWith(".");
}

/** The home holding a conversation file (`<homes>/<id>/sessions/<file>.jsonl`), or null. String only. */
export function homeOfSessionFile(p: string): string | null {
  return isHomeSessionFile(p) ? join(homesRoot(), homeIdOfPath(p)!) : null;
}

/** Every home's `sessions/` folder, for the session feed's scoped watch (§app.session-list/live-watch-scope). */
export const homeSessionsDirs = (): string[] => listHomeIds().map(homeSessionsDir);

/** Exactly `<homes root>/<id>/sessions`: a home's conversations folder. String only. */
export function isHomeSessionsDir(dir: string): boolean {
  const parts = below(dir);
  return !!parts && parts.length === 2 && isHomeId(parts[0]!) && parts[1] === "sessions";
}

/**
 * The own-state guards' shape rule (§app.chat-homes/sole-writer): true for the homes root itself and anything in it,
 * except a home's tool-writable `shared/` (and what is below it). `p` must be absolute; resolve it first.
 */
export function isHomeOwnState(p: string): boolean {
  const abs = resolve(p);
  const root = homesRoot();
  if (abs === root) return true;
  const parts = below(abs);
  if (!parts) return false;
  return !(parts.length >= 2 && parts[1] === "shared");
}

/** Ids whose manifest was read and names this state root (homes are never re-pointed while a server runs). */
const knownHomes = new Map<string, Set<string>>();
const known = (): Set<string> => {
  const root = homesRoot();
  let set = knownHomes.get(root);
  if (!set) knownHomes.set(root, (set = new Set()));
  return set;
};

/** The manifest of a home, or null when missing or unreadable. */
export function readHomeManifest(id: string): HomeManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(chatHome(id), MANIFEST_FILE), "utf8")) as HomeManifest;
    return raw && raw.v === 1 && raw.id === id && typeof raw.stateRoot === "string" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Whether the chat has a home of this state root. A positive answer is kept; a negative one re-reads (a home is made
 * once, never unmade except by Delete, which calls forgetHome).
 */
export function hasHome(id: string): boolean {
  if (!isHomeId(id)) return false;
  const set = known();
  if (set.has(id)) return true;
  const m = readHomeManifest(id);
  if (!m || m.stateRoot !== canonicalStateRoot()) return false;
  set.add(id);
  return true;
}

/** After a Delete removed a home. */
export function forgetHome(id: string): void {
  known().delete(id);
}

/** This host as org-holder.ts names it (`<state root>/host.json`'s id, its machine name), read without making one. */
function thisDevice(): { id: string; name: string } {
  let id = "";
  try {
    const raw = JSON.parse(readFileSync(join(canonicalStateRoot(), "host.json"), "utf8")) as { id?: unknown };
    if (typeof raw.id === "string") id = raw.id;
  } catch {
    // none yet
  }
  const name = hostname();
  return { id: id || name, name: name || id };
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Make the chat's home (idempotent): the folder, its manifest, its `sessions/`, and the state root's marker the first
 * time (never with the override set, so a harness can't point real state at scratch). Returns the home's folder.
 */
export function ensureChatHome(id: string): string {
  if (!isHomeId(id)) throw new Error(`not a chat id for a home: ${JSON.stringify(id)}`);
  const { root, fromMarker, overridden } = resolveRoot();
  const home = join(root, id);
  if (!known().has(id) || !existsSync(join(home, "sessions"))) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    if (!existsSync(join(home, MANIFEST_FILE))) {
      const device = thisDevice();
      const manifest: HomeManifest = { v: 1, id, stateRoot: canonicalStateRoot(), layout: LAYOUT_VERSION, device: { id: device.id, name: device.name }, createdAt: new Date().toISOString() };
      writeJsonAtomic(join(home, MANIFEST_FILE), manifest);
    }
    known().add(id);
  }
  if (!overridden && !fromMarker) {
    const state = canonicalStateRoot();
    mkdirSync(state, { recursive: true });
    writeJsonAtomic(join(state, MARKER_FILE), { v: 1, homes: root });
    rootMemo = null; // the marker decides from now on
  }
  return home;
}

/** Every home of this state root, by id (one readdir plus each unknown home's manifest once). */
export function listHomeIds(): string[] {
  let names: string[];
  try {
    names = readdirSync(homesRoot());
  } catch {
    return [];
  }
  return names.filter(hasHome);
}

/** Tests only: forget the memos (the override or the state root moved under a running process). */
export function resetHomesMemoForTests(): void {
  rootMemo = null;
  stateMemo = null;
  knownHomes.clear();
  missingLogged.clear();
}
