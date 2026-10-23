// The server's side of a hosted chat (al_3 stage 1): server code talks to a chat only through its
// ChatHandle, never to the ChatSession (server/chat-manager.ts) or its driving session. The handle is
// what a chat in its own process will look like to the server (shared/chat-runtime.ts): commands that
// are calls with ids, answered with a result or a typed refusal; a state mirror read synchronously;
// lifecycle events numbered per runtime; browser frames passed through. Today the chat runs in this
// process: a call runs the chat's method at once (its guards run at the moment of the call, exactly
// as a direct call did) and its answer comes back as a reply.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatCall,
  ChatId,
  ChatLifecycleEvent,
  ChatMethod,
  ChatMethods,
  ChatModePatch,
  ChatRefusal,
  ChatReply,
  ChatRunEvent,
  ChatSpecialKind,
  RunStartAnswer,
  ChatSendInput,
  ChatSendReceipt,
  ChatStateMirror,
  ChatTopicBatch,
  ChatTurnEnd,
  ServerToolCall,
  ServerToolDecl,
  ServerToolOutcome,
  SpecialSpec,
} from "../shared/chat-runtime";
import type { ChatAskMethod, ServerToolCtxWire } from "../shared/chat-runtime-wire";
import type { HEntry, HookCtx, ImageInput, StateKind, ToolCtx, ToolResult, ToolSpec } from "../shared/harness";
import type { ChatClientMessage, ChatModeResult, HeldChatState, ProjectModeApproval } from "../shared/protocol";
import {
  BusyError,
  type ChatClient,
  type ChatSession,
  isOverseerFile,
  type LocalSpecials,
  type SessionMarks,
  setLocalSpecials,
  type SpecialPort,
  chatEventsSince,
  ConfigError,
  drainQueueThenAbort,
  emitChatEvent,
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
import { failureReply, refusalOf } from "./chat-runtime/methods";
import type { LoadoutEntryData } from "./session-loadout";
import { branchOf, readPi, strictBranchTo } from "./harness/pi/reader";
import { stateView } from "./harness/state-view";
import { playbookHost } from "./playbook-host";
import { projectEngine } from "./project-services/routes";
import { sessionInstanceNote, sessionVerbsTool } from "./project-services/tools";
import { stateRoot } from "./state-root";
import { queueOpenTool, queuePushTool } from "./topics";
import type { PowersSend } from "./session-powers";
import { tourTools } from "./tours/tools";
import { sessionOfferTools } from "./session-offers-tool";
import { offerNoteFor } from "./session-offers";
/** The powers host, loaded when first needed (session-profile-routes binds chat-manager at its import). */
const powersHost = () => import("./session-profile-routes").then((m) => m.powersHost);

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
  setWorkerHostSource,
  warmChatRuntime,
} from "./chat-manager";
import { fetchSessionTimings } from "./reply-facts";

export { failureReply, refusalOf };

