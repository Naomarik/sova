// Usage burn (§app.insights/usage-burn): how fast a subscription window is going, how that
// compares with its last period and when it runs out at this pace, plus the card's words and its
// chart's axis, projection and readout. Pure and DOM-free: the server computes `UsageWindow.burn`
// with it (server/insights.ts), the Usage page words and draws it.
import type { UsageBalance, UsageBalanceBurn, UsageBurn, UsageHistoryPeriod, UsageHistoryPoint, UsageStripWindow, UsageWindow } from "../../shared/protocol";
import { clockTime, duration, shortDate, stampTime, thousands } from "./format";
import { liveWindow, money, windowSpan } from "./insights";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Under this share of the window gone, the rate is too young to say anything. */
export const MIN_SHARE = 0.05;
/** A rate over history (no span, or a balance) needs at least this much of it. */
export const MIN_HISTORY_MS = 6 * HOUR;
/** And looks back at most this far. */
export const WINDOW_LOOKBACK_MS = 7 * DAY;
export const BALANCE_LOOKBACK_MS = 14 * DAY;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type Span = { start: number; end: number };

/** The recent rate's span T for a window of length `len`: 1 hour under a day, 24 hours up to 8 days, 3 days beyond. */
export function recentSpanMs(len: number): number {
  if (len < DAY) return HOUR;
  if (len <= 8 * DAY) return DAY;
  return 3 * DAY;
}

/**
 * The percent at `t` along recorded points (time order): linear between two points, held after
 * the last; null before the first (nothing recorded yet).
 */
export function pctAt(points: readonly UsageHistoryPoint[], t: number): number | null {
  if (!points.length || t < points[0]!.t) return null;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (t > b.t) continue;
    const a = points[i - 1]!;
    return b.t === a.t ? b.pct : a.pct + ((b.pct - a.pct) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1]!.pct;
}

/** A recorded period's span: its readings' reset (and start, when they carry one), with the window's label length. */
export function periodSpan(label: string, period: { startsAt?: number; resetsAt?: number } | null): Span | null {
  if (!period || period.resetsAt === undefined) return null;
  return windowSpan({
    label,
    pct: 0,
    resetsAt: new Date(period.resetsAt).toISOString(),
    ...(period.startsAt !== undefined ? { startsAt: new Date(period.startsAt).toISOString() } : {}),
  });
}

/**
 * Whether a previous period counts as the last one: a window of a day or more needs it to have
 * ended within 10% of a span before this one began; a shorter one takes the previous recorded
 * window, whenever it was.
 */
export function lastPeriodCounts(span: Span, last: Span | null): boolean {
  const len = span.end - span.start;
  if (len < DAY) return true;
  return last !== null && last.end <= span.start + 0.1 * len && last.end >= span.start - 0.1 * len;
}

export interface BurnHistory {
  /** This period's recorded readings, in time order (empty when it has none yet). */
  current: readonly UsageHistoryPoint[];
  /** The previous period's, with its span when its readings say it; from its summary (tenths as points), its own final percent and 100% time too. */
  previous: { points: readonly UsageHistoryPoint[]; startsAt?: number; resetsAt?: number; final?: number; hitAt?: number } | null;
  /** The first recorded reading of this series and window. */
  since: number | null;
}

/**
 * A window's burn at `now`, or null when there is nothing to say: 0%, 100% or more, a ghost (its
 * reset has passed), under 5% of its span gone, or, with no span, under 6 hours of recorded
 * history or no rise in it.
 */
