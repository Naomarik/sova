import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chatHome, hasHome, homesRoot, listHomeIds, noteHomeArrived, onHomesRootSwitch, sweepHomeNegatives } from "./root";
import { appendChange, onChanges, pollChanges, startTail, type ChangeLine } from "./changes";
import { CHAT_HOME_ENV, setChatHomesRoot } from "../../pi-config/extensions/sandbox/shared-folder.ts";

// The shared folder's helper (pi-config, no server imports) asks the server's own homes folder.
setChatHomesRoot(homesRoot);

/**
 * A chat home's own records (§app.chat-homes/layout): `<home>/chat/{meta,seen,signals}.json`,
 * written by Sova alone. The unsent draft is never in a home: it stays in the server-wide drafts
 * store, never carried and never readable by an extension.
 *
 * Each server-wide store keeps its file for chats without a home and, for a key whose chat has one, keeps that key's entry in the home instead, under a field named after
 * the server-wide file and the map inside it (`"session-titles.json#titles"`), holding EXACTLY the
 * entry the server-wide store would have written. So putting a home back into the server-wide stores
 * (the rollback) is: merge each field's entries into that file's map.
 *
 * A key is a session id, or `<session id>:<suffix>` (a worker's signals, a card's follow-up). A home
 * holds the keys of its own chat and of every worker and team member under it (`homeOf`).
 *
 * The stores keep their shape: `withHome` lays the homes' entries over what the server-wide file
 * holds, and `splitOut` takes the homed keys back out before the store writes its file, writing
 * each home whose entries changed (compared by content: a store may change an entry in place). The
 * store still writes its own file as before, unless it says which one key it changed (`only`) and
 * that key is homed. A store with no home at all pays one shallow copy per load.
 *
 * Several processes write these files (the server, the chat processes it runs, a second server on
 * the same state root), so a home's file follows the stores' own rule: a write re-reads it and
 * changes only the keys this process changed (against what it last read), leaving another writer's
 * keys as they are. Every write appends a line to the homes' change log (server/chat-homes/changes.ts),
 * and a read takes the lines appended since, at most once a second (CHECK_MS): one read of the log,
 * whatever the number of homes, and a stat of each home a line names. The log is a hint: every
 * BACKSTOP_MS (and when lines may have gone by unread) a read checks every active home's `chat/`
 * folder's stat as before (every write there is a rename into it), so a write that came with no line
 * is seen late, never lost. An archived chat's home is not swept: every change to it goes through Sova.
 */

export type HomeDoc = "meta" | "seen" | "signals";
export const HOME_DOCS: readonly HomeDoc[] = ["meta", "seen", "signals"];

/** The file of one home record. */
export const homeDocFile = (homeId: string, doc: HomeDoc): string => join(chatHome(homeId), "chat", `${doc}.json`);

type Json = Record<string, unknown>;

interface HomeEntry {
  docs: Map<HomeDoc, Json>;
  /** Per `doc|field`, each key's entry as last read or written here, serialised (an id alone, for a set): what a
      write compares with, so it writes only what this process changed. */
  base: Map<string, Map<string, string>>;
  /** Each file's stat when last read or written here. */
  stamp: Map<HomeDoc, string>;
  /** The `chat/` folder's stat then: a rename into it by any process moves it. */
  dirStamp: string;
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
  /** When the homes were last checked for another writer's change. */
  checkedAt: number;
  /** The environment the root was resolved from (homesGeneration's fast path). */
  envKey: string;
  /** Bumped whenever what this process holds of the homes changed other than by its own write: a home arrived,
      was read again or forgotten, or another process wrote one. A store's memo compares it (homesGeneration). */
  gen: number;
  /** Per home, the change counter when what it holds of it last changed other than by a write of its own records
      docs here (homeGeneration): a store of whole per-chat files (offers, cards) compares its home's alone. */
  homeGens: Map<string, number>;
  /** The counter when this state began: every home's generation before any change. */
  base: number;
  /** The homes changed, in order, by counter (homesChangedSince); `floor`: older entries were dropped. */
  journal: { at: number; id: string }[];
  floor: number;
  /** When every home was last checked whole (the backstop sweep); `sweepNow`: lines may have gone by unread. */
  sweptAt: number;
  sweepNow: boolean;
}

