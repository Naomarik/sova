// Run: pnpm test -- src/lib/guide-line.test.ts. Where a guide line's press leaves the list (§app.session-list/guide-lines):
// a head that ended up above the list's top is brought to the top; one at or below it never moves. The geometry and
// the press itself are measured in a real Chrome (server/sidebar-guide-lines.integration.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { headRevealDelta } from "./guide-line";

test("a head above the list's top is scrolled up to it, by exactly how far above it is", () => {
  assert.equal(headRevealDelta(-400, 0), -400);
  assert.equal(headRevealDelta(60, 120), -60);
});

test("a head at or below the list's top stays where it is, half a pixel of rounding included", () => {
  assert.equal(headRevealDelta(0, 0), 0);
  assert.equal(headRevealDelta(-0.4, 0), 0);
  assert.equal(headRevealDelta(300, 0), 0);
  assert.equal(headRevealDelta(120, 120), 0);
});
