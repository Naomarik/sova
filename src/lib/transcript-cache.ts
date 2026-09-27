// What a transcript keeps across a refetch and across a session switch.
//
// A refetch (a chat's hello or turn-end resync, a watch snapshot) sends every row again as new
// objects. The thread keys its rows by object, so each row whose entry didn't change keeps its
// old object (`reconcileItems`) and with it its DOM: open cards, focus, a revealed action strip.
//
// A switch disposes the whole view. The last few sessions opened keep their rows and where they
// were scrolled to (`transcriptCache`), so switching back paints them at once, where the user
// left them, while the view's own hello or snapshot is on the way; it then reconciles as above.

import type { TranscriptItem } from "../../shared/protocol";

/** Sessions whose rows and scroll position are kept for switching back. */
export const CACHED_SESSIONS = 3;

const sameJson = (a: unknown, b: unknown): boolean => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

const sameStrings = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s === b[i]));

/** The entry behind `raw`, as far as it can be told apart cheaply: pi never rewrites an entry
    under its id, so the id and the timestamp name its content. */
const rawStamp = (raw: unknown): unknown =>
  raw && typeof raw === "object" ? [(raw as { id?: unknown }).id, (raw as { timestamp?: unknown }).timestamp, (raw as { type?: unknown }).type] : raw;

/**
 * Whether two rows render the same. The fields the server derives are compared in full; the
 * entry itself (`raw`, which holds a tool's whole output) by the id and time it was written under.
 */
export function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.toolCallId === b.toolCallId &&
    a.model === b.model &&
    sameStrings(a.images, b.images) &&
    sameJson(rawStamp(a.raw), rawStamp(b.raw)) &&
    sameJson(a.attachments, b.attachments) &&
    sameJson(a.report, b.report) &&
    sameJson(a.wake, b.wake) &&
    sameJson(a.link, b.link) &&
    sameJson(a.overseerMark, b.overseerMark) &&
    sameJson(a.batonMark, b.batonMark) &&
    sameJson(a.teamEvent, b.teamEvent) &&
    sameJson(a.worktreeMerge, b.worktreeMerge)
  );
}

/**
 * `next`, with each row that renders the same as a row of `prev` (same id) replaced by that row's
 * old object. When nothing changed at all, `prev` itself, so setting it notifies nobody.
 */
export function reconcileItems(prev: readonly TranscriptItem[] | null | undefined, next: TranscriptItem[]): TranscriptItem[] {
  if (!prev || prev.length === 0) return next;
  const byId = new Map<string, TranscriptItem>();
  for (const it of prev) byId.set(it.id, it);
  let same = prev.length === next.length;
  const out = next.map((it, i) => {
    const old = byId.get(it.id);
    const kept = old && sameItem(old, it) ? old : it;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as TranscriptItem[]) : out;
}

/** A map that keeps only its `max` most recently used keys. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  keys(): K[] {
    return [...this.map.keys()];
  }
}

/**
 * Where a transcript was scrolled: at the end (following), or with a row's top `offset` px below
 * the top of the view. A row, not a pixel position, because rows are added at the end meanwhile
 * and rows not drawn yet have estimated heights.
 */
export type ScrollSpot = { follow: true } | { follow: false; rowId: string; offset: number };

export interface CachedTranscript {
  items: TranscriptItem[];
  spot: ScrollSpot | null;
}

const cache = new Lru<string, CachedTranscript>(CACHED_SESSIONS);

/** The rows and scroll spot kept for a session view (`key`: its view key), if any. */
export const cachedTranscript = (key: string): CachedTranscript | undefined => cache.get(key);

/** Keeps a session's latest rows. */
export function cacheItems(key: string, items: TranscriptItem[]): void {
  cache.set(key, { items, spot: cache.get(key)?.spot ?? null });
}

/** Keeps where a session was scrolled when its view went away. */
export function cacheSpot(key: string, spot: ScrollSpot): void {
  const had = cache.get(key);
  if (had) cache.set(key, { ...had, spot });
}

/** Forgets a session (tests; a view that must not come back from memory). */
export const forgetTranscript = (key: string): void => cache.delete(key);
