import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Shared with the frontend (src/): a non-live session whose file changed within this window
 * may be written by a pi process we can't identify (e.g. a headless/orchestrating pi that is
 * not in the TUI live registry). /ws/chat refuses it unless the client connects with &force=1.
 */
export const RECENT_WRITE_MS = 120_000;

/** Stat of files this server last left them in (created via POST, or at runtime dispose). */
const ownedStat = new Map<string, { size: number; mtimeMs: number }>();

export function markOwned(path: string): void {
  try {
    const st = statSync(path);
    ownedStat.set(path, { size: st.size, mtimeMs: st.mtimeMs });
  } catch {
    ownedStat.delete(path);
  }
}

/**
 * Returns seconds since the last modification if the file was changed recently by someone
 * other than this server, else null.
 */
export function recentForeignWriteAgeSec(path: string): number | null {
  const st = statSync(path);
  const own = ownedStat.get(path);
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

  constructor(
    private readonly path: string,
    private readonly isKnownId: (id: string) => boolean,
  ) {
    this.offset = statSync(path).size;
  }

  /** Returns a reason string if a foreign write is detected, else null. */
  check(): string | null {
    const { size } = statSync(this.path);
    if (size < this.offset) return "session file shrank (rewritten by another process)";
    if (size === this.offset) return null;
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
    if (nl < 0) return null; // a line is mid-write; judge it once complete
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
    return null;
  }
}
