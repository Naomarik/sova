// Run: pnpm test -- src/lib/float-card.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOAT_GAP_MOUSE, FLOAT_GAP_TOUCH, FLOAT_MARGIN, floatAbove } from "./float-card";

const view = { width: 1440, height: 900 };
const card = { width: 180, height: 72 };

test("floatAbove: centred on the pointer, its bottom edge the gap above it", () => {
  const p = { x: 200, y: 850 };
  const m = floatAbove(p, card, view, FLOAT_GAP_MOUSE);
  assert.equal(m.x + card.width / 2, p.x, "centred on the pointer's x");
  assert.equal(m.y + card.height, p.y - FLOAT_GAP_MOUSE, "bottom edge 14px above the tip");
  const t = floatAbove(p, card, view, FLOAT_GAP_TOUCH);
  assert.equal(t.y + card.height, p.y - FLOAT_GAP_TOUCH, "a finger gets more room");
  assert.ok(t.y + card.height < p.y && m.y + card.height < p.y, "never over the pointer");
});

test("floatAbove: never trails right or below, even near the window's right and bottom edges", () => {
  // Where the drag ghost's mouse placement would trail right and below, this stays above.
  const p = { x: 1430, y: 895 };
  const m = floatAbove(p, card, view, FLOAT_GAP_MOUSE);
  assert.equal(m.x, view.width - FLOAT_MARGIN - card.width, "clamped 8px inside the right edge");
  assert.equal(m.y + card.height, p.y - FLOAT_GAP_MOUSE, "still above");
});

test("floatAbove: clamped 8px inside the left edge", () => {
  const m = floatAbove({ x: 3, y: 500 }, card, view, FLOAT_GAP_MOUSE);
  assert.equal(m.x, FLOAT_MARGIN);
});

test("floatAbove: below only when there is no room above", () => {
  const room = FLOAT_MARGIN + card.height + FLOAT_GAP_MOUSE;
  assert.equal(floatAbove({ x: 500, y: room }, card, view, FLOAT_GAP_MOUSE).y, FLOAT_MARGIN, "exactly fits above");
  const flipped = floatAbove({ x: 500, y: room - 1 }, card, view, FLOAT_GAP_MOUSE);
  assert.equal(flipped.y, room - 1 + FLOAT_GAP_MOUSE, "one pixel short: the gap below the pointer");
  const touch = floatAbove({ x: 500, y: 30 }, card, view, FLOAT_GAP_TOUCH);
  assert.equal(touch.y, 30 + FLOAT_GAP_TOUCH);
});

test("floatAbove: a window narrower than the card keeps its left edge in view", () => {
  const m = floatAbove({ x: 100, y: 500 }, { width: 300, height: 72 }, { width: 200, height: 900 }, FLOAT_GAP_MOUSE);
  assert.equal(m.x, FLOAT_MARGIN);
});

test("floatAbove: whole pixels", () => {
  const m = floatAbove({ x: 200.6, y: 600.3 }, { width: 181, height: 71 }, view, FLOAT_GAP_MOUSE);
  assert.ok(Number.isInteger(m.x) && Number.isInteger(m.y));
});
