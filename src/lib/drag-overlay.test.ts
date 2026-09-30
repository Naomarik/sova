// Run: npx tsx --test src/lib/drag-overlay.test.ts
// The row's press (lift, select on release, drag) and what the drop overlay offers and hits.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionGroup } from "../../shared/protocol";
import {
  ARCHIVE_TILE,
  autoScrollStep,
  CANCEL_TILE,
  createRowPress,
  type DragInfo,
  dropAction,
  dropHint,
  DROP_LIST_FIT,
  dropListLayout,
  dropTiles,
  GHOST_LIFT_PX,
  ghostPlacement,
  ghostTarget,
  groupCountLabel,
  hitTile,
  NEW_TILE,
  openAnnouncement,
  ORG_GROUP_REASON,
  type Point,
  REMOVE_TILE,
} from "./drag-overlay";
import { HOLD_MS, HOLD_SUPPRESS_MS } from "./hold-select";

/** A press on a fake clock: `advance` runs the hold timer when its time comes. */
function rig(opts: { drag?: boolean; pointer?: string } = {}) {
  let t = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const log: string[] = [];
  const drags: Point[] = [];
  const press = createRowPress({
    onLift: () => log.push("lift"),
    onDrag: (at) => {
      log.push("drag");
      drags.push(at);
    },
    now: () => t,
    schedule: (fn, ms) => (pending = { fn, at: t + ms }),
    unschedule: () => (pending = null),
  });
  const advance = (ms: number) => {
    t += ms;
    if (pending && pending.at <= t) {
      const p = pending;
      pending = null;
      p.fn();
    }
  };
  const down = (at: Point = { x: 100, y: 100 }) => press.start(at, opts.pointer ?? "touch", opts.drag ?? true);
  return { press, log, drags, advance, down };
}

test("a thumb held still lifts the row, and the release in place selects", () => {
  const r = rig();
  r.down();
  r.advance(HOLD_MS - 1);
  assert.equal(r.press.phase(), "pressed");
  r.advance(1);
  assert.deepEqual(r.log, ["lift"]);
  assert.equal(r.press.phase(), "lifted");
  r.press.move({ x: 104, y: 97 }); // a thumb is never perfectly still
  assert.equal(r.press.finish(), true, "the release is the selection");
  assert.equal(r.press.phase(), "idle");
  // The lift's echo (the click, the contextmenu) is swallowed for a while after the release.
  assert.equal(r.press.suppressed(), true);
  r.advance(HOLD_SUPPRESS_MS + 1);
  assert.equal(r.press.suppressed(), false);
});

test("a lifted row that moves past 10px becomes a drag, and its release selects nothing", () => {
  const r = rig();
  r.down();
  r.advance(HOLD_MS);
  r.press.move({ x: 100, y: 111 });
  assert.deepEqual(r.log, ["lift", "drag"]);
  assert.deepEqual(r.drags, [{ x: 100, y: 111 }]);
  assert.equal(r.press.phase(), "idle", "the drag is handed over; the press is done");
  assert.equal(r.press.finish(), false);
  assert.equal(r.press.suppressed(), true, "the drag's click never reaches the row");
});

test("a thumb that moves before the lift is a scroll: no lift, no drag, no selection", () => {
  const r = rig();
  r.down();
  r.advance(200);
  r.press.move({ x: 100, y: 130 });
  r.advance(HOLD_MS);
  assert.deepEqual(r.log, []);
  assert.equal(r.press.finish(), false);
  assert.equal(r.press.suppressed(), false, "a tap after it is an ordinary tap");
});

test("a mouse drags after 6px with no hold; 6px itself is still a press", () => {
  const r = rig({ pointer: "mouse" });
  r.down();
  r.press.move({ x: 106, y: 100 });
  assert.deepEqual(r.log, []);
  r.press.move({ x: 107, y: 100 });
  assert.deepEqual(r.log, ["drag"]);
  r.advance(HOLD_MS);
  assert.deepEqual(r.log, ["drag"], "the hold timer is gone with the press");
});

test("a still mouse held 500ms lifts and selects on release, as a thumb does", () => {
  const r = rig({ pointer: "mouse" });
  r.down();
  r.advance(HOLD_MS);
  assert.deepEqual(r.log, ["lift"]);
  assert.equal(r.press.finish(), true);
});

test("a tap is a tap: no lift, no selection, nothing suppressed", () => {
  const r = rig();
  r.down();
  r.advance(120);
  assert.equal(r.press.finish(), false);
  assert.equal(r.press.suppressed(), false);
  assert.deepEqual(r.log, []);
});

