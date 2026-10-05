// The driving session on pi (§app.harness/session): the contract's HarnessSession over a pi runtime's
// AgentSession, for a hosted chat (server/chat-manager.ts). Every member looks the runtime's session up again
// at the call, and every pi method by property at the call: nothing is bound or cached, so a session the
// runtime swapped in, or a method a test replaced after open, is the one used. Events pass through pi's own
// subscribe, one pi listener per Sova listener, mapped inside it: same order, same tick.
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
  CommandOwner,
  CompactHooks,
  CompactOutcome,
  EntryId,
  HarnessCommand,
  HarnessEvent,
  HarnessModel,
  HarnessQueue,
  HarnessResources,
  HarnessSession,
  HEntry,
  ImageInput,
  InputSource,
  OwnedCommand,
  RewindHooks,
  RewindOutcome,
  SendOptions,
  SessionState,
} from "../../../shared/harness";
import { commandContextOf, ownedCommand } from "./commands";
import { compactSession, rewindSession } from "./history-ops";
import { historyOf, toHEntry } from "./reader";
import { resourcesOf } from "./resources";
import { piSessionState } from "./state";
import { watchUserMessages } from "./turns";
import { v1Frame, writtenEntryId } from "./wire";

/** Sova's input sources in pi's words (what extensions' input handlers are told). */
const PI_SOURCE = { user: "interactive", queued: "rpc", system: "extension" } as const satisfies Record<InputSource, string>;

/** SendOptions' keys in pi's prompt options. */
const PI_OPTION = { images: "images", source: "source", delivery: "streamingBehavior", expand: "expandPromptTemplates", onAccepted: "preflightResult" } as const;

/** pi's options for a send, keyed in the caller's order (pi reads them by name; the order is only what a
    recording of the call shows). */
function piOptions(o: SendOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o) as [keyof SendOptions, unknown][]) {
    const name = PI_OPTION[key];
    if (!name) continue;
    if (key === "source") out[name] = value === undefined ? undefined : PI_SOURCE[value as InputSource];
    else if (key === "onAccepted") out[name] = value === undefined ? undefined : () => (value as () => void)();
    else out[name] = value;
  }
  return out;
}

/** pi's event names, in Sova's words. */
const NAMES: Record<string, HarnessEvent["type"]> = {
  agent_start: "run.start",
  agent_end: "run.end",
  agent_settled: "run.settled",
  turn_start: "turn.start",
  turn_end: "turn.end",
  message_start: "message.start",
  message_update: "message.update",
  message_end: "message.end",
  tool_execution_start: "tool.start",
  tool_execution_update: "tool.update",
  tool_execution_end: "tool.end",
  queue_update: "queue",
  compaction_start: "compaction.start",
  compaction_end: "compaction.end",
  auto_retry_start: "retry.start",
  auto_retry_end: "retry.end",
  entry_appended: "entry.appended",
};

/** A stored message's text blocks, joined as pi stores them; a string content is itself. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** One pi event as the HarnessEvent it is (exactly one per event). */
export function harnessEventOf(event: { type: string; [k: string]: any }): HarnessEvent {
  const frame = () => v1Frame(event);
  const type = NAMES[event.type] ?? "other";
  switch (type) {
    case "message.start":
    case "message.end": {
      const message = event.message as { role?: unknown; content?: unknown } | undefined;
      const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "other";
      return { type, frame, role, ...(role === "user" ? { text: messageText(message!.content) } : {}), handle: message ?? undefined };
    }
    case "queue":
      return { type, frame, steering: event.steering, followUp: event.followUp };
    case "compaction.end":
      return { type, frame, wrote: typeof event.result === "object" && event.result !== null };
    case "entry.appended":
      return event.entry ? { type, frame, entry: toHEntry(event.entry) } : { type: "other", frame };
    default:
      return { type, frame } as HarnessEvent;
  }
}

