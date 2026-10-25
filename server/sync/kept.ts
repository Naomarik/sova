import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./logins-stores";
import type { ProfileChanges } from "./profile-merge";

/**
 * Kept copies (§mesh.sync/kept-copies): before sync replaces, changes or removes a settings
 * document with another host's version, the version this host had is kept under
 * `<state dir>/sync-kept/<document>/`, newest 10 per document. Never synced, never offered to a
 * peer; Settings → Subagents reads the library's to offer it back.
 */

export const KEPT_PER_DOC = 10;
export const KEPT_DIR = "sync-kept";
/** The subagent profile library's sync key. */
export const LIBRARY_KEY = "settings:subagent-profiles.json";

export interface KeptCopy {
  v: 1;
  /** The document's sync key, e.g. `settings:subagent-profiles.json`. */
  key: string;
  /** When it was replaced (this host's clock). */
  at: number;
  /** The host whose copy replaced it, and its name as this host knew it then. */
  by: string;
  byName?: string;
  /** The replaced file's text, exactly. */
  content: string;
  /** For the subagent library: what the other copy did here, by profile name. */
  changes?: ProfileChanges;
  /** Set when Restore put this copy back. */
  restoredAt?: number;
}
export type KeptEntry = KeptCopy & { file: string };

const safe = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");
export const keptDir = (stateDir: string, key: string): string => join(stateDir, KEPT_DIR, safe(key));

function isKept(v: unknown, key: string): v is KeptCopy {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const k = v as Partial<KeptCopy>;
  return k.v === 1 && k.key === key && typeof k.at === "number" && typeof k.by === "string" && typeof k.content === "string";
}

/** Keep `copy`, then drop all but the newest `limit`. Returns the kept file's name. */
export function keepCopy(stateDir: string, copy: Omit<KeptCopy, "v">, limit = KEPT_PER_DOC): string {
  const dir = keptDir(stateDir, copy.key);
  mkdirSync(dir, { recursive: true });
  // Zero-padded, so names sort by time.
  const file = `${String(Math.max(0, Math.floor(copy.at))).padStart(15, "0")}-${randomBytes(3).toString("hex")}.json`;
  writeFileAtomic(join(dir, file), `${JSON.stringify({ v: 1, ...copy }, null, 2)}\n`);
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  for (const old of names.slice(0, Math.max(0, names.length - limit))) rmSync(join(dir, old), { force: true });
  return file;
}

/** Every kept copy of `key`, newest first; an unreadable one is skipped. */
export function listKept(stateDir: string, key: string): KeptEntry[] {
  const dir = keptDir(stateDir, key);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return [];
  }
  const out: KeptEntry[] = [];
  for (const file of names.sort().reverse()) {
    try {
      const v = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
      if (isKept(v, key)) out.push({ ...v, file });
    } catch {
      // unreadable: skipped
    }
  }
  return out;
}

/** Mark one kept copy restored (its notice is done). False when it is gone. */
export function markRestored(stateDir: string, key: string, file: string, at: number): boolean {
  const entry = listKept(stateDir, key).find((k) => k.file === file);
  if (!entry) return false;
  const { file: _file, ...copy } = entry;
  writeFileAtomic(join(keptDir(stateDir, key), file), `${JSON.stringify({ ...copy, restoredAt: at }, null, 2)}\n`);
  return true;
}
