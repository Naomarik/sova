import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorCorrection, anchorIndex, type RowBox } from "./scroll-anchor";

test("the correction is the row's own measured move, fractions included", () => {
  // A chunk 309 px tall built above, the row measured 309.2 px lower: scrolling by 309 (what a
  // whole-pixel scrollHeight says) would leave 0.2 px, a device pixel's step at a ratio of 1.8.
  assert.equal(anchorCorrection(100, 409.2, 1.8), 409.2 - 100);
  assert.equal(anchorCorrection(250.75, 200.25, 1), 200.25 - 250.75, "a row moved up is scrolled back up");
});

test("half a device pixel is the least corrected, at the device pixel ratio given", () => {
  // 0.3 CSS px: 0.54 device px at 1.8, 0.27 at 0.9.
  assert.equal(anchorCorrection(0, 0.3, 1.8), 0.3);
  assert.equal(anchorCorrection(0, 0.3, 0.9), 0, "under half a device pixel: nothing is written");
  assert.equal(anchorCorrection(0, -0.25, 2), -0.25, "exactly half a device pixel is corrected");
  assert.equal(anchorCorrection(0, -0.24, 2), 0);
  assert.equal(anchorCorrection(10, 10, 1.25), 0, "a row that didn't move: nothing");
});

test("an unusable device pixel ratio counts as 1", () => {
  assert.equal(anchorCorrection(0, 0.6, 0), 0.6);
  assert.equal(anchorCorrection(0, 0.4, Number.NaN), 0);
  assert.equal(anchorCorrection(0, 0.4, -2), 0);
});

/** Rows of these heights stacked from `top` (a height of 0 draws nothing). */
const stack = (top: number, heights: number[]): RowBox[] => {
  let y = top;
  return heights.map((h) => {
    const box = { top: y, bottom: y + h };
    y += h;
    return box;
  });
};
/** The index found, and which rows were measured to find it. */
const find = (rows: RowBox[], viewTop: number) => {
  const read: number[] = [];
  const i = anchorIndex(rows.length, (k) => (read.push(k), rows[k]!), viewTop);
  return { i, read };
};

test("the row held is the one the view's top is in", () => {
  const rows = stack(-500, [100, 100, 100, 100, 100, 100, 100, 100]); // tops -500 … 200
  assert.equal(find(rows, 0).i, 5, "the row whose top is at the view's top");
  assert.equal(find(rows, 30).i, 5, "the row straddling the view's top");
  assert.equal(find(rows, -401).i, 0);
});

test("read from the end, it measures only the rows below the view's top and the one it is in", () => {
  const rows = stack(-5000, Array(60).fill(100)); // the view's top in row 50
  const { i, read } = find(rows, 0);
  assert.equal(i, 50);
  assert.deepEqual(read, [59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
});

test("rows that draw nothing are passed over", () => {
  // Row 2 draws nothing; a box of no height can't say which row the view's top is in. A row taken
  // out of layout (display: none) measures all zeros, wherever it sits.
  const rows = stack(-150, [100, 100, 0, 100]);
  rows.push({ top: 0, bottom: 0 }, { top: 50, bottom: 150 });
  assert.equal(find(rows, 0).i, 1);
  assert.equal(find(rows, 50).i, 5, "a later row whose top is at the view's top");
});

test("a view whose top is above every row holds the first drawn one; none drawn, none held", () => {
  assert.equal(find(stack(40, [0, 100, 100]), 0).i, 1, "the first row with a box");
  assert.equal(find(stack(40, [0, 0]), 0).i, -1);
  assert.equal(find([], 0).i, -1);
});
