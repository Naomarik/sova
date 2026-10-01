import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PO_CAPS } from "../../shared/project-overseer";
import { attentionLine, confirmSummary, emptySectionsLine, levelWords, LIMIT_COLUMNS, LIMIT_ROWS, limitCell, paceLine, summaryChips } from "./project-page";

test("levelWords: the level and its meaning's first word", () => {
  assert.equal(levelWords("L0"), "L0 Propose");
  assert.equal(levelWords("L3"), "L3 Build");
});

test("summaryChips: a count not read yet is left out, never shown as 0", () => {
  assert.deepEqual(summaryChips({}), []);
  const ids = summaryChips({ sessions: 0, todos: 2 }).map((c) => c.id);
  assert.deepEqual(ids, ["sessions", "todos"]);
});

test("summaryChips: labels, order, tabs and the conflicts' warn", () => {
  const chips = summaryChips({
    sessions: 1,
    previews: 2,
    cost: "$27.21",
    conflicts: 3,
    decisions: { total: 1, ready: 1 },
    ideas: { gaps: 2, other: 1 },
    todos: 0,
  });
  assert.deepEqual(
    chips.map((c) => [c.label, c.tab, c.section]),
    [
      ["1 session", "overview", "project-coding"],
      ["2 previews", "overview", "project-previews"],
      ["$27.21", "cost", "project-cost"],
      ["3 conflicts", "requirements", "project-conflicts"],
      ["1 decision", "requirements", "project-decisions"],
      ["2 gaps · 1 idea", "requirements", "project-ideas"],
      ["0 to-dos", "overview", "project-todos"],
    ],
  );
  assert.equal(chips.find((c) => c.id === "conflicts")!.tone, "warn");
  assert.equal(chips.find((c) => c.id === "decisions")!.title, "1 ready to promote");
  assert.equal(summaryChips({ conflicts: 0 })[0]!.tone, undefined, "no open conflict is not a warning");
  assert.equal(summaryChips({ ideas: { gaps: 1, other: 0 } })[0]!.label, "1 gap");
});

test("attentionLine: only what waits, null when nothing does", () => {
  assert.equal(attentionLine(0, 0), null);
  assert.equal(attentionLine(1, 0), "1 conflict open.");
  assert.equal(attentionLine(0, 4), "4 decisions ready to promote.");
  assert.equal(attentionLine(2, 1), "2 conflicts open · 1 decision ready to promote.");
});

test("emptySectionsLine: names only the empty sections, null when none is", () => {
  const none = { conflicts: false, decisions: false, pipeline: false, ideas: false };
  assert.equal(emptySectionsLine(none), null);
  assert.equal(emptySectionsLine({ ...none, pipeline: true }), "No pipeline rows yet.");
  assert.equal(emptySectionsLine({ ...none, conflicts: true, ideas: true }), "No conflicts or ideas yet.");
  assert.equal(emptySectionsLine({ conflicts: true, decisions: true, pipeline: true, ideas: true }), "No conflicts, decisions, pipeline rows or ideas yet.");
});

test("confirmSummary: all, some (named, in the list's order), none", () => {
  const all = ["gather", "offer", "promote"];
  const label = (k: string) => k.toUpperCase();
  assert.equal(confirmSummary(all, all, label), "All 3 wait for its approval.");
  assert.equal(confirmSummary(["promote", "gather"], all, label), "2 of 3 wait for its approval: GATHER, PROMOTE.");
  assert.equal(confirmSummary([], all, label), "None waits for its approval.");
  assert.equal(confirmSummary(["unknown"], all, label), "None waits for its approval.", "a kind the list doesn't know isn't counted");
});

test("the Limits table covers every cap exactly once", () => {
  const keys = LIMIT_ROWS.flatMap((r) => LIMIT_COLUMNS.map((c) => r.cells[c]).filter(Boolean));
  assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_PO_CAPS).sort());
  // The at-once limits are the only ones in the At once column, and never Unlimited-able elsewhere.
  assert.deepEqual(
    LIMIT_ROWS.filter((r) => r.cells.once).map((r) => r.cells.once),
    ["gatheringsOpen", "codingRunning"],
  );
});

test("limitCell and paceLine", () => {
  assert.equal(limitCell(null), "∞");
  assert.equal(limitCell(0), "0");
  assert.equal(limitCell(12), "12");
  assert.equal(paceLine(10, 60, 10), "Looks at most every 10 min · Within 1 min after a session finishes · Hold: 10 min");
  assert.equal(paceLine(60, null, 0), "Looks at most every 1 hour · No sooner look after a session finishes · Hold: No hold");
});
