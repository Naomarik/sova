import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Shared with the frontend (src/): a non-live session whose file changed within this window
 * may be written by a pi process we can't identify (e.g. a headless/orchestrating pi that is
 * not in the TUI live registry). /ws/chat refuses it unless the client connects with &force=1.
 */
export const RECENT_WRITE_MS = 120_000;

/**
 * The stat each session file was last left in by THIS server — any of its processes, earlier ones
 * included — persisted under the state root as `owned-writes.json` (`{ [path]: {size, mtimeMs, at} }`).
 * A restart used to forget it, so the file the server was writing a second ago read as "changed by
 * a process we can't identify" and opened read-only for 120s.
 *
 * A stat is recorded only where our write is certain: a file POST /api/sessions just created, an
 * entry a held runtime just appended, and — the continuous case — after ForeignWriteGuard has
 * verified that every line past its offset is an entry our own SessionManager knows. It matches
 * only when size AND mtime are both unchanged, so any later append by anyone breaks it. A TUI-live
 * session never gets this far: assertNotLive refuses it first.
 */
const OWNED_FILE = () => join(stateRoot(), "owned-writes.json");
/** Entries kept: the most recent by `at`. A dropped one only means the old 120s guard applies. */
const OWNED_MAX = 500;

type Owned = Record<string, { size: number; mtimeMs: number; at: number }>;

function loadOwned(): Owned {
  try {
    const v = JSON.parse(readFileSync(OWNED_FILE(), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Owned = {};
    for (const [k, e] of Object.entries(v as Record<string, any>)) {
      if (e && Number.isFinite(e.size) && Number.isFinite(e.mtimeMs)) out[k] = { size: e.size, mtimeMs: e.mtimeMs, at: Number(e.at) || 0 };
    }
    return out;
  } catch {
    return {}; // missing or corrupt: nothing is ours, the plain guard applies
  }
}

/** Re-read, merge this one path, trim, write atomically (tmp + rename): several servers may share it. */
function saveOwned(path: string, entry: Owned[string] | null): void {
  const next = loadOwned();
  const prev = next[path];
  if (entry && prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs) return; // unchanged: no write
  if (entry) next[path] = entry;
  else if (prev) delete next[path];
  else return;
  const kept = Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, OWNED_MAX);
  try {
    const file = OWNED_FILE();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    renameSync(tmp, file);
  } catch (err) {
    console.error("[write-guard] couldn't record an owned write", err);
  }
}

/** Record a stat ForeignWriteGuard verified (`verified()`): exactly what was checked, never a later stat. */
export function markOwnedStat(path: string, stat: { size: number; mtimeMs: number }): void {
  saveOwned(path, { size: stat.size, mtimeMs: stat.mtimeMs, at: Date.now() });
}

/** Record the file's current stat as ours. Call only right after a write that is certainly ours. */
export function markOwned(path: string): void {
  try {
    const st = statSync(path);
    saveOwned(path, { size: st.size, mtimeMs: st.mtimeMs, at: Date.now() });
  } catch {
    saveOwned(path, null);
  }
}

/**
 * Returns seconds since the last modification if the file was changed recently by someone
 * other than this server, else null.
 */
export function recentForeignWriteAgeSec(path: string): number | null {
  const st = statSync(path);
  const own = loadOwned()[path];
  if (own && own.size === st.size && own.mtimeMs === st.mtimeMs) return null;
  const age = Date.now() - st.mtimeMs;
  return age < RECENT_WRITE_MS ? Math.max(0, Math.round(age / 1000)) : null;
}

/**
 * Detects writes to a session file that did not come from our runtime: every complete line
 * appended after `offset` must be an entry whose id our SessionManager already knows
 * (SessionManager adds entries to its index before appending them to disk).
 */
export class ForeignWriteGuard {
  private offset: number;
  private mtimeMs: number;

  constructor(
    private readonly path: string,
    private readonly isKnownId: (id: string) => boolean,
  ) {
    const st = statSync(path);
    this.offset = st.size;
    this.mtimeMs = st.mtimeMs;
  }

  /**
   * The file state every byte of which is either what we opened or a line our own SessionManager
   * wrote, as of the last check(); null while a line is still mid-write. This is the only stat a
   * runtime records as its own (markOwnedStat).
   */
  verified(): { size: number; mtimeMs: number } | null {
    return this.pending ? null : { size: this.offset, mtimeMs: this.mtimeMs };
  }

  /** A partial trailing line was seen at the last check: the file is not fully verified. */
  private pending = false;

  /** Returns a reason string if a foreign write is detected, else null. */
  check(): string | null {
    const { size, mtimeMs } = statSync(this.path);
    if (size < this.offset) return "session file shrank (rewritten by another process)";
    // Our runtime only ever appends (SessionManager rewrites in place only when opening), so a
    // changed mtime without growth means someone else modified the file in place.
    if (size === this.offset) {
      this.pending = false;
      return mtimeMs !== this.mtimeMs ? "session file modified in place by another process" : null;
    }
    const fd = openSync(this.path, "r");
    let data: Buffer;
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      data = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
    const nl = data.lastIndexOf(0x0a);
    if (nl < 0) {
      this.pending = true;
      return null; // a line is mid-write; judge it once complete
    }
    for (const line of data.subarray(0, nl + 1).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let id: unknown;
      try {
        id = JSON.parse(line)?.id;
      } catch {
        return "unparseable line appended by another process";
      }
      if (typeof id !== "string" || !this.isKnownId(id)) return "entries appended by another process";
    }
    this.offset += nl + 1;
    this.mtimeMs = mtimeMs;
    this.pending = this.offset < size; // bytes past the last newline are still being written
    return null;
  }
}
