// Run: pnpm test -- src/lib/usage-burn.test.ts (bun test runs with TZ=UTC: the clock words below are UTC)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageBalance, UsageWindow } from "../../shared/protocol";
import {
  alignedLast,
  balanceBurn,
  balanceBurnLine,
  type BurnHistory,
  type BurnLine,
  burnLines,
  chartAxis,
  chartSpan,
  nowWords,
  pastPeriodLine,
  pastReadoutAt,
  pctAt,
  periodTitle,
  projection,
  readoutAt,
  recentSpanMs,
  roughDuration,
  shortSpan,
  stripCaption,
  stripLayout,
  stripReadout,
  windowBurn,
} from "./usage-burn";

const H = 3_600_000;
const D = 24 * H;
const keys = { series: "claude:acct", window: "7d" };
const none: BurnHistory = { current: [], previous: null, since: null };
const iso = (t: number) => new Date(t).toISOString();
/** A line as text, mono parts in backticks, its chip in brackets. */
const text = (l: BurnLine) => l.parts.map((p) => (typeof p === "string" ? p : `\`${p.mono}\``)).join("") + (l.chip ? ` [${l.chip}]` : "");

// The mock-up's 7-day window: resets Thu Oct 8 18:00, now Mon Oct 5 08:24 (day 4 of 7).
const START = Date.parse("2026-10-01T18:00:00Z");
const RESET = START + 7 * D;
const NOW = Date.parse("2026-10-05T08:24:00Z");
const week = (pct: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ label: "7d", pct, resetsAt: iso(RESET), ...extra });

test("window average: percent ÷ time gone; the run-out before the reset at that rate", () => {
  const b = windowBurn(week(58), NOW, none, keys)!;
  const gone = (NOW - START) / H;
  assert.equal(b.rate, 58 / gone);
  assert.equal(b.runsOutAt, Math.round(NOW + (42 / (58 / gone)) * H));
  assert.equal(b.atReset, undefined);
  assert.deepEqual(burnLines({ ...week(58), burn: b }, NOW).map(text), ["≈16%/day · at this pace used up `Wed 10:57 PM`, `19h` before reset [Runs out]"]);
});

test("on pace for N% at reset when 100% falls after it", () => {
  const b = windowBurn(week(12, { label: "7d scoped", scope: "Fable" }), NOW, none, keys)!;
  assert.equal(b.runsOutAt, undefined);
  assert.equal(Math.round(b.atReset!), 23);
  assert.deepEqual(burnLines({ ...week(12), burn: b }, NOW).map(text), ["≈3%/day · on pace for 23% at reset"]);
});

test("nothing to say: 0%, 100% or more, a ghost, or under 5% of the window gone", () => {
  assert.equal(windowBurn(week(0), NOW, none, keys), null);
  assert.equal(windowBurn(week(100), NOW, none, keys), null);
  assert.equal(windowBurn(week(40), RESET + 60_000, none, keys), null, "ghost: its reset has passed");
  const early = START + 0.04 * 7 * D;
  assert.equal(windowBurn(week(3), early, none, keys), null, "4% gone: too early");
  assert.ok(windowBurn(week(3), START + 0.06 * 7 * D, none, keys), "6% gone: says it");
  assert.deepEqual(burnLines(week(40), NOW), [], "no burn, no lines");
});

test("the recent rate's span: 1 hour under a day, 24 hours up to 8 days, 3 days beyond; only when history reaches back that far", () => {
  assert.equal(recentSpanMs(5 * H), H);
  assert.equal(recentSpanMs(7 * D), D);
  assert.equal(recentSpanMs(30 * D), 3 * D);
  const covered = windowBurn(week(58), NOW, { current: [{ t: START, pct: 0 }, { t: NOW - D, pct: 36 }, { t: NOW - H, pct: 58 }], previous: null, since: START }, keys)!;
  assert.deepEqual(covered.recent, { rate: 22 / 24, ms: D });
  assert.equal(covered.since, START);
  const short = windowBurn(week(58), NOW, { current: [{ t: NOW - 20 * H, pct: 40 }], previous: null, since: NOW - 20 * H }, keys)!;
  assert.equal(short.recent, undefined, "20 hours of history doesn't cover 24");
});

