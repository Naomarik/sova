// Where a chat runs (§app/chat-processes): each chat runs in a process of its own (a systemd user
// unit, else a detached session), started and taken back by the supervisor
// (server/chat-runtime/supervisor.ts) and talked to through a RemoteChatHandle. Installed into chat-handle.ts as
// its router (setChatRouter), so ws.ts and every caller of acquireChatHandle/chatHandle/chatHandles
// reach a chat the same way wherever it runs.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeExecutable } from "../pi-config/extensions/claude-code/claude-executable.ts";
import { producerId, setChildCounts } from "../pi-config/extensions/llm-inflight/tracker.ts";
import { type ChatRuntimeMirror, type ChatRuntimeSettings, DEFAULT_RUNTIME_SETTINGS, type ExitCause, type FrameOf } from "../shared/chat-runtime-wire";
import { sovaToken } from "./auth";
import {
  acquireChatHandle,
  assertOpenConfig,
  assertNotLive,
  BusyError,
  ConfigError,
  RefusedError,
  type ChatHandle,
  type CloseOpts,
  chatHandle,
  currentLinkOrigin,
  errorOfRefusal,
  onLinksNotified,
  openKindOf,
  recordConfigFailure,
  adoptSpecial,
  servedToolsFor,
  setChatRouter,
  setWorkerHostSource,
  specialHostOf,
  specialSpecFor,
  takeOpeningChoice,
} from "./chat-handle";
import { type ChatSpecialKind, isNoAnswer, type SpecialSpec, type WorkerSpec } from "../shared/chat-runtime";
import { type HeldRequests, holdRequests, RemoteChatHandle, type RemoteHooks } from "./chat-handle-remote";
import { awaitFrame, connectLink, type Link } from "./chat-runtime/link";
import { crashSkip } from "./chat-runtime/crash";
import { dropResume, type InflightMarker, markResume, pendingResumes, readInflight, takeInflight } from "./chat-runtime/inflight";
import { codeRoot, currentGeneration, type Generation, generationDir, generationHealth, isGenerationComplete, lastGood, noteGood, startGenerationGc } from "./chat-runtime/generations";
import { linkWaitReady, Rollout } from "./chat-runtime/rollout";
import {
  type ChatDeath,
  type ChatHost,
  type ChatRecord,
  type SupervisorDeps,
  ChatSupervisor,
  chatDriver,
  chatEnv,
  chooseChatHost,
  nextEpoch,
  supervisorConfig,
  sweepOldChildren,
} from "./chat-runtime/supervisor";
import { holderAlive, readLock, releaseLockOf } from "./chat-runtime/writer-lock";
import { chatBun, NO_BUN, NO_BUN_CHATS } from "./chat-runtime/bun";
import { WORKER_PROTO } from "./chat-runtime/worker-port";
import { type WorkerProcesses, type WorkerRecord, WorkerRegistry } from "./chat-workers";
import { readWorkerNice } from "./process-priority";
import type { Driver } from "./project-services/drivers";
import { addOwnPid } from "./live";
import { meshLinks } from "./mesh/links";
import { resumeCrashedChat } from "./overseer";
import { setRemoteHosted } from "./resource-monitor";
import { subagentSessionRefusal } from "./session-guards";
import { getSessionSummary } from "./sessions-index";
import { agentRoot, stateRoot } from "./state-root";
import { markOwned, recentForeignWriteAgeSec } from "./write-guard";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** How long a browser's connect waits for the chats a previous server left running to be taken back. */
const READY_WAIT_MS = 10_000;
/** How long opening a chat waits for that take-back: past its own one-minute retries, so a chat whose
    process survived is never started a second time. */
const TAKE_BACK_MAX_MS = 120_000;
/** How long a new chat process may boot before its start fails: the worst measured start under heavy load was 34 s. */
const BOOT_WAIT_MS = 40_000;

/** How this server runs chat processes, once decided at start (logged in full). */
let host: ChatHost | null = null;

/** The same for GET /api/health, which answers without sign-in: the driver, never a value from the
    environment or a probe's own text. */
export function chatHostHealth(): { driver: ChatHost["driver"] | "starting"; bun?: false; code?: "copy" | "live"; codeWhy?: string } {
  if (!host) return { driver: "starting" };
  return { driver: host.driver, ...(chatBun() ? {} : { bun: false as const }), ...generationHealth() };
}

const log = (line: string) => console.log(`[chat-host] ${line}`);

/** What a test swaps (a fake driver, links over in-memory streams); the server uses the real ones. */
export interface RouterDeps {
  driver?: Driver;
  connect?: typeof connectLink;
  /** The Bun chat processes run on, null on a Node server (the server: chatBun). */
  bun?: () => string | null;
  /** Where the supervisor keeps its records and sockets, and its units' prefix. */
  supervisor?: Pick<SupervisorDeps, "registryDir" | "deathsFile" | "socketPath" | "unitPrefix" | "isChatProcess">;
  /** Where the worker registry keeps its records. */
  workersDir?: () => string;
  /** The one-time sweep of an older server's worker children (the server: sweepOldChildren). */
  sweepChildren?: () => Promise<string[]>;
  /** The code generation chat processes start on (§app.chat-processes/code-generations); none: the checkout. */
  gen?: Generation;
  /** A crashed chat's one resume, a few seconds on (the server: overseer's resumeCrashedChat); `done` once sent or refused. */
  resumeCrashed?: (path: string, since: number, before: (path: string) => Promise<void>, done?: () => void) => void;
}

