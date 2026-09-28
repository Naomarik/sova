// Which removed line became which added line, and what changed inside each such pair.

import { lineDiff } from "./line-diff";

/** A [start, end) character range of a line. */
export type Range = [number, number];

/** Pairs are only made above this similarity (0..1). */
const PAIR_MIN = 0.5;
/** Past this many cells the pairing matrix is skipped: lines pair by position, if similar. */
const PAIR_CELLS = 4000;
/** No word marks on a line longer than this. */
export const WORD_MAX_LINE = 1000;
/** No word marks when more than this share of a line changed: the whole line reads as changed. */
export const WORD_MAX_CHANGED = 0.6;

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.trim();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams of the trimmed lines. */
export function similarity(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return 1;
  if (ta.length < 2 || tb.length < 2) return 0;
  const ga = bigrams(ta);
  const gb = bigrams(tb);
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  return (2 * common) / (ta.length - 1 + tb.length - 1);
}

/**
 * Pairs removed lines with added lines, in order (no crossing pairs), maximising total similarity;
 * only pairs above PAIR_MIN count. Returns [delIndex, addIndex] pairs.
 */
export function pairLines(dels: readonly string[], adds: readonly string[]): [number, number][] {
  const n = dels.length;
  const m = adds.length;
  if (n === 0 || m === 0) return [];
  if (n * m > PAIR_CELLS) {
    const out: [number, number][] = [];
    for (let i = 0; i < Math.min(n, m); i++) if (similarity(dels[i]!, adds[i]!) >= PAIR_MIN) out.push([i, i]);
    return out;
  }
  const sim = (i: number, j: number) => similarity(dels[i]!, adds[j]!);
  const best: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const s: Float64Array[] = Array.from({ length: n }, (_, i) => Float64Array.from({ length: m }, (_, j) => sim(i, j)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const v = s[i - 1]![j - 1]!;
      best[i]![j] = Math.max(best[i - 1]![j]!, best[i]![j - 1]!, v >= PAIR_MIN ? best[i - 1]![j - 1]! + v : -1);
    }
  }
  const out: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const v = s[i - 1]![j - 1]!;
    if (v >= PAIR_MIN && best[i]![j] === best[i - 1]![j - 1]! + v) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (best[i]![j] === best[i - 1]![j]) i--;
    else j--;
  }
  return out.reverse();
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Words, runs of space, and single punctuation marks, with their offsets. */
function tokens(s: string): { t: string; at: number }[] {
  const out: { t: string; at: number }[] = [];
  for (const m of s.matchAll(TOKEN)) out.push({ t: m[0], at: m.index! });
  return out;
}

function pushRange(list: Range[], from: number, to: number, line: string): void {
  const last = list[list.length - 1];
  // Ranges split only by space merge, so "a b" changed reads as one mark.
  if (last && (last[1] === from || line.slice(last[1], from).trim() === "")) last[1] = to;
  else list.push([from, to]);
}

/** Marks never start or end on space: a changed indent reads from the line's tint, not a block of colour. */
function trimRanges(ranges: Range[], line: string): Range[] {
  const out: Range[] = [];
  for (let [x, y] of ranges) {
    while (x < y && /\s/.test(line[x]!)) x++;
    while (y > x && /\s/.test(line[y - 1]!)) y--;
    if (y > x) out.push([x, y]);
  }
  return out;
}

const changedShare = (ranges: Range[], line: string) => {
  const len = line.trim().length;
  if (len === 0) return 0;
  let n = 0;
  for (const [a, b] of ranges) n += line.slice(a, b).trim().length;
  return n / len;
};

/**
 * The changed character ranges of a paired removed line `a` and added line `b`, by a word diff;
 * null when either line is too long or too much of it changed for marks to help.
 */
export function wordDiff(a: string, b: string): { del: Range[]; add: Range[] } | null {
  if (a.length > WORD_MAX_LINE || b.length > WORD_MAX_LINE) return null;
  const ta = tokens(a);
  const tb = tokens(b);
  const ops = lineDiff(
    ta.map((x) => x.t),
    tb.map((x) => x.t),
    200,
  );
  const del: Range[] = [];
  const add: Range[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      i++;
      j++;
    } else if (op === "-") {
      const t = ta[i++]!;
      pushRange(del, t.at, t.at + t.t.length, a);
    } else {
      const t = tb[j++]!;
      pushRange(add, t.at, t.at + t.t.length, b);
    }
  }
  if (changedShare(del, a) > WORD_MAX_CHANGED || changedShare(add, b) > WORD_MAX_CHANGED) return null;
  return { del: trimRanges(del, a), add: trimRanges(add, b) };
}
