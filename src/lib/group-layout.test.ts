// Run: npx tsx --test src/lib/group-layout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampWidth,
  defaultPaneWidth,
  fitPaneWidth,
  movePane,
  neighbourOf,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_WIDTH_STEP,
  stepFrom,
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

// The focus move itself is the workspace's; this asserts only which pane it picks.
test("neighbourOf picks the removed pane's right-hand neighbour, else its left", () => {
  assert.equal(neighbourOf(["a", "b", "c"], "b"), "c");
  assert.equal(neighbourOf(["a", "b"], "b"), "a");
  assert.equal(neighbourOf(["a"], "a"), null);
  assert.equal(neighbourOf(["a"], "gone"), null);
});

test("fitPaneWidth divides the row so N panes never overflow it", () => {
  // The comparison the default width cannot host: 4×440 = 1760 > 1120, but a fit can.
  assert.equal(fitPaneWidth(1120, 4), 280);
  assert.equal(fitPaneWidth(1180, 4), 295);
  // 3-way at the measured live widths, and the audit's headline numbers.
  assert.equal(fitPaneWidth(1120, 3), 373); // floor, not round: 3×374 would overflow by 2
  assert.equal(fitPaneWidth(1600, 3), 533);
  // 2-way fills the row but stops at the stepped ceiling: a pane past it hides its neighbour,
  // which is the opposite of what a fit is for.
  assert.equal(fitPaneWidth(1600, 2), 800); // 1600/2, below the 1040 stepped ceiling
  assert.equal(fitPaneWidth(3000, 2), PANE_MAX_WIDTH);
  // A count that needs no fitting still gets a whole number in range, capped like any width.
  assert.equal(fitPaneWidth(1120, 1), 1040);
  // N×width never exceeds the row: the property the scrollbar's absence rests on.
  for (const [row, n] of [[1120, 4], [1600, 3], [1180, 6], [977, 5]] as const) {
    assert.ok(fitPaneWidth(row, n) * n <= row, `${n} panes of ${fitPaneWidth(row, n)} overflow ${row}`);
  }
  // Degenerate inputs fall back to the floor, never to NaN or 0.
  assert.equal(fitPaneWidth(-5, 4), PANE_MIN_WIDTH);
  assert.equal(fitPaneWidth(Number.NaN, 4), PANE_MIN_WIDTH);
  assert.equal(fitPaneWidth(1120, 0), PANE_MIN_WIDTH);
});

test("a fitted width leaves the stepped range deliberately: Wider returns, Narrower holds", () => {
  // Below the floor, Narrower must not move — the button would say "narrower" and widen the pane to 440.
  assert.equal(stepFrom(280, -1), 280);
  assert.equal(stepFrom(439, -1), 439);
  // Wider from a fit lands on the floor, the first honest step of the stepped range.
  assert.equal(stepFrom(280, 1), PANE_MIN_WIDTH);
  // In the stepped range, stepFrom is stepWidth.
  assert.equal(stepFrom(600, 1), 600 + PANE_WIDTH_STEP);
  assert.equal(stepFrom(PANE_MIN_WIDTH, -1), PANE_MIN_WIDTH);
});
