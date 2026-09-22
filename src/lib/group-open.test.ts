// Run: npx tsx --test src/lib/group-open.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOpen, groupsRegionOpen } from "./group-open";

const region = (o: Partial<Parameters<typeof groupsRegionOpen>[0]> = {}) =>
  groupsRegionOpen({ searching: false, draggingGrouped: false, ...o });

test("a group section is collapsed until the user opens it on this page", () => {
  assert.equal(groupOpen(undefined), false); // fresh load, and every load after
  assert.equal(groupOpen(true), true);
  assert.equal(groupOpen(false), false);
});

test("the Groups region starts collapsed and follows the user's choice after that", () => {
  assert.equal(region(), false);
  assert.equal(region({ chosen: true }), true);
  assert.equal(region({ chosen: false }), false);
});

test("a search and a grouped drag force the region open without changing the choice", () => {
  assert.equal(region({ searching: true }), true);
  assert.equal(region({ draggingGrouped: true }), true);
  // Forced open over an explicit "closed": the hits and the drop targets have to be reachable…
  assert.equal(region({ chosen: false, searching: true }), true);
  assert.equal(region({ chosen: false, draggingGrouped: true }), true);
  // …and when the force lifts, the choice the user made is still the one that answers.
  assert.equal(region({ chosen: false }), false);
});

test("nothing outside this page can open either one: the inputs are the whole rule", () => {
  // A reload is the no-input call, for the region and for every group in it. If a stored choice
  // ever came back, one of these would be the test that turns red.
  assert.equal(region(), false);
  assert.equal(groupOpen(undefined), false);
});
