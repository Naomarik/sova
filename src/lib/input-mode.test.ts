import assert from "node:assert/strict";
import { test } from "node:test";
import { stopButton } from "./compact";
import {
  composerKey,
  createEscTimes,
  createPressTracker,
  enterSends,
  ESC_SETTLE_MS,
  escStops,
  escTooSoon,
  notePress,
  refocusAfterSend,
  toEnd,
  type ComposerKey,
  type ComposerKeyState,
  type EscKey,
  type EscTimes,
} from "./input-mode";

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
  timeStamp: 10_000,
  ...over,
});
const noPopover = () => false;
const run = { running: true, compacting: false, readOnly: false, stopping: false, stopBlocked: false };
/** No Esc went down on the page before this one. */
const first = null;
/** Esc times whose Esc before any press is `at` (a stand-in for createEscTimes). */
const escAfter = (at: number | null): EscTimes => ({ before: () => at });

test("a plain Esc stops while Stop is usable: a reply or a compaction", () => {
  assert.equal(escStops(esc(), stopButton(run), noPopover, first), true);
  assert.equal(escStops(esc(), stopButton({ ...run, running: false, compacting: true }), noPopover, first), true);
});

test("Esc with any modifier never stops", () => {
  for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey"] as const)
    assert.equal(escStops(esc({ [mod]: true }), "usable", noPopover, first), false, mod);
});

test("an Esc something else took never stops: IME, a held key, a menu that prevented it", () => {
  assert.equal(escStops(esc({ isComposing: true }), "usable", noPopover, first), false);
  assert.equal(escStops(esc({ keyCode: 229 }), "usable", noPopover, first), false); // Safari's composition-ending key
  assert.equal(escStops(esc({ repeat: true }), "usable", noPopover, first), false);
  assert.equal(escStops(esc({ defaultPrevented: true }), "usable", noPopover, first), false);
});

test("with a popover open, Esc is the popover's", () => {
  assert.equal(escStops(esc(), "usable", () => true, first), false);
});

test("Esc does nothing where Stop is missing or aria-disabled", () => {
  const cases = {
    "not running": { ...run, running: false },
    "read only": { ...run, readOnly: true },
    stopping: { ...run, stopping: true },
    "socket not open": { ...run, stopBlocked: true },
  };
  for (const [name, s] of Object.entries(cases)) assert.equal(escStops(esc(), stopButton(s), noPopover, first), false, name);
});

test("no other key stops, and the popover is read only for an Esc that would", () => {
  let asked = 0;
  const popover = () => (asked++, false);
  for (const key of ["Enter", "Tab", "Backspace", "q"]) assert.equal(escStops(esc({ key }), "usable", popover, first), false, key);
  assert.equal(escStops(esc(), "disabled", popover, first), false);
  assert.equal(escStops(esc({ timeStamp: 10_100 }), "usable", popover, 10_000), false);
  assert.equal(asked, 0);
});

test("an Esc less than half a second after the page's last Esc never stops; one at 500 ms does", () => {
  assert.equal(ESC_SETTLE_MS, 500);
  assert.equal(escStops(esc({ timeStamp: 10_000 }), "usable", noPopover, first), true, "no Esc before it");
  assert.equal(escStops(esc({ timeStamp: 10_001 }), "usable", noPopover, 10_000), false);
  assert.equal(escStops(esc({ timeStamp: 10_499 }), "usable", noPopover, 10_000), false);
  assert.equal(escStops(esc({ timeStamp: 10_500 }), "usable", noPopover, 10_000), true);
  assert.equal(escStops(esc({ timeStamp: 70_000 }), "usable", noPopover, 10_000), true);
});

test("a gap that reads negative counts as too soon", () => {
  assert.equal(escTooSoon(10_000, 10_200), true);
  assert.equal(escStops(esc({ timeStamp: 10_000 }), "usable", noPopover, 10_200), false);
});

test("escTooSoon: no previous Esc is never too soon, and the window is the given one", () => {
  assert.equal(escTooSoon(0, null), false);
  assert.equal(escTooSoon(499, 0), true);
  assert.equal(escTooSoon(500, 0), false);
  assert.equal(escTooSoon(250, 0, 300), true);
  assert.equal(escTooSoon(300, 0, 300), false);
});

test("a held Esc never stops, however long after the last one", () => {
  assert.equal(escStops(esc({ repeat: true }), "usable", noPopover, first), false);
  assert.equal(escStops(esc({ repeat: true, timeStamp: 90_000 }), "usable", noPopover, 10_000), false);
});

