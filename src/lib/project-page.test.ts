import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PO_CAPS } from "../../shared/project-overseer";
import { attentionLine, emptySectionsLine, LIMIT_COLUMNS, LIMIT_ROWS, limitCell, paceLine } from "./project-page";

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
