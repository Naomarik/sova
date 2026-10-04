// What the sidebar reads off the session feed's `llm_inflight` frame: no longer the calls in
// flight (the sidebar's figure is the working count, src/lib/work-now.ts), but the token ring
// that rides it — the output-token velocity: a 5-minute figure over a 30-minute chart
// (§app.insights/token-velocity). Pure presentation: the foot's Agents row, the phone bar and the
// spine tally all read `tokenVelocityView`, so the three can't disagree. No Solid here, so the
// tests run it bare.

import type { LlmInflight, LlmTokens } from "../../shared/protocol";

/** The windows, in minutes: the readout's (5) and the chart's, with its dashed mean (30). */
export const VELOCITY_WINDOWS = [5, 30] as const;
const LONGEST = 30;
/** The chart's floor: a scale never below this many tokens a minute, so a trickle stays low. */
export const VELOCITY_SCALE_FLOOR = 10_000;
/** The chart's slots: the ring's whole 30 minutes. */
export const VELOCITY_SLOTS = 60;

export type TokenVelocityState = "complete" | "partial" | "unknown";

export interface TokenVelocityView {
  state: TokenVelocityState;
  /** Output tokens a minute over each window, in `VELOCITY_WINDOWS`' order; null while unknown. */
  perMinute: number[] | null;
  /** The 5-minute mean, dense (`48k`), bare whatever the state; `–` while unknown. */
  readout: string;
  /** Each of the last 60 slots as a per-minute rate (its tokens × slots a minute), oldest first,
      the current slot last; all 0 while unknown. */
  series: number[];
  /** The 30-minute mean, the chart's dashed line; 0 while unknown. */
  mean30: number;
  /** The chart's full height in tokens a minute: the larger of the floor and the series' peak. */
  scale: number;
  /** The title/aria-label sentence, ending in a full stop. */
  sentence: string;
  /** The ring holds a token in its last 30 minutes by `now`: only then does the sidebar tick. */
  active: boolean;
  /** A slot's length in ms, and the epoch slot `now` fell in (the series' last): what the scrub
      card's time span is read from, so it can't disagree with the chart at a slot boundary. */
  slotMs: number;
  slot: number;
}

/**
 * A count in as few characters as it can say honestly: under 1,000 the whole number (`840`),
 * 1,000–9,999 one decimal (`8.4k`), 10,000 up no decimal (`48k`), a million up one decimal
 * (`1.2M`). Rounded to the whole token first; a figure that rounds up into the next tier is
 * printed in that tier (`9,999` → `10k`, `999,999` → `1.0M`).
 */
export function denseCount(n: number): string {
  const r = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (r < 1000) return `${r}`;
  if (Math.round(r / 100) < 100) return `${(Math.round(r / 100) / 10).toFixed(1)}k`;
  if (Math.round(r / 1000) < 1000) return `${Math.round(r / 1000)}k`;
  return `${(Math.round(r / 100_000) / 10).toFixed(1)}M`;
}

