import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Persistent set of session ids spawned via POST /api/sessions (SessionSummary.origin = "web"). */
const FILE = join(getAgentDir(), "pi-web", "web-sessions.json");

function load(): Set<string> {
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // missing or corrupt: start empty
  }
}

const ids = load();

export function isWebSession(id: string): boolean {
  return ids.has(id);
}

/**
 * Record a web-spawned session id; written atomically (tmp + rename). Re-reads and merges the
 * file first so ids added by another server instance (e.g. 4800 dev + an audit port) survive.
 */
export function addWebSession(id: string): void {
  for (const other of load()) ids.add(other);
  ids.add(id);
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...ids]));
  renameSync(tmp, FILE);
}
