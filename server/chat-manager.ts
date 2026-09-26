import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  getAgentDir,
  ModelRuntime,
  initTheme,
  SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { OVERSEER_DIALOG_ANSWER_ENTRY, OVERSEER_ENTRY, OVERSEER_SENT_ENTRY } from "../shared/protocol";
import type { ChatClientMessage, ChatModeResult, ChatServerMessage, CompactRefusal, ModeApplies, ModeInfo, OverseerDialogAnswerData, OverseerSentMarkerData, QueueItem, RegenerateRefusal, RewindRefusal, SandboxApplyResult, SlashCommand, WorkerInfo } from "../shared/protocol";
import { COMPACT_COMMAND, COMPACT_IMAGES_REFUSAL, compactCommand } from "../shared/compact";
import { stripImageNotes } from "../shared/image-note";
import { parseWakeNudge } from "../shared/wake";
import { type QueueImage, type QueueKind, WebQueue, type WebQueueItem } from "./queue";
import { decodeUsageTotal, decodeWorkers } from "./insights";
import { readLive, readOwnLiveRecords, workerCountsOf } from "./live";
import { appliesAfter, defaultPatchOf, mergeMode, MINOR_MODES, modeApplyPlan, modeInfo, readMode, resolveChatMode, writeMode, type ModePatch, type ModeState } from "./mode-state";
import { loadDefaults, saveDefaults } from "./web-defaults";
import { modelAllowed, modelDenial, readModelPolicy } from "./model-policy";
import { toContextInfo, workerWindowResolver } from "./models";
import { claudeSpawnModels, WorkerContextReader, withWorkerContext } from "./worker-context";
import { resumeCommandOf, resumeWorker, type ResumeOutcome } from "./worker-resume";
import { applySandbox, onSandboxAppend, sandboxCommandOf, sandboxMessage, type SandboxHost } from "./sandbox-state";
import { contextForBranch, normalizeEntries, normalizeEntry } from "./transcript";
import { isOverseerId } from "./overseer-store";
import { targetOfCwd } from "./targets";
import { claudeCodeProviderEnabled } from "./web-settings";
import { ForeignWriteGuard, markOwned, markOwnedStat, recentForeignWriteAgeSec } from "./write-guard";

const GUARD_POLL_MS = 3000;
/** Hosted workers' context fill, read off their transcripts' tails; shared, mtime-gated. */
const workerContextReader = new WorkerContextReader();

/** The experimental Settings switch, as the claude-code extension registers it
    (pi-config/extensions/claude-code/provider/index.ts CLAUDE_PROVIDER_FLAG). */
const CLAUDE_CODE_FLAG = "claude-code-provider";

/**
 * The extension flags every webapp-hosted runtime starts with.
 *
 * - `topic-outline-headless`: topic-outline only summarizes in the TUI unless its host opts in;
 *   opt in so web chats get outlines. Boolean flag: the SDK sets it true whatever the value.
 *   Workers never get it, and neither does a fanout member (`outline: false`) — N outline
 *   summarizers on one fanout is cost with no reader.
 * - `target`: a remote session (cwd = a target placeholder, server/targets.ts) switches
 *   pi-config's remote extension on for that target.
 * - `claude-code-provider`: the experimental Settings switch. When on, the claude-code extension
 *   registers the Claude Code CLI's models as first-class pi models. Read per runtime, so the
 *   switch applies to sessions created after it changed and never reaches an open one.
 */
function sessionFlags(cwd: string, outline = true): Map<string, boolean | string> {
  const flags = new Map<string, boolean | string>(outline ? [["topic-outline-headless", true]] : []);
  const target = targetOfCwd(cwd);
  if (target) flags.set("target", target);
  if (claudeCodeProviderEnabled()) flags.set(CLAUDE_CODE_FLAG, true);
  return flags;
}

/**
 * Build services for a webapp runtime.
 *
 * A flag no extension registered is NOT fatal: the SDK reports `Unknown option: --<flag>` as a
 * services diagnostic and carries on (verified against 0.86.1 with the switch on and a
 * claude-code extension that does not register it yet — the session still opened and every other
 * model still worked). That is what makes the experimental switch safe to leave on with an older
 * pi-config: the provider is simply absent, and the diagnostic below says why.
 */
async function servicesForCwd(
  cwd: string,
  modelRuntime: ModelRuntime,
  outline = true,
  resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"],
) {
  return await createAgentSessionServices({
    cwd,
    modelRuntime,
    extensionFlagValues: sessionFlags(cwd, outline),
    ...(resourceLoaderOptions ? { resourceLoaderOptions } : {}),
  });
}

/**
 * Register the Claude Code provider without waiting for the user to open a session.
 *
 * The provider registers from the claude-code extension's session_start, straight into the
 * ModelRuntime it is handed — and Sova shares one runtime across every session, so building a
 * throwaway services instance with the flag set is enough to make claude-code-cli/* appear in
 * GET /api/models for the picker. The instance is discarded; only the registration outlives it.
 *
 * Best-effort by design: the CLI may be missing or unauthenticated, and neither is a reason to
 * fail startup. A failure just means the models are absent until a session opens.
 */
