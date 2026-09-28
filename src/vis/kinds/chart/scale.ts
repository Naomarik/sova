/**
 * The chart's axes: a value → px mapping with nice ticks and their labels. Linear axes pick a 1, 2,
 * 2.5 or 5 × 10^k step for the pixels they have and label every tick with the same number of
 * decimals; log axes tick whole decades (1-2-5 inside a single decade) with unlabelled minor ticks.
 * Pure: layout.ts and the tests use it; no DOM.
 */

import { niceStep } from "../../core/scale";

export interface Axis {
  /** Value → px. */
  at(v: number): number;
  min: number;
  max: number;
  /** Labelled ticks, low to high. */
  ticks: number[];
  /** Unlabelled grid lines between ticks (log axes only). */
  minor: number[];
  log: boolean;
  /** The tick's label, formatted to the axis' precision. */
  fmt(v: number): string;
}

export interface LinearOptions {
  /** Keep 0 on the axis (bars: a bar's length is its value). Otherwise 0 is kept only when it's near the data. */
  zero?: boolean;
  /** About how many ticks; the step is the nice one nearest (hi - lo) / count. */
  count?: number;
}

/** How many ticks fit along `px` pixels, one per `gap`. */
export const tickCount = (px: number, gap: number) => Math.max(2, Math.min(8, Math.round(Math.abs(px) / gap)));

/** A linear axis over [lo, hi] mapped to [from, to] px, extended to whole steps. */
export function linearAxis(lo: number, hi: number, from: number, to: number, opts: LinearOptions = {}): Axis {
  let min = lo;
  let max = hi;
  // Zero anchors an axis whenever the data sits close enough to it that leaving it out would
  // exaggerate differences: bars always, lines and points when 0 is within half the span again.
  const span = max - min;
  if (opts.zero || (min >= 0 && min <= span * 0.5) || (max <= 0 && -max <= span * 0.5)) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const step = niceStep((max - min) / (opts.count ?? 5));
  min = Math.floor(min / step + 1e-9) * step;
  max = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; ; i++) {
    const v = clean(min + i * step);
    if (v > max + step / 2) break;
    ticks.push(v);
  }
  const at = (v: number) => from + ((v - min) / (max - min)) * (to - from);
  const fmt = tickFormat(step, Math.max(Math.abs(min), Math.abs(max)));
  return { at, min, max, ticks, minor: [], log: false, fmt };
}

/** A log10 axis over [lo, hi] (both > 0), widened to whole decades. */
export function logAxis(lo: number, hi: number, from: number, to: number, maxTicks = 6): Axis {
  const a = Math.floor(Math.log10(lo) + 1e-9);
  let b = Math.ceil(Math.log10(hi) - 1e-9);
  if (b === a) b = a + 1;
  const ticks: number[] = [];
  const minor: number[] = [];
  const decades = b - a;
  if (decades === 1) {
    // One decade: 1, 2, 5 labelled, the rest as minor lines.
    for (const m of [1, 2, 5, 10]) ticks.push(clean(m * 10 ** a));
    for (const m of [3, 4, 6, 7, 8, 9]) minor.push(clean(m * 10 ** a));
  } else {
    const stride = Math.ceil(decades / Math.max(1, maxTicks - 1));
    for (let e = a; e <= b; e++) {
      if ((e - a) % stride === 0 || e === b) ticks.push(clean(10 ** e));
      else minor.push(clean(10 ** e));
      if (stride === 1 && decades <= 4 && e < b) for (let m = 2; m <= 9; m++) minor.push(clean(m * 10 ** e));
    }
    // The top decade is always labelled; drop the one below it if the stride left them crowded.
    if (ticks.length > 2 && Math.log10(ticks[ticks.length - 1]!) - Math.log10(ticks[ticks.length - 2]!) < stride) ticks.splice(ticks.length - 2, 1);
  }
  const min = 10 ** a;
  const max = 10 ** b;
  const at = (v: number) => from + ((Math.log10(v) - a) / (b - a)) * (to - from);
  return { at, min, max, ticks, minor, log: true, fmt: logLabel };
}

/** Floating-point noise off a computed tick (0.1 + 0.2). */
const clean = (v: number) => Number(v.toPrecision(12));

const SUFFIX: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

/** Decimals needed to write `v` exactly (for a step: 0.25 → 2, 2.5 → 1, 50 → 0). */
export function decimalsOf(v: number): number {
  const s = String(clean(Math.abs(v)));
  const e = /e-(\d+)$/.exec(s);
  if (e) return Number(e[1]) + (s.split("e")[0]!.split(".")[1]?.length ?? 0);
  return s.split(".")[1]?.length ?? 0;
}

/**
 * Every tick on one axis reads alike: the same suffix (k, M…) and the same decimals, chosen from the
 * step. 0, 2.5k, 5k, 7.5k; 0, 0.25, 0.5.
 */
export function tickFormat(step: number, maxAbs: number): (v: number) => string {
  const [div, suffix] = maxAbs >= 1e4 ? SUFFIX.find(([d]) => maxAbs >= d)! : [1, ""];
  const decimals = Math.min(6, decimalsOf(step / div));
  return (v) => {
    const n = clean(v / div);
    if (n === 0) return "0";
    return `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(decimals)}${suffix}`;
  };
}

/** A log tick: 0.01, 1, 10, 1k, 100k, 1M. */
export function logLabel(v: number): string {
  if (v >= 1e3) {
    const [div, suffix] = SUFFIX.find(([d]) => v >= d)!;
    return `${clean(v / div)}${suffix}`;
  }
  return String(clean(v));
}

/** A data value as a label: at most 3 significant digits, k/M/B/T from 10k, a real minus sign. */
export function valueLabel(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  const trim = (n: number) => String(Number(n.toPrecision(3)));
  if (abs >= 1e4) {
    const [div, suffix] = SUFFIX.find(([d]) => abs >= d)!;
    return `${sign}${trim(abs / div)}${suffix}`;
  }
  if (abs === 0) return "0";
  return `${sign}${abs >= 100 ? String(Math.round(abs)) : trim(abs)}`;
}
