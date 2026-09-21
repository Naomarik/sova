import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmActivate, confirmReset } from "./confirm-step";

test("the first activation arms, the second runs", () => {
  const first = confirmActivate(false);
  assert.deepEqual(first, { armed: true, run: false });
  assert.deepEqual(confirmActivate(first.armed), { armed: false, run: true });
});

test("one arming runs once: a second activation re-arms instead of running again", () => {
  // Double click, or Enter then a click: both land on the state the confirm left behind.
  const confirmed = confirmActivate(true);
  assert.equal(confirmed.run, true);
  const again = confirmActivate(confirmed.armed);
  assert.deepEqual(again, { armed: true, run: false });
});

test("a blocked row never arms and never runs", () => {
  assert.deepEqual(confirmActivate(false, true), { armed: false, run: false });
  assert.deepEqual(confirmActivate(true, true), { armed: false, run: false });
});

test("opening or closing the menu disarms, so an old arming can't run on one click", () => {
  assert.deepEqual(confirmReset(), { armed: false, run: false });
  assert.deepEqual(confirmActivate(confirmReset().armed), { armed: true, run: false });
});