/** The error a refusal is thrown as on this side, so `instanceof` reads it as the chat meant it. */
export function errorOfRefusal(r: ChatRefusal): Error {
  if (r.kind === "busy") return new BusyError(r.message, r.code);
  if (r.kind === "config") return new ConfigError(r.message, r.cwd);
  return r.mode ? new ModeRefusedError(r.message) : new RefusedError(r.message);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One held chat, as the server talks to it: in a process of its own (RemoteChatHandle,
    server/chat-handle-remote.ts, §app/chat-processes), or in the caller's own process (tests only:
    server/testing/in-process-chats.ts). The typed commands
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
  modeResult(): Promise<ChatModeResult> {
    return this.call("modeResult", {});
  }
  approveHooks(approvals: ProjectModeApproval[]) {
    return this.call("approveHooks", { approvals });
  }
  runModeCommand(mode: string, name: string, args?: unknown) {
    return this.call("runModeCommand", { mode, name, ...(args !== undefined ? { args } : {}) });
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
  appendNote(noteType: string, text: string, details?: unknown): Promise<boolean> {
    return this.call("appendNote", { noteType, text, ...(details !== undefined ? { details } : {}) });
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

// The special kinds (the Overseer, batons, project overseers; §app.harness/session-special): each one's
// server side, registered by the module that owns it. A chat gets its loadout as data (SpecialSpec)
// and asks the rest of its kind through its SpecialPort: in a chat process its socket (a test's chat
// in its own process: a loopback, server/testing/in-process-chats.ts). Its hooks get the chat's handle, never the chat.

/** The server's side of a special kind. */
export interface SpecialHost {
  kind: ChatSpecialKind;
  /** The kind a file opens as (the Overseer's is isOverseerFile, always tried first). */
  matches(marks: SessionMarks, path: string): boolean;
  /** The directory its chat opens in on THIS host, or null (not this kind's file): used instead of
      the header's cwd, which records the host the file was created on. */
  cwd?(path: string): string | null;
  /** The loadout for an open (local or remote), its tools served for this chat; throws the kind's
      refusal (a previous conversation is read-only) before anything is built or spawned. */
  spec(path: string): Promise<SpecialSpec>;
  /** A chat process this server took back (no open): serve its tools and rebuild per-chat state. */
  adopt(path: string): Promise<void>;
  runStart(path: string, ctx: HookCtx, a: { images: boolean }): Promise<RunStartAnswer>;
  compact?(path: string, ctx: HookCtx): Promise<RunStartAnswer["message"] | null>;
  agentEnd?(path: string, text: string): Promise<RunStartAnswer["message"] | null>;
  /** Each run event of the kind's chat, inside the chat's own event (here) or in arrival order (a chat
      process). `n`: its number, increasing per chat (a chat process's frame number; here a counter). */
  runEvent?(path: string, e: ChatRunEvent, n: number): void;
  /** Every open, once bound. */
  opened?(chat: ChatHandle): Promise<void>;
  /** A message from this server's own composer: who sent it, or throw a refusal the client is told.
      `text` and `images`, when given, are what is sent instead. */
  clientSend?(path: string, msg: { images: number; text: string }): { by: string; text?: string; images?: ImageInput[] };
  /** The runtime refused the message `clientSend` attributed after all. */
  clientSendRefused?(path: string): void;
  /** The composer changed the chat's model or thinking (`save: true`): the kind keeps it. */
  saveChoice?(path: string, patch: { model?: string; thinking?: string }): void;
  /** Its composer takes nothing right now (a message for the client), or null. */
  composerClosed?(path: string): string | null;
  /** Its chat's process died: the kind cleans up what the run left in its own state. */
  died?(path: string): void;
  /** Its chat closed: what the kind kept for it goes. */
  closed?(path: string): void;
  /** Its chat's process is linked again (a reconnect, a reload): what waited for it goes now. */
  relinked?(path: string): void;
}
const specialHosts: SpecialHost[] = [];
/** Each chat's kind, as its spec was last built or its process taken back. */
const kindOfChat = new Map<ChatId, ChatSpecialKind>();

let specialsHere: LocalSpecials | null = null;
export function registerSpecialHost(h: SpecialHost): void {
  if (!specialHosts.some((x) => x.kind === h.kind)) specialHosts.push(h);
  setLocalSpecials(specialsHere ?? serverSpecials);
}
/** Tests' chats in their own process add the loopback to the kinds (server/testing/in-process-chats.ts). */
export function setSpecialsHere(s: LocalSpecials): void {
  specialsHere = s;
  setLocalSpecials(s);
}
export const specialHostOf = (kind: ChatSpecialKind): SpecialHost | undefined => specialHosts.find((h) => h.kind === kind);
/** The special kind a session file opens as: the Overseer's first, then each registered kind. */
export function specialKindOf(marks: SessionMarks, path: string): ChatSpecialKind | null {
  if (isOverseerFile(marks)) return "overseer";
  return specialHosts.find((h) => h.kind !== "overseer" && h.matches(marks, path))?.kind ?? null;
}

/** The server actions a special chat calls (§app.chat-processes/server-actions), as served tools of
    reserved names: never declared to the model, run under the same effect ids. */
function specialActions(h: SpecialHost, path: string): ToolSpec[] {
  const action = (name: string, run: (params: any) => unknown): ToolSpec => ({
    name,
    label: name,
    description: "A server action (never declared to a model).",
    parameters: { type: "object" },
    async execute(_id, params) {
      return { content: [], details: (await run(params)) ?? null };
    },
  });
  return [
    ...(h.clientSend ? [action("@clientSend", (m) => h.clientSend!(path, { images: Number(m?.images) || 0, text: String(m?.text ?? "") }))] : []),
    ...(h.clientSendRefused ? [action("@clientSendRefused", () => h.clientSendRefused!(path))] : []),
    ...(h.saveChoice ? [action("@saveChoice", (patch) => h.saveChoice!(path, patch ?? {}))] : []),
  ];
}

/** A special chat's spec, with its server actions served, and the test-only slow tool when the
    trial asks for it (SOVA_CHAT_TEST_SERVED=1, last in its tools and allowlist). */
export async function specialSpecFor(kind: ChatSpecialKind, path: string): Promise<SpecialSpec> {
  const h = specialHostOf(kind);
  if (!h) throw new Error(kind === "overseer" ? "The Overseer is not available on this server." : "This chat's kind is not available here.");
  const spec = await h.spec(path);
  kindOfChat.set(path, kind);
  serveTools(path, specialActions(h, path));
  if (process.env.SOVA_CHAT_TEST_SERVED === "1") {
    const sleep = trialServedSleep();
    spec.tools = [...spec.tools, ...serveTools(path, [sleep]).map(() => declOfTool(sleep))];
    spec.allow = [...spec.allow, sleep.name];
  }
  return spec;
}

/** A special chat process this server took back: its kind serves it again. */
export async function adoptSpecial(kind: ChatSpecialKind, path: string): Promise<void> {
  const h = specialHostOf(kind);
  if (!h) return;
  kindOfChat.set(path, kind);
  await h.adopt(path);
  serveTools(path, specialActions(h, path));
  if (process.env.SOVA_CHAT_TEST_SERVED === "1") serveTools(path, [trialServedSleep()]);
}

/** The kinds as the server's own code reads them: what a file opens as, where, its loadout. The
    loopback to a kind (`port`, `opened`) is only for a chat in the caller's process (tests:
    server/testing/in-process-chats.ts). */
export const serverSpecials: LocalSpecials = {
  kindOf: specialKindOf,
  cwd(path) {
    for (const h of specialHosts) {
      const cwd = h.cwd?.(path);
      if (cwd) return cwd;
    }
    return undefined;
  },
  spec: specialSpecFor,
};
export type { SessionMarks, SpecialKind } from "./chat-manager";

/**
 * Get (or open) the chat for a session file. Refused (BusyError) when a TUI owns it, or unless
 * `force`, when another process may be writing it; ConfigError when it can't be opened at all.
 */
export async function acquireChatHandle(path: string, force = false): Promise<ChatHandle> {
  // The server's router: every chat in a process of its own (it waits for the chat's own take-back,
  // if a previous server left it running).
  if (!router) throw new Error("no chat router: the server hosts no chat in its process");
  return router.acquire(path, force);
}

/** Whether a chat is open for a session file, once a take-back of it (after a server restart) is
    done: the chat, or undefined. A router that takes nothing back answers at once. */
export async function chatHandleTakenBack(path: string): Promise<ChatHandle | undefined> {
  if (!router && routerComing) await routerComing.promise;
  await router?.takenBack?.(path);
  return router?.get(path);
}

/** The open chat for a session file (already through resolveSessionPath), or undefined. */
export const chatHandle = (path: string): ChatHandle | undefined => router?.get(path);

/** Every chat this server holds open, here or in processes of their own. */
export const chatHandles = (): ChatHandle[] => router?.all() ?? [];

/**
 * Where the server's chats run (server/chat-host.ts, §app/chat-processes): installed at the server's
 * start, every chat in a process of its own. Unset (a chat process, a test), a chat runs here.
 */
export interface ChatRouter {
  /** Resolves once the chats a previous server left running are taken back (bounded). */
  ready(): Promise<void>;
  /** The chat of this path in a process of its own, if one is open. */
  get(path: string): ChatHandle | undefined;
  all(): ChatHandle[];
  /** The chat in a process of its own (taken back, or started); a chat that can't start is refused. */
  acquire(path: string, force: boolean): Promise<ChatHandle>;
  /** Close it for good (archive): its panes are told to reconnect, or with `quiet` that it closed. False: none open there. */
  close(path: string, message: string, opts?: CloseOpts): Promise<boolean>;
  /** A special chat's composer may have changed: each in a process of its own is told. */
  composersChanged?(): void;
  /** Resolves once this path's chat, if a previous server left it running, is taken back (bounded),
      so `get` can be trusted for it; at once when none of it was left running. */
  takenBack?(path: string): Promise<void>;
}
let router: ChatRouter | null = null;
export function setChatRouter(r: ChatRouter | null): void {
  router = r;
  routerComing?.resolve();
  routerComing = null;
}

/** A special chat's composer may have changed (a project archived or not): each chat in a process of its own is told. */
export const specialComposersChanged = (): void => router?.composersChanged?.();

/** Set by a server that will install a router (server/index.ts, before its orgs open): until it is
    installed, chatsReady waits for it, so a reader at boot never mistakes "not taken back yet" for "none". */
let routerComing: { promise: Promise<void>; resolve(): void } | null = null;
export function expectChatRouter(): void {
  if (router || routerComing) return;
  let resolve!: () => void;
  routerComing = { promise: new Promise<void>((r) => (resolve = r)), resolve };
}

/** Resolves once the chats a previous server left running are taken back (bounded): at once with no router. */
export const chatsReady = async (): Promise<void> => {
  if (!router && routerComing) await routerComing.promise;
  await router?.ready();
};

/** The open chat of a session id, or undefined. */
export const chatHandleById = (sessionId: string): ChatHandle | undefined => chatHandles().find((h) => h.mirror.sessionId === sessionId);

/** How a closed chat's open tabs are told. `quiet`: they keep what they show and don't reconnect
    (`closed`, as after an idle stop), so the close never starts the chat again (an archive);
    otherwise they reconnect, opening it anew (a cleared Overseer, a model change, a move). */
export interface CloseOpts {
  quiet?: "archived";
}

/** Close a held chat for good (archive/close): every open tab is told to reconnect, and the session
    reopens on demand, or with `quiet` told it closed. A running turn is aborted and its workers die
    with it. False: none held. */
export async function closeChat(path: string, message: string, opts: CloseOpts = {}): Promise<boolean> {
  return router ? router.close(path, message, opts) : false;
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
    if (e.type !== "closed") return;
    hostedTools.delete(e.chatId);
    // What a special kind kept for the chat goes with it.
    const kind = kindOfChat.get(e.chatId);
    kindOfChat.delete(e.chatId);
    if (kind) specialHostOf(kind)?.closed?.(e.chatId);
  });
}

