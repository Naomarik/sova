// Run: pnpm test -- src/lib/context-menu.test.ts
// The right-click menu's rules (§app.context-menus/native, /keyboard, /touch), on plain facts and
// stand-in elements: what opens Sova's menu, what stays the browser's, what a hold swallows, one
// menu per key press, and a mouse's menu showing on the button's release (§app.context-menus/placement).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRowPress } from "./drag-overlay";
import { HOLD_MS } from "./hold-select";
import {
  contextAction,
  type ContextFacts,
  contextPointerKind,
  createKeyEcho,
  createOpenOnRelease,
  type ElementLike,
  holdOwns,
  inPopover,
  inTextEntry,
  isContextMenuKey,
  KEYBOARD_ECHO_MS,
  onContentLink,
  pointInRects,
  pressHeld,
  startsPress,
} from "./context-menu";

const plain: ContextFacts = { kind: "mouse", shiftKey: false, taken: false, holds: false, textEntry: false, inPopover: false, onSelection: false, contentLink: false };
const act = (over: Partial<ContextFacts>) => contextAction({ ...plain, ...over });

test("a plain right-click on a place opens Sova's menu; so does a key", () => {
  assert.equal(act({}), "open");
  assert.equal(act({ kind: "keyboard" }), "open");
});

test("the decision table: each exception, on its own, and what wins when two meet", () => {
  const rows: [Partial<ContextFacts>, string, string][] = [
    [{ shiftKey: true }, "native", "Shift+right-click is the browser's"],
    [{ textEntry: true }, "native", "a text field, the composer or a select"],
    [{ onSelection: true }, "native", "a right-click on the selected text"],
    [{ contentLink: true }, "native", "a link inside content"],
    [{ inPopover: true }, "native", "inside an open menu or popover, Sova's own included"],
    [{ kind: "touch" }, "native", "a finger never opens Sova's menu"],
    [{ kind: "pen" }, "native", "nor does a pen"],
    [{ holds: true }, "swallow", "the hold's echo: neither menu"],
    [{ holds: true, kind: "touch" }, "swallow", "Android's long-press menu during the press stays swallowed"],
    [{ holds: true, shiftKey: true }, "swallow", "a hold owns the event whatever the modifiers"],
    [{ taken: true }, "taken", "an inner place already opened its menu: innermost wins"],
    [{ taken: true, holds: true }, "taken", "an inner place's answer stands"],
    [{ kind: "keyboard", shiftKey: true }, "open", "Shift+F10's own Shift is no request for the browser's menu"],
    [{ kind: "keyboard", onSelection: true }, "open", "a key has no pointer on the selection"],
    [{ kind: "keyboard", textEntry: true }, "native", "in a text field the keys stay the browser's"],
    [{ kind: "keyboard", contentLink: true }, "native", "on a link inside content they stay the browser's"],
  ];
  for (const [facts, want, why] of rows) assert.equal(act(facts), want, why);
});

test("the input a contextmenu came from", () => {
  assert.equal(contextPointerKind({ pointerType: "mouse" }, "touch"), "mouse", "Chromium says it, whatever went down last");
  assert.equal(contextPointerKind({ pointerType: "touch" }, null), "touch");
  assert.equal(contextPointerKind({ pointerType: "pen" }, null), "pen");
  assert.equal(contextPointerKind({ pointerType: "" }, "mouse"), "keyboard", "an empty pointer type reads as a key");
  assert.equal(contextPointerKind({ mozInputSource: 6 }, null), "keyboard", "Firefox's keyboard source");
  assert.equal(contextPointerKind({ mozInputSource: 5 }, null), "touch");
  assert.equal(contextPointerKind({ mozInputSource: 1 }, "touch"), "mouse");
  assert.equal(contextPointerKind({}, "touch"), "touch", "a plain MouseEvent after a finger went down is the finger's");
  assert.equal(contextPointerKind({}, "pen"), "pen");
  assert.equal(contextPointerKind({}, "mouse"), "mouse");
  assert.equal(contextPointerKind({}, null), "mouse");
});

test("a row's press: only the main mouse button without Ctrl, or any touch or pen, starts one", () => {
  assert.equal(startsPress({ pointerType: "mouse", button: 0, ctrlKey: false }), true);
  assert.equal(startsPress({ pointerType: "mouse", button: 2, ctrlKey: false }), false, "right-click is not a hold");
  assert.equal(startsPress({ pointerType: "mouse", button: 1, ctrlKey: false }), false, "nor a middle click");
  assert.equal(startsPress({ pointerType: "mouse", button: 0, ctrlKey: true }), false, "a Mac's Ctrl+click is a right-click");
  assert.equal(startsPress({ pointerType: "touch", button: 0, ctrlKey: false }), true);
  assert.equal(startsPress({ pointerType: "pen", button: 0, ctrlKey: false }), true);
});

