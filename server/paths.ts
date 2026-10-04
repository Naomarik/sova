import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { agentRoot } from "./state-root";

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // missing: keep the literal path
  }
}

/** Canonical (symlink-free) sessions dir, so every path derived from it is canonical too. */
export const SESSIONS_DIR = canonical(join(agentRoot(), "sessions"));
export const LIVE_DIR = join(SESSIONS_DIR, "live");

/**
 * Session roots besides SESSIONS_DIR: each attached organization's `<workspace repo>/sessions/`
 * (server/orgs.ts registers the provider), where baton sessions are written directly
 * (§app.organizations/workspace-repo). Canonical dirs; a file counts only DIRECTLY inside one, so
 * nothing else in a workspace repo (its roster history is a .jsonl too) is ever a session.
 */
let extraRoots: () => readonly string[] = () => [];
export function setExtraSessionRoots(provider: () => readonly string[]): void {
  extraRoots = provider;
}
/** Each standalone project's `<stateRoot>/projects/<pid>/sessions/` (server/projects/spaces.ts registers it). */
let projectRoots: () => readonly string[] = () => [];
export function setProjectSessionRoots(provider: () => readonly string[]): void {
  projectRoots = provider;
}
export const extraSessionRoots = (): readonly string[] => [...extraRoots(), ...projectRoots()];

const isInsideSessions = (p: string) =>
  (p.startsWith(SESSIONS_DIR + sep) && !p.startsWith(LIVE_DIR + sep)) || extraSessionRoots().includes(dirname(p));

/**
 * The fs-FREE half of resolveSessionPath: a .jsonl inside SESSIONS_DIR (not live/), with the
 * uncanonicalized agent dir mapped onto the canonical one, or null. No syscall at all, so a
 * caller on a hot path — or one that must not risk a sync stat — can check containment first and
 * decide for itself how to touch the file. Listed session paths are built from SESSIONS_DIR the
 * same way (never per-file realpath), so for a real session file this IS the canonical path.
 *
 * CONTAINMENT HERE IS BY SHAPE ONLY. Dropping the realpath drops the step that stops a SYMLINK
 * inside sessions/ from pointing outside it, so this is safe for a caller that merely stats the
 * result and reports it, and NOT safe for one that opens, reads or writes the file: anything that
 * touches the contents must go through resolveSessionPath, which resolves the link and re-checks
 * containment on the real path.
 */
export function sessionPathShape(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const abs = resolve(raw);
  if (!abs.endsWith(".jsonl")) return null;
  const literal = abs.startsWith(join(agentRoot(), "sessions") + sep)
    ? join(SESSIONS_DIR, abs.slice(join(agentRoot(), "sessions").length))
    : abs;
  return isInsideSessions(literal) ? literal : null;
}

/**
 * Validate a client-supplied session path: must be a .jsonl file inside SESSIONS_DIR
 * (not in live/), or directly inside an extra session root. Existing files are canonicalized with realpath, so a symlink can neither
 * point outside the sessions dir nor alias another session (the canonical path is THE key
 * for the chat map, live-registry lookup and ownership records). Returns null if rejected;
 * a missing file is returned as-is (callers check existence).
 */
export function resolveSessionPath(raw: string | undefined | null): string | null {
  const literal = sessionPathShape(raw);
  if (!literal) return null;
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
