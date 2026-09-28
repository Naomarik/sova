// Sequence diff for when no patch was recorded (a streaming or failed edit, two whole texts):
// common prefix/suffix trimmed, lines unique to both sides used as anchors (patience), Myers
// between anchors, and runs slid to the tidiest position. Past a cost cap the middle is one
// whole replacement, which is always a correct diff, just a coarse one.

import { countRows, splitLines, type DiffRow, type FileDiff, type Hunk } from "./types";

/** "=" kept, "-" only in a, "+" only in b; one op per element, a's and b's in order. */
export type Op = "=" | "-" | "+";

/** Edit distance past which Myers gives up on a range and replaces it whole. */
const MAX_COST = 2000;

export function lineDiff(a: readonly string[], b: readonly string[], maxCost = MAX_COST): Op[] {
  const ops: Op[] = [];
  diffRange(a, 0, a.length, b, 0, b.length, maxCost, ops);
  return slide(ops, a, b);
}

function diffRange(a: readonly string[], alo: number, ahi: number, b: readonly string[], blo: number, bhi: number, maxCost: number, out: Op[]): void {
  let pre = 0;
  while (alo + pre < ahi && blo + pre < bhi && a[alo + pre] === b[blo + pre]) pre++;
  let suf = 0;
  while (ahi - suf > alo + pre && bhi - suf > blo + pre && a[ahi - suf - 1] === b[bhi - suf - 1]) suf++;
  for (let i = 0; i < pre; i++) out.push("=");
  const a0 = alo + pre;
  const a1 = ahi - suf;
  const b0 = blo + pre;
  const b1 = bhi - suf;
  if (a0 === a1 || b0 === b1) {
    for (let i = a0; i < a1; i++) out.push("-");
    for (let i = b0; i < b1; i++) out.push("+");
  } else {
    const anchors = uniqueAnchors(a, a0, a1, b, b0, b1);
    if (anchors.length > 0) {
      let pa = a0;
      let pb = b0;
      for (const [ia, ib] of anchors) {
        diffRange(a, pa, ia, b, pb, ib, maxCost, out);
        out.push("=");
        pa = ia + 1;
        pb = ib + 1;
      }
      diffRange(a, pa, a1, b, pb, b1, maxCost, out);
    } else {
      const mid = myers(a, a0, a1, b, b0, b1, maxCost);
      if (mid) out.push(...mid);
      else {
        for (let i = a0; i < a1; i++) out.push("-");
        for (let i = b0; i < b1; i++) out.push("+");
      }
    }
  }
  for (let i = 0; i < suf; i++) out.push("=");
}

/** Lines occurring exactly once in each range, as [aIndex, bIndex], longest increasing run of b by a. */
function uniqueAnchors(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number): [number, number][] {
  const seen = new Map<string, { na: number; nb: number; ia: number; ib: number }>();
  for (let i = a0; i < a1; i++) {
    const e = seen.get(a[i]!);
    if (e) e.na++;
    else seen.set(a[i]!, { na: 1, nb: 0, ia: i, ib: -1 });
  }
  for (let i = b0; i < b1; i++) {
    const e = seen.get(b[i]!);
    if (e) {
      e.nb++;
      e.ib = i;
    }
  }
  const pairs: [number, number][] = [];
  for (const e of seen.values()) if (e.na === 1 && e.nb === 1 && a[e.ia]!.trim() !== "") pairs.push([e.ia, e.ib]);
  if (pairs.length === 0) return [];
  pairs.sort((x, y) => x[0] - y[0]);
  // Patience: longest increasing subsequence of b indices.
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: [number, number][] = [];
  for (let k = tails[tails.length - 1]!; k >= 0; k = prev[k]!) out.push(pairs[k]!);
  return out.reverse();
}

/** Myers' O(ND) diff of a[a0,a1) against b[b0,b1); null when the distance passes maxCost. */
function myers(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number, maxCost: number): Op[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxCost);
  for (let d = 0; d <= limit; d++) {
    // The state before step d, for k in [-d, d]: all the backtrack reads.
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number): Op[] {
  const rev: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const vp = trace[d]!;
    const at = (k: number) => vp[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = prevK === k + 1 ? prevX : prevX + 1;
    while (x > startX) {
      rev.push("=");
      x--;
      y--;
    }
    rev.push(prevK === k + 1 ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    rev.push("=");
    x--;
  }
  return rev.reverse();
}

const blank = (s: string | undefined) => s === undefined || s.trim() === "";

/**
 * Slides each run of only-removed or only-added lines to its tidiest equivalent position: the
 * lowest one where the run ends on a blank line, else the lowest. So an added function lands as
 * "function…}" plus its blank, not "}" plus the next function's head.
 */
function slide(ops: Op[], a: readonly string[], b: readonly string[]): Op[] {
  let ia = 0;
  let ib = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === "=") {
      ia++;
      ib++;
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j] !== "=") j++;
    const kinds = new Set(ops.slice(i, j));
    const len = j - i;
    if (kinds.size === 1) {
      const kind = ops[i]!;
      const seq = kind === "-" ? a : b;
      const start = kind === "-" ? ia : ib;
      // How far up (the op before is "=" and the lines match) and down it may move.
      let up = 0;
      while (i - up - 1 >= 0 && ops[i - up - 1] === "=" && seq[start - up - 1] === seq[start - up - 1 + len]) up++;
      let down = 0;
      while (j + down < ops.length && ops[j + down] === "=" && seq[start + down] === seq[start + down + len]) down++;
      if (up + down > 0) {
        let best = down;
        for (let s = down; s >= -up; s--) {
          if (blank(seq[start + s + len - 1])) {
            best = s;
            break;
          }
        }
        if (best !== 0) {
          const lo = i + Math.min(0, best);
          const hi = j + Math.max(0, best);
          for (let k = lo; k < hi; k++) ops[k] = "=";
          for (let k = i + best; k < j + best; k++) ops[k] = kind;
        }
        const shift = best;
        i = j + shift;
        if (kind === "-") ia = start + shift + len;
        else ib = start + shift + len;
        // The "="s the run passed over (or gave back) move the other side too.
        if (kind === "-") ib += shift;
        else ia += shift;
        continue;
      }
    }
    for (let k = i; k < j; k++) ops[k] === "-" ? ia++ : ib++;
    i = j;
  }
  return ops;
}

