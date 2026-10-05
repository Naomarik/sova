// pi's `codemode` tool in Sova's ordinary chats (§chat.mode-menu/codemode). An SDK runtime loads none of
// pi's built-in extensions, so the chat's factory list adds this one (server/chat-manager.ts
// DEFAULT_EXTENSION_FACTORIES); the special loadouts (the Overseer, org, baton) never get it. It registers pi's
// own definition (createCodemodeExtension), inactive, and the mode extension's codemode minor mode switches it
// (pi-config/extensions/mode/index.ts syncCodemodeTool).
//
// A chat on the Claude Code provider gets another form of the same tool: declared at all times, with a fixed
// one-line description, no prompt lines and no per-tool script notes, so the CLI's tool list and system prompt
// never change on a toggle and the CLI is never restarted for it. There this extension keeps the activation
// itself (it pins the host, minor.ts CODEMODE_HOST_EVENT) and tells the model by hidden notes: the whole guide
// when codemode turns on, a short note when it turns off; while it is off, the tool refuses. The form follows the
// chat's provider at each run boundary.
//
// In both forms a script's `models.classify` / `models.generateImages` reach the model registry through a
// wrapper (scriptContext): the model policy refuses a disallowed model, the call holds a provider-limits slot,
// and it runs in the chat's usage context, so its ledger record (llm-inflight runtime.ts) is the chat's
// whichever thread the script's host callback runs on.
import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext, type ToolDefinition, type ToolLoadout } from "@earendil-works/pi-coding-agent";
import { withUsageContext } from "../../../pi-config/extensions/llm-inflight/attribution.ts";
import { CODEMODE_HOST_DISCOVER_EVENT, CODEMODE_HOST_EVENT, CODEMODE_TOOL, type CodemodeHostEvent } from "../../../pi-config/extensions/mode/minor.ts";
import { MODE_DISCOVER_EVENT, MODE_STATE_EVENT, normalizeActive } from "../../../pi-config/extensions/mode/state.ts";

/** The Claude Code provider's pi id (server/models.ts CLAUDE_CODE_PROVIDER; that module imports the chat manager). */
const CLAUDE_CODE_PROVIDER = "claude-code-cli";

/** The Claude Code form's whole description, the same whether codemode is on or off. */
export const CODEMODE_STUB_DESCRIPTION = "Inactive unless a codemode note in this conversation says it is on; ignore it otherwise";

/** The hidden notes of the Claude Code form (display: false; the transcript shows no hidden custom message). */
export const CODEMODE_NOTE_TYPE = "codemode-note";
export interface CodemodeNoteDetails {
  v: 1;
  on: boolean;
}

/** The off note, and what the Claude Code form answers a call with while codemode is off. */
export const CODEMODE_OFF_NOTE =
  "Codemode is now OFF in this conversation: do not call the `codemode` tool. Every call is refused until a later codemode note says it is on again.";

/** The on note: the full description the tool list's one line stands for. */
export function codemodeGuideNote(description: string): string {
  return `Codemode is now ON in this conversation: the \`codemode\` tool in your tool list works from now on. Its description there is a placeholder; this is its full description.\n\n${description}`;
}

/** What a script's model calls need from the server: the model policy and the provider-limits gate. */
export interface CodemodeDeps {
  /** May "provider/id" be used at all (the device's model policy, read at each call)? */
  allowed(ref: string): boolean;
  /** One of the provider's request slots on this device, waiting while they are taken; null: no limit. */
  acquire(provider: string, opts: { sessionId?: string; signal?: AbortSignal }): Promise<{ release(): void } | null>;
  /** Run `fn` as holding the provider's slot (so a gated call inside it never claims a second). */
  holding<T>(provider: string, fn: () => T): T;
}

/** No policy and no gate: every model allowed, nothing claimed (tests, and a host without either). */
export const UNGATED: CodemodeDeps = { allowed: () => true, acquire: async () => null, holding: (_p, fn) => fn() };

type AnyTool = ToolDefinition<any, any>;
type Ctx = ExtensionContext;

/**
 * pi's codemode definition, as its own factory registers it (quirk P21): the factory runs against this
 * extension's API with registerTool caught, so the definition keeps pi's closures (the store's appendEntry,
 * the settings it reads) and is registered by this extension, the one whose API it holds.
 */
function captureCodemode(pi: ExtensionAPI, options: Parameters<typeof createCodemodeExtension>[0]): AnyTool {
  let captured: AnyTool | undefined;
  const api = new Proxy(pi, {
    get: (target, key) => (key === "registerTool" ? (def: AnyTool) => void (captured = def) : Reflect.get(target, key)),
  });
  createCodemodeExtension(options)(api);
  if (!captured || captured.name !== CODEMODE_TOOL) throw new Error("pi's codemode extension registered no codemode tool");
  return captured;
}

type ModelCall = "classify" | "generateImages";

