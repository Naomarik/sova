// Run: npx tsx --test src/lib/group-layout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampWidth,
  defaultPaneWidth,
  movePane,
  neighbourOf,
  orderPanes,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_WIDTH_STEP,
  parseWidths,
  stepWidth,
} from "./group-layout";

test("the default width splits the row, never below the floor", () => {
  assert.equal(defaultPaneWidth(1800, 2), 900);
  assert.equal(defaultPaneWidth(1200, 4), PANE_MIN_WIDTH); // 300 would be unusable
  assert.equal(defaultPaneWidth(0, 2), PANE_MIN_WIDTH);
  assert.equal(defaultPaneWidth(4000, 1), PANE_MAX_WIDTH);
  assert.equal(defaultPaneWidth(1800, 0), PANE_MIN_WIDTH);
});

test("Wider and Narrower move by one step and stop at the bounds", () => {
  assert.equal(stepWidth(600, 1), 600 + PANE_WIDTH_STEP);
  assert.equal(stepWidth(600, -1), 600 - PANE_WIDTH_STEP);
  assert.equal(stepWidth(PANE_MIN_WIDTH, -1), PANE_MIN_WIDTH);
  assert.equal(stepWidth(PANE_MAX_WIDTH, 1), PANE_MAX_WIDTH);
});

test("stored widths: bad shapes are dropped, good ones clamped", () => {
  assert.deepEqual(parseWidths(null), {});
  assert.deepEqual(parseWidths("not json"), {});
  assert.deepEqual(parseWidths("[1,2]"), {});
  assert.deepEqual(parseWidths('{"a": "wide", "b": 700, "c": 10}'), { b: 700, c: PANE_MIN_WIDTH });
  assert.equal(clampWidth(10_000), PANE_MAX_WIDTH);
});

test("stored order keeps moved panes in place and appends new members", () => {
  assert.deepEqual(orderPanes(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
  assert.deepEqual(orderPanes(["a", "b"], []), ["a", "b"]);
  // A path that left the group, and a duplicate, are ignored.
  assert.deepEqual(orderPanes(["a", "b"], ["gone", "b", "b"]), ["b", "a"]);
});

test("Move left/right walks one step and does nothing at the ends", () => {
  assert.deepEqual(movePane(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(movePane(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(movePane(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(movePane(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(movePane(["a", "b"], "gone", 1), ["a", "b"]);
});

test("removing a pane hands focus to its right-hand neighbour, else its left", () => {
  assert.equal(neighbourOf(["a", "b", "c"], "b"), "c");
  assert.equal(neighbourOf(["a", "b"], "b"), "a");
  assert.equal(neighbourOf(["a"], "a"), null);
  assert.equal(neighbourOf(["a"], "gone"), null);
});
