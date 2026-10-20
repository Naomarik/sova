import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { type ChatDialogInfo, type ChatLifecycleEvent, type ChatRunEvent, type ChatSpecialKind, type RunStartAnswer, type ServerToolCall, type ServerToolDecl, type ServerToolOutcome, type SpecialSpec, unsentRefusal, type WorkerHost, type WorkerSpec } from "../shared/chat-runtime";
import { BUILTIN_TOOLS as WORKER_BUILTIN_TOOLS, WORKER_HOST_DISCOVER_EVENT, WORKER_HOST_EVENT, type WorkerHostAnnouncement } from "../pi-config/extensions/subagents/worker-host.ts";
import { prepareOwnerArea } from "../shared/decisions";
import { LOGIN_UNCHANGED } from "../shared/protocol";
import { type BatonSentData, OPERATOR } from "../shared/baton";
import type { ChatClaudeLogin, ChatClientMessage, ChatModeResult, ChatServerMessage, HeldChatState, V1EventFrame, V2EventFrame, ModeApplies, ModeInfo, OverseerDialogAnswerData, ProjectModeApproval, ProjectModeApprovalNeeded, OverseerSentMarkerData, QueueItem, RegenerateRefusal, SandboxApplyResult, SandboxInfo, SlashCommand, TranscriptItem, WorkerInfo } from "../shared/protocol";
import { COMPACT_COMMAND, COMPACT_IMAGES_REFUSAL, compactCommand } from "../shared/compact";
import type { LinkedAgentInfo } from "../shared/mesh-links";
import { isLinkMessage, parseLinkMessage } from "../shared/link-message";
import { isTopicBatch } from "../shared/topic-message";
import { parseWakeNudge } from "../shared/wake";
import { inputSourceOf, type QueueImage, type QueueKind, WebQueue, type WebQueueItem } from "./queue";
import { decodeWorkers } from "./insights";
import { readLive, readOwnLiveRecords, workerCountsOf } from "./live";
import { sessionsChanged } from "./list-generation";
import { appliesAfter, type BranchEntries, chatModeOf, defaultPatchOf, mergeMode, MINOR_MODES, modeApplyPlan, modeInfo, pinEntryFor, readMode, writeMode, type ModePatch, type ModeState } from "./mode-state";
import { loadDefaults, saveDefaults } from "./web-defaults";
import { subagentProfilesInfo, requireSubagentProfile, saveSubagentProfileDefault } from "./subagent-profiles";
import { restorePick, pickEntryFor } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { modelAllowed, modelDenial, readModelPolicy } from "./model-policy";
import { toContextInfo, workerWindowResolver } from "./models";
import { claudeSpawnModels, WorkerContextReader, withWorkerContext } from "./worker-context";
import { resumeWorker, type ResumeOutcome } from "./worker-resume";
import { applySandbox, onSandboxAppend, sandboxInfo, sandboxMessage, type SandboxHost } from "./sandbox-state";
import type { SandboxState } from "../pi-config/extensions/sandbox/state.ts";
import { chatClaudeLogin, claudeLoginAfterHello, claudeLoginMessage, isClaudeLoginEntry, LoginPick, loginName } from "./claude-login-state";
import { rowsOf, rowsOfEntry } from "./transcript";
import { onWire, onWire1, withRows, type ReplyLookup } from "./wire-rows";
import { perfRecordOf, ReplyTimer, type ReplyOutcome } from "./reply-timing";
import { appendPerfRecord, replyTimingOf, type PerfKind } from "./perf-record";
import { replyTimingsOf } from "./reply-facts";
import type { ReplyTiming } from "../shared/harness-wire";
import { producerId } from "../pi-config/extensions/llm-inflight/tracker.ts";
import { readDeviceId } from "../pi-config/extensions/llm-inflight/usage-record.ts";
import type { CompactOutcome, DialogBridge, EntryId, HarnessEvent, HarnessSession, HEntry, HookCtx, ImageInput, SessionState, SessionStateWriter, StateKind, StateView, ToolCtx, ToolResult, ToolSpec, ToolUpdate } from "../shared/harness";
import { branchOf, historyOf, lineHeader, readPi, storedAsString } from "./harness/pi/reader";
import { stateView } from "./harness/state-view";
import { LiveTail } from "./chat-runtime/live-tail";
import { takeWriterLock, type WriterLock, WriterLockHeld } from "./chat-runtime/writer-lock";
import { extensionFlagValues, getModelRuntime, openPiSession, type OpenFlags, type OpenRead, type PiBuild, type PiModelRuntime, warmClaudeCodeProvider as warmPiProvider } from "./harness/pi/open";
import type { PiExtensionAPI, PiLoaderOptions, PiToolDefinition } from "./harness/pi/extension-types";
import { PiChatHost } from "./harness/pi/host";
import { contextOfBranch } from "./harness/pi/usage";
import { extensionEntries } from "./harness/pi/state";
import { isAlreadyProcessing } from "./harness/pi/session";
import { isCompactionInProgress } from "./harness/pi/history-ops";
import { ALIGN_LAUNCH, type AlignLaunchData, BATON_SENT, FANOUT_MEMBER, LINK_MEMBER, LOADOUT, MEMORY, MODE, OVERSEER, OVERSEER_DIALOG_ANSWER, OVERSEER_SENT, PROFILE, SESSION_SENT, SUBAGENT_PROFILE, TOPIC_DELIVERED, stateKindOf } from "./harness/state-kinds";
import { piPrepare, toolCtx, toPiTool } from "./harness/pi/tools";
import { forgetSpecial, specialLoadout, specialWriter } from "./chat-special";
import { cutTail, helloAfterHave, type HistoryPart, pullFields } from "./tail-hello";
import { isOverseerId } from "./overseer-store";
import { attachStreamGuard, capsFor, type StreamTrip } from "./stream-guard";
import { targetOfCwd } from "./targets";
import { sovaToken } from "./auth";
import { ForeignWriteGuard, markOwned, markOwnedStat, recentForeignWriteAgeSec } from "./write-guard";
import { monitorExtension } from "./resource-monitor";
import { forkCacheExtension } from "../pi-config/extensions/subagents/fork/cache.ts";
import { codemodeFactory } from "./harness/pi/codemode";
import { claimSessionSlot, holdingSlot } from "./provider-limits";
import { VIS_CHECK_TOOL, visCheckExtension, type VisCheckHost } from "./vis-check";
import { MEMORY_COMPACTION_REFUSAL, memoryExtension, type MemoryHost } from "./harness/pi/memory";
import { playbookExtension, type PlaybookHost } from "./harness/pi/playbook";
import { playbookHost } from "./playbook-host";
import { ChatMemory } from "./memory/chat";
import { readOverseerSettings } from "./overseer-store";

/** An overseer's own memory switch in force: the Overseer's from the state root's
    overseer.json, a project overseer's from the file its loadout names; no saved choice = on, UniiChat 128 KB. */
function overseerMemoryNow(file: string | undefined): OverseerMemorySetting {
  if (!file) return overseerMemoryOf(readOverseerSettings().memory);
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(file, "utf8")) as { memory?: unknown } | null)?.memory;
  } catch {
    raw = undefined;
  }
  return overseerMemoryOf(parseOverseerMemory(raw));
}
import { withWebMinors } from "./memory/permit";
import { approvalNeededText, checkProjectSwitch, listingFor, projectModesInfo } from "./project-mode-menu";
import { isApproved, isApprovedByUser, recordApproval } from "./project-mode-approvals";
import { ModeActions, notHereFor, type ModeCommandOutcome } from "./mode-commands";
import { projectModesOf, restoreProjectSnapshots } from "../pi-config/extensions/mode/state.ts";
import { PROJECT_MODE_PREFIX, type ProjectModeRef } from "../shared/project-modes";
import { applyMemoryPatch, overseerMemoryOf, type OverseerMemorySetting, parseOverseerMemory, saveDefaultMemoryChoice } from "./memory/settings";
import { MEMORY_TOOLS } from "../shared/memory";
import { projectEngine } from "./project-services/routes";
import { projectVerbsExtension, sessionInstanceNote } from "./project-services/tools";
import { servedToolsExtension, servedVisToolsExtension } from "./served-tools";
import { TOUR_TOOLS } from "../shared/tour";
import { tourTools } from "./tours/tools";
import { excludedTools, GRANT_TOOLS, keyOf, KNOWN_REMOVABLE_TOOLS, parseMine, singletonRaceText, type ProfileEntryData, type SessionSentData } from "../shared/profiles";
import { loadoutOverrides, type LoadoutEntryData, type LoadoutState } from "./session-loadout";
import { RunState, SessionLimits, sessionPowersExtension } from "./session-powers";
import { QUEUE_OPEN_TOOL, queuePushExtension, topicStore } from "./topics";
import { noteUsageSession, registerUsageSession, resolveUsageAttribution } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { reviewSaved } from "./web-settings";
import { visToolsWanted } from "../pi-config/extensions/mode/minor.ts";
import { alignForPick } from "./align-settings";
import { agentRoot } from "./state-root";
import { UserTurns } from "./user-turns";
import { markBackground } from "../pi-config/extensions/provider-limits/gate.ts";

const GUARD_POLL_MS = 3000;
const PERF_KINDS_SET: ReadonlySet<string> = new Set(["main", "worker", "overseer"]);
/** The entry a message was written as, or null. */
const safeId = (harness: HarnessSession, message: unknown): string | null => {
  try {
    return harness.persistedId(message);
  } catch {
    return null;
  }
};
/** Hosted workers' context fill, read off their transcripts' tails; shared, mtime-gated. */
const workerContextReader = new WorkerContextReader();

/** This server's own bound origin, for the `link` extension's `sova-link` flag (setLinkOrigin). */
let linkOrigin: string | null = null;
/** Set once the listener is bound (server/index.ts, through server/link-delivery.ts); runtimes
    opened from then on get it. */
export function setLinkOrigin(origin: string): void {
  linkOrigin = origin;
}
export const currentLinkOrigin = (): string | null => linkOrigin;
/** The token the link tools send back (§app.access/callers): this server's own, unless the process
    hosting the chat was handed its server's (a chat process, §app/chat-processes). */
let linkToken: string | null = null;
export function setLinkToken(token: string | null): void {
  linkToken = token;
}

/** Where a chat's runs in flight are recorded, for resuming what a death cuts off: the chat process's
    in-flight marker (§app.chat-processes/crash). Unset (the server's own process): nowhere. */
export interface RunRecorder {
  started(path: string): void;
  settled(path: string): void;
  markResuming(path: string): void;
}
const NO_RECORDER: RunRecorder = { started() {}, settled() {}, markResuming() {} };
let runRecorder: RunRecorder = NO_RECORDER;
export function setRunRecorder(r: RunRecorder | null): void {
  runRecorder = r ?? NO_RECORDER;
}
/**
 * An ordinary chat's server-hosted tools in a chat process of its own (§app/chat-processes): the
 * declarations of `project_verbs` and `queue_push`, in loadout order, which the chat registers in
 * place of the extensions that would run them in this process (whose singletons are not wired
 * there). Unset (the server's own process): the tools run here.
 */
let servedDecls: readonly ServerToolDecl[] | null = null;
export function setServedTools(decls: readonly ServerToolDecl[] | null): void {
  servedDecls = decls;
}

/** What an ordinary chat's extensions ask the server that no setter of their own reaches: the
    playbook host and the instance note's render. Unset, this server's own. */
export interface ChatHosts {
  playbook?: PlaybookHost;
  instanceNote?: (ctx: HookCtx) => Promise<string | null>;
}
let chatHosts: ChatHosts = {};
export function setChatHosts(h: ChatHosts): void {
  chatHosts = h;
}

/** A pane's "Reload now" (`reload_code`), where the process hosting the chat runs code of its own
    (a chat process, §app.chat-processes/code-pickup). Unset: the chat runs the server's code. */
let codeReload: ((client: ChatClient) => void) | null = null;
export function setCodeReload(fn: ((client: ChatClient) => void) | null): void {
  codeReload = fn;
}

/** The chat's next run is a resume: cut off again, it is not resumed a second time. */
export const markRunResuming = (path: string): void => runRecorder.markResuming(path);

/**
 * The extension flags every webapp-hosted runtime starts with (named in pi's words by
 * server/harness/pi/open.ts, OpenFlags).
 *
 * - topic outline: topic-outline only summarizes in the TUI unless its host opts in;
 *   opt in so web chats get outlines.
 *   Workers never get it, and neither does a session carrying an older build's group-member
 *   marker (`outline: false`, FANOUT_MEMBER_ENTRY).
 * - `target`: a remote session (cwd = a target placeholder, server/targets.ts) switches
 *   pi-config's remote extension on for that target.
 * - the Claude Code provider: always set, so the claude-code extension registers the Claude Code
 *   CLI's models as first-class pi models (§app.claude-code-provider/always-on). With no `claude`
 *   CLI the extension registers nothing and the session carries on.
 * - the link: this server's own bound origin (setLinkOrigin), switching pi-config's `link`
 *   extension on (its tools call the /api/mesh/links/* routes), and which tools it registers
 *   (§mesh.links/tools): `member` for a link member session (its LINK_MEMBER marker, written by its
 *   create), all seven from its start; `legacy` for every other: all seven once it is in a live link
 *   (the extension asks the server's `sova:link-live` hook, app.ts), at its next request, else only
 *   the tools its transcript already declares (a session an earlier build hosted); either is dropped
 *   at a compaction that finds it in no live link. Absent until
 *   the listener is bound; workers and the TUI never get it, so they register no link tool. Beside it,
 *   this server's per-install token, which the link tools send back as `x-sova-token`
 *   (§app.access/callers). In-process only: never argv, never env.
 * - adversarial review and the align mode's Visuals: what the chat's launch record says
 *   (§chat.alignment-review/flag, §chat.alignment/visuals; ALIGN_LAUNCH, alignLaunchOf), so a chat keeps
 *   what it began with across every later start. Without a record (a caller with no chat), the review
 *   switch as saved now, and no Visuals flag (the extension then reads mode-align.json itself).
 */
function sessionFlags(cwd: string, outline = true, linkTools: "member" | "legacy" = "legacy", launch?: AlignLaunchData): OpenFlags {
  const flags: OpenFlags = { outline };
  const target = targetOfCwd(cwd);
  if (target) flags.target = target;
  flags.claudeCode = true;
  if (launch ? launch.review : reviewSaved()) flags.review = true;
  if (launch) flags.alignVisuals = launch.visuals;
  if (linkOrigin) flags.link = { origin: linkOrigin, token: linkToken ?? sovaToken(), tools: linkTools };
  return flags;
}

/** The extension flags a runtime is handed: none for a loadout that loads no extension (a flag
    nobody registered only logs "Unknown option"), else sessionFlags. Exported for the tests. */
export function extensionFlagsFor(cwd: string, outline: boolean, noExtensions: boolean, linkTools: "member" | "legacy" = "legacy", launch?: AlignLaunchData): Map<string, boolean | string> {
  return noExtensions ? new Map() : extensionFlagValues(sessionFlags(cwd, outline, linkTools, launch));
}

/** A chat's launch values and whether its file holds them yet. */
export interface AlignLaunch {
  data: AlignLaunchData | null;
  recorded: boolean;
}

/**
 * What a chat's align mode starts with (§chat.alignment-review/flag, §chat.alignment/visuals): its launch
 * record when the file has one (`recorded`), else what its first start takes now — the review switch as
 * saved, and Visuals by the chat's subagent profile (its pick on the branch, else this device's default),
 * else mode-align.json. The caller writes an unrecorded one with the chat's first message.
 */
export function alignLaunchOf(state: Pick<SessionState, "branch" | "file">): AlignLaunch & { data: AlignLaunchData } {
  const recorded = state.file().first(ALIGN_LAUNCH)?.data;
  if (recorded) return { data: recorded, recorded: true };
  const pick = state.branch().latest(SUBAGENT_PROFILE)?.data.profile;
  return { data: { v: 1, review: reviewSaved(), visuals: alignForPick(pick).visuals }, recorded: false };
}

/** The extensions every ordinary session loads beyond pi-config's: resource monitoring, inherited
    fork-cache affinity, and pi's codemode tool (registered inactive: the codemode minor mode turns it
    on, §chat.mode-menu/codemode; in a Claude Code chat it is a fixed stub). None changes prompt
    sections or tool declarations by loading. A caller that passes its own list for an ordinary session
    starts from this one; the special loadouts keep exactly their own. */
const DEFAULT_EXTENSION_FACTORIES = [
  { name: "sova-resource-monitor", factory: monitorExtension },
  { name: "sova-fork-cache", factory: forkCacheExtension },
  codemodeFactory({
    allowed: (ref) => modelAllowed(readModelPolicy(), ref),
    acquire: (provider, opts) => claimSessionSlot(provider, opts),
    holding: holdingSlot,
  }),
];

/** Register the Claude Code provider without waiting for the user to open a session: a throwaway
    session with the default extensions and the provider flag alone (server/harness/pi/open.ts).
    Best-effort; never throws. `onStep` hears each step as it begins (§app.chat-processes/boot-log). */
export function warmClaudeCodeProvider(modelRuntime: PiModelRuntime, cwd: string, onStep?: (step: string) => void): Promise<void> {
  return warmPiProvider(modelRuntime, cwd, DEFAULT_EXTENSION_FACTORIES, onStep);
}

let runtimeWarm: Promise<void> | null = null;
/**
 * The chat runtime's own start, once per process: its instrumented model runtime (getModelRuntime
 * counts every call it makes) with the Claude Code provider registered in it, whatever extensions
 * the chats it opens load. A loadout that loads no extension (a project overseer, a baton) never
 * registers the provider itself, so once this has started its open waits for it. Best-effort; never
 * throws. `onStep` hears Sova's name for each step as it begins: a chat process's start-up trail
 * (§app.chat-processes/boot-log, recorded by server/chat-runtime/main.ts). By default nothing hears
 * them, and the server's own warm-up passes none: it logs and sends nothing of a trail.
 */
export function warmChatRuntime(onStep: (step: string) => void = () => {}): Promise<void> {
  if (runtimeWarm) return runtimeWarm;
  onStep("model setup");
  runtimeWarm = getModelRuntime().then(
    (runtime) => warmClaudeCodeProvider(runtime, agentRoot(), onStep),
    (err) => console.warn("[chat] claude-code warm-up skipped:", err instanceof Error ? err.message : String(err)),
  );
  return runtimeWarm;
}

/** pi's ThinkingLevel ladder (see server/models.ts, which mirrors the semantics). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** How many sends' client ids a chat remembers as taken (ChatSession.takenSends). */
const TAKEN_SENDS_MAX = 1000;

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
 *  (server/overseer.ts keepNormal), and a baton session has no mode at all (§app.baton/goal-and-loadout).
 *  POST /api/mode answers it with a 409. */
/** A gesture this session refuses by its rules (a baton session's composer while someone else
 *  holds the baton, a mode switch where there is no mode): reported with code "refused" and its
 *  own message, never as an internal failure. */
export class RefusedError extends Error {}

/** The /ws/chat error code of a failure. */
const errorCode = (err: unknown) => (err instanceof BusyError ? err.code : err instanceof RefusedError ? ("refused" as const) : ("internal" as const));

