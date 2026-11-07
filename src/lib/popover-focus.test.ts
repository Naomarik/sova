import assert from "node:assert/strict";
import { test } from "node:test";
import { leftPopover } from "./popover-focus";

const base = { inside: false, onBody: true, fromConnected: true, windowFocused: true };

test("a step swap that unmounts the focused button is not leaving (the Clean Logs… confirm step)", () => {
  assert.equal(leftPopover({ ...base, fromConnected: false }), false);
});

test("a click on nothing or focus moved elsewhere on the page is leaving", () => {
  assert.equal(leftPopover(base), true);
  assert.equal(leftPopover({ ...base, onBody: false }), true);
  // A removed button whose focus went somewhere real outside still leaves.
  assert.equal(leftPopover({ ...base, fromConnected: false, onBody: false }), true);
});

test("focus that settled back inside, or a window switch, keeps it open", () => {
  assert.equal(leftPopover({ ...base, inside: true, onBody: false }), false);
  assert.equal(leftPopover({ ...base, windowFocused: false }), false);
});
