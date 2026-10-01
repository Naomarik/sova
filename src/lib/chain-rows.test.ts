import { strict as assert } from "node:assert";
import test from "node:test";
import { chainRuns } from "./chain-rows";

/** The runs as a drawing reads them: `at` and what the row is within its run. */
const runs = (working: boolean[]) =>
  chainRuns(working).map((r) => (r ? `${r.at}:${r.first ? "first" : r.last ? "last" : "mid"}:${r.steps}` : null));

test("a run of working rows is one timeline, one step per row", () => {
  assert.deepEqual(runs([false, true, true, true, false]), [null, "1:first:3", "1:mid:3", "1:last:3", null]);
});

test("a lone working row is a run of one: a dot, no rail", () => {
  assert.deepEqual(runs([false, true, false]), [null, "1:first:1", null]);
});

test("a row that is not the working breaks the run in two", () => {
  assert.deepEqual(runs([true, true, false, true, true]), ["0:first:2", "0:last:2", null, "3:first:2", "3:last:2"]);
});

test("two runs never share an id, and each one knows both its ends", () => {
  const three = chainRuns([true, true, true, false, true, true, true, true]);
  assert.deepEqual(three.map((r) => (r ? [r.at, r.first, r.last] : null)), [
    [0, true, false],
    [0, false, false],
    [0, false, true],
    null,
    [4, true, false],
    [4, false, false],
    [4, false, false],
    [4, false, true],
  ]);
  assert.equal(three[0]!.steps, 3);
  assert.equal(three[4]!.steps, 4);
});

test("undrawn results join the visible steps across skipped rows", () => {
  assert.deepEqual(chainRuns([true, false, false, true], [false, true, true, false]), [
    { at: 0, first: true, last: false, steps: 2 },
    null,
    null,
    { at: 0, first: false, last: true, steps: 2 },
  ]);
});

test("skip takes precedence over working and does not move either endpoint", () => {
  assert.deepEqual(chainRuns([true, true, true, true, true], [true, false, true, false, true]), [
    null,
    { at: 1, first: true, last: false, steps: 2 },
    null,
    { at: 1, first: false, last: true, steps: 2 },
    null,
  ]);
  assert.deepEqual(chainRuns([true, true], [true, true]), [null, null]);
  assert.deepEqual(chainRuns([], []), []);
});

test("a visible message still breaks runs beside skipped rows", () => {
  assert.deepEqual(chainRuns([true, false, false, true, true], [false, true, false, true, false]), [
    { at: 0, first: true, last: true, steps: 1 },
    null,
    null,
    null,
    { at: 4, first: true, last: true, steps: 1 },
  ]);
});

test("every row of a run reads the same count, whichever row is asked", () => {
  assert.deepEqual(chainRuns([true, true, true]).map((r) => r!.steps), [3, 3, 3]);
});
