// The chat's side of a chat process (al_3 stage 2): one ordinary chat, opened through the server's own
// chat-manager exactly as the server would host it, answering the server over its socket (link.ts):
// commands run through the same METHODS table, the mirror goes out as data whenever it changes, the
// chat's lifecycle events are numbered and replayed from where a reconnecting server left off, and
// each browser's frames pass through as the chat serialized them. What the chat would otherwise read
// from server singletons comes over the socket: server-hosted tools (with effect ids, q5), asks, and
// pushes. The chat outlives its server: on a broker drop its panes become orphans (dialogs stay open),
// a server-hosted call in flight reports "outcome unknown" to the next server, and a call made with
// no server waits for one. It closes on a drain (idle, reload, archive), on SIGTERM, or when the chat
// closes itself, and says why (`exit`) before it goes.
import type { ChatCall, ChatLifecycleEvent, ChatMethod, ChatMethods, ChatStateMirror, ServerToolCall, ServerToolOutcome } from "../../shared/chat-runtime";
import {
  CHAT_WIRE_MIN_PROTO,
  CHAT_WIRE_PROTO,
  type ChatAskMethod,
  type ChatAsks,
  type ChatCodeState,
  type ChatRuntimeMirror,
  type ChatRuntimeSettings,
  DEFAULT_RUNTIME_SETTINGS,
  type ExitCause,
  type FrameOf,
  NOT_RUN_NO_SERVER,
  OUTCOME_UNKNOWN,
  type ServerToolCtxWire,
} from "../../shared/chat-runtime-wire";
import type { ToolResult } from "../../shared/harness";
import type { ChatServerMessage, WorkerInfo } from "../../shared/protocol";
import { claudeChildState, releaseIdleClaudeChildren } from "../../pi-config/extensions/claude-code/provider/children";
import {
  acquireChat,
  assertNotLive,
  BusyError,
  type ChatClient,
  type ChatSession,
  chatEventsSince,
  disposeHeldChat,
  heldChat,
  notifyLinksChanged,
  onChatEvent,
  setChatHosts,
  setCodeReload,
  setLinkOrigin,
  setLinksSource,
  setLinkToken,
  setOpeningChoice,
  setRunRecorder,
  setServedTools,
  setServerToolPort,
  setSingletonCheck,
  type ServerToolLocal,
  titleOf,
} from "../chat-manager";
import { decodeWorkers } from "../insights";
import { listGeneration } from "../list-generation";
import { readOwnLiveRecords, workerCountsOf } from "../live";
import { InflightRecorder } from "./inflight";
import type { ControlFrame, HelloFrame, Link } from "./link";
import { type CallCtx, failureReply, runMethod } from "./methods";
import { mirrorOf } from "./mirror";

/** The provider and model runtime warm-up, once per process (main.ts awaits it before "ready"). */
export { warmChatRuntime } from "../chat-manager";

/** `globalThis[LINK_LIVE](sessionId)`: whether a session is in a live link (the link extension asks). */
const LINK_LIVE = Symbol.for("sova:link-live");

export interface HostOptions {
  /** The one session file this process hosts. */
  path: string;
  sessionId: string;
  unit: string;
  /** The build of the server that started this process (its code). */
  build: string;
  startedAt: number;
  /** Exit the process (after `exit` went out). Tests: record it. */
  exit(cause: ExitCause): void;
  now?: () => number;
  log?: (line: string) => void;
  /** How often the host looks at what the chat's events don't announce (workers, the list's generation, the reload dwell). */
  tickMs?: number;
  /** How long an ask may take before it reads as nothing. */
  askWithinMs?: number;
}

type State = HelloFrame["state"];

/** A server-hosted call: queued until a server is linked, then written to that link until its result. */
interface PendingTool {
  call: ServerToolCall;
  ctx: ServerToolCtxWire;
  local: ServerToolLocal;
  /** The link it was written to, or null while it waits for one. */
  sentOn: Link | null;
  timer: NodeJS.Timeout | null;
  resolve(outcome: ServerToolOutcome<ToolResult>): void;
}

