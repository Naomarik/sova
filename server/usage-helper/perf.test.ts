// The Performance tab's figures over measured replies: the speed thresholds, the split rule, thinking
// time over replies that thought only, too few replies for a range, figures a provider can't give.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PERF_ALL_TOOLS, PERF_MIN_RANGE, PERF_NO_SPLIT, replySpeeds, type ReplyTiming } from "../../shared/usage/perf";
import { binsOn, figure, figuresOf, logBins, normalizeTiming, percentile, performanceRows, type PerfSample } from "./perf";

const t = (o: Partial<ReplyTiming>): ReplyTiming => ({ ttftMs: 500, thinkingMs: 0, replyMs: 2000, output: 200, ...o });

test("a speed counts only from 100 tokens over 1 s in its part; times always count", () => {
  assert.equal(replySpeeds(t({ output: 99, replyMs: 5000 })).overall, undefined);
  assert.equal(replySpeeds(t({ output: 100, replyMs: 999 })).overall, undefined);
  assert.equal(replySpeeds(t({ output: 100, replyMs: 1000 })).overall, 100);
  const f = figuresOf([t({ output: 10, replyMs: 200, ttftMs: 700 })]);
  assert.equal(f.overall.n, 0);
  assert.equal(f.ttft.n, 1);
  assert.equal(f.ttft.median, 700);
});

test("overall speed is every token over thinking + reply time; the split speeds need their own part's threshold", () => {
  const s = replySpeeds(t({ output: 600, reasoning: 400, thinkingMs: 2000, replyMs: 2000 }));
  assert.equal(s.overall, 150);
  assert.equal(s.thinking, 200);
  assert.equal(s.reply, 100);
  // 50 reply tokens: no reply speed, the thinking one stands.
  const short = replySpeeds(t({ output: 450, reasoning: 400, thinkingMs: 2000, replyMs: 2000 }));
  assert.equal(short.reply, undefined);
  assert.equal(short.thinking, 200);
});

test("without a thinking count, a reply that thought has no reply or thinking speed; one that didn't think has a reply speed", () => {
  const thought = replySpeeds(t({ output: 600, thinkingMs: 2000, replyMs: 2000 }));
  assert.equal(thought.reply, undefined);
  assert.equal(thought.thinking, undefined);
  assert.equal(thought.overall, 150);
  assert.equal(replySpeeds(t({ output: 600, replyMs: 2000 })).reply, 300);
});

test("a 0 thinking count for a reply with a thinking window is a count not reported", () => {
  assert.equal(normalizeTiming(t({ reasoning: 0, thinkingMs: 1500 })).reasoning, undefined);
  assert.equal(normalizeTiming(t({ reasoning: 0, thinkingMs: 0 })).reasoning, 0);
  assert.equal(normalizeTiming(t({ reasoning: 900, output: 300, thinkingMs: 10 })).reasoning, 300);
});

test("thinking time per reply is over the replies that thought only, with how many did", () => {
  const f = figuresOf([t({ thinkingMs: 4000, reasoning: 300, output: 500 }), t({}), t({}), t({ thinkingMs: 8000, reasoning: 100, output: 400 })]);
  assert.equal(f.replies, 4);
  assert.equal(f.thought, 2);
  assert.equal(f.thinkingMs.n, 2);
  assert.equal(f.thinkingMs.median, 6000);
  assert.equal(f.thinkingTokens.median, 200);
});

test("a figure a provider can't give says why; a figure with no sample yet doesn't", () => {
  // Thought, never counted (Claude Code, Ollama Cloud): thinking speed and tokens unsupported, reply too
  // when every reply thought.
  const cc = figuresOf([t({ thinkingMs: 3000, output: 800 }), t({ thinkingMs: 2000, output: 500 })]);
  assert.equal(cc.thinkingTps.unsupported, PERF_NO_SPLIT);
  assert.equal(cc.thinkingTokens.unsupported, PERF_NO_SPLIT);
  assert.equal(cc.reply.unsupported, PERF_NO_SPLIT);
  assert.equal(cc.thinkingMs.n, 2);
  assert.equal(cc.overall.n, 2);
  // One reply without thinking: the reply speed has a real split, so it's supported.
  const mixed = figuresOf([t({ thinkingMs: 3000, output: 800 }), t({ output: 50 })]);
  assert.equal(mixed.reply.unsupported, undefined);
  assert.equal(mixed.reply.n, 0);
  // Never thought: nothing to count, nothing unsupported.
  const none = figuresOf([t({})]);
  assert.equal(none.thinkingTps.unsupported, undefined);
  assert.equal(none.thought, 0);
});

test("under the minimum, a figure has its median and count but no range or chart", () => {
  const few = figure([3, 1, 2]);
  assert.deepEqual(few, { n: 3, median: 2, mean: 2 });
  const enough = figure([5, 1, 4, 2, 3].slice(0, PERF_MIN_RANGE));
  assert.equal(enough.median, 3);
  assert.ok(enough.p10 !== undefined && enough.p90 !== undefined && enough.bins);
  assert.equal(enough.bins!.reduce((n, b) => n + b.n, 0), PERF_MIN_RANGE);
  assert.deepEqual(figure([]), { n: 0 });
});

