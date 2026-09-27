// Newest rows first over the wire. A client that opts in (`?tail=1` on /ws/chat or /ws/watch)
// gets a `hello`/`snapshot` holding only the transcript's newest whole entries, with `older`
// saying how many rows came before them, and then those older rows as `history` messages of about
// HISTORY_CHUNK_CHARS each, newest chunk first, sent in the same synchronous step so no other
// message can come between. The cut is made on the list `normalizeEntries` already produced, so
// the tail and the chunks, put back together, are exactly the rows a whole hello carries: every
// whole-branch rule (the newest align doc, the newest explain run, the running model) has run.
// Pure, for tsx --test.

import type { TranscriptItem } from "../shared/protocol";

/** The tail holds at least this many rows, when its size allows (the client builds 60 with it). */
export const TAIL_MIN_ROWS = 60;
/** …and stays under this much JSON, except that it always holds the newest entry whole. */
export const TAIL_CHARS = 256 * 1024;
/** A history message holds about this much JSON; a row bigger than that is a message of its own. */
export const HISTORY_CHUNK_CHARS = 256 * 1024;

/** The entry a row belongs to: an assistant reply's blocks are `<entryId>:<i>` (and `:stop`). */
const entryOf = (id: string): string => {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(0, i);
};

/** The index of the first row of the entry that row `i` belongs to. */
function entryStart(items: readonly TranscriptItem[], i: number): number {
  const e = entryOf(items[i]!.id);
  while (i > 0 && entryOf(items[i - 1]!.id) === e) i--;
  return i;
}

/** The index just past the entry row `i` belongs to. */
function entryEnd(items: readonly TranscriptItem[], i: number): number {
  const e = entryOf(items[i]!.id);
  while (i < items.length && entryOf(items[i]!.id) === e) i++;
  return i;
}

/**
 * Where the tail starts in `items`, given each row's JSON length. It always starts on an entry's
 * first row, never between a reply's blocks. Entries are added from the newest back while the tail
 * has fewer than `minRows` rows and stays within `maxChars`; the newest entry is always in.
 * A tail that would open on a tool result starts at the next entry instead, so a result never
 * arrives before its call (unless that leaves nothing, then it takes the call too), and a tail
 * that would open inside a baton wrap-up starts at the wrap-up's start mark, so the fold that
 * hides that turn (src/lib/wrapup-rows.ts) sees it from its first row.
 */
export function tailStart(
  items: readonly TranscriptItem[],
  sizes: readonly number[],
  minRows = TAIL_MIN_ROWS,
  maxChars = TAIL_CHARS,
): number {
  const n = items.length;
  if (n === 0) return 0;
  let start = entryStart(items, n - 1);
  let chars = 0;
  for (let i = start; i < n; i++) chars += sizes[i]!;
  while (start > 0 && n - start < minRows) {
    const g = entryStart(items, start - 1);
    let add = 0;
    for (let i = g; i < start; i++) add += sizes[i]!;
    if (chars + add > maxChars) break;
    chars += add;
    start = g;
  }
  let s = start;
  while (s < n && items[s]!.kind === "tool-result") s = entryEnd(items, s);
  if (s < n) start = s;
  else while (start > 0 && items[start]!.kind === "tool-result") start = entryStart(items, start - 1);
  for (let i = start - 1; i >= 0; i--) {
    const m = items[i]!.batonMark;
    if (m?.kind !== "wrapup") continue;
    if (m.phase === "start") start = i;
    break;
  }
  return start;
}

/** The `[from, to)` row ranges of the history messages for rows `[0, count)`, newest first: each
    about `maxChars` of JSON, a row bigger than that alone. */
export function historyRanges(sizes: readonly number[], count: number, maxChars = HISTORY_CHUNK_CHARS): [number, number][] {
  const out: [number, number][] = [];
  let to = count;
  while (to > 0) {
    let from = to - 1;
    let chars = sizes[from]!;
    while (from > 0 && chars + sizes[from - 1]! <= maxChars) chars += sizes[--from]!;
    out.push([from, to]);
    to = from;
  }
  return out;
}

/** One history message: the object (for a client that takes objects) and its JSON, made once. */
export interface HistoryPart {
  msg: { type: "history"; items: TranscriptItem[]; left: number };
  raw: string;
}

export interface TailCut {
  /** The newest rows, for the hello or snapshot. */
  items: TranscriptItem[];
  /** Rows before them, still to come; 0: `items` is the whole list and `history` is empty. */
  older: number;
  /** The older rows, newest chunk first; the last one has `left: 0`. */
  history: HistoryPart[];
}

/**
 * Cut a normalized transcript into its tail and its history messages. Each row is serialized once:
 * its length picks the cut, and its JSON is reused in the history message's own JSON, which is
 * byte for byte what `JSON.stringify` makes of that message.
 */
export function cutTail(items: TranscriptItem[], opts: { minRows?: number; maxChars?: number; chunkChars?: number } = {}): TailCut {
  const json = items.map((it) => JSON.stringify(it));
  const sizes = json.map((s) => s.length);
  const start = tailStart(items, sizes, opts.minRows, opts.maxChars);
  const history = historyRanges(sizes, start, opts.chunkChars).map(([from, to]): HistoryPart => ({
    msg: { type: "history", items: items.slice(from, to), left: from },
    raw: `{"type":"history","items":[${json.slice(from, to).join(",")}],"left":${from}}`,
  }));
  return { items: start === 0 ? items : items.slice(start), older: start, history };
}
