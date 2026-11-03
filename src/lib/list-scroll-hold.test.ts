// The session list's hold rule (§app.session-list/content-rules, "Only the user scrolls the list"): after a change,
// how far to scroll so the row that was on screen is back where it was. The DOM side is driven in a real Chrome by
// server/sidebar-scroll.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { holdCorrection, keptPlace } from "./list-scroll-hold";

const at = { offset: 120, savedScrollTop: 3000, scrollTop: 3000, maxScrollTop: 5000, userScrolling: false };

test("content arriving above pushes the row down by its height: scroll down by exactly that", () => {
  assert.equal(holdCorrection({ ...at, now: 120 + 2017 }), 2017);
});

test("content leaving above pulls the row up: scroll up by exactly that", () => {
  assert.equal(holdCorrection({ ...at, now: 120 - 300 }), -300);
});

test("nothing moved the row: nothing to do", () => {
  assert.equal(holdCorrection({ ...at, now: 120 }), 0);
  assert.equal(holdCorrection({ ...at, now: 120.3 }), 0, "under half a pixel is no move");
});

test("the user's own scroll still in flight is theirs: only the rest is corrected", () => {
  // The user scrolled 80px down; the row is 80px higher for that alone.
  assert.equal(holdCorrection({ ...at, userScrolling: true, scrollTop: 3080, now: 40 }), 0);
  // …and something above also grew by 50.
  assert.equal(holdCorrection({ ...at, userScrolling: true, scrollTop: 3080, now: 90 }), 50);
});

test("a move nobody scrolled for is undone in full: a rebuild that clamped the list for a moment, say", () => {
  // Mid-rebuild the list was short and the browser clamped scrollTop from 3000 to 1000; the rows are back now, the
  // list is long again, and the row sits 2000px lower than it did.
  assert.equal(holdCorrection({ ...at, scrollTop: 1000, now: 120 + 2000 }), 2000);
});

test("the browser clamping a shortened list at its end is not a scroll of the user's", () => {
  // The list lost 400px above the row and is now short enough that scrollTop was clamped from 3000 to 2800 (its end).
  // The row is 400px higher for the loss, 200px lower for the clamp: −200 from where it was. Scrolling up 200 more
  // puts it back (scrollTop 2600).
  assert.equal(holdCorrection({ ...at, scrollTop: 2800, maxScrollTop: 2800, now: 120 - 200 }), -200);
  assert.equal(holdCorrection({ ...at, userScrolling: true, scrollTop: 2800, maxScrollTop: 2800, now: 120 - 200 }), -200, "while the user scrolls too");
});

test("a list at its very top stays at its top: what arrives there shows", () => {
  assert.equal(holdCorrection({ ...at, savedScrollTop: 0, scrollTop: 0, now: 120 + 300 }), 0);
});

// A row's place among its siblings (keptPlace): what decides whether it may hold the list. A row that moved is never
// followed, or the hold itself would carry everything else on screen along by however far it went.
test("rows arriving or leaving around a row leave it in its place", () => {
  // A, B, C, D, E; B was under A, A leaves (into another state group, a closed Done, the archive).
  assert.equal(keptPlace({ before: ["A", "X"], after: ["C", "D"] }, ["X", "B", "C", "D"], 1), true, "the row under the one that left");
  // A search ending puts rows back on both sides.
  assert.equal(keptPlace({ before: ["X"], after: ["C"] }, ["W", "X", "n1", "B", "n2", "C"], 3), true);
  // A sole row, or one whose neighbours all left: nothing says it moved.
  assert.equal(keptPlace({ before: [], after: [] }, ["B"], 0), true);
  assert.equal(keptPlace({ before: ["A"], after: ["C"] }, ["B"], 0), true);
});

test("a row re-sorted past its neighbours has moved", () => {
  // A was first, ahead of B, C, D; now it is last.
  assert.equal(keptPlace({ before: [], after: ["B", "C", "D"] }, ["B", "C", "D", "A"], 3), false);
  // A and B swap: both moved; C, under them, did not.
  assert.equal(keptPlace({ before: ["X"], after: ["B", "C"] }, ["X", "B", "A", "C"], 2), false, "A");
  assert.equal(keptPlace({ before: ["A", "X"], after: ["C"] }, ["X", "B", "A", "C"], 1), false, "B");
  assert.equal(keptPlace({ before: ["B", "A", "X"], after: ["D"] }, ["X", "B", "A", "C", "D"], 3), true, "C");
  // A moved up past what was before it.
  assert.equal(keptPlace({ before: ["Y", "X"], after: ["B"] }, ["A", "Y", "X", "B"], 0), false);
});