export class ModeRefusedError extends RefusedError {
  constructor(message = "The Overseer is always in normal mode.") {
    super(message);
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
 * Throw the open's permanent config failure, if the chat has one, and remember it: the cheap check
 * before any expensive open, in this process or a chat process of its own (chat-host.ts).
 */
export function assertOpenConfig(path: string): void {
  // Permanent and already known: answer from the memo. Retrying would repeat the same SDK open and
  // hand the client another copy of an error it cannot act on. `force` does not apply — no flag
  // makes a deleted directory exist.
  const known = activeConfigFailure(path);
  if (known) throw known;
  // Detect it cheaply on the first connect too: the header's cwd is all it takes, and the open
  // would otherwise build a model runtime before the SDK reached the same conclusion.
  const cwd = cwdOverride(path) ?? storedCwd(path);
  if (cwd && !existsSync(cwd)) {
    const failure = new ConfigError(`Stored session working directory does not exist: ${cwd}\nSession file: ${path}`, cwd);
    configFailures.set(path, failure);
    throw failure;
  }
}

/** Remember a permanent failure an open found elsewhere (a chat process's refusal). */
export function recordConfigFailure(path: string, err: ConfigError): void {
  configFailures.set(path, err);
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
    const cwd = lineHeader(firstLine)?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
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
  send(msg: ChatServerMessage | V2EventFrame): void;
  /** The same message already serialized (server/ws.ts): a hello or history made once for every
      client that gets it. Without it, `send`. */
  sendRaw?(json: string): void;
  /** Asked for wire 2 (`/ws/chat?wire=2`, shared/protocol.ts WireVersion): its events and rows are
      mapped (server/wire-rows.ts). Absent: wire 1, every message as it always was. */
  wire?: 2;
  /** Asked for newest rows first (`/ws/chat?tail=1`): its hellos are cut (server/tail-hello.ts). */
  tail?: boolean;
  /** …and fetches the older rows itself (`?tail=rest`, server/transcript-rows.ts): no history is
      pushed, and its hellos carry `olderSummary` (and `prefetch`, for a browser on this machine). */
  pull?: { prefetch: boolean };
  /** Called after each hello this client is sent at its attach (greet), for what the host says to a
      pane after its hello (its chat process's code state): the hello may wait (attach). */
  greeted?(): void;
  /** …and already holds the rows up to this one (`?have=`, §chat.transcript/instant-open): its
      first hello carries only the rows after it, when it can (server/tail-hello.ts `afterHave`). */
  have?: string;
  /** End this browser's socket (server/ws.ts): a chat whose process died tells it so, then closes
      it so it reconnects (§app.chat-processes/crash). */
  close?(code: number, reason: string): void;
}

const wireOfClient = (client: ChatClient) => client.wire ?? 1;

/** A message on each wire (its rows mapped for wire 2, server/wire-rows.ts), each made and serialized at
    most once however many clients get it. */
type PerWire = (wire: 1 | 2) => { msg: ChatServerMessage; json?: string };
function perWire(msg: ChatServerMessage, replies?: ReplyLookup): PerWire {
  const made: { 1?: { msg: ChatServerMessage; json?: string }; 2?: { msg: ChatServerMessage; json?: string } } = {};
  return (wire) => (made[wire] ??= { msg: withRows(msg, wire, replies) });
}

/** The message to one client, on its wire, serialized once for every client that takes JSON. */
function deliver(client: ChatClient, msg: PerWire): void {
  const on = msg(wireOfClient(client));
  if (client.sendRaw) client.sendRaw((on.json ??= JSON.stringify(on.msg)));
  else client.send(on.msg);
}

/** A hello cut for tail clients: the hello they get, and the history that follows it. Cut on wire-1
    rows (their JSON sizes), so both wires cut at the same rows. */
export interface CutHello {
  hello: Extract<ChatServerMessage, { type: "hello" }>;
  history: HistoryPart[];
  /** The history on wire 2, made for the first wire-2 client that gets it. */
  history2?: HistoryPart[];
  /** The whole branch's rows, for a `?tail=rest` client's summary of the ones it wasn't sent. */
  all: TranscriptItem[];
}

/** `history`: false when only `?tail=rest` clients get it, who are never pushed any. */
export function cutHello(hello: Extract<ChatServerMessage, { type: "hello" }>, history = true): CutHello {
  const cut = cutTail(hello.items, { history });
  return { hello: cut.older > 0 ? { ...hello, items: cut.items, older: cut.older } : hello, history: cut.history, all: hello.items };
}

/** The cut hello as `client` gets it, on its wire: a `?tail=rest` client's also sums up the rows before it. */
function helloFor(cut: CutHello, client: ChatClient, replies?: ReplyLookup): ChatServerMessage {
  const older = cut.hello.older ?? 0;
  const hello = client.pull && older > 0 ? { ...cut.hello, ...pullFields(cut.all, older, client.pull.prefetch) } : cut.hello;
  return withRows(hello, wireOfClient(client), replies);
}

/** A pane's first hello: when it holds the rows up to `have` (it painted them from the file,
    §chat.transcript/instant-open), only the rows after that one, with `after` naming it and the
    summary counting every row up to it; else the usual cut hello (tail-hello.ts `afterHave`). */
export function firstHelloFor(cut: CutHello, client: ChatClient, replies?: ReplyLookup): ChatServerMessage {
  const after = client.pull && client.have ? helloAfterHave(cut.hello, cut.all, cut.hello.older ?? 0, client.have, client.pull.prefetch) : null;
  return after ? withRows(after, wireOfClient(client), replies) : helloFor(cut, client, replies);
}

/** A cut hello's history to the tail clients that got that hello and are still here. */
function sendHistory(cut: CutHello | null, clients: readonly ChatClient[], still: (c: ChatClient) => boolean, replies?: ReplyLookup): void {
  if (!cut) return;
  for (const c of clients) {
    if (!still(c)) continue;
    const parts = c.wire === 2 ? (cut.history2 ??= cut.history.map((p) => historyOnWire2(p, replies))) : cut.history;
    for (const part of parts) {
      if (c.sendRaw) c.sendRaw(part.raw);
      else c.send(part.msg);
    }
  }
}

const historyOnWire2 = (part: HistoryPart, replies?: ReplyLookup): HistoryPart => {
  const msg = withRows(part.msg, 2, replies);
  return { msg, raw: JSON.stringify(msg) };
};

/** The one pi model runtime this process shares (server/harness/pi/open.ts). */
export { getModelRuntime };

/** Throws BusyError if another process (TUI/CLI) currently owns the session file. */
export function assertNotLive(path: string): void {
  const rec = readLive().get(path);
  if (rec) {
    throw new BusyError(
      `Session is open in another pi process (pid ${rec.pid}, ${rec.mode ?? "tui"}); it is read-only here. Use watch instead.`,
    );
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_RE = /^image\/[\w.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate client OutboundImage[] and convert to pi's ImageContent {type:"image", data, mimeType}
 * (the stored/SDK shape in 0.86.0, pi-ai types.d.ts:256; docs' `source:{type:"base64"}` wrapper is
 * not what the types take).
 */
function parseImages(raw: unknown): ImageInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("images must be an array of {data, mimeType}");
  let total = 0;
  const out: ImageInput[] = [];
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
 * The special kinds that stop a chat themselves call it too.
 */
export async function drainQueueThenAbort(
  session: Pick<HarnessSession, "queue" | "abort">,
  broadcast: (msg: ChatServerMessage) => void,
  /** Sova's own queue, when the chat has one: it drains BOTH its held items and the SDK's (it
      clears the session's queue itself), so Stop keeps meaning "nothing queued survives this".
      Absent leaves the original SDK-only behaviour, which is what a bare session still gets. */
  queue?: { drain(): Promise<{ steering: string[]; followUp: string[] }> },
): Promise<void> {
  // Awaited: the queue's own drain waits out a hand-off parked in an extension `input` handler,
  // so Stop cannot clear "nothing", hand back no text, and then let that message be delivered
  // after the user pressed Stop.
  const { steering, followUp } = queue ? await queue.drain() : session.queue.clear();
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
 * customType of the invisible entry an older build wrote into every member of a group it created
 * in one gesture (§workspace.groups/legacy-groups). Nothing writes it now; it is READ so those
 * sessions keep opening WITHOUT `topic-outline-headless`, as they always did — the marker travels
 * with the file, so the exception holds across restarts. Same shape as REWIND_ENTRY: never LLM
 * context, no usage, rendered nowhere (normalizeEntry's default for custom types).
 */
export const FANOUT_MEMBER_ENTRY = "sova-fanout-member";

/** What a session file is recognised by when it opens: its id and its state over the whole file (a
 *  session being opened, server/harness/pi/open.ts OpenRead, or a held chat's driving session). */
export interface SessionMarks {
  readonly id: string;
  readonly state: { file(): StateView };
}

/** Whether a session file carries that marker. The predicate openSession keys the outline
 *  exception on. */
export function isFanoutMember(s: Pick<SessionMarks, "state">): boolean {
  return s.state.file().has(FANOUT_MEMBER);
}

/** Whether a session file is a link member session: its create wrote the marker (§mesh.links/tools). */
export function isLinkMember(s: Pick<SessionMarks, "state">): boolean {
  return s.state.file().first(LINK_MEMBER) !== null;
}

/** Whether a session file is an Overseer file: it carries the marker its creation wrote
 *  (server/overseer.ts) AND overseer-state.json knows it (the current conversation or one in its
 *  history). A fork of an Overseer file inherits the marker but is known to neither, so it opens
 *  as an ordinary session, as SessionSummary.overseer lists it. */
export function isOverseerFile(s: SessionMarks): boolean {
  return isOverseerId(s.id) && s.state.file().has(OVERSEER);
}

/** The special kinds (§app.harness/session-special): the Overseer, a project overseer, a baton session. */
export type SpecialKind = ChatSpecialKind;

/**
 * What a special chat asks of its kind, which lives in the server (§app.chat-processes/special-kinds):
 * in the server's process a loopback to the kind's SpecialHost (server/chat-handle.ts), in a chat
 * process of its own the chat's socket (server/chat-runtime/host.ts). `local`: what only the loopback
 * reads (the run's live context).
 */
export interface SpecialPort {
  runStart(a: { leafId: string | null; images: boolean }, local?: { ctx: HookCtx }): Promise<RunStartAnswer>;
  compact(a: { leafId: string | null }, local?: { ctx: HookCtx }): Promise<RunStartAnswer["message"] | null>;
  agentEnd(a: { text: string }): Promise<RunStartAnswer["message"] | null>;
  /** Each run event, in the chat's own event; never awaited. */
  runEvent(e: ChatRunEvent): void;
  /** A server action under an effect id of its own (a composer's message, a model choice saved). */
  action(name: "@clientSend" | "@clientSendRefused" | "@saveChoice", args: unknown): Promise<ServerToolOutcome<unknown>>;
  /** Why the composer is closed now, read live (the loopback); absent: the spec's, as last pushed. */
  composerClosed?(): string | null;
}

/**
 * The server's kinds as a chat in its own process reaches them (server/chat-handle.ts installs this,
 * so this module never imports a kind and the dependency points one way). Never consulted for a
 * chat whose spec was set (setSpecialSpec): a chat process takes its kind and loadout from its open.
 */
export interface LocalSpecials {
  /** The kind a session file opens as (the Overseer's first), or null. */
  kindOf(marks: SessionMarks, path: string): SpecialKind | null;
  /** The directory a kind's chat opens in on this host, or undefined: the header's. */
  cwd(path: string): string | undefined;
  /** The loadout of one build, the kind's tools served for this chat; throws the kind's refusal. */
  spec(kind: SpecialKind, path: string): Promise<SpecialSpec>;
  /** The loopback to the kind, for a chat in the caller's process (tests only: the server opens none). */
  port?(kind: SpecialKind, path: string): SpecialPort;
  /** Every open of such a chat, once bound (the kind's `opened`, with the chat's handle). */
  opened?(kind: SpecialKind, chat: ChatSession): Promise<void>;
}
let localSpecials: LocalSpecials | null = null;
export function setLocalSpecials(s: LocalSpecials): void {
  localSpecials = s;
}

/** Specs and ports given before an open (a chat process: from the server's `open`), by path. */
const presetSpecs = new Map<string, SpecialSpec>();
const presetPorts = new Map<string, SpecialPort>();
export function setSpecialSpec(path: string, spec: SpecialSpec | null): void {
  if (spec) presetSpecs.set(path, spec);
  else presetSpecs.delete(path);
}
export function setSpecialPort(path: string, port: SpecialPort | null): void {
  if (port) presetPorts.set(path, port);
  else presetPorts.delete(path);
}
/** The spec a chat process was given for this path, if any. */
export const specialSpecOf = (path: string): SpecialSpec | undefined => presetSpecs.get(path);

/** Worker loadouts given before an open (a worker chat's process: from the server's `open`), by path. */
const presetWorkers = new Map<string, WorkerSpec>();
export function setWorkerSpec(path: string, spec: WorkerSpec | null): void {
  if (spec) presetWorkers.set(path, spec);
  else presetWorkers.delete(path);
}
/** The worker loadout a chat process was given for this path, if any. */
export const workerSpecOf = (path: string): WorkerSpec | undefined => presetWorkers.get(path);

/**
 * Where a parent chat's workers are started (§app.chat-processes/workers): the server's worker
 * registry for a chat in its process, the chat process's link to its server for one in a process of
 * its own. Bound per session; null where neither is installed (no worker host is announced).
 */
let workerHostSource: ((parent: { sessionId: string; path: string }) => WorkerHost) | null = null;
export function setWorkerHostSource(source: ((parent: { sessionId: string; path: string }) => WorkerHost) | null): void {
  workerHostSource = source;
}

/**
 * The inline extension that announces the session's worker host on its bus (WORKER_HOST_EVENT, again
 * on each discover), bound to the session it runs: the subagents extension and the hidden chats start
 * every worker through it.
 */
function workerHostExtension(pi: PiExtensionAPI): void {
  let announcement: WorkerHostAnnouncement | null = null;
  const announce = () => {
    if (announcement) pi.events?.emit(WORKER_HOST_EVENT, announcement);
  };
  pi.events?.on(WORKER_HOST_DISCOVER_EVENT, announce);
  pi.on("session_start", (_event, ctx) => {
    const c = toolCtx(ctx);
    const host = c.key && workerHostSource ? workerHostSource({ sessionId: c.sessionId, path: c.key }) : null;
    announcement = host ? { version: 1, host } : null;
    announce();
  });
}

/**
 * One build of a worker chat (design §2.3): its own extensions only, in its order, discovery off; its
 * flags; the built-ins outside its list excluded (extension tools never filtered); its appended
 * prompt; its model and thinking as a fresh session takes them. Nothing of an ordinary chat.
 */
function workerBuild(w: WorkerSpec): PiBuild {
  return {
    loader: {
      noExtensions: true,
      additionalExtensionPaths: [...w.extensions],
      extensionFactories: [],
      ...(w.appendSystemPrompt ? { appendSystemPrompt: [w.appendSystemPrompt] } : {}),
    },
    flags: () => ({ extra: w.flags }),
    exclude: () => (w.builtins === null ? [] : WORKER_BUILTIN_TOOLS.filter((t) => !w.builtins!.includes(t))),
    // A worker trusts its project's local files as every Sova chat does.
    opening: () => ({
      ...(w.model ? { model: w.model } : {}),
      ...(w.thinking ? { thinking: w.thinking } : {}),
      fresh: { model: !!w.model, thinking: !!w.thinking },
    }),
    forkCacheRouting: false,
  };
}
/** The server's word on the composer of a special chat in this process (`push special`). */
export function setSpecialComposerClosed(path: string, text: string | null): void {
  const spec = presetSpecs.get(path);
  if (spec) spec.composerClosed = text;
  const chat = held.get(path);
  if (chat?.specialSpec) chat.specialSpec.composerClosed = text;
}

/** A special kind's working directory for this file on this host, or undefined: the header's. */
export function cwdOverride(path: string): string | undefined {
  const preset = presetSpecs.get(path);
  if (preset) return preset.cwd ?? undefined;
  return localSpecials?.cwd(path);
}

/** The special kind a session file opens as: the one its open was given, else the server's kinds
    (the Overseer's first). With no kinds here, an Overseer file is still the Overseer's. */
function specialFor(marks: SessionMarks, path: string): SpecialKind | null {
  const preset = presetSpecs.get(path);
  if (preset) return preset.kind;
  if (localSpecials) return localSpecials.kindOf(marks, path);
  return isOverseerFile(marks) ? "overseer" : null;
}

/** One build's special loadout: its spec and the port to its kind. */
async function specialOf(kind: SpecialKind, path: string): Promise<{ spec: SpecialSpec; port: SpecialPort }> {
  const spec = presetSpecs.get(path);
  const port = presetPorts.get(path);
  if (spec && port) return { spec, port };
  if (!localSpecials?.port) throw new Error(kind === "overseer" ? "The Overseer is not available on this server." : "This chat's kind is not available here.");
  return { spec: await localSpecials.spec(kind, path), port: localSpecials.port(kind, path) };
}

/**
 * What a session file opens as, read from the file without building anything: a special kind, a
 * profile that grants powers (`powers`), else null (an ordinary chat). The rule openSession applies,
 * for a host deciding where a chat runs before it opens (§app/chat-processes).
 */
export async function openKindOf(path: string): Promise<SpecialKind | "powers" | null> {
  const file = await readPi(path);
  const all = stateView(file.entries);
  const kind = specialFor({ id: file.header?.id ?? "", state: { file: () => all } }, path);
  if (kind) return kind;
  return stateView(branchOf(file.entries)).latest(PROFILE)?.data?.profile?.grant.length ? "powers" : null;
}

/** What a write guard's throw means to a rewind or a compaction: a BusyError is a refusal ("busy" when
    the TUI owns the file, else "recent"); anything else is a failure. */
export function busyRefusal(err: unknown): { reason: "busy" | "recent"; message: string } | null {
  return err instanceof BusyError ? { reason: err.code === "busy" ? "busy" : "recent", message: err.message } : null;
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
export function resolveRegenerate(branch: readonly HEntry[], entryId: string): RegenerateTarget {
  const notOnBranch = (message: string): RegenerateTarget => ({ ok: false, reason: "not_on_branch", message });
  let index = branch.findIndex((h) => h.id === entryId);
  if (index === -1 && entryId.includes(":")) {
    const stem = entryId.slice(0, entryId.indexOf(":"));
    index = branch.findIndex((h) => h.id === stem);
  }
  if (index === -1) return notOnBranch("That reply is not on this chat's current branch anymore.");
  // Regenerating your own message is Rewind — it hands the text back so you can change it. Saying
  // so here keeps the two gestures from quietly becoming one that resends without asking.
  if (branch[index]!.kind === "user") return notOnBranch("That is your own message; rewind to it to edit and send it again.");
  for (let i = index; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.kind !== "user") continue;
    // A stored string is one text block, so this is the string itself.
    const text = textBlocks(entry.blocks);
    const images = imageBlocks(entry.blocks);
    if (!text.trim() && !images) return notOnBranch("The message that started that turn has nothing left to send.");
    // A WAKE NUDGE is a role:"user" message Sova's own scheduler wrote, rendered as its own card
    // (kind "wake"). Replaying it would put the "[wake_nudge …] Scheduled wakeup fired (set 4m17s
    // ago)" preamble back on the branch as if the user had typed it, with an elapsed time that is
    // now a lie. Nothing here is the user's message, so there is nothing to send again.
    // A tour's sign-in notice (`[tour_sign_in tN]`, §app.tours/sites) parses as a wake too, under its own name.
    const wake = parseWakeNudge(text);
    if (wake)
      return { ok: false, reason: "wake", message: wake.tour ? "That reply answered a tour's sign-in notice, not a message you sent, so there is nothing to send again." : "That reply answered a scheduled wake-up, not a message you sent, so there is nothing to send again." };
    // A partner's message over a link (kind "link", §mesh.links/transcript) is not the user's
    // either; replaying it would redeliver the partner's words as a fresh message.
    if (isLinkMessage(text))
      return { ok: false, reason: "link", message: "That reply answered a message from a linked session, not one you sent, so there is nothing to send again." };
    // A topic batch (kind "topic", §chat.topics/row) is notes other sessions pushed, not the user's.
    if (isTopicBatch(text))
      return { ok: false, reason: "topic", message: "That reply answered notes other sessions pushed to a topic, not a message you sent, so there is nothing to send again." };
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

/** The runtime's commands as pi's rpc get_commands lists them, per runtime/cwd. */
function listCommands(harness: HarnessSession): SlashCommand[] {
  // Sova's own `compact` leads; an extension command of that name could never run from here,
  // because the text is intercepted before pi sees it (ChatSession.handle), so it is not offered.
  return [COMPACT_COMMAND, ...harness.commands().filter((c) => !(c.source === "extension" && c.name === COMPACT_COMMAND.name))];
}

/** A session's title as the list would say it: its name, else its first message, else "Untitled". A first
    message stored as a bare string (legacy files) has never been read for it: "Untitled". */
export function titleOf(branch: readonly HEntry[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind === "setting" && h.what === "name" && typeof h.name === "string" && h.name.trim()) return h.name.trim();
  }
  const first = branch.find((h) => h.kind === "user");
  const t = first && first.kind === "user" && !storedAsString(first) ? textBlocks(first.blocks).replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, 80) : "Untitled";
}

interface PendingUi {
  resolve: (value: unknown) => void;
  /** The ui_request as broadcast (method, title, options…), for the Overseer's view of it. */
  request: Record<string, unknown>;
  since: number;
  /** When its timeout answers it with the fallback (ms epoch); none without a timeout. */
  deadline?: number;
}

/** One live-pending extension dialog of a hosted chat, as the Overseer sees it. */
export type PendingDialog = ChatDialogInfo;

/** Session events after which Sova's queue re-reads the SDK's own queue lengths. `run.settled` and
    `run.end` are here because a turn that ends with our queue non-empty must start the next one;
    without them the queue would wait for an event that never comes. `compaction.end` likewise
    releases what the queue held while a compaction ran (its `paused`). */
const QUEUE_WAKE_EVENTS = new Set<HarnessEvent["type"]>(["queue", "message.start", "turn.end", "run.settled", "run.end", "compaction.end"]);

/** Who a marked message is from: the Overseer (`sova-overseer-sent`, §app.overseer/sent-marker) or a
    baton session's participant (`sova-baton-sent`, §app.baton/attribution). */
type Sender = { kind: "overseer"; overseerId?: string } | { kind: "baton"; by: string } | { kind: "session"; sessionId: string; title: string; hop: number };

/** A message whose user entry still needs its sender marker. `itemId`: it rode in on a queue
    item; `held` while that item has not departed, so the settle sweep leaves the mark alone (its
    message may still be in the SDK's queue). */
type SenderMark = { text: string; sender: Sender; itemId?: string; held?: boolean };

/** `customType` of the invisible marker beside a delivered topic batch (§chat.topics/delivery). */
export const TOPIC_DELIVERED_ENTRY = "sova-topic-delivered";

/** A topic batch handed to the agent whose user entry still needs its marker. `entered` runs once
    that entry exists (the notes are acknowledged then); `gone` when it never will (the turn failed
    first, or the run settled without it). */
export interface TopicBatchMark {
  text: string;
  topic: string;
  batch: string;
  items: { id: string; from: { sessionId: string; title: string }; at: string }[];
  entered(): void;
  gone(): void;
}

/** The sender a queue item carries, if any. */
const senderOfItem = (item: Pick<WebQueueItem, "overseer" | "baton" | "session">): Sender | null =>
  item.overseer
    ? { kind: "overseer", ...(item.overseer.overseerId ? { overseerId: item.overseer.overseerId } : {}) }
    : item.baton
      ? { kind: "baton", by: item.baton.by }
      : item.session
        ? { kind: "session", ...item.session }
        : null;

/** Write a sender's invisible marker for the user entry `targetId`; returns the marker's id. */
function appendSenderMarker(state: SessionStateWriter, targetId: string, sender: Sender): string {
  if (sender.kind === "baton") return state.append(BATON_SENT, { v: 1, targetId, by: sender.by } satisfies BatonSentData);
  if (sender.kind === "session")
    return state.append(SESSION_SENT, { v: 1, targetId, from: { sessionId: sender.sessionId, title: sender.title }, hop: sender.hop } satisfies SessionSentData);
  return state.append(OVERSEER_SENT, { v: 1, targetId, ...(sender.overseerId ? { overseerId: sender.overseerId } : {}) } satisfies OverseerSentMarkerData);
}

/** A runtime's profile (§chat.profiles/enforcement): the branch's snapshot when it was built, and,
    when it grants something, the run state and limits its session tools use. */
export interface ProfileState {
  data: ProfileEntryData | null;
  excluded: string[];
  run?: RunState;
  limits?: SessionLimits;
}

/** The One at a time check at the first message (§chat.profiles/singleton), bound by the module
    that can list sessions (server/session-profile-routes.ts). Resolves to the holder, or null. */
let singletonCheck: ((key: string, path: string) => Promise<{ id: string; path: string; title: string } | null>) | null = null;
export function setSingletonCheck(fn: typeof singletonCheck): void {
  singletonCheck = fn;
}

/** How long a wire-2 pane's hello waits for the session's stored reply timings (ChatSession.attach):
    a slow store delays a cold transcript by at most this. */
export const HELLO_WAIT_MS = 1500;

/** One embedded pi runtime for one session file, shared by all connected chat clients. */
class ChatSession {
  readonly clients = new Set<ChatClient>();
  private unsubscribe: (() => void) | null = null;
  /** Its project modes' commands and hooks (§chat.mode-menu/project-mode-commands, …/project-mode-hooks). */
  private modeActionsRef: ModeActions | undefined;
  /** Times each reply as it streams (§app.insights/reply-timing); a new one per bind. */
  private replyTimer = new ReplyTimer();
  /** This session's measured replies by entry id: one load at bind (the store, through the server)
      plus each reply measured here. A wire-2 row's `reply` fact reads it. */
  private replyTimings = new Map<string, ReplyTiming>();
  private storedTimings: ReplyLookup | null = null;
  /** The stored timings are on their way (loadReplyTimings). */
  private timingsLoading = false;
  /** Wire-2 panes greeted while they were (their hold ran out first). */
  private readonly greetedEarly = new Set<ChatClient>();
  /** Wire-2 panes that attached while they were: greeted once they arrive, or at HELLO_WAIT_MS. Not
      yet in `clients` (nothing is sent to them before their hello), but they count as attached for a
      dialog. */
  private readonly helloHeld = new Map<ChatClient, NodeJS.Timeout>();
  private readonly replyLookup: ReplyLookup = (entryId) => this.replyTimings.get(entryId) ?? this.storedTimings?.(entryId);
  private streamGuardOff: (() => void) | null = null;
  /** This runtime's last stream-guard trip (server/stream-guard.ts); cleared when a run starts. */
  lastStreamTrip: StreamTrip | null = null;
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
  /** The special kind this runtime is (set by openSession from the file's marker), else null. */
  special: SpecialKind | null = null;
  /** A special chat's loadout (the last build's) and the port to its kind. */
  specialSpec: SpecialSpec | null = null;
  /** A worker chat's loadout (§app.chat-processes/workers), else null. */
  workerSpec: WorkerSpec | null = null;
  specialPort: SpecialPort | null = null;
  /** Composer messages a kind attributes (`@clientSend`), one at a time, in order. */
  private clientSends: Promise<void> = Promise.resolve();
  /** The client ids of the prompts and steers this chat has taken (§chat.transcript/send-while-starting):
      `true` once acknowledged, `false` while still being taken. One sent again (a view coming back,
      a second tab, a retry) never runs twice. Bounded, oldest out. */
  private readonly takenSends = new Map<string, boolean>();
  /** The browser messages waiting behind a model switch or a rewind still under way, in arrival
      order (§chat.transcript/send-while-starting); null when none is. */
  private behind: Promise<void> | null = null;
  /** The person's turns, where the loadout tells them apart (SpecialLoadoutResult.attribution). */
  userTurns: UserTurns | null = null;
  /** The tag the next run's `run.start` names (ChatSendInput.runTag), until a run starts. */
  runTag: { next?: string } = {};
  /** This runtime is the Overseer's. */
  get overseer(): boolean {
    return this.special === "overseer";
  }
  /** A client gesture this special kind refuses (a message for the client), or null. */
  specialRefuses(gesture: "rewind" | "regenerate" | "mode"): string | null {
    return this.specialSpec?.refuses[gesture] ?? null;
  }
  /** Why this special chat's composer takes nothing right now, or null. */
  private composerClosed(): string | null {
    if (!this.specialSpec) return null;
    return this.specialPort?.composerClosed ? this.specialPort.composerClosed() : this.specialSpec.composerClosed;
  }
  /** The composer changed a special chat's model or thinking (`save: true`): its kind keeps it. */
  private saveSpecialChoice(patch: { model?: string; thinking?: string }): void {
    if (!this.specialSpec?.saveChoice || !this.specialPort) return;
    this.specialPort.action("@saveChoice", patch).then(
      (out) => {
        if (!out.ok) console.warn(`[chat] ${this.special}'s model choice not saved: ${out.error.message}`);
      },
      (err) => console.warn(`[chat] ${this.special}'s model choice not saved: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  /** Texts sent here whose user entry still needs its sender marker. */
  private senderMarks: SenderMark[] = [];
  /** Topic batches handed to the agent whose user entry still needs its marker (§chat.topics/delivery). */
  private topicMarks: TopicBatchMark[] = [];
  /** Stop pressed: no topic batch starts here until the user's next message (§chat.topics/delivery).
      The pause outlives this runtime: the store keeps it (topic-store.ts paused.json), so a restart
      holds it too. `topicsPaused` is the in-memory view the delivery gate reads; the three writers
      below keep both. */
  topicsPaused = false;
  private setTopicsPaused(v: boolean): void {
    if (this.topicsPaused === v) return;
    this.topicsPaused = v;
    if (v) topicStore().pauseReceiver(this.path);
    else topicStore().resumeReceiver(this.path);
  }
  /** This runtime's profile, set by openSession (null for special kinds). */
  profileState: ProfileState | null = null;
  /** What this chat's align mode started with (review, Visuals), set by openSession; null in a chat built
      without it (tests), which then reads the vis tools from its mode alone and sends no `alignReview`. */
  alignLaunch: AlignLaunch | null = null;
  /** The `sova-loadout` entry this runtime was built with, and the loader's unfiltered lists
      (§chat.transcript/setup-card-toggles). Null for a special session, which keeps its own loadout. */
  loadoutState: LoadoutState | null = null;
  /** The One at a time check passed for this runtime's first message. */
  private singletonCleared = false;
  /**
   * A prompt() handed to an idle session whose run has not begun: the SDK awaits its input
   * handlers before `isStreaming` turns true, and a second prompt() in that gap is refused
   * ("already processing") after the first was accepted — a message lost after its send was
   * acknowledged. While set, acceptPrompt queues instead and the queue waits (its `paused`).
   * Cleared at the first event of the run, or when that prompt settles without one.
   */
  private starting: Promise<unknown> | null = null;
  private startWaiters: (() => void)[] = [];

  private noteStarting(turn: Promise<unknown>): void {
    this.starting = turn;
    const clear = () => {
      if (this.starting !== turn) return;
      this.startedNow();
      if (!this.disposed) this.queue.onSdkEvent();
    };
    turn.then(clear, clear);
  }
  private startedNow(): void {
    this.starting = null;
    for (const w of this.startWaiters.splice(0)) w();
  }
  /** Client sends that may run an extension command (text starting with "/"), from the send until it
      settles: an idle chat runs a command at once and outside any run (pi awaits its handler), so a
      process closing on purpose lets it finish first (§app.chat-processes/survives-restart, F14). */
  private commandsRunning = 0;
  get commandsInFlight(): number {
    return this.commandsRunning;
  }
  private tracked<T>(text: string, send: () => Promise<T>): Promise<T> {
    if (!text.startsWith("/")) return send();
    this.commandsRunning++;
    const p = send();
    const done = () => void this.commandsRunning--;
    p.then(done, done);
    return p;
  }
  /** A turn was handed to the SDK and its run has not begun (see `starting`): the SDK's abort()
      misses it, so whoever must stop it waits for `whenStarted` first. */
  get turnStarting(): boolean {
    return this.starting !== null;
  }
  /** Resolves once no turn is starting: its run has begun, or its prompt settled without one. */
  whenStarted(): Promise<void> {
    return this.starting ? new Promise((r) => this.startWaiters.push(r)) : Promise.resolve();
  }
  /** How the last switch of THIS chat applies (ModeApplies); set at bind and by applyMode. */
  modeApplies: ModeApplies = "now";
  /**
   * This chat's own mode — never another chat's, and never simply the file. bind() resolves it
   * from this session's branch (resolveChatMode), and applyMode replaces it. The file default
   * here is only a placeholder until bind() runs.
   */
  modeState: ModeState = readMode();
  /** A Claude login picked while a reply ran, applied when it ends (§app.claude-logins/switch-queue);
      also set while an idle pick is landing. Kept in memory only: a server restart drops it. */
  private readonly loginPick = new LoginPick();
  private get loginPending() { return this.loginPick.pending; }

  /** What this chat's last `sandbox` and `claude_login` messages said (undefined: none built yet),
      for SessionSummary.chat (heldChatState): kept as each is built, so the list reads no file. */
  private saidSandbox: SandboxInfo | null | undefined;
  private saidLogin: ChatClaudeLogin | null | undefined;
  /** The one way saidSandbox changes: a new value bumps the list generation, a re-send of the same doesn't. */
  private noteSandbox(sandbox: SandboxInfo | null): void {
    if (this.saidSandbox !== undefined && JSON.stringify(this.saidSandbox) === JSON.stringify(sandbox)) return;
    this.saidSandbox = sandbox;
    sessionsChanged();
  }
  /** The one way saidLogin changes, as noteSandbox. A login only the composer would hide (one login
      on this device) is kept as null, as the message after a hello says it. */
  private noteLogin(login: ChatClaudeLogin | null): void {
    const kept = login?.several ? login : null;
    if (this.saidLogin !== undefined && JSON.stringify(this.saidLogin) === JSON.stringify(kept)) return;
    this.saidLogin = kept;
    sessionsChanged();
  }
  /** HeldChatState's sandbox and login: only those already said. */
  saidState(): Pick<HeldChatState, "sandbox" | "login"> {
    return {
      ...(this.saidSandbox !== undefined ? { sandbox: this.saidSandbox } : {}),
      ...(this.saidLogin !== undefined ? { login: this.saidLogin } : {}),
    };
  }
  /** A pick is landing (a borrow can take up to 30 s): the web queue holds its items meanwhile. */
  private get loginApplying() { return this.loginPick.applying; }

  /**
   * Sova's own outgoing queue (server/queue.ts). Every message that would have gone straight
   * into the SDK's queue goes here first, and exactly one of ours is inside the SDK at a time —
   * which is what makes a single queued message removable at all (the SDK can only clear the lot).
   * A message sent to an IDLE session never enters it: there is nothing to queue behind.
   */
  readonly queue: WebQueue = new WebQueue({
    sdk: {
      // The REAL queue (`hasQueued`, the agent's own) and the mirror, through the driving session
      // (P9 queue-one-bit, server/harness/pi/QUIRKS.md). Delivery is read from the real queue, never
      // the mirror: the mirror is spliced late and skips empty text, so an image-only send never
      // leaves it. The mirror is read ONLY as a change detector against our own earlier reading of
      // it (server/queue.ts sdkHolds); server/queue.ts's header has the full account.
      hasQueued: () => this.harness.queue.hasQueued(),
      mirrorTotal: () => this.harness.queue.mirrorTotal(),
      mirrorFor: (kind) => this.harness.queue.mirrorFor(kind),
      mirrorHas: (kind, text) => this.harness.queue.mirrorHas(kind, text),
    },
    streaming: () => this.harness.isRunning(),
    // A Claude login switch landing holds it too, so the next turn starts on the new login.
    paused: () => this.isCompacting() || this.starting !== null || this.loginApplying,
    // Every clear of the SDK's queue (Stop, the Overseer's stop, a removal) keeps the link messages
    // in it: they are never the user's to take back (§mesh.links/delivery).
    clearSdkQueue: () => this.clearSdkQueue(),
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
      this.settleSenderMark(item.id, reason === "delivered");
      this.broadcast({ type: "queue_item_gone", itemId: item.id, reason, ...(reason === "delivered" ? {} : { text: item.text }) });
    },
    onChange: (items) => this.broadcast({ type: "queue", items }),
    onHandOffError: (item, err) => {
      const code = errorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      // Named to its sender when it had one, so the right composer gets its draft back.
      //
      // NO SYNTHETIC `queue_cleared` HERE. This used to send one "because that is the message the
      // client already restores from", which predates `queue_item_gone` — and with both in flight
      // the client restored the same text TWICE, prepending it into the draft twice with a blank
      // line between. `queue_item_gone{reason:"failed"}` is now the single departure signal, which
      // also makes "failed" and "dropped" symmetric, and leaves `queue_cleared` meaning Stop and
      // nothing else.
      const provider = this.harness.model()?.provider;
      this.broadcast({ type: "error", code, message, ...(item.origin === "client" ? { clientId: item.id } : {}), ...(provider ? { provider } : {}) });
    },
  });

  /** The driving session (§app.harness/session): the runtime's current session, looked up at each call. */
  readonly harness: HarnessSession;

  constructor(
    readonly path: string,
    /** The pi runtime behind the driving session, held by the adapter (harness/pi/host.ts). */
    private readonly host: PiChatHost,
    private readonly onDisposed: () => void,
  ) {
    this.harness = host.harness;
  }

  /** This session's state (§app.harness/state), on the runtime's current session each time. */
  get state(): SessionState {
    return this.harness.state;
  }

  /** The branch's state entries as pi wrote them, for the pi-config cores that fold pi's own entry
      shape (the subagent-profile pick, the mode pin). */
  private extensionBranch(): BranchEntries {
    return extensionEntries(this.harness.branch()) as unknown as BranchEntries;
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

  /** The guard's check: told to the clients when there are any; with none, only recorded (the stat
      still has to be current for a restart). */
  private checkOwnWrites(): void {
    if (this.clients.size === 0) return this.recordOwnWrites();
    try {
      this.assertNoForeignWrites();
    } catch {
      // already broadcast
    }
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
    const images = item.images as ImageInput[] | undefined;
    const toSdk = <T>(send: () => T) => this.toSdk(item.origin, send, item.confirm);
    // What the extensions' input handlers are told: a person's input, or Sova's own (§app.overseer/input-source).
    const source = inputSourceOf(item);
    // The sender's mark goes in with the message, never earlier: a held item is not in the SDK,
    // so a message the user types meanwhile with the same text must not take its mark. It stays
    // until the message ends (markSend) or the item departs undelivered (onGone).
    const sender = senderOfItem(item);
    const mark: SenderMark | null = sender ? { text: item.text, sender, itemId: item.id, held: true } : null;
    if (mark) this.senderMarks.push(mark);
    if (sender?.kind === "session") this.profileState?.run?.expectHop(item.text, sender.hop);
    if (!streaming) {
      // Idle: this starts a turn. Its own failure belongs in this session's pane, like every other
      // turn nobody is awaiting, and must not be reported as a hand-off failure (which would hand
      // the text back to the composer for a message that HAS been sent).
      const turn = toSdk(() => this.tracked(item.text, () => this.harness.send(item.text, { images, source })));
      this.noteStarting(turn);
      turn.catch((err) => {
        if (mark) this.dropSenderMark(mark);
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
      await toSdk(() => this.harness.steer(item.text, images, { source }));
      return;
    }
    await toSdk(() => this.tracked(item.text, () => this.harness.send(item.text, { images, delivery: item.kind, source }))).catch((err) => {
      if (!this.heldForCompaction(err, { ...item, id: undefined })) throw err;
    });
  }

  /** Hand a message to the SDK. Where the loadout tells the person's turns apart (the Overseer, a
      project overseer), one the user sent from the UI (`origin` "client") is marked as it goes, so
      the turn it opens is known as theirs by identity, not text; a confirm card's click only in the
      Overseer. */
  private toSdk<T>(origin: QueueItem["origin"], send: () => T, confirm?: string): T {
    if (origin === "client" && this.userTurns) return this.userTurns.send(send, this.overseer ? confirm : undefined);
    // A profile session with powers tells the user's own messages by identity too (its limits).
    if (origin === "client" && this.profileState?.run) return this.profileState.run.turns.send(send);
    return send();
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
    item: {
      kind: WebQueueItem["kind"];
      text: string;
      images?: QueueImage[];
      origin: QueueItem["origin"];
      id?: string;
      overseer?: WebQueueItem["overseer"];
      baton?: WebQueueItem["baton"];
      session?: WebQueueItem["session"];
      confirm?: WebQueueItem["confirm"];
      byPerson?: WebQueueItem["byPerson"];
    },
  ): boolean {
    if (!isCompactionInProgress(err) || this.disposed) return false;
    // A confirm card's click keeps its mark, and a person's message stays theirs, through the hold
    // (§app.overseer/org-people-facing).
    this.queue.enqueue({
      kind: item.kind,
      text: item.text,
      images: item.images,
      origin: item.origin,
      ...(item.id ? { id: item.id } : {}),
      ...(item.overseer ? { overseer: item.overseer } : {}),
      ...(item.baton ? { baton: item.baton } : {}),
      ...(item.session ? { session: item.session } : {}),
      ...(item.confirm ? { confirm: item.confirm } : {}),
      ...(item.byPerson ? { byPerson: true as const } : {}),
    });
    return true;
  }

  /** A queue item left: delivered, its mark waits for its message like any other (the settle
      sweep may take it from now on); gone any other way, its message never enters, so neither
      does the mark. */
  private settleSenderMark(itemId: string, delivered: boolean): void {
    const mark = this.senderMarks.find((s) => s.itemId === itemId);
    if (!mark) return;
    if (delivered) mark.held = false;
    else this.dropSenderMark(mark);
  }

  private dropSenderMark(mark: SenderMark): void {
    const i = this.senderMarks.indexOf(mark);
    if (i >= 0) this.senderMarks.splice(i, 1);
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
    return this.queue.size > 0 || this.harness.queue.hasQueued();
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
    if (this.disposed || this.harness.isRunning() || this.isCompacting() || this.loginApplying) return;
    if (!this.harness.queue.hasQueued()) return;
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
    this.harness.queue
      .continue()
      .catch((err) => this.reportTurnFailure(err))
      .finally(() => {
        this.waking = false;
      });
  }

  /** The chat's launch record, written once with its first message (one of the open-time appends). */
  recordAlignLaunch(): void {
    const launch = this.alignLaunch;
    if (!launch?.data || launch.recorded) return;
    if (!this.harness.state.file().first(ALIGN_LAUNCH)) this.harness.state.append(ALIGN_LAUNCH, launch.data);
    launch.recorded = true;
  }

  /** Write the model and thinking entries the open queued (P1), e.g. to keep a fresh open's choice. */
  flushDeferredAppends(): void {
    for (const append of this.deferredAppends.splice(0)) append();
  }

  /**
   * Hand a partner's link message straight to this session's agent (§mesh.links/delivery): idle, it
   * starts a turn; mid-turn, it goes in through the SDK's own steering and the model sees it at its
   * next step; while a compaction runs, it is held here and goes in once it ends. NEVER through
   * Sova's web queue: it is never a queued row, never counted or reordered with the user's
   * messages, and Remove never reaches it.
   *
   * The refusals are a prompt's, checked now and thrown (BusyError for a TUI or a foreign writer),
   * and the model policy BEFORE anything is handed over: model-policy's `input` handler answers
   * `handled` for a model that is off, which would swallow the message silently. The deferred
   * opening appends are written at the hand-off, as before any prompt.
   *
   * Returns "started" when this message opens a turn, "delivered" when the agent will see it at
   * its next step (or once the compaction ends). Acceptance, not proof the agent acted on it.
   */
  deliverToAgent(text: string): "started" | "delivered" {
    if (this.disposed) throw new Error("The session's runtime was closed.");
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    this.assertModelAllowed();
    if (!text.trim()) throw new Error("A link message must not be blank.");
    if (this.isCompacting()) {
      this.linkHeld.push(text);
      return "delivered";
    }
    const starts = !this.harness.isRunning() && !this.starting && this.linkPending === 0;
    this.handLinkToAgent(text);
    return starts ? "started" : "delivered";
  }

  /**
   * Start a turn with a topic batch (§chat.topics/delivery): a sibling of deliverToAgent that ONLY
   * ever starts a turn. Mid-turn, starting, compacting, or with anything queued (Sova's queue or the
   * SDK's), it hands nothing over and says why, and the batch waits for the next settle; it never
   * steers and never enters Sova's web queue. The write guards and the model policy throw, as for a
   * prompt. Returns "started", or the word for why not.
   *
   * The turn is not the user's (no `toSdk("client")`), so it is unattended for session powers'
   * limits. The batch's mark rides with it: `entered` at its user entry's message_end (markTopic),
   * `gone` if the turn fails before that or the run settles without it.
   */
  deliverTopicBatch(mark: TopicBatchMark): "started" | "busy" | "paused" | "closed" {
    if (this.disposed) return "closed";
    if (this.topicsPaused) return "paused";
    if (this.harness.isRunning() || this.starting || this.isCompacting() || this.loginApplying || this.waking) return "busy";
    if (this.queue.size > 0 || this.harness.queue.hasQueued() || this.linkPending > 0 || this.linkHeld.length) return "busy";
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    this.assertModelAllowed();
    this.flushDeferredAppends();
    this.topicMarks.push(mark);
    // Inside the settle emit the harness defers the prompt and resolves it at once (P5 settle-window);
    // delivery stays out of that window, and if it ever didn't, the settle sweep owns the mark.
    const deferred = this.harness.inSettleWindow();
    let turn: Promise<void>;
    try {
      turn = this.harness.send(mark.text, { expand: false, source: "system" });
      this.noteStarting(turn);
    } catch (err) {
      // A synchronous throw would otherwise orphan the mark (gone() never runs) and leave the
      // delivery in flight: clean up on this failure path as the turn's rejection does below.
      this.dropTopicMark(mark);
      throw err;
    }
    turn.then(
      // Finished without its message ever entering (an input handler returned "handled"): no run,
      // so no settle sweeps the mark. Drop it now, so the batch isn't stuck in flight.
      () => {
        if (!deferred) this.dropTopicMark(mark);
      },
      (err) => {
        this.dropTopicMark(mark);
        if (this.disposed || isCompactionInProgress(err)) return; // retried at compaction_end
        this.reportTurnFailure(err);
        this.queue.onSdkEvent();
      },
    );
    return "started";
  }

  private dropTopicMark(mark: TopicBatchMark): void {
    const i = this.topicMarks.indexOf(mark);
    if (i < 0) return;
    this.topicMarks.splice(i, 1);
    mark.gone();
  }

  /** A user message ended: if it is a batch handed over here, write its invisible marker on its
      entry (one microtask later, when the SDK has persisted it: markSend's timing) and acknowledge it. */
  private markTopic(text: string): void {
    const i = this.topicMarks.findIndex((m) => m.text === text);
    if (i < 0) return;
    const [mark] = this.topicMarks.splice(i, 1);
    queueMicrotask(() => {
      if (this.disposed || this.foreignWrite) return mark!.gone();
      const leaf = this.harness.leafId();
      const entry = leaf ? this.harness.entry(leaf) : undefined;
      if (entry?.kind !== "user") return mark!.gone();
      this.harness.state.append(TOPIC_DELIVERED, { v: 1, targetId: entry.id!, topic: mark!.topic, batch: mark!.batch, items: mark!.items });
      markOwned(this.path);
      mark!.entered();
    });
  }

  /** Link messages held while a compaction runs; released when it ends (releaseLinks). */
  private linkHeld: string[] = [];
  /** Link messages Stop took back from the SDK before the model saw them: they go in at the
      session's next turn (its `agent_start`), never to the composer. */
  private linkStopped: string[] = [];
  /** Link messages steered into the SDK and not yet started (`message_start`): what clearSdkQueue
      tells apart from the user's own texts. By exact text; the ids in the tag make it unique. */
  private linkInSdk: string[] = [];
  /** Hand-offs are serialized, so two messages arriving together keep their order and the second
      steers into the turn the first starts. */
  private linkChain: Promise<void> = Promise.resolve();
  private linkPending = 0;

  private handLinkToAgent(text: string): void {
    this.linkPending++;
    this.linkChain = this.linkChain
      .then(() => this.linkToSdk(text))
      .catch((err) => this.reportTurnFailure(err))
      .finally(() => void this.linkPending--);
  }

  /** One link message into the SDK, the guards re-checked at the write (a TUI can grab the file
      meanwhile; then the message stays only in the link inbox). Resolves once pi has accepted it. */
  private async linkToSdk(text: string): Promise<void> {
    // A turn handed over and not yet begun (`starting`) would refuse this prompt: wait for its run,
    // then steer into it.
    if (this.starting) await this.whenStarted();
    if (this.disposed) return;
    try {
      assertNotLive(this.path);
      this.assertNoForeignWrites();
    } catch {
      return;
    }
    if (this.isCompacting()) {
      this.linkHeld.push(text);
      return;
    }
    try {
      this.assertModelAllowed();
    } catch {
      this.linkStopped.push(text); // the model was turned off meanwhile: the next turn, on another model
      return;
    }
    this.flushDeferredAppends();
    // Tracked from before the hand-off: a prompt made idle can still be queued as a steer.
    this.linkInSdk.push(text);
    const untrack = () => {
      const i = this.linkInSdk.indexOf(text);
      if (i >= 0) this.linkInSdk.splice(i, 1);
    };
    if (this.harness.isRunning()) {
      await this.harness.steer(text, undefined, { source: "system" }).catch((err) => {
        untrack();
        throw err;
      });
      // The run can end while pi runs the steer's input handlers; the steer then sits in the SDK's
      // queue with no run to drain it. Wake one (wakeQueuedRun is guarded: not streaming, not
      // compacting, one at a time).
      if (!this.harness.isRunning() && this.linkInSdk.includes(text)) this.wakeQueuedRun();
      return;
    }
    // Idle. A `steer` delivery covers a turn that started while the input handlers ran; send()
    // resolves at TURN end, so acceptance is `onAccepted` (P15 accept-vs-complete), or its settling,
    // when pi defers it inside an agent_settled or refuses it.
    // It is a turn starting like any prompt (noteStarting): a user's send in the gap queues instead
    // of being refused by pi.
    await new Promise<void>((accepted) => {
      const turn = this.harness.send(text, { expand: false, source: "system", delivery: "steer", onAccepted: () => accepted() });
      this.noteStarting(turn);
      turn.then(
        () => accepted(),
        (err) => {
          accepted();
          untrack();
          if (this.disposed) return;
          // Another turn won the race after the streaming check: steer into it instead.
          if (isAlreadyProcessing(err)) this.handLinkToAgent(text);
          else if (isCompactionInProgress(err)) this.linkHeld.push(text);
          else this.reportTurnFailure(err);
        },
      );
    });
  }

  /** Hand over what waited: a compaction's hold once it has ended, and at a turn's start what
      Stop took back. A message already on the branch (Stop raced its delivery) is not sent twice. */
  private releaseLinks(stopped: boolean): void {
    if (this.disposed || this.isCompacting()) return;
    const texts = [...this.linkHeld.splice(0), ...(stopped ? this.linkStopped.splice(0) : [])];
    if (!texts.length) return;
    const onBranch = new Set<string>();
    for (const h of this.harness.branch()) {
      if (h.kind !== "user") continue;
      const link = parseLinkMessage(textBlocks(h.blocks));
      if (link) onBranch.add(link.messageId);
    }
    for (const text of texts) {
      const id = parseLinkMessage(text)?.messageId;
      if (id && onBranch.has(id)) continue;
      this.handLinkToAgent(text);
    }
  }

  /** The SDK's clearQueue(), minus the link messages in it, which go back on this chat's own hold
      for the next turn: whoever cleared (Stop, above all) never hands them to a composer. */
  private clearSdkQueue(): { steering: string[]; followUp: string[] } {
    const cleared = this.harness.queue.clear();
    const keep = (texts: string[]) =>
      texts.filter((t) => {
        const i = this.linkInSdk.indexOf(t);
        if (i < 0) return true;
        this.linkInSdk.splice(i, 1);
        this.linkStopped.push(t);
        return false;
      });
    return { steering: keep(cleared.steering), followUp: keep(cleared.followUp) };
  }

  /** A compaction is running on this runtime: a /compact of ours, pi's automatic one, or an
      extension's `ctx.compact()`. Every send is held in the queue meanwhile. */
  isCompacting(): boolean {
    return this.compactRunning || this.harness.isCompacting();
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
   * Whether the vis tools belong in this chat's loadout (§chat.alignment/visuals): the one rule
   * (visToolsWanted) over this chat's mode and the Visuals its runtime started with. A chat built
   * without launch values (tests) has no Visuals.
   */
  visToolsOn(): boolean {
    return visToolsWanted(this.modeState.minorModes, this.alignLaunch?.data?.visuals ?? false);
  }

  /** What the vis feedback extension asks this chat (server/vis-check.ts): its vis mode is this
      chat's own mode, a message queued behind the run goes before any retry, and a runtime that may
      no longer write the file adds nothing to it. */
  visCheckHost(): VisCheckHost {
    return {
      visOn: () => this.modeState.minorModes.includes("vis"),
      visToolsOn: () => this.visToolsOn(),
      queued: () => this.queue.size > 0 || this.harness.queue.hasQueued(),
      writable: () => {
        if (this.disposed || this.foreignWrite) return false;
        try {
          assertNotLive(this.path);
        } catch {
          return false;
        }
        return !this.hasForeignWrites();
      },
    };
  }

  /**
   * The user's model policy, checked as the message goes out: a session sitting on a
   * model that was turned off in Settings → Models refuses its next message and says which switch
   * to move. Nothing is chosen for it — a session that silently fell back to another model would
   * spend a turn on a model the user didn't pick, and the transcript would not say so.
   */
  assertModelAllowed(): void {
    const ref = this.harness.model()?.ref;
    if (!ref) return; // no model yet: the SDK's own error is the useful one
    const denial = modelDenial(readModelPolicy(), ref);
    if (denial) throw new Error(denial);
  }

  busyMessage(): string {
    return `modified by another process while open here (${this.foreignWrite}); reconnect with force to reload`;
  }

  async bind(): Promise<void> {
    const harness = this.harness;
    this.guard = new ForeignWriteGuard(this.path, (id) => harness.hasEntry(id));
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
        if (this.harness.isRunning() || this.harness.isCompacting()) this.harness.abort().catch(() => {});
        return;
      }
      this.checkOwnWrites();
    }, GUARD_POLL_MS);
    this.guardTimer.unref();
    this.workersTimer = setInterval(() => this.pushWorkers(), GUARD_POLL_MS);
    this.workersTimer.unref();
    // Provider bodies in reads no bigger than Node's, so the guard's abort lands as soon on any
    // runtime (§app.server-runtime/quirks): the one place it is installed.
    this.host.useSlicedProviderReads();
    this.streamGuardOff?.();
    this.streamGuardOff = attachStreamGuard(harness, () => capsFor(this.special), {
      onRunStart: () => (this.lastStreamTrip = null),
      onTrip: (trip) => {
        this.lastStreamTrip = trip;
        console.warn(`[stream-guard] ${this.path}: ${trip.kind} (${trip.detail}); turn stopped`);
        this.broadcast({ type: "error", code: "internal", message: `Stopped the turn: ${trip.detail}.` });
      },
    });
    await this.host.bindExtensions(this.dialogs, (extensionPath, error) =>
      this.broadcast({ type: "error", code: "internal", message: `Extension error (${extensionPath}): ${error}` }),
    );
    this.unsubscribe?.();
    this.replyTimer = new ReplyTimer();
    void this.loadReplyTimings();
    // Through the driving session: one pi listener, registered here, after the stream guard and the
    // extensions, as before; each event arrives once, in pi's tick (P12 message-end-before-persist).
    this.unsubscribe = harness.subscribe((event) => {
      // The agent's request going out: reply timing's alone, never forwarded (no wire carries it).
      if (event.type === "request.start") {
        this.replyTimer.observe(event);
        return;
      }
      let timed: ReplyOutcome | null = null;
      try {
        timed = this.replyTimer.observe(event);
      } catch (err) {
        console.error("[chat] reply timing failed", err);
      }
      // A turn starting or settling, and a tool call ending (the Overseer's tools write stores in
      // process), start the next session listing afresh (§app.session-list/listing-reuse). A codemode
      // script's own calls don't: its result's end does, once.
      if ((event.type === "tool.end" && !event.nested) || event.type === "run.start" || event.type === "run.settled") sessionsChanged();
      // A Claude login picked during the reply goes in now, before the queue wake below can start
      // the next turn: applyLoginPick holds the web queue until it has landed
      // (§app.claude-logins/switch-queue).
      if (event.type === "run.settled" && this.loginPending && !this.loginApplying) void this.applyLoginPick();
      if (this.starting && this.harness.isRunning()) {
        this.startedNow(); // the run has begun: a send now queues on isStreaming
        this.queue.onSdkEvent();
      }
      try {
        const wire = event.frame();
        if (event.type === "message.end") this.holdForEntryId(wire, event.handle, timed);
        else this.broadcast(wire);
        // A note an extension sends while the chat is idle (pi's sendMessage, triggerTurn false: /btw's
        // answer) is written with no entry_appended and no turn to end: its row goes out now, after
        // its message_end (held for its entry id), as an append would.
        if (event.type === "message.end" && event.noteType !== undefined && !this.harness.isRunning()) this.appendIdleNote(event.handle, event.noteType);
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
      // boundary — and `rowsOfEntry` below is not in a try.
      if (event.type === "queue") {
        // The mirror's own totals, straight from the SDK. The queue reads GROWTH out of the
        // sequence of these — the only way to tell "an extension queued something" from "our item
        // was delivered", which a single total cannot distinguish (one in, one out, total unmoved).
        this.queue.observeQueueUpdate(event.steering.length, event.followUp.length);
      } else if (QUEUE_WAKE_EVENTS.has(event.type) && !refreshWakes) this.queue.onSdkEvent();
      // pi's AUTOMATIC compaction emits compaction_end before its finally clears the controller
      // `isCompacting` reads, so the wake above can still find the queue paused: look again once
      // that has unwound. (The manual path clears first, so this one is a no-op there.)
      if (event.type === "compaction.end")
        setImmediate(() => {
          if (this.disposed) return;
          this.queue.onSdkEvent();
          this.releaseLinks(false);
        });
      if (event.type === "run.start") {
        this.releaseLinks(true);
        emitChatEvent(this.path, "started");
        // After the fact: schedules a mode's turn.started hooks (if any) and returns.
        this.modeActions.turnStarted();
        // The runs in flight, for resuming what a restart cuts off (§app.overseer/auto-resume).
        runRecorder.started(this.path);
      }
      if (event.type === "run.settled") runRecorder.settled(this.path);
      if (event.type === "message.start" && this.linkInSdk.length && event.role === "user") {
        const i = this.linkInSdk.indexOf(event.text!);
        if (i >= 0) this.linkInSdk.splice(i, 1);
      }
      if (event.type === "entry.appended") {
        // Display entries an extension appended outside a turn (mode markers, align docs, …)
        // reach the pane now instead of at the next hello/resync. rowsOfEntry returns []
        // for entries with nothing to show, so most appends broadcast nothing.
        const appended = event.entry;
        const items = appended ? rowsOfEntry(appended) : [];
        if (items.length) this.broadcast({ type: "append", items });
        onSandboxAppend(this.sandboxHost, appended);
        if (isClaudeLoginEntry(appended)) this.broadcast(this.loginMessage());
      }
      if (event.type === "message.end" && this.senderMarks.length && event.role === "user") {
        this.markSend(event.text!);
      }
      if (event.type === "message.end" && this.topicMarks.length && event.role === "user") {
        this.markTopic(event.text!);
      }
      if (event.type === "run.settled" && this.topicMarks.length) {
        // A batch whose message never entered this run is gone (its notes stay undelivered).
        // Deferred like the sender sweep: a batch handed over inside this settle runs in it.
        const stale = [...this.topicMarks];
        setTimeout(() => {
          if (!this.harness.isRunning() && !this.starting) for (const m of stale) this.dropTopicMark(m);
        }, 0);
      }
      if (event.type === "run.settled" || event.type === "compaction.end") emitChatEvent(this.path, "receiverIdle");
      if (event.type === "run.settled" && this.senderMarks.length) {
        // A mark that never found its message this run (the prompt was swallowed or failed early)
        // is stale. Deferred, so a mark for a prompt made while this event is being emitted (it
        // runs in this same settle window) is not dropped before its message ends. A mark whose
        // queue item has not departed yet is not stale: its message is still on its way.
        const stale = this.senderMarks.filter((s) => !s.held);
        setTimeout(() => {
          if (!this.harness.isRunning()) this.senderMarks = this.senderMarks.filter((s) => !stale.includes(s));
        }, 0);
      }
      if (event.type === "run.settled") {
        emitChatEvent(this.path, "settled");
        this.modeActions.turnSettled();
      }
      if (event.type === "run.settled" && this.modeApplies === "after-turn") {
        // A mid-turn switch reaches the next prompt from here on.
        this.modeApplies = "now";
        this.broadcast(this.modeMessage());
      }
    });
    this.broadcast(this.commands()); // extension commands exist only after bindExtensions
    this.sendSandbox((m) => this.broadcast(m));
    // The same rule the extension's own session_start runs, so both agree on this session's mode.
    this.modeState = chatModeOf(harness.state.branch());
    this.modeApplies = this.modeCommand() ? "now" : "new-chats";
    await this.syncModePrompt();
  }

  /** This session's measured replies from the store (server/reply-facts.ts), merged under the ones
      measured here since. Never throws. */
  private async loadReplyTimings(): Promise<void> {
    const fresh = (this.replyTimings = new Map());
    this.storedTimings = null;
    this.greetedEarly.clear();
    this.timingsLoading = true;
    try {
      // In a chat process the server answers once this chat's open is done: a pane that attaches
      // before then gets its hello again with the facts (greetedEarly).
      const got = await replyTimingsOf(this.harness.id);
      // A later bind started its own load: this one's answer is for a session no longer here.
      if (this.replyTimings !== fresh) return;
      this.timingsLoading = false;
      const early = [...this.greetedEarly];
      this.greetedEarly.clear();
      if (got && !this.disposed) this.storedTimings = got.get;
      // Whatever the answer (none, failed, timed out), each held pane gets its one hello now.
      this.releaseHeld();
      if (!got || this.disposed) return;
      for (const c of early) if (this.clients.has(c)) this.greet(c);
    } catch {
      // no facts: rows look as they always did
      if (this.replyTimings === fresh) {
        this.timingsLoading = false;
        this.releaseHeld();
      }
    }
  }

  /** Greet held panes (`only`: that one, its hold run out; it gets its hello again when the timings
      arrive). */
  private releaseHeld(only?: ChatClient): void {
    for (const c of only ? [only] : [...this.helloHeld.keys()]) {
      const t = this.helloHeld.get(c);
      if (!t) continue;
      clearTimeout(t);
      this.helloHeld.delete(c);
      if (this.disposed) continue;
      this.clients.add(c);
      this.greet(c);
      if (only && this.timingsLoading) this.greetedEarly.add(c);
    }
  }

  /** A measured reply, once its entry is known: its record into the store, and its timing on the
      message_end frame (wire 2's message.end) and in this chat's lookup. Only a written record is
      shown. Never throws. */
  private recordReply(outcome: ReplyOutcome | null, entryId: string | null, wire: V1EventFrame): void {
    if (!outcome || !("measured" in outcome) || entryId === null) return;
    try {
      const sid = this.harness.id;
      const who = resolveUsageAttribution(sid);
      const kind = who.routed && PERF_KINDS_SET.has(who.kind) ? (who.kind as PerfKind) : undefined;
      const root = agentRoot();
      const rec = perfRecordOf(outcome.measured, { sid, entryId, device: readDeviceId(root), producer: producerId(), ...(kind ? { kind } : {}) });
      if (!appendPerfRecord(rec, root)) return;
      const timing = replyTimingOf(rec);
      this.replyTimings.set(entryId, timing);
      wire.reply = timing;
    } catch (err) {
      console.error("[chat] reply timing record failed", err);
    }
  }

  /**
   * `/mode sync`: the extension's quiet argument that changes and writes nothing, only hands it
   * pi's base prompt options (reachable from a command context alone) and puts the session's mode
   * block there. Without it, a chat never switched in this runtime lost its mode section on every
   * turn an extension's message starts (a worker settling) at that turn's second request, and
   * the claude-code bridge restarted its CLI at each flip. Run at every bind, so every chat has it
   * before its first turn; safe on a foreign or terminal-live session, since nothing is written.
   */
  private async syncModePrompt(): Promise<void> {
    const cmd = this.modeCommand();
    if (!cmd) return;
    try {
      await cmd.handler("sync", this.harness.commandContext());
    } catch (err) {
      console.error("[chat] /mode sync failed", err);
    }
  }

  /**
   * The mode extension's own /mode command in this runtime, or undefined when it isn't loaded
   * (extension-toggle, a name clash). Checked by source so another extension's "mode" never runs.
   */
  private modeCommand() {
    return this.harness.command("mode");
  }

  /** The chat socket's `profile` message (§chat.profiles/applying). */
  profileMessage(): Extract<ChatServerMessage, { type: "profile" }> {
    const data = this.profileState?.data ?? null;
    const active = this.harness.activeTools();
    const grants = data?.profile?.grant ?? [];
    const granted = grants.flatMap((g) => GRANT_TOOLS[g]).filter((t) => active.includes(t));
    let live = false;
    try {
      assertNotLive(this.path);
    } catch {
      live = true;
    }
    return {
      type: "profile",
      profile: data?.profile ?? null,
      ...(data?.by ? { by: data.by } : {}),
      locked: !this.isPristine(),
      pickable: !this.special && !live,
      tools: active,
      removed: [...(this.profileState?.excluded ?? [])].filter((t) => this.harness.registeredTools().includes(t) || ["bash", "edit", "write"].includes(t)),
      granted,
      ...(data?.profile && parseMine(data.mine) ? { mine: parseMine(data.mine) } : {}),
    };
  }

  /**
   * Write this session's profile entry (§chat.profiles/applying): refused once a user message is on
   * the branch, mid-turn, TUI-live, for a foreign writer or a special kind. The caller disposes the
   * runtime afterwards, so the next open builds it with the profile.
   */
  writeProfile(data: ProfileEntryData): void {
    if (this.special) throw new RefusedError("This session can't take a profile.");
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (!this.isPristine()) throw new RefusedError("The profile is fixed once a message is sent.");
    if (this.harness.isRunning() || this.isCompacting() || this.starting) throw new BusyError("Wait for the reply to finish first.", "busy");
    this.flushDeferredAppends(); // open-time entries go first, as in pinMode
    this.state.append(PROFILE, data);
    markOwned(this.path);
  }

  /**
   * Write this session's context and skills entry (§chat.transcript/setup-card-toggles): the same
   * window and refusals as a profile pick. The caller disposes the runtime afterwards, so the next
   * open builds it with the entry.
   */
  writeLoadout(data: LoadoutEntryData): void {
    if (this.special) throw new RefusedError("This session's context files and skills can't be switched.");
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (!this.isPristine()) throw new RefusedError("Context files and skills are fixed once a message is sent.");
    if (this.harness.isRunning() || this.isCompacting() || this.starting) throw new BusyError("Wait for the reply to finish first.", "busy");
    this.flushDeferredAppends(); // open-time entries go first, as in writeProfile
    this.state.append(LOADOUT, data);
    markOwned(this.path);
  }

  /** Whether the setup card may offer its switches now: what writeLoadout would accept, short of
      a foreign writer (which only a write discovers). */
  get loadoutToggleable(): boolean {
    if (this.special || this.disposed || !this.isPristine()) return false;
    try {
      assertNotLive(this.path);
    } catch {
      return false;
    }
    return true;
  }

  /** Whether this chat is still before its first message (the picker is live). */
  get pristine(): boolean {
    return this.isPristine();
  }

  modeMessage(): ChatServerMessage {
    const s = this.modeState;
    // `memory` only where the menu can turn it on (§chat.memory/where): its absence hides the row.
    return { type: "mode", mode: s.mode, minorModes: [...s.minorModes], strict: s.strict, applies: this.modeApplies, ...(this.memoryOffered() ? { memory: this.memory.choiceNow() } : {}), ...this.projectModesInfo() };
  }

  /** The project modes this chat has on (its newest mode entry's `projectModes`, turn-on order). */
  projectOn(): ProjectModeRef[] {
    const active = this.harness.state.branch().latest(MODE)?.data.active;
    return active ? projectModesOf(active) : [];
  }

  /** This chat's mode commands and hooks: read accessors only, so nothing there can send or queue. */
  private get modeActions(): ModeActions {
    return (this.modeActionsRef ??= new ModeActions({
      sessionId: () => this.harness.id,
      cwd: () => this.harness.cwd || undefined,
      projectOn: () => this.projectOn(),
      copies: () => restoreProjectSnapshots(this.extensionBranch()),
      sandboxOn: () => this.sandboxInfo()?.on === true,
      notHere: () => notHereFor({ worker: this.workerSpec !== null, special: !!this.special, cwd: this.harness.cwd || undefined, remote: (cwd) => !!targetOfCwd(cwd) }),
      approved: isApproved,
      approvedByUser: isApprovedByUser,
    }));
  }

  /** Run a command of a project mode on in this chat (POST /api/mode/command, §chat.mode-menu/project-mode-commands). */
  runModeCommand(mode: string, name: string, args: unknown): Promise<ModeCommandOutcome> {
    return this.modeActions.runCommand(mode, name, args);
  }

  /** The checkout this chat's project modes come from, read now: none for a remote (target) chat, the
      Overseer, or a session that refuses mode switches. */
  private projectListing() {
    const cwd = this.harness.cwd || undefined;
    const none = this.overseer || !!this.specialRefuses("mode") || (cwd !== undefined && !!targetOfCwd(cwd));
    return listingFor(cwd, none);
  }

  /** The mode menu's project rows (§chat.mode-menu/project-modes), read from disk now. Empty (no keys) when
      the chat has no checkout and nothing on; never throws. */
  projectModesInfo() {
    try {
      return projectModesInfo(this.projectListing(), this.projectOn(), restoreProjectSnapshots(this.extensionBranch()), isApproved, {
        approvedByUser: isApprovedByUser,
        hookNotes: this.modeActionsRef?.hookNotes(),
      });
    } catch (err) {
      console.error("[chat] project modes unreadable", err);
      return {};
    }
  }

  /** This chat's mode as POST /api/mode?path= answers it, the project rows read now. */
  modeResult(): ChatModeResult {
    return { ...modeInfo(this.modeState, this.memoryOffered() ? this.memory.choiceNow() : undefined), applies: this.modeApplies, ...this.projectModesInfo() };
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
    return !this.harness.branch().some((h) => h.kind === "user");
  }

  /**
   * POST /api/mode?path=: merge the patch into THIS chat's mode and apply it here; no other chat
   * hears about it, and nothing is written to mode.json. The default new sessions start from moves
   * only when the user asks for it — the menu's `Save as default` (saveModeDefault), `/mode default`
   * in the TUI, or a POST /api/mode with no ?path=. A new chat's switch stops being a side effect
   * of being new.
   */
  /**
   * Your own approval of project modes' hooks (§chat.mode-menu/project-mode-hooks): records `user` for each exact
   * version given, the one on in this chat or the one its checkout offers now, when that version has hooks. A hash
   * that isn't that version's answers like a stale approval (nothing recorded). Switches nothing.
   */
  approveHooks(approvals: readonly ProjectModeApproval[]): ChatModeResult & Partial<ProjectModeApprovalNeeded> {
    if (this.overseer || this.special) throw new ModeRefusedError("This chat's project modes have no hooks to approve.");
    const listing = this.projectListing();
    if (listing.root === null) throw new ModeRefusedError("This chat has no project modes.");
    const copies = restoreProjectSnapshots(this.extensionBranch());
    const on = this.projectOn();
    const stale: string[] = [];
    const record: { id: string; hash: string }[] = [];
    for (const a of approvals) {
      const ref = on.find((r) => r.id === a.id);
      const version = (ref && copies.get(ref.sha)) || listing.modes.find((m) => m.id === a.id);
      if (!version?.hooks?.length) throw new ModeRefusedError(`Project mode "${a.id}" has no hooks to approve here.`);
      if (version.toolsHash !== a.hash) stale.push(a.id);
      else record.push(a);
    }
    if (stale.length > 0) {
      const info = this.modeResult();
      const fresh = (info.projectMinors ?? []).filter((m) => stale.includes(m.id));
      return { ...info, error: `The hooks of ${stale.join(", ")} changed since you looked; check them again.`, needsApproval: fresh };
    }
    for (const a of record) recordApproval(listing.root, a.id, a.hash, "user");
    this.broadcast(this.modeMessage());
    return this.modeResult();
  }

  async switchMode(patch: ModePatch): Promise<ChatModeResult & Partial<ProjectModeApprovalNeeded>> {
    if (this.overseer) throw new ModeRefusedError();
    const refused = this.specialRefuses("mode");
    if (refused) throw new ModeRefusedError(refused);
    // Project modes (§chat.mode-menu/project-modes): every turn-on checked, and its approval stored, before
    // anything switches; one needing the user's approval switches nothing.
    if (patch.projectModes !== undefined) {
      const listing = this.projectListing();
      const check = checkProjectSwitch(listing, this.projectOn().map((r) => r.id), patch.projectModes, patch.approve ?? [], patch.approvedBy === "overseer", isApproved);
      if ("error" in check) throw new ModeRefusedError(check.error);
      if ("needsApproval" in check) {
        return { ...this.modeResult(), error: approvalNeededText(check), needsApproval: check.needsApproval };
      }
      // Only the operator's own page records `user`, and only when the route says so: anything else is a caller's
      // (fail closed). Hooks run on `user` alone.
      for (const a of check.record) recordApproval(listing.root!, a.id, a.hash, patch.approvedBy ?? "caller");
    }
    // Memory runs in an ordinary chat's runtime (§chat.memory/where): a special loadout has no engine.
    if (!this.memoryOffered() && (patch.memory || (patch.minorModes?.includes("memory") && !this.modeState.minorModes.includes("memory"))))
      throw new ModeRefusedError("Memory can't be turned on in this chat.");
    if (patch.memory) this.writeMemoryChoice(patch.memory);
    const wasOn = this.modeState.minorModes.includes("memory");
    if (patch.mode !== undefined || patch.minorModes !== undefined || patch.projectModes !== undefined) await this.applyMode(mergeMode(this.modeState, patch), patch.projectModes);
    else this.broadcast(this.modeMessage());
    const isOn = this.modeState.minorModes.includes("memory");
    if (isOn && !wasOn) this.memory.turnedOn();
    else if (isOn !== wasOn) this.memory.changed();
    return this.modeResult();
  }

  /** This chat's memory (§chat/memory): its choice, engine and status. */
  private memoryRef: ChatMemory | undefined;
  get memory(): ChatMemory {
    this.memoryRef ??= new ChatMemory({
      sessionId: () => this.harness.id,
      cwd: () => this.harness.cwd || undefined,
      branch: () => this.harness.branch(),
      // An overseer (the Overseer, a project overseer) has no mode entry: its switch, type and size are its own
      // overseer.json's, on by default.
      record: () => {
        const o = this.overseerMemory();
        return o ? { v: 1, type: o.type, size: o.size } : (this.harness.state.branch().latest(MEMORY)?.data ?? null);
      },
      on: () => this.overseerMemory()?.on ?? this.modeState.minorModes.includes("memory"),
      send: (msg) => this.broadcast(msg),
    });
    return this.memoryRef;
  }

  /** An overseer's own memory switch in force, or undefined for every other chat (its memory is its mode's). */
  private overseerMemory(): OverseerMemorySetting | undefined {
    if (this.overseer) return overseerMemoryNow(undefined);
    if ((this.special === "project-overseer" || this.special === "project-assistant") && this.specialSpec?.memory && this.specialSpec.memorySettings) return overseerMemoryNow(this.specialSpec.memorySettings);
    return undefined;
  }

  /** What the memory extension asks this chat (server/harness/pi/memory.ts). */
  memoryHost(): MemoryHost {
    return this.memory;
  }

  /** Whether this chat's mode menu offers memory: an ordinary chat whose runtime has the engine (never the
      Overseer, whose switch is its own, nor a session that refuses mode switches). */
  memoryOffered(): boolean {
    return !this.overseer && !this.specialRefuses("mode") && this.memoryAvailable();
  }

  /** Whether this runtime has the memory engine (its recall tools are registered). */
  memoryAvailable(): boolean {
    try {
      return MEMORY_TOOLS.every((t) => this.harness.registeredTools().includes(t));
    } catch {
      return false;
    }
  }

  /**
   * Write this chat's memory choice (§chat.memory/choice): a `sova-memory` record on its branch, the
   * patch over the current choice. Kept while memory is off. Refused where a mode switch would be.
   */
  writeMemoryChoice(patch: Partial<{ type: "uniichat" | "zoomable"; size: number }>): void {
    if (this.disposed || this.foreignWrite || this.hasForeignWrites()) throw new ModeRefusedError("This chat can't be written now.");
    assertNotLive(this.path);
    const cur = this.memory.choiceNow();
    const next = applyMemoryPatch(cur, patch);
    if (next.type === cur.type && next.size === cur.size && this.harness.state.branch().latest(MEMORY)) return;
    const prev = this.harness.state.branch().latest(MEMORY)?.data;
    this.flushDeferredAppends();
    this.harness.state.append(MEMORY, { v: 1, type: next.type, size: next.size, ...(prev?.on !== undefined ? { on: prev.on } : {}) });
    markOwned(this.path);
  }

  /** An overseer's runtime opened (its kind now set): its recall tools follow its switch, and with memory on the
      engine syncs with the branch, preparing a conversation whose memory was never built. */
  memoryOpened(): void {
    if (this.disposed || !this.memoryAvailable()) return;
    this.syncMemoryTools();
    if (!this.memory.choice().on) return;
    try {
      this.memory.engine().sync(this.harness.branch());
    } catch (err) {
      console.warn(`[memory] sync at open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The Overseer's switch moved (server/memory/routes.ts): its tools follow between runs. */
  memorySwitched(): void {
    this.syncMemoryTools();
  }

  /** Between runs, the recall tools follow memory's switch at once (mid-run the run keeps its tools). */
  private syncMemoryTools(): void {
    if (this.disposed || this.harness.isRunning() || !this.memoryAvailable()) return;
    const want = this.memory.choice().on;
    const current = this.harness.activeTools();
    const has = current.some((t) => MEMORY_TOOLS.includes(t));
    if (want && !MEMORY_TOOLS.every((t) => current.includes(t))) this.harness.setActiveTools([...current.filter((t) => !MEMORY_TOOLS.includes(t)), ...MEMORY_TOOLS]);
    else if (!want && has) this.harness.setActiveTools(current.filter((t) => !MEMORY_TOOLS.includes(t)));
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
  subagentProfileInfo() {
    return subagentProfilesInfo(restorePick(this.extensionBranch()));
  }

  /** This chat's own subagent pick on its branch (an id or "off"), or undefined: it follows the device default. */
  get subagentPick(): string | undefined {
    return restorePick(this.extensionBranch());
  }

  /** Why switchSubagentProfile would refuse right now (short of an unknown id), or null: a profile
      pick checks this before it writes anything. */
  subagentSwitchRefusal(): string | null {
    if (this.disposed || this.overseer || this.specialRefuses("mode") || this.hasForeignWrites()) return "This session's subagent profile can't be switched here.";
    if (!this.modeCommand()) return "The mode extension isn't loaded in this chat.";
    return null;
  }

  async switchSubagentProfile(id: unknown) {
    if (this.disposed || this.overseer || this.specialRefuses("mode") || this.hasForeignWrites()) throw new ModeRefusedError();
    assertNotLive(this.path);
    const profile = requireSubagentProfile(id);
    if (!this.modeCommand()) throw new ModeRefusedError("The mode extension isn't loaded in this chat.");
    this.flushDeferredAppends();
    const entry = pickEntryFor(this.extensionBranch(), profile);
    if (entry) this.harness.state.append(SUBAGENT_PROFILE, entry.data);
    markOwned(this.path);
    return { ...this.subagentProfileInfo(), applies: this.harness.isRunning() ? "after-turn" as const : "now" as const };
  }

  async saveModeDefault(): Promise<ModeInfo> {
    if (this.overseer) throw new ModeRefusedError();
    const refused = this.specialRefuses("mode");
    if (refused) throw new ModeRefusedError(refused);
    const profile = this.subagentProfileInfo().current.id;
    if (profile === null) throw new ModeRefusedError("Fix the subagent profiles file before saving the default.");
    // Two files, no transaction: the profile default first, then the mode. If the second write
    // fails, say plainly that the first one already happened.
    try {
      saveSubagentProfileDefault(profile);
    } catch (err) {
      throw new ModeRefusedError(`The subagent profile default was not saved, and the mode default was not touched: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const memory = this.memoryOffered() ? this.memory.choiceNow() : undefined;
      if (memory) saveDefaultMemoryChoice(memory);
      return modeInfo(writeMode(defaultPatchOf(this.modeState)), memory);
    } catch (err) {
      throw new ModeRefusedError(`The subagent profile default "${profile}" WAS saved, but the mode default was not: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Make this runtime follow `state` from its next prompt (modeApplyPlan), and make it this
   * chat's mode. The /mode handler is called directly, never sent through prompt(), so no command
   * text can reach the model; it appends the marker entry this session later restores from.
   * Resolves once the switch is in the extension's memory; the delegate routing probe it then
   * starts isn't awaited. Returns the plan that ran ("command" = taken, "skip" = a foreign writer
   * got it, "unsupported" = no /mode command loaded), so callers can decide what else to do.
   */
  async applyMode(state: ModeState, projectModes?: readonly string[]): Promise<"skip" | "unsupported" | "command"> {
    if (this.disposed) return "skip"; // a disposed runtime took nothing
    const streaming = this.harness.isRunning();
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
      const ctx = this.harness.commandContext();
      this.flushDeferredAppends(); // open-time entries go before the extension's mode marker
      try {
        // memory is web-only: the extension takes it on only while this switch is being applied (permit.ts).
        const web = state.minorModes.includes("memory") && this.memoryAvailable() ? (["memory"] as const) : [];
        const memoryWasOn = this.modeState.minorModes.includes("memory");
        await withWebMinors(this.harness.id, web, async () => {
          for (const minor of MINOR_MODES) {
            const on = state.minorModes.includes(minor);
            if (minor === "memory" && !on && !memoryWasOn) continue; // nothing to turn off
            await cmd.handler(`${minor} ${on ? "on" : "off"}`, ctx);
          }
        });
        // Project modes (§chat.mode-menu/project-modes), always by their prefixed name: off first, then each
        // new one on in the order asked. A turn-on the extension refuses leaves it off; the menu reads the
        // on set back from the branch (projectOn), never from what was asked.
        if (projectModes !== undefined) {
          const was = this.projectOn().map((r) => r.id);
          for (const id of was) if (!projectModes.includes(id)) await cmd.handler(`${PROJECT_MODE_PREFIX}${id} off`, ctx);
          for (const id of projectModes) if (!was.includes(id)) await cmd.handler(`${PROJECT_MODE_PREFIX}${id} on`, ctx);
        }
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
      // The runtime took it: this is now this chat's mode (memory only where the engine runs: the extension refused it otherwise).
      this.modeState = state.minorModes.includes("memory") && !this.memoryAvailable() ? { ...state, minorModes: state.minorModes.filter((m) => m !== "memory") } : state;
      this.syncVisCheckTool();
      this.syncMemoryTools();
    }
    this.modeApplies = applies;
    this.broadcast(this.modeMessage());
    return plan;
  }

  /**
   * Between runs, vis_check follows this chat's vis mode at once, as the mode extension's vis_guide does
   * (§chat.mode-menu/minor-toggle-keeps-prompt): called after both /mode handlers ran and modeState took the
   * new state, so a major switch's restored tool set (leaving strict delegate puts back a snapshot that never
   * saw vis_check change) is corrected too. Never from a MODE_STATE_EVENT listener, which fires inside the
   * handler while visOn still reads the old state. Mid-run the run keeps its tools; the vis-check
   * extension syncs when it settles.
   */
  private syncVisCheckTool(): void {
    if (this.disposed || this.harness.isRunning()) return;
    const registered = this.harness.registeredTools();
    const names = [VIS_CHECK_TOOL, ...TOUR_TOOLS].filter(n => registered.includes(n));
    const wanted = names.filter(n => n === VIS_CHECK_TOOL ? this.visToolsOn() : this.modeState.minorModes.includes("vis"));
    const current = this.harness.activeTools();
    const next = [...current.filter(n => !names.includes(n) || wanted.includes(n)), ...wanted.filter(n => !current.includes(n))];
    if (next.length !== current.length) this.harness.setActiveTools(next);
  }

  /**
   * Pin this chat to its current mode: append the extension's own `mode` entry (pinEntryFor) when
   * the branch's newest snapshot differs, so the session keeps this mode on every reopen whatever
   * mode.json says later — the extension itself appends only on a change, never for a mode equal
   * to the default. Call it after applyMode returned "command". False when this chat can't be
   * written (disposed, a foreign writer, live in a terminal).
   */
  pinMode(): boolean {
    if (this.disposed || this.foreignWrite || this.hasForeignWrites()) return false;
    try {
      assertNotLive(this.path);
    } catch {
      return false;
    }
    const pin = pinEntryFor(this.extensionBranch(), this.modeState);
    if (!pin) return true;
    this.flushDeferredAppends(); // open-time entries go before the mode entry, as in applyMode
    this.harness.state.append(MODE, pin.data);
    markOwned(this.path);
    return true;
  }

  /**
   * The claude-code extension's own /claude-login command in this runtime (its provider registers
   * it; the source is the extension's entry), or undefined (not loaded, a name clash). Checked by
   * source, like modeCommand.
   */
  private claudeLoginCommand() {
    return this.harness.command("claude-login");
  }

  /** This chat's Claude login with its waiting pick, as every tab is told it. */
  loginMessage(): ChatServerMessage {
    const msg = claudeLoginMessage(this.harness.branch(), undefined, { pending: this.loginPending });
    this.noteLogin(msg.login);
    return msg;
  }

  /** The `claude_login` message every hello is followed by (claudeLoginAfterHello). */
  private loginAfterHello(): ChatServerMessage {
    const msg = claudeLoginAfterHello(this.harness.branch(), undefined, { pending: this.loginPending }); // the branch's newest entry
    this.noteLogin(msg.login);
    return msg;
  }

  /**
   * `set_claude_login` (§app.claude-logins/switch-login): move this chat to a Claude login now, or,
   * while a reply runs, when it ends (§app.claude-logins/switch-queue). `null` cancels a waiting
   * pick; picking the chat's own login cancels one too. The write guards are a model change's.
   */
  setClaudeLogin(login: string | null): void {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    const current = chatClaudeLogin(this.harness.branch())?.id;
    if (login !== null && login !== current) {
      if (!/^(default|l-[0-9a-f]{8})$/.test(login)) throw new Error("There's no such Claude login.");
      if (!(this.harness.model()?.ref ?? "").startsWith("claude-code-cli/")) throw new Error("This chat isn't on a Claude Code model.");
      if (!this.claudeLoginCommand()) throw new Error("This chat's runtime has no /claude-login command. Turn on Claude Code models, then reopen the chat.");
    }
    const busy = this.harness.isRunning() || this.isCompacting() || !!this.starting;
    const outcome = this.loginPick.choose(login === null ? null : { id: login, name: loginName(login) }, current, busy);
    if (outcome === "landing") throw new Error("A switch of Claude login is already landing. Pick again once it has.");
    if (outcome === "cancelled" || outcome === "queued") this.broadcast(this.loginMessage());
    if (outcome === "apply") void this.applyLoginPick();
  }

  /**
   * Apply the waiting pick through the extension's /claude-login handler, called directly like
   * /mode (never through prompt()). The web queue holds while it lands, so no turn starts on the
   * old login in between; a refusal drops the pick and says why.
   */
  private async applyLoginPick(): Promise<void> {
    if (this.disposed) return;
    const pick = this.loginPick.start();
    if (!pick) return;
    const cmd = this.claudeLoginCommand();
    this.broadcast(this.loginMessage()); // the label shows the pick while it lands (a borrow)
    let failure: string | null = null;
    try {
      if (!cmd) throw new Error("This chat's runtime has no /claude-login command.");
      assertNotLive(this.path);
      this.assertNoForeignWrites();
      this.flushDeferredAppends(); // open-time entries go before the claude-login entry
      await cmd.handler(pick.id, this.harness.commandContext());
      if (!this.foreignWrite) markOwned(this.path); // the claude-login entry is our write
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.loginPick.done(pick);
    }
    if (this.disposed) return;
    if (failure) this.broadcast({ type: "error", code: "internal", message: `${LOGIN_UNCHANGED} ${failure.replace(/\.$/, "")}.` });
    this.broadcast(this.loginMessage());
    // Whatever was sent meanwhile goes now, on the new login.
    this.queue.onSdkEvent();
    this.wakeQueuedRun();
  }

  /**
   * A note for the session's model, shown in the chat, that starts no turn (a project coding
   * session started with no prompt gets its worktree paragraph this way). pi appends it to the file
   * at once while idle, and it is context from the next turn on. False when this runtime may not
   * write (a foreign writer, the TUI) or is mid-turn.
   */
  async appendNote(customType: string, text: string, details?: unknown): Promise<boolean> {
    if (this.disposed || this.foreignWrite || this.hasForeignWrites() || this.harness.isRunning()) return false;
    try {
      assertNotLive(this.path);
    } catch {
      return false;
    }
    this.flushDeferredAppends(); // open-time entries go first, as in pinMode
    await this.harness.appendNote(customType, text, details);
    markOwned(this.path);
    return true;
  }

  /** The sandbox extension's /sandbox command in this runtime (server/sandbox-state.ts). */
  private sandboxCommand() {
    return this.harness.command("sandbox");
  }

  /** This chat's sandbox now (§chat.sandbox/states), or null when its runtime has no sandbox extension. */
  sandboxInfo(): SandboxInfo | null {
    return this.sandboxCommand() ? sandboxInfo(this.harness.branch()) : null;
  }

  /** This chat's "sandbox" message, only when the extension is loaded: without it, nothing is sent
      (and the list's `chat` says null). */
  private sendSandbox(send: (msg: ChatServerMessage) => void): void {
    if (!this.sandboxCommand()) return this.noteSandbox(null);
    const msg = sandboxMessage(this.harness.branch());
    this.noteSandboxMessage(msg);
    send(msg);
  }

  private noteSandboxMessage(msg: ChatServerMessage): void {
    if (msg.type !== "sandbox") return;
    const { type: _type, ...sandbox } = msg;
    this.noteSandbox(sandbox);
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
      commandContext: () => this.harness.commandContext(),
      beforeCommand: () => this.flushDeferredAppends(), // open-time entries go before the extension's
      afterCommand: () => {
        if (!this.foreignWrite) markOwned(this.path); // the extension's entry is our write
      },
      branch: () => this.harness.branch(),
      broadcast: (msg) => {
        this.noteSandboxMessage(msg);
        this.broadcast(msg);
      },
    };
  }

  /** POST /api/workers/resume: start one restored worker again, idle (server/worker-resume.ts).
      The fresh worker snapshot is pushed at once, so clients don't wait for the next poll. */
  async resumeWorker(id: string): Promise<ResumeOutcome> {
    if (this.disposed) return { ok: false, status: 404, error: "That session isn't open on this server; open the chat first." };
    const outcome = await resumeWorker(
      {
        command: () => this.harness.command("agent-resume"),
        foreign: () => this.sandboxHost.foreign(),
        commandContext: () => this.harness.commandContext(),
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

  /** POST /api/sandbox?path=: set this chat's sandbox state from its next tool call (applySandbox). */
  applySandbox(state: SandboxState): Promise<SandboxApplyResult> {
    return applySandbox(this.sandboxHost, state);
  }

  commands(): ChatServerMessage {
    try {
      return { type: "commands", commands: listCommands(this.harness) };
    } catch (err) {
      console.error("[chat] listing commands failed", err);
      return { type: "commands", commands: [] };
    }
  }

  /** `live`: with the reply in flight so far (a wire-2 client's hello, §chat.transcript/streaming). */
  hello(live = false): Extract<ChatServerMessage, { type: "hello" }> {
    const harness = this.harness;
    const branch = harness.branch();
    const tail = live ? this.liveTail.snapshot() : undefined;
    return {
      type: "hello",
      items: rowsOf(branch),
      isStreaming: harness.isRunning(),
      isCompacting: this.isCompacting(),
      model: harness.model()?.ref ?? null,
      thinking: harness.thinking(),
      context: toContextInfo(contextOfBranch(branch), this.host.models),
      ...(this.alignLaunch?.data ? { alignReview: this.alignLaunch.data.review } : {}),
      ...(tail ? { live: tail } : {}),
    };
  }

  /** The reply in flight, folded from the wire-2 events broadcast (server/chat-runtime/live-tail.ts). */
  private readonly liveTail = new LiveTail();

  attach(client: ChatClient): void {
    // A wire-2 pane that comes while this session's stored reply timings are on their way waits
    // for them, a bounded while, so its one hello carries the reply facts (loadReplyTimings). It
    // joins `clients` at its hello: what it would have been sent before then, the hello holds.
    if (this.timingsLoading && client.wire === 2 && !this.disposed) {
      if (this.helloHeld.has(client)) return;
      const t = setTimeout(() => this.releaseHeld(client), HELLO_WAIT_MS);
      t.unref?.();
      this.helloHeld.set(client, t);
      return;
    }
    this.clients.add(client);
    this.greet(client);
  }

  /** A client's hello and the state its first paint needs, in one synchronous step (attach). */
  private greet(client: ChatClient): void {
    const hello = this.hello(client.wire === 2);
    // A tail client's older rows go last, after the state its first paint needs, and in this same
    // synchronous step, so no event, append or other hello can come between them.
    const cut = client.tail ? cutHello(hello, !client.pull) : null;
    client.send(cut ? firstHelloFor(cut, client, this.replyLookup) : withRows(hello, wireOfClient(client), this.replyLookup));
    client.send(this.commands());
    // The queue goes out on EVERY attach, empty or not: a reconnect resets the pane's live rows to
    // nothing, so a client that is told nothing cannot tell "no queue" from "not told yet" and
    // would show an empty thread over a full queue.
    client.send({ type: "queue", items: this.queue.snapshot() });
    client.send(this.modeMessage());
    // Only while memory is on (or was turned off since): absent means off (§chat.memory/status).
    if (this.memoryAvailable() && this.memory.choice().on) client.send(this.memory.statusMessage());
    this.sendSandbox((m) => client.send(m));
    // Only when there is something to show: a profile, or a session still before its first message.
    if (this.profileState?.data?.profile || this.isPristine()) client.send(this.profileMessage());
    client.send(this.loginAfterHello());
    const snap = this.workersSnapshot();
    if (snap) client.send(snap);
    pushLinks(this, client);
    // The dialogs still waiting, with the time each has left: a pane that joins (a second tab, a
    // reconnect after its chat process lost the server) can answer them (§app.harness/session-open).
    for (const [id, p] of this.pendingUi)
      client.send({ type: "ui_request", id, request: { ...p.request, timeout: p.deadline === undefined ? undefined : Math.max(0, p.deadline - Date.now()) } });
    if (!client.pull) sendHistory(cut, [client], (c) => this.clients.has(c), this.replyLookup);
    client.greeted?.();
  }

  /**
   * The server this chat's process answers to went away (§app.chat-processes/survives-restart): its
   * panes are kept as orphans, each a mute stand-in that still counts as attached, so a pending
   * dialog stays open and a new one may open. Nothing is sent to them.
   */
  orphanClients(): void {
    for (const c of [...this.clients]) {
      if (this.orphans.has(c)) continue;
      this.clients.delete(c);
      const ghost: ChatClient = { send: () => {}, ...(c.wire ? { wire: c.wire } : {}), ...(c.tail ? { tail: c.tail } : {}), ...(c.pull ? { pull: c.pull } : {}) };
      this.orphans.add(ghost);
      this.clients.add(ghost);
    }
  }

  /** The orphans go: a pane came back (dialogs stay), or none did in time (`resolveDialogs`: the
      last-pane rule applies, as when the last pane leaves). */
  dropOrphans(opts: { resolveDialogs: boolean }): void {
    for (const ghost of this.orphans) this.clients.delete(ghost);
    this.orphans.clear();
    if (opts.resolveDialogs && this.clients.size === 0) this.resolveDialogsUnanswered();
  }

  private readonly orphans = new Set<ChatClient>();

  private resolveDialogsUnanswered(): void {
    for (const p of this.pendingUi.values()) p.resolve(undefined);
    this.pendingUi.clear();
  }

  detach(client: ChatClient): void {
    const held = this.helloHeld.get(client);
    if (held) clearTimeout(held);
    this.helloHeld.delete(client);
    this.greetedEarly.delete(client);
    this.clients.delete(client);
    if (this.clients.size === 0 && this.helloHeld.size === 0) {
      // Nobody can answer open dialogs anymore: resolve them with defaults. The runtime stays
      // alive: a session closes when the user archives it, not when the last tab leaves.
      this.resolveDialogsUnanswered();
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
    images?: ImageInput[],
    origin: QueueItem["origin"] = "server",
    clientId?: string,
    /** `replay: true` = this text came OUT of the transcript, so it is already expanded and must
        be sent verbatim. Without it the SDK would expand skills and templates a SECOND time, and a
        stored message that merely begins with "/" would be DISPATCHED as an extension command
        instead of replayed — a regenerate that runs a command rather than redoing the turn. */
    /** `sentByOverseer`: mark the user entry as the Overseer's (§app.overseer/sent-marker), now
        or, when it is queued, at its hand-off; `sentByBaton` likewise marks it as a baton
        participant's (§app.baton/attribution). `delivery`: the kind it is queued as mid-turn, as
        the composer's Steer or a Playbook's follow-up; idle, either is a plain prompt. */
    opts?: {
      replay?: boolean;
      sentByOverseer?: { overseerId?: string };
      sentByBaton?: { by: string };
      /** Another session's `session_send` (§chat.profiles/delivery): marked `sova-session-sent`. */
      sentBySession?: { sessionId: string; title: string; hop: number };
      delivery?: WebQueueItem["kind"];
      confirm?: string;
      /** A person typed it elsewhere (a group batch): its input source is `interactive` (inputSourceOf). */
      byPerson?: true;
    },
  ): { queued: boolean; turn: Promise<void> } {
    // Never write if a TUI grabbed this file, or anyone else wrote it, after we opened it.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    // Blank text with no image is a no-op first of all: it is not a message, so it never lifts
    // the pause (§chat.topics/delivery).
    if (!text.trim() && !images) return { queued: false, turn: Promise.resolve() };
    // The user's own message lifts a Stop's pause on topic batches (§chat.topics/delivery).
    if (origin === "client" && !opts?.replay) this.setTopicsPaused(false);
    // While streaming, a plain prompt is a follow-up — held in Sova's own queue now, so it can
    // still be taken back one item at a time. Server-originated prompts (a group batch, a remote
    // status probe) queue on the same terms as a client's: they are messages to this session, and
    // a queue that some messages could skip would not be a queue.
    // A compaction running is the same: pi refuses every prompt until it ends, so the message is
    // held, and the queue hands it over (as a fresh turn) at compaction_end.
    if (this.harness.isRunning() || this.isCompacting() || this.starting) {
      const overseer = opts?.sentByOverseer ? { overseer: opts.sentByOverseer } : {};
      const baton = opts?.sentByBaton ? { baton: opts.sentByBaton } : {};
      const fromSession = opts?.sentBySession ? { session: opts.sentBySession } : {};
      const confirm = opts?.confirm ? { confirm: opts.confirm } : {};
      const byPerson = opts?.byPerson ? { byPerson: true as const } : {};
      this.queue.enqueue({ kind: opts?.delivery ?? "followUp", text, images: images as QueueImage[] | undefined, origin, id: clientId, ...overseer, ...baton, ...fromSession, ...confirm, ...byPerson });
      return { queued: true, turn: Promise.resolve() };
    }
    this.flushDeferredAppends();
    // Marked here when it starts a turn now; a queued one is marked at its hand-off. A pending
    // mark is dropped if the turn fails, and any left when the run settles are dropped too
    // (bind's agent_settled), so a later identical message the user types is never tagged.
    const sender: Sender | null = opts?.sentByOverseer
      ? { kind: "overseer", ...(opts.sentByOverseer.overseerId ? { overseerId: opts.sentByOverseer.overseerId } : {}) }
      : opts?.sentByBaton
        ? { kind: "baton", by: opts.sentByBaton.by }
        : opts?.sentBySession
          ? { kind: "session", ...opts.sentBySession }
          : null;
    const send: SenderMark | null = sender ? { text, sender } : null;
    if (send) this.senderMarks.push(send);
    if (opts?.sentBySession) this.profileState?.run?.expectHop(text, opts.sentBySession.hop);
    const source = inputSourceOf({ origin, ...(opts?.sentByOverseer ? { overseer: opts.sentByOverseer } : {}), ...(opts?.sentByBaton ? { baton: opts.sentByBaton } : {}), ...(opts?.byPerson ? { byPerson: true as const } : {}) });
    const turn = this.toSdk(origin, () => this.tracked(opts?.replay ? "" : text, () => this.harness.send(text, { images, source, ...(opts?.replay ? { expand: false } : {}) })), opts?.confirm);
    this.noteStarting(turn);
    if (send)
      turn.catch(() => {
        const i = this.senderMarks.indexOf(send);
        if (i >= 0) this.senderMarks.splice(i, 1);
      });
    // A replay is not re-queued: the queue would expand it a second time (see `replay` above).
    if (opts?.replay) return { queued: false, turn };
    // Held under the sender's own id: this send was never a queue item, so the id is still free.
    const held = (err: unknown) => {
      const item = {
        kind: opts?.delivery ?? "followUp",
        text,
        images: images as QueueImage[] | undefined,
        origin,
        id: clientId,
        ...(opts?.sentByOverseer ? { overseer: opts.sentByOverseer } : {}),
        ...(opts?.sentByBaton ? { baton: opts.sentByBaton } : {}),
        ...(opts?.sentBySession ? { session: opts.sentBySession } : {}),
        ...(opts?.confirm ? { confirm: opts.confirm } : {}),
        ...(opts?.byPerson ? { byPerson: true as const } : {}),
      };
      if (!this.heldForCompaction(err, item)) throw err;
    };
    return { queued: false, turn: turn.catch(held) };
  }

  /** Accept a prompt AND wait for the turn. The /ws/chat path, where the socket reports the
      turn's own failure to the one client that asked for it. A queued message's "turn" is already
      resolved: its failure, when it comes, reports through the queue's own hand-off path. */
  async prompt(text: string, images?: ImageInput[], origin: QueueItem["origin"] = "server", clientId?: string): Promise<boolean> {
    const { queued, turn } = this.acceptPrompt(text, images, origin, clientId);
    await turn;
    return queued;
  }

  /**
   * A marked user message has just ended: write its sender's invisible marker — `sova-overseer-sent`
   * for the Overseer, `sova-baton-sent` for a baton participant — pointing at that entry (the `sova-rewind` pattern — never LLM context, the TUI ignores
   * it). Listeners run BEFORE the SDK persists the message (agent-session.js `_handleAgentEvent`:
   * `_emit`, then `appendMessage`, in the same synchronous stretch), so the write waits one
   * microtask, by which time the entry exists and is the leaf. The marker is parented on it, and
   * the reply is then parented on the marker: rewind (to the user entry's parent) and regenerate
   * (walking back past custom entries to the user entry) behave exactly as on any user turn.
   */
  private markSend(text: string): void {
    const i = this.senderMarks.findIndex((s) => s.text === text);
    if (i < 0) return;
    const [send] = this.senderMarks.splice(i, 1);
    queueMicrotask(() => {
      if (this.disposed || this.foreignWrite) return;
      const leaf = this.harness.leafId();
      const entry = leaf ? this.harness.entry(leaf) : undefined;
      if (entry?.kind !== "user") return;
      const markerId = appendSenderMarker(this.harness.state, entry.id!, send?.sender ?? { kind: "overseer" });
      markOwned(this.path);
      const marker = this.harness.entry(markerId);
      if (marker) {
        const items = rowsOfEntry(marker);
        if (items.length) this.broadcast({ type: "append", items });
      }
    });
  }

  /**
   * Stop the run, keeping the queued messages `keep` picks (the rest go back as `queue_cleared`,
   * as Stop's do). Returns the kept ones, for `enterQueued` once nothing runs any more.
   */
  async stopRun(keep: (item: WebQueueItem) => boolean): Promise<WebQueueItem[]> {
    const { steering, followUp, kept } = await this.queue.drain(keep);
    if (steering.length || followUp.length) this.broadcast({ type: "queue_cleared", steering, followUp });
    await this.harness.abort();
    return kept;
  }

  /** Stop the run and write the queued messages `keep` picks into the transcript as their senders'
      (stopRun, then enterQueued): a baton session's Stop, and its clean close. */
  async keepQueued(keep: (item: WebQueueItem) => boolean): Promise<number> {
    const since = this.leafId();
    return this.enterQueued(await this.stopRun(keep), since);
  }

  /**
   * Stop the reply in flight and keep every queued message, written into the transcript as its
   * sender's (a baton session's stop-reply). A queue wake could start another run as this one
   * settles, so it checks again, a few times at most. Returns how many it wrote.
   */
  async interruptKeepingQueued(): Promise<number> {
    const since = this.leafId();
    const kept: WebQueueItem[] = [];
    for (let i = 0; i < 3 && (this.harness.isRunning() || this.isCompacting() || this.turnStarting); i++) {
      // A turn that is starting (a message just handed over) can't be aborted until its run begins.
      await this.whenStarted();
      kept.push(...(await this.stopRun(() => true)));
    }
    return this.enterQueued(kept, since);
  }

  /** The current leaf, the point `enterQueued` looks back to for messages the run took itself. */
  leafId(): string | null {
    return this.harness.leafId();
  }

  /**
   * Write queued messages a stopped run never took into the transcript as their senders' user
   * messages (with the `sova-baton-sent` / `sova-overseer-sent` marker), with no turn: nothing
   * anyone sent is lost when a reply is cut short (§app.baton/hand-off). One the run did take
   * after `since` (a message in the transcript with its text) is not written twice. The model
   * reads them with the next turn. Refused mid-turn, like appendStateRow.
   */
  enterQueued(items: readonly WebQueueItem[], since: string | null): number {
    if (!items.length) return 0;
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.harness.isRunning() || this.isCompacting()) throw new BusyError("Wait for the reply to finish first.", "busy");
    const branch = this.harness.branch();
    const from = since ? branch.findIndex((h) => h.id === since) + 1 : 0;
    const taken = branch
      .slice(from)
      .map((h) => (h.kind === "user" ? textBlocks(h.blocks) : null))
      .filter((t): t is string => t !== null);
    this.flushDeferredAppends();
    let n = 0;
    for (const item of items) {
      const t = taken.indexOf(item.text);
      if (t >= 0) {
        taken.splice(t, 1);
        continue;
      }
      const marks = this.senderMarks.filter((m) => m.itemId === item.id);
      for (const m of marks) this.dropSenderMark(m);
      const id = this.harness.appendUserMessage(item.text, item.images);
      const sender = senderOfItem(item);
      const markerId = sender ? appendSenderMarker(this.harness.state, id, sender) : null;
      const items = [id, markerId].flatMap((eid) => {
        const entry = eid ? this.harness.entry(eid) : null;
        return entry ? rowsOfEntry(entry) : [];
      });
      if (items.length) this.broadcast({ type: "append", items });
      n++;
    }
    if (n) {
      markOwned(this.path);
      // The agent's context is the session's projection, re-read after a write outside a run, as
      // the SDK does for its own (P6 refresh-context).
      this.harness.refreshContext();
    }
    return n;
  }

  /**
   * Append an invisible entry for a special kind, outside any turn (a baton hand-off the operator
   * made with Take back). The same write guards as a prompt; refused mid-turn, where the entry
   * would land inside the run. Every client gets the row the entry renders as.
   */
  appendStateRow<T>(kind: StateKind<T>, data: T): string {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.harness.isRunning() || this.isCompacting()) throw new BusyError("Wait for the reply to finish first.", "busy");
    const id = this.harness.state.append(kind, data);
    markOwned(this.path);
    const entry = this.harness.entry(id);
    if (entry) {
      const items = rowsOfEntry(entry);
      if (items.length) this.broadcast({ type: "append", items });
    }
    return id;
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
    const markerId = this.state.append(OVERSEER_DIALOG_ANSWER, data);
    markOwned(this.path);
    const marker = this.harness.entry(markerId);
    if (marker) {
      const items = rowsOfEntry(marker);
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
    if (this.harness.isRunning()) throw new Error("Cannot switch models while the agent is running; wait or abort first");
    const found = await this.harness.findModel(ref);
    // The user's own policy first: a model turned off in Settings → Models is refused
    // whether or not it has credentials, and nothing is written (server/model-policy.ts).
    const denial = modelDenial(readModelPolicy(), ref);
    if (denial) throw new Error(denial);
    if (!found.ok) throw new Error(found.error);
    // Re-check after the async lookup: a TUI/foreign writer may have appeared meanwhile.
    // BusyError propagates to `fail`, which maps it to its busy/recent code.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.harness.isRunning()) throw new Error("Cannot switch models while the agent is running; wait or abort first");
    this.flushDeferredAppends(); // keep open-time entries before this model_change
    await this.harness.setModel(found.model);
    this.broadcast({ type: "model", model: this.harness.model()?.ref ?? ref });
    // setModel re-clamps the level to the new model's ladder; the pane needs that too.
    this.broadcast({ type: "thinking", level: this.harness.thinking() });
    // Only the user's pick saves: the Overseer's own chat records it in overseer.json, and a session
    // with no messages yet makes it the next new session's default. A programmatic switch (the
    // Overseer acting on a session, Settings → Overseer) never becomes anyone's default.
    if (opts.save !== true) return;
    // The level too: setModel re-clamped it, and the next conversation is seeded from the file.
    // A special kind keeps it as it says (a baton: in its own file only, never the host's default).
    if (this.special) this.saveSpecialChoice({ model: ref, thinking: this.harness.thinking() });
    else if (this.isPristine()) saveDefaults({ model: ref });
  }

  /** Change thinking level: the `set_thinking` path, shared like setModelRef (and saved, like it,
      only with `save: true`). Returns the effective level. */
  setThinking(level: string, opts: { save?: boolean } = {}): string {
    // setThinkingLevel appends a thinking_level_change entry: same write guards as set_model.
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    if (this.harness.isRunning()) throw new Error("Cannot change thinking while the agent is running; wait or abort first");
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown thinking level: ${level || "(empty)"}`);
    this.flushDeferredAppends(); // keep open-time entries before this thinking_level_change
    // The SDK clamps to what the model supports, so the echo is the effective level.
    const before = this.harness.thinking();
    this.harness.setThinking(level);
    const after = this.harness.thinking();
    this.broadcast({ type: "thinking", level: after });
    // The SDK's appendThinkingLevelChange emits no entry_appended (only the extension
    // appendEntry API does), so the "Thinking: X" row is synthesized here; the next
    // hello/resync replaces it with the real entry.
    if (after !== before)
      this.broadcast({
        type: "append",
        items: [{ id: `thinking-${Date.now()}`, kind: "info", meta: { type: "thinking_level_change" }, text: `Thinking: ${after}` }],
      });
    if (opts.save !== true) return after;
    if (this.special) this.saveSpecialChoice({ thinking: after });
    // A session with no messages yet: this level is also the next new session's default (never a special kind's).
    else if (this.isPristine()) saveDefaults({ thinking: after });
    return after;
  }

  /** Report a failure into this session's own pane(s) — where every other turn failure already
      reports. Used for a turn nobody is awaiting (the group batch dispatches and returns). */
  reportTurnFailure(err: unknown): void {
    const code = errorCode(err);
    // The turn failed on this session's model: name its provider (this session's model cannot move
    // mid-turn — switches are idle-only), so the limit row never has to read the provider out of text.
    const provider = this.harness.model()?.provider;
    this.broadcast({ type: "error", code, message: err instanceof Error ? err.message : String(err), ...(provider ? { provider } : {}) });
  }

  /** A composer message its kind attributes (a baton session: only while the operator holds the
      baton): the kind decides who sent it, before anything is queued or written; a refusal from
      acceptPrompt itself is handed back to the kind. */
  private async clientSend(port: SpecialPort, client: ChatClient, msg: Extract<ChatClientMessage, { type: "prompt" | "steer" }>, clientId: string | undefined, fail: (err: unknown) => void): Promise<void> {
    const out = await port.action("@clientSend", { images: msg.images?.length ?? 0, text: String(msg.text ?? "") });
    if (!out.ok) throw "unknown" in out ? new Error(out.error.message) : new RefusedError(out.error.message);
    const sent = out.result as { by: string; text?: string; images?: ImageInput[] };
    const own = parseImages(msg.images);
    const images = sent.images?.length ? [...(own ?? []), ...sent.images] : own;
    let accepted: ReturnType<ChatSession["acceptPrompt"]>;
    try {
      accepted = this.acceptPrompt(sent.text ?? String(msg.text ?? ""), images, "client", clientId, {
        sentByBaton: { by: sent.by },
        ...(msg.type === "steer" ? { delivery: "steer" as const } : {}),
      });
    } catch (err) {
      void port.action("@clientSendRefused", {}).catch(() => {});
      throw err;
    }
    const { queued, turn } = accepted;
    this.ackSend(client, clientId, queued);
    turn.catch(fail);
  }

  /** A send taken: acknowledged to its sender, and remembered so the same id never runs again. */
  private ackSend(client: ChatClient, clientId: string | undefined, queued: boolean): void {
    if (!clientId) return;
    this.takenSends.set(clientId, true);
    client.send({ type: "send_ack", clientId, queued });
  }

  /** Whether a prompt or steer by this id was taken (or is being taken) already: a taken one is
      acknowledged again, never run. Otherwise it is noted as being taken. */
  private sentBefore(client: ChatClient, clientId: string): boolean {
    const taken = this.takenSends.get(clientId);
    if (taken === undefined) {
      this.takenSends.set(clientId, false);
      if (this.takenSends.size > TAKEN_SENDS_MAX) this.takenSends.delete(this.takenSends.keys().next().value!);
      return false;
    }
    if (taken) client.send({ type: "send_ack", clientId, queued: this.queue.snapshot().some((it) => it.id === clientId) });
    return true;
  }

  /** `msg` waits for `step` (a model switch, a rewind), and so does every browser message after it.
      Only when it can go ahead: mid-run (or mid-compaction) both are refused at once, so nothing
      waits and the refusals keep the order they always had (the session goldens' S14). */
  private waitFor(step: Promise<unknown>): void {
    if (this.harness.isRunning() || this.isCompacting()) {
      void step;
      return;
    }
    const tail = step.then(
      () => {},
      () => {},
    );
    this.behind = tail;
    void tail.then(() => {
      if (this.behind === tail) this.behind = null;
    });
  }

  handle(client: ChatClient, msg: ChatClientMessage): void {
    // A message after a model switch or a rewind still under way waits for it, so what the person
    // asked first is applied first (§chat.transcript/send-while-starting). A dialog's answer and a
    // Stop never wait.
    if (this.behind && msg.type !== "ui_response" && msg.type !== "abort") {
      const tail = this.behind.then(() => this.handleNow(client, msg));
      this.behind = tail;
      void tail.then(() => {
        if (this.behind === tail) this.behind = null;
      });
      return;
    }
    this.handleNow(client, msg);
  }

  private handleNow(client: ChatClient, msg: ChatClientMessage): void {
    // The failing send's own id rides along when it has one, so the client restores THAT draft and
    // no other; a chat-wide failure still reports without one, exactly as before.
    const clientId = "clientId" in msg && typeof msg.clientId === "string" && msg.clientId ? msg.clientId : undefined;
    const fail = (err: unknown) => {
      // Refused before it was taken: the same id may be sent again.
      if (clientId && this.takenSends.get(clientId) === false) this.takenSends.delete(clientId);
      const code = errorCode(err);
      client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err), ...(clientId ? { clientId } : {}) });
    };
    if (this.disposed) {
      // A prompt comes back to the draft first; the reconnect alone would drop it in silence.
      const refusal = unsentRefusal(msg);
      if (refusal) client.send(refusal);
      client.send({ type: "error", code: "reloaded", message: "Session runtime was closed; reconnect" });
      return;
    }
    // One at a time (§chat.profiles/singleton): the first message of a session whose profile is
    // live in another one is refused, the draft kept, before anything is written.
    const single = this.profileState?.data?.profile;
    if ((msg.type === "prompt" || msg.type === "steer") && single?.singleton && !this.singletonCleared && singletonCheck && this.isPristine()) {
      singletonCheck(keyOf(single), this.path).then(
        (holder) => {
          if (holder) {
            client.send({ type: "error", code: "refused", message: singletonRaceText(single.label), profileRunning: holder, ...(clientId ? { clientId } : {}) });
            return;
          }
          this.singletonCleared = true;
          this.handleNow(client, msg);
        },
        (err) => fail(err),
      );
      return;
    }
    // Exactly once: a prompt or steer whose id this chat already took is answered as taken.
    if ((msg.type === "prompt" || msg.type === "steer") && clientId && this.sentBefore(client, clientId)) return;
    try {
      switch (msg.type) {
        case "prompt":
        case "steer": {
          // A kind whose composer is closed right now (an archived project's overseer).
          const closed = this.composerClosed();
          if (closed) {
            fail(new BusyError(closed, "busy"));
            return;
          }
          // `/compact [instructions]` as a whole message: Sova's builtin, never text for the
          // model. It runs here, before pi's prompt() could send the literal "/compact" to the
          // model, and before a streaming steer could queue it. The send's own id names the
          // reply; it never becomes a queue row. With images it is refused, not sent without them.
          const compact = compactCommand(String(msg.text ?? ""));
          if (compact) {
            this.ackSend(client, clientId, false);
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
          // A special kind that attributes its composer's messages (a baton session: only while
          // the operator holds the baton) decides here, before anything is queued or written.
          // The model gate runs first, so a refusal never counts against the kind (a baton's budget);
          // a refusal from acceptPrompt itself is handed back through `undo`.
          if (this.specialSpec?.clientSend && this.specialPort) {
            this.assertModelAllowed();
            const port = this.specialPort;
            const step = this.clientSends.then(() => this.clientSend(port, client, msg, clientId, fail));
            this.clientSends = step.catch(fail);
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
          // A confirm card's click in the Overseer (never a typed answer): the turn it opens may act on the card's items.
          const confirm = this.overseer && msg.type === "prompt" && typeof msg.confirm === "string" && msg.confirm ? msg.confirm : undefined;
          const { queued, turn } = this.acceptPrompt(text, images, "client", clientId, confirm ? { confirm } : undefined);
          // The ack goes out NOW, not after the turn: it says whether a queue row exists, and a
          // client that learned that only at turn end would offer Remove for a sent message.
          this.ackSend(client, clientId, queued);
          turn.catch(fail);
          return;
        }
        case "abort":
          // Stop pauses topic batches here until the user's next message (§chat.topics/delivery).
          this.setTopicsPaused(true);
          // The queue drains Sova's held items AND the SDK's, so Stop still means "nothing
          // queued survives this", and the drained text still comes back as `queue_cleared`.
          // In a baton session a participant's queued message is theirs, not the composer's to
          // take back: it enters the transcript instead (§app.baton/hand-off, nothing dropped).
          if (this.special === "baton") {
            // After the composer messages its kind is still attributing (@clientSend): a Stop pressed
            // right after a message stops that message's turn, as it always did.
            this.clientSends = this.clientSends.then(async () => void (await this.keepQueued((it) => !!it.baton && it.baton.by !== OPERATOR))).catch(fail);
            return;
          }
          drainQueueThenAbort(this.harness, (m) => this.broadcast(m), this.queue).catch(fail);
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
        case "regenerate": {
          const refused = this.specialRefuses("regenerate");
          if (refused) throw new Error(refused);
          this.regenerate(client, String(msg.id ?? ""), String(msg.entryId ?? "")).catch(fail);
          return;
        }
        case "set_thinking":
          this.setThinking(String(msg.level ?? ""), { save: true });
          return;
        case "set_model":
          this.waitFor(this.setModelRef(String(msg.ref ?? ""), { save: true }).catch(fail));
          return;
        case "set_claude_login":
          try {
            this.setClaudeLogin(typeof msg.login === "string" ? msg.login : null);
          } catch (err) {
            // A TUI or a foreign writer keeps its busy code; every other refusal is this switch's banner.
            if (err instanceof BusyError) throw err;
            throw new Error(`${LOGIN_UNCHANGED} ${(err instanceof Error ? err.message : String(err)).replace(/\.$/, "")}.`);
          }
          return;
        case "rewind": {
          const refused = this.specialRefuses("rewind");
          if (refused) throw new Error(refused);
          this.waitFor(this.rewind(client, String(msg.id ?? ""), String(msg.entryId ?? "")).catch(fail));
          return;
        }
        case "compact": {
          const instructions = typeof msg.instructions === "string" ? msg.instructions.trim() : "";
          this.compact(client, String(msg.id ?? ""), instructions || undefined).catch(fail);
          return;
        }
        case "reload_code": {
          // A chat in the server's own process runs the server's code: it is current
          // (§app.chat-processes/code-pickup). A chat process answers it itself (setCodeReload).
          if (codeReload) codeReload(client);
          else client.send({ type: "code", state: "current" });
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
  private onCompactionEvent(event: HarnessEvent): boolean {
    try {
      if (event.type === "compaction.end" && !this.compactRunning && event.wrote) {
        if (this.harness.isRunning()) {
          this.refreshAtSettle = true;
          return false;
        }
        setImmediate(() => {
          if (this.disposed) return;
          try {
            this.refreshAfterCompaction()();
          } catch (err) {
            console.error("[chat] refresh after compaction failed", err);
          }
          if (!this.disposed) this.queue.onSdkEvent();
        });
        return true;
      }
      if (event.type === "run.settled" && this.refreshAtSettle) {
        this.refreshAtSettle = false;
        this.refreshAfterCompaction()();
      }
    } catch (err) {
      console.error("[chat] refresh after compaction failed", err);
    }
    return false;
  }

  /** afterBranchMove, then the queue snapshot: that hello reset every client's pending rows, and the
      snapshot is what rebuilds them (as on attach). */
  private refreshAfterCompaction(): () => void {
    const history = this.afterBranchMove();
    if (this.disposed) return history;
    this.broadcast({ type: "queue", items: this.queue.snapshot() });
    return history;
  }

  /** The `steer` case of handle(), whose failures `fail` reports to the sender. */
  private steer(client: ChatClient, msg: Extract<ChatClientMessage, { type: "steer" }>, clientId: string | undefined, fail: (err: unknown) => void): void {
    assertNotLive(this.path);
    this.assertNoForeignWrites();
    this.assertModelAllowed();
    const text = String(msg.text ?? "");
    const images = parseImages(msg.images);
    if (!text.trim() && !images) return;
    this.setTopicsPaused(false);
    // Mid-turn, this is a steer and goes through Sova's queue so it stays removable; idle,
    // there is nothing to queue behind, so it starts its turn straight away (and the
    // extension-command split lives in handOffQueued, which both paths reach). While a
    // compaction runs it is held the same way, and goes in when the compaction ends.
    if (this.harness.isRunning() || this.isCompacting()) {
      this.queue.enqueue({ kind: "steer", text, images: images as QueueImage[] | undefined, origin: "client", id: clientId });
      this.ackSend(client, clientId, true);
      return;
    }
    this.flushDeferredAppends();
    this.ackSend(client, clientId, false);
    this.toSdk("client", () => this.tracked(text, () => this.harness.send(text, { images })))
      .catch((err) => {
        if (!this.heldForCompaction(err, { kind: "steer", text, images: images as QueueImage[] | undefined, origin: "client", id: clientId })) throw err;
      })
      .catch(fail);
  }

  /**
   * The client's /compact (HarnessSession.compact), then the same refresh a rewind does: pi emits no
   * `entry_appended` for a manual compaction's entry, so every client gets a fresh hello (items
   * ending in the compaction row, context null until the next reply), workers and mode. Only the
   * requester gets the outcome. `compactRunning` spans the whole call, from before pi's own
   * `isCompacting` turns true until after it is false again. Whatever the queue held meanwhile goes
   * AFTER the hello: that hello resets every client's live rows, so the queue snapshot follows it
   * (as on attach) and only then is the queue woken — a turn started first would be wiped from the
   * pane by the hello that describes the branch before it.
   */
  private async compact(client: ChatClient, id: string, instructions: string | undefined): Promise<void> {
    const memory = this.memoryAvailable() ? this.memory.choice() : undefined;
    if (memory?.on && memory.type === "uniichat") {
      client.send({ type: "compact_refused", id, reason: "cancelled", message: MEMORY_COMPACTION_REFUSAL });
      return;
    }
    if (this.compactRunning) {
      client.send({ type: "compact_refused", id, reason: "compacting", message: "A compaction is already running." });
      return;
    }
    this.compactRunning = true;
    let outcome: CompactOutcome;
    try {
      outcome = await this.harness.compact(instructions, {
        guard: () => {
          assertNotLive(this.path);
          this.assertNoForeignWrites();
        },
        refusal: busyRefusal,
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
      const history = this.refreshAfterCompaction();
      if (this.disposed) return;
      client.send({ type: "compacted", id, entryId: outcome.entryId, tokensBefore: outcome.tokensBefore });
      history();
    }
    this.queue.onSdkEvent();
    this.releaseLinks(false);
  }

  /**
   * The client's rewind (HarnessSession.rewindTo), then the refresh no SDK event does: every client gets a
   * fresh hello (branch-based, so transcript and context fill follow the new leaf) and this chat's
   * mode re-resolved from the new branch, as bind() does (the mode extension re-resolves on
   * session_tree too), with the workers snapshot between them. Only the requester gets the text back.
   */
  private async rewind(client: ChatClient, id: string, entryId: string): Promise<void> {
    const outcome = await this.harness.rewindTo(entryId, {
      guard: () => {
        assertNotLive(this.path);
        this.assertNoForeignWrites();
      },
      refusal: busyRefusal,
      queued: () => this.hasPendingSends(),
      beforeMarker: () => this.flushDeferredAppends(),
    });
    if (!outcome.ok) {
      client.send({ type: "rewind_refused", id, entryId, reason: outcome.reason, message: outcome.message });
      return;
    }
    const history = this.afterBranchMove();
    if (this.disposed) return;
    client.send({ type: "rewound", id, entryId, editorText: outcome.editorText });
    history();
  }

  /**
   * Redo the turn an assistant entry belongs to: rewind to just before the user message that
   * started it, then send that message again — its own stored text and images, with the session's
   * CURRENT model and thinking level, which is what makes "switch model, then regenerate" a
   * comparison rather than a repeat.
   *
   * Order is load-bearing in two places. The model policy is checked BEFORE the rewind, so a
   * session sitting on a switched-off model refuses without having thrown its branch away. And the
   * rewind goes through `rewindTo`, so the invisible `sova-rewind` marker is written before
   * the prompt: if the prompt then fails, a reload still lands on the new branch instead of
   * silently restoring the reply the user asked to replace.
   */
  private async regenerate(client: ChatClient, id: string, entryId: string): Promise<void> {
    const refuse = (reason: RegenerateRefusal, message: string) =>
      client.send({ type: "regenerate_refused", id, entryId, reason, message });
    const target = resolveRegenerate(this.harness.branch(), entryId);
    if (!target.ok) return refuse(target.reason, target.message);
    try {
      this.assertModelAllowed();
    } catch (err) {
      return refuse("internal", err instanceof Error ? err.message : String(err));
    }
    const outcome = await this.harness.rewindTo(target.userId, {
      guard: () => {
        assertNotLive(this.path);
        this.assertNoForeignWrites();
      },
      refusal: busyRefusal,
      queued: () => this.hasPendingSends(),
      beforeMarker: () => this.flushDeferredAppends(),
    });
    if (!outcome.ok) return refuse(outcome.reason, outcome.message);
    const history = this.afterBranchMove();
    if (this.disposed) return;
    client.send({ type: "regenerated", id, entryId, userEntryId: target.userId });
    history();
    // The branch is now at the point before the user message, so the session is idle and this
    // starts a turn rather than queueing. Its failure reports into this session's pane, where
    // every other turn failure already does.
    const { turn } = this.acceptPrompt(target.text, target.images as ImageInput[] | undefined, "client", undefined, { replay: true });
    turn.catch((err) => this.reportTurnFailure(err));
  }

  /** The refresh no SDK event does after the leaf moved: a fresh hello (branch-based, so transcript
      and context fill follow the new leaf), the workers snapshot, and this chat's mode re-resolved
      from the new branch as bind() does. Shared by rewind, regenerate and compact so they can never
      drift into telling clients different things about the same move.
      Returns the older rows' send for tail clients (server/tail-hello.ts): the caller runs it right
      after the requester's own ack, still in the same step, so the requester's composer text never
      waits behind a long history and nothing else comes between the chunks. */
  private afterBranchMove(): () => void {
    if (!this.foreignWrite) markOwned(this.path); // the marker (or compaction) entry is our write
    if (this.disposed) return () => {};
    const hello = this.hello();
    let cut: CutHello | null = null;
    const whole = perWire(hello, this.replyLookup);
    const tails: ChatClient[] = [];
    const pushed = [...this.clients].some((c) => c.tail && !c.pull);
    for (const c of this.clients) {
      if (c.tail) {
        cut ??= cutHello(hello, pushed);
        if (!c.pull) tails.push(c);
        c.send(helloFor(cut, c, this.replyLookup));
      } else deliver(c, whole);
    }
    // Every client's hello handler clears its worker list, and pushWorkers only sends on change,
    // so an unchanged set would stay blank: re-send it now (attach() does the same after hello).
    const workers = this.workersSnapshot();
    if (workers) {
      this.lastWorkersJson = JSON.stringify(workers);
      this.broadcast(workers);
    }
    this.modeState = chatModeOf(this.harness.state.branch());
    this.broadcast(this.modeMessage());
    if (this.memoryAvailable()) this.memory.changed(); // the engine re-syncs on session_tree
    this.sendSandbox((m) => this.broadcast(m)); // the extension re-restores on session_tree too
    this.broadcast(this.loginAfterHello()); // the new branch's newest entry
    pushLinks(this); // after every hello, as attach() does
    return () => sendHistory(cut, tails, (c) => this.clients.has(c), this.replyLookup);
  }

  /** `msg` to every client, on its wire (server/wire-rows.ts): wire 1 the message itself, wire 2 its
      mapping, made once for all the wire-2 clients. */
  broadcast(msg: ChatServerMessage): void {
    // The list's `chat` field says these (heldChatState): the next listing is built afresh.
    if (msg.type === "model" || msg.type === "thinking" || msg.type === "mode") sessionsChanged();
    if (this.held) {
      this.held.push(msg);
      return;
    }
    let on2: (ChatServerMessage | V2EventFrame)[] | undefined;
    // Every live event folds into the reply so far, whoever is attached: a pane that joins later
    // starts from it.
    if (msg.type === "event") for (const f of (on2 ??= onWire(msg, 2, this.replyLookup))) if (f.type === "event" && "v" in f && f.v === 2) this.liveTail.apply(f.event);
    let on1: ChatServerMessage | undefined;
    for (const c of this.clients) {
      if (c.wire === 2) for (const m of (on2 ??= onWire(msg, 2, this.replyLookup))) c.send(m);
      // Wire 1 stays byte for byte: a message_end's reply timing rides wire 2 only.
      else c.send((on1 ??= onWire1(msg)));
    }
  }

  /** An idle note's rows, once its entry is known (after holdForEntryId's flush, queued before this).
      The pane renders an idle note only from this append (its message_end makes no row of a note), so
      a client that one day also rows the message_end would show it twice. */
  private appendIdleNote(message: unknown, noteType: string): void {
    queueMicrotask(() => {
      try {
        // pi writes a note as a new entry, not the message object it emits: by its id when the
        // harness knows it, else the branch's last entry when it is that note.
        const id = this.harness.persistedId(message);
        const entries = this.harness.entries();
        const last = entries.at(-1);
        const entry = id !== null ? entries.find((h) => h.id === id) : last?.kind === "note" && last.noteType === noteType ? last : undefined;
        const items = entry ? rowsOfEntry(entry) : [];
        if (items.length) this.broadcast({ type: "append", items });
      } catch (err) {
        console.error("[chat] failed to send an idle note", err);
      }
    });
  }

  /** Broadcasts waiting behind a `message_end` until its entry id is known (holdForEntryId). */
  private held: ChatServerMessage[] | null = null;
  /**
   * Sends a `message_end` tagged with the entry the SDK writes its message as (§chat.transcript/rendering,
   * "Switching back": a live row knows its row). Listeners run BEFORE the SDK persists the message
   * (agent-session.js `_handleAgentEvent`: `_emit`, then `appendMessage`, in the same synchronous
   * stretch), so the event waits one microtask, as `markSend` does, and every broadcast meanwhile
   * waits behind it: the order clients see is unchanged. Queued before `markSend`'s, so the leaf
   * read here is still the message, never its marker.
   */
  private holdForEntryId(wire: V1EventFrame, message: unknown, timed: ReplyOutcome | null = null): void {
    if (this.held) {
      this.held.push(wire);
      // Behind an earlier message_end: its record (and its frame's tag) once its entry is written.
      if (timed) queueMicrotask(() => this.recordReply(timed, safeId(this.harness, message), wire));
      return;
    }
    this.held = [wire];
    queueMicrotask(() => {
      let id: string | null = null;
      try {
        id = this.harness.persistedId(message);
        if (id !== null) wire.entryId = id;
      } catch {
        // untagged: a client falls back to the rows it can see
      }
      this.recordReply(timed, id, wire);
      // The entry is on disk now (P12): ours, recorded at once, so a process that dies before the
      // guard's next tick leaves no "recent" behind (§chat.transcript/own-writes-across-restart).
      if (!this.disposed && !this.foreignWrite) this.checkOwnWrites();
      const out = this.held ?? [];
      this.held = null;
      for (const m of out) this.broadcast(m);
    });
  }

  /** Worker snapshot from this runtime's own live record (the sessions extension writes one
      even for embedded runtimes), as the wire message; null when the record or its counts
      are absent. The token Σ rides along: it is the record's own lifetime total, which covers
      workers the record no longer lists, so it is never summed from the rows. */
  private workersSnapshot(): ChatServerMessage | null {
    const rec = readOwnLiveRecords().get(this.path);
    const counts = rec ? workerCountsOf(rec.rec) : undefined;
    if (!rec || !counts) return null;
    // Each worker's context fill, off its own transcript's tail (the record carries no fill);
    // claude-code windows follow the spawn model this session's manifests recorded.
    const workers = withWorkerContext(decodeWorkers(rec.rec?.presence, true), workerContextReader,
      workerWindowResolver(this.host.models), (id) => this.claudeSpawnModel(id));
    return { type: "workers", working: counts.working, total: counts.total, workers };
  }

  /** A claude-code worker's spawn model from this session's manifests, folded once per entry count. */
  private spawnModels: { count: number; of: (id: string) => string | undefined } | null = null;
  private claudeSpawnModel(id: string): string | undefined {
    const entries = this.harness.entries();
    if (this.spawnModels?.count !== entries.length) this.spawnModels = { count: entries.length, of: claudeSpawnModels(extensionEntries(entries)) };
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
    // A baton session closing cleanly (archive, shutdown, reload) keeps every message still
    // waiting in its queue, as its sender's: nothing sent is dropped (§app.baton/hand-off). A
    // refused write (a foreign one, the TUI) keeps nothing, said in the log.
    if (this.special === "baton" && (this.queue.size || this.turnStarting))
      await this.whenStarted()
        .then(() => this.keepQueued((it) => !!it.baton))
        .catch((err) => console.warn(`[chat] queued messages not kept at close: ${err instanceof Error ? err.message : String(err)}`));
    this.disposed = true;
    for (const t of this.helloHeld.values()) clearTimeout(t);
    this.helloHeld.clear();
    this.memoryRef?.dispose();
    this.modeActionsRef?.dispose();
    this.queue.close(); // nothing more is handed to a runtime that is going away
    if (this.guardTimer) clearInterval(this.guardTimer);
    if (this.workersTimer) clearInterval(this.workersTimer);
    this.unsubscribe?.();
    this.streamGuardOff?.();
    for (const p of this.pendingUi.values()) p.resolve(undefined);
    this.pendingUi.clear();
    if (held.get(this.path) === this) held.delete(this.path); // a reload may already hold a newer one
    this.onDisposed();
    emitChatEvent(this.path, "closed");
    // Recorded now as well as after: the run's last entry (a reply a shutdown cut off) is already
    // written, and a stop that ends the process before the runtime's own dispose returns must not
    // leave it reading as another process's write (§chat.transcript/own-writes-across-restart).
    this.recordOwnWrites();
    try {
      await this.host.dispose();
    } catch (err) {
      console.error("[chat] runtime dispose failed", err);
    }
    // Remember the state we left the file in, so reopening soon — by this process or the next one,
    // after a restart — isn't mistaken for a foreign write. Only what the guard verifies: the
    // shutdown appends are our SessionManager's own entries, and anything else records nothing.
    this.recordOwnWrites();
  }

  /**
   * Extension dialog bridge (server/harness/pi/ui-bridge.ts turns pi's UI calls into it): a dialog is
   * broadcast as ui_request and resolved by the first ui_response; a fire-and-forget request
   * (notify, setStatus) is forwarded with request.fireAndForget = true.
   */
  private readonly dialogs: DialogBridge = {
    open: <T>(
      request: Record<string, unknown>,
      fallback: T,
      parse: (value: unknown) => T,
      opts: { signal?: AbortSignal; timeout?: number } | undefined,
    ): Promise<T> => {
      if (opts?.signal?.aborted || (this.clients.size === 0 && this.helloHeld.size === 0)) return Promise.resolve(fallback);
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
          ...(opts?.timeout ? { deadline: Date.now() + opts.timeout } : {}),
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
    },
    fireAndForget: (request) => this.broadcast({ type: "ui_request", id: randomUUID(), request: { ...request, fireAndForget: true } }),
  };
}

/** Where a session's `links` rows come from (§mesh.links/agents-pane): server/mesh/links.ts
    registers it through server/link-delivery.ts. Unset, no chat gets a `links` frame. */
type LinksSource = (sessionId: string, path: string) => Promise<LinkedAgentInfo[]>;
let linksSource: LinksSource | null = null;
export function setLinksSource(fn: LinksSource | null): void {
  linksSource = fn;
}

/** Send `links` to one client, or to every client of the chat. Best-effort: a failed read sends
    nothing, and the insight poll still carries the rows. */
function pushLinks(chat: ChatSession, client?: ChatClient): void {
  const source = linksSource;
  if (!source) return;
  source(chat.harness.id, chat.path)
    .then((links) => {
      if (chat.disposed) return;
      const msg: ChatServerMessage = { type: "links", links };
      if (client) {
        if (chat.clients.has(client)) client.send(msg);
      } else chat.broadcast(msg);
    })
    .catch((err) => console.error("[chat] links frame failed", err));
}

/** A link message landed, or a link was made or ended: push `links` to every held chat of those
    sessions, and to the Overseer's, whose pane lists every link on this host. */
export function notifyLinksChanged(sessionIds: readonly string[]): void {
  for (const fn of linksListeners) fn(sessionIds);
  const ids = new Set(sessionIds);
  for (const chat of heldChats()) {
    if (!chat.clients.size) continue;
    if (chat.overseer || ids.has(chat.harness.id)) pushLinks(chat);
  }
}

/** Who else hears a links change: the chats in processes of their own (server/chat-handle.ts). */
const linksListeners = new Set<(sessionIds: readonly string[]) => void>();
export function onLinksNotified(fn: (sessionIds: readonly string[]) => void): () => void {
  linksListeners.add(fn);
  return () => linksListeners.delete(fn);
}
/** A session's `links` rows from this server's source, for a chat that asks from its own process. */
export const linksFor = (sessionId: string, path: string): Promise<LinkedAgentInfo[]> => (linksSource ? linksSource(sessionId, path) : Promise.resolve([]));
/** This server's singleton check, for a chat that asks from its own process. */
export const singletonFor = (key: string, path: string): Promise<{ id: string; path: string; title: string } | null> =>
  singletonCheck ? singletonCheck(key, path) : Promise.resolve(null);

/** Every chat's lifecycle events, numbered across this runtime (shared/chat-runtime.ts
    ChatLifecycleEvent); the server hears them through server/chat-handle.ts. The newest are kept,
    so a consumer that missed some can ask for the ones after the last seq it saw. */
let eventSeq = 0;
const EVENTS_KEPT = 256;
const recentEvents: ChatLifecycleEvent[] = [];
const eventListeners = new Set<(event: ChatLifecycleEvent) => void>();
const LISTENER_NAME: Record<ChatLifecycleEvent["type"], string> = {
  started: "agent_start",
  settled: "agent_settled",
  receiverIdle: "receiver-idle",
  closed: "closed",
  topicEntered: "topic-entered",
  topicGone: "topic-gone",
};
/** Listeners run inside the event, each on its own: one that throws is logged and the rest still run. */
export function onChatEvent(fn: (event: ChatLifecycleEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}
/** The kept events with a seq above `seq`, oldest first. */
export const chatEventsSince = (seq: number): ChatLifecycleEvent[] => recentEvents.filter((e) => e.seq > seq);
export function emitChatEvent(chatId: string, type: ChatLifecycleEvent["type"], batch?: string): void {
  const event: ChatLifecycleEvent = { seq: ++eventSeq, chatId, type, at: Date.now(), ...(batch ? { batch } : {}) };
  recentEvents.push(event);
  if (recentEvents.length > EVENTS_KEPT) recentEvents.shift();
  for (const fn of eventListeners) {
    try {
      fn(event);
    } catch (err) {
      console.error(`[chat] ${LISTENER_NAME[type]} listener failed`, err);
    }
  }
}
const onEventOf = (type: ChatLifecycleEvent["type"], fn: (path: string) => void): (() => void) =>
  onChatEvent((e) => {
    if (e.type === type) fn(e.chatId);
  });
/** A hosted session started a turn (agent_start): a project's build hears it as `turn/started` (F21). */
export const onAgentStarted = (fn: (path: string) => void): (() => void) => onEventOf("started", fn);
/** A hosted runtime's turn settled or its compaction ended: a topic receiver may take its next
    batch (server/topic-delivery.ts). Called inside the event; listeners defer their own work. */
export const onReceiverIdle = (fn: (path: string) => void): (() => void) => onEventOf("receiverIdle", fn);
/** A hosted chat's run settled (attention signals, tags). */
export const onAgentSettled = (fn: (path: string) => void): (() => void) => onEventOf("settled", fn);

/**
 * The model and thinking a new session opens on instead of the saved new-session defaults, for the
 * next open of that file only (a project's coding session gets its model at creation, so its file
 * never records a switch from the default first). Ignored once the session has a user message.
 */
const openingChoices = new Map<string, { model?: string; thinking?: string; fresh?: { model?: boolean; thinking?: boolean } }>();
/** The opening choice waiting for a session's first open, taken: a host that opens it elsewhere
    hands it on (§app/chat-processes). */
export function takeOpeningChoice(path: string): { model?: string; thinking?: string; fresh?: { model?: boolean; thinking?: boolean } } | undefined {
  const c = openingChoices.get(path);
  openingChoices.delete(path);
  return c;
}
/** `fresh`: open on the model and/or effort a new session would, not the ones the file records. */
export function setOpeningChoice(path: string, choice: { model?: string | null; thinking?: string | null; fresh?: { model?: boolean; thinking?: boolean } }): void {
  const c = { ...(choice.model ? { model: choice.model } : {}), ...(choice.thinking ? { thinking: choice.thinking } : {}), ...(choice.fresh ? { fresh: choice.fresh } : {}) };
  if (Object.keys(c).length) openingChoices.set(path, c);
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
  return !!chat && !chat.disposed && chat.harness.isRunning();
}

/** SessionSummary.chat: a held chat's model, thinking level and mode, as its hello and `mode`
    message would say them, and its sandbox and Claude login as its last such messages did. From memory only; undefined when this server doesn't hold the chat. */
export function heldChatState(path: string): HeldChatState | undefined {
  const chat = held.get(path);
  if (!chat || chat.disposed) return undefined;
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

/** Bring an opened Overseer runtime to overseer.json's model and thinking (its spec's), without the
    composer's write-back (the setting is already what it says). Stale or unauthenticated choices are skipped. */
async function syncOverseerModel(chat: ChatSession, want: Pick<SpecialSpec, "model" | "thinking">): Promise<void> {
  const harness = chat.harness;
  if (want.model && want.model !== (harness.model()?.ref ?? null) && modelAllowed(readModelPolicy(), want.model)) {
    const found = await harness.findModel(want.model).catch(() => null);
    if (found?.ok) await harness.setModel(found.model);
  }
  if (want.thinking && want.thinking !== harness.thinking() && (THINKING_LEVELS as readonly string[]).includes(want.thinking))
    harness.setThinking(want.thinking);
}

// ---- server-hosted tools: the chat's side of the loopback ----------------------------------------

/** What a server-hosted tool reads and writes of the chat that runs it, beyond its ToolCtx. In one
    process it is the chat itself; a chat in its own process sends the reads with the call and runs
    the writes and nested calls as calls back to it, within the call (§app.harness/session-special). */
export interface ServerToolChat {
  /** The active branch at the call, plus what this call appended since (root first). */
  branch(): HEntry[];
  /** Every entry of the file at the call, plus this call's appends. */
  entries(): HEntry[];
  /** Append a state record within this call. `announce`: through the special extension's own writer
      (entry_appended fires: a baton's share refresh), else the chat's state writer. Resolves to the
      new entry's id; it is the leaf after. */
  append<T>(kind: StateKind<T>, data: T, o?: { announce?: boolean }): Promise<EntryId>;
  /** A tool the chat's runtime registered (the subagents extension's), run by the chat within this
      call, with the call's own context and abort signal. */
  tool(name: string): { execute(toolCallId: string, params: unknown): Promise<ToolResult> } | undefined;
}
/** What travels with a server-hosted tool's call only while chat and server share a process. */
export interface ServerToolLocal {
  signal: AbortSignal | undefined;
  onUpdate: ToolUpdate | undefined;
  ctx: ToolCtx | undefined;
  chat: ServerToolChat;
  /** Set by the server when the run threw: the very error, for the chat to throw again. */
  error?: unknown;
}
/** The server's side of server-hosted tools (server/chat-handle.ts installs it). */
export interface ServerToolPort {
  call(call: ServerToolCall, local: ServerToolLocal): Promise<ServerToolOutcome<ToolResult>>;
}

/** A declaration's prepare rule, run by the chat (pi asks for the arguments synchronously): pure,
    from the declaration's own data. */
function prepareOf(decl: ServerToolDecl): ((args: unknown) => unknown) | undefined {
  if (decl.prepares === "owner-area") return (args) => prepareOwnerArea(decl.parameters, args);
  if (decl.prepares === "pi-edit") return piPrepare("pi-edit");
  return undefined;
}

/** Append within a server-hosted call (the chat's side of `ServerToolChat.append`): through the special
    extension's own writer when `announce`, else the chat's state writer; the new entry, now the leaf. */
export async function appendForCall(path: string, kind: string, data: unknown, announce: boolean): Promise<{ entryId: string; entry: HEntry }> {
  const chat = held.get(path);
  if (!chat || chat.disposed) throw new Error("This chat is closed.");
  const k = stateKindOf(kind);
  if (!k) throw new Error(`Unknown state kind: ${kind}`);
  let id: EntryId = "";
  if (announce) {
    const write = specialWriter(path);
    if (!write) throw new Error("This chat has no special loadout to write through.");
    write.append(k, data);
  } else id = chat.harness.state.append(k, data);
  const branch = chat.harness.branch();
  const entry = (id ? branch.find((h) => h.id === id) : undefined) ?? branch[branch.length - 1];
  if (!entry?.id) throw new Error("The entry was not written.");
  return { entryId: entry.id, entry };
}
let serverToolPort: ServerToolPort | null = null;
export function setServerToolPort(port: ServerToolPort): void {
  serverToolPort = port;
}
const portOrThrow = (): ServerToolPort => {
  if (!serverToolPort) throw new Error("This server runs no server-hosted tools.");
  return serverToolPort;
};

/**
 * A server-hosted tool as the chat registers it: its declaration (data), each run a call to the
 * server under an effect id of its own, answered with the run's outcome. The chat's turn as it stands
 * goes with the call (`attended`, `card`), and what the tool reads and writes of the chat beyond its
 * ToolCtx is the chat's own (ServerToolChat).
 */
export function serverToolSpec(chatId: string, decl: ServerToolDecl): ToolSpec {
  const { prepares: _rule, ...fields } = decl;
  const prepare = prepareOf(decl);
  return {
    ...fields,
    ...(prepare ? { prepareArguments: prepare } : {}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const chat = heldChat(chatId);
      if (!chat) throw new Error("This chat is closed.");
      const turns = chat.userTurns;
      const call: ServerToolCall = {
        effectId: `${chatId}#${toolCallId}#${randomUUID()}`,
        chatId,
        toolCallId,
        name: decl.name,
        params,
        attended: turns?.attended() ?? false,
        card: turns?.confirmedCard() ?? null,
      };
      const local: ServerToolLocal = {
        signal,
        onUpdate,
        ctx,
        chat: {
          branch: () => [...chat.harness.branch()],
          entries: () => [...chat.harness.entries()],
          append: async (kind, data, o) => {
            if (!o?.announce) return chat.harness.state.append(kind, data);
            const write = specialWriter(chatId);
            if (!write) throw new Error("This chat has no special loadout to write through.");
            return write.append(kind, data);
          },
          tool: (name) => chat.harness.registeredTool(name) as unknown as ReturnType<ServerToolChat["tool"]>,
        },
      };
      const out = await portOrThrow().call(call, local);
      if (out.ok) return out.result;
      throw local.error ?? new Error(out.error.message);
    },
  };
}

/** The served tools whose names `which` takes, as this chat registers them (`queue_push`'s extension also
    carries any test-only one the server serves, after it). */
const servedSpecs = (chatId: string, which: (name: string) => boolean): ToolSpec[] => (servedDecls ?? []).filter((d) => which(d.name)).map((d) => serverToolSpec(chatId, d));

/** What one chat's special loadout hears of its runs, across the runtimes it builds. */
interface RunHearing {
  turns: UserTurns | null;
  tag: { next?: string };
}

/** The text of a streaming assistant message so far: its text blocks only. */
const replyTextOf = (message: unknown): string => {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
};

/**
 * A special loadout's ear on one runtime its chat builds: the driving session's stream, as data
 * (ChatRunEvent), to the kind's `runEvent`, in the event and its tick. The person's turns are told
 * apart here, by the object their message reaches the agent as (UserTurns), and the prompt is
 * rebuilt at a run's start when the loadout's text for it changed (quirk P19).
 */
function hearRuns(
  session: HarnessSession,
  path: string,
  runs: RunHearing,
  o: { port: SpecialPort | null; replyText: boolean; prompt?: (branch: readonly HEntry[]) => string },
): void {
  const turns = runs.turns;
  turns?.watch(session);
  const emit = (event: ChatRunEvent) => {
    try {
      o.port?.runEvent(event);
    } catch (err) {
      console.error("[chat] run event listener failed", err);
    }
  };
  let prompt: string | undefined;
  session.subscribe((event) => {
    if (event.type === "run.start") {
      if (o.prompt) {
        const text = o.prompt(session.branch());
        if (text !== prompt) {
          prompt = text;
          // The SDK rebuilds the base prompt options from the loader's parts (quirk P19).
          session.refreshSystemPrompt();
        }
      }
      const tag = runs.tag.next;
      runs.tag.next = undefined;
      emit({ type: "run.start", ...(tag !== undefined ? { tag } : {}) });
    }
    if (turns?.observe(event)) emit({ type: "user.entered", card: turns.confirmedCard() });
    if (event.type === "message.update" && event.role === "assistant" && o.replyText) emit({ type: "reply.text", text: replyTextOf(event.handle) });
    if (event.type === "message.end") {
      const card = event.role === "user" ? turns?.confirmedCard() : null;
      if (card) emit({ type: "user.end", card });
      emit({ type: "message.end" });
    }
    if (event.type === "entry.appended") emit({ type: "entry.appended" });
    if (event.type === "run.settled") emit({ type: "run.settled" });
  });
}

async function openSession(path: string, onDisposed: () => void, onStep: (step: string) => void): Promise<ChatSession> {
  if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
  // One writer per session file, across this server and its chat processes (§app.chat-processes/wire):
  // held from the open to the chat's dispose. Another live holder refuses as another writer does.
  let lock: WriterLock;
  try {
    lock = takeWriterLock(path, { unit: process.env.SOVA_CHAT_UNIT ?? null });
  } catch (err) {
    if (err instanceof WriterLockHeld) throw new BusyError(err.message, "recent");
    throw err;
  }
  try {
    return await openLocked(
      path,
      () => {
        lock.release();
        onDisposed();
      },
      onStep,
    );
  } catch (err) {
    lock.release();
    throw err;
  }
}

async function openLocked(path: string, onDisposed: () => void, onStep: (step: string) => void): Promise<ChatSession> {
  // Merely opening (browsing) a session never modifies its file: the model/thinking entries pi records
  // while building it wait in `file.deferred` for the first prompt (server/harness/pi/open.ts, P1).
  onStep("open file");
  const file = await openPiSession(path, cwdOverride(path), onStep);
  // The chat that hosts this runtime, once bound: the vis extension is built before it exists, and
  // until bind() has resolved the chat's mode it reads the mode from the branch itself.
  const visHost: { chat?: ChatSession } = {};
  // The profile the runtime was built with (§chat.profiles/enforcement), read from the branch at
  // every build: a pick disposes the runtime, so a runtime never outlives the profile it has.
  const profile: ProfileState = { data: null, excluded: [] };
  const loadout: LoadoutState = { data: null };
  // What the chat's align mode starts with (alignLaunchOf): its record once the file has one; until
  // then the values its first build took, kept for every rebuild, and written with its first message.
  const launch: AlignLaunch = { data: null, recorded: false };
  // A special loadout's run events and the person's turns (SpecialLoadoutResult.attribution): one
  // for the chat, kept across the runtimes it builds.
  const runs: RunHearing = { turns: null, tag: {} };
  /** The last build's special loadout, if this chat is a special kind's. */
  const last: { special: { spec: SpecialSpec; port: SpecialPort } | null } = { special: null };
  const worker = presetWorkers.get(path) ?? null;
  const build = async ({ cwd, read }: { cwd: string; read: OpenRead }): Promise<PiBuild> => {
    // A worker chat (§app.chat-processes/workers) is its loadout and nothing else.
    if (worker) return workerBuild(worker);
    if (!launch.recorded) {
      const now = alignLaunchOf(read.state);
      if (now.recorded || launch.data === null) Object.assign(launch, now);
    }
    // The outline opt-in is declined for a session an older build marked as a group member, and
    // the FILE says so (FANOUT_MEMBER_ENTRY), not a flag threaded through acquireChat, so the
    // marker survives restarts. Nothing writes the marker any more. Everything else about the loadout — `target`,
    // the experimental claude-code switch — is the same sessionFlags() every runtime gets.
    // The Overseer (server/overseer.ts) is recognised the same way, by its marker, and gets its own
    // loadout: its prompt appended after the user's APPEND_SYSTEM.md, its sova_* tools, a tool
    // allowlist, no topic outline (nobody lists it), and its model from overseer.json.
    const kind = specialFor(read, path);
    const special = kind ? await specialOf(kind, path) : null;
    last.special = special;
    const spec = special?.spec ?? null;
    // A loadout that loads no extension never registers the provider itself: it waits for the
    // runtime's own start, when this process started it (the server at boot; a chat's own process).
    if (spec?.loader.noExtensions && runtimeWarm) await runtimeWarm;
    if (spec?.attribution) runs.turns ??= new UserTurns();
    // The memory minor mode's engine (§chat/memory), bound to the chat that hosts this runtime.
    const memory = () => memoryExtension(() => (visHost.chat && !visHost.chat.disposed ? visHost.chat.memoryHost() : null));
    // A special loadout, built from its spec (server/chat-special.ts): its tools and file tools are the server's.
    const built = special
      ? specialLoadout(path, special.spec, special.port, {
          tool: (decl) => toPiTool(serverToolSpec(path, decl)) as PiToolDefinition,
          memory,
          log: (line) => console.warn(`[chat] ${kind}: ${line}`),
        })
      : null;
    // An ordinary chat gets the default extensions plus the vis feedback extension
    // (server/vis-check.ts); the special loadouts keep exactly their own.
    const data = special ? null : (read.state.branch().latest(PROFILE)?.data ?? null);
    const snap = data?.profile ?? null;
    profile.data = data;
    // The session's own context files and skills (§chat.transcript/setup-card-toggles), also read at
    // every build: a flip disposes the runtime like a pick does. Special loadouts keep their own.
    loadout.data = special ? null : (read.state.branch().latest(LOADOUT)?.data ?? null);
    loadout.baseContext = undefined;
    loadout.baseSkills = undefined;
    const overrides = special ? undefined : loadoutOverrides(loadout);
    profile.run = undefined;
    profile.limits = undefined;
    if (snap?.grant.length) {
      profile.limits = new SessionLimits(read.id, snap.limits);
      profile.run = new RunState(profile.limits);
    }
    const powers =
      snap?.grant.length && profile.run && profile.limits
        ? [sessionPowersExtension({ sessionId: read.id, cwd, title: () => titleOf(read.branch()), profile: snap, run: profile.run, limits: profile.limits, path: () => path })]
        : [];
    const outline = special ? false : !isFanoutMember(read);
    // A link member's tools are fixed by its creation marker, read at every build (§mesh.links/tools).
    const linkTools = isLinkMember(read) ? "member" : "legacy";
    return {
      loader: built
        ? // A special chat that loads extensions (the Overseer, whose subagents start its explorers) has
          // the worker host an ordinary chat has (§app.chat-processes/workers); one that loads none of
          // the operator's (a baton, a project overseer) starts no worker and keeps its own alone.
          special!.spec.loader.noExtensions
          ? built.loader
          : { ...built.loader, extensionFactories: [...(built.loader.extensionFactories ?? []), { name: "sova-worker-host", factory: workerHostExtension }] }
        : {
            extensionFactories: [
              ...DEFAULT_EXTENSION_FACTORIES,
              // Its workers' and hidden chats' host (§app.chat-processes/workers).
              { name: "sova-worker-host", factory: workerHostExtension },
              visCheckExtension(() => (visHost.chat && !visHost.chat.disposed ? visHost.chat.visCheckHost() : null)),
              // The memory minor mode's engine (§chat/memory): idle until memory is turned on.
              memory(),
              // playbook_read, once a schedule's fire delivered a playbook here (§chat.schedules/playbook-read).
              playbookExtension(chatHosts.playbook ?? playbookHost),
              // project_verbs: its own worktrees' running instances (server/project-services/tools.ts).
              servedDecls
                ? servedToolsExtension("sova-project-verbs", servedSpecs(path, (n) => n === "project_verbs"), chatHosts.instanceNote ?? ((ctx) => sessionInstanceNote(projectEngine, ctx)))
                : projectVerbsExtension(projectEngine),
              // queue_push: every ordinary session can answer on a topic (§chat.topics/push).
              servedDecls
                ? servedToolsExtension("sova-topics", servedSpecs(path, (n) => n !== "project_verbs" && n !== QUEUE_OPEN_TOOL && !TOUR_TOOLS.has(n)))
                : queuePushExtension({ sessionId: () => read.id, title: () => titleOf(read.branch()) }),
              servedVisToolsExtension("sova-tours", servedDecls ? servedSpecs(path, n => TOUR_TOOLS.has(n)) : tourTools(read.id, path), () => visHost.chat ? visHost.chat.modeState.minorModes.includes("vis") : undefined),
              ...powers,
            ],
            ...overrides,
          },
      flags: () => sessionFlags(cwd, outline, linkTools, launch.data ?? undefined),
      // Removals: the SDK's excludeTools, a filter on the registry itself, so no extension's
      // setActiveTools or re-registration brings a removed tool back.
      exclude: (present) => (profile.excluded = snap?.remove.length ? excludedTools(snap.remove, present) : []),
      ...(built ? { tools: built.allow, ...(built.customTools.length ? { customTools: built.customTools } : {}) } : {}),
      // A session with no messages yet starts from the saved new-session defaults (web-defaults.ts):
      // the stored model ref is resolved against models with configured auth and the SDK clamps the
      // stored level to the model's ladder. Anything stale or unauthenticated is skipped, so a bad
      // default degrades to pi's own default instead of failing the open.
      opening: () => {
        if (read.branch().some((h) => h.kind === "user")) return null;
        const opening = openingChoices.get(path);
        openingChoices.delete(path);
        const defaults = spec ? { model: spec.model ?? undefined, thinking: spec.thinking ?? undefined } : { ...loadDefaults(), ...opening };
        return {
          // A stored default the user has since turned off is stale like any other: skipped here, so
          // the session opens on pi's own default rather than on a model it would refuse to send with.
          ...(defaults.model && modelAllowed(readModelPolicy(), defaults.model) ? { model: defaults.model } : {}),
          ...(defaults.thinking && (THINKING_LEVELS as readonly string[]).includes(defaults.thinking) ? { thinking: defaults.thinking } : {}),
          ...(opening?.fresh ? { fresh: opening.fresh } : {}),
        };
      },
      forkCacheRouting: !special,
      built: (session) => {
        if (profile.run) {
          const run = profile.run;
          run.turns.watch(session);
          session.subscribe((event) => run.observe(event));
        }
        // A special loadout hears its runs, and tells a message the user sent from every other by
        // the object it reaches the Agent as, from here: where its own watch was, so every listener
        // keeps its place in the order.
        if (special && built) {
          if (special.spec.background) markBackground(session.id);
          hearRuns(session, path, runs, {
            port: special.port,
            replyText: !!special.spec.replyText,
            ...(built.promptAtRunStart ? { prompt: built.promptAtRunStart } : {}),
          });
        }
      },
    };
  };
  const sessionCwd = file.read.cwd;
  // The runtime cannot be built against a directory that is gone. Check before doing the work, so
  // the failure is classified (ConfigError, not "internal") and cheap to repeat.
  const openCwd = sessionCwd ? resolveOpenCwd(path, sessionCwd) : sessionCwd;
  try {
    const host = new PiChatHost(await file.start(openCwd, build));
    let unregisterUsage: (() => void) | undefined;
    const chat = new ChatSession(path, host, () => {
      unregisterUsage?.();
      forgetSpecial(path);
      onDisposed();
    });
    // A Stop pressed before a restart still pauses its topic batches (§chat.topics/delivery).
    chat.topicsPaused = topicStore().receiverPaused(path);
    onStep("extensions start");
    try {
      await chat.bind();
    } catch (err) {
      await chat.dispose();
      throw err;
    }
    onStep("finish");
    visHost.chat = chat;
    chat.deferredAppends = file.deferred;
    if (worker) {
      chat.workerSpec = worker;
      // Its calls are its parent's worker's in the usage ledger (the extension's env attribution, gone).
      unregisterUsage = registerUsageSession(file.read.id, {
        kind: "worker",
        ...(openCwd ? { cwd: openCwd } : {}),
        parent: worker.parent.sessionId,
        worker: worker.parent.workerId,
      });
      try {
        await bringWorkerModel(chat, worker);
      } catch (err) {
        await chat.dispose();
        throw err;
      }
      held.set(path, chat);
      sessionsChanged();
      return chat;
    }
    // An ordinary chat's align launch record (a special loadout — the Overseer, a baton or project
    // overseer session — runs no align mode, so its file gets none and its hello says no flag).
    const kind = specialFor(file.read, path);
    if (!kind) {
      chat.alignLaunch = launch;
      if (!launch.recorded) chat.deferredAppends.push(() => chat.recordAlignLaunch());
    }
    chat.profileState = profile;
    chat.userTurns = runs.turns;
    chat.runTag = runs.tag;
    if (!kind) chat.loadoutState = loadout;
    // The usage ledger (llm-inflight attribution.ts): this chat's calls are its own, an Overseer's or
    // a project overseer's as `overseer`. Registered here as well as by the extension at
    // session_start, since a special loadout may not load it.
    const usageSid = file.read.id;
    if (last.special?.spec.usage === "overseer") noteUsageSession(usageSid, { kind: "overseer" });
    unregisterUsage = registerUsageSession(usageSid, { kind: "main", ...(openCwd ? { cwd: openCwd } : {}), parent: null });
    if (kind && last.special) {
      chat.special = kind;
      chat.specialSpec = last.special.spec;
      chat.specialPort = last.special.port;
      // An overseer's memory is its own switch, readable only once its kind is set: the recall tools and the
      // engine follow it from the open, so a conversation on by default starts preparing now.
      if (last.special.spec.memory) chat.memoryOpened();
    }
    // A chat process's kind is opened by its server, once the open is answered (server/chat-host.ts).
    const local = !presetSpecs.has(path);
    if (kind && kind !== "overseer" && local) await localSpecials?.opened?.(kind, chat);
    if (kind === "overseer" && last.special) {
      // A conversation that already has messages keeps the model its file records (the SDK restores
      // it); overseer.json is the Overseer's setting, so bring the runtime to it now. The appends
      // this makes are still deferred (the hold is live until `restoreAppends`), so opening writes
      // nothing, like any other open.
      await syncOverseerModel(chat, last.special.spec).catch((err) =>
        console.warn(`[overseer] model sync skipped: ${err instanceof Error ? err.message : String(err)}`),
      );
      if (local) await localSpecials?.opened?.(kind, chat);
    }
    held.set(path, chat);
    sessionsChanged(); // its row now carries `chat` (heldChatState)
    return chat;
  } catch (err) {
    const config = asConfigError(err, sessionCwd);
    throw config ?? err;
  } finally {
    file.restoreAppends();
  }
}

/**
 * A worker's model when the open could not take it (a `claude-code-cli` id the catalog lacks: its
 * provider registers it at session_start, after the build), and its thinking again on that model, set
 * before any task is sent; a model that can't be set fails the start, never running on another.
 */
async function bringWorkerModel(chat: ChatSession, w: WorkerSpec): Promise<void> {
  if (!w.model || chat.harness.model()?.ref === w.model) return;
  try {
    await chat.setModelRef(w.model);
  } catch (err) {
    const provider = w.model.slice(0, w.model.indexOf("/"));
    throw new Error(
      `Model ${w.model} could not be set on the worker (${err instanceof Error ? err.message : String(err)}); the task was not started. The ${provider} provider must be registered in the worker (the claude-code extension with --claude-code-provider).`,
    );
  }
  if (w.thinking) chat.setThinking(w.thinking);
}

/**
 * Get (or open) the shared runtime for a session file. Throws BusyError when a TUI owns it,
 * or (unless `force`) when another process may be writing it. Concurrent callers share one
 * open attempt; failures are not cached. `onStep` hears a new open's steps as they begin (a chat
 * process's open trail, §app.chat-processes/boot-log); an open already under way keeps its own.
 */
export async function acquireChat(path: string, force = false, onStep: (step: string) => void = () => {}): Promise<ChatSession> {
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
  assertOpenConfig(path);
  if (!force) {
    // Shared constant with the frontend: RECENT_WRITE_MS (120s) in server/write-guard.ts.
    const age = recentForeignWriteAgeSec(path);
    if (age !== null) throw new BusyError(`modified ${age}s ago by a process we can't identify`, "recent");
  }
  const forget = () => {
    if (sessions.get(path) === p) sessions.delete(path);
  };
  const p = openSession(path, forget, onStep);
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