test("the last period: its final percent and where it stood at the same share; with a run-out the second line holds both", () => {
  const prevStart = START - 7 * D;
  const share = (NOW - START) / (7 * D);
  const h: BurnHistory = {
    current: [{ t: START, pct: 0 }, { t: NOW - D, pct: 36 }],
    previous: { resetsAt: START, points: [{ t: prevStart + H, pct: 1 }, { t: prevStart + share * 7 * D, pct: 40 }, { t: START - H, pct: 81 }] },
    since: prevStart + H,
  };
  const b = windowBurn(week(58), NOW, h, keys)!;
  assert.deepEqual(b.last, { pct: 81, byNow: 40 });
  assert.deepEqual(burnLines({ ...week(58), burn: b }, NOW).map(text), [
    "≈16%/day · at this pace used up `Wed 10:57 PM`, `19h` before reset [Runs out]",
    "Last 24h ≈22%/day · last week 81% (40% by this point)",
  ]);
  // One that hit 100% says when.
  const hit = windowBurn(week(58), NOW, { ...h, previous: { resetsAt: START, points: [{ t: prevStart + H, pct: 1 }, { t: START - 2 * D, pct: 100 }] } }, keys)!;
  assert.deepEqual(hit.last, { pct: 100, hitAt: START - 2 * D, byNow: pctAt([{ t: prevStart + H, pct: 1 }, { t: START - 2 * D, pct: 100 }], prevStart + share * 7 * D)! });
  assert.match(text(burnLines({ ...week(58), burn: hit }, NOW)[1]!), /^Last 24h ≈22%\/day · last week hit 100% at `Tue 6:00 PM` \(\d+% by this point\)$/);
  // A week-long window's previous period counts only when it ended about when this one began.
  const stale = windowBurn(week(58), NOW, { ...h, previous: { resetsAt: START - 14 * D, points: [{ t: START - 15 * D, pct: 70 }] } }, keys)!;
  assert.equal(stale.last, undefined);
  // Before its recording began, there is no "by this point".
  const late = windowBurn(week(58), NOW, { ...h, previous: { resetsAt: START, points: [{ t: START - H, pct: 81 }] } }, keys)!;
  assert.deepEqual(late.last, { pct: 81 });
});

test("the 5-hour window: per hour, a countdown, and the previous window whenever it was", () => {
  const reset = NOW + 2 * H + 17 * 60_000;
  const w: UsageWindow = { label: "5h", pct: 58, resetsAt: iso(reset) };
  const h: BurnHistory = {
    current: [{ t: reset - 5 * H, pct: 0 }, { t: NOW - H, pct: 33 }],
    previous: { resetsAt: NOW - 2 * D, points: [{ t: NOW - 2 * D - 5 * H + 60_000, pct: 1 }, { t: NOW - 2 * D - 5 * H + (2 * H + 43 * 60_000), pct: 35 }, { t: NOW - 2 * D - 60_000, pct: 64 }] },
    since: NOW - 3 * D,
  };
  const b = windowBurn(w, NOW, h, { series: "claude:acct", window: "5h" })!;
  assert.deepEqual(burnLines({ ...w, burn: b }, NOW).map(text), [
    "≈21%/h · at this pace used up in `1h 58m`, `19m` before reset [Runs out]",
    "Last hour ≈25%/h · last window 64% (35% by this point)",
  ]);
  // Z.ai's 5-hour on pace: the last window joins the first line.
  const z: UsageWindow = { label: "5h", pct: 22, resetsAt: iso(NOW + 3 * H) };
  const zb = windowBurn(z, NOW, { current: [], previous: { resetsAt: NOW - D, points: [{ t: NOW - D - 5 * H + 60_000, pct: 1 }, { t: NOW - D - 3 * H, pct: 19 }, { t: NOW - D - 60_000, pct: 41 }] }, since: null }, { series: "zai", window: "5h" })!;
  assert.deepEqual(burnLines({ ...z, burn: zb }, NOW).map(text), ["≈11%/h · on pace for 55% at reset · last window 41% (19% by this point)"]);
});