test("percentiles interpolate; bins are log-spaced, cover every value, and hold one bin for equal values", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.1), 14);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 46);
  const values = Array.from({ length: 200 }, (_, i) => 1 + i * 5).sort((a, b) => a - b);
  const bins = logBins(values);
  assert.ok(bins.length <= 12);
  assert.equal(bins.reduce((n, b) => n + b.n, 0), 200);
  assert.equal(bins[0]!.lo, 1);
  assert.equal(bins.at(-1)!.hi, 996);
  for (let i = 1; i < bins.length; i++) assert.ok(Math.abs(bins[i]!.hi / bins[i]!.lo - bins[0]!.hi / bins[0]!.lo) < 1e-9);
  assert.deepEqual(logBins([7, 7, 7]), [{ lo: 7, hi: 7, n: 3 }]);
  assert.equal(logBins([0, 0, 5, 50]).reduce((n, b) => n + b.n, 0), 4);
});

test("rows: one per provider+model, most replies first, effort lines in level order", () => {
  const s = (provider: string, model: string, effort?: string): PerfSample => ({ provider, model, timing: t(effort ? { effort } : {}) });
  const rows = performanceRows([s("zai", "glm-5.3", "high"), s("openai", "gpt-5.5", "xhigh"), s("openai", "gpt-5.5", "low"), s("openai", "gpt-5.5", "medium"), s("openai", "gpt-5.5")]);
  assert.deepEqual(
    rows.map((r) => `${r.provider}/${r.model}:${r.replies}`),
    ["openai/gpt-5.5:4", "zai/glm-5.3:1"],
  );
  assert.deepEqual(
    rows[0]!.efforts.map((e) => `${e.effort}:${e.replies}`),
    ["low:1", "medium:1", "xhigh:1", "unknown:1"],
  );
});

test("every effort level is binned on its model's bands: the same spread at two levels draws the same heights", () => {
  const thought = (effort: string, thinkingMs: number): PerfSample => ({ provider: "zai", model: "glm-5.3", timing: t({ effort, thinkingMs, thinkingParts: 1 }) });
  const low = [100, 200, 200, 400, 800];
  const high = low.map((v) => v * 10);
  const [row] = performanceRows([...low.map((v) => thought("low", v)), ...high.map((v) => thought("high", v)), thought("xhigh", 300)]);
  const model = row!.thinkingMs.bins!;
  const [lo, hi, few] = row!.efforts.map((e) => e.thinkingMs);
  const edges = (bins: { lo: number; hi: number }[]) => bins.map((b) => [b.lo, b.hi]);
  assert.deepEqual(edges(lo!.bins!), edges(model), "low on the model's bands");
  assert.deepEqual(edges(hi!.bins!), edges(model), "high on the model's bands");
  const counts = (bins: { n: number }[]) => bins.map((b) => b.n);
  assert.equal(Math.max(...counts(lo!.bins!)), Math.max(...counts(hi!.bins!)), "comparable peak heights");
  assert.deepEqual(counts(lo!.bins!).filter(Boolean), counts(hi!.bins!).filter(Boolean), "the same shape, moved along the axis");
  assert.equal(counts(lo!.bins!).reduce((a, b) => a + b), low.length);
  assert.equal(few!.bins, undefined, "a level under 5 has no bins");
  // A value at or under the first band's lo falls in it, one over the last band's hi in the last.
  assert.deepEqual(counts(binsOn([{ lo: 10, hi: 20, n: 9 }, { lo: 20, hi: 40, n: 9 }], [0, 10, 25, 40, 99])), [2, 3]);
});

test("a reply with tool calls: overall speed includes the tool-call writing window, no reply-text speed", () => {
  // A short preamble, then a long, slow tool-argument stream.
  const tool = t({ output: 1200, replyMs: 12_000, toolCalls: 1, reasoning: 0 });
  const s = replySpeeds(tool);
  assert.equal(s.overall, 100);
  assert.equal(s.reply, undefined);
  assert.equal(normalizeTiming(t({ toolCalls: 0 })).toolCalls, undefined);
  assert.equal(figuresOf([tool, tool]).reply.unsupported, PERF_ALL_TOOLS);
  assert.equal(figuresOf([tool, t({ output: 600, replyMs: 2000 })]).reply.n, 1);
});

test("a reply that thought in no measurable time (one chunk, or Claude's hidden thinking in one tick) has no reply-text speed and counts as thinking", () => {
  const quick = t({ thinkingMs: 0, thinkingParts: 1, output: 500, replyMs: 2000 });
  assert.equal(replySpeeds(quick).reply, undefined, "its output holds uncounted thinking tokens");
  assert.ok(replySpeeds(quick).overall !== undefined);
  assert.equal(replySpeeds(t({ thinkingMs: 0, output: 500 })).reply, 250, "no thinking part: every token is reply");
  assert.equal(normalizeTiming({ ...quick, reasoning: 0 }).reasoning, undefined, "a 0 count beside a thinking part is 'not reported'");
  assert.equal(normalizeTiming(quick).thinkingParts, 1);
  const f = figuresOf([quick, t({})]);
  assert.equal(f.thought, 1, "it thought, however briefly");
});
