// Run: npx tsx --test src/lib/group-open.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOpen, groupsRegionOpen } from "./group-open";

const region = (o: Partial<Parameters<typeof groupsRegionOpen>[0]> = {}) =>
  groupsRegionOpen({ searching: false, ...o });

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

test("a search forces the region open without changing the choice", () => {
  assert.equal(region({ searching: true }), true);
  // Forced open over an explicit "closed": the hits have to be reachable…
  assert.equal(region({ chosen: false, searching: true }), true);
  // …and when the force lifts, the choice the user made is still the one that answers.
  assert.equal(region({ chosen: false }), false);
});

test("the choice is not the rule's business: a search answers the same over every choice", () => {
  for (const chosen of [undefined, true, false]) assert.equal(region({ chosen, searching: true }), true);
});

test("nothing outside this page can open either one: the inputs are the whole rule", () => {
  // A reload is the no-input call, for the region and for every group in it. If a stored choice
  // ever came back, one of these would be the test that turns red.
  assert.equal(region(), false);
  assert.equal(groupOpen(undefined), false);
});
