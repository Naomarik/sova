// Run: npx tsx --test src/lib/text-entry.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTextEntry } from "./text-entry";

test("isTextEntry: a caret, not merely an <input>", () => {
  assert.equal(isTextEntry({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextEntry({ tagName: "input", type: "CHECKBOX" }), false, "tag and type are case-insensitive");
  for (const type of ["radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"]) {
    assert.equal(isTextEntry({ tagName: "INPUT", type }), false, type);
  }
  for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date"]) {
    assert.equal(isTextEntry({ tagName: "INPUT", type }), true, type);
  }
  assert.equal(isTextEntry({ tagName: "INPUT" }), true, "no type attribute is text, per HTML");
  assert.equal(isTextEntry({ tagName: "INPUT", type: "some-future-type" }), true, "unknown types are text, not buttons");
  assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: "DIV" }), false);
  assert.equal(isTextEntry({ tagName: "BUTTON" }), false);
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(undefined), false);
});
