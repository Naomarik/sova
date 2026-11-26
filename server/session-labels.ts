import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionLabels, SessionSummary } from "../shared/protocol";
import { stateRoot } from "./state-root";

/**
 * Labels on a chat: a few short labels an extension sets on a session, by its key alone, and reads
 * back (opening B). Stored in `<stateRoot>/session-labels.json`, keyed by session id and then by the
 * extension's id, like titles and tags: a sidecar only, never a byte into a JSONL.
 *
 * On the wire a row carries `labels` only for a requester that names, in its request, the
 * (extension, key) pairs it reads (`labels=<extId>:<key>,…`, parseLabelPairs). Nothing here runs on
 * a request that names none: the list it is handed goes back as is, so its JSON is byte-identical,
 * and with an empty store a request that names some does no per-row work either (withLabels).
 */

/** A label key: the manual tags' rule. */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Keys one extension may keep on one chat. */
export const LABEL_KEYS_MAX = 8;
/** A value's length, after trimming. */
export const LABEL_VALUE_MAX = 64;
/** Pairs one request may name. */
export const LABEL_PAIRS_MAX = 16;
/** An extension id as the loader takes it (server/extensions.ts EXTENSION_ID_RE), bounded. */
const EXT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Plain text: no control characters, no line breaks.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// --- the store -------------------------------------------------------------------------------

type Store = Record<string, SessionLabels>;
interface Loaded {
  file: string;
  /** mtimeMs and size of the file as read (null: no file). */
  stamp: string | null;
  sessions: Store;
  /** How many sessions hold a label: 0 means every overlay returns its input untouched. */
  count: number;
  /** Bumped at every load and write: what a memoized row was built against. */
  rev: number;
}

const labelsFile = () => join(stateRoot(), "session-labels.json");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A value as stored, or null when it is not one (trimmed). */
export function cleanLabelValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > LABEL_VALUE_MAX || CONTROL_RE.test(t)) return null;
  return t;
}

const validExt = (id: string): boolean => EXT_ID_RE.test(id) && id !== "." && id !== "..";

function cleanSession(v: unknown): SessionLabels | null {
  if (!isObj(v)) return null;
  const out: SessionLabels = Object.create(null);
  let any = false;
  for (const [ext, kv] of Object.entries(v)) {
    if (!validExt(ext) || !isObj(kv)) continue;
    const keys: Record<string, string> = Object.create(null);
    let n = 0;
    for (const [k, val] of Object.entries(kv)) {
      const clean = cleanLabelValue(val);
      if (!LABEL_KEY_RE.test(k) || clean === null || n >= LABEL_KEYS_MAX) continue;
      keys[k] = clean;
      n++;
    }
    if (n) {
      out[ext] = keys;
      any = true;
    }
  }
  return any ? out : null;
}

let rev = 0;
let cache: Loaded | null = null;

function stampOf(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function load(file: string, stamp: string | null): Loaded {
  // No prototype: an id is a plain key, and "__proto__" must stay one.
  const sessions: Store = Object.create(null);
  let count = 0;
  if (stamp !== null) {
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isObj(v) && isObj(v.sessions)) {
        for (const [id, rec] of Object.entries(v.sessions)) {
          const clean = cleanSession(rec);
          if (clean) {
            sessions[id] = clean;
            count++;
          }
        }
      }
    } catch {
      // corrupt: start empty (a write replaces it)
    }
  }
  return { file, stamp, sessions, count, rev: ++rev };
}

/** The store as the file has it now: one stat per call, re-read only when the file changed (another
    server sharing the state root may write it). Called per request or per re-diff, never per row. */
function readStore(file = labelsFile()): Loaded {
  const stamp = stampOf(file);
  if (cache && cache.file === file && cache.stamp === stamp) return cache;
  cache = load(file, stamp);
  return cache;
}

/** Re-read, change, write atomically (tmp + rename): another server's sessions survive. */
function update(fn: (s: Store) => void, file = labelsFile()): Loaded {
  const next = load(file, stampOf(file));
  fn(next.sessions);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, sessions: next.sessions }));
  renameSync(tmp, file);
  next.count = Object.keys(next.sessions).length;
  next.stamp = stampOf(file);
  cache = next;
  return next;
}

// --- writes ----------------------------------------------------------------------------------

export type LabelChanges = Record<string, string | null>;

