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
 * there would mean "everything is built", and rows that arrive later above it (older rows fetched
 * on demand, lib/older-rows) would then be built all at once, in one long task per chunk, outside the
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

/** What a message's text is made of, for its estimate: its prose lines and their characters (in
    plain text, `pre`, a blank line is a line too; in markdown it is only a paragraph break), the
    lines inside code fences (which scroll, never wrap), the fenced blocks and the table rows. */
export interface TextShape { lines: number; chars: number; code: number; fences: number; table: number }

export function textShape(text: string, pre = false): TextShape {
  const shape: TextShape = { lines: 0, chars: 0, code: 0, fences: 0, table: 0 };
  let inCode = false;
  for (const line of text.split("\n")) {
    if (!pre && /^\s*```/.test(line)) {
      if (!inCode) shape.fences++;
      inCode = !inCode;
    } else if (inCode) shape.code++;
    else if (!pre && /^\s*\|/.test(line)) shape.table++;
    else if (pre || line.trim() !== "") {
      shape.lines++;
      shape.chars += line.length;
    }
  }
  return shape;
}

/** A row's wrapped lines are capped here: a very long message still gets a tall estimate, not a huge one. */
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

/** Characters a message line holds at a message width of `px`: less the bubble's padding, 7px a
    character, both fitted to real rows. The transcript sets it as `--entry-cols` (Thread). */
export const lineCols = (px: number): number => Math.max(10, Math.round((px - 50) / 7));

/**
 * Wrapped lines, as a CSS expression: each prose line is `perLine` of a line (short ones don't
 * wrap), plus its characters over the characters a line holds at the width the transcript has
 * (`--entry-cols`). The constants are fitted to the rows' real heights at 1440 and 390px wide.
 */
const wrapped = (s: TextShape, perLine: number) =>
  `min(${MAX_EST_LINES}, ${+(perLine * s.lines).toFixed(2)} + ${s.chars} / var(--entry-cols, 110)) * var(--entry-line, 22.5px)`;

/** A compaction draws as a folded disclosure, not as its summary's text (Thread `Compaction`). */
const isCompaction = (raw: unknown) => typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "compaction";

/**
 * A row's height until it is first drawn (`content-visibility: auto` skips rows off screen, and a
 * skipped row is laid out at this size): a fixed part for its chrome, measured per kind (a
 * collapsed tool card, a folded disclosure or compaction), plus its text's wrapped lines, which app.css turns
 * into pixels for the width the transcript has, plus the images the row shows (`images`, `at`
 * where they sit: a tool call's are its result's). Only the scrollbar and a long jump's first aim
 * depend on it; a drawn row remembers its real height. A row that draws nothing (a paired tool
 * result) takes no space whatever its estimate (`.entry:empty`).
 */
export function rowEstimate(item: { kind: string; text?: string; raw?: unknown }, images?: readonly string[], at: ImagesAt = "user"): string {
  const text = item.text ?? "";
  let est: string;
  if (item.kind === "assistant-text") {
    const s = textShape(text);
    est = `${99 + 19 * s.code + 93 * s.fences + 67 * s.table}px + ${wrapped(s, 0.8)}`;
  } else if (item.kind === "user") est = `97px + ${wrapped(textShape(text, true), 0.7)}`;
  else if (item.kind === "info" && isCompaction(item.raw)) est = "36px";
  else if (item.kind === "info") est = `-4px + ${wrapped(textShape(text, true), 1)}`;
  else if (item.kind === "tool-call" || item.kind === "tool-result" || item.kind === "wake") est = "46px";
  else if (item.kind === "thinking" || item.kind === "report") est = "36px";
  else if (item.kind === "worktree-merge") est = "98px + var(--entry-narrow, 0) * 66px";
  else est = "70px";
  const [wide, narrow] = imagesEstimate(images, at);
  if (wide === 0) return `calc(${est})`;
  return `calc(${est} + ${wide}px${narrow === wide ? "" : ` + var(--entry-narrow, 0) * ${narrow - wide}px`})`;
}
