// Run: npx tsx --test src/lib/group-picker.test.ts
// The group picker's tiles: every group, in order, a link when it holds a session, else its reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionGroup } from "../../shared/protocol";
import { EMPTY_GROUP_REASON, firstFocusTile, pickerTiles } from "./group-picker";

const group = (id: string, name: string): SessionGroup => ({ id, name, createdAt: "2026-10-01T00:00:00Z" });
const groups = [group("g1", "Work"), group("g/2", "Home"), group("g3", "Solo")];

test("a tile per group, in the order the groups come, with the drop overlay's counts", () => {
  const tiles = pickerTiles(groups, new Map([["g1", 4], ["g3", 1]]));
  assert.deepEqual(tiles.map((t) => t.id), ["g1", "g/2", "g3"]);
  assert.deepEqual(tiles.map((t) => t.count), [4, 0, 1]);
  assert.deepEqual(tiles.map((t) => t.line), ["4 sessions", EMPTY_GROUP_REASON, "1 session"]);
});

test("a populated group links to its workspace; an empty one is disabled with its reason and no link", () => {
  const [work, home] = pickerTiles(groups, new Map([["g1", 2]]));
  assert.equal(work!.href, "#/g/g1");
  assert.equal(work!.disabled, null);
  assert.equal(home!.href, null);
  assert.equal(home!.disabled, "Nothing is in it yet. Drag a session into it first.");
});

test("the link percent-encodes the group id, as the route reads it", () => {
  const [, home] = pickerTiles(groups, new Map([["g/2", 1]]));
  assert.equal(home!.href, "#/g/g%2F2");
});

test("focus opens on the first group that opens, else the first tile, else nothing", () => {
  assert.equal(firstFocusTile(pickerTiles(groups, new Map([["g3", 1]]))), 2);
  assert.equal(firstFocusTile(pickerTiles(groups, new Map())), 0);
  assert.equal(firstFocusTile([]), -1);
});