export class ChatHostRouter {
  private readonly resumeCrashed: NonNullable<RouterDeps["resumeCrashed"]>;
  private readonly remotes = new Map<string, RemoteChatHandle>();
  /** When each handle's link was last dialed again: one that ends within a second waits a second. */
  private readonly relinkedAt = new WeakMap<RemoteChatHandle, number>();
  /** Worker chats' session files: their handles are the registry's, never a browser's chat. */
  private readonly workerPaths = new Set<string>();
  /** Every worker, team member and hidden chat (§app.chat-processes/workers). */
  readonly workers: WorkerRegistry;
  /** Session id (the supervisor's chat id) → session file. */
  private readonly paths = new Map<string, string>();
  private readonly starting = new Map<string, Promise<ChatHandle>>();
  /** The code a chat's next process starts on when it is not the current copy (a fallback), by chat id. */
  private readonly codeFor = new Map<string, string>();
  /** The code each chat's process runs (its record's build), by chat id: a failed reload's way back. */
  private readonly builds = new Map<string, string>();
  /** A chat starting again on the code it ran before, after its open on new code failed: that code is
      in use from the forget until its new record is written (never collected in between). */
  private readonly restarting = new Map<string, string>();
  private readonly settings: ChatRuntimeSettings;
  private readonly sup: ChatSupervisor;
  private readonly rollout: Rollout<Link>;
  private readyP: Promise<void> = Promise.resolve();
  /** Each chat a previous server left running, by session file: its take-back (known once the
      supervisor has adopted them). */
  private takingBack: Promise<Map<string, Promise<void>>> = Promise.resolve(new Map());
  private readonly connect: typeof connectLink;
  private readonly bun: () => string | null;
  private readonly sweepChildren: (() => Promise<string[]>) | undefined;
  private readonly gen: Generation | undefined;
  /** Unused code generations collected (after the take-back, hourly, after a run of reloads). */
  private gc: { collect: () => Promise<void>; stop: () => void } | null = null;

  constructor(
    private readonly epoch: number,
    private readonly build: string,
    deps: RouterDeps = {},
  ) {
    const cfg = supervisorConfig();
    this.connect = deps.connect ?? connectLink;
    this.bun = deps.bun ?? chatBun;
    this.sweepChildren = deps.sweepChildren;
    this.gen = deps.gen;
    this.resumeCrashed = deps.resumeCrashed ?? resumeCrashedChat;
    // Every process starts on the generation's copy, the checkout when there is none: a new chat, a
    // reopen, a reload's replacement, a worker. One already running keeps its own.
    const currentCode = deps.gen?.dir ?? REPO;
    this.settings = { ...DEFAULT_RUNTIME_SETTINGS, idleStopMin: cfg.idleMs / 60_000 };
    // A worker chat's process gets its loadout's environment and agent dir, the server's state root
    // for its bookkeeping, the server's own Bun, and the worker niceness.
    const launch: SupervisorDeps["launch"] = (c) => {
      const w = this.workers?.record(c.chatId);
      const id = this.codeFor.get(c.chatId) ?? build;
      const code = id === build ? currentCode : generationDir(id);
      const bun = this.bun() ?? process.execPath;
      return {
        argv: [bun, join(code, "server", "chat-runtime", "main.ts")],
        workdir: code,
        env: chatEnv({
          serverEnv: process.env,
          bun,
          claude: claudePath(),
          home: homedir(),
          agentDir: w?.spec.agentDir ?? agentRoot(),
          extra: {
            ...w?.spec.env,
            ...(w?.spec.agentDir ? { SOVA_CHAT_STATE_ROOT: stateRoot() } : {}),
            SOVA_CHAT_SOCK: c.sock,
            SOVA_CHAT_PATH: c.sessionPath,
            SOVA_CHAT_ID: c.chatId,
            SOVA_CHAT_UNIT: c.unit,
            SOVA_CHAT_BUILD: id,
            SOVA_CHAT_LIVE_ROOT: REPO,
            SOVA_CHAT_COPIES_ROOT: codeRoot(),
          },
        }),
        build: id,
        ...(w?.spec.lowered ? { nice: readWorkerNice() } : {}),
      };
    };
    const common = {
      epoch,
      idleMs: cfg.idleMs,
      claudeIdleMax: cfg.claudeIdleMax,
      launch,
      onDeath: (d: ChatDeath) => this.died(d),
      onBootFailed: (id: string, d: ChatDeath) => {
        if (this.workers.has(id)) {
          log(`worker chat ${id}: its process did not start (${d.detail ?? d.cause})`);
          return;
        }
        log(`${id}: did not start (${d.detail ?? d.cause})`);
        this.forget(d.sessionPath);
      },
      onStopped: (id, cause) => {
        const path = this.paths.get(id);
        if (path) this.forget(path, cause);
      },
      drain: (id, reason) => this.handleOf(id)?.drain(reason) ?? Promise.resolve({ ok: false }),
      reapClaude: (id) => this.handleOf(id)?.releaseIdleModelChild() ?? Promise.resolve("none" as const),
      lockHeld: (path: string) => {
        const l = readLock(path);
        return !!l && holderAlive(l);
      },
      ownPid: addOwnPid,
    } satisfies Omit<SupervisorDeps, "driver">;
    // The units' supervisor first: it takes over the pids claimed at start (claimRecordedChats).
    this.sup = new ChatSupervisor({ ...common, driver: deps.driver ?? chatDriver({ ...cfg, driver: host?.driver ?? cfg.driver }), ...deps.supervisor });
    const procs: WorkerProcesses = {
      start: (rec) => this.startWorker(rec),
      stop: (rec) => this.stopWorker(rec),
    };
    this.workers = new WorkerRegistry(procs, deps.workersDir ? { dir: deps.workersDir } : {});
    this.rollout = new Rollout<Link>({
      supervisor: this.sup,
      waitReady: linkWaitReady({ epoch, build, settings: this.settings }),
      codeId: () => build,
      collect: () => this.gc?.collect() ?? Promise.resolve(),
      drain: (id) => this.handleOf(id)?.drain("reload") ?? Promise.resolve({ ok: false }),
      open: async (id, rep, link) => {
        if (!link) throw new Error("no link to the replacement");
        const before = this.remotes.get(rep.sessionPath);
        const mirror = await this.openOn(link, rep.sessionPath, id, false, before ? kindOfMirror(before.mirror) : null, undefined, this.workers.record(id)?.spec);
        const h = this.remotes.get(rep.sessionPath);
        if (h) h.repoint(link, { unit: rep.unit, pid: rep.pid ?? 0 }, mirror);
        else this.adoptHandle(rep, link, mirror);
        if (rep.build) this.builds.set(id, rep.build);
        this.good(rep);
      },
      setCode: (id, state, detail) => this.handleOf(id)?.pushCode(state, detail),
      onReloadOpenFailed: (id, path, reason) => {
        if (this.workers.has(id)) {
          // A worker never runs in the server: it waits, and its next instruction starts it again.
          log(`worker chat ${path}: ${reason}`);
          this.forget(path);
          this.workers.onExit(id, "closed");
          return;
        }
        // Its old process is gone: it starts again at once on the code it ran before, showing why.
        const before = this.builds.get(id);
        this.forget(path);
        log(`${path}: ${reason}; it starts again on ${before ?? "the code it ran before"}`);
        if (before) this.restarting.set(id, before);
        void this.startOnce(path, true, { code: before, why: reason })
          .catch((err) => log(`${path}: it did not start again (${err instanceof Error ? err.message : String(err)})`))
          .finally(() => this.restarting.delete(id));
      },
    });
    onLinksNotified((ids) => {
      for (const h of this.remotes.values()) h.pushLinksChanged(ids);
    });
  }

