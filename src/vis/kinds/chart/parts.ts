/**
 * `vis chart` `type: parts`: one bar split into its rows, in order, with a legend row per part
 * (swatch, label, value, share). With `of:` the bar is that capacity and the unused rest is a
 * "Free" part, drawn as the empty track. HTML, so the facts here are the text and the colours; the
 * height repeats parts.css' fixed metrics (keep the two in step). Pure: no DOM.
 */

import { emphasisMap } from "../../core/emphasis";
import type { Tone } from "../../core/grammar";
import { wrap } from "../../core/text";
import { htmlMeasure, type WeightedMeasure } from "../tree/measure";
import type { ChartSpec } from "./parse";
import { valueLabel } from "./scale";

export interface Part {
  /** Row index, or -1 for the free rest. */
  row: number;
  label: string;
  value: number;
  /** Share of the whole (the capacity, else the total), 0…1. */
  share: number;
  valueText: string;
  pctText: string;
  /** Colour class: the row's tone, else the next series colour no tone uses; the free rest has none. */
  color: string;
}

/** 0 → 0%, under 1 → <1%, under 10 → one decimal, else whole. */
export function pctText(share: number): string {
  const p = share * 100;
  if (p === 0) return "0%";
  if (p < 1) return "<1%";
  if (p < 10) return `${Number(p.toFixed(1))}%`;
  return `${Math.round(p)}%`;
}

/** One style for every number in the figure: once the whole reaches 10k, thousands read as k too (9k beside 14k, not 9000). */
const numText = (v: number, big: boolean) => (big && v >= 1000 && v < 1e4 ? `${Number((v / 1000).toPrecision(3))}k` : valueLabel(v));

/** The series colour (chart.css' vis-chart-s<n>) each tone's colour matches. */
const TONE_SERIES: Record<Tone, number> = { accent: 0, warn: 1, ok: 2, error: 3, info: 4, muted: 5 };

const unitText = (unit?: string) => (unit ? (unit === "%" ? "%" : ` ${unit}`) : "");

export function partsOf(spec: ChartSpec): { parts: Part[]; total: number; whole: number; head: { value: string; rest: string } } {
  const total = spec.rows.reduce((a, r) => a + r.values[0]!, 0);
  const whole = spec.of ?? total;
  const big = whole >= 1e4;
  // Untoned parts take the series colours no tone in this chart already shows, in turn.
  const taken = new Set(spec.rows.map((r) => (r.tone ? TONE_SERIES[r.tone] : -1)));
  const free = [0, 1, 2, 3, 4, 5].filter((s) => !taken.has(s));
  const palette = free.length ? free : [0, 1, 2, 3, 4, 5];
  let series = 0;
  const parts: Part[] = spec.rows.map((r, i) => {
    const v = r.values[0]!;
    return { row: i, label: r.label, value: v, share: v / whole, valueText: numText(v, big), pctText: pctText(v / whole), color: r.tone ? `vis-chart-toned vis-tone-${r.tone}` : `vis-chart-s${palette[series++ % palette.length]}` };
  });
  if (spec.of !== undefined && spec.of > total) {
    const free = spec.of - total;
    parts.push({ row: -1, label: "Free", value: free, share: free / whole, valueText: numText(free, big), pctText: pctText(free / whole), color: "" });
  }
  const unit = unitText(spec.unit);
  const head =
    spec.of !== undefined
      ? { value: numText(total, big), rest: ` of ${numText(spec.of, big)}${unit} · ${pctText(total / spec.of)}` }
      : { value: `${numText(total, big)}${unit}`, rest: " in total" };
  return { parts, total, whole, head };
}

/** parts.css' metrics (tokens: fs-caption 12.5, fs-mono 12.5, space-1 4, space-2 8). */
export const PARTS_CSS = { line: 18, gap: 8, bar: 20, rowPad: 6, swatch: 12, colGap: 8, rowPadX: 12, badge: 18 + 4, px: 12.5 };

/**
 * The height the parts figure renders at in a `.vis-body` whose content box is `width` px wide:
 * the head line(s), the bar, and the legend, whose labels wrap in what the swatch, value and share
 * columns leave them.
 */
export function partsHeight(spec: ChartSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const { parts, head } = partsOf(spec);
  const C = PARTS_CSS;
  const mono = measure(400);
  const em = emphasisMap(spec);
  const headLines = wrap(head.value + head.rest, Math.max(1, width), 99, C.px, mono, true).length;
  const valueW = Math.max(...parts.map((p) => mono(p.valueText, C.px, true)));
  const pctW = Math.max(...parts.map((p) => mono(p.pctText, C.px, true)));
  const labelW = Math.max(40, width - C.rowPadX - C.swatch - valueW - pctW - 3 * C.colGap);
  let rows = 0;
  for (const p of parts) {
    const e = p.row >= 0 ? em.get(String(p.row)) : undefined;
    const m = measure(e ? 600 : 400);
    // A badge sits inline before the label's first word: it narrows only the first line.
    const lines = e?.n
      ? wrap(`\u0000 ${p.label}`, labelW, 99, C.px, (t, px) => (t.startsWith("\u0000") ? C.badge + m(t.slice(2), px) : m(t, px))).length
      : wrap(p.label, labelW, 99, C.px, m).length;
    rows += lines * C.line + C.rowPad;
  }
  return headLines * C.line + C.gap + C.bar + C.gap + rows;
}
