import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chatHome, hasHome, homesRoot, listHomeIds } from "./root";
import { CHAT_HOME_ENV, setChatHomesRoot } from "../../pi-config/extensions/sandbox/shared-folder.ts";

// The shared folder's helper (pi-config, no server imports) asks the server's own homes folder.
setChatHomesRoot(homesRoot);

/**
 * A chat home's own records (§app.chat-homes/layout): `<home>/chat/{meta,seen,draft,signals}.json`,
 * written by the server alone. Each server-wide store keeps its file for chats without a home and,
 * for a key whose chat has one, keeps that key's entry in the home instead, under a field named after
 * the server-wide file and the map inside it (`"session-titles.json#titles"`), holding EXACTLY the
 * entry the server-wide store would have written. So putting a home back into the server-wide stores
 * (the rollback) is: merge each field's entries into that file's map.
 *
 * A key is a session id, or `<session id>:<suffix>` (a worker's signals, a card's follow-up). A home
 * holds the keys of its own chat and of every worker and team member under it (`homeOf`).
 *
 * The stores keep their shape: `withHome` lays the homes' entries over what the server-wide file
 * holds (an in-memory read: homes are read once, then kept by this module's own writes), and
 * `splitOut` takes the homed keys back out before the store writes its file, writing each home
 * whose entries changed (compared by content: a store may change an entry in place). The store
 * still writes its own file as before, unless it says which one key it changed (`only`) and that
 * key is homed. A store with no home at all pays one shallow copy per load.
 */

export type HomeDoc = "meta" | "seen" | "draft" | "signals";
export const HOME_DOCS: readonly HomeDoc[] = ["meta", "seen", "draft", "signals"];

/** The file of one home record; draft.json is the account's alone (it can hold a typed secret). */
export const homeDocFile = (homeId: string, doc: HomeDoc): string => join(chatHome(homeId), "chat", `${doc}.json`);

type Json = Record<string, unknown>;

interface HomeEntry {
  docs: Map<HomeDoc, Json>;
  /** What was last read or written per `doc|field`, serialised: a write happens only on a change. */
  written: Map<string, string>;
}

interface State {
  root: string;
  /** Every home's records read (the first store read or write). */
  loaded: boolean;
  /** Every home's `workers/` listed (the first question about an id not known yet). */
  membersLoaded: boolean;
  homes: Map<string, HomeEntry>;
  /** Worker or team member id → the home holding its records. */
  members: Map<string, string>;
}

let st: State | null = null;

