import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, LIVE_DIR } from "./paths";

export interface LiveRecord {
  pid: number;
  status: string;
  mode: string | null;
  /** From presence.workerCounts (sessions extension schema v2); absent for older writers. */
  workers?: { working: number; total: number };
}

/** A parsed live file whose pid is alive. `rec` is untrusted JSON: consumers parse defensively. */
export interface RawLiveRecord {
  sessionFile: string | null; // canonical; null for ephemeral sessions
  pid: number;
  rec: any;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * All live files (~/.pi/agent/sessions/live/*.json) with an alive pid, read fresh from disk.
 * Contract: pi-config/extensions/sessions/public/SCHEMA.md. Read-only: never delete or
 * rewrite anything there, not even dead records (pi writers clean those up).
 */
export function readLiveRecords(opts: { includeOwn?: boolean } = {}): RawLiveRecord[] {
  const out: RawLiveRecord[] = [];
  let names: string[];
  try {
    names = readdirSync(LIVE_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue; // dotfiles = writers' temp files
    try {
      const rec = JSON.parse(readFileSync(join(LIVE_DIR, name), "utf8"));
      const s = rec?.session;
      if (!s || typeof s.pid !== "number") continue;
      if ((s.pid === process.pid && !opts.includeOwn) || !pidAlive(s.pid)) continue;
      out.push({ sessionFile: typeof s.sessionFile === "string" ? canonicalPath(s.sessionFile) : null, pid: s.pid, rec });
    } catch {
      // partially written or malformed presence file: skip
    }
  }
  return out;
}

/** presence.workerCounts (working/total) of a raw record, or undefined when absent or malformed. */
export function workerCountsOf(rec: any): { working: number; total: number } | undefined {
  const wc = rec?.presence?.workerCounts;
  const working = count(wc?.working);
  const total = count(wc?.total);
  return working !== null && total !== null ? { working, total } : undefined;
}

/** Same threshold as insights' "fresh" (SCHEMA.md): writers heartbeat every ~3-4s. */
const OWN_FRESH_MS = 15_000;

/**
 * This server's own live records (written by the sessions extension inside our embedded chat
 * runtimes), keyed by canonical session file; the freshest heartbeat wins. Stale ones are skipped:
 * a runtime that went away without its clean-shutdown delete must not report workers forever.
 * They never mean "a TUI owns it" (see readLive).
 */
export function readOwnLiveRecords(): Map<string, RawLiveRecord> {
  const out = new Map<string, RawLiveRecord>();
  const now = Date.now();
  const beat = (r: RawLiveRecord) => (typeof r.rec.heartbeat === "number" ? r.rec.heartbeat : 0);
  for (const r of readLiveRecords({ includeOwn: true })) {
    if (r.pid !== process.pid || !r.sessionFile || now - beat(r) > OWN_FRESH_MS) continue;
    const prev = out.get(r.sessionFile);
    if (!prev || beat(r) > beat(prev)) out.set(r.sessionFile, r);
  }
  return out;
}

/**
 * Live presence keyed by absolute session file path. Records owned by this server process
 * (the pi "sessions" extension also runs inside our embedded runtimes) are skipped: they
 * are not external writers.
 */
export function readLive(): Map<string, LiveRecord> {
  const out = new Map<string, LiveRecord>();
  for (const { sessionFile, pid, rec } of readLiveRecords()) {
    if (!sessionFile) continue;
    const s = rec.session;
    const wc = rec.presence?.workerCounts;
    const working = count(wc?.working);
    const total = count(wc?.total);
    out.set(sessionFile, {
      pid,
      status: String(rec.presence?.status ?? s.status ?? "unknown"),
      mode: typeof s.mode === "string" ? s.mode : null,
      ...(working !== null && total !== null ? { workers: { working, total } } : {}),
    });
  }
  return out;
}
