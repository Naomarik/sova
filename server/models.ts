import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ContextInfo, ModelInfo } from "../shared/protocol";
import { getModelRuntime } from "./chat-manager";
import { readFavorites } from "./model-favorites";
import type { BranchContext } from "./transcript";
import { claudeCodeProviderEnabled } from "./web-settings";

/** pi's cached remote catalogs (READ-ONLY): {[provider]: {models: [{id, contextWindow}]}}. */
const MODELS_STORE_FILE = join(getAgentDir(), "models-store.json");
const windowCache = new Map<string, number | null>();

function storeWindow(provider: string, id: string): number | null {
  try {
    const store = JSON.parse(readFileSync(MODELS_STORE_FILE, "utf8"));
    const m = store?.[provider]?.models?.find?.((x: any) => x?.id === id);
    return typeof m?.contextWindow === "number" ? m.contextWindow : null;
  } catch {
    return null;
  }
}

/** Cached per model id: `models-store.json` changes rarely, and a worker listing asks per row. */
const providerCache = new Map<string, string | null>();

/**
 * The provider that serves a model, for the subagents pane's meta line (which leads with it). A ref
 * keeps its own prefix (`zai/glm-5.3` → `zai`); a bare id is looked up in pi's cached catalogs
 * (`models-store.json`), which is what a worker's live record usually carries. Lower-case. Unknown,
 * empty and absent all give null: callers show no provider rather than guess one.
 */
export function modelProvider(ref: string | null | undefined): string | null {
  const v = (ref ?? "").trim();
  if (!v) return null;
  const slash = v.indexOf("/"); // provider has no "/", model ids may
  if (slash > 0) return v.slice(0, slash).toLowerCase();
  const hit = providerCache.get(v);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  try {
    const store = JSON.parse(readFileSync(MODELS_STORE_FILE, "utf8")) as Record<string, { models?: { id?: unknown }[] } | undefined>;
    for (const [provider, entry] of Object.entries(store)) {
      if (entry?.models?.some((m) => m?.id === v)) {
        found = provider.toLowerCase();
        break;
      }
    }
  } catch {
    // No catalog cached: no provider, never a guess.
  }
  providerCache.set(v, found);
  return found;
}

/**
 * contextWindow for "provider/id": the SDK model registry first (includes custom models.json
 * providers such as ollama-cloud), then models-store.json. Cached per ref; unknown → null.
 */
export function contextWindow(ref: string, modelRuntime: ModelRuntime): number | null {
  const hit = windowCache.get(ref);
  if (hit !== undefined) return hit;
  const slash = ref.indexOf("/"); // provider has no "/", model ids may
  if (slash <= 0) return null;
  const [provider, id] = [ref.slice(0, slash), ref.slice(slash + 1)];
  const fromRegistry = modelRuntime.getModel(provider, id)?.contextWindow;
  const window = typeof fromRegistry === "number" && fromRegistry > 0 ? fromRegistry : storeWindow(provider, id);
  windowCache.set(ref, window);
  return window;
}

/**
 * A worker's model → its context window, for a ref ("provider/id") or the bare id a worker's live
 * record usually carries (its provider found as modelProvider finds it). Unknown → null.
 */
export function workerWindowResolver(modelRuntime: ModelRuntime): (ref: string) => number | null {
  return (ref) => {
    if (ref.indexOf("/") > 0) return contextWindow(ref, modelRuntime);
    const provider = modelProvider(ref);
    return provider ? contextWindow(`${provider}/${ref}`, modelRuntime) : null;
  };
}

/** workerWindowResolver over the shared runtime, best-effort: without one (no auth, a test's
    agent dir) every window is unknown rather than the caller failing. */
export async function sharedWorkerWindowResolver(): Promise<(ref: string) => number | null> {
  try {
    return workerWindowResolver(await getModelRuntime());
  } catch {
    return () => null;
  }
}

export function toContextInfo(ctx: BranchContext | null, modelRuntime: ModelRuntime): ContextInfo | null {
  if (!ctx) return null;
  return { tokens: ctx.tokens, window: ctx.model ? contextWindow(ctx.model, modelRuntime) : null };
}