export async function warmClaudeCodeProvider(modelRuntime: ModelRuntime, cwd: string): Promise<void> {
  if (!claudeCodeProviderEnabled()) return;
  try {
    const services = await servicesForCwd(cwd, modelRuntime);
    for (const d of services.diagnostics) console.warn(`[chat] claude-code warm-up ${d.type}: ${d.message}`);
    // The flag is only visible from session_start, and session_start is emitted by
    // AgentSession.bindExtensions (dist/core/agent-session.js:2029) — NOT by creating the session.
    // So the warm-up has to go all the way to bindExtensions, exactly as a real chat does, or the
    // extension factory runs and registers nothing (verified: the factory logs, session_start
    // never fires). SessionManager.create() defers writing until the first assistant reply
    // (CLAUDE.md, "Backend notes"), and this session never prompts, so no file is left behind.
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd) });
    currentTheme(); // extensions may read the theme singleton at session_start; initialize it first
    await session.bindExtensions({
      mode: "rpc",
      onError: (err) => console.warn(`[chat] claude-code warm-up extension error (${err.extensionPath}): ${err.error}`),
    });
    // The registration now lives in the shared runtime; the session itself must not outlive the
    // warm-up, or every extension's session_start side effects (timers, live records) would.
    //
    // Shut the extensions down BEFORE disposing, which is what AgentSessionRuntime.dispose does
    // (agent-session-runtime.js:296 — emitSessionShutdownEvent, then session.dispose). A bare
    // session.dispose() skips session_shutdown, and extensions that armed a timer at session_start
    // then fire it against a disposed session: the sessions extension's focus-discovery timeout
    // did exactly that, throwing "This extension ctx is stale after session replacement or reload"
    // as an unhandledRejection on every warm-up.
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
    session.dispose();
  } catch (err) {
    console.warn(`[chat] claude-code warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** pi's ThinkingLevel ladder (see server/models.ts, which mirrors the semantics). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Extensions may read ctx.ui.theme; pi's `theme` singleton isn't exported, so initialize
// it and read the global instance it registers (same key as pi's theme.js).
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function currentTheme(): Theme {
  const g = globalThis as Record<symbol, Theme | undefined>;
  if (!g[THEME_KEY]) initTheme(undefined, false);
  return g[THEME_KEY] as Theme;
}

/** A refusal to write. code per shared/protocol.ts: busy = TUI owns it (force never helps),
 *  recent = unknown writer (reconnect with &force=1), reloaded = another client reloaded the runtime. */
export class BusyError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "recent" | "reloaded" = "busy",
  ) {
    super(message);
  }
}

/** A mode switch refused because this chat has one fixed mode: the Overseer is always in normal mode
 *  (server/overseer.ts keepNormal). POST /api/mode answers it with a 409. */
export class ModeRefusedError extends Error {
  constructor() {
    super("The Overseer is always in normal mode.");
  }
}

/**
 * A session that cannot be opened until something outside this server changes — today, a stored
 * `cwd` that no longer exists (the SDK refuses to build a runtime for it). Unlike BusyError this
 * is not worth retrying: reconnecting re-runs the same failure and appends another error to the
 * client's thread, which is how one reaped directory produced dozens of identical banners.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    /** The missing directory, re-checked to decide when the condition has cleared. */
    readonly cwd: string,
  ) {
    super(message);
  }
}

/**
 * Paths whose last open failed permanently, so repeat connects fail fast instead of re-running
 * the SDK open. Keyed by session path; dropped as soon as the cwd exists again, so recreating the
 * directory recovers without restarting the server.
 */
const configFailures = new Map<string, ConfigError>();

/**
 * Where an open must happen: the stored cwd, which must exist. Throws the ConfigError with the
 * stored cwd, the name the user knows; the banner's restore advice is about it.
 */
export function resolveOpenCwd(path: string, sessionCwd: string): string {
  if (!existsSync(sessionCwd)) throw new ConfigError(`Stored session working directory does not exist: ${sessionCwd}\nSession file: ${path}`, sessionCwd);
  return sessionCwd;
}

/** The cached permanent failure for `path`, if it still applies. Exported because it is the whole
 * retry policy for permanent errors: acquireChat answers from it, and it is how a caller (or a
 * test) asks whether the condition has cleared.
 */
export function activeConfigFailure(path: string): ConfigError | undefined {
  const failure = configFailures.get(path);
  if (!failure) return undefined;
  if (existsSync(failure.cwd)) {
    configFailures.delete(path); // the directory came back: let the next open try for real
    return undefined;
  }
  return failure;
}

/**
 * The session's stored cwd, read straight from the JSONL header, so a missing directory can be
 * detected before doing any of the expensive open work (model runtime, extensions, SDK session).
 * Unreadable or headerless files return null and are left to the normal open path to report.
 */
function storedCwd(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8192);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(firstLine);
    return header?.type === "session" && typeof header.cwd === "string" && header.cwd ? header.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** The SDK throws MissingSessionCwdError; match by name so we don't depend on its class identity. */
function asConfigError(err: unknown, cwd: string): ConfigError | null {
  if (err instanceof ConfigError) return err;
  if (err instanceof Error && err.name === "MissingSessionCwdError") return new ConfigError(err.message, cwd);
  return null;
}

/** Minimal client interface so ws.ts owns the socket details. */
export interface ChatClient {
  send(msg: ChatServerMessage): void;
}

let modelRuntimePromise: Promise<ModelRuntime> | null = null;
export function getModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= ModelRuntime.create().catch((err) => {
    modelRuntimePromise = null;
    throw err;
  });
  return modelRuntimePromise;
}

/** Throws BusyError if another process (TUI/CLI) currently owns the session file. */
export function assertNotLive(path: string): void {
  const rec = readLive().get(path);
  if (rec) {
    throw new BusyError(
      `Session is open in another pi process (pid ${rec.pid}, ${rec.mode ?? "tui"}); it is read-only here. Use watch instead.`,
    );
  }
}

/** Strip the per-delta `partial` snapshot (same as pi's rpc toJsonEvent) to keep frames small. */
function toWireEvent(event: any): unknown {
  if (event?.type !== "message_update") return event;
  const ame = event.assistantMessageEvent ?? {};
  let wire = ame;
  if ("partial" in ame) {
    const { partial, ...rest } = ame;
    wire = rest;
    if (ame.type === "toolcall_start") {
      const tc = partial?.content?.[ame.contentIndex];
      if (tc?.type === "toolCall") wire = { ...rest, id: tc.id, toolName: tc.name };
    }
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: wire };
}

type SdkImage = NonNullable<Parameters<AgentSession["steer"]>[1]>[number];

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_RE = /^image\/[\w.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate client OutboundImage[] and convert to pi's ImageContent {type:"image", data, mimeType}
 * (the stored/SDK shape in 0.86.0, pi-ai types.d.ts:256; docs' `source:{type:"base64"}` wrapper is
 * not what the types take).
 */
function parseImages(raw: unknown): SdkImage[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("images must be an array of {data, mimeType}");
  let total = 0;
  const out: SdkImage[] = [];
  raw.forEach((img, i) => {
    const data = img?.data;
    const mimeType = img?.mimeType;
    if (typeof data !== "string" || !data || typeof mimeType !== "string" || !MIME_RE.test(mimeType)) {
      throw new Error(`images[${i}] must be {data: base64 string, mimeType: "image/…"}`);
    }
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      throw new Error(`images[${i}].data is not valid base64 (send it without the data: prefix)`);
    }
    total += (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (total > MAX_IMAGE_BYTES) throw new Error("images exceed the 20MB total limit");
    out.push({ type: "image", data, mimeType });
  });
  return out.length ? out : undefined;
}

/**
 * Stop: drain the queued steers/follow-ups, then abort — the TUI's Esc order
 * (restoreQueuedMessagesToEditor). abort() leaves the queue intact, so the next prompt would
 * send itself first and the stale steer right behind it. Nothing is written to the session file.
 */
export async function drainQueueThenAbort(
  session: Pick<AgentSession, "clearQueue" | "abort">,
  broadcast: (msg: ChatServerMessage) => void,
  /** Sova's own queue, when the chat has one: it drains BOTH its held items and the SDK's (it
      calls `clearQueue()` itself), so Stop keeps meaning "nothing queued survives this". Absent
      leaves the original SDK-only behaviour, which is what a bare session still gets. */
  queue?: { drain(): Promise<{ steering: string[]; followUp: string[] }> },
): Promise<void> {
  // Awaited: the queue's own drain waits out a hand-off parked in an extension `input` handler,
  // so Stop cannot clear "nothing", hand back no text, and then let that message be delivered
  // after the user pressed Stop.
  const { steering, followUp } = queue ? await queue.drain() : session.clearQueue();
  if (steering.length || followUp.length) broadcast({ type: "queue_cleared", steering, followUp });
  return session.abort();
}

/**
 * customType of the invisible entry a rewind appends. navigateTree({summarize:false}) only moves
 * the SessionManager's in-memory leaf, and on reopen the SDK takes the file's LAST entry as the
 * leaf, so without a write a reload or server restart would silently put the abandoned turns back.
 * A `custom` entry parented on the new leaf pins it: it is extension state, never LLM context
 * (buildSessionContext skips `custom`), our transcript renders nothing for it (normalizeEntry's
 * default for custom types), and it carries no usage, so neither totals nor context fill move.
 */
export const REWIND_ENTRY = "sova-rewind";

/**
 * customType of the invisible entry fanout writes into every member at creation (server/fanout.ts,
 * beside the member's model change). It is how a LATER runtime — this server after a restart, or
 * the workspace opened cold — knows to open the session WITHOUT `topic-outline-headless`: the
 * outline summarizer is a second model call per turn, and N of them on a fanout is cost with no
 * reader. The marker travels with the file,
 * so the exception holds for the member's life across restarts, rather than being an in-memory
 * flag threaded through acquireChat that a restart would forget. Same shape as REWIND_ENTRY:
 * never LLM context, no usage, rendered nowhere (normalizeEntry's default for custom types).
 */
export const FANOUT_MEMBER_ENTRY = "sova-fanout-member";

/** Whether a session file is a fanout member, by the marker its creation wrote. The predicate
 *  openSession keys the outline exception on; exported for the test that pins the marker's
 *  round trip through the file. */
export function isFanoutMember(sm: Pick<SessionManager, "getEntries">): boolean {
  return sm.getEntries().some((e) => e.type === "custom" && e.customType === FANOUT_MEMBER_ENTRY);
}

/** Whether a session file is an Overseer file: it carries the marker its creation wrote
 *  (server/overseer.ts) AND overseer-state.json knows it (the current conversation or one in its
 *  history). A fork of an Overseer file inherits the marker but is known to neither, so it opens
 *  as an ordinary session, as SessionSummary.overseer lists it. */
export function isOverseerFile(sm: Pick<SessionManager, "getEntries" | "getSessionId">): boolean {
  return isOverseerId(sm.getSessionId()) && sm.getEntries().some((e) => e.type === "custom" && e.customType === OVERSEER_ENTRY);
}

/**
 * What an Overseer runtime gets instead of the ordinary loadout (server/overseer.ts registers it,
 * so this module never imports the Overseer and the dependency points one way). `loadout` throws a
 * BusyError for an Overseer file that is not the current one: previous conversations are read-only.
 */
export interface OverseerRuntime {
  loadout(path: string): Promise<{
    resourceLoaderOptions: NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;
    /** The tool allowlist: built-in, extension and inline tools alike. */
    tools: string[];
    /** SDK custom tools: they replace a built-in or an extension's tool of the same name (the
        Overseer's secret-guarded read/grep/find/ls). */
    customTools?: ToolDefinition[];
    /** From overseer.json, never defaults.json. */
    model: string | null;
    thinking: string | null;
  }>;
  /** The composer changed the Overseer's model or thinking: write it back to overseer.json. */
  saveChoice(patch: { model?: string; thinking?: string }): void;
  /** Every open of an Overseer runtime, once bound: brings its mode back to normal with no minor
      modes, whatever its branch restored. */
  opened(chat: ChatSession): Promise<void>;
  /** Called with every AgentSession the Overseer's runtime builds, so `userSend` can recognise the
      message it produced when that message reaches the Agent, and every run is decided from the
      session's own event stream. */
  watchSession(session: AgentSession): void;
  /** Runs the SDK call that hands the Overseer a message the user sent from the UI (a prompt, a
      steer, a regenerate; `origin` "client"). The turn the resulting message opens is the user's,
      whatever an extension's `input` handler or a template made of its text: full tools, and the
      per-turn caps start over. Server-started runs (a brief, a wake-up) never go through it. */
  userSend<T>(send: () => T): T;
}

let overseerRuntime: OverseerRuntime | null = null;
export function setOverseerRuntime(r: OverseerRuntime): void {
  overseerRuntime = r;
}

export type RewindOutcome = { ok: true; editorText: string } | { ok: false; reason: RewindRefusal; message: string };

/** The members of AgentSession a rewind uses (narrow so tests can drive it with a fake). */
export interface RewindTarget {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionManager: Pick<SessionManager, "getBranch" | "getLeafId" | "appendCustomEntry">;
  navigateTree(targetId: string, options: { summarize: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
}

/**
 * Rewind to just before the user input `entryId` on the active branch: navigateTree moves the leaf
 * to that message's parent (root when it is the first input) and returns its text, then the marker
 * above makes the move durable. `guard` runs the write guards (throws BusyError); `beforeMarker`
 * flushes the open-time appends. Those are flushed AFTER navigating, not before: flushed first,
 * they would land on the branch being abandoned and the new branch would lose its model/thinking
 * entries. A refusal writes nothing.
 */
export async function rewindSession(
  session: RewindTarget,
  entryId: string,
  hooks: { guard(): void; beforeMarker(): void; queued(): boolean },
): Promise<RewindOutcome> {
  const check = (): RewindOutcome | null => {
    try {
      hooks.guard();
    } catch (err) {
      if (!(err instanceof BusyError)) throw err;
      return { ok: false, reason: err.code === "busy" ? "busy" : "recent", message: err.message };
    }
    if (session.isStreaming) return { ok: false, reason: "streaming", message: "Stop the turn first, then rewind." };
    if (session.isCompacting)
      return { ok: false, reason: "compacting", message: "Wait for the compaction or rewind in progress to finish, then rewind." };
    // NOT covered by the isStreaming check above, and this is the point of having it separately:
    // `steer()` awaits the extension `input` handlers before it queues anything, so a message can
    // still be on its way out after the turn it was meant to interrupt has ended. Moving the leaf
    // now would deliver it into the NEW branch on the next run — the abandoned message reappearing
    // on the branch the user rewound TO. `hooks.queued` answers for Sova's own queue AND the
    // SDK's, ours or an extension's: all three land the same way.
    if (hooks.queued())
      return { ok: false, reason: "queued", message: "A message is still on its way out. Wait for it to send, or press Stop, then rewind." };
    return null;
  };
  try {
    const refused = check();
    if (refused) return refused;
    const sm = session.sessionManager;
    const target = sm.getBranch().find((e) => e.id === entryId);
    if (target?.type !== "message" || target.message.role !== "user")
      return { ok: false, reason: "not_on_branch", message: "That input is not on this chat's current branch anymore." };
    const fromLeafId = sm.getLeafId();
    const result = await session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) return { ok: false, reason: "cancelled", message: "An extension cancelled the rewind." };
    // navigateTree awaits extension handlers; a TUI or foreign writer that appeared meanwhile
    // still gets no write. The in-memory leaf has moved, but that runtime is write-refused from
    // here on and a force reconnect reloads it from disk.
    const late = check();
    if (late) return late;
    hooks.beforeMarker();
    sm.appendCustomEntry(REWIND_ENTRY, { targetId: entryId, fromLeafId });
    // Without pi 0.87's image resize notes: the composer gets the text as typed, not the model's copy.
    return { ok: true, editorText: stripImageNotes(result.editorText ?? "", target.message.content) };
  } catch (err) {
    return { ok: false, reason: "internal", message: err instanceof Error ? err.message : String(err) };
  }
}

export type CompactOutcome = { ok: true; entryId: string; tokensBefore: number } | { ok: false; reason: CompactRefusal; message: string };

/** The members of AgentSession a compaction uses (narrow so tests can drive it with a fake). */
export interface CompactTarget {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionManager: Pick<SessionManager, "getBranch" | "appendCompaction">;
  compact(customInstructions?: string): Promise<{ tokensBefore: number }>;
}

/**
 * Compact the chat now: pi's own `AgentSession.compact(instructions)`, behind the same refusals a
 * rewind has, because pi's compact() would otherwise do two things silently. It calls `abort()`
 * first (agent-session.js compact()), so a compaction started while a turn streams KILLS the turn;
 * and a message still on its way out would land after a summary that never saw it.
 *
 * `guard` runs the write guards (throws BusyError) and `allowed` the model policy (the summary is
 * a model call on the session's own model). The ONE write is pi's `appendCompaction`, and it is
 * wrapped for the call's duration: the write guards run again there — a summary can take minutes,
 * and a TUI that grabbed the file meanwhile must get no write — then `beforeWrite` flushes the
 * open-time appends, so they precede the compaction entry exactly as they precede a prompt. Any
 * refusal or failure therefore writes nothing at all, deferred appends included.
 */
export async function compactSession(
  session: CompactTarget,
  instructions: string | undefined,
  hooks: { guard(): void; allowed(): void; queued(): boolean; beforeWrite(): void },
): Promise<CompactOutcome> {
  const refused = (reason: CompactRefusal, message: string): CompactOutcome => ({ ok: false, reason, message });
  const fromError = (err: unknown): CompactOutcome => {
    if (err instanceof BusyError) return refused(err.code === "busy" ? "busy" : "recent", err.message);
    const message = err instanceof Error ? err.message : String(err);
    // pi's own refusals and its cancel, by the exact text agent-session.js compact() throws.
    if (message === "Already compacted") return refused("already", "Already compacted.");
    if (message.startsWith("Nothing to compact")) return refused("nothing", "Nothing to compact yet.");
    if (message === "Compaction cancelled") return refused("cancelled", "Compaction cancelled.");
    return refused("internal", `Compaction failed: ${message}`);
  };
  try {
    hooks.guard();
    hooks.allowed();
  } catch (err) {
    return fromError(err);
  }
  if (session.isStreaming) return refused("streaming", "Stop the turn first, then compact.");
  if (session.isCompacting) return refused("compacting", "A compaction is already running.");
  // The same window rewindSession's "queued" names: a steer can still be inside the extension
  // `input` handlers after its turn ended.
  if (hooks.queued())
    return refused("queued", "Wait for the queued messages to send, then compact.");
  // pi refuses this too, but only after announcing a compaction_start; saying it here keeps every
  // client's pane from flickering "Compacting" for a no-op.
  if (session.sessionManager.getBranch().at(-1)?.type === "compaction") return fromError(new Error("Already compacted"));
  const sm = session.sessionManager;
  const append = sm.appendCompaction;
  let entryId: string | null = null;
  sm.appendCompaction = (...args: Parameters<typeof append>) => {
    hooks.guard();
    hooks.beforeWrite();
    entryId = append.apply(sm, args);
    return entryId;
  };
  try {
    const result = await session.compact(instructions);
    if (!entryId) return refused("internal", "Compaction failed: pi reported success but wrote no compaction entry.");
    return { ok: true, entryId, tokensBefore: result.tokensBefore };
  } catch (err) {
    return fromError(err);
  } finally {
    sm.appendCompaction = append;
  }
}

/** A session entry as the branch hands it over; only the fields the rules below read are named. */
interface BranchEntry {
  id?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** What a regenerate resolved to: the user input to replay, exactly as the file stores it. */
export type RegenerateTarget =
  | { ok: true; userId: string; text: string; images?: QueueImage[] }
  | { ok: false; reason: RegenerateRefusal; message: string };

/**
 * The user message whose turn `entryId` belongs to, on the ACTIVE branch, plus its stored content.
 *
 * Pure, so the whole rule is testable without an SDK. Three things it settles:
 *
 * - Block ids. The transcript emits one row per assistant content block, `<entryId>:<n>` (and
 *   `<entryId>:stop`), so the id a client rendered is usually not an entry id. An id that is not
 *   on the branch is retried once with everything after its first ":" removed. Entry ids are
 *   uuids and carry no colon, so this can only ever rescue a block id.
 * - Direction. It walks BACKWARD to the nearest `role:"user"` message, so regenerating from any
 *   row of a turn — the reply, a tool call, the "Aborted" line — redoes the same turn.
 * - What gets replayed: the entry's OWN stored text and its OWN stored `ImageContent` blocks, not
 *   the display text. `TranscriptItem.text` has pi's clipboard paths stripped for rendering; the
 *   model was given them, so a replay that used the display text would send a different message.
 */
export function resolveRegenerate(branch: readonly BranchEntry[], entryId: string): RegenerateTarget {
  const notOnBranch = (message: string): RegenerateTarget => ({ ok: false, reason: "not_on_branch", message });
  let index = branch.findIndex((e) => e.id === entryId);
  if (index === -1 && entryId.includes(":")) {
    const stem = entryId.slice(0, entryId.indexOf(":"));
    index = branch.findIndex((e) => e.id === stem);
  }
  if (index === -1) return notOnBranch("That reply is not on this chat's current branch anymore.");
  const isUser = (e: BranchEntry) => e.type === "message" && e.message?.role === "user";
  // Regenerating your own message is Rewind — it hands the text back so you can change it. Saying
  // so here keeps the two gestures from quietly becoming one that resends without asking.
  if (isUser(branch[index]!)) return notOnBranch("That is your own message; rewind to it to edit and send it again.");
  for (let i = index; i >= 0; i--) {
    const entry = branch[i]!;
    if (!isUser(entry)) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : textBlocks(content);
    const images = imageBlocks(content);
    if (!text.trim() && !images) return notOnBranch("The message that started that turn has nothing left to send.");
    // A WAKE NUDGE is a role:"user" message Sova's own scheduler wrote, rendered as its own card
    // (kind "wake"). Replaying it would put the "[wake_nudge …] Scheduled wakeup fired (set 4m17s
    // ago)" preamble back on the branch as if the user had typed it, with an elapsed time that is
    // now a lie. Nothing here is the user's message, so there is nothing to send again.
    if (parseWakeNudge(text))
      return { ok: false, reason: "wake", message: "That reply answered a scheduled wake-up, not a message you sent, so there is nothing to send again." };
    return { ok: true, userId: String(entry.id), text, ...(images ? { images } : {}) };
  }
  return notOnBranch("Nothing on this branch started that reply, so there is nothing to run again.");
}

/** Text blocks of a stored message, joined as pi stores them. */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Stored ImageContent blocks, in order, or undefined when there are none. */
function imageBlocks(content: unknown): QueueImage[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: QueueImage[] = [];
  for (const b of content) {
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      out.push({ type: "image", data: b.data, mimeType: b.mimeType });
    }
  }
  return out.length ? out : undefined;
}

/** pi SourceInfo.scope → rpc get_commands `location` ("temporary" = explicit CLI/settings path). */
function sourceLocation(info: { scope: string } | undefined): string | undefined {
  if (!info) return undefined;
  return info.scope === "temporary" ? "path" : info.scope;
}

/** Same enumeration as pi's rpc get_commands (rpc-mode.js "get_commands"), per runtime/cwd. */
function listCommands(session: AgentSession): SlashCommand[] {
  // Sova's own `compact` leads; an extension command of that name could never run from here,
  // because the text is intercepted before pi sees it (ChatSession.handle), so it is not offered.
  const out: SlashCommand[] = [COMPACT_COMMAND];
  for (const c of session.extensionRunner.getRegisteredCommands()) {
    if (c.invocationName === COMPACT_COMMAND.name) continue;
    out.push({ name: c.invocationName, description: c.description, source: "extension", path: c.sourceInfo?.path });
  }
  for (const t of session.promptTemplates) {
    out.push({ name: t.name, description: t.description, source: "prompt", location: sourceLocation(t.sourceInfo), path: t.filePath });
  }
  for (const s of session.resourceLoader.getSkills().skills) {
    out.push({ name: `skill:${s.name}`, description: s.description, source: "skill", location: sourceLocation(s.sourceInfo), path: s.filePath });
  }
  return out;
}

function modelLabel(session: AgentSession): string | null {
  const m = session.model;
  return m ? `${m.provider}/${m.id}` : null;
}

interface PendingUi {
  resolve: (value: unknown) => void;
  /** The ui_request as broadcast (method, title, options…), for the Overseer's view of it. */
  request: Record<string, unknown>;
  since: number;
}

/** One live-pending extension dialog of a hosted chat, as the Overseer sees it. */
export interface PendingDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  since: number;
}

/** pi's prompt() refusal while a manual compaction runs (agent-session.js prompt(), 0.87.1). */
export function isCompactionInProgress(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Cannot submit a prompt while compaction is in progress");
}

/** SDK events after which Sova's queue re-reads the SDK's own queue lengths. `agent_settled` and
    `agent_end` are here because a turn that ends with our queue non-empty must start the next one;
    without them the queue would wait for an event that never comes. `compaction_end` likewise
    releases what the queue held while a compaction ran (its `paused`). */
const QUEUE_WAKE_EVENTS = new Set(["queue_update", "message_start", "turn_end", "agent_settled", "agent_end", "compaction_end"]);

/** A message the Overseer sent whose user entry still needs its `sova-overseer-sent` marker.
    `itemId`: it rode in on a queue item; `held` while that item has not departed, so the settle
    sweep leaves the mark alone (its message may still be in the SDK's queue). */
type OverseerMark = { text: string; overseerId?: string; itemId?: string; held?: boolean };

/** One embedded pi runtime for one session file, shared by all connected chat clients. */
class ChatSession {
  readonly clients = new Set<ChatClient>();
  private unsubscribe: (() => void) | null = null;
  private pendingUi = new Map<string, PendingUi>();
  private guard: ForeignWriteGuard | null = null;
  private guardTimer: NodeJS.Timeout | null = null;
  private workersTimer: NodeJS.Timeout | null = null;
  /** Wire-serialized last workers broadcast, so polls only send on change. */
  private lastWorkersJson: string | null = null;
  /** Set once another process is seen writing this file; all writes are refused after that. */
  foreignWrite: string | null = null;
  /** Open-time SDK bookkeeping appends, written right before the first prompt/steer/compaction. */
  deferredAppends: Array<() => void> = [];
  /**
   * Set synchronously for the whole of a /compact this chat runs. pi's own `isCompacting` turns
   * true only after compact() has awaited `abort()`, so without this a second /compact, or a
   * prompt, arriving in that gap would pass every check.
   */
  private compactRunning = false;
  /** A compaction that was not our /compact landed while a turn ran; its refresh waits for the
      turn's agent_settled (onCompactionEvent). */
  private refreshAtSettle = false;
  disposed = false;
  /** This runtime is the Overseer's (set by openSession from the file's marker). */
  overseer = false;
  /** Texts the Overseer sent here whose user entry still needs its `sova-overseer-sent` marker. */
  private overseerSends: OverseerMark[] = [];
  /** How the last switch of THIS chat applies (ModeApplies); set at bind and by applyMode. */
  modeApplies: ModeApplies = "now";
  /**
   * This chat's own mode — never another chat's, and never simply the file. bind() resolves it
   * from this session's branch (resolveChatMode), and applyMode replaces it. The file default
   * here is only a placeholder until bind() runs.
   */
  modeState: ModeState = readMode();

  /**
   * Sova's own outgoing queue (server/queue.ts). Every message that would have gone straight
   * into the SDK's queue goes here first, and exactly one of ours is inside the SDK at a time —
   * which is what makes a single queued message removable at all (the SDK can only clear the lot).
   * A message sent to an IDLE session never enters it: there is nothing to queue behind.
   */
  readonly queue: WebQueue = new WebQueue({
    sdk: {
      // The REAL queues, through public API: `AgentSession.agent` is public
      // (agent-session.d.ts:196) and so is `hasQueuedMessages()` (pi-agent-core agent.d.ts:96).
      // Nothing private is read, and nothing is mutated — `Agent.steeringQueue.messages.length`
      // would answer per kind, but it is private in the types and reading it is the reach-in this
      // design was chosen to avoid.
      //
      // Delivery is read from THESE, not from getSteeringMessages(): that mirror is spliced on
      // `message_start`, which is later than the loop's drain, and the splice is skipped entirely
      // for empty text — so an image-only send never leaves it and a mirror-watching queue stalls
      // for the session's life. server/queue.ts's header has the full account.
      hasQueued: () => this.session.agent.hasQueuedMessages(),
      // The mirror, read ONLY as a change detector against our own earlier reading of it
      // (server/queue.ts sdkHolds). `peekQueuedMessages()` would answer more precisely; it arrived
      // with the 0.87.1 pin and is deliberately not used yet (server/queue.ts's header).
      mirrorTotal: () => this.session.getSteeringMessages().length + this.session.getFollowUpMessages().length,
      mirrorFor: (kind) => (kind === "steer" ? this.session.getSteeringMessages() : this.session.getFollowUpMessages()).length,
      // Same public pair; a read of the live array's current contents, never a copy anyone mutates.
      mirrorHas: (kind, text) => (kind === "steer" ? this.session.getSteeringMessages() : this.session.getFollowUpMessages()).includes(text),
    },
    streaming: () => this.session.isStreaming,
    paused: () => this.isCompacting(),
    clearSdkQueue: () => this.session.clearQueue(),
    guard: () => {
      assertNotLive(this.path);
      this.assertNoForeignWrites();
    },
    wake: () => this.wakeQueuedRun(),
    handOff: (item, streaming) => this.handOffQueued(item, streaming),
    // Broadcast, never addressed: a second tab on this chat has the same pending rows and must
    // learn why one left, including a removal it did not make. The text rides along for every
    // reason but "delivered", so whichever client wants to offer it back to a composer can.
    onGone: (item, reason) => {
      this.settleOverseerMark(item.id, reason === "delivered");
      this.broadcast({ type: "queue_item_gone", itemId: item.id, reason, ...(reason === "delivered" ? {} : { text: item.text }) });
    },
    onChange: (items) => this.broadcast({ type: "queue", items }),
    onHandOffError: (item, err) => {
      const code = err instanceof BusyError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      // Named to its sender when it had one, so the right composer gets its draft back.
      //
      // NO SYNTHETIC `queue_cleared` HERE. This used to send one "because that is the message the
      // client already restores from", which predates `queue_item_gone` — and with both in flight
      // the client restored the same text TWICE, prepending it into the draft twice with a blank
      // line between. `queue_item_gone{reason:"failed"}` is now the single departure signal, which
      // also makes "failed" and "dropped" symmetric, and leaves `queue_cleared` meaning Stop and
      // nothing else.
      this.broadcast({ type: "error", code, message, ...(item.origin === "client" ? { clientId: item.id } : {}) });
    },
  });

  constructor(
    readonly path: string,
    readonly runtime: AgentSessionRuntime,
    private readonly onDisposed: () => void,
  ) {}

  get session(): AgentSession {
    return this.runtime.session;
  }

  /** Throws BusyError if a foreign writer was detected (now or earlier). */
  assertNoForeignWrites(): void {
    if (!this.foreignWrite && this.guard) {
      let reason: string | null;
      try {
        reason = this.guard.check();
      } catch (err) {
        reason = `session file unreadable: ${err instanceof Error ? err.message : err}`;
      }
      if (reason) {
        this.foreignWrite = reason;
        this.broadcast({ type: "error", code: "recent", message: this.busyMessage() });
      } else this.persistVerified();
    }
    if (this.foreignWrite) throw new BusyError(this.busyMessage(), "recent");
  }

  /** The file as the guard last verified it is ours: record it, so a restarted server knows. */
  private persistVerified(): void {
    const v = this.guard?.verified();
    if (v) markOwnedStat(this.path, v);
  }

  /** A silent guard check: records our writes when every appended line is ours; a foreign line
      marks the chat foreign (reported to the next client, as before) and records nothing. */
  private recordOwnWrites(): void {
    if (this.foreignWrite || !this.guard) return;
    let reason: string | null;
    try {
      reason = this.guard.check();
    } catch (err) {
      reason = `session file unreadable: ${err instanceof Error ? err.message : err}`;
    }
    if (reason) this.foreignWrite = reason;
    else this.persistVerified();
  }

  /**
   * Give ONE queued message to the SDK. The queue calls this and nothing else does.
   *
   * It resolves when the message has been ACCEPTED, never when its turn ends. That distinction is
   * the whole reason the idle branch is not awaited: `AgentSession.prompt()` on an idle session
   * runs the entire agent loop before resolving (agent-session.js:937), so awaiting it would stall
   * the queue for the length of the run and the next item would only be handed over minutes later.
   *
   * The guards run HERE, at the moment of the write, not at enqueue time: a TUI can grab the file,
   * or the user can turn a model off, while messages sit in the queue.
   */
  private async handOffQueued(item: WebQueueItem, streaming: boolean): Promise<void> {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    this.assertModelAllowed();
    this.flushDeferredAppends();
    const images = item.images as Parameters<AgentSession["steer"]>[1];
    const toSdk = <T>(send: () => T) => this.toSdk(item.origin, send);
    // The Overseer's mark goes in with the message, never earlier: a held item is not in the SDK,
    // so a message the user types meanwhile with the same text must not take its mark. It stays
    // until the message ends (markOverseerSend) or the item departs undelivered (onGone).
    const mark = item.overseer ? { text: item.text, overseerId: item.overseer.overseerId, itemId: item.id, held: true } : null;
    if (mark) this.overseerSends.push(mark);
    if (!streaming) {
      // Idle: this starts a turn. Its own failure belongs in this session's pane, like every other
      // turn nobody is awaiting, and must not be reported as a hand-off failure (which would hand
      // the text back to the composer for a message that HAS been sent).
      toSdk(() => this.session.prompt(item.text, { images })).catch((err) => {
        if (mark) this.dropOverseerMark(mark);
        if (this.heldForCompaction(err, { ...item, id: undefined })) return;
        this.reportTurnFailure(err);
        // A turn that never started emits no event, so nothing would wake the queue and every
        // item behind this one would sit there for ever. Wake it explicitly.
        this.queue.onSdkEvent();
      });
      return;
    }
    // steer() throws on extension commands; prompt() runs them immediately (even mid-stream) and
    // otherwise queues with the same skill/template expansion. Same split as the direct path.
    if (item.kind === "steer" && !item.text.startsWith("/")) {
      await toSdk(() => this.session.steer(item.text, images));
      return;
    }
    await toSdk(() => this.session.prompt(item.text, { images, streamingBehavior: item.kind })).catch((err) => {
      if (!this.heldForCompaction(err, { ...item, id: undefined })) throw err;
    });
  }

  /** Hand a message to the SDK. In the Overseer, one the user sent from the UI (`origin` "client")
      goes through its `userSend`, so the turn it opens is known as theirs by identity, not text. */
  private toSdk<T>(origin: QueueItem["origin"], send: () => T): T {
    return this.overseer && origin === "client" && overseerRuntime ? overseerRuntime.userSend(send) : send();
  }

  /**
   * pi refused a prompt because a compaction had started: put the message back in Sova's queue,
   * which holds it until compaction_end, instead of failing it. `isCompacting()` holds every send
   * that arrives once a compaction is under way; this is the gap before that — pi's compact()
   * awaits `abort()` before it sets the flag, and a `/`-prefixed prompt awaits the extension
   * command lookup before pi checks it. A queue item comes back as a NEW item (no `id`): the old
   * one has departed and the client has settled that id; it rejoins at the back. A direct send
   * keeps its sender's id, which no queue item ever had. Returns false for any other error.
   */
  private heldForCompaction(
    err: unknown,
    item: { kind: WebQueueItem["kind"]; text: string; images?: QueueImage[]; origin: QueueItem["origin"]; id?: string; overseer?: WebQueueItem["overseer"] },
  ): boolean {
    if (!isCompactionInProgress(err) || this.disposed) return false;
    this.queue.enqueue({ kind: item.kind, text: item.text, images: item.images, origin: item.origin, ...(item.id ? { id: item.id } : {}), ...(item.overseer ? { overseer: item.overseer } : {}) });
    return true;
  }

  /** A queue item left: delivered, its mark waits for its message like any other (the settle
      sweep may take it from now on); gone any other way, its message never enters, so neither
      does the mark. */
  private settleOverseerMark(itemId: string, delivered: boolean): void {
    const mark = this.overseerSends.find((s) => s.itemId === itemId);
    if (!mark) return;
    if (delivered) mark.held = false;
    else this.dropOverseerMark(mark);
  }

  private dropOverseerMark(mark: OverseerMark): void {
    const i = this.overseerSends.indexOf(mark);
    if (i >= 0) this.overseerSends.splice(i, 1);
  }

  /**
   * Whether ANY message is still on its way out: held in Sova's queue, mid-hand-off, or sitting
   * in the SDK's own queues (including an extension's follow-up, which resurrects on a rewound
   * branch exactly as ours would).
   *
   * `hasQueuedMessages()` is the REAL queue, deliberately, not `pendingMessageCount`: that is the
   * mirror sum, and the mirror keeps empty-text entries for ever — so one image-only send would
   * make every later rewind refuse for the life of the session.
   */
  hasPendingSends(): boolean {
    return this.queue.size > 0 || this.session.agent.hasQueuedMessages();
  }

  /**
   * Run what the SDK is ALREADY holding, adding nothing of our own.
   *
   * `Agent.continue()` is public (pi-agent-core agent.d.ts:113) and does exactly this: with the
   * last message an assistant one it DRAINS the steering queue (else the follow-up queue) and runs
   * those messages, passing `skipInitialSteeringPoll` so it cannot double-drain (agent.js:252-262).
   * That ordering is the whole reason it is used instead of handing our own next message over: a
   * plain `prompt()` would start the run with OUR message and only poll the steering queue after
   * the first assistant turn, delivering the message that was queued FIRST second.
   *
   * Nothing is deleted and nothing is declared delivered — the messages are DELIVERED, which is
   * what they were queued for, and the ordinary `message_start` bookkeeping follows.
   *
   * Not awaited: `continue()` resolves at turn end. Guarded on `hasQueuedMessages()` so it is never
   * called with an empty queue, where it would either continue the transcript on its own or throw.
   */
  /** Set while a wake's run is being started, so events arriving mid-wake cannot stack another. */
  private waking = false;

  private wakeQueuedRun(): void {
    if (this.disposed || this.session.isStreaming || this.isCompacting()) return;
    if (!this.session.agent.hasQueuedMessages()) return;
    try {
      assertNotLive(this.path);
      this.assertNoForeignWrites();
    } catch {
      return; // not ours to write to; the queue's own guards report it on the next hand-off
    }
    this.flushDeferredAppends();
    // ONE WAKE AT A TIME, AND NO RE-PUMP ON FAILURE. Both halves are load-bearing:
    //
    // `continue()` can throw — "No messages to continue from" on a transcript that is empty or all
    // system, or "Agent is already processing" if a run started in the gap. The obvious catch,
    // report-and-re-pump, is a SPIN: the pump's wake condition (`hasQueued() && !streaming`) is
    // unchanged by the failure, so it wakes again, throws again, and reports again, forever. That
    // was measured, not reasoned about — a test with a throwing wake hung for 60s at 0 pass/0 fail.
    // So a failed wake leaves the state exactly as it found it and waits for a REAL change: the
    // next SDK event, or the user's next send. Nothing is lost either way; the queued messages are
    // still queued and Stop still drains them.
    if (this.waking) return;
    this.waking = true;
    this.session.agent
      .continue()
      .catch((err) => this.reportTurnFailure(err))
      .finally(() => {
        this.waking = false;
      });
  }

  private flushDeferredAppends(): void {
    for (const append of this.deferredAppends.splice(0)) append();
  }

  /** A compaction is running on this runtime: a /compact of ours, pi's automatic one, or an
      extension's `ctx.compact()`. Every send is held in the queue meanwhile. */
  isCompacting(): boolean {
    return this.compactRunning || this.session.isCompacting;
  }

  hasForeignWrites(): boolean {
    try {
      this.assertNoForeignWrites();
      return false;
    } catch {
      return true;
    }
  }

  /**
   * The user's model policy, checked as the message goes out: a session sitting on a
   * model that was turned off in Settings → Models refuses its next message and says which switch
   * to move. Nothing is chosen for it — a session that silently fell back to another model would
   * spend a turn on a model the user didn't pick, and the transcript would not say so.
   */
  assertModelAllowed(): void {
    const ref = modelLabel(this.session);
    if (!ref) return; // no model yet: the SDK's own error is the useful one
    const denial = modelDenial(readModelPolicy(), ref);
    if (denial) throw new Error(denial);
  }

  busyMessage(): string {
    return `modified by another process while open here (${this.foreignWrite}); reconnect with force to reload`;
  }

  async bind(): Promise<void> {
    const session = this.session;
    const sm = session.sessionManager;
    this.guard = new ForeignWriteGuard(this.path, (id) => sm.getEntry(id) !== undefined);
    this.guardTimer = setInterval(() => {
      if (this.foreignWrite) return;
      // A TUI that grabs the file mid-run: stop writing now (busy: force must never help).
      const live = readLive().get(this.path);
      if (live) {
        this.foreignWrite = `opened by another pi process (pid ${live.pid})`;
        this.broadcast({
          type: "error",
          code: "busy",
          message: `Session was opened in another pi process (pid ${live.pid}) while held here; stopped writing. Use watch instead.`,
        });
        // abort() also stops a compaction, whose entry would otherwise be written into a TUI's file.
        if (this.session.isStreaming || this.session.isCompacting) this.session.abort().catch(() => {});
        return;
      }
      if (this.clients.size === 0) {
        this.recordOwnWrites(); // nobody to tell, but the stat still has to be current for a restart
        return;
      }
      try {
        this.assertNoForeignWrites();
      } catch {
        // already broadcast
      }
    }, GUARD_POLL_MS);
    this.guardTimer.unref();
    this.workersTimer = setInterval(() => this.pushWorkers(), GUARD_POLL_MS);
    this.workersTimer.unref();
    await session.bindExtensions({
      uiContext: this.createUiContext(),
      mode: "rpc",
      onError: (err) =>
        this.broadcast({ type: "error", code: "internal", message: `Extension error (${err.extensionPath}): ${err.error}` }),
    });
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      try {
        this.broadcast({ type: "event", event: toWireEvent(event) });
      } catch (err) {
        console.error("[chat] failed to forward event", err);
      }
      // Before the queue wake below, so a held message's turn starts only after clients have the
      // branch with the compaction on it (refreshAfterCompaction). When the refresh is deferred,
      // so is this event's wake: the refresh wakes the queue itself once the hello is out.
      const refreshWakes = this.onCompactionEvent(event);
      // BEFORE anything else that can throw. Every event that can mean "the SDK's queue moved":
      // one was queued, one was delivered, the run ended. A generous list is cheaper than a
      // precise one, because the cost of a spurious wake is a re-read of two lengths while the
      // cost of a MISSED one is a queue that stops handing messages over until the next turn
      // boundary — and `normalizeEntry` below is not in a try.
      if (event.type === "queue_update") {
        // The mirror's own totals, straight from the SDK. The queue reads GROWTH out of the
        // sequence of these — the only way to tell "an extension queued something" from "our item
        // was delivered", which a single total cannot distinguish (one in, one out, total unmoved).
        this.queue.observeQueueUpdate(event.steering.length, event.followUp.length);
      } else if (QUEUE_WAKE_EVENTS.has(event.type) && !refreshWakes) this.queue.onSdkEvent();
      // pi's AUTOMATIC compaction emits compaction_end before its finally clears the controller
      // `isCompacting` reads, so the wake above can still find the queue paused: look again once
      // that has unwound. (The manual path clears first, so this one is a no-op there.)
      if (event.type === "compaction_end") setImmediate(() => !this.disposed && this.queue.onSdkEvent());
      if (event.type === "entry_appended" && (event as { entry?: unknown }).entry) {
        // Display entries an extension appended outside a turn (mode markers, align docs, …)
        // reach the pane now instead of at the next hello/resync. normalizeEntry returns []
        // for entries with nothing to show, so most appends broadcast nothing.
        const items = normalizeEntry((event as { entry: Record<string, any> }).entry);
        if (items.length) this.broadcast({ type: "append", items });
        onSandboxAppend(this.sandboxHost, (event as { entry: unknown }).entry);
      }
      if (event.type === "message_end" && this.overseerSends.length && (event as { message?: { role?: unknown } }).message?.role === "user") {
        this.markOverseerSend((event as { message: { content?: unknown } }).message);
      }
      if (event.type === "agent_settled" && this.overseerSends.length) {
        // A mark that never found its message this run (the prompt was swallowed or failed early)
        // is stale. Deferred, so a mark for a prompt made while this event is being emitted (it
        // runs in this same settle window) is not dropped before its message ends. A mark whose
        // queue item has not departed yet is not stale: its message is still on its way.
        const stale = this.overseerSends.filter((s) => !s.held);
        setTimeout(() => {
          if (!this.session.isStreaming) this.overseerSends = this.overseerSends.filter((s) => !stale.includes(s));
        }, 0);
      }
      if (event.type === "agent_settled") settledTurn(this.path);
      if (event.type === "agent_settled" && this.modeApplies === "after-turn") {
        // A mid-turn switch reaches the next prompt from here on.
        this.modeApplies = "now";
        this.broadcast(this.modeMessage());
      }
    });
    this.broadcast(this.commands()); // extension commands exist only after bindExtensions
    this.sendSandbox((m) => this.broadcast(m));
    // The same rule the extension's own session_start runs, so both agree on this session's mode.
    this.modeState = resolveChatMode(session.sessionManager.getBranch());
    this.modeApplies = this.modeCommand() ? "now" : "new-chats";
  }

  /**
   * The mode extension's own /mode command in this runtime, or undefined when it isn't loaded
   * (extension-toggle, a name clash). Checked by source so another extension's "mode" never runs.
   */
  private modeCommand() {
    const cmd = this.session.extensionRunner.getCommand("mode");
    return cmd && /[\\/]extensions[\\/]mode[\\/]index\.ts$/.test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
  }

  modeMessage(): ChatServerMessage {
    const s = this.modeState;
    return { type: "mode", mode: s.mode, minorModes: [...s.minorModes], strict: s.strict, applies: this.modeApplies };
  }

  /**
   * A session with no user message on its branch yet — the "new session" whose MODEL and THINKING
   * changes also save as the next new session's defaults (web-defaults). Modes are deliberately not
   * in that set: switching a new chat's mode changes nothing anywhere else, and the one write that
   * makes a mode the default is the explicit `Save as default` in the mode menu (saveModeDefault)
   * or `/mode default` in the TUI. Mode markers, model and thinking entries never count; only a
   * sent message stops it being new.
   */
  private isPristine(): boolean {
    return !this.session.sessionManager.getBranch().some((e) => e.type === "message" && e.message.role === "user");
  }

  /**
   * POST /api/mode?path=: merge the patch into THIS chat's mode and apply it here; no other chat
   * hears about it, and nothing is written to mode.json. The default new sessions start from moves
   * only when the user asks for it — the menu's `Save as default` (saveModeDefault), `/mode default`
   * in the TUI, or a POST /api/mode with no ?path=. A new chat's switch stops being a side effect
   * of being new.
   */
  async switchMode(patch: ModePatch): Promise<ChatModeResult> {
    if (this.overseer) throw new ModeRefusedError();
    await this.applyMode(mergeMode(this.modeState, patch));
    return { ...modeInfo(this.modeState), applies: this.modeApplies };
  }

  /**
   * POST /api/mode?path= { saveDefault: true }: make THIS chat's mode, strict flag and minor modes
   * the default new sessions start from (~/.pi/agent/mode.json) — the same three fields `/mode
   * default` writes in the TUI (defaultPatchOf). The write re-reads the file first, so shortcuts and
   * anything else in it are kept. The file as written comes back, so the caller can say what is now
   * the default without a second read.
   *
   * It switches nothing NOW: this chat keeps its mode and no open chat hears about it. The default
   * is read at each session_start, so it moves new sessions from their next start — and, like any
   * write of the default, a session that has never switched (no mode entry on its branch) follows
   * it too from its next start or reopen. "Unchanged" is true now, not forever.
   */
  async saveModeDefault(): Promise<ModeInfo> {
    if (this.overseer) throw new ModeRefusedError();
    return modeInfo(writeMode(defaultPatchOf(this.modeState)));
  }

  /**
   * Make this runtime follow `state` from its next prompt (modeApplyPlan), and make it this
   * chat's mode. The /mode handler is called directly, never sent through prompt(), so no command
   * text can reach the model; it appends the marker entry this session later restores from.
   * Resolves once the switch is in the extension's memory; the delegate routing probe it then
   * starts isn't awaited. Returns the plan that ran ("command" = taken, "skip" = a foreign writer
   * got it, "unsupported" = no /mode command loaded), so callers can decide what else to do.
   */
  async applyMode(state: ModeState): Promise<"skip" | "unsupported" | "command"> {
    if (this.disposed) return "skip"; // a disposed runtime took nothing
    const session = this.session;
    const streaming = session.isStreaming;
    let live = false;
    try {
      assertNotLive(this.path);
    } catch {
      live = true;
    }
    const plan = modeApplyPlan({
      foreign: live || this.hasForeignWrites(),
      hasModeCommand: !!this.modeCommand(),
      pristine: this.isPristine(),
      streaming,
    });
    let applies = appliesAfter(plan, streaming);
    if (plan === "command") {
      // getCommand + createCommandContext + handler(args, ctx) is the SDK's own extension-command
      // path (AgentSession._tryExecuteExtensionCommand, agent-session.js:1062 in pinned 0.86.0;
      // the method body is byte-identical to 0.85.1's, it only moved),
      // minus the prompt text that path falls back to when a command is missing. Internal-ish
      // API: re-check on SDK upgrades. The SDK reports handler errors via emitError; so do we.
      const cmd = this.modeCommand()!;
      const ctx = session.extensionRunner.createCommandContext();
      this.flushDeferredAppends(); // open-time entries go before the extension's mode marker
      try {
        for (const minor of MINOR_MODES) await cmd.handler(`${minor} ${state.minorModes.includes(minor) ? "on" : "off"}`, ctx);
        // Not awaited: after switching, setMode awaits the delegate routing probe (up to 15s).
        cmd.handler(state.mode, ctx).catch((err) => {
          console.error("[chat] /mode handler failed", err);
          if (this.disposed) return;
          this.modeApplies = "new-chats";
          this.broadcast(this.modeMessage());
        });
      } catch (err) {
        console.error("[chat] /mode handler failed", err);
        applies = "new-chats";
      }
      if (!this.foreignWrite) markOwned(this.path); // the marker entry is our write
      this.modeState = state; // the runtime took it: this is now this chat's mode
    }
    this.modeApplies = applies;
    this.broadcast(this.modeMessage());
    return plan;
  }

  /** The sandbox extension's /sandbox command in this runtime (server/sandbox-state.ts). */
  private sandboxCommand() {
    return sandboxCommandOf(this.session.extensionRunner);
  }

  /** This chat's "sandbox" message, only when the extension is loaded: without it, nothing is sent. */
  private sendSandbox(send: (msg: ChatServerMessage) => void): void {
    if (this.sandboxCommand()) send(sandboxMessage(this.session.sessionManager.getBranch()));
  }

  private get sandboxHost(): SandboxHost {
    return {
      command: () => this.sandboxCommand(),
      foreign: () => {
        try {
          assertNotLive(this.path);
        } catch {
          return true;
        }
        return this.disposed || this.hasForeignWrites();
      },
      commandContext: () => this.session.extensionRunner.createCommandContext(),
      beforeCommand: () => this.flushDeferredAppends(), // open-time entries go before the extension's
      afterCommand: () => {
        if (!this.foreignWrite) markOwned(this.path); // the extension's entry is our write
      },
      branch: () => this.session.sessionManager.getBranch(),
      broadcast: (msg) => this.broadcast(msg),
    };
  }

  /** POST /api/workers/resume: start one restored worker again, idle (server/worker-resume.ts).
      The fresh worker snapshot is pushed at once, so clients don't wait for the next poll. */
  async resumeWorker(id: string): Promise<ResumeOutcome> {
    if (this.disposed) return { ok: false, status: 404, error: "That session isn't open on this server; open the chat first." };
    const outcome = await resumeWorker(
      {
        command: () => resumeCommandOf(this.session.extensionRunner),
        foreign: () => this.sandboxHost.foreign(),
        commandContext: () => this.session.extensionRunner.createCommandContext(),
        beforeCommand: () => this.flushDeferredAppends(),
        afterCommand: () => {
          if (!this.foreignWrite) markOwned(this.path); // the extension's registry entry is our write
        },
      },
      id,
    );
    this.pushWorkers();
    return outcome;
  }

  /** This runtime's current record of one worker, from its own live record. */
  workerInfo(id: string): WorkerInfo | null {
    const rec = readOwnLiveRecords().get(this.path);
    return decodeWorkers(rec?.rec?.presence, true).find((w) => w.id === id) ?? null;
  }

  /** POST /api/sandbox?path=: flip this chat's sandbox from its next tool call (applySandbox). */
  applySandbox(on: boolean): Promise<SandboxApplyResult> {
    return applySandbox(this.sandboxHost, on);
  }

  commands(): ChatServerMessage {
    try {
      return { type: "commands", commands: listCommands(this.session) };
    } catch (err) {
      console.error("[chat] listing commands failed", err);
      return { type: "commands", commands: [] };
    }
  }

  hello(): ChatServerMessage {
    const session = this.session;
    const branch = session.sessionManager.getBranch();
    return {
      type: "hello",
      items: normalizeEntries(branch),
      isStreaming: session.isStreaming,
      isCompacting: this.isCompacting(),
      model: modelLabel(session),
      thinking: session.thinkingLevel,
      context: toContextInfo(contextForBranch(branch), this.runtime.services.modelRuntime),
    };
  }

  attach(client: ChatClient): void {
    this.clients.add(client);
    client.send(this.hello());
    client.send(this.commands());
    // The queue goes out on EVERY attach, empty or not: a reconnect resets the pane's live rows to
    // nothing, so a client that is told nothing cannot tell "no queue" from "not told yet" and
    // would show an empty thread over a full queue.
    client.send({ type: "queue", items: this.queue.snapshot() });
    client.send(this.modeMessage());
    this.sendSandbox((m) => client.send(m));
    const snap = this.workersSnapshot();
    if (snap) client.send(snap);
  }

  detach(client: ChatClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0) {
      // Nobody can answer open dialogs anymore: resolve them with defaults. The runtime stays
      // alive: a session closes when the user archives it, not when the last tab leaves.
      for (const p of this.pendingUi.values()) p.resolve(undefined);
      this.pendingUi.clear();
    }
  }

  /**
   * ACCEPT one user message: the write guards run NOW and throw on refusal, and the turn itself
   * runs on. Returns the in-flight turn so a caller can attach failure handling — it is NOT
   * something to await before answering a request, because the SDK's `prompt()` resolves on TURN
   * COMPLETION (`AgentSession.prompt` in agent-session.js runs the whole agent loop; :1207 in the
   * pinned 0.87.1 — and a prompt() made while agent_settled is being emitted is deferred: it
   * resolves at once and its turn runs inside the PREVIOUS prompt()'s promise), so awaiting N of
   * them in a row
   * runs N turns end to end. Acceptance is everything up to handing the text to the SDK: a TUI
   * owning the file, a foreign writer, a closed runtime. Blank text with no image is a no-op.
   */
  acceptPrompt(
    text: string,
    images?: SdkImage[],
    origin: QueueItem["origin"] = "server",
    clientId?: string,
    /** `replay: true` = this text came OUT of the transcript, so it is already expanded and must
        be sent verbatim. Without it the SDK would expand skills and templates a SECOND time, and a
        stored message that merely begins with "/" would be DISPATCHED as an extension command
        instead of replayed — a regenerate that runs a command rather than redoing the turn. */
    /** `sentByOverseer`: mark the user entry as the Overseer's (§app.overseer/sent-marker), now
        or, when it is queued, at its hand-off. `delivery`: the kind it is queued as mid-turn, as
        the composer's Steer or a Playbook's follow-up; idle, either is a plain prompt. */
    opts?: { replay?: boolean; sentByOverseer?: { overseerId?: string }; delivery?: WebQueueItem["kind"] },
  ): { queued: boolean; turn: Promise<void> } {
    // Never write if a TUI grabbed this file, or anyone else wrote it, after we opened it.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (!text.trim() && !images) return { queued: false, turn: Promise.resolve() };
    // While streaming, a plain prompt is a follow-up — held in Sova's own queue now, so it can
    // still be taken back one item at a time. Server-originated prompts (a group batch, a remote
    // status probe) queue on the same terms as a client's: they are messages to this session, and
    // a queue that some messages could skip would not be a queue.
    // A compaction running is the same: pi refuses every prompt until it ends, so the message is
    // held, and the queue hands it over (as a fresh turn) at compaction_end.
    if (this.session.isStreaming || this.isCompacting()) {
      const overseer = opts?.sentByOverseer ? { overseer: opts.sentByOverseer } : {};
      this.queue.enqueue({ kind: opts?.delivery ?? "followUp", text, images: images as QueueImage[] | undefined, origin, id: clientId, ...overseer });
      return { queued: true, turn: Promise.resolve() };
    }
    this.flushDeferredAppends();
    // Marked here when it starts a turn now; a queued one is marked at its hand-off. A pending
    // mark is dropped if the turn fails, and any left when the run settles are dropped too
    // (bind's agent_settled), so a later identical message the user types is never tagged.
    const send = opts?.sentByOverseer ? { text, overseerId: opts.sentByOverseer.overseerId } : null;
    if (send) this.overseerSends.push(send);
    const turn = this.toSdk(origin, () => this.session.prompt(text, { images, ...(opts?.replay ? { expandPromptTemplates: false } : {}) }));
    if (send)
      turn.catch(() => {
        const i = this.overseerSends.indexOf(send);
        if (i >= 0) this.overseerSends.splice(i, 1);
      });
    // A replay is not re-queued: the queue would expand it a second time (see `replay` above).
    if (opts?.replay) return { queued: false, turn };
    // Held under the sender's own id: this send was never a queue item, so the id is still free.
    const held = (err: unknown) => {
      const item = { kind: opts?.delivery ?? "followUp", text, images: images as QueueImage[] | undefined, origin, id: clientId, ...(opts?.sentByOverseer ? { overseer: opts.sentByOverseer } : {}) };
      if (!this.heldForCompaction(err, item)) throw err;
    };
    return { queued: false, turn: turn.catch(held) };
  }

  /** Accept a prompt AND wait for the turn. The /ws/chat path, where the socket reports the
      turn's own failure to the one client that asked for it. A queued message's "turn" is already
      resolved: its failure, when it comes, reports through the queue's own hand-off path. */
  async prompt(text: string, images?: SdkImage[], origin: QueueItem["origin"] = "server", clientId?: string): Promise<boolean> {
    const { queued, turn } = this.acceptPrompt(text, images, origin, clientId);
    await turn;
    return queued;
  }

  /**
   * The user message the Overseer sent has just ended: write its invisible `sova-overseer-sent`
   * marker pointing at that entry (the `sova-rewind` pattern — never LLM context, the TUI ignores
   * it). Listeners run BEFORE the SDK persists the message (agent-session.js `_handleAgentEvent`:
   * `_emit`, then `appendMessage`, in the same synchronous stretch), so the write waits one
   * microtask, by which time the entry exists and is the leaf. The marker is parented on it, and
   * the reply is then parented on the marker: rewind (to the user entry's parent) and regenerate
   * (walking back past custom entries to the user entry) behave exactly as on any user turn.
   */
  private markOverseerSend(message: { content?: unknown }): void {
    const text = typeof message.content === "string" ? message.content : textBlocks(message.content);
    const i = this.overseerSends.findIndex((s) => s.text === text);
    if (i < 0) return;
    const [send] = this.overseerSends.splice(i, 1);
    queueMicrotask(() => {
      if (this.disposed || this.foreignWrite) return;
      const sm = this.session.sessionManager;
      const leaf = sm.getLeafId();
      const entry = leaf ? sm.getEntry(leaf) : undefined;
      if (entry?.type !== "message" || entry.message.role !== "user") return;
      const data: OverseerSentMarkerData = { v: 1, targetId: entry.id, ...(send?.overseerId ? { overseerId: send.overseerId } : {}) };
      const markerId = sm.appendCustomEntry(OVERSEER_SENT_ENTRY, data);
      markOwned(this.path);
      const marker = sm.getEntry(markerId);
      if (marker) {
        const items = normalizeEntry(marker as unknown as Record<string, any>);
        if (items.length) this.broadcast({ type: "append", items });
      }
    });
  }

  /** The extension dialogs waiting on an answer right now (live-pending: a browser is attached). */
  pendingDialogs(): PendingDialog[] {
    const out: PendingDialog[] = [];
    for (const [id, p] of this.pendingUi) {
      const r = p.request;
      const method = r.method;
      if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") continue;
      out.push({
        id,
        method,
        title: typeof r.title === "string" ? r.title : "",
        ...(typeof r.message === "string" ? { message: r.message } : {}),
        ...(Array.isArray(r.options) ? { options: r.options.filter((o): o is string => typeof o === "string") } : {}),
        since: p.since,
      });
    }
    return out;
  }

  /**
   * The Overseer answers one pending dialog. Same write guards as a prompt (the answer marker is a
   * write); the answer is resolved exactly as a browser's `ui_response` would be, every tab drops
   * its copy of the dialog, and an invisible `sova-overseer-dialog-answer` entry records it as the
   * machine row "Overseer chose: X".
   */
  answerDialog(id: string, value: unknown, answer: string, overseerId?: string): void {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    const pending = this.pendingUi.get(id);
    if (!pending) throw new Error("That dialog is no longer waiting for an answer.");
    const title = typeof pending.request.title === "string" ? pending.request.title : "";
    this.pendingUi.delete(id);
    pending.resolve(value); // every tab drops the dialog (ui_resolved, from the dialog's own settle)
    this.flushDeferredAppends();
    const data: OverseerDialogAnswerData = { v: 1, title, answer, ...(overseerId ? { overseerId } : {}) };
    const markerId = this.session.sessionManager.appendCustomEntry(OVERSEER_DIALOG_ANSWER_ENTRY, data);
    markOwned(this.path);
    const marker = this.session.sessionManager.getEntry(markerId);
    if (marker) {
      const items = normalizeEntry(marker as unknown as Record<string, any>);
      if (items.length) this.broadcast({ type: "append", items });
    }
  }

  /**
   * Switch model, the one path for the composer's `set_model`, the Overseer's `sova_set_session`
   * and Settings → Overseer. Resolves against models with configured auth (= GET /api/models)
   * BEFORE writing anything, so a rejected switch leaves the file untouched. Only `save: true`
   * (the user's own pick in the composer) is remembered; every other caller changes this chat only.
   */
  async setModelRef(ref: string, opts: { save?: boolean } = {}): Promise<void> {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.session.isStreaming) throw new Error("Cannot switch models while the agent is running; wait or abort first");
    const available = await this.runtime.services.modelRuntime.getAvailable();
    // The user's own policy first: a model turned off in Settings → Models is refused
    // whether or not it has credentials, and nothing is written (server/model-policy.ts).
    const denial = modelDenial(readModelPolicy(), ref);
    if (denial) throw new Error(denial);
    const model = available.find((m) => `${m.provider}/${m.id}` === ref);
    if (!model) {
      const known = this.runtime.services.modelRuntime.getModel(ref.split("/")[0] ?? "", ref.slice(ref.indexOf("/") + 1));
      throw new Error(known ? `No credentials configured for ${ref}` : `Unknown model: ${ref || "(empty ref)"}`);
    }
    // Re-check after the async lookup: a TUI/foreign writer may have appeared meanwhile.
    // BusyError propagates to `fail`, which maps it to its busy/recent code.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.session.isStreaming) throw new Error("Cannot switch models while the agent is running; wait or abort first");
    this.flushDeferredAppends(); // keep open-time entries before this model_change
    await this.session.setModel(model);
    this.broadcast({ type: "model", model: modelLabel(this.session) ?? ref });
    // setModel re-clamps the level to the new model's ladder; the pane needs that too.
    this.broadcast({ type: "thinking", level: this.session.thinkingLevel });
    // Only the user's pick saves: the Overseer's own chat records it in overseer.json, and a session
    // with no messages yet makes it the next new session's default. A programmatic switch (the
    // Overseer acting on a session, Settings → Overseer) never becomes anyone's default.
    if (opts.save !== true) return;
    // The level too: setModel re-clamped it, and the next conversation is seeded from the file.
    if (this.overseer) overseerRuntime?.saveChoice({ model: ref, thinking: this.session.thinkingLevel });
    else if (this.isPristine()) saveDefaults({ model: ref });
  }

  /** Change thinking level: the `set_thinking` path, shared like setModelRef (and saved, like it,
      only with `save: true`). Returns the effective level. */
  setThinking(level: string, opts: { save?: boolean } = {}): string {
    // setThinkingLevel appends a thinking_level_change entry: same write guards as set_model.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.session.isStreaming) throw new Error("Cannot change thinking while the agent is running; wait or abort first");
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown thinking level: ${level || "(empty)"}`);
    this.flushDeferredAppends(); // keep open-time entries before this thinking_level_change
    // The SDK clamps to what the model supports, so the echo is the effective level.
    const before = this.session.thinkingLevel;
    this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
    const after = this.session.thinkingLevel;
    this.broadcast({ type: "thinking", level: after });
    // The SDK's appendThinkingLevelChange emits no entry_appended (only the extension
    // appendEntry API does), so the "Thinking: X" row is synthesized here; the next
    // hello/resync replaces it with the real entry.
    if (after !== before)
      this.broadcast({
        type: "append",
        items: [{ id: `thinking-${Date.now()}`, kind: "info", raw: { type: "thinking_level_change", thinkingLevel: after }, text: `Thinking: ${after}` }],
      });
    if (opts.save !== true) return after;
    if (this.overseer) overseerRuntime?.saveChoice({ thinking: after });
    // A session with no messages yet: this level is also the next new session's default.
    else if (this.isPristine()) saveDefaults({ thinking: after });
    return after;
  }

  /** Report a failure into this session's own pane(s) — where every other turn failure already
      reports. Used for a turn nobody is awaiting (the group batch dispatches and returns). */
  reportTurnFailure(err: unknown): void {
    const code = err instanceof BusyError ? err.code : "internal";
    this.broadcast({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
  }

  handle(client: ChatClient, msg: ChatClientMessage): void {
    // The failing send's own id rides along when it has one, so the client restores THAT draft and
    // no other; a chat-wide failure still reports without one, exactly as before.
    const clientId = "clientId" in msg && typeof msg.clientId === "string" && msg.clientId ? msg.clientId : undefined;
    const fail = (err: unknown) => {
      const code = err instanceof BusyError ? err.code : "internal";
      client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err), ...(clientId ? { clientId } : {}) });
    };
    if (this.disposed) {
      client.send({ type: "error", code: "reloaded", message: "Session runtime was closed; reconnect" });
      return;
    }
    try {
      switch (msg.type) {
        case "prompt":
        case "steer": {
          // `/compact [instructions]` as a whole message: Sova's builtin, never text for the
          // model. It runs here, before pi's prompt() could send the literal "/compact" to the
          // model, and before a streaming steer could queue it. The send's own id names the
          // reply; it never becomes a queue row. With images it is refused, not sent without them.
          const compact = compactCommand(String(msg.text ?? ""));
          if (compact) {
            if (clientId) client.send({ type: "send_ack", clientId, queued: false });
            if (msg.images?.length) client.send({ type: "compact_refused", id: clientId ?? "", reason: "internal", message: COMPACT_IMAGES_REFUSAL });
            else this.compact(client, clientId ?? "", compact.instructions).catch(fail);
            return;
          }
          // `/mode …` in the Overseer: it is always in normal mode. Its composer answers this
          // itself; this is the server's own refusal, so no client can switch it by prompt text.
          if (this.overseer && /^\/mode(\s|$)/.test(String(msg.text ?? "").trim())) {
            fail(new ModeRefusedError());
            return;
          }
          if (msg.type === "steer") {
            this.steer(client, msg, clientId, fail);
            return;
          }
          // The model-policy gate, at the same site the `steer` case below applies it: a model
          // turned off in Settings → Models is refused before anything is written. Everything else
          // this case needs (TUI ownership, foreign writers, blank text, deferred appends, the
          // streaming follow-up choice) lives in `acceptPrompt`, which `prompt()` awaits.
          this.assertModelAllowed();
          const images = parseImages(msg.images);
          const text = String(msg.text ?? "");
          const { queued, turn } = this.acceptPrompt(text, images, "client", clientId);
          // The ack goes out NOW, not after the turn: it says whether a queue row exists, and a
          // client that learned that only at turn end would offer Remove for a sent message.
          if (clientId) client.send({ type: "send_ack", clientId, queued });
          turn.catch(fail);
          return;
        }
        case "abort":
          // The queue drains Sova's held items AND the SDK's, so Stop still means "nothing
          // queued survives this", and the drained text still comes back as `queue_cleared`.
          drainQueueThenAbort(this.session, (m) => this.broadcast(m), this.queue).catch(fail);
          return;
        case "queue_remove": {
          const id = String(msg.id ?? "");
          const itemId = String(msg.itemId ?? "");
          // Awaited, not answered from a snapshot: a removal that arrives while the item is still
          // inside its hand-off (extension `input` handlers, which can take a model call) waits
          // that window out rather than mistaking "not given to the SDK yet" for "already sent".
          this.queue
            .remove(itemId)
            .then((outcome) => {
              if (outcome.ok) client.send({ type: "queue_removed", id, itemId, text: outcome.item.text });
              else client.send({ type: "queue_remove_refused", id, itemId, reason: outcome.reason, message: outcome.message });
            })
            .catch(fail);
          return;
        }
        case "regenerate":
          this.regenerate(client, String(msg.id ?? ""), String(msg.entryId ?? "")).catch(fail);
          return;
        case "set_thinking":
          this.setThinking(String(msg.level ?? ""), { save: true });
          return;
        case "set_model":
          this.setModelRef(String(msg.ref ?? ""), { save: true }).catch(fail);
          return;
        case "rewind":
          this.rewind(client, String(msg.id ?? ""), String(msg.entryId ?? "")).catch(fail);
          return;
        case "compact": {
          const instructions = typeof msg.instructions === "string" ? msg.instructions.trim() : "";
          this.compact(client, String(msg.id ?? ""), instructions || undefined).catch(fail);
          return;
        }
        case "ui_response": {
          const pending = this.pendingUi.get(msg.id);
          if (pending) {
            this.pendingUi.delete(msg.id);
            pending.resolve(msg.value); // every other tab drops it (ui_resolved, from the dialog's own settle)
          }
          return;
        }
        default:
          client.send({ type: "error", code: "internal", message: `Unknown message type: ${(msg as any)?.type}` });
      }
    } catch (err) {
      fail(err);
    }
  }

  /**
   * The refresh for a compaction Sova did not start itself: the provider's `ctx.compact()` from an
   * agent_settled hook, pi's threshold or overflow compaction. pi emits no `entry_appended` for a
   * compaction entry on any path, so without this the row only appears at the next reload. Only a
   * `compaction_end` with a `result` wrote one. Our own /compact refreshes in compact().
   *
   * Idle: on the next macrotask, not inside the event. pi's AUTOMATIC path emits compaction_end
   * before its finally clears the controller `isCompacting` reads, so a hello sent from inside the
   * event would say `isCompacting: true` after the compaction ended, and every client would stay
   * on "Compacting…". The event's own queue wake is skipped (returns true) and the refresh wakes
   * the queue after its hello, so a message held during the compaction still starts its turn after
   * the clients have the new branch. That holds for ctx.compact() too, where pi clears the flag
   * first and the queue would otherwise hand off at once.
   *
   * Mid-turn (the overflow path ends with willRetry and carries on streaming; a threshold one can
   * land inside the run): at that turn's `agent_settled`, because a hello resets every client's
   * live rows and would wipe the turn being streamed. That refresh runs before the settle's own
   * queue wake.
   */
  private onCompactionEvent(event: { type: string }): boolean {
    try {
      const result = (event as { result?: unknown }).result;
      if (event.type === "compaction_end" && !this.compactRunning && typeof result === "object" && result !== null) {
        if (this.session.isStreaming) {
          this.refreshAtSettle = true;
          return false;
        }
        setImmediate(() => {
          if (this.disposed) return;
          try {
            this.refreshAfterCompaction();
          } catch (err) {
            console.error("[chat] refresh after compaction failed", err);
          }
          if (!this.disposed) this.queue.onSdkEvent();
        });
        return true;
      }
      if (event.type === "agent_settled" && this.refreshAtSettle) {
        this.refreshAtSettle = false;
        this.refreshAfterCompaction();
      }
    } catch (err) {
      console.error("[chat] refresh after compaction failed", err);
    }
    return false;
  }

  /** afterBranchMove, then the queue snapshot: that hello reset every client's pending rows, and the
      snapshot is what rebuilds them (as on attach). */
  private refreshAfterCompaction(): void {
    this.afterBranchMove();
    if (this.disposed) return;
    this.broadcast({ type: "queue", items: this.queue.snapshot() });
  }

  /** The `steer` case of handle(), whose failures `fail` reports to the sender. */
  private steer(client: ChatClient, msg: Extract<ChatClientMessage, { type: "steer" }>, clientId: string | undefined, fail: (err: unknown) => void): void {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    this.assertModelAllowed();
    const text = String(msg.text ?? "");
    const images = parseImages(msg.images);
    if (!text.trim() && !images) return;
    // Mid-turn, this is a steer and goes through Sova's queue so it stays removable; idle,
    // there is nothing to queue behind, so it starts its turn straight away (and the
    // extension-command split lives in handOffQueued, which both paths reach). While a
    // compaction runs it is held the same way, and goes in when the compaction ends.
    if (this.session.isStreaming || this.isCompacting()) {
      this.queue.enqueue({ kind: "steer", text, images: images as QueueImage[] | undefined, origin: "client", id: clientId });
      if (clientId) client.send({ type: "send_ack", clientId, queued: true });
      return;
    }
    this.flushDeferredAppends();
    if (clientId) client.send({ type: "send_ack", clientId, queued: false });
    this.toSdk("client", () => this.session.prompt(text, { images }))
      .catch((err) => {
        if (!this.heldForCompaction(err, { kind: "steer", text, images: images as QueueImage[] | undefined, origin: "client", id: clientId })) throw err;
      })
      .catch(fail);
  }

  /**
   * The client's /compact (compactSession), then the same refresh a rewind does: pi emits no
   * `entry_appended` for a manual compaction's entry, so every client gets a fresh hello (items
   * ending in the compaction row, context null until the next reply), workers and mode. Only the
   * requester gets the outcome. `compactRunning` spans the whole call, from before pi's own
   * `isCompacting` turns true until after it is false again. Whatever the queue held meanwhile goes
   * AFTER the hello: that hello resets every client's live rows, so the queue snapshot follows it
   * (as on attach) and only then is the queue woken — a turn started first would be wiped from the
   * pane by the hello that describes the branch before it.
   */
  private async compact(client: ChatClient, id: string, instructions: string | undefined): Promise<void> {
    if (this.compactRunning) {
      client.send({ type: "compact_refused", id, reason: "compacting", message: "A compaction is already running." });
      return;
    }
    this.compactRunning = true;
    let outcome: CompactOutcome;
    try {
      outcome = await compactSession(this.session, instructions, {
        guard: () => {
          assertNotLive(this.path);
          this.assertNoForeignWrites();
        },
        allowed: () => this.assertModelAllowed(),
        queued: () => this.hasPendingSends(),
        beforeWrite: () => this.flushDeferredAppends(),
      });
    } finally {
      this.compactRunning = false;
    }
    if (this.disposed) return;
    if (!outcome.ok) {
      client.send({ type: "compact_refused", id, reason: outcome.reason, message: outcome.message });
    } else {
      this.refreshAfterCompaction();
      if (this.disposed) return;
      client.send({ type: "compacted", id, entryId: outcome.entryId, tokensBefore: outcome.tokensBefore });
    }
    this.queue.onSdkEvent();
  }

  /**
   * The client's rewind (rewindSession), then the refresh no SDK event does: every client gets a
   * fresh hello (branch-based, so transcript and context fill follow the new leaf) and this chat's
   * mode re-resolved from the new branch, as bind() does (the mode extension re-resolves on
   * session_tree too), with the workers snapshot between them. Only the requester gets the text back.
   */
  private async rewind(client: ChatClient, id: string, entryId: string): Promise<void> {
    const outcome = await rewindSession(this.session, entryId, {
      guard: () => {
        assertNotLive(this.path);
        this.assertNoForeignWrites();
      },
      queued: () => this.hasPendingSends(),
      beforeMarker: () => this.flushDeferredAppends(),
    });
    if (!outcome.ok) {
      client.send({ type: "rewind_refused", id, entryId, reason: outcome.reason, message: outcome.message });
      return;
    }
    this.afterBranchMove();
    if (this.disposed) return;
    client.send({ type: "rewound", id, entryId, editorText: outcome.editorText });
  }

  /**
   * Redo the turn an assistant entry belongs to: rewind to just before the user message that
   * started it, then send that message again — its own stored text and images, with the session's
   * CURRENT model and thinking level, which is what makes "switch model, then regenerate" a
   * comparison rather than a repeat.
   *
   * Order is load-bearing in two places. The model policy is checked BEFORE the rewind, so a
   * session sitting on a switched-off model refuses without having thrown its branch away. And the
   * rewind goes through `rewindSession`, so the invisible `sova-rewind` marker is written before
   * the prompt: if the prompt then fails, a reload still lands on the new branch instead of
   * silently restoring the reply the user asked to replace.
   */
  private async regenerate(client: ChatClient, id: string, entryId: string): Promise<void> {
    const refuse = (reason: RegenerateRefusal, message: string) =>
      client.send({ type: "regenerate_refused", id, entryId, reason, message });
    const target = resolveRegenerate(this.session.sessionManager.getBranch(), entryId);
    if (!target.ok) return refuse(target.reason, target.message);
    try {
      this.assertModelAllowed();
    } catch (err) {
      return refuse("internal", err instanceof Error ? err.message : String(err));
    }
    const outcome = await rewindSession(this.session, target.userId, {
      guard: () => {
        assertNotLive(this.path);
        this.assertNoForeignWrites();
      },
      queued: () => this.hasPendingSends(),
      beforeMarker: () => this.flushDeferredAppends(),
    });
    if (!outcome.ok) return refuse(outcome.reason, outcome.message);
    this.afterBranchMove();
    if (this.disposed) return;
    client.send({ type: "regenerated", id, entryId, userEntryId: target.userId });
    // The branch is now at the point before the user message, so the session is idle and this
    // starts a turn rather than queueing. Its failure reports into this session's pane, where
    // every other turn failure already does.
    const { turn } = this.acceptPrompt(target.text, target.images as SdkImage[] | undefined, "client", undefined, { replay: true });
    turn.catch((err) => this.reportTurnFailure(err));
  }

  /** The refresh no SDK event does after the leaf moved: a fresh hello (branch-based, so transcript
      and context fill follow the new leaf), the workers snapshot, and this chat's mode re-resolved
      from the new branch as bind() does. Shared by rewind, regenerate and compact so they can never
      drift into telling clients different things about the same move. */
  private afterBranchMove(): void {
    if (!this.foreignWrite) markOwned(this.path); // the marker (or compaction) entry is our write
    if (this.disposed) return;
    this.broadcast(this.hello());
    // Every client's hello handler clears its worker list, and pushWorkers only sends on change,
    // so an unchanged set would stay blank: re-send it now (attach() does the same after hello).
    const workers = this.workersSnapshot();
    if (workers) {
      this.lastWorkersJson = JSON.stringify(workers);
      this.broadcast(workers);
    }
    this.modeState = resolveChatMode(this.session.sessionManager.getBranch());
    this.broadcast(this.modeMessage());
    this.sendSandbox((m) => this.broadcast(m)); // the extension re-restores on session_tree too
  }

  broadcast(msg: ChatServerMessage): void {
    for (const c of this.clients) c.send(msg);
  }

  /** Worker snapshot from this runtime's own live record (the sessions extension writes one
      even for embedded runtimes), as the wire message; null when the record or its counts
      are absent. The token Σ rides along: it is the record's own lifetime total, which covers
      workers the record no longer lists, so it is never summed from the rows. */
  private workersSnapshot(): ChatServerMessage | null {
    const rec = readOwnLiveRecords().get(this.path);
    const counts = rec ? workerCountsOf(rec.rec) : undefined;
    if (!rec || !counts) return null;
    const usageTotal = decodeUsageTotal(rec.rec?.presence);
    // Each worker's context fill, off its own transcript's tail (the record carries spend only);
    // claude-code windows follow the spawn model this session's manifests recorded.
    const workers = withWorkerContext(decodeWorkers(rec.rec?.presence, true), workerContextReader,
      workerWindowResolver(this.runtime.services.modelRuntime), (id) => this.claudeSpawnModel(id));
    return { type: "workers", working: counts.working, total: counts.total,
      workers, ...(usageTotal ? { usageTotal } : {}) };
  }

  /** A claude-code worker's spawn model from this session's manifests, folded once per entry count. */
  private spawnModels: { count: number; of: (id: string) => string | undefined } | null = null;
  private claudeSpawnModel(id: string): string | undefined {
    const entries = this.session.sessionManager.getEntries();
    if (this.spawnModels?.count !== entries.length) this.spawnModels = { count: entries.length, of: claudeSpawnModels(entries) };
    return this.spawnModels.of(id);
  }

  /** Broadcast the worker snapshot when it changed since the last send; a record that
      vanished after existing means workers went away, so send an explicit zero once. */
  private pushWorkers(): void {
    if (this.disposed || this.clients.size === 0) return;
    let msg: ChatServerMessage | null = null;
    try {
      msg = this.workersSnapshot();
    } catch {
      return; // live dir unreadable mid-write: retry next tick
    }
    const json = msg ? JSON.stringify(msg) : null;
    if (json === this.lastWorkersJson) return;
    this.lastWorkersJson = json;
    this.broadcast(msg ?? { type: "workers", working: 0, total: 0, workers: [] });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.close(); // nothing more is handed to a runtime that is going away
    if (this.guardTimer) clearInterval(this.guardTimer);
    if (this.workersTimer) clearInterval(this.workersTimer);
    this.unsubscribe?.();
    for (const p of this.pendingUi.values()) p.resolve(undefined);
    this.pendingUi.clear();
    if (held.get(this.path) === this) held.delete(this.path); // a reload may already hold a newer one
    this.onDisposed();
    try {
      await this.runtime.dispose();
    } catch (err) {
      console.error("[chat] runtime dispose failed", err);
    }
    // Remember the state we left the file in, so reopening soon — by this process or the next one,
    // after a restart — isn't mistaken for a foreign write. Only what the guard verifies: the
    // shutdown appends are our SessionManager's own entries, and anything else records nothing.
    this.recordOwnWrites();
  }

  /**
   * Extension dialog bridge (pattern from pi's rpc-mode): select/confirm/input/editor are
   * broadcast as ui_request and resolved by the first ui_response. notify/setStatus are
   * forwarded fire-and-forget (request.fireAndForget = true). TUI-only features are no-ops.
   */
  private createUiContext(): ExtensionUIContext {
    const dialog = <T>(
      opts: ExtensionUIDialogOptions | undefined,
      fallback: T,
      request: Record<string, unknown>,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      if (opts?.signal?.aborted || this.clients.size === 0) return Promise.resolve(fallback);
      const id = randomUUID();
      return new Promise<T>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (value: T) => {
          if (timer) clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          this.pendingUi.delete(id);
          // However it settled — answered here or in another tab, by the Overseer, timed out,
          // aborted — every client drops its copy of the dialog.
          this.broadcast({ type: "ui_resolved", id });
          resolve(value);
        };
        const onAbort = () => done(fallback);
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        if (opts?.timeout) timer = setTimeout(() => done(fallback), opts.timeout);
        this.pendingUi.set(id, {
          request,
          since: Date.now(),
          resolve: (v) => {
            // Accept bare values or pi rpc-style {value}|{confirmed}|{cancelled:true}.
            if (v && typeof v === "object") {
              const o = v as Record<string, unknown>;
              v = o.cancelled ? undefined : "confirmed" in o ? o.confirmed : "value" in o ? o.value : v;
            }
            try {
              done(v === undefined || v === null ? fallback : parse(v));
            } catch {
              done(fallback);
            }
          },
        });
        this.broadcast({ type: "ui_request", id, request: { ...request, timeout: opts?.timeout } });
      });
    };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const fireAndForget = (request: Record<string, unknown>) =>
      this.broadcast({ type: "ui_request", id: randomUUID(), request: { ...request, fireAndForget: true } });

    return {
      select: (title, options, opts) => dialog(opts, undefined, { method: "select", title, options }, str),
      confirm: (title, message, opts) => dialog(opts, false, { method: "confirm", title, message }, (v) => v === true),
      input: (title, placeholder, opts) => dialog(opts, undefined, { method: "input", title, placeholder }, str),
      editor: (title, prefill) => dialog(undefined, undefined, { method: "editor", title, prefill }, str),
      notify: (message, type) => fireAndForget({ method: "notify", message, notifyType: type }),
      setStatus: (key, text) => fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined as never,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return currentTheme();
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching not supported in Sova" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

/** Listeners told each time a hosted chat's run settles (attention signals, tags). A registry, not
    an import, so those modules can import the list without a cycle back into this one. */
const settledListeners = new Set<(path: string) => void>();
export function onAgentSettled(fn: (path: string) => void): () => void {
  settledListeners.add(fn);
  return () => settledListeners.delete(fn);
}
function settledTurn(path: string): void {
  for (const fn of settledListeners) {
    try {
      fn(path);
    } catch (err) {
      console.error("[chat] agent_settled listener failed", err);
    }
  }
}

const sessions = new Map<string, Promise<ChatSession>>();
/** Fully opened runtimes by canonical path (pending opens are not here), for sync busy lookups. */
const held = new Map<string, ChatSession>();

/** Close a held runtime for good (archive/close): any open tab is told to reconnect, and the
    session reopens on demand. A running turn is aborted and its workers die with it. */
export async function disposeHeldChat(path: string, message: string): Promise<boolean> {
  const chat = held.get(path);
  if (!chat || chat.disposed) return false;
  chat.broadcast({ type: "error", code: "reloaded", message });
  await chat.dispose();
  return true;
}

/** SessionSummary.pendingDialogs: live-pending extension dialogs of a chat this server holds. */
export function pendingDialogCount(path: string): number {
  const chat = held.get(path);
  return chat && !chat.disposed ? chat.pendingDialogs().length : 0;
}

/** SessionSummary.busy: this server holds the runtime and an agent run is in progress. */
export function isSessionBusy(path: string): boolean {
  const chat = held.get(path);
  return !!chat && !chat.disposed && chat.session.isStreaming;
}

/** A model as the runtime resolves it, without naming pi-ai's `Model` (not re-exported by the SDK entry). */
type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * The model a MESSAGE-LESS session records for itself, for openSession to pass as
 * `createAgentSessionFromServices`' `model`. The SDK restores a session's recorded model only
 * when the branch already has messages (sdk.js gates the restore on `messages.length > 0`), and
 * a fresh fanout member is created with a model_change and nothing else — so without this, its
 * runtime resolves the server default and the member's first turn runs a model nobody chose.
 * Once the branch has messages the SDK does this itself, which is why the message-less case is
 * the only one answered here. The two guards are the SDK's own restore guards (getModel, then
 * hasConfiguredAuth): on either failure the answer is undefined and the SDK falls back —
 * binding a member's model must never fail the open.
 */
