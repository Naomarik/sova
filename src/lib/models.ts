import { createSignal } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { listModels, putModelFavorite } from "./api";

/**
 * The one model list the app keeps (GET /api/models). Both the model picker and the composer
 * flyout's Thinking group read it, so a list fetched for one is already there for the other.
 * It's a signal, not a plain variable: the flyout's thinking levels have to re-render when the
 * list lands, and again when the model changes under it.
 */
const [models, setModels] = createSignal<ModelInfo[] | null>(null);

/** The cache as it stands: null before the first successful load. */
export const modelList = models;

/** Re-fetches and replaces the cache. Rejects like `listModels`; the cache is left untouched.
    A favorite toggle still in flight wins over the fetched value, which may predate its write. */
export async function loadModels(fetchList: () => Promise<ModelInfo[]> = listModels): Promise<ModelInfo[]> {
  let next = await fetchList();
  for (const [ref, t] of toggles) next = withFavorite(next, ref, t.want);
  setModels(next);
  return next;
}

/** `list` with one ref's favorite flag set; untouched entries (and an unchanged list) keep identity. */
export function withFavorite(list: ModelInfo[], ref: string, favorite: boolean): ModelInfo[] {
  return list.some((m) => m.ref === ref && m.favorite !== favorite)
    ? list.map((m) => (m.ref === ref ? { ...m, favorite } : m))
    : list;
}

/** Favorite toggles in flight, per ref: the latest one's number, what it asked for, and the
    value the server last confirmed — which is what a failed latest toggle rolls back to. */
const toggles = new Map<string, { seq: number; want: boolean; confirmed: boolean }>();
let toggleSeq = 0;

/**
 * Stars or unstars a model: the shared cache flips at once, so every picker and pane agrees, then
 * PUT /api/models/favorite saves it. Rejects with the server's error after rolling the flag back
 * to the last value the server confirmed; an earlier toggle's failure is moot once a later one for
 * the same ref is in flight, and doesn't touch the cache.
 */
export async function toggleFavorite(
  ref: string,
  favorite: boolean,
  put: (ref: string, favorite: boolean) => Promise<unknown> = putModelFavorite,
): Promise<void> {
  const seq = ++toggleSeq;
  const confirmed = toggles.get(ref)?.confirmed ?? modelByRef(ref)?.favorite ?? !favorite;
  toggles.set(ref, { seq, want: favorite, confirmed });
  setModels((list) => list && withFavorite(list, ref, favorite));
  try {
    await put(ref, favorite);
  } catch (error) {
    const t = toggles.get(ref);
    if (t?.seq === seq) {
      toggles.delete(ref);
      setModels((list) => list && withFavorite(list, ref, t.confirmed));
    }
    throw error;
  }
  const t = toggles.get(ref);
  if (t?.seq === seq) toggles.delete(ref);
  else if (t) t.confirmed = favorite;
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