/** A tool's declaration: what the chat declares to its model, nothing it runs. */
export function declOfTool(spec: ToolSpec): ServerToolDecl {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
    ...(spec.promptGuidelines !== undefined ? { promptGuidelines: spec.promptGuidelines } : {}),
    parameters: spec.parameters,
    ...(spec.executionMode !== undefined ? { executionMode: spec.executionMode } : {}),
    ...(spec.exposure !== undefined ? { exposure: spec.exposure } : {}),
    ...(spec.prepareRule ? { prepares: spec.prepareRule } : {}),
  };
}

/**
 * Host tools for one chat (a loadout's: the Overseer's, a project overseer's, a baton's): each spec
 * stays here, and what the chat registers is its declaration, run through the loopback with an
 * effect id per run. A spec hosted again under the same name replaces the one before.
 */
export function serveTools(chatId: ChatId, specs: readonly ToolSpec[]): ToolSpec[] {
  serveOnce();
  for (const spec of specs)
    if (spec.prepareArguments && !spec.prepareRule) throw new Error(`${spec.name}: a served tool that rewrites its arguments must name its prepare rule.`);
  let mine = hostedTools.get(chatId);
  if (!mine) hostedTools.set(chatId, (mine = new Map()));
  for (const spec of specs) mine.set(spec.name, spec);
  return specs.map((spec) => serverToolSpec(chatId, declOfTool(spec)));
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
};