/**
 * A member of `target` as a Proxy over it may hand it out: a method bound to its object, except a read-only,
 * non-configurable one (pi defines the tool context's `executeTool` that way), which a Proxy must return as is.
 */
function member(target: object, key: PropertyKey): unknown {
  const value = Reflect.get(target, key);
  const own = Object.getOwnPropertyDescriptor(target, key);
  if (own && !own.configurable && own.writable === false) return value;
  return typeof value === "function" ? value.bind(target) : value;
}

/** A refused model call in the result shape a script reads (both kinds report errors, never throw). */
function refused(kind: ModelCall, model: { provider?: unknown; id?: unknown }, message: string, stop: "error" | "aborted" = "error"): unknown {
  const base = { provider: String(model?.provider ?? ""), model: String(model?.id ?? ""), stopReason: stop, errorMessage: message };
  return kind === "classify" ? { ...base, answers: {} } : { ...base, output: [] };
}

/**
 * The model registry a script sees (quirk P21: pi's script `models.*` call `ctx.modelRegistry`): classify
 * and generateImages refused for a model the policy disallows, run holding a provider-limits slot, inside the
 * chat's usage context; every other member is the registry's own.
 */
export function scriptRegistry(registry: object, owner: { sessionId?: string; cwd?: string }, deps: CodemodeDeps): object {
  const gated = (kind: ModelCall) => async (model: { provider?: unknown; id?: unknown }, context: unknown, options?: { signal?: AbortSignal }) => {
    const provider = typeof model?.provider === "string" ? model.provider : "";
    const ref = `${provider}/${String(model?.id ?? "")}`;
    if (!deps.allowed(ref)) return refused(kind, model, `${ref} is turned off in this device's model policy (Settings → Models).`);
    let slot: { release(): void } | null = null;
    try {
      slot = await deps.acquire(provider, { sessionId: owner.sessionId, signal: options?.signal });
    } catch {
      return refused(kind, model, `Aborted while waiting for a ${provider} request slot.`, "aborted");
    }
    try {
      const run = () => (registry as Record<ModelCall, (...a: unknown[]) => Promise<unknown>>)[kind](model, context, options);
      return await deps.holding(provider, () =>
        withUsageContext({ ...(owner.sessionId ? { owner: owner.sessionId } : {}), ...(owner.cwd ? { cwd: owner.cwd } : {}) }, run),
      );
    } finally {
      slot?.release();
    }
  };
  const wrapped: Record<ModelCall, unknown> = { classify: gated("classify"), generateImages: gated("generateImages") };
  return new Proxy(registry, {
    get: (target, key) => (key === "classify" || key === "generateImages" ? wrapped[key] : member(target, key)),
  });
}

/** The tool's context with the script's registry in place of the chat's. */
function scriptContext<C extends Ctx | undefined>(ctx: C, deps: CodemodeDeps): C {
  if (!ctx) return ctx;
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    sessionId = undefined;
  }
  const registry = scriptRegistry(ctx.modelRegistry, { sessionId, cwd: ctx.cwd }, deps);
  return new Proxy(ctx, { get: (target, key) => (key === "modelRegistry" ? registry : member(target, key)) }) as C;
}

/** Whether the branch's newest codemode note since its last compaction said on (undefined: none told). */
function toldOnBranch(entries: readonly { type?: string; customType?: string; details?: unknown }[]): boolean | undefined {
  let told: boolean | undefined;
  for (const entry of entries) {
    if (entry.type === "compaction") told = undefined;
    else if (entry.type === "custom_message" && entry.customType === CODEMODE_NOTE_TYPE) {
      const on = (entry.details as Partial<CodemodeNoteDetails> | undefined)?.on;
      if (typeof on === "boolean") told = on;
    }
  }
  return told;
}

