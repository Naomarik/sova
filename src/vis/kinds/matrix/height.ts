/**
 * The height MatrixView renders at a given body width, from matrix.css' metrics (tokens: fs-caption
 * 12.5 × lh-caption 1.45; space-1..3 4/8/12; 1px rules). The table has a fixed layout with the
 * column widths from matrixColumns, so its wrapping is computable. At a body width of MATRIX_NARROW
 * or less (matrix.css' own container query), 3+ columns become one card per row. Pure; change it
 * with matrix.css.
 */

import { estimateWidth, wrap, type Measure } from "../../core/text";
import { TONE_ICON } from "../../icons";
import type { MatrixCell, MatrixSpec } from "./parse";

const PX = 12.5;
const LH = 12.5 * 1.45;
const GLYPH = 16 + 4;
const BADGE = 18 + 4;
/** A toned cell's chip (matrix.css): 4px padding each side, plus a 14px icon and 4px gap for the tones that have one. */
const CHIP = (c: MatrixCell) => (!c.tone || !c.text ? 0 : (c.tone === "muted" ? 0 : 8) + (TONE_ICON[c.tone] ? 14 + 4 : 0));
const PAD_X = 12 * 2;
const PAD_Y = 8 * 2;
/** matrix.css' `@container vis-matrix (max-width: 404px)`: the wrap is as wide as the body. */
export const MATRIX_NARROW = 404;

/**
 * Text widths at the weight each part is set in (cells 400, row labels 530, headers 600: the fw tokens): core's
 * canvasMeasure measures at 530, which wraps plain cell text a word early. Canvas in the browser,
 * the estimate table elsewhere.
 */
let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
export const measureAt =
  (weight: number): Measure =>
  (text, px) => {
    const key = `${weight}|${px}|${text}`;
    const hit = widths.get(key);
    if (hit !== undefined) return hit;
    if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (!ctx) return estimateWidth(text, px);
    ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    if (widths.size > 4000) widths.clear();
    widths.set(key, w);
    return w;
  };
/** Drop cached widths: the View calls it when a web font finishes loading. */
export const clearWidths = () => widths.clear();
const CELL = measureAt(400);
const LABEL = measureAt(530);
const HEAD = measureAt(600);

const cellText = (c: MatrixCell) => c.text ?? (c.mark ? "" : "—");
/** An accent chip is set semibold (matrix.css). */
const cellMeasure = (c: MatrixCell): Measure => (c.tone === "accent" && c.text ? HEAD : CELL);
const cellLead = (c: MatrixCell) => (c.mark ? GLYPH : 0) + CHIP(c);

/**
 * Column widths in px (padding included) for a body `width` px wide; the View sets them on a
 * fixed-layout table, so the browser wraps exactly as estimateHeight does. Every column first gets
 * the least it can take, then columns grow toward not breaking words, then toward not wrapping,
 * each in proportion to what it still needs. Only when even the least doesn't fit is the table
 * wider than the body (it scrolls).
 */
