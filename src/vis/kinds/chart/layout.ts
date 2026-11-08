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

import { canvasMeasure, wrap, type Measure } from "../../core/text";
import type { ChartSpec } from "./parse";
import { partsHeight } from "./parts";
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
  /** Thin lines from a scatter point to a label that had to sit further out. */
  leaders: { x1: number; y1: number; x2: number; y2: number }[];
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
  // A badge wins over any other unmarked row's value label it would cover.
  const badges = out.badges.map((b) => ({ row: b.row, x: b.x - BADGE_R, y: b.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 }));
  // A marked row's own label always stays: badges are placed clear of those.
  const marks = markedRows(spec);
  out.values = out.values.filter((v) => marks.has(v.row) || !badges.some((b) => b.row !== v.row && overlaps(b, textBox(v, measure))));
  return out;
}

/** The box a value label covers. */
export function textBox(v: ValueText, measure: Measure): Rect {
  const w = measure(v.text, FONT.value);
  return { x: v.anchor === "start" ? v.x : v.anchor === "end" ? v.x - w : v.x - w / 2, y: v.y - 6.5, w, h: 13 };
}

function emptyLayout(W: number, mode: ChartMode): ChartLayout {
  return { W, H: 0, mode, plot: { x0: 0, y0: 0, x1: 0, y1: 0 }, yTicks: [], xTicks: [], cats: [], bands: [], bars: [], values: [], paths: [], points: [], rings: [], leaders: [], badges: [] };
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

/** Room kept between two value labels side by side, so they never read as one number. */
const VALUE_GAP = 4;
/** Room kept between two category labels along a line chart's axis. */
const CAT_GAP = 10;

/** Two value labels too close to read apart: their boxes overlap, or stand closer than VALUE_GAP side by side. */
const crowded = (a: Rect, b: Rect) => a.x < b.x + b.w + VALUE_GAP && b.x < a.x + a.w + VALUE_GAP && a.y < b.y + b.h && b.y < a.y + a.h;

/** The box a category label covers. */
export function catBox(c: CatLabel, mode: ChartMode, measure: Measure): Rect {
  const w = Math.max(...c.lines.map((l) => measure(l, mode === "hbar" ? FONT.hcat : FONT.cat)));
  return { x: c.anchor === "start" ? c.x : c.anchor === "end" ? c.x - w : c.x - w / 2, y: c.y - LH / 2, w, h: c.lines.length * LH };
}

/** A value label a layout would like to draw; a marked row's are always drawn. `down`: it hangs below a negative bar. */
interface Wanted extends ValueText {
  marked: boolean;
  down: boolean;
}

/**
 * The value labels drawn, and how far the highest would rise above the frame. A marked row's labels
 * all stay: one that would touch another marked label steps up past it (down, below a negative
 * bar), over its own bar. Any other label that would touch a drawn one is dropped.
 */
function settleValues(wanted: Wanted[], measure: Measure): { values: ValueText[]; need: number } {
  const placed: ValueText[] = [];
  const boxes: Rect[] = [];
  const marked = wanted.filter((w) => w.marked);
  // Nearest their bars first: the lowest of those above bars, the highest of those below.
  marked.sort((a, b) => (a.down === b.down ? (a.down ? a.y - b.y : b.y - a.y) : a.down ? 1 : -1));
  for (const w of marked) {
    const v: ValueText = { row: w.row, x: w.x, y: w.y, text: w.text, anchor: w.anchor };
    for (let tries = 0; tries <= boxes.length; tries++) {
      const box = textBox(v, measure);
      const hit = boxes.filter((b) => crowded(b, box));
      if (!hit.length) break;
      v.y = w.down ? Math.max(...hit.map((b) => b.y + b.h)) + 1 + 6.5 : Math.min(...hit.map((b) => b.y)) - 1 - 6.5;
    }
    placed.push(v);
    boxes.push(textBox(v, measure));
  }
  for (const w of wanted) {
    if (w.marked) continue;
    const v: ValueText = { row: w.row, x: w.x, y: w.y, text: w.text, anchor: w.anchor };
    const box = textBox(v, measure);
    if (boxes.some((b) => crowded(b, box))) continue;
    placed.push(v);
    boxes.push(box);
  }
  // Half a pixel past the frame is nothing to make room for.
  const need = Math.max(0, ...boxes.map((b) => -b.y - 0.5));
  // Source order, so the same input always lists its labels the same way.
  const order = new Map(wanted.map((w, i) => [`${w.row}|${w.x}`, i]));
  placed.sort((a, b) => order.get(`${a.row}|${a.x}`)! - order.get(`${b.row}|${b.x}`)!);
  return { values: placed, need };
}

/**
 * Where a marked row's numbered badge goes, by its own bar or point: right of the row's labels,
 * else above them, else left of them. It never covers another marked row's label or another
 * badge; it prefers a spot that covers no label at all (any other it covers is dropped later).
 * `need` is the room above the frame the spot above would take, when nothing else fits.
 */
function placeBadge(row: number, cx: number, own: Rect[], body: Rect[], gap: number, W: number, values: ValueText[], marks: Map<number, unknown>, badges: Badge[], measure: Measure): { badge: Badge; need: number } {
  const all = [...own, ...body];
  const top = Math.min(...all.map((r) => r.y));
  // Level with the row's top label over its bars (or, with none there, a little above the bars).
  const bodyTop = Math.min(...body.map((r) => r.y));
  const over = own.filter((r) => r.y < bodyTop);
  const yMid = Math.max(BADGE_R, over.length ? Math.min(...over.map((r) => r.y)) + 6.5 : bodyTop - (own.length ? 7 : 12));
  // Beside the row at that height: past whatever of its labels and bars stands within the badge's reach.
  const level = all.filter((r) => r.y < yMid + BADGE_R + 1 && r.y + r.h > yMid - BADGE_R - 1);
  const reach = level.length ? level : all;
  const spots: Badge[] = [
    { row, x: Math.max(...reach.map((r) => r.x + r.w)) + gap + BADGE_R, y: yMid },
    { row, x: cx, y: top - 2 - BADGE_R },
    { row, x: Math.min(...reach.map((r) => r.x)) - gap - BADGE_R, y: yMid },
  ];
  const disc = (b: Badge): Rect => ({ x: b.x - BADGE_R - 1, y: b.y - BADGE_R - 1, w: BADGE_R * 2 + 2, h: BADGE_R * 2 + 2 });
  const others = values.filter((v) => v.row !== row && !v.inside);
  const ok = (b: Badge, strict: boolean) => {
    if (b.x < BADGE_R || b.x > W - BADGE_R || b.y < BADGE_R) return false;
    const d = disc(b);
    if (badges.some((o) => overlaps(disc(o), d))) return false;
    return !others.some((v) => (strict || marks.has(v.row)) && overlaps(textBox(v, measure), d));
  };
  for (const strict of [true, false]) {
    const hit = spots.find((b) => ok(b, strict));
    if (hit) return { badge: hit, need: 0 };
  }
  // Nothing fits as the frame stands: above the labels, with the room it takes.
  const above = spots[1]!;
  return { badge: { row, x: Math.min(W - BADGE_R, Math.max(BADGE_R, above.x)), y: Math.max(BADGE_R, above.y) }, need: BADGE_R - above.y };
}

function layoutColumns(spec: ChartSpec, W: number, measure: Measure, mode: "column" | "line"): ChartLayout {
  const first = layoutColumnsAt(spec, W, measure, mode, 0);
  // A marked row's label or badge that steps up past another may need more room above the plot.
  return first.need > 0 ? layoutColumnsAt(spec, W, measure, mode, Math.ceil(first.need) + 2).out : first.out;
}

/**
 * A line chart's category labels: every marked row's, then the first and the last, then every
 * k-th (k the smallest step at which the widest label clears its neighbours), each kept only where
 * it touches none already kept. Each fits the frame: a long one wraps to two lines (then "…"), and
 * one at an end slides inward.
 */
function lineCats(spec: ChartSpec, measure: Measure, cx: (i: number) => number, band: number, W: number, y: number, marks: Map<number, unknown>): CatLabel[] {
  const rows = spec.rows.length;
  const cap = Math.max(40, Math.min(160, (W - 20) / 3));
  const lines = spec.rows.map((r) => wrap(r.label, cap, 2, FONT.cat, measure));
  const widths = lines.map((l) => Math.max(...l.map((s) => measure(s, FONT.cat))));
  // One that would pass an edge is anchored to it instead, so a font wider than measured grows inward.
  const at = (i: number, ls: string[], w: number): CatLabel =>
    cx(i) - w / 2 < 2 ? { row: i, x: 2, y, lines: ls, anchor: "start" } : cx(i) + w / 2 > W - 2 ? { row: i, x: W - 2, y, lines: ls, anchor: "end" } : { row: i, x: cx(i), y, lines: ls, anchor: "middle" };
  const k = Math.max(1, Math.ceil((Math.max(...widths) + CAT_GAP) / band));
  const kept: CatLabel[] = [];
  const clear = (c: CatLabel) => {
    const b = catBox(c, "line", measure);
    return kept.every((o) => {
      const ob = catBox(o, "line", measure);
      return b.x >= ob.x + ob.w + CAT_GAP || ob.x >= b.x + b.w + CAT_GAP;
    });
  };
  const order = [...[...marks.keys()].filter((i) => i >= 0 && i < rows).sort((a, b) => a - b), 0, rows - 1, ...Array.from({ length: rows }, (_, i) => i).filter((i) => i % k === 0)];
  for (const i of order) {
    if (kept.some((c) => c.row === i)) continue;
    let c = at(i, lines[i]!, widths[i]!);
    // A marked label squeezed by another marked one narrows to its own share of the axis.
    if (!clear(c) && marks.has(i)) {
      const narrow = wrap(spec.rows[i]!.label, Math.max(20, band - CAT_GAP), 2, FONT.cat, measure);
      c = at(i, narrow, Math.max(...narrow.map((s) => measure(s, FONT.cat))));
      kept.push(c);
      continue;
    }
    if (clear(c)) kept.push(c);
  }
  return kept.sort((a, b) => a.row - b.row);
}

function layoutColumnsAt(spec: ChartSpec, W: number, measure: Measure, mode: "column" | "line", extra: number): { out: ChartLayout; need: number } {
  const out = emptyLayout(W, mode);
  const marks = markedRows(spec);
  const stacked = spec.type === "stacked";
  const n = stacked ? 1 : seriesCount(spec);
  const rows = spec.rows.length;
  const plotH = Math.round(Math.min(240, Math.max(140, W * 0.42)));
  // Room above the plot for value labels, and for badges where a line chart puts them.
  const top = 18 + (marks.size ? 4 : 0) + (mode === "line" && seriesCount(spec) > 1 && [...marks.values()].some((e) => e.n) ? 6 : 0) + extra;
  // Tick labels decide the left margin, so measure them on a provisional axis first.
  const probe = valueAxis(spec, top + plotH, top, stacked, mode === "column");
  const left = Math.ceil(Math.max(...probe.ticks.map((t) => measure(probe.fmt(t), FONT.tick)))) + 10;
  const right = mode === "line" ? 10 : 6;
  const band = (W - left - right) / rows;
  const y0 = top;
  const y1 = top + plotH;
  const cx = (i: number) => left + band * (i + 0.5);
  const catY = y1 + 8 + LH / 2;
  // Category labels: two lines under each bar; a line chart's thinned to fit (lineCats).
  out.cats =
    mode === "line"
      ? lineCats(spec, measure, cx, band, W, catY, marks)
      : spec.rows.map((r, i) => ({ row: i, x: cx(i), y: catY, lines: wrap(r.label, Math.max(24, band - 4), 2, FONT.cat, measure), anchor: "middle" as const }));
  const lineCount = Math.max(1, ...out.cats.map((c) => c.lines.length));
  const bottom = 8 + lineCount * LH;
  const axis = valueAxis(spec, y1, y0, stacked, mode === "column");
  out.plot = { x0: left, y0, x1: W - right, y1 };
  out.yTicks = ticksOf(axis);
  out.H = y1 + bottom;
  const zero = axis.at(base(axis));
  let need = 0;

  spec.rows.forEach((row, i) => {
    const e = marks.get(i);
    if (e) out.bands.push({ row: i, x: cx(i) - band / 2 + 1, y: y0 - (e.n ? 4 : 0), w: band - 2, h: y1 - y0 + 6 + lineCount * LH + (e.n ? 4 : 0) });
  });

  if (mode === "column") {
    const bw = Math.min(stacked ? 56 : 44, (band * (n > 1 ? 0.8 : 0.66)) / n);
    const valueFits = (text: string) => measure(text, FONT.value) <= Math.min(band - 4, bw + 24);
    const wanted: (Wanted & { fits: boolean })[] = [];
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
        const text = valueLabel(v);
        if (stacked) {
          // A segment names its own value when there's room inside it.
          if (bar.h >= 15 && measure(text, FONT.value) <= bar.w - 6 && row.values.filter((x) => x !== null).length > 1) out.values.push({ row: i, x: bar.x + bar.w / 2, y: bar.y + bar.h / 2, text, anchor: "middle", inside: true });
        } else {
          // Side by side in a group, a label needs its own bar's width (and a gap); alone, its band.
          const fits = n > 1 ? measure(text, FONT.value) + VALUE_GAP <= bw : valueFits(text);
          // Below a negative bar, unless that runs into the category labels: then just above zero.
          const below = v < 0 && bar.y + bar.h + 8 + 6.5 <= y1;
          wanted.push({ row: i, x: bar.x + bar.w / 2, y: below ? bar.y + bar.h + 8 : v < 0 ? zero - 7 : bar.y - 7, text, anchor: "middle", marked: marks.has(i), down: below, fits });
        }
      });
      if (stacked) {
        const text = valueLabel(sum(row.values));
        wanted.push({ row: i, x: cx(i), y: topY - 7, text, anchor: "middle", marked: marks.has(i), down: false, fits: valueFits(text) });
      }
    });
    // A group's labels are all drawn or, for the whole chart, none are (a marked row keeps its own).
    const all = stacked || n === 1 ? true : rows * n <= 24 && wanted.every((w) => w.fits);
    const settled = settleValues(
      wanted.filter((w) => w.marked || (all && w.fits && (stacked || rows * n <= 24))),
      measure,
    );
    need = Math.max(need, settled.need);
    out.values.push(...settled.values);
    // The badge sits right of the row's top value label (or of the bars), clear of both.
    spec.rows.forEach((_, i) => {
      if (!marks.get(i)?.n) return;
      const own = out.values.filter((v) => v.row === i && !v.inside).map((v) => textBox(v, measure));
      // A group's bars each give up 1px a side to the gap between them: the badge measures from the group's edge.
      const body = out.bars.filter((b) => b.row === i).map((b) => (n > 1 ? { ...b, x: b.x - 1, w: b.w + 2 } : b));
      const placed = placeBadge(i, cx(i), own, body, 3, W, out.values, marks, out.badges, measure);
      out.badges.push(placed.badge);
      need = Math.max(need, placed.need);
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
    const wanted: Wanted[] = [];
    for (const p of out.points) {
      const e = marks.get(p.row);
      const text = valueLabel(spec.rows[p.row]!.values[p.series]!);
      // A ring pushes its point's label up.
      if (nSeries === 1 && (labelAll || e)) wanted.push({ row: p.row, x: p.x, y: p.y - (e ? 16 : 11), text, anchor: "middle", marked: !!e, down: false });
      if (e) out.rings.push({ row: p.row, x: p.x, y: p.y });
    }
    const settled = settleValues(wanted, measure);
    need = Math.max(need, settled.need);
    out.values.push(...settled.values);
    // One series: the badge follows its point's label. Several: it goes to the band's top corner, off the lines.
    if (nSeries === 1)
      for (const p of out.points) {
        if (!marks.get(p.row)?.n) continue;
        const own = out.values.filter((v) => v.row === p.row).map((v) => textBox(v, measure));
        const placed = placeBadge(p.row, p.x, own, [{ x: p.x - 4, y: p.y - 4, w: 8, h: 8 }], 4, W, out.values, marks, out.badges, measure);
        out.badges.push(placed.badge);
        need = Math.max(need, placed.need);
      }
    if (nSeries > 1)
      for (const b of out.bands) if (marks.get(b.row)?.n) out.badges.push({ row: b.row, x: Math.min(W - BADGE_R, b.x + b.w / 2 + 12), y: y0 - 13 });
  }
  return { out, need };
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
  let right = 12;
  const y = mk(ys, top + plotH, top, 40);
  // Tick labels along x must not touch: thin the ticks until they fit.
  const xAxis = () => {
    const a = mk(xs, left, W - right, 70);
    const xw = Math.max(...a.ticks.map((t) => measure(a.fmt(t), FONT.tick)));
    return a.ticks.length > 1 && Math.abs(a.at(a.ticks[1]!) - a.at(a.ticks[0]!)) < xw + 10 ? mk(xs, left, W - right, xw * 2 + 30) : a;
  };
  let x = xAxis();
  // The last tick's label is centred on it: when it would pass the edge, the plot ends sooner.
  const last = x.ticks[x.ticks.length - 1];
  const over = last === undefined ? 0 : x.at(last) + (measure(x.fmt(last), FONT.tick) * 1.1) / 2 - (W - 2);
  if (over > 0) {
    right += Math.ceil(over);
    x = xAxis();
  }
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
  // Labels: marked points first, then in order. Each tries the four sides of its point, then the
  // diagonals, then the same a step further out (joined to its point by a leader line), and is
  // dropped only when all of those would hit a label, a point, a ring, a tick label or the frame.
  const taken: Rect[] = [
    ...out.points.map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })),
    ...out.rings.map((r) => ({ x: r.x - 10, y: r.y - 10, w: 20, h: 20 })),
    ...out.badges.map((b) => ({ x: b.x - BADGE_R, y: b.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 })),
    ...out.yTicks.filter((t) => t.label).map((t) => ({ x: 0, y: t.pos - 7, w: left - 4, h: 14 })),
  ];
  const order = [...out.points].sort((a, b) => (marks.has(a.row) ? 0 : 1) - (marks.has(b.row) ? 0 : 1) || a.row - b.row);
  let placed = 0;
  for (const p of order) {
    if (placed >= MAX_POINT_LABELS) break;
    const text = spec.rows[p.row]!.label;
    const w = measure(text, FONT.point);
    const h = 13;
    const near = marks.has(p.row) ? 15 : 7; // clear of a mark's ring (r 8 + stroke) by about 5px
    for (const [tx, ty, anchor, far] of labelSpots(p.x, p.y, near)) {
      const box: Rect = { x: anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2, y: ty - h / 2, w, h };
      if (box.x < out.plot.x0 + 2 || box.x + box.w > W || box.y < 0 || box.y + box.h > out.plot.y1 - 2) continue;
      if (taken.some((t) => overlaps(t, box))) continue;
      taken.push(box);
      out.values.push({ row: p.row, x: tx, y: ty, text, anchor });
      if (far) {
        // From the point's edge to the label's nearest edge.
        const ex = anchor === "start" ? box.x - 2 : anchor === "end" ? box.x + box.w + 2 : tx;
        const ey = anchor === "middle" ? (ty < p.y ? box.y + box.h + 1 : box.y - 1) : ty;
        const d = Math.hypot(ex - p.x, ey - p.y) || 1;
        out.leaders.push({ x1: p.x + ((ex - p.x) / d) * 5, y1: p.y + ((ey - p.y) / d) * 5, x2: ex, y2: ey });
      }
      placed++;
      break;
    }
  }
  return out;
}

