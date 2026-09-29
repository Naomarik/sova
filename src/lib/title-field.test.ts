// Run: npx tsx --test src/lib/title-field.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { inPlaceTitleEnd } from "./title-field";

test("an unchanged field is a cancel on Enter and on leaving, whatever the row's title is now", () => {
  // The field opened on "Old", and the row's title moved to "New" while it was open: the field
  // doesn't know "New" at all, so the only thing to rule out is writing "Old" back.
  assert.equal(inPlaceTitleEnd("Old", "Old", "leave"), null);
  assert.equal(inPlaceTitleEnd("Old", "Old", "enter"), null);
  assert.equal(inPlaceTitleEnd("Old", "  Old ", "leave"), null, "whitespace around it changes nothing");
});

test("a typed title saves, on Enter or on leaving", () => {
  assert.deepEqual(inPlaceTitleEnd("Old", "Typed", "leave"), { save: "Typed" });
  assert.deepEqual(inPlaceTitleEnd("Old", " Typed ", "enter"), { save: "Typed" });
});

test("empty clears on Enter and cancels on leaving", () => {
  assert.deepEqual(inPlaceTitleEnd("Old", "", "enter"), { save: null });
  assert.deepEqual(inPlaceTitleEnd("Old", "   ", "enter"), { save: null });
  assert.equal(inPlaceTitleEnd("Old", "", "leave"), null);
});
