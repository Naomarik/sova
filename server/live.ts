import { type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { canonicalPath, LIVE_DIR } from "./paths";

export interface LiveRecord {
  pid: number;
  status: string;
  mode: string | null;
  /** From presence.workerCounts (sessions extension schema v2); absent for older writers. */
  workers?: { working: number; total: number };
  /** The presence outline broadcast (topic-outline), untrusted JSON: { now, generatedAt, … }. */
  outline?: unknown;
  /** presence.activity (sessions extension schema v2), when the writer sends one. */
  activity?: LiveActivity;
}

/** The part of presence.activity Sova reads (SCHEMA.md "Activity"). */
export interface LiveActivity {
  state: "working" | "idle" | "needs-input" | "error";
  /** ms epoch the state began; 0 unknown. */
  since: number;
  /** Only with state "error", ≤200 chars. */
  error?: string;
  lastAssistantAt?: number;
}

const ACTIVITY_STATES = new Set(["working", "idle", "needs-input", "error"]);

/** presence.activity of a raw record, parsed defensively; undefined when absent or malformed. */
export function activityOf(rec: any): LiveActivity | undefined {
  const a = rec?.presence?.activity;
  if (!a || typeof a !== "object" || !ACTIVITY_STATES.has(a.state)) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    state: a.state,
    since: num(a.since) ?? 0,
    ...(a.state === "error" && typeof a.error === "string" && a.error ? { error: a.error.slice(0, 200) } : {}),
    ...(num(a.lastAssistantAt) !== undefined ? { lastAssistantAt: num(a.lastAssistantAt) } : {}),
  };
}

/** presence.workerCounts.error: workers that ended in an error, or 0. Killed ones are left out:
    a kill is usually the user's own gesture, not something to bring back to them. */
export function failedWorkersOf(rec: any): number {
  return count(rec?.presence?.workerCounts?.error) ?? 0;
}

/** When each worker ROW in status `error` ended (endedAt, else lastActivity, else startedAt), for
    the rows that carry a time. Rows can be dropped for size (SCHEMA.md §5,
    finished ones first), so this may cover fewer workers than failedWorkersOf counts. */
