import assert from "node:assert/strict";
import { test } from "node:test";
import { entrySelectors, JUMP_CLASS, JUMP_HIGHLIGHT_MS } from "./jump";

test("an entry id matches its own rows, and a block id also falls back to its entry", () => {
  assert.deepEqual(entrySelectors("abc"), ['[data-entry="abc"], [data-entry^="abc:"]']);
  assert.deepEqual(entrySelectors("abc:2"), ['[data-entry="abc:2"], [data-entry^="abc:2:"]', '[data-entry="abc"], [data-entry^="abc:"]']);
});

test("an id with a quote or a backslash can't break out of the selector", () => {
  for (const s of entrySelectors('a"b\\c')) assert.match(s, /\[data-entry="a\\"b\\\\c"/);
});

test("the landing highlight is a class with a bounded life", () => {
  assert.equal(JUMP_CLASS, "entry-jumped");
  assert.ok(JUMP_HIGHLIGHT_MS >= 1000 && JUMP_HIGHLIGHT_MS <= 2500);
});