test("a declared Ollama month: its own span; the recent 3 days join the first line and the last month takes the second", () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const end = Date.parse("2026-10-31T00:00:00Z");
  const now = start + (11 * D + 8 * H);
  const w: UsageWindow = { label: "month", pct: 34, startsAt: iso(start), resetsAt: iso(end), declared: true };
  const prev = { startsAt: Date.parse("2026-09-01T00:00:00Z"), resetsAt: start };
  const share = (now - start) / (end - start);
  const h: BurnHistory = {
    current: [{ t: start + H, pct: 0.2 }, { t: now - 3 * D, pct: 22 }],
    previous: { ...prev, points: [{ t: prev.startsAt + H, pct: 0 }, { t: prev.startsAt + share * (start - prev.startsAt), pct: 27 }, { t: start - H, pct: 72 }] },
    since: prev.startsAt,
  };
  const b = windowBurn(w, now, h, { series: "ollama", window: "month" })!;
  assert.deepEqual(burnLines({ ...w, burn: b }, now).map(text), ["≈3%/day · on pace for 90% at reset · last 3 days ≈4%/day", "Last month 72% (27% by this point)"]);
  // With no reset day the month has no span: a rate over history only.
  const bare: UsageWindow = { label: "month", pct: 34 };
  assert.equal(windowBurn(bare, now, none, { series: "ollama", window: "month" }), null, "no history yet");
  const nb = windowBurn(bare, now, { current: [{ t: now - 5 * D, pct: 19 }], previous: null, since: null }, { series: "ollama", window: "month" })!;
  assert.deepEqual(burnLines({ ...bare, burn: nb }, now).map(text), ["≈3%/day over 5 days · no reset reported, so no run-out estimate"]);
});

test("no span: MCP uses as uses/day over up to 7 days, at least 6 hours of history", () => {
  const w: UsageWindow = { label: "mcp", pct: 21.2, used: 212, limit: 1000 };
  const h: BurnHistory = { current: [{ t: NOW - 9 * D, pct: 0 }, { t: NOW - 7 * D, pct: 0 }], previous: null, since: NOW - 9 * D };
  const b = windowBurn(w, NOW, h, { series: "zai", window: "mcp" })!;
  assert.equal(b.over, 7 * D);
  assert.deepEqual(burnLines({ ...w, burn: b }, NOW).map(text), ["≈30 uses/day over 7 days · no reset reported, so no run-out estimate"]);
  assert.equal(windowBurn(w, NOW, { current: [{ t: NOW - 5 * H, pct: 0 }], previous: null, since: null }, keys), null, "5 hours is too little");
  assert.equal(windowBurn(w, NOW, { current: [{ t: NOW - 2 * D, pct: 21.2 }], previous: null, since: null }, keys), null, "not rising");
});

test("DeepSeek's balance: spend per day since the top-up, days left at that pace", () => {
  const b: UsageBalance = { currency: "USD", total: 18.4, granted: 0, toppedUp: 18.4, available: true };
  const run = [
    { t: NOW - 20 * D, total: 40 },
    { t: NOW - 14 * D, total: 35.2 },
  ];
  const burn = balanceBurn(b, NOW, run, NOW - 30 * D)!;
  assert.ok(Math.abs(burn.perDay - 1.2) < 1e-9);
  assert.equal(burn.over, 14 * D);
  assert.deepEqual(text(balanceBurnLine({ ...b, burn })!), "≈$1.20/day over 14 days · about `15 days` left at this pace");
  assert.equal(balanceBurn(b, NOW, [{ t: NOW - 2 * H, total: 19 }], null), null, "2 hours is too little");
  assert.equal(balanceBurn(b, NOW, [{ t: NOW - 2 * D, total: 18.4 }], null), null, "not going down");
  assert.equal(balanceBurn(b, NOW, [], null), null, "a top-up started a new run with nothing in it");
});

