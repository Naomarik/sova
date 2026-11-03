// The server's worker registry (al_3 stage 4, design §2.4; §app.chat-processes/workers): the one
// factory every worker, team member and hidden chat is started by, from one loadout (WorkerSpec), as a
// chat process of its own. A parent never talks to a worker's process: each start, send, abort and stop
// comes here (from the parent in this process, directly; from a parent in a process of its own, over
// its link), and each worker's events go back to whoever watches it, from a ring kept per worker. A
// record per worker, written before its process starts, outlives the server: the next one knows what
// each recorded process is.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNoAnswer, NO_ANSWER, type WorkerCursor, type WorkerFeedFrame, type WorkerHost, type WorkerKind, type WorkerRef, type WorkerSpec, type WorkerStart, type WorkerState } from "../shared/chat-runtime";
import type { FrameOf } from "../shared/chat-runtime-wire";
import type { HEntry } from "../shared/harness";
import { CRASH_RESUME_TEXT } from "./auto-resume";
import { acquireChatHandle } from "./chat-handle";
import { isArchived } from "./archived-sessions";
import type { RemoteChatHandle } from "./chat-handle-remote";
import type { ChatDeath } from "./chat-runtime/supervisor";
import { crashResumeOn, crashSkip } from "./chat-runtime/crash";
import type { InflightMarker } from "./chat-runtime/inflight";
import { joinedText, toHEntry } from "./harness/pi/reader";
import { createWorkerSession } from "./harness/pi/worker-session";
import { logAutoResume } from "./overseer-store";
import { stateRoot } from "./state-root";

/** Frames kept per worker for its watchers (a re-watch from a cursor replays from here). */
export const WORKER_RING_MAX = 2000;
/** A run that settled with nobody watching: after this, the parent chat is opened once to take it. */
export const UNWATCHED_SETTLE_MS = 10_000;
/** A parent that did not open for a settle is tried again after these (then it is the next server's). */
const SETTLE_RETRY_MS = [10_000, 30_000, 90_000];
/** How much of a dead worker's log its error keeps (§app.chat-processes/worker-crash). */
const DEATH_LINES = 20;
const DEATH_BYTES = 2048;

export const workersDir = () => join(stateRoot(), "chats", "workers");

/** A parent chat, as its link or its binding names it. */
type Parent = { sessionId: string; path: string };
type EndCause = Extract<WorkerFeedFrame, { t: "ended" }>["cause"];

export interface WorkerRecord {
  v: 1;
  chatId: string;
  path: string;
  key: string;
  kind: WorkerKind;
  parent: WorkerSpec["parent"];
  spec: WorkerSpec;
  state: WorkerRef["state"];
  ended?: { cause: EndCause; detail?: string; logTail?: string[]; at: string };
  startedAt: string;
  /** The last settle key a watcher was told of or its parent was opened for: a server that takes the
      worker back announces only a settle after it. */
  seenSettleKey?: string;
  /** Its first task while not yet taken (cleared once it is): a server that dies first leaves the
      start for the next one to finish. `from`: the session file's size when the start began. */
  task?: { text: string; key: string; from: number };
}

/** Where a worker's chat process runs: the router (server/chat-host.ts) does the processes. */
export interface WorkerProcesses {
  /** Start the worker chat's process and open it as that worker; its handle once open. */
  start(rec: WorkerRecord): Promise<RemoteChatHandle>;
  /** Stop its process (a kill): resolves when it is gone. */
  stop(rec: WorkerRecord): Promise<void>;
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
  /** Its first task being handed over (once at a time). */
  finishing: Promise<void> | null;
}