/** The box with nothing open, Stop usable, no Esc before. */
const idle: ComposerKeyState = {
  slash: { open: false, matches: 0 },
  mention: { open: false, matches: 0 },
  runsLocal: false,
  touch: false,
  stop: "usable",
  popoverOpen: noPopover,
  escs: escAfter(first),
};
const press = (name: string): EscKey => {
  const [mods, key] = name.includes("+") ? [name.split("+")[0]!, name.split("+")[1]!] : ["", name];
  return esc({ key, shiftKey: mods === "Shift", ctrlKey: mods === "Ctrl" });
};

test("/ menu open: Esc closes it and never stops", () => {
  for (const matches of [0, 3]) {
    const s = { ...idle, slash: { open: true, matches } };
    assert.equal(composerKey(esc(), s), "slash-close", `${matches} rows`);
    assert.equal(composerKey(esc({ timeStamp: 10_100 }), { ...s, escs: escAfter(10_000) }), "slash-close", "the guard leaves the menu its Esc");
  }
});

test("@ menu open: Esc closes it and never stops", () => {
  for (const matches of [0, 3]) {
    const s = { ...idle, mention: { open: true, matches } };
    assert.equal(composerKey(esc(), s), "mention-close", `${matches} rows`);
    assert.equal(composerKey(esc({ timeStamp: 10_100 }), { ...s, escs: escAfter(10_000) }), "mention-close");
  }
});

test("/ menu open with a match: Enter picks, never sends", () => {
  const s = { ...idle, slash: { open: true, matches: 2 } };
  assert.equal(composerKey(press("Enter"), s), "slash-pick");
  assert.equal(composerKey(press("Ctrl+Enter"), s), "slash-pick");
  // With no match the Enter is the box's again.
  assert.equal(composerKey(press("Enter"), { ...s, slash: { open: true, matches: 0 } }), "send");
});

test("a bare local command's Enter goes past the / menu and sends", () => {
  assert.equal(composerKey(press("Enter"), { ...idle, slash: { open: true, matches: 2 }, runsLocal: true }), "send");
});

test("nothing open, Stop usable: Esc stops", () => {
  assert.equal(composerKey(esc(), idle), "stop");
  assert.equal(composerKey(esc(), { ...idle, stop: "disabled" }), "default");
  assert.equal(composerKey(esc(), { ...idle, stop: "hidden" }), "default");
  assert.equal(composerKey(esc(), { ...idle, popoverOpen: () => true }), "default");
});

test("shell mode with a command typed: Esc never stops the reply, and Enter still runs", () => {
  // An empty shell box's Esc left shell mode before composerKey is asked (lib/shell-box key).
  assert.equal(composerKey(esc(), { ...idle, shell: true }), "default");
  assert.equal(composerKey(press("Enter"), { ...idle, shell: true }), "send");
  // Out of shell mode, the same Esc stops as before.
  assert.equal(composerKey(esc(), { ...idle, shell: false }), "stop");
});

test("Esc right after an Esc: nothing", () => {
  assert.equal(composerKey(esc({ timeStamp: 10_300 }), { ...idle, escs: escAfter(10_000) }), "default");
  // Only Esc is held back: Enter right after an Esc still sends.
  assert.equal(composerKey(press("Enter"), { ...idle, escs: escAfter(9_990) }), "send");
});

/** A keydown as the page's Esc times see it, at `timeStamp`. */
const keydown = (key: string, timeStamp: number) => {
  const e = Object.assign(new Event("keydown"), { key });
  Object.defineProperty(e, "timeStamp", { value: timeStamp });
  return e;
};
/** An Esc press as the box's handler gets it, after the page's listener noted the same event. */
const escOn = (page: EventTarget, timeStamp: number): EscKey => {
  page.dispatchEvent(keydown("Escape", timeStamp));
  return esc({ timeStamp });
};

test("the page's Esc times hold back the box's Esc right after another, end to end", () => {
  const page = new EventTarget();
  const escs = createEscTimes(page);
  const s = { ...idle, escs };
  assert.equal(composerKey(escOn(page, 10_000), s), "stop", "a lone Esc stops");
  assert.equal(composerKey(escOn(page, 10_300), s), "default", "the one right after it doesn't");
  assert.equal(composerKey(escOn(page, 10_900), s), "stop", "half a second after the last one, it does");
  // An Esc that only closed something elsewhere (the box never saw it) still holds the next one back.
  page.dispatchEvent(keydown("Escape", 20_000));
  assert.equal(composerKey(escOn(page, 20_200), s), "default");
  // Other keys aren't Escs.
  page.dispatchEvent(keydown("a", 30_000));
  assert.equal(composerKey(escOn(page, 30_100), s), "stop");
  // A press the page never noted is measured against the last one noted.
  assert.equal(composerKey(esc({ timeStamp: 30_200 }), s), "default");
  escs.dispose();
  page.dispatchEvent(keydown("Escape", 40_000));
  assert.equal(composerKey(esc({ timeStamp: 40_100 }), s), "stop", "disposed: no longer listening");
});

