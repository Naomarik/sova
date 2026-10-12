// The server's side of a hosted chat (al_3 stage 1): server code talks to a chat only through its
// ChatHandle, never to the ChatSession (server/chat-manager.ts) or its driving session. The handle is
// what a chat in its own process will look like to the server (shared/chat-runtime.ts): commands that
// are calls with ids, answered with a result or a typed refusal; a state mirror read synchronously;
// lifecycle events numbered per runtime; browser frames passed through. Today the chat runs in this
// process: a call runs the chat's method at once (its guards run at the moment of the call, exactly
// as a direct call did) and its answer comes back as a reply.
import { AsyncLocalStorage } from "node:async_hooks";
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
  ChatTopicBatch,
  ChatTurnEnd,
  ServerToolCall,
  ServerToolDecl,
  ServerToolOutcome,
} from "../shared/chat-runtime";
import type { StateKind, ToolCtx, ToolResult, ToolSpec } from "../shared/harness";
import type { ChatClientMessage, HeldChatState } from "../shared/protocol";
import {
  acquireChat,
  BusyError,
  type ChatClient,
  type ChatSession,
  type OverseerRuntime as ChatOverseerRuntime,
  registerSpecialLoadout as registerChatSpecialLoadout,
  setOverseerRuntime as setChatOverseerRuntime,
  type SpecialLoadout as ChatSpecialLoadout,
  chatEventsSince,
  ConfigError,
  drainQueueThenAbort,
  emitChatEvent,
  heldChat,
  heldChats,
  ModeRefusedError,
  onChatEvent,
  RefusedError,
  type ServerToolChat,
  type ServerToolLocal,
  type ServerToolPort,
  serverToolSpec,
  setServerToolPort,
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
  warmChatRuntime,
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
    if (a.checkModel) chat.assertModelAllowed();
    // The next run names the tag, unless the chat refuses this message.
    const tagWas = chat.runTag.next;
    if (a.runTag !== undefined) chat.runTag.next = a.runTag;
    let accepted: ReturnType<ChatSession["acceptPrompt"]>;
    try {
      accepted = chat.acceptPrompt(a.text, a.images, a.origin ?? "server", a.clientId, {
        ...(a.replay ? { replay: true } : {}),
        ...(a.sentByOverseer ? { sentByOverseer: a.sentByOverseer } : {}),
        ...(a.sentByBaton ? { sentByBaton: a.sentByBaton } : {}),
        ...(a.sentBySession ? { sentBySession: a.sentBySession } : {}),
        ...(a.delivery ? { delivery: a.delivery } : {}),
        ...(a.confirm ? { confirm: a.confirm } : {}),
        ...(a.byPerson ? { byPerson: true as const } : {}),
      });
    } catch (err) {
      if (a.runTag !== undefined) chat.runTag.next = tagWas;
      throw err;
    }
    const { queued, turn } = accepted;
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
  deliverTopicBatch: (chat, batch) =>
    chat.deliverTopicBatch({
      ...batch,
      entered: () => emitChatEvent(chat.path, "topicEntered", batch.batch),
      gone: () => emitChatEvent(chat.path, "topicGone", batch.batch),
    }),
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
  fileState: (chat, { kinds }) => {
    const file = chat.state.file();
    return kinds.flatMap((kind) => file.written(kindOf(kind)).map((r) => r.data));
  },
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
  memoryOutline: (chat) => (chat.memoryAvailable() ? chat.memory.outline() : null),
  memoryOpen: (chat, { id, n }) => {
    if (!chat.memoryAvailable()) return { state: "unavailable" };
    let engine;
    try {
      engine = chat.memory.engine();
    } catch {
      return { state: "no-engine" };
    }
    try {
      return { state: "ok", open: engine.open(id, n) };
    } catch (err) {
      return { state: "refused", error: errorText(err) };
    }
  },
  memoryStatus: (chat) => chat.memory.status(),
  memorySettingsChanged: (chat, { turnedOn }) => {
    if (turnedOn) chat.memory.turnedOn();
    else chat.memory.changed();
    chat.memorySwitched();
    return null;
  },
  sandboxInfo: (chat) => chat.sandboxInfo(),
  applySandbox: (chat, { state }) => chat.applySandbox(state),
  resumeWorker: (chat, { id }) => chat.resumeWorker(id),
  workerInfo: (chat, { id }) => chat.workerInfo(id),
};

