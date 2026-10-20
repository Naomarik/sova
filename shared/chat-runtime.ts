// What crosses between the server and a hosted chat (al_3: one runtime for every Sova chat). Types
// only, emits nothing. Today both sides run in one process: server/chat-handle.ts is the server's
// side (a ChatHandle per held chat), server/chat-manager.ts the chat's. The shapes are the ones a chat
// in its own process speaks over its socket later, so nothing here may hold a function, a class
// instance or an object whose identity matters:
//   - commands: `ChatCall` with an id, answered by one `ChatReply` (a result, or a typed refusal);
//   - a state mirror (`ChatStateMirror`) the server reads synchronously instead of asking the chat;
//   - lifecycle events (`ChatLifecycleEvent`) numbered per runtime, for reconnecting `since` a seq;
//   - browser frames (`ChatClientFrame`), passed through without the server parsing a reply.
import type { ModeState } from "../pi-config/extensions/mode/state";
import type { SandboxState } from "../pi-config/extensions/sandbox/state";
import type { HEntry } from "./harness-history";
import type { HarnessResources, HarnessToolInfo, ImageInput } from "./harness-session";
import type { PrepareRule } from "./harness-tools";
import type { ProfileEntryData } from "./profiles";
import type {
  ChatClientMessage,
  ChatMemoryChoice,
  ChatModeResult,
  HeldChatState,
  MemoryOpen,
  MemoryOutline,
  ModeCommandOutcome,
  ModeInfo,
  ProjectModeApproval,
  ProjectModeApprovalNeeded,
  OverseerMemoryInfo,
  SandboxApplyResult,
  SandboxInfo,
  WorkerInfo,
} from "./protocol";
import type { SubagentProfilesInfo } from "./subagent-profiles";
import type { WorkerCursor } from "../pi-config/extensions/subagents/worker-host";

// The one worker loadout (al_3 stage 4): defined beside the subagents extension that computes it
// (pi-config never imports shared/), re-exported for the server.
export type {
  WorkerCursor,
  WorkerFeedFrame,
  WorkerHost,
  WorkerKind,
  WorkerRef,
  WorkerSession,
  WorkerSpec,
  WorkerStart,
  WorkerState,
} from "../pi-config/extensions/subagents/worker-host";
export { isNoAnswer, NO_ANSWER, noAnswer } from "../pi-config/extensions/subagents/worker-host";

/** A hosted chat's id across the boundary: its session file's canonical path. */
export type ChatId = string;

/** What a pane hears for a prompt or steer that reached a chat whose process is stopping (or a link
    that is closing or closed): the refusal its page answers by putting the text back in the draft,
    never silence. Null for any other message: those mean nothing to a stopping chat. */
export function unsentRefusal(msg: ChatClientMessage): { type: "error"; code: "refused"; message: string; clientId?: string } | null {
  if (msg.type !== "prompt" && msg.type !== "steer") return null;
  return { type: "error", code: "refused", message: "The chat was restarting; your message wasn't sent.", ...(msg.clientId ? { clientId: msg.clientId } : {}) };
}

/** The loadouts a chat may be opened with besides an ordinary one. */
export type ChatSpecialKind = "overseer" | "baton" | "project-overseer" | "project-assistant";

/** One extension dialog of a chat that waits on an answer (a browser is attached). */
export interface ChatDialogInfo {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  since: number;
}

/** Why the stream guard ended a chat's last turn (server/stream-guard.ts StreamTrip). */
export interface ChatStreamTrip {
  kind: string;
  /** Plain words for the operator. */
  detail: string;
  chars: number;
  at: string;
}

/** The context files and skills a session leaves out (server/session-loadout.ts LoadoutEntryData). */
export interface ChatLoadoutChoice {
  v: 1;
  offContext: string[];
  offSkills: string[];
}