test("the page's Esc times listen on the window by default, in the capture phase", () => {
  const added: Array<[string, boolean]> = [];
  const page = { addEventListener: (t: string, _f: unknown, c: boolean) => added.push([t, c]), removeEventListener() {} } as unknown as EventTarget;
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: page });
  try {
    createEscTimes();
  } finally {
    if (had) Object.defineProperty(globalThis, "window", had);
    else delete (globalThis as { window?: unknown }).window;
  }
  assert.deepEqual(added, [["keydown", true]]);
});

test("nothing open: Enter sends (touch: newline)", () => {
  assert.equal(composerKey(press("Enter"), idle), "send");
  assert.equal(composerKey(press("Enter"), { ...idle, touch: true }), "default");
  assert.equal(composerKey(press("Ctrl+Enter"), { ...idle, touch: true }), "send");
});

test("composing: nothing", () => {
  const states = [idle, { ...idle, slash: { open: true, matches: 2 } }, { ...idle, mention: { open: true, matches: 2 } }];
  for (const s of states)
    for (const key of ["Escape", "Enter", "Tab", "ArrowDown"]) assert.equal(composerKey(esc({ key, isComposing: true }), s), "default", key);
});

test("every key in every state: the one rule, key by key", () => {
  const keys = ["ArrowDown", "ArrowUp", "Enter", "Shift+Enter", "Ctrl+Enter", "Tab", "Escape", "Shift+Escape", "a"];
  const d = "default";
  const table: [string, ComposerKeyState, ComposerKey[]][] = [
    ["nothing open", idle, [d, d, "send", d, "send", d, "stop", d, d]],
    ["nothing open, touch", { ...idle, touch: true }, [d, d, d, d, "send", d, "stop", d, d]],
    ["nothing open, Stop missing", { ...idle, stop: "hidden" }, [d, d, "send", d, "send", d, d, d, d]],
    ["nothing open, Esc just before", { ...idle, escs: escAfter(9_800) }, [d, d, "send", d, "send", d, d, d, d]],
    ["/ with rows", { ...idle, slash: { open: true, matches: 3 } }, ["slash-move", "slash-move", "slash-pick", d, "slash-pick", "slash-pick", "slash-close", "slash-close", d]],
    ["/ with no rows", { ...idle, slash: { open: true, matches: 0 } }, [d, d, "send", d, "send", d, "slash-close", "slash-close", d]],
    ["@ with rows", { ...idle, mention: { open: true, matches: 3 } }, ["mention-move", "mention-move", "mention-pick", d, "mention-pick", "mention-pick", "mention-close", "mention-close", d]],
    ["@ with no rows", { ...idle, mention: { open: true, matches: 0 } }, [d, d, "send", d, "send", d, "mention-close", "mention-close", d]],
    // The / menu asks first: its arrows with no rows do nothing, even with the @ menu open too.
    ["/ with no rows and @ with rows", { ...idle, slash: { open: true, matches: 0 }, mention: { open: true, matches: 3 } }, [d, d, "mention-pick", d, "mention-pick", d, "slash-close", "slash-close", d]],
  ];
  for (const [name, s, want] of table)
    assert.deepEqual(
      keys.map((k) => composerKey(press(k), s)),
      want,
      name,
    );
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

test("text that comes back leaves the caret after what was typed, scrolled into view", () => {
  // A 2,100-character queued message back above a typed line, in a box 336 px tall: as the browser leaves it.
  const value = `${"x".repeat(2100)}\n\nmy words`;
  const calls: Array<[number, number]> = [];
  const box = { value, scrollTop: 0, scrollHeight: 2109, setSelectionRange: (a: number, b: number) => void calls.push([a, b]) };
  toEnd(box);
  assert.deepEqual(calls, [[value.length, value.length]], "the caret at the end, after the typed words");
  assert.equal(box.scrollTop, 2109, "scrolled to the bottom, where the caret is");
});
