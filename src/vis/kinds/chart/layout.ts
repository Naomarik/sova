/**
 * `vis chart` geometry, laid out at the width the chart is given. Pure (a measure function stands in
 * for the browser's fonts), so the tests can check what matters: nothing leaves the frame, labels
 * don't collide, and the same input always draws the same picture.
 *
 * Modes: `column` (vertical bars, grouped or stacked), `hbar` (the same, sideways: chosen when the
 * category labels can't sit under their bars), `line` (categories along x) and `scatter` (x and y
 * both numeric). Every marked row gets a band behind it (a ring around a scatter point) and, when
 * its mark has a note, a badge position.
 */

import { wrap, type Measure } from "../../core/text";
import type { ChartSpec } from "./parse";
import { linearAxis, logAxis, tickCount, valueLabel, type Axis } from "./scale";

export const FONT = { tick: 11, cat: 11, hcat: 12, value: 11, point: 11 };
const LH = 13;
const BADGE_R = 9;

export type ChartMode = "column" | "hbar" | "line" | "scatter";
export interface Tick { pos: number; label: string; zero: boolean; minor: boolean }
export interface CatLabel { row: number; x: number; y: number; lines: string[]; anchor: "start" | "middle" | "end" }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Bar extends Rect { row: number; series: number; title: string }
export interface ValueText { row: number; x: number; y: number; text: string; anchor: "start" | "middle" | "end"; inside?: boolean }
export interface Point { row: number; series: number; x: number; y: number; title: string }
export interface Badge { row: number; x: number; y: number }

export interface ChartLayout {
  W: number;
  H: number;
  mode: ChartMode;
  plot: { x0: number; y0: number; x1: number; y1: number };
  /** Horizontal grid lines, labelled on the left (value axis of column/line, y of scatter). */
  yTicks: Tick[];
  /** Vertical grid lines, labelled underneath (value axis of hbar, x of scatter). */
  xTicks: Tick[];
  cats: CatLabel[];
  bands: (Rect & { row: number })[];
  bars: Bar[];
  values: ValueText[];
  paths: { series: number; d: string }[];
  points: Point[];
  rings: { row: number; x: number; y: number }[];
  badges: Badge[];
}

const unitSuffix = (unit?: string) => (unit ? (unit === "%" ? "%" : ` ${unit}`) : "");
export const fmtValue = (v: number, unit?: string) => `${valueLabel(v)}${unitSuffix(unit)}`;

const markedRows = (spec: ChartSpec) => new Map((spec.emphasis ?? []).map((e) => [Number(e.key), e]));
const seriesCount = (spec: ChartSpec) => Math.max(1, spec.series.length);
const titleOf = (spec: ChartSpec, row: number, s: number, v: number) => `${spec.series[s] ? `${spec.series[s]}, ` : ""}${spec.rows[row]!.label}: ${fmtValue(v, spec.unit)}`;
const sum = (vals: (number | null)[]) => vals.reduce<number>((a, v) => a + (v ?? 0), 0);

/** The mode a chart draws in at width W: bars go sideways when their labels can't sit under them. */
export function chartMode(spec: ChartSpec, W: number, measure: Measure): ChartMode {
  if (spec.type === "line" || spec.type === "scatter") return spec.type;
  const band = (W - 48) / spec.rows.length;
  if (band < 24 + (seriesCount(spec) > 1 && spec.type === "bar" ? 8 * seriesCount(spec) : 0)) return "hbar";
  // Every word must fit its band, and every label in two lines.
  for (const r of spec.rows) {
    if (r.label.split(/\s+/).some((w) => measure(w, FONT.cat) > band - 4)) return "hbar";
    const lines = wrap(r.label, band - 4, 2, FONT.cat, measure);
    if (lines[lines.length - 1]!.endsWith("…") && !r.label.endsWith("…")) return "hbar";
  }
  return "column";
}

export function layoutChart(spec: ChartSpec, W: number, measure: Measure): ChartLayout {
  const mode = chartMode(spec, W, measure);
  const out = mode === "hbar" ? layoutHBars(spec, W, measure) : mode === "scatter" ? layoutScatter(spec, W, measure) : layoutColumns(spec, W, measure, mode);
  // A badge wins over any other row's value label it would cover.
  const badges = out.badges.map((b) => ({ row: b.row, x: b.x - BADGE_R, y: b.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 }));
  out.values = out.values.filter((v) => !badges.some((b) => b.row !== v.row && overlaps(b, textBox(v, measure))));
  return out;
}

