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
import { randomUUID } from "node:crypto";
import { type ChatCall, type ChatLifecycleEvent, type ChatMethod, type ChatMethods, type ChatRunEvent, type ChatStateMirror, type ServerToolCall, type ServerToolDecl, type ServerToolOutcome, unsentRefusal } from "../../shared/chat-runtime";
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
  type ServerActionName,
  type ServerToolCtxWire,
} from "../../shared/chat-runtime-wire";
import type { ToolResult } from "../../shared/harness";
import type { ChatServerMessage } from "../../shared/protocol";
import { claudeChildState, releaseIdleClaudeChildren } from "../../pi-config/extensions/claude-code/provider/children";
import {
  acquireChat,
  appendForCall,
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
  serverToolSpec,
  setServedTools,
  setServerToolPort,
  setSingletonCheck,
  setSpecialComposerClosed,
  setSpecialPort,
  setSpecialSpec,
  setWorkerHostSource,
  setWorkerSpec,
  type SpecialPort,
  type ServerToolLocal,
  titleOf,
} from "../chat-manager";
import { listGeneration } from "../list-generation";
import { decodeWorkers } from "../insights";
import { readOwnLiveRecords, workerCountsOf } from "../live";
import { hostedFacts } from "../resource-monitor";
import { type PowersHost, type PowersSendResult, setPowersHost } from "../session-powers";
import { InflightRecorder } from "./inflight";
import type { ControlFrame, HelloFrame, Link } from "./link";
import { type CallCtx, failureReply, runMethod } from "./methods";
import { mirrorOf } from "./mirror";
import { snapshot as llmSnapshot } from "../../pi-config/extensions/llm-inflight/tracker.ts";
import { WorkerFeed } from "./worker-feed";
import { LinkWorkerHost, WORKER_PROTO } from "./worker-port";

/** The provider and model runtime warm-up, once per process (main.ts awaits it before "ready"). */
export { warmChatRuntime } from "../chat-manager";
import { setReplyTimingsSource } from "../reply-facts";

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
  /** The open's trail (§app.chat-processes/boot-log): one per `open`, its steps sent on `send`. Only
      a chat process records one (server/chat-runtime/main.ts); without it an open records nothing. */
  openTrail?: (send: (frame: FrameOf<"boot">) => void) => { step(name: string): void; finish(ok?: boolean): void };
}

type State = HelloFrame["state"];

/** A server-hosted call: queued until a server is linked, then written to that link until its result.
    A server action (`@clientSend`, …) is one too, with no tool's local side. */
interface PendingTool {
  call: ServerToolCall;
  ctx: ServerToolCtxWire;
  local: ServerToolLocal | null;
  /** The link it was written to, or null while it waits for one. */
  sentOn: Link | null;
  timer: NodeJS.Timeout | null;
  resolve(outcome: ServerToolOutcome<unknown>): void;
}

/** A wait-ask in flight: `sentOn` the link it was last written to, null while it waits for one. */
interface PendingWait {
  id: string;
  method: WaitAsk;
  args: unknown;
  sentOn: Link | null;
  timer: NodeJS.Timeout | null;
  resolve(v: unknown): void;
  reject(err: Error): void;
}

/** The asks that wait for a server (ASK_POLICY "wait"). */
type WaitAsk = Exclude<ChatAskMethod, NothingAsk>;

/** Run events kept until the server acks them (the rest are ticks, dropped while no server is linked). */
const RUN_FACTS = new Set<ChatRunEvent["type"]>(["run.start", "user.entered", "user.end", "run.settled"]);
/** The streaming reply's text goes to the server at most this often. */
export const REPLY_TEXT_EVERY_MS = 100;
/** The protocol that carries special loadouts, wait-asks, actions, call-backs and run events. */
const SPECIAL_PROTO = 2;

/** The asks that read as nothing without a server (ASK_POLICY "nothing"). */
type NothingAsk = "project.note" | "playbook.bundleFor" | "playbook.reprime" | "links" | "singleton" | "reply.timings" | "offers.note";
const NOTHING: { [M in NothingAsk]: ChatAsks[M]["result"] } = {
  "project.note": null,
  "playbook.bundleFor": null,
  "playbook.reprime": null,
  links: [],
  singleton: null,
  "reply.timings": null,
  "offers.note": null,
};

