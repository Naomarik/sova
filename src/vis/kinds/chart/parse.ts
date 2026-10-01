/**
 * `vis chart`: labelled rows of numbers. `type:` bar (default; grouped with `series:`), stacked,
 * line, scatter (each row: label, x, y), or parts (one bar split into its rows, optionally against
 * an `of:` capacity). No pie or donut, by design: parts is the linear part-of-whole.
 */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { commaListFor, fail, isTone, lines, takeSettings, text, tokenize, VisError, warn, type Line, type Token, type Tone, type VisBase } from "../../core/grammar";

export type ChartType = "bar" | "stacked" | "line" | "scatter" | "parts";
export interface ChartRow {
  label: string;
  /** One per series (null is a gap); for scatter, [x, y]. */
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
  /** parts only: the capacity the parts fill; the rest is drawn as free. */
  of?: number;
}

const MAX_ROWS = 40;
const MAX_SERIES = 6;
const MAX_PARTS = 12;

const CHART_TYPES: ChartType[] = ["bar", "stacked", "line", "scatter", "parts"];
/** Other words for a type (§chat.markdown/vis-lenience-content): pie and donut are a whole and its parts. */
const TYPE_WORDS: Readonly<Record<string, ChartType>> = {
  column: "bar", columns: "bar", bars: "bar", hbar: "bar", horizontal: "bar", vertical: "bar", grouped: "bar",
  area: "line", lines: "line", trend: "line",
  stack: "stacked", "stacked bar": "stacked", "stacked bars": "stacked",
  pie: "parts", donut: "parts", doughnut: "parts",
  points: "scatter", dots: "scatter",
};

const MAGNITUDE: Readonly<Record<string, number>> = { k: 1e3, K: 1e3, M: 1e6, bn: 1e9 };
const GAP = /^(-|null|n\/a|na|\?|—|–)$/i;
const VALUE = /^([-+])?([$€£¥])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d[\d_]*(?:\.\d*)?|\.\d+)(e[-+]?\d+)?([A-Za-zµμ%€£¥$/]+)?$/;
const UNIT_WORD = /^[A-Za-zµμ%€£¥$][A-Za-zµμ%€£¥$/]{0,7}$/;

/**
 * A value as people write one: `1.2k`, `$4,200`, `120ms`, `-3%`, `n/a` (a gap). `unit` is its unit
 * suffix or currency (never `%` or a magnitude: `k` `K` `M` `bn`, and `B` after a currency, since
 * `500B` is bytes); null when the word isn't a value.
 */
export function readValue(w: string): { v: number | null; unit?: string } | null {
  if (GAP.test(w)) return { v: null };
  const m = VALUE.exec(w);
  if (!m) return null;
  const [, sign, cur, digits, exp, suffix] = m;
  let v = Number(digits!.replace(/[,_]/g, "") + (exp ?? ""));
  if (!Number.isFinite(v)) return null;
  if (sign === "-") v = -v;
  if (suffix === "%") return cur ? null : { v };
  const mag = suffix === undefined ? undefined : (MAGNITUDE[suffix] ?? (suffix === "B" && cur ? 1e9 : undefined));
  if (mag) v *= mag;
  const unit = mag || suffix === undefined ? cur : `${cur ?? ""}${suffix}`;
  return { v, ...(unit ? { unit } : {}) };
}

type RowRead = { label: string; vals: (number | null)[]; tone?: Tone; units: (string | undefined)[] };

