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
 * Wire record: schema.ts LiveRecord (v=1, schemaVersion=2). Readers accept
 * legacy v1 records (no schemaVersion) through schema.parseLiveRecord.
 *   session:  SessionMeta                 — roster metadata
 *   presence: latest Presence payload     — sticky; redelivered on each heartbeat
 *   note:     transient control message   — currently { type: "visited", … }
 *   heartbeat: ms epoch of the last write
 *
 * Reads are gated per file on {mtimeMs, size, ino}: unchanged files reuse the
 * cached parsed record, but staleness/deletion is still decided every poll.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fit, parseLiveRecord, RECORD_BUDGET, SCHEMA_VERSION, type LiveRecord, type Presence, type SessionMeta } from "./schema.ts";
import { pidAlive } from "./feed.ts";

const STALE_MS = 15_000; // heartbeat older than this ⇒ peer hidden from rosters
const DELETE_MS = 90_000; // …and its file unlinked once this old (or pid dead sooner)
const NOTE_TTL_MS = 60_000; // never deliver transient notes older than this
const HEARTBEAT_MS = 3_000; // rewrite my file once heartbeat is this old

// Protocol types, originally a vendored subset of pi-intercom's extension-channel
// protocol. `heartbeat`/`legacy` are local additions describing the source record.
export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "message"; fromSessionId: string; payload: unknown; heartbeat?: number; legacy?: boolean }
  | { type: "session_joined"; session: SessionMeta; legacy?: boolean }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionMeta; legacy?: boolean };

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): { connected: boolean; supported: boolean };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  listSessions(): Promise<SessionMeta[]>;
}

export interface PresenceChannelOptions {
  /** Current roster metadata; called on every write so name/model/status stay live. */
  info(): Omit<SessionMeta, "id" | "endpointEpoch">;
  onEvent(event: IntercomExtensionEvent): void;
  /** Test override; defaults to ~/.pi/agent/sessions/live. */
  dir?: string;
  /** Test override; defaults to 2000ms. */
  pollMs?: number;
  /** Test override; minimum ms between heartbeat rewrites (default 3000). */
  heartbeatMs?: number;
  /** Total serialized record budget in UTF-8 bytes (default schema RECORD_BUDGET). */
  budgetBytes?: number;
}

/** IntercomExtensionChannel plus explicit teardown (the real channel had none). */
export interface PresenceChannel extends IntercomExtensionChannel {
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function createPresenceChannel(options: PresenceChannelOptions): PresenceChannel {
  const dir = options.dir ?? join(homedir(), ".pi", "agent", "sessions", "live");
  const pollMs = options.pollMs ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const budget = options.budgetBytes ?? RECORD_BUDGET;
  const id = `p${process.pid}-${randomUUID().slice(0, 8)}`;
  const epoch = randomUUID();
  const myPath = join(dir, `${id}.json`);
  const tmpPath = join(dir, `.${id}.${process.pid}.tmp`);

  let running = true;
  let heartbeat = 0;
  let dirty = true;
  let myPresence: Presence | undefined;
  let myNote: { payload: unknown; at: number } | undefined;
  /** Live peer records keyed by session id, refreshed by scan(). */
  const live = new Map<string, LiveRecord>();
  /** Per-peer delivery cursors. */
  const seen = new Map<string, { heartbeat: number; noteAt: number; meta: string }>();
  /** Per-file read cache: re-read and re-parse only when the file changed. */
  const files = new Map<string, { mtimeMs: number; size: number; ino: number; record: LiveRecord | undefined }>();

  function emit(event: IntercomExtensionEvent): void {
    try {
      options.onEvent(event);
    } catch { /* one bad consumer must not break the bus */ }
  }

  function selfSession(now: number): SessionMeta {
    return { ...options.info(), id, endpointEpoch: epoch, lastActivity: now };
  }

  function writeSelf(now = Date.now()): void {
    if (!running || (!dirty && now - heartbeat < heartbeatMs)) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record: LiveRecord = { v: 1, schemaVersion: SCHEMA_VERSION, session: selfSession(now), presence: myPresence, note: myNote, heartbeat: now };
      if (bytes(record) > budget) {
        // fit() mutates: never trim the caller's sticky presence object.
        if (record.presence) record.presence = structuredClone(record.presence);
        fit(record, budget);
        // The file must never exceed the budget: sacrifice the note, then presence.
        if (bytes(record) > budget) delete record.note;
        if (bytes(record) > budget) delete record.presence;
      }
      writeFileSync(tmpPath, JSON.stringify(record));
      renameSync(tmpPath, myPath); // atomic: peers never read a partial record
      heartbeat = now;
      dirty = false;
    } catch { /* unwritable dir: stay disconnected, retry next scan */ }
  }

  function read(name: string, now: number): LiveRecord | undefined {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      files.delete(name);
      return; // vanished mid-scan
    }
    const cached = files.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) return cached.record;
    let record: LiveRecord | undefined;
    try {
      record = parseLiveRecord(JSON.parse(readFileSync(path, "utf8")), now);
    } catch { /* malformed: ignore, never crash the bus */ }
    files.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, record });
    return record;
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
    const listed = new Set<string>();
    for (const name of names) {
      // Tmp files (.<id>.<pid>.tmp) and other dotfiles are never records.
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      const rid = name.slice(0, -".json".length);
      if (rid === id) continue;
      listed.add(name);
      const record = read(name, now);
      if (!record || record.session.id !== rid) continue;
      const age = now - record.heartbeat;
      if (age > STALE_MS || !pidAlive(record.session.pid)) {
        // Gone. Unlink only when certain (very stale or dead pid) so a
        // merely paused peer keeps its file and reappears seamlessly.
        if (age > DELETE_MS || !pidAlive(record.session.pid)) {
          try { rmSync(join(dir, name), { force: true }); } catch { /* not ours to lose */ }
          files.delete(name);
        }
        continue;
      }
      present.add(rid);
      live.set(rid, record);
      const legacy = record.schemaVersion === undefined;
      const cursor = seen.get(rid);
      const meta = JSON.stringify([record.session.name, record.session.status, record.session.model]);
      if (!cursor) {
        seen.set(rid, { heartbeat: record.heartbeat, noteAt: record.note?.at ?? 0, meta });
        emit({ type: "session_joined", session: record.session, legacy });
        if (record.presence !== undefined) emit({ type: "message", fromSessionId: rid, payload: record.presence, heartbeat: record.heartbeat, legacy });
        continue;
      }
      if (meta !== cursor.meta) {
        cursor.meta = meta;
        emit({ type: "presence_update", session: record.session, legacy });
      }
      // Every heartbeat rewrite redelivers the sticky presence, which is what
      // keeps the peer's 20s freshness window (state.ts FRESH_MS) alive.
      if (record.heartbeat !== cursor.heartbeat) {
        cursor.heartbeat = record.heartbeat;
        if (record.presence !== undefined) emit({ type: "message", fromSessionId: rid, payload: record.presence, heartbeat: record.heartbeat, legacy });
      }
      const noteAt = record.note?.at ?? 0;
      if (noteAt > cursor.noteAt) {
        cursor.noteAt = noteAt;
        if (now - noteAt <= NOTE_TTL_MS) emit({ type: "message", fromSessionId: rid, payload: record.note!.payload });
      }
    }
    for (const name of [...files.keys()]) if (!listed.has(name)) files.delete(name);
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
      if (isRecord(payload) && payload.type === "presence") myPresence = payload as unknown as Presence;
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