/** A mode switch, merged into the chat's own mode by the chat (server/mode-state.ts ModePatch). */
export interface ChatModePatch {
  mode?: ModeState["mode"];
  minorModes?: ModeState["minorModes"];
  strict?: ModeState["strict"];
  memory?: Partial<ChatMemoryChoice>;
  /** The chat's project minor modes, whole on set (server/mode-state.ts ModePatch). */
  projectModes?: string[];
  approve?: ProjectModeApproval[];
  approvedBy?: "overseer" | "user" | "caller";
}

/**
 * What the server may read about a held chat without asking it: the chat's own values at the moment
 * of the read in-process, the last pushed copy once the chat runs elsewhere. A decision that must be
 * atomic with a write is a command, never a mirror read followed by one.
 */
export interface ChatStateMirror {
  chatId: ChatId;
  /** The session's id (its file header's). */
  sessionId: string;
  cwd: string;
  /** Closed for good: archived, reloaded, the server stopping. A closed chat takes no command. */
  closed: boolean;
  special: ChatSpecialKind | null;
  /** A run is in progress. */
  running: boolean;
  compacting: boolean;
  /** A turn was handed to the agent and has not started yet. */
  starting: boolean;
  /** `images`: the model takes images. */
  model: { ref: string; provider: string; images: boolean } | null;
  thinking: string;
  leafId: string | null;
  /** How the branch's last assistant message ended (its stop reason); null with none. */
  lastStop: string | null;
  /** Sova's web queue length, and whether the agent itself still holds queued messages. */
  queue: { web: number; agent: boolean };
  dialogs: ChatDialogInfo[];
  /** The chat's own mode (never another chat's, never simply the file). */
  mode: { mode: ModeState["mode"]; minorModes: ModeState["minorModes"]; strict: boolean };
  /** The chat's model, thinking and mode and when its last switch applies, its sandbox and Claude
      login as last said (SessionSummary.chat). */
  held: HeldChatState;
  /** The memory choice, where the chat can run memory; null where it can't. */
  memory: ChatMemoryChoice | null;
  /** Why the stream guard ended the last turn, if it did. */
  streamTrip: ChatStreamTrip | null;
  /** A foreign writer was already detected (no new check: `checkWrites` makes one). */
  foreignWrite: boolean;
  /** Messages wait in Sova's queue or the agent's. */
  pendingSends: boolean;
  /** No user message on the branch yet. */
  pristine: boolean;
  /** The chat's own subagent pick on its branch; undefined: it follows the device default. */
  subagentPick: string | undefined;
  /** The profile entry the runtime was built with (§chat.profiles/enforcement); null without one. */
  profile: ProfileEntryData | null;
  /** An ordinary chat's context-file and skill switches; null for a special loadout. */
  loadout: { off: ChatLoadoutChoice | null; toggleable: boolean } | null;
  /** A loadout that tells the person's turns apart (the Overseer, a project overseer): the run in
      progress answers a message the person sent from a composer (§app.overseer/input-source).
      False anywhere else. */
  attended: boolean;
  /** The confirm card whose click opened the person's part of the run in progress, or null. */
  confirmedCard: string | null;
}

/**
 * What a special loadout hears of its chat's runs, in the order and at the moment the chat's own
 * stream has them (in place of the driving session itself). Delivered live, never kept: a consumer
 * that missed some reads the mirror.
 */
export type ChatRunEvent =
  /** A run began. `tag`: the first run since a send that named one (`ChatSendInput.runTag`). */
  | { type: "run.start"; tag?: string }
  /** A message the person sent from a composer entered the context: the run is theirs from here
      (`card`: a confirm card's click sent it). Only where the loadout tells turns apart. */
  | { type: "user.entered"; card: string | null }
  /** The person's message, sent by a click on a confirm card (`card`), ended: its entry is written
      right after this event. */
  | { type: "user.end"; card: string }
  /** The reply so far, its text blocks only, while it streams (a loadout that asks for it). */
  | { type: "reply.text"; text: string }
  | { type: "message.end" }
  | { type: "entry.appended" }
  | { type: "run.settled" };

/** A tool whose state lives in the server (the Overseer's, a project overseer's, a baton's), as the
    chat declares it to its model: data only. The chat runs it by calling the server (ServerToolCall). */