export function recordedModelForEmptyBranch(
  sessionManager: Pick<SessionManager, "buildSessionContext">,
  modelRuntime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
): ResolvedModel | undefined {
  const context = sessionManager.buildSessionContext();
  if (context.messages.length > 0 || !context.model) return undefined;
  const model = modelRuntime.getModel(context.model.provider, context.model.modelId);
  return model && modelRuntime.hasConfiguredAuth(model.provider) ? model : undefined;
}

/** The recorded member choice outranks an eligible global default; undefined leaves the SDK
 *  to choose. savedDefault has already passed the pristine-session and available/auth checks. */
export function modelForSessionOpen(
  sessionManager: Pick<SessionManager, "buildSessionContext">,
  modelRuntime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
  savedDefault: ResolvedModel | undefined,
): ResolvedModel | undefined {
  return recordedModelForEmptyBranch(sessionManager, modelRuntime) ?? savedDefault;
}

/** A branch's resolved context, as buildSessionContext() reports it. */
type BranchContext = ReturnType<SessionManager["buildSessionContext"]>;

/**
 * Whether the runtime's construction-time model append only restates what the branch already
 * records. The SDK appends the model it was built with for a session with no messages
 * (sdk.js:261), and a fanout member's file was written with exactly that model at creation — so
 * deferring it lands a second identical `model_change` on the first prompt, and transcript.ts
 * renders one `Model:` row per entry: every member's pane would open with the same row twice.
 * Both halves of the condition are load-bearing. With messages on the branch that append is the
 * SDK's own resume record, and a pair that differs from the recorded one is a real change (the
 * fallback default after an unauthenticated recorded model) — those must still be written.
 */
