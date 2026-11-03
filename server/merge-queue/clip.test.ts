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
  assert.equal(clip(`${"word ".repeat(40)}tail`, 200).endsWith(" …"), false, "no space before the …");
});
