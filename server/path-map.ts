import { readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { legacyStateRoot, stateRoot } from "./state-root";

/**
 * Renamed LOCAL roots the server must keep opening transparently: `<stateRoot>/path-map.json`,
 * written by the migration procedure (never by this server). The one entry that matters is the
 * repo rename itself —
 *
 *   { "version": 1, "moved": [ { "from": "/home/user/webapps/pi-web", "to": "/home/user/webapps/sova" } ] }
 *
 * A session's stored cwd is its identity and its transcripts are never rewritten, so a session
 * recorded against the old repo path (the operator's own included) must still open after the move:
 * the mapped cwd is what the existence check and the SDK runtime see. Tools then run in the moved
 * folder, which IS the folder — a rename, not a substitution.
 *
 * Boundaries where this does NOT apply, each with its own bridge:
 *   - remote placeholder cwds (`…/{pi-web,sova}/targets/<name>/…`): targets.parseTargetCwd's dual
 *     roots — a placeholder is an identity, tools run on the target, and it must never classify as
 *     a moved LOCAL folder;
 *   - `…/pi-web/attachments|connect|workers/…`: unlegacyStatePath (state-root rebase);
 *   - the legacy sshfs mounts root (`~/.pi/agent/mounts/`): still refused outright;
 *   - session FILE paths: identities, unchanged by any move.
 * Tolerant by construction: a missing, unreadable or malformed file is an empty map, never a boot
 * failure. Re-read on mtime change, like model-policy.ts, so a corrected map lands without a
 * restart.
 */

interface MovedRoot {
  from: string;
  to: string;
}

const FILE = () => join(stateRoot(), "path-map.json");

let cache: { mtimeMs: number; entries: MovedRoot[] } | null = null;

/** The root itself or anything under it (prefix alone must never count a lookalike sibling). */
const isUnder = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);

function load(): MovedRoot[] {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(FILE()).mtimeMs;
  } catch {
    cache = { mtimeMs: 0, entries: [] };
    return cache.entries;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.entries;
  let entries: MovedRoot[] = [];
  try {
    const raw = JSON.parse(readFileSync(FILE(), "utf8")) as { moved?: unknown };
    if (Array.isArray(raw?.moved)) {
      entries = raw.moved
        .map((e): MovedRoot | null => {
          const m = e as { from?: unknown; to?: unknown } | null;
          return m && typeof m.from === "string" && typeof m.to === "string" && m.from.startsWith("/") && m.to.startsWith("/")
            ? { from: m.from.replace(/\/+$/, ""), to: m.to.replace(/\/+$/, "") }
            : null;
        })
        .filter((e): e is MovedRoot => e !== null && e.from !== e.to)
        // A state-root entry would double-map with unlegacyStatePath's own bridge; roots there are
        // the rename's business, not this file's. Dropped (root itself or anything under it), with
        // the rest of the file still read.
        .filter((e) => !isUnder(e.from, legacyStateRoot()) && !isUnder(e.from, stateRoot()) && !isUnder(e.to, legacyStateRoot()));
    }
  } catch {
    entries = [];
  }
  cache = { mtimeMs, entries };
  return entries;
}

/**
 * The mapped path for `p`, or `p` itself. Exact match or a child of a `from` root maps onto the
 * `to` root; longest `from` wins when entries nest. Lexical only — no fs, no symlink resolution:
 * the caller decides what to stat. Applied at open/create boundaries only; listing/display keeps
 * the stored cwd, which is the session's own history.
 */
export function movedPath(p: string): string {
  let best: MovedRoot | null = null;
  for (const e of load()) {
    if (p !== e.from && !p.startsWith(e.from + sep)) continue;
    if (!best || e.from.length > best.from.length) best = e;
  }
  return best ? best.to + p.slice(best.from.length) : p;
}