/** The reply a call that threw answers with: its typed refusal, or an error with its message. A
    caller on the other side of a socket throws it again as `errorOfRefusal(refusal)`, or an Error. */
export function failureReply(id: string, err: unknown): ChatReply {
  const refusal = refusalOf(err);
  return refusal ? { id, ok: false, refusal } : { id, ok: false, error: { message: errorText(err) } };
}

/** Run one call on the chat. */
function run<M extends ChatMethod>(chat: ChatSession, call: ChatCall<M>, ctx: CallCtx): ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]> {
  return (METHODS[call.method] as (c: ChatSession, a: ChatMethods[M]["args"], x: CallCtx) => ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]>)(chat, call.args, ctx);
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
    return m ? { ref: m.ref, provider: m.provider, images: m.images } : null;
  }
  get thinking() {
    return this.chat.harness.thinking();
  }
  get leafId() {
    return this.chat.leafId();
  }
  get lastStop() {
    const branch = this.chat.harness.branch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.kind === "assistant") return e.stop ?? null;
    }
    return null;
  }
  get queue() {
    return { web: this.chat.queue.size, agent: this.chat.harness.queue.hasQueued() };
  }
  get dialogs() {
    return this.chat.pendingDialogs();
  }
  get mode() {
    const s = this.chat.modeState;
    return { mode: s.mode, minorModes: [...s.minorModes], strict: s.strict };
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
  get attended() {
    return this.chat.userTurns?.attended() ?? false;
  }
  get confirmedCard() {
    return this.chat.userTurns?.confirmedCard() ?? null;
  }
}

