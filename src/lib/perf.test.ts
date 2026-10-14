import assert from "node:assert/strict";
import { test } from "node:test";
import { PERF_ALL_TOOLS, PERF_NO_SPLIT, type PerfEffortRow, type PerfFigure, type PerfFigures, type PerfModelRow, type ReplyTiming } from "../../shared/usage/perf";
import { insightsRouteFromHash } from "./insights";
import {
  axisAt,
  byEffort,
  bySort,
  chartArea,
  chartAxis,
  chartSlots,
  countWords,
  figureWords,
  levelWords,
  msBare,
  msRange,
  msWord,
  overallScale,
  perfEmptyTitle,
  perfHref,
  perfRouteFromHash,
  placeBins,
  replyCard,
  replyCardSummary,
  replyHovers,
  rowWords,
  thoughtWords,
  tpsNum,
  tpsWord,
} from "./perf";

const parts = (t: ReplyTiming) => Object.fromEntries(replyCard(t).parts.map((l) => [l.label, l.value]));

// ---- the reply card ----

test("a measured reply leads with its overall speed, then its parts in the order they happened", () => {
  const t: ReplyTiming = { effort: "high", ttftMs: 1800, thinkingMs: 4000, replyMs: 6000, output: 1000, reasoning: 400 };
  const c = replyCard(t);
  assert.equal(c.effort, "high");
  assert.deepEqual(c.headline, { label: "Overall speed", value: "100 tok/s", note: "1.0k tokens, written in 10 s" });
  assert.deepEqual(
    c.parts.map((p) => p.label),
    ["First token", "Thinking", "Reply"],
  );
  assert.deepEqual(parts(t), { "First token": "after 1.8 s", Thinking: "100 tok/s", Reply: "100 tok/s" });
  assert.equal(replyCardSummary(t), "Effort high. Overall speed 100 tok/s, 1.0k tokens, written in 10 s. First token after 1.8 s, Thinking 100 tok/s, Reply 100 tok/s.");
});

test("no thinking count: thinking and reply show times, never an estimated speed", () => {
  const t: ReplyTiming = { effort: "high", ttftMs: 900, thinkingMs: 12_400, replyMs: 8100, output: 2000 };
  assert.deepEqual(parts(t), { "First token": "after 900 ms", Thinking: "12 s", Reply: "8.1 s" });
  assert.match(replyCard(t).headline.value, /tok\/s$/, "overall is exact for every model");
});

test("a reply that didn't think has no thinking part and no effort line when none was recorded", () => {
  const c = replyCard({ ttftMs: 500, thinkingMs: 0, replyMs: 2000, output: 300 });
  assert.equal(c.effort, undefined);
  assert.equal("Thinking" in parts({ ttftMs: 500, thinkingMs: 0, replyMs: 2000, output: 300 }), false);
  assert.equal(parts({ ttftMs: 500, thinkingMs: 0, replyMs: 2000, output: 300 }).Reply, "150 tok/s");
});

test("a reply that wrote tool calls shows its reply time, never a reply-text speed", () => {
  const t: ReplyTiming = { ttftMs: 700, thinkingMs: 0, replyMs: 9000, output: 1200, toolCalls: 2 };
  assert.equal(parts(t).Reply, "9.0 s");
  assert.equal(replyCard(t).headline.value, "133 tok/s", "overall still covers the tool-call writing");
});

test("too few tokens for a speed: the card leads with a time labelled as one", () => {
  const c = replyCard({ ttftMs: 1200, thinkingMs: 0, replyMs: 145, output: 17 });
  assert.deepEqual(c.headline, { label: "Written in", value: "145 ms", note: "17 tokens, too few for a speed" });
  assert.equal(parts({ ttftMs: 1200, thinkingMs: 0, replyMs: 145, output: 17 }).Reply, "145 ms");
  assert.notEqual(c.headline.label, "Overall speed", "a time is never under a speed's label");
});

test("enough tokens written in under a second: too quick, never too few", () => {
  const c = replyCard({ ttftMs: 400, thinkingMs: 0, replyMs: 800, output: 500 });
  assert.equal(c.headline.label, "Written in");
  assert.equal(c.headline.value, "800 ms");
  assert.equal(c.headline.note, "500 tokens, too quick for a speed");
  assert.doesNotMatch(c.headline.note, /too few/);
});