/** Sizes and durations (§chat.markdown/vis-lenience-content): units one chart may mix, each value converted. */
const SIZES: Readonly<Record<string, number>> = { B: 1, KB: 1e3, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
/** `4.3G`: a size only beside another size. */
const SIZE_LETTERS: Readonly<Record<string, number>> = { G: 1e9, T: 1e12 };
const DURATIONS: Readonly<Record<string, number>> = {
  ns: 1e-9, "µs": 1e-6, "μs": 1e-6, us: 1e-6, ms: 1e-3,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400,
};
const sizeOf = (u: string): number | undefined => (/^bytes?$/i.test(u) ? 1 : Object.hasOwn(SIZES, u) ? SIZES[u] : undefined);
const durationOf = (u: string): number | undefined => (Object.hasOwn(DURATIONS, u.toLowerCase()) ? DURATIONS[u.toLowerCase()] : undefined);
/** The words of a `unit:` setting, as the unit check splits them. */
const unitWords = (unit: string) => unit.split(/[^\p{L}\p{N}%$€£¥µμ]+/u).filter(Boolean);

/**
 * Rows in several sizes or several durations, and the `unit:` words: each unit's factor and the
 * one to draw in (`unit:`'s, else the smallest), or null when they aren't all one family.
 */
function unitFamily(units: string[], setting: string | undefined): { factor: (u: string) => number; target: number; unit?: string } | null {
  const words = setting === undefined ? [] : unitWords(setting);
  for (const of of [sizeOf, durationOf]) {
    const named = [...units, ...words].some((u) => of(u) !== undefined);
    const factor = (u: string) => of(u) ?? (of === sizeOf && named ? SIZE_LETTERS[u] : undefined);
    if (!units.every((u) => factor(u) !== undefined)) continue;
    if (setting !== undefined) {
      const w = words.find((x) => of(x) !== undefined);
      if (w === undefined) continue;
      return { factor: (u) => factor(u)!, target: of(w)! };
    }
    const smallest = units.reduce((a, u) => (factor(u)! < factor(a)! ? u : a));
    return { factor: (u) => factor(u)!, target: factor(smallest)!, unit: smallest };
  }
  return null;
}

/**
 * A row today's reading refuses, read from its end (§chat.markdown/vis-lenience-content): a tone,
 * then `width` values, each with an optional unit word after it; the rest is the label. Null when
 * that doesn't read, or when every extra word could be a value (a missing `series:` reads the same)
 * and no row read as written settles the width (`widthSettled`).
 */
function readRowFromEnd(toks: Token[], width: number, widthSettled: boolean): RowRead | null {
  const head = toks[0];
  if (!head || head.t === "arrow") return null;
  let i = toks.length - 1;
  let tone: Tone | undefined;
  const last = toks[i];
  if (i > 0 && last?.t === "word" && isTone(last.v)) {
    tone = last.v;
    i--;
  }
  const vals: (number | null)[] = [];
  const units: (string | undefined)[] = [];
  for (let k = 0; k < width; k++) {
    let unitWord: string | undefined;
    const t = toks[i];
    const before = toks[i - 1];
    if (i >= 2 && t?.t === "word" && UNIT_WORD.test(t.v) && !isTone(t.v) && !readValue(t.v) && before?.t === "word" && readValue(before.v)?.v != null && readValue(before.v)!.unit === undefined) {
      unitWord = t.v;
      i--;
    }
    const vt = toks[i];
    if (i < 1 || vt?.t !== "word") return null;
    const v = readValue(vt.v);
    if (!v) return null;
    vals.unshift(v.v);
    units.unshift(v.unit ?? unitWord);
    i--;
  }
  const labelToks = toks.slice(0, i + 1);
  if (labelToks.length === 0 || labelToks.some((t) => t.t === "arrow")) return null;
  if (labelToks.length > 1) {
    if (head.t === "str") return null;
    const seen = new Set(units.filter(Boolean));
    if (!widthSettled && labelToks.slice(1).every((t) => t.t === "word" && (readValue(t.v) !== null || seen.has(t.v)))) return null;
  }
  return { label: labelToks.map((t) => t.v).join(" "), vals, units, ...(tone ? { tone } : {}) };
}

/** A `key: value` line that is a row: every word a value, a unit word, a tone or `|` (`jan: 1200`). */
const valuesOnly = (_key: string, value: string): boolean => {
  const ws = value.split(/\s+/).filter(Boolean);
  return ws.some((w) => readValue(w)?.v != null) && ws.every((w) => readValue(w) !== null || isTone(w) || w === "|" || UNIT_WORD.test(w));
};

export function parseChart(body: string, defaultType: ChartType = "bar"): ChartSpec {
  const ls = lines(body);
  const spec: ChartSpec = { kind: "chart", type: defaultType, scale: "linear", series: [], rows: [] };
  const { rest: settled, values } = takeSettings(ls, ["type", "unit", "x", "y", "series", "scale", "of"], spec, { caseless: true, asRow: valuesOnly });
  const { rest, marks } = takeMarks(settled, { indented: true });
  const type = values.get("type");
  if (type) {
    const word = type.value.toLowerCase().replace(/\s+chart$/, "").trim();
    const known = CHART_TYPES.includes(word as ChartType) ? (word as ChartType) : Object.hasOwn(TYPE_WORDS, word) ? TYPE_WORDS[word] : undefined;
    if (known) type.value = known;
    if (!CHART_TYPES.includes(type.value as ChartType)) fail(type.n, `type: is one of ${CHART_TYPES.join(", ")}${/pie|donut|doughnut/.test(type.value) ? " (no pie or donut: use parts for a whole and its parts)" : ""}`);
    spec.type = type.value as ChartType;
  }
  const scale = values.get("scale");
  if (scale) {
    if (/^(logarithmic|log10)$/i.test(scale.value)) scale.value = "log";
    if (scale.value !== "linear" && scale.value !== "log") fail(scale.n, "scale: is linear or log");
    spec.scale = scale.value as "linear" | "log";
  }
  for (const key of ["unit", "x", "y"] as const) {
    const v = values.get(key);
    if (v) spec[key] = text(v.value, v.n);
  }
  const series = values.get("series");
  // The rows' value counts settle a `series:` line that reads more than one way (commaListFor).
  if (series) spec.series = commaListFor(series.raw, series.n, () => rest.map((line) => tokenize(line).slice(1).filter((t) => !(t.t === "word" && isTone(t.v))).length));
  if (spec.series.length > MAX_SERIES) fail(series!.n, `${spec.series.length} series; at most ${MAX_SERIES}`);
  if (spec.type === "scatter" && series) fail(series.n, "scatter takes no series: each row is label x y");
  if (spec.type === "parts") {
    if (series) fail(series.n, "parts takes no series: each row is one part, label value [tone]");
    if (scale && spec.scale === "log") fail(scale.n, "parts can't use scale: log (a part's length is its share)");
    for (const key of ["x", "y"] as const) if (values.has(key)) fail(values.get(key)!.n, `parts has no axes: drop ${key}:`);
  }
  const of = values.get("of");
  if (of) {
    if (spec.type !== "parts") fail(of.n, "of: is the capacity of a type: parts chart");
    const plain = /^\d[\d_]*\.?\d*(e[-+]?\d+)?$/i.test(of.value);
    // `of: 200k`, `of: $2.4M`: a value as a row's reads (its unit aside).
    const cap = plain ? Number(of.value.replace(/_/g, "")) : (readValue(of.value)?.v ?? NaN);
    if (!(cap > 0)) fail(of.n, `of: is a number above 0${/,/.test(of.value) ? " (no thousands commas)" : ""}`);
    spec.of = cap;
  }
  const width = spec.type === "scatter" ? 2 : Math.max(1, spec.series.length);
  // Each row's units (the lenient reading's), to check that they agree.
  const rowUnits: { unit: string; n: number }[] = [];
  const strict = (line: Line, toks: Token[]): RowRead => {
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
    // A bare head then one value too many may be a label with a space: say so.
    const quote = head.t === "word" && vals.length > width && toks[1]?.t === "word" ? `; or quote a label with spaces: "${head.v} ${toks[1].v}" ${toks.slice(2).map((t) => t.v).join(" ")}` : "";
    if (vals.length !== width) fail(line.n, `${vals.length} values; expected ${width}${spec.type === "scatter" ? " (x y)" : spec.series.length ? ` (series: ${spec.series.join(", ")})` : " (add series: a, b for more than one)"}${quote}`);
    return { label, vals, units: [], ...(tone ? { tone } : {}) };
  };
  // Bare words then a `|` (`Sep 24 | 120`): the words are the label, when the row reads no other way.
  const labelBeforeBar = (line: Line, toks: Token[]): RowRead | null => {
    const bar = toks.findIndex((t) => t.t === "word" && t.v === "|");
    if (bar < 1 || toks.slice(0, bar).some((t) => t.t !== "word")) return null;
    const rest = [{ t: "str", v: toks.slice(0, bar).map((t) => t.v).join(" ") } as Token, ...toks.slice(bar + 1).filter((t) => !(t.t === "word" && t.v === "|"))];
    try {
      return strict(line, rest);
    } catch {
      return readRowFromEnd(rest, width, true);
    }
  };
  // `10|`, `|10`: a `|` glued to a value, apart from it.
  const unglue = (toks: Token[]): Token[] => toks.flatMap((t) => {
    const m = t.t === "word" ? /^\|(.+)$|^(.+)\|$/.exec(t.v) : null;
    const v = m?.[1] ?? m?.[2];
    return v !== undefined && readValue(v) ? (m![1] !== undefined ? [{ t: "word", v: "|" }, { t: "word", v }] : [{ t: "word", v }, { t: "word", v: "|" }]) as Token[] : [t];
  });
  const noBars = (toks: Token[]) => unglue(toks).filter((t) => !(t.t === "word" && t.v === "|"));
  // A missing `series:` can't be what's meant when a row reads as written with exactly `width`
  // values, or from its end with a label word that is no value (`Galaxy S24 859 21`), or when two
  // rows share their first word while the labels read from their ends differ (`Sep 24 120`,
  // `Sep 25 135`). Then a label may end in a number (`iPhone 16 799 22` in a scatter).
  const strictOk = (line: Line) => {
    try {
      strict(line, tokenize(line));
      return true;
    } catch {
      return false;
    }
  };
  const failing = rest.filter((line) => !strictOk(line)).map((line) => tokenize(line));
  const fromEnd = failing.map((toks) => readRowFromEnd(noBars(toks), width, true));
  const heads = failing.flatMap((toks) => (toks[0]?.t === "word" ? [toks[0].v] : []));
  const labels = fromEnd.flatMap((r) => (r ? [r.label] : []));
  const widthSettled =
    failing.length < rest.length ||
    failing.some((toks) => readRowFromEnd(noBars(toks), width, false) !== null) ||
    (new Set(heads).size < heads.length && labels.length === failing.length && new Set(labels).size === labels.length);
  // A tone on a row of several series: that row marked in that tone, after the fence's own marks.
  const toned: { key: string; tone: Tone }[] = [];
  // Each row's values' units, by row index.
  const valueUnits: (string | undefined)[][] = [];
  for (const line of rest) {
    const all = tokenize(line);
    let row: RowRead;
    try {
      row = strict(line, all);
    } catch (e) {
      // Today's reading refuses the row: the one other reading, or today's error.
      const lenient = e instanceof VisError ? (readRowFromEnd(noBars(all), width, widthSettled) ?? labelBeforeBar(line, unglue(all))) : null;
      if (!lenient) throw e;
      row = lenient;
    }
    const { label, vals } = row;
    let tone = row.tone;
    for (const unit of row.units) if (unit) rowUnits.push({ unit, n: line.n });
    if (spec.type === "scatter" && vals.includes(null)) fail(line.n, "a scatter point needs both x and y");
    if (spec.type === "parts" && vals.includes(null)) fail(line.n, "a part needs a number: leave out a part that has none");
    if (spec.type === "parts" && vals[0]! < 0) fail(line.n, "a part can't be negative");
    if (tone && width > 1 && spec.type !== "scatter") {
      toned.push({ key: String(spec.rows.length), tone });
      tone = undefined;
    }
    if (spec.scale === "log" && vals.some((v) => v !== null && v <= 0)) fail(line.n, "scale: log needs values above 0");
    spec.rows.push({ label: text(label, line.n), values: vals, ...(tone ? { tone } : {}) });
    valueUnits.push(row.units);
  }
  // The rows' units agree: one unit, the chart's (a currency is always fine beside `unit:`).
  const distinct = [...new Set(rowUnits.map((u) => u.unit))];
  const mixed = (a: string, b: string, n: number): void => {
    // Sizes or durations draw in one of them, converted (§chat.markdown/vis-lenience-content); a
    // value with no unit then must be in `unit:`'s, so with no `unit:` every value needs one.
    const fam = spec.type === "scatter" ? null : unitFamily(distinct, spec.unit);
    const bare = spec.rows.some((r, i) => r.values.some((v, j) => v !== null && valueUnits[i]![j] === undefined));
    if (!fam || (spec.unit === undefined && bare)) fail(n, `mixed units ${a} and ${b}: write every value in one unit`);
    spec.rows.forEach((r, i) => {
      r.values = r.values.map((v, j) => {
        const u = valueUnits[i]![j];
        return v === null || u === undefined ? v : Number(((v * fam!.factor(u)) / fam!.target).toPrecision(12));
      });
    });
    spec.unit ??= fam!.unit;
  };
  if (distinct.length > 1) mixed(distinct[0]!, distinct[1]!, rowUnits.find((u) => u.unit === distinct[1])!.n);
  else if (distinct.length === 1) {
    const u = distinct[0]!;
    if (spec.unit === undefined) spec.unit = u;
    else if (!/^[$€£¥]$/.test(u) && !unitWords(spec.unit.toLowerCase()).includes(u.toLowerCase())) mixed(spec.unit, u, rowUnits[0]!.n);
  }
  if (spec.rows.length === 0) fail(0, spec.type === "parts" ? 'nothing to draw: add parts like "System prompt" 9000' : 'nothing to draw: add rows like "Quicksort" 120');
  if (spec.type === "parts") {
    if (spec.rows.length > MAX_PARTS) fail(0, `${spec.rows.length} parts; at most ${MAX_PARTS}: fold the small ones into one`);
    const total = spec.rows.reduce((a, r) => a + r.values[0]!, 0);
    // Parts past `of:` draw as if it were absent (what the guide asks for then), with a warning.
    if (spec.of !== undefined && total > spec.of) {
      warn(values.get("of")!.n, `the parts add up to ${total}, more than of: ${spec.of}: drawn without of:`);
      delete spec.of;
    }
    if (total === 0) fail(0, "the parts add up to 0: nothing to split");
  }
  if (spec.rows.length > MAX_ROWS) fail(0, `${spec.rows.length} rows; at most ${MAX_ROWS}`);
  if (spec.type === "stacked" && spec.scale === "log") fail(values.get("scale")!.n, "stacked bars can't use scale: log (the segments' lengths would lie); use grouped bars");
  if (spec.type === "stacked" && spec.rows.some((r) => r.values.some((v) => v !== null && v < 0))) fail(0, "stacked bars need values of 0 or more");
  applyMarks(spec, marks, byIdOrLabel(spec.rows.map((r, i) => ({ key: String(i), label: r.label }))), "row");
  const marked = new Set((spec.emphasis ?? []).map((e) => e.key));
  const extra = toned.filter((t) => !marked.has(t.key));
  if (extra.length) spec.emphasis = [...(spec.emphasis ?? []), ...extra];
  return spec;
}

