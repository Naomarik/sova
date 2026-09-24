// Run: npx tsx --test src/lib/drag-archive.test.ts
// Dragging a row out of the sidebar: what the drag may do, what shows while the pointer is
// outside, and when the pointer has left the window altogether.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveDragOf, archivedDropToast, blockedDropSentence, leftWindow, outsideDropEffect, outsideLabel, outsideTarget } from "./drag-archive";
import type { SelectableSession } from "./session-selection";

const row = (over: Partial<SelectableSession> = {}): SelectableSession => ({
  path: "/s/1.jsonl",
  id: "id-1",
  title: "Fix the build",
  archived: false,
  origin: "web",
  busy: false,
  live: null,
  ...over,
});

test("an eligible row archives outside the sidebar, and nothing happens inside it", () => {
  const drag = archiveDragOf(row());
  assert.deepEqual(drag, { kind: "archive" });
  assert.equal(outsideTarget(drag, false), "archive");
  assert.equal(outsideTarget(drag, true), null);
  assert.equal(outsideDropEffect(outsideTarget(drag, false)), "move");
  assert.equal(outsideLabel(outsideTarget(drag, false), drag, "Fix the build"), "Archive “Fix the build”");
  assert.equal(outsideLabel(outsideTarget(drag, true), drag, "Fix the build"), null);
  assert.equal(blockedDropSentence(drag), null);
});

test("a row already in the Archive region dragged outside is no target: no state, no cursor, no words", () => {
  // Archived, even one that would be blocked if it weren't: it's already where the gesture goes.
  const already: Partial<SelectableSession>[] = [{ archived: true }, { archived: true, origin: "external" }, { archived: true, busy: true }];
  // Archived and open in a TUI: on top while live, but archiving it again means nothing.
  already.push({ archived: true, live: { pid: 7, status: "idle" } });
  // External and not live: the Archive region lists it without an archived flag.
  already.push({ origin: "external" }, { origin: "external", busy: true });
  for (const over of already) {
    const drag = archiveDragOf(row(over));
    assert.deepEqual(drag, { kind: "none" });
    assert.equal(outsideTarget(drag, false), null);
    assert.equal(outsideDropEffect(outsideTarget(drag, false)), "none");
    assert.equal(outsideLabel(outsideTarget(drag, false), drag, "x"), null);
    assert.equal(blockedDropSentence(drag), null);
  }
});

test("a blocked row shows archiveBlockReason's own words, refuses the drop, and never reads as archive", () => {
  const cases: [Partial<SelectableSession>, string][] = [
    [{ live: { pid: 7, status: "idle" } }, "open in a TUI"],
    // Live wins: an external session open in a TUI is on top, and blocked for the TUI.
    [{ origin: "external", live: { pid: 7, status: "idle" } }, "open in a TUI"],
    [{ busy: true }, "mid-turn"],
    [{ workers: { working: 2, total: 2 } }, "with subagents working"],
  ];
  for (const [over, reason] of cases) {
    const drag = archiveDragOf(row(over));
    assert.deepEqual(drag, { kind: "blocked", reason });
    const t = outsideTarget(drag, false);
    assert.equal(t, "archive-blocked");
    assert.equal(outsideDropEffect(t), "none");
    assert.equal(outsideLabel(t, drag, "Fix the build"), `Can't archive: ${reason}`);
    assert.equal(blockedDropSentence(drag), `Can't archive this session: ${reason}.`);
    assert.equal(outsideTarget(drag, true), null);
  }
});

test("leftWindow: only a leave with no next element, at or past the viewport's edge", () => {
  const view = { width: 1000, height: 800 };
  const el = {};
  // Crossing between elements names the next one: never "left the window", wherever the point is.
  assert.equal(leftWindow({ relatedTarget: el, clientX: 0, clientY: 400 }, view), false);
  // No next element, but mid-window (a browser that leaves relatedTarget null between elements).
  assert.equal(leftWindow({ relatedTarget: null, clientX: 500, clientY: 400 }, view), false);
  for (const [x, y] of [[0, 400], [500, 0], [1000, 400], [500, 800], [-5, 400], [1200, 900]] as const) {
    assert.equal(leftWindow({ relatedTarget: null, clientX: x, clientY: y }, view), true, `${x},${y}`);
  }
});

test("a drop that archived offers Undo; one that deleted a never-sent session does not", () => {
  assert.deepEqual(archivedDropToast(false), { text: "Archived. Find it under Archive.", undo: true });
  const gone = archivedDropToast(true);
  assert.equal(gone.undo, false);
  // It must not claim the session is in the Archive: the server deleted the file.
  assert.doesNotMatch(gone.text, /Archive\./);
});