/** One held chat, as the server talks to it. */
export class ChatHandle {
  /** What the server may read without asking (see ChatStateMirror). */
  readonly mirror: ChatStateMirror;
  private readonly ctx: CallCtx = { turns: new Map() };
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
      const out = run(this.chat, call, this.ctx);
      return out instanceof Promise ? out : Promise.resolve(out);
    } catch (err) {
      return Promise.reject(err);
    }
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
  deliverTopicBatch(batch: ChatTopicBatch) {
    return this.call("deliverTopicBatch", batch);
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
  fileState(kinds: readonly StateKind<unknown>[]): Promise<unknown[]> {
    return this.call("fileState", { kinds: kinds.map((k) => k.type) });
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
  memoryOutline() {
    return this.call("memoryOutline", {});
  }
  memoryOpen(id: number, n: number) {
    return this.call("memoryOpen", { id, n });
  }
  memoryStatus() {
    return this.call("memoryStatus", {});
  }
  memorySettingsChanged(turnedOn: boolean): Promise<null> {
    return this.call("memorySettingsChanged", { turnedOn });
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

// The loadout policy of the special kinds (the Overseer, batons, project overseers): registered by
// the modules that own them, run where the chat runs (server/chat-manager.ts openSession). Its hooks
// get the chat's handle, never the chat: loadout policy talks to it the way the server does.

/** A special kind's loadout policy (chat-manager's SpecialLoadout), its `opened` given the handle. */
export type SpecialLoadout = Omit<ChatSpecialLoadout, "opened"> & { opened?(chat: ChatHandle): Promise<void> };
export function registerSpecialLoadout(s: SpecialLoadout): void {
  const { opened, ...rest } = s;
  registerChatSpecialLoadout({ ...rest, ...(opened ? { opened: (chat: ChatSession) => opened(handleOf(chat)) } : {}) });
}
/** The Overseer's loadout policy (chat-manager's OverseerRuntime), its `opened` given the handle. */
export type OverseerRuntime = Omit<ChatOverseerRuntime, "opened"> & { opened(chat: ChatHandle): Promise<void> };
export function setOverseerRuntime(r: OverseerRuntime): void {
  const { opened, ...rest } = r;
  setChatOverseerRuntime({ ...rest, opened: (chat: ChatSession) => opened(handleOf(chat)) });
}
export type { SessionMarks, SpecialKind, SpecialLoadoutResult } from "./chat-manager";

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

// ---- server-hosted tools: the server's side of the loopback -------------------------------------

/** The tools each chat's loadout hosts here, by chat and name: their state lives in this server, so
    their specs never leave it; the chat gets each one's declaration (data) and runs it by a call. */
const hostedTools = new Map<ChatId, Map<string, ToolSpec>>();
let serving = false;
/** Wired at the first hosted tool, not at import: this module and the chat's import each other. */
function serveOnce(): void {
  if (serving) return;
  serving = true;
  setServerToolPort(port);
  onChatEvent((e) => {
    if (e.type === "closed") hostedTools.delete(e.chatId);
  });
}

/** A tool's declaration: what the chat declares to its model, nothing it runs. */
function declOf(spec: ToolSpec): ServerToolDecl {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
    ...(spec.promptGuidelines !== undefined ? { promptGuidelines: spec.promptGuidelines } : {}),
    parameters: spec.parameters,
    ...(spec.executionMode !== undefined ? { executionMode: spec.executionMode } : {}),
    ...(spec.exposure !== undefined ? { exposure: spec.exposure } : {}),
    ...(spec.prepareArguments ? { prepares: true as const } : {}),
  };
}

/**
 * Host tools for one chat (a loadout's: the Overseer's, a project overseer's, a baton's): each spec
 * stays here, and what the chat registers is its declaration, run through the loopback with an
 * effect id per run. A spec hosted again under the same name replaces the one before.
 */
export function serveTools(chatId: ChatId, specs: readonly ToolSpec[]): ToolSpec[] {
  serveOnce();
  let mine = hostedTools.get(chatId);
  if (!mine) hostedTools.set(chatId, (mine = new Map()));
  for (const spec of specs) mine.set(spec.name, spec);
  return specs.map((spec) => serverToolSpec(chatId, declOf(spec)));
}

/** A server-hosted tool's run in progress, as the server code it calls reads it (serverToolCall). */
export interface ServerToolRun {
  call: ServerToolCall;
  ctx: ToolCtx | undefined;
  chat: ServerToolChat;
}
const runs = new AsyncLocalStorage<ServerToolRun>();
/** The server-hosted tool run this code runs inside (across its awaits), or undefined. */
export const serverToolCall = (): ServerToolRun | undefined => runs.getStore();

/** Runs by effect id: in flight, then the last few hundred outcomes, so a call delivered again is
    answered with its first run's outcome and never runs twice. */
const effects = new Map<string, Promise<ServerToolOutcome<ToolResult>>>();
const EFFECTS_KEPT = 256;

async function runServerTool(call: ServerToolCall, local: ServerToolLocal): Promise<ServerToolOutcome<ToolResult>> {
  const spec = hostedTools.get(call.chatId)?.get(call.name);
  if (!spec) return { ok: false, error: { message: `No such tool here: ${call.name}` } };
  try {
    const result = await runs.run({ call, ctx: local.ctx, chat: local.chat }, () => spec.execute(call.toolCallId, call.params, local.signal, local.onUpdate, local.ctx));
    return { ok: true, result };
  } catch (err) {
    local.error = err;
    return { ok: false, error: { message: errorText(err) } };
  }
}

/** One delivery of a server-hosted tool's call (what a chat's socket hands the server, stage 3). */
export const deliverServerToolCall = (call: ServerToolCall, local: ServerToolLocal): Promise<ServerToolOutcome<ToolResult>> => port.call(call, local);

const port: ServerToolPort = {
  call(call, local) {
    let outcome = effects.get(call.effectId);
    if (!outcome) {
      outcome = runServerTool(call, local);
      effects.set(call.effectId, outcome);
      while (effects.size > EFFECTS_KEPT) effects.delete(effects.keys().next().value!);
    }
    return outcome;
  },
  prepare(chatId, name, args) {
    const spec = hostedTools.get(chatId)?.get(name);
    return spec?.prepareArguments ? spec.prepareArguments(args) : args;
  },
};
