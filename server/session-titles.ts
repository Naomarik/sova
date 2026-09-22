import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { SESSION_TITLE_MAX } from "../shared/protocol";

/**
 * The user's own titles for sessions (POST /api/sessions/title), keyed by session id like the
 * archive mark and the group assignment. Sova's own store and NOTHING ELSE: renaming a session
 * never writes a byte into its .jsonl, so a title the user set here is invisible to the TUI, to
 * the model, and to any other writer of that file (spec/02-session-list.md §2 "Selecting several
 * sessions"). Clearing an override puts the derived title — the session's first user message —
 * back, which is why the derived one is never copied in here.
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

function load(): Record<string, string> {
  // No prototype: an id is a plain key, and "__proto__" must stay one.
  const out: Record<string, string> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    const titles: unknown = v?.titles;
    if (!titles || typeof titles !== "object" || Array.isArray(titles)) return out;
    // One bad value must not cost the user every other title.
    for (const [id, t] of Object.entries(titles as Record<string, unknown>)) {
      const clean = cleanSessionTitle(t);
      if (clean) out[id] = clean;
    }
  } catch {
    // missing or corrupt: start empty
  }
  return out;
}

let titles = load();

/** Atomic (tmp + rename), then the in-memory map is refreshed to what was written. */
function save(next: Record<string, string>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, titles: next }));
  renameSync(tmp, FILE);
  titles = next;
}

/** Every stored title. Reads the file, so a listing sees another server instance's writes. */
export function readSessionTitles(): Record<string, string> {
  titles = load();
  return titles;
}

/**
 * Set or clear ONE session's title; `null` clears it. Same write rules as drafts.ts and
 * web-sessions.ts: re-read the file and change only this id, so a title another server instance
 * wrote survives. Returns what the session's title now is here, or null when it is the derived
 * one again. A title identical to what is stored still rewrites nothing.
 */
export function setSessionTitle(id: string, title: string | null): string | null {
  const next = load();
  if (title === null) {
    if (!(id in next)) {
      titles = next; // absent already: nothing to write
      return null;
    }
    delete next[id];
    save(next);
    return null;
  }
  if (next[id] === title) {
    titles = next;
    return title;
  }
  next[id] = title;
  save(next);
  return title;
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
  else titles = next;
}
