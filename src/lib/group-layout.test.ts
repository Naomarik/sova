// Run: npx tsx --test src/lib/group-layout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampWidth,
  defaultPaneWidth,
  movePane,
  neighbourOf,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_WIDTH_STEP,
  stepWidth,
} from "./group-layout";

test("a pane starts at clamp(440px, 34vw, 720px)", () => {
  assert.equal(defaultPaneWidth(1600), 544);
  assert.equal(defaultPaneWidth(1000), PANE_MIN_WIDTH); // 340 would be unusable
  assert.equal(defaultPaneWidth(3000), 720);
  assert.equal(defaultPaneWidth(0), PANE_MIN_WIDTH);
});

test("Wider and Narrower move by one step and stop at the bounds", () => {
  assert.equal(stepWidth(600, 1), 600 + PANE_WIDTH_STEP);
  assert.equal(stepWidth(600, -1), 600 - PANE_WIDTH_STEP);
  assert.equal(stepWidth(PANE_MIN_WIDTH, -1), PANE_MIN_WIDTH);
  assert.equal(stepWidth(PANE_MAX_WIDTH, 1), PANE_MAX_WIDTH);
  assert.equal(clampWidth(10_000), PANE_MAX_WIDTH);
  assert.equal(clampWidth(10), PANE_MIN_WIDTH);
});

test("Move Left/Right walks one step, returns the whole order, and does nothing at the ends", () => {
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
