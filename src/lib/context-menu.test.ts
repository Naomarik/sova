// How every right-click or hold menu opens: where the panel goes for a pointer, which menu a
// contextmenu gets, that a held right-click's menu waits for the release, and the shared hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextMenuAction,
  createKeyMenuMark,
  createMenuHold,
  createOpenOnRelease,
  createOutsidePress,
  EDGE_GAP,
  holdOwns,
  KEY_MENU_MS,
  type PointerKind,
  pointMenuSpot,
  pressHeld,
} from "./context-menu";
import { HOLD_MOVE_PX, HOLD_MS, HOLD_SUPPRESS_MS } from "./hold-select";

test("pointMenuSpot: the corner sits on the pointer when the panel fits there, flips when it doesn't, and stays inside the window", () => {
  const views = [
    { width: 1280, height: 800 },
    { width: 300, height: 200 }, // smaller than the panel: only the clamp holds
  ];
  const boxes = [
    { width: 220, height: 300 },
    { width: 400, height: 600 },
  ];
  for (const view of views)
    for (const box of boxes)
      for (let x = 0; x <= view.width; x += 37)
        for (let y = 0; y <= view.height; y += 29) {
          const { top, left } = pointMenuSpot({ x, y }, box, view);
          const fitsW = box.width + 2 * EDGE_GAP <= view.width;
          const fitsH = box.height + 2 * EDGE_GAP <= view.height;
          // Inside the window, EDGE_GAP to spare, on each axis the panel fits.
          if (fitsW) assert.ok(left >= EDGE_GAP && left + box.width <= view.width - EDGE_GAP, `left ${left} at ${x},${y}`);
          else assert.equal(left, EDGE_GAP);
          if (fitsH) assert.ok(top >= EDGE_GAP && top + box.height <= view.height - EDGE_GAP, `top ${top} at ${x},${y}`);
          else assert.equal(top, EDGE_GAP);
          // Room below and right of the pointer: its corner is the pointer (clamped up to the gap at the very edge).
          if (y + box.height <= view.height - EDGE_GAP && y >= EDGE_GAP) assert.equal(top, y);
          if (x + box.width <= view.width - EDGE_GAP && x >= EDGE_GAP) assert.equal(left, x);
          // No room right but room left: its right edge is the pointer (the pointer itself inside the gap).
          if (x + box.width > view.width - EDGE_GAP && x - box.width >= EDGE_GAP && x <= view.width - EDGE_GAP) assert.equal(left, x - box.width);
          if (y + box.height > view.height - EDGE_GAP && y - box.height >= EDGE_GAP && y <= view.height - EDGE_GAP) assert.equal(top, y - box.height);
        }
});

test("contextMenuAction: the hold's echo is swallowed; only a mouse's right-click without Shift opens the place's menu, the rest keep the browser's", () => {
  const kinds: PointerKind[] = ["mouse", "touch", "pen", "keyboard"];
  for (const owned of [false, true])
    for (const kind of kinds)
      for (const shiftKey of [false, true]) {
        const want = owned ? "swallow" : kind === "mouse" && !shiftKey ? "open" : "native";
        assert.equal(contextMenuAction({ owned, kind, shiftKey }), want, JSON.stringify({ owned, kind, shiftKey }));
      }
});

test("createKeyMenuMark: the Menu key or Shift+F10 marks the next contextmenu as a key's, once and only for a while; (0, 0) is a key's too", () => {
  let t = 0;
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  const at = { clientX: 120, clientY: 300 };
  const cases: [ReturnType<typeof key>, boolean][] = [
    [key("ContextMenu"), true],
    [key("F10", { shiftKey: true }), true],
    [key("F10"), false],
    [key("ContextMenu", { shiftKey: true }), false],
    [key("F10", { shiftKey: true, ctrlKey: true }), false],
    [key("Enter"), false],
  ];
  for (const [k, want] of cases) {
    const mark = createKeyMenuMark(() => t);
    mark.keydown(k);
    assert.equal(mark.take(at), want, JSON.stringify(k));
    assert.equal(mark.take(at), false, "consumed: the next right-click is a mouse's");
  }
  const late = createKeyMenuMark(() => t);
  t = 0;
  late.keydown(key("ContextMenu"));
  t = KEY_MENU_MS + 1;
  assert.equal(late.take(at), false, "a mark whose event never came expires");
  assert.equal(createKeyMenuMark(() => t).take({ clientX: 0, clientY: 0 }), true);
});