export function restatesRecordedModel(context: BranchContext, provider: string, modelId: string): boolean {
  if (context.messages.length > 0 || !context.model) return false;
  return context.model.provider === provider && context.model.modelId === modelId;
}

async function overseerLoadout(path: string) {
  if (!overseerRuntime) throw new Error("The Overseer is not available on this server.");
  return overseerRuntime.loadout(path);
}

/** Bring an opened Overseer runtime to overseer.json's model and thinking, without the composer's
    write-back (the setting is already what it says). Stale or unauthenticated choices are skipped. */
async function syncOverseerModel(chat: ChatSession, modelRuntime: ModelRuntime, path: string): Promise<void> {
  const want = await overseerLoadout(path);
  const session = chat.session;
  if (want.model && want.model !== modelLabel(session) && modelAllowed(readModelPolicy(), want.model)) {
    const model = (await modelRuntime.getAvailable().catch(() => [])).find((m) => `${m.provider}/${m.id}` === want.model);
    if (model) await session.setModel(model);
  }
  if (want.thinking && want.thinking !== session.thinkingLevel && (THINKING_LEVELS as readonly string[]).includes(want.thinking))
    session.setThinkingLevel(want.thinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
}

async function openSession(path: string, onDisposed: () => void): Promise<ChatSession> {
  if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
  const modelRuntime = await getModelRuntime();
  const sessionManager = SessionManager.open(path);
  // The SDK records model/thinking-level entries while constructing a session (for sessions with
  // no messages yet, or no thinking entry on the branch). Queue them and write them just before
  // the first prompt, so merely opening (browsing) a session never modifies its file.
  const deferred: Array<() => void> = [];
  const appendModelChange = sessionManager.appendModelChange;
  const appendThinkingLevelChange = sessionManager.appendThinkingLevelChange;
  // Everything is deferred except the one append restatesRecordedModel names — see its comment
  // for why that restatement must be dropped rather than queued. Reading the context once, before
  // the runtime exists, is what lets the filter answer without touching the file.
  const openContext = sessionManager.buildSessionContext();
  sessionManager.appendModelChange = (...args: Parameters<typeof appendModelChange>) => {
    if (restatesRecordedModel(openContext, args[0], args[1])) return "";
    deferred.push(() => appendModelChange.apply(sessionManager, args));
    return "";
  };
  sessionManager.appendThinkingLevelChange = (...args: Parameters<typeof appendThinkingLevelChange>) => {
    deferred.push(() => appendThinkingLevelChange.apply(sessionManager, args));
    return "";
  };
  const restore = () => {
    sessionManager.appendModelChange = appendModelChange;
    sessionManager.appendThinkingLevelChange = appendThinkingLevelChange;
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    // The outline opt-in is declined for a FANOUT MEMBER, and the FILE says so, not a flag
    // threaded through acquireChat: its creation wrote the FANOUT_MEMBER_ENTRY marker beside the
    // model change, so the member opens WITHOUT the opt-in and lands in the extension's own
    // default, and the marker survives restarts. Everything else about the loadout — `target`,
    // the experimental claude-code switch — is the same sessionFlags() every runtime gets.
    // The Overseer (server/overseer.ts) is recognised the same way, by its marker, and gets its own
    // loadout: its prompt appended after the user's APPEND_SYSTEM.md, its sova_* tools, a tool
    // allowlist, no topic outline (nobody lists it), and its model from overseer.json.
    const special = isOverseerFile(sessionManager) ? await overseerLoadout(path) : null;
    const services = special
      ? await servicesForCwd(cwd, modelRuntime, false, special.resourceLoaderOptions)
      : await servicesForCwd(cwd, modelRuntime, !isFanoutMember(sessionManager));
    for (const d of services.diagnostics) console.warn(`[chat] runtime ${d.type}: ${d.message}`);
    // A session with no messages yet starts from the saved new-session defaults (web-defaults.ts):
    // resolve the stored model ref against models with configured auth and let the SDK clamp the
    // stored level to the model's ladder. Anything stale or unauthenticated is skipped, so a bad
    // default degrades to pi's own default instead of failing the open.
    let defaultModel: Awaited<ReturnType<typeof modelRuntime.getAvailable>>[number] | undefined;
    let defaultThinking: ThinkingLevel | undefined;
    if (!sessionManager.getBranch().some((e) => e.type === "message" && e.message.role === "user")) {
      const defaults = special ? { model: special.model ?? undefined, thinking: special.thinking ?? undefined } : loadDefaults();
      // A stored default the user has since turned off is stale like any other: skipped here, so
      // the session opens on pi's own default rather than on a model it would refuse to send with.
      if (defaults.model && modelAllowed(readModelPolicy(), defaults.model))
        defaultModel = (await modelRuntime.getAvailable().catch(() => [])).find(
          (m) => `${m.provider}/${m.id}` === defaults.model,
        );
      if (defaults.thinking && (THINKING_LEVELS as readonly string[]).includes(defaults.thinking))
        defaultThinking = defaults.thinking as ThinkingLevel;
    }
    const model = modelForSessionOpen(sessionManager, modelRuntime, defaultModel);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      ...(defaultThinking ? { thinkingLevel: defaultThinking as Parameters<AgentSession["setThinkingLevel"]>[0] } : {}), // same cast as setThinkingLevel above: our ladder has "off", the SDK's union doesn't
      ...(special ? { tools: special.tools, ...(special.customTools ? { customTools: special.customTools } : {}) } : {}),
    });
    // The Overseer tells a message the user sent from every other by the object it reaches the Agent as.
    if (special) overseerRuntime?.watchSession(created.session);
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
  const sessionCwd = sessionManager.getCwd();
  // The runtime cannot be built against a directory that is gone. Check before doing the work, so
  // the failure is classified (ConfigError, not "internal") and cheap to repeat.
  const openCwd = sessionCwd ? resolveOpenCwd(path, sessionCwd) : sessionCwd;
  try {
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: openCwd,
      agentDir: getAgentDir(),
      sessionManager,
    });
    const chat = new ChatSession(path, runtime, onDisposed);
    try {
      await chat.bind();
    } catch (err) {
      await chat.dispose();
      throw err;
    }
    chat.deferredAppends = deferred;
    if (isOverseerFile(sessionManager)) {
      chat.overseer = true;
      // A conversation that already has messages keeps the model its file records (the SDK restores
      // it); overseer.json is the Overseer's setting, so bring the runtime to it now. The appends
      // this makes are still deferred (the patch above is live until `restore`), so opening writes
      // nothing, like any other open.
      await syncOverseerModel(chat, modelRuntime, path).catch((err) =>
        console.warn(`[overseer] model sync skipped: ${err instanceof Error ? err.message : String(err)}`),
      );
      await overseerRuntime?.opened(chat);
    }
    held.set(path, chat);
    return chat;
  } catch (err) {
    const config = asConfigError(err, sessionCwd);
    throw config ?? err;
  } finally {
    restore();
  }
}

