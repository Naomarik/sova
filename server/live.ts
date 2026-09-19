import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIVE_DIR } from "./paths";

export interface LiveRecord {
  pid: number;
  status: string;
  mode: string | null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the live presence registry (~/.pi/agent/sessions/live/*.json) fresh from disk.
 * Keyed by absolute session file path. Records owned by this server process (the pi
 * "sessions" extension also runs inside our embedded runtimes) and records whose pid
 * is dead are skipped: they are not external writers.
 */
export function readLive(): Map<string, LiveRecord> {
  const out = new Map<string, LiveRecord>();
  let names: string[];
  try {
    names = readdirSync(LIVE_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(LIVE_DIR, name), "utf8"));
      const s = rec?.session;
      if (!s || typeof s.sessionFile !== "string" || typeof s.pid !== "number") continue;
      if (s.pid === process.pid || !pidAlive(s.pid)) continue;
      out.set(resolve(s.sessionFile), {
        pid: s.pid,
        status: String(rec.presence?.status ?? s.status ?? "unknown"),
        mode: typeof s.mode === "string" ? s.mode : null,
      });
    } catch {
      // partially written or malformed presence file: skip
    }
  }
  return out;
}
