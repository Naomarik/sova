// Run: pnpm test -- src/commands/palette-key.test.ts
// Ctrl/⌘+K's owner (§app.command-palette/opening): a Mac's Ctrl+K in a text field stays the field's
// own, held or not; elsewhere a held key toggles the palette once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { paletteKeyAction } from "./keys";

const field = { tagName: "TEXTAREA" };
const button = { tagName: "BUTTON" };
const k = (over: object) => ({ key: "k", code: "KeyK", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

test("a Mac's Ctrl+K in a text field is left to the field, its auto-repeats too", () => {
  assert.equal(paletteKeyAction(k({ ctrlKey: true, target: field }), true), "field");
  assert.equal(paletteKeyAction(k({ ctrlKey: true, target: field, repeat: true }), true), "field"); // held: delete-to-end keeps repeating
});

test("⌘K, a Mac's Ctrl+K outside a field, and Ctrl+K elsewhere toggle, and a held key's repeats are swallowed", () => {
  assert.equal(paletteKeyAction(k({ metaKey: true, target: field }), true), "toggle");
  assert.equal(paletteKeyAction(k({ ctrlKey: true, target: button }), true), "toggle");
  assert.equal(paletteKeyAction(k({ ctrlKey: true, target: field }), false), "toggle");
  assert.equal(paletteKeyAction(k({ ctrlKey: true, target: field, repeat: true }), false), "repeat");
  assert.equal(paletteKeyAction(k({ metaKey: true, target: field, repeat: true }), true), "repeat");
});