  private handleOf(sessionId: string): RemoteChatHandle | undefined {
    const path = this.paths.get(sessionId);
    return path ? this.remotes.get(path) : undefined;
  }

  /** Done with this chat's process: its panes still here reconnect quietly (the chat reopens on demand),
      except after an idle stop: they are told the chat closed, and keep what they show without
      reconnecting until they need it (§chat.transcript/instant-open). */
  private forget(path: string, cause?: ExitCause): void {
    const h = this.remotes.get(path);
    if (cause === "idle") h?.closePanesQuietly("idle");
    else h?.endPanes("Reconnecting. Your draft is kept.", "reloaded");
    if (h) {
      this.paths.delete(h.mirror.sessionId);
      this.workers.parentUnlinked(h);
      // Its model calls are no longer counted here; its tokens stay in this server's ring until they age out.
      setChildCounts(llmKey(h.mirror.sessionId), undefined);
    }
    this.remotes.delete(path);
    setRemoteHosted(path, null);
  }

  private readonly hooks: RemoteHooks = {
    state: (h) => {
      const m = h.mirror;
      const sup = this.sup;
      // Quiet is enough: an open tab doesn't keep a chat running (§app.chat-processes/idle-stop).
      sup.noteIdle(m.sessionId, m.quiet.quiet, m.quiet.since);
      sup.noteClaude(m.sessionId, m.claude);
      const w = this.workerPaths.has(h.path) ? this.workers.record(m.sessionId) : undefined;
      setRemoteHosted(h.path, {
        sessionId: m.sessionId,
        cwd: m.cwd,
        ...(m.monitor.title ? { title: m.monitor.title } : {}),
        workers: m.monitor.workers,
        toolsRunning: m.monitor.toolsRunning,
        lastToolEnd: m.monitor.lastToolEnd,
        pid: h.at.pid,
        ...(w ? { worker: { parentPath: w.parent.path, parentSessionId: w.parent.sessionId, workerId: w.parent.workerId } } : {}),
      });
      if (w) this.workers.onState(h);
      // Every chat process's model calls, counted once here (§6 of the stage-4 design): its producer is
      // then folded, so its live record (an ordinary chat's) is never summed again. Never this
      // process's own counts (a chat host in this process, as in tests): they would count themselves.
      if (m.llm && m.llm.producer !== producerId()) setChildCounts(llmKey(m.sessionId), m.llm);
    },
    exit: (h, cause) => {
      const id = h.mirror.sessionId;
      this.sup.expectExit(id, cause);
      // A reload's replacement takes the handle over (rollout's open); anything else is done.
      if (cause !== "reload") this.forget(h.path, cause);
      if (this.workers.has(id)) this.workers.onExit(id, cause);
    },
    linkEnd: (h, end) => {
      this.workers.parentUnlinked(h);
      void this.linkEnded(h, end);
    },
    reload: (h, auto) => {
      void this.rollout.request(h.mirror.sessionId, { auto }).catch((err) => log(`reload of ${h.path} failed: ${err instanceof Error ? err.message : String(err)}`));
    },
    linkLive: (id) => meshLinks.inLiveLink(id),
    feed: (h, f) => this.workers.onFeed(h, f),
    worker: (h, f) => this.workers.serve(h, f),
  };

