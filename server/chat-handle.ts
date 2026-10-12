// The server's side of a hosted chat (al_3 stage 1): server code talks to a chat only through its
// ChatHandle, never to the ChatSession (server/chat-manager.ts) or its driving session. The handle is
// what a chat in its own process will look like to the server (shared/chat-runtime.ts): commands that
// are calls with ids, answered with a result or a typed refusal; a state mirror read synchronously;
// lifecycle events numbered per runtime; browser frames passed through. Today the chat runs in this
// process: a call runs the chat's method at once (its guards run at the moment of the call, exactly
// as a direct call did) and its answer comes back as a reply.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
import type { ChatAskMethod, ServerToolCtxWire } from "../shared/chat-runtime-wire";
import type { HookCtx, StateKind, ToolCtx, ToolResult, ToolSpec } from "../shared/harness";
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
  disposeHeldChat,
  drainQueueThenAbort,
  emitChatEvent,
  heldChat,
  heldChats,
  linksFor,
  onLinksNotified,
  singletonFor,
  ModeRefusedError,
  onChatEvent,
  RefusedError,
  type ServerToolChat,
  type ServerToolLocal,
  type ServerToolPort,
  serverToolSpec,
  setServerToolPort,
} from "./chat-manager";
import { type CallCtx, failureReply, refusalOf, runMethod } from "./chat-runtime/methods";
import { LiveMirror } from "./chat-runtime/mirror";
import type { LoadoutEntryData } from "./session-loadout";
import { branchOf, readPi, strictBranchTo } from "./harness/pi/reader";
import { stateView } from "./harness/state-view";
import { playbookHost } from "./playbook-host";
import { projectEngine } from "./project-services/routes";
import { sessionInstanceNote, sessionVerbsTool } from "./project-services/tools";
import { stateRoot } from "./state-root";
import { queuePushTool } from "./topics";