test("pctAt: linear between readings, held after the last, unknown before the first", () => {
  const pts = [
    { t: 0, pct: 10 },
    { t: 100, pct: 20 },
  ];
  assert.equal(pctAt(pts, -1), null);
  assert.equal(pctAt(pts, 50), 15);
  assert.equal(pctAt(pts, 500), 20);
});

test("rough durations", () => {
  assert.equal(roughDuration(118 * 60_000), "1h 58m");
  assert.equal(roughDuration(19 * 60_000), "19m");
  assert.equal(roughDuration(19 * H + 2 * 60_000), "19h");
  assert.equal(roughDuration(2.2 * D), "2 days");
});

test("the axis: weekday ticks for a week, the reset with its time last; crowded labels are dropped, never the ends", () => {
  const span = { start: START, end: RESET };
  const wide = chartAxis(span, 800);
  assert.deepEqual(
    wide.grid.map((g) => Math.round(g * 7)),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    wide.labels.map((l) => l.text),
    ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu 6:00 PM"],
  );
  assert.deepEqual(
    wide.labels.map((l) => l.align),
    ["start", "middle", "middle", "middle", "middle", "middle", "middle", "end"],
  );
  const narrow = chartAxis(span, 400);
  assert.deepEqual(
    narrow.labels.map((l) => l.text),
    ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Thu 6:00 PM"],
  );
  const tiny = chartAxis(span, 120);
  assert.equal(tiny.labels[0]!.text, "Thu");
  assert.equal(tiny.labels.at(-1)!.text, "Thu 6:00 PM");
  assert.equal(nowWords(span, NOW), "now Mon 8:24 AM");
  // A month: dated ticks at its quarters, about a week apart.
  const month = { start: Date.parse("2026-10-01T00:00:00Z"), end: Date.parse("2026-10-31T00:00:00Z") };
  assert.deepEqual(
    chartAxis(month, 400).labels.map((l) => l.text),
    ["Oct 1", "Oct 8", "Oct 16", "Oct 23", "Oct 31"],
  );
  assert.equal(nowWords(month, Date.parse("2026-10-12T09:00:00Z")), "now Oct 12");
});

test("a chart only for a live window of a day or more with a known span", () => {
  assert.ok(chartSpan(week(58), NOW));
  assert.equal(chartSpan({ label: "5h", pct: 10, resetsAt: iso(NOW + H) }, NOW), null);
  assert.equal(chartSpan(week(58), RESET + 1), null);
  assert.equal(chartSpan({ label: "month", pct: 10 }, NOW), null);
});

test("the readout: recorded before now, at this pace after it, used up past the run-out, and the last period at the same point", () => {
  const span = { start: START, end: RESET };
  const b = windowBurn(week(58), NOW, none, keys)!;
  const w = { ...week(58), burn: b };
  const current = [
    { t: START, pct: 0 },
    { t: START + 2 * D, pct: 30 },
  ];
  const last = alignedLast(span, "7d", { resetsAt: START, points: [{ t: START - 7 * D + H, pct: 0 }, { t: START - 5 * D, pct: 31 }] });
  const past = readoutAt(w, span, NOW, START + 2 * D, current, last, "week");
  assert.deepEqual(past, { time: "Sat 6:00 PM", value: { kind: "past", pct: 30 }, last: "last week 31% by this point" });
  const ahead = readoutAt(w, span, NOW, NOW + 24 * H, current, last, "week");
  assert.equal(ahead.value.kind, "pace");
  assert.equal(Math.round((ahead.value as { pct: number }).pct), 74);
  assert.equal(readoutAt(w, span, NOW, b.runsOutAt! + H, current, last, "week").value.kind, "used-up");
  assert.equal(readoutAt(w, span, NOW, START + H, [], [], "week").value.kind, "unrecorded");
  // The pace line stops at 100% at the run-out; without one it runs to the reset.
  assert.deepEqual(projection(w, span, NOW), { from: { t: NOW, pct: 58 }, to: { t: b.runsOutAt!, pct: 100 } });
  const calm = { ...week(12), burn: windowBurn(week(12), NOW, none, keys)! };
  assert.equal(projection(calm, span, NOW)!.to.t, RESET);
});

