// The server's side of a hosted chat (al_3 stage 1): server code talks to a chat only through its
// ChatHandle, never to the ChatSession (server/chat-manager.ts) or its driving session. The handle is
// what a chat in its own process will look like to the server (shared/chat-runtime.ts): commands that
// are calls with ids, answered with a result or a typed refusal; a state mirror read synchronously;
// lifecycle events numbered per runtime; browser frames passed through. Today the chat runs in this
// process: a call runs the chat's method at once (its guards run at the moment of the call, exactly
// as a direct call did) and its answer comes back as a reply.
import { randomUUID } from "node:crypto";
import type {
  ChatCall,
  ChatId,
  ChatLifecycleEvent,
  ChatMethod,
  ChatMethods,
  ChatModePatch,
  ChatRefusal,
  ChatReply,
  ChatSendInput,
  ChatSendReceipt,
  ChatStateMirror,
  ChatTurnEnd,
} from "../shared/chat-runtime";
import type { StateKind } from "../shared/harness";
import type { ChatClientMessage, HeldChatState } from "../shared/protocol";
import {
  acquireChat,
  BusyError,
  type ChatClient,
  type ChatSession,
  chatEventsSince,
  ConfigError,
  drainQueueThenAbort,
  heldChat,
  heldChats,
  ModeRefusedError,
  onChatEvent,
  RefusedError,
} from "./chat-manager";
import { stateKindOf } from "./harness/state-kinds";
import { mergeMode } from "./mode-state";
import type { LoadoutEntryData } from "./session-loadout";

export { BusyError, ConfigError, ModeRefusedError, RefusedError, onChatEvent, chatEventsSince };
export type { ChatClient };
export {
  activeConfigFailure,
  assertNotLive,
  busyRefusal,
  cwdOverride,
  disposeAllChats,
  getModelRuntime,
  notifyLinksChanged,
  onAgentSettled,
  onAgentStarted,
  onReceiverIdle,
  setLinkOrigin,
  setLinksSource,
  setOpeningChoice,
  setSingletonCheck,
  warmClaudeCodeProvider,
} from "./chat-manager";

/** The controller epoch of this server's calls. One process: one controller, always current. */
const EPOCH = 1;

/** A typed refusal for an error the chat threw, or null for any other error. */
export function refusalOf(err: unknown): ChatRefusal | null {
  if (err instanceof BusyError) return { kind: "busy", code: err.code, message: err.message };
  if (err instanceof RefusedError) return { kind: "refused", mode: err instanceof ModeRefusedError, message: err.message };
  if (err instanceof ConfigError) return { kind: "config", cwd: err.cwd, message: err.message };
  return null;
}

/** The error a refusal is thrown as on this side, so `instanceof` reads it as the chat meant it. */
export function errorOfRefusal(r: ChatRefusal): Error {
  if (r.kind === "busy") return new BusyError(r.message, r.code);
  if (r.kind === "config") return new ConfigError(r.message, r.cwd);
  return r.mode ? new ModeRefusedError(r.message) : new RefusedError(r.message);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const kindOf = (type: string): StateKind<unknown> => {
  const kind = stateKindOf(type);
  if (!kind) throw new Error(`Unknown state kind: ${type}`);
  return kind;
};

/** What one chat's commands share: its tracked turns, until each is asked for once. */
interface CallCtx {
  turns: Map<string, Promise<ChatTurnEnd>>;
}

type Impl = { [M in ChatMethod]: (chat: ChatSession, args: ChatMethods[M]["args"], ctx: CallCtx) => ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]> };

