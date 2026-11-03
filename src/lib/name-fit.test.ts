// Run: npx tsx --test src/lib/name-fit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLabel, foldedRest, overflowOf, shouldFold } from "./name-fit";

const fits = { scrollWidth: 80, clientWidth: 80 };
const cut = { scrollWidth: 64, clientWidth: 41 }; // "Opus 5.5" ellipsized to "Opus 5…"

test("overflowOf: content past its box, with tolerance, never negative", () => {
  assert.equal(overflowOf(cut), 23);
  assert.equal(overflowOf(fits), 0);
  assert.equal(overflowOf({ scrollWidth: 50, clientWidth: 90 }), 0);
  assert.equal(overflowOf({ scrollWidth: 81, clientWidth: 80 }, 1), 0);
  assert.equal(overflowOf(null), 0);
});

test("shouldFold: folds only when the unfolded row overflows somewhere", () => {
  // the name is cut while the icons are all out: fold
  assert.equal(shouldFold([cut, fits], 4), true);
  // the trigger clips its own icons, the name whole: fold
  assert.equal(shouldFold([fits, { scrollWidth: 120, clientWidth: 96 }], 3), true);
  // everything fits: stay unfolded
  assert.equal(shouldFold([fits, fits, null], 4), false);
});

test("shouldFold: nothing to fold with one mode icon or none, so the name is what gives", () => {
  assert.equal(shouldFold([cut], 1), false);
  assert.equal(shouldFold([cut], 0), false);
  assert.equal(shouldFold([cut], 2), true);
});

test("shouldFold: a function of the unfolded measurement only, so repeated checks agree", () => {
  // The same unfolded boxes give the same answer every time: no state to oscillate on.
  const runs = Array.from({ length: 5 }, () => shouldFold([cut, fits], 3));
  assert.deepEqual(runs, [true, true, true, true, true]);
});

test("foldedRest and foldLabel: the count of every mode icon but the first", () => {
  assert.equal(foldedRest(4), 3);
  assert.equal(foldLabel(4), "+3");
  assert.equal(foldedRest(2), 1);
  assert.equal(foldLabel(2), "+1");
  assert.equal(foldedRest(1), 0);
  assert.equal(foldedRest(0), 0);
});
