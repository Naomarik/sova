// What a transcript keeps across a refetch and across a session switch.
//
// A refetch (a chat's hello or turn-end resync, a watch snapshot) sends every row again as new
// objects. The thread keys its rows by object, so each row whose entry didn't change keeps its
// old object (`reconcileItems`) and with it its DOM: open cards, focus, a revealed action strip.
//
// A switch disposes the whole view. The last few sessions opened, and the sidebar's Recent rows
// (preloaded, lib/recent-preload), keep their rows and where they were scrolled to
// (`TranscriptStore`), so opening one paints it at once, where the user left it, while the view's
// own hello or snapshot is on the way; it then reconciles as above.

import type { TranscriptItem } from "../../shared/protocol";
import type { Older } from "./older-rows";

/** Sessions whose rows and scroll position are kept for switching back. */
export const CACHED_SESSIONS = 3;

/**
 * The most JSON (characters) the Recent sessions kept beyond those may add up to. Kept rows take
 * about 1.0-1.6x their JSON in the heap, so this is about 20-32 MB. Rows carry what they draw and
 * no copy of their entry, so a whole branch is about a third of what it was (measured on 663 real
 * sessions: 945 MB of rows became 295 MB): the 5 most recent sessions take 10 MB, the 20 most
 * recent 17 MB, the 20 largest 88 MB.
 */
export const CACHE_BUDGET = 20_000_000;

const sameJson = (a: unknown, b: unknown): boolean => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

const sameStrings = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s === b[i]));

/**
 * Whether two rows render the same. Every field the server sends is compared in full: a row
 * carries what it draws and no copy of its entry, so this is cheap.
 */
export function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.toolCallId === b.toolCallId &&
    a.model === b.model &&
    sameStrings(a.images, b.images) &&
    a.at === b.at &&
    sameJson(a.meta, b.meta) &&
    sameJson(a.tool, b.tool) &&
    sameJson(a.entry, b.entry) &&
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

/**
 * Where a transcript was scrolled: at the end (following), with the last row read there (`lastRow`:
 * rows that come after it while away are new), or with a row's top `offset` px below the top of
 * the view. A row, not a pixel position, because rows are added at the end meanwhile and rows not
 * drawn yet have estimated heights.
 */
export type ScrollSpot = { follow: true; lastRow?: string } | { follow: false; rowId: string; offset: number };

export interface CachedTranscript {
  items: TranscriptItem[];
  /** What was above `items` (lib/older-rows), when known: a pair, only true of these rows. */
  older: Older | null;
  spot: ScrollSpot | null;
}

/**
 * What the kept pair says is above `list`: its `older`, only while `list` is still the kept rows
 * themselves. For the counts a switch back shows before the view's hello; nothing else may take
 * kept rows for the whole list.
 */
export const keptOlder = (kept: CachedTranscript | undefined, list: readonly TranscriptItem[] | null): Older | null =>
  kept && list && kept.items === list ? kept.older : null;

/**
 * The kept transcripts, by view key. A key stays while any of these holds it, and goes the moment
 * none does:
 * - it is one of the last `openedMax` sessions opened (switching back to anything);
 * - it is pinned: the sidebar's Recent rows, which are preloaded (lib/recent-preload);
 * - a view is showing it now.
 */
export class TranscriptStore {
  private readonly entries = new Map<string, CachedTranscript & { stamp: string | null; size: number }>();
  /** Opened sessions, least recent first. */
  private opened: string[] = [];
  private pinned: ReadonlySet<string> = new Set();
  /** Views showing a key: how many, and since when (ms). */
  private readonly views = new Map<string, { n: number; since: number }>();
  /** Sizes of preloaded rows, kept after they go: whether fetching them again could fit. */
  private readonly known = new Map<string, number>();
  constructor(
    readonly openedMax = CACHED_SESSIONS,
    private readonly now: () => number = Date.now,
    readonly budget = CACHE_BUDGET,
  ) {}