/** A write's body `labels`, checked: the changes, or what is wrong with them. */
export function cleanLabelChanges(v: unknown): LabelChanges | string {
  if (!isObj(v)) return "labels must be an object of key: value (null deletes the key)";
  const out: LabelChanges = Object.create(null);
  for (const [k, val] of Object.entries(v)) {
    if (!LABEL_KEY_RE.test(k)) return `"${k.slice(0, 40)}" is not a label key (a-z, 0-9 and -, at most 32, starting with a letter or digit)`;
    if (val === null) {
      out[k] = null;
      continue;
    }
    const clean = cleanLabelValue(val);
    if (clean === null) return `the value of "${k}" must be plain text of 1 to ${LABEL_VALUE_MAX} characters`;
    out[k] = clean;
  }
  return out;
}

/**
 * Merges `changes` into extension `ext`'s labels on session `id` (null deletes a key) and returns
 * that extension's labels after it, or a string when a change is not one (cleanLabelChanges) or the
 * result would hold more than LABEL_KEYS_MAX keys (nothing is written then). A change that changes nothing writes nothing and tells no one.
 */
export function setLabels(id: string, path: string, ext: string, changes: LabelChanges): { labels: Record<string, string>; changed: boolean } | string {
  if (!validExt(ext)) return "not an extension id";
  const clean = cleanLabelChanges(changes);
  if (typeof clean === "string") return clean;
  const before = readStore().sessions[id]?.[ext] ?? {};
  const after: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(before)) after[k] = v;
  for (const [k, v] of Object.entries(clean)) {
    if (v === null) delete after[k];
    else after[k] = v;
  }
  const keys = Object.keys(after);
  if (keys.length > LABEL_KEYS_MAX) return `an extension keeps at most ${LABEL_KEYS_MAX} labels on a chat`;
  const changed = keys.length !== Object.keys(before).length || keys.some((k) => before[k] !== after[k]);
  if (!changed) return { labels: { ...after }, changed: false };
  update((s) => {
    const rec: SessionLabels = Object.create(null);
    for (const [e, kv] of Object.entries(s[id] ?? {})) if (e !== ext) rec[e] = kv;
    if (keys.length) rec[ext] = after;
    if (Object.keys(rec).length) s[id] = rec;
    else delete s[id];
  });
  for (const fn of listeners) {
    try {
      fn({ id, path, extension: ext });
    } catch (err) {
      console.warn(`[labels] a listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { labels: { ...after }, changed: true };
}

export type LabelNews = { id: string; path: string; extension: string };
const listeners = new Set<(e: LabelNews) => void>();
/** Told of each write that changed a session's labels (the `session.labelled` news, the feed's nudge). */
export function onLabelled(fn: (e: LabelNews) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- reads -----------------------------------------------------------------------------------

const plain = (l: SessionLabels): SessionLabels => {
  const out: SessionLabels = {};
  for (const [e, kv] of Object.entries(l)) out[e] = { ...kv };
  return out;
};

/** One session's labels, every extension's (the read-back), or undefined when it has none. */
export function labelsOf(id: string): SessionLabels | undefined {
  const l = readStore().sessions[id];
  return l ? plain(l) : undefined;
}

/** Every session's labels (the read-back without an id). */
export function allLabels(): Record<string, SessionLabels> {
  const out: Record<string, SessionLabels> = {};
  for (const [id, l] of Object.entries(readStore().sessions)) out[id] = plain(l);
  return out;
}

/** Whether any session holds a label now. */
export const labelsHeld = (): boolean => readStore().count > 0;

// --- the declaration: which pairs a request reads --------------------------------------------

/** The (extension, key) pairs a request names, canonical (sorted) so one filter is one `key`. */
export interface LabelPairs {
  /** The canonical spelling: `ext:key,…` sorted. Equal filters have equal keys. */
  key: string;
  byExt: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * `labels=<extId>:<key>[,<extId>:<key>…]` as URLSearchParams decodes it, or null when the request
 * names none, or names them wrongly (more than LABEL_PAIRS_MAX, an empty or malformed pair): a
 * request whose declaration can't be read is answered as one that made none.
 */
export function parseLabelPairs(raw: string | null | undefined): LabelPairs | null {
  if (typeof raw !== "string" || !raw || raw.length > LABEL_PAIRS_MAX * 100) return null;
  const parts = raw.split(",");
  if (parts.length > LABEL_PAIRS_MAX) return null;
  const set = new Set<string>();
  const byExt = new Map<string, Set<string>>();
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i <= 0 || i !== p.lastIndexOf(":")) return null;
    const ext = p.slice(0, i);
    const key = p.slice(i + 1);
    if (!validExt(ext) || !LABEL_KEY_RE.test(key)) return null;
    set.add(`${ext}:${key}`);
    let keys = byExt.get(ext);
    if (!keys) byExt.set(ext, (keys = new Set()));
    keys.add(key);
  }
  return { key: [...set].sort().join(","), byExt };
}

/** The union of several filters (the feed's base, from its sockets' filters); null for none. */
export function unionPairs(all: Iterable<LabelPairs>): LabelPairs | null {
  const keys = new Set<string>();
  for (const p of all) for (const k of p.key.split(",")) keys.add(k);
  return keys.size ? parseLabelPairs([...keys].join(",")) : null;
}

/** What of a session's labels a filter lets through, or undefined when none. */
function pick(l: SessionLabels | undefined, pairs: LabelPairs): SessionLabels | undefined {
  if (!l) return undefined;
  let out: SessionLabels | undefined;
  for (const [ext, keys] of pairs.byExt) {
    const kv = l[ext];
    if (!kv) continue;
    let o: Record<string, string> | undefined;
    for (const k of keys) {
      const v = kv[k];
      if (v === undefined) continue;
      (o ??= {})[k] = v;
    }
    if (o) (out ??= {})[ext] = o;
  }
  return out;
}

/** A row with `labels` set (or left out), keeping every other field and its order. */
function withField(row: SessionSummary, labels: SessionLabels | undefined): SessionSummary {
  if (row.labels === undefined && labels === undefined) return row;
  const { labels: _drop, ...rest } = row;
  return labels ? { ...rest, labels } : rest;
}

/** Per row object, the overlay built for it: same store revision and filter, same object back. */
const memo = new WeakMap<SessionSummary, { rev: number; key: string; row: SessionSummary }>();

/**
 * The rows with the labels `pairs` names laid over them (a row with none of them is the same object,
 * any `labels` it carried taken off). The same array back when nothing changes: with an empty store
 * and rows carrying no labels it looks at no row at all.
 */
export function withLabels<T extends readonly SessionSummary[]>(rows: T, pairs: LabelPairs): T;
export function withLabels(rows: readonly SessionSummary[], pairs: LabelPairs): readonly SessionSummary[] {
  const store = readStore();
  if (store.count === 0) return rows;
  let out: SessionSummary[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rec = store.sessions[row.id];
    if (!rec && row.labels === undefined) continue;
    const m = memo.get(row);
    let next: SessionSummary;
    if (m && m.rev === store.rev && m.key === pairs.key) next = m.row;
    else {
      next = withField(row, pick(rec, pairs));
      memo.set(row, { rev: store.rev, key: pairs.key, row: next });
    }
    if (next !== row) (out ??= rows.slice())[i] = next;
  }
  return out ?? rows;
}

/** A row cut down to what `pairs` names of the labels it already carries (null: none of them). */
export function projectLabels(row: SessionSummary, pairs: LabelPairs | null): SessionSummary {
  if (row.labels === undefined) return row;
  return withField(row, pairs ? pick(row.labels, pairs) : undefined);
}

/** A linked computer's row as this host passes it on to a page that asked for `pairs`: only those pairs,
    each value one this host would keep (a peer's answer is data, never trusted to be cut). */
export function peerRowLabels(row: SessionSummary, pairs: LabelPairs): SessionSummary {
  const l = row.labels;
  if (l === undefined) return row;
  if (!isObj(l)) return withField(row, undefined);
  const clean: SessionLabels = {};
  for (const [ext, keys] of pairs.byExt) {
    const kv = Object.hasOwn(l, ext) ? l[ext] : undefined;
    if (!isObj(kv)) continue;
    for (const k of keys) {
      const v = Object.hasOwn(kv, k) ? cleanLabelValue(kv[k]) : null;
      if (v !== null) (clean[ext] ??= {})[k] = v;
    }
  }
  return withField(row, Object.keys(clean).length ? clean : undefined);
}

/** One row (a single-row read) with the labels `pairs` names. */
export function rowWithLabels(row: SessionSummary, pairs: LabelPairs): SessionSummary {
  return withLabels([row], pairs)[0]!;
}

/** Tests: forget the cached read. */
export function resetLabelsCache(): void {
  cache = null;
}
