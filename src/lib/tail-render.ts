// Tail-first rendering of a long transcript. A session opens on its newest rows: those are built
// in the same task as the hello, the frame paints, and the older rows are then prepended above
// them in small chunks while the browser is idle, until every row is in the DOM again (so
// Ctrl+F, the outline and the input list see the whole transcript once the fill completes).
// This file is the arithmetic; Thread.tsx does the mounting and the scroll anchoring.

import { dataUrlSize, type ImageSize, thumbBoxHeight } from "./image-size";

/** Rows built with the hello: a phone screen holds ~10 rows, a desktop ~20, so this is several
    screens at either width, and the first frame never waits on the rest. */
export const TAIL_ROWS = 60;
/** The first backfill chunk, before any has been timed. */
export const FIRST_CHUNK = 50;
/** What one chunk may cost: under a frame, so a chunk never becomes a long task. */
export const CHUNK_BUDGET_MS = 12;
export const MIN_CHUNK = 5;
export const MAX_CHUNK = 200;

/** The first row built with the hello, for a list of `n` rows. */
export const initialStart = (n: number, tail = TAIL_ROWS): number => Math.max(0, n - tail);

/**
 * The next chunk's size, from how long the last one took: scaled toward the budget, never more
 * than doubling or less than halving at a time (one expensive row shouldn't collapse the rate),
 * and within [MIN_CHUNK, MAX_CHUNK].
 */
export function nextChunk(prevRows: number, prevMs: number, budgetMs = CHUNK_BUDGET_MS): number {
  const scaled = prevMs <= 0.5 ? prevRows * 2 : Math.floor((prevRows * budgetMs) / prevMs);
  const bounded = Math.min(prevRows * 2, Math.max(Math.floor(prevRows / 2), scaled));
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, bounded));
}

/** The first mounted row after one more chunk above `start`. */
export const chunkStart = (start: number, rows: number): number => Math.max(0, start - rows);

/**
 * The index of the row an entry id resolves to, the way the transcript's `[data-entry]` lookup
 * does (lib/jump `entrySelectors`): the entry's own row or the first of its blocks (`<id>:<i>`),
 * then, for a block id, the first row of the entry it came from. `ids` holds each rendered row's
 * id, or null for a row that draws no `.entry` (a link message). -1: not in the rows at all.
 */
export function rowIndexFor(ids: readonly (string | null)[], entryId: string): number {
  const find = (id: string) => {
    const prefix = `${id}:`;
    return ids.findIndex((r) => r !== null && (r === id || r.startsWith(prefix)));
  };
  const own = find(entryId);
  if (own >= 0) return own;
  const i = entryId.indexOf(":");
  return i < 0 ? -1 : find(entryId.slice(0, i));
}

/**
 * The id that holds the window's start at row `i`: that row's own, at index 0 too. Holding "none"
 * there would mean "everything is built", and rows that arrive later above it (a tail-first hello's
 * history, lib/tail-hello) would then be built all at once, in one long task per chunk, outside the
 * scroll anchoring; held by id, they land above the window and the idle fill builds them.
 */
export const windowId = (ids: readonly { id: string }[], i: number): string | null => ids[i]?.id ?? null;

/**
 * Where the window starts in a new row list: at the row it started at before (appends and
 * reconciled refetches keep everything already built; rows that arrive above it are left to the
 * fill), at 0 when there was no row to hold it by, and, when that row is gone (a rewind, or hiding
 * the kind of row it was), at 0 again if everything was built (`prev`), else at the tail.
 */
export function carriedStart(firstId: string | null, indexOfId: (id: string) => number, n: number, prev?: number): number {
  if (firstId === null) return 0;
  const i = indexOfId(firstId);
  return i >= 0 ? i : prev === 0 ? 0 : initialStart(n);
}

/** Lines `text` wraps to at `cols` characters, counting each hard line at least once. */
export function wrapLines(text: string, cols: number): number {
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / cols));
  return lines;
}

/** A row's lines are capped here: a very long message still gets a tall estimate, not a huge one. */
const MAX_EST_LINES = 200;

/** Where a row's images sit, which decides the chrome around the strip: a user row's gap above it,
    or a tool card's media strip (rule and padding). */
export type ImagesAt = "user" | "tool";

/** A thumbnail tile with its border (base.css `.thumb img`: 96px), and the gap between tiles. */
const TILE = 98;
const TILE_GAP = 8;
/** Tiles to a row at the reading measure (6 at a 1024px window, 8 at 1440, 9 at 1920), and in a
    folded-width transcript (3 at 390, 4 at 800). */
const TILES_WIDE = 7;
const TILES_NARROW = 3;
/** A single image whose header can't be read counts as a 16:10 screenshot. */
const UNKNOWN_IMAGE: ImageSize = { w: 1600, h: 1000 };

const tileRows = (n: number, perRow: number) => {
  const rows = Math.ceil(n / perRow);
  return rows * TILE + (rows - 1) * TILE_GAP;
};

/**
 * The height a row's images add, in a wide and in a folded-width transcript: one image at its box's
 * own height (lib/image-size), two or more as rows of tiles, plus the strip's chrome.
 */
export function imagesEstimate(images: readonly string[] | undefined, at: ImagesAt): [wide: number, narrow: number] {
  const n = images?.length ?? 0;
  if (n === 0) return [0, 0];
  const chrome = at === "user" ? 8 : 17;
  if (n === 1) {
    const h = chrome + thumbBoxHeight(dataUrlSize(images![0]!) ?? UNKNOWN_IMAGE);
    return [h, h];
  }
  return [chrome + tileRows(n, TILES_WIDE), chrome + tileRows(n, TILES_NARROW)];
}

/**
 * A row's height until it is first drawn (`content-visibility: auto` skips rows off screen, and a
 * skipped row is laid out at this size): a fixed part for its chrome plus its text's wrapped lines,
 * which app.css turns into pixels for the width the transcript has, plus the images the row shows
 * (`images`, `at` where they sit: a tool call's are its result's). Only the scrollbar and a long
 * jump's first aim depend on it; a drawn row remembers its real height.
 */
export function rowEstimate(item: { kind: string; text?: string }, images?: readonly string[], at: ImagesAt = "user"): string {
  const text = item.text ?? "";
  const [base, lines] =
    item.kind === "assistant-text" ? [24, wrapLines(text, 80)]
    : item.kind === "user" ? [48, wrapLines(text, 64)]
    : item.kind === "tool-call" || item.kind === "tool-result" || item.kind === "thinking" ? [40, 0]
    : item.kind === "report" ? [64, 0]
    : item.kind === "info" ? [8, 1]
    : [48, 1];
  const est = `${base}px + ${Math.min(lines, MAX_EST_LINES)} * var(--entry-line-est, 23px)`;
  const [wide, narrow] = imagesEstimate(images, at);
  if (wide === 0) return `calc(${est})`;
  return `calc(${est} + ${wide}px${narrow === wide ? "" : ` + var(--entry-narrow, 0) * ${narrow - wide}px`})`;
}
