/**
 * Local filesystem presence bus: the standalone replacement for the pi-intercom
 * channel this extension originally consumed.
 *
 * Every pi process running this extension atomically rewrites
 *   ~/.pi/agent/sessions/live/<id>.json
 * every few seconds (heartbeat) and polls the directory for peers. A record
 * whose heartbeat is stale *and* whose pid is dead is unlinked; staleness alone
 * (e.g. a busy event loop) only hides the peer until it resumes. No broker
 * process, no sockets, no singleton claiming — the directory is the registry.
 *
 * Wire record (v=1):
 *   session:  SessionInfo                 — roster metadata
 *   presence: latest Presence payload     — sticky; redelivered on each heartbeat
 *   note:     transient control message   — currently { type: "visited", … }
 *   heartbeat: ms epoch of the last write
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IntercomExtensionChannel, IntercomExtensionEvent, SessionInfo } from "./intercom.ts";

const STALE_MS = 15_000; // heartbeat older than this ⇒ peer hidden from rosters
const DELETE_MS = 90_000; // …and its file unlinked once this old (or pid dead sooner)
const NOTE_TTL_MS = 60_000; // never deliver transient notes older than this
const HEARTBEAT_MS = 3_000; // rewrite my file once heartbeat is this old

interface LiveRecord {
  v: 1;
  session: SessionInfo;
  presence?: unknown;
  note?: { payload: unknown; at: number };
  heartbeat: number;
}

export interface PresenceChannelOptions {
  /** Current roster metadata; called on every write so name/model/status stay live. */
  info(): Omit<SessionInfo, "id" | "endpointEpoch">;
  onEvent(event: IntercomExtensionEvent): void;
  /** Test override; defaults to ~/.pi/agent/sessions/live. */
  dir?: string;
  /** Test override; defaults to 2000ms. */
  pollMs?: number;
  /** Test override; minimum ms between heartbeat rewrites (default 3000). */
  heartbeatMs?: number;
}

/** IntercomExtensionChannel plus explicit teardown (the real channel had none). */
export interface PresenceChannel extends IntercomExtensionChannel {
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecord(value: unknown): value is LiveRecord {
  if (!isRecord(value)) return false;
  const s = value.session;
  return value.v === 1
    && typeof value.heartbeat === "number" && Number.isFinite(value.heartbeat)
    && isRecord(s)
    && typeof s.id === "string" && typeof s.pid === "number" && Number.isFinite(s.pid)
    && typeof s.cwd === "string" && typeof s.model === "string"
    && typeof s.startedAt === "number" && typeof s.lastActivity === "number"
    && (s.name === undefined || typeof s.name === "string");
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function createPresenceChannel(options: PresenceChannelOptions): PresenceChannel {
  const dir = options.dir ?? join(homedir(), ".pi", "agent", "sessions", "live");
  const pollMs = options.pollMs ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const id = `p${process.pid}-${randomUUID().slice(0, 8)}`;
  const epoch = randomUUID();
  const myPath = join(dir, `${id}.json`);
  const tmpPath = join(dir, `.${id}.${process.pid}.tmp`);

  let running = true;
  let heartbeat = 0;
  let dirty = true;
  let myPresence: unknown;
  let myNote: { payload: unknown; at: number } | undefined;
  /** Live peer records keyed by session id, refreshed by scan(). */
  const live = new Map<string, LiveRecord>();
  /** Per-peer delivery cursors. */
  const seen = new Map<string, { heartbeat: number; noteAt: number; meta: string }>();

  function emit(event: IntercomExtensionEvent): void {
    try {
      options.onEvent(event);
    } catch { /* one bad consumer must not break the bus */ }
  }

  function selfSession(now: number): SessionInfo {
    return { ...options.info(), id, endpointEpoch: epoch, lastActivity: now };
  }

  function writeSelf(now = Date.now()): void {
    if (!running || (!dirty && now - heartbeat < heartbeatMs)) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record: LiveRecord = { v: 1, session: selfSession(now), presence: myPresence, note: myNote, heartbeat: now };
      writeFileSync(tmpPath, JSON.stringify(record));
      renameSync(tmpPath, myPath); // atomic: peers never read a partial record
      heartbeat = now;
      dirty = false;
    } catch { /* unwritable dir: stay disconnected, retry next scan */ }
  }

  function scan(now = Date.now()): void {
    writeSelf(now);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // dir unreadable this tick; keep previous view
    }
    const present = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rid = name.slice(0, -".json".length);
      if (rid === id) continue;
      let record: unknown;
      try {
        record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue; // malformed: ignore, never crash the bus
      }
      if (!validRecord(record) || record.session.id !== rid) continue;
      const age = now - record.heartbeat;
      if (age > STALE_MS || !pidAlive(record.session.pid)) {
        // Gone. Unlink only when certain (very stale or dead pid) so a
        // merely paused peer keeps its file and reappears seamlessly.
        if (age > DELETE_MS || !pidAlive(record.session.pid)) {
          try { rmSync(join(dir, name), { force: true }); } catch { /* not ours to lose */ }
        }
        continue;
      }
      present.add(rid);
      live.set(rid, record);
      const cursor = seen.get(rid);
      const meta = JSON.stringify([record.session.name, record.session.status, record.session.model]);
      if (!cursor) {
        seen.set(rid, { heartbeat: record.heartbeat, noteAt: record.note?.at ?? 0, meta });
        emit({ type: "session_joined", session: record.session });
        if (record.presence !== undefined) emit({ type: "message", fromSessionId: rid, payload: record.presence });
        continue;
      }
      if (meta !== cursor.meta) {
        cursor.meta = meta;
        emit({ type: "presence_update", session: record.session });
      }
      // Every heartbeat rewrite redelivers the sticky presence, which is what
      // keeps the peer's 20s freshness window (state.ts FRESH_MS) alive.
      if (record.heartbeat !== cursor.heartbeat) {
        cursor.heartbeat = record.heartbeat;
        if (record.presence !== undefined) emit({ type: "message", fromSessionId: rid, payload: record.presence });
      }
      const noteAt = record.note?.at ?? 0;
      if (noteAt > cursor.noteAt) {
        cursor.noteAt = noteAt;
        if (now - noteAt <= NOTE_TTL_MS) emit({ type: "message", fromSessionId: rid, payload: record.note!.payload });
      }
    }
    for (const rid of [...seen.keys()]) {
      if (present.has(rid)) continue;
      seen.delete(rid);
      live.delete(rid);
      emit({ type: "session_left", sessionId: rid });
    }
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeSelf();
  scan();
  const timer = setInterval(() => scan(), pollMs);
  timer.unref();
  // Matches the old registry behaviour: ready means connected.
  queueMicrotask(() => { if (running) emit({ type: "connection", connected: true, supported: true }); });

  return {
    namespace: "pi-sessions/v1",
    snapshot() {
      return { connected: running && heartbeat > 0, supported: true };
    },
    publish(payload) {
      // Presence payloads are sticky; everything else (visited/hello) is a
      // transient note so it never displaces the presence peers rely on.
      if (isRecord(payload) && payload.type === "presence") myPresence = payload;
      else myNote = { payload, at: Date.now() };
      dirty = true;
      writeSelf();
    },
    async listSessions() {
      const now = Date.now();
      const sessions = [selfSession(now)];
      for (const [rid, record] of live) {
        if (now - record.heartbeat <= STALE_MS && pidAlive(record.session.pid)) sessions.push(record.session);
        else { live.delete(rid); seen.delete(rid); }
      }
      return sessions;
    },
    close() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      try { rmSync(myPath, { force: true }); } catch { /* best effort */ }
      try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    },
  };
}
