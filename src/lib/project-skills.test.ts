import assert from "node:assert/strict";
import { test } from "node:test";
import { shortDescription } from "./project-skills";

test("a description is one line, cut with an ellipsis past its limit", () => {
  assert.equal(shortDescription("a\n  b"), "a b");
  assert.equal(shortDescription(undefined), "");
  const cut = shortDescription("x".repeat(200), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith("…"));
});
