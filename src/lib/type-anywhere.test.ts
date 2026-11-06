import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isOpenOverlay,
  keyBelongsToTarget,
  parseTypeAnywhere,
  readStoredTypeAnywhere,
  readTypeAnywhere,
  setTypeAnywhere,
  startTyping,
  takeTyping,
  typeAnywhere,
  typesCharacter,
  TYPE_ANYWHERE_KEY,
  writeTypeAnywhere,
  type CharKeyLike,
  type ElementLike,
} from "./type-anywhere";

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

test("an input method's keys are its own: a composing keydown, keyCode 229, Process, a soft keyboard's Unidentified", () => {
  for (const mac of BOTH) {
    assert.equal(typesCharacter(key({ key: "a", isComposing: true }), mac), false);
    assert.equal(typesCharacter(key({ key: "a", keyCode: 229 }), mac), false);
    assert.equal(typesCharacter(key({ key: "Process" }), mac), false);
    assert.equal(typesCharacter(key({ key: "Unidentified" }), mac), false);
    assert.equal(typesCharacter(key({ key: "a", keyCode: 65 }), mac), true, "a real key's code is fine");
  }
});

test("an accent key counts even as keyCode 229 (a Mac's Option+E), but not once a composition runs", () => {
  assert.equal(typesCharacter(key({ key: "Dead", altKey: true, keyCode: 229 }), true), true);
  assert.equal(typesCharacter(key({ key: "Dead", keyCode: 229 }), false), true, "´ on a Spanish layout");
  assert.equal(typesCharacter(key({ key: "Dead", isComposing: true }), true), false);
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

test("a key typed in a text field, a contenteditable or a select is the field's", () => {
  assert.equal(keyBelongsToTarget(el("TEXTAREA", {}, main)), true);
  assert.equal(keyBelongsToTarget(el("INPUT", { type: "text" }, main)), true);
  assert.equal(keyBelongsToTarget(el("INPUT", { type: "search" }, main)), true);
  assert.equal(keyBelongsToTarget(el("DIV", {}, main, { isContentEditable: true })), true);
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

test("an open overlay: a modal dialog, a scrim dialog, an open popover; not a tooltip, a closed one or a non-modal dialog", () => {
  const withState = (tag: string, attrs: Record<string, string>, open: Record<string, boolean>) => el(tag, attrs, body, { matches: (s) => open[s] === true });
  assert.equal(isOpenOverlay(el("DIV", { role: "dialog", "aria-modal": "true" }, body)), true, "the palette, Settings, the shortcut sheet");
  assert.equal(isOpenOverlay(el("DIV", { role: "dialog", "aria-modal": "false" }, body)), false);
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

const opened = el("DIV", { popover: "auto" }, body, { matches: (s) => s === ":popover-open" });
const closed = el("DIV", { popover: "auto" }, body, { matches: () => false });
const button = el("BUTTON", {}, main);

const run = (over: { on?: boolean; target?: unknown; overlays?: ElementLike[]; box?: { take(): boolean } | null }) => {
  const calls = { box: 0, take: 0 };
  const box = over.box === undefined ? { take: () => true } : over.box;
  const acted = startTyping(
    { target: "target" in over ? over.target : button },
    {
      on: over.on ?? true,
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

test("nothing happens with the switch off: the box isn't even looked for", () => {
  assert.deepEqual(run({ on: false }), { acted: false, box: 0, take: 0 });
});

test("nothing happens from a text field, a contenteditable, a select or a list that jumps as you type", () => {
  for (const target of [el("TEXTAREA", {}, main), el("DIV", {}, main, { isContentEditable: true }), el("SELECT", {}, main), el("DIV", { role: "option" }, el("DIV", { role: "listbox" }, main))])
    assert.deepEqual(run({ target }), { acted: false, box: 0, take: 0 }, String(target.tagName));
});

test("nothing happens while a dialog, sheet, menu or popover is open, focus outside it or not", () => {
  assert.deepEqual(run({ overlays: [closed, opened] }), { acted: false, box: 0, take: 0 });
  assert.deepEqual(run({ overlays: [el("DIV", { role: "dialog", "aria-modal": "true" }, body)] }), { acted: false, box: 0, take: 0 });
});

test("nothing happens with no box on screen, or a box that takes no typing (read-only)", () => {
  assert.deepEqual(run({ box: null }), { acted: false, box: 1, take: 0 });
  assert.deepEqual(run({ box: { take: () => false } }), { acted: false, box: 1, take: 1 });
});

// ---- the box taking it ----

const textarea = (lands = true) => {
  const log: string[] = [];
  const node = { isConnected: true, focus: () => void log.push("focus") };
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

test("a box that isn't mounted, or that focus didn't reach, took nothing", () => {
  const gone = textarea();
  gone.node.isConnected = false;
  assert.equal(takeTyping({ readOnly: false, el: gone.node, active: gone.active, hiddenByFocus: false, endFocus: () => {} }), false);
  assert.deepEqual(gone.log, []);
  const missed = textarea(false);
  assert.equal(takeTyping({ readOnly: false, el: missed.node, active: missed.active, hiddenByFocus: false, endFocus: () => {} }), false);
});

// ---- the switch ----

const values = new Map<string, string>();
const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) } as Storage;

test("the switch is on by default; only exactly false turns it off", () => {
  for (const raw of [null, "", "true", "0", "False", " false ", "garbage"]) assert.equal(parseTypeAnywhere(raw), true, String(raw));
  assert.equal(parseTypeAnywhere("false"), false);
  values.clear();
  assert.equal(readTypeAnywhere(storage), true);
  writeTypeAnywhere(storage, false);
  assert.equal(values.get(TYPE_ANYWHERE_KEY), "false");
  assert.equal(readTypeAnywhere(storage), false);
  writeTypeAnywhere(storage, true);
  assert.equal(readTypeAnywhere(storage), true);
});

test("the switch survives missing, blocked and full storage, its choice held for the page", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    assert.equal(readStoredTypeAnywhere(), true);
    setTypeAnywhere(false);
    assert.equal(typeAnywhere(), false);
    const full = { getItem: () => null, setItem: () => { throw new Error("full"); } } as unknown as Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: full });
    assert.doesNotThrow(() => setTypeAnywhere(true));
    assert.equal(typeAnywhere(), true);
    values.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    setTypeAnywhere(false);
    assert.equal(values.get(TYPE_ANYWHERE_KEY), "false");
    assert.equal(readStoredTypeAnywhere(), false);
    setTypeAnywhere(true);
    assert.equal(typeAnywhere(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
