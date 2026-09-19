import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SESSIONS_DIR = join(getAgentDir(), "sessions");
export const LIVE_DIR = join(SESSIONS_DIR, "live");

/**
 * Validate a client-supplied session path: must be a .jsonl file inside SESSIONS_DIR
 * (not in live/). Returns the resolved absolute path, or null if not acceptable.
 */
export function resolveSessionPath(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const abs = resolve(raw);
  if (!abs.endsWith(".jsonl")) return null;
  let root = SESSIONS_DIR;
  try {
    root = realpathSync(SESSIONS_DIR);
  } catch {
    // sessions dir missing; fall back to the literal path
  }
  const inside = (p: string) => p.startsWith(SESSIONS_DIR + sep) || p.startsWith(root + sep);
  if (!inside(abs)) return null;
  if (abs.startsWith(LIVE_DIR + sep)) return null;
  return abs;
}
