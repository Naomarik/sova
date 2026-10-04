// Run: pnpm exec tsx --test src/lib/llm-inflight.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmInflight, LlmTokens } from "../../shared/protocol";
import { denseCount, sameInflight, tokenVelocityView, VELOCITY_SCALE_FLOOR, velocityChart } from "./llm-inflight";

const complete = (count: number): LlmInflight => ({ count, approximate: 0, partial: false, gaps: [] });

const B = 30_000;
/** A ring whose newest slot is `end`, with `slots` (age in slots back from `end` → tokens). */
function ring(end: number, slots: Record<number, number>, partial = false): LlmTokens {
  const out = Array.from({ length: 60 }, () => 0);
  for (const [age, n] of Object.entries(slots)) out[59 - Number(age)] = n;
  return { bucketMs: B, end, out, partial };
}
const withTokens = (tokens: LlmTokens | undefined, base: LlmInflight = complete(0)): LlmInflight => ({ ...base, tokens });
/** A moment inside slot `s`. */
const at = (s: number) => s * B + 1_000;

test("sameInflight: an unchanged frame is equal; any change to the count, its coverage or the ring is not", () => {
  const a: LlmInflight = { count: 2, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] };
  assert.equal(sameInflight(a, { ...a, gaps: [{ reason: "claude-internal" }] }), true);
  assert.equal(sameInflight(null, null), true);
  assert.equal(sameInflight(a, null), false, "unknown is never the same as a count");
  assert.equal(sameInflight(complete(0), null), false, "a complete 0 is not unknown");
  assert.equal(sameInflight(a, { ...a, count: 3 }), false);
  assert.equal(sameInflight(a, { ...a, partial: false, gaps: [] }), false);
  assert.equal(sameInflight(a, { ...a, gaps: [{ reason: "claude-internal", host: "peer-a" }] }), false);
  const t = withTokens(ring(100, { 0: 5 }));
  assert.equal(sameInflight(t, withTokens(ring(100, { 0: 5 }))), true);
  assert.equal(sameInflight(t, withTokens(ring(100, { 0: 6 }))), false, "a frame that only moves the ring still wakes the sidebar");
  assert.equal(sameInflight(t, withTokens(ring(101, { 1: 5 }))), false);
  assert.equal(sameInflight(t, withTokens(ring(100, { 0: 5 }, true))), false);
  assert.equal(sameInflight(t, complete(0)), false, "a ring appearing is a change");
});

test("dense format: whole under 1,000, one decimal to 9,999, none from 10,000, one decimal from a million", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [840, "840"],
    [999, "999"],
    [999.4, "999"],
    [999.6, "1.0k"], // rounds into the next tier, printed there
    [1000, "1.0k"],
    [8400, "8.4k"],
    [9949, "9.9k"],
    [9950, "10k"],
    [9999, "10k"],
    [10_000, "10k"],
    [48_200, "48k"],
    [120_000, "120k"],
    [999_499, "999k"],
    [999_999, "1.0M"],
    [1_000_000, "1.0M"],
    [1_240_000, "1.2M"],
    [12_300_000, "12.3M"],
  ];
  for (const [n, s] of cases) assert.equal(denseCount(n), s, `${n}`);
  assert.equal(denseCount(-5), "0", "never a negative");
  assert.equal(denseCount(Number.NaN), "0");
});

test("unknown: no snapshot, or a server with no ring — a dash, an empty chart, never a 0, no tick", () => {
  for (const f of [null, complete(3)]) {
    const v = tokenVelocityView(f, at(100));
    assert.equal(v.state, "unknown");
    assert.equal(v.readout, "–");
    assert.equal(v.perMinute, null);
    assert.equal(v.series.length, 60);
    assert.ok(v.series.every((x) => x === 0));
    assert.equal(v.mean30, 0);
    assert.equal(v.scale, VELOCITY_SCALE_FLOOR);
    assert.equal(v.sentence, "Output tokens a minute: not known yet.");
    assert.equal(v.active, false);
    const c = velocityChart(v, 1, 18);
    assert.deepEqual([c.columns, c.meanY], [[], null], "the baseline alone: the row keeps its height");
  }
  const bad = withTokens({ bucketMs: 0, end: 1, out: [], partial: false });
  assert.equal(tokenVelocityView(bad, at(1)).state, "unknown", "a ring it can't read is unknown");
});

test("windowed means per minute over 5 and 30 minutes; the readout is the 5-minute one", () => {
  // 3,000 tokens 1 minute ago, 6,000 ten minutes ago, 12,000 twenty minutes ago.
  const t = ring(1000, { 2: 3000, 20: 6000, 40: 12_000 });
  const v = tokenVelocityView(withTokens(t), at(1000));
  assert.deepEqual(v.perMinute, [3000 / 5, (3000 + 6000 + 12_000) / 30]);
  assert.equal(v.readout, "600");
  assert.equal(v.mean30, 700);
  assert.equal(v.state, "complete");
  assert.equal(v.sentence, "Output tokens a minute: 600 over the last 5 minutes, 700 over 30. Replies still being written aren't counted yet.");
  assert.doesNotMatch(v.sentence, /15/, "the 15-minute mean is gone from the words too");
  assert.equal(v.active, true);
});

test("window edges: exactly 2W slots up to and including the current one", () => {
  const v = tokenVelocityView(withTokens(ring(500, { 9: 500, 10: 1000 })), at(500));
  assert.equal(v.perMinute![0], 100, "age 9 in the 5-minute window, age 10 out");
  assert.equal(v.perMinute![1], 50);
  const old = tokenVelocityView(withTokens(ring(500, { 59: 3000 })), at(500));
  assert.deepEqual(old.perMinute, [0, 100], "the ring's oldest slot is in the 30-minute window");
});

