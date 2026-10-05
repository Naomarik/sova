// Opening a hosted chat's pi runtime (§app.harness/session-open): the session file, pi's services and
// session, the extension flags in pi's words, the model a message-less session opens on, and the deferral
// that keeps an open from writing (quirk P1). The chat (server/chat-manager.ts) decides the policy (special
// loadouts, profile, loadout, defaults) in its `build`, from the read this hands it; nothing here decides.
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SessionRead, StateView } from "../../../shared/harness";
import { applyForkCacheRouting } from "../../../pi-config/extensions/subagents/fork/cache.ts";
import { instrumentModelRuntime } from "../../../pi-config/extensions/llm-inflight/runtime.ts";
import { markDegraded } from "../../../pi-config/extensions/llm-inflight/tracker.ts";
import { installWorkerNice, lowerToolCommands } from "../../process-priority";
import { agentRoot } from "../../state-root";
import { liveRead } from "./reader";
import { piSessionState } from "./state";
import { currentTheme } from "./ui-bridge";

/** pi's resource loader options for a runtime: the extensions it loads and any loader overrides. */
export type PiLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;
/** An extension factory entry of a loader's `extensionFactories`. */
export type PiExtensionFactory = NonNullable<PiLoaderOptions["extensionFactories"]>[number];
export type PiModelRuntime = ModelRuntime;
export type PiToolDefinition = ToolDefinition;

/**
 * The extension flags a runtime starts with, by meaning; Sova decides each value (server/chat-manager.ts
 * sessionFlags), this file names them.
 *
 * - `outline`: topic-outline summarizes headless (`topic-outline-headless`, a boolean flag: the SDK sets it
 *   true whatever the value).
 * - `target`: a remote session's target, switching pi-config's remote extension on (`target`).
 * - `claudeCode`: the claude-code extension registers the Claude Code CLI's models (`claude-code-provider`,
 *   pi-config/extensions/claude-code/provider/index.ts CLAUDE_PROVIDER_FLAG).
 * - `review`: adversarial review (`adversarial-review`, pi-config/extensions/mode/index.ts REVIEW_FLAG).
 * - `link`: this server's bound origin and its per-install token for the `link` extension (`sova-link`,
 *   `sova-link-token`). In-process only: never argv, never env.
 */
export interface OpenFlags {
  outline?: boolean;
  target?: string;
  claudeCode?: boolean;
  review?: boolean;
  link?: { origin: string; token: string };
}

/** The flags as pi's extension flag values, in the order they have always been set. */
export function extensionFlagValues(f: OpenFlags): Map<string, boolean | string> {
  const flags = new Map<string, boolean | string>(f.outline ? [["topic-outline-headless", true]] : []);
  if (f.target) flags.set("target", f.target);
  if (f.claudeCode) flags.set("claude-code-provider", true);
  if (f.review) flags.set("adversarial-review", true);
  if (f.link) {
    flags.set("sova-link", f.link.origin);
    flags.set("sova-link-token", f.link.token);
  }
  return flags;
}

let modelRuntimePromise: Promise<ModelRuntime> | null = null;
/** The one pi model runtime this process shares across every session. */
export function getModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= ModelRuntime.create().then(
    (runtime) => {
      // Every pi call of this process (hosted chats, compaction, warming, one-shots) passes through
      // this one runtime: count it here, before anything can call it. One that can't be
      // instrumented leaves this host's count partial, never a silent 0.
      if (instrumentModelRuntime(runtime) === "unsupported") markDegraded("server-runtime");
      return runtime;
    },
    (err) => {
      modelRuntimePromise = null;
      throw err;
    },
  );
  return modelRuntimePromise;
}