export interface ServerToolDecl {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { readonly [key: string]: unknown };
  executionMode?: "sequential" | "parallel";
  exposure?: "model-only";
  /** The arguments are rewritten before the chat checks them against `parameters`, by a rule the
      chat runs itself (pi asks for them synchronously, so no server call can do it). */
  prepares?: PrepareRule;
}

export type { PrepareRule } from "./harness-tools";

/** One run of a server-hosted tool, chat → server. `effectId` is the same for every delivery of one
    tool call of one chat: a delivery the server has seen is answered with that run's outcome, never
    run again. `attended`/`card`: the chat's turn as it stood when the call was made. */
export interface ServerToolCall {
  effectId: string;
  chatId: ChatId;
  toolCallId: string;
  name: string;
  params: unknown;
  attended: boolean;
  card: string | null;
}

/** How a server-hosted tool's run ended, server → chat. A server that stopped while the tool ran
    answers no outcome at all; the chat's own side then says so (`unknown`, al_3 q5) and never
    sends the call again. */
export type ServerToolOutcome<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: { message: string } }
  | { ok: false; unknown: true; error: { message: string } };

/** A lifecycle event of a chat, numbered per runtime. Delivery is at least once: a consumer that
    reconnects asks for the events `since` the last seq it saw, and acts idempotently. */
export interface ChatLifecycleEvent {
  seq: number;
  chatId: ChatId;
  /** started: a run began (agent_start). settled: a run settled. receiverIdle: a run settled or a
      compaction ended (a topic receiver may take its next batch). closed: the chat closed.
      topicEntered / topicGone: a topic batch handed over entered the transcript, or never will. */
  type: "started" | "settled" | "receiverIdle" | "closed" | "topicEntered" | "topicGone";
  at: number;
  /** The topic batch's id, on topicEntered and topicGone. */
  batch?: string;
}

/** A topic batch to hand to a receiver's agent (§chat.topics/delivery). */
export interface ChatTopicBatch {
  text: string;
  topic: string;
  batch: string;
  items: { id: string; from: { sessionId: string; title: string }; at: string }[];
}

/** Why a command was refused, by what the caller can do about it. Anything else is an error. */
export type ChatRefusal =
  /** busy: a TUI owns the file (force never helps); recent: another writer (reconnect with force);
      reloaded: another client reloaded the runtime. */
  | { kind: "busy"; code: "busy" | "recent" | "reloaded"; message: string }
  /** Refused by the session's own rules (a mode switch where there is no mode, a baton turn). */
  | { kind: "refused"; mode: boolean; message: string }
  /** Can't be opened until something outside changes (its stored folder is gone). */
  | { kind: "config"; cwd: string; message: string };

/** A message to the chat: the composer's, another session's, a server feature's. */
export interface ChatSendInput {
  text: string;
  images?: ImageInput[];
  /** "client": a person in a pane (it lifts a Stop's pause on topic batches). */
  origin?: "client" | "server";
  clientId?: string;
  /** Text that came out of the transcript, sent verbatim (no second expansion, no command). */
  replay?: boolean;
  sentByOverseer?: { overseerId?: string };
  sentByBaton?: { by: string };
  sentBySession?: { sessionId: string; title: string; hop: number };
  /** The kind it is queued as mid-turn. */
  delivery?: "steer" | "followUp";
  confirm?: string;
  byPerson?: true;
  /** Refused first when the chat's model is turned off in the model policy (assertModelAllowed). */
  checkModel?: boolean;
  /** A failure of the turn it starts is reported to the chat's panes (default true). */
  report?: boolean;
  /** Keep the turn's end for one `turnEnd` call (default false). */
  track?: boolean;
  /** Named on the next run's `run.start` (ChatRunEvent), whichever run starts next. */
  runTag?: string;
  /** A send delivered again under the same key (a retry after a lost reply, an invocation resumed
      after a server restart) gets the first one's receipt back and starts no turn. */
  key?: string;
}

