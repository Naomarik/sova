// Measured model speed and thinking time: the reply card and the Agents page's Performance tab
// (#/agents/performance), its address and the pure shaping of what the usage helper answers.
// The speed rule itself is shared/usage/perf.ts's. Nothing here touches the DOM.

import {
  didThink,
  PERF_ALL_TOOLS,
  PERF_BINS,
  PERF_EFFORT_ORDER,
  PERF_MIN_RANGE,
  PERF_MIN_TOKENS,
  PERF_NO_SPLIT,
  type PerfBin,
  type PerfEffortRow,
  type PerfFigure,
  type PerfFigures,
  type PerfModelRow,
  type ReplyTiming,
  replySpeeds,
} from "../../shared/usage/perf";
import { type CostsQuery, costsSearch, DEFAULT_COSTS_QUERY, parseCostsQuery } from "./cost-history";
import { tokens } from "./project-overseer-view";

// ---- the address ----

/** The By model card's order: most replies (the default), fastest overall, quickest first token. */
export type PerfSort = "replies" | "fastest" | "first-token";
export const PERF_SORTS: readonly { id: PerfSort; label: string }[] = [
  { id: "replies", label: "Most replies" },
  { id: "fastest", label: "Fastest" },
  { id: "first-token", label: "Quickest first token" },
];
const isSort = (v: string | null): v is PerfSort => PERF_SORTS.some((s) => s.id === v);

/** The tab's query: the Costs tab's range and filters, and the sort. */
export interface PerfQuery extends CostsQuery {
  sort: PerfSort;
}
export const DEFAULT_PERF_QUERY: PerfQuery = { ...DEFAULT_COSTS_QUERY, sort: "replies" };

/** The tab's address: `#/agents/performance`, then the Costs tab's filter words and `sort=` after
    `?`, defaults left out. */
export function perfHref(q?: CostsQuery & { sort?: PerfSort }): string {
  const p = new URLSearchParams(q ? costsSearch(q) : "");
  if (q?.sort && q.sort !== "replies") p.set("sort", q.sort);
  const s = p.toString();
  return s ? `#/agents/performance?${s}` : "#/agents/performance";
}

/** The Performance tab's query if `hash` is its address, else null. `#/agents/performance/…` is not
    it. An unknown sort falls to the default. */
export function perfRouteFromHash(hash: string): PerfQuery | null {
  const m = /^#\/agents\/performance(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const sort = new URLSearchParams(m[1] ?? "").get("sort");
  return { ...parseCostsQuery(m[1] ?? ""), sort: isSort(sort) ? sort : "replies" };
}

// ---- words ----

/** "84 tok/s", "4.2 tok/s", "1,240 tok/s". */
export function tpsWord(v: number): string {
  const n = v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  return `${n} tok/s`;
}

/** "640 ms", "1.8 s", "12 s", "2m 05s". */
export function msWord(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)} s`;
  if (s < 59.5) return `${Math.round(s)} s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  return `${m}m ${String(total - m * 60).padStart(2, "0")}s`;
}

