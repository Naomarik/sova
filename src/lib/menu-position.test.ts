// Run: pnpm test -- src/lib/menu-position.test.ts
// Where a menu panel goes (§app.context-menus/placement): at the pointer, flipping and clamping;
// under a focused element; and under a ⋯ trigger exactly as ActionMenu placed it before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EDGE_GAP, MIN_PANEL_HEIGHT, menuRoom, menuSpot, TRIGGER_GAP } from "./menu-position";

const view = { width: 1200, height: 800 };
const box = { width: 240, height: 300 };
const at = (x: number, y: number) => ({ kind: "point" as const, x, y });

test("at the pointer: the corner on it, below and to the right when the menu fits", () => {
  assert.deepEqual(menuSpot(at(100, 100), box, view), { top: 100, left: 100 });
});

test("at the pointer near the right edge: flipped left, its right edge on the pointer", () => {
  assert.deepEqual(menuSpot(at(1100, 100), box, view), { top: 100, left: 1100 - 240 });
  // Exactly fitting stays put: the panel's right edge sits EDGE_GAP inside the window.
  assert.deepEqual(menuSpot(at(1200 - EDGE_GAP - 240, 100), box, view), { top: 100, left: 1200 - EDGE_GAP - 240 });
});

test("at the pointer near the bottom: flipped up, its bottom edge on the pointer", () => {
  assert.deepEqual(menuSpot(at(100, 700), box, view), { top: 400, left: 100 });
  assert.deepEqual(menuSpot(at(1100, 700), box, view), { top: 400, left: 860 }, "both flips at once (a bottom-right corner)");
});

test("at the pointer, a menu bigger than either side is clamped inside the window", () => {
  const tall = { width: 240, height: 700 };
  // Neither side has 700px: it flips up from y=400 and is clamped to the top gap.
  assert.deepEqual(menuSpot(at(100, 400), tall, view), { top: EDGE_GAP, left: 100 });
  const huge = { width: 1500, height: 900 };
  assert.deepEqual(menuSpot(at(600, 400), huge, view), { top: EDGE_GAP, left: EDGE_GAP }, "wider and taller than the window: pinned to the top-left gap");
  // A pointer in the gap itself.
  assert.deepEqual(menuSpot(at(2, 2), box, view), { top: EDGE_GAP, left: EDGE_GAP });
});

test("the room handed to the panel before it is measured: the larger side, never under the minimum", () => {
  assert.equal(menuRoom(at(100, 100), view), 800 - EDGE_GAP - 100);
  assert.equal(menuRoom(at(100, 700), view), 700 - EDGE_GAP);
  assert.equal(menuRoom(at(100, 100), { width: 300, height: 200 }), MIN_PANEL_HEIGHT);
});

// ---- under an element: a ⋯ trigger, or the focused thing from the keyboard ----

const trigger = { top: 100, bottom: 140, left: 900, right: 940 };
const under = (align: "start" | "end", rect = trigger) => ({ kind: "rect" as const, rect, align });

/** ActionMenu's place() as it read before the panel was split out, written out here rather than read from the code. */
function before(r: typeof trigger, b: typeof box, v: typeof view, align: "start" | "end") {
  const below = v.height - EDGE_GAP - (r.bottom + TRIGGER_GAP);
  const above = r.top - TRIGGER_GAP - EDGE_GAP;
  const max = Math.round(Math.max(below, above, MIN_PANEL_HEIGHT));
  const top = b.height <= below ? r.bottom + TRIGGER_GAP : r.top - TRIGGER_GAP - b.height;
  const maxTop = Math.max(EDGE_GAP, v.height - EDGE_GAP - b.height);
  const maxLeft = Math.max(EDGE_GAP, v.width - EDGE_GAP - b.width);
  const left = align === "start" ? r.left : r.right - b.width;
  return { max, top: Math.round(Math.min(Math.max(top, EDGE_GAP), maxTop)), left: Math.round(Math.min(Math.max(left, EDGE_GAP), maxLeft)) };
}

test("under a trigger: the same numbers ActionMenu's own placement gave, in every corner", () => {
  const rects = [trigger, { top: 700, bottom: 740, left: 900, right: 940 }, { top: 10, bottom: 30, left: 0, right: 20 }, { top: 380, bottom: 420, left: 1180, right: 1200 }];
  const boxes = [box, { width: 600, height: 760 }, { width: 100, height: 50 }];
  for (const r of rects)
    for (const b of boxes)
      for (const align of ["start", "end"] as const) {
        const want = before(r, b, view, align);
        assert.equal(menuRoom(under(align, r), view), want.max);
        assert.deepEqual(menuSpot(under(align, r), b, view), { top: want.top, left: want.left }, JSON.stringify({ r, b, align }));
      }
});

test("from the keyboard: under the focused element, its left edges lined up, above when there's no room below", () => {
  const row = { top: 200, bottom: 244, left: 16, right: 336 };
  assert.deepEqual(menuSpot(under("start", row), box, view), { top: 244 + TRIGGER_GAP, left: 16 });
  const low = { top: 700, bottom: 744, left: 16, right: 336 };
  assert.deepEqual(menuSpot(under("start", low), box, view), { top: 700 - TRIGGER_GAP - 300, left: 16 });
});

test("a spanned panel starts at the spanned element's left edge, inside the gap", () => {
  assert.deepEqual(menuSpot(under("end"), { width: 300, height: 100 }, { width: 400, height: 800 }, 20), { top: 144, left: 28 });
});
