// Jump to Latest never covers any part of a playbook's card in the conversation
// (§chat.playbooks/run-card): the rule is whether its box lies over a card's. The cases are the ones
// the gallery showed at c0155c0a0: a setup card's end in view with the view a little short of the
// conversation's end, an opened record, and the view inside a tall card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxesOverlap, jumpCovers, type Box } from "./jump-cover";

/** Jump to Latest as it stands in a 1280 view: centred, 44 high, above the view's end. */
const JUMP: Box = { top: 683, bottom: 727, left: 710, right: 871 };
const card = (top: number, bottom: number, left = 380, right = 1136): Box => ({ top, bottom, left, right });

test("a setup card whose end is in view, the view a little short of the conversation's end: the button would lie on its last lines", () => {
  // The card's buttons are no longer pinned; its end stands 20px above the view's end.
  assert.equal(jumpCovers(JUMP, [card(-1300, 723)]), true);
  // Even a sliver of the card under the button counts.
  assert.equal(jumpCovers(JUMP, [card(-1300, 684)]), true);
});

test("an opened record, and the view inside a tall card: the button would lie on it", () => {
  assert.equal(jumpCovers(JUMP, [card(200, 1216)]), true);
  assert.equal(jumpCovers(JUMP, [card(-800, 1400)]), true);
});

test("a card that ends above the button, starts below it, or stands beside it is not under it", () => {
  assert.equal(jumpCovers(JUMP, [card(100, 600)]), false);
  // Touching edges share no area.
  assert.equal(jumpCovers(JUMP, [card(100, 683)]), false);
  assert.equal(jumpCovers(JUMP, [card(727, 1500)]), false);
  assert.equal(jumpCovers(JUMP, [card(900, 1500)]), false);
  assert.equal(jumpCovers(JUMP, [card(600, 800, 16, 374)]), false);
});

test("any one card under the button is enough; no card, or no button, covers nothing", () => {
  assert.equal(jumpCovers(JUMP, [card(100, 600), card(650, 900)]), true);
  assert.equal(jumpCovers(JUMP, [card(100, 600), card(900, 1200)]), false);
  assert.equal(jumpCovers(JUMP, []), false);
  assert.equal(jumpCovers(null, [card(650, 900)]), false);
});

test("the overlap rule over its edges: it is symmetric, and a box with no area overlaps nothing", () => {
  const a: Box = { top: 0, bottom: 10, left: 0, right: 10 };
  for (const [dx, dy] of [[0, 0], [9, 9], [-9, -9], [9, -9], [0, 9]] as const) {
    const b = { top: dy, bottom: dy + 10, left: dx, right: dx + 10 };
    assert.equal(boxesOverlap(a, b), true, `${dx},${dy}`);
    assert.equal(boxesOverlap(b, a), true, `${dx},${dy} the other way`);
  }
  for (const [dx, dy] of [[10, 0], [0, 10], [-10, 0], [0, -10], [11, 11]] as const) {
    const b = { top: dy, bottom: dy + 10, left: dx, right: dx + 10 };
    assert.equal(boxesOverlap(a, b), false, `${dx},${dy}`);
    assert.equal(boxesOverlap(b, a), false, `${dx},${dy} the other way`);
  }
  // A card not drawn (hidden, or its row skipped off screen) has no height.
  assert.equal(boxesOverlap(a, { top: 5, bottom: 5, left: 0, right: 10 }), false);
  assert.equal(boxesOverlap({ top: 5, bottom: 5, left: 0, right: 10 }, a), false);
});
