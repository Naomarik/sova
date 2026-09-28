/** `vis chart` (and the `vis bar` / `vis hbar` / `vis line` shorthands): labelled rows of numbers. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export type ChartType = "bar" | "hbar" | "line" | "stacked";
export interface ChartRow {
  label: string;
  /** One per series; null is a gap. */
  values: (number | null)[];
  tone?: Tone;
}
export interface ChartSpec extends VisBase {
  kind: "chart";
  type: ChartType;
  unit?: string;
  x?: string;
  y?: string;
  scale: "linear" | "log";
  series: string[];
  rows: ChartRow[];
}


const MAX_ROWS = 40;
const MAX_SERIES = 6;

// ---- chart -------------------------------------------------------------------------------

const CHART_TYPES: ChartType[] = ["bar", "hbar", "line", "stacked"];

function parseChartLines(ls: Line[], preset: ChartType | null): ChartSpec {
  const spec: ChartSpec = { kind: "chart", type: preset ?? "bar", scale: "linear", series: [], rows: [] };
  const { rest, values } = takeSettings(ls, ["type", "unit", "x", "y", "series", "scale"], spec);
  const type = values.get("type");
  if (type) {
    if (!CHART_TYPES.includes(type.value as ChartType)) fail(type.n, `type: is one of ${CHART_TYPES.join(", ")}`);
    if (preset && type.value !== preset) fail(type.n, `vis ${preset} is already type: ${preset}`);
    spec.type = type.value as ChartType;
  }
  const scale = values.get("scale");
  if (scale) {
    if (scale.value !== "linear" && scale.value !== "log") fail(scale.n, "scale: is linear or log");
    spec.scale = scale.value as "linear" | "log";
  }
  for (const key of ["unit", "x", "y"] as const) {
    const v = values.get(key);
    if (v) spec[key] = text(v.value, v.n);
  }
  const series = values.get("series");
  if (series) spec.series = commaList(series.value, series.n);
  if (spec.series.length > MAX_SERIES) fail(series!.n, `${spec.series.length} series; at most ${MAX_SERIES}`);
  const width = Math.max(1, spec.series.length);
  for (const line of rest) {
    const toks = tokenize(line);
    const head = toks[0]!;
    if (head.t === "arrow") fail(line.n, "a row is: label value [value…] [tone]");
    const label = head.v;
    const vals: (number | null)[] = [];
    let tone: Tone | undefined;
    for (const tok of toks.slice(1)) {
      if (tok.t !== "word") fail(line.n, `expected a number, found ${tok.t === "str" ? `"${tok.v}"` : tok.v}`);
      if (tone) fail(line.n, "the tone goes last");
      if (isTone(tok.v)) {
        tone = tok.v;
        continue;
      }
      if (tok.v === "-" || tok.v === "null") {
        vals.push(null);
        continue;
      }
      const num = Number(tok.v.replace(/_/g, ""));
      if (!/^[-+]?(\d[\d_]*\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(tok.v) || !Number.isFinite(parseFloat(tok.v))) {
        fail(line.n, `"${tok.v}" is not a number${/,/.test(tok.v) ? " (no thousands commas)" : ""}${head.t === "word" && toks.length > 2 && vals.length === 0 ? '; quote labels that have spaces: "Merge sort" 12' : ""}`);
      }
      vals.push(tok.v.endsWith("%") ? parseFloat(tok.v) : num);
    }
    if (vals.length !== width) fail(line.n, `${vals.length} values; expected ${width}${spec.series.length ? ` (series: ${spec.series.join(", ")})` : " (add series: a, b for more than one)"}`);
    if (tone && width > 1) fail(line.n, "a tone colours a single-series bar; with several series each series has its own colour");
    if (spec.scale === "log" && vals.some((v) => v !== null && v <= 0)) fail(line.n, "scale: log needs values above 0");
    spec.rows.push({ label: text(label, line.n), values: vals, ...(tone ? { tone } : {}) });
  }
  if (spec.rows.length === 0) fail(0, 'nothing to draw: add rows like "Quicksort" 120');
  if (spec.rows.length > MAX_ROWS) fail(0, `${spec.rows.length} rows; at most ${MAX_ROWS}`);
  if (spec.type === "stacked" && spec.rows.some((r) => r.values.some((v) => v !== null && v < 0))) fail(0, "stacked bars need values of 0 or more");
  return spec;
}

/** ```vis chart (type: from the body, default bar); ```vis bar / hbar / line preset the type. */
export const parseChart = (preset: ChartType | null) => (body: string) => parseChartLines(lines(body), preset);