  /** A link ended without the chat saying it exits: reconnect while its unit is up, else it is the
      supervisor's to report (one death reporter, onDeath). */
  private async linkEnded(h: RemoteChatHandle, end: { reason: string }): Promise<void> {
    // A reload's old process: its replacement takes the handle over (the rollout's open).
    if (h.closed || h.reloading || this.remotes.get(h.path) !== h) return;
    if (end.reason === "refused") {
      log(`${h.path}: another server controls this chat now`);
      this.forget(h.path);
      return;
    }
    const id = h.mirror.sessionId;
    const sup = this.sup;
    // A link that keeps ending at once never spins connect → repoint → end.
    if (Date.now() - (this.relinkedAt.get(h) ?? 0) < 1_000) await new Promise((r) => setTimeout(r, 1_000));
    const until = Date.now() + 30_000;
    while (Date.now() < until && this.remotes.get(h.path) === h) {
      const state = await sup.check(id).catch(() => "unknown" as const);
      if (state !== "up") return;
      const rec = sup.record(id);
      if (!rec) return;
      try {
        const { link } = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: h.lastSeq });
        h.repoint(link, { unit: rec.unit, pid: rec.pid ?? h.at.pid });
        this.relinkedAt.set(h, Date.now());
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (this.remotes.get(h.path) === h) await sup.lost(id, "it stopped answering").catch(() => {});
  }

  /** Send `open` on `link` and wait for its answer: the mirror, or its refusal thrown. */
  private async openOn(link: Link, path: string, sessionId: string, force: boolean, kind: OpenKind = null, built?: SpecialSpec, worker?: WorkerSpec): Promise<ChatRuntimeMirror> {
    const id = randomUUID();
    if (worker) {
      // A worker chat opens as its loadout says, with nothing an ordinary chat is served.
      const answer = awaitFrame(link, "opened", 60_000, (f) => f.id === id);
      link.send({ t: "open", id, path, force, link: null, served: [], worker });
      const f: FrameOf<"opened"> = await answer;
      if (f.ok) return f.mirror;
      if (f.refusal) throw errorOfRefusal(f.refusal);
      throw new Error(f.error?.message ?? "The worker chat did not open in its process.");
    }
    // A special chat's loadout is the server's word on it at each open (its refusal: no open); a
    // start built it already, before its process was spawned.
    const special: SpecialSpec | undefined = built ?? (kind && kind !== "powers" ? await specialSpecFor(kind, path) : undefined);
    const answer = awaitFrame(link, "opened", 60_000, (f) => f.id === id);
    const origin = currentLinkOrigin();
    const opening = takeOpeningChoice(path);
    const served = servedToolsFor(path, sessionId, () => this.remotes.get(path)?.mirror.monitor.title, kind === "powers");
    link.send({ t: "open", id, path, force, ...(opening ? { opening } : {}), link: origin ? { origin, token: sovaToken() } : null, served, ...(special ? { special } : {}) });
    const f: FrameOf<"opened"> = await answer;
    if (f.ok) return f.mirror;
    if (f.refusal) throw errorOfRefusal(f.refusal);
    throw new Error(f.error?.message ?? "The chat did not open in its process.");
  }

  private adoptHandle(rec: ChatRecord, link: Link, mirror: ChatRuntimeMirror, held?: HeldRequests): RemoteChatHandle {
    const h = new RemoteChatHandle(rec.sessionPath, rec.sessionPath, { unit: rec.unit, pid: rec.pid ?? 0 }, link, mirror, this.epoch, this.hooks, held);
    this.remotes.set(rec.sessionPath, h);
    this.paths.set(rec.chatId, rec.sessionPath);
    if (rec.build) this.builds.set(rec.chatId, rec.build);
    this.hooks.state?.(h);
    return h;
  }

  /** A special chat's composer as its kind says it is now (`push special`). */
  private pushSpecial(h: RemoteChatHandle): void {
    const kind = kindOfMirror(h.mirror);
    if (!kind || kind === "powers") return;
    h.pushComposerClosed(specialHostOf(kind)?.composerClosed?.(h.path) ?? null);
  }

  /** Every special chat this server runs in a process: its composer as its kind says it is now. */
  composersChanged(): void {
    for (const h of this.remotes.values()) if (!h.closed) this.pushSpecial(h);
  }

  /** A chat process booted and opened its chat on its code: that copy is the last known good one. */
  private good(rec: ChatRecord): void {
    if (this.gen && !this.gen.live) noteGood(rec.build ?? this.build);
  }