test("the last period from a summary: its own final percent and 100% time win over its tenths", () => {
  const prevStart = START - 7 * D;
  const tenths = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95].map((pct, k) => ({ t: prevStart + (k * 7 * D) / 10, pct }));
  const b = windowBurn(week(58), NOW, { current: [], previous: { startsAt: prevStart, resetsAt: START, points: tenths, final: 100, hitAt: START - H }, since: null }, keys)!;
  assert.equal(b.last?.pct, 100);
  assert.equal(b.last?.hitAt, START - H);
  assert.ok(Math.abs(b.last!.byNow! - 51.4) < 0.1, `byNow ${b.last?.byNow}`);
});

test("the stepper's names: a week by its start, a month from the 1st by its month, else a date range", () => {
  assert.equal(periodTitle(week(10), { start: START, end: RESET }), "Week of Oct 1");
  const month: UsageWindow = { label: "month", pct: 10 };
  assert.equal(periodTitle(month, { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2026-10-01T00:00:00Z") }), "Month of Sep");
  assert.equal(periodTitle(month, { start: Date.parse("2026-09-25T00:00:00Z"), end: Date.parse("2026-10-25T00:00:00Z") }), "Sep 25 – Oct 25");
});

test("a past period's line, and its readout against the period before", () => {
  const span = { start: START - 7 * D, end: START };
  const hit = pastPeriodLine({ points: [], final: 100, hitAt: START - 2 * D - 4 * H, rate: 0.5 }, span, NOW);
  assert.equal(text(hit), "hit 100% at `Tue 2:00 PM` · ≈12%/day");
  assert.equal(text(pastPeriodLine({ points: [], final: 81, rate: 0.5 }, span, NOW)), "peaked at 81% · ≈12%/day");
  const r = pastReadoutAt(span, START - 6 * D, [{ t: span.start, pct: 0 }, { t: START - 5 * D, pct: 40 }], [{ t: span.start, pct: 0 }, { t: START - 5 * D, pct: 20 }], "week before");
  assert.deepEqual(r, { time: "Fri 6:00 PM", value: { kind: "past", pct: 20 }, last: "week before 10% by this point" });
  assert.equal(pastReadoutAt(span, span.start - 1, [{ t: span.start, pct: 0 }], [], "week before").value.kind, "unrecorded");
});

test("the 5-hour strip: one pitch for all bars (at least 3px), the newest that fit, its caption and readout", () => {
  assert.deepEqual(stripLayout(30, 330), { pitch: 11, bar: 10, from: 0 });
  assert.deepEqual(stripLayout(150, 330), { pitch: 3, bar: 2, from: 40 });
  const wins = [
    { startsAt: NOW - 10 * H, resetsAt: NOW - 5 * H, final: 64, rate: 12.8 },
    { startsAt: NOW - 30 * H, resetsAt: NOW - 25 * H, final: 100, hitAt: NOW - 26 * H, rate: 25 },
  ];
  assert.equal(stripCaption(wins), "Last 30 days · 2 windows · 1 hit 100%");
  assert.equal(stripCaption([wins[0]!]), "Last 30 days · 1 window");
  assert.deepEqual(stripReadout(wins[1]!, NOW), { time: "Oct 4 2:24 AM – 7:24 AM", pct: 100, rate: "≈25%/h", hit: "6:24 AM" });
  assert.equal(shortSpan({ label: "5h", pct: 0 }), true, "an idle 5-hour window, no reset: by its label");
  assert.equal(shortSpan(week(10)), false);
});
