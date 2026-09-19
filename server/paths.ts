import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // missing: keep the literal path
  }
}

/** Canonical (symlink-free) sessions dir, so every path derived from it is canonical too. */
export const SESSIONS_DIR = canonical(join(getAgentDir(), "sessions"));
export const LIVE_DIR = join(SESSIONS_DIR, "live");

const isInsideSessions = (p: string) => p.startsWith(SESSIONS_DIR + sep) && !p.startsWith(LIVE_DIR + sep);

/**
 * Validate a client-supplied session path: must be a .jsonl file inside SESSIONS_DIR
 * (not in live/). Existing files are canonicalized with realpath, so a symlink can neither
 * point outside the sessions dir nor alias another session (the canonical path is THE key
 * for the chat map, live-registry lookup and ownership records). Returns null if rejected;
 * a missing file is returned as-is (callers check existence).
 */
export function resolveSessionPath(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const abs = resolve(raw);
  if (!abs.endsWith(".jsonl")) return null;
  const literal = abs.startsWith(join(getAgentDir(), "sessions") + sep)
    ? join(SESSIONS_DIR, abs.slice(join(getAgentDir(), "sessions").length))
    : abs;
  if (!isInsideSessions(literal)) return null;
  let real: string;
  try {
    real = realpathSync(literal);
  } catch {
    return literal;
  }
  return real.endsWith(".jsonl") && isInsideSessions(real) ? real : null;
}

/** Canonicalize a path we produced ourselves (e.g. SessionManager.create output). */
export function canonicalPath(p: string): string {
  return canonical(resolve(p));
}