function state(): State {
  const root = homesRoot();
  if (!st || st.root !== root) st = { root, loaded: false, membersLoaded: false, homes: new Map(), members: new Map() };
  return st;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function readDoc(homeId: string, doc: HomeDoc): Json {
  try {
    const v: unknown = JSON.parse(readFileSync(homeDocFile(homeId, doc), "utf8"));
    if (isObj(v)) return v;
  } catch {
    // missing or corrupt: empty
  }
  return { version: 1, id: homeId };
}

function loadHome(s: State, homeId: string): HomeEntry {
  const docs = new Map<HomeDoc, Json>();
  const written = new Map<string, string>();
  for (const doc of HOME_DOCS) {
    const d = readDoc(homeId, doc);
    docs.set(doc, d);
    for (const [field, v] of Object.entries(d)) if (field !== "version" && field !== "id") written.set(`${doc}|${field}`, JSON.stringify(v));
  }
  const entry: HomeEntry = { docs, written };
  s.homes.set(homeId, entry);
  listMembers(s, homeId);
  return entry;
}

function listMembers(s: State, homeId: string): void {
  try {
    for (const name of readdirSync(join(chatHome(homeId), "workers")))
      if (name.endsWith(".json")) s.members.set(name.slice(0, -5), homeId);
  } catch {
    // no workers yet
  }
}

function loaded(): State {
  const s = state();
  if (s.loaded) return s;
  s.loaded = s.membersLoaded = true;
  for (const id of listHomeIds()) if (!s.homes.has(id)) loadHome(s, id);
  return s;
}

/** Every home's members known, without reading its records (a chat process asks about one id). */
function membersLoaded(): State {
  const s = state();
  if (s.membersLoaded) return s;
  s.membersLoaded = true;
  for (const id of listHomeIds()) listMembers(s, id);
  return s;
}

/** Pick up homes this server did not make (a full list build; a home that arrived from outside). */
export function refreshHomeRecords(): void {
  const s = state();
  if (!s.loaded) return void loaded();
  for (const id of listHomeIds()) if (!s.homes.has(id)) loadHome(s, id);
}

/** Read one home's records again from disk (a home unpacked or rewritten outside this module). */
export function reloadHome(homeId: string): void {
  const s = state();
  s.homes.delete(homeId);
  for (const [m, h] of s.members) if (h === homeId) s.members.delete(m);
  if (hasHome(homeId)) {
    if (s.loaded) loadHome(s, homeId);
    else listMembers(s, homeId);
  }
}

/** Forget a home that was removed (Delete). */
export function forgetHomeRecords(homeId: string): void {
  const s = state();
  s.homes.delete(homeId);
  for (const [m, h] of s.members) if (h === homeId) s.members.delete(m);
}

/** The session id a store key names. */
export const keyId = (key: string): string => {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
};

function known(s: State, id: string): string | null {
  return s.members.get(id) ?? (s.homes.has(id) ? id : null);
}

/** Note a home this module had not seen yet (made after the first read). */
function adopt(s: State, id: string): string | null {
  if (!hasHome(id)) return null;
  if (!s.homes.has(id)) loadHome(s, id);
  return id;
}

/** The home that holds a chat's records: its own, or for a worker or team member its root chat's.
    null for a chat with no home (its records stay where they always were). */
export function homeOf(id: string): string | null {
  if (!id) return null;
  const s = state();
  const k = known(s, id);
  if (k) return k;
  if (hasHome(id)) {
    if (s.loaded && !s.homes.has(id)) loadHome(s, id);
    return id;
  }
  // A chat process knows its own home (SOVA_CHAT_HOME): a member's record there answers without listing every home.
  const own = process.env[CHAT_HOME_ENV];
  if (own && existsSync(join(own, "workers", `${id}.json`))) {
    const h = own.replace(/\/+$/, "").split("/").pop()!;
    s.members.set(id, h);
    return h;
  }
  if (s.membersLoaded) return null;
  return known(membersLoaded(), id);
}

/** The folder of `homeOf(id)`, or null. */
export function homeDirOf(id: string): string | null {
  const h = homeOf(id);
  return h ? chatHome(h) : null;
}

/** Each home's `chat/<kind>/` folder (whether it exists or not): a store that indexes every record lists these
    beside its own folder. */
export function homeRecordDirs(kind: "offers" | "cards"): string[] {
  return listHomeIds().map((id) => join(chatHome(id), "chat", kind));
}

/** A worker or team member started under a chat with a home: its records go to that home. The home is
    the root's, whatever the depth: a member's own members go to the same home. */
export function registerHomeMember(memberId: string, parentId: string): string | null {
  const home = homeOf(parentId);
  if (!home || !memberId || memberId === home) return home;
  state().members.set(memberId, home);
  return home;
}

/** The env a chat process gets when its chat, or the root chat above it, has a home: that home's folder. */
export { CHAT_HOME_ENV };

// ---- the stores' two hooks ------------------------------------------------------------------------

/** The server-wide map each merged map was built over: a key it held stays server-wide (only a new
    key may be a new home's, so splitOut asks the disk about new keys alone). */
const origins = new WeakMap<object, Json>();
const setOrigins = new WeakMap<Set<string>, Set<string>>();

/** Whether any home has entries in this field (the fast path skips the merge). */
function homesWith(s: State, doc: HomeDoc, field: string): HomeEntry[] {
  const out: HomeEntry[] = [];
  for (const h of s.homes.values()) if (h.docs.get(doc)?.[field] !== undefined) out.push(h);
  return out;
}

/** A store's map with every home's entries of `doc`/`field` laid over it. A fresh object, so the store
    may change it freely and hand it to splitOut. */
export function withHome<V>(legacy: Record<string, V>, doc: HomeDoc, field: string): Record<string, V> {
  const s = loaded();
  const out: Record<string, V> = Object.assign(Object.create(Object.getPrototypeOf(legacy)), legacy);
  for (const h of homesWith(s, doc, field)) {
    const m = h.docs.get(doc)![field];
    if (isObj(m)) Object.assign(out, m);
  }
  origins.set(out, legacy as Json);
  return out;
}

/** A store's set (archived ids, web ids) with every home's ids of `doc`/`field` added. */
export function withHomeSet(legacy: Set<string>, doc: HomeDoc, field: string): Set<string> {
  const s = loaded();
  const out = new Set(legacy);
  for (const h of homesWith(s, doc, field)) {
    const m = h.docs.get(doc)![field];
    if (Array.isArray(m)) for (const id of m) if (typeof id === "string") out.add(id);
  }
  setOrigins.set(out, legacy);
  return out;
}

function ownerOfKey(s: State, key: string, inLegacy: boolean): string | null {
  const id = keyId(key);
  const k = known(s, id);
  if (k) return k;
  // A key the server-wide file already held stays there; only a new key may be a new home's.
  return inLegacy ? null : adopt(s, id);
}

function writeHomeField(s: State, homeId: string, doc: HomeDoc, field: string, value: unknown): void {
  // A home removed by its chat's Delete is never made again by a late write.
  if (!hasHome(homeId)) return;
  const h = s.homes.get(homeId) ?? loadHome(s, homeId);
  const ser = value === undefined ? undefined : JSON.stringify(value);
  const tag = `${doc}|${field}`;
  if (h.written.get(tag) === ser) return;
  const file = homeDocFile(homeId, doc);
  // Re-read, change only this field: another field of the same file may have been written since.
  const next: Json = { ...readDoc(homeId, doc), version: 1, id: homeId };
  if (value === undefined) delete next[field];
  else next[field] = value;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: doc === "draft" ? 0o600 : 0o644 });
    renameSync(tmp, file);
    h.docs.set(doc, next);
    if (ser === undefined) h.written.delete(tag);
    else h.written.set(tag, ser);
  } catch (err) {
    console.warn(`[chat-homes] ${doc}.json write failed for ${homeId}:`, err instanceof Error ? err.message : String(err));
  }
}

