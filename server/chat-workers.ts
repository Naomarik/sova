// The server's worker registry (al_3 stage 4, design §2.4; §app.chat-processes/workers): the one
// factory every worker, team member and hidden chat is started by, from one loadout (WorkerSpec), as a
// chat process of its own. A parent never talks to a worker's process: each start, send, abort and stop
// comes here (from the parent in this process, directly; from a parent in a process of its own, over
// its link), and each worker's events go back to whoever watches it, from a ring kept per worker. A
// record per worker, written before its process starts, outlives the server: the next one knows what
// each recorded process is.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerCursor, WorkerFeedFrame, WorkerHost, WorkerKind, WorkerRef, WorkerSpec, WorkerStart, WorkerState } from "../shared/chat-runtime";
import type { FrameOf } from "../shared/chat-runtime-wire";
import { CRASH_RESUME_TEXT } from "./auto-resume";
import { acquireChatHandle } from "./chat-handle";
import type { RemoteChatHandle } from "./chat-handle-remote";
import type { ChatDeath } from "./chat-runtime/supervisor";
import type { InflightMarker } from "./chat-runtime/inflight";
import { createWorkerSession } from "./harness/pi/worker-session";
import { readOverseerSettings } from "./overseer-store";
import { stateRoot } from "./state-root";

/** Frames kept per worker for its watchers (a re-watch from a cursor replays from here). */
export const WORKER_RING_MAX = 2000;
/** A run that settled with nobody watching: after this, the parent chat is opened once to take it. */
export const UNWATCHED_SETTLE_MS = 10_000;
/** How much of a dead worker's log its error keeps (§app.chat-processes/worker-crash). */
const DEATH_LINES = 20;
const DEATH_BYTES = 2048;

export const workersDir = () => join(stateRoot(), "chats", "workers");

export type Placement = WorkerRef["placement"];
type EndCause = Extract<WorkerFeedFrame, { t: "ended" }>["cause"];

export interface WorkerRecord {
  v: 1;
  chatId: string;
  path: string;
  key: string;
  kind: WorkerKind;
  parent: WorkerSpec["parent"];
  spec: WorkerSpec;
  placement: Placement;
  state: WorkerRef["state"];
  ended?: { cause: EndCause; detail?: string; logTail?: string[]; at: string };
  startedAt: string;
}

/** Where a worker's chat process runs: the router (server/chat-host.ts) does the processes. */
export interface WorkerProcesses {
  /** Start the worker chat's process and open it as that worker; its handle once open. `prefer`: the
      placement asked for (a unit unless the server places children only); the one it got. */
  start(rec: WorkerRecord, prefer: Placement): Promise<{ handle: RemoteChatHandle; placement: Placement }>;
  /** Stop its process (a kill): resolves when it is gone. */
  stop(rec: WorkerRecord): Promise<void>;
  /** The placement a new worker gets on this server. */
  placement(): Placement;
}

interface Watcher {
  fn: (f: WorkerFeedFrame) => void;
}

interface Live {
  rec: WorkerRecord;
  handle: RemoteChatHandle | null;
  /** The process its feed is from (the mirror's worker.proc), and the frames of that process. */
  proc: string | null;
  seq: number;
  ring: { cursor: WorkerCursor; event: unknown }[];
  watchers: Set<Watcher>;
  queue: WorkerState["queue"];
  lastState: string;
  lastSettledKey: string | null;
  /** Settle keys the parent chat was opened for already (once per settle). */
  opened: Set<string>;
  settleTimer: NodeJS.Timeout | null;
  /** A start or a reopen in flight. */
  opening: Promise<RemoteChatHandle> | null;
}

const log = (line: string) => console.log(`[chat-workers] ${line}`);

