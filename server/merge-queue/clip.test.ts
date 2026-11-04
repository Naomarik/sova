// A review's verdict text on a run step, a review note and a flagged run's why: cut short, they end in "…".
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip } from "./run";

test("a text over the limit is cut to the limit and ends in …; a shorter one is untouched", () => {
  const long = "x".repeat(250);
  assert.equal(clip(long, 200).length, 200);
  assert.ok(clip(long, 200).endsWith("…"));
  assert.equal(clip("short", 200), "short");
  assert.equal(clip("a".repeat(200), 200), "a".repeat(200), "exactly at the limit: whole");
  // The cut (the first 199 characters) ends on a space: it is trimmed, so the … follows the last word.
  const spaced = `${"a".repeat(198)}   tail`;
  assert.equal(spaced.slice(0, 199).endsWith(" "), true, "the cut lands on a space");
  assert.equal(clip(spaced, 200), `${"a".repeat(198)}…`, "no space before the …");
});
