import assert from "node:assert/strict";
import { test } from "node:test";
import * as typeAnywhereModule from "./type-anywhere";
import { isOpenOverlay, keyBelongsToTarget, OVERLAY_CANDIDATES, startTyping, takeTyping, typesCharacter, type CharKeyLike, type ElementLike } from "./type-anywhere";

const key = (over: Partial<CharKeyLike>): CharKeyLike => ({ key: "", altKey: false, ctrlKey: false, metaKey: false, ...over });
const altGraph = (k: string) => k === "AltGraph";
const BOTH = [false, true];

// ---- which keys count ----

test("a character counts on every platform: letters, capitals, digits, symbols, a layout's own letters, an accent key", () => {
  for (const mac of BOTH)
    for (const k of ["a", "z", "A", "Z", "0", "7", "@", "#", ".", "'", "é", "ß", "ñ", "ø", "€", "Dead"]) assert.equal(typesCharacter(key({ key: k }), mac), true, `mac=${mac} ${k}`);
  // Shift only changes which character (capitals, symbols): the key arrives already shifted.
  assert.equal(typesCharacter(key({ key: "A" }), false), true);
});

test("Option types characters on a Mac; plain Alt elsewhere is a menu key", () => {
  for (const k of ["å", "ø", "∑", "©", "Dead"]) {
    assert.equal(typesCharacter(key({ key: k, altKey: true }), true), true, `Mac Option ${k}`);
    assert.equal(typesCharacter(key({ key: k, altKey: true }), false), false, `plain Alt ${k}`);
  }
  assert.equal(typesCharacter(key({ key: "a", altKey: true }), false), false, "Windows Alt+A");
});

test("AltGr characters count: Windows reports Ctrl+Alt, Linux the AltGraph modifier", () => {
  assert.equal(typesCharacter(key({ key: "@", ctrlKey: true, altKey: true }), false), true, "Windows AltGr+Q on a German layout");
  assert.equal(typesCharacter(key({ key: "€", ctrlKey: true, altKey: true, getModifierState: altGraph }), false), true);
  assert.equal(typesCharacter(key({ key: "@", getModifierState: altGraph }), false), true, "Linux AltGr");
  assert.equal(typesCharacter(key({ key: "@", altKey: true, getModifierState: altGraph }), false), true);
  assert.equal(typesCharacter(key({ key: "@", ctrlKey: true, getModifierState: altGraph }), false), true);
  // A Mac has no AltGr: Ctrl+Option is a chord there.
  assert.equal(typesCharacter(key({ key: "a", ctrlKey: true, altKey: true }), true), false);
});

