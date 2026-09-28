/**
 * Text geometry for the SVG kinds. SVG never wraps, so every label is broken into lines here,
 * against a width function: the browser passes a canvas measure (exact for the loaded font), tests
 * and first paint use `estimateWidth`, an Inter-shaped per-character table.
 */

export type Measure = (text: string, px: number, mono?: boolean) => number;

const NARROW = new Set("iljtfr.,:;'|!()[]{} ");
const WIDE = new Set("mwMW@%");

/** Inter-ish advance widths in em; mono is a flat 0.6em. Errs slightly wide so boxes never clip. */
export const estimateWidth: Measure = (text, px, mono = false) => {
  if (mono) return text.length * px * 0.6;
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.32;
    else if (WIDE.has(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.68;
    else if (ch >= "0" && ch <= "9") em += 0.6;
    else if (ch.charCodeAt(0) > 0x2e7f) em += 1;
    else em += 0.56;
  }
  return em * px;
};

let canvasCtx: CanvasRenderingContext2D | null | undefined;
const memo = new Map<string, number>();

/** Canvas measure in the app's fonts, memoized; falls back to the estimate off-DOM. */
export const canvasMeasure: Measure = (text, px, mono = false) => {
  const key = `${mono ? "m" : "s"}${px}|${text}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  if (canvasCtx === undefined) canvasCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!canvasCtx) return estimateWidth(text, px, mono);
  canvasCtx.font = mono ? `400 ${px}px "JetBrains Mono", ui-monospace, monospace` : `530 ${px}px Inter, system-ui, sans-serif`;
  // Canvas and SVG round differently; a little slack keeps a box from clipping its own text.
  const w = canvasCtx.measureText(text).width * 1.03;
  if (memo.size > 4000) memo.clear();
  memo.set(key, w);
  return w;
};

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`. A word too long for a
 * line breaks after `/ . - _ ? = &` when it can, else anywhere. Overflow ends the last line with "…".
 * Explicit "\n" in the text starts a new line.
 */
export function wrap(text: string, maxWidth: number, maxLines: number, px: number, measure: Measure = estimateWidth, mono = false): string[] {
  const out: string[] = [];
  const w = (s: string) => measure(s, px, mono);
  let truncated = false;
  for (const para of text.split("\n")) {
    let line = "";
    const pieces = para.split(/(\s+)/).flatMap((word) => (word.trim() && w(word) > maxWidth ? splitWord(word, maxWidth, w) : [word]));
    for (const piece of pieces) {
      if (!piece) continue;
      const next = line + piece;
      if (line && w(next.trimEnd()) > maxWidth) {
        out.push(line.trimEnd());
        line = piece.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  if (out.length > maxLines) {
    out.length = maxLines;
    truncated = true;
  }
  if (truncated) {
    let last = out[maxLines - 1]!;
    while (last && w(`${last}…`) > maxWidth) last = last.slice(0, -1);
    out[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

function splitWord(word: string, maxWidth: number, w: (s: string) => number): string[] {
  const parts: string[] = [];
  let cur = "";
  const soft = word.split(/(?<=[/._?=&-])/);
  for (const s of soft) {
    if (w(cur + s) <= maxWidth) {
      cur += s;
      continue;
    }
    if (cur) parts.push(cur);
    cur = "";
    for (const ch of s) {
      if (w(cur + ch) > maxWidth && cur) {
        parts.push(cur);
        cur = "";
      }
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  // A stranded tail ("…", "s"): pull the previous part's last soft segment down to keep it company.
  const n = parts.length;
  if (n > 1 && parts[n - 1]!.length <= 2) {
    const prev = parts[n - 2]!;
    const cut = prev.search(/[^/._?=&-]+[/._?=&-]*$/);
    if (cut > 0 && w(prev.slice(cut) + parts[n - 1]) <= maxWidth) {
      parts[n - 2] = prev.slice(0, cut);
      parts[n - 1] = prev.slice(cut) + parts[n - 1];
    }
  }
  return parts;
}

/** Width of the widest line. */
export const widest = (lines: string[], px: number, measure: Measure = estimateWidth, mono = false) => Math.max(0, ...lines.map((l) => measure(l, px, mono)));

/** A name that looks like a path or file name (no spaces, a slash or an extension): set in mono. */
export const looksLikePath = (s: string) => /[/\\]|\.[a-z0-9]{1,5}$/i.test(s) && !/\s/.test(s);
