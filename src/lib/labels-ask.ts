/**
 * Which chat labels this page reads (§app.extensions/labels): the `<extension id>:<key>` pairs the
 * list place's declaration names (src/lib/list-place.ts), sent as `labels=` on the reads that carry
 * rows: GET /api/sessions, /api/sessions/summary, /api/mesh/sessions and the session feed's socket.
 * Null while no declaration exists: every URL is then exactly today's, so a server sends rows
 * without labels, byte for byte. Plain module state, no Solid: src/lib/api.ts reads it.
 */

let pairs: string | null = null;
const listeners = new Set<() => void>();

/** The pairs this page reads, or null (none: today's URLs). */
export const labelsAsk = (): string | null => pairs;

/** Set the pairs (the list place, as its declaration changes); listeners hear only a real change. */
export function setLabelsAsk(next: string | null): void {
  if (next === pairs) return;
  pairs = next;
  for (const fn of [...listeners]) fn();
}

/** Call `fn` whenever the pairs change; returns the unsubscribe. */
export function onLabelsAsk(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** `path` with `labels=<pairs>` appended while there are pairs; `path` itself otherwise. */
export const withLabels = (path: string): string => (pairs === null ? path : `${path}${path.includes("?") ? "&" : "?"}labels=${encodeURIComponent(pairs)}`);
