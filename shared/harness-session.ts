// The harness contract, the driving session (§app/harness, §app.harness/session). Types only: imports
// nothing but its siblings, emits nothing. What a hosted chat (server/chat-manager.ts) drives its agent
// through instead of pi's AgentSession; pi's implementation is server/harness/pi/session.ts. Sized to the
// chat's real call sites: opening a runtime, history surgery (rewind, compaction), extension commands and
// the dialog bridge are not here yet.
import type { EntryId, ModelRef } from "./harness-core";
import type { HEntry, SessionRead } from "./harness-history";
import type { SessionState } from "./harness-state";

/** Who an input is from, as the extensions' input handlers are told: a person (`user`), Sova's own queue
    or a server-started message (`queued`), or Sova acting for itself (`system`: a link, a topic batch).
    pi: `interactive`, `rpc` and `extension`. */
export type InputSource = "user" | "queued" | "system";

/** An image sent with a message, as the session stores it. */
export interface ImageInput {
  type: "image";
  data: string;
  mimeType: string;
}

/** How a message is handed to the agent. Absent keys are the harness's defaults; the keys given are passed
    on in the order the caller wrote them. */
export interface SendOptions {
  images?: ImageInput[];
  source?: InputSource;
  /** Mid-run delivery (a steer, or a follow-up after the run); idle it is ignored. */
  delivery?: "steer" | "followUp";
  /** false: the text goes verbatim, no skill or template expansion and no command dispatch (a replay, a
      link, a topic batch). */
  expand?: boolean;
  /** Called once the message is accepted (its input handlers ran, or it was swallowed or deferred);
      `send` itself resolves only when the turn ends. */
  onAccepted?: () => void;
}

/** The agent's own queues. `hasQueued` is the real queue (false is the only proof of delivery); the
    mirror totals are a change detector only (server/queue.ts SdkQueueView, which this satisfies). */
export interface HarnessQueue {
  hasQueued(): boolean;
  mirrorTotal(): number;
  mirrorFor(kind: "steer" | "followUp"): number;
  mirrorHas(kind: "steer" | "followUp", text: string): boolean;
  /** Empties both queues and returns their texts. */
  clear(): { steering: string[]; followUp: string[] };
  /** Runs what the agent already holds (steering first, then follow-ups); never called with an empty
      queue. Resolves at turn end. */
  continue(): Promise<void>;
}

/** The session's model, or a model it may switch to. */
export interface HarnessModel {
  readonly ref: ModelRef;
  readonly provider: string;
  readonly id: string;
  /** It takes images as input. */
  readonly images: boolean;
}

/** A slash command the runtime offers (an extension's, a prompt template, a skill). */
export interface HarnessCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  /** A template's or skill's scope (project, user, …), "path" for an explicit one. */
  location?: string;
  path?: string;
}

/** What a runtime loaded for its prompt, as paths: the context files, the skills, the system prompt's
    source file and the files appended to it. */
export interface HarnessResources {
  context: readonly { path: string }[];
  skills: readonly { name: string; filePath: string; description?: string }[];
  systemPrompt?: string;
  appendSystemPrompt: readonly string[];
}

/** A live event's wire-1 frame, the shape every consumer that didn't ask for wire 2 reads
    (shared/protocol.ts V1EventFrame). Made by the adapter; Sova forwards it. */
export interface HarnessFrame {
  type: "event";
  event: unknown;
  entryId?: string;
}

/** A message the agent started or ended: its role, its text blocks joined (user messages only) and the
    object the harness holds it as (identity only: `persistedId`). */
interface HarnessMessageEvent {
  role: "user" | "assistant" | "other";
  text?: string;
  handle: object | undefined;
}

/**
 * One live event of the session, in Sova's words: exactly one per harness event, delivered inside the
 * harness's own listener, in its order and tick. `frame()` makes the event's wire-1 frame (call it once).
 */
