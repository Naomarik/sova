// pi's `codemode` tool in Sova's ordinary chats (§chat.mode-menu/codemode). An SDK runtime loads none of
// pi's built-in extensions, so the chat's factory list adds this one (server/chat-manager.ts
// DEFAULT_EXTENSION_FACTORIES); the special loadouts (the Overseer, org, baton) never get it. It registers pi's
// own definition (createCodemodeExtension), inactive, and the mode extension's codemode minor mode switches it
// (pi-config/extensions/mode/index.ts syncCodemodeTool), the same in every chat, a Claude Code one included:
// off, the tool is nowhere in the loadout; on, it is pi's tool as pi declares it.
//
// A script's `models.classify` / `models.generateImages` reach the model registry through a wrapper
// (scriptContext): the model policy refuses a disallowed model, the call holds a provider-limits slot, and it
// runs in the chat's usage context, so its ledger record (llm-inflight runtime.ts) is the chat's whichever
// thread the script's host callback runs on.
import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withUsageContext } from "../../../pi-config/extensions/llm-inflight/attribution.ts";
import { CODEMODE_TOOL } from "../../../pi-config/extensions/mode/minor.ts";

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

/** The extension: `codemodeExtension(deps)` is a factory for a chat's `extensionFactories`. */
export function codemodeExtension(deps: CodemodeDeps = UNGATED): (pi: ExtensionAPI) => void {
  return (pi) => {
    const real = captureCodemode(pi, {});
    pi.registerTool({
      ...real,
      defaultActive: false,
      execute: (id, params, signal, onUpdate, ctx) => real.execute(id, params, signal, onUpdate, scriptContext(ctx, deps)),
    });
  };
}

/** The factory entry for a chat's `extensionFactories`. */
export function codemodeFactory(deps?: CodemodeDeps): { name: string; factory: (pi: ExtensionAPI) => void } {
  return { name: "pi-codemode", factory: codemodeExtension(deps) };
}
