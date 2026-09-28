/** Axis helpers for `vis chart`: nice linear ticks, decade log ticks, and short number labels. */

export interface Scale {
  /** Value → px along the axis. */
  at(v: number): number;
  ticks: number[];
  min: number;
  max: number;
}

/** 1, 2, 2.5 or 5 × 10^k, the step nearest `raw` from above. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw - 1e-12) return m * mag;
  return 10 * mag;
}

/**
 * A linear scale over [lo, hi] mapped to [from, to] px, extended to whole ticks. Zero is always
 * included, so a bar's length is its value.
 */
export function linearScale(lo: number, hi: number, from: number, to: number, count = 5): Scale {
  let min = Math.min(0, lo);
  let max = Math.max(0, hi);
  if (min === max) max = min + 1;
  const step = niceStep((max - min) / count);
  min = Math.floor(min / step + 1e-9) * step;
  max = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  const at = (v: number) => from + ((v - min) / (max - min)) * (to - from);
  return { at, ticks, min, max };
}

/** A log10 scale over whole decades covering [lo, hi] (both > 0). */
export function logScale(lo: number, hi: number, from: number, to: number): Scale {
  const a = Math.floor(Math.log10(lo));
  let b = Math.ceil(Math.log10(hi));
  if (b === a) b = a + 1;
  const ticks: number[] = [];
  const stride = Math.ceil((b - a) / 6);
  for (let e = a; e <= b; e += stride) ticks.push(10 ** e);
  const min = 10 ** a;
  const max = 10 ** b;
  const at = (v: number) => from + ((Math.log10(v) - a) / (b - a)) * (to - from);
  return { at, ticks, min, max };
}

/** 1200 → "1.2k", 0.004 → "0.004", 3e9 → "3B". Keeps at most 3 significant digits. */
export function shortNumber(v: number): string {
  const abs = Math.abs(v);
  const trim = (n: number) => String(Number(n.toPrecision(3)));
  if (abs >= 1e12) return `${trim(v / 1e12)}T`;
  if (abs >= 1e9) return `${trim(v / 1e9)}B`;
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e4) return `${trim(v / 1e3)}k`;
  if (abs === 0) return "0";
  return trim(v);
}