const NOTHING: { [M in ChatAskMethod]: ChatAsks[M]["result"] } = {
  "project.note": null,
  "playbook.bundleFor": null,
  "playbook.reprime": null,
  links: [],
  singleton: null,
};

/** The text a pane gets when its chat process closes to reload on current code (ChatView reconnects quietly). */
export const RELOAD_MESSAGE = "Reconnecting. Your draft is kept.";

export class ChatRuntimeHost {
  private state: State = "ready";
  private chat: ChatSession | null = null;
  private link: Link | null = null;
  private epoch = 0;
  private settings: ChatRuntimeSettings = DEFAULT_RUNTIME_SETTINGS;
  private serverBuild: string | null = null;
  /** The rollout's own word on this chat's code (reloading, failed), over what the builds say. */
  private codeSaid: { state: ChatCodeState["state"]; detail?: string } | null = null;
  private reloadPending = false;
  private reloadAsked = false;
  private readonly ctx: CallCtx = { turns: new Map() };
  private readonly clients = new Map<string, ChatClient>();
  private orphaned = false;
  private orphanTimer: NodeJS.Timeout | null = null;
  private readonly tools = new Map<string, PendingTool>();
  private readonly asks = new Map<string, { resolve(v: unknown): void; timer: NodeJS.Timeout }>();
  private askN = 0;
  private liveIds = new Set<string>();
  private lastSeq = 0;
  private lastMirror = "";
  private lastGeneration = listGeneration();
  private quietSince: number;
  private wasQuiet = true;
  private workersWorking = 0;
  private monitorWorkers: WorkerInfo[] = [];
  private poke: NodeJS.Timeout | null = null;
  private readonly ticker: NodeJS.Timeout;
  private closing = false;
  /** The chat is being reopened in place (reacquire with force): its close is not this process's end. */
  private reopening = false;
  private readonly recorder: InflightRecorder;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: HostOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.error(`[chat-runtime] ${l}`));
    this.quietSince = this.now();
    this.recorder = new InflightRecorder(() => o.sessionId);
    onChatEvent((e) => this.onEvent(e));
    this.ticker = setInterval(() => this.tick(), o.tickMs ?? 1_000);
    this.ticker.unref?.();
  }

  /** The hello for a new connection (link.ts adds proto and epoch). */
  hello(): Omit<HelloFrame, "t" | "proto" | "minProto" | "epoch"> {
    return { build: this.o.build, pid: process.pid, startedAt: this.o.startedAt, unit: this.o.unit, sessionId: this.o.sessionId, path: this.o.path, state: this.state, seq: this.lastSeq };
  }

  private setState(s: State): void {
    if (this.state === s) return;
    this.state = s;
    // Kernel: a hello again on every change of state (a rollout waits for "ready" on its link).
    this.link?.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: this.epoch, ...this.hello() });
  }

  // ---- the controller -----------------------------------------------------------------------------

  /** A server took control (link.ts serveLink's onControl). */
  onControl(link: Link, control: ControlFrame): void {
    const before = this.link;
    if (before && before !== link) this.lostLink();
    this.link = link;
    this.epoch = control.epoch;
    this.settings = control.settings;
    void link.closed.then(() => {
      if (this.link === link) this.lostLink();
    });
    this.listen(link);
    // Replay the lifecycle events the server missed, or tell it what it can't have.
    if (control.since !== null) {
      const kept = chatEventsSince(0).filter((e) => e.chatId === this.o.path);
      const oldest = kept[0]?.seq ?? this.lastSeq + 1;
      if (control.since < oldest - 1) link.send({ t: "events.gap", from: control.since + 1, to: oldest - 1 });
      for (const e of kept) if (e.seq > control.since) link.send({ t: "event", event: e });
    }
    if (link.compatible) {
      this.setServerBuild(control.build);
      if (this.chat) this.sendState(true);
      // Server-hosted calls: written to a link that dropped, their outcome is unknown and they are
      // never sent again; never written, they go now.
      for (const p of [...this.tools.values()]) {
        if (p.sentOn) this.settleTool(p, { ok: false, unknown: true, error: { message: OUTCOME_UNKNOWN } });
        else this.writeTool(p);
      }
      if (this.orphaned) {
        if (this.orphanTimer) clearTimeout(this.orphanTimer);
        this.orphanTimer = setTimeout(() => this.endOrphans(true), this.settings.orphanGraceMs);
        this.orphanTimer.unref?.();
      }
    }
  }

  /** The controller's link ended: its panes become orphans (open dialogs wait), asks read as nothing. */
  private lostLink(): void {
    this.link = null;
    if (this.clients.size && this.chat && !this.chat.disposed) {
      this.chat.orphanClients();
      this.orphaned = true;
    }
    this.clients.clear();
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    for (const [id, a] of this.asks) {
      clearTimeout(a.timer);
      this.asks.delete(id);
      a.resolve(undefined);
    }
    // A call written to that link: its outcome is unknown from here. Said at the next control, or
    // when no server comes back in time.
    for (const p of this.tools.values()) if (p.sentOn) this.armToolTimer(p, { ok: false, unknown: true, error: { message: OUTCOME_UNKNOWN } });
    this.pokeSoon();
  }

  private endOrphans(resolveDialogs: boolean): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    if (!this.orphaned) return;
    this.orphaned = false;
    if (this.chat && !this.chat.disposed) this.chat.dropOrphans({ resolveDialogs });
    this.pokeSoon();
  }

  private listen(link: Link): void {
    const mine = <F,>(fn: (f: F) => void) => (f: F) => {
      if (this.link === link) fn(f);
    };
    link.on("drain", mine((f: FrameOf<"drain">) => void this.drain(link, f)));
    link.on("bye", mine(() => this.log("the server is stopping; the chat runs on")));
    if (!link.compatible) return;
    link.on("open", mine((f: FrameOf<"open">) => void this.open(link, f)));
    link.on("call", mine((f: FrameOf<"call">) => void this.runCall(link, f.call)));
    link.on("client.attach", mine((f: FrameOf<"client.attach">) => this.attach(link, f)));
    link.on("client.msg", mine((f: FrameOf<"client.msg">) => {
      const c = this.clients.get(f.clientId);
      if (c && this.chat) this.chat.handle(c, f.msg);
      this.pokeSoon();
    }));
    link.on("client.detach", mine((f: FrameOf<"client.detach">) => {
      const c = this.clients.get(f.clientId);
      this.clients.delete(f.clientId);
      if (c && this.chat) this.chat.detach(c);
      this.pokeSoon();
    }));
    link.on("tool.update", mine((f: FrameOf<"tool.update">) => this.tools.get(f.effectId)?.local.onUpdate?.(f.update)));
    link.on("tool.result", mine((f: FrameOf<"tool.result">) => {
      const p = this.tools.get(f.effectId);
      if (p) this.settleTool(p, f.outcome);
    }));
    link.on("answer", mine((f: FrameOf<"answer">) => {
      const a = this.asks.get(f.id);
      if (!a) return;
      clearTimeout(a.timer);
      this.asks.delete(f.id);
      if (f.ok) a.resolve(f.result);
      else {
        this.log(`an ask failed on the server: ${f.error.message}`);
        a.resolve(undefined);
      }
    }));
    link.on("push", mine((f: FrameOf<"push">) => this.push(f)));
  }

  private push(f: FrameOf<"push">): void {
    if (f.kind === "link-live") this.liveIds = new Set(f.ids);
    else if (f.kind === "links-changed") notifyLinksChanged(f.sessionIds);
    else if (f.kind === "build") this.setServerBuild(f.build);
    else if (f.kind === "settings") this.settings = f.settings;
    else if (f.kind === "code") {
      this.codeSaid = f.state === "reloading" || f.state === "failed" ? { state: f.state, ...(f.detail ? { detail: f.detail } : {}) } : null;
      if (f.state !== "reloading") this.reloadAsked = false;
      this.codeChanged();
    }
  }

  // ---- opening ------------------------------------------------------------------------------------

  /** Wire this process's chat to the server over the socket, then open it (once). */
  private async open(link: Link, f: FrameOf<"open">): Promise<void> {
    const reply = (frame: FrameOf<"opened">) => link.send(frame);
    if (f.path !== this.o.path) return void reply({ t: "opened", id: f.id, ok: false, error: { message: `This process hosts ${this.o.path}, not ${f.path}.` } });
    if (this.chat && !this.chat.disposed) return void reply({ t: "opened", id: f.id, ok: true, mirror: this.mirror() });
    if (f.link) {
      setLinkOrigin(f.link.origin);
      setLinkToken(f.link.token);
    }
    if (f.opening) setOpeningChoice(this.o.path, f.opening);
    setServedTools(f.served);
    this.wire();
    try {
      const chat = await acquireChat(this.o.path, f.force);
      this.chat = chat;
      this.setState("open");
      this.quietSince = this.now();
      reply({ t: "opened", id: f.id, ok: true, mirror: this.mirror() });
      this.lastMirror = JSON.stringify(this.mirror());
    } catch (err) {
      const r = failureReply(f.id, err);
      reply({ t: "opened", id: f.id, ok: false, ...(r.ok === false && "refusal" in r ? { refusal: r.refusal } : { error: { message: err instanceof Error ? err.message : String(err) } }) });
      this.log(`open refused: ${err instanceof Error ? err.message : String(err)}`);
      await this.close("refused", { dispose: false });
    }
  }

  /** What this process's chat reads of the server, over the socket instead of the server's singletons. */
  private wire(): void {
    setRunRecorder(this.recorder);
    setServerToolPort({
      call: (call, local) => this.toolCall(call, local),
      prepare: () => {
        throw new Error("A tool that rewrites its arguments can't run from a chat process.");
      },
    });
    setChatHosts({
      playbook: {
        bundleFor: (sessionId, hint) => this.ask("playbook.bundleFor", { sessionId, hint: hint ?? null }) as never,
        reprime: (ctx) => this.ask("playbook.reprime", { sessionId: ctx.sessionId, leafId: this.chat?.leafId() ?? null }),
      },
      instanceNote: (ctx) => this.ask("project.note", { cwd: ctx.cwd, sessionId: ctx.sessionId, leafId: this.chat?.leafId() ?? null }),
    });
    setSingletonCheck((key, path) => this.ask("singleton", { key, path }));
    setLinksSource((sessionId, path) => this.ask("links", { sessionId, path }) as never);
    setCodeReload((client) => this.reloadNow(client));
    (globalThis as Record<symbol, unknown>)[LINK_LIVE] = (sessionId: string) => this.liveIds.has(sessionId);
  }

  private ask<M extends ChatAskMethod>(method: M, args: ChatAsks[M]["args"]): Promise<ChatAsks[M]["result"]> {
    const link = this.link;
    if (!link?.isOpen || !link.compatible) return Promise.resolve(NOTHING[method]);
    const id = `a${++this.askN}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        this.log(`ask ${method} unanswered`);
        resolve(NOTHING[method]);
      }, this.o.askWithinMs ?? 10_000);
      timer.unref?.();
      this.asks.set(id, { resolve: (v) => resolve(v === undefined ? NOTHING[method] : (v as ChatAsks[M]["result"])), timer });
      link.send({ t: "ask", id, method, args });
    });
  }

  // ---- commands -----------------------------------------------------------------------------------

  /** The commands a chat process answers its own way; the rest are the shared table's. */
  private readonly own: Partial<{ [M in ChatMethod]: (chat: ChatSession, args: ChatMethods[M]["args"]) => Promise<ChatMethods[M]["result"]> | ChatMethods[M]["result"] }> = {
    releaseIdleModelChild: () => releaseIdleClaudeChildren("idle session released by the server's cap"),
    reacquire: async (chat, { force }) => {
      assertNotLive(chat.path);
      if (!chat.hasForeignWrites()) return "ok";
      if (!force) throw new BusyError(chat.busyMessage(), "recent");
      // "Chat anyway": reopened from the file in this same process (acquireChat tells every pane to reconnect).
      this.reopening = true;
      try {
        this.chat = await acquireChat(chat.path, true);
      } finally {
        this.reopening = false;
      }
      this.clients.clear();
      return "reloaded";
    },
  };

  private async runCall(link: Link, call: ChatCall): Promise<void> {
    if (call.epoch !== this.epoch) return void link.send({ t: "reply", reply: { id: call.id, ok: false, error: { message: "stale controller" } } });
    const chat = this.chat;
    if (!chat || chat.disposed) return void link.send({ t: "reply", reply: { id: call.id, ok: false, error: { message: "This chat is closed." } } });
    let reply: FrameOf<"reply">["reply"];
    try {
      const own = this.own[call.method] as ((c: ChatSession, a: unknown) => unknown) | undefined;
      const result = await (own ? own(chat, call.args) : runMethod(chat, call, this.ctx));
      reply = { id: call.id, ok: true, result } as FrameOf<"reply">["reply"];
    } catch (err) {
      reply = failureReply(call.id, err);
    }
    // A read of the mirror after `await call()` is current: the state goes first.
    if (this.chat) this.sendState(false);
    link.send({ t: "reply", reply });
  }

  // ---- browsers -----------------------------------------------------------------------------------

  private attach(link: Link, f: FrameOf<"client.attach">): void {
    const chat = this.chat;
    if (!chat || chat.disposed) {
      link.send({ t: "client.send", clientId: f.clientId, json: JSON.stringify({ type: "error", code: "reloaded", message: "This chat is closed; reconnect" }) });
      return;
    }
    const out = (json: string) => {
      if (this.link === link && this.clients.has(f.clientId)) link.send({ t: "client.send", clientId: f.clientId, json });
    };
    const client: ChatClient = {
      send: (msg) => out(JSON.stringify(msg)),
      sendRaw: out,
      ...(f.client.wire ? { wire: f.client.wire } : {}),
      ...(f.client.tail ? { tail: f.client.tail } : {}),
      ...(f.client.pull ? { pull: f.client.pull } : {}),
    };
    this.clients.set(f.clientId, client);
    // A pane is back: the orphans go, their dialogs stay (attach sends them again).
    if (this.orphaned) this.endOrphans(false);
    chat.attach(client);
    const code = this.code();
    if (code.state !== "current") client.send(codeMessage(code));
    this.pokeSoon();
  }

  // ---- server-hosted tools ------------------------------------------------------------------------

  private toolCall(call: ServerToolCall, local: ServerToolLocal): Promise<ServerToolOutcome<ToolResult>> {
    const chat = this.chat;
    const ctx: ServerToolCtxWire = {
      sessionId: this.o.sessionId,
      cwd: chat?.harness.cwd ?? local.ctx?.cwd ?? "",
      leafId: chat?.leafId() ?? null,
      title: chat ? titleOf(chat.harness.branch()) : null,
    };
    return new Promise((resolve) => {
      const p: PendingTool = { call, ctx, local, sentOn: null, timer: null, resolve };
      this.tools.set(call.effectId, p);
      local.signal?.addEventListener("abort", () => {
        if (!this.tools.has(call.effectId)) return;
        if (p.sentOn?.isOpen) p.sentOn.send({ t: "tool.abort", effectId: call.effectId });
        else if (!p.sentOn) this.settleTool(p, { ok: false, error: { message: "Stopped before the server ran it." } });
      });
      if (this.link?.isOpen && this.link.compatible) this.writeTool(p);
      else this.armToolTimer(p, { ok: false, error: { message: NOT_RUN_NO_SERVER } });
      this.pokeSoon();
    });
  }

  private writeTool(p: PendingTool): void {
    const link = this.link;
    if (!link?.isOpen) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.sentOn = link;
    link.send({ t: "tool.call", call: p.call, ctx: p.ctx });
  }

  private armToolTimer(p: PendingTool, outcome: ServerToolOutcome<ToolResult>): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.settleTool(p, outcome), this.settings.serverToolWaitMs);
    p.timer.unref?.();
  }

  private settleTool(p: PendingTool, outcome: ServerToolOutcome<ToolResult>): void {
    if (this.tools.get(p.call.effectId) !== p) return;
    this.tools.delete(p.call.effectId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(outcome);
    this.pokeSoon();
  }

  // ---- state --------------------------------------------------------------------------------------

  private onEvent(e: ChatLifecycleEvent): void {
    if (e.chatId !== this.o.path) return;
    this.lastSeq = e.seq;
    this.link?.send({ t: "event", event: e });
    if (e.type === "closed" && !this.reopening && !this.closing) void this.close("closed", { dispose: false });
    this.pokeSoon();
  }

  /** Look at the mirror soon (an event, a frame, a call): coalesced. */
  private pokeSoon(): void {
    if (this.poke) return;
    this.poke = setTimeout(() => {
      this.poke = null;
      this.check();
    }, 50);
    this.poke.unref?.();
  }

  private tick(): void {
    // What no event announces: the workers' live record, the session list's generation.
    try {
      const rec = readOwnLiveRecords().get(this.o.path);
      this.workersWorking = workerCountsOf(rec?.rec)?.working ?? 0;
      this.monitorWorkers = decodeWorkers(rec?.rec?.presence, true);
    } catch {
      // the live dir mid-write: next tick
    }
    this.check();
  }

  private check(): void {
    if (!this.chat || this.chat.disposed) return;
    const g = listGeneration();
    if (g !== this.lastGeneration) {
      this.lastGeneration = g;
      this.link?.send({ t: "touched" });
    }
    this.sendState(false);
    this.considerReload();
  }

  private sendState(force: boolean): void {
    const m = this.mirror();
    const json = JSON.stringify(m);
    if (!force && json === this.lastMirror) return;
    this.lastMirror = json;
    this.link?.send({ t: "state", mirror: m });
  }

  private clientCount(): number {
    return this.clients.size + (this.orphaned ? 1 : 0);
  }

  /** Nothing in flight: no run, compaction, start, queue, dialog, working worker or server call. */
  private quietOf(m: ChatStateMirror): boolean {
    return !m.running && !m.compacting && !m.starting && m.queue.web === 0 && !m.queue.agent && m.dialogs.length === 0 && this.workersWorking === 0 && this.tools.size === 0;
  }

  private mirror(): ChatRuntimeMirror {
    const chat = this.chat!;
    const base = mirrorOf(chat);
    const quiet = this.quietOf(base);
    if (quiet !== this.wasQuiet) {
      this.wasQuiet = quiet;
      this.quietSince = this.now();
      if (!quiet) this.reloadAsked = false;
    }
    return {
      ...base,
      build: this.o.build,
      startedAt: this.o.startedAt,
      code: this.code(),
      quiet: { quiet, since: this.quietSince, clients: this.clientCount(), workersWorking: this.workersWorking, serverCalls: this.tools.size },
      claude: claudeChildState(),
      monitor: { title: titleOf(chat.harness.branch()), workers: this.monitorWorkers, toolsRunning: base.running ? 1 : 0, lastToolEnd: 0 },
    };
  }

  // ---- code ---------------------------------------------------------------------------------------

  private setServerBuild(build: string): void {
    if (build === this.serverBuild) return;
    this.serverBuild = build;
    this.codeChanged();
  }

  /** This chat's code against its server's (§6 of the stage-2 design). "unknown" on either side: current. */
  private code(): ChatCodeState {
    if (this.codeSaid) return { state: this.codeSaid.state, ...(this.codeSaid.detail ? { detail: this.codeSaid.detail } : {}) };
    const older = !!this.serverBuild && this.serverBuild !== "unknown" && this.o.build !== "unknown" && this.serverBuild !== this.o.build;
    return older ? { state: "older", ...(this.reloadPending ? { pending: true as const } : {}) } : { state: "current" };
  }

  private codeChanged(): void {
    if (this.code().state === "current") this.reloadPending = false;
    if (this.chat && !this.chat.disposed && this.clients.size) this.chat.broadcast(codeMessage(this.code()) as ChatServerMessage);
    this.pokeSoon();
  }

  /** A pane's "Reload now": at once when quiet, else when the reply finishes; a current chat says so to that pane only. */
  private reloadNow(client: ChatClient): void {
    const code = this.code();
    if (code.state === "current") return client.send({ type: "code", state: "current" } as ChatServerMessage);
    if (code.state === "reloading") return client.send(codeMessage(code) as ChatServerMessage);
    this.codeSaid = null; // failed: try again, as older
    if (this.wasQuiet && this.chat && this.quietOf(mirrorOf(this.chat))) this.requestReload(false);
    else {
      this.reloadPending = true;
      this.codeChanged();
    }
  }

  private requestReload(auto: boolean): void {
    if (!this.link?.isOpen || !this.link.compatible) return;
    this.reloadAsked = true;
    this.link.send({ t: "reload.request", auto });
  }

  /** Older and quiet: a reload is asked for once per quiet stretch: at once with nobody attached, or
      after the dwell; a pending "Reload now" at the first quiet moment. Working workers block it
      (they'd die with the process): they are part of quiet. */
  private considerReload(): void {
    if (this.reloadAsked || !this.wasQuiet || this.code().state !== "older") return;
    if (this.reloadPending) {
      this.reloadPending = false;
      this.requestReload(false);
      return;
    }
    if (this.clientCount() === 0 || this.now() - this.quietSince >= this.settings.reloadDwellMs) this.requestReload(true);
  }

  // ---- closing ------------------------------------------------------------------------------------

  private async drain(link: Link, f: FrameOf<"drain">): Promise<void> {
    const answer = (frame: FrameOf<"drained">) => link.send(frame);
    if (this.closing) return void answer({ t: "drained", id: f.id, ok: true });
    const chat = this.chat;
    if (chat && !chat.disposed && !f.force) {
      const quiet = this.quietOf(mirrorOf(chat));
      if (!quiet) return void answer({ t: "drained", id: f.id, ok: false, why: "busy" });
      if (f.reason === "idle" && this.clientCount() > 0) return void answer({ t: "drained", id: f.id, ok: false, why: "attached" });
    }
    answer({ t: "drained", id: f.id, ok: true });
    const cause: ExitCause = f.reason;
    const message = f.reason === "reload" ? RELOAD_MESSAGE : f.reason === "archived" ? (f.message ?? "This chat was archived; reconnect") : f.message;
    await this.close(cause, { dispose: true, ...(message ? { message } : {}) });
  }

  /**
   * Close down on purpose: the chat disposed (its workers and Claude CLI go in order; a pane told
   * to reconnect with `message`), the run's in-flight marker cleared, `exit {cause}` sent, then exit.
   */
  async close(cause: ExitCause, opts: { dispose: boolean; message?: string }): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.setState("closing");
    clearInterval(this.ticker);
    const chat = this.chat;
    if (opts.dispose && chat && !chat.disposed) {
      try {
        if (opts.message) await disposeHeldChat(chat.path, opts.message);
        else await chat.dispose();
      } catch (err) {
        this.log(`dispose failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.recorder.clear();
    this.link?.send({ t: "exit", cause });
    this.o.exit(cause);
  }

  /** The server, as the process's own end sees it (main.ts). */
  get controllerLink(): Link | null {
    return this.link;
  }
  /** Whether this process hosts an open chat now. */
  get hosting(): boolean {
    return !!this.chat && !this.chat.disposed;
  }
  /** For tests: the chat this process hosts. */
  heldChat(): ChatSession | undefined {
    return heldChat(this.o.path);
  }
}

function codeMessage(code: ChatCodeState): { type: "code"; state: ChatCodeState["state"]; pending?: boolean; detail?: string } {
  return { type: "code", state: code.state, ...(code.pending ? { pending: true } : {}), ...(code.detail ? { detail: code.detail } : {}) };
}
