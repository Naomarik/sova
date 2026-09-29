import assert from "node:assert/strict";
import { test } from "node:test";
import { enterSends } from "./input-mode";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...mods });

test("plain Enter sends, except in touch mode, where it adds a line", () => {
  assert.equal(enterSends(key("Enter"), false), true);
  assert.equal(enterSends(key("Enter"), true), false);
});

test("Ctrl+Enter and ⌘+Enter send on every device", () => {
  for (const touch of [false, true]) {
    assert.equal(enterSends(key("Enter", { ctrlKey: true }), touch), true);
    assert.equal(enterSends(key("Enter", { metaKey: true }), touch), true);
    // A held Ctrl outranks Shift: the chord is a send.
    assert.equal(enterSends(key("Enter", { ctrlKey: true, shiftKey: true }), touch), true);
  }
});

test("Shift+Enter never sends", () => {
  assert.equal(enterSends(key("Enter", { shiftKey: true }), false), false);
  assert.equal(enterSends(key("Enter", { shiftKey: true }), true), false);
});

test("an IME's Enter is its own, whatever the modifiers", () => {
  for (const touch of [false, true]) {
    assert.equal(enterSends(key("Enter", { isComposing: true }), touch), false);
    assert.equal(enterSends(key("Enter", { isComposing: true, ctrlKey: true }), touch), false);
    assert.equal(enterSends(key("Enter", { isComposing: true, metaKey: true }), touch), false);
  }
});

test("no other key sends, Ctrl held or not", () => {
  for (const touch of [false, true]) {
    assert.equal(enterSends(key("a"), touch), false);
    assert.equal(enterSends(key("Tab"), touch), false);
    assert.equal(enterSends(key("a", { ctrlKey: true }), touch), false);
  }
});