/** The box a value label covers. */
export function textBox(v: ValueText, measure: Measure): Rect {
  const w = measure(v.text, FONT.value);
  return { x: v.anchor === "start" ? v.x : v.anchor === "end" ? v.x - w : v.x - w / 2, y: v.y - 6.5, w, h: 13 };
}

function emptyLayout(W: number, mode: ChartMode): ChartLayout {
  return { W, H: 0, mode, plot: { x0: 0, y0: 0, x1: 0, y1: 0 }, yTicks: [], xTicks: [], cats: [], bands: [], bars: [], values: [], paths: [], points: [], rings: [], badges: [] };
}

/** The value axis for bars and lines: stacks by their totals, log when asked (never for stacks). */
function valueAxis(spec: ChartSpec, from: number, to: number, stacked: boolean, bars: boolean): Axis {
  const vals = spec.rows.flatMap((r) => {
    if (!stacked) return r.values.filter((v): v is number => v !== null);
    return [sum(r.values)];
  });
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (spec.scale === "log") return logAxis(lo, hi, from, to, tickCount(to - from, 36));
  return linearAxis(lo, hi, from, to, { zero: bars, count: tickCount(to - from, 48) });
}

const ticksOf = (axis: Axis): Tick[] => [
  ...axis.minor.map((v) => ({ pos: axis.at(v), label: "", zero: false, minor: true })),
  ...axis.ticks.map((v) => ({ pos: axis.at(v), label: axis.fmt(v), zero: v === 0 && axis.min < 0, minor: false })),
];

/** Where a bar starts: 0 on a linear axis, the axis floor on a log one. */
const base = (axis: Axis) => (axis.log ? axis.min : Math.max(axis.min, Math.min(axis.max, 0)));