export { BusyError, ConfigError, ModeRefusedError, RefusedError, onChatEvent, chatEventsSince };
export type { ChatClient };
export {
  activeConfigFailure,
  assertOpenConfig,
  assertNotLive,
  currentLinkOrigin,
  openKindOf,
  recordConfigFailure,
  takeOpeningChoice,
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

export { failureReply, refusalOf };

/** The error a refusal is thrown as on this side, so `instanceof` reads it as the chat meant it. */
export function errorOfRefusal(r: ChatRefusal): Error {
  if (r.kind === "busy") return new BusyError(r.message, r.code);
  if (r.kind === "config") return new ConfigError(r.message, r.cwd);
  return r.mode ? new ModeRefusedError(r.message) : new RefusedError(r.message);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One held chat, as the server talks to it: in this process (LocalChatHandle) or in a process of
    its own (RemoteChatHandle, server/chat-handle-remote.ts, §app/chat-processes). The typed commands
    are the same for both; each is one `call`. */
export abstract class ChatHandle {
  /** Where the chat runs: this server's process, or a chat process of its own. */
  abstract readonly where: "server" | "process";
  /** What the server may read without asking (see ChatStateMirror). */
  abstract readonly mirror: ChatStateMirror;
  abstract readonly chatId: ChatId;
  /** The session file this chat hosts (its id, today). */
  abstract readonly path: string;
  abstract readonly closed: boolean;
  /** One command: its result, or its refusal thrown as the error class it names. */
  abstract call<M extends ChatMethod>(method: M, args: ChatMethods[M]["args"]): Promise<ChatMethods[M]["result"]>;
  /** A browser joins: it gets the chat's hello and state, then everything the chat sends. */
  abstract attach(client: ChatClient): void;
  /** A message from that browser. */
  abstract clientMessage(client: ChatClient, msg: ChatClientMessage): void;
  abstract detach(client: ChatClient): void;

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
  /** The chat's next run is a resume: cut off again, it is not resumed a second time. */
  markResuming(): Promise<null> {
    return this.call("markResuming", {});
  }
}

/** A chat in this server's process: a call runs the chat's method at once. */
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
const handleOf = (chat: ChatSession): ChatHandle => {
  let h = handles.get(chat);
  if (!h) handles.set(chat, (h = new LocalChatHandle(chat)));
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
  if (router) {
    // A chat a previous server left running is taken back before anything decides where it runs.
    await router.ready();
    if (!heldChat(path)) {
      const remote = await router.acquire(path, force);
      if (remote) return remote;
    }
  }
  return handleOf(await acquireChat(path, force));
}

/** The open chat for a session file (already through resolveSessionPath), or undefined. */
export const chatHandle = (path: string): ChatHandle | undefined => {
  const chat = heldChat(path);
  return chat ? handleOf(chat) : router?.get(path);
};

/** Every chat this server holds open, here or in processes of their own. */
export const chatHandles = (): ChatHandle[] => [...heldChats().map(handleOf), ...(router?.all() ?? [])];

/**
 * Where chats run besides this process (server/chat-host.ts, §app/chat-processes): installed at start
 * when ordinary chats run in processes of their own. Unset, every chat runs here.
 */
export interface ChatRouter {
  /** Resolves once the chats a previous server left running are taken back (bounded). */
  ready(): Promise<void>;
  /** The chat of this path in a process of its own, if one is open. */
  get(path: string): ChatHandle | undefined;
  all(): ChatHandle[];
  /** The chat in a process of its own (taken back, or started), or null: open it in this process. */
  acquire(path: string, force: boolean): Promise<ChatHandle | null>;
  /** Close it for good (archive): its panes are told to reconnect. False: none open there. */
  close(path: string, message: string): Promise<boolean>;
}
let router: ChatRouter | null = null;
export function setChatRouter(r: ChatRouter | null): void {
  router = r;
}

/** The open chat of a session id, or undefined. */
export const chatHandleById = (sessionId: string): ChatHandle | undefined => chatHandles().find((h) => h.mirror.sessionId === sessionId);

/** Close a held chat for good (archive/close): every open tab is told to reconnect, and the session
    reopens on demand. A running turn is aborted and its workers die with it. False: none held. */
export async function closeChat(path: string, message: string): Promise<boolean> {
  if (await disposeHeldChat(path, message)) return true;
  return router ? router.close(path, message) : false;
}

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

// ---- a chat in a process of its own: what the server answers it (§app.chat-processes/server-actions) --

/** The ToolCtx of a call a chat process made: its session file read up to the leaf it named. */
export async function fileHookCtx(path: string, w: Partial<ServerToolCtxWire> & { sessionId: string }): Promise<HookCtx> {
  const file = await readPi(path);
  const branch = strictBranchTo(file, w.leafId ?? null) ?? branchOf(file.entries);
  const state = stateView(branch);
  return {
    sessionId: w.sessionId,
    cwd: w.cwd ?? file.header?.cwd ?? "",
    leafId: () => w.leafId ?? null,
    branch: () => branch,
    state: () => state,
    key: path,
    title: () => w.title ?? undefined,
  };
}

/** The server-hosted tools of an ordinary chat in a process of its own, hosted here: their
    declarations go to the chat in its `open`, in loadout order. `title`: the chat's name now. */
export function servedToolsFor(chatId: ChatId, sessionId: string, title: () => string): ServerToolDecl[] {
  const specs: ToolSpec[] = [sessionVerbsTool(() => projectEngine()), queuePushTool({ sessionId: () => sessionId, title })];
  if (process.env.SOVA_CHAT_TEST_SERVED === "1") specs.push(trialServedSleep());
  serveTools(chatId, specs);
  return specs.map(declOf);
}

/** Test only (SOVA_CHAT_TEST_SERVED=1, the chat-runtime trial): a served tool that sleeps `ms` and logs
    each run's start and end, so a trial can tell a run that happened once from one run twice. */
function trialServedSleep(): ToolSpec {
  const log = (event: string, effectId: string | undefined) => {
    mkdirSync(join(stateRoot(), "chats"), { recursive: true });
    appendFileSync(join(stateRoot(), "chats", "test-served.jsonl"), `${JSON.stringify({ event, effectId, at: Date.now() })}\n`);
  };
  return {
    name: "trial_served_sleep",
    label: "Trial served sleep",
    description: "Test only: sleeps for ms milliseconds on the server.",
    parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
    async execute(_id, params: { ms?: number }, signal) {
      const effectId = serverToolCall()?.call.effectId;
      log("start", effectId);
      await new Promise<void>((done) => {
        const t = setTimeout(done, Math.max(0, Number(params?.ms) || 0));
        signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
      });
      log("end", effectId);
      return { content: [{ type: "text", text: "SERVED-DONE" }], details: null };
    },
  };
}

/** One ask of a chat process, answered from this server's own sources. */
export async function answerChatAsk(path: string, method: ChatAskMethod, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, any>;
  switch (method) {
    case "project.note":
      return sessionInstanceNote(() => projectEngine(), await fileHookCtx(path, { sessionId: a.sessionId, cwd: a.cwd, leafId: a.leafId ?? null }));
    case "playbook.bundleFor":
      return playbookHost.bundleFor(a.sessionId, a.hint);
    case "playbook.reprime":
      return playbookHost.reprime(await fileHookCtx(path, { sessionId: a.sessionId, leafId: a.leafId ?? null }));
    case "links":
      return linksFor(a.sessionId, a.path ?? path);
    case "singleton":
      return singletonFor(a.key, a.path ?? path);
  }
  throw new Error(`Unknown ask: ${String(method)}`);
}

export { emitChatEvent, onLinksNotified };