/** The send was accepted: queued behind a run, or its turn started (`turnId` when tracked). */
export interface ChatSendReceipt {
  queued: boolean;
  turnId: string | null;
}

/** How a tracked turn ended. A queued send's turn is not tracked: it ends at a later `settled`. */
export type ChatTurnEnd = { ok: true } | { ok: false; error: string };

/** Every command a chat takes: its arguments and its result. */
export interface ChatMethods {
  send: { args: ChatSendInput; result: ChatSendReceipt };
  turnEnd: { args: { turnId: string }; result: ChatTurnEnd };
  /** Throws the model policy's refusal for the chat's current model. */
  assertModelAllowed: { args: Record<string, never>; result: null };
  /** A topic batch, only ever as a new turn; its fate arrives as topicEntered or topicGone. */
  deliverTopicBatch: { args: ChatTopicBatch; result: "started" | "busy" | "paused" | "closed" };
  /** A link message into the agent (§mesh.links). */
  deliverToAgent: { args: { text: string }; result: "started" | "delivered" };
  setModel: { args: { ref: string; save?: boolean }; result: null };
  /** Resolves to the effective level. */
  setThinking: { args: { level: string; save?: boolean }; result: string };
  findModel: { args: { ref: string }; result: { ok: true } | { ok: false; error: string } };
  /** A project mode turn-on that needs approval switches nothing and answers the chat's mode as it is plus
      `error` and `needsApproval` (ProjectModeApprovalNeeded). */
  switchMode: { args: { patch: ChatModePatch }; result: ChatModeResult & Partial<ProjectModeApprovalNeeded> };
  /** Merge `patch` into the chat's mode and apply it (the /mode handler, no prompt). */
  applyMode: { args: { patch: ChatModePatch }; result: "skip" | "unsupported" | "command" };
  /** Your approval of project modes' hooks (POST /api/mode?path= { approveHooks }); a stale hash answers like
      switchMode's needsApproval. */
  approveHooks: { args: { approvals: ProjectModeApproval[] }; result: ChatModeResult & Partial<ProjectModeApprovalNeeded> };
  /** Run a command of a project mode on in the chat (POST /api/mode/command). */
  runModeCommand: { args: { mode: string; name: string; args?: unknown }; result: ModeCommandOutcome };
  /** The chat's mode with its project rows read now (GET /api/mode?path=). */
  modeResult: { args: Record<string, never>; result: ChatModeResult };
  pinMode: { args: Record<string, never>; result: boolean };
  saveModeDefault: { args: Record<string, never>; result: ModeInfo };
  subagentProfileInfo: { args: Record<string, never>; result: SubagentProfilesInfo };
  subagentSwitchRefusal: { args: Record<string, never>; result: string | null };
  switchSubagentProfile: { args: { id: unknown }; result: SubagentProfilesInfo & { applies: "now" | "after-turn" } };
  /** Append a state record of a registered kind (server/harness/state-kinds.ts), refused mid-turn. */
  appendStateRow: { args: { kind: string; data: unknown }; result: string };
  /** Append a state record of a registered kind, whatever the run is doing. */
  appendState: { args: { kind: string; data: unknown }; result: string };
  /** A note entry of `noteType` (its custom type), between turns only. */
  appendNote: { args: { noteType: string; text: string; details?: unknown }; result: boolean };
  writeProfile: { args: { data: ProfileEntryData }; result: null };
  writeLoadout: { args: { data: ChatLoadoutChoice }; result: null };
  flushDeferredAppends: { args: Record<string, never>; result: null };
  /** Run the write guard now: true when another writer touched the file. */
  checkWrites: { args: Record<string, never>; result: boolean };
  /** Throws the busy refusal when another writer touched the file. */
  assertNoForeignWrites: { args: Record<string, never>; result: null };
  answerDialog: { args: { id: string; value: unknown; answer: string; overseerId?: string }; result: null };
  /** Stop the run: the queue is drained first and its items go back to their panes. */
  drainAndAbort: { args: Record<string, never>; result: null };
  abort: { args: Record<string, never>; result: null };
  /** Stop the run until it stays stopped and write every queued message into the transcript as its
      sender's; how many it wrote. */
  interruptKeepingQueued: { args: Record<string, never>; result: number };
  branch: { args: Record<string, never>; result: HEntry[] };
  entries: { args: Record<string, never>; result: HEntry[] };
  /** The data of every record of these registered kinds the file holds (any branch), kind by kind,
      each oldest first. */
  fileState: { args: { kinds: string[] }; result: unknown[] };
  activeTools: { args: Record<string, never>; result: string[] };
  setActiveTools: { args: { names: string[] }; result: null };
  declaredTools: { args: Record<string, never>; result: HarnessToolInfo[] };
  /** What the runtime loaded for its prompt, the unfiltered lists where switches left rows out. */
  resources: { args: Record<string, never>; result: HarnessResources };
  sandboxInfo: { args: Record<string, never>; result: SandboxInfo | null };
  applySandbox: { args: { state: SandboxState }; result: SandboxApplyResult };
  /** The memory outline (§chat/memory), or null where the chat runs no memory engine. */
  memoryOutline: { args: Record<string, never>; result: MemoryOutline | null };
  /** One node of the memory, opened: unavailable (no engine here: read the file), no-engine (it
      could not be built), refused (no such node). */
  memoryOpen: {
    args: { id: number; n: number };
    result: { state: "unavailable" } | { state: "no-engine" } | { state: "ok"; open: MemoryOpen } | { state: "refused"; error: string };
  };
  memoryStatus: { args: Record<string, never>; result: OverseerMemoryInfo["status"] };
  /** An overseer's memory setting changed (its overseer.json): turned on now, or changed otherwise. */
  memorySettingsChanged: { args: { turnedOn: boolean }; result: null };
  resumeWorker: { args: { id: string }; result: { ok: true } | { ok: false; status: 404 | 409; error: string } };
  workerInfo: { args: { id: string }; result: WorkerInfo | null };
  /** Let the chat's idle model child go (a Claude CLI kept for its next turn); a busy one never. */
  releaseIdleModelChild: { args: Record<string, never>; result: "released" | "busy" | "none" };
  /** The chat is opened again while held: refused while a TUI owns the file, and on another writer's
      lines unless `force`; with `force` it is reopened from the file (every pane told to reconnect). */
  reacquire: { args: { force: boolean }; result: "ok" | "reloaded" };
  /** The chat's next run is an automatic resume (§app.overseer/auto-resume): never resumed again. */
  markResuming: { args: Record<string, never>; result: null };
  /** A worker chat's feed frames after `seq` of process `proc`, from its ring; a gap when they fell
      out of it or `proc` is another process (proto 3). */
  feedSince: { args: { proc: string; seq: number }; result: { frames: { cursor: WorkerCursor; event: unknown }[] } | { gap: true } };
}