function layoutColumns(spec: ChartSpec, W: number, measure: Measure, mode: "column" | "line"): ChartLayout {
  const out = emptyLayout(W, mode);
  const marks = markedRows(spec);
  const stacked = spec.type === "stacked";
  const n = stacked ? 1 : seriesCount(spec);
  const rows = spec.rows.length;
  const plotH = Math.round(Math.min(240, Math.max(140, W * 0.42)));
  // Room above the plot for value labels, and for badges where a line chart puts them.
  const top = 18 + (marks.size ? 4 : 0) + (mode === "line" && seriesCount(spec) > 1 && [...marks.values()].some((e) => e.n) ? 6 : 0);
  // Tick labels decide the left margin, so measure them on a provisional axis first.
  const probe = valueAxis(spec, top + plotH, top, stacked, mode === "column");
  const left = Math.ceil(Math.max(...probe.ticks.map((t) => measure(probe.fmt(t), FONT.tick)))) + 10;
  const right = mode === "line" ? 10 : 6;
  const band = (W - left - right) / rows;
  // Category labels: two lines under a bar; one line under a line chart's point, every k-th.
  // A line chart's labels stay whole: when they can't all fit, every k-th one is shown.
  const every = mode === "line" ? Math.max(1, Math.ceil((Math.max(...spec.rows.map((r) => measure(r.label, FONT.cat))) + 10) / band)) : 1;
  const catLines = spec.rows.map((r) => wrap(r.label, mode === "line" ? Math.max(24, band * every - 10) : Math.max(24, band - 4), mode === "line" ? 1 : 2, FONT.cat, measure));
  const lineCount = Math.max(...catLines.map((l) => l.length));
  const bottom = 8 + lineCount * LH;
  const y0 = top;
  const y1 = top + plotH;
  const axis = valueAxis(spec, y1, y0, stacked, mode === "column");
  out.plot = { x0: left, y0, x1: W - right, y1 };
  out.yTicks = ticksOf(axis);
  out.H = y1 + bottom;
  const cx = (i: number) => left + band * (i + 0.5);
  const zero = axis.at(base(axis));

  spec.rows.forEach((row, i) => {
    const e = marks.get(i);
    if (i % every === 0) out.cats.push({ row: i, x: cx(i), y: y1 + 8 + LH / 2, lines: catLines[i]!, anchor: "middle" });
    if (e) out.bands.push({ row: i, x: cx(i) - band / 2 + 1, y: y0 - (e.n ? 4 : 0), w: band - 2, h: y1 - y0 + 6 + lineCount * LH + (e.n ? 4 : 0) });
  });

  if (mode === "column") {
    const bw = Math.min(stacked ? 56 : 44, (band * (n > 1 ? 0.8 : 0.66)) / n);
    const valueFits = (text: string) => measure(text, FONT.value) <= (n > 1 ? bw + 2 : Math.min(band - 4, bw + 24));
    spec.rows.forEach((row, i) => {
      const gx = cx(i) - (bw * n) / 2;
      let acc = 0;
      let topY = zero;
      row.values.forEach((v, s) => {
        if (v === null) return;
        const from = stacked ? acc : 0;
        const to = stacked ? (acc += v) : v;
        const a = axis.at(Math.max(axis.min, stacked || !axis.log ? from : axis.min));
        const b = axis.at(to);
        const x = stacked ? cx(i) - bw / 2 : gx + bw * s;
        const bar: Bar = { row: i, series: s, x: x + (n > 1 ? 1 : 0), y: Math.min(a, b), w: Math.max(1, bw - (n > 1 ? 2 : 0)), h: Math.max(v === 0 ? 0 : 1, Math.abs(a - b)), title: titleOf(spec, i, s, v) };
        out.bars.push(bar);
        topY = Math.min(topY, bar.y);
        if (stacked) {
          // A segment names its own value when there's room inside it.
          const text = valueLabel(v);
          if (bar.h >= 15 && measure(text, FONT.value) <= bar.w - 6 && row.values.filter((x) => x !== null).length > 1) out.values.push({ row: i, x: bar.x + bar.w / 2, y: bar.y + bar.h / 2, text, anchor: "middle", inside: true });
        } else {
          const text = valueLabel(v);
          if (valueFits(text) && rows * n <= 24) out.values.push({ row: i, x: bar.x + bar.w / 2, y: v < 0 ? bar.y + bar.h + 8 : bar.y - 7, text, anchor: "middle" });
        }
      });
      if (stacked) {
        const text = valueLabel(sum(row.values));
        if (valueFits(text)) out.values.push({ row: i, x: cx(i), y: topY - 7, text, anchor: "middle" });
      }
      // The badge sits right of the row's top value label (or of the bars), clear of both.
      const e = marks.get(i);
      if (e?.n) {
        const labels = out.values.filter((v) => v.row === i && !v.inside).map((v) => textBox(v, measure));
        const right = Math.max(cx(i) + (bw * n) / 2, ...labels.map((b) => b.x + b.w));
        const y = Math.max(BADGE_R, Math.min(topY, zero) - (labels.length ? 7 : 12));
        const x = right + 3 + BADGE_R;
        out.badges.push(x <= W - BADGE_R ? { row: i, x, y } : { row: i, x: Math.min(W - BADGE_R, cx(i) + (bw * n) / 2), y: Math.max(BADGE_R, y - 18) });
      }
    });
  } else {
    // Lines: a path per series, broken at gaps; single series label their points when they fit.
    const nSeries = seriesCount(spec);
    for (let s = 0; s < nSeries; s++) {
      let d = "";
      let pen = false;
      spec.rows.forEach((row, i) => {
        const v = row.values[s];
        if (v === null || v === undefined) {
          pen = false;
          return;
        }
        const p = { x: cx(i), y: axis.at(v) };
        d += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
        pen = true;
        out.points.push({ row: i, series: s, ...p, title: titleOf(spec, i, s, v) });
      });
      out.paths.push({ series: s, d: d.trim() });
    }
    const labelAll = nSeries === 1 && spec.rows.every((r) => r.values[0] === null || measure(valueLabel(r.values[0]!), FONT.value) <= band - 4);
    for (const p of out.points) {
      const e = marks.get(p.row);
      const v = spec.rows[p.row]!.values[p.series]!;
      const text = valueLabel(v);
      const labelled = nSeries === 1 && (labelAll || !!e);
      // A ring pushes its point's label up; the badge sits right of the label, or of the ring.
      if (labelled) out.values.push({ row: p.row, x: p.x, y: p.y - (e ? 16 : 11), text, anchor: "middle" });
      if (e) out.rings.push({ row: p.row, x: p.x, y: p.y });
      // One series: the badge follows its point's label. Several: it goes to the band's top corner, off the lines.
      if (e?.n && nSeries === 1) {
        const bx = labelled ? p.x + measure(text, FONT.value) / 2 + 4 + BADGE_R : p.x + 13;
        out.badges.push({ row: p.row, x: Math.min(W - BADGE_R, bx), y: Math.max(BADGE_R, labelled ? p.y - 16 : p.y - 13) });
      }
    }
    if (nSeries > 1)
      for (const b of out.bands) if (marks.get(b.row)?.n) out.badges.push({ row: b.row, x: Math.min(W - BADGE_R, b.x + b.w / 2 + 12), y: y0 - 13 });
  }
  return out;
}


