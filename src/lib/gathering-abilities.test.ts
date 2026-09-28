import assert from "node:assert/strict";
import { test } from "node:test";
import { ABILITIES_KEYS, abilitiesKey, abilitiesLabel, abilitiesOfKey, abilitiesWords, abilityToast } from "./gathering-abilities";

test("every option maps to a setting and back; Automatic is null", () => {
  for (const k of ABILITIES_KEYS) assert.equal(abilitiesKey(abilitiesOfKey(k)), k);
  assert.equal(abilitiesOfKey("auto"), null);
  assert.deepEqual(abilitiesOfKey("draw+links"), { draw: true, readLinks: true });
  assert.deepEqual(ABILITIES_KEYS.map(abilitiesLabel), ["Automatic", "Draw", "Draw and read links", "Read links", "Neither"]);
});

test("the hint's words and the strip's toasts", () => {
  assert.equal(abilitiesWords({ draw: true, readLinks: false }), "draw");
  assert.equal(abilitiesWords({ draw: true, readLinks: true }), "draw, read links");
  assert.equal(abilitiesWords({ draw: false, readLinks: false }), "nothing extra");
  assert.equal(abilityToast("draw", false), "Drawing off from its next reply.");
  assert.equal(abilityToast("readLinks", true), "Reading links on from its next reply.");
});
