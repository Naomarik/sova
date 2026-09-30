// Run: npx tsx --test src/lib/pipeline-view.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  byWord,
  cancelLabel,
  cancelledLine,
  heldFromLine,
  heldLine,
  inPhaseFor,
  logStamp,
  minutesLeft,
  moveLine,
  PHASES,
  phaseChip,
  phaseDetail,
  pipelineOrder,
  pipelineSummary,
  stalledTitle,
  STAGES,
  timelineOrder,
} from "./pipeline-view";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;
const row = (itemId: string, phase: string, since = ago(H), extra: object = {}) => ({ itemId, title: itemId, phase, since, ...extra });

test("phaseChip: the stage word the claim names, in the lane state's tone when it waits on you or failed", () => {
  assert.deepEqual(phaseChip("asking"), STAGES.gathering);
  assert.deepEqual(phaseChip("needs-operator"), { word: "Gathering", tone: "warn", live: undefined });
  assert.deepEqual(phaseChip("conflicted"), { word: "Deciding", tone: "warn", live: undefined });
  assert.deepEqual(phaseChip("failed"), { word: "Promoted", tone: "error", live: undefined });
  assert.deepEqual(phaseChip("working"), { word: "Promoted", tone: "accent", live: true });
  assert.equal(phaseChip("on-hold").word, "On hold");
  assert.equal(phaseChip("done").word, "Done");
  assert.equal(phaseChip("open").word, "Open");
});

test("every lane state maps to one of the claim's stages", () => {
  const stages = new Set(["open", "gathering", "deciding", "promoted", "done", "on-hold", "dropped"]);
  for (const [id, p] of Object.entries(PHASES)) assert.ok(stages.has(p.stage), id);
});

test("an unknown lane state reads as its own id, under Open, never as nothing", () => {
  assert.equal(phaseDetail("follow-up-starting"), "Follow up starting");
  assert.equal(phaseChip("follow-up-starting").word, "Open");
  assert.equal(phaseDetail(""), "Unknown");
});

test("pipelineOrder: dropped not listed; waiting on you, then stalled, then the rest, on hold, done last", () => {
  const rows = [
    row("done", "done"),
    row("drop", "dropped"),
    row("hold", "on-hold"),
    row("ask", "asking"),
    row("stall", "awaiting-build", ago(4 * 24 * H), { stalled: { since: ago(H) } }),
    row("conf", "conflicted"),
    row("fail", "failed"),
    row("open", "open"),
  ];
  assert.deepEqual(
    pipelineOrder(rows).map((r) => r.itemId),
    ["conf", "fail", "stall", "open", "ask", "hold", "done"],
  );
});

test("pipelineOrder: ties go longest in phase first, then title", () => {
  const rows = [row("b", "asking", ago(H)), row("a", "asking", ago(H)), row("c", "asking", ago(2 * H))];
  assert.deepEqual(pipelineOrder(rows).map((r) => r.itemId), ["c", "a", "b"]);
});

test("inPhaseFor: for how long, just now under a minute, nothing when unreadable", () => {
  assert.equal(inPhaseFor(ago(30_000), NOW), "just now");
  assert.equal(inPhaseFor(ago(2 * H + 5 * 60_000), NOW), "for 2h 5m");
  assert.equal(inPhaseFor(ago(3 * 24 * H), NOW), "for 3d");
  assert.equal(inPhaseFor("nope", NOW), "");
});

test("stalledTitle and heldFromLine say the lane state in words", () => {
  const r = row("x", "asking", ago(4 * 24 * H), { stalled: { since: ago(H) } });
  assert.equal(stalledTitle(r, NOW), "Waiting past its stall time: asking for 4d. The overseer was asked to look.");
  assert.equal(stalledTitle(row("y", "asking"), NOW), "");
  assert.equal(heldFromLine({ held: { since: ago(H), from: "needs-operator" } }), "Resume puts it back where it was: needs you.");
  assert.equal(heldFromLine({}), "");
});

test("pipelineSummary: open, stalled, on hold and done counts; dropped not counted; empty when nothing listed", () => {
  assert.equal(pipelineSummary([]), "");
  assert.equal(pipelineSummary([row("d", "dropped")]), "");
  assert.equal(pipelineSummary([row("a", "asking")]), "1 gap open.");
  assert.equal(
    pipelineSummary([row("a", "asking", ago(H), { stalled: { since: ago(H) } }), row("b", "on-hold"), row("c", "done"), row("d", "dropped")]),
    "2 gaps open · 1 stalled · 1 on hold · 1 done.",
  );
});

