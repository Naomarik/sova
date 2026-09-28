import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { estimateHeight, MATRIX_NARROW, matrixColumns } from "./height";
import type { MatrixSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("matrix", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as MatrixSpec;
};
const TWO = spec('columns: Merge, Rebase\nKeeps original commits | yes | no "new SHAs"\nLinear history | no | yes\nSafe on shared branches | yes | partial "only with --force-with-lease"\nmark "Keeps original commits" "why"');
const FIVE = spec("columns: Redux, Zustand, Jotai, MobX, Signals\nBoilerplate | high | low | low | medium | low\nDevtools | yes | yes | partial | yes | no\nFine-grained updates | no | partial | yes | yes | yes\nmark Signals info");

test("matrix columns: fill the body exactly when they can, never below their least", () => {
  for (const s of [TWO, FIVE]) {
    for (let w = 296; w <= 900; w += 13) {
      const cols = matrixColumns(s, w);
      assert.equal(cols.length, s.columns.length + 1);
      const sum = cols.reduce((a, b) => a + b, 0);
      assert.ok(sum >= w - 1e-6, `${w}: ${sum} fills the body`);
      if (sum > w + 1e-6) assert.deepEqual(cols, matrixColumns(s, 10), `${w}: only the least is wider than the body`);
      assert.deepEqual(cols, matrixColumns(s, w), "deterministic");
    }
  }
});

test("matrix estimateHeight: deterministic, sane, never taller as the table widens", () => {
  for (const s of [TWO, FIVE]) {
    let prev = Infinity;
    for (let w = 296; w <= 900; w += 4) {
      const h = estimateHeight(s, w);
      assert.equal(h, estimateHeight(s, w));
      assert.ok(h > 60 && h < 900, `${w}: ${h}`);
      if (s === FIVE && w > MATRIX_NARROW && prev !== Infinity && w - 4 <= MATRIX_NARROW) prev = Infinity; // cards end here
      assert.ok(h <= prev + 1e-9, `${w}: ${h} after ${prev}`);
      prev = h;
    }
  }
  // A one-line table: the header row and one row, each a caption line plus padding and a rule.
  const one = spec("columns: A, B\nx | yes | no");
  assert.equal(estimateHeight(one, 600), 2 * (12.5 * 1.45 + 16) + 1);
});

test("matrix estimateHeight: three columns or more on a phone are one card per row", () => {
  const cards = estimateHeight(FIVE, MATRIX_NARROW);
  const table = estimateHeight(FIVE, MATRIX_NARROW + 1);
  assert.ok(cards > table * 1.5, `cards ${cards} vs table ${table}`);
  assert.ok(estimateHeight(TWO, MATRIX_NARROW) < estimateHeight(TWO, 300) + 1e-9, "two columns stay a table");
});