export function matrixColumns(spec: MatrixSpec, width: number): number[] {
  const em = new Set((spec.emphasis ?? []).filter((e) => e.n).map((e) => e.key));
  // A word longer than `cap` may break anywhere (overflow-wrap: anywhere), so it doesn't widen its column.
  const words = (s: string, m: Measure, cap: number) => Math.min(cap, Math.max(0, ...s.split(/\s+/).map((w) => m(w, PX))));
  // Three widths a column can have: hard (below which it can't go: a header on one line, a glyph
  // and a few letters, a criterion at 4em), soft (no word broken) and max (no line wrapped).
  const cols = [
    {
      hard: PX * 4,
      soft: Math.max(PX * 5, ...spec.rows.map((r, i) => words(r.label, LABEL, 120) + (em.has(String(i)) ? BADGE : 0))),
      max: Math.max(PX * 5, ...spec.rows.map((r, i) => LABEL(r.label, PX) + (em.has(String(i)) ? BADGE : 0))),
    },
    ...spec.columns.map((name, ci) => {
      const head = HEAD(name, PX) + (em.has(`c${ci}`) ? BADGE : 0);
      return {
        hard: Math.max(head, ...spec.rows.map((r) => cellLead(r.cells[ci]!) + (cellText(r.cells[ci]!) ? PX * 3 : CELL("—", PX)))),
        soft: Math.max(head, ...spec.rows.map((r) => cellLead(r.cells[ci]!) + words(cellText(r.cells[ci]!), cellMeasure(r.cells[ci]!), 90))),
        max: Math.max(head, ...spec.rows.map((r) => cellLead(r.cells[ci]!) + cellMeasure(r.cells[ci]!)(cellText(r.cells[ci]!), PX))),
      };
    }),
  ].map((c) => ({ hard: Math.ceil(c.hard) + PAD_X, soft: Math.ceil(Math.max(c.hard, c.soft)) + PAD_X, max: Math.ceil(Math.max(c.hard, c.soft, c.max)) + PAD_X }));
  const sum = (k: "hard" | "soft" | "max") => cols.reduce((a, c) => a + c[k], 0);
  const grow = (from: "hard" | "soft", to: "soft" | "max") => {
    const t = (width - sum(from)) / Math.max(1, sum(to) - sum(from));
    return cols.map((c) => c[from] + (c[to] - c[from]) * t);
  };
  if (sum("hard") >= width) return cols.map((c) => c.hard);
  if (sum("soft") >= width) return grow("hard", "soft");
  if (sum("max") >= width) return grow("soft", "max");
  return cols.map((c) => c.max + ((width - sum("max")) * c.max) / sum("max"));
}

export function estimateHeight(spec: MatrixSpec, width: number): number {
  const em = new Set((spec.emphasis ?? []).filter((e) => e.n).map((e) => e.key));
  const lines = (s: string, w: number, measure: Measure = CELL) => (s ? wrap(s, Math.max(8, w), 99, PX, measure).length : 1);
  // A badge sits inline before a header's first word: it narrows only the first line.
  const badged = (s: string, w: number, measure: Measure, badge: boolean) => (badge ? lines(`\u0000 ${s}`, w, (t, px) => (t.startsWith("\u0000") ? BADGE + measure(t.slice(2), px) : measure(t, px))) : lines(s, w, measure));
  if (width <= MATRIX_NARROW && spec.columns.length >= 3) {
    // Cards: th (4px/8px padding), then a grid row per cell: column name | cell.
    const inner = width - 16;
    const nameW = Math.max(12.5 * 6, inner * 0.38);
    const cellW = inner - nameW - 8;
    let h = 0;
    spec.rows.forEach((r, i) => {
      h += 16 + (i < spec.rows.length - 1 ? 1 : 0);
      h += 8 + badged(r.label, inner, LABEL, em.has(String(i))) * LH;
      r.cells.forEach((c, ci) => {
        h += 8 + Math.max(lines(spec.columns[ci]!, nameW), lines(cellText(c), cellW - cellLead(c), cellMeasure(c))) * LH;
      });
    });
    return h;
  }
  const w = matrixColumns(spec, width).map((px) => px - PAD_X);
  const head = Math.max(1, ...spec.columns.map((c, ci) => badged(c, w[ci + 1]!, HEAD, em.has(`c${ci}`))));
  let h = head * LH + PAD_Y + 1;
  spec.rows.forEach((r, i) => {
    const label = badged(r.label, w[0]!, LABEL, em.has(String(i)));
    const cells = r.cells.map((c, ci) => lines(cellText(c), w[ci + 1]! - cellLead(c), cellMeasure(c)));
    h += Math.max(label, ...cells) * LH + PAD_Y + (i < spec.rows.length - 1 ? 1 : 0);
  });
  return h;
}