/** Each command, run on the chat. A method that throws a refusal answers with that refusal. */
const METHODS: Impl = {
  send(chat, a, ctx) {
    const { queued, turn } = chat.acceptPrompt(a.text, a.images, a.origin ?? "server", a.clientId, {
      ...(a.replay ? { replay: true } : {}),
      ...(a.sentByOverseer ? { sentByOverseer: a.sentByOverseer } : {}),
      ...(a.sentByBaton ? { sentByBaton: a.sentByBaton } : {}),
      ...(a.sentBySession ? { sentBySession: a.sentBySession } : {}),
      ...(a.delivery ? { delivery: a.delivery } : {}),
      ...(a.confirm ? { confirm: a.confirm } : {}),
      ...(a.byPerson ? { byPerson: true as const } : {}),
    });
    const report = a.report !== false;
    const ended = turn.then(
      (): ChatTurnEnd => ({ ok: true }),
      (err): ChatTurnEnd => {
        if (report) chat.reportTurnFailure(err);
        return { ok: false, error: errorText(err) };
      },
    );
    if (!a.track || queued) return { queued, turnId: null };
    const turnId = randomUUID();
    ctx.turns.set(turnId, ended);
    return { queued, turnId };
  },
  turnEnd(_chat, { turnId }, ctx) {
    const ended = ctx.turns.get(turnId);
    if (!ended) throw new Error("That turn is not tracked.");
    ctx.turns.delete(turnId);
    return ended;
  },
  assertModelAllowed: (chat) => (chat.assertModelAllowed(), null),
  deliverToAgent: (chat, { text }) => chat.deliverToAgent(text),
  setModel: async (chat, { ref, save }) => (await chat.setModelRef(ref, save === undefined ? {} : { save }), null),
  setThinking: (chat, { level, save }) => chat.setThinking(level, save === undefined ? {} : { save }),
  findModel: async (chat, { ref }) => {
    const found = await chat.harness.findModel(ref);
    return found.ok ? { ok: true } : { ok: false, error: found.error };
  },
  switchMode: (chat, { patch }) => chat.switchMode(patch),
  applyMode: (chat, { patch }) => chat.applyMode(mergeMode(chat.modeState, patch)),
  pinMode: (chat) => chat.pinMode(),
  saveModeDefault: (chat) => chat.saveModeDefault(),
  subagentProfileInfo: (chat) => chat.subagentProfileInfo(),
  subagentSwitchRefusal: (chat) => chat.subagentSwitchRefusal(),
  switchSubagentProfile: (chat, { id }) => chat.switchSubagentProfile(id),
  appendStateRow: (chat, { kind, data }) => chat.appendStateRow(kindOf(kind), data),
  appendState: (chat, { kind: type, data }) => {
    // The kind the registry has under that type: SessionState refuses any other (server/harness/pi/state.ts).
    const kind = kindOf(type);
    return chat.harness.state.append(kind, data);
  },
  appendNote: (chat, { noteType, text }) => chat.appendNote(noteType, text),
  writeProfile: (chat, { data }) => (chat.writeProfile(data), null),
  writeLoadout: (chat, { data }) => (chat.writeLoadout(data), null),
  flushDeferredAppends: (chat) => (chat.flushDeferredAppends(), null),
  checkWrites: (chat) => chat.hasForeignWrites(),
  assertNoForeignWrites: (chat) => (chat.assertNoForeignWrites(), null),
  answerDialog: (chat, { id, value, answer, overseerId }) => (chat.answerDialog(id, value, answer, overseerId), null),
  drainAndAbort: async (chat) => (await drainQueueThenAbort(chat.harness, (m) => chat.broadcast(m), chat.queue), null),
  abort: async (chat) => (await chat.harness.abort(), null),
  interruptKeepingQueued: (chat) => chat.interruptKeepingQueued(),
  branch: (chat) => [...chat.harness.branch()],
  entries: (chat) => [...chat.harness.entries()],
  fileState: (chat, { kind }) => chat.state.file().written(kindOf(kind)).map((r) => r.data),
  activeTools: (chat) => chat.harness.activeTools(),
  setActiveTools: (chat, { names }) => (chat.harness.setActiveTools(names), null),
  declaredTools: (chat) => chat.harness.declaredTools(),
  resources: (chat) => {
    const loadout = chat.harness.resources();
    const base = chat.loadoutState;
    return {
      ...loadout,
      ...(base?.baseContext ? { context: base.baseContext.map((path) => ({ path })) } : {}),
      ...(base?.baseSkills ? { skills: base.baseSkills } : {}),
    };
  },
  sandboxInfo: (chat) => chat.sandboxInfo(),
  applySandbox: (chat, { state }) => chat.applySandbox(state),
  resumeWorker: (chat, { id }) => chat.resumeWorker(id),
  workerInfo: (chat, { id }) => chat.workerInfo(id),
};

