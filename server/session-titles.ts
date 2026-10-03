import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { SESSION_TITLE_MAX, type SessionTitleBy } from "../shared/protocol";
import { sessionsChanged } from "./list-generation";

/**
 * The user's own titles for sessions (POST /api/sessions/title), keyed by session id like the
 * archive mark and the group assignment. Sova's own store and NOTHING ELSE: renaming a session
 * never writes a byte into its .jsonl, so a title the user set here is invisible to the TUI, to
 * the model, and to any other writer of that file. Each title records who set it (StoredTitle).
 * Clearing an override puts the derived title — the session's first user message — back, which is
 * why the derived one is never copied in here.
 */
const FILE = join(stateRoot(), "session-titles.json");

/** The cap lives in the wire contract, beside every other one; re-exported so this module's
    callers (and its tests) read the rule from the module that enforces it. */
export { SESSION_TITLE_MAX };

/**
 * A title the store will keep, or null when the input is not one: trimmed, whitespace collapsed
 * to single spaces (a row is one line), no control characters, 1–`SESSION_TITLE_MAX` characters.
 * Null is the route's 400 — it is NOT the clear gesture, which sends `title: null` instead.
 */
export function cleanSessionTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Whitespace first, so a pasted two-line title becomes one line rather than being refused;
  // what is left after that — NUL, ESC, the rest — is not whitespace and has no place in a row.
  const t = raw.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  return t && t.length <= SESSION_TITLE_MAX ? t : null;
}

/**
 * One stored title and who set it (§app.session-list/selecting-several-sessions). The file is
 * version 2: `titles[id]` is a bare string — a title stored before provenance existed, which
 * counts as explicit — or `{title, by, at}`. Only `by: "auto"` may ever be replaced by Sova's own
 * namer (server/session-autotitle.ts); every other title is explicit.
 */
export interface StoredTitle {
  title: string;
  by: SessionTitleBy;
  /** ms epoch it was set; absent on a bare-string (pre-provenance) title. */
  at?: number;
  /** Stored as a bare string: written back as one, so a pre-provenance title stays exactly as it was. */
  legacy?: true;
}

const BY: readonly SessionTitleBy[] = ["user", "overseer", "auto"];

/** A title a user or the Overseer set (or one from before provenance): never renamed automatically. */
export const isExplicitTitle = (t: StoredTitle | undefined): boolean => !!t && t.by !== "auto";

function parseStored(v: unknown): StoredTitle | null {
  if (typeof v === "string") {
    const title = cleanSessionTitle(v);
    return title ? { title, by: "user", legacy: true } : null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const title = cleanSessionTitle(r.title);
  if (!title) return null;
  // An unknown `by` is a title somebody set on purpose: explicit, never the namer's to replace.
  const by = BY.includes(r.by as SessionTitleBy) ? (r.by as SessionTitleBy) : "user";
  return { title, by, ...(typeof r.at === "number" && Number.isFinite(r.at) ? { at: r.at } : {}) };
}

function load(): Record<string, StoredTitle> {
  // No prototype: an id is a plain key, and "__proto__" must stay one.
  const out: Record<string, StoredTitle> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    const titles: unknown = v?.titles;
    if (!titles || typeof titles !== "object" || Array.isArray(titles)) return out;
    // One bad value must not cost the user every other title.
    for (const [id, t] of Object.entries(titles as Record<string, unknown>)) {
      const stored = parseStored(t);
      if (stored) out[id] = stored;
    }
  } catch {
    // missing or corrupt: start empty
  }
  return out;
}

const plain = (records: Record<string, StoredTitle>): Record<string, string> => {
  const out: Record<string, string> = Object.create(null);
  for (const [id, t] of Object.entries(records)) out[id] = t.title;
  return out;
};

let records = load();
let titles = plain(records);

/** Atomic (tmp + rename), then the in-memory maps are refreshed to what was written. */
function save(next: Record<string, StoredTitle>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  const out: Record<string, string | { title: string; by: SessionTitleBy; at?: number }> = {};
  for (const [id, t] of Object.entries(next)) out[id] = t.legacy ? t.title : { title: t.title, by: t.by, ...(t.at !== undefined ? { at: t.at } : {}) };
  writeFileSync(tmp, JSON.stringify({ version: 2, titles: out }));
  renameSync(tmp, FILE);
  sessionsChanged();
  records = next;
  titles = plain(next);
}

const remember = (next: Record<string, StoredTitle>) => {
  records = next;
  titles = plain(next);
};

/** The titles as last read or written by this process, with no file read (for per-tick use). */
export const memoSessionTitles = (): Readonly<Record<string, string>> => titles;

/** Every stored title. Reads the file, so a listing sees another server instance's writes. */
export function readSessionTitles(): Record<string, string> {
  remember(load());
  return titles;
}

/** Every stored title with who set it. Reads the file, like readSessionTitles. */
export function readSessionTitleRecords(): Readonly<Record<string, StoredTitle>> {
  remember(load());
  return records;
}

/** The records as last read or written by this process, with no file read. */
export const memoSessionTitleRecords = (): Readonly<Record<string, StoredTitle>> => records;

/**
 * Set or clear ONE session's title; `null` clears it, whoever set it. `by` is who is setting it
 * ("user" unless the Overseer's tools say otherwise). Same write rules as drafts.ts and
 * web-sessions.ts: re-read the file and change only this id, so a title another server instance
 * wrote survives. Returns what the session's title now is here, or null when it is the derived
 * one again. A title identical to what is stored, by the same setter, rewrites nothing.
 */
export function setSessionTitle(id: string, title: string | null, by: Exclude<SessionTitleBy, "auto"> = "user", now = Date.now()): string | null {
  const next = load();
  if (title === null) {
    if (!(id in next)) {
      remember(next); // absent already: nothing to write
      return null;
    }
    delete next[id];
    save(next);
    return null;
  }
  const cur = next[id];
  if (cur && cur.title === title && cur.by === by) {
    remember(next);
    return title;
  }
  next[id] = { title, by, at: now };
  save(next);
  return title;
}

/**
 * Sova's own namer's write (§app.session-list/auto-titles): store `title` as an `auto` title only
 * if, on a fresh read of the file now, the session has no explicit title — so a title the user or
 * the Overseer set while the model call was out wins. `redo` false also refuses to replace an
 * earlier auto title (the sweep names a session once). True when written (or already that title).
 */
export function writeAutoTitle(id: string, title: string, opts: { redo?: boolean; now?: number } = {}): boolean {
  const next = load();
  const cur = next[id];
  if (isExplicitTitle(cur) || (cur && !opts.redo)) {
    remember(next);
    return false;
  }
  if (cur?.title === title) {
    remember(next);
    return true;
  }
  next[id] = { title, by: "auto", at: opts.now ?? Date.now() };
  save(next);
  return true;
}

/** Drop the titles of deleted sessions; same write rules as setSessionTitle. */
export function dropSessionTitles(ids: string[]): void {
  const next = load();
  let changed = false;
  for (const id of ids) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) save(next);
  else remember(next);
}