/**
 * Get (or open) the shared runtime for a session file. Throws BusyError when a TUI owns it,
 * or (unless `force`) when another process may be writing it. Concurrent callers share one
 * open attempt; failures are not cached.
 */
export async function acquireChat(path: string, force = false): Promise<ChatSession> {
  const existing = sessions.get(path);
  if (existing) {
    const chat = await existing.catch(() => null);
    if (chat && !chat.disposed) {
      assertNotLive(path);
      if (chat.hasForeignWrites()) {
        if (!force) throw new BusyError(chat.busyMessage(), "recent");
        // "Chat anyway": our in-memory tree is stale, so reload from disk instead of appending to it.
        chat.broadcast({ type: "error", code: "reloaded", message: "Session was reloaded by another client; reconnect" });
        await chat.dispose();
      } else {
        return chat;
      }
    }
  }
  assertNotLive(path);
  // The cheap pre-checks before the expensive open (model runtime, extensions, SDK session).
  const cwd = storedCwd(path);
  // Permanent and already known: answer from the memo. Retrying would repeat the same SDK open and
  // hand the client another copy of an error it cannot act on. `force` does not apply — no flag
  // makes a deleted directory exist.
  const known = activeConfigFailure(path);
  if (known) throw known;
  // Detect it cheaply on the first connect too: the header's cwd is all it takes, and the open
  // below would otherwise build a model runtime before the SDK reached the same conclusion.
  if (cwd && !existsSync(cwd)) {
    const failure = new ConfigError(`Stored session working directory does not exist: ${cwd}\nSession file: ${path}`, cwd);
    configFailures.set(path, failure);
    throw failure;
  }
  if (!force) {
    // Shared constant with the frontend: RECENT_WRITE_MS (120s) in server/write-guard.ts.
    const age = recentForeignWriteAgeSec(path);
    if (age !== null) throw new BusyError(`modified ${age}s ago by a process we can't identify`, "recent");
  }
  const forget = () => {
    if (sessions.get(path) === p) sessions.delete(path);
  };
  const p = openSession(path, forget);
  sessions.set(path, p);
  p.catch((err) => {
    // Transient failures are forgotten so the next connect retries; permanent ones are recorded so
    // it doesn't.
    if (err instanceof ConfigError) configFailures.set(path, err);
    forget();
  });
  return p;
}

/** Every fully opened runtime this server holds. Each keeps its own mode; there is no fan-out. */
export const heldChats = (): ChatSession[] => [...held.values()].filter((c) => !c.disposed);

/** The open chat for a session file (already through resolveSessionPath), for POST /api/mode?path=. */
export const heldChat = (path: string): ChatSession | undefined => heldChats().find((c) => c.path === path);

export async function disposeAllChats(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((p) => p.then((c) => c.dispose()).catch(() => {})));
}

export type { ChatSession };