test("a reply that thought in no measurable time keeps its Thinking part and shows its reply as a time", () => {
  const p = parts({ effort: "high", ttftMs: 900, thinkingMs: 0, thinkingParts: 1, replyMs: 2000, output: 500 });
  assert.equal(p.Thinking, msWord(0));
  assert.equal(p.Reply, msWord(2000), "its output holds uncounted thinking tokens: no reply speed");
  assert.equal("Thinking" in parts({ ttftMs: 900, thinkingMs: 0, replyMs: 2000, output: 500 }), false);
});

test("the hover sits on a measured entry's first reply-text row only", () => {
  const t: ReplyTiming = { ttftMs: 1, thinkingMs: 0, replyMs: 1, output: 1 };
  const rows = [
    { id: "a:0", kind: "thinking", facts: { reply: t } },
    { id: "a:1", kind: "assistant-text" },
    { id: "a:2", kind: "assistant-text" },
    { id: "b:0", kind: "assistant-text" },
  ];
  const m = replyHovers(rows, (id) => id.split(":")[0]!, (r) => (r as { facts?: { reply?: ReplyTiming } }).facts?.reply);
  assert.deepEqual([...m.keys()], ["a:1"], "an unmeasured entry (b) gets nothing");
});

// ---- words ----

test("words: speeds and times", () => {
  assert.equal(tpsWord(4.25), "4.3 tok/s");
  assert.equal(tpsWord(84.4), "84 tok/s");
  assert.equal(tpsWord(1240.2), "1,240 tok/s");
  assert.equal(tpsNum(84.4), "84");
  assert.equal(msWord(640), "640 ms");
  assert.equal(msWord(9960), "10 s");
  assert.equal(msWord(59_700), "1m 00s");
  assert.equal(msWord(125_000), "2m 05s");
  assert.equal(msRange({ n: 20, p10: 1400, p90: 10_000 }), "1.4 to 10 s");
  assert.equal(msRange({ n: 20, p10: 400, p90: 3000 }), "400 ms to 3.0 s", "mixed units keep both");
  assert.equal(msBare(3000)(400), "400 ms");
});

test("a figure: one muted line, the figure's own count under 5, its range from 5, a short reason for a dash", () => {
  const full: PerfFigure = { n: 20, median: 80, mean: 82, p10: 60, p90: 110, bins: [] };
  assert.deepEqual(figureWords(full, tpsWord, { count: "speed", end: tpsNum }), { main: "80 tok/s", sub: "60 to 110", ranged: true });
  assert.deepEqual(figureWords(full, tpsWord, { count: "speed", detail: (f) => `avg ${tpsNum(f.mean!)}` }).sub, "avg 82");
  assert.deepEqual(figureWords({ n: 3, median: 80, mean: 81 }, tpsWord, { count: "speed" }), { main: "80 tok/s", sub: "3 long enough for a speed", ranged: false });
  assert.equal(figureWords({ n: 4, median: 900 }, msWord, { count: "thought" }).sub, "4 thought");
  assert.equal(figureWords({ n: 2, median: 900 }, msWord, { count: "replies" }).sub, "2 replies");
  assert.equal(figureWords({ n: 1, median: 900 }, msWord, { count: "replies" }).sub, "1 reply");
  assert.deepEqual(figureWords({ n: 0, unsupported: PERF_NO_SPLIT }, tpsWord, { count: "speed" }), { main: "—", sub: "not counted", sr: PERF_NO_SPLIT, ranged: false });
  assert.equal(figureWords({ n: 0, unsupported: PERF_ALL_TOOLS }, tpsWord, { count: "speed" }).sub, "tool calls only");
  assert.deepEqual(figureWords({ n: 0 }, tpsWord, { count: "speed" }), { main: "—", sub: "too short yet", sr: "No reply long enough yet", ranged: false });
  assert.equal(countWords("counted", 4), "4 counted");
  assert.equal(thoughtWords({ replies: 7, thought: 4 }), "4 of 7 thought");
});

// ---- the tab ----

