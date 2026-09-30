import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttentionItem } from "../shared/protocol";
import { stateRoot } from "./state-root";

/**
 * Later (§app.overseer/attention-digest): Needs you items the user put away until something new
 * happens for them. `<stateRoot>/needs-you-later.json`, `{version: 1, items: {"<session id>:<kind>":
 * {anchor, at}}}`, atomic tmp+rename, re-read before every write like seen.ts.
 *
 * An item's **anchor** is the list of tokens whose change counts as new for it (its open
 * questions' ids, its dialogs, its error's time…). A put-away item stays hidden while every token
 * it has now was in the anchor put away: a new token brings it back; a token gone (a question
 * answered) does not.
 */

const MAX_TOKENS = 50;
const MAX_TOKEN = 200;

interface Entry {
  anchor: string[];
  at: number;
  /** The item's id (its session's, or a project item's): pruneLater's key. */
  id?: string;
}
interface LaterFile {
  version: 1;
  items: Record<string, Entry>;
}

export const laterFile = () => join(stateRoot(), "needs-you-later.json");

/** The item's `later` key: its session, kind and anchor as the user saw it. */
export function laterKey(id: string, kind: string, anchor: readonly string[]): string {
  return Buffer.from(JSON.stringify([id, kind, anchor.slice(0, MAX_TOKENS)]), "utf8").toString("base64url");
}

/** A key back to its parts, or null when it isn't one of ours. */
export function parseLaterKey(key: unknown): { id: string; kind: string; anchor: string[] } | null {
  if (typeof key !== "string" || key.length === 0 || key.length > 16_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [id, kind, anchor] = v;
  if (typeof id !== "string" || !id || typeof kind !== "string" || !kind || !Array.isArray(anchor)) return null;
  if (anchor.length > MAX_TOKENS || !anchor.every((t) => typeof t === "string" && t.length <= MAX_TOKEN)) return null;
  return { id, kind, anchor };
}

const slot = (id: string, kind: string) => `${id}:${kind}`;

function load(file: string): LaterFile {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    const out: LaterFile = { version: 1, items: {} };
    if (typeof v !== "object" || v === null || typeof v.items !== "object" || v.items === null) return out;
    for (const [k, e] of Object.entries(v.items as Record<string, unknown>)) {
      const r = e as Partial<Entry> | null;
      if (r && Array.isArray(r.anchor) && r.anchor.every((t) => typeof t === "string") && typeof r.at === "number")
        out.items[k] = { anchor: r.anchor, at: r.at, ...(typeof r.id === "string" ? { id: r.id } : {}) };
    }
    return out;
  } catch {
    return { version: 1, items: {} };
  }
}

function save(file: string, data: LaterFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

let cache: { file: string; data: LaterFile } | null = null;
function read(file: string): LaterFile {
  if (cache?.file === file) return cache.data;
  const data = load(file);
  cache = { file, data };
  return data;
}
function write(file: string, change: (d: LaterFile) => void): void {
  const data = load(file);
  change(data);
  save(file, data);
  cache = { file, data };
}

/** Put items away (their keys as the digest gave them). Returns how many keys were valid. */
export function putAway(keys: readonly unknown[], now = Date.now(), file = laterFile()): number {
  const parsed = keys.map(parseLaterKey).filter((k): k is NonNullable<typeof k> => k !== null);
  if (!parsed.length) return 0;
  write(file, (d) => {
    for (const k of parsed) d.items[slot(k.id, k.kind)] = { anchor: [...new Set(k.anchor)], at: now, id: k.id };
  });
  return parsed.length;
}

/** Bring put-away items back. Returns how many keys were valid. */
export function bringBack(keys: readonly unknown[], file = laterFile()): number {
  const parsed = keys.map(parseLaterKey).filter((k): k is NonNullable<typeof k> => k !== null);
  if (!parsed.length) return 0;
  write(file, (d) => {
    for (const k of parsed) delete d.items[slot(k.id, k.kind)];
  });
  return parsed.length;
}

/**
 * The items without the ones put away whose anchor hasn't moved. An entry whose item has a new
 * token now is dropped from the store (one write). Nothing expires with time: only something new
 * brings an item back (`now` is kept for callers).
 */
export function withoutLater<T extends Pick<AttentionItem, "later">>(items: readonly T[], _now = Date.now(), file = laterFile()): T[] {
  const data = read(file);
  if (!Object.keys(data.items).length) return [...items];
  const stale = new Set<string>();
  const out = items.filter((it) => {
    const k = it.later ? parseLaterKey(it.later) : null;
    if (!k) return true;
    const s = slot(k.id, k.kind);
    const e = data.items[s];
    if (!e || stale.has(s)) return true;
    const had = new Set(e.anchor);
    if (k.anchor.every((t) => had.has(t))) return false;
    stale.add(s);
    return true;
  });
  if (stale.size) {
    try {
      write(file, (d) => {
        for (const s of stale) delete d.items[s];
      });
    } catch (err) {
      console.warn("[needs-you-later] write failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/**
 * Store hygiene: drop entries whose session (or project item) is no longer listed at all — a
 * deleted session never comes back to need them. `ids`: every listed session's id and every
 * no-session item's id. An entry is never dropped just because its item is absent now: open
 * questions leave the digest while a turn runs and must stay put away when it ends.
 */
export function pruneLater(ids: ReadonlySet<string>, file = laterFile()): void {
  const data = read(file);
  const gone = Object.entries(data.items).filter(([k, e]) => !ids.has(e.id ?? k.slice(0, k.indexOf(":")))).map(([k]) => k);
  if (!gone.length) return;
  try {
    write(file, (d) => {
      for (const k of gone) delete d.items[k];
    });
  } catch (err) {
    console.warn("[needs-you-later] write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Tests: forget the in-memory copy. */
export function resetLaterCache(): void {
  cache = null;
}