// ---- a chat in a process of its own: what the server answers it (§app.chat-processes/server-actions) --

/** The ToolCtx of a call a chat process made: its session file read up to the leaf it named. */
export async function fileHookCtx(path: string, w: Partial<ServerToolCtxWire> & { sessionId: string }): Promise<HookCtx> {
  return (await fileSnapshot(path, w)).ctx;
}

/** Each session file as last parsed, by its size and mtime (a special chat's run start reads its file
    once per run; the Overseer's runs to megabytes). */
const parsed = new Map<string, { size: number; mtimeMs: number; file: Awaited<ReturnType<typeof readPi>> }>();
async function readPiCached(path: string): Promise<Awaited<ReturnType<typeof readPi>>> {
  const st = await stat(path).catch(() => null);
  const have = parsed.get(path);
  if (st && have && have.size === st.size && have.mtimeMs === st.mtimeMs) return have.file;
  const file = await readPi(path);
  if (st) parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, file });
  return file;
}

/**
 * A chat process's call, read from its session file up to the leaf it named: the ToolCtx, and the
 * whole file. `add`: an entry the call appended since (a call-back), which becomes the leaf.
 */
export async function fileSnapshot(path: string, w: Partial<ServerToolCtxWire> & { sessionId: string }): Promise<{ ctx: HookCtx; entries: () => HEntry[]; add(entry: HEntry): void }> {
  const file = await readPiCached(path);
  const branch = [...(strictBranchTo(file, w.leafId ?? null) ?? branchOf(file.entries))];
  const all = [...file.entries];
  let leaf = w.leafId ?? null;
  let state = stateView(branch);
  return {
    ctx: {
      sessionId: w.sessionId,
      cwd: w.cwd ?? file.header?.cwd ?? "",
      leafId: () => leaf,
      branch: () => branch,
      state: () => state,
      key: path,
      title: () => w.title ?? undefined,
    },
    entries: () => all,
    add(entry) {
      branch.push(entry);
      all.push(entry);
      leaf = entry.id;
      state = stateView(branch);
    },
  };
}