test("series: 60 per-minute rates, oldest first, the current slot last, aligned to the browser's clock", () => {
  const t = ring(1000, { 0: 500, 1: 200, 59: 100 });
  const v = tokenVelocityView(withTokens(t), at(1000));
  assert.equal(v.series.length, 60);
  assert.equal(v.series[59], 1000, "the current slot last, as a rate a minute (× 2)");
  assert.equal(v.series[58], 400);
  assert.equal(v.series[0], 200, "the ring's oldest slot first");
  // Two slots later the same ring has moved left; the slots after its newest read 0.
  const later = tokenVelocityView(withTokens(t), at(1002));
  assert.equal(later.series[57], 1000);
  assert.deepEqual(later.series.slice(58), [0, 0]);
  assert.equal(later.series[0], 0, "the oldest has dropped off");
});

test("scale: the 30 minutes' peak, never under 10k a minute", () => {
  const trickle = tokenVelocityView(withTokens(ring(10, { 3: 1000 })), at(10));
  assert.equal(trickle.scale, 10_000, "a 2k trickle is drawn against the floor");
  const busy = tokenVelocityView(withTokens(ring(10, { 3: 60_000, 9: 20_000 })), at(10));
  assert.equal(busy.scale, 120_000, "a 120k peak fills the height");
});

test("chart at 0, light, 100k+: baseline only, short columns, full height at the peak", () => {
  const zero = tokenVelocityView(withTokens(ring(10, {})), at(10));
  assert.equal(zero.readout, "0");
  assert.deepEqual(velocityChart(zero, 1, 18), { columns: [], meanY: null, count: 60 });
  // ~2k a minute steady: every slot 1,000 tokens.
  const steady = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, 1000]));
  const light = tokenVelocityView(withTokens(ring(10, steady)), at(10));
  assert.equal(light.readout, "2.0k");
  const lc = velocityChart(light, 1, 18);
  assert.equal(lc.columns.length, 60);
  assert.ok(lc.columns.every((c) => c.height === 3), "2k on a 10k floor: 20% of 16px");
  assert.equal(lc.meanY, 18 - 1 - 3);
  const heavy = tokenVelocityView(withTokens(ring(10, { ...steady, 5: 60_000 })), at(10));
  const hc = velocityChart(heavy, 1, 18);
  assert.equal(heavy.readout, "14k", "(9 × 1,000 + 60,000) / 5 minutes");
  assert.equal(heavy.scale, 120_000);
  assert.deepEqual(hc.columns.map((c) => [c.index, c.height]), [[54, 16]], "the peak column full height; 2k beside it is under a pixel, not drawn");
});

test("pale newest minute: the last two 30 s columns on the row, the last one-minute column on the phone", () => {
  const steady = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, 30_000]));
  const v = tokenVelocityView(withTokens(ring(10, steady)), at(10));
  const row = velocityChart(v, 1, 18);
  assert.deepEqual(row.columns.filter((c) => c.pale).map((c) => c.index), [58, 59]);
  const phone = velocityChart(v, 2, 16);
  assert.equal(phone.count, 30);
  assert.deepEqual(phone.columns.filter((c) => c.pale).map((c) => c.index), [29]);
  assert.ok(phone.columns.every((c) => c.height === 14), "pairs average into one-minute columns");
  assert.equal(phone.meanY, 1, "a mean at the peak sits level with the columns' tops");
});

test("the clock moves the windows between frames, and an emptied ring stops the tick", () => {
  const t = ring(1000, { 0: 6000 });
  assert.deepEqual(tokenVelocityView(withTokens(t), at(1000)).perMinute, [1200, 200]);
  assert.deepEqual(tokenVelocityView(withTokens(t), at(1012)).perMinute, [0, 200]);
  const gone = tokenVelocityView(withTokens(t), at(1060));
  assert.deepEqual(gone.perMinute, [0, 0]);
  assert.equal(gone.active, false);
  assert.deepEqual(tokenVelocityView(withTokens(t), at(999)).perMinute, [0, 0], "a browser clock behind the server's sums nothing ahead");
});

test("partial: the same readout and chart, \"at least\" and why in words only; the calls count's gaps don't decide it", () => {
  const p = tokenVelocityView(withTokens(ring(10, { 0: 48_000 * 5 }, true)), at(10));
  assert.equal(p.state, "partial");
  assert.equal(p.readout, "48k", "no + or ~ on the figure");
  assert.equal(p.sentence, "Output tokens a minute: at least 48k over the last 5 minutes, 8.0k over 30. Some calls' tokens can't be seen. Replies still being written aren't counted yet.");
  const same = tokenVelocityView(withTokens(ring(10, { 0: 48_000 * 5 })), at(10));
  assert.deepEqual(velocityChart(p, 1, 18), velocityChart(same, 1, 18));
  const callsPartial = withTokens(ring(10, {}), { count: 1, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(tokenVelocityView(callsPartial, at(10)).state, "complete", "the ring says its own coverage");
});

test("malformed slots count as nothing", () => {
  const t = ring(10, {});
  t.out[59] = Number.NaN;
  t.out[58] = -40;
  t.out[57] = 100;
  const v = tokenVelocityView(withTokens(t), at(10));
  assert.deepEqual(v.perMinute, [20, 100 / 30]);
  assert.deepEqual(v.series.slice(57), [200, 0, 0]);
});
