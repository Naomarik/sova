// A chat in a process of its own, as the server talks to it (§app/chat-processes): the same ChatHandle
// surface as a chat in this process, over the chat's socket (server/chat-runtime/link.ts). A command is
// a `call` frame answered by its `reply` (a refusal thrown again as the error class it names); the
// mirror is the last `state` the chat sent, which it sends before a reply whenever the call changed
// it; its lifecycle events reach this server's listeners through the one bus (emitChatEvent);
// browser frames pass through unparsed. Its server-hosted tools run here and its asks are answered
// from this server's own sources.
import { randomUUID } from "node:crypto";
import { type ChatCall, type ChatId, type ChatMethod, type ChatMethods, type ChatReply, noAnswer, type ServerToolCall, unsentRefusal } from "../shared/chat-runtime";
import type { ChatRuntimeMirror, ChatWireFrame, ExitCause, FrameOf } from "../shared/chat-runtime-wire";
import type { EntryId, HEntry, ToolResult } from "../shared/harness";
import type { ChatClientMessage, ChatServerMessage } from "../shared/protocol";
import {
  answerChatAsk,
  type ChatClient,
  ChatHandle,
  deliverServerToolCall,
  emitChatEvent,
  errorOfRefusal,
  fileSnapshot,
  specialHostOf,
} from "./chat-handle";
import { awaitFrame, type Link, type LinkEnd } from "./chat-runtime/link";
import { sessionsChanged } from "./list-generation";

/** The text a call gets when the chat's process can't be reached (design §2.5). */
export const UNREACHABLE = "The chat's process is not reachable right now.";
/** How long a command waits for a chat whose link is down to be linked again (a reconnect, a reload). */
export const RELINK_WAIT_MS = 15_000;
/** The run events a chat keeps until acknowledged (its outbox); the others are ticks. */
const FACTS = new Set(["run.start", "user.entered", "user.end", "run.settled"]);
/** How often the ticks handled are acknowledged, at most. */
const RUN_ACK_MS = 200;

/** What the server does with what a chat process tells it, beyond the handle itself. */
export interface RemoteHooks {
  /** A `state` frame arrived (idle stop, the Claude cap, the resource monitor). */
  state?(h: RemoteChatHandle): void;
  /** The chat said it exits on purpose. */
  exit?(h: RemoteChatHandle, cause: ExitCause): void;
  /** Its link ended (lost, closed, refused) without that exit. */
  linkEnd?(h: RemoteChatHandle, end: LinkEnd): void;
  /** The chat asks to reload on current code (§app.chat-processes/code-pickup). */
  reload?(h: RemoteChatHandle, auto: boolean): void;
  /** Whether a session is in a live link now (the `sova:link-live` hook a chat here reads). */
  linkLive?(sessionId: string): boolean;
  /** A worker chat's feed frame (proto 3). */
  feed?(h: RemoteChatHandle, f: FrameOf<"feed">): void;
  /** A parent chat's worker host asks (proto 3): an op, a watch, an unwatch. */
  worker?(h: RemoteChatHandle, f: FrameOf<"wk"> | FrameOf<"wk.watch"> | FrameOf<"wk.unwatch">): void;
}

const REQUEST_FRAMES = ["tool.call", "tool.abort", "ask"] as const;
type RequestFrame = FrameOf<(typeof REQUEST_FRAMES)[number]>;

/** A chat's requests that arrive before its handle exists, kept for it. */
export interface HeldRequests {
  /** Stop holding; the requests held so far, in order. */
  release(): RequestFrame[];
}

/** Hold what the chat asks on `link` until a handle takes the link: on adoption the chat sends the
    calls it queued while no server was there as soon as it gets `control`, before its `state`. */
export function holdRequests(link: Link): HeldRequests {
  const held: RequestFrame[] = [];
  const offs = REQUEST_FRAMES.map((t) => link.on(t, (f) => void held.push(f as RequestFrame)));
  return {
    release() {
      for (const off of offs) off();
      return held.splice(0);
    },
  };
}

/** Where a chat's process runs: its unit and pid (the supervisor's record). */
export interface RemoteWhere {
  unit: string;
  pid: number;
}

