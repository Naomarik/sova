// A chat in a process of its own, as the server talks to it (§app/chat-processes): the same ChatHandle
// surface as a chat in this process, over the chat's socket (server/chat-runtime/link.ts). A command is
// a `call` frame answered by its `reply` (a refusal thrown again as the error class it names); the
// mirror is the last `state` the chat sent, which it sends before a reply whenever the call changed
// it; its lifecycle events reach this server's listeners through the one bus (emitChatEvent);
// browser frames pass through unparsed. Its server-hosted tools run here and its asks are answered
// from this server's own sources.
import { randomUUID } from "node:crypto";
import type { ChatCall, ChatId, ChatMethod, ChatMethods, ChatReply, ServerToolCall } from "../shared/chat-runtime";
import type { ChatRuntimeMirror, ChatWireFrame, ExitCause, FrameOf } from "../shared/chat-runtime-wire";
import type { ToolResult } from "../shared/harness";
import type { ChatClientMessage } from "../shared/protocol";
import {
  answerChatAsk,
  type ChatClient,
  ChatHandle,
  deliverServerToolCall,
  emitChatEvent,
  errorOfRefusal,
  fileHookCtx,
} from "./chat-handle";
import { awaitFrame, type Link, type LinkEnd } from "./chat-runtime/link";
import { sessionsChanged } from "./list-generation";

/** The text a call gets when the chat's process can't be reached (design §2.5). */
export const UNREACHABLE = "The chat's process is not reachable right now.";

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
  private readonly pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();
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
  ) {
    super();
    this.mirror = mirror;
    this.bind(link);
  }

  get closed(): boolean {
    return this.ended || this.mirror.closed;
  }
  get linkOpen(): boolean {
    return this.link.isOpen;
  }

  /** Talk to the chat over this link from now on (a reconnect, or a reload's replacement process). */
  repoint(link: Link, at: RemoteWhere = this.at, mirror?: ChatRuntimeMirror): void {
    this.at = at;
    this.ended = false;
    if (mirror) this.mirror = mirror;
    this.bind(link);
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
    on("tool.call", (f) => void this.runTool(f));
    on("tool.abort", (f) => this.running.get(f.effectId)?.abort());
    on("ask", (f) => {
      answerChatAsk(this.path, f.method, f.args).then(
        (result) => link.send({ t: "answer", id: f.id, ok: true, result: result ?? null }),
        (err) => link.send({ t: "answer", id: f.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } }),
      );
    });
    on("reload.request", (f) => this.hooks.reload?.(this, f.auto));
    on("exit", (f) => {
      this.ended = true;
      this.hooks.exit?.(this, f.cause);
    });
    void link.closed.then((end) => {
      if (this.link !== link) return; // repointed since
      this.failPending();
      this.hooks.linkEnd?.(this, end);
    });
    this.pushLinkLive();
  }

  private failPending(): void {
    for (const p of this.pending.values()) p.reject(new Error(UNREACHABLE));
    this.pending.clear();
  }

  private replied(reply: ChatReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject("refusal" in reply ? errorOfRefusal(reply.refusal) : new Error(reply.error.message));
  }

  call<M extends ChatMethod>(method: M, args: ChatMethods[M]["args"]): Promise<ChatMethods[M]["result"]> {
    if (!this.link.isOpen) return Promise.reject(new Error(UNREACHABLE));
    const call: ChatCall<M> = { id: `${this.epoch}:${++this.calls}`, epoch: this.epoch, chatId: this.chatId, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(call.id, { resolve: resolve as (v: unknown) => void, reject });
      if (!this.link.send({ t: "call", call: call as ChatCall })) {
        this.pending.delete(call.id);
        reject(new Error(UNREACHABLE));
      }
    });
  }

  // ---- browser frames -------------------------------------------------------------------------------

  attach(client: ChatClient): void {
    const clientId = randomUUID();
    this.clients.set(clientId, client);
    this.ids.set(client, clientId);
    this.link.send({
      t: "client.attach",
      clientId,
      client: { clientId, ...(client.wire ? { wire: client.wire } : {}), ...(client.tail ? { tail: true } : {}), ...(client.pull ? { pull: client.pull } : {}) },
    });
  }
  clientMessage(client: ChatClient, msg: ChatClientMessage): void {
    const clientId = this.ids.get(client);
    if (clientId) this.link.send({ t: "client.msg", clientId, msg });
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
  endPanes(message: string): void {
    this.ended = true;
    this.failPending();
    for (const c of this.clients.values()) {
      c.send({ type: "error", code: "internal", message });
      c.close?.(4500, "chat process stopped");
    }
    this.clients.clear();
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
  pushCode(state: FrameOf<"push"> extends infer P ? (P extends { kind: "code"; state: infer S } ? S : never) : never, detail?: string): void {
    this.link.send({ t: "push", kind: "code", state, ...(detail ? { detail } : {}) });
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
      const ctx = await fileHookCtx(this.path, f.ctx);
      const outcome = await deliverServerToolCall(call, {
        signal: abort.signal,
        onUpdate: (update: ToolResult) => link.send({ t: "tool.update", effectId: call.effectId, update }),
        ctx,
        chat: {
          branch: () => ctx.branch(),
          entries: () => ctx.branch(),
          append: () => {
            throw new Error("This chat runs in a process of its own: a server-hosted tool can't write its file.");
          },
          tool: () => undefined,
        },
      });
      link.send({ t: "tool.result", effectId: call.effectId, outcome });
    } catch (err) {
      link.send({ t: "tool.result", effectId: call.effectId, outcome: { ok: false, error: { message: err instanceof Error ? err.message : String(err) } } });
    } finally {
      this.running.delete(call.effectId);
    }
  }
}
