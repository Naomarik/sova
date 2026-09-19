/**
 * Consumer-side view of the live directory: pure, stateless, node-only.
 * Shared by presence.ts, the overlay and the standalone `pi-sessions` CLI, so
 * the same no-pi-deps / erasable-syntax rules as schema.ts apply here.
 *
 * readLiveDir() takes a full snapshot; diffLive() turns two snapshots into
 * FeedEvents. Heartbeat-only rewrites (every ~3–4s) and `note` traffic never
 * produce events; liveness transitions (fresh ⇄ stale/dead) do.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { countWorkers, deriveState, parseLiveRecord, type LiveRecord, type SessionState } from "./schema.ts";

export const STALE_MS = 15_000; // heartbeat older than this ⇒ not fresh
export const DELETE_MS = 90_000; // writers unlink records this old (or with a dead pid)
export const HEARTBEAT_MS = 3_000; // min gap between heartbeat rewrites (checked on a 2s poll)
export const FEED_VERSION = 1;

export interface LiveSession {
  id: string;
  record: LiveRecord;
  /** now - heartbeat ≤ STALE_MS and the pid is alive. */
  fresh: boolean;
  /** ms since heartbeat. */
  age: number;
  /** record.schemaVersion absent. */
  legacy: boolean;
  state: SessionState;
  attention: "needs-input" | "error" | "none";
  workersWorking: number;
}

export type FeedEvent =
  | { type: "hello"; at: number; feedVersion: 1; schemaVersion: 2; dir: string }
  | { type: "snapshot"; at: number; sessions: LiveSession[] }
  | { type: "upsert"; at: number; session: LiveSession; changed: string[] }
  | { type: "remove"; at: number; id: string; reason: "left" | "stale" | "dead" | "invalid" }
  | { type: "error"; at: number; message: string };

export type FeedState = Map<string, { record: LiveRecord; hash: string; fresh: boolean }>;

export function defaultLiveDir(): string {
  return join(homedir(), ".pi", "agent", "sessions", "live");
}

export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string })?.code === "EPERM";
  }
}

export function toLiveSession(record: LiveRecord, now = Date.now()): LiveSession {
  const age = now - record.heartbeat;
  const state = deriveState(record.presence, record.session);
  const p = record.presence;
  return {
    id: record.session.id, record, age,
    fresh: age <= STALE_MS && pidAlive(record.session.pid),
    legacy: record.schemaVersion === undefined, state,
    attention: state === "needs-input" || state === "error" ? state : "none",
    workersWorking: p ? (p.workerCounts ?? countWorkers(p.workers)).working : 0,
  };
}

/** Every valid record in `dir` (fresh or not), sorted by id. Never throws. */
export function readLiveDir(dir: string, now = Date.now()): LiveSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: LiveSession[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      const record = parseLiveRecord(JSON.parse(readFileSync(join(dir, name), "utf8")), now);
      // The file stem is the identity; a mismatched id is someone else's record.
      if (record && record.session.id === name.slice(0, -".json".length)) sessions.push(toLiveSession(record, now));
    } catch { /* unreadable, vanished mid-scan, or malformed: skip */ }
  }
  return sessions;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => v === undefined ? "null" : stable(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Content without the fields every heartbeat rewrite touches or pi-internal notes. */
function payload(record: LiveRecord): Record<string, unknown> {
  const { heartbeat: _h, note: _n, session, ...rest } = record;
  const { lastActivity: _l, ...meta } = session;
  return { ...rest, session: meta };
}

/** Stable hash of the record EXCLUDING heartbeat, session.lastActivity and note. */
export function hashRecord(record: LiveRecord): string {
  return createHash("sha1").update(stable(payload(record))).digest("hex");
}

function changedPaths(prev: LiveRecord, next: LiveRecord): string[] {
  const a = payload(prev), b = payload(next);
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key], y = b[key];
    if (stable(x) === stable(y)) continue;
    if ((key === "session" || key === "presence") && x && y && typeof x === "object" && typeof y === "object") {
      const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
      for (const sub of new Set([...Object.keys(ox), ...Object.keys(oy)]))
        if (stable(ox[sub]) !== stable(oy[sub])) changed.push(`${key}.${sub}`);
    } else changed.push(key);
  }
  return changed.sort();
}

/** The diff baseline for the next call: pass readLiveDir()'s result. */
export function feedState(sessions: LiveSession[]): FeedState {
  return new Map(sessions.map(s => [s.id, { record: s.record, hash: hashRecord(s.record), fresh: s.fresh }]));
}

/**
 * Events turning `prev` into `next`. Only fresh sessions are ever announced:
 * - unseen/previously-unfresh id becomes fresh ⇒ upsert (changed: top-level
 *   subtrees for a new id; "fresh" plus any payload paths for a revival)
 * - fresh ⇒ fresh with a different hash ⇒ upsert with dotted changed paths
 * - fresh ⇒ not fresh ⇒ remove "dead" (pid gone) or "stale" (heartbeat > 15s)
 * - fresh ⇒ absent ⇒ remove "left"
 * Heartbeat-only rewrites produce nothing. Callers keep `feedState(next)`.
 */
export function diffLive(prev: FeedState, next: LiveSession[], now = Date.now()): FeedEvent[] {
  const events: FeedEvent[] = [];
  const seen = new Set<string>();
  for (const session of next) {
    seen.add(session.id);
    const old = prev.get(session.id);
    if (!session.fresh) {
      if (old?.fresh) {
        const dead = session.age <= STALE_MS || !pidAlive(session.record.session.pid);
        events.push({ type: "remove", at: now, id: session.id, reason: dead ? "dead" : "stale" });
      }
      continue;
    }
    if (!old) {
      events.push({ type: "upsert", at: now, session,
        changed: ["session", "presence"].filter(k => session.record[k as keyof LiveRecord] !== undefined) });
      continue;
    }
    const hashChanged = hashRecord(session.record) !== old.hash;
    if (old.fresh && !hashChanged) continue;
    const changed = hashChanged ? changedPaths(old.record, session.record) : [];
    if (!old.fresh) changed.unshift("fresh");
    events.push({ type: "upsert", at: now, session, changed });
  }
  for (const [id, old] of prev) {
    if (!seen.has(id) && old.fresh) events.push({ type: "remove", at: now, id, reason: "left" });
  }
  return events;
}

export function makeHello(dir: string, now = Date.now()): FeedEvent {
  return { type: "hello", at: now, feedVersion: 1, schemaVersion: 2, dir };
}