/** The chat's answer to one call. Run at once: whatever the method does before its first await
    happens inside the call, as it did when callers called the chat directly. */
async function answer<M extends ChatMethod>(chat: ChatSession, call: ChatCall<M>, ctx: CallCtx, thrown: WeakMap<object, unknown>): Promise<ChatReply<M>> {
  let reply: ChatReply<M>;
  try {
    const result = await (METHODS[call.method] as (c: ChatSession, a: ChatMethods[M]["args"], x: CallCtx) => ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]>)(chat, call.args, ctx);
    return { id: call.id, ok: true, result };
  } catch (err) {
    const refusal = refusalOf(err);
    reply = refusal ? { id: call.id, ok: false, refusal } : { id: call.id, ok: false, error: { message: errorText(err) } };
    // In one process the caller gets the very error the chat threw (its class, its fields); across
    // a socket it gets `errorOfRefusal(refusal)`, or an Error with the message.
    thrown.set(reply, err);
    return reply;
  }
}

/** The mirror of a chat in this process: every field read from the chat as it is now. */
class LiveMirror implements ChatStateMirror {
  constructor(private readonly chat: ChatSession) {}
  get chatId() {
    return this.chat.path;
  }
  get sessionId() {
    return this.chat.harness.id;
  }
  get cwd() {
    return this.chat.harness.cwd;
  }
  get closed() {
    return this.chat.disposed;
  }
  get special() {
    return this.chat.special;
  }
  get running() {
    return this.chat.harness.isRunning();
  }
  get compacting() {
    return this.chat.isCompacting();
  }
  get starting() {
    return this.chat.turnStarting;
  }
  get model() {
    const m = this.chat.harness.model();
    return m ? { ref: m.ref, provider: m.provider } : null;
  }
  get thinking() {
    return this.chat.harness.thinking();
  }
  get leafId() {
    return this.chat.leafId();
  }
  get queue() {
    return { web: this.chat.queue.size, agent: this.chat.harness.queue.hasQueued() };
  }
  get dialogs() {
    return this.chat.pendingDialogs();
  }
  get held(): HeldChatState {
    const chat = this.chat;
    const s = chat.modeState;
    return {
      model: chat.harness.model()?.ref ?? null,
      thinking: chat.harness.thinking(),
      mode: s.mode,
      minorModes: [...s.minorModes],
      strict: s.strict,
      applies: chat.modeApplies,
      ...chat.saidState(),
    };
  }
  get memory() {
    return this.chat.memoryOffered() ? this.chat.memory.choiceNow() : null;
  }
  get streamTrip() {
    return this.chat.lastStreamTrip;
  }
  get foreignWrite() {
    return !!this.chat.foreignWrite;
  }
  get pendingSends() {
    return this.chat.hasPendingSends();
  }
  get pristine() {
    return this.chat.pristine;
  }
  get subagentPick() {
    return this.chat.subagentPick;
  }
  get profile() {
    return this.chat.profileState?.data ?? null;
  }
  get loadout() {
    const chat = this.chat;
    return chat.loadoutState ? { off: chat.loadoutState.data, toggleable: chat.loadoutToggleable } : null;
  }
}