test("hold interplay: a finger's press owns the contextmenu before the hold fires, and after it for the suppression window", () => {
  let at = 0;
  const timers: { fn: () => void; due: number }[] = [];
  const press = createRowPress({
    onLift() {},
    onDrag() {},
    now: () => at,
    schedule: (fn, ms) => timers.push({ fn, due: at + ms }),
    unschedule: () => {},
  });
  const owns = (pointerKind: string, dragging = false) => holdOwns({ suppressed: press.suppressed(), dragging, phase: press.phase(), pointerKind });
  // Touch: Android's long-press contextmenu can arrive before the 500ms hold fires.
  press.start({ x: 0, y: 0 }, "touch");
  at = HOLD_MS - 20;
  assert.equal(owns("touch"), true, "the press is still down, the hold not fired yet");
  assert.equal(act({ kind: "touch", holds: owns("touch") }), "swallow");
  at = HOLD_MS;
  timers.shift()!.fn();
  assert.equal(press.phase(), "lifted");
  assert.equal(owns("touch"), true, "lifted");
  press.finish();
  at += 500;
  assert.equal(owns("touch"), true, "within the window after the release");
  at += 1000;
  assert.equal(owns("touch"), false, "the window ran out");
  assert.equal(act({ kind: "touch", holds: owns("touch") }), "native", "a later long press elsewhere is the browser's, as before");
  // A mouse press in flight doesn't own a right-click: it is a press of its own.
  press.start({ x: 0, y: 0 }, "mouse");
  assert.equal(owns("mouse"), false);
  assert.equal(act({ kind: "mouse", holds: owns("mouse") }), "open");
  press.cancel();
  // A drag in flight owns it, whatever the pointer.
  assert.equal(owns("mouse", true), true);
});

