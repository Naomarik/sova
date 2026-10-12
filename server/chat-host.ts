// Where an ordinary chat runs (§app/chat-processes): with SOVA_CHAT_HOST=out on a host where it can
// apply, each ordinary chat runs in a process of its own, started and taken back by the supervisor
// (server/chat-runtime/supervisor.ts) and talked to through a RemoteChatHandle; everything else, and
// everything when the switch is off, runs in this process as before. Installed into chat-handle.ts as
// its router (setChatRouter), so ws.ts and every caller of acquireChatHandle/chatHandle/chatHandles
// reach a chat the same way wherever it runs.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeExecutable } from "../pi-config/extensions/claude-code/claude-executable.ts";
import { type ChatRuntimeMirror, type ChatRuntimeSettings, DEFAULT_RUNTIME_SETTINGS, type FrameOf } from "../shared/chat-runtime-wire";
import { sovaToken } from "./auth";
import {
  acquireChatHandle,
  activeConfigFailure,
  assertNotLive,
  BusyError,
  ConfigError,
  RefusedError,
  type ChatHandle,
  chatHandle,
  currentLinkOrigin,
  errorOfRefusal,
  onLinksNotified,
  openKindOf,
  servedToolsFor,
  setChatRouter,
  takeOpeningChoice,
} from "./chat-handle";
import { RemoteChatHandle, type RemoteHooks } from "./chat-handle-remote";
import { awaitFrame, connectLink, type Link } from "./chat-runtime/link";
import { takeInflight } from "./chat-runtime/inflight";
import { linkWaitReady, Rollout } from "./chat-runtime/rollout";
import {
  type ChatDeath,
  type ChatHost,
  type ChatRecord,
  ChatSupervisor,
  chatDriver,
  chatEnv,
  chooseChatHost,
  nextEpoch,
  supervisorConfig,
} from "./chat-runtime/supervisor";
import { holderAlive, readLock, releaseLockOf } from "./chat-runtime/writer-lock";
import type { Driver } from "./project-services/drivers";
import { addOwnPid } from "./live";
import { bootBuildChecked } from "./mesh/build-id";
import { meshLinks } from "./mesh/links";
import { resumeCrashedChat } from "./overseer";
import { setRemoteHosted } from "./resource-monitor";
import { getSessionSummary } from "./sessions-index";
import { agentRoot } from "./state-root";
import { markOwned, recentForeignWriteAgeSec } from "./write-guard";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** How long a browser's connect waits for the chats a previous server left running to be taken back. */
const READY_WAIT_MS = 10_000;

let host: ChatHost = { mode: "in", why: "the server has not started its chats yet" };
/** Where ordinary chats run on this server, and why (logged in full at start). */
export const chatHostStatus = (): ChatHost => host;

/** The same for GET /api/health, which answers without sign-in: the mode and a fixed short reason,
    never a value from the environment or a probe's own text. */
export function chatHostHealth(): { mode: "in" | "out"; why: string } {
  const w = host.why;
  if (host.mode === "out") return { mode: "out", why: /detached/.test(w) ? "test driver" : "systemd user units" };
  if (!w.startsWith("SOVA_CHAT_HOST=out")) return { mode: "in", why: /not started/.test(w) ? "starting" : "switch off" };
  if (/Linux-only/.test(w)) return { mode: "in", why: "not Linux" };
  if (/Bun/.test(w)) return { mode: "in", why: "server not on Bun" };
  return { mode: "in", why: "no systemd user manager" };
}

const log = (line: string) => console.log(`[chat-host] ${line}`);

/** This server's build (§app.chat-processes/code-pickup): SOVA_BUILD, else the boot commit plus a
    digest of the uncommitted changes when the tree is dirty; "unknown" when neither says. */