function layoutHBars(spec: ChartSpec, W: number, measure: Measure): ChartLayout {
  const out = emptyLayout(W, "hbar");
  const marks = markedRows(spec);
  const stacked = spec.type === "stacked";
  const n = stacked ? 1 : seriesCount(spec);
  const rowH = n === 1 ? 30 : n * 12 + 14;
  const barH = n === 1 ? 18 : 10;
  const labelMax = Math.round(W * 0.36);
  const labels = spec.rows.map((r) => wrap(r.label, labelMax, 2, FONT.hcat, measure));
  const labelW = Math.ceil(Math.min(labelMax, Math.max(...labels.map((l) => Math.max(...l.map((s) => measure(s, FONT.hcat)))))));
  const texts = spec.rows.flatMap((r) => (stacked ? [valueLabel(sum(r.values))] : r.values.map((v) => (v === null ? "" : valueLabel(v)))));
  const valueRoom = Math.ceil(Math.max(...texts.map((t) => measure(t, FONT.value)))) + 8;
  const anyNeg = spec.rows.some((r) => r.values.some((v) => v !== null && v < 0));
  const badgeRoom = [...marks.values()].some((e) => e.n) ? BADGE_R * 2 + 4 : 0;
  const x0 = 8 + labelW + 10 + (anyNeg ? valueRoom : 0);
  const x1 = W - valueRoom - badgeRoom - 2;
  const axis = valueAxis(spec, x0, x1, stacked, true);
  const top = 4;
  const y1 = top + spec.rows.length * rowH;
  out.plot = { x0, y0: top, x1, y1 };
  out.xTicks = ticksOf(axis);
  out.H = y1 + 22;
  const zero = axis.at(base(axis));
  spec.rows.forEach((row, i) => {
    const y = top + i * rowH;
    const e = marks.get(i);
    out.cats.push({ row: i, x: 8 + labelW, y: y + rowH / 2 - ((labels[i]!.length - 1) * LH) / 2, lines: labels[i]!, anchor: "end" });
    if (e) out.bands.push({ row: i, x: 0, y: y + 1, w: W, h: rowH - 2 });
    let acc = 0;
    let end = zero;
    let lo = zero;
    row.values.forEach((v, s) => {
      if (v === null) return;
      const from = stacked ? acc : 0;
      const to = stacked ? (acc += v) : v;
      const a = axis.at(Math.max(axis.min, stacked || !axis.log ? from : axis.min));
      const b = axis.at(to);
      const by = n === 1 ? y + (rowH - barH) / 2 : y + 7 + s * 12;
      const bar: Bar = { row: i, series: s, x: Math.min(a, b), y: by, w: Math.max(v === 0 ? 0 : 1, Math.abs(a - b)), h: barH, title: titleOf(spec, i, s, v) };
      out.bars.push(bar);
      end = Math.max(end, bar.x + bar.w);
      lo = Math.min(lo, bar.x);
      if (stacked) {
        const text = valueLabel(v);
        if (measure(text, FONT.value) <= bar.w - 8 && row.values.filter((x) => x !== null).length > 1) out.values.push({ row: i, x: bar.x + bar.w / 2, y: by + barH / 2, text, anchor: "middle", inside: true });
      } else if (v < 0) out.values.push({ row: i, x: bar.x - 5, y: by + barH / 2, text: valueLabel(v), anchor: "end" });
      else out.values.push({ row: i, x: bar.x + bar.w + 5, y: by + barH / 2, text: valueLabel(v), anchor: "start" });
    });
    if (stacked) out.values.push({ row: i, x: end + 5, y: y + rowH / 2, text: valueLabel(sum(row.values)), anchor: "start" });
    if (e?.n) {
      const texts = out.values.filter((t) => t.row === i && !t.inside && t.anchor === "start");
      const right = Math.max(end, ...texts.map((t) => t.x + measure(t.text, FONT.value)));
      out.badges.push({ row: i, x: Math.min(W - BADGE_R - 1, right + 6 + BADGE_R), y: y + rowH / 2 });
    }
  });
  return out;
}