/** One held chat, as the server talks to it. */
export class ChatHandle {
  /** What the server may read without asking (see ChatStateMirror). */
  readonly mirror: ChatStateMirror;
  private readonly ctx: CallCtx = { turns: new Map() };
  private readonly thrown = new WeakMap<object, unknown>();
  private calls = 0;

  constructor(private readonly chat: ChatSession) {
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

  /** One command: its result, or its refusal thrown as the error class it names. */
  async call<M extends ChatMethod>(method: M, args: ChatMethods[M]["args"]): Promise<ChatMethods[M]["result"]> {
    const call: ChatCall<M> = { id: `c${++this.calls}`, epoch: EPOCH, chatId: this.chat.path, method, args };
    const reply = await answer(this.chat, call, this.ctx, this.thrown);
    if (reply.ok) return reply.result;
    if (this.thrown.has(reply)) throw this.thrown.get(reply);
    throw "refusal" in reply ? errorOfRefusal(reply.refusal) : new Error(reply.error.message);
  }

  // ---- the commands, typed ------------------------------------------------------------------------

  /** Accept one message: the write guards run now and refuse it; its turn runs on. */
  send(input: ChatSendInput): Promise<ChatSendReceipt> {
    return this.call("send", input);
  }
  /** How a turn `send` tracked ended; a receipt with no turnId ended (or will) without one. */
  turnEnd(receipt: ChatSendReceipt): Promise<ChatTurnEnd> {
    return receipt.turnId ? this.call("turnEnd", { turnId: receipt.turnId }) : Promise.resolve({ ok: true });
  }
  assertModelAllowed(): Promise<null> {
    return this.call("assertModelAllowed", {});
  }
  deliverToAgent(text: string): Promise<"started" | "delivered"> {
    return this.call("deliverToAgent", { text });
  }
  setModel(ref: string, opts: { save?: boolean } = {}): Promise<null> {
    return this.call("setModel", { ref, ...opts });
  }
  setThinking(level: string, opts: { save?: boolean } = {}): Promise<string> {
    return this.call("setThinking", { level, ...opts });
  }
  findModel(ref: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.call("findModel", { ref });
  }
  switchMode(patch: ChatModePatch) {
    return this.call("switchMode", { patch });
  }
  applyMode(patch: ChatModePatch) {
    return this.call("applyMode", { patch });
  }
  pinMode(): Promise<boolean> {
    return this.call("pinMode", {});
  }
  saveModeDefault() {
    return this.call("saveModeDefault", {});
  }
  subagentProfileInfo() {
    return this.call("subagentProfileInfo", {});
  }
  subagentSwitchRefusal() {
    return this.call("subagentSwitchRefusal", {});
  }
  switchSubagentProfile(id: unknown) {
    return this.call("switchSubagentProfile", { id });
  }
  /** A state record outside any turn, with the row it renders as sent to every pane; refused mid-turn. */
  appendStateRow<T>(kind: StateKind<T>, data: T): Promise<string> {
    return this.call("appendStateRow", { kind: kind.type, data });
  }
  /** A state record, whatever the run is doing (no row is sent). */
  appendState<T>(kind: StateKind<T>, data: T): Promise<string> {
    return this.call("appendState", { kind: kind.type, data });
  }
  appendNote(noteType: string, text: string): Promise<boolean> {
    return this.call("appendNote", { noteType, text });
  }
  writeProfile(data: ChatMethods["writeProfile"]["args"]["data"]): Promise<null> {
    return this.call("writeProfile", { data });
  }
  writeLoadout(data: LoadoutEntryData): Promise<null> {
    return this.call("writeLoadout", { data });
  }
  flushDeferredAppends(): Promise<null> {
    return this.call("flushDeferredAppends", {});
  }
  checkWrites(): Promise<boolean> {
    return this.call("checkWrites", {});
  }
  assertNoForeignWrites(): Promise<null> {
    return this.call("assertNoForeignWrites", {});
  }
  answerDialog(id: string, value: unknown, answer: string, overseerId?: string): Promise<null> {
    return this.call("answerDialog", { id, value, answer, ...(overseerId ? { overseerId } : {}) });
  }
  drainAndAbort(): Promise<null> {
    return this.call("drainAndAbort", {});
  }
  abort(): Promise<null> {
    return this.call("abort", {});
  }
  interruptKeepingQueued(): Promise<number> {
    return this.call("interruptKeepingQueued", {});
  }
  branch() {
    return this.call("branch", {});
  }
  entries() {
    return this.call("entries", {});
  }
  fileState<T>(kind: StateKind<T>): Promise<unknown[]> {
    return this.call("fileState", { kind: kind.type });
  }
  activeTools(): Promise<string[]> {
    return this.call("activeTools", {});
  }
  setActiveTools(names: readonly string[]): Promise<null> {
    return this.call("setActiveTools", { names: [...names] });
  }
  declaredTools() {
    return this.call("declaredTools", {});
  }
  resources() {
    return this.call("resources", {});
  }
  sandboxInfo() {
    return this.call("sandboxInfo", {});
  }
  applySandbox(state: ChatMethods["applySandbox"]["args"]["state"]) {
    return this.call("applySandbox", { state });
  }
  resumeWorker(id: string) {
    return this.call("resumeWorker", { id });
  }
  workerInfo(id: string) {
    return this.call("workerInfo", { id });
  }

  // ---- browser frames -------------------------------------------------------------------------------

  /** A browser joins: it gets the chat's hello and state, then everything the chat sends. */
  attach(client: ChatClient): void {
    this.chat.attach(client);
  }
  /** A message from that browser. */
  clientMessage(client: ChatClient, msg: ChatClientMessage): void {
    this.chat.handle(client, msg);
  }
  detach(client: ChatClient): void {
    this.chat.detach(client);
  }
}

/** One handle per chat, for as long as the chat lives. */
const handles = new WeakMap<ChatSession, ChatHandle>();
const handleOf = (chat: ChatSession): ChatHandle => {
  let h = handles.get(chat);
  if (!h) handles.set(chat, (h = new ChatHandle(chat)));
  return h;
};

/**
 * Get (or open) the chat for a session file. Refused (BusyError) when a TUI owns it, or unless
 * `force`, when another process may be writing it; ConfigError when it can't be opened at all.
 */
export async function acquireChatHandle(path: string, force = false): Promise<ChatHandle> {
  return handleOf(await acquireChat(path, force));
}

/** The open chat for a session file (already through resolveSessionPath), or undefined. */
export const chatHandle = (path: string): ChatHandle | undefined => {
  const chat = heldChat(path);
  return chat ? handleOf(chat) : undefined;
};

/** Every chat this server holds open. */
export const chatHandles = (): ChatHandle[] => heldChats().map(handleOf);

/** The open chat of a session id, or undefined. */
export const chatHandleById = (sessionId: string): ChatHandle | undefined => chatHandles().find((h) => h.mirror.sessionId === sessionId);

/** Close a held chat for good (archive/close): every open tab is told to reconnect, and the session
    reopens on demand. A running turn is aborted and its workers die with it. False: none held. */
export { disposeHeldChat as closeChat } from "./chat-manager";

/** SessionSummary.busy: this server holds the chat and a run is in progress. */
export function isSessionBusy(path: string): boolean {
  const h = chatHandle(path);
  return !!h && h.mirror.running;
}

/** SessionSummary.pendingDialogs: the waiting extension dialogs of a chat this server holds. */
export function pendingDialogCount(path: string): number {
  return chatHandle(path)?.mirror.dialogs.length ?? 0;
}

/** SessionSummary.chat: a held chat's model, thinking and mode as its hello and `mode` message say
    them, its sandbox and Claude login as its last such messages did; undefined when not held. */
export const heldChatState = (path: string): HeldChatState | undefined => chatHandle(path)?.mirror.held;

export type { ChatLifecycleEvent };
