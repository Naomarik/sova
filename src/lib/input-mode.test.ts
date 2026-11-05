import assert from "node:assert/strict";
import { test } from "node:test";
import { stopButton } from "./compact";
import { createPressTracker, enterSends, escStops, notePress, refocusAfterSend, type EscKey } from "./input-mode";

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

const esc = (over: Partial<EscKey> = {}): EscKey => ({
  key: "Escape",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  repeat: false,
  defaultPrevented: false,
  keyCode: 27,
  ...over,
});
const noPopover = () => false;
const run = { running: true, compacting: false, readOnly: false, stopping: false, stopBlocked: false };

test("a plain Esc stops while Stop is usable: a reply or a compaction", () => {
  assert.equal(escStops(esc(), stopButton(run), noPopover), true);
  assert.equal(escStops(esc(), stopButton({ ...run, running: false, compacting: true }), noPopover), true);
});

test("Esc with any modifier never stops", () => {
  for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey"] as const)
    assert.equal(escStops(esc({ [mod]: true }), "usable", noPopover), false, mod);
});

test("an Esc something else took never stops: IME, a held key, a menu that prevented it", () => {
  assert.equal(escStops(esc({ isComposing: true }), "usable", noPopover), false);
  assert.equal(escStops(esc({ keyCode: 229 }), "usable", noPopover), false); // Safari's composition-ending key
  assert.equal(escStops(esc({ repeat: true }), "usable", noPopover), false);
  assert.equal(escStops(esc({ defaultPrevented: true }), "usable", noPopover), false);
});

test("with a popover open, Esc is the popover's", () => {
  assert.equal(escStops(esc(), "usable", () => true), false);
});

test("Esc does nothing where Stop is missing or aria-disabled", () => {
  const cases = {
    "not running": { ...run, running: false },
    "read only": { ...run, readOnly: true },
    stopping: { ...run, stopping: true },
    "socket not open": { ...run, stopBlocked: true },
  };
  for (const [name, s] of Object.entries(cases)) assert.equal(escStops(esc(), stopButton(s), noPopover), false, name);
});

test("no other key stops, and the popover is read only for an Esc that would", () => {
  let asked = 0;
  const popover = () => (asked++, false);
  for (const key of ["Enter", "Tab", "Backspace", "q"]) assert.equal(escStops(esc({ key }), "usable", popover), false, key);
  assert.equal(escStops(esc(), "disabled", popover), false);
  assert.equal(asked, 0);
});

test("a key send, with no press, returns focus to the textarea", () => {
  assert.equal(refocusAfterSend(null), true);
});

test("a mouse or pen press returns focus whatever the focus and keyboard were", () => {
  for (const focused of [false, true]) {
    for (const keyboardUp of [false, true]) assert.equal(refocusAfterSend({ touch: false, focused, keyboardUp }), true);
  }
});

test("a tap returns focus only when the textarea had it with the keyboard up", () => {
  assert.equal(refocusAfterSend({ touch: true, focused: true, keyboardUp: true }), true);
  // Focused after a back gesture, keyboard down: refocusing would raise it.
  assert.equal(refocusAfterSend({ touch: true, focused: true, keyboardUp: false }), false);
  assert.equal(refocusAfterSend({ touch: true, focused: false, keyboardUp: true }), false);
  assert.equal(refocusAfterSend({ touch: true, focused: false, keyboardUp: false }), false);
});

test("a press is read at pointerdown: a touch, and whether the box had focus with the keyboard up", () => {
  const box = { id: "box" } as unknown as Element;
  const other = { id: "other" } as unknown as Element;
  assert.deepEqual(notePress({ pointerType: "touch" }, box, { active: box, keyboardUp: true }), { touch: true, focused: true, keyboardUp: true });
  assert.deepEqual(notePress({ pointerType: "touch" }, box, { active: other, keyboardUp: false }), { touch: true, focused: false, keyboardUp: false });
  assert.deepEqual(notePress({ pointerType: "mouse" }, box, { active: box, keyboardUp: false }), { touch: false, focused: true, keyboardUp: false });
  assert.equal(notePress({ pointerType: "pen" }, box, { active: box, keyboardUp: false }).touch, false);
  // No box on screen: nothing had its focus, even with nothing focused at all.
  assert.equal(notePress({ pointerType: "touch" }, null, { active: null, keyboardUp: true }).focused, false);
});

/** A pointerdown as the tracker sees it: an Event carrying its pointer type. */
const pointerdown = (pointerType: string) => Object.assign(new Event("pointerdown"), { pointerType });

test("the tracker hands over the last press once, and a keydown forgets it", () => {
  const page = new EventTarget();
  const seen: string[] = [];
  const presses = createPressTracker((e) => {
    seen.push(e.pointerType);
    return { touch: e.pointerType === "touch", focused: false, keyboardUp: false };
  }, page);
  assert.equal(presses.take(), null, "nothing pressed yet counts as a key");
  page.dispatchEvent(pointerdown("mouse"));
  page.dispatchEvent(pointerdown("touch"));
  assert.deepEqual(presses.take(), { touch: true, focused: false, keyboardUp: false }, "the latest press wins");
  assert.equal(presses.take(), null, "taken once");
  // A tap, then a send made with a key: the stale tap must not speak for it.
  page.dispatchEvent(pointerdown("touch"));
  page.dispatchEvent(new Event("keydown"));
  assert.equal(presses.take(), null);
  // So the stale tap's rule can't apply: a key send refocuses.
  assert.equal(refocusAfterSend(presses.take()), true);
  presses.dispose();
  page.dispatchEvent(pointerdown("touch"));
  assert.equal(presses.take(), null, "disposed: no longer listening");
  assert.deepEqual(seen, ["mouse", "touch", "touch"]);
});

test("the tracker listens in the capture phase, so it reads a press before a handler moves focus", () => {
  const added: Array<[string, boolean]> = [];
  const page = { addEventListener: (t: string, _f: unknown, c: boolean) => added.push([t, c]), removeEventListener() {} } as unknown as EventTarget;
  createPressTracker(() => ({ touch: false, focused: false, keyboardUp: false }), page);
  assert.deepEqual(added, [["pointerdown", true], ["keydown", true]]);
});
