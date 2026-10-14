// This computer's own notes about saved sessions (§chat.saved-sessions/discovery, /save-dialog): which version of
// each saved session it has seen (bundle id → rev, for the New and Updated badges), and per project the push
// choice, when the saved branch was last fetched, and per remote whether the "may be public" warning was
// accepted. Small JSON files under the state root, written whole and atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../state-root";

export const SEEN_FILE = "saved-sessions-seen.json";
export const PREFS_FILE = "saved-sessions.json";

function readJson(path: string): Record<string, any> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const seenPath = () => join(stateRoot(), SEEN_FILE);
const prefsPath = () => join(stateRoot(), PREFS_FILE);

/** The newest version of each saved session this computer has seen (previewed or continued). */
export function seenRevs(): Record<string, number> {
  const raw = readJson(seenPath());
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
  return out;
}

export function markSavedSeen(bundleId: string, rev: number): void {
  const all = seenRevs();
  if ((all[bundleId] ?? 0) >= rev) return;
  all[bundleId] = rev;
  writeJson(seenPath(), all);
}

/** New: never seen. Updated: an older version was seen. */
export function badgeOf(bundleId: string, rev: number, seen: Record<string, number> = seenRevs()): "new" | "updated" | null {
  const s = seen[bundleId];
  if (s === undefined) return "new";
  return s < rev ? "updated" : null;
}

export interface ProjectPrefs {
  push?: boolean;
  fetchedAt?: string;
}

interface Prefs {
  projects: Record<string, ProjectPrefs>;
  remotes: Record<string, { publicWarningAccepted?: boolean }>;
}

function readPrefs(): Prefs {
  const raw = readJson(prefsPath());
  return {
    projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
    remotes: raw.remotes && typeof raw.remotes === "object" ? raw.remotes : {},
  };
}

export function projectPrefs(key: string): ProjectPrefs {
  return readPrefs().projects[key] ?? {};
}

export function setProjectPrefs(key: string, patch: ProjectPrefs): void {
  const p = readPrefs();
  p.projects[key] = { ...p.projects[key], ...patch };
  writeJson(prefsPath(), p);
}

export function publicWarningAccepted(remoteUrl: string): boolean {
  return readPrefs().remotes[remoteUrl]?.publicWarningAccepted === true;
}

export function acceptPublicWarning(remoteUrl: string): void {
  const p = readPrefs();
  p.remotes[remoteUrl] = { ...p.remotes[remoteUrl], publicWarningAccepted: true };
  writeJson(prefsPath(), p);
}