export class RemoteChatHandle extends ChatHandle {
  readonly where = "process" as const;
  mirror: ChatRuntimeMirror;
  private link!: Link;
  private calls = 0;
  private readonly pending = new Map<string, { call: ChatCall; resend: boolean; resolve(v: unknown): void; reject(e: unknown): void }>();
  /** Waiting for the link to come back: resolved by repoint, rejected when the handle ends. */
  private relinked: { promise: Promise<void>; resolve(): void; reject(e: unknown): void } | null = null;
  /** Call-backs within a served call, answered by the chat (`tool.backResult`). */
  private readonly backs = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();
  private backN = 0;
  /** The last run event handled (the chat numbers them; one told again is not handled twice). */
  private runN = 0;
  private ackTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Map<string, ChatClient>();
  private readonly ids = new Map<ChatClient, string>();
  private readonly running = new Map<string, AbortController>();
  private offs: (() => void)[] = [];
  private ended = false;
  /** The last lifecycle seq heard: the next link's `control.since`. */
  lastSeq: number | null = null;

  constructor(
    readonly chatId: ChatId,
    readonly path: string,
    public at: RemoteWhere,
    link: Link,
    mirror: ChatRuntimeMirror,
    private readonly epoch: number,
    private readonly hooks: RemoteHooks = {},
    held?: HeldRequests,
  ) {
    super();
    this.mirror = mirror;
    this.bind(link);
    for (const f of held?.release() ?? []) this.request(link, f);
  }

  get closed(): boolean {
    return this.ended || this.mirror.closed;
  }
  /** Its process said it exits for a reload: the replacement takes this handle over (repoint), so
      a command meanwhile waits for it, as across a reconnect, never failing as unreachable. */
  get reloading(): boolean {
    return this.reloadingNow;
  }
  private reloadingNow = false;
  get linkOpen(): boolean {
    return this.link.isOpen;
  }

  /** Talk to the chat over this link from now on (a reconnect, or a reload's replacement process). */
  repoint(link: Link, at: RemoteWhere = this.at, mirror?: ChatRuntimeMirror): void {
    this.at = at;
    this.ended = false;
    this.reloadingNow = false;
    // A replacement process numbers its run events afresh.
    if (mirror) this.runN = 0;
    this.bind(link);
    // Commands that waited for the link go now; a keyed send or a turn's end whose answer was lost, once more.
    for (const [id, p] of this.pending) {
      if (!p.resend) continue;
      p.resend = false;
      if (!link.send({ t: "call", call: p.call })) {
        this.pending.delete(id);
        p.reject(noAnswer(UNREACHABLE));
      }
    }
    this.relinked?.resolve();
    this.relinked = null;
    const kind = this.mirror.special;
    if (kind) specialHostOf(kind)?.relinked?.(this.path);
    if (mirror) {
      // A reload's replacement: the old process told every pane to reconnect, and each comes back.
      this.mirror = mirror;
      this.clients.clear();
      this.ids.clear();
    } else {
      // The same process, linked again: the panes still here (or attached while it was down) attach anew.
      for (const [clientId, client] of this.clients) this.sendAttach(clientId, client);
    }
  }

  private bind(link: Link): void {
    for (const off of this.offs) off();
    this.link = link;
    const on = <T extends FrameOf<ChatWireFrame["t"]>["t"]>(t: T, fn: (f: FrameOf<T>) => void) => this.offs.push(link.on(t, fn));
    on("reply", (f) => this.replied(f.reply));
    on("state", (f) => {
      this.mirror = f.mirror;
      sessionsChanged();
      this.hooks.state?.(this);
    });
    on("touched", () => sessionsChanged());
    on("event", (f) => {
      this.lastSeq = f.event.seq;
      emitChatEvent(this.chatId, f.event.type, f.event.batch);
    });
    on("client.send", (f) => {
      const c = this.clients.get(f.clientId);
      if (!c) return;
      if (c.sendRaw) c.sendRaw(f.json);
      else c.send(JSON.parse(f.json));
    });
    for (const t of REQUEST_FRAMES) on(t, (f) => this.request(link, f));
    on("reload.request", (f) => this.hooks.reload?.(this, f.auto));
    on("feed", (f) => this.hooks.feed?.(this, f));
    on("wk", (f) => this.hooks.worker?.(this, f));
    on("wk.watch", (f) => this.hooks.worker?.(this, f));
    on("wk.unwatch", (f) => this.hooks.worker?.(this, f));
    on("run", (f) => this.runEvent(link, f));
    on("tool.backResult", (f) => {
      const b = this.backs.get(f.id);
      if (!b) return;
      this.backs.delete(f.id);
      if (f.ok) b.resolve(f.result);
      else b.reject(new Error(f.error.message));
    });
    on("exit", (f) => {
      if (f.cause === "reload") this.reloadingNow = true;
      else this.ended = true;
      this.hooks.exit?.(this, f.cause);
      // Heard: nothing more goes to it (a pane's send is refused back, clientMessage), and the
      // process, which waits for this close, sees every frame sent before it.
      link.close();
    });
    void link.closed.then((end) => {
      if (this.link !== link) return; // repointed since
      this.flushAck(link);
      this.linkDropped();
      this.hooks.linkEnd?.(this, end);
    });
    this.pushLinkLive();
  }