test("keys with their own jobs never count: Space, Enter, Tab, Esc, arrows, paging, editing, function and modifier keys", () => {
  const named = [" ", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Backspace", "Delete", "Insert", "F1", "F5", "Shift", "Control", "Alt", "Meta", "CapsLock", "ContextMenu"];
  for (const mac of BOTH)
    for (const k of named) {
      assert.equal(typesCharacter(key({ key: k }), mac), false, `mac=${mac} ${k}`);
      assert.equal(typesCharacter(key({ key: k, altKey: true, getModifierState: altGraph }), mac), false, `mac=${mac} AltGr ${k}`);
    }
  // A control character is no character either.
  assert.equal(typesCharacter(key({ key: "\u0007" }), false), false);
});

test("Ctrl and ⌘ chords stay shortcuts: copy, paste, select all, and Ctrl alone off a Mac", () => {
  for (const mac of BOTH)
    for (const k of ["c", "v", "a", "z", "C"]) {
      assert.equal(typesCharacter(key({ key: k, metaKey: true }), mac), false, `mac=${mac} ⌘${k}`);
      assert.equal(typesCharacter(key({ key: k, ctrlKey: true }), mac), false, `mac=${mac} Ctrl+${k}`);
      assert.equal(typesCharacter(key({ key: k, metaKey: true, altKey: true }), mac), false, `mac=${mac} ⌘⌥${k}`);
      assert.equal(typesCharacter(key({ key: k, metaKey: true, ctrlKey: true, altKey: true }), mac), false, `mac=${mac} ⌘⌃⌥${k}`);
    }
});

test("an input method's keys are its own: keyCode 229, Process, a soft keyboard's Unidentified (a composing keydown: keys.test.ts)", () => {
  for (const mac of BOTH) {
    assert.equal(typesCharacter(key({ key: "a", keyCode: 229 }), mac), false);
    assert.equal(typesCharacter(key({ key: "Process" }), mac), false);
    assert.equal(typesCharacter(key({ key: "Unidentified" }), mac), false);
    assert.equal(typesCharacter(key({ key: "a", keyCode: 65 }), mac), true, "a real key's code is fine");
  }
});

test("an accent key counts even as keyCode 229 (a Mac's Option+E)", () => {
  assert.equal(typesCharacter(key({ key: "Dead", altKey: true, keyCode: 229 }), true), true);
  assert.equal(typesCharacter(key({ key: "Dead", keyCode: 229 }), false), true, "´ on a Spanish layout");
});

// ---- where a key belongs ----

const el = (tagName: string, attrs: Record<string, string> = {}, parent: ElementLike | null = null, extra: Partial<ElementLike> = {}): ElementLike => ({
  tagName,
  type: attrs.type ?? null,
  parentElement: parent,
  getAttribute: (n) => attrs[n] ?? null,
  hasAttribute: (n) => n in attrs,
  ...extra,
});
const body = el("BODY");
const main = el("MAIN", {}, body);

test("a key typed in a select is the select's (a caret field is the row's textEntry rule: keys.test.ts)", () => {
  assert.equal(keyBelongsToTarget(el("SELECT", {}, main)), true);
  assert.equal(keyBelongsToTarget(el("OPTION", {}, el("SELECT", {}, main))), true);
});

test("inside a dialog, a popover, a menu or a list that jumps as you type, the key stays there", () => {
  const inside = (container: ElementLike) => el("BUTTON", {}, el("DIV", {}, container));
  assert.equal(keyBelongsToTarget(inside(el("DIALOG", {}, body))), true, "<dialog>");
  assert.equal(keyBelongsToTarget(inside(el("DIV", { popover: "auto" }, body))), true, "a popover menu");
  for (const role of ["dialog", "alertdialog", "menu", "menubar", "listbox", "tree", "treegrid", "grid", "combobox", "radiogroup", "slider", "spinbutton"])
    assert.equal(keyBelongsToTarget(inside(el("DIV", { role }, main))), true, `role=${role}`);
  // The type-ahead lists: an option of the model menu's listbox, a menu item of the mode menu.
  assert.equal(keyBelongsToTarget(el("DIV", { role: "option" }, el("DIV", { role: "listbox" }, main))), true);
  assert.equal(keyBelongsToTarget(el("BUTTON", { role: "menuitemradio" }, el("DIV", { role: "menu" }, main))), true);
});

test("a button, a link, a tab, a checkbox or the page itself takes no letters, so the key is free", () => {
  assert.equal(keyBelongsToTarget(null), false);
  assert.equal(keyBelongsToTarget(body), false);
  assert.equal(keyBelongsToTarget(el("BUTTON", {}, main)), false);
  assert.equal(keyBelongsToTarget(el("A", { href: "#/x" }, main)), false);
  assert.equal(keyBelongsToTarget(el("INPUT", { type: "checkbox" }, main)), false);
  assert.equal(keyBelongsToTarget(el("BUTTON", { role: "tab" }, el("DIV", { role: "tablist" }, main))), false);
  assert.equal(keyBelongsToTarget(el("BUTTON", { role: "option" }, main)), false, "an option outside any list");
  assert.equal(keyBelongsToTarget(el("SECTION", { role: "log" }, main)), false, "the transcript");
});

test("an open overlay: a modal dialog, any mounted dialog or sheet, an open popover; not a tooltip, a closed one or a dialog shown without showModal", () => {
  const withState = (tag: string, attrs: Record<string, string>, open: Record<string, boolean>) => el(tag, attrs, body, { matches: (s) => open[s] === true });
  assert.equal(isOpenOverlay(el("DIV", { role: "dialog", "aria-modal": "true" }, body)), true, "the palette, Settings, the shortcut sheet");
  assert.equal(isOpenOverlay(el("SECTION", { role: "dialog" }, body)), true, "the context sheet: a dialog role, no aria-modal");
  assert.equal(isOpenOverlay(el("DIV", { role: "dialog", "aria-modal": "false" }, body)), true, "a landing popover without its scrim");
  assert.equal(isOpenOverlay(el("DIV", { role: "alertdialog" }, body)), true, "a confirm");
  assert.equal(isOpenOverlay(el("DIV", {}, body)), false, "a plain element");
  assert.equal(isOpenOverlay(withState("DIALOG", {}, { ":modal": true })), true, "the lightbox");
  assert.equal(isOpenOverlay(withState("DIALOG", { open: "" }, { ":modal": false })), false, "a dialog shown without showModal");
  assert.equal(isOpenOverlay(withState("DIALOG", {}, {})), false, "a closed dialog");
  assert.equal(isOpenOverlay(withState("DIV", { popover: "auto" }, { ":popover-open": true })), true, "an open menu");
  assert.equal(isOpenOverlay(withState("DIV", { popover: "manual", role: "dialog" }, { ":popover-open": true })), true, "an open help card");
  assert.equal(isOpenOverlay(withState("DIV", { popover: "auto" }, { ":popover-open": false })), false, "a closed menu");
  assert.equal(isOpenOverlay(withState("DIV", { popover: "manual", role: "tooltip" }, { ":popover-open": true })), false, "a reply-timing tooltip");
  const old = el("DIV", { popover: "auto" }, body, {
    matches: () => {
      throw new SyntaxError("unknown pseudo-class");
    },
  });
  assert.equal(isOpenOverlay(old), false, "a browser without :popover-open has no open popover");
});

// ---- the owner's decision ----

test("the page's overlay query finds every kind isOpenOverlay counts", () => {
  for (const sel of ["dialog", '[aria-modal="true"]', "[popover]", '[role="dialog"]', '[role="alertdialog"]']) assert.ok(OVERLAY_CANDIDATES.split(", ").includes(sel), sel);
});

const opened = el("DIV", { popover: "auto" }, body, { matches: (s) => s === ":popover-open" });
const closed = el("DIV", { popover: "auto" }, body, { matches: () => false });
const button = el("BUTTON", {}, main);

const run = (over: { target?: unknown; defaultPrevented?: boolean; overlays?: ElementLike[]; box?: { take(): boolean } | null }) => {
  const calls = { box: 0, take: 0 };
  const box = over.box === undefined ? { take: () => true } : over.box;
  const acted = startTyping(
    { target: "target" in over ? over.target : button, defaultPrevented: over.defaultPrevented },
    {
      overlays: () => over.overlays ?? [],
      box: () => (calls.box++, box && { take: () => (calls.take++, box.take()) }),
    },
  );
  return { acted, ...calls };
};

test("a free key moves into the box on screen, which takes it", () => {
  assert.deepEqual(run({}), { acted: true, box: 1, take: 1 });
  assert.deepEqual(run({ target: body }), { acted: true, box: 1, take: 1 });
  assert.deepEqual(run({ overlays: [closed] }), { acted: true, box: 1, take: 1 }, "a closed menu doesn't stop it");
});

test("nothing happens from a select or a list that jumps as you type", () => {
  for (const target of [el("SELECT", {}, main), el("DIV", { role: "option" }, el("DIV", { role: "listbox" }, main))])
    assert.deepEqual(run({ target }), { acted: false, box: 0, take: 0 }, String(target.tagName));
});

test("nothing happens while a dialog, sheet, menu or popover is open, focus outside it or not", () => {
  assert.deepEqual(run({ overlays: [closed, opened] }), { acted: false, box: 0, take: 0 });
  assert.deepEqual(run({ overlays: [el("SECTION", { role: "dialog" }, body)] }), { acted: false, box: 0, take: 0 }, "the context sheet, focus dropped off it");
  assert.deepEqual(run({ overlays: [el("DIV", { role: "dialog", "aria-modal": "true" }, body)] }), { acted: false, box: 0, take: 0 });
});

test("nothing happens to a key a widget already used: a diff's n and p prevent theirs", () => {
  assert.deepEqual(run({ defaultPrevented: true }), { acted: false, box: 0, take: 0 });
  assert.deepEqual(run({ defaultPrevented: false }), { acted: true, box: 1, take: 1 });
});

test("nothing happens with no box on screen, or a box that takes no typing (read-only)", () => {
  assert.deepEqual(run({ box: null }), { acted: false, box: 1, take: 0 });
  assert.deepEqual(run({ box: { take: () => false } }), { acted: false, box: 1, take: 1 });
});

// ---- the box taking it ----

const textarea = (lands = true) => {
  const log: string[] = [];
  const node = { focus: () => void log.push("focus") };
  return { log, node, active: () => (lands ? node : null) };
};

test("a box takes the typing: focus moves in, nothing else changes", () => {
  const t = textarea();
  assert.equal(takeTyping({ readOnly: false, el: t.node, active: t.active, hiddenByFocus: false, endFocus: () => t.log.push("endFocus") }), true);
  assert.deepEqual(t.log, ["focus"]);
});

test("a read-only box (TUI-live, an earlier conversation, a baton not held) takes nothing and leaves Focus on", () => {
  const t = textarea();
  assert.equal(takeTyping({ readOnly: true, el: t.node, active: t.active, hiddenByFocus: true, endFocus: () => t.log.push("endFocus") }), false);
  assert.deepEqual(t.log, []);
});

test("a box Focus hides has Focus ended first, so it is visible and no longer inert when focused", () => {
  const t = textarea();
  assert.equal(takeTyping({ readOnly: false, el: t.node, active: t.active, hiddenByFocus: true, endFocus: () => t.log.push("endFocus") }), true);
  assert.deepEqual(t.log, ["endFocus", "focus"]);
});

test("a box that focus didn't reach took nothing", () => {
  const missed = textarea(false);
  assert.equal(takeTyping({ readOnly: false, el: missed.node, active: missed.active, hiddenByFocus: false, endFocus: () => {} }), false);
});

// ---- always on ----

test("there is no switch: no stored choice is read or written, so an old off choice changes nothing", () => {
  for (const name of ["TYPE_ANYWHERE_KEY", "typeAnywhere", "setTypeAnywhere", "readTypeAnywhere", "writeTypeAnywhere", "parseTypeAnywhere", "readStoredTypeAnywhere"])
    assert.equal(name in typeAnywhereModule, false, name);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const reads: string[] = [];
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => (reads.push(k), "false"), setItem: () => {} } });
    assert.deepEqual(run({}), { acted: true, box: 1, take: 1 });
    assert.deepEqual(reads, []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