/** P4: pi refused a send because a run was already going (the session's own check without a mid-run
    delivery, or the agent's, after another run won the race). */
export function isAlreadyProcessing(err: unknown): boolean {
  return err instanceof Error && /already processing/i.test(err.message);
}

/** A pi Model's `input` lists "image". */
const takesImages = (m: { input?: unknown }): boolean => Array.isArray(m.input) && m.input.includes("image");

/** The pi Model behind each model handle this session gave out. */
const piModels = new WeakMap<HarnessModel, unknown>();

/** pi SourceInfo.scope → rpc get_commands `location` ("temporary" = an explicit CLI or settings path). */
function sourceLocation(info: { scope: string } | undefined): string | undefined {
  if (!info) return undefined;
  return info.scope === "temporary" ? "path" : info.scope;
}

type Runtime = Pick<AgentSessionRuntime, "session" | "services">;

export class PiHarnessSession implements HarnessSession {
  constructor(private readonly runtime: Runtime) {}

  /** The runtime's session now. */
  private get s(): AgentSession {
    return this.runtime.session;
  }

  get id(): string {
    return this.s.sessionManager.getSessionId();
  }
  get cwd(): string {
    return this.s.sessionManager.getCwd();
  }
  leafId(): EntryId | null {
    return this.s.sessionManager.getLeafId() ?? null;
  }
  branch(): HEntry[] {
    return historyOf(this.s.sessionManager.getBranch());
  }
  entries(): HEntry[] {
    return historyOf(this.s.sessionManager.getEntries());
  }
  entry(id: EntryId): HEntry | undefined {
    return toHEntry(this.s.sessionManager.getEntry(id)) ?? undefined;
  }
  hasEntry(id: EntryId): boolean {
    return this.s.sessionManager.getEntry(id) !== undefined;
  }
  /** Read once pi has persisted the message: its listeners run before the write (P12). */
  persistedId(handle: unknown): EntryId | null {
    return writtenEntryId(this.s, handle) ?? null;
  }
  get state(): SessionState {
    return piSessionState(this.s.sessionManager);
  }

  isRunning(): boolean {
    return this.s.isStreaming;
  }
  isCompacting(): boolean {
    return this.s.isCompacting;
  }
  /** P5: a prompt made while agent_settled is emitted is deferred. */
  inSettleWindow(): boolean {
    return (this.s as unknown as { _isEmittingAgentSettled?: boolean })._isEmittingAgentSettled === true;
  }
  model(): HarnessModel | null {
    const m = this.s.model;
    return m ? { ref: `${m.provider}/${m.id}`, provider: m.provider, id: m.id, images: takesImages(m) } : null;
  }
  thinking(): string {
    return this.s.thinkingLevel;
  }

  /** P15: resolves at turn end; `onAccepted` is pi's preflight. P4: mid-run without `delivery`, pi refuses
      with "already processing". */
  send(text: string, o?: SendOptions): Promise<void> {
    return o ? this.s.prompt(text, piOptions(o) as Parameters<AgentSession["prompt"]>[1]) : this.s.prompt(text);
  }
  steer(text: string, images?: ImageInput[], o?: { source?: InputSource }): Promise<void> {
    return o ? this.s.steer(text, images, piOptions(o) as Parameters<AgentSession["steer"]>[2]) : this.s.steer(text, images);
  }
  /** P9: `hasQueued` is the agent's real queue, the rest the session's mirror. */
  get queue(): HarnessQueue {
    return {
      hasQueued: () => this.s.agent.hasQueuedMessages(),
      mirrorTotal: () => this.s.getSteeringMessages().length + this.s.getFollowUpMessages().length,
      mirrorFor: (kind) => (kind === "steer" ? this.s.getSteeringMessages() : this.s.getFollowUpMessages()).length,
      mirrorHas: (kind, text) => (kind === "steer" ? this.s.getSteeringMessages() : this.s.getFollowUpMessages()).includes(text),
      clear: () => this.s.clearQueue(),
      continue: () => this.s.agent.continue(),
    };
  }
  abort(): Promise<void> {
    return this.s.abort();
  }

