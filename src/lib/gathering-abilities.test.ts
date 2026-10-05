import assert from "node:assert/strict";
import { test } from "node:test";
import { ABILITIES_KEYS, abilitiesKey, abilitiesLabel, abilitiesOfKey, abilitiesWords, abilityToast, drawHtmlSavedToast, drawHtmlSettable } from "./gathering-abilities";

test("every option maps to a setting and back; Automatic is null", () => {
  for (const k of ABILITIES_KEYS) assert.equal(abilitiesKey(abilitiesOfKey(k)), k);
  for (const k of ABILITIES_KEYS) assert.equal(abilitiesKey(abilitiesOfKey(k, true)), k, "the carried checkbox never moves the select");
  assert.equal(abilitiesOfKey("auto"), null);
  assert.equal(abilitiesOfKey("auto", true), null, "Automatic has no interactive drawings");
  assert.deepEqual(abilitiesOfKey("draw+links"), { draw: true, readLinks: true, drawHtml: false });
  assert.deepEqual(ABILITIES_KEYS.map(abilitiesLabel), ["Automatic", "Draw", "Draw and read links", "Read links", "Neither"]);
});

test("a select change carries the Interactive drawings checkbox over, never clearing it", () => {
  // As ProjectOverseerPanel saves a select change: the current checkbox value over the new key.
  const now = abilitiesOfKey("draw", true)!;
  for (const k of ["draw+links", "links", "none", "draw"] as const) assert.equal(abilitiesOfKey(k, now.drawHtml)!.drawHtml, true, k);
  assert.deepEqual(
    ABILITIES_KEYS.filter((k) => drawHtmlSettable(k)),
    ["draw", "draw+links"],
    "the checkbox is disabled while the select is Automatic, Read links or Neither",
  );
});

test("the hint's words and the strip's toasts", () => {
  assert.equal(abilitiesWords({ draw: true, readLinks: false, drawHtml: false }), "draw");
  assert.equal(abilitiesWords({ draw: true, readLinks: true, drawHtml: false }), "draw, read links");
  assert.equal(abilitiesWords({ draw: true, readLinks: true, drawHtml: true }), "draw with interactive drawings, read links");
  assert.equal(abilitiesWords({ draw: false, readLinks: false, drawHtml: true }), "nothing extra", "interactive drawings count only with draw");
  assert.equal(abilityToast("draw", false), "Drawing off from its next reply.");
  assert.equal(abilityToast("readLinks", true), "Reading links on from its next reply.");
  assert.equal(abilityToast("drawHtml", true), "Interactive drawings on from its next reply.");
  assert.equal(drawHtmlSavedToast(false), "Gathering sessions: interactive drawings off.");
});
