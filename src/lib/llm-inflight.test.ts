// Run: pnpm exec tsx --test src/lib/llm-inflight.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmInflight, LlmTokens } from "../../shared/protocol";
import { denseCount, sameInflight, tokenVelocityView } from "./llm-inflight";

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

test("unknown: no snapshot, or a server with no ring — one dash, never a 0, no tick", () => {
  for (const f of [null, complete(3)]) {
    const v = tokenVelocityView(f, at(100));
    assert.equal(v.state, "unknown");
    assert.equal(v.figures, "–");
    assert.equal(v.perMinute, null);
    assert.equal(v.sentence, "Output tokens a minute: not known yet.");
    assert.equal(v.active, false);
  }
  const bad = withTokens({ bucketMs: 0, end: 1, out: [], partial: false });
  assert.equal(tokenVelocityView(bad, at(1)).state, "unknown", "a ring it can't read is unknown");
});

test("windowed means per minute over 5, 15 and 30 minutes, newest window first", () => {
  // 10 slots a minute's worth = 2 slots/minute. 3,000 tokens 1 minute ago, 6,000 ten minutes ago,
  // 12,000 twenty minutes ago.
  const t = ring(1000, { 2: 3000, 20: 6000, 40: 12_000 });
  const v = tokenVelocityView(withTokens(t), at(1000));
  assert.deepEqual(v.perMinute, [3000 / 5, (3000 + 6000) / 15, (3000 + 6000 + 12_000) / 30]);
  assert.equal(v.figures, "600 600 700");
  assert.equal(v.state, "complete");
  assert.equal(v.sentence, "Output tokens a minute: 600 over the last 5 minutes, 600 over 15, 700 over 30. Replies still being written aren't counted yet.");
  assert.equal(v.active, true);
});

test("window edges: exactly 2W slots up to and including the current one", () => {
  // The 5-minute window is slots (cur − 10, cur]: age 9 is in, age 10 is out.
  const t = ring(500, { 9: 500, 10: 1000 });
  const v = tokenVelocityView(withTokens(t), at(500));
  assert.equal(v.perMinute![0], 100);
  assert.equal(v.perMinute![1], 100, "both in the 15-minute window");
  // Age 59 is the ring's oldest: in the 30-minute window; nothing older exists.
  const old = tokenVelocityView(withTokens(ring(500, { 59: 3000 })), at(500));
  assert.deepEqual(old.perMinute, [0, 0, 100]);
});

test("the clock moves the windows between frames: slots after the ring's newest read 0, older ones drop off", () => {
  const t = ring(1000, { 0: 6000 });
  assert.deepEqual(tokenVelocityView(withTokens(t), at(1000)).perMinute, [1200, 400, 200]);
  // 6 minutes later (12 slots): out of the 5-minute window, still in the others.
  assert.deepEqual(tokenVelocityView(withTokens(t), at(1012)).perMinute, [0, 400, 200]);
  // 30 minutes later: gone, and the ring is idle, so the sidebar stops ticking.
  const gone = tokenVelocityView(withTokens(t), at(1060));
  assert.deepEqual(gone.perMinute, [0, 0, 0]);
  assert.equal(gone.figures, "0 0 0");
  assert.equal(gone.active, false);
  // A browser clock behind the server's: the slots ahead of `now` aren't summed yet.
  assert.deepEqual(tokenVelocityView(withTokens(t), at(999)).perMinute, [0, 0, 0]);
});

test("complete at 0 reads 0 0 0 and doesn't tick", () => {
  const v = tokenVelocityView(withTokens(ring(10, {})), at(10));
  assert.equal(v.state, "complete");
  assert.equal(v.figures, "0 0 0");
  assert.equal(v.active, false);
  assert.equal(v.sentence, "Output tokens a minute: 0 over the last 5 minutes, 0 over 15, 0 over 30. Replies still being written aren't counted yet.");
});

test("partial: bare numbers, \"at least\" and why in words only; the calls count's gaps don't decide it", () => {
  const p = tokenVelocityView(withTokens(ring(10, { 0: 48_000 * 5 }, true)), at(10));
  assert.equal(p.state, "partial");
  assert.equal(p.figures, "48k 16k 8.0k", "no + or ~ on the numbers");
  assert.equal(
    p.sentence,
    "Output tokens a minute: at least 48k over the last 5 minutes, 16k over 15, 8.0k over 30. Some calls' tokens can't be seen. Replies still being written aren't counted yet.",
  );
  const callsPartial = withTokens(ring(10, {}), { count: 1, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] });
  assert.equal(tokenVelocityView(callsPartial, at(10)).state, "complete", "the ring says its own coverage");
});

test("malformed slots count as nothing", () => {
  const t = ring(10, {});
  t.out[59] = Number.NaN;
  t.out[58] = -40;
  t.out[57] = 100;
  assert.deepEqual(tokenVelocityView(withTokens(t), at(10)).perMinute, [20, 100 / 15, 100 / 30]);
});