export type HarnessEvent = { frame(): HarnessFrame } & (
  | { type: "run.start" }
  | { type: "run.end" }
  /** The run is over and nothing more streams until the next start. */
  | { type: "run.settled" }
  | { type: "turn.start" }
  | { type: "turn.end" }
  | ({ type: "message.start" } & HarnessMessageEvent)
  | { type: "message.update" }
  /** Listeners run before the message's entry is written; one microtask later it is (persistedId). */
  | ({ type: "message.end" } & HarnessMessageEvent)
  | { type: "tool.start" }
  | { type: "tool.update" }
  | { type: "tool.end" }
  /** The agent's queue mirror changed: its texts now. */
  | { type: "queue"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction.start" }
  /** `wrote`: a compaction entry was written. */
  | { type: "compaction.end"; wrote: boolean }
  | { type: "retry.start" }
  | { type: "retry.end" }
  /** An entry appended outside the agent loop's own messages (an extension's state, a note). */
  | { type: "entry.appended"; entry: HEntry | null }
  /** An event Sova has no word for. */
  | { type: "other" }
);

/** Why a rewind was refused (shared/protocol.ts RewindRefusal). */
export type RewindRefusal = "streaming" | "compacting" | "busy" | "recent" | "not_on_branch" | "cancelled" | "queued" | "internal";
export type RewindOutcome = { ok: true; editorText: string } | { ok: false; reason: RewindRefusal; message: string };

/** Why a compaction was refused (shared/protocol.ts CompactRefusal). */
export type CompactRefusal = "streaming" | "compacting" | "queued" | "busy" | "recent" | "already" | "nothing" | "cancelled" | "internal";
export type CompactOutcome = { ok: true; entryId: EntryId; tokensBefore: number } | { ok: false; reason: CompactRefusal; message: string };

/** What a history operation asks its caller: the write guards, what a guard's throw means, and whether a
    message is still on its way out. */
export interface WriteGuardHooks {
  /** Runs the write guards; throws when this session may not be written now. */
  guard(): void;
  /** A throw from `guard` (or a check the caller runs) as a refusal and its message; null: not a refusal,
      a failure. */
  refusal(err: unknown): { reason: "busy" | "recent"; message: string } | null;
  /** A message is still on its way into the agent (the caller's queue, or the agent's own). */
  queued(): boolean;
}
export interface RewindHooks extends WriteGuardHooks {
  /** Just before the marker is written: flush the open-time appends. */
  beforeMarker(): void;
}
export interface CompactHooks extends WriteGuardHooks {
  /** The model policy: throws when the session's model may not be used for the summary. */
  allowed(): void;
  /** At the moment the compaction is written, after the guards ran again: flush the open-time appends. */
  beforeWrite(): void;
}

/** The extension commands Sova runs directly (never through a send, so no command text reaches the
    model), each named as the extension that owns it registers it. */
export type CommandOwner = "mode" | "claude-login" | "sandbox" | "agent-resume";

/** An extension's own command, as the session found it: run its handler with a context the session made. */
export interface OwnedCommand {
  handler(args: string, ctx: unknown): Promise<void>;
}

/** A held session, driven: its reads (SessionRead), its state, its input, its queue and its events. */
export interface HarnessSession extends SessionRead {
  readonly state: SessionState;
  /** Whether a whole entry with this id is in the session (the foreign-write guard's ownership check). */
  hasEntry(id: EntryId): boolean;
  /** The id of the leaf entry whose message is `handle` (the object a message event carried), else null:
      the entry a just-ended message was written as. */
  persistedId(handle: unknown): EntryId | null;

  // ── run state
  isRunning(): boolean;
  /** The harness's own compaction flag (a compaction Sova started is tracked by Sova too). */
  isCompacting(): boolean;
  /** Inside the run's settle event: a send now is deferred, resolving at once while its turn runs after. */
  inSettleWindow(): boolean;
  model(): HarnessModel | null;
  thinking(): string;

  // ── input
  /** Resolves when the turn ends (idle), or once queued (mid-run, with `delivery`). */
  send(text: string, o?: SendOptions): Promise<void>;
  /** Queue a steer into the running turn (a `/command` is refused by the harness: send it instead). */
  steer(text: string, images?: ImageInput[], o?: { source?: InputSource }): Promise<void>;
  readonly queue: HarnessQueue;
  /** Stop the run (and a compaction); leaves the queue alone. */
  abort(): Promise<void>;

  // ── history surgery (each reports a refusal, never throws one)
  /** Move the leaf to just before the user input `entryId` on the active branch and write a marker that
      keeps the move across a reopen; `editorText` is that input's text. Refused mid-run, mid-compaction,
      with a message on its way out, or when a guard throws; a refusal writes nothing. */
  rewindTo(entryId: EntryId, hooks: RewindHooks): Promise<RewindOutcome>;
  /** Compact the session now, behind the same refusals; the compaction is the only write, guarded and
      preceded by `beforeWrite` at the moment it happens. */
  compact(instructions: string | undefined, hooks: CompactHooks): Promise<CompactOutcome>;

  // ── config
  /** A model this session may switch to, by ref: one with configured credentials, else why not. */
  findModel(ref: ModelRef): Promise<{ ok: true; model: HarnessModel } | { ok: false; error: string }>;
  /** Switch to a model `findModel` returned (writes the switch; re-clamps thinking). */
  setModel(model: HarnessModel): Promise<void>;
  /** Set the thinking level; the harness clamps it to the model's ladder (read it back with thinking()). */
  setThinking(level: string): void;
  activeTools(): string[];
  registeredTools(): string[];
  commands(): HarnessCommand[];
  /** `owner`'s own command in this runtime, or undefined (not loaded, or a same-named command another
      extension registered). */
  command(owner: CommandOwner): OwnedCommand | undefined;
  /** A fresh context to run an extension command's handler with. */
  commandContext(): unknown;
  /** What the runtime loaded for its prompt, extension-added skill paths included. */
  resources(): HarnessResources;

  // ── writes outside a turn
  /** A user message entered with no turn; its id. Call refreshContext() after the last one. */
  appendUserMessage(text: string, images?: readonly ImageInput[]): EntryId;
  /** Re-read the agent's context from the session after writes outside a run. */
  refreshContext(): void;
  /** A note for the model, shown in the chat, that starts no turn (idle: written now). */
  appendNote(noteType: string, text: string): Promise<void>;

  // ── attribution
  /** `claim` sees the input each user-message entry point hands the agent (prompt, steer, follow-up)
      before the agent takes it; the message object it finds there is the one the message events carry.
      Claimers registered later see it first. Returns the unregister. */
  onUserMessage(claim: (input: unknown) => void): () => void;

  // ── events
  /** One harness listener per call, registered now: a synchronous pass-through, so listeners keep the
      order they were registered in, relative to the harness's own. Returns the unsubscribe. */
  subscribe(fn: (event: HarnessEvent) => void): () => void;
}