/** A call-back whose call is no longer pending (the link dropped, the call settled). */
export const GONE_CALL = "That tool call is no longer running.";

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
  /** A pane's "Reload now" stands until the chat reloads, fails or is current: a drain refused as busy re-arms it. */
  private reloadNowWanted = false;
  private reloadAsked = false;
  /** Which server (pid and start) the controller is: a reload, and its failure, are that server's own. */
  private serverLife: string | null = null;
  private readonly ctx: CallCtx = { turns: new Map() };
  private readonly clients = new Map<string, ChatClient>();
  private orphaned = false;
  private orphanTimer: NodeJS.Timeout | null = null;
  private readonly tools = new Map<string, PendingTool>();
  private readonly asks = new Map<string, { resolve(v: unknown): void; timer: NodeJS.Timeout }>();
  /** Wait-asks (ASK_POLICY "wait"), in the order they were made: written to each new controller
      until answered, failed after serverToolWaitMs. */
  private readonly waits = new Map<string, PendingWait>();
  private askN = 0;
  /** A special loadout's run events: the last `n`, the facts the server hasn't acked, the reply
      text waiting for its coalesced send. */
  private runN = 0;
  private outbox: FrameOf<"run">[] = [];
  private replyText: { event: ChatRunEvent; timer: NodeJS.Timeout } | null = null;
  private liveIds = new Set<string>();
  private lastSeq = 0;
  private lastMirror = "";
  private lastGeneration = listGeneration();
  private quietSince: number;
  private wasQuiet = true;
  /** Quiet but for workers in processes of their own, which a reload keeps (they are reattached). */
  private reloadQuietSince: number;
  private wasReloadQuiet = true;
  private workersWorking = 0;
  /** Of those, another backend's: they run inside this process and would end with it. */
  private workersInProcess = 0;
  private poke: NodeJS.Timeout | null = null;
  private readonly ticker: NodeJS.Timeout;
  private closing = false;
  /** Why it closes, once it does. */
  private closingFor: ExitCause | null = null;
  /** The chat is being reopened in place (reacquire with force): its close is not this process's end. */
  private reopening = false;
  private readonly recorder: InflightRecorder;
  /** A worker chat's feed (proto 3), else null. */
  private feed: WorkerFeed | null = null;
  /** This chat's own workers, started and driven through the server (§app.chat-processes/workers). */
  private readonly workers = new LinkWorkerHost(() => this.settings.serverToolWaitMs);
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: HostOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.error(`[chat-runtime] ${l}`));
    this.quietSince = this.now();
    this.reloadQuietSince = this.quietSince;
    this.recorder = new InflightRecorder(() => o.sessionId);
    onChatEvent((e) => this.onEvent(e));
    setWorkerHostSource((parent) => this.workers.bind(parent));
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
    if (this.link) this.sayHello(this.link, this.epoch);
  }

  // ---- the controller -----------------------------------------------------------------------------

  /** A server took control (link.ts serveLink's onControl). */
  onControl(link: Link, control: ControlFrame): void {
    try {
      this.takeControl(link, control);
    } finally {
      // The link's opening hello said another state (it came while the process booted, or before a
      // change no controller heard): say the state now, once (kernel hello), even when taking control
      // threw, or the server waiting for "ready" refuses the chat. setState says each later change on
      // this link and records it, so the server hears "ready" exactly once, whether the boot ended
      // before this control arrived or after.
      if (link.isOpen && link.saidState !== null && link.saidState !== this.state) this.sayHello(link, control.epoch);
    }
  }

  private takeControl(link: Link, control: ControlFrame): void {
    const before = this.link;
    if (before && before !== link) this.lostLink();
    this.link = link;
    this.epoch = control.epoch;
    this.settings = control.settings;
    const life = `${control.serverPid}:${control.serverStartedAt}`;
    if (this.serverLife !== null && this.serverLife !== life) {
      // The last server's reload (asked for, running or failed) ends with it: this one sees older
      // code and is asked by its own rules; a Reload now still stands.
      this.reloadAsked = false;
      if (this.reloadNowWanted) this.reloadPending = true;
      this.codeSaid = null;
      this.codeChanged();
    }
    this.serverLife = life;
    void link.closed.then(() => {
      if (this.link === link) this.lostLink();
    });
    this.listen(link);
    if (link.compatible) this.workers.linked(link);
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
      // In this order (stage-3 design §8): the run facts the last server didn't ack, the wait-asks,
      // then the calls. A run's start reaches the server before any tool call of that run.
      if (link.peerProto >= SPECIAL_PROTO) {
        for (const f of this.outbox) link.send(f);
        for (const w of this.waits.values()) this.writeWait(w);
      }
      // Server-hosted calls and actions: written to a link that dropped, their outcome is unknown and
      // they are never sent again; never written, they go now.
      for (const p of [...this.tools.values()]) {
        if (p.sentOn) this.settleTool(p, { ok: false, unknown: true, error: { message: OUTCOME_UNKNOWN } });
        else if (this.canWrite(p)) this.writeTool(p);
      }
      if (this.orphaned) {
        if (this.orphanTimer) clearTimeout(this.orphanTimer);
        this.orphanTimer = setTimeout(() => this.endOrphans(true), this.settings.orphanGraceMs);
        this.orphanTimer.unref?.();
      }
    }
  }

  private sayHello(link: Link, epoch: number): void {
    link.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch, ...this.hello() });
  }

  /** The controller's link ended: its panes become orphans (open dialogs wait), asks read as nothing. */
  private lostLink(): void {
    this.link = null;
    this.workers.unlinked();
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
    // Wait-asks wait for the next server; the reply text so far is only for share pages: dropped.
    for (const w of this.waits.values()) w.sentOn = null;
    if (this.replyText) clearTimeout(this.replyText.timer);
    this.replyText = null;
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
      // A stopping chat takes no prompt: it goes back to its pane (the draft restored), never lost
      // in a dispose or a pane this process never attached.
      if (this.closing || !c || !this.chat || this.chat.disposed) {
        this.log(`a pane's ${f.msg.type} came while ${this.closing ? "closing" : !c ? "its pane is not attached" : "no chat is open"}: ${unsentRefusal(f.msg) ? "refused" : "dropped"}`);
        const refusal = unsentRefusal(f.msg);
        if (refusal) link.send({ t: "client.send", clientId: f.clientId, json: JSON.stringify(refusal) });
        return;
      }
      if ((f.msg.type === "prompt" || f.msg.type === "steer") && String(f.msg.text ?? "").startsWith("/")) this.log(`took a pane's ${f.msg.type} command ${String(f.msg.text).split(/\s/)[0]}`);
      this.chat.handle(c, f.msg);
      this.pokeSoon();
    }));
    link.on("client.detach", mine((f: FrameOf<"client.detach">) => {
      const c = this.clients.get(f.clientId);
      this.clients.delete(f.clientId);
      if (c && this.chat) this.chat.detach(c);
      this.pokeSoon();
    }));
    link.on("tool.update", mine((f: FrameOf<"tool.update">) => this.tools.get(f.effectId)?.local?.onUpdate?.(f.update)));
    link.on("tool.result", mine((f: FrameOf<"tool.result">) => {
      const p = this.tools.get(f.effectId);
      if (p) this.settleTool(p, f.outcome);
    }));
    link.on("tool.back", mine((f: FrameOf<"tool.back">) => void this.toolBack(link, f)));
    link.on("run.ack", mine((f: FrameOf<"run.ack">) => {
      const before = this.outbox.length;
      this.outbox = this.outbox.filter((r) => r.n > f.n);
      if (this.outbox.length !== before) this.pokeSoon();
    }));
    link.on("answer", mine((f: FrameOf<"answer">) => {
      const w = this.waits.get(f.id);
      if (w) {
        this.waits.delete(f.id);
        if (w.timer) clearTimeout(w.timer);
        if (f.ok) w.resolve(f.result);
        else w.reject(new Error(f.error.message));
        this.pokeSoon();
        return;
      }
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
    else if (f.kind === "special") setSpecialComposerClosed(this.o.path, f.composerClosed);
    else if (f.kind === "code") {
      this.codeSaid = f.state === "reloading" || f.state === "failed" ? { state: f.state, ...(f.detail ? { detail: f.detail } : {}) } : null;
      if (f.state !== "reloading") this.reloadAsked = false;
      if (f.state === "failed") this.reloadNowWanted = false;
      // "older" after "reloading": the rollout's drain was refused (no longer quiet); Reload now asks again at the next quiet moment.
      if (f.state === "older" && this.reloadNowWanted) this.reloadPending = true;
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
    if (f.special && link.peerProto < SPECIAL_PROTO)
      return void reply({ t: "opened", id: f.id, ok: false, error: { message: "A special chat needs a server that speaks protocol 2." } });
    if (f.worker && link.peerProto < WORKER_PROTO)
      return void reply({ t: "opened", id: f.id, ok: false, error: { message: "A worker chat needs a server that speaks protocol 3." } });
    if (f.worker) setWorkerSpec(this.o.path, f.worker);
    if (f.opening) setOpeningChoice(this.o.path, f.opening);
    setServedTools(f.served);
    // A special loadout opens from the server's data, its kind answered over this socket.
    if (f.special) {
      setSpecialSpec(this.o.path, f.special);
      setSpecialPort(this.o.path, this.specialPort());
    }
    this.wire(f.served);
    const trail = this.o.openTrail?.((frame) => void (link.isOpen && link.compatible && link.send(frame))) ?? null;
    try {
      // The broken-deploy trial's failed open (T27): this build refuses every open.
      const failOpen = process.env.SOVA_CHAT_TEST_FAIL_OPEN;
      if (failOpen && failOpen === this.o.build) throw new Error(`SOVA_CHAT_TEST_FAIL_OPEN=${failOpen}: failing the open on purpose`);
      const chat = await acquireChat(this.o.path, f.force, trail ? (step) => trail.step(step) : undefined);
      this.chat = chat;
      // A worker chat feeds its parent (through the server) from its first event.
      if (f.worker && !this.feed) {
        this.feed = new WorkerFeed((frame) => this.sendFeed(frame), { onSettled: () => this.pokeSoon() });
        this.feed.attach(chat.harness, chat.sendKeys);
      }
      this.setState("open");
      this.quietSince = this.now();
      this.reloadQuietSince = this.quietSince;
      trail?.finish(true);
      reply({ t: "opened", id: f.id, ok: true, mirror: this.mirror() });
      this.lastMirror = JSON.stringify(this.mirror());
    } catch (err) {
      trail?.finish(false);
      const r = failureReply(f.id, err);
      reply({ t: "opened", id: f.id, ok: false, ...(r.ok === false && "refusal" in r ? { refusal: r.refusal } : { error: { message: err instanceof Error ? err.message : String(err) } }) });
      this.log(`open refused: ${err instanceof Error ? err.message : String(err)}`);
      await this.close("refused", { dispose: false });
    }
  }

  /** What this process's chat reads of the server, over the socket instead of the server's singletons. */
  private wire(served: ServerToolDecl[]): void {
    setRunRecorder(this.recorder);
    setPowersHost(this.powersPort(served));
    setServerToolPort({ call: (call, local) => this.toolCall(call, local) });
    setChatHosts({
      playbook: {
        bundleFor: (sessionId, hint) => this.ask("playbook.bundleFor", { sessionId, hint: hint ?? null }) as never,
        reprime: (ctx) => this.ask("playbook.reprime", { sessionId: ctx.sessionId, leafId: this.chat?.leafId() ?? null }),
      },
      instanceNote: (ctx) => this.ask("project.note", { cwd: ctx.cwd, sessionId: ctx.sessionId, leafId: this.chat?.leafId() ?? null }),
      offerNote: (sessionId) => this.ask("offers.note", { sessionId }),
    });
    setSingletonCheck((key, path) => this.ask("singleton", { key, path }));
    setLinksSource((sessionId, path) => this.ask("links", { sessionId, path }) as never);
    // A stage-2 server (proto 1) knows no such ask: it gets none, and the rows go without timings.
    setReplyTimingsSource((sessionId) => (this.speaksSpecial() ? this.ask("reply.timings", { sessionId }) : Promise.resolve(null)));
    setCodeReload((client) => this.reloadNow(client));
    (globalThis as Record<symbol, unknown>)[LINK_LIVE] = (sessionId: string) => this.liveIds.has(sessionId);
  }

  private ask<M extends NothingAsk>(method: M, args: ChatAsks[M]["args"]): Promise<ChatAsks[M]["result"]> {
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

  /** A wait-ask: written to the controller now, or to the next one; fails with NOT_RUN_NO_SERVER
      after serverToolWaitMs without an answer (from its making, and again from each new controller). */
  waitAsk<M extends WaitAsk>(method: M, args: ChatAsks[M]["args"]): Promise<ChatAsks[M]["result"]> {
    const id = `w${++this.askN}`;
    return new Promise((resolve, reject) => {
      const w: PendingWait = { id, method, args, sentOn: null, timer: null, resolve: resolve as (v: unknown) => void, reject };
      this.waits.set(id, w);
      this.armWait(w);
      if (this.speaksSpecial()) this.writeWait(w);
      this.pokeSoon();
    });
  }

  private writeWait(w: PendingWait): void {
    const link = this.link!;
    w.sentOn = link;
    this.armWait(w);
    link.send({ t: "ask", id: w.id, method: w.method, args: w.args });
  }

  private armWait(w: PendingWait): void {
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      if (this.waits.get(w.id) !== w) return;
      this.waits.delete(w.id);
      this.log(`ask ${w.method} unanswered${w.sentOn ? "" : " (no server)"}`);
      w.reject(new Error(NOT_RUN_NO_SERVER));
      this.pokeSoon();
    }, this.settings.serverToolWaitMs);
    w.timer.unref?.();
  }

  /** Whether the controller is linked and speaks the stage-3 frames. */
  private speaksSpecial(): boolean {
    return !!this.link?.isOpen && this.link.compatible && this.link.peerProto >= SPECIAL_PROTO;
  }

  // ---- a special loadout's run events (stage 3) -----------------------------------------------------

  /**
   * One run event of this chat's special loadout, in the chat's own event: numbered, written at once.
   * Facts are kept until the server acks them and written again, in order, to the next controller;
   * ticks go only to a linked server. The reply's text is coalesced (REPLY_TEXT_EVERY_MS), and what
   * is waiting goes before any other event.
   */
  runEvent(event: ChatRunEvent): void {
    if (event.type === "reply.text") {
      if (!this.speaksSpecial()) return;
      if (this.replyText) this.replyText.event = event;
      else {
        const timer = setTimeout(() => this.flushReplyText(), REPLY_TEXT_EVERY_MS);
        timer.unref?.();
        this.replyText = { event, timer };
      }
      return;
    }
    this.flushReplyText();
    if (RUN_FACTS.has(event.type)) {
      const f: FrameOf<"run"> = { t: "run", n: ++this.runN, event };
      this.outbox.push(f);
      if (this.speaksSpecial()) this.link!.send(f);
      this.pokeSoon();
    } else if (this.speaksSpecial()) this.link!.send({ t: "run", n: ++this.runN, event });
  }

  private flushReplyText(): void {
    const r = this.replyText;
    if (!r) return;
    clearTimeout(r.timer);
    this.replyText = null;
    if (this.speaksSpecial()) this.link!.send({ t: "run", n: ++this.runN, event: r.event });
  }

  /** A server action (stage 3): a call on the served-tool path, under an effect id of its own; it
      resolves to the action's own result. */
  action(name: ServerActionName, args: unknown): Promise<ServerToolOutcome<unknown>> {
    const turns = this.chat?.userTurns;
    const call: ServerToolCall = {
      effectId: `${this.o.path}#${name}#${randomUUID()}`,
      chatId: this.o.path,
      toolCallId: name,
      name,
      params: args,
      attended: turns?.attended() ?? false,
      own: turns?.ownMessage() ?? false,
      card: turns?.confirmedCard() ?? null,
    };
    // The server answers an action's tool.result with the action's own result (chat-handle-remote.ts).
    return this.queueTool(call, null);
  }

  /**
   * Session powers in this process (§chat.profiles/session-tools): the tools run here, beside the run
   * they hear; what they read of other sessions waits for the server (never an empty answer when
   * none comes); a send is the `@powers.send` action; `queue_open` is served.
   */
  private powersPort(served: ServerToolDecl[]): PowersHost {
    const queueOpen = served.find((d) => d.name === "queue_open");
    return {
      sessions: () => this.waitAsk("powers.sessions", {}),
      session: (id) => this.waitAsk("powers.session", { id }),
      transcript: (path) => this.waitAsk("powers.transcript", { path }),
      insight: (path) => this.waitAsk("powers.insight", { path }),
      held: (path) => this.waitAsk("powers.held", { path }),
      projectRoot: (cwd) => this.waitAsk("powers.projectRoot", { cwd }),
      send: async (a) => {
        const out = await this.action("@powers.send", a);
        if (out.ok) return out.result as PowersSendResult;
        return "unknown" in out ? { ok: false, error: out.error.message, unknown: true } : { ok: false, error: out.error.message };
      },
      queueOpen: () => (queueOpen ? serverToolSpec(this.o.path, queueOpen) : null),
    };
  }

  /** What this process's chat answers for its special loadout (chat-manager's SpecialPort). */
  specialPort(): SpecialPort {
    return {
      runStart: (a) => this.waitAsk("special.runStart", a),
      compact: (a) => this.waitAsk("special.compact", a),
      agentEnd: (a) => this.waitAsk("special.agentEnd", a),
      runEvent: (e) => this.runEvent(e),
      action: (name, args) => this.action(name, args),
    };
  }

  // ---- commands -----------------------------------------------------------------------------------

  /** The commands a chat process answers its own way; the rest are the shared table's. */
  private readonly own: Partial<{ [M in ChatMethod]: (chat: ChatSession, args: ChatMethods[M]["args"]) => Promise<ChatMethods[M]["result"]> | ChatMethods[M]["result"] }> = {
    // A worker chat's feed ring, read again by a server whose link dropped.
    feedSince: (_chat, { proc, seq }) => this.feed?.since(proc, seq) ?? { gap: true },
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
    // Its chat already closed for a reload: unanswered, so the server's handle sends it to the replacement
    // (or, for a command it can't send twice, fails it as unreachable when this link ends), never "closed".
    if (this.closingFor === "reload" && (!this.chat || this.chat.disposed)) return;
    const chat = this.chat;
    if (!chat || chat.disposed) return void link.send({ t: "reply", reply: { id: call.id, ok: false, error: { message: "This chat is closed." } } });
    let reply: FrameOf<"reply">["reply"];
    // A worker's settle is told under the key of the send that started its run.
    if (call.method === "send") this.feed?.noteSend((call.args as { key?: string }).key);
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
      ...(f.client.pull && typeof f.client.have === "string" ? { have: f.client.have } : {}),
      // After its hello, which starts the pane's account again (the hello may wait: ChatSession.attach).
      greeted: () => {
        const code = this.code();
        if (code.state !== "current") client.send(codeMessage(code));
      },
    };
    this.clients.set(f.clientId, client);
    // A pane is back: the orphans go, their dialogs stay (attach sends them again).
    if (this.orphaned) this.endOrphans(false);
    chat.attach(client);
    this.pokeSoon();
  }

  // ---- server-hosted tools ------------------------------------------------------------------------

  private toolCall(call: ServerToolCall, local: ServerToolLocal): Promise<ServerToolOutcome<ToolResult>> {
    return this.queueTool(call, local) as Promise<ServerToolOutcome<ToolResult>>;
  }

  /** A served tool's call (`local`: its side in this process) or a server action's (null): written
      to the controller now, or queued for the next one. */
  private queueTool(call: ServerToolCall, local: ServerToolLocal | null): Promise<ServerToolOutcome<unknown>> {
    const chat = this.chat;
    const ctx: ServerToolCtxWire = {
      sessionId: this.o.sessionId,
      cwd: chat?.harness.cwd ?? local?.ctx?.cwd ?? "",
      leafId: chat?.leafId() ?? null,
      title: chat ? titleOf(chat.harness.branch()) : null,
    };
    return new Promise((resolve) => {
      const p: PendingTool = { call, ctx, local, sentOn: null, timer: null, resolve };
      this.tools.set(call.effectId, p);
      local?.signal?.addEventListener("abort", () => {
        if (!this.tools.has(call.effectId)) return;
        if (p.sentOn?.isOpen) p.sentOn.send({ t: "tool.abort", effectId: call.effectId });
        else if (!p.sentOn) this.settleTool(p, { ok: false, error: { message: "Stopped before the server ran it." } });
      });
      if (this.canWrite(p)) this.writeTool(p);
      else this.armToolTimer(p, { ok: false, error: { message: NOT_RUN_NO_SERVER } });
      this.pokeSoon();
    });
  }

  /** A served tool goes to any compatible controller; an action only to one that speaks stage 3. */
  private canWrite(p: PendingTool): boolean {
    return !!this.link?.isOpen && this.link.compatible && (p.local !== null || this.link.peerProto >= SPECIAL_PROTO);
  }

  private writeTool(p: PendingTool): void {
    const link = this.link;
    if (!link?.isOpen) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.sentOn = link;
    link.send({ t: "tool.call", call: p.call, ctx: p.ctx });
  }

  private armToolTimer(p: PendingTool, outcome: ServerToolOutcome<unknown>): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.settleTool(p, outcome), this.settings.serverToolWaitMs);
    p.timer.unref?.();
  }

  private settleTool(p: PendingTool, outcome: ServerToolOutcome<unknown>): void {
    if (this.tools.get(p.call.effectId) !== p) return;
    this.tools.delete(p.call.effectId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(outcome);
    this.pokeSoon();
  }

  /**
   * A call-back inside a served call (stage 3): the server's tool appends a state record to this
   * chat, or runs a tool the chat registered, within that call. Only for a call still pending on the
   * link the call-back came over; answered once, on that link.
   */
  private async toolBack(link: Link, f: FrameOf<"tool.back">): Promise<void> {
    const answer = (frame: FrameOf<"tool.backResult">) => {
      if (link.isOpen) link.send(frame);
    };
    const fail = (message: string) => answer({ t: "tool.backResult", id: f.id, ok: false, error: { message } });
    const p = this.tools.get(f.effectId);
    const chat = this.chat;
    if (!p || p.sentOn !== link || !chat || chat.disposed) return fail(GONE_CALL);
    try {
      if (f.op === "append") {
        // Through the chat's writer, or with `announce` through its special extension
        // (entry_appended fires, as the baton's share refresh needs).
        const result = await appendForCall(this.o.path, f.kind, f.data, f.announce);
        return answer({ t: "tool.backResult", id: f.id, ok: true, result });
      }
      if (!p.local) return fail("A server action runs no tool of the chat.");
      const tool = chat.harness.registeredTool(f.name);
      if (!tool) return fail(`No such tool in this chat: ${f.name}`);
      const result = await tool.execute(f.toolCallId, f.params, p.local.signal, undefined, p.local.ctx);
      answer({ t: "tool.backResult", id: f.id, ok: true, result });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
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
      this.workersInProcess = inProcessWorking(rec?.rec);
    } catch {
      // the live dir mid-write: next tick
    }
    this.check();
    this.idleWithoutServer();
  }

  /** Since when this chat has had no server linked and nothing in flight, or null. */
  private unlinkedQuietSince: number | null = null;
  /** No server linked (Sova stopped for good, §app.chat-processes/idle-stop): a chat with nothing in
      flight for the idle-stop time (as the last server set it) exits by itself, as an idle stop. Run
      facts no server has acknowledged don't hold it: the session file has them. A process never opened
      (its server stopped mid-start, or a reload's replacement never moved into) is quiet. */
  private idleWithoutServer(): void {
    const chat = this.chat;
    const quiet = !chat || (!chat.disposed && this.quietOf(mirrorOf(chat), false, true));
    if (this.link || this.closing || !(this.settings.idleStopMin > 0) || !quiet) {
      this.unlinkedQuietSince = null;
      return;
    }
    const now = this.now();
    this.unlinkedQuietSince ??= now;
    if (now - this.unlinkedQuietSince < this.settings.idleStopMin * 60_000) return;
    this.log(`no server, and quiet for ${this.settings.idleStopMin} min: closing`);
    void this.close("idle", { dispose: true });
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

  /** Nothing in flight: no run, compaction, start, queue, dialog, working worker, server call or
      action, unacked run fact or wait-ask. For a reload, only a worker inside this process counts:
      the rest run in processes of their own and are reattached (§app.chat-processes/code-pickup). */
  private quietOf(m: ChatStateMirror, reload = false, unlinked = false): boolean {
    return (
      !m.running &&
      !m.compacting &&
      !m.starting &&
      m.queue.web === 0 &&
      !m.queue.agent &&
      m.dialogs.length === 0 &&
      (reload ? this.workersInProcess : this.workersWorking) === 0 &&
      this.tools.size === 0 &&
      this.workers.pending === 0 &&
      (unlinked || this.outbox.length === 0) &&
      this.waits.size === 0
    );
  }

  /** Wait-asks and server actions waiting on the server. */
  private hooksWaiting(): number {
    let actions = 0;
    for (const p of this.tools.values()) if (!p.local) actions++;
    return this.waits.size + actions;
  }

  private mirror(): ChatRuntimeMirror {
    const chat = this.chat!;
    const base = mirrorOf(chat);
    const quiet = this.quietOf(base);
    const reloadQuiet = this.quietOf(base, true);
    const hooks = this.hooksWaiting();
    if (quiet !== this.wasQuiet) {
      this.wasQuiet = quiet;
      this.quietSince = this.now();
    }
    if (reloadQuiet !== this.wasReloadQuiet) {
      this.wasReloadQuiet = reloadQuiet;
      this.reloadQuietSince = this.now();
      if (!reloadQuiet) this.reloadAsked = false;
    }
    return {
      ...base,
      build: this.o.build,
      startedAt: this.o.startedAt,
      code: this.code(),
      quiet: {
        quiet,
        since: this.quietSince,
        clients: this.clientCount(),
        // What holds a reload: "Reloads when its workers finish" (src/lib/code-state.ts).
        workersWorking: this.workersInProcess,
        serverCalls: this.tools.size - (hooks - this.waits.size),
        outbox: this.outbox.length,
        hooks,
      },
      claude: claudeChildState(),
      // What the monitor extension in this process says of the chat; before its first session_start, the title alone.
      monitor: hostedFacts(this.o.path) ?? { title: titleOf(chat.harness.branch()), workers: [], toolsRunning: 0, lastToolEnd: 0 },
      ...(chat.workerSpec && this.feed
        ? { worker: { parentSessionId: chat.workerSpec.parent.sessionId, workerId: chat.workerSpec.parent.workerId, kind: chat.workerSpec.kind, proc: this.feed.proc, seq: this.feed.cursor().seq, lastSettled: this.feed.settled, keys: true } }
        : {}),
      llm: llmSnapshot(),
    };
  }

  /** A worker chat's feed frame, to a server that speaks proto 3 (one that doesn't reads the ring later). */
  private sendFeed(f: { cursor: { proc: string; seq: number }; event: unknown }): void {
    const link = this.link;
    if (link?.isOpen && link.compatible && link.peerProto >= WORKER_PROTO) link.send({ t: "feed", cursor: f.cursor, event: f.event });
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
    if (this.code().state === "current") this.reloadPending = this.reloadNowWanted = false;
    if (this.chat && !this.chat.disposed && this.clients.size) this.chat.broadcast(codeMessage(this.code()) as ChatServerMessage);
    this.pokeSoon();
  }

  /** A pane's "Reload now": at once when quiet, else when the reply finishes; a current chat says so to that pane only. */
  private reloadNow(client: ChatClient): void {
    const code = this.code();
    if (code.state === "current") return client.send({ type: "code", state: "current" } as ChatServerMessage);
    if (code.state === "reloading") {
      // A reload is under way (an automatic one, say): the press stands, so if its drain is refused the
      // chat asks again at its next quiet moment, never after the dwell.
      this.reloadNowWanted = true;
      return client.send(codeMessage(code) as ChatServerMessage);
    }
    this.codeSaid = null; // failed: try again, as older
    this.reloadNowWanted = true;
    if (this.wasReloadQuiet && this.chat && this.quietOf(mirrorOf(this.chat), true)) this.requestReload(false);
    else {
      this.reloadPending = true;
      this.codeChanged();
    }
  }

  private requestReload(auto: boolean): void {
    if (!this.link?.isOpen || !this.link.compatible) return;
    this.reloadAsked = true;
    this.log(`asking to reload (${auto ? "automatic" : "Reload now"})`);
    this.link.send({ t: "reload.request", auto });
  }

  /** Older and quiet: a reload is asked for once per quiet stretch: at once with nobody attached, or
      after the dwell; a pending "Reload now" at the first quiet moment. Workers in processes of
      their own don't hold it; another backend's working worker does (it'd end with the process). */
  private considerReload(): void {
    if (this.reloadAsked || !this.wasReloadQuiet || this.code().state !== "older") return;
    if (this.reloadPending) {
      this.reloadPending = false;
      this.requestReload(false);
      return;
    }
    if (this.clientCount() === 0 || this.now() - this.reloadQuietSince >= this.settings.reloadDwellMs) this.requestReload(true);
  }

  // ---- closing ------------------------------------------------------------------------------------

  private async drain(link: Link, f: FrameOf<"drain">): Promise<void> {
    const answer = (frame: FrameOf<"drained">) => link.send(frame);
    if (this.closing) return void answer({ t: "drained", id: f.id, ok: true });
    const chat = this.chat;
    if (chat && !chat.disposed && !f.force) {
      const quiet = this.quietOf(mirrorOf(chat), f.reason === "reload");
      if (!quiet) {
        // A Reload now whose drain came after a reply started: it goes at the reply's end, the pane saying so.
        if (f.reason === "reload" && this.reloadNowWanted && !this.reloadPending) {
          this.reloadPending = true;
          this.codeChanged();
        }
        return void answer({ t: "drained", id: f.id, ok: false, why: "busy" });
      }
      // An open tab doesn't keep a quiet chat running (§app.chat-processes/idle-stop): its panes are
      // told it closed, and keep what they show until they need the chat again.
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
    this.closingFor = cause;
    this.setState("closing");
    clearInterval(this.ticker);
    const chat = this.chat;
    if (opts.dispose && chat && !chat.disposed) {
      // Finish what was taken (F14): a command running (an idle chat runs `/btw` at once) and what
      // it asked the server get a bounded moment, so its request reaches the server before the
      // dispose cuts it off; prompts arriving meanwhile are refused (client.msg above).
      const busy = () => chat.commandsInFlight > 0 || chat.turnStarting || this.workers.pending > 0;
      const state = () => `${chat.commandsInFlight} command(s) running, turn starting ${chat.turnStarting}, ${this.workers.pending} request(s) to the server unanswered`;
      this.log(`closing (${cause}): ${state()}`);
      const until = Date.now() + CLOSE_QUIESCE_MS;
      while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      if (busy()) this.log(`closing with work unfinished: ${state()}`);
      try {
        if (opts.message) await disposeHeldChat(chat.path, opts.message);
        else await chat.dispose();
      } catch (err) {
        this.log(`dispose failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The run marker is the open chat's: a process that never opened it (a reload's replacement) leaves
    // the one the chat's own process wrote.
    if (chat) this.recorder.clear();
    const link = this.link;
    if (link?.send({ t: "exit", cause })) {
      // The server closes the link once it hears the exit, so whatever a pane sent before then
      // arrives here first and is refused back (client.msg above), never lost on a closed socket.
      await Promise.race([link.closed, new Promise((r) => setTimeout(r, EXIT_LINGER_MS))]);
    }
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

/** How long a closing chat lets a command it already took, and its requests to the server, finish. */
const CLOSE_QUIESCE_MS = 3_000;
/** How long a closing process waits, after its `exit`, for the server to close the link. */
const EXIT_LINGER_MS = 2_000;

/** Backends whose workers are chat processes of their own (§app.chat-processes/workers); any other
    registered backend's worker runs inside its parent's process. */
const CHAT_PROCESS_BACKENDS = new Set(["pi", "claude-code"]);

/** A live record's working workers that run inside this process (another backend's); the record
    never drops a working one for size. */
function inProcessWorking(rec: unknown): number {
  const presence = (rec as { presence?: Record<string, unknown> } | undefined)?.presence;
  return decodeWorkers(presence).filter((w) => w.working && !CHAT_PROCESS_BACKENDS.has(w.backend ?? "pi")).length;
}

function codeMessage(code: ChatCodeState): { type: "code"; state: ChatCodeState["state"]; pending?: boolean; detail?: string } {
  return { type: "code", state: code.state, ...(code.pending ? { pending: true } : {}), ...(code.detail ? { detail: code.detail } : {}) };
}