/** Write each home whose entries of `doc`/`field` differ from what it holds; `byHome` is every home
    that has entries now (a home missing from it has none left). */
function writeHomes<T>(s: State, doc: HomeDoc, field: string, byHome: Map<string, T>, empty: (v: T) => boolean): void {
  for (const [homeId, h] of s.homes) {
    if (byHome.has(homeId)) continue;
    if (h.docs.get(doc)?.[field] !== undefined) writeHomeField(s, homeId, doc, field, undefined);
  }
  for (const [homeId, v] of byHome) writeHomeField(s, homeId, doc, field, empty(v) ? undefined : v);
}

/**
 * Take the homed keys out of a store's map before it writes its file: each home whose entries changed
 * is written here. Returns the server-wide part and whether it differs from what was loaded (false
 * only when the change was a homed key's alone, so the store can skip rewriting its file).
 */
export function splitOut<V>(
  next: Record<string, V>,
  doc: HomeDoc,
  field: string,
  opts: {
    /** The one key this write changed, when the store knows it: a homed one leaves the file alone. */
    only?: string;
    /** The entry as the server-wide file writes it, when the store keeps another form in memory. */
    toDisk?: (v: V) => unknown;
  } = {},
): { legacy: Record<string, V>; legacyChanged: boolean } {
  const s = loaded();
  const toDisk = opts.toDisk ?? ((v: V) => v);
  const orig = origins.get(next) as Record<string, V> | undefined;
  const legacy: Record<string, V> = Object.create(Object.getPrototypeOf(next));
  const byHome = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(next)) {
    const home = ownerOfKey(s, k, !!orig && k in orig);
    if (home) {
      let m = byHome.get(home);
      if (!m) byHome.set(home, (m = {}));
      m[k] = toDisk(v);
      continue;
    }
    legacy[k] = v;
  }
  writeHomes(s, doc, field, byHome, (m) => Object.keys(m).length === 0);
  return { legacy, legacyChanged: opts.only === undefined || !homeOfKnownKey(s, opts.only, !!orig && opts.only in orig) };
}

function homeOfKnownKey(s: State, key: string, inLegacy: boolean): boolean {
  return ownerOfKey(s, key, inLegacy) !== null;
}

/** splitOut for a set store; `only` as for splitOut. */
export function splitOutSet(next: Set<string>, doc: HomeDoc, field: string, only?: string): { legacy: Set<string>; legacyChanged: boolean } {
  const s = loaded();
  const orig = setOrigins.get(next);
  const legacy = new Set<string>();
  const byHome = new Map<string, string[]>();
  for (const id of next) {
    const home = ownerOfKey(s, id, !!orig && orig.has(id));
    if (home) {
      let m = byHome.get(home);
      if (!m) byHome.set(home, (m = []));
      m.push(id);
    } else legacy.add(id);
  }
  writeHomes(s, doc, field, byHome, (m) => m.length === 0);
  return { legacy, legacyChanged: only === undefined || !homeOfKnownKey(s, only, !!orig && orig.has(only)) };
}

/** For tests: drop everything this module holds in memory. */
export function resetHomeRecordsForTest(): void {
  st = null;
}
