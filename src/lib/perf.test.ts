import assert from "node:assert/strict";
import { test } from "node:test";
import type { PerfFigure, ReplyTiming } from "../../shared/usage/perf";
import { insightsRouteFromHash } from "./insights";
import { byEffort, figureWords, msBare, msWord, perfEmptyTitle, perfHref, perfRouteFromHash, replyCardLines, replyHovers, tpsNum, tpsWord } from "./perf";

const lines = (t: ReplyTiming) => Object.fromEntries(replyCardLines(t).map((l) => [l.label, l.value]));

test("a reply whose provider counts thinking tokens shows thinking and reply speeds", () => {
  const l = lines({ effort: "high", ttftMs: 1800, thinkingMs: 4000, replyMs: 6000, output: 1000, reasoning: 400 });
  assert.equal(l.Effort, "high");
  assert.equal(l.Overall, "100 tok/s");
  assert.equal(l.Tokens, "1.0k");
  assert.equal(l.Thinking, "100 tok/s");
  assert.equal(l.Reply, "100 tok/s");
  assert.equal(l["First token"], "after 1.8 s");
});

test("no thinking count: thinking and reply show times, never an estimated speed", () => {
  const l = lines({ effort: "high", ttftMs: 900, thinkingMs: 12_400, replyMs: 8100, output: 2000 });
  assert.equal(l.Thinking, "12 s");
  assert.equal(l.Reply, "8.1 s");
  assert.match(l.Overall!, /tok\/s$/, "overall is exact for every model");
});

test("a reply that didn't think has no thinking line, and every token is reply", () => {
  const l = lines({ ttftMs: 500, thinkingMs: 0, replyMs: 2000, output: 300 });
  assert.equal(l.Thinking, undefined);
  assert.equal(l.Effort, undefined, "no level recorded: no effort line");
  assert.equal(l.Reply, "150 tok/s");
});

test("a reply that wrote tool calls shows its reply time, never a reply-text speed", () => {
  const l = lines({ ttftMs: 700, thinkingMs: 0, replyMs: 9000, output: 1200, toolCalls: 2 });
  assert.equal(l.Reply, "9.0 s");
  assert.equal(l.Overall, "133 tok/s", "overall still covers the tool-call writing");
});

test("a part too short for a speed shows its time", () => {
  const l = lines({ ttftMs: 400, thinkingMs: 0, replyMs: 300, output: 40 });
  assert.equal(l.Overall, "300 ms");
  assert.equal(l.Reply, "300 ms");
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

test("words: speeds and times", () => {
  assert.equal(tpsWord(4.25), "4.3 tok/s");
  assert.equal(tpsWord(84.4), "84 tok/s");
  assert.equal(tpsWord(1240.2), "1,240 tok/s");
  assert.equal(tpsNum(84.4), "84");
  assert.equal(msWord(640), "640 ms");
  assert.equal(msWord(9960), "10 s");
  assert.equal(msWord(59_700), "1m 00s");
  assert.equal(msWord(125_000), "2m 05s");
});

test("a figure: median and range, too few for a range, unsupported, nothing long enough", () => {
  const full: PerfFigure = { n: 20, median: 80, mean: 82, p10: 60, p90: 110, bins: [] };
  assert.deepEqual(figureWords(full, tpsWord, { mean: true, bare: tpsNum }), { main: "80 tok/s", details: ["avg 82 tok/s", "10–90% 60–110 tok/s"] });
  assert.deepEqual(figureWords({ n: 20, median: 900, p10: 400, p90: 3000 }, msWord, { slow: true }), { main: "900 ms", details: ["slow 3.0 s"] });
  assert.deepEqual(figureWords({ n: 20, median: 4200, p10: 1400, p90: 10_000 }, msWord, { bare: msBare(10_000) }).details, ["10–90% 1.4–10 s"]);
  assert.deepEqual(figureWords({ n: 20, median: 900, p10: 400, p90: 3000 }, msWord, { bare: msBare(3000) }).details, ["10–90% 400 ms–3.0 s"], "mixed units keep both");
  assert.deepEqual(figureWords({ n: 3, median: 80, mean: 81 }, tpsWord), { main: "80 tok/s", reason: "3 replies, too few for a range" });
  assert.deepEqual(figureWords({ n: 0, unsupported: "Provider doesn't count thinking tokens" }, tpsWord), { main: "—", reason: "Provider doesn't count thinking tokens" });
  assert.equal(figureWords({ n: 0 }, tpsWord).main, "—");
});

test("effort levels sort in level order, unknown ones last", () => {
  assert.deepEqual(byEffort([{ effort: "xhigh" }, { effort: "unknown" }, { effort: "low" }, { effort: "off" }]).map((e) => e.effort), ["off", "low", "xhigh", "unknown"]);
});

test("the address: its own tab, the Costs filter words, never a team key", () => {
  assert.equal(perfHref(), "#/agents/performance");
  assert.equal(perfHref({ range: "7d", providers: ["zai"], models: [] }), "#/agents/performance?range=7d&provider=zai");
  assert.deepEqual(perfRouteFromHash("#/agents/performance?range=all"), { range: "all", providers: [], models: [] });
  assert.equal(perfRouteFromHash("#/agents/performance/x"), null);
  const r = insightsRouteFromHash("#/agents/performance?range=7d");
  assert.deepEqual(r, { page: "agents", team: null, performance: { range: "7d", providers: [], models: [] } });
});

test("empty: before anything was measured it says so; after, it names the range", () => {
  const q = { range: "30d" as const, providers: [], models: [] };
  assert.equal(perfEmptyTitle(q, false), "No measured replies yet.");
  assert.equal(perfEmptyTitle(q, true), "No measured replies in the last 30 days.");
  assert.equal(perfEmptyTitle({ ...q, providers: ["zai"] }, true), "No measured replies in the last 30 days with these filters.");
});

test("a reply that thought in no measurable time keeps its Thinking line and shows its reply as a time", () => {
  const l = lines({ effort: "high", ttftMs: 900, thinkingMs: 0, thinkingParts: 1, replyMs: 2000, output: 500 });
  assert.equal(l.Thinking, msWord(0));
  assert.equal(l.Reply, msWord(2000), "its output holds uncounted thinking tokens: no reply speed");
  assert.equal("Thinking" in lines({ ttftMs: 900, thinkingMs: 0, replyMs: 2000, output: 500 }), false);
});