const fig = (n: number, median?: number, extra: Partial<PerfFigure> = {}): PerfFigure => (median === undefined ? { n } : { n, median, mean: median, ...extra });
const ranged = (n: number, median: number, p10: number, p90: number, bins = [{ lo: p10, hi: p90, n }]): PerfFigure => ({ n, median, mean: median, p10, p90, bins });
const figures = (o: Partial<PerfFigures> = {}): PerfFigures => ({
  replies: 0,
  thought: 0,
  overall: fig(0),
  reply: fig(0),
  thinkingTps: fig(0),
  thinkingMs: fig(0),
  thinkingTokens: fig(0),
  ttft: fig(0),
  ...o,
});
const row = (provider: string, model: string, o: Partial<PerfFigures> = {}, efforts: PerfEffortRow[] = []): PerfModelRow => ({ provider, model, ...figures(o), efforts });

test("a row of 7 replies, 4 thought, 3 with a speed: every count line says its own count, and no chart area is drawn", () => {
  const r = row("zai", "glm-5.3", { replies: 7, thought: 4, overall: fig(3, 150), thinkingMs: fig(4, 900), ttft: fig(7, 1100), reply: fig(2, 144) });
  const w = rowWords(r);
  assert.equal(w.overall.sub, "3 long enough for a speed");
  assert.equal(w.thinking.sub, "4 thought");
  assert.equal(w.reply.sub, "2 long enough for a speed");
  assert.equal(w.overall.ranged, false, "no bar under 5 of its own");
  for (const s of [w.overall.sub, w.thinking.sub, w.reply.sub]) assert.doesNotMatch(s!, /7/, "never the row's reply total");
  assert.deepEqual(chartArea(r), { show: false, n: 4 });
  const panel = chartSlots(r, null);
  assert.deepEqual(panel.slots, [], "no chart frame at all");
  assert.equal(panel.gap, "Charts appear from 5 measured replies; this model has 4. Its medians are in the lines above.");
});

test("each chart is shown or replaced on its own count, and a replaced chart at a level points to All levels", () => {
  const low: PerfEffortRow = { effort: "low", ...figures({ replies: 4, thought: 3, overall: fig(4, 120), thinkingMs: fig(3, 800) }) };
  const high: PerfEffortRow = { effort: "high", ...figures({ replies: 6, thought: 0, overall: ranged(6, 90, 60, 140) }) };
  const r = row("zai", "glm-5.3", { replies: 10, thought: 3, overall: ranged(10, 100, 60, 150), thinkingMs: fig(3, 800) }, [low, high]);
  const all = chartSlots(r, null);
  assert.equal(all.gap, undefined);
  assert.equal(all.slots[0]!.head, undefined, "thinking: 3 of its own, replaced");
  assert.equal(all.slots[0]!.line, "Thinking time per reply: median 800 ms · 3 thought. A chart needs 5.");
  assert.equal(all.slots[1]!.head, "median 100 · 10–90% 60 to 150 · 10 replies");
  const atLow = chartSlots(r, low);
  assert.equal(atLow.slots[1]!.line, "Overall speed (tok/s): median 120 · 4 long enough for a speed. A chart needs 5. All levels pools them.");
  const atHigh = chartSlots(r, high);
  assert.equal(atHigh.slots[0]!.line, "No reply at this level thought.");
  assert.match(atHigh.slots[1]!.head!, /6 replies$/);
});

test("the effort line: thinking with its average and range from 5, tokens and speed by their own counts", () => {
  const e = figures({ replies: 9, thought: 6, thinkingMs: ranged(6, 4200, 1400, 10_000), thinkingTokens: fig(2, 820), overall: fig(0) });
  const w = levelWords(e);
  assert.equal(w.thinking.main, "4.2 s");
  assert.equal(w.thinking.sub, "avg 4.2 s · 1.4 to 10 s");
  assert.equal(w.tokens.sub, "2 counted");
  assert.equal(w.overall.sub, "too short yet");
  const none = levelWords(figures({ replies: 3, thought: 0 }));
  assert.deepEqual([none.thinking.sub, none.tokens.sub], ["none thought", "none thought"]);
});

test("sort: most replies, fastest or quickest first token; a model without the figure goes last; ties by replies, then name", () => {
  const a = row("zai", "a", { replies: 5, overall: fig(1, 100), ttft: fig(5, 900) });
  const b = row("zai", "b", { replies: 9, overall: fig(1, 200), ttft: fig(9, 1500) });
  const c = row("ant", "c", { replies: 2, ttft: fig(2, 400) });
  const d = row("ant", "d", { replies: 5, overall: fig(1, 100), ttft: fig(5, 900) });
  const ids = (rows: PerfModelRow[]) => rows.map((r) => r.model).join(",");
  assert.equal(ids(bySort([a, b, c, d], "replies")), "b,d,a,c", "a 5–5 tie falls to provider");
  assert.equal(ids(bySort([a, b, c, d], "fastest")), "b,d,a,c", "c has no overall speed: last");
  assert.equal(ids(bySort([a, b, c, d], "first-token")), "c,d,a,b");
});