/** The death text (§app.chat-processes/worker-crash): how it ended, then its last output. */
export function deathText(d: Pick<ChatDeath, "exit" | "signal" | "logTail">): string {
  const how = d.exit !== null ? `exit ${d.exit}` : d.signal ? `signal ${d.signal}` : "it stopped answering";
  let tail = d.logTail.filter((l) => l.trim()).slice(-DEATH_LINES).join("\n");
  if (Buffer.byteLength(tail) > DEATH_BYTES) tail = Buffer.from(tail).subarray(-DEATH_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
  return `This worker's process stopped unexpectedly (${how})${tail.trim() ? `\nLast output: ${tail.trim()}` : ""}`;
}

export class WorkerRegistry {
  private readonly live = new Map<string, Live>();
  private readonly keys = new Map<string, string>();
  private readonly starting = new Map<string, Promise<WorkerRef>>();
  private readonly dir: () => string;
  private readonly now: () => number;

  constructor(
    private readonly procs: WorkerProcesses,
    o: { dir?: () => string; now?: () => number; autoResume?: () => boolean; openParent?: (path: string) => Promise<unknown> } = {},
  ) {
    this.dir = o.dir ?? workersDir;
    this.now = o.now ?? Date.now;
    this.autoResume = o.autoResume ?? (() => readOverseerSettings().autoResume !== false);
    this.openParent = o.openParent ?? ((path) => acquireChatHandle(path));
    for (const rec of this.readAll()) this.track(rec);
  }
  private readonly autoResume: () => boolean;
  private readonly openParent: (path: string) => Promise<unknown>;

  // ---- records ------------------------------------------------------------------------------------

  private file = (chatId: string) => join(this.dir(), `${encodeURIComponent(chatId)}.json`);
  private write(rec: WorkerRecord): void {
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const f = this.file(rec.chatId);
    writeFileSync(`${f}.tmp`, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
  private readAll(): WorkerRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir());
    } catch {
      return [];
    }
    const out: WorkerRecord[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir(), n), "utf8")) as WorkerRecord;
        if (rec?.v === 1 && rec.chatId && rec.path) out.push(rec);
      } catch {
        // half-written or foreign: not a worker of ours
      }
    }
    return out;
  }
  private track(rec: WorkerRecord): Live {
    const l: Live = {
      rec,
      handle: null,
      proc: null,
      seq: 0,
      ring: [],
      watchers: new Set(),
      queue: { steering: [], followUp: [] },
      lastState: "",
      lastSettledKey: null,
      opened: new Set(),
      settleTimer: null,
      opening: null,
    };
    this.live.set(rec.chatId, l);
    this.keys.set(rec.key, rec.chatId);
    return l;
  }
  private set(l: Live, patch: Partial<WorkerRecord>): void {
    l.rec = { ...l.rec, ...patch };
    this.write(l.rec);
  }

  /** The record of worker chat `chatId` (the router's launch env reads its spec). */
  record(chatId: string): WorkerRecord | undefined {
    return this.live.get(chatId)?.rec;
  }
  /** Whether `chatId` is a worker chat's (its process is the registry's, never an ordinary chat). */
  has(chatId: string): boolean {
    return this.live.has(chatId);
  }

  private ref(l: Live): WorkerRef {
    return {
      chatId: l.rec.chatId,
      sessionId: l.rec.chatId,
      sessionFile: l.rec.path,
      workerId: l.rec.parent.workerId,
      kind: l.rec.kind,
      placement: l.rec.placement,
      pid: l.handle && !l.handle.closed ? l.handle.at.pid : null,
      state: l.rec.state,
    };
  }

  private get(chatId: string): Live {
    const l = this.live.get(chatId);
    if (!l) throw new Error(`No worker chat ${chatId} on this server.`);
    return l;
  }

  // ---- the factory --------------------------------------------------------------------------------

  /** Start a worker chat (idempotent by key): its session file, its record, its process, its task. */
  start(req: WorkerStart): Promise<WorkerRef> {
    const known = this.keys.get(req.key);
    if (known) {
      const l = this.live.get(known)!;
      return l.opening ? l.opening.then(() => this.ref(l)) : Promise.resolve(this.ref(l));
    }
    let p = this.starting.get(req.key);
    if (!p) {
      p = this.startNew(req).finally(() => this.starting.delete(req.key));
      this.starting.set(req.key, p);
    }
    return p;
  }

  private async startNew(req: WorkerStart): Promise<WorkerRef> {
    const file = createWorkerSession(req.session, req.spec.cwd);
    const rec: WorkerRecord = {
      v: 1,
      chatId: file.sessionId,
      path: file.path,
      key: req.key,
      kind: req.spec.kind,
      parent: req.spec.parent,
      spec: req.spec,
      placement: this.procs.placement(),
      state: "open",
      startedAt: new Date(this.now()).toISOString(),
    };
    // Recorded before its process exists: a server that dies in between knows what it was.
    this.write(rec);
    const l = this.track(rec);
    try {
      await this.open(l);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.end(l, "died", { detail });
      throw err instanceof Error ? err : new Error(detail);
    }
    if (req.task !== null) await this.deliver(l, { text: req.task, key: `${req.key}:task` });
    return this.ref(l);
  }

  /** Its process, started (or started again: an idle stop, a crash resume) and open. */
  private open(l: Live): Promise<RemoteChatHandle> {
    if (l.handle && !l.handle.closed) return Promise.resolve(l.handle);
    l.opening ??= (async () => {
      try {
        const { handle, placement } = await this.procs.start(l.rec, l.rec.placement);
        if (placement !== l.rec.placement) this.set(l, { placement });
        this.attach(l, handle);
        if (l.rec.state !== "open") this.set(l, { state: "open" });
        return handle;
      } finally {
        l.opening = null;
      }
    })();
    return l.opening;
  }

  private async deliver(l: Live, input: { text: string; key: string; delivery?: "steer" | "followUp" }): Promise<{ queued: boolean }> {
    const h = await this.open(l);
    const receipt = await h.call("send", { text: input.text, key: input.key, origin: "server", report: false, ...(input.delivery ? { delivery: input.delivery } : {}) });
    return { queued: receipt.queued };
  }

  async send(chatId: string, input: { text: string; delivery: "prompt" | "steer" | "followUp"; key: string }): Promise<{ queued: boolean }> {
    const l = this.get(chatId);
    if (l.rec.state === "ended") throw new Error(`${l.rec.parent.workerId} has ended`);
    return this.deliver(l, { text: input.text, key: input.key, ...(input.delivery === "prompt" ? {} : { delivery: input.delivery }) });
  }

  async abort(chatId: string): Promise<void> {
    const l = this.get(chatId);
    if (l.handle && !l.handle.closed) await l.handle.call("abort", {});
  }

  /** Kill: its process stopped, its record ended. Repeating it is harmless. */
  async stop(chatId: string, reason: string): Promise<void> {
    const l = this.live.get(chatId);
    if (!l || l.rec.state === "ended") return;
    log(`${chatId} (${l.rec.parent.workerId}): stopping (${reason})`);
    this.set(l, { state: "ended", ended: { cause: "killed", at: new Date(this.now()).toISOString() } });
    await this.procs.stop(l.rec).catch((err) => log(`${chatId}: stop failed: ${err instanceof Error ? err.message : String(err)}`));
    l.handle = null;
    this.ended(l, { t: "ended", cause: "killed" });
  }

  /** The workers of parent session `parentSessionId` whose records have not ended. */
  list(parentSessionId: string): WorkerRef[] {
    return [...this.live.values()].filter((l) => l.rec.parent.sessionId === parentSessionId && l.rec.state !== "ended").map((l) => this.ref(l));
  }

  /** Stop every worker of parent session `parentSessionId` (it was archived or deleted). */
  async stopAllOf(parentSessionId: string, reason: string): Promise<void> {
    await Promise.all([...this.live.values()].filter((l) => l.rec.parent.sessionId === parentSessionId && l.rec.state !== "ended").map((l) => this.stop(l.rec.chatId, reason)));
  }

  // ---- the feed -----------------------------------------------------------------------------------

  /**
   * Watch worker `chatId`: from `cursor` (the frames after it, from this ring or the process's own, or
   * a gap), then its state, then each frame as it comes. Returns the unwatch.
   */
  watch(chatId: string, cursor: WorkerCursor | null, fn: (f: WorkerFeedFrame) => void): () => void {
    const l = this.get(chatId);
    const w: Watcher = { fn };
    l.watchers.add(w);
    if (l.settleTimer) {
      clearTimeout(l.settleTimer);
      l.settleTimer = null;
    }
    const emit = (f: WorkerFeedFrame) => {
      if (l.watchers.has(w)) safe(w.fn, f);
    };
    const tail = () => {
      emit({ t: "state", cursor: { proc: l.proc ?? "", seq: l.seq }, state: this.stateOf(l) });
      if (l.rec.state === "ended" && l.rec.ended) emit({ t: "ended", cause: l.rec.ended.cause, ...(l.rec.ended.detail ? { detail: l.rec.ended.detail } : {}), ...(l.rec.ended.logTail ? { logTail: l.rec.ended.logTail } : {}) });
    };
    if (!cursor || !l.proc) {
      if (cursor) emit({ t: "gap" });
      tail();
    } else if (cursor.proc !== l.proc) {
      emit({ t: "gap" });
      tail();
    } else {
      const oldest = l.ring[0]?.cursor.seq ?? l.seq + 1;
      if (cursor.seq + 1 >= oldest) {
        for (const f of l.ring) if (f.cursor.seq > cursor.seq) emit({ t: "event", cursor: f.cursor, event: f.event });
        tail();
      } else if (l.handle && !l.handle.closed) {
        // Older than this ring: the process's own may still have it. Frames that come meanwhile wait.
        const waiting: WorkerFeedFrame[] = [];
        const hold = (f: WorkerFeedFrame) => void waiting.push(f);
        w.fn = hold;
        void l.handle
          .call("feedSince", { proc: cursor.proc, seq: cursor.seq })
          .catch(() => ({ gap: true as const }))
          .then((r) => {
            if (!l.watchers.has(w)) return;
            w.fn = fn;
            if ("gap" in r) emit({ t: "gap" });
            else for (const f of r.frames) if (f.cursor.seq < oldest) emit({ t: "event", cursor: f.cursor, event: f.event });
            for (const f of l.ring) if (f.cursor.seq > cursor.seq) emit({ t: "event", cursor: f.cursor, event: f.event });
            const seen = l.ring.at(-1)?.cursor.seq ?? 0;
            for (const f of waiting) if (f.t !== "event" || f.cursor.seq > seen) emit(f);
            tail();
          });
      } else {
        emit({ t: "gap" });
        tail();
      }
    }
    return () => void l.watchers.delete(w);
  }

  private broadcast(l: Live, f: WorkerFeedFrame): void {
    for (const w of [...l.watchers]) safe(w.fn, f);
  }

  /** The worker as its watchers see it, from its process's mirror and its record. */
  private stateOf(l: Live): WorkerState {
    const m = l.handle && !l.handle.closed ? l.handle.mirror : null;
    const status: WorkerState["status"] =
      l.rec.state === "ended" ? "ended" : l.opening && !m ? "starting" : !m ? "idle" : m.running || m.starting || m.compacting ? "running" : "idle";
    return {
      status,
      sessionId: l.rec.chatId,
      sessionFile: l.rec.path,
      pid: m ? l.handle!.at.pid : null,
      model: m?.model?.ref ?? l.rec.spec.model,
      thinking: m?.thinking ?? l.rec.spec.thinking,
      lastSettled: m?.worker?.lastSettled ?? null,
      queue: l.queue,
    };
  }

  private stateChanged(l: Live): void {
    const state = this.stateOf(l);
    const json = JSON.stringify(state);
    if (json === l.lastState) return;
    l.lastState = json;
    this.broadcast(l, { t: "state", cursor: { proc: l.proc ?? "", seq: l.seq }, state });
    const key = state.lastSettled?.key ?? null;
    if (key && key !== l.lastSettledKey) {
      l.lastSettledKey = key;
      this.unwatchedSettle(l, key);
    }
  }

  /** A run settled and nobody watches: after a while, the parent chat is opened (once per settle)
      so its manager reattaches and takes the report. */
  private unwatchedSettle(l: Live, key: string): void {
    if (l.watchers.size || l.opened.has(key)) return;
    if (l.settleTimer) clearTimeout(l.settleTimer);
    l.settleTimer = setTimeout(() => {
      l.settleTimer = null;
      if (l.watchers.size || l.opened.has(key)) return;
      l.opened.add(key);
      log(`${l.rec.chatId} (${l.rec.parent.workerId}) settled with nobody watching: opening its parent`);
      void this.openParent(l.rec.parent.path).catch((err) => log(`its parent ${l.rec.parent.path} did not open: ${err instanceof Error ? err.message : String(err)}`));
    }, UNWATCHED_SETTLE_MS);
    l.settleTimer.unref?.();
  }

  // ---- what the router tells it -------------------------------------------------------------------

  /** A worker chat's process is linked (its start, a take-back after a restart, a reload's replacement). */
  attach(l: Live | string, handle: RemoteChatHandle): void {
    const live = typeof l === "string" ? this.live.get(l) : l;
    if (!live) return;
    live.handle = handle;
    this.noteProc(live);
    this.stateChanged(live);
  }

  /** A process this server took back whose mirror says it is a worker (a server restart): the record's. */
  adopt(handle: RemoteChatHandle): boolean {
    const l = this.live.get(handle.mirror.sessionId);
    if (!l) return false;
    this.attach(l, handle);
    return true;
  }

  private noteProc(l: Live): void {
    const proc = l.handle?.mirror.worker?.proc ?? null;
    if (!proc || proc === l.proc) return;
    if (l.proc) this.broadcast(l, { t: "ended", cause: "reload" });
    l.proc = proc;
    l.seq = 0;
    l.ring = [];
  }

  /** A worker chat's mirror changed. */
  onState(handle: RemoteChatHandle): void {
    const l = this.live.get(handle.mirror.sessionId);
    if (!l || l.handle !== handle) return;
    this.noteProc(l);
    this.stateChanged(l);
  }

  /** One frame of a worker chat's feed. */
  onFeed(handle: RemoteChatHandle, f: FrameOf<"feed">): void {
    const l = this.live.get(handle.mirror.sessionId);
    if (!l) return;
    if (f.cursor.proc !== l.proc) {
      if (l.proc) this.broadcast(l, { t: "ended", cause: "reload" });
      l.proc = f.cursor.proc;
      l.ring = [];
      l.seq = 0;
    }
    if (f.cursor.seq <= l.seq) return;
    l.seq = f.cursor.seq;
    l.ring.push({ cursor: f.cursor, event: f.event });
    if (l.ring.length > WORKER_RING_MAX) l.ring.splice(0, l.ring.length - WORKER_RING_MAX);
    const ev = f.event as { type?: string; steering?: unknown; followUp?: unknown };
    if (ev?.type === "queue_update") l.queue = { steering: strings(ev.steering), followUp: strings(ev.followUp) };
    this.broadcast(l, { t: "event", cursor: f.cursor, event: f.event });
    if (ev?.type === "queue_update") this.stateChanged(l);
  }

  /** Its process ended on purpose (it said why), or the supervisor stopped it as idle. */
  onExit(chatId: string, cause: string): void {
    const l = this.live.get(chatId);
    if (!l || l.rec.state === "ended") return;
    if (cause === "reload") return; // the replacement takes the handle over
    l.handle = null;
    if (cause === "archived") return; // a stop the registry asked for: stop() records it
    // An idle stop, an operator's, a close: the worker waits, and its next instruction reopens it.
    this.set(l, { state: "idle" });
    this.broadcast(l, { t: "ended", cause: "idle" });
    this.stateChanged(l);
  }

  /**
   * Its process died (§app.chat-processes/worker-crash): with a run in flight that was no resume, and
   * the setting on, it is reopened once and told to continue; otherwise it ends with the death text.
   */
  died(d: ChatDeath, marker: InflightMarker | null): void {
    const l = this.live.get(d.chatId);
    if (!l || l.rec.state === "ended") return;
    l.handle = null;
    const detail = deathText(d);
    const logTail = d.logTail.slice(-DEATH_LINES);
    if (marker && !marker.auto && this.autoResume()) {
      log(`${d.chatId} (${l.rec.parent.workerId}) died mid-run: reopening it once to continue`);
      this.broadcast(l, { t: "ended", cause: "died", detail, logTail, resuming: true });
      void (async () => {
        const h = await this.open(l);
        await h.call("markResuming", {});
        await h.call("send", { text: CRASH_RESUME_TEXT, key: `${l.rec.key}:crash:${d.at}`, origin: "server", report: false });
      })().catch((err) => {
        log(`${d.chatId}: the crash resume failed: ${err instanceof Error ? err.message : String(err)}`);
        this.end(l, "died", { detail, logTail });
      });
      return;
    }
    this.end(l, "died", { detail, logTail });
  }

  /** Children stopped with the server (child placement): their records end as stopped by the server. */
  serverStopped(chatId: string): void {
    const l = this.live.get(chatId);
    if (!l || l.rec.state === "ended") return;
    l.handle = null;
    this.end(l, "server-stopped", {});
  }

  /** At boot, after the take-back: a unit record with no process that ended in order waits, idle;
      a child's (child placement) ended with the server that ran it. */
  settleBoot(): void {
    for (const l of this.live.values()) {
      if (l.rec.state === "ended" || (l.handle && !l.handle.closed)) continue;
      if (l.rec.placement === "child") this.end(l, "server-stopped", {});
      else if (l.rec.state === "open") this.set(l, { state: "idle" });
    }
  }

  /** Every child-placement worker that is not ended (the router stops their processes). */
  children(): WorkerRecord[] {
    return [...this.live.values()].filter((l) => l.rec.placement === "child" && l.rec.state !== "ended").map((l) => l.rec);
  }

  private end(l: Live, cause: EndCause, o: { detail?: string; logTail?: string[] }): void {
    this.set(l, { state: "ended", ended: { cause, ...(o.detail ? { detail: o.detail } : {}), ...(o.logTail?.length ? { logTail: o.logTail } : {}), at: new Date(this.now()).toISOString() } });
    this.ended(l, { t: "ended", cause, ...(o.detail ? { detail: o.detail } : {}), ...(o.logTail?.length ? { logTail: o.logTail } : {}) });
  }

  private ended(l: Live, f: Extract<WorkerFeedFrame, { t: "ended" }>): void {
    this.broadcast(l, f);
    this.stateChanged(l);
  }

  // ---- hosts --------------------------------------------------------------------------------------

  /** The worker host of a parent chat in this process. */
  bind(parent: { sessionId: string; path: string }): WorkerHost {
    return {
      start: (req) => this.start(req),
      send: (chatId, input) => this.send(chatId, input),
      abort: (chatId) => this.abort(chatId),
      stop: (chatId, reason) => this.stop(chatId, reason),
      watch: (chatId, cursor, fn) => this.watch(chatId, cursor, fn),
      list: async () => this.list(parent.sessionId),
    };
  }

  /** Per parent chat process: its watches, by worker chat. */
  private readonly parentWatches = new Map<RemoteChatHandle, Map<string, () => void>>();

  /** A `wk` frame of a parent chat in a process of its own: run, then answered on its link. */
  serve(parent: RemoteChatHandle, f: FrameOf<"wk"> | FrameOf<"wk.watch"> | FrameOf<"wk.unwatch">): void {
    if (f.t === "wk.watch") {
      let mine = this.parentWatches.get(parent);
      if (!mine) this.parentWatches.set(parent, (mine = new Map()));
      mine.get(f.chatId)?.();
      try {
        mine.set(f.chatId, this.watch(f.chatId, f.cursor, (frame) => parent.sendWorker({ t: "wk.feed", chatId: f.chatId, frame })));
      } catch (err) {
        parent.sendWorker({ t: "wk.feed", chatId: f.chatId, frame: { t: "ended", cause: "died", detail: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    if (f.t === "wk.unwatch") {
      const mine = this.parentWatches.get(parent);
      mine?.get(f.chatId)?.();
      mine?.delete(f.chatId);
      return;
    }
    const a = (f.args ?? {}) as Record<string, unknown>;
    const run = (): Promise<unknown> => {
      switch (f.op) {
        case "start":
          return this.start(a as unknown as WorkerStart);
        case "send":
          return this.send(String(a.chatId), a.input as Parameters<WorkerRegistry["send"]>[1]);
        case "abort":
          return this.abort(String(a.chatId));
        case "stop":
          return this.stop(String(a.chatId), String(a.reason ?? "stopped"));
        case "list":
          return Promise.resolve(this.list(String(a.parentSessionId)));
      }
    };
    void run().then(
      (result) => parent.sendWorker({ t: "wk.result", id: f.id, ok: true, result: result ?? null }),
      (err) => parent.sendWorker({ t: "wk.result", id: f.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } }),
    );
  }

  /** A parent chat's link ended (or its process is gone): its watches go (its next control asks again). */
  parentUnlinked(parent: RemoteChatHandle): void {
    for (const off of this.parentWatches.get(parent)?.values() ?? []) off();
    this.parentWatches.delete(parent);
  }
}

function safe(fn: (f: WorkerFeedFrame) => void, f: WorkerFeedFrame): void {
  try {
    fn(f);
  } catch (err) {
    console.error("[chat-workers] watcher failed", err);
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