export function windowBurn(w: UsageWindow, now: number, h: BurnHistory, keys: { series: string; window: string }): UsageBurn | null {
  if (!(w.pct > 0) || w.pct >= 100 || !liveWindow(w, now)) return null;
  const since = h.since !== null ? { since: h.since } : {};
  const span = windowSpan(w);
  if (!span) {
    const first = h.current[0];
    if (!first) return null;
    const over = Math.min(WINDOW_LOOKBACK_MS, now - first.t);
    if (over < MIN_HISTORY_MS) return null;
    const from = pctAt(h.current, now - over);
    const rate = from === null ? 0 : (w.pct - from) / (over / HOUR);
    return rate > 0 ? { ...keys, rate, over, ...since } : null;
  }
  const len = span.end - span.start;
  const gone = now - span.start;
  if (gone <= 0 || gone / len < MIN_SHARE) return null;
  const share = gone / len;
  const rate = w.pct / (gone / HOUR);
  const runsOutAt = now + ((100 - w.pct) / rate) * HOUR;
  const out: UsageBurn = { ...keys, rate, ...(runsOutAt < span.end ? { runsOutAt: Math.round(runsOutAt) } : { atReset: w.pct / share }), ...since };
  const T = recentSpanMs(len);
  const first = h.current[0];
  if (first && first.t <= now - T) {
    const from = pctAt(h.current, now - T);
    if (from !== null) out.recent = { rate: Math.max(0, (w.pct - from) / (T / HOUR)), ms: T };
  }
  const prev = h.previous;
  if (prev && prev.points.length) {
    const lastSpan = periodSpan(w.label, prev);
    if (lastPeriodCounts(span, lastSpan)) {
      const points = prev.points;
      const hitAt = prev.hitAt ?? points.find((p) => p.pct >= 100)?.t;
      const at = lastSpan ? lastSpan.start + share * (lastSpan.end - lastSpan.start) : null;
      const byNow = at !== null ? pctAt(points, at) : null;
      out.last = { pct: prev.final ?? points[points.length - 1]!.pct, ...(hitAt !== undefined ? { hitAt } : {}), ...(byNow !== null ? { byNow } : {}) };
    }
  }
  return out;
}

/** A balance's burn: the spend per day since the last top-up (at most 14 days, at least 6 hours); null while it isn't going down. */
export function balanceBurn(b: UsageBalance, now: number, run: readonly { t: number; total: number }[], since: number | null): UsageBalanceBurn | null {
  const first = run[0];
  if (!first || b.total <= 0) return null;
  const over = Math.min(BALANCE_LOOKBACK_MS, now - first.t);
  if (over < MIN_HISTORY_MS) return null;
  const from = pctAt(run.map((r) => ({ t: r.t, pct: r.total })), now - over);
  const spent = from === null ? 0 : from - b.total;
  if (!(spent > 0)) return null;
  const perDay = spent / (over / DAY);
  return { perDay, over, daysLeft: b.total / perDay, ...(since !== null ? { since } : {}) };
}

// ---- Words -------------------------------------------------------------------------------------

/** A piece of a burn line: plain words, or a figure in mono. */
export type BurnPart = string | { mono: string };
export interface BurnLine {
  parts: BurnPart[];
  /** "Runs out": the projection reaches 100% before the reset. */
  chip?: string;
}

/** "Wed 10:48 PM": the app's clock with its weekday. */
export const weekdayTime = (t: number) => `${WEEKDAYS[new Date(t).getDay()]} ${clockTime(t)}`;