/** How long a read trusts the homes' files without reading the log: as long as the stores trust their own (seen.ts CACHE_MS). */
const CHECK_MS = 1000;
/** How often a read checks every home whatever the log says: the session list's full build's pace (SWEEP_MS). */
export const BACKSTOP_MS = 5 * 60_000;
/** How many changed homes the journal keeps before an older cursor means "everything". */
const JOURNAL_MAX = 20_000;

let st: State | null = null;
/** Never goes back, across states: a cursor or generation of an older state never equals a newer one's. */
let counter = 0;

/** I/O this module did (the bench and tests count it). */
export const recordsIo = { sweeps: 0, stats: 0 };

function state(): State {
  const root = homesRoot();
  if (!st || st.root !== root) {
    const base = ++counter;
    st = { root, loaded: false, membersLoaded: false, homes: new Map(), members: new Map(), checkedAt: 0, envKey: envKey(), gen: 0, homeGens: new Map(), base, journal: [], floor: base, sweptAt: Date.now(), sweepNow: false };
  }
  return st;
}

/** What this process holds of `homeId` changed other than by its own records write: its generation moves. */
function bumpHome(s: State, homeId: string): void {
  const at = ++counter;
  s.homeGens.set(homeId, at);
  s.journal.push({ at, id: homeId });
  if (s.journal.length > JOURNAL_MAX) {
    const cut = s.journal.length - JOURNAL_MAX / 2;
    s.floor = s.journal[cut - 1]!.at;
    s.journal = s.journal.slice(cut);
  }
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

/** A file's identity as a stat shows it ("" when missing): a write (tmp + rename) changes its inode. */
function stampOf(file: string): string {
  recordsIo.stats++;
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

/** Each key of a field's value, serialised: an object's entries, or a set's ids. */
function keysOf(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(v)) {
    for (const id of v) if (typeof id === "string") out.set(id, "");
  } else if (isObj(v)) for (const [k, e] of Object.entries(v)) out.set(k, JSON.stringify(e));
  return out;
}

/** Keep `d` as what this process last saw of the file. */
function remember(h: HomeEntry, doc: HomeDoc, d: Json, stamp: string): void {
  h.docs.set(doc, d);
  h.stamp.set(doc, stamp);
  for (const tag of [...h.base.keys()]) if (tag.startsWith(`${doc}|`)) h.base.delete(tag);
  for (const [field, v] of Object.entries(d)) if (field !== "version" && field !== "id") h.base.set(`${doc}|${field}`, keysOf(v));
}

function readInto(h: HomeEntry, homeId: string, doc: HomeDoc): void {
  const stamp = stampOf(homeDocFile(homeId, doc));
  remember(h, doc, readDoc(homeId, doc), stamp);
}

const chatDir = (homeId: string): string => join(chatHome(homeId), "chat");

/** Re-read each file of the home whose stat no longer matches what this process last read or wrote. */
function recheck(s: State, homeId: string, h: HomeEntry, docs: readonly HomeDoc[] = HOME_DOCS): boolean {
  let moved = false;
  for (const doc of docs)
    if (stampOf(homeDocFile(homeId, doc)) !== h.stamp.get(doc)) {
      readInto(h, homeId, doc);
      s.gen++;
      moved = true;
    }
  return moved;
}

/** Whether a home's chat is archived, by its own record (`archived-sessions.json` in its meta) as this process holds it. */
const archivedEntry = (homeId: string, h: HomeEntry): boolean => {
  const a = h.docs.get("meta")?.["archived-sessions.json"];
  return Array.isArray(a) && a.includes(homeId);
};

/** Whether the chat of home `homeId` is archived, as the records this process holds say (false when not read yet). */
export function isHomeArchived(homeId: string): boolean {
  const h = st?.homes.get(homeId);
  return !!h && archivedEntry(homeId, h);
}

/** The backstop: every active home whose `chat/` folder moved since this process last read or wrote there is read
    again, homes that came with no line are found, and every "not a home" answer is asked again. An archived chat's
    home is not swept (every change to it goes through Sova, which writes its line), except when lines may have gone
    by unread (`all`). */
function sweep(s: State, all = false): void {
  recordsIo.sweeps++;
  s.sweptAt = Date.now();
  s.sweepNow = false;
  sweepHomeNegatives();
  for (const [homeId, h] of s.homes) {
    if (!all && archivedEntry(homeId, h)) continue;
    const ds = stampOf(chatDir(homeId));
    if (ds === h.dirStamp) continue;
    h.dirStamp = ds;
    if (recheck(s, homeId, h)) bumpHome(s, homeId);
  }
  if (s.loaded) for (const id of listHomeIds()) if (!s.homes.has(id)) loadHome(s, id);
}

/** Take what the log says changed since the last look (at most once a second); sweep when due. */
function fresh(s: State): void {
  const now = Date.now();
  if (now - s.checkedAt < CHECK_MS) return;
  s.checkedAt = now;
  pollChanges(s.root);
  if (s.sweepNow) sweep(s, true);
  else if (now - s.sweptAt >= BACKSTOP_MS || now < s.sweptAt) sweep(s);
}

const DOC_OF: Partial<Record<ChangeLine["d"], HomeDoc>> = { meta: "meta", seen: "seen", signals: "signals" };

/** One line of the log, this process's own included (its writes are already held: a stat finds nothing new). */
function applyLine(s: State, l: ChangeLine): void {
  // A line of this pid is taken as this process's own write, already held. A replay from the index's cursor at a start
  // may hold the previous server's lines under the same pid (a container that always starts it as pid 1): skipping them
  // loses nothing, since loaded() reads every home from disk at the start, and session-files' listener takes every line.
  const own = l.p === process.pid;
  const doc = DOC_OF[l.d];
  if (doc) {
    if (own) return;
    const h = s.homes.get(l.h);
    if (h) {
      if (recheck(s, l.h, h, [doc])) bumpHome(s, l.h);
    } else if (s.loaded && hasHome(l.h)) loadHome(s, l.h);
    return;
  }
  switch (l.d) {
    case "home":
      if (own) return;
      noteHomeArrived(l.h);
      if (s.loaded && !s.homes.has(l.h) && hasHome(l.h)) loadHome(s, l.h);
      else bumpHome(s, l.h);
      return;
    case "gone":
      if (s.homes.delete(l.h)) s.gen++;
      for (const [m, h] of s.members) if (h === l.h) s.members.delete(m);
      bumpHome(s, l.h);
      return;
    case "workers":
      if (!own && s.membersLoaded) listMembers(s, l.h);
      return;
    case "offers":
    case "cards":
      if (!own) bumpHome(s, l.h);
      return;
    default:
      return;
  }
}

onChanges((root, lines, gap) => {
  const s = st;
  if (!s || s.root !== root) return;
  if (gap) s.sweepNow = true;
  for (const l of lines) applyLine(s, l);
});

// A Chats folder move: everything held of the old folder goes; the next read is of the new one.
onHomesRootSwitch(() => resetHomeRecords());

function loadHome(s: State, homeId: string, members = true): HomeEntry {
  // The folder first: a write landing while the files are read shows as a move at the next check. A home with no
  // chat/ yet (most: its records are made at their first write) costs this one stat.
  const dirStamp = stampOf(chatDir(homeId));
  const entry: HomeEntry = { docs: new Map(), base: new Map(), stamp: new Map(), dirStamp };
  for (const doc of HOME_DOCS) {
    if (dirStamp) readInto(entry, homeId, doc);
    else remember(entry, doc, { version: 1, id: homeId }, "");
  }
  s.homes.set(homeId, entry);
  if (members) listMembers(s, homeId);
  s.gen++;
  bumpHome(s, homeId);
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
  // The worker registry listed every home's workers/ at start (membersFromRegistry): not again here.
  const members = !s.membersLoaded;
  s.loaded = s.membersLoaded = true;
  // The log is read from here on before the homes are: a write landing while they are read is a line read next.
  startTail(s.root);
  s.checkedAt = Date.now();
  s.sweptAt = s.checkedAt;
  for (const id of listHomeIds()) if (!s.homes.has(id)) loadHome(s, id, members);
  return s;
}

/** The worker registry read every home's helpers' records and registered each as its home's member: the members
    are known without listing the homes again. */
export function membersFromRegistry(): void {
  state().membersLoaded = true;
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

/** Read one home's records again from disk (a home unpacked or rewritten outside this module). Every store sees
    them at its next read (homesGeneration). */
export function reloadHome(homeId: string): void {
  const s = state();
  s.homes.delete(homeId);
  for (const [m, h] of s.members) if (h === homeId) s.members.delete(m);
  if (hasHome(homeId)) {
    if (s.loaded) loadHome(s, homeId);
    else listMembers(s, homeId);
  }
  s.gen++;
  bumpHome(s, homeId);
}

/** A home arrived from outside (Transport, right after the rename that publishes it): every store, its memo
    included, lists the chat's records (title, archive mark, origin, seen, signals, offers, cards…) at its next read,
    and every other process reading the homes is told by the log. */
export function homeArrived(homeId: string): void {
  noteHomeArrived(homeId);
  reloadHome(homeId);
  appendChange(state().root, homeId, "home");
}

/** Forget a home that was removed (Delete). */
export function forgetHomeRecords(homeId: string): void {
  const s = state();
  s.homes.delete(homeId);
  for (const [m, h] of s.members) if (h === homeId) s.members.delete(m);
  s.gen++;
  bumpHome(s, homeId);
}

/** What a store's memo compares: it changes whenever the homes' records this process holds changed other than by
    its own writes (a home arrived, was read again or forgotten, another process wrote one, checked once a second). */
export function homesGeneration(): number {
  // Asked once per row by the list: inside the second since the last check, with the same environment the homes root
  // was resolved from, the answer is the one held (resolving the root and the clock check are the cost otherwise).
  const s0 = st;
  if (s0?.loaded && s0.envKey === envKey() && Date.now() - s0.checkedAt < CHECK_MS) return s0.gen;
  const s = loaded();
  fresh(s);
  return s.gen;
}

/** What the homes root is resolved from (server/chat-homes/root.ts, the agent dir): a change means another root. */
const envKey = (): string => {
  const e = process.env;
  return `${e.PI_CODING_AGENT_DIR ?? ""}\0${e.SOVA_CHAT_HOMES ?? ""}\0${e.SOVA_CHAT_HOMES_ROOT ?? ""}\0${e.HOME ?? ""}`;
};

/**
 * What a store of whole per-chat files (offers, cards) compares for one chat: its home's generation, which moves when
 * that home arrived, was read again or forgotten, or another process wrote its cards or offers. 0 for a chat with no
 * home. Never reads every home.
 */
export function homeGeneration(id: string): number {
  const home = homeOf(id);
  if (!home) return 0;
  const s = state();
  fresh(s);
  return s.homeGens.get(home) ?? s.base;
}

/** Where the changes are now: hand it back to homesChangedSince. */
export const homesChangeCursor = (): number => {
  const s = state();
  fresh(s);
  return counter;
};

/**
 * Each home whose generation moved after `cursor` (homesChangeCursor), once each; null when the cursor is older than
 * what is kept, or of another homes folder: read everything again.
 */
export function homesChangedSince(cursor: number): string[] | null {
  const s = state();
  fresh(s);
  if (cursor < s.floor) return null;
  const out = new Set<string>();
  for (let i = s.journal.length - 1; i >= 0 && s.journal[i]!.at > cursor; i--) out.add(s.journal[i]!.id);
  return [...out];
}

/** A store of whole per-chat files wrote one: other processes reading the homes hear of it (no-op for no home). */
export function noteHomeFileWritten(id: string, doc: "offers" | "cards" | "workers" | "sessions"): void {
  const home = homeOf(id);
  if (home) appendChange(homesRoot(), home, doc);
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

/** A helper's record as the worker registry holds it (server/chat-workers.ts WorkerRecord), what "in use" reads. */
export interface HelperRecord {
  chatId: string;
  path: string;
  parent: { path: string };
  state: string;
}

let helperSource: (() => Iterable<HelperRecord>) | null = null;

/** The server's worker registry names itself here: its records in memory are the truth while it runs. */
export function setHelperRecordSource(fn: (() => Iterable<HelperRecord>) | null): void {
  helperSource = fn;
}

/** Every helper record the running registry holds, or null when no registry runs in this process (read the disk). */
export function helperRecords(): HelperRecord[] | null {
  return helperSource ? [...helperSource()] : null;
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
  fresh(s);
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
  fresh(s);
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

/**
 * Write one home's entries of `doc`/`field` as this process now has them (`next`: an object's entries, or a set's ids).
 * Only the keys that differ from what this process last read or wrote are changed, on a fresh read of the file: an
 * entry another process wrote meanwhile stays.
 */
function writeHomeField(s: State, homeId: string, doc: HomeDoc, field: string, next: Record<string, unknown> | string[]): void {
  // A home removed by its chat's Delete is never made again by a late write.
  if (!hasHome(homeId)) return;
  const h = s.homes.get(homeId) ?? loadHome(s, homeId);
  const base = h.base.get(`${doc}|${field}`) ?? new Map<string, string>();
  const now = keysOf(next);
  const set: string[] = [];
  const del: string[] = [];
  for (const [k, ser] of now) if (base.get(k) !== ser) set.push(k);
  for (const k of base.keys()) if (!now.has(k)) del.push(k);
  if (!set.length && !del.length) return;
  const file = homeDocFile(homeId, doc);
  const disk = readDoc(homeId, doc);
  const cur = disk[field];
  let value: unknown;
  if (Array.isArray(next)) {
    const ids = new Set(Array.isArray(cur) ? cur.filter((x): x is string => typeof x === "string") : []);
    for (const k of set) ids.add(k);
    for (const k of del) ids.delete(k);
    value = ids.size ? [...ids] : undefined;
  } else {
    const m: Json = isObj(cur) ? { ...cur } : {};
    for (const k of set) m[k] = next[k];
    for (const k of del) delete m[k];
    value = Object.keys(m).length ? m : undefined;
  }
  const out: Json = { ...disk, version: 1, id: homeId };
  if (value === undefined) delete out[field];
  else out[field] = value;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o644 });
    renameSync(tmp, file);
    // The folder's stamp is left as it was: the next sweep sees it moved and stats this home's files, where our own
    // file's stamp matches and another writer's, landed in between, does not.
    remember(h, doc, out, stampOf(file));
    appendChange(s.root, homeId, doc);
  } catch (err) {
    console.warn(`[chat-homes] ${doc}.json write failed for ${homeId}:`, err instanceof Error ? err.message : String(err));
  }
}

/** Write each home whose entries of `doc`/`field` differ from what it holds; `byHome` is every home that has entries
    now (a home missing from it has none left of what this process knew). */
function writeHomes(s: State, doc: HomeDoc, field: string, byHome: Map<string, Record<string, unknown> | string[]>, empty: Record<string, unknown> | string[]): void {
  const tag = `${doc}|${field}`;
  for (const [homeId, h] of s.homes) if (!byHome.has(homeId) && h.base.get(tag)?.size) writeHomeField(s, homeId, doc, field, empty);
  for (const [homeId, v] of byHome) writeHomeField(s, homeId, doc, field, v);
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
  // One key changed: only its home can differ (none, for an older chat's key), so only it is compared and written.
  const one = opts.only === undefined ? null : ownerOfKey(s, opts.only, !!orig && opts.only in orig);
  if (one) writeHomeField(s, one, doc, field, byHome.get(one) ?? {});
  else if (opts.only === undefined) writeHomes(s, doc, field, byHome, {});
  return { legacy, legacyChanged: one === null };
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
  const one = only === undefined ? null : ownerOfKey(s, only, !!orig && orig.has(only));
  if (one) writeHomeField(s, one, doc, field, byHome.get(one) ?? []);
  else if (only === undefined) writeHomes(s, doc, field, byHome, []);
  return { legacy, legacyChanged: one === null };
}

/** Drop everything this module holds in memory (a Chats folder move; tests): the next read reads the homes again. */
export function resetHomeRecords(): void {
  st = null;
}
export const resetHomeRecordsForTest = resetHomeRecords;

/** For tests: the next read takes the log at once, as a second later would. */
export function expireHomeRecordChecksForTest(): void {
  if (st) st.checkedAt = 0;
}

/** For tests: the next read also sweeps every home, as five minutes later would. */
export function expireHomeRecordSweepForTest(): void {
  if (st) {
    st.checkedAt = 0;
    st.sweptAt = 0;
  }
}
