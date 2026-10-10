// The help button's card (§chat.memory/help): where it sits, and where focus goes when it closes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_EDGE_GAP, HELP_TRIGGER_GAP, placeHelpCard, refocusAfterClose } from "./help-popover";

const view = { width: 1280, height: 800 };
const button = (top: number, left: number) => ({ top, left, bottom: top + 44, right: left + 44 });

test("the card sits under the button, its left edge on the button's, when that fits", () => {
  assert.deepEqual(placeHelpCard(button(100, 300), { width: 440, height: 400 }, view), { top: 144 + HELP_TRIGGER_GAP, left: 300 });
});

test("near the right edge it moves left to stay inside the window", () => {
  const at = placeHelpCard(button(100, 1200), { width: 440, height: 400 }, view);
  assert.equal(at.left, view.width - HELP_EDGE_GAP - 440);
});

test("with no room below and more above, it opens above the button", () => {
  const at = placeHelpCard(button(700, 300), { width: 440, height: 400 }, view);
  assert.equal(at.top, 700 - HELP_TRIGGER_GAP - 400);
});

test("a card taller than the window keeps its top inside it", () => {
  const at = placeHelpCard(button(400, 300), { width: 440, height: 2000 }, view);
  assert.equal(at.top, HELP_EDGE_GAP);
});

test("Escape and × always give focus back to the button", () => {
  for (const focus of ["inside", "body", "elsewhere"] as const) {
    assert.equal(refocusAfterClose("escape", focus), true);
    assert.equal(refocusAfterClose("close-button", focus), true);
  }
});

test("a press outside or a Tab away keeps focus where the user put it, unless it fell to nowhere", () => {
  assert.equal(refocusAfterClose("outside", "elsewhere"), false);
  assert.equal(refocusAfterClose("focus-left", "elsewhere"), false);
  assert.equal(refocusAfterClose("outside", "body"), true);
  assert.equal(refocusAfterClose("outside", "inside"), true);
});