test("Shift+F10 and the Menu key, and nothing else", () => {
  const k = (key: string, over: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
    isContextMenuKey({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
  assert.equal(k("F10", { shiftKey: true }), true);
  assert.equal(k("ContextMenu"), true);
  assert.equal(k("F10"), false, "plain F10 is the browser's menu bar");
  assert.equal(k("ContextMenu", { shiftKey: true }), false);
  for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
    assert.equal(k("F10", { shiftKey: true, [mod]: true }), false, mod);
    assert.equal(k("ContextMenu", { [mod]: true }), false, mod);
  }
});

// ---- reading the facts on stand-in elements ----

/** A stand-in element: a tag, attributes, a parent; `closest` understands the selectors the rules use. */
function el(tag: string, attrs: Record<string, string | boolean> = {}, parent: Fake | null = null): Fake {
  return new Fake(tag, attrs, parent);
}
class Fake implements ElementLike {
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string | boolean>,
    readonly parent: Fake | null,
  ) {}
  get tagName() {
    return this.tag.toUpperCase();
  }
  get type() {
    return (this.attrs.type as string) ?? null;
  }
  get isContentEditable(): boolean {
    const v = this.attrs.contenteditable;
    if (v === "false") return false;
    if (v !== undefined) return true;
    return this.parent?.isContentEditable ?? false;
  }
  private matches(sel: string): boolean {
    return sel.split(",").some((one) => {
      const s = one.trim();
      if (s === "[popover]") return "popover" in this.attrs;
      if (s === "[contenteditable]") return "contenteditable" in this.attrs;
      if (s === "a[href]") return this.tag === "a" && "href" in this.attrs;
      return s === this.tag;
    });
  }
  closest(sel: string): Fake | null {
    for (let e: Fake | null = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  within(other: Fake): boolean {
    for (let e: Fake | null = this; e; e = e.parent) if (e === other) return true;
    return false;
  }
}

test("text entry: a field you type in, editable text or a select; a checkbox or a button is not", () => {
  const root = el("div");
  assert.equal(inTextEntry(el("span", {}, el("textarea", {}, root))), true);
  assert.equal(inTextEntry(el("input", { type: "text" }, root)), true);
  assert.equal(inTextEntry(el("input", {}, root)), true, "no type is text");
  assert.equal(inTextEntry(el("input", { type: "search" }, root)), true);
  assert.equal(inTextEntry(el("option", {}, el("select", {}, root))), true);
  assert.equal(inTextEntry(el("b", {}, el("div", { contenteditable: "true" }, root))), true, "the composer's editable text");
  assert.equal(inTextEntry(el("input", { type: "checkbox" }, root)), false);
  assert.equal(inTextEntry(el("button", {}, root)), false);
  assert.equal(inTextEntry(el("span", {}, root)), false);
  assert.equal(inTextEntry(null), false);
});

test("inside an open popover: Sova's right-click menu, a ⋯ panel inside a row", () => {
  const row = el("li");
  const panel = el("div", { popover: "auto" }, row);
  assert.equal(inPopover(el("span", {}, el("div", {}, panel))), true);
  assert.equal(inPopover(el("span", {}, row)), false);
});

test("a link inside content is the browser's; the row's own link is the row", () => {
  const row = el("li");
  const own = el("a", { href: "#/s/a" }, row);
  const title = el("p", {}, own);
  const body = el("div", {}, row);
  const mdLink = el("a", { href: "https://example.com" }, body);
  const chip = el("a", { href: "#/agents/t" }, row);
  const inRow = (a: ElementLike) => (a as Fake).within(row);
  assert.equal(onContentLink(title, inRow, own), false, "on the row's own link (a sidebar row, a board title)");
  assert.equal(onContentLink(el("code", {}, mdLink), inRow, own), true, "a Markdown link in a message");
  assert.equal(onContentLink(chip, inRow, own), true, "a team chip on the board");
  assert.equal(onContentLink(body, inRow, own), false, "no link at all");
  assert.equal(onContentLink(el("a", {}, row), inRow, own), false, "an anchor with no href is no link");
  const outside = el("a", { href: "#/x" });
  assert.equal(onContentLink(el("span", {}, outside), inRow, own), false, "a link around the place isn't inside its content");
});

test("on the selection: the pointer inside one of its boxes, edges included", () => {
  const rects = [
    { left: 10, right: 100, top: 10, bottom: 20 },
    { left: 0, right: 40, top: 20, bottom: 30 },
  ];
  assert.equal(pointInRects(50, 15, rects), true);
  assert.equal(pointInRects(10, 10, rects), true);
  assert.equal(pointInRects(30, 25, rects), true, "the second line");
  assert.equal(pointInRects(60, 25, rects), false, "beside the second line, inside the first's width: not on it");
  assert.equal(pointInRects(5, 15, rects), false);
  assert.equal(pointInRects(5, 15, []), false, "no selection boxes");
});

test("one press of the key opens one menu: the browser's own keyboard menu after it is swallowed once", () => {
  let at = 0;
  const echo = createKeyEcho(() => at);
  assert.equal(echo.isEcho(), false, "nothing opened: a contextmenu is no echo");
  echo.opened();
  at += 50;
  assert.equal(echo.isEcho(), true, "Shift+F10's native menu right after");
  assert.equal(echo.isEcho(), false, "only once per press");
  // Chromium on Windows sends the Menu key's on keyup: a key held a while counts from its release.
  echo.opened();
  at += KEYBOARD_ECHO_MS + 500;
  echo.keyUp();
  at += 30;
  assert.equal(echo.isEcho(), true);
  // A right-click after a keyboard open is a pointer's: its pointerdown comes first.
  echo.opened();
  at += 10;
  echo.pointerDown();
  assert.equal(echo.isEcho(), false);
  // No echo came (macOS): a much later contextmenu is no echo.
  echo.opened();
  at += KEYBOARD_ECHO_MS + 1;
  assert.equal(echo.isEcho(), false);
  // keyUp with nothing pending opens no window.
  echo.keyUp();
  assert.equal(echo.isEcho(), false);
});

// ---- a mouse's menu shows on the release ----

/** A stand-in window and document that record listeners, and a scheduler run by hand. */
function releaseRig() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const target = (prefix: string) => ({
    addEventListener: (type: string, fn: (e: Event) => void) => void (listeners.get(prefix + type) ?? listeners.set(prefix + type, new Set()).get(prefix + type)!).add(fn),
    removeEventListener: (type: string, fn: (e: Event) => void) => void listeners.get(prefix + type)?.delete(fn),
  });
  const doc = { ...target("doc:"), visibilityState: "visible" };
  let tasks: (() => void)[] = [];
  const release = createOpenOnRelease({
    win: target(""),
    doc,
    later: (fn) => {
      tasks.push(fn);
      return () => (tasks = tasks.filter((t) => t !== fn));
    },
  });
  const fire = (type: string, props: Record<string, unknown> = {}, prefix = "") => {
    for (const fn of [...(listeners.get(prefix + type) ?? [])]) fn({ type, ...props } as unknown as Event);
  };
  const opened: string[] = [];
  return {
    release,
    opened,
    /** The browser's input, in order: the window hears each event before any place. */
    pointerdown: (buttons = 2) => fire("pointerdown", { buttons }),
    pointerup: (buttons = 0) => fire("pointerup", { buttons }),
    /** A contextmenu reaching a place that answers `open`, with `buttons` as the event carries them. */
    contextmenu(place: string, buttons: number, kind: "mouse" | "keyboard" = "mouse") {
      fire("contextmenu", { buttons });
      release.request(pressHeld(kind, buttons), place, () => opened.push(place));
    },
    fire,
    hide() {
      doc.visibilityState = "hidden";
      fire("visibilitychange", {}, "doc:");
    },
    /** The next task: what `later` scheduled runs. */
    tick() {
      const run = tasks;
      tasks = [];
      for (const t of run) t();
    },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

test("held: only a mouse contextmenu that comes with a button still down", () => {
  assert.equal(pressHeld("mouse", 2), true, "Linux and macOS: on the right button's press");
  assert.equal(pressHeld("mouse", 1), true, "a Mac's Ctrl+click: the left button");
  assert.equal(pressHeld("mouse", 0), false, "Windows: on the release");
  assert.equal(pressHeld("mouse", undefined), false);
  assert.equal(pressHeld("keyboard", 0), false);
  assert.equal(pressHeld("keyboard", 2), false, "a key while a button is down: a key's menu, at once");
});

test("a contextmenu after the release (Windows) or from a key opens at once, with no further event", () => {
  const r = releaseRig();
  r.pointerdown();
  r.pointerup();
  r.contextmenu("row A", 0);
  assert.deepEqual(r.opened, ["row A"]);
  assert.equal(r.release.waiting(), false);
  assert.equal(r.listening(), 0, "nothing left listening");
  r.contextmenu("row B", 0, "keyboard");
  assert.deepEqual(r.opened, ["row A", "row B"]);
});

test("a contextmenu during the press (Linux, macOS) opens one task after the release, never before", () => {
  const r = releaseRig();
  r.pointerdown();
  r.contextmenu("row A", 2);
  assert.deepEqual(r.opened, [], "nothing while the button is held");
  assert.equal(r.release.waiting(), true);
  r.tick();
  assert.deepEqual(r.opened, [], "no deadline: a long hold still waits");
  r.pointerup(1); // another button still down
  r.tick();
  assert.deepEqual(r.opened, []);
  r.pointerup(0);
  assert.deepEqual(r.opened, [], "not during the release's own dispatch, where light dismiss runs");
  r.tick();
  assert.deepEqual(r.opened, ["row A"]);
  assert.equal(r.release.waiting(), false);
  assert.equal(r.listening(), 0, "nothing left listening");
  r.pointerup(0);
  r.tick();
  assert.deepEqual(r.opened, ["row A"], "opens once");
});

test("the place going away before the release opens nothing", () => {
  const r = releaseRig();
  r.pointerdown();
  r.contextmenu("row A", 2);
  r.release.cancelOf((k) => k === "row B");
  assert.equal(r.release.waiting(), true, "another place going away leaves it");
  r.release.cancelOf((k) => k === "row A");
  r.pointerup();
  r.tick();
  assert.deepEqual(r.opened, []);
  assert.equal(r.listening(), 0);
});

test("a press that never finishes opens nothing: pointercancel, blur, hidden, Escape", () => {
  const cases: [string, (r: ReturnType<typeof releaseRig>) => void][] = [
    ["pointercancel", (r) => r.fire("pointercancel")],
    ["the window's blur", (r) => r.fire("blur")],
    ["the page turning hidden", (r) => r.hide()],
    ["Escape", (r) => r.fire("keydown", { key: "Escape" })],
  ];
  for (const [what, end] of cases) {
    const r = releaseRig();
    r.pointerdown();
    r.contextmenu("row A", 2);
    end(r);
    assert.equal(r.release.waiting(), false, what);
    r.pointerup();
    r.tick();
    assert.deepEqual(r.opened, [], what);
    assert.equal(r.listening(), 0, what);
  }
  // Another key doesn't end it.
  const r = releaseRig();
  r.contextmenu("row A", 2);
  r.fire("keydown", { key: "Shift" });
  r.pointerup();
  r.tick();
  assert.deepEqual(r.opened, ["row A"]);
});

test("abandoned between the release and its task: the release's blur or Escape still wins", () => {
  for (const end of ["blur", "keydown"]) {
    const r = releaseRig();
    r.contextmenu("row A", 2);
    r.pointerup();
    r.fire(end, { key: "Escape" });
    r.tick();
    assert.deepEqual(r.opened, [], end);
  }
});

test("a newer contextmenu abandons the waiting one: only the newer place's menu shows", () => {
  const r = releaseRig();
  r.contextmenu("row A", 2);
  r.contextmenu("row B", 2);
  r.pointerup();
  r.tick();
  assert.deepEqual(r.opened, ["row B"]);
  // A newer one no place takes (the browser's menu) abandons it too.
  const n = releaseRig();
  n.contextmenu("row A", 2);
  n.fire("contextmenu", { buttons: 2 });
  n.pointerup();
  n.tick();
  assert.deepEqual(n.opened, []);
  // A newer one after the release opens at once and ends the wait.
  const w = releaseRig();
  w.contextmenu("row A", 2);
  w.contextmenu("row B", 0, "keyboard");
  w.pointerup();
  w.tick();
  assert.deepEqual(w.opened, ["row B"]);
});