/** A span in words for "before reset": "1h 58m" under 2 hours, "19h" under 36, else "3 days". */
export function roughDuration(ms: number): string {
  if (ms < 2 * HOUR) return duration(Math.round(ms / 60_000) * 60_000);
  if (ms < 36 * HOUR) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)} days`;
}

/** "7 days", "9h": how much history a rate covers. */
export const overWords = (ms: number) => (ms >= 36 * HOUR ? `${Math.round(ms / DAY)} days` : `${Math.max(1, Math.round(ms / HOUR))}h`);

/** A figure with one decimal under 1, whole from 1: "16", "0.4". */
function figure(v: number): string {
  if (v >= 1) return thousands(Math.round(v));
  const one = Math.round(v * 10) / 10;
  return one > 0 ? String(one) : "<0.1";
}

/** Per hour for a window under a day, else per day. */
const perHour = (span: Span | null) => span !== null && span.end - span.start < DAY;

/** "≈16%/day", "≈21%/h". */
export function rateWords(ratePerHour: number, hourly: boolean): string {
  return hourly ? `≈${figure(ratePerHour)}%/h` : `≈${figure(ratePerHour * 24)}%/day`;
}

/** The window's period noun: week for a 7-day span, month for a monthly window, else window. */
export function periodNoun(w: UsageWindow, span: Span | null): "week" | "month" | "window" {
  if (w.label === "month") return "month";
  const len = span ? span.end - span.start : null;
  return len !== null && Math.abs(len - 7 * DAY) <= 0.05 * 7 * DAY ? "week" : "window";
}

/** "last hour", "last 24h", "last 3 days". */
const recentWords = (ms: number) => (ms === HOUR ? "last hour" : ms === DAY ? "last 24h" : `last ${overWords(ms)}`);

/** When something happens, in the window's own terms: a clock (with its date when not today) under a day, a weekday up to 8 days, else a date. */
function whenWords(t: number, span: Span, now: number): { word: "at" | "on"; text: string } {
  const len = span.end - span.start;
  if (len < DAY) return { word: "at", text: stampTime(t, now) };
  if (len <= 8 * DAY) return { word: "at", text: weekdayTime(t) };
  return { word: "on", text: shortDate(t, now) };
}

const capital = (parts: BurnPart[]): BurnPart[] => {
  const [head, ...rest] = parts;
  return typeof head === "string" ? [head.charAt(0).toUpperCase() + head.slice(1), ...rest] : parts;
};

/** Join groups of parts with " · ". */
function joined(groups: BurnPart[][]): BurnPart[] {
  const out: BurnPart[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(" · ");
    out.push(...g);
  });
  return out;
}

/**
 * A meter's burn lines: the rate and the projection first; with a run-out its chip ends that line
 * and a second line holds the recent rate and the last period; without one, the recent rate joins
 * the first line, and the last period does too unless a recent rate is there (then it is the
 * second line). A window with no span: the rate over its history, in uses when it counts them.
 */
export function burnLines(w: UsageWindow, now: number): BurnLine[] {
  const b = w.burn;
  if (!b) return [];
  const span = windowSpan(w);
  if (!span) {
    const uses = w.used !== undefined && w.limit !== undefined && w.limit > 0;
    const rate = uses ? `≈${figure((b.rate * 24 * w.limit!) / 100)} uses/day` : rateWords(b.rate, false);
    return [{ parts: [`${rate} over ${overWords(b.over ?? 0)} · no reset reported, so no run-out estimate`] }];
  }
  const hourly = perHour(span);
  const head: BurnPart[] = [rateWords(b.rate, hourly)];
  let chip: string | undefined;
  if (b.runsOutAt !== undefined) {
    const before = { mono: roughDuration(span.end - b.runsOutAt) };
    const when: BurnPart[] = hourly ? ["at this pace used up in ", { mono: roughDuration(b.runsOutAt - now) }] : ["at this pace used up ", { mono: whenWords(b.runsOutAt, span, now).text }];
    head.push(" · ", ...when, ", ", before, " before reset");
    chip = "Runs out";
  } else if (b.atReset !== undefined) {
    head.push(` · on pace for ${Math.round(b.atReset)}% at reset`);
  }
  const recent: BurnPart[] | null = b.recent ? [`${recentWords(b.recent.ms)} ${rateWords(b.recent.rate, hourly)}`] : null;
  let last: BurnPart[] | null = null;
  if (b.last) {
    const noun = `last ${periodNoun(w, span)}`;
    const by = b.last.byNow !== undefined ? ` (${Math.round(b.last.byNow)}% by this point)` : "";
    if (b.last.pct >= 100 && b.last.hitAt !== undefined) {
      const at = whenWords(b.last.hitAt, span, now);
      last = [`${noun} hit 100% ${at.word} `, { mono: at.text }, by];
    } else last = [`${noun} ${Math.round(b.last.pct)}%${by}`];
  }
  if (chip) {
    const second = [recent, last].filter((g): g is BurnPart[] => g !== null);
    return second.length ? [{ parts: head, chip }, { parts: capital(joined(second)) }] : [{ parts: head, chip }];
  }
  const first = joined([head, ...(recent ? [recent] : []), ...(!recent && last ? [last] : [])]);
  return recent && last ? [{ parts: first }, { parts: capital(last) }] : [{ parts: first }];
}

/** "≈$1.20/day over 14 days · about `15 days` left at this pace". */
export function balanceBurnLine(b: UsageBalance): BurnLine | null {
  const x = b.burn;
  if (!x) return null;
  const days = x.daysLeft < 1 ? "less than a day" : `${Math.round(x.daysLeft)} ${Math.round(x.daysLeft) === 1 ? "day" : "days"}`;
  return { parts: [`≈${money(x.perDay, b.currency)}/day over ${overWords(x.over)} · about `, { mono: days }, " left at this pace"] };
}

// ---- The chart ---------------------------------------------------------------------------------

/** A chart is drawn for a live window of a day or more with a known span. */
export function chartSpan(w: UsageWindow, now: number): Span | null {
  const span = windowSpan(w);
  return span && span.end - span.start >= DAY && liveWindow(w, now) && now < span.end ? span : null;
}

const monthly = (span: Span) => span.end - span.start > 8 * DAY;

/**
 * A window under a day (the 5-hour), by its own span or, idle with no reset, by its label: it gets
 * the strip of past windows, not a chart.
 */
export function shortSpan(w: UsageWindow): boolean {
  const span = windowSpan(w);
  return span !== null ? span.end - span.start < DAY : /^\d+[mh]( scoped)?$/.test(w.label);
}

export interface AxisLabel {
  t: number;
  text: string;
  /** Share of the span, 0..1. */
  x: number;
  align: "start" | "middle" | "end";
}

/** Rough width of an axis label in px (micro text), for culling the ones that would collide. */
const labelWidth = (text: string) => text.length * 6.2 + 4;

/**
 * The x axis: gridlines at each day from the window start (a monthly window: its quarters,
 * about a week apart), and labels on them, weekdays for a week, dates for a month, the last being
 * the reset (a week's with its time). At `width` px, a label that would overlap one already
 * placed is dropped; the start and the reset are placed first.
 */
export function chartAxis(span: Span, width: number): { grid: number[]; labels: AxisLabel[] } {
  const len = span.end - span.start;
  const month = monthly(span);
  const steps = month ? 4 : Math.max(1, Math.round(len / DAY));
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i++) ticks.push(i === steps ? span.end : span.start + (len * i) / steps);
  const grid = ticks.slice(1, -1).map((t) => (t - span.start) / len);
  const text = (t: number, i: number) => {
    if (month) return shortDate(t, span.start);
    return i === steps ? weekdayTime(t) : WEEKDAYS[new Date(t).getDay()]!;
  };
  const all: AxisLabel[] = ticks.map((t, i) => ({ t, text: text(t, i), x: (t - span.start) / len, align: i === 0 ? "start" : i === steps ? "end" : "middle" }));
  const order = [all[0]!, all[all.length - 1]!, ...all.slice(1, -1)];
  const placed: { from: number; to: number }[] = [];
  const kept = new Set<AxisLabel>();
  for (const l of order) {
    const w = labelWidth(l.text);
    const at = l.x * width;
    const from = l.align === "start" ? at : l.align === "end" ? at - w : at - w / 2;
    const box = { from, to: from + w };
    if (placed.some((p) => box.from < p.to + 6 && box.to > p.from - 6)) continue;
    placed.push(box);
    kept.add(l);
  }
  return { grid, labels: all.filter((l) => kept.has(l)) };
}

/** "now Mon 8:24 AM" (a month: "now Oct 12"). */
export const nowWords = (span: Span, now: number) => `now ${monthly(span) ? shortDate(now, now) : weekdayTime(now)}`;

/** The pointer's time on the readout: "Sun 2:30 PM", or "Oct 9" for a monthly window. */
export const readoutTime = (span: Span, t: number) => (monthly(span) ? shortDate(t, span.start) : weekdayTime(t));

/** The "at this pace" line: from now's reading to 100% at the run-out, or to the reset at the projected percent. */
export function projection(w: UsageWindow, span: Span, now: number): { from: UsageHistoryPoint; to: UsageHistoryPoint } | null {
  const b = w.burn;
  if (!b || (b.runsOutAt === undefined && b.atReset === undefined)) return null;
  return { from: { t: now, pct: w.pct }, to: b.runsOutAt !== undefined ? { t: b.runsOutAt, pct: 100 } : { t: span.end, pct: Math.min(100, b.atReset!) } };
}

/** The last period's points placed on this window's time axis by share of its span; empty when it doesn't count. */
export function alignedLast(span: Span, label: string, previous: { points: readonly UsageHistoryPoint[]; startsAt?: number; resetsAt?: number } | null): UsageHistoryPoint[] {
  if (!previous || !previous.points.length) return [];
  const last = periodSpan(label, previous);
  if (!last || !lastPeriodCounts(span, last)) return [];
  const len = span.end - span.start;
  const lastLen = last.end - last.start;
  const at = (t: number) => span.start + ((t - last.start) / lastLen) * len;
  const points = previous.points.filter((p) => p.t >= last.start && p.t <= last.end).map((p) => ({ t: at(p.t), pct: p.pct }));
  // The final reading holds to the period's end.
  const end = points[points.length - 1];
  if (end && end.t < span.end) points.push({ t: span.end, pct: end.pct });
  return points;
}

// ---- Past periods: the stepper and the 5-hour strip --------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A period's name on the stepper: "Week of Sep 25", "Month of Sep" (a month from the 1st), else "Sep 25 – Oct 25". */
export function periodTitle(w: UsageWindow, span: Span): string {
  const noun = periodNoun(w, span);
  if (noun === "week") return `Week of ${shortDate(span.start, span.start)}`;
  const start = new Date(span.start);
  if (noun === "month" && start.getDate() === 1 && start.getHours() === 0) return `Month of ${MONTHS[start.getMonth()]}`;
  return `${shortDate(span.start, span.start)} – ${shortDate(span.end, span.start)}`;
}

/** A past period's line: "hit 100% at `Wed 2:00 PM` · ≈12%/day", else "peaked at 81% · ≈12%/day". */
export function pastPeriodLine(p: UsageHistoryPeriod, span: Span, now: number): BurnLine {
  const rate = rateWords(p.rate ?? 0, perHour(span));
  if (p.hitAt !== undefined) {
    const at = whenWords(p.hitAt, span, now);
    return { parts: [`hit 100% ${at.word} `, { mono: at.text }, ` · ${rate}`] };
  }
  return { parts: [`peaked at ${Math.round(p.final ?? p.points[p.points.length - 1]?.pct ?? 0)}% · ${rate}`] };
}

/** On a past period, what the readout card says at `t`: its recorded percent, and the period before's at the same point. */
export function pastReadoutAt(span: Span, t: number, points: readonly UsageHistoryPoint[], before: readonly UsageHistoryPoint[], beforeNoun: string): { time: string; value: ReadoutValue; last: string | null } {
  const p = pctAt(points, t);
  const l = pctAt(before, t);
  return { time: readoutTime(span, t), value: p === null ? { kind: "unrecorded" } : { kind: "past", pct: p }, last: l === null ? null : `${beforeNoun} ${Math.round(l)}% by this point` };
}

/** The strip's bars: one pitch for all (width ÷ count, at least 3px, 1px gap), and the newest that fit. */
export function stripLayout(count: number, width: number): { pitch: number; bar: number; from: number } {
  const pitch = Math.max(3, Math.floor(width / Math.max(1, count)));
  const fit = Math.max(1, Math.floor(width / pitch));
  return { pitch, bar: pitch - 1, from: Math.max(0, count - fit) };
}

/** "Last 30 days · 47 windows · 6 hit 100%" (no hit count at 0). */
export function stripCaption(windows: readonly UsageStripWindow[]): string {
  const hit = windows.filter((w) => w.hitAt !== undefined || w.final >= 100).length;
  return `Last 30 days · ${windows.length} ${windows.length === 1 ? "window" : "windows"}${hit ? ` · ${hit} hit 100%` : ""}`;
}

/** The strip's readout for one window: its time range, final percent, ≈rate and 100% time. */
export function stripReadout(win: UsageStripWindow, now: number): { time: string; pct: number; rate: string; hit: string | null } {
  return {
    time: `${stampTime(win.startsAt, now)} – ${clockTime(win.resetsAt)}`,
    pct: Math.round(win.final),
    rate: rateWords(win.rate, true),
    hit: win.hitAt !== undefined ? clockTime(win.hitAt) : null,
  };
}

export type ReadoutValue = { kind: "past"; pct: number } | { kind: "pace"; pct: number } | { kind: "used-up" } | { kind: "unrecorded" };

/**
 * What the readout card says at time `t`: the recorded percent before now (null before the first
 * reading), the projected one after now, "used up" past the run-out; and the last period's
 * percent at the same point when it was recorded there.
 */
export function readoutAt(
  w: UsageWindow,
  span: Span,
  now: number,
  t: number,
  current: readonly UsageHistoryPoint[],
  last: readonly UsageHistoryPoint[],
  noun: string,
): { time: string; value: ReadoutValue; last: string | null } {
  let value: ReadoutValue;
  if (t <= now) {
    const p = pctAt([...current, { t: now, pct: w.pct }], t);
    value = p === null ? { kind: "unrecorded" } : { kind: "past", pct: p };
  } else if (w.burn?.runsOutAt !== undefined && t >= w.burn.runsOutAt) value = { kind: "used-up" };
  else if (w.burn) value = { kind: "pace", pct: Math.min(100, w.pct + w.burn.rate * ((t - now) / HOUR)) };
  else value = { kind: "unrecorded" };
  const l = pctAt(last, t);
  return { time: readoutTime(span, t), value, last: l === null ? null : `last ${noun} ${Math.round(l)}% by this point` };
}