/** The extension: `codemodeExtension(deps)` is a factory for a chat's `extensionFactories`. */
export function codemodeExtension(deps: CodemodeDeps = UNGATED): (pi: ExtensionAPI) => void {
  return (pi) => {
    const real = captureCodemode(pi, {});
    // The guide the Claude Code form's on note carries: pi's description in its `only` variant, which lists
    // every tool a script can call (no other tool carries a script line there).
    const listing = captureCodemode(pi, { mode: "only" });
    const execute = (def: AnyTool): AnyTool["execute"] => (id, params, signal, onUpdate, ctx) => def.execute(id, params, signal, onUpdate, scriptContext(ctx, deps));

    /** pi's own form: what ordinary chats get, inactive until the mode turns it on. */
    const realForm: AnyTool = { ...real, execute: execute(real) };

    /** The Claude Code form's latest loadout (its prepareLoadout sees each change of the active tools). */
    let loadout: ToolLoadout | undefined;
    /** What the model was told by note: undefined until a note (or after a compaction). */
    let told: boolean | undefined;
    /** The codemode minor mode, as the mode extension last published it. */
    let minorOn = false;
    let stub = false;
    let running = false;

    const stubForm: AnyTool = {
      ...real,
      description: CODEMODE_STUB_DESCRIPTION,
      promptSnippet: undefined,
      promptGuidelines: undefined,
      defaultActive: true,
      prepareLoadout: (next) => {
        loadout = next;
        return undefined;
      },
      execute: async (id, params, signal, onUpdate, ctx) => {
        if (told !== true) return { content: [{ type: "text", text: CODEMODE_OFF_NOTE }], details: { calls: [] }, isError: true } as never;
        return execute(real)(id, params, signal, onUpdate, ctx);
      },
    };

    pi.registerTool({ ...realForm, defaultActive: false });

    const publishPin = () => {
      const event: CodemodeHostEvent = { version: 1, pinned: stub };
      try {
        pi.events?.emit(CODEMODE_HOST_EVENT, event);
      } catch {
        // Best-effort: without it the mode extension keeps switching the tool itself.
      }
    };
    pi.events?.on(CODEMODE_HOST_DISCOVER_EVENT, () => publishPin());
    pi.events?.on(MODE_STATE_EVENT, (data: unknown) => {
      minorOn = normalizeActive(data)?.minorModes.includes("codemode") ?? false;
    });
    pi.events?.emit(MODE_DISCOVER_EVENT, {});

    /**
     * The form for the chat's provider (`provider`, else its model's now); a change re-registers the tool (pi
     * keeps it active across that). True when the form changed.
     */
    function applyForm(ctx: Ctx, provider = ctx.model?.provider): boolean {
      const want = provider === CLAUDE_CODE_PROVIDER;
      if (want === stub) return false;
      stub = want;
      // Entering the Claude Code form, the model learns the state from a note, whatever earlier forms said.
      if (stub) told = undefined;
      pi.registerTool(stub ? stubForm : { ...realForm, defaultActive: false });
      publishPin();
      return true;
    }

    /**
     * A form changed inside before_agent_start: pi copied this run's prompt options before the handlers ran,
     * so they still carry the old form's prompt line and guidelines. Give them the new form's (none for the
     * Claude Code form), or the run's prompt would differ from every later one.
     */
    function patchRunOptions(options: { toolSnippets?: Record<string, string>; toolGuidelines?: Record<string, string[]> } | undefined): void {
      if (!options) return;
      const def = stub ? stubForm : real;
      if (options.toolSnippets) {
        if (def.promptSnippet) options.toolSnippets[CODEMODE_TOOL] = def.promptSnippet;
        else delete options.toolSnippets[CODEMODE_TOOL];
      }
      if (options.toolGuidelines) {
        if (def.promptGuidelines?.length) options.toolGuidelines[CODEMODE_TOOL] = [...def.promptGuidelines];
        else delete options.toolGuidelines[CODEMODE_TOOL];
      }
    }

    /** The note for what the Claude Code form's model hasn't been told yet (none for an off it never heard on). */
    function takeNote(): { customType: string; content: string; display: false; details: CodemodeNoteDetails } | undefined {
      if (!stub || told === minorOn || (told === undefined && !minorOn)) return undefined;
      told = minorOn;
      const content = minorOn
        ? codemodeGuideNote((loadout && listing.prepareLoadout?.(loadout)?.descriptions?.[CODEMODE_TOOL]) ?? listing.description)
        : CODEMODE_OFF_NOTE;
      return { customType: CODEMODE_NOTE_TYPE, content, display: false, details: { v: 1, on: minorOn } };
    }

    pi.on("session_start", async (_event, ctx) => {
      running = false;
      applyForm(ctx);
      try {
        told = stub ? toldOnBranch(ctx.sessionManager.getBranch() as never) : undefined;
      } catch {
        told = undefined;
      }
    });

    // A model switch between runs takes its form at once, so the next run's prompt is built with it.
    pi.on("model_select", async (event, ctx) => {
      if (!running) applyForm(ctx, event.model?.provider);
    });

    // A run a user's prompt starts: the note rides beside the prompt.
    pi.on("before_agent_start", async (event, ctx) => {
      if (applyForm(ctx)) patchRunOptions(event.systemPromptOptions as never);
      const note = takeNote();
      if (note) pi.sendMessage(note, { deliverAs: "nextTurn" });
    });

    // A run an extension's message starts (no before_agent_start): steered in ahead of its first request.
    pi.on("agent_start", async (_event, ctx) => {
      if (running) return;
      running = true;
      applyForm(ctx);
      const note = takeNote();
      if (note) pi.sendMessage(note);
    });

    pi.on("agent_settled", async () => {
      running = false;
    });

    // The guide went with the summarized history: the next run sends it again while codemode is on.
    pi.on("session_compact", async () => {
      told = undefined;
    });
  };
}

/** The factory entry for a chat's `extensionFactories`. */
export function codemodeFactory(deps?: CodemodeDeps): { name: string; factory: (pi: ExtensionAPI) => void } {
  return { name: "pi-codemode", factory: codemodeExtension(deps) };
}
