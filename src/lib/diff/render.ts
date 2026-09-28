// A FileDiff turned into what the view draws: highlighted, word-marked rows per hunk, the folded
// gaps between hunks, and the side-by-side pairing for Split. Pure string work, run once per file.

import { highlightByPath } from "../markdown";
import { markRanges, splitHighlighted } from "./highlight";
import { pairLines, wordDiff, type Range } from "./intraline";
import { filePath, hunkSpan, splitLines, type FileDiff, type Hunk, type RowKind } from "./types";

export interface RenderedRow {
  kind: RowKind;
  oldNo: number | null;
  newNo: number | null;
  /** Escaped, highlighted HTML of the line's text, with word marks on a paired changed line. */
  html: string;
  noEol?: boolean;
  /** Index (in its hunk's rows) of the changed line this one is paired with. */
  pair?: number;
}

/** Unchanged lines between two shown hunks (or before the first, after the last). */
export interface RenderedGap {
  count: number;
  /** The rows, when the whole text is known; the view shows them in place of the fold. */
  rows: (() => RenderedRow[]) | null;
}

/** A Split line: the old side and the new side, either empty (a filler) on an unmatched change. */
export interface SplitRow {
  left: RenderedRow | null;
  right: RenderedRow | null;
}

export interface RenderedHunk {
  /** Index into FileDiff.hunks. */
  index: number;
  hunk: Hunk;
  /** The unchanged lines above this hunk; null when there are none, or when the hunk above isn't shown. */
  gapBefore: RenderedGap | null;
  rows: RenderedRow[];
  split: SplitRow[];
}

export interface RenderedFile {
  hunks: RenderedHunk[];
  /** Unchanged lines after the last hunk, when the whole text says there are any. */
  gapAfter: RenderedGap | null;
}

/** No syntax highlighting past this many characters on a side: escaped text only. */
const HIGHLIGHT_MAX = 400_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One HTML string per line of `lines`, highlighted as one text by the file's path. */
export function highlightLines(lines: readonly string[], path: string): string[] {
  const text = lines.join("\n");
  if (text.length > HIGHLIGHT_MAX) return lines.map(escapeHtml);
  const out = splitHighlighted(highlightByPath(text, path).html);
  return out.length === lines.length ? out : lines.map(escapeHtml);
}

/** Which file (and which of its hunks) a view shows: a view keeps its state (Load Diff, open
    folds) while this stays the same, and starts over when it changes. The same file read again,
    or with its whole text added, keeps the key. */
export function viewKey(file: FileDiff, only?: readonly number[]): string {
  return JSON.stringify([file.oldPath, file.newPath, file.status, file.numbered, only ?? null]);
}

/** Changed rows past which a file waits behind "Load diff". */
export const BIG_DIFF_ROWS = 1500;

/** Renders the hunks of `file` whose indices are in `only` (all when omitted), in file order. */
export function renderFile(file: FileDiff, only?: readonly number[]): RenderedFile {
  const path = filePath(file);
  const shown = only ? [...new Set(only)].filter((i) => i >= 0 && i < file.hunks.length).sort((a, b) => a - b) : file.hunks.map((_, i) => i);
  const oldAll = file.oldText !== undefined ? splitLines(file.oldText) : null;
  const newAll = file.newText !== undefined ? splitLines(file.newText) : null;
  // Whole sides highlight once, so a hunk inside a block comment is coloured as one.
  let oldHtml: string[] | null = null;
  let newHtml: string[] | null = null;
  const oldSide = () => (oldHtml ??= oldAll ? highlightLines(oldAll, path) : null);
  const newSide = () => (newHtml ??= newAll ? highlightLines(newAll, path) : null);

  const hunks: RenderedHunk[] = shown.map((index, k) => {
    const hunk = file.hunks[index]!;
    const rows = renderRows(hunk, path, file.numbered ? oldSide() : null, file.numbered ? newSide() : null);
    const prevShown = k > 0 ? shown[k - 1] : undefined;
    const adjacent = index === 0 ? prevShown === undefined : prevShown === index - 1;
    return { index, hunk, gapBefore: adjacent && file.numbered ? gapBefore(file, index, oldAll, newAll, oldSide, newSide) : null, rows, split: splitRows(rows) };
  });

  let gapAfter: RenderedGap | null = null;
  const lastIndex = shown[shown.length - 1];
  if (lastIndex === file.hunks.length - 1 && file.numbered && (oldAll || newAll)) {
    const span = hunkSpan(file.hunks[lastIndex]!);
    const count = oldAll ? oldAll.length - span.oldEnd + 1 : newAll!.length - span.newEnd + 1;
    if (count > 0) gapAfter = { count, rows: () => contextRows(span.oldEnd, span.newEnd, count, oldAll, newAll, oldSide, newSide) };
  }
  return { hunks, gapAfter };
}

