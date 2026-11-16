// A sidebar session row's own menu: what it offers a session, where the panel goes for a pointer,
// which menu a contextmenu gets, and that a held right-click's menu waits for the release.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import type { ArchiveDrag } from "./drag-archive";
import {
  createOpenOnRelease,
  EDGE_GAP,
  groupChoices,
  holdOwns,
  type PointerKind,
  pointMenuSpot,
  pressHeld,
  rowContextAction,
  rowMenuOf,
} from "./session-context-menu";

const row = (over: Partial<SessionSummary> = {}) => ({ title: "Fix the build", archived: false, ...over }) as SessionSummary;
const ARCHIVES: ArchiveDrag = { kind: "archive" };
const NO_NOTE = { groupNote: null, remove: null };

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

test("rowContextAction: the hold's echo is swallowed, Shift and a finger's long press keep the browser's menu, the rest open the row's", () => {
  const kinds: PointerKind[] = ["mouse", "touch", "pen", "keyboard"];
  for (const owned of [false, true])
    for (const kind of kinds)
      for (const shiftKey of [false, true]) {
        const want = owned ? "swallow" : kind === "touch" || kind === "pen" ? "native" : shiftKey && kind === "mouse" ? "native" : "open";
        assert.equal(rowContextAction({ owned, kind, shiftKey }), want, JSON.stringify({ owned, kind, shiftKey }));
      }
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

test("rowMenuOf: a self-named chat has no title rows; Gist and Reset say why they can't run", () => {
  assert.equal(rowMenuOf(row({ fixedName: "overseer" as SessionSummary["fixedName"] }), ARCHIVES, NO_NOTE).title, null);
  const plain = rowMenuOf(row(), ARCHIVES, NO_NOTE).title!;
  assert.equal(plain.gistDisabled, "No gist yet.");
  assert.equal(plain.resetDisabled, "Not renamed.");
  const renamed = rowMenuOf(row({ originalTitle: "first words", outlineGist: "Ship the menu" }), ARCHIVES, NO_NOTE).title!;
  assert.deepEqual([renamed.gist, renamed.gistDisabled, renamed.original, renamed.resetDisabled], ["Ship the menu", "", "first words", ""]);
  const same = rowMenuOf(row({ title: "Ship the menu", outlineGist: "Ship the menu" }), ARCHIVES, NO_NOTE).title!;
  assert.equal(same.gistDisabled, "The gist is already the title.");
});

test("rowMenuOf: Archive and Move to Group refuse exactly what the drop panel refuses, in its words", () => {
  assert.deepEqual(rowMenuOf(row(), ARCHIVES, NO_NOTE).archive, { label: "Archive", act: "archive", disabled: "" });
  assert.deepEqual(rowMenuOf(row({ archived: true }), { kind: "none" }, NO_NOTE).archive, { label: "Unarchive", act: "unarchive", disabled: "" });
  assert.deepEqual(rowMenuOf(row(), { kind: "blocked", reason: "its turn is running" }, NO_NOTE).archive, { label: "Archive", act: null, disabled: "Can't archive: its turn is running" });
  assert.equal(rowMenuOf(row(), { kind: "none" }, NO_NOTE).archive.disabled, "Already in the Archive.");
  const note = "Groups hold this host's sessions only. That one lives on box.";
  assert.equal(rowMenuOf(row(), ARCHIVES, { groupNote: note, remove: null }).moveDisabled, note);
  assert.equal(rowMenuOf(row(), ARCHIVES, { groupNote: note, remove: { name: "Work" } }).moveDisabled, "", "taking it out still works");
  assert.deepEqual(
    groupChoices({ remove: { name: "Work" }, groups: [{ id: "g1", name: "Work", count: 2, current: true, disabled: null }, { id: "g2", name: "Play", count: 0, current: false, disabled: note }] }),
    [
      { id: null, name: "No group", current: false, disabled: "" },
      { id: "g1", name: "Work", current: true, disabled: "" },
      { id: "g2", name: "Play", current: false, disabled: note },
    ],
  );
});