  /** What the chat asks of the server: a server-hosted tool call, its abort, an ask. */
  private request(link: Link, f: RequestFrame): void {
    if (f.t === "tool.call") void this.runTool(f);
    else if (f.t === "tool.abort") this.running.get(f.effectId)?.abort();
    else
      answerChatAsk(this.path, f.method, f.args).then(
        (result) => link.send({ t: "answer", id: f.id, ok: true, result: result ?? null }),
        (err) => link.send({ t: "answer", id: f.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } }),
      );
  }

  private failPending(): void {
    for (const p of this.pending.values()) p.reject(noAnswer(UNREACHABLE));
    this.pending.clear();
    for (const b of this.backs.values()) b.reject(noAnswer(UNREACHABLE));
    this.backs.clear();
    this.relinked?.reject(noAnswer(UNREACHABLE));
    this.relinked = null;
  }

  /** The link dropped while the handle lives on (it may be linked again): a keyed send or a turn's
      end waits to be sent once more; every other command in flight fails, its outcome unknown. */
  private linkDropped(): void {
    for (const [id, p] of this.pending) {
      if (p.resend || this.resendable(p.call)) {
        p.resend = true;
        continue;
      }
      this.pending.delete(id);
      p.reject(noAnswer(UNREACHABLE));
    }
    for (const b of this.backs.values()) b.reject(noAnswer(UNREACHABLE));
    this.backs.clear();
    // Those kept for a resend fail too unless the link is back in time.
    if ([...this.pending.values()].some((p) => p.resend)) void this.waitRelink().catch(() => this.failPending());
  }

  /** A command safe to send again: a keyed send (answered with its first receipt), a turn's end, or an
      open cut off by the process exiting for a reload (the replacement answers it, never "unreachable"). */
  private resendable(call: ChatCall): boolean {
    if (call.method === "turnEnd") return true;
    if (call.method === "reacquire" && this.reloadingNow) return true;
    return call.method === "send" && !!(call.args as { key?: string }).key;
  }

  /** Resolves when the link is back (repoint), or rejects after RELINK_WAIT_MS or when the handle ends. */
  private waitRelink(): Promise<void> {
    if (!this.relinked) {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
      const timer = setTimeout(() => {
        if (this.relinked?.promise === promise) this.relinked = null;
        reject(noAnswer(UNREACHABLE));
      }, RELINK_WAIT_MS);
      timer.unref?.();
      void promise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
      this.relinked = { promise, resolve, reject };
    }
    return this.relinked.promise;
  }

  // ---- run events (a special loadout's, §app.chat-processes/special-kinds) -----------------------------

  /** A run event: its kind hears it once, in arrival order; acknowledged in batches. */
  private runEvent(link: Link, f: FrameOf<"run">): void {
    if (f.n <= this.runN) return this.scheduleAck(link);
    this.runN = f.n;
    const kind = this.mirror.special;
    try {
      if (kind) specialHostOf(kind)?.runEvent?.(this.path, f.event, f.n);
    } catch (err) {
      console.error("[chat] run event listener failed", err);
    }
    // A fact (a run's start or end, the person's message, a card click) is acknowledged at once, so a
    // restart can catch few of them unacknowledged; ticks are acknowledged in batches.
    if (FACTS.has(f.event.type)) this.flushAck(link);
    else this.scheduleAck(link);
  }
  private scheduleAck(link: Link): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => this.flushAck(link), RUN_ACK_MS);
    this.ackTimer.unref?.();
  }
  private flushAck(link: Link): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.runN > 0 && link.isOpen) link.send({ t: "run.ack", n: this.runN });
  }

  private replied(reply: ChatReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject("refusal" in reply ? errorOfRefusal(reply.refusal) : new Error(reply.error.message));
  }

  async call<M extends ChatMethod>(method: M, args: ChatMethods[M]["args"]): Promise<ChatMethods[M]["result"]> {
    // A chat whose link is down while its handle lives (reconnecting, a reload's swap) is waited for.
    if (!this.link.isOpen && !this.ended) await this.waitRelink();
    // A handle that ended (the process died, exited or was let go) takes no command: the next open starts afresh.
    if (!this.link.isOpen || this.ended) throw noAnswer(UNREACHABLE);
    const call: ChatCall<M> = { id: `${this.epoch}:${++this.calls}`, epoch: this.epoch, chatId: this.chatId, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(call.id, { call: call as ChatCall, resend: false, resolve: resolve as (v: unknown) => void, reject });
      if (!this.link.send({ t: "call", call: call as ChatCall })) {
        this.pending.delete(call.id);
        reject(noAnswer(UNREACHABLE));
      }
    });
  }

  // ---- browser frames -------------------------------------------------------------------------------

  attach(client: ChatClient): void {
    const clientId = randomUUID();
    this.clients.set(clientId, client);
    this.ids.set(client, clientId);
    // With the link down this sends nothing: the pane is attached when the chat is linked again
    // (repoint), or told it stopped (endPanes).
    this.sendAttach(clientId, client, true);
  }
  /** `first`: the pane's own attach, the only one that says which rows it holds (a relink's hello
      is the usual one). */
  private sendAttach(clientId: string, client: ChatClient, first = false): void {
    this.link.send({
      t: "client.attach",
      clientId,
      client: {
        clientId,
        ...(client.wire ? { wire: client.wire } : {}),
        ...(client.tail ? { tail: true } : {}),
        ...(client.pull ? { pull: client.pull } : {}),
        ...(first && client.pull && client.have ? { have: client.have } : {}),
      },
    });
  }
  clientMessage(client: ChatClient, msg: ChatClientMessage): void {
    const clientId = this.ids.get(client);
    if (clientId && !this.ended && this.link.send({ t: "client.msg", clientId, msg })) return;
    // No process to take it (exited, stopping, or its link down): a prompt goes back to the pane.
    const refusal = unsentRefusal(msg);
    if (refusal) client.send(refusal);
  }
  detach(client: ChatClient): void {
    const clientId = this.ids.get(client);
    if (!clientId) return;
    this.ids.delete(client);
    this.clients.delete(clientId);
    this.link.send({ t: "client.detach", clientId });
  }

  /** Every pane is told `message` and its socket closed, so it reconnects (a death, or a chat this
      server can no longer talk to). The handle is done. */
  endPanes(message: string, code: "internal" | "reloaded" = "internal"): void {
    this.closePanes({ type: "error", code, message }, code === "internal" ? "chat process stopped" : "chat closed");
  }
  /** The chat closed for being quiet (§app.chat-processes/idle-stop) or was archived: each pane is
      told so, then its socket closes. A pane that knows the word keeps what it shows and doesn't
      reconnect; one that doesn't reconnects on the close, as it always did. The handle is done. */
  closePanesQuietly(reason: "idle" | "archived"): void {
    this.closePanes({ type: "closed", reason }, "chat closed");
  }
  private closePanes(last: ChatServerMessage, reason: string): void {
    this.ended = true;
    this.reloadingNow = false;
    this.failPending();
    for (const c of this.clients.values()) {
      c.send(last);
      c.close?.(4500, reason);
    }
    this.clients.clear();
    this.ids.clear();
  }

  // ---- kernel and pushes ------------------------------------------------------------------------------

  /** Ask the chat to close (idle, reload, archive, operator): refused unless quiet, or `force`. */
  async drain(reason: FrameOf<"drain">["reason"], opts: { force?: boolean; message?: string; withinMs?: number } = {}): Promise<{ ok: true } | { ok: false; why: string }> {
    const id = randomUUID();
    const answer = awaitFrame(this.link, "drained", opts.withinMs ?? 30_000, (f) => f.id === id);
    if (!this.link.send({ t: "drain", id, reason, force: opts.force ?? false, ...(opts.message ? { message: opts.message } : {}) })) return { ok: false, why: UNREACHABLE };
    try {
      const f = await answer;
      return f.ok ? { ok: true } : { ok: false, why: f.why };
    } catch (err) {
      return { ok: false, why: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The server is stopping: say so and let go. The chat runs on. */
  bye(): void {
    this.flushAck(this.link);
    this.link.send({ t: "bye", reason: "server-stopping" });
    this.link.close();
  }

  pushLinkLive(): void {
    const id = this.mirror.sessionId;
    this.link.send({ t: "push", kind: "link-live", ids: id && this.hooks.linkLive?.(id) ? [id] : [] });
  }
  pushLinksChanged(sessionIds: readonly string[]): void {
    this.link.send({ t: "push", kind: "links-changed", sessionIds: [...sessionIds] });
    this.pushLinkLive();
  }
  /** A special chat's composer, as its kind says it is now (closed: why; open: null). */
  pushComposerClosed(text: string | null): void {
    this.link.send({ t: "push", kind: "special", composerClosed: text });
  }
  pushCode(state: FrameOf<"push"> extends infer P ? (P extends { kind: "code"; state: infer S } ? S : never) : never, detail?: string): void {
    this.link.send({ t: "push", kind: "code", state, ...(detail ? { detail } : {}) });
  }

  /** A worker host's answer or feed frame to this parent chat (proto 3); dropped while the link is down
      (the chat asks again at its next control). */
  sendWorker(f: FrameOf<"wk.result"> | FrameOf<"wk.feed">): void {
    if (this.link.isOpen) this.link.send(f);
  }

  releaseIdleModelChild() {
    return this.call("releaseIdleModelChild", {});
  }

  // ---- server-hosted tools ------------------------------------------------------------------------------

  private async runTool(f: FrameOf<"tool.call">): Promise<void> {
    const link = this.link;
    const call: ServerToolCall = f.call;
    const abort = new AbortController();
    this.running.set(call.effectId, abort);
    try {
      const snap = await fileSnapshot(this.path, f.ctx);
      const ctx = snap.ctx;
      // What the call reads of the chat is its file as it stood, plus what it wrote since; its writes
      // and nested tools are calls back to the chat, within this call (§app.harness/session-special).
      const back = (frame: { op: "append"; kind: string; data: unknown; announce: boolean } | { op: "tool"; name: string; toolCallId: string; params: unknown }): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = `b${++this.backN}`;
          this.backs.set(id, { resolve, reject });
          if (!link.send({ t: "tool.back", id, effectId: call.effectId, ...frame } as FrameOf<"tool.back">)) {
            this.backs.delete(id);
            reject(noAnswer(UNREACHABLE));
          }
        });
      const outcome = await deliverServerToolCall(call, {
        signal: abort.signal,
        onUpdate: (update: ToolResult) => link.send({ t: "tool.update", effectId: call.effectId, update }),
        ctx,
        chat: {
          branch: () => ctx.branch(),
          entries: () => snap.entries(),
          append: async (kind, data, o): Promise<EntryId> => {
            const r = (await back({ op: "append", kind: kind.type, data, announce: !!o?.announce })) as { entryId: string; entry: HEntry };
            snap.add(r.entry);
            return r.entryId;
          },
          tool: (name) => ({
            execute: async (toolCallId: string, params: unknown) => (await back({ op: "tool", name, toolCallId, params })) as ToolResult,
          }),
        },
      });
      // A server action (a reserved @name) answers with its own result, as the loopback does (actionOutcome).
      const answer = call.name.startsWith("@") && outcome.ok ? ({ ok: true, result: outcome.result.details } as typeof outcome) : outcome;
      link.send({ t: "tool.result", effectId: call.effectId, outcome: answer });
    } catch (err) {
      link.send({ t: "tool.result", effectId: call.effectId, outcome: { ok: false, error: { message: err instanceof Error ? err.message : String(err) } } });
    } finally {
      this.running.delete(call.effectId);
    }
  }
}
