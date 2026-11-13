// Test-only (al_3 stage 5, B1): chats opened in the test's own process. The server hosts no chat in
// its process (§app.harness/session): its router runs each in a process of its own. A unit test that
// opens chats directly imports this module, which installs a router over chats in this process and
// the loopback to the special kinds, as the server once did itself. Never imported by product code.
import { randomUUID } from "node:crypto";
import type { ChatCall, ChatId, ChatMethod, ChatMethods, ChatRunEvent, ChatStateMirror, ServerToolCall, ServerToolOutcome } from "../../shared/chat-runtime";
import type { HookCtx, ToolResult } from "../../shared/harness";
import type { ChatClientMessage } from "../../shared/protocol";
import { acquireChat, type ChatClient, type ChatSession, disposeHeldChat, heldChat, heldChats, onChatEvent, type SpecialPort } from "../chat-manager";
import { ChatHandle, chatHandle, deliverServerToolCall, fileHookCtx, serverSpecials, setChatRouter, setSpecialsHere, type SpecialHost, specialHostOf } from "../chat-handle";
import { type CallCtx, runMethod } from "../chat-runtime/methods";
import { LiveMirror } from "../chat-runtime/mirror";
import { procStart, setProcStartForTest } from "../chat-runtime/writer-lock";

/** The controller epoch of calls in one process: one controller, always current. */
const EPOCH = 1;

export class LocalChatHandle extends ChatHandle {
  readonly where = "server" as const;
  /** What the server may read without asking (see ChatStateMirror). */
  readonly mirror: ChatStateMirror;
  private readonly ctx: CallCtx = { turns: new Map() };
  private calls = 0;

  constructor(private readonly chat: ChatSession) {
    super();
    this.mirror = new LiveMirror(chat);
  }

  get chatId(): ChatId {
    return this.chat.path;
  }
  /** The session file this chat hosts (its id, today). */
  get path(): string {
    return this.chat.path;
  }
  get closed(): boolean {
    return this.chat.disposed;
  }

  /**
   * One command: its result, or its refusal thrown as the error class it names. It runs at once:
   * whatever the method does before its first await happens inside this call, as it did when callers
   * called the chat directly. In one process the caller gets the very error the chat threw (its
   * class, its fields; failureReply is what crosses a socket), and the answer takes no turn of the
   * event loop of its own beyond the promise's: the order callers rely on against the chat's own
   * events (a settle, a statechart's next effect) was built on direct calls.
   */
  call<M extends ChatMethod>(method: M, args: ChatMethods[M]["args"]): Promise<ChatMethods[M]["result"]> {
    const call: ChatCall<M> = { id: `c${++this.calls}`, epoch: EPOCH, chatId: this.chat.path, method, args };
    try {
      const out = runMethod(this.chat, call, this.ctx);
      return out instanceof Promise ? out : Promise.resolve(out);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  attach(client: ChatClient): void {
    this.chat.attach(client);
  }
  clientMessage(client: ChatClient, msg: ChatClientMessage): void {
    this.chat.handle(client, msg);
  }
  detach(client: ChatClient): void {
    this.chat.detach(client);
  }
}

/** One handle per chat, for as long as the chat lives. */
const handles = new WeakMap<ChatSession, ChatHandle>();
export const handleOf = (chat: ChatSession): ChatHandle => {
  let h = handles.get(chat);
  if (!h) handles.set(chat, (h = new LocalChatHandle(chat)));
  return h;
};

/** A server action's outcome as a port answers it: the action's own result. */
const actionOutcome = (out: ServerToolOutcome<ToolResult>): ServerToolOutcome<unknown> => (out.ok ? { ok: true, result: out.result.details } : out);

/** The run events each chat in this process told its kind, by path (their numbers). */
const eventsHere = new Map<string, number>();

/** The loopback to a special kind, for a chat in this process. */
class LocalSpecialPort implements SpecialPort {
  private actions = 0;
  constructor(
    private readonly host: SpecialHost,
    private readonly path: string,
  ) {}
  private async ctxOf(local: { ctx: HookCtx } | undefined, leafId: string | null): Promise<HookCtx> {
    return local?.ctx ?? fileHookCtx(this.path, { sessionId: chatHandle(this.path)?.mirror.sessionId ?? "", leafId });
  }
  async runStart(a: { leafId: string | null; images: boolean }, local?: { ctx: HookCtx }) {
    return this.host.runStart(this.path, await this.ctxOf(local, a.leafId), { images: a.images });
  }
  async compact(a: { leafId: string | null }, local?: { ctx: HookCtx }) {
    return this.host.compact ? this.host.compact(this.path, await this.ctxOf(local, a.leafId)) : null;
  }
  async agentEnd(a: { text: string }) {
    return this.host.agentEnd ? this.host.agentEnd(this.path, a.text) : null;
  }
  runEvent(e: ChatRunEvent): void {
    const n = (eventsHere.get(this.path) ?? 0) + 1;
    eventsHere.set(this.path, n);
    this.host.runEvent?.(this.path, e, n);
  }
  action(name: "@clientSend" | "@clientSendRefused" | "@saveChoice", args: unknown): Promise<ServerToolOutcome<unknown>> {
    const call: ServerToolCall = { effectId: `${this.path}#${name}#${++this.actions}#${randomUUID()}`, chatId: this.path, toolCallId: name, name, params: args, attended: false, card: null };
    const none = () => {
      throw new Error("A server action reads nothing of its chat.");
    };
    return deliverServerToolCall(call, { signal: undefined, onUpdate: undefined, ctx: undefined, chat: { branch: none, entries: none, append: none, tool: () => undefined } }).then(actionOutcome);
  }
  composerClosed(): string | null {
    return this.host.composerClosed?.(this.path) ?? null;
  }
}

onChatEvent((e) => {
  if (e.type === "closed") eventsHere.delete(e.chatId);
});

/** Install chats in this process as the router, and the loopback to the kinds (on import). */
export function installInProcessChats(): void {
  setSpecialsHere({
    ...serverSpecials,
    port(kind, path) {
      const h = specialHostOf(kind);
      if (!h) throw new Error("This chat's kind is not available here.");
      return new LocalSpecialPort(h, path);
    },
    async opened(kind, chat) {
      await specialHostOf(kind)?.opened?.(handleOf(chat));
    },
  });
  setChatRouter({
    ready: async () => {},
    get: (path) => {
      const chat = heldChat(path);
      return chat ? handleOf(chat) : undefined;
    },
    all: () => heldChats().map(handleOf),
    acquire: async (path, force) => handleOf(await acquireChat(path, force)),
    close: (path, message) => disposeHeldChat(path, message),
  });
}
installInProcessChats();
// A chat's writer lock reads its start time as on Linux (/proc); on macOS none, so a unit test spawns no `ps`.
setProcStartForTest((pid) => procStart(pid, "linux"));