function gapBefore(
  file: FileDiff,
  index: number,
  oldAll: string[] | null,
  newAll: string[] | null,
  oldSide: () => string[] | null,
  newSide: () => string[] | null,
): RenderedGap | null {
  const span = hunkSpan(file.hunks[index]!);
  const prev = index > 0 ? hunkSpan(file.hunks[index - 1]!) : { oldEnd: 1, newEnd: 1 };
  const count = span.oldFirst - prev.oldEnd;
  if (count <= 0) return null;
  return { count, rows: oldAll || newAll ? () => contextRows(prev.oldEnd, prev.newEnd, count, oldAll, newAll, oldSide, newSide) : null };
}

/** `count` unchanged rows from old line `oldFrom` / new line `newFrom`, from whichever side's text is known. */
function contextRows(
  oldFrom: number,
  newFrom: number,
  count: number,
  oldAll: string[] | null,
  newAll: string[] | null,
  oldSide: () => string[] | null,
  newSide: () => string[] | null,
): RenderedRow[] {
  const rows: RenderedRow[] = [];
  const html = oldAll ? oldSide() : newSide();
  for (let i = 0; i < count; i++) {
    const at = oldAll ? oldFrom - 1 + i : newFrom - 1 + i;
    const text = (oldAll ?? newAll)![at];
    if (text === undefined) break;
    rows.push({ kind: "ctx", oldNo: oldFrom + i, newNo: newFrom + i, html: html?.[at] ?? escapeHtml(text) });
  }
  return rows;
}

/**
 * A hunk's rows with HTML. Each side takes its lines from the whole-file highlight when there is
 * one, else from highlighting the hunk's own lines of that side. Changed lines then pair up by
 * similarity, and each pair gets word marks.
 */
function renderRows(hunk: Hunk, path: string, oldHtml: string[] | null, newHtml: string[] | null): RenderedRow[] {
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  hunk.rows.forEach((r, i) => {
    if (r.kind !== "add") oldIdx.push(i);
    if (r.kind !== "del") newIdx.push(i);
  });
  const ownOld = oldHtml ? null : highlightLines(oldIdx.map((i) => hunk.rows[i]!.text), path);
  const ownNew = newHtml ? null : highlightLines(newIdx.map((i) => hunk.rows[i]!.text), path);
  const htmlOf = new Array<string>(hunk.rows.length);
  const pair = new Array<number | undefined>(hunk.rows.length);
  oldIdx.forEach((ri, k) => {
    const r = hunk.rows[ri]!;
    htmlOf[ri] = (oldHtml && r.oldNo !== null ? oldHtml[r.oldNo - 1] : undefined) ?? ownOld?.[k] ?? escapeHtml(r.text);
  });
  newIdx.forEach((ri, k) => {
    const r = hunk.rows[ri]!;
    if (r.kind === "ctx" && htmlOf[ri] !== undefined) return;
    htmlOf[ri] = (newHtml && r.newNo !== null ? newHtml[r.newNo - 1] : undefined) ?? ownNew?.[k] ?? escapeHtml(r.text);
  });

  // Word marks on each paired del/add inside every run of changed rows.
  let i = 0;
  while (i < hunk.rows.length) {
    if (hunk.rows[i]!.kind === "ctx") {
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < hunk.rows.length && hunk.rows[i]!.kind !== "ctx") (hunk.rows[i]!.kind === "del" ? dels : adds).push(i++);
    for (const [d, a] of pairLines(
      dels.map((k) => hunk.rows[k]!.text),
      adds.map((k) => hunk.rows[k]!.text),
    )) {
      const di = dels[d]!;
      const ai = adds[a]!;
      const w = wordDiff(hunk.rows[di]!.text, hunk.rows[ai]!.text);
      if (!w) continue;
      htmlOf[di] = markRanges(htmlOf[di]!, w.del, "del");
      htmlOf[ai] = markRanges(htmlOf[ai]!, w.add, "ins");
      pair[di] = ai;
      pair[ai] = di;
    }
  }
  return hunk.rows.map((r, k) => {
    const out: RenderedRow = { kind: r.kind, oldNo: r.oldNo, newNo: r.newNo, html: htmlOf[k]! };
    if (r.noEol) out.noEol = true;
    if (pair[k] !== undefined) out.pair = pair[k];
    return out;
  });
}

/**
 * Split rows: unchanged rows on both sides; in each run of changes, a removed line beside the line
 * it became (by the pairing), other lines beside the next unpaired line opposite, or a filler.
 */
export function splitRows(rows: readonly RenderedRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.kind === "ctx") {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < rows.length && rows[i]!.kind !== "ctx") (rows[i]!.kind === "del" ? dels : adds).push(i++);
    let a = 0;
    for (const d of dels) {
      const partner = rows[d]!.pair;
      if (partner !== undefined) {
        while (a < adds.length && adds[a] !== partner) out.push({ left: null, right: rows[adds[a++]!]! });
        out.push({ left: rows[d]!, right: a < adds.length ? rows[adds[a++]!]! : null });
      } else if (a < adds.length && rows[adds[a]!]!.pair === undefined) out.push({ left: rows[d]!, right: rows[adds[a++]!]! });
      else out.push({ left: rows[d]!, right: null });
    }
    while (a < adds.length) out.push({ left: null, right: rows[adds[a++]!]! });
  }
  return out;
}

export type { Range };