const log = (line: string) => console.log(`[chat-workers] ${line}`);

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Whether a user message holding `task.text` was written to session file `path` after `task.from`. */
function sessionHolds(path: string, task: { text: string; from: number }): boolean {
  // An empty task matches any message: never taken for one. A file shorter than at the start was
  // rewritten: what follows `from` is no record of this start (the key still dedupes on a live process).
  if (!task.text.trim()) return false;
  let tail: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.length < task.from) return false;
    tail = bytes.subarray(task.from).toString("utf8");
  } catch {
    return false;
  }
  for (const line of tail.split("\n")) {
    if (!line.includes('"user"')) continue;
    let h: HEntry | null;
    try {
      h = toHEntry(JSON.parse(line));
    } catch {
      continue; // a partial last line
    }
    if (h?.kind === "user" && joinedText(h, { sep: "", images: false }).includes(task.text)) return true;
  }
  return false;
}

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
    o: {
      dir?: () => string;
      now?: () => number;
      autoResume?: () => boolean;
      openParent?: (path: string) => Promise<unknown>;
      /** Whether a parent session is archived: a report never opens it (§app.chat-processes/workers). */
      archived?: (sessionId: string) => boolean;
      logResume?: (args: { path: string; parent: string; workerId: string }, why?: string) => void;
    } = {},
  ) {
    this.dir = o.dir ?? workersDir;
    this.now = o.now ?? Date.now;
    this.autoResume = o.autoResume ?? crashResumeOn;
    this.openParent = o.openParent ?? ((path) => acquireChatHandle(path));
    this.archived = o.archived ?? isArchived;
    this.logResume = o.logResume ?? logAutoResume;
    for (const rec of this.readAll()) this.track(rec);
  }
  private readonly autoResume: () => boolean;
  private readonly openParent: (path: string) => Promise<unknown>;
  private readonly archived: (sessionId: string) => boolean;
  private readonly logResume: (args: { path: string; parent: string; workerId: string }, why?: string) => void;

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
      lastSettledKey: rec.seenSettleKey ?? null,
      opened: new Set(),
      settleTimer: null,
      opening: null,
      finishing: null,
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
    const pending = this.starting.get(req.key);
    if (pending) return pending;
    const known = this.keys.get(req.key);
    if (known) {
      const l = this.live.get(known)!;
      // A start this server or the last recorded and never finished: finished now, its ref once the task is taken.
      if (l.rec.state !== "ended" && l.rec.task) return this.finishStart(l).then(() => this.ref(l));
      return l.opening ? l.opening.then(() => this.ref(l)) : Promise.resolve(this.ref(l));
    }
    const p = this.startNew(req).finally(() => this.starting.delete(req.key));
    this.starting.set(req.key, p);
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
      state: "open",
      startedAt: new Date(this.now()).toISOString(),
      ...(req.task !== null ? { task: { text: req.task, key: `${req.key}:task`, from: sizeOf(file.path) } } : {}),
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
    await this.finishStart(l);
    return this.ref(l);
  }

  /** Hand a start's first task over, once (under its key; not again if its session already holds it). */
  private finishStart(l: Live): Promise<void> {
    const task = l.rec.task;
    if (!task) return Promise.resolve();
    l.finishing ??= (async () => {
      try {
        // Taken by a process that has since gone (its receipts with it), the answer lost: its session says so.
        if (!sessionHolds(l.rec.path, task)) await this.deliver(l, { text: task.text, key: task.key });
        this.set(l, { task: undefined });
      } catch (err) {
        // Nobody holds it yet: a worker whose task was refused is stopped, never left running unowned.
        await this.stop(l.rec.chatId, "its task was not accepted");
        throw err;
      } finally {
        l.finishing = null;
      }
    })();
    return l.finishing;
  }

  /** Its process, started (or started again: an idle stop, a crash resume) and open. */
  private open(l: Live): Promise<RemoteChatHandle> {
    if (l.handle && !l.handle.closed) return Promise.resolve(l.handle);
    l.opening ??= (async () => {
      try {
        const handle = await this.procs.start(l.rec);
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
    // A report still waiting to open its parent goes with it (an archived parent opens for none).
    this.cancelSettle(l);
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
    // Every report still waiting to open the parent, an ended worker's included.
    for (const l of this.live.values()) if (l.rec.parent.sessionId === parentSessionId) this.cancelSettle(l);
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
    if (l.lastSettledKey) this.seen(l, l.lastSettledKey);
    const emit = (f: WorkerFeedFrame) => {
      if (l.watchers.has(w)) safe(w.fn, f);
    };
    const tail = () => {
      emit({ t: "state", cursor: { proc: l.proc ?? "", seq: l.seq }, state: this.stateOf(l) });
      const e = l.rec.ended;
      if (l.rec.state !== "ended" || !e) return;
      // An older server's record of a worker it stopped with itself (it ran workers as its children).
      const legacy = (e.cause as string) === "server-stopped";
      const detail = legacy ? "Sova's server stopped this worker with it" : e.detail;
      emit({ t: "ended", cause: legacy ? "died" : e.cause, ...(detail ? { detail } : {}), ...(e.logTail ? { logTail: e.logTail } : {}) });
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
      ...(m?.worker?.keys ? { keys: true as const } : {}),
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
      if (l.watchers.size) this.seen(l, key);
      else this.unwatchedSettle(l, key);
    }
  }

  private cancelSettle(l: Live): void {
    if (l.settleTimer) clearTimeout(l.settleTimer);
    l.settleTimer = null;
  }

  private seen(l: Live, key: string): void {
    if (l.rec.seenSettleKey !== key) this.set(l, { seenSettleKey: key });
  }

  /** A run settled and nobody watches: after a while, the parent chat is opened (once per settle)
      so its manager reattaches and takes the report. */
  private unwatchedSettle(l: Live, key: string, retry = 0): void {
    if (l.watchers.size || l.opened.has(key)) return;
    if (this.archived(l.rec.parent.sessionId)) return;
    if (l.settleTimer) clearTimeout(l.settleTimer);
    l.settleTimer = setTimeout(
      () => {
        l.settleTimer = null;
        if (l.watchers.size || l.opened.has(key) || l.lastSettledKey !== key) return;
        // Archived meanwhile: an archived parent is never opened for a report.
        if (this.archived(l.rec.parent.sessionId)) return;
        // Seen only once the parent opened: a failed open is tried again, and after the last try left to the next server.
        l.opened.add(key);
        log(`${l.rec.chatId} (${l.rec.parent.workerId}) settled with nobody watching: opening its parent`);
        this.openParent(l.rec.parent.path).then(
          () => this.seen(l, key),
          (err) => {
            l.opened.delete(key);
            log(`its parent ${l.rec.parent.path} did not open: ${err instanceof Error ? err.message : String(err)}`);
            if (retry < SETTLE_RETRY_MS.length) this.unwatchedSettle(l, key, retry + 1);
          },
        );
      },
      retry ? SETTLE_RETRY_MS[retry - 1]! : UNWATCHED_SETTLE_MS,
    );
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
    const w = l.handle?.mirror.worker;
    const proc = w?.proc ?? null;
    if (!proc) return;
    // The process's feed is past what this server got (a take-back, or frames sent while no server was
    // linked): this ring starts there, so an older cursor reads the process's own ring (feedSince).
    const seq = typeof w?.seq === "number" ? w.seq : 0;
    if (proc === l.proc) {
      if (seq > l.seq) {
        l.seq = seq;
        l.ring = [];
        // A watcher missed them: it resyncs from its file and the next state.
        this.broadcast(l, { t: "gap" });
      }
      return;
    }
    if (l.proc) this.broadcast(l, { t: "ended", cause: "reload" });
    l.proc = proc;
    l.seq = seq;
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
    this.waitIdle(l);
  }

  private waitIdle(l: Live): void {
    this.set(l, { state: "idle" });
    this.broadcast(l, { t: "ended", cause: "idle" });
    this.stateChanged(l);
  }

  /**
   * Its process died (§app.chat-processes/worker-crash), under the one crash rule (crashSkip): a run
   * in flight is continued once; with none it waits idle; otherwise it ends with the death text.
   */
  died(d: ChatDeath, marker: InflightMarker | null): void {
    const l = this.live.get(d.chatId);
    if (!l || l.rec.state === "ended") return;
    // A reopen is in flight (this death's resume, or a late second report of the same death): the
    // process now starting is not the one that died.
    if (l.opening) return log(`${d.chatId}: a death reported while it reopens; ignored`);
    l.handle = null;
    const detail = deathText(d);
    const logTail = d.logTail.slice(-DEATH_LINES);
    const args = { path: l.rec.path, parent: l.rec.parent.path, workerId: l.rec.parent.workerId };
    const why = crashSkip(marker, this.autoResume());
    if (why === "no run in flight") {
      log(`${d.chatId} (${l.rec.parent.workerId}) died idle (${detail.split("\n")[0]}): it waits for its next instruction`);
      this.logResume(args, why);
      return this.waitIdle(l);
    }
    if (!why) {
      log(`${d.chatId} (${l.rec.parent.workerId}) died mid-run: reopening it once to continue`);
      this.broadcast(l, { t: "ended", cause: "died", detail, logTail, resuming: true });
      void (async () => {
        const h = await this.open(l);
        await h.call("markResuming", {});
        await h.call("send", { text: CRASH_RESUME_TEXT, key: `${l.rec.key}:crash:${d.at}`, origin: "server", report: false });
      })().then(
        () => this.logResume(args),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`${d.chatId}: the crash resume failed: ${msg}`);
          this.logResume(args, `reopen failed: ${msg}`);
          this.end(l, "died", { detail, logTail });
        },
      );
      return;
    }
    this.logResume(args, why);
    this.end(l, "died", { detail, logTail });
  }

  /** At boot, after the take-back: a record with no process that ended in order waits, idle. */
  settleBoot(): void {
    for (const l of this.live.values()) {
      if (l.rec.state === "ended" || l.opening || (l.handle && !l.handle.closed)) continue;
      if (l.rec.state === "open") this.set(l, { state: "idle" });
    }
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

  /** A parent reaches its own workers only: worker ids repeat in every session. The parent is the
      one its link or its binding names, never what a request says. */
  private mine(parent: Parent, chatId: string): string {
    const l = this.live.get(chatId);
    if (!l || l.rec.parent.sessionId !== parent.sessionId) throw new Error(`No worker chat ${chatId} for this session.`);
    return chatId;
  }
  private async startFor(parent: Parent, req: WorkerStart): Promise<WorkerRef> {
    const p = req?.spec?.parent;
    if (!p || p.sessionId !== parent.sessionId) throw new Error("A worker chat is started by its own parent session only.");
    const known = this.keys.get(req.key);
    if (known) this.mine(parent, known);
    // Its parent's file as the link or binding names it (canonical), never as the request spells it.
    return this.start(p.path === parent.path ? req : { ...req, spec: { ...req.spec, parent: { ...p, path: parent.path } } });
  }

  /** The worker host of a parent chat in this process. */
  bind(parent: Parent): WorkerHost {
    return {
      start: (req) => this.startFor(parent, req),
      send: async (chatId, input) => this.send(this.mine(parent, chatId), input),
      abort: async (chatId) => this.abort(this.mine(parent, chatId)),
      stop: async (chatId, reason) => this.stop(this.mine(parent, chatId), reason),
      watch: (chatId, cursor, fn) => this.watch(this.mine(parent, chatId), cursor, fn),
      list: async () => this.list(parent.sessionId),
    };
  }

  /** Per parent chat process: its watches, by worker chat. */
  private readonly parentWatches = new Map<RemoteChatHandle, Map<string, () => void>>();

  /** A `wk` frame of a parent chat in a process of its own: run, then answered on its link. */
  serve(parent: RemoteChatHandle, f: FrameOf<"wk"> | FrameOf<"wk.watch"> | FrameOf<"wk.unwatch">): void {
    const who: Parent = { sessionId: parent.mirror.sessionId, path: parent.path };
    if (f.t === "wk.watch") {
      let mine = this.parentWatches.get(parent);
      if (!mine) this.parentWatches.set(parent, (mine = new Map()));
      mine.get(f.chatId)?.();
      try {
        mine.set(f.chatId, this.watch(this.mine(who, f.chatId), f.cursor, (frame) => parent.sendWorker({ t: "wk.feed", chatId: f.chatId, frame })));
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
    const run = async (): Promise<unknown> => {
      switch (f.op) {
        case "start":
          return this.startFor(who, a as unknown as WorkerStart);
        case "send":
          return this.send(this.mine(who, String(a.chatId)), a.input as Parameters<WorkerRegistry["send"]>[1]);
        case "abort":
          return this.abort(this.mine(who, String(a.chatId)));
        case "stop":
          return this.stop(this.mine(who, String(a.chatId)), String(a.reason ?? "stopped"));
        case "list":
          return this.list(who.sessionId);
      }
    };
    void run().then(
      (result) => parent.sendWorker({ t: "wk.result", id: f.id, ok: true, result: result ?? null }),
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        parent.sendWorker({ t: "wk.result", id: f.id, ok: false, error: { message, ...(isNoAnswer(err) ? { code: NO_ANSWER } : {}) } });
      },
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