test("a cancel after the lift selects nothing and still swallows the lift's echo", () => {
  const r = rig();
  r.down();
  r.advance(HOLD_MS);
  r.press.cancel();
  assert.equal(r.press.phase(), "idle");
  assert.equal(r.press.finish(), false, "a finish after the cancel is not a release in place");
  assert.equal(r.press.suppressed(), true);
});

test("in selection mode nothing drags: a mouse move past the tolerance just ends the press", () => {
  const r = rig({ pointer: "mouse", drag: false });
  r.down();
  r.press.move({ x: 120, y: 100 });
  assert.deepEqual(r.log, []);
  assert.equal(r.press.phase(), "idle");
  const t = rig({ drag: false });
  t.down();
  t.advance(HOLD_MS);
  t.press.move({ x: 100, y: 140 });
  assert.deepEqual(t.log, ["lift"], "a lifted row in selection mode doesn't drag either");
  assert.equal(t.press.finish(), false);
});

// ---------------------------------------------------------------------------

const G = (id: string, name: string): SessionGroup => ({ id, name }) as SessionGroup;
const GROUPS = [G("g1", "Work"), G("g2", "Home"), G("g3", "Later")];
const COUNTS = new Map([
  ["g1", 4],
  ["g2", 1],
]);
const info = (over: Partial<DragInfo> = {}): DragInfo => ({
  path: "/s/1.jsonl",
  title: "Fix the build",
  groupId: null,
  org: false,
  orgProject: null,
  peer: null,
  archive: { kind: "archive" },
  archived: false,
  ...over,
});

test("an ungrouped row: every group takes it, no Remove tile, Archive open", () => {
  const t = dropTiles(info(), GROUPS, COUNTS);
  assert.equal(t.groupNote, null);
  assert.equal(t.newDisabled, null);
  assert.equal(t.remove, null);
  assert.deepEqual(
    t.groups.map((g) => [g.id, g.count, g.current, g.disabled]),
    [
      ["g1", 4, false, null],
      ["g2", 1, false, null],
      ["g3", 0, false, null],
    ],
  );
  assert.equal(t.archiveDisabled, null);
  assert.deepEqual(dropAction("g2", t), { kind: "group", groupId: "g2" });
  assert.deepEqual(dropAction(NEW_TILE, t), { kind: "new" });
  assert.deepEqual(dropAction(ARCHIVE_TILE, t), { kind: "archive" });
  assert.deepEqual(dropAction(REMOVE_TILE, t), { kind: "none" }, "no Remove tile, nothing to remove");
});

test("a grouped row: its group is Current and inert, and Remove names the group", () => {
  const t = dropTiles(info({ groupId: "g1" }), GROUPS, COUNTS);
  assert.deepEqual(t.remove, { name: "Work" });
  assert.equal(t.groups.find((g) => g.id === "g1")!.current, true);
  assert.deepEqual(dropAction("g1", t), { kind: "none" }, "a drop on the group it is in does nothing");
  assert.deepEqual(dropAction(REMOVE_TILE, t), { kind: "group", groupId: null });
  assert.deepEqual(dropAction("g2", t), { kind: "group", groupId: "g2" });
  assert.equal(dropHint("g2", info({ groupId: "g1" })), "Drop to move here");
  assert.equal(dropHint("g2", info()), "Drop to add here");
});

test("an organization session: groups and New group refused once, in words; out of a group still works", () => {
  const t = dropTiles(info({ org: true, groupId: "g2" }), GROUPS, COUNTS);
  assert.equal(t.groupNote, ORG_GROUP_REASON);
  assert.deepEqual(dropAction(NEW_TILE, t), { kind: "refused", reason: ORG_GROUP_REASON });
  assert.deepEqual(dropAction("g1", t), { kind: "refused", reason: ORG_GROUP_REASON });
  assert.deepEqual(dropAction(REMOVE_TILE, t), { kind: "group", groupId: null });
  assert.deepEqual(dropAction(ARCHIVE_TILE, t), { kind: "archive" }, "archive goes to its project's Done list");
});

test("a peer's session: no group of this host, no Current, no Remove — its group id is the peer's", () => {
  const t = dropTiles(info({ peer: "desk", groupId: "g1" }), GROUPS, COUNTS);
  assert.equal(t.groupNote, "Groups hold this host's sessions only. That one lives on desk.");
  assert.equal(t.remove, null);
  assert.ok(t.groups.every((g) => !g.current && g.disabled === t.groupNote));
  assert.equal(dropAction("g1", t).kind, "refused");
});