  /** The code every chat and worker process still runs (never collected). */
  buildsInUse(): string[] {
    return [...this.sup.list().flatMap((r) => (r.build ? [r.build] : [])), ...this.restarting.values()];
  }

  /** Take back what a previous server left running (before any chat socket is served). */
  start(): void {
    let found!: (m: Map<string, Promise<void>>) => void;
    this.takingBack = new Promise((r) => (found = r));
    this.readyP = (async () => {
      // Workers an older server ran as its own children (before every worker had a process of its own).
      for (const unit of await (this.sweepChildren ?? sweepOldChildren)()) log(`${unit}: an older server's worker child; stopped`);
      const { adopted } = await this.sup.adopt();
      const each = new Map(adopted.map((rec) => [rec.sessionPath, this.takeBack(rec)] as const));
      found(each);
      await Promise.all(each.values());
      this.workers.settleBoot();
      // Resumes the last server had not sent when it stopped: a chat it took back runs on (its marker is a live run's).
      const back = new Set(adopted.map((rec) => rec.chatId));
      for (const { sessionId, marker } of pendingResumes()) if (!back.has(sessionId) && !this.workers.has(sessionId)) this.resume(sessionId, marker);
      return true;
    })()
      .catch((err) => (log(`taking chats back failed: ${err instanceof Error ? err.message : String(err)}`), false))
      .then((tookBack) => {
        // Whatever the take-back did: no open waits on it any more, and deaths are watched. Copies no
        // chat runs any more go only after a whole take-back: one that failed may not know a
        // surviving chat, and so not its copy.
        found(new Map());
        this.sup.watch(2_000);
        if (this.gen && tookBack) this.gc = startGenerationGc(() => this.buildsInUse());
        else if (this.gen) log("unused code is not collected this server life: the take-back failed");
      });
  }

