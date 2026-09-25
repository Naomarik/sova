import { createSignal } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { listModels, putModelFavorite } from "./api";

/**
 * The one model list the app keeps per host (GET /api/models; a peer's through /peer/<id>). Both
 * the model picker and the composer flyout's Thinking group read it, so a list fetched for one is
 * already there for the other. It's a signal, not a plain variable: the flyout's thinking levels
 * have to re-render when the list lands, and again when the model changes under it.
 *
 * `host` is a peer id, or null/undefined for the host serving this page: a peer session's models
 * are the ones its own host can run, with its own keys and favorites.
 */
const [lists, setLists] = createSignal<ReadonlyMap<string, ModelInfo[]>>(new Map());
const keyOf = (host?: string | null) => host ?? "";
const setModels = (host: string | null | undefined, update: (list: ModelInfo[] | null) => ModelInfo[] | null) =>
  setLists((m) => {
    const k = keyOf(host);
    const next = update(m.get(k) ?? null);
    if (next === (m.get(k) ?? null)) return m;
    const copy = new Map(m);
    if (next) copy.set(k, next);
    else copy.delete(k);
    return copy;
  });

/** The cache as it stands: null before the first successful load. */
export const modelList = (host?: string | null): ModelInfo[] | null => lists().get(keyOf(host)) ?? null;

/** Re-fetches and replaces the cache. Rejects like `listModels`; the cache is left untouched.
    A favorite toggle still in flight wins over the fetched value, which may predate its write. */
export async function loadModels(fetchList?: () => Promise<ModelInfo[]>, host?: string | null): Promise<ModelInfo[]> {
  let next = await (fetchList ?? (() => listModels(host)))();
  for (const [key, t] of toggles) if (key.host === keyOf(host)) next = withFavorite(next, key.ref, t.want);
  setModels(host, () => next);
  return next;
}

/** `list` with one ref's favorite flag set; untouched entries (and an unchanged list) keep identity. */
export function withFavorite(list: ModelInfo[], ref: string, favorite: boolean): ModelInfo[] {
  return list.some((m) => m.ref === ref && m.favorite !== favorite)
    ? list.map((m) => (m.ref === ref ? { ...m, favorite } : m))
    : list;
}

/** Favorite toggles in flight, per host and ref: the latest one's number, what it asked for, and
    the value the server last confirmed — which is what a failed latest toggle rolls back to. */
const toggles = new Map<{ host: string; ref: string }, { seq: number; want: boolean; confirmed: boolean }>();
/** The one key object for a host and ref, so the Map above can be keyed by it. */
const toggleKeys = new Map<string, { host: string; ref: string }>();
const toggleKey = (host: string | null | undefined, ref: string) => {
  const id = `${keyOf(host)}\n${ref}`;
  let k = toggleKeys.get(id);
  if (!k) toggleKeys.set(id, (k = { host: keyOf(host), ref }));
  return k;
};
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
  put?: (ref: string, favorite: boolean) => Promise<unknown>,
  host?: string | null,
): Promise<void> {
  const key = toggleKey(host, ref);
  const seq = ++toggleSeq;
  const confirmed = toggles.get(key)?.confirmed ?? modelByRef(ref, host)?.favorite ?? !favorite;
  toggles.set(key, { seq, want: favorite, confirmed });
  setModels(host, (list) => list && withFavorite(list, ref, favorite));
  try {
    await (put ?? ((r: string, f: boolean) => putModelFavorite(r, f, host)))(ref, favorite);
  } catch (error) {
    const t = toggles.get(key);
    if (t?.seq === seq) {
      toggles.delete(key);
      setModels(host, (list) => list && withFavorite(list, ref, t.confirmed));
    }
    throw error;
  }
  const t = toggles.get(key);
  if (t?.seq === seq) toggles.delete(key);
  else if (t) t.confirmed = favorite;
}

/** Fetches once; later calls resolve against the cache while nothing refreshes it. */
export async function ensureModels(host?: string | null): Promise<ModelInfo[]> {
  const have = modelList(host);
  return have ?? (await loadModels(undefined, host));
}

/** The cached entry for a "provider/id" ref, or null when it isn't loaded (or known). */
export const modelByRef = (ref: string | null | undefined, host?: string | null): ModelInfo | null =>
  (ref && modelList(host)?.find((m) => m.ref === ref)) || null;

/**
 * A model's thinking ladder (off…max), or [] when the model isn't in the list yet. A model with
 * one level (or none) has nothing to choose, which is what hides the Thinking group.
 */
export const thinkingLevelsFor = (ref: string | null | undefined, host?: string | null): string[] =>
  modelByRef(ref, host)?.thinkingLevels ?? [];
