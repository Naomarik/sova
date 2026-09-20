import { createSignal } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { listModels } from "./api";

/**
 * The one model list the app keeps (GET /api/models). Both the model picker and the composer
 * flyout's Thinking group read it, so a list fetched for one is already there for the other.
 * It's a signal, not a plain variable: the flyout's thinking levels have to re-render when the
 * list lands, and again when the model changes under it.
 */
const [models, setModels] = createSignal<ModelInfo[] | null>(null);

/** The cache as it stands: null before the first successful load. */
export const modelList = models;

/** Re-fetches and replaces the cache. Rejects like `listModels`; the cache is left untouched. */
export async function loadModels(): Promise<ModelInfo[]> {
  const next = await listModels();
  setModels(next);
  return next;
}

/** Fetches once; later calls resolve against the cache while nothing refreshes it. */
export async function ensureModels(): Promise<ModelInfo[]> {
  const have = models();
  return have ?? (await loadModels());
}

/** The cached entry for a "provider/id" ref, or null when it isn't loaded (or known). */
export const modelByRef = (ref: string | null | undefined): ModelInfo | null =>
  (ref && models()?.find((m) => m.ref === ref)) || null;

/**
 * A model's thinking ladder (off…max), or [] when the model isn't in the list yet. A model with
 * one level (or none) has nothing to choose, which is what hides the Thinking group (§4b).
 */
export const thinkingLevelsFor = (ref: string | null | undefined): string[] => modelByRef(ref)?.thinkingLevels ?? [];