  private async takeBack(rec: ChatRecord): Promise<void> {
    const until = Date.now() + 60_000;
    for (let first = true; Date.now() < until; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, 5_000));
      let tried: Link | null = null;
      try {
        const { link } = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: null, retryForMs: first ? 5_000 : 0 });
        tried = link;
        // The calls it queued while no server was there come at once, before its state: kept for the handle.
        const held = holdRequests(link);
        const state = await awaitFrame(link, "state", 5_000);
        // A worker chat is the registry's: nothing is served to it.
        if (state.mirror.worker) {
          this.workerPaths.add(rec.sessionPath);
          const h = this.adoptHandle(rec, link, state.mirror, held);
          if (!this.workers.adopt(h)) log(`${rec.chatId}: a worker chat no worker record names`);
          return;
        }
        // Its server-hosted tools run here now, as for a chat this server opened (the same specs: the
        // chat declared them at its open).
        const kind = kindOfMirror(state.mirror);
        servedToolsFor(rec.sessionPath, state.mirror.sessionId, () => this.remotes.get(rec.sessionPath)?.mirror.monitor.title, kind === "powers");
        if (kind && kind !== "powers") await adoptSpecial(kind, rec.sessionPath);
        const h = this.adoptHandle(rec, link, state.mirror, held);
        this.pushSpecial(h);
        return;
      } catch {
        // its unit is up but it did not answer yet: again in 5 s, for a minute. A link left open would
        // stay its controller and make every retry a busy one.
        tried?.close();
      }
    }
    await this.sup.lost(rec.chatId, "it did not answer this server").catch(() => {});
  }

  ready(): Promise<void> {
    return Promise.race([this.readyP, new Promise<void>((r) => setTimeout(r, READY_WAIT_MS))]);
  }
  /** The take-back itself (each chat has a minute to answer), bounded only against a hang: of every
      chat, or with `path` of that chat's only (none when no process of it was left running). */
  private async takenBack(path?: string): Promise<void> {
    const hang = new Promise<void>((r) => setTimeout(r, TAKE_BACK_MAX_MS).unref?.());
    if (path === undefined) return Promise.race([this.readyP, hang]);
    const each = await Promise.race([this.takingBack, hang.then(() => null)]);
    const mine = each?.get(path);
    if (mine) await Promise.race([mine, hang]);
  }
  get(path: string): ChatHandle | undefined {
    const h = this.remotes.get(path);
    return h && !h.closed && !this.workerPaths.has(path) ? h : undefined;
  }
  all(): ChatHandle[] {
    return [...this.remotes.values()].filter((h) => !h.closed && !this.workerPaths.has(h.path));
  }

  async acquire(path: string, force: boolean): Promise<ChatHandle> {
    // A worker's or hidden chat's own file is never opened as a chat (the subagent-session refusal),
    // permanently: a browser never retries it.
    const s = await getSessionSummary(path).catch(() => null);
    if (this.workerPaths.has(path) || s?.workerSession) throw new ConfigError(subagentSessionRefusal(s?.title ?? "This session"), s?.cwd ?? "");
    // A chat a previous server left running is this one's once it is taken back: never started anew
    // meanwhile, however long its take-back takes. A chat with no process left opens at once.
    await this.takenBack(path);
    const open = this.remotes.get(path);
    if (open && !open.closed) {
      let again: "ok" | "reloaded" | null;
      try {
        again = await open.call("reacquire", { force });
      } catch (err) {
        // Its process exited while this open waited for it (an operator stop, an idle stop, an archive,
        // a death): the handle is gone, so the chat opens anew below, never a stale "not reachable"
        // for the pane.
        if (!isNoAnswer(err) || (this.remotes.get(path) === open && !open.closed)) throw err;
        again = null;
      }
      if (again !== null) {
        // "Chat anyway" reopens it in its process, and that close drops what this server serves it: served again.
        if (again === "reloaded") {
          const kind = kindOfMirror(open.mirror);
          servedToolsFor(path, open.mirror.sessionId, () => open.mirror.monitor.title, kind === "powers");
          if (kind && kind !== "powers") await adoptSpecial(kind, path);
        }
        return open;
      }
    }
    if (!this.bun()) throw new Error(NO_BUN_CHATS);
    return this.startOnce(path, force);
  }

  /** One start at a time per chat: a second open waits for the first. */
  private startOnce(path: string, force: boolean, back?: { code: string | undefined; why: string }): Promise<ChatHandle> {
    let p = this.starting.get(path);
    if (!p) {
      p = this.startChat(path, force, back).finally(() => this.starting.delete(path));
      this.starting.set(path, p);
    }
    return p;
  }

  /** The copy a chat whose process can't start on the current code starts on: the last good one, when
      it is another complete copy (§app/chat-processes), else none. */
  private fallbackCode(prefer?: string): string | null {
    if (!this.gen || this.gen.live) return null;
    for (const id of [prefer, lastGood()]) if (id && id !== this.build && isGenerationComplete(id)) return id;
    return null;
  }

  /**
   * Start the chat in a process of its own. One that can't start on the current code (no process, no
   * answer, a failed open) starts on the last good copy and shows why; with none, or if that fails
   * too, the open is refused with the reason. `back`: a reload's failed open, so straight to the code
   * the chat ran before.
   */
  private async startChat(path: string, force: boolean, back?: { code: string | undefined; why: string }): Promise<ChatHandle> {
    const kind: OpenKind = await openKindOf(path);
    const summary = await getSessionSummary(path).catch(() => null);
    if (!summary) throw new Error("This session's file can't be read.");
    // A special kind's refusal (a previous conversation is read-only) comes before any process starts.
    const special = kind && kind !== "powers" ? await specialSpecFor(kind, path) : undefined;
    // The cheap refusals first: no process for a doomed open.
    assertNotLive(path);
    assertOpenConfig(path);
    if (!force) {
      const age = recentForeignWriteAgeSec(path);
      if (age !== null) throw new BusyError(`modified ${age}s ago by a process we can't identify`, "recent");
    }
    // A refusal (busy, recent, config) is the caller's; the process exits by itself.
    const refused = (err: unknown) => err instanceof BusyError || err instanceof ConfigError || err instanceof RefusedError;
    const startOn = async (code: string | null) => {
      if (code) this.codeFor.set(summary.id, code);
      try {
        return await this.startProcess(
          this.sup,
          { chatId: summary.id, sessionPath: path, cwd: summary.cwd ?? REPO },
          // A special or powers chat needs a chat process that speaks proto 2 (an older one opens it as ordinary).
          kind ? 2 : 0,
          (link, rec) => this.openOn(link, path, rec.chatId, force, kind, special),
          async (h) => {
            // Its kind's every-open hook (the Overseer's mode, a baton's abilities), before anyone has it.
            const opened = kindOfMirror(h.mirror);
            if (opened && opened !== "powers") await specialHostOf(opened)?.opened?.(h);
            this.pushSpecial(h);
          },
          refused,
        );
      } catch (err) {
        // A config failure is remembered too: the next open answers from it, with no process.
        if (err instanceof ConfigError) recordConfigFailure(path, err);
        throw err;
      } finally {
        this.codeFor.delete(summary.id);
      }
    };
    const text = (err: unknown) => (err instanceof Error ? err.message : String(err));
    let why = back?.why ?? "";
    if (!back) {
      try {
        return await startOn(null);
      } catch (err) {
        if (refused(err)) throw err;
        why = `${err instanceof NoProcess ? "it could not start its process" : "it did not open in its process"} (${text(err)})`;
      }
    }
    const code = this.fallbackCode(back?.code);
    if (!code) {
      log(`${path}: ${why}; no older code to start it on`);
      throw new Error(`This chat's process didn't start: ${why}`);
    }
    log(`${path}: ${why}; starting it on ${code}`);
    try {
      const h = await startOn(code);
      h.pushCode("failed", why);
      return h;
    } catch (err) {
      if (refused(err)) throw err;
      log(`${path}: it did not start on ${code} either (${text(err)})`);
      throw new Error(`This chat's process didn't start: ${text(err)}`);
    }
  }

  /** One start path for every chat process, a chat's and a worker's: start → connect → hello (at least
      protocol `minProto`, its boot waited out) → open → adopt (→ `adopted`). A process that didn't start
      or answer throws NoProcess, the supervisor told. A failed open closes the link, expects the exit,
      stops the process unless `exitsItself(err)`, and throws its own error. */
  private async startProcess(
    sup: ChatSupervisor,
    at: { chatId: string; sessionPath: string; cwd: string },
    minProto: number,
    open: (link: Link, rec: ChatRecord) => Promise<ChatRuntimeMirror>,
    adopted?: (h: RemoteChatHandle) => Promise<void>,
    exitsItself: (err: unknown) => boolean = () => false,
  ): Promise<RemoteChatHandle> {
    let rec: ChatRecord;
    try {
      rec = await sup.start(at);
    } catch (err) {
      throw new NoProcess(err instanceof Error ? err.message : String(err));
    }
    let link: Link;
    try {
      const c = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: null, retryForMs: 10_000 });
      link = c.link;
      sup.noteConnected(rec.chatId);
      if (c.hello.proto < minProto) throw new Error(`its process speaks protocol ${c.hello.proto}, below ${minProto}`);
      if (c.hello.state === "booting") await awaitFrame(link, "hello", BOOT_WAIT_MS, (h) => h.state !== "booting");
    } catch (err) {
      await sup.lost(rec.chatId, `no hello: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      throw new NoProcess(err instanceof Error ? err.message : String(err));
    }
    try {
      const h = this.adoptHandle(rec, link, await open(link, rec));
      this.good(rec);
      await adopted?.(h);
      return h;
    } catch (err) {
      sup.expectExit(rec.chatId, "refused");
      link.close();
      if (!exitsItself(err)) await sup.stop(rec.chatId, "refused").catch(() => {});
      throw err;
    }
  }

  async close(path: string, message: string, opts: CloseOpts = {}): Promise<boolean> {
    const h = this.remotes.get(path);
    if (!h || h.closed) return false;
    const sid = h.mirror.sessionId;
    // An archive: its tabs are told first, so the chat's own goodbye (`reloaded`, from its dispose)
    // reaches none of them and none reconnects, which would start the archived chat again.
    if (opts.quiet) h.closePanesQuietly(opts.quiet);
    this.sup.expectExit(sid, "archived");
    const r = await h.drain("archived", { force: true, message });
    if (!r.ok) await this.sup.stop(sid, "archived").catch(() => {});
    this.forget(path);
    return true;
  }

  // ---- worker chats (§app.chat-processes/workers) ----------------------------------------------------

  /** Start worker chat `rec` in a process of its own and open it as its loadout; a process that does
      not start or answer fails the start with its reason. */
  private async startWorker(rec: WorkerRecord): Promise<RemoteChatHandle> {
    if (!this.bun()) throw new Error(NO_BUN);
    await this.takenBack();
    this.workerPaths.add(rec.path);
    try {
      // Opened as its loadout says, with no foreign-write guard (the registry wrote its file and is
      // its only opener); a failed open (a model that can not be set, a refusal) fails the start.
      const at = { chatId: rec.chatId, sessionPath: rec.path, cwd: rec.spec.cwd };
      return await this.startProcess(this.sup, at, WORKER_PROTO, (link) => this.openOn(link, rec.path, rec.chatId, true, null, undefined, rec.spec));
    } catch (err) {
      this.workerPaths.delete(rec.path);
      throw err instanceof NoProcess ? new Error(`The worker's process did not start: ${err.message}`) : err;
    }
  }

  /** Stop worker chat `rec`'s process (a kill): resolves once it is gone. */
  private async stopWorker(rec: WorkerRecord): Promise<void> {
    const h = this.remotes.get(rec.path);
    this.sup.expectExit(rec.chatId, "archived");
    const r = h && !h.closed ? await h.drain("archived", { force: true, message: "This worker was stopped." }) : { ok: false };
    if (r.ok) await this.sup.awaitExit(rec.chatId);
    await this.sup.stop(rec.chatId, "archived").catch(() => {});
    this.forget(rec.path);
  }

  /** A chat or worker process died (§app.chat-processes/crash, /worker-crash): a chat's panes are
      told, its last writes are the server's while it still held the file's lock (let go first, so a
      crash resume can open the file again), and one crash rule (crashSkip) decides on its run. */
  private died(d: ChatDeath): void {
    const path = d.sessionPath;
    const h = this.remotes.get(path);
    const worker = this.workers.has(d.chatId);
    const special = h && !worker ? kindOfMirror(h.mirror) : null;
    const pid = h?.at.pid ?? this.sup.record(d.chatId)?.pid ?? d.pid ?? null;
    if (!worker) {
      const how = d.exit !== null ? `exit ${d.exit}` : d.signal ? `signal ${d.signal}` : "it stopped answering";
      const tail = d.logTail.slice(-3).join("\n").slice(-300);
      h?.endPanes(`This chat's process stopped unexpectedly (${how}). Your messages are saved; it reopens when you reconnect.${tail ? `\nLast output: ${tail}` : ""}`);
    }
    this.forget(path);
    // Step 0 (design §4.5): the dead process held the lock and nobody wrote since it ended.
    const lock = readLock(path);
    if (lock && pid !== null && lock.pid === pid && !holderAlive(lock)) {
      // When it ended: the journal's word, else when this server saw it go (it was linked to it). A
      // death found at a start with no end time (the detached driver) has no bound: a later append by
      // anyone would read as ours, so only what the process recorded as its own counts.
      const bound = d.endedAt ?? (h ? d.at : null);
      try {
        if (bound && statSync(path).mtimeMs <= Date.parse(bound)) markOwned(path);
      } catch {
        // the file is gone: nothing to record
      }
      releaseLockOf(path, lock);
    }
    if (worker) return this.workers.died(d, takeInflight(d.chatId));
    if (special && special !== "powers") specialHostOf(special)?.died?.(path);
    const marker = readInflight(d.chatId);
    if (marker && !crashSkip(marker)) this.resume(d.chatId, marker);
    else takeInflight(d.chatId);
  }

  /** A crashed chat's one resume: marked on disk until sent or refused, so a server stop before then leaves it to the next. */
  private resume(chatId: string, marker: InflightMarker): void {
    markResume(chatId, marker);
    this.resumeCrashed(
      marker.path,
      marker.since,
      async (p) => {
        await (await acquireChatHandle(p)).markResuming();
      },
      () => dropResume(chatId),
    );
  }

  /** The server is stopping: chats in their own process run on; each is told goodbye, never stopped. */
  detach(): void {
    for (const h of this.remotes.values()) h.bye();
    this.sup.detach();
  }
}