/** Context info for a read-only parsed branch (REST path). */
export async function resolveContext(ctx: BranchContext | null): Promise<ContextInfo | null> {
  return ctx ? toContextInfo(ctx, await getModelRuntime()) : null;
}

/** Models with configured auth (what the palette lists without a scoped-model setting). */
export async function listModels(): Promise<ModelInfo[]> {
  const favorites = readFavorites();
  const runtime = await getModelRuntime();
  const models = await runtime.getAvailable();
  const offerClaudeCode = claudeCodeProviderEnabled();
  return models
    // The experimental switch decides what Sova OFFERS. The claude-code extension registers its
    // provider into the ModelRuntime, which this server shares across every session, and an
    // extension instance only unregisters what it registered itself — so a session opened while
    // the switch was on leaves the provider in the shared runtime until the server restarts.
    // Filtering here is what makes turning the switch off take effect immediately, rather than
    // leaving models in the picker that the user has just asked not to see.
    .filter((m) => offerClaudeCode || m.provider !== CLAUDE_CODE_PROVIDER)
    // The window comes from the same cached resolver ContextInfo.window uses, so a model's window
    // reads identically whether it is asked about here or through a session's gauge.
    .map((m) => toModelInfo(m, favorites, contextWindow(`${m.provider}/${m.id}`, runtime)));
}

/**
 * Every model the shared runtime holds with credentials, the experimental Claude Code switch
 * notwithstanding: what a worker could be spawned from, rather than what the picker offers
 * (Settings → Modes → Delegate). The Claude Code provider's models are registered per runtime, so
 * this is still not the whole truth for them — see DelegateBackendOptions.sessionScopedProviders.
 */
export async function listRegistryModels(): Promise<ModelInfo[]> {
  const favorites = readFavorites();
  const runtime = await getModelRuntime();
  return (await runtime.getAvailable()).map((m) => toModelInfo(m, favorites, contextWindow(`${m.provider}/${m.id}`, runtime)));
}

/** Provider id the claude-code extension registers under (provider/index.ts CLAUDE_PROVIDER_ID). */
export const CLAUDE_CODE_PROVIDER = "claude-code-cli";

/** How many Claude Code CLI models the shared runtime currently has (the Experimental tab's
    status line). Counts what is registered, not what is offered, so it stays honest while the
    switch is off and the registration is still in place. */
export async function claudeCodeModelCount(): Promise<number> {
  const models = await (await getModelRuntime()).getAvailable();
  return models.filter((m) => m.provider === CLAUDE_CODE_PROVIDER).length;
}

/**
 * One pi Model as the wire shape. `input` (pi 0.86.0 Model.input, "text"/"image") is passed
 * through verbatim when the model carries one, and left off entirely otherwise — a custom
 * models.json provider may omit it, and absent means unknown, not text-only.
 */
export function toModelInfo(
  m: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>; input?: ("text" | "image")[] },
  /** The command-palette's favorites (`readFavorites` in model-favorites.ts). */
  isFavorite: (provider: string, id: string) => boolean,
  /** Tokens, from the cached resolver; null/undefined when neither source knows the model. */
  window?: number | null,
): ModelInfo {
  const ref = `${m.provider}/${m.id}`;
  const info: ModelInfo = {
    ref,
    provider: m.provider,
    id: m.id,
    favorite: isFavorite(m.provider, m.id),
    thinkingLevels: supportedThinkingLevels(m),
  };
  if (Array.isArray(m.input)) info.input = m.input;
  if (typeof window === "number" && window > 0) info.contextWindow = window;
  return info;
}

/** pi's ThinkingLevel ladder, in order (pi 0.86.0 defaults.js:2 THINKING_LEVEL_OPTIONS). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Mirrors pi 0.86.0 getSupportedThinkingLevels (pi-ai models.js:554): a reasoning model supports the ladder minus its
 *  thinkingLevelMap nulls — except xhigh/max, which count only with an explicit non-null map
 *  entry — and a non-reasoning model supports only "off". */
export function supportedThinkingLevels(m: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}): string[] {
  if (!m.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
