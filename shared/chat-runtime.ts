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
import type { ProfileEntryData } from "./profiles";
import type {
  ChatClientMessage,
  ChatMemoryChoice,
  ChatModeResult,
  HeldChatState,
  ModeInfo,
  SandboxApplyResult,
  SandboxInfo,
  WorkerInfo,
} from "./protocol";
import type { SubagentProfilesInfo } from "./subagent-profiles";

/** A hosted chat's id across the boundary: its session file's canonical path. */
export type ChatId = string;

/** The loadouts a chat may be opened with besides an ordinary one. */
export type ChatSpecialKind = "overseer" | "baton" | "project-overseer";

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
  model: { ref: string; provider: string } | null;
  thinking: string;
  leafId: string | null;
  /** Sova's web queue length, and whether the agent itself still holds queued messages. */
  queue: { web: number; agent: boolean };
  dialogs: ChatDialogInfo[];
  /** The chat's mode and when its last switch applies, its sandbox and Claude login as last said. */
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
}

/** A lifecycle event of a chat, numbered per runtime. Delivery is at least once: a consumer that
    reconnects asks for the events `since` the last seq it saw, and acts idempotently. */
export interface ChatLifecycleEvent {
  seq: number;
  chatId: ChatId;
  /** started: a run began (agent_start). settled: a run settled. receiverIdle: a run settled or a
      compaction ended (a topic receiver may take its next batch). closed: the chat closed. */
  type: "started" | "settled" | "receiverIdle" | "closed";
  at: number;
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
  /** A failure of the turn it starts is reported to the chat's panes (default true). */
  report?: boolean;
  /** Keep the turn's end for one `turnEnd` call (default false). */
  track?: boolean;
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
  /** A link message into the agent (§mesh.links). */
  deliverToAgent: { args: { text: string }; result: "started" | "delivered" };
  setModel: { args: { ref: string; save?: boolean }; result: null };
  /** Resolves to the effective level. */
  setThinking: { args: { level: string; save?: boolean }; result: string };
  findModel: { args: { ref: string }; result: { ok: true } | { ok: false; error: string } };
  switchMode: { args: { patch: ChatModePatch }; result: ChatModeResult };
  /** Merge `patch` into the chat's mode and apply it (the /mode handler, no prompt). */
  applyMode: { args: { patch: ChatModePatch }; result: "skip" | "unsupported" | "command" };
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
  appendNote: { args: { noteType: string; text: string }; result: boolean };
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
  /** The data of every record of a registered kind the file holds (any branch), oldest first. */
  fileState: { args: { kind: string }; result: unknown[] };
  activeTools: { args: Record<string, never>; result: string[] };
  setActiveTools: { args: { names: string[] }; result: null };
  declaredTools: { args: Record<string, never>; result: HarnessToolInfo[] };
  /** What the runtime loaded for its prompt, the unfiltered lists where switches left rows out. */
  resources: { args: Record<string, never>; result: HarnessResources };
  sandboxInfo: { args: Record<string, never>; result: SandboxInfo | null };
  applySandbox: { args: { state: SandboxState }; result: SandboxApplyResult };
  resumeWorker: { args: { id: string }; result: { ok: true } | { ok: false; status: 404 | 409; error: string } };
  workerInfo: { args: { id: string }; result: WorkerInfo | null };
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
}

/** Browser frames: attach, a message from the browser, detach (server → chat), and the chat's
    serialized frame for one browser (chat → server), forwarded to its socket as it is. */
export type ChatClientFrame =
  | { type: "client.attach"; chatId: ChatId; client: ChatClientInfo }
  | { type: "client.msg"; chatId: ChatId; clientId: string; msg: ChatClientMessage }
  | { type: "client.detach"; chatId: ChatId; clientId: string }
  | { type: "client.send"; chatId: ChatId; clientId: string; json: string };