export function workerErrorTimesOf(rec: any): number[] {
  const rows = rec?.presence?.workers;
  if (!Array.isArray(rows)) return [];
  const out: number[] = [];
  for (const w of rows) {
    if (!w || typeof w !== "object" || w.status !== "error") continue;
    const t = [w.endedAt, w.lastActivity, w.startedAt].find((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
    if (t !== undefined) out.push(t);
  }
  return out;
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

/**
 * The processes whose live records are this server's own: the chats it hosts write them (the pi
 * "sessions" extension runs inside every hosted chat). Today every hosted chat runs in this process;
 * a chat this server hosts in a process of its own is added here for as long as it lives, so its
 * record never reads as a TUI owning the file, and a process that is not in the set always does.
 */
const ownPids = new Set<number>([process.pid]);
/** Whether a live record's pid is one of this server's hosted chats. */
export const isOwnPid = (pid: number): boolean => ownPids.has(pid);
/** A process hosting this server's chats, until the returned call removes it (never this process). */
export function addOwnPid(pid: number): () => void {
  if (ownPids.has(pid)) return () => {};
  ownPids.add(pid);
  return () => {
    ownPids.delete(pid);
  };
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Each live file's parse, by name, kept while its stat stamp holds: writers replace a record by
    rename (a new inode) on every heartbeat, so an unchanged stamp is an unchanged record. */
const parsed = new Map<string, { stamp: string; record: RawLiveRecord | null }>();

/**
 * The last listing's records, shared by every caller while it holds. It holds while the folder's
 * own stamp is unchanged (writers rename a temp file over their record, SCHEMA.md, and every
 * rename, new record or removal moves it, so those are seen at once, in the same tick), no event
 * arrived on the folder's watch since (an in-place rewrite, or two renames inside one timestamp
 * tick), and it is younger than VIEW_MAX_AGE_MS (a missed event). Without a watch (none could be
 * set, or it errored) every call lists the folder again, as before.
 *
 * File times are coarse (a clock tick of a few ms): a change in the same tick as the listing can
 * leave the stamp as it was. So a listing made while the folder's stamp is younger than
 * SETTLE_MS is never kept: once it is older, any later change gets a newer stamp.
 */
let view: { dirStamp: string; at: number; records: RawLiveRecord[] } | null = null;
let watcher: { w: FSWatcher; ino: bigint } | null = null;
export const VIEW_MAX_AGE_MS = 2_000;
const SETTLE_MS = 50;
/** How many times the folder was listed (tests and measurement). */
export let liveListings = 0;

function unwatch(): void {
  watcher?.w.close();
  watcher = null;
  view = null;
}

function ensureWatch(ino: bigint): void {
  if (watcher?.ino === ino) return;
  unwatch(); // a folder replaced by another (new inode): the old watch sees nothing more
  try {
    const w = watch(LIVE_DIR, { persistent: false }, () => {
      view = null;
    });
    w.on("error", () => {
      if (watcher?.w === w) unwatch();
      else w.close();
    });
    watcher = { w, ino };
  } catch {
    // unwatchable: list on every call
  }
}

/**
 * All live files (~/.pi/agent/sessions/live/*.json) with an alive pid. The folder is listed and
 * each file stat'ed only when the shared view no longer holds (see `view`); a file is read and
 * parsed again only when its stamp moved. Pids are checked on every call (a process that dies
 * writes nothing). Contract: pi-config/extensions/sessions/public/SCHEMA.md. Read-only: never
 * delete or rewrite anything there, not even dead records (pi writers clean those up). `rec` is
 * shared between calls: consumers never mutate it.
 */
export function readLiveRecords(opts: { includeOwn?: boolean } = {}): RawLiveRecord[] {
  const out: RawLiveRecord[] = [];
  for (const r of liveView()) {
    if ((isOwnPid(r.pid) && !opts.includeOwn) || !pidAlive(r.pid)) continue;
    out.push({ sessionFile: r.sessionFile, pid: r.pid, rec: r.rec });
  }
  return out;
}

function liveView(): RawLiveRecord[] {
  let dir;
  try {
    dir = statSync(LIVE_DIR, { bigint: true });
  } catch {
    parsed.clear();
    unwatch();
    return [];
  }
  const dirStamp = `${dir.ino}:${dir.size}:${dir.mtimeNs}:${dir.ctimeNs}`;
  const now = Date.now();
  if (view && watcher && view.dirStamp === dirStamp && now - view.at < VIEW_MAX_AGE_MS) return view.records;
  ensureWatch(dir.ino);
  const records = listLive();
  // Kept only with a watch armed before the listing: an event after it clears the view.
  const changedMs = Number((dir.mtimeNs > dir.ctimeNs ? dir.mtimeNs : dir.ctimeNs) / 1_000_000n);
  view = watcher && records && now - changedMs >= SETTLE_MS ? { dirStamp, at: now, records } : null;
  return records ?? [];
}

/** Every parseable record in the folder, dead pids included; null when it can't be listed. */
function listLive(): RawLiveRecord[] | null {
  liveListings++;
  const out: RawLiveRecord[] = [];
  let names: string[];
  try {
    names = readdirSync(LIVE_DIR);
  } catch {
    parsed.clear();
    return null;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue; // dotfiles = writers' temp files
    seen.add(name);
    const path = join(LIVE_DIR, name);
    let stamp: string;
    try {
      const st = statSync(path, { bigint: true });
      stamp = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch {
      continue; // removed since the listing
    }
    let hit = parsed.get(name);
    if (hit?.stamp !== stamp) {
      let record: RawLiveRecord | null = null;
      try {
        const rec = JSON.parse(readFileSync(path, "utf8"));
        const s = rec?.session;
        if (s && typeof s.pid === "number") record = { sessionFile: typeof s.sessionFile === "string" ? canonicalPath(s.sessionFile) : null, pid: s.pid, rec };
      } catch {
        // partially written or malformed presence file: skip until it changes
      }
      hit = { stamp, record };
      parsed.set(name, hit);
    }
    if (hit.record) out.push(hit.record);
  }
  for (const name of parsed.keys()) if (!seen.has(name)) parsed.delete(name);
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
    if (!isOwnPid(r.pid) || !r.sessionFile || now - beat(r) > OWN_FRESH_MS) continue;
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
      ...(rec.presence?.outline !== undefined ? { outline: rec.presence.outline } : {}),
      ...(activityOf(rec) ? { activity: activityOf(rec) } : {}),
    });
  }
  return out;
}

/** How recent a heartbeat must be for the archive guard to believe a record's worker count.
    Looser than OWN_FRESH_MS on purpose: a false "working" costs the user a wait, a false "idle"
    kills their subagents. */
export const WORKING_FRESH_MS = 30_000;
/** SCHEMA.md: a heartbeat this far in the future is garbage, not fresh. */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Subagents working in the session at `path` right now, read fresh from every live record for
 * that file — this server's own embedded runtime AND any other process hosting it (a TUI,
 * another Sova server). The sessions extension rewrites its record ~150ms after the subagent
 * manager's worker snapshot changes, so this is as fresh as the server can see without
 * importing pi-config; the list's `workers` field is the same data, but a poll old in the
 * browser. Dead pids are already dropped by readLiveRecords; stale heartbeats are ignored here.
 * The largest count wins when several processes claim the file.
 */
export function workingSubagents(path: string, records: RawLiveRecord[] = readLiveRecords({ includeOwn: true }), now = Date.now()): number {
  let working = 0;
  for (const r of records) {
    if (r.sessionFile !== path) continue;
    const beat = typeof r.rec?.heartbeat === "number" ? r.rec.heartbeat : 0;
    if (now - beat > WORKING_FRESH_MS || beat - now > FUTURE_SKEW_MS) continue;
    working = Math.max(working, workerCountsOf(r.rec)?.working ?? 0);
  }
  return working;
}
