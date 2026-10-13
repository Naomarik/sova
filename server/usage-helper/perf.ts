import {
  PERF_BINS,
  PERF_EFFORT_ORDER,
  PERF_MIN_RANGE,
  PERF_ALL_TOOLS,
  PERF_NO_SPLIT,
  didThink,
  replySpeeds,
  replyTokens,
  type PerfBin,
  type PerfEffortRow,
  type PerfFigure,
  type PerfFigures,
  type PerfModelRow,
  type ReplyTiming,
} from "../../shared/usage/perf";

/**
 * The Performance tab's figures over measured replies (shared/usage/perf.ts). Pure: the helper's
 * perf store (perf-store.ts) hands it the samples in range, already normalized.
 */

/** One measured reply as the figures read it. */
export interface PerfSample {
  provider: string;
  /** As the Costs rows name it (query.ts displayModel). */
  model: string;
  timing: ReplyTiming;
}

/**
 * A recorded reply's timing as the hover and the figures read it: `reasoning` dropped where the split
 * isn't real (a 0 count for a reply that had a thinking window is a count not reported, never "no
 * thinking"; the ollama-cloud case), and kept no larger than the output.
 */
export function normalizeTiming(t: ReplyTiming): ReplyTiming {
  const out: ReplyTiming = { ttftMs: nonneg(t.ttftMs), thinkingMs: nonneg(t.thinkingMs), replyMs: nonneg(t.replyMs), output: nonneg(t.output) };
  if (t.effort !== undefined) out.effort = t.effort;
  if (t.toolCalls !== undefined && t.toolCalls > 0) out.toolCalls = t.toolCalls;
  if (t.thinkingParts !== undefined && t.thinkingParts > 0) out.thinkingParts = t.thinkingParts;
  if (t.reasoning !== undefined && Number.isFinite(t.reasoning) && !(t.reasoning <= 0 && didThink(out))) out.reasoning = Math.min(out.output, Math.max(0, t.reasoning));
  return out;
}
const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** The p-th percentile (0..1) of sorted values, linearly interpolated. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Log-spaced bins over the values (at most PERF_BINS, lowest first); a value of 0 falls in the first. */
export function logBins(sorted: readonly number[]): PerfBin[] {
  if (!sorted.length) return [];
  const pos = sorted.filter((v) => v > 0);
  const min = pos.length ? pos[0]! : 0;
  const max = sorted[sorted.length - 1]!;
  if (!(max > min) || min <= 0) return [{ lo: sorted[0]!, hi: max, n: sorted.length }];
  const count = Math.min(PERF_BINS, Math.max(1, Math.ceil(Math.sqrt(sorted.length))));
  const ratio = Math.log(max / min) / count;
  const edges = Array.from({ length: count + 1 }, (_, i) => (i === count ? max : min * Math.exp(ratio * i)));
  const bins: PerfBin[] = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1]!, n: 0 }));
  for (const v of sorted) {
    const i = v <= min ? 0 : Math.min(count - 1, Math.floor(Math.log(v / min) / ratio));
    bins[i]!.n++;
  }
  return bins;
}

/** One figure over its values: median and mean always; a range and bins from PERF_MIN_RANGE values. */
export function figure(values: number[], unsupported?: string): PerfFigure {
  if (!values.length) return unsupported ? { n: 0, unsupported } : { n: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const out: PerfFigure = { n: sorted.length, median: percentile(sorted, 0.5), mean: sorted.reduce((s, v) => s + v, 0) / sorted.length };
  if (sorted.length >= PERF_MIN_RANGE) {
    out.p10 = percentile(sorted, 0.1);
    out.p90 = percentile(sorted, 0.9);
    out.bins = logBins(sorted);
  }
  return out;
}

/** A group's figures (shared/usage/perf.ts PerfFigures) over its replies' timings. */
export function figuresOf(timings: readonly ReplyTiming[]): PerfFigures {
  const overall: number[] = [];
  const reply: number[] = [];
  const thinkingTps: number[] = [];
  const thinkingMs: number[] = [];
  const thinkingTokens: number[] = [];
  const ttft: number[] = [];
  let thought = 0;
  let split = 0;
  let toolFree = 0;
  let counted = 0;
  for (const t of timings) {
    const s = replySpeeds(t);
    if (s.overall !== undefined) overall.push(s.overall);
    if (s.reply !== undefined) reply.push(s.reply);
    if (s.thinking !== undefined) thinkingTps.push(s.thinking);
    if (replyTokens(t) !== undefined) split++;
    if (!((t.toolCalls ?? 0) > 0)) toolFree++;
    ttft.push(t.ttftMs);
    if (didThink(t)) {
      thought++;
      thinkingMs.push(t.thinkingMs);
      if (t.reasoning !== undefined) {
        counted++;
        thinkingTokens.push(t.reasoning);
      }
    }
  }
  // A figure no reply could give: the provider counted no reply's thinking tokens.
  const noCount = thought > 0 && counted === 0 ? PERF_NO_SPLIT : undefined;
  return {
    replies: timings.length,
    thought,
    overall: figure(overall),
    // No reply could give a reply-text speed: every one wrote tool calls, or thought uncounted.
    reply: figure(reply, split > 0 ? undefined : toolFree === 0 ? PERF_ALL_TOOLS : PERF_NO_SPLIT),
    thinkingTps: figure(thinkingTps, noCount),
    thinkingMs: figure(thinkingMs),
    thinkingTokens: figure(thinkingTokens, noCount),
    ttft: figure(ttft),
  };
}

const effortRank = (e: string) => {
  const i = PERF_EFFORT_ORDER.indexOf(e);
  return i < 0 ? PERF_EFFORT_ORDER.length : i;
};

/** One row per provider+model (most replies first), each with one line per effort level that ran. */
export function performanceRows(samples: readonly PerfSample[]): PerfModelRow[] {
  const groups = new Map<string, { provider: string; model: string; all: ReplyTiming[]; byEffort: Map<string, ReplyTiming[]> }>();
  for (const s of samples) {
    const key = `${s.provider}/${s.model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { provider: s.provider, model: s.model, all: [], byEffort: new Map() }));
    g.all.push(s.timing);
    const effort = s.timing.effort ?? "unknown";
    let list = g.byEffort.get(effort);
    if (!list) g.byEffort.set(effort, (list = []));
    list.push(s.timing);
  }
  const rows: PerfModelRow[] = [];
  for (const g of groups.values()) {
    const efforts: PerfEffortRow[] = [...g.byEffort.entries()]
      .sort(([a], [b]) => effortRank(a) - effortRank(b) || a.localeCompare(b))
      .map(([effort, list]) => ({ effort, ...figuresOf(list) }));
    rows.push({ provider: g.provider, model: g.model, ...figuresOf(g.all), efforts });
  }
  return rows.sort((a, b) => b.replies - a.replies || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
