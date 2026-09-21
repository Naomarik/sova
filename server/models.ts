import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ContextInfo, ModelInfo } from "../shared/protocol";
import { getModelRuntime } from "./chat-manager";
import type { BranchContext } from "./transcript";

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

export function toContextInfo(ctx: BranchContext | null, modelRuntime: ModelRuntime): ContextInfo | null {
  if (!ctx) return null;
  return { tokens: ctx.tokens, window: ctx.model ? contextWindow(ctx.model, modelRuntime) : null };
}

/** Context info for a read-only parsed branch (REST path). */
export async function resolveContext(ctx: BranchContext | null): Promise<ContextInfo | null> {
  return ctx ? toContextInfo(ctx, await getModelRuntime()) : null;
}

/** The command-palette extension's favorites (READ-ONLY here): {version:1, models:[{provider,id}]}. */
const FAVORITES_FILE = join(getAgentDir(), "model-favorites.json");

function readFavorites(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(FAVORITES_FILE, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.models)) return new Set();
    return new Set(
      data.models
        .filter((m: any) => typeof m?.provider === "string" && typeof m?.id === "string")
        .map((m: any) => `${m.provider}/${m.id}`),
    );
  } catch {
    return new Set(); // missing or corrupt: no favorites
  }
}

/** Models with configured auth (what the palette lists without a scoped-model setting). */
export async function listModels(): Promise<ModelInfo[]> {
  const favorites = readFavorites();
  const models = await (await getModelRuntime()).getAvailable();
  return models.map((m) => toModelInfo(m, favorites));
}

/**
 * One pi Model as the wire shape. `input` (pi 0.86.0 Model.input, "text"/"image") is passed
 * through verbatim when the model carries one, and left off entirely otherwise — a custom
 * models.json provider may omit it, and absent means unknown, not text-only.
 */
export function toModelInfo(
  m: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>; input?: ("text" | "image")[] },
  favorites: Set<string>,
): ModelInfo {
  const ref = `${m.provider}/${m.id}`;
  const info: ModelInfo = {
    ref,
    provider: m.provider,
    id: m.id,
    favorite: favorites.has(ref),
    thinkingLevels: supportedThinkingLevels(m),
  };
  if (Array.isArray(m.input)) info.input = m.input;
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
