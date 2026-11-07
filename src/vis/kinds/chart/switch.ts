/**
 * `vis chart` views: what a reader may switch a chart to (Bar, Stacked, Line, Parts) and its Log,
 * Sort and % toggles, and the spec each choice draws. The model's fence is the default; nothing
 * here changes what a fence means. Pure (no DOM, no Solid): the figure's head and the tests use it.
 */

import type { Emphasis, Tone } from "../../core/grammar";
import { MAX_PARTS, type ChartRow, type ChartSpec, type ChartType } from "./parse";
import { partsOf } from "./parts";

export type ChartView = "bar" | "stacked" | "line" | "parts";
export const VIEW_ORDER: readonly ChartView[] = ["bar", "stacked", "line", "parts"];

/** A reader's choice. `view` is "scatter" only on a scatter chart. `log` is kept while a view ignores it. */
export interface ChartChoice {
  view: ChartType;
  log: boolean;
  sort: boolean;
  pct: boolean;
}
export type Toggle = "log" | "sort" | "pct";

export interface ChartViews {
  /** The views offered, in order; the switch shows only when there are two or more. */
  views: ChartView[];
  /** The model's view (the fence's `type:`). */
  model: ChartType;
  /** Every value above 0, gaps aside (scatter: every x and y). */
  logOk: boolean;
  /** Not already in percent, no value below 0 and something to share (a single series' sum above 0). */
  pctOk: boolean;
}

const values = (spec: ChartSpec) => spec.rows.flatMap((r) => r.values.filter((v): v is number => v !== null));
const seriesCount = (spec: ChartSpec) => Math.max(1, spec.series.length);
/** A parts chart drawn against its `of:` capacity: only Parts answers that. */
const capacity = (spec: ChartSpec) => spec.type === "parts" && spec.of !== undefined;
/** Values already in percent (`unit: %`, or rows written `12%`): % would only rescale them. */
const percent = (spec: ChartSpec) => !!spec.percent || /^(%|percent|pct)$/i.test(spec.unit?.trim() ?? "");

function fits(spec: ChartSpec, view: ChartView): boolean {
  const vs = values(spec);
  const neg = vs.some((v) => v < 0);
  switch (view) {
    case "bar":
      return true;
    case "line":
      return spec.rows.length >= 2;
    case "stacked":
      return spec.series.length >= 2 && !neg;
    case "parts": {
      const gaps = spec.rows.some((r) => r.values.some((v) => v === null));
      const sum = vs.reduce((a, v) => a + v, 0);
      return seriesCount(spec) === 1 && spec.rows.length >= 2 && spec.rows.length <= MAX_PARTS && !gaps && !neg && sum > 0;
    }
  }
}

export function chartViews(spec: ChartSpec): ChartViews {
  const vs = values(spec);
  const logOk = vs.length > 0 && vs.every((v) => v > 0);
  if (spec.type === "scatter" || capacity(spec)) return { views: [], model: spec.type, logOk: spec.type === "scatter" && logOk, pctOk: false };
  const single = seriesCount(spec) === 1;
  const pctOk = !percent(spec) && !vs.some((v) => v < 0) && (single ? vs.reduce((a, v) => a + v, 0) > 0 : vs.some((v) => v > 0));
  // The model's own view is always offered: it is what the fence draws.
  const views = VIEW_ORDER.filter((v) => v === spec.type || fits(spec, v));
  return { views, model: spec.type, logOk, pctOk };
}

export function modelChoice(spec: ChartSpec): ChartChoice {
  return { view: spec.type, log: spec.scale === "log", sort: false, pct: false };
}

/** Which toggles the head shows for this choice. % and Log hide each other while one is on. */
export function shownToggles(spec: ChartSpec, choice: ChartChoice): Record<Toggle, boolean> {
  const v = chartViews(spec);
  if (spec.type === "scatter") return { log: v.logOk, sort: false, pct: false };
  if (capacity(spec)) return { log: false, sort: false, pct: false };
  const view = choice.view;
  return {
    log: (view === "bar" || view === "line") && v.logOk && !choice.pct,
    sort: view === "bar" || view === "stacked" || view === "parts",
    pct: (view === "bar" || view === "stacked" || view === "line") && v.pctOk && !choice.log,
  };
}

export const TOGGLE_ORDER: readonly Toggle[] = ["log", "sort", "pct"];
const VIEW_NAME: Record<ChartType, string> = { bar: "Bar", stacked: "Stacked", line: "Line", parts: "Parts", scatter: "Scatter" };
const TOGGLE_NAME: Record<Toggle, string> = { log: "Log", sort: "Sort", pct: "%" };

/**
 * The toggles this chart can use in any of its views, in the head's fixed order. The head always
 * shows exactly these, so switching views or flipping one never moves a control.
 */
export function offeredToggles(spec: ChartSpec): Toggle[] {
  const v = chartViews(spec);
  const views: ChartType[] = spec.type === "scatter" || capacity(spec) ? [spec.type] : v.views;
  const any = new Set<Toggle>();
  for (const view of views) {
    // Each of Log and % shows while the other is off, so try both off.
    const shown = shownToggles(spec, { view, log: false, sort: false, pct: false });
    for (const t of TOGGLE_ORDER) if (shown[t]) any.add(t);
  }
  return TOGGLE_ORDER.filter((t) => any.has(t));
}

