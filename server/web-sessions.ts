import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/** Persistent set of session ids spawned via POST /api/sessions (SessionSummary.origin = "web"). */
const FILE = join(stateRoot(), "web-sessions.json");

function load(): Set<string> {
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // missing or corrupt: start empty
  }
}

let ids = load();

export function isWebSession(id: string): boolean {
  return ids.has(id);
}

/**
 * Record a web-spawned session id; written atomically (tmp + rename). The file is the source of
 * truth: re-read it and add only this id, so ids added by another server instance survive and
 * ids removed from the file stay removed (the in-memory set is refreshed to match).
 */
export function addWebSession(id: string): void {
  const next = load();
  next.add(id);
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...next]));
  renameSync(tmp, FILE);
  ids = next;
}

/** Drop a web-spawned id (its session file was deleted); same write rules as addWebSession. */
export function removeWebSession(id: string): void {
  const next = load();
  if (!next.delete(id)) return; // absent: the in-memory set already matches the file
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...next]));
  renameSync(tmp, FILE);
  ids = next;
}