export const repliesWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "reply" : "replies"}`;

const tokensWord = (n: number) => `${tokens(Math.round(n))} ${Math.round(n) === 1 ? "token" : "tokens"}`;

// ---- one reply: the card ----

/** The reply card: its effort, one headline, then the reply's parts in the order they happened. */
export interface ReplyCard {
  /** The level it ran at; absent when not recorded. */
  effort?: string;
  /** The overall speed ("Overall speed", "150 tok/s"), or, too short for one, its writing time
      ("Written in", "145 ms"): a time is never shown under a speed's label. `note` says what it
      rests on: "1.0k tokens, written in 10 s", "17 tokens, too few for a speed". */
  headline: { label: string; value: string; note: string };
  /** First token, Thinking (only when it thought), Reply. */
  parts: { label: string; value: string }[];
}

/**
 * The reply card. A part too short for a speed, or one whose tokens the provider doesn't split out,
 * shows its time. A reply with no overall speed wrote under 100 tokens (too few) or wrote them in
 * under 1 s (too quick).
 */
export function replyCard(t: ReplyTiming): ReplyCard {
  const sp = replySpeeds(t);
  const written = msWord(t.thinkingMs + t.replyMs);
  const headline =
    sp.overall !== undefined
      ? { label: "Overall speed", value: tpsWord(sp.overall), note: `${tokensWord(t.output)}, written in ${written}` }
      : { label: "Written in", value: written, note: `${tokensWord(t.output)}, ${t.output < PERF_MIN_TOKENS ? "too few" : "too quick"} for a speed` };
  const parts = [{ label: "First token", value: `after ${msWord(t.ttftMs)}` }];
  if (didThink(t)) parts.push({ label: "Thinking", value: sp.thinking !== undefined ? tpsWord(sp.thinking) : msWord(t.thinkingMs) });
  parts.push({ label: "Reply", value: sp.reply !== undefined ? tpsWord(sp.reply) : msWord(t.replyMs) });
  const out: ReplyCard = { headline, parts };
  if (t.effort) out.effort = t.effort;
  return out;
}

/** The card as one line for a screen reader, in the card's order: "Effort high. Overall speed 84
    tok/s, 1.0k tokens, written in 12 s. First token after 1.8 s, Thinking 12 s, Reply 8.1 s." */
export function replyCardSummary(t: ReplyTiming): string {
  const c = replyCard(t);
  const effort = c.effort ? `Effort ${c.effort}. ` : "";
  return `${effort}${c.headline.label} ${c.headline.value}, ${c.headline.note}. ${c.parts.map((p) => `${p.label} ${p.value}`).join(", ")}.`;
}

/** The entries whose reply was measured, and the one row per entry that shows the hover: its first
    reply-text row. `entryOf` unwraps a row id; `factOf` reads the row's `reply` fact. */
export function replyHovers<R extends { id: string; kind: string }>(
  rows: readonly R[],
  entryOf: (id: string) => string,
  factOf: (row: R) => ReplyTiming | undefined,
): Map<string, ReplyTiming> {
  const facts = new Map<string, ReplyTiming>();
  for (const r of rows) {
    const f = factOf(r);
    if (f) facts.set(entryOf(r.id), f);
  }
  const out = new Map<string, ReplyTiming>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "assistant-text") continue;
    const e = entryOf(r.id);
    if (seen.has(e)) continue;
    seen.add(e);
    const f = facts.get(e);
    if (f) out.set(r.id, f);
  }
  return out;
}

// ---- the tab: order ----

/** Whether a figure shows a range: 5 replies of its own, and the server sent the range. */
export const showsRange = (f: PerfFigure) => f.n >= PERF_MIN_RANGE && f.p10 !== undefined && f.p90 !== undefined;
/** Whether a figure draws a chart: a range, and bins to draw. */
export const showsChart = (f: PerfFigure) => showsRange(f) && !!f.bins?.length;

/** The effort levels in their own order, unknown ones after (the server sorts too; this keeps it). */
export function byEffort<T extends { effort: string }>(rows: readonly T[]): T[] {
  const at = (e: string) => {
    const i = PERF_EFFORT_ORDER.indexOf(e);
    return i < 0 ? PERF_EFFORT_ORDER.length : i;
  };
  return [...rows].sort((a, b) => at(a.effort) - at(b.effort) || a.effort.localeCompare(b.effort));
}

const byMost = (a: PerfModelRow, b: PerfModelRow) => b.replies - a.replies || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
/** `dir` 1: lowest first; -1: highest first. A row without the figure goes after every row with it. */
const byMedian = (pick: (r: PerfModelRow) => PerfFigure, dir: 1 | -1) => (a: PerfModelRow, b: PerfModelRow) => {
  const x = pick(a).median;
  const y = pick(b).median;
  if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1;
  return (x - y) * dir;
};

/** The rows in the picked order; ties fall to most replies, then provider and model. */
export function bySort(rows: readonly PerfModelRow[], sort: PerfSort): PerfModelRow[] {
  const first = sort === "fastest" ? byMedian((r) => r.overall, -1) : sort === "first-token" ? byMedian((r) => r.ttft, 1) : () => 0;
  return [...rows].sort((a, b) => first(a, b) || byMost(a, b));
}

// ---- the tab: a figure in words ----

/** "4 of 7 thought": how many of a group's replies thought. */
export const thoughtWords = (g: Pick<PerfFigures, "replies" | "thought">) => `${g.thought.toLocaleString("en-US")} of ${g.replies.toLocaleString("en-US")} thought`;

/** What a figure's own count counts, said under 5: "3 long enough for a speed", "4 thought",
    "4 counted" (thinking tokens), "2 replies". */
export type PerfCount = "speed" | "thought" | "counted" | "replies";
export function countWords(kind: PerfCount, n: number): string {
  const c = n.toLocaleString("en-US");
  return kind === "speed" ? `${c} long enough for a speed` : kind === "thought" ? `${c} thought` : kind === "counted" ? `${c} counted` : repliesWord(n);
}

/** The server's reasons (shared/usage/perf.ts) in 2–3 words, for a cell's muted line. */
const SHORT_REASONS: Record<string, string> = { [PERF_NO_SPLIT]: "not counted", [PERF_ALL_TOOLS]: "tool calls only" };
export const NO_REPLY_THOUGHT = "No reply thought";
export const NONE_LONG_ENOUGH = "No reply long enough yet";

/** A figure in a cell: the median and at most one short muted line under it. */
export interface FigureWords {
  /** The median, or "—". */
  main: string;
  /** The one muted line: a range or average from 5, the figure's own count under 5, or the 2–3 word
      reason a dash has. */
  sub?: string;
  /** A dash's reason in full, for a screen reader. */
  sr?: string;
  /** It rests on 5 replies of its own: a range (and, where the cell has one, a bar). */
  ranged: boolean;
}

/**
 * A figure in words. `unit` formats the median; `count` names what its own count counts; `detail`
 * gives the line from 5 replies (by default its 10–90% range, `end` formatting the range's ends).
 */
export function figureWords(
  f: PerfFigure,
  unit: (v: number) => string,
  opts: { count: PerfCount; detail?: (f: PerfFigure) => string; end?: (v: number) => string },
): FigureWords {
  if (f.unsupported) return { main: "—", sub: SHORT_REASONS[f.unsupported] ?? f.unsupported, sr: f.unsupported, ranged: false };
  if (!f.n || f.median === undefined) return { main: "—", sub: "too short yet", sr: NONE_LONG_ENOUGH, ranged: false };
  const main = unit(f.median);
  if (!showsRange(f)) return { main, sub: countWords(opts.count, f.n), ranged: false };
  return { main, sub: opts.detail ? opts.detail(f) : rangeWords(f, opts.end ?? unit), ranged: true };
}

/** A thinking figure of a group none of whose replies thought says that, never "too short". */
export function thinkingWords(g: Pick<PerfFigures, "thought">, f: PerfFigure, w: FigureWords): FigureWords {
  return g.thought === 0 && !f.unsupported ? { main: "—", sub: "none thought", sr: NO_REPLY_THOUGHT, ranged: false } : w;
}

/** "60 to 110": a figure's 10–90% range, each end in `end`. */
export const rangeWords = (f: PerfFigure, end: (v: number) => string) => `${end(f.p10!)} to ${end(f.p90!)}`;

/** A time range's low end without its unit when both ends say seconds: "1.4 to 10 s", not "1.4 s to 10 s". */
export const msBare = (hi: number | undefined) => (v: number) => {
  const w = msWord(v);
  return hi !== undefined && v >= 1000 && hi >= 1000 && hi < 59_500 && w.endsWith(" s") ? w.slice(0, -2) : w;
};
/** A time figure's range: "1.4 to 10 s", "400 ms to 3.0 s". */
export const msRange = (f: PerfFigure) => `${msBare(f.p90)(f.p10!)} to ${msWord(f.p90!)}`;

/** A bare number for a range's ends: "84", "4.2", "1,240". */
export const tpsNum = (v: number) => tpsWord(v).replace(" tok/s", "");
/** A token count: "820", "1.2k". */
export const tokensNum = (v: number) => tokens(Math.round(v));

// ---- the tab: bars and charts ----

/** The main row's shared scale: 0 to the highest overall-speed 90th percentile among the rows with a
    range of their own (0 when none has one). */
export function overallScale(rows: readonly PerfModelRow[]): number {
  return Math.max(0, ...rows.filter((r) => showsRange(r.overall)).map((r) => r.overall.p90!));
}

/** Where a value sits on a 0-to-`max` scale, 0..1. */
export const scaleAt = (v: number, max: number) => (max > 0 ? Math.min(1, Math.max(0, v / max)) : 0);

/** Bar heights for a spread chart, each a share of the fullest band. */
export function binShares(bins: readonly PerfBin[]): number[] {
  const max = Math.max(0, ...bins.map((b) => b.n));
  return bins.map((b) => (max > 0 ? b.n / max : 0));
}

/** A chart's axis: the whole model's bands, lowest to highest, on a log scale where it can be. */
export interface ChartAxis {
  lo: number;
  hi: number;
  log: boolean;
}

/** The axis a chart keeps at every level: the model's own figure's bins, so picking a level moves the
    bars and never re-scales them. Null when the model's figure has no bins. */
export function chartAxis(model: PerfFigure): ChartAxis | null {
  const bins = model.bins;
  if (!bins?.length) return null;
  const lo = bins[0]!.lo;
  const hi = bins[bins.length - 1]!.hi;
  return { lo, hi, log: lo > 0 && hi > lo };
}

/** Where a value sits on an axis, 0..1: one under it at 0, one over it at 1 (a 0 on a log axis at 0). */
export function axisAt(axis: ChartAxis, v: number): number {
  if (!(axis.hi > axis.lo)) return 0.5;
  const at = axis.log ? (v > 0 ? Math.log(v / axis.lo) / Math.log(axis.hi / axis.lo) : 0) : (v - axis.lo) / (axis.hi - axis.lo);
  return Math.min(1, Math.max(0, at));
}

/** A bar on a chart: its band, its place on the axis (0..1) and its height (a share of the fullest). */
export interface PlacedBin {
  bin: PerfBin;
  left: number;
  width: number;
  share: number;
}

/** Bins placed on an axis by their lo and hi. On a one-value axis (every value equal) the one bar sits
    at the middle. */
export function placeBins(bins: readonly PerfBin[], axis: ChartAxis): PlacedBin[] {
  const shares = binShares(bins);
  const one = 1 / PERF_BINS;
  return bins.map((bin, i) => {
    if (!(axis.hi > axis.lo)) return { bin, left: 0.5 - one / 2, width: one, share: shares[i]! };
    const left = axisAt(axis, bin.lo);
    return { bin, left, width: Math.max(0, axisAt(axis, bin.hi) - left), share: shares[i]! };
  });
}

/** Whether the opened row has a chart area: either of the model's chart figures has a chart of its
    own. `n` is the larger of their two counts, for the sentence that stands in when neither does. */
export function chartArea(row: Pick<PerfFigures, "thinkingMs" | "overall">): { show: boolean; n: number } {
  return { show: showsChart(row.thinkingMs) || showsChart(row.overall), n: Math.max(row.thinkingMs.n, row.overall.n) };
}

/** The sentence that stands in for the chart area. */
export const chartAreaGap = (n: number) => `Charts appear from ${PERF_MIN_RANGE} measured replies; this model has ${n.toLocaleString("en-US")}. Its medians are in the lines above.`;

/** A chart's head: "median 1.4 s · 10–90% 400 ms to 3.0 s · 12 replies". */
export const chartHead = (f: PerfFigure, unit: (v: number) => string, range: string) => `median ${unit(f.median!)} · 10–90% ${range} · ${repliesWord(f.n)}`;

/**
 * The one line a chart gives way to under 5 replies of its own: its median and its own count, then
 * that a chart needs 5 and, at a single level, that All levels pools them. A thinking chart where no
 * reply thought (`thought` 0) says only that.
 */
export function chartGap(o: { title: string; figure: PerfFigure; unit(v: number): string; count: PerfCount; level?: string; thought?: number }): string {
  if (o.thought === 0) return o.level ? "No reply at this level thought." : "No reply thought.";
  const f = o.figure;
  const what = f.unsupported
    ? `— · ${SHORT_REASONS[f.unsupported] ?? f.unsupported}`
    : !f.n || f.median === undefined
      ? "— · too short yet"
      : `median ${o.unit(f.median)} · ${countWords(o.count, f.n)}`;
  return `${o.title}: ${what}. A chart needs ${PERF_MIN_RANGE}.${o.level ? " All levels pools them." : ""}`;
}

// ---- the tab: what a row and its opened panel say ----

/** A model's main row, column by column; also each figure's one muted line. */
export function rowWords(g: PerfFigures) {
  return {
    overall: figureWords(g.overall, tpsWord, { count: "speed", detail: (f) => `avg ${tpsNum(f.mean!)}` }),
    reply: figureWords(g.reply, tpsWord, { count: "speed", end: tpsNum }),
    thinking: thinkingWords(g, g.thinkingMs, figureWords(g.thinkingMs, msWord, { count: "thought", detail: () => thoughtWords(g) })),
    ttft: figureWords(g.ttft, msWord, { count: "replies", detail: (f) => `slow ${msWord(f.p90!)}` }),
    /** The opened row's first line. */
    thinkingSpeed: thinkingWords(g, g.thinkingTps, figureWords(g.thinkingTps, tpsWord, { count: "speed", end: tpsNum })),
  };
}

/** One effort line: replies (said by the line itself), thinking per reply, thinking tokens, overall speed. */
export function levelWords(e: PerfFigures) {
  return {
    thinking: thinkingWords(e, e.thinkingMs, figureWords(e.thinkingMs, msWord, { count: "thought", detail: (f) => `avg ${msWord(f.mean!)} · ${msRange(f)}` })),
    tokens: thinkingWords(e, e.thinkingTokens, figureWords(e.thinkingTokens, tokensNum, { count: "counted" })),
    overall: figureWords(e.overall, tpsWord, { count: "speed", end: tpsNum }),
  };
}

/** One of the opened row's two charts at the picked level: drawn (its head, on the model's axis), or
    the one line it gives way to. */
export interface ChartSlot {
  title: string;
  /** The model's own figure: its bins are the axis at every level. */
  model: PerfFigure;
  /** The picked level's figure (All levels: the model's). */
  figure: PerfFigure;
  axis: ChartAxis | null;
  unit(v: number): string;
  /** Drawn: "median 1.4 s · 10–90% 400 ms to 3.0 s · 12 replies". */
  head?: string;
  /** Not drawn: the one line in its place. */
  line?: string;
}

/**
 * The opened row's chart area at the picked level (`level` null: All levels). Absent (`gap` set, no
 * slots) when neither of the model's chart figures has a chart of its own; otherwise the two slots,
 * each drawn or replaced on its own count.
 */
export function chartSlots(row: PerfModelRow, level: PerfEffortRow | null): { gap?: string; slots: ChartSlot[] } {
  const area = chartArea(row);
  if (!area.show) return { gap: chartAreaGap(area.n), slots: [] };
  const g: PerfFigures = level ?? row;
  const slot = (title: string, model: PerfFigure, figure: PerfFigure, unit: (v: number) => string, range: (f: PerfFigure) => string, count: PerfCount, thought?: number): ChartSlot => {
    const axis = chartAxis(model);
    const drawn = thought !== 0 && showsChart(figure) && axis !== null;
    return drawn
      ? { title, model, figure, axis, unit, head: chartHead(figure, unit, range(figure)) }
      : { title, model, figure, axis, unit, line: chartGap({ title, figure, unit, count, level: level?.effort, thought }) };
  };
  return {
    slots: [
      slot("Thinking time per reply", row.thinkingMs, g.thinkingMs, msWord, msRange, "thought", g.thought),
      slot("Overall speed (tok/s)", row.overall, g.overall, tpsNum, (f) => rangeWords(f, tpsNum), "speed"),
    ],
  };
}

/** The empty tab's title. Before any reply was ever measured it says so; after, it names the range
    and the filters, so an empty range never reads as no data at all. */
export function perfEmptyTitle(q: CostsQuery, everMeasured: boolean): string {
  if (!everMeasured) return "No measured replies yet.";
  const span = q.range === "7d" ? "in the last 7 days" : q.range === "30d" ? "in the last 30 days" : "yet";
  return q.providers.length || q.models.length ? `No measured replies ${span} with these filters.` : `No measured replies ${span}.`;
}