test("heldLine: decisions.md r2's sentence, minutes rounded up, 'starting now' once due", () => {
  const what = "A gathering with Sam Okafor about pricing";
  assert.equal(heldLine(what, NOW + 10 * 60_000, NOW), "A gathering with Sam Okafor about pricing starts in 10 min unless you cancel it.");
  assert.equal(heldLine(`${what}.`, NOW + 9 * 60_000 + 1, NOW), "A gathering with Sam Okafor about pricing starts in 10 min unless you cancel it.");
  assert.equal(heldLine(what, NOW + 5_000, NOW), "A gathering with Sam Okafor about pricing starts in 1 min unless you cancel it.");
  assert.equal(heldLine(what, NOW, NOW), "A gathering with Sam Okafor about pricing is starting now.");
  assert.equal(minutesLeft(NOW - 1, NOW), 0);
});

test("cancel's name and its done line name the act", () => {
  assert.equal(cancelLabel("Promotion of 3 decisions."), "Cancel: Promotion of 3 decisions");
  assert.equal(cancelledLine("Promotion of 3 decisions"), "Cancelled. Promotion of 3 decisions won't happen.");
});

test("byWord: you, you via the Overseer, the overseer, Sova, a person by name", () => {
  assert.equal(byWord("operator"), "You");
  assert.equal(byWord("operator", "overseer"), "You via the Overseer");
  assert.equal(byWord("overseer"), "Overseer");
  assert.equal(byWord("chart"), "Sova");
  assert.equal(byWord("Sam Okafor"), "Sam Okafor");
});

test("moveLine: the lane states in words, nothing when it didn't move", () => {
  assert.equal(moveLine({ from: "asking", to: "needs-operator" }), "Asking → Needs you");
  assert.equal(moveLine({ from: "asking", to: "asking" }), "");
  assert.equal(moveLine({}), "");
});

test("timelineOrder: newest first; one time keeps the later log row first", () => {
  const rows = [
    { at: ago(3 * H), by: "chart", line: "a" },
    { at: ago(H), by: "chart", line: "b" },
    { at: ago(H), by: "chart", line: "c" },
  ];
  assert.deepEqual(timelineOrder(rows).map((r) => r.line), ["c", "b", "a"]);
  assert.deepEqual(timelineOrder([...rows, { at: ago(0), by: "chart", line: "lease renewed", quiet: true }]).map((r) => r.line), ["c", "b", "a"], "a quiet row is left out (r8a)");
});

test("logStamp: 24-hour clock today, date and clock before, year when not this year", () => {
  const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  assert.equal(logStamp(local(2026, 8, 30, 9, 5), now), "09:05");
  assert.equal(logStamp(local(2026, 2, 4, 14, 6), now), "Mar 4 14:06");
  assert.equal(logStamp(local(2025, 11, 31, 23, 59), now), "Dec 31 2025 23:59");
  assert.equal(logStamp("nope", now), "");
});

test("heldWaitLine: the hold's r2 sentence; an hours wait's send time on your clock; a review wait's stall clock (r7, r8)", async () => {
  const { heldWaitLine, sendAt } = await import("./pipeline-view");
  const now = new Date(2026, 8, 30, 15, 0).getTime(); // a Wednesday
  const what = "A message to Sam Okafor";
  assert.equal(heldWaitLine({ what, goesAt: now + 5 * 60_000 }, now), "A message to Sam Okafor starts in 5 min unless you cancel it.");
  const tomorrow9 = new Date(2026, 9, 1, 9, 0).getTime();
  assert.equal(
    heldWaitLine({ what, goesAt: tomorrow9, wait: "hours", person: "Sam Okafor" }, now),
    "A message to Sam Okafor waits for Sam Okafor's working hours: it starts at Thu 09:00 (in 18h) unless you cancel it.",
  );
  assert.equal(heldWaitLine({ what, goesAt: tomorrow9, wait: "hours" }, now).includes("waits for their working hours"), true);
  assert.equal(heldWaitLine({ what, goesAt: now - 1, wait: "hours", person: "Sam" }, now), "A message to Sam Okafor is starting now.");
  assert.equal(
    heldWaitLine({ what, goesAt: now - 12 * 60_000, reviewSince: now - 12 * 60_000 }, now),
    "A message to Sam Okafor is waiting for the overseer's review, for 12m. It goes ahead only when the overseer approves it; you can cancel it.",
  );
  assert.equal(sendAt(new Date(2026, 8, 30, 18, 30).getTime(), now), "18:30");
  assert.equal(sendAt(new Date(2026, 9, 5, 9, 0).getTime(), now), "Mon 09:00");
  assert.equal(sendAt(new Date(2026, 9, 12, 9, 0).getTime(), now), "Oct 12 09:00");
});

test("followUpLine: the follow-up region in words; none when no follow-up runs", async () => {
  const { followUpLine } = await import("./pipeline-view");
  assert.deepEqual(followUpLine("follow-up-asking"), { text: "A follow-up gathering is asking.", warn: false });
  assert.deepEqual(followUpLine("follow-up-needs-operator"), { text: "A follow-up gathering needs you.", warn: true });
  assert.equal(followUpLine("no-follow-up"), null);
  assert.equal(followUpLine(undefined), null);
});
