import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { sessionsChanged } from "./list-generation";
import { homesGeneration, splitOutSet, withHomeSet } from "./chat-homes/records";

/** Persistent set of session ids spawned via POST /api/sessions (SessionSummary.origin = "web"). */
/** Read at each use, never at import: the state root is the process's current one. */
const file = (): string => join(stateRoot(), "web-sessions.json");

/** A chat with a home keeps its origin mark in `<home>/chat/meta.json` (server/chat-homes/records.ts). */
const FIELD = "web-sessions.json";
const load = (): Set<string> => withHomeSet(loadFile(), "meta", FIELD);

function save(next: Set<string>, only: string): void {
  const { legacy, legacyChanged } = splitOutSet(next, "meta", FIELD, only);
  if (legacyChanged) {
    mkdirSync(dirname(file()), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...legacy]));
    renameSync(tmp, file());
  }
  sessionsChanged();
  ids = next;
  idsGen = homesGeneration();
}

function loadFile(): Set<string> {
  try {
    const v = JSON.parse(readFileSync(file(), "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // missing or corrupt: start empty
  }
}

let ids = load();
let idsGen = homesGeneration();

export function isWebSession(id: string): boolean {
  // A home's mark from outside (an arrived chat, another process) is read at once.
  const gen = homesGeneration();
  if (gen !== idsGen) {
    ids = load();
    idsGen = homesGeneration();
  }
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
  save(next, id);
}

/** Drop a web-spawned id (its session file was deleted); same write rules as addWebSession. */
export function removeWebSession(id: string): void {
  const next = load();
  if (!next.delete(id)) return; // absent: the in-memory set already matches the file
  save(next, id);
}
