import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpecTurnInfo, TranscriptItem } from "../../shared/protocol";
import { byArea, changeWord, leftOpen, rowsWithCard, specTurnLine, withoutClosingLines } from "./spec-card";

test("the closing spec lines go; the body, and a line inside it, stay", () => {
  const reply = "Merged master; checks pass.\n\nAlso changes: is how the line starts.\nMore body.\n\nPlumbing: scripts/run-tests.mjs — test runner globs\nDeferred: §chat/merge-round — waits on the replay run\nSpec check override: the list is wrong\nAlso changes: §app.harness/reader — goldens";
  assert.equal(withoutClosingLines(reply), "Merged master; checks pass.\n\nAlso changes: is how the line starts.\nMore body.");
  assert.equal(withoutClosingLines("Just a reply."), "Just a reply.");
  assert.equal(withoutClosingLines("Also changes: none"), "", "a reply that is only the line leaves nothing");
});

const row = (id: string, kind: TranscriptItem["kind"]): TranscriptItem => ({ id, kind });

test("a reply's closing lines are the card's when its run has one, never another run's", () => {
  const rows = [
    row("u1", "user"),
    row("a1:0", "assistant-text"),
    row("a1:1", "tool-call"),
    row("a2:0", "assistant-text"),
    row("st1", "spec-turn"),
    row("u2", "user"),
    row("a3:0", "assistant-text"),
    row("w1", "wake"),
    row("a4:0", "assistant-text"),
    row("st2", "spec-turn"),
  ];
  assert.deepEqual([...rowsWithCard(rows)].sort(), ["a1:0", "a2:0", "a4:0"]);
});

const turn = (over: Partial<SpecTurnInfo> = {}): SpecTurnInfo => ({
  v: 1,
  ops: [],
  own: [
    { id: "§app.harness/reader", what: "goldens", change: "text" },
    { id: "§app.harness/session", change: "text+record" },
    { id: "§chat/merge-round", change: "child-added" },
  ],
  landed: [{ id: "§app.harness/wire" }],
  created: [],
  gate: { unmapped: [], unpromoted: [], stale: [], handResolved: [] },
  check: { ok: true, reprompts: 0 },
  ...over,
});

test("the collapsed line: changed § and arrivals, a 0 part left out", () => {
  assert.equal(specTurnLine(turn({ arrived: { from: "master", count: 83, byArea: [] } })), "Spec · 4 § changed · 83 § from master");
  assert.equal(specTurnLine(turn()), "Spec · 4 § changed");
  assert.equal(specTurnLine(turn({ own: [], landed: [] })), "Spec · no § changed");
});

test("rows group by area in first-seen order; change kinds read as words", () => {
  assert.deepEqual(
    byArea(turn().own).map((g) => [g.area, g.items.length]),
    [
      ["app.harness", 2],
      ["chat", 1],
    ],
  );
  assert.equal(changeWord("text+record"), "Text + record");
  assert.equal(changeWord("child-added"), "New child");
  assert.equal(changeWord(undefined), undefined);
});

test("Left open only when something is", () => {
  assert.equal(leftOpen(turn()), false);
  assert.equal(leftOpen(turn({ gate: { unmapped: [{ path: "a.ts" }], unpromoted: [], stale: [], handResolved: [] } })), true);
  assert.equal(leftOpen(turn({ check: { ok: false, problem: "omits §x", reprompts: 2 } })), true);
});