test("holdOwns: a fired hold, a drag, or a finger's or pen's press still down; never a mouse press in flight", () => {
  for (const suppressed of [false, true])
    for (const dragging of [false, true])
      for (const phase of ["idle", "pressed", "lifted"])
        for (const pointerKind of ["mouse", "touch", "pen"]) {
          const want = suppressed || dragging || (phase !== "idle" && pointerKind !== "mouse");
          assert.equal(holdOwns({ suppressed, dragging, phase, pointerKind }), want);
        }
  assert.equal(pressHeld("mouse", 2), true);
  assert.equal(pressHeld("mouse", 0), false);
  assert.equal(pressHeld("keyboard", 0), false);
});

test("createOpenOnRelease: a held right-click opens one task after every button is up, and anything else on the way abandons it", () => {
  const make = () => {
    const ls = new Map<string, (e: Event) => void>();
    const tasks: (() => void)[] = [];
    const target = { addEventListener: (t: string, fn: (e: Event) => void) => ls.set(t, fn), removeEventListener: (t: string) => ls.delete(t) };
    const opener = createOpenOnRelease({
      win: target,
      doc: { ...target, visibilityState: "visible" },
      later: (fn) => {
        tasks.push(fn);
        return () => tasks.splice(tasks.indexOf(fn), 1);
      },
    });
    const fire = (type: string, e: object = {}) => ls.get(type)?.(e as Event);
    return { opener, fire, ls, run: () => tasks.splice(0).forEach((f) => f()) };
  };
  // Not held: at once, listening to nothing.
  {
    const t = make();
    let opened = 0;
    t.opener.request(false, () => opened++);
    assert.equal(opened, 1);
    assert.equal(t.ls.size, 0);
  }
  // Held: a pointerup with a button still down waits; buttons 0 opens on the later task, then stops listening.
  {
    const t = make();
    let opened = 0;
    t.opener.request(true, () => opened++);
    t.fire("pointerup", { buttons: 1 });
    t.run();
    assert.equal(opened, 0);
    t.fire("pointerup", { buttons: 0 });
    assert.equal(opened, 0, "not on the release's own task");
    t.run();
    assert.equal(opened, 1);
    assert.equal(t.ls.size, 0);
  }
  // Each way of giving up opens nothing, even with the release's task already queued.
  for (const [type, e] of [["pointercancel", {}], ["blur", {}], ["contextmenu", {}], ["keydown", { key: "Escape" }]] as const) {
    const t = make();
    let opened = 0;
    t.opener.request(true, () => opened++);
    t.fire("pointerup", { buttons: 0 });
    t.fire(type, e);
    t.run();
    assert.equal(opened, 0, type);
    assert.equal(t.opener.waiting(), false);
  }
  // A newer request replaces the waiting one.
  {
    const t = make();
    const seen: string[] = [];
    t.opener.request(true, () => seen.push("a"));
    t.opener.request(true, () => seen.push("b"));
    t.fire("pointerup", { buttons: 0 });
    t.run();
    assert.deepEqual(seen, ["b"]);
  }
});

test("createMenuHold: a finger's or pen's press kept still past HOLD_MS and let go where it fired opens at the release point; nothing else does", () => {
  const make = () => {
    let t = 0;
    let timer: { fn: () => void; at: number } | null = null;
    const opened: { at: { x: number; y: number }; kind: string }[] = [];
    let buzzed = 0;
    const hold = createMenuHold({
      now: () => t,
      schedule: (fn, ms) => (timer = { fn, at: t + ms }),
      unschedule: () => (timer = null),
      onHold: () => buzzed++,
      onHeld: (at, kind) => opened.push({ at, kind }),
    });
    const advance = (ms: number) => {
      t += ms;
      if (timer && t >= timer.at) {
        const { fn } = timer;
        timer = null;
        fn();
      }
    };
    const p = (x: number, y: number, pointerType = "touch", pointerId = 1) => ({ pointerId, pointerType, clientX: x, clientY: y });
    return { hold, advance, opened, p, buzzed: () => buzzed };
  };
  // Held, let go in place: opens there, with its kind; the press owned its contextmenu throughout, and its click is the echo.
  for (const kind of ["touch", "pen"]) {
    const h = make();
    h.hold.down(h.p(100, 100, kind));
    assert.equal(h.hold.owns(), true, "a finger's press down owns Android's long-press contextmenu");
    h.advance(HOLD_MS);
    assert.equal(h.buzzed(), 1);
    h.hold.move(h.p(100 + HOLD_MOVE_PX, 100, kind));
    h.hold.up(h.p(103, 104, kind));
    assert.deepEqual(h.opened, [{ at: { x: 103, y: 104 }, kind }]);
    assert.equal(h.hold.suppressed(), true);
    assert.equal(h.hold.owns(), true);
    h.advance(HOLD_SUPPRESS_MS + 1);
    assert.equal(h.hold.suppressed(), false);
    assert.equal(h.hold.owns(), false);
  }
  // Each way a press is not a hold let go in place opens nothing.
  const cases: [string, (h: ReturnType<typeof make>) => void][] = [
    ["let go early", (h) => (h.advance(HOLD_MS - 1), h.hold.up(h.p(100, 100)))],
    ["moved before the hold (a scroll)", (h) => (h.hold.move(h.p(100, 100 + HOLD_MOVE_PX + 1)), h.advance(HOLD_MS), h.hold.up(h.p(100, 100)))],
    ["moved away after the hold, then back", (h) => (h.advance(HOLD_MS), h.hold.move(h.p(140, 100)), h.hold.move(h.p(100, 100)), h.hold.up(h.p(100, 100)))],
    ["let go away from where it fired", (h) => (h.advance(HOLD_MS), h.hold.up(h.p(100 + HOLD_MOVE_PX + 1, 100)))],
    ["cancelled after the hold", (h) => (h.advance(HOLD_MS), h.hold.cancel(), h.hold.up(h.p(100, 100)))],
    ["another pointer's release", (h) => (h.advance(HOLD_MS), h.hold.up(h.p(100, 100, "touch", 2)))],
  ];
  for (const [name, run] of cases) {
    const h = make();
    h.hold.down(h.p(100, 100));
    run(h);
    assert.deepEqual(h.opened, [], name);
  }
  // A mouse is never a hold: its right-click is the menu's door.
  const m = make();
  m.hold.down(m.p(100, 100, "mouse"));
  assert.equal(m.hold.owns(), false);
  m.advance(HOLD_MS);
  m.hold.up(m.p(100, 100, "mouse"));
  assert.deepEqual(m.opened, []);
  assert.equal(m.buzzed(), 0);
});

