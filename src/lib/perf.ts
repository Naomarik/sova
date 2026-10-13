// Measured model speed and thinking time: the reply hover's lines and the Agents page's Performance
// tab (#/agents/performance), its address and the pure shaping of what the usage helper answers.
// The speed rule itself is shared/usage/perf.ts's. Nothing here touches the DOM.

import { PERF_EFFORT_ORDER, PERF_MIN_RANGE, type PerfBin, type PerfFigure, type PerfFigures, type PerfModelRow, type ReplyTiming, replySpeeds } from "../../shared/usage/perf";
import { type CostsQuery, costsSearch, parseCostsQuery } from "./cost-history";
import { tokens } from "./project-overseer-view";

// ---- the address ----

/** The tab's address: `#/agents/performance`, and the Costs tab's filter words after `?`. */
export function perfHref(q?: CostsQuery): string {
  const s = q ? costsSearch(q) : "";
  return s ? `#/agents/performance?${s}` : "#/agents/performance";
}

/** The Performance tab's query if `hash` is its address, else null. `#/agents/performance/…` is not it. */
export function perfRouteFromHash(hash: string): CostsQuery | null {
  const m = /^#\/agents\/performance(?:\?(.*))?$/.exec(hash);
  return m ? parseCostsQuery(m[1] ?? "") : null;
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

// ---- one reply: the hover ----

export interface ReplyCardLine {
  label: string;
  value: string;
  /** A short note the line carries in words (never only on hover). */
  note?: string;
}

/**
 * The reply hover's lines, in order: effort, overall speed, tokens, thinking, reply, first token.
 * A part too short for a speed, or one whose tokens the provider doesn't split out, shows its time.
 * Thinking is left out when the reply didn't think.
 */
export function replyCardLines(t: ReplyTiming): ReplyCardLine[] {
  const sp = replySpeeds(t);
  const lines: ReplyCardLine[] = [];
  if (t.effort) lines.push({ label: "Effort", value: t.effort });
  lines.push({ label: "Overall", value: sp.overall !== undefined ? tpsWord(sp.overall) : msWord(t.thinkingMs + t.replyMs) });
  lines.push({ label: "Tokens", value: tokens(t.output) });
  if (t.thinkingMs > 0) lines.push({ label: "Thinking", value: sp.thinking !== undefined ? tpsWord(sp.thinking) : msWord(t.thinkingMs) });
  lines.push({ label: "Reply", value: sp.reply !== undefined ? tpsWord(sp.reply) : msWord(t.replyMs) });
  lines.push({ label: "First token", value: `after ${msWord(t.ttftMs)}` });
  return lines;
}

/** The card's one-line summary for a screen reader: "Effort high, overall 84 tok/s, …". */
export function replyCardSummary(t: ReplyTiming): string {
  return replyCardLines(t)
    .map((l) => `${l.label} ${l.value}`)
    .join(", ");
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

// ---- the tab ----

/** Whether a figure shows a range and a chart: enough replies, and the server sent them. */
export const showsRange = (f: PerfFigure) => f.n >= PERF_MIN_RANGE && f.p10 !== undefined && f.p90 !== undefined;

/** The effort levels in their own order, unknown ones after (the server sorts too; this keeps it). */
export function byEffort<T extends { effort: string }>(rows: readonly T[]): T[] {
  const at = (e: string) => {
    const i = PERF_EFFORT_ORDER.indexOf(e);
    return i < 0 ? PERF_EFFORT_ORDER.length : i;
  };
  return [...rows].sort((a, b) => at(a.effort) - at(b.effort) || a.effort.localeCompare(b.effort));
}

/** Most replies first; ties by provider, then model. */
export function byReplies(rows: readonly PerfModelRow[]): PerfModelRow[] {
  return [...rows].sort((a, b) => b.replies - a.replies || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** "40%": how often a group's replies thought. */
export function thoughtShare(f: Pick<PerfFigures, "replies" | "thought">): string {
  return f.replies ? `${Math.round((f.thought / f.replies) * 100)}%` : "—";
}

/** A figure in words: the median, then what it rests on. `unit` formats one value. */
export interface FigureWords {
  /** The headline: the median, or "—". */
  main: string;
  /** One short line each: "avg 80 tok/s", "10–90% 60–110 tok/s". */
  details?: string[];
  /** A sentence that may wrap: why it's a dash (the provider can't give it, no reply was long
      enough yet), or "3 replies, too few for a range". */
  reason?: string;
}

/** `unit` formats one value with its unit; `bare`, the low end of a range ("60–110 tok/s"). */
export function figureWords(f: PerfFigure, unit: (v: number) => string, opts: { mean?: boolean; slow?: boolean; bare?: (v: number) => string } = {}): FigureWords {
  if (f.unsupported) return { main: "—", reason: f.unsupported };
  if (!f.n || f.median === undefined) return { main: "—", reason: "No reply long enough yet" };
  const main = unit(f.median);
  if (!showsRange(f)) return { main, reason: `${repliesWord(f.n)}, too few for a range` };
  const parts: string[] = [];
  if (opts.mean && f.mean !== undefined) parts.push(`avg ${unit(f.mean)}`);
  if (opts.slow) parts.push(`slow ${unit(f.p90!)}`);
  else parts.push(`10–90% ${(opts.bare ?? unit)(f.p10!)}–${unit(f.p90!)}`);
  return { main, details: parts };
}

/** A time range's low end without its unit when both ends say seconds: "1.4–10 s", not "1.4 s–10 s". */
export const msBare = (hi: number | undefined) => (v: number) => {
  const w = msWord(v);
  return hi !== undefined && v >= 1000 && hi >= 1000 && hi < 59_500 && w.endsWith(" s") ? w.slice(0, -2) : w;
};

/** A bare number for a range's ends: "84", "4.2", "1,240". */
export const tpsNum = (v: number) => tpsWord(v).replace(" tok/s", "");

/** Bar heights for a spread chart, each a share of the tallest bin. */
export function binShares(bins: readonly PerfBin[]): number[] {
  const max = Math.max(0, ...bins.map((b) => b.n));
  return bins.map((b) => (max > 0 ? b.n / max : 0));
}

/** The empty tab's title. Before any reply was ever measured it says so; after, it names the range
    and the filters, so an empty range never reads as no data at all. */
export function perfEmptyTitle(q: CostsQuery, everMeasured: boolean): string {
  if (!everMeasured) return "No measured replies yet.";
  const span = q.range === "7d" ? "in the last 7 days" : q.range === "30d" ? "in the last 30 days" : "yet";
  return q.providers.length || q.models.length ? `No measured replies ${span} with these filters.` : `No measured replies ${span}.`;
}