/** Hunks from an op list, with `context` unchanged lines around each change. */
export function hunksFromOps(ops: readonly Op[], a: readonly string[], b: readonly string[], context = 3, oldBase = 1, newBase = 1): Hunk[] {
  const rows: DiffRow[] = [];
  let ia = 0;
  let ib = 0;
  for (const op of ops) {
    if (op === "=") rows.push({ kind: "ctx", text: b[ib]!, oldNo: oldBase + ia++, newNo: newBase + ib++ });
    else if (op === "-") rows.push({ kind: "del", text: a[ia]!, oldNo: oldBase + ia++, newNo: null });
    else rows.push({ kind: "add", text: b[ib]!, oldNo: null, newNo: newBase + ib++ });
  }
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind === "ctx") {
      i++;
      continue;
    }
    const from = Math.max(0, i - context);
    // Extend while the next change is within 2·context unchanged rows.
    let end = i;
    for (;;) {
      while (end < rows.length && rows[end]!.kind !== "ctx") end++;
      let gap = end;
      while (gap < rows.length && rows[gap]!.kind === "ctx") gap++;
      if (gap < rows.length && gap - end <= 2 * context) end = gap;
      else break;
    }
    const to = Math.min(rows.length, end + context);
    hunks.push(hunkOf(rows.slice(from, to), oldBase + countBefore(rows, from, "old"), newBase + countBefore(rows, from, "new")));
    i = to;
  }
  return hunks;
}

function countBefore(rows: DiffRow[], upto: number, side: "old" | "new"): number {
  let n = 0;
  for (let i = 0; i < upto; i++) if (side === "old" ? rows[i]!.kind !== "add" : rows[i]!.kind !== "del") n++;
  return n;
}

function hunkOf(rows: DiffRow[], oldFirst: number, newFirst: number): Hunk {
  const oldLines = rows.filter((r) => r.kind !== "add").length;
  const newLines = rows.filter((r) => r.kind !== "del").length;
  return {
    oldStart: oldLines === 0 ? oldFirst - 1 : oldFirst,
    oldLines,
    newStart: newLines === 0 ? newFirst - 1 : newFirst,
    newLines,
    heading: "",
    rows,
  };
}

/** A FileDiff of two whole texts; they stay on it, so its folds can expand. */
export function diffTexts(oldText: string, newText: string, path: string, context = 3): FileDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const hunks = hunksFromOps(lineDiff(a, b), a, b, context);
  return { oldPath: path, newPath: path, status: "M", hunks, oldText, newText, numbered: true, ...countRows(hunks) };
}

/** A new file: every line added. */
export function addedFile(text: string, path: string): FileDiff {
  const lines = splitLines(text);
  const hunks = lines.length ? [hunkOf(lines.map((t, i) => ({ kind: "add", text: t, oldNo: null, newNo: i + 1 })), 1, 1)] : [];
  if (hunks[0]) hunks[0].oldStart = 0;
  return { oldPath: null, newPath: path, status: "A", hunks, newText: text, oldText: "", numbered: true, ...countRows(hunks) };
}

/**
 * Snippet replacements (an edit call's oldText → newText pairs) with no file to place them in: one
 * hunk each, numbered from the snippet's first line, so the view hides the numbers.
 */
export function diffSnippets(edits: readonly { oldText: string; newText: string }[], path: string): FileDiff {
  const hunks: Hunk[] = [];
  for (const e of edits) {
    const a = splitLines(e.oldText);
    const b = splitLines(e.newText);
    const all = hunksFromOps(lineDiff(a, b), a, b, Number.MAX_SAFE_INTEGER);
    hunks.push(...all);
  }
  return { oldPath: path, newPath: path, status: "M", hunks, numbered: false, ...countRows(hunks) };
}