/** The server-hosted tools of an ordinary chat in a process of its own, hosted here: their
    declarations go to the chat in its `open`, in loadout order. `known`: the title the chat reports
    (its pi session name, often none), used only when the session's display title can't be read. */
export function servedToolsFor(chatId: ChatId, sessionId: string, known: () => string | undefined, powers = false): ServerToolDecl[] {
  const specs: ToolSpec[] = [sessionVerbsTool(() => projectEngine()), queuePushTool({ sessionId: () => sessionId, title: () => senderTitle(chatId, known) }), ...tourTools(sessionId, chatId)];
  if (process.env.SOVA_CHAT_TEST_SERVED === "1") specs.push(trialServedSleep());
  // A powers profile's queue_open (its own extension registers it, from this declaration) and its
  // sends, a server action (§app.chat-processes/server-actions).
  if (powers) {
    specs.push(queueOpenTool({ sessionId, path: () => chatId, project: async () => (await (await powersHost()).projectRoot?.(chatHandle(chatId)?.mirror.cwd ?? "")) ?? null }));
    serveTools(chatId, [powersSendAction()]);
  }
  serveTools(chatId, specs);
  return specs.map(declOfTool);
}

/**
 * Every server-hosted tool of a chat this server opens or adopts: servedToolsFor's, then, for an
 * ordinary chat (no special kind but a powers profile), its `offer` tool when its snapshot names any
 * (§chat.offers/tool). Last in the list, so a chat with none declares exactly what it did before.
 */