export type ChatMethod = keyof ChatMethods;

/** A command, server → chat. `epoch`: the controller's, so a stale server's call is refused. */
export interface ChatCall<M extends ChatMethod = ChatMethod> {
  id: string;
  epoch: number;
  chatId: ChatId;
  method: M;
  args: ChatMethods[M]["args"];
}

/** Its answer, chat → server: exactly one per call id. */
export type ChatReply<M extends ChatMethod = ChatMethod> =
  | { id: string; ok: true; result: ChatMethods[M]["result"] }
  | { id: string; ok: false; refusal: ChatRefusal }
  | { id: string; ok: false; error: { message: string } };

/** A browser on `/ws/chat`, as the chat sees it: which wire it reads and how it wants the transcript. */
export interface ChatClientInfo {
  clientId: string;
  wire?: 2;
  tail?: boolean;
  pull?: { prefetch: boolean };
  /** The last row the browser holds (`/ws/chat?have=`): its first hello carries only the rows after
      it, when it can (server/tail-hello.ts `afterHave`). Sent on the pane's first attach only. */
  have?: string;
}

/** Browser frames: attach, a message from the browser, detach (server → chat), and the chat's
    serialized frame for one browser (chat → server), forwarded to its socket as it is. */
export type ChatClientFrame =
  | { type: "client.attach"; chatId: ChatId; client: ChatClientInfo }
  | { type: "client.msg"; chatId: ChatId; clientId: string; msg: ChatClientMessage }
  | { type: "client.detach"; chatId: ChatId; clientId: string }
  | { type: "client.send"; chatId: ChatId; clientId: string; json: string };