/**
 * Build services for a webapp runtime.
 *
 * A flag no extension registered is NOT fatal: the SDK reports `Unknown option: --<flag>` as a
 * services diagnostic and carries on (verified against 0.86.1 with the switch on and a
 * claude-code extension that does not register it yet — the session still opened and every other
 * model still worked). That is what makes the always-on provider flag safe with an older
 * pi-config: the provider is simply absent, and the diagnostic below says why. A loadout that loads
 * no extension gets no flag at all (a flag nobody registered only logs "Unknown option"), and its
 * `flags` are never read.
 */
async function servicesForCwd(cwd: string, modelRuntime: ModelRuntime, flags: () => OpenFlags, resourceLoaderOptions: PiLoaderOptions) {
  // Its workers and tool commands start below the server (§app.load-priority/workers).
  installWorkerNice();
  const services = await createAgentSessionServices({
    cwd,
    modelRuntime,
    extensionFlagValues: resourceLoaderOptions.noExtensions ? new Map() : extensionFlagValues(flags()),
    resourceLoaderOptions,
  });
  lowerToolCommands(services.settingsManager);
  return services;
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
export async function warmClaudeCodeProvider(modelRuntime: ModelRuntime, cwd: string, extensionFactories: PiExtensionFactory[]): Promise<void> {
  try {
    // The provider flag alone: the throwaway session needs nothing else, and the link flags would
    // read the access token, which throws (and logs its problem again) when the token file is damaged.
    const services = await createAgentSessionServices({
      cwd,
      modelRuntime,
      extensionFlagValues: extensionFlagValues({ claudeCode: true }),
      resourceLoaderOptions: { extensionFactories: [...extensionFactories] },
    });
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

/** A model as the runtime resolves it, without naming pi-ai's `Model` (not re-exported by the SDK entry). */
type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * The model a MESSAGE-LESS session records for itself, for openSession to pass as
 * `createAgentSessionFromServices`' `model`. The SDK restores a session's recorded model only
 * when the branch already has messages (sdk.js gates the restore on `messages.length > 0`), and
 * a session can record a model_change and nothing else (its model set before its first message)
 * — so without this, its runtime resolves the server default and the first turn runs a model
 * nobody chose.
 * Once the branch has messages the SDK does this itself, which is why the message-less case is
 * the only one answered here. The two guards are the SDK's own restore guards (getModel, then
 * hasConfiguredAuth): on either failure the answer is undefined and the SDK falls back —
 * binding a recorded model must never fail the open.
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

/** The recorded choice outranks an eligible global default; undefined leaves the SDK
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
 * (sdk.js:261), and a message-less file that already records exactly that model would get a
 * second identical `model_change` on the first prompt, and transcript.ts renders one `Model:`
 * row per entry: the session would open with the same row twice.
 * Both halves of the condition are load-bearing. With messages on the branch that append is the
 * SDK's own resume record, and a pair that differs from the recorded one is a real change (the
 * fallback default after an unauthenticated recorded model) — those must still be written.
 */
export function restatesRecordedModel(context: BranchContext, provider: string, modelId: string): boolean {
  if (context.messages.length > 0 || !context.model) return false;
  return context.model.provider === provider && context.model.modelId === modelId;
}

/** A session being opened, as the chat's policy reads it: its history and its state, read live. */
export interface OpenRead extends SessionRead {
  readonly state: { branch(): StateView; file(): StateView };
}

function openRead(sm: SessionManager): OpenRead {
  const read = liveRead(sm);
  const state = piSessionState(sm);
  return {
    get id() {
      return read.id;
    },
    get cwd() {
      return read.cwd;
    },
    leafId: read.leafId,
    branch: read.branch,
    entries: read.entries,
    entry: read.entry,
    state: { branch: state.branch, file: state.file },
  };
}

/** What the chat decides for one build of its runtime (each session the runtime builds). */
export interface PiBuild {
  /** The extensions this runtime loads, and any loader overrides. */
  loader: PiLoaderOptions;
  /** The extension flags, read as the services are built; never read for a loader that loads no extension. */
  flags(): OpenFlags;
  /** The tools to leave out (pi's `excludeTools`, a filter on the registry itself), given every
      extension tool the loader found. */
  exclude(present: string[]): string[];
  /** A tool allowlist (built-in, extension and inline tools alike) and custom tools that replace a tool
      of the same name: a special loadout's. */
  tools?: string[];
  customTools?: ToolDefinition[];
  /** For a session that may still open on a default: the model ref and thinking level it should, already
      checked against Sova's policy and ladder; null, or a missing field, leaves pi's choice. */
  opening(): { model?: string; thinking?: string } | null;
  /** Route the provider's prompt cache by the file's inherited fork key (an ordinary session). */
  forkCacheRouting: boolean;
  /** Each session built, before anything runs on it (the profile's run state, a special kind's watch). */
  built?(session: AgentSession): void;
}

/** A session file opened for a hosted chat, its runtime not built yet. */
export interface PiOpenFile {
  /** The session's history and state; `cwd` is the override's, else the header's. */
  readonly read: OpenRead;
  /** P1: the model and thinking appends pi made while building, to run (in order) before the chat's first
      write. The chat takes this array as its own. */
  readonly deferred: Array<() => void>;
  /** Build the runtime in `cwd`; `build` is asked for each session the runtime builds. */
  start(cwd: string, build: (o: { cwd: string; read: OpenRead }) => Promise<PiBuild>): Promise<AgentSessionRuntime>;
  /** End the P1 hold: pi's own appends write again. Call once the whole open is over. */
  restoreAppends(): void;
}

/**
 * Open `path` for a hosted chat. Until `restoreAppends`, the model and thinking appends pi makes (for a
 * session with no messages yet, or no thinking entry on the branch) are queued on `deferred`, so merely
 * opening (browsing) a session never modifies its file (P1 open-writes-nothing).
 */
export async function openPiSession(path: string, cwdOverride: string | undefined): Promise<PiOpenFile> {
  const modelRuntime = await getModelRuntime();
  const sessionManager = SessionManager.open(path, undefined, cwdOverride);
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
  const restoreAppends = () => {
    sessionManager.appendModelChange = appendModelChange;
    sessionManager.appendThinkingLevelChange = appendThinkingLevelChange;
  };
  const start = (cwd: string, build: (o: { cwd: string; read: OpenRead }) => Promise<PiBuild>) => {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const plan = await build({ cwd, read: openRead(sessionManager) });
      const services = await servicesForCwd(cwd, modelRuntime, plan.flags, plan.loader);
      const present = services.resourceLoader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()]);
      const excluded = plan.exclude(present);
      for (const d of services.diagnostics) console.warn(`[chat] runtime ${d.type}: ${d.message}`);
      // A session the chat lets open on a default resolves the stored model ref against models with
      // configured auth, and lets the SDK clamp the stored level to the model's ladder. Anything stale
      // or unauthenticated is skipped, so a bad default degrades to pi's own default instead of failing
      // the open.
      let defaultModel: Awaited<ReturnType<typeof modelRuntime.getAvailable>>[number] | undefined;
      const opening = plan.opening();
      if (opening?.model) defaultModel = (await modelRuntime.getAvailable().catch(() => [])).find((m) => `${m.provider}/${m.id}` === opening.model);
      const model = modelForSessionOpen(sessionManager, modelRuntime, defaultModel);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        ...(opening?.thinking ? { thinkingLevel: opening.thinking as Parameters<AgentSession["setThinkingLevel"]>[0] } : {}), // Sova's ladder has "off", the SDK's union doesn't
        ...(plan.tools ? { tools: plan.tools, ...(plan.customTools ? { customTools: plan.customTools } : {}) } : {}),
        ...(excluded.length ? { excludeTools: excluded } : {}),
      });
      if (plan.forkCacheRouting) applyForkCacheRouting(created.session);
      plan.built?.(created.session);
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };
    return createAgentSessionRuntime(createRuntime, { cwd, agentDir: agentRoot(), sessionManager });
  };
  return { read: openRead(sessionManager), deferred, start, restoreAppends };
}
