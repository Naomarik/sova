import assert from "node:assert/strict";
import { test } from "node:test";
import { entryIdOf, entrySelectors, JUMP_CLASS, JUMP_HIGHLIGHT_MS } from "./jump";

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

test("entryIdOf unwraps a rendered row's id to the entry the server knows", () => {
  // An assistant message renders one row per content block, so a row id is usually NOT an entry id.
  assert.equal(entryIdOf("01a0c3c1:0"), "01a0c3c1");
  assert.equal(entryIdOf("01a0c3c1:stop"), "01a0c3c1");
  assert.equal(entryIdOf("01a0c3c1"), "01a0c3c1");
  assert.equal(entryIdOf(""), "");
});