  /** P10: navigateTree, then the marker (history-ops.ts rewindSession). */
  rewindTo(entryId: EntryId, hooks: RewindHooks): Promise<RewindOutcome> {
    return rewindSession(this.s, entryId, hooks);
  }
  /** P2/P3: pi's compact() with its write wrapped (history-ops.ts compactSession). */
  compact(instructions: string | undefined, hooks: CompactHooks): Promise<CompactOutcome> {
    return compactSession(this.s, instructions, hooks);
  }

  async findModel(ref: string): Promise<{ ok: true; model: HarnessModel } | { ok: false; error: string }> {
    const models = this.runtime.services.modelRuntime;
    const found = (await models.getAvailable()).find((m) => `${m.provider}/${m.id}` === ref);
    if (!found) {
      const known = models.getModel(ref.split("/")[0] ?? "", ref.slice(ref.indexOf("/") + 1));
      return { ok: false, error: known ? `No credentials configured for ${ref}` : `Unknown model: ${ref || "(empty ref)"}` };
    }
    const model: HarnessModel = { ref, provider: found.provider, id: found.id, images: takesImages(found) };
    piModels.set(model, found);
    return { ok: true, model };
  }
  setModel(model: HarnessModel): Promise<void> {
    const found = piModels.get(model);
    if (!found) throw new Error(`Not a model this session found: ${model.ref}`);
    return this.s.setModel(found as Parameters<AgentSession["setModel"]>[0]);
  }
  setThinking(level: string): void {
    this.s.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
  }
  activeTools(): string[] {
    return this.s.getActiveToolNames();
  }
  registeredTools(): string[] {
    return this.s.extensionRunner.getAllRegisteredTools().map((r) => r.definition.name);
  }
  /** pi's rpc get_commands enumeration (rpc-mode.js "get_commands"): extension commands, prompt templates,
      skills. */
  commands(): HarnessCommand[] {
    const s = this.s;
    const out: HarnessCommand[] = [];
    for (const c of s.extensionRunner.getRegisteredCommands()) out.push({ name: c.invocationName, description: c.description, source: "extension", path: c.sourceInfo?.path });
    for (const t of s.promptTemplates) out.push({ name: t.name, description: t.description, source: "prompt", location: sourceLocation(t.sourceInfo), path: t.filePath });
    for (const k of s.resourceLoader.getSkills().skills)
      out.push({ name: `skill:${k.name}`, description: k.description, source: "skill", location: sourceLocation(k.sourceInfo), path: k.filePath });
    return out;
  }

  /** P14: the owner's own command, found by its source path (commands.ts). */
  command(owner: CommandOwner): OwnedCommand | undefined {
    return ownedCommand(this.s.extensionRunner, owner);
  }
  commandContext(): unknown {
    return commandContextOf(this.s.extensionRunner);
  }
  resources(): HarnessResources {
    return resourcesOf(this.s.resourceLoader);
  }

  appendUserMessage(text: string, images?: readonly ImageInput[]): EntryId {
    return this.s.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() });
  }
  /** P6: the public re-read of the session's projection. */
  refreshContext(): void {
    this.s.refreshContext();
  }
  /** P16: idle, appended at once with message_start and message_end, no turn. */
  async appendNote(noteType: string, text: string): Promise<void> {
    await this.s.sendCustomMessage({ customType: noteType, content: text, display: true }, { triggerTurn: false });
  }

  onUserMessage(claim: (input: unknown) => void): () => void {
    return watchUserMessages(this.s.agent, claim);
  }

  subscribe(fn: (event: HarnessEvent) => void): () => void {
    return this.s.subscribe((event) => fn(harnessEventOf(event as { type: string })));
  }
}
