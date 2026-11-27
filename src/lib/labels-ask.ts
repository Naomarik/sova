/**
 * Which chat labels this page reads (§app.extensions/labels): the `<extension id>:<key>` pairs the
 * list place's declaration names (src/lib/list-place.ts), sent as `labels=` on the reads that carry
 * rows: GET /api/sessions, /api/sessions/summary, /api/mesh/sessions and the session feed's socket.
 * Null while no declaration exists: every URL is then exactly today's, so a server sends rows
 * without labels, byte for byte. Plain module state, no Solid: src/lib/api.ts reads it.
 *
 * The pairs are remembered per browser (LABELS_READ_KEY): a page load where an extension declared them
 * last time asks for them from its first list read and its first socket, so the declaration arriving
 * changes nothing (no reconnect, no second list read). A browser that never had one stores nothing and
 * starts from null; the list place clears the key once it knows no declaration is there.
 */

/** Where the last pairs read are kept: absent unless an extension declared some in this browser. */
export const LABELS_READ_KEY = "sova:labels-read";
/** One `<extension id>:<label key>` pair (the server's rules for both halves). */
const PAIR_RE = /^[A-Za-z0-9._-]{1,64}:[a-z0-9][a-z0-9-]{0,31}$/;

const store = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const readStored = (): string | null => {
  try {
    const v = store()?.getItem(LABELS_READ_KEY) ?? null;
    return v !== null && v.split(",").every((p) => PAIR_RE.test(p)) ? v : null;
  } catch {
    return null;
  }
};

let pairs: string | null = readStored();
const listeners = new Set<() => void>();

/** The pairs this page reads, or null (none: today's URLs). */
export const labelsAsk = (): string | null => pairs;

/** Set the pairs (the list place, as its declaration changes); kept for the next load; listeners
    hear only a real change. */
export function setLabelsAsk(next: string | null): void {
  if (next === pairs) return;
  pairs = next;
  try {
    if (next === null) store()?.removeItem(LABELS_READ_KEY);
    else store()?.setItem(LABELS_READ_KEY, next);
  } catch {
    // storage full or denied: this page still reads them
  }
  for (const fn of [...listeners]) fn();
}

/** Call `fn` whenever the pairs change; returns the unsubscribe. */
export function onLabelsAsk(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** `path` with `labels=<pairs>` appended while there are pairs; `path` itself otherwise. */
export const withLabels = (path: string): string => (pairs === null ? path : `${path}${path.includes("?") ? "&" : "?"}labels=${encodeURIComponent(pairs)}`);