export async function servedToolsForChat(chatId: ChatId, sessionId: string, known: () => string | undefined, kind: string | null): Promise<ServerToolDecl[]> {
  const decls = servedToolsFor(chatId, sessionId, known, kind === "powers");
  if (kind !== null && kind !== "powers") return decls;
  const offers = await sessionOfferTools(sessionId, chatId);
  if (!offers.length) return decls;
  serveTools(chatId, offers);
  return [...decls, ...offers.map(declOfTool)];
}

/** A pusher's title, the one Sova shows for its session (§chat.topics/push): its display title, else
    the title its chat reports, else "Untitled"; never blank. */
async function senderTitle(path: string, known: () => string | undefined): Promise<string> {
  const { displayTitleOf } = await import("./sessions-index"); // it imports this module
  return (await displayTitleOf(path))?.trim() || known()?.trim() || "Untitled";
}

/** `@powers.send`: a powers chat's session_send, run here with its invitations (PowersHost.send). */
function powersSendAction(): ToolSpec {
  return {
    name: "@powers.send",
    label: "@powers.send",
    description: "A server action (never declared to a model).",
    parameters: { type: "object" },
    async execute(_id, params) {
      return { content: [], details: await (await powersHost()).send(params as PowersSend) };
    },
  };
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

/**
 * Test only (SOVA_CHAT_TEST_SERVED=1 with SOVA_CHAT_TEST_ACT_DELAY_MS, the chat-runtime trial): an
 * acting tool waits that long, `before` its act or `after` it (logged and done), as
 * SOVA_CHAT_TEST_ACT_DELAY_AT says (default after), so a trial can restart the server inside a real
 * act. Each wait is logged beside trial_served_sleep's runs. A no-op otherwise.
 */
export async function trialActWait(at: "before" | "after", tool: string, toolCallId: string, signal?: AbortSignal): Promise<void> {
  const ms = Number(process.env.SOVA_CHAT_TEST_ACT_DELAY_MS);
  if (process.env.SOVA_CHAT_TEST_SERVED !== "1" || !(ms > 0)) return;
  if ((process.env.SOVA_CHAT_TEST_ACT_DELAY_AT === "before" ? "before" : "after") !== at) return;
  const log = (event: string) => {
    mkdirSync(join(stateRoot(), "chats"), { recursive: true });
    appendFileSync(join(stateRoot(), "chats", "test-served.jsonl"), `${JSON.stringify({ event, tool, toolCallId, effectId: serverToolCall()?.call.effectId, at: Date.now() })}\n`);
  };
  log("act-wait");
  await new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });
  log("act-done");
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
    case "reply.timings":
      return fetchSessionTimings(String(a.sessionId ?? ""));
    case "offers.note":
      return offerNoteFor(String(a.sessionId ?? ""));
    case "powers.sessions":
      return (await powersHost()).sessions();
    case "powers.session":
      return (await powersHost()).session(String(a.id ?? ""));
    case "powers.transcript":
      return (await powersHost()).transcript(String(a.path ?? ""));
    case "powers.insight":
      return (await powersHost()).insight(String(a.path ?? ""));
    case "powers.held":
      return await (await powersHost()).held(String(a.path ?? ""));
    case "powers.projectRoot":
      return (await (await powersHost()).projectRoot?.(String(a.cwd ?? ""))) ?? null;
    case "special.runStart":
    case "special.compact":
    case "special.agentEnd": {
      const kind = kindOfChat.get(path);
      const h = kind ? specialHostOf(kind) : undefined;
      if (!h) throw new Error("This chat is no special kind's here.");
      if (method === "special.agentEnd") return h.agentEnd ? h.agentEnd(path, String(a.text ?? "")) : null;
      const ctx = await fileHookCtx(path, { sessionId: chatHandle(path)?.mirror.sessionId ?? "", leafId: a.leafId ?? null });
      if (method === "special.compact") return h.compact ? h.compact(path, ctx) : null;
      return h.runStart(path, ctx, { images: !!a.images });
    }
  }
  throw new Error(`Unknown ask: ${String(method)}`);
}

export { emitChatEvent, isOverseerFile, onLinksNotified };