const MAX_POINT_LABELS = 16;

/** Where a point's label may go, nearest first: [x, y, anchor, needs a leader line]. */
function labelSpots(x: number, y: number, near: number): [number, number, "start" | "end" | "middle", boolean][] {
  const out: [number, number, "start" | "end" | "middle", boolean][] = [];
  for (const [d, far] of [[near, false], [near + 16, true], [near + 34, true]] as const) {
    out.push([x + d, y, "start", far], [x - d, y, "end", far], [x, y - d - 5, "middle", far], [x, y + d + 5, "middle", far]);
    out.push([x + d * 0.8, y - d * 0.8 - 3, "start", far], [x + d * 0.8, y + d * 0.8 + 3, "start", far], [x - d * 0.8, y - d * 0.8 - 3, "end", far], [x - d * 0.8, y + d * 0.8 + 3, "end", far]);
  }
  return out;
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The width a chart lays out at: the body's width, kept between these. Below the minimum it scales down. */
export const CHART_MIN = 260;
export const CHART_MAX = 720;
export const chartWidth = (width: number) => Math.max(CHART_MIN, Math.min(CHART_MAX, Math.floor(width)));

/** The value axis' name above the plot: `y (unit)`, or either alone. */
export function axisTitle(spec: ChartSpec): string | undefined {
  if (spec.y && spec.unit && spec.unit !== "%") return `${spec.y} (${spec.unit})`;
  return spec.y ?? spec.unit;
}

/** HTML metrics chart.css sets (tokens: fs-caption 12.5 × lh-caption 1.45; fs-micro 11 × lh-micro 1.3; space-1 4, space-2 8, space-3 12). */
export const CHART_CSS = { legendLine: 12.5 * 1.45, legendGapX: 12, legendGapY: 4, legendBelow: 8, swatch: 22 + 4, axisLine: 11 * 1.3, axisGap: 4 };

/**
 * Where the series legend breaks into rows at `width`: the indices that start a new row. The View
 * draws those breaks itself, so the legend's height is this function's, not the browser's wrapping.
 */
export function legendBreaks(spec: ChartSpec, width: number, measure: Measure = canvasMeasure): number[] {
  const breaks: number[] = [];
  let x = 0;
  spec.series.forEach((name, i) => {
    const w = CHART_CSS.swatch + measure(name, 12.5);
    if (x > 0 && x + CHART_CSS.legendGapX + w > width) {
      breaks.push(i);
      x = w;
    } else x += (x > 0 ? CHART_CSS.legendGapX : 0) + w;
  });
  return breaks;
}

/**
 * The height ChartView renders when its box is `width` px wide: legend, axis name, the SVG (laid out
 * at chartWidth(width), shrunk to fit below CHART_MIN) and the x axis' name. Exact wherever the
 * measure is (canvas in the browser).
 */
export function estimateHeight(spec: ChartSpec, width: number, measure: Measure = canvasMeasure): number {
  if (spec.type === "parts") return partsHeight(spec, width);
  const W = chartWidth(width);
  let h = layoutChart(spec, W, measure).H * Math.min(1, width / W);
  if (spec.series.length > 1) {
    const rows = legendBreaks(spec, width, measure).length + 1;
    h += rows * CHART_CSS.legendLine + (rows - 1) * CHART_CSS.legendGapY + CHART_CSS.legendBelow;
  }
  if (axisTitle(spec)) h += CHART_CSS.axisLine + CHART_CSS.axisGap;
  if (spec.x) h += CHART_CSS.axisGap + CHART_CSS.axisLine;
  return h;
}