// ---- special loadouts (al_3 stage 3) ---------------------------------------------------------------

/**
 * A special loadout as the chat gets it (the Overseer, a project overseer, a baton): data only, built
 * by the kind's host on the server for every open, local or remote. One chat-side extension turns it
 * into the loadout; whatever reads or changes shared state stays on the server (served tools, hooks
 * the server answers, actions).
 */
export interface SpecialSpec {
  kind: ChatSpecialKind;
  /** The inline extension's name, unchanged. */
  extension: "sova-overseer" | "sova-project-overseer" | "sova-baton" | "sova-project-assistant";
  /** The folder the chat runs in on this host, or null: the header's. */
  cwd: string | null;
  /** Served, registered by the extension, in loadout order. */
  tools: ServerToolDecl[];
  /** Served, given as the SDK's customTools (the file tools), in order. */
  customTools: ServerToolDecl[];
  /** The tool allowlist. */
  allow: string[];
  loader: {
    noExtensions?: true;
    noSkills?: true;
    noPromptTemplates?: true;
    noThemes?: true;
    noContextFiles?: true;
    /** "user-then-ours": the append override keeps the user's APPEND_SYSTEM.md parts, then `append`
        (the Overseer); "none": no appended parts (project overseer, baton). */
    append: "user-then-ours" | "none";
    /** The project overseer's context files: those inside `root`, outside `out` (projectContextFiles). */
    contextFilesWithin?: { root: string; out: string[] };
  };
  model: string | null;
  thinking: string | null;
  memory?: true;
  /** The file whose `memory` is this loadout's own memory switch (a project overseer's overseer.json),
      read at each of its turns; absent = the Overseer's own (the state root's). */
  memorySettings?: string;
  attribution?: true;
  background?: true;
  replyText?: true;
  /** The usage kind the chat's requests are noted under (the Overseer, a project overseer). */
  usage?: "overseer";
  /** The hooks the server answers besides runStart (always installed). */
  hooks: { compact?: true; agentEnd?: true };
  /** The context hook, chat-side. */
  context: "redact" | "baton";
  refuses: { mode?: string; rewind?: string; regenerate?: string };
  /** The composer's prompt and steer go through the `@clientSend` action. */
  clientSend?: true;
  /** A composer model or thinking change goes to the `@saveChoice` action. */
  saveChoice?: true;
  /** Why the composer is closed, or null; updated by `push special`. */
  composerClosed: string | null;
  /** The run-start answer for the branch at open, so a process always has one. */
  start: RunStartAnswer;
}

/** The server's answer to a special loadout's run start; the last one is kept for a run that starts
    while no server answers. */
export interface RunStartAnswer {
  /** systemPromptOptions fields set verbatim (the baton: customPrompt, appendSystemPrompt "",
      contextFiles [], skills [], cwd "(none)"; the project overseer: appendSystemPrompt). */
  prompt: { appendSystemPrompt?: string; customPrompt?: string; contextFiles?: []; skills?: []; cwd?: string };
  /** The Overseer's own appended parts: the chat sets appendSystemPrompt to the user's base parts,
      then these, joined by blank lines. */
  append?: string[];
  /** The hidden message before_agent_start returns (run note, cards note). */
  message?: { customType: string; content: string; display: false; details?: unknown };
  /** Declarations registered again (the baton's record_decision with the roster's owner areas now). */
  reregister?: ServerToolDecl[];
  /** setActiveTools for this run (the baton's abilities now). */
  activeTools?: string[];
  /** The baton's context pack for this run's requests. */
  baton?: { names: Record<string, string>; holder: string | null; holderTexts: string[]; vocabulary: string[] };
}
