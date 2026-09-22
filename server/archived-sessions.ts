import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/** Persistent set of session ids the user archived by hand (SessionSummary.archived). */
const FILE = join(stateRoot(), "archived-sessions.json");

function load(): Set<string> {
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // missing or corrupt: start empty
  }
}

let ids = load();

export function isArchived(id: string): boolean {
  return ids.has(id);
}

/**
 * Add or remove one archived id; written atomically (tmp + rename). Same rules as
 * web-sessions.ts: re-read the file and change only this id, so changes made by another server
 * instance survive, and the in-memory set is refreshed to match the file.
 */
export function setArchived(id: string, on: boolean): void {
  const next = load();
  if (on) next.add(id);
  else next.delete(id);
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...next]));
  renameSync(tmp, FILE);
  ids = next;
}