export interface ToggleState {
  toggle: Toggle;
  /** Usable in this choice; otherwise drawn greyed in its place. */
  enabled: boolean;
  /** Pressed: on and usable. */
  on: boolean;
  /** Why it is greyed ("Sort doesn't apply to Line", "Turn % off to use Log"), else undefined. */
  hint?: string;
}

/** Every offered toggle for this choice, in order: usable or greyed, with the reason. */
export function toggleStates(spec: ChartSpec, choice: ChartChoice): ToggleState[] {
  const shown = shownToggles(spec, choice);
  return offeredToggles(spec).map((t) => {
    if (shown[t]) return { toggle: t, enabled: true, on: choice[t] };
    const other: Toggle | null = t === "log" ? "pct" : t === "pct" ? "log" : null;
    const blocker = other && choice[other] && shownToggles(spec, { ...choice, [other]: false })[t];
    const hint = blocker ? `Turn ${TOGGLE_NAME[other!]} off to use ${TOGGLE_NAME[t]}` : `${TOGGLE_NAME[t]} doesn't apply to ${VIEW_NAME[choice.view]}`;
    return { toggle: t, enabled: false, on: false, hint };
  });
}

/**
 * Any choice made valid for this chart (one restored from the tab, say): a view that doesn't fit
 * falls back to the model's; Sort and % switch off where hidden; Log is kept while allowed at all,
 * and wins when both it and % are on.
 */
export function settle(spec: ChartSpec, choice: Partial<ChartChoice>): ChartChoice {
  const v = chartViews(spec);
  const view = spec.type === "scatter" || capacity(spec) ? spec.type : (v.views as ChartType[]).includes(choice.view as ChartType) ? choice.view! : spec.type;
  const log = !!choice.log && v.logOk;
  const out: ChartChoice = { view, log, sort: !!choice.sort, pct: !!choice.pct && !log };
  const shown = shownToggles(spec, out);
  if (!shown.sort) out.sort = false;
  if (!shown.pct) out.pct = false;
  return out;
}

export const pickView = (spec: ChartSpec, choice: ChartChoice, view: ChartView): ChartChoice => settle(spec, { ...choice, view });

/** Flips one toggle, if the head shows it for this choice. */
export function toggle(spec: ChartSpec, choice: ChartChoice, which: Toggle): ChartChoice {
  if (!shownToggles(spec, choice)[which]) return choice;
  return settle(spec, { ...choice, [which]: !choice[which] });
}

export const isModel = (spec: ChartSpec, choice: ChartChoice): boolean => {
  const c = settle(spec, choice);
  const m = modelChoice(spec);
  return c.view === m.view && c.log === m.log && !c.sort && !c.pct;
};

/** The row order Sort draws: largest first (a row's total with several series), ties in source order, gaps last. */
export function sortOrder(spec: ChartSpec): number[] {
  const key = (r: ChartRow) => (r.values.every((v) => v === null) ? -Infinity : r.values.reduce<number>((a, v) => a + (v ?? 0), 0));
  return spec.rows.map((r, i) => ({ i, k: key(r) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.i);
}

const TONE_OF_SERIES: Tone[] = ["accent", "warn", "ok", "error", "info", "muted"];
const clean = (v: number) => Number(v.toPrecision(12));

/** The spec a choice draws: the model's spec as another type, with its rows sorted or as shares. */
export function drawAs(spec: ChartSpec, choice: ChartChoice): ChartSpec {
  const c = settle(spec, choice);
  if (spec.type === "scatter") return c.log === (spec.scale === "log") ? spec : { ...spec, scale: c.log ? "log" : "linear" };
  if (capacity(spec)) return spec;
  const view = c.view as ChartView;
  const out: ChartSpec = { ...spec, type: view, scale: c.log && (view === "bar" || view === "line") ? "log" : "linear", rows: spec.rows.map((r) => ({ ...r, values: [...r.values] })) };
  if (view === "parts") {
    out.series = [];
    // Parts colour untoned rows in turn: under Sort each keeps the colour it has in source order.
    if (c.sort) {
      const colors = partsOf({ ...spec, type: "parts", series: [] }).parts;
      out.rows.forEach((r, i) => {
        const m = /^vis-chart-s(\d)$/.exec(colors[i]!.color);
        if (!r.tone && m) r.tone = TONE_OF_SERIES[Number(m[1])];
      });
    }
  }
  if (c.pct) {
    const single = seriesCount(spec) === 1;
    const whole = single ? out.rows.reduce((a, r) => a + (r.values[0] ?? 0), 0) : 0;
    for (const r of out.rows) {
      const sum = single ? whole : r.values.reduce<number>((a, v) => a + (v ?? 0), 0);
      r.values = r.values.map((v) => (v === null ? null : sum > 0 ? clean((v / sum) * 100) : 0));
    }
    out.unit = "%";
  }
  if (c.sort) {
    const order = sortOrder(spec);
    out.rows = order.map((i) => out.rows[i]!);
    const at = new Map(order.map((from, to) => [String(from), String(to)]));
    if (spec.emphasis) out.emphasis = spec.emphasis.map((e): Emphasis => ({ ...e, key: at.get(e.key) ?? e.key }));
  }
  return out;
}