test("Archive refused says why; a refused drop only says it", () => {
  const blocked = dropTiles(info({ archive: { kind: "blocked", reason: "open in a TUI" } }), GROUPS, COUNTS);
  assert.deepEqual(dropAction(ARCHIVE_TILE, blocked), { kind: "refused", reason: "Can't archive: open in a TUI" });
  const archived = dropTiles(info({ archive: { kind: "none" }, archived: true }), GROUPS, COUNTS);
  assert.equal(archived.archiveDisabled, "Already archived.");
});

test("Cancel, empty space and an unknown tile do nothing", () => {
  const t = dropTiles(info(), GROUPS, COUNTS);
  for (const tile of [CANCEL_TILE, null, "gone"]) assert.deepEqual(dropAction(tile, t), { kind: "none" });
});

test("group tile counts read as words", () => {
  assert.equal(groupCountLabel(0), "Empty");
  assert.equal(groupCountLabel(1), "1 session");
  assert.equal(groupCountLabel(7), "7 sessions");
});

test("hitTile: the tile under the point, and never where the grid hides it", () => {
  const grid = { left: 0, top: 100, right: 400, bottom: 600 };
  const tiles = [
    { id: "g1", rect: { left: 16, top: 60, right: 190, bottom: 140 }, clip: grid }, // half under the head
    { id: "g2", rect: { left: 200, top: 150, right: 380, bottom: 230 }, clip: grid },
    { id: ARCHIVE_TILE, rect: { left: 16, top: 620, right: 150, bottom: 690 } },
  ];
  assert.equal(hitTile(tiles, { x: 50, y: 80 }), null, "the hidden half isn't a target");
  assert.equal(hitTile(tiles, { x: 50, y: 120 }), "g1");
  assert.equal(hitTile(tiles, { x: 300, y: 200 }), "g2");
  assert.equal(hitTile(tiles, { x: 100, y: 650 }), ARCHIVE_TILE);
  assert.equal(hitTile(tiles, { x: 195, y: 200 }), null, "the gap between tiles is empty space");
});

test("autoScrollStep: up near the top, down near the bottom, faster at the edge, still in the middle", () => {
  const box = { top: 100, bottom: 600 };
  assert.equal(autoScrollStep(350, box), 0);
  assert.ok(autoScrollStep(110, box) < 0);
  assert.ok(autoScrollStep(590, box) > 0);
  assert.ok(Math.abs(autoScrollStep(101, box)) > Math.abs(autoScrollStep(150, box)));
  assert.equal(autoScrollStep(100 + 56, box), 0, "the edge band ends at 56px");
  assert.equal(autoScrollStep(60, box), -18, "over the head, at full speed");
  assert.equal(autoScrollStep(900, box), 0, "far outside the grid does nothing");
});

test("opening says what the gesture is", () => {
  assert.equal(openAnnouncement("Fix the build"), "Moving “Fix the build”. Drop it on a group, Archive, New group, or Cancel.");
});

test("ghostTarget: the card says where a drop would put the row, and when it wouldn't", () => {
  const loose = dropTiles(info(), GROUPS, COUNTS);
  assert.deepEqual(ghostTarget("g2", loose, info()), { text: "Add to “Home”", refused: false });
  assert.deepEqual(ghostTarget(null, loose, info()), { text: "Let go to cancel", refused: false });
  assert.deepEqual(ghostTarget(CANCEL_TILE, loose, info()), { text: "Cancel", refused: false });
  assert.deepEqual(ghostTarget(NEW_TILE, loose, info()), { text: "Into a new group", refused: false });
  assert.deepEqual(ghostTarget(ARCHIVE_TILE, loose, info()), { text: "Archive", refused: false });
  const grouped = info({ groupId: "g1" });
  const t = dropTiles(grouped, GROUPS, COUNTS);
  assert.deepEqual(ghostTarget("g2", t, grouped), { text: "Move to “Home”", refused: false });
  assert.deepEqual(ghostTarget("g1", t, grouped), { text: "Already in “Work”", refused: true });
  assert.deepEqual(ghostTarget(REMOVE_TILE, t, grouped), { text: "Remove from “Work”", refused: false });
  const org = info({ org: true });
  const o = dropTiles(org, GROUPS, COUNTS);
  assert.deepEqual(ghostTarget("g2", o, org), { text: "Can't drop here", refused: true });
  assert.deepEqual(ghostTarget(NEW_TILE, o, org), { text: "Can't drop here", refused: true });
  const done = info({ archived: true, archive: { kind: "none" } });
  assert.deepEqual(ghostTarget(ARCHIVE_TILE, dropTiles(done, GROUPS, COUNTS), done), { text: "Can't archive", refused: true });
});

