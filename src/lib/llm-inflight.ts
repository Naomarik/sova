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
    return { state: "unknown", perMinute: null, readout: "–", series, mean30: 0, scale: VELOCITY_SCALE_FLOOR, sentence: "Output tokens a minute: not known yet.", active: false };
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
  };
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
