// Run: pnpm test -- src/lib/context-menu.test.ts
// The pointer menu's rules (§app.context-menus/native, /doors, /touch), on plain facts and
// stand-in elements: right-click, a touch/pen hold, what stays the browser's (a keyboard context-menu
// event included), what a hold swallows, and a mouse's menu showing on the button's release
// (§app.context-menus/placement).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_MOVE_PX, HOLD_MS, HOLD_SUPPRESS_MS } from "./hold-select";
import {
  contextAction,
  type ContextFacts,
  contextPointerKind,
  createMenuHold,
  createOpenOnRelease,
  createPressSelection,
  type ElementLike,
  inPopover,
  inTextEntry,
  onContentLink,
  pointInRects,
  pressHeld,
  startsPress,
} from "./context-menu";

const plain: ContextFacts = { kind: "mouse", shiftKey: false, taken: false, holds: false, textEntry: false, inPopover: false, onSelection: false, contentLink: false };
const act = (over: Partial<ContextFacts>) => contextAction({ ...plain, ...over });

test("a plain right-click on a place opens Sova's menu; a keyboard event stays the browser's", () => {
  assert.equal(act({}), "open");
  assert.equal(act({ kind: "keyboard" }), "native");
});

test("the decision table: each exception, on its own, and what wins when two meet", () => {
  const rows: [Partial<ContextFacts>, string, string][] = [
    [{ shiftKey: true }, "native", "Shift+right-click is the browser's"],
    [{ textEntry: true }, "native", "a text field, the composer or a select"],
    [{ onSelection: true }, "native", "a right-click on the selected text"],
    [{ contentLink: true }, "native", "a link inside content"],
    [{ inPopover: true }, "native", "inside an open menu or popover, Sova's own included"],
    [{ kind: "touch" }, "native", "a browser contextmenu without Sova's completed hold stays native"],
    [{ kind: "pen" }, "native", "nor does a pen's browser event alone open one"],
    [{ kind: "touch", held: true }, "open", "a stationary finger hold opens at 500ms"],
    [{ kind: "pen", held: true }, "open", "so does a stationary pen hold"],
    [{ kind: "touch", held: true, textEntry: true }, "native", "a hold in a text field stays the browser's"],
    [{ kind: "pen", held: true, inPopover: true }, "native", "a hold inside an open popover stays the browser's"],
    [{ kind: "touch", held: true, onSelection: true }, "native", "a hold on live selected text stays the browser's"],
    [{ kind: "pen", held: true, contentLink: true }, "native", "a content link keeps its own browser menu"],
    [{ holds: true }, "swallow", "the hold's echo: neither menu"],
    [{ holds: true, kind: "touch" }, "swallow", "Android's long-press menu during the press stays swallowed"],
    [{ holds: true, shiftKey: true }, "swallow", "a hold owns the event whatever the modifiers"],
    [{ taken: true }, "taken", "an inner place already opened its menu: innermost wins"],
    [{ taken: true, holds: true }, "taken", "an inner place's answer stands"],
    [{ kind: "keyboard", shiftKey: true }, "native", "Shift+F10's browser event is never taken"],
    [{ kind: "keyboard", onSelection: true }, "native", "nor is the Menu key's"],
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

/** The hold controller on a fake clock, with the row's optional drag handoff recorded. */
function holdRig() {
  let at = 0;
  let due: { at: number; fn: () => void } | null = null;
  const opened: string[] = [];
  const drags: { x: number; y: number }[] = [];
  const hold = createMenuHold({
    now: () => at,
    schedule: (fn, ms) => (due = { at: at + ms, fn }),
    unschedule: () => (due = null),
  });
  const start = (drag = true, key = "row") => hold.start({ key, pointerId: 1, at: { x: 100, y: 100 }, show: () => (opened.push(String(key)), true), drag: drag ? (p) => drags.push(p) : undefined });
  const tick = (ms: number) => {
    at += ms;
    if (due && due.at <= at) {
      const task = due;
      due = null;
      task.fn();
    }
  };
  return { hold, opened, drags, start, tick };
}

test("the hold's 500ms boundary: not before, exactly then, once", () => {
  const r = holdRig();
  r.start(false);
  r.tick(HOLD_MS - 1);
  assert.deepEqual(r.opened, []);
  r.tick(1);
  assert.deepEqual(r.opened, ["row"]);
  r.tick(HOLD_MS * 3);
  assert.deepEqual(r.opened, ["row"], "a long press does not open it again");
});

test("the movement rule: either axis past 10px before firing abandons the hold and leaves the browser's scroll alone", () => {
  for (const [dx, dy, opens] of [
    [0, 0, true],
    [HOLD_MOVE_PX, 0, true],
    [0, -HOLD_MOVE_PX, true],
    [HOLD_MOVE_PX + 1, 0, false],
    [0, HOLD_MOVE_PX + 1, false],
    [-HOLD_MOVE_PX - 1, 0, false],
  ] as const) {
    const r = holdRig();
    r.start();
    r.tick(100);
    r.hold.move(1, { x: 100 + dx, y: 100 + dy });
    r.tick(HOLD_MS);
    r.hold.finish(1);
    assert.equal(r.opened.length > 0, opens, `${dx},${dy}: hold`);
    assert.deepEqual(r.drags, [], `${dx},${dy}: no drag before the row has lifted`);
  }
  const plain = holdRig();
  plain.start(false);
  plain.hold.move(1, { x: 111, y: 100 });
  plain.tick(HOLD_MS);
  assert.deepEqual(plain.opened, [], "a non-draggable place simply abandons a moved hold");
});

test("a draggable row's stationary 500ms hold opens its actions only on release", () => {
  const r = holdRig();
  r.start();
  r.tick(HOLD_MS);
  assert.deepEqual(r.opened, [], "the deadline lifts the row; it does not open the menu");
  r.hold.finish(1);
  assert.deepEqual(r.opened, ["row"], "the stationary release opens the actions");
  assert.deepEqual(r.drags, []);
});

test("a draggable row that moves after its 500ms lift starts one drag and never opens the menu", () => {
  const r = holdRig();
  r.start();
  r.tick(HOLD_MS);
  r.hold.move(1, { x: 100, y: 100 + HOLD_MOVE_PX + 1 });
  assert.deepEqual(r.drags, [{ x: 100, y: 100 + HOLD_MOVE_PX + 1 }]);
  assert.deepEqual(r.opened, []);
  r.hold.finish(1);
  assert.deepEqual(r.opened, [], "the drag's release does not open the actions too");
});

test("a lift before 500ms is an ordinary tap; a completed hold owns its contextmenu and release click", () => {
  const tap = holdRig();
  tap.start(false);
  tap.tick(HOLD_MS - 1);
  tap.hold.finish(1);
  tap.tick(HOLD_MS);
  assert.deepEqual(tap.opened, []);
  assert.equal(tap.hold.owned(), null, "the tap's click is free to follow the link");
  assert.equal(tap.hold.echo(1), false);

  const held = holdRig();
  held.start(false);
  held.tick(HOLD_MS);
  assert.equal(held.hold.owned(), "row", "a browser long-press event during the press is swallowed");
  held.hold.move(1, { x: 200, y: 200 });
  assert.deepEqual(held.drags, [], "movement after the menu opened does not also drag");
  held.hold.finish(1);
  assert.equal(held.hold.owned(), "row", "the release click cannot follow the row's link");
  assert.equal(held.hold.echo(1), true, "nor can it activate a panel row now under the finger");
  assert.equal(held.hold.echo(2), false, "a new tap with another pointer id can use the menu");
  held.tick(HOLD_SUPPRESS_MS + 1);
  assert.equal(held.hold.owned(), null, "a later unrelated press is not suppressed");
});

test("pointercancel, scroll, blur and a hidden page abandon a press before it fires", () => {
  for (const what of ["pointercancel", "scroll", "window blur", "hidden page"]) {
    const r = holdRig();
    r.start(false);
    r.tick(HOLD_MS - 1);
    r.hold.cancel(1); // the host maps each named event to this one abandonment
    r.tick(HOLD_MS);
    assert.deepEqual(r.opened, [], what);
    assert.equal(r.hold.owned(), null, what);
  }
});

test("a place that becomes ineligible before the timer shows nothing and leaves the browser's events alone", () => {
  let at = 0;
  let due: (() => void) | null = null;
  const hold = createMenuHold({ now: () => at, schedule: (fn) => (due = fn), unschedule: () => (due = null) });
  hold.start({ key: "row", pointerId: 1, at: { x: 0, y: 0 }, show: () => false });
  at = HOLD_MS;
  due!();
  assert.equal(hold.owned(), null);
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

test("inside an open popover: Sova's pointer menu or another popover inside a row", () => {
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
    contextmenu(place: string, buttons: number) {
      fire("contextmenu", { buttons });
      release.request(pressHeld("mouse", buttons), place, () => opened.push(place));
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
});

test("a contextmenu after the release (Windows) opens at once, with no further event", () => {
  const r = releaseRig();
  r.pointerdown();
  r.pointerup();
  r.contextmenu("row A", 0);
  assert.deepEqual(r.opened, ["row A"]);
  assert.equal(r.release.waiting(), false);
  assert.equal(r.listening(), 0, "nothing left listening");
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
  w.contextmenu("row B", 0);
  w.pointerup();
  w.tick();
  assert.deepEqual(w.opened, ["row B"]);
});

test("a right-click counts the selection its press found, never the word a Mac's browser selects on that press", () => {
  let now: string[] = ["before any press"];
  const sel = createPressSelection(() => now);
  assert.deepEqual(sel.counted(), ["before any press"], "with no press yet, what is selected now");
  assert.equal(sel.madeByPress(), false);
  // Nothing selected as the button goes down; the browser then selects the word under it.
  now = [];
  sel.pressed();
  now = ["word"];
  assert.deepEqual(sel.counted(), [], "the press's own word isn't the user's selection");
  assert.equal(sel.madeByPress(), true, "so Sova's menu takes it back");
  // The user's own selection, right-clicked: it counts, and the press didn't make it.
  now = ["the user's text"];
  sel.pressed();
  assert.deepEqual(sel.counted(), ["the user's text"]);
  assert.equal(sel.madeByPress(), false);
});
