import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { sessionsChanged } from "./list-generation";

/** The one refusal for anything asked of an archived session (§chat.transcript/instant-open,
    "An archived chat"): a mode, sandbox or profile switch, a worker's resume, a message. */
export const ARCHIVED_REFUSAL = "That session is archived; unarchive it first.";

/** Persistent set of session ids the user archived by hand (SessionSummary.archived). Read per call,
    like every agent-dir path: PI_CODING_AGENT_DIR is what the tests move. */
const archivedFile = () => join(stateRoot(), "archived-sessions.json");

function load(file: string): Set<string> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // missing or corrupt: start empty
  }
}

/** The file's identity as a stat shows it ("" when missing): an atomic write (tmp + rename) changes its inode. */
function stamp(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

/** How long a read trusts the set without a stat: every listing asks once per row. Shorter than the
    listing's settle time for a store write (sessions-index STORE_SETTLE_MS, 2 s), so a list built on a
    stale set is never kept. */
const CHECK_MS = 1000;
let cache: { file: string; stamp: string; checked: number; ids: Set<string> } | null = null;

/** The set as the file has it: re-read when the file's stat changes, so a write by another process
    (another server, the user's own edit) shows within CHECK_MS. */
function current(): Set<string> {
  const file = archivedFile();
  const now = Date.now();
  if (cache && cache.file === file && now - cache.checked < CHECK_MS) return cache.ids;
  const s = stamp(file);
  if (cache && cache.file === file && cache.stamp === s) {
    cache.checked = now;
    return cache.ids;
  }
  cache = { file, stamp: s, checked: now, ids: load(file) };
  return cache.ids;
}

export function isArchived(id: string): boolean {
  return current().has(id);
}

/**
 * Add or remove one archived id; written atomically (tmp + rename). Same rules as
 * web-sessions.ts: re-read the file and change only this id, so changes made by another server
 * instance survive, and the in-memory set is refreshed to match the file.
 */
export function setArchived(id: string, on: boolean): void {
  const file = archivedFile();
  const next = load(file);
  if (on) next.add(id);
  else next.delete(id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...next]));
  renameSync(tmp, file);
  cache = { file, stamp: stamp(file), checked: Date.now(), ids: next };
  sessionsChanged();
}