test("dropListLayout: one column of session-sized rows, then 2 and 3 columns, then shrink, then scroll", () => {
  // The room a 1440×900 window and a 390×844 phone leave the list, head and bar taken out.
  const desk = { width: 1392, height: 720 };
  const phone = { width: 358, height: 640 };
  const pick = (n: number, box: { width: number; height: number }) => {
    const l = dropListLayout(n, box);
    return [l.columns, l.rowHeight, l.scroll];
  };
  // 720 holds 12 rows of 52 (+4 gap): 12 per column at rest.
  assert.deepEqual(pick(1, desk), [1, 52, false], "no groups: one row, New group");
  assert.deepEqual(pick(4, desk), [1, 52, false], "3 groups: a short single column");
  assert.deepEqual(pick(10, desk), [1, 52, false], "8 groups still one column");
  assert.deepEqual(pick(13, desk), [2, 52, false], "past a column's height: a 2nd column");
  assert.deepEqual(pick(22, desk), [2, 52, false], "20 groups: 2 columns");
  assert.deepEqual(pick(36, desk), [3, 52, false], "3 full columns at rest");
  const forty = dropListLayout(42, desk);
  assert.deepEqual([forty.columns, forty.rows, forty.scroll], [3, 14, false], "40 groups: 3 columns, rows shrunk");
  assert.ok(forty.rowHeight < 52 && forty.rowHeight >= 44, `shrunk to ${forty.rowHeight}`);
  assert.ok(forty.height <= desk.height, "and it fits");
  const many = dropListLayout(120, desk);
  assert.deepEqual([many.columns, many.rowHeight, many.scroll], [3, 44, true], "never below 44px: it scrolls instead");
  // A column is the sessions pane's width, and the list is its own size, not the box's.
  assert.equal(dropListLayout(4, desk).columnWidth, DROP_LIST_FIT.columnWidth);
  assert.equal(dropListLayout(4, desk).width, 320);
  assert.equal(dropListLayout(4, desk).height, 4 * 52 + 3 * 4);
  assert.equal(dropListLayout(22, desk).width, 2 * 320 + 4);
  assert.equal(dropListLayout(22, desk).rows, 11, "column-major: the first column fills before the next");
  // A phone is one column wide: it shrinks to the floor, then scrolls.
  assert.deepEqual(pick(4, phone), [1, 52, false]);
  assert.equal(dropListLayout(4, phone).columnWidth, 320);
  assert.deepEqual(pick(13, phone), [1, 45, false], "13 rows shrink to fit 640px");
  assert.deepEqual(pick(22, phone), [1, 44, true], "20 groups on a phone scroll");
  // A phone on its side has room for columns again; a narrow box gives a column the box's width.
  assert.equal(dropListLayout(22, { width: 812, height: 250 }).columns, 3);
  assert.equal(dropListLayout(3, { width: 280, height: 600 }).columnWidth, 280);
  assert.deepEqual(pick(0, desk), [1, 52, false]);
  assert.deepEqual(pick(9, { width: 0, height: 0 }), [1, 52, false], "not measured yet");
  // Whatever it picks: never more than 3 columns, never under 44px, and it scrolls only when it must.
  for (const box of [desk, phone, { width: 900, height: 500 }]) {
    for (let n = 1; n <= 80; n++) {
      const l = dropListLayout(n, box);
      assert.ok(l.columns <= 3 && l.rowHeight >= 44 && l.columns * l.rows >= n, `n=${n}`);
      assert.equal(l.scroll, l.height > box.height, `n=${n} scroll`);
    }
  }
});

test("ghostPlacement: above a finger, trailing a mouse, always inside the window", () => {
  const size = { width: 300, height: 100 };
  const view = { width: 390, height: 844 };
  assert.deepEqual(ghostPlacement({ x: 195, y: 500 }, size, view, true), { x: 45, y: 500 - GHOST_LIFT_PX - 100 }, "centred above the finger");
  assert.deepEqual(ghostPlacement({ x: 195, y: 60 }, size, view, true), { x: 45, y: 60 + GHOST_LIFT_PX }, "no room above: below it");
  assert.deepEqual(ghostPlacement({ x: 20, y: 500 }, size, view, true).x, 8, "held inside the left edge");
  const wide = { width: 1440, height: 900 };
  assert.deepEqual(ghostPlacement({ x: 400, y: 300 }, size, wide, false), { x: 416, y: 320 }, "below and right of the tip");
  assert.deepEqual(ghostPlacement({ x: 1300, y: 850 }, size, wide, false), { x: 984, y: 730 }, "flipped left and up at the edges");
});
