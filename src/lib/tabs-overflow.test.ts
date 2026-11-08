import assert from "node:assert/strict";
import { test } from "node:test";
import { tabsOverflow } from "./tabs-overflow";

test("a strip whose tabs all fit has no hidden edge, within a pixel of slack", () => {
  assert.deepEqual(tabsOverflow(0, 400, 400), { start: false, end: false });
  assert.deepEqual(tabsOverflow(0, 400.6, 400), { start: false, end: false });
});

test("each edge is hidden exactly while content lies past it", () => {
  assert.deepEqual(tabsOverflow(0, 600, 400), { start: false, end: true });
  assert.deepEqual(tabsOverflow(100, 600, 400), { start: true, end: true });
  assert.deepEqual(tabsOverflow(200, 600, 400), { start: true, end: false });
});

test("a right-to-left strip's negative scroll reads the same way", () => {
  assert.deepEqual(tabsOverflow(-200, 600, 400), { start: true, end: false });
});