/** The ring's slot `s`, 0 outside it (after its newest: nothing landed yet; before its oldest: gone). */
function slot(t: LlmTokens, s: number): number {
  const i = t.out.length - 1 - (t.end - s);
  if (i < 0 || i >= t.out.length) return 0;
  const v = t.out[i];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** A ring the view can read: anything else is unknown, never a guessed 0. */
const usable = (t: LlmTokens | undefined): t is LlmTokens =>
  !!t && Number.isFinite(t.bucketMs) && t.bucketMs > 0 && Number.isFinite(t.end) && Array.isArray(t.out);

/** The output-token means at `now` (epoch ms): for W minutes, the slots in (cur − W·60s/slot, cur]
    summed and divided by W, `cur` being the slot `now` falls in. */
export function tokenVelocityView(inflight: LlmInflight | null, now: number): TokenVelocityView {
  const t = inflight?.tokens;
  if (!usable(t)) {
    const series = Array.from({ length: VELOCITY_SLOTS }, () => 0);
    const slotMs = 30_000;
    return { state: "unknown", perMinute: null, readout: "–", series, mean30: 0, scale: VELOCITY_SCALE_FLOOR, sentence: "Output tokens a minute: not known yet.", active: false, slotMs, slot: Math.floor(now / slotMs) };
  }
  const cur = Math.floor(now / t.bucketMs);
  const perSlotMin = 60_000 / t.bucketMs;
  const sumBack = (slots: number) => {
    let sum = 0;
    for (let s = cur - slots + 1; s <= cur; s++) sum += slot(t, s);
    return sum;
  };
  const perMinute = VELOCITY_WINDOWS.map((w) => sumBack(Math.round(w * perSlotMin)) / w);
  const active = sumBack(Math.round(LONGEST * perSlotMin)) > 0;
  const series = Array.from({ length: VELOCITY_SLOTS }, (_, i) => slot(t, cur - (VELOCITY_SLOTS - 1) + i) * perSlotMin);
  const [a, c] = perMinute.map(denseCount);
  // The ring says its own coverage: the calls count's gaps are about calls, not tokens.
  const floor = t.partial === true;
  const sentence =
    `Output tokens a minute: ${floor ? "at least " : ""}${a} over the last ${VELOCITY_WINDOWS[0]} minutes, ${c} over ${VELOCITY_WINDOWS[1]}.` +
    `${floor ? " Some calls' tokens can't be seen." : ""} Replies still being written aren't counted yet.`;
  return {
    state: floor ? "partial" : "complete",
    perMinute,
    readout: a!,
    series,
    mean30: perMinute[1]!,
    scale: Math.max(VELOCITY_SCALE_FLOOR, ...series),
    sentence,
    active,
    slotMs: t.bucketMs,
    slot: cur,
  };
}

/** One chart column as the scrub card reads it out (§app.insights/velocity-scrub). */
export interface VelocityColumnReading {
  /** Its span, epoch ms: from its oldest slot's start to its newest slot's end. */
  from: number;
  to: number;
  /** The mean rate of its slots, tokens a minute, and the tokens they hold. */
  perMinute: number;
  tokens: number;
  /** It holds the newest minute, whose replies are still landing (the chart draws it hollow). */
  hollow: boolean;
  /** Its rate ÷ the 30-minute mean; null with no mean to compare with. */
  vsMean: number | null;
  /** The ring is partial: the rate is a floor. */
  partial: boolean;
}

/**
 * Column `index` of the chart `velocityChart` draws from the same view (`group` slots a column,
 * oldest 0), or null while the ring is unknown or for an index off the chart. Read from the view
 * alone, so the card and the chart can't disagree.
 */
export function velocityColumnAt(v: TokenVelocityView, group: 2 | 4, index: number): VelocityColumnReading | null {
  const count = Math.floor(v.series.length / group);
  if (v.state === "unknown" || !Number.isInteger(index) || index < 0 || index >= count) return null;
  let rate = 0;
  for (let j = 0; j < group; j++) rate += v.series[index * group + j] ?? 0;
  const perMinute = rate / group;
  const minutes = (group * v.slotMs) / 60_000;
  const first = v.slot - (v.series.length - 1) + index * group;
  return {
    from: first * v.slotMs,
    to: (first + group) * v.slotMs,
    perMinute,
    tokens: Math.round(perMinute * minutes),
    hollow: (count - 1 - index) * group < 2,
    vsMean: v.mean30 > 0 ? perMinute / v.mean30 : null,
    partial: v.state === "partial",
  };
}

/** A local time on the 24-hour clock, `14:06`; seconds only off the minute, `14:06:30`. */
function clock24(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.getSeconds() ? `${hm}:${two(d.getSeconds())}` : hm;
}

/** The scrub card's three lines: the span (`14:06–14:07`, the hollow column `Now`), the rate
    (`38k`, `at least` while partial) and a caption comparing it with the 30-minute mean. */
export function velocityScrubCard(r: VelocityColumnReading): { span: string; atLeast: boolean; figure: string; caption: string } {
  let caption: string;
  if (r.hollow) caption = "Still landing — replies in progress";
  else if (!(r.tokens > 0) || r.vsMean === null) caption = "No output";
  else caption = `${r.vsMean < 0.1 ? "<0.1" : r.vsMean.toFixed(1)}× the 30-min average`;
  return {
    span: r.hollow ? "Now" : `${clock24(r.from)}–${clock24(r.to)}`,
    atLeast: r.partial,
    figure: denseCount(r.perMinute),
    caption,
  };
}

/** The column under `x` pixels from the chart's left edge at `pitch`: clamped to the first and the
    last, so the pixels the pitch leaves over pick the newest; null for a chart with no columns. */
export function columnAtX(x: number, pitch: number, count: number): number | null {
  if (!(count > 0) || !(pitch > 0) || !Number.isFinite(x)) return null;
  return Math.max(0, Math.min(count - 1, Math.floor(x / pitch)));
}

export interface VelocityColumn {
  /** Left to right, 0 the oldest. */
  index: number;
  /** Whole pixels above the baseline: at least 2 for any tokens at all, so light load reads as
      low blocks; a column with none isn't drawn. */
  height: number;
  /** Its slots include the newest minute's two, whose replies are still landing: drawn hollow. */
  hollow: boolean;
}

/** The shortest column with tokens in it, in pixels; the hollow one's, the least an outline needs
    to show its hollow. */
const MIN_COLUMN = 2;
const MIN_HOLLOW = 4;

/**
 * The chart's columns at `height` pixels (the baseline's 1px included): `group` slots a column (2
 * on the Agents row, 30 one-minute columns; 4 on the phone bar, 15 two-minute columns), each the
 * mean rate of its slots on `scale`, `height − 2` pixels full. `meanY` is the dashed line's y,
 * null with no mean.
 */
export function velocityChart(v: Pick<TokenVelocityView, "series" | "scale" | "mean30">, group: 2 | 4, height: number): { columns: VelocityColumn[]; meanY: number | null; count: number } {
  const count = Math.floor(v.series.length / group);
  const room = height - 2;
  const columns: VelocityColumn[] = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < group; j++) sum += v.series[i * group + j] ?? 0;
    if (!(sum > 0)) continue;
    const hollow = (count - 1 - i) * group < 2;
    const h = Math.max(hollow ? MIN_HOLLOW : MIN_COLUMN, Math.round((sum / group / v.scale) * room));
    columns.push({ index: i, height: Math.min(h, room), hollow });
  }
  const meanY = v.mean30 > 0 ? height - 1 - Math.min(room, Math.round((v.mean30 / v.scale) * room)) : null;
  return { columns, meanY, count };
}

/**
 * The row chart's geometry at its line's `width`: one whole-pixel pitch for every column (the
 * width ÷ `count` rounded down, never under 3), a 2px gap from a 5px pitch and 1px under it, so
 * no column is a pixel wider than its neighbour. `width` is the chart's own, `pitch × count`.
 */
export function velocityPitch(available: number, count: number): { pitch: number; gap: number; width: number } {
  const pitch = Math.max(3, Math.floor((Number.isFinite(available) ? available : 0) / count));
  return { pitch, gap: pitch >= 5 ? 2 : 1, width: pitch * count };
}

/** Whether two pushed frames read the same, so an unchanged frame doesn't wake the sidebar. */
export function sameInflight(a: LlmInflight | null, b: LlmInflight | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.count === b.count &&
    a.approximate === b.approximate &&
    a.partial === b.partial &&
    JSON.stringify(a.gaps) === JSON.stringify(b.gaps) &&
    JSON.stringify(a.tokens ?? null) === JSON.stringify(b.tokens ?? null)
  );
}
