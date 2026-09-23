// Run: npx tsx --test src/lib/group-layout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoPaneWidth,
  clampWidth,
  defaultPaneWidth,
  fitPaneWidth,
  paneWidths,
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

test("autoPaneWidth fills the row's leftover space, and only when the default leaves some", () => {
  // The screenshot's case: a 1440 viewport (34vw = 490) inside a 1160px row, two members.
  assert.equal(defaultPaneWidth(1440), 490);
  assert.equal(autoPaneWidth(1160, 2, [], 1440), 580, "2 × 490 = 980 left 180px of row empty");
  // No room to give: the panes are already wider than their share, so the default posture stands
  // and the row scrolls — an auto-fit never squeezes a pane to make room for itself.
  assert.equal(autoPaneWidth(1160, 4, [], 1440), 490, "4 × 490 overflows: not the case autofit is for");
  assert.equal(autoPaneWidth(600, 2, [], 1440), 490);
  // Measured row unknown yet (0): the default, never a division by nothing.
  assert.equal(autoPaneWidth(0, 2, [], 1440), 490);
  assert.equal(autoPaneWidth(1160, 0, [], 1440), 490);
  // A single member gets the whole row, up to the stepped ceiling that keeps a column readable.
  assert.equal(autoPaneWidth(1160, 1, [], 1440), PANE_MAX_WIDTH);
  assert.equal(autoPaneWidth(900, 1, [], 1440), 900);
  // A row narrower than the default: the default stands and the row scrolls, exactly as it did
  // before this existed — an auto-fit widens, it never narrows.
  assert.equal(autoPaneWidth(400, 1, [], 1440), 490);
});

test("autoPaneWidth shares what the user's own widths left — never rewrites one of them", () => {
  // One pane stepped to the ceiling: the other takes what is left of the row, not half of it.
  assert.equal(autoPaneWidth(1600, 2, [PANE_MAX_WIDTH], 1440), 560);
  // Every pane stepped: nothing is left on a default, so the default posture answers (and is only
  // used if a pane is added later).
  assert.equal(autoPaneWidth(1600, 2, [600, 600], 1440), 490);
  // A stepped width wider than the row leaves nothing: the default stands, the row scrolls.
  assert.equal(autoPaneWidth(1000, 2, [1040], 1440), 490);
  // Three panes, one chosen at 700, in a row with room: the other two split what is left, and the
  // row's own widths add up to the row — the leftover is not divided by all three.
  assert.equal(autoPaneWidth(1700, 3, [700], 1440), 500);
  assert.equal(700 + 2 * autoPaneWidth(1700, 3, [700], 1440), 1700);
  // What is left is too little for the default posture: the default stands (the row may scroll),
  // rather than an auto-fit shrinking a pane nobody asked to shrink.
  assert.equal(autoPaneWidth(1600, 3, [700], 1440), 490);
});

test("autoPaneWidth floors a fractional row, so the shares never pass it by a fraction", () => {
  // A ResizeObserver content box at a fractional zoom: 2 × 560 = 1120 would pass 1119.6 by 0.4px.
  assert.equal(autoPaneWidth(1119.6, 2, [], 1440), 559);
  assert.equal(fitPaneWidth(1119.6, 2), 559);
});

test("paneWidths: a stepped number stands, a fitted pane takes the row's share, the rest auto-fit", () => {
  assert.deepEqual(paneWidths(["a", "b"], {}, 1160, 1440), { a: 580, b: 580 });
  assert.deepEqual(paneWidths(["a", "b"], { a: 800 }, 1600, 1440), { a: 800, b: 800 });
  assert.deepEqual(paneWidths(["a", "b"], { a: 800, b: "fit" }, 1600, 1440), { a: 800, b: 800 });
  assert.deepEqual(paneWidths(["a", "b"], { a: 1040, b: "fit" }, 1000, 1440), { a: 1040, b: 500 });
});

test("paneWidths: a member added to a fitted row joins the fit, and the row still has no scrollbar", () => {
  const row = 1120;
  const fitted = { a: "fit", b: "fit" } as const;
  const w = paneWidths(["a", "b", "c"], fitted, row, 1440);
  // Without the rule, c would auto-fit at 34vw (490) beside two panes at 373: 1236px in a 1120 row.
  assert.deepEqual(w, { a: 373, b: 373, c: 373 });
  assert.ok(w.a! + w.b! + w.c! <= row);
  // A member that comes back with its own "fit" entry, or with none, stands in the same fit.
  assert.deepEqual(paneWidths(["a", "c"], { a: "fit", b: "fit" }, row, 1440), { a: 560, c: 560 });
});

test("paneWidths: only the panes in the row count — a departed member's width is no one's choice", () => {
  // A "fit" left by a member that came out doesn't make the row fitted…
  assert.deepEqual(paneWidths(["a", "b"], { gone: "fit" }, 1160, 1440), { a: 580, b: 580 });
  // …and a number left by one doesn't take space from the row's share.
  assert.deepEqual(paneWidths(["a", "b"], { gone: 1040 }, 1160, 1440), { a: 580, b: 580 });
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