test("the address: its own tab, the Costs filter words and the sort, never a team key", () => {
  assert.equal(perfHref(), "#/agents/performance");
  assert.equal(perfHref({ range: "7d", providers: ["zai"], models: [], sort: "replies" }), "#/agents/performance?range=7d&provider=zai");
  assert.equal(perfHref({ range: "30d", providers: [], models: [], sort: "fastest" }), "#/agents/performance?sort=fastest");
  for (const sort of ["replies", "fastest", "first-token"] as const) {
    const q = { range: "all" as const, providers: ["zai"], models: ["zai/glm-5.3"], sort };
    assert.deepEqual(perfRouteFromHash(perfHref(q)), q, `round trip: ${sort}`);
  }
  assert.deepEqual(perfRouteFromHash("#/agents/performance?range=all"), { range: "all", providers: [], models: [], sort: "replies" });
  assert.equal(perfRouteFromHash("#/agents/performance?sort=nope")!.sort, "replies");
  assert.equal(perfRouteFromHash("#/agents/performance/x"), null);
  const r = insightsRouteFromHash("#/agents/performance?range=7d&sort=first-token");
  assert.deepEqual(r, { page: "agents", team: null, performance: { range: "7d", providers: [], models: [], sort: "first-token" } });
});

test("the main row's scale: 0 to the highest overall 90th percentile among rows with a range of their own", () => {
  const rows = [row("a", "x", { overall: ranged(6, 100, 50, 180) }), row("a", "y", { overall: ranged(5, 300, 200, 420) }), row("a", "z", { overall: fig(3, 900) })];
  assert.equal(overallScale(rows), 420, "a median from 3 replies never stretches the scale");
  assert.equal(overallScale([row("a", "z", { overall: fig(3, 900) })]), 0);
});

test("chart axis: the model's bands; a level's bins sit inside it, a one-value figure draws one bar, a 0 sits at the start", () => {
  const model = ranged(10, 400, 120, 2000, [
    { lo: 100, hi: 1000, n: 6 },
    { lo: 1000, hi: 10_000, n: 4 },
  ]);
  const axis = chartAxis(model)!;
  assert.deepEqual(axis, { lo: 100, hi: 10_000, log: true });
  const level = placeBins(
    [
      { lo: 100, hi: 1000, n: 0 },
      { lo: 1000, hi: 10_000, n: 5 },
    ],
    axis,
  );
  assert.deepEqual(
    level.map((p) => [p.left, p.width, p.share]),
    [
      [0, 0.5, 0],
      [0.5, 0.5, 1],
    ],
  );
  for (const p of level) assert.ok(p.left >= 0 && p.left + p.width <= 1 + 1e-9, "inside the model's axis");
  assert.equal(axisAt(axis, 0), 0, "a 0 on a log axis at the start");
  assert.equal(axisAt(axis, 50_000), 1);
  const one = chartAxis(ranged(5, 7, 7, 7, [{ lo: 7, hi: 7, n: 5 }]))!;
  const [bar] = placeBins([{ lo: 7, hi: 7, n: 5 }], one);
  assert.ok(bar!.width > 0 && bar!.left > 0 && bar!.left < 0.5, "one bar, drawn, near the middle");
  assert.equal(chartAxis(fig(3, 10)), null);
});

test("effort levels sort in level order, unknown ones last", () => {
  assert.deepEqual(byEffort([{ effort: "xhigh" }, { effort: "unknown" }, { effort: "low" }, { effort: "off" }]).map((e) => e.effort), ["off", "low", "xhigh", "unknown"]);
});

test("empty: before anything was measured it says so; after, it names the range", () => {
  const q = { range: "30d" as const, providers: [], models: [] };
  assert.equal(perfEmptyTitle(q, false), "No measured replies yet.");
  assert.equal(perfEmptyTitle(q, true), "No measured replies in the last 30 days.");
  assert.equal(perfEmptyTitle({ ...q, providers: ["zai"] }, true), "No measured replies in the last 30 days with these filters.");
});
