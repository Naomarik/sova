import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutChangeWord, aboutCount, aboutLength, aboutOverCap, aboutPreview } from "./org-about";

test("a history line says what it did; a revert says so whatever it restored", () => {
  assert.equal(aboutChangeWord({ from: "", to: "a" }), "Written");
  assert.equal(aboutChangeWord({ from: "a", to: "" }), "Cleared");
  assert.equal(aboutChangeWord({ from: "a", to: "b" }), "Changed");
  assert.equal(aboutChangeWord({ from: "a", to: "", revertOf: "t" }), "Reverted");
  assert.equal(aboutChangeWord({ from: "", to: "b", revertOf: "t" }), "Reverted");
});

test("the preview is one line, clipped with an ellipsis; nothing reads as (empty)", () => {
  assert.equal(aboutPreview("They pay\n\nlate.  Always."), "They pay late. Always.");
  assert.equal(aboutPreview("  \n "), "(empty)");
  const long = aboutPreview("x".repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
  assert.equal(aboutPreview("x".repeat(120)), "x".repeat(120), "exactly the limit is whole");
});

test("the counter and the cap", () => {
  assert.equal(aboutCount(""), "0 / 4,000");
  assert.equal(aboutCount("y".repeat(1234)), "1,234 / 4,000");
  assert.equal(aboutOverCap("z".repeat(4000)), false);
  assert.equal(aboutOverCap("z".repeat(4001)), true);
});

test("a version's length, in words", () => {
  assert.equal(aboutLength(""), "0 characters");
  assert.equal(aboutLength("a"), "1 character");
  assert.equal(aboutLength("b".repeat(4000)), "4,000 characters");
});