test("createOutsidePress: a press that starts outside the open menu closes it at once; only a plain tap or click is spent on it", () => {
  const make = () => {
    let t = 0;
    const rule = createOutsidePress({ now: () => t });
    return { rule, advance: (ms: number) => (t += ms) };
  };
  const out = (kind = "touch", button = 0) => ({ open: true, inside: false, kind, button });
  // Inside the menu, or with the menu closed: nothing closes, nothing is spent.
  for (const p of [{ ...out(), inside: true }, { ...out(), open: false }, { ...out("mouse"), inside: true }]) {
    const { rule } = make();
    assert.equal(rule.down(p), "none");
    rule.up();
    assert.equal(rule.mouseDown(), false);
    assert.equal(rule.takeClick(), false);
  }
  // A tap or click outside: closed at the press; a finger's or pen's mousedown is stopped, a mouse's
  // is not; the click that follows is taken once, the next one passes.
  for (const kind of ["touch", "pen", "mouse"]) {
    const { rule, advance } = make();
    assert.equal(rule.down(out(kind)), "close", kind);
    rule.up();
    assert.equal(rule.mouseDown(), kind !== "mouse", kind);
    advance(50);
    assert.equal(rule.takeClick(), true, kind);
    assert.equal(rule.takeClick(), false, `${kind}: once`);
    assert.equal(rule.mouseDown(), false, `${kind}: spent`);
  }
  // A scroll (pointercancel): closed at the press, and nothing of it is spent afterwards.
  {
    const { rule } = make();
    assert.equal(rule.down(out()), "close");
    rule.cancel();
    rule.up();
    assert.equal(rule.mouseDown(), false);
    assert.equal(rule.takeClick(), false);
  }
  // No click before the release: a click arriving while the press is still down is not the tap's.
  {
    const { rule } = make();
    rule.down(out("mouse"));
    assert.equal(rule.takeClick(), false);
  }
  // A long hold outside closes at the press; its echo within HOLD_SUPPRESS_MS of the release is taken,
  // however long it was held; a click later than that passes.
  {
    const { rule, advance } = make();
    rule.down(out());
    advance(3000);
    rule.up();
    advance(HOLD_SUPPRESS_MS);
    assert.equal(rule.takeClick(), true);
  }
  {
    const { rule, advance } = make();
    rule.down(out());
    rule.up();
    advance(HOLD_SUPPRESS_MS + 1);
    assert.equal(rule.takeClick(), false);
  }
  // A second press disarms the first: with the menu now closed, its tap works normally.
  {
    const { rule } = make();
    rule.down(out());
    rule.up();
    assert.equal(rule.down({ ...out(), open: false }), "none");
    rule.up();
    assert.equal(rule.mouseDown(), false);
    assert.equal(rule.takeClick(), false);
  }
  // A right or middle press outside closes without arming: its own contextmenu or auxclick goes on,
  // and the click after it is not spent.
  for (const button of [1, 2]) {
    const { rule } = make();
    assert.equal(rule.down(out("mouse", button)), "close");
    rule.up();
    assert.equal(rule.mouseDown(), false);
    assert.equal(rule.takeClick(), false);
  }
});