  /** What is kept for `key`, without counting as an open. */
  peek(key: string): CachedTranscript | undefined {
    return this.entries.get(key);
  }
  /** A view opening `key`: it becomes the most recently opened. */
  open(key: string): CachedTranscript | undefined {
    this.touch(key);
    return this.entries.get(key);
  }
  /**
   * A view's latest rows, with what its hello said is above them (null: not yet, and then the
   * kept `older` stays only while the rows are the kept ones). The view is open, so this counts
   * as one.
   */
  setItems(key: string, items: TranscriptItem[], older: Older | null = null): void {
    const had = this.entries.get(key);
    const pair = older ?? (had?.items === items ? had.older : null);
    this.entries.set(key, { items, older: pair, spot: had?.spot ?? null, stamp: null, size: had?.size ?? 0 });
    this.touch(key);
  }
  setSpot(key: string, spot: ScrollSpot): void {
    const had = this.entries.get(key);
    if (had) this.entries.set(key, { ...had, spot });
  }
  /**
   * Rows fetched in the background for a pinned session, as of the session's activity `stamp`,
   * `size` characters of JSON (0: not known, measured when trimming). Refused (false) unless the
   * key is still pinned and no view shows it: a view's own rows are newer than any fetch. The rows
   * may be the branch's newest only, with older ones a view fetched kept above them
   * (lib/recent-preload); a view opening them learns what's above from its own hello.
   */
  preload(key: string, items: TranscriptItem[], stamp: string, size: number, older: Older | null = null): boolean {
    if (!this.pinned.has(key) || this.showing(key)) return false;
    this.entries.set(key, { items, older, spot: this.entries.get(key)?.spot ?? null, stamp, size });
    if (size > 0) this.known.set(key, size);
    this.trim();
    return this.entries.has(key);
  }
  /**
   * Keeps the budgeted entries — pinned only: not among the last opened, not shown — within
   * `budget`, dropping the largest first. An entry a view filled is measured here, once
   * (serialized), so call this when idle. The keys it dropped.
   */
  trim(): string[] {
    const sizes = new Map(this.budgeted().map((k) => [k, this.sizeOf(k)]));
    const dropped = overBudget(sizes, this.budget);
    for (const k of dropped) this.entries.delete(k);
    return dropped;
  }
  /** Whether rows of `size` for `key` would stay after `trim`; true when the size isn't known. */
  wouldKeep(key: string, size = this.known.get(key)): boolean {
    if (size === undefined || this.opened.includes(key) || this.showing(key)) return true;
    const sizes = new Map(this.budgeted().filter((k) => k !== key).map((k) => [k, this.sizeOf(k)]));
    sizes.set(key, size);
    return !overBudget(sizes, this.budget).includes(key);
  }
  /** Records the size `key`'s rows came as, when they weren't kept (too big to fetch whole). */
  noteSize(key: string, size: number): void {
    this.known.set(key, size);
  }
  private budgeted(): string[] {
    return this.keys().filter((k) => this.pinned.has(k) && !this.opened.includes(k) && !this.views.has(k));
  }
  private sizeOf(key: string): number {
    const e = this.entries.get(key)!;
    if (!e.size) e.size = JSON.stringify(e.items).length;
    return e.size;
  }
  /**
   * When the kept rows were last known current (ISO): the session's activity stamp a background
   * fetch started at, or the moment the last view showing it went away (a view keeps its rows
   * current). Null while a view has it or when unknown.
   */
  stamp(key: string): string | null | undefined {
    return this.entries.get(key)?.stamp;
  }
  /** The size recorded for a preloaded entry (0 for one a view filled). */
  size(key: string): number {
    return this.entries.get(key)?.size ?? 0;
  }
  /** Replaces the pinned set; whatever nothing else holds goes. */
  pin(keys: Iterable<string>): void {
    this.pinned = new Set(keys);
    this.prune();
  }
  isPinned(key: string): boolean {
    return this.pinned.has(key);
  }
  /** A view shows `key` until the returned release is called. */
  show(key: string): () => void {
    const had = this.views.get(key);
    this.views.set(key, { n: (had?.n ?? 0) + 1, since: had?.since ?? this.now() });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const v = this.views.get(key);
      if (v && v.n > 1) return void this.views.set(key, { ...v, n: v.n - 1 });
      this.views.delete(key);
      const entry = this.entries.get(key);
      if (entry) entry.stamp = new Date(this.now()).toISOString();
      this.prune();
    };
  }
  showing(key: string): boolean {
    return this.views.has(key);
  }
  /** Since when (ms) a view has shown `key`, if one does. */
  shownSince(key: string): number | undefined {
    return this.views.get(key)?.since;
  }
  /** Keys shown by a view now. */
  shown(): string[] {
    return [...this.views.keys()];
  }
  delete(key: string): void {
    this.entries.delete(key);
    this.opened = this.opened.filter((k) => k !== key);
  }
  keys(): string[] {
    return [...this.entries.keys()];
  }
  private touch(key: string): void {
    this.opened = [...this.opened.filter((k) => k !== key), key].slice(-this.openedMax);
    this.prune();
  }
  private prune(): void {
    for (const key of this.entries.keys())
      if (!this.opened.includes(key) && !this.pinned.has(key) && !this.views.has(key)) this.entries.delete(key);
  }
}

/**
 * The keys to drop, largest first, until the rest of `sizes` add up to no more than `budget`.
 * Equal sizes go by key, so the answer depends on the set alone, never on the order it was built
 * in: otherwise two equal sessions could each evict the other on every fetch.
 */
export function overBudget(sizes: ReadonlyMap<string, number>, budget: number): string[] {
  let total = 0;
  for (const n of sizes.values()) total += n;
  const out: string[] = [];
  for (const [k, n] of [...sizes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))) {
    if (total <= budget) break;
    out.push(k);
    total -= n;
  }
  return out;
}

/** This tab's store. */
export const transcripts = new TranscriptStore();

/** The rows and scroll spot kept for a session view (`key`: its view key), if any; opening it. */
export const cachedTranscript = (key: string): CachedTranscript | undefined => transcripts.open(key);

/** Keeps a session's latest rows, and what is above them once a hello has said. */
export const cacheItems = (key: string, items: TranscriptItem[], older: Older | null = null): void => transcripts.setItems(key, items, older);

/** Keeps where a session was scrolled when its view went away. */
export const cacheSpot = (key: string, spot: ScrollSpot): void => transcripts.setSpot(key, spot);

/** Forgets a session (tests; a view that must not come back from memory). */
export const forgetTranscript = (key: string): void => transcripts.delete(key);