/** Scatter: both axes numeric; `scale: log` makes both logarithmic. Points are labelled where they fit. */
function layoutScatter(spec: ChartSpec, W: number, measure: Measure): ChartLayout {
  const out = emptyLayout(W, "scatter");
  const marks = markedRows(spec);
  const xs = spec.rows.map((r) => r.values[0]!);
  const ys = spec.rows.map((r) => r.values[1]!);
  const log = spec.scale === "log";
  const plotH = Math.round(Math.min(300, Math.max(180, W * 0.55)));
  const top = 14;
  // Linear axes get a little room past the data, so no point sits on the frame.
  const mk = (vals: number[], from: number, to: number, gap: number) => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (log) return logAxis(lo, hi, from, to, tickCount(to - from, gap));
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.04;
    return linearAxis(lo < 0 || lo - pad >= 0 ? lo - pad : 0, hi + pad, from, to, { count: tickCount(to - from, gap) });
  };
  const probe = mk(ys, top + plotH, top, 40);
  const left = Math.ceil(Math.max(...probe.ticks.map((t) => measure(probe.fmt(t), FONT.tick)))) + 10;
  const right = 12;
  const y = mk(ys, top + plotH, top, 40);
  let x = mk(xs, left, W - right, 70);
  // Tick labels along x must not touch: thin the ticks until they fit.
  const xw = Math.max(...x.ticks.map((t) => measure(x.fmt(t), FONT.tick)));
  if (x.ticks.length > 1 && Math.abs(x.at(x.ticks[1]!) - x.at(x.ticks[0]!)) < xw + 10) x = mk(xs, left, W - right, xw * 2 + 30);
  out.plot = { x0: left, y0: top, x1: W - right, y1: top + plotH };
  out.yTicks = ticksOf(y);
  out.xTicks = ticksOf(x);
  out.H = top + plotH + 22;
  spec.rows.forEach((r, i) => {
    out.points.push({ row: i, series: 0, x: x.at(r.values[0]!), y: y.at(r.values[1]!), title: `${r.label}: ${x.fmt(r.values[0]!)}, ${fmtValue(r.values[1]!, spec.unit)}` });
  });
  for (const p of out.points) {
    const e = marks.get(p.row);
    if (!e) continue;
    out.rings.push({ row: p.row, x: p.x, y: p.y });
    if (e.n) out.badges.push({ row: p.row, x: Math.min(W - BADGE_R, p.x + 11), y: Math.max(BADGE_R, p.y - 12) });
  }
  // Labels: marked points first, then in order; each tries right, left, above, below of its point
  // and is dropped if every side would hit another label, a point, or the frame.
  const taken: Rect[] = [
    ...out.points.map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })),
    ...out.badges.map((b) => ({ x: b.x - BADGE_R, y: b.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 })),
  ];
  const order = [...out.points].sort((a, b) => (marks.has(a.row) ? 0 : 1) - (marks.has(b.row) ? 0 : 1) || a.row - b.row);
  const budget = marks.size + Math.max(0, 16 - marks.size);
  let placed = 0;
  for (const p of order) {
    if (placed >= budget) break;
    const text = spec.rows[p.row]!.label;
    const w = measure(text, FONT.point);
    const h = 13;
    const gap = marks.has(p.row) ? 14 : 7; // clear of a mark's ring (r 8 + stroke) by about 5px
    const tries: [number, number, "start" | "end" | "middle"][] = [
      [p.x + gap, p.y, "start"],
      [p.x - gap, p.y, "end"],
      [p.x, p.y - gap - 5, "middle"],
      [p.x, p.y + gap + 5, "middle"],
    ];
    for (const [tx, ty, anchor] of tries) {
      const box: Rect = { x: anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2, y: ty - h / 2, w, h };
      if (box.x < out.plot.x0 + 2 || box.x + box.w > W || box.y < 0 || box.y + box.h > out.plot.y1 - 2) continue;
      if (taken.some((t) => overlaps(t, box))) continue;
      taken.push(box);
      out.values.push({ row: p.row, x: tx, y: ty, text, anchor });
      placed++;
      break;
    }
  }
  return out;
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