/** The key a chat process's model-call counts are kept under in this server's tracker. */
const llmKey = (sessionId: string) => `chat:${sessionId}`;

/** A chat's process did not start or never answered (not an open it refused). */
class NoProcess extends Error {}

/** What a chat opens as, for where it runs: a special kind, a powers profile, or null (ordinary). */
type OpenKind = Awaited<ReturnType<typeof openKindOf>>;

/** A chat process's kind, from its mirror: a special kind's, "powers" for a powers profile, else null. */
function kindOfMirror(m: ChatRuntimeMirror): ChatSpecialKind | "powers" | null {
  return m.special ?? (m.profile?.profile?.grant.length ? "powers" : null);
}

function claudePath(): string | null {
  try {
    return claudeExecutable();
  } catch {
    return null;
  }
}

let router: ChatHostRouter | null = null;

/** Decide where ordinary chats run, and with the switch on take back the chats a previous server
    left running. Called once at start, before chat sockets are served: until it is done, a browser's
    connect waits (bounded) instead of opening a chat a process may still hold. */
export function startChatHost(): void {
  const boot = (async () => {
    host = await chooseChatHost();
    log(`chats run in processes of their own, as ${host.why}${chatBun() ? "" : `; this server runs on Node, so every chat open is refused`}`);
    // Chats start on this server's own copy of its code (made now, or reused).
    const gen = await currentGeneration({ log });
    router = new ChatHostRouter(nextEpoch(), gen.id, { gen });
    router.start();
  })().catch((err) => log(`start failed: ${err instanceof Error ? err.message : String(err)}`));
  // Every parent chat in this process starts its workers here, once the router is up.
  setWorkerHostSource((parent) => {
    const later = <T,>(fn: (r: ChatHostRouter) => Promise<T>): Promise<T> =>
      Promise.race([boot, new Promise<void>((r) => setTimeout(r, TAKE_BACK_MAX_MS).unref?.())]).then(() => {
        if (!router) throw new Error("The Sova server's chat host did not start.");
        return fn(router);
      });
    return {
      start: (req) => later((r) => r.workers.bind(parent).start(req)),
      send: (chatId, input) => later((r) => r.workers.bind(parent).send(chatId, input)),
      abort: (chatId) => later((r) => r.workers.bind(parent).abort(chatId)),
      stop: (chatId, reason) => later((r) => r.workers.bind(parent).stop(chatId, reason)),
      list: () => later((r) => r.workers.bind(parent).list()),
      watch: (chatId, cursor, fn) => {
        let off: (() => void) | null = null;
        let gone = false;
        void later(async (r) => {
          if (!gone) off = r.workers.bind(parent).watch(chatId, cursor, fn);
        }).catch((err) => fn({ t: "ended", cause: "died", detail: err instanceof Error ? err.message : String(err) }));
        return () => {
          gone = true;
          off?.();
        };
      },
    };
  });
  setChatRouter({
    ready: () => Promise.race([boot.then(() => router?.ready()), new Promise<void>((r) => setTimeout(r, 2 * READY_WAIT_MS))]),
    get: (path) => router?.get(path),
    all: () => router?.all() ?? [],
    // Opening waits for the router itself (the server's build can take seconds to compute).
    acquire: async (path, force) => {
      await Promise.race([boot, new Promise<void>((r) => setTimeout(r, TAKE_BACK_MAX_MS).unref?.())]);
      if (!router) throw new Error("The Sova server's chat host did not start.");
      return router.acquire(path, force);
    },
    close: (path, message, opts) => (router ? router.close(path, message, opts) : Promise.resolve(false)),
    composersChanged: () => router?.composersChanged(),
  });
}

/** At shutdown: let go of every chat process (they run on), never stop one. */
export function detachChatHost(): void {
  router?.detach();
}

/** Parent session `sessionId` was archived or deleted: its workers stop. */
export async function stopWorkersOf(sessionId: string, reason: string): Promise<void> {
  await router?.workers.stopAllOf(sessionId, reason);
}

/** The handle `chatHandle` finds, if it is a chat process's (tests, health). */
export const isRemote = (path: string): boolean => chatHandle(path)?.where === "process";
