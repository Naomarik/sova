// Run: pnpm test -- src/lib/time-spent-view.test.ts
// The Time Spent section's figures (§app.subagents-pane/time-spent): the deck's durations, rows that
// add up to You to the second, the empty row hidden, Not Recording not ticking, and a running turn in Agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimeSpentAlignment, TimeSpentRecord } from "../../shared/time-spent";
import { modelLabel } from "./format";
import { alignmentWords, messageLines, screenshotParts, formatSpent, type SpentLive, spentView, wholeSeconds } from "./time-spent-view";

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
  assert.deepEqual(v.reading!.parts.map((p) => p.label), ["Alignments"]);
  const under = spentView(record({ rows: { typing: 0.4 } }), live(), 0);
  assert.deepEqual(under.rows, [], "under a second shows no 0s row");
});

test("Your Time's rows, in order, Reviewing Screenshots after Reviewing Changes; each counts toward You", () => {
  const rows = { typing: 1, dictating: 1, scrolling: 1, changes: 1, screenshots: 1, tours: 1, other: 1 };
  const v = spentView(record({ rows }), live(), 0);
  assert.deepEqual(v.rows.map((r) => r.label), ["Typing", "Dictating", "Scrolling", "Reviewing Changes", "Reviewing Screenshots", "Viewing Tours", "Other"]);
  assert.equal(v.you, 7, "the new row's second is in You, so the rows still add up");
});

test("Reading's parts are named without the word Reading, over the record's own keys", () => {
  const v = spentView(record({ rows: { "reading-transcript": 3, "reading-alignments": 2, "reading-workers": 1 } }), live(), 0);
  assert.deepEqual(v.reading!.parts.map((p) => [p.key, p.label]), [["reading-transcript", "Main Thread"], ["reading-alignments", "Alignments"], ["reading-workers", "Workers"]]);
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

const labelled = (over: Partial<Parameters<typeof messageLines>[0]> = {}) => ({
  rows: [{ key: "reworking" as const, seconds: 10.6, messages: [{ id: "m1", excerpt: "No", seconds: 7.3 }, { id: "m2", excerpt: "Redo", seconds: 3.3, labelledBy: "zai/glm-5.3" }] }],
  beforeAction: { count: 1, seconds: 4 },
  sinceLast: 5.4,
  ...over,
});

test("Your Messages: seconds not yet read are Since Your Last Message's, and the rows stay whole", () => {
  const lines = messageLines(labelled(), 23);
  assert.deepEqual(lines.map((l) => l.key), ["reworking", "before-action", "since-last"]);
  assert.equal(lines.reduce((n, l) => n + l.seconds, 0), 23, "You, to the second");
  assert.equal(lines.find((l) => l.key === "since-last")!.seconds, 9, "what the other rows leave, 10 and 4");
  const row = lines[0]!;
  assert.equal(row.count, 2);
  assert.equal(row.messages!.reduce((n, m) => n + m.seconds, 0), row.seconds, "a row's messages add up to it");
  assert.equal(lines[1]!.count, 1);
  assert.equal(lines[1]!.messages, null, "Before An Action opens to nothing");
  assert.equal(lines[2]!.count, null, "Since Your Last Message has no count");
  assert.equal(row.messages![1]!.labelledBy, modelLabel("zai/glm-5.3"), "the model's name, not its raw id");
  assert.notEqual(row.messages![1]!.labelledBy, "zai/glm-5.3");
  assert.equal(row.messages![0]!.labelledBy, null);
});

test("Your Messages: the rows add up to You to the second, while You ticks and whatever the read's fractions", () => {
  for (const unreported of [0, 1, 37]) {
    const you = 20 + unreported;
    const view = spentView(record({ rows: { typing: 20 }, you: 20, messages: labelled() }), live({ you: unreported, rows: { typing: unreported }, word: "Counting" }), 0);
    assert.equal(view.you, you);
    assert.equal(view.messages!.reduce((n, l) => n + l.seconds, 0), you, `${unreported}s not yet read`);
    assert.equal(view.messages!.find((l) => l.key === "since-last")!.seconds, 6 + unreported, "those seconds are Since Your Last Message's and no other row's");
  }
  const late = spentView(record({ rows: { typing: 1000 }, you: 1000, messages: labelled() }), live(), 0);
  assert.equal(late.messages!.reduce((n, l) => n + l.seconds, 0), 1000, "a read whose rows fall short of You still adds up");
});

test("Your Messages: a label's row with a message shows at 0 seconds; before-action and since-last don't, and no rows at all is null", () => {
  const lines = messageLines({ rows: [{ key: "asking", seconds: 0, messages: [{ id: "m", excerpt: "Why", seconds: 0 }] }], beforeAction: { count: 0, seconds: 0 }, sinceLast: 0 }, 0);
  assert.deepEqual(lines.map((l) => l.key), ["asking"]);
  const none = record({ you: 5, rows: { screenshots: 5 }, screenshots: { reworking: 5, specifying: 0, directing: 0, other: 0 }, messages: { rows: [], beforeAction: { count: 0, seconds: 0 }, sinceLast: 0 } });
  const view = spentView(none, live(), 0);
  assert.equal(view.messages, null);
  assert.equal(view.rows.find((r) => r.key === "screenshots")!.parts, undefined, "with no Your Messages the row doesn't open");
});

test("Reviewing Screenshots' parts add up to its row, unread seconds going to anything else, and an empty part doesn't show", () => {
  assert.deepEqual(screenshotParts({ reworking: 10, specifying: 0, directing: 0, other: 2 }, 15).map((p) => [p.label, p.seconds]), [["Followed By Reworking", 10], ["Followed By Anything Else", 5]]);
  assert.deepEqual(screenshotParts({ reworking: 10, specifying: 5, directing: 5, other: 0 }, 12).map((p) => p.seconds), [10, 2], "never more than the row");
  assert.deepEqual(
    screenshotParts({ reworking: 3, specifying: 4, directing: 5, other: 1 }, 13).map((p) => [p.label, p.seconds]),
    [["Followed By Reworking", 3], ["Followed By Specifying", 4], ["Followed By Directing", 5], ["Followed By Anything Else", 1]],
  );
});

test("Your Messages: the rows in order, Specifying first and Steering gone, whatever order the read sends them in", () => {
  const keys = ["not-labelled", "unsorted", "asking", "reworking", "directing", "specifying"] as const;
  const rows = keys.map((key, i) => ({ key, seconds: 1, messages: [{ id: `m${i}`, excerpt: key, seconds: 1 }] }));
  const lines = messageLines({ rows, beforeAction: { count: 1, seconds: 1 }, sinceLast: 0 }, 10);
  assert.deepEqual(
    lines.map((l) => l.label),
    ["Specifying", "Directing", "Reworking", "Asking", "Unsorted", "Not Labelled", "Before An Action", "Since Your Last Message"],
  );
});
