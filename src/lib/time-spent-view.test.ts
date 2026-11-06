// Run: pnpm test -- src/lib/time-spent-view.test.ts
// The Time Spent section's figures (§app.subagents-pane/time-spent): the deck's durations, rows that
// add up to You to the second, the empty row hidden, Not Recording not ticking, and a running turn in Agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimeSpentAlignment, TimeSpentRecord } from "../../shared/time-spent";
import { alignmentWords, formatSpent, type SpentLive, spentView, wholeSeconds } from "./time-spent-view";

const record = (over: Partial<TimeSpentRecord> = {}): TimeSpentRecord => ({ you: 0, rows: {}, agent: 0, agentRunning: null, alignments: [], older: false, ...over });
const live = (over: Partial<SpentLive> = {}): SpentLive => ({ you: 0, rows: {}, cards: {}, word: "Paused", ...over });

test("durations read as the copy deck writes them", () => {
  assert.equal(formatSpent(4328), "1h 12m 08s");
  assert.equal(formatSpent(848), "14m 08s");
  assert.equal(formatSpent(8), "8s");
  assert.equal(formatSpent(0), "0s");
  assert.equal(formatSpent(3600), "1h 00m 00s");
  assert.equal(formatSpent(8.9), "8s", "whole seconds, never rounded up past what counted");
  assert.equal(formatSpent(Number.NaN), "0s");
});

test("whole seconds add up exactly, whatever the fractions", () => {
  const order = ["a", "b", "c"] as const;
  for (const values of [{ a: 0.4, b: 0.4, c: 0.4 }, { a: 1.5, b: 1.5, c: 1.5 }, { a: 0.1, b: 0.2, c: 0.7 }, { a: 59.999, b: 0.001, c: 0 }]) {
    const whole = wholeSeconds(values, order);
    const sum = whole.a + whole.b + whole.c;
    assert.equal(sum, Math.floor(values.a + values.b + values.c + 1e-6), JSON.stringify(values));
    for (const k of order) assert.ok(Number.isInteger(whole[k]));
  }
});

test("the rows add up to You, and Reading's parts to Reading, record and live together", () => {
  const v = spentView(
    record({ rows: { "reading-transcript": 100.4, "reading-alignments": 20.4, "reading-workers": 5.4, typing: 60.4, scrolling: 3.4, other: 1.4 } }),
    live({ word: "Counting", rows: { typing: 2.6, "reading-workers": 0.6 } }),
    0,
  );
  const rows = v.rows.reduce((n, r) => n + r.seconds, 0);
  assert.equal(rows + v.reading!.seconds, v.you);
  assert.equal(v.reading!.parts.reduce((n, p) => n + p.seconds, 0), v.reading!.seconds);
  assert.equal(v.you, 194); // 194.6 counted: a part of a second never shows
});

test("a row with no time doesn't show, Reading and its parts included; the rest keep their order", () => {
  const none = spentView(record(), live(), 0);
  assert.equal(none.reading, null);
  assert.deepEqual(none.rows, []);
  const v = spentView(record({ rows: { other: 3, tours: 2, typing: 1, "reading-alignments": 4 } }), live(), 0);
  assert.deepEqual(v.rows.map((r) => r.label), ["Typing", "Viewing Tours", "Other"]);
  assert.deepEqual(v.reading!.parts.map((p) => p.label), ["Reading Alignments"]);
  const under = spentView(record({ rows: { typing: 0.4 } }), live(), 0);
  assert.deepEqual(under.rows, [], "under a second shows no 0s row");
});

test("Not Recording keeps the figure from before and doesn't tick; alignments' on screen with it", () => {
  const before = record({ rows: { typing: 10 }, alignments: [{ docId: "d", title: "T", onScreen: 5, toRead: 60, firstShownAt: null, toDecided: null } as TimeSpentAlignment] });
  const pending = { rows: { typing: 4 }, cards: { d: 4 } };
  const off = spentView(before, live({ word: "Not Recording", ...pending }), 0);
  assert.equal(off.word, "Not Recording");
  assert.equal(off.you, 10);
  assert.match(off.alignments[0]!.words, /^5s on screen/);
  const on = spentView(before, live({ word: "Counting", ...pending }), 0);
  assert.equal(on.you, 14);
  assert.match(on.alignments[0]!.words, /^9s on screen/);
});

test("Agent takes in a running turn, and a finished one stops growing", () => {
  assert.equal(spentView(record({ agent: 120, agentRunning: 20 }), live(), 7.5).agent, 127, "agent already holds the 20s; only what passed since the read is added");
  assert.equal(spentView(record({ agent: 100 }), live(), 7.5).agent, 100);
});

test("an alignment line leaves out first shown to decided when it has none", () => {
  assert.equal(alignmentWords(252, 130, null), "4m 12s on screen · 2m 10s to read");
  assert.equal(alignmentWords(252, 130, 3700), "4m 12s on screen · 2m 10s to read · 1h 01m 40s from first shown to decided");
});