async function serverBuild(): Promise<string> {
  if (process.env.SOVA_BUILD) return process.env.SOVA_BUILD;
  const boot = await Promise.race([bootBuildChecked(), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
  if (!boot?.commit) return "unknown";
  if (!boot.dirty) return boot.commit;
  const diff = await new Promise<Buffer | null>((done) =>
    execFile("git", ["diff", "HEAD", "--no-ext-diff", "--binary"], { cwd: REPO, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 10_000 }, (err, out) =>
      done(err ? null : out),
    ),
  );
  return diff ? `${boot.commit}+${createHash("sha256").update(diff).digest("hex").slice(0, 8)}` : "unknown";
}

/** What a test swaps (a fake driver, links over in-memory streams); the server uses the real ones. */
export interface RouterDeps {
  driver?: Driver;
  connect?: typeof connectLink;
  /** Whether ordinary chats move out now (the server: the chosen host's mode). */
  out?: () => boolean;
}

export class ChatHostRouter {
  private readonly remotes = new Map<string, RemoteChatHandle>();
  /** Session id (the supervisor's chat id) → session file. */
  private readonly paths = new Map<string, string>();
  private readonly starting = new Map<string, Promise<ChatHandle | null>>();
  /** Chats that run in this process until it restarts: a start that failed, an open on new code that did. */
  private readonly inprocOnly = new Set<string>();
  private readonly settings: ChatRuntimeSettings;
  private readonly sup: ChatSupervisor;
  private readonly rollout: Rollout<Link>;
  private readyP: Promise<void> = Promise.resolve();
  private readonly connect: typeof connectLink;
  private readonly out: () => boolean;

  constructor(
    private readonly epoch: number,
    private readonly build: string,
    deps: RouterDeps = {},
  ) {
    const cfg = supervisorConfig();
    this.connect = deps.connect ?? connectLink;
    this.out = deps.out ?? (() => host.mode === "out");
    this.settings = { ...DEFAULT_RUNTIME_SETTINGS, idleStopMin: cfg.idleMs / 60_000 };
    this.sup = new ChatSupervisor({
      driver: deps.driver ?? chatDriver(cfg),
      epoch,
      idleMs: cfg.idleMs,
      claudeIdleMax: cfg.claudeIdleMax,
      launch: (c) => ({
        argv: [process.execPath, join(REPO, "server", "chat-runtime", "main.ts")],
        env: chatEnv({
          serverEnv: process.env,
          bun: process.execPath,
          claude: claudePath(),
          home: homedir(),
          agentDir: agentRoot(),
          extra: { SOVA_CHAT_SOCK: c.sock, SOVA_CHAT_PATH: c.sessionPath, SOVA_CHAT_ID: c.chatId, SOVA_CHAT_UNIT: c.unit, SOVA_CHAT_BUILD: build },
        }),
        build,
      }),
      onDeath: (d) => this.died(d),
      onBootFailed: (id, d) => {
        log(`${id}: did not start (${d.detail ?? d.cause}); it runs in the server until it restarts`);
        this.inprocOnly.add(d.sessionPath);
        this.forget(d.sessionPath);
      },
      onStopped: (id) => {
        const path = this.paths.get(id);
        if (path) this.forget(path);
      },
      drain: (id, reason) => this.handleOf(id)?.drain(reason) ?? Promise.resolve({ ok: false }),
      reapClaude: (id) => this.handleOf(id)?.releaseIdleModelChild() ?? Promise.resolve("none" as const),
      lockHeld: (path) => {
        const l = readLock(path);
        return !!l && holderAlive(l);
      },
      ownPid: addOwnPid,
    });
    this.rollout = new Rollout<Link>({
      supervisor: this.sup,
      waitReady: linkWaitReady({ epoch, build, settings: this.settings }),
      drain: (id) => this.handleOf(id)?.drain("reload") ?? Promise.resolve({ ok: false }),
      open: async (id, rep, link) => {
        if (!link) throw new Error("no link to the replacement");
        const mirror = await this.openOn(link, rep.sessionPath, id, false);
        const h = this.remotes.get(rep.sessionPath);
        if (h) h.repoint(link, { unit: rep.unit, pid: rep.pid ?? 0 }, mirror);
        else this.adoptHandle(rep, link, mirror);
      },
      setCode: (id, state, detail) => this.handleOf(id)?.pushCode(state, detail),
      onReloadOpenFailed: (_id, path, reason) => {
        log(`${path}: ${reason}; it runs in the server until it restarts`);
        this.inprocOnly.add(path);
        this.forget(path);
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

  /** Done with this chat's process: its panes still here reconnect quietly (the chat reopens on demand). */
  private forget(path: string): void {
    const h = this.remotes.get(path);
    h?.endPanes("Reconnecting. Your draft is kept.", "reloaded");
    if (h) this.paths.delete(h.mirror.sessionId);
    this.remotes.delete(path);
    setRemoteHosted(path, null);
  }

  private readonly hooks: RemoteHooks = {
    state: (h) => {
      const m = h.mirror;
      this.sup.noteIdle(m.sessionId, m.quiet.quiet && m.quiet.clients === 0, m.quiet.since);
      this.sup.noteClaude(m.sessionId, m.claude);
      setRemoteHosted(h.path, { sessionId: m.sessionId, cwd: m.cwd, ...(m.monitor.title ? { title: m.monitor.title } : {}), workers: m.monitor.workers, toolsRunning: m.monitor.toolsRunning, lastToolEnd: m.monitor.lastToolEnd, pid: h.at.pid });
    },
    exit: (h, cause) => {
      this.sup.expectExit(h.mirror.sessionId, cause);
      // A reload's replacement takes the handle over (rollout's open); anything else is done.
      if (cause !== "reload") this.forget(h.path);
    },
    linkEnd: (h, end) => void this.linkEnded(h, end),
    reload: (h, auto) => void this.rollout.request(h.mirror.sessionId, { auto }).catch((err) => log(`reload of ${h.path} failed: ${err instanceof Error ? err.message : String(err)}`)),
    linkLive: (id) => meshLinks.inLiveLink(id),
  };

  /** A link ended without the chat saying it exits: reconnect while its unit is up, else it is the
      supervisor's to report (one death reporter, onDeath). */
  private async linkEnded(h: RemoteChatHandle, end: { reason: string }): Promise<void> {
    if (h.closed || this.remotes.get(h.path) !== h) return;
    if (end.reason === "refused") {
      log(`${h.path}: another server controls this chat now`);
      this.forget(h.path);
      return;
    }
    const id = h.mirror.sessionId;
    const until = Date.now() + 30_000;
    while (Date.now() < until && this.remotes.get(h.path) === h) {
      const state = await this.sup.check(id).catch(() => "unknown" as const);
      if (state !== "up") return;
      const rec = this.sup.record(id);
      if (!rec) return;
      try {
        const { link } = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: h.lastSeq });
        h.repoint(link, { unit: rec.unit, pid: rec.pid ?? h.at.pid });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (this.remotes.get(h.path) === h) await this.sup.lost(id, "it stopped answering").catch(() => {});
  }

  /** Send `open` on `link` and wait for its answer: the mirror, or its refusal thrown. */
  private async openOn(link: Link, path: string, sessionId: string, force: boolean): Promise<ChatRuntimeMirror> {
    const id = randomUUID();
    const answer = awaitFrame(link, "opened", 60_000, (f) => f.id === id);
    const origin = currentLinkOrigin();
    const opening = takeOpeningChoice(path);
    const served = servedToolsFor(path, sessionId, () => this.remotes.get(path)?.mirror.monitor.title ?? "");
    link.send({ t: "open", id, path, force, ...(opening ? { opening } : {}), link: origin ? { origin, token: sovaToken() } : null, served });
    const f: FrameOf<"opened"> = await answer;
    if (f.ok) return f.mirror;
    if (f.refusal) throw errorOfRefusal(f.refusal);
    throw new Error(f.error?.message ?? "The chat did not open in its process.");
  }

  private adoptHandle(rec: ChatRecord, link: Link, mirror: ChatRuntimeMirror): RemoteChatHandle {
    const h = new RemoteChatHandle(rec.sessionPath, rec.sessionPath, { unit: rec.unit, pid: rec.pid ?? 0 }, link, mirror, this.epoch, this.hooks);
    this.remotes.set(rec.sessionPath, h);
    this.paths.set(rec.chatId, rec.sessionPath);
    this.hooks.state?.(h);
    return h;
  }

  /** Take back what a previous server left running (before any chat socket is served). */
  start(): void {
    this.readyP = (async () => {
      const { adopted } = await this.sup.adopt();
      await Promise.all(adopted.map((rec) => this.takeBack(rec)));
      this.sup.watch(2_000);
    })().catch((err) => log(`taking chats back failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async takeBack(rec: ChatRecord): Promise<void> {
    const until = Date.now() + 60_000;
    for (let first = true; Date.now() < until; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, 5_000));
      try {
        const { link } = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: null, retryForMs: first ? 5_000 : 0 });
        const state = await awaitFrame(link, "state", 5_000);
        this.adoptHandle(rec, link, state.mirror);
        return;
      } catch {
        // its unit is up but it did not answer yet: again in 5 s, for a minute
      }
    }
    await this.sup.lost(rec.chatId, "it did not answer this server").catch(() => {});
  }

  ready(): Promise<void> {
    return Promise.race([this.readyP, new Promise<void>((r) => setTimeout(r, READY_WAIT_MS))]);
  }
  get(path: string): ChatHandle | undefined {
    const h = this.remotes.get(path);
    return h && !h.closed ? h : undefined;
  }
  all(): ChatHandle[] {
    return [...this.remotes.values()].filter((h) => !h.closed);
  }

  async acquire(path: string, force: boolean): Promise<ChatHandle | null> {
    const open = this.remotes.get(path);
    if (open && !open.closed) {
      await open.call("reacquire", { force });
      return open;
    }
    if (!this.out() || this.inprocOnly.has(path)) return null;
    let p = this.starting.get(path);
    if (!p) {
      p = this.startChat(path, force).finally(() => this.starting.delete(path));
      this.starting.set(path, p);
    }
    return p;
  }

  /** Start the chat in a process of its own, or null: it runs here (not ordinary, or its start failed). */
  private async startChat(path: string, force: boolean): Promise<ChatHandle | null> {
    let kind: Awaited<ReturnType<typeof openKindOf>>;
    try {
      kind = await openKindOf(path);
    } catch {
      return null; // unreadable: the in-process open says why
    }
    if (kind) return null;
    const summary = await getSessionSummary(path).catch(() => null);
    if (!summary || summary.workerSession) return null;
    // The cheap refusals first, as the in-process open makes them: no process for a doomed open.
    assertNotLive(path);
    const known = activeConfigFailure(path);
    if (known) throw known;
    if (!force) {
      const age = recentForeignWriteAgeSec(path);
      if (age !== null) throw new BusyError(`modified ${age}s ago by a process we can't identify`, "recent");
    }
    let rec: ChatRecord;
    try {
      rec = await this.sup.start({ chatId: summary.id, sessionPath: path, cwd: summary.cwd ?? REPO });
    } catch (err) {
      log(`${path}: could not start its process (${err instanceof Error ? err.message : String(err)}); it runs in the server until it restarts`);
      this.inprocOnly.add(path);
      return null;
    }
    let link: Link;
    try {
      const c = await this.connect(rec.sock, { epoch: this.epoch, build: this.build, settings: this.settings, since: null, retryForMs: 10_000 });
      link = c.link;
      this.sup.noteConnected(rec.chatId);
      if (c.hello.state === "booting") await awaitFrame(link, "hello", 30_000, (h) => h.state !== "booting");
    } catch (err) {
      await this.sup.lost(rec.chatId, `no hello: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      this.inprocOnly.add(path);
      return null;
    }
    try {
      const mirror = await this.openOn(link, path, rec.chatId, force);
      return this.adoptHandle(rec, link, mirror);
    } catch (err) {
      // A refusal (busy, recent, config) is the caller's, as in-process; the process exits by itself.
      this.sup.expectExit(rec.chatId, "refused");
      link.close();
      if (err instanceof BusyError || err instanceof ConfigError || err instanceof RefusedError) throw err;
      log(`${path}: did not open in its process (${err instanceof Error ? err.message : String(err)}); it runs in the server until it restarts`);
      await this.sup.stop(rec.chatId, "refused").catch(() => {});
      this.inprocOnly.add(path);
      return null;
    }
  }

  async close(path: string, message: string): Promise<boolean> {
    const h = this.remotes.get(path);
    if (!h || h.closed) return false;
    const sid = h.mirror.sessionId;
    this.sup.expectExit(sid, "archived");
    const r = await h.drain("archived", { force: true, message });
    if (!r.ok) await this.sup.stop(sid, "archived").catch(() => {});
    this.forget(path);
    return true;
  }

  /** A chat process died (§app.chat-processes/crash): its panes are told, its last writes are the
      server's while it still held the file's lock, and a run it had in flight is resumed once. */
  private died(d: ChatDeath): void {
    const path = d.sessionPath;
    const h = this.remotes.get(path);
    const pid = h?.at.pid ?? this.sup.record(d.chatId)?.pid ?? null;
    const how = d.exit !== null ? `exit ${d.exit}` : d.signal ? `signal ${d.signal}` : "it stopped answering";
    const tail = d.logTail.slice(-3).join("\n").slice(-300);
    h?.endPanes(`This chat's process stopped unexpectedly (${how}). Your messages are saved; it reopens when you reconnect.${tail ? `\nLast output: ${tail}` : ""}`);
    this.forget(path);
    // Step 0 (design §4.5): the dead process held the lock and nobody wrote since it ended.
    const lock = readLock(path);
    if (lock && pid !== null && lock.pid === pid && !holderAlive(lock)) {
      try {
        if (statSync(path).mtimeMs <= Date.parse(d.at)) markOwned(path);
      } catch {
        // the file is gone: nothing to record
      }
      releaseLockOf(path, lock);
    }
    const marker = takeInflight(d.chatId);
    if (marker && !marker.auto)
      resumeCrashedChat(path, marker.since, async (p) => {
        await (await acquireChatHandle(p)).markResuming();
      });
  }

  /** The server is stopping: chats in their own process run on; each is told goodbye, never stopped. */
  detach(): void {
    for (const h of this.remotes.values()) h.bye();
    this.sup.detach();
  }
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
    log(`ordinary chats run ${host.mode === "out" ? "in processes of their own" : "in the server"}: ${host.why}`);
    // Chats a previous server started are taken back even with the switch off now: never orphaned.
    router = new ChatHostRouter(nextEpoch(), await serverBuild());
    router.start();
    await router.ready();
  })().catch((err) => log(`start failed: ${err instanceof Error ? err.message : String(err)}`));
  setChatRouter({
    ready: () => Promise.race([boot, new Promise<void>((r) => setTimeout(r, 2 * READY_WAIT_MS))]),
    get: (path) => router?.get(path),
    all: () => router?.all() ?? [],
    acquire: (path, force) => (router ? router.acquire(path, force) : Promise.resolve(null)),
    close: (path, message) => (router ? router.close(path, message) : Promise.resolve(false)),
  });
}

/** At shutdown: let go of every chat process (they run on), never stop one. */
export function detachChatHost(): void {
  router?.detach();
}

/** The handle `chatHandle` finds, if it is a chat process's (tests, health). */
export const isRemote = (path: string): boolean => chatHandle(path)?.where === "process";
