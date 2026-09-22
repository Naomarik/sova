// Run: npx tsx --test src/lib/group-route.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupHref, groupRouteFromHash } from "./group-route";

const PATH = "/home/u/.pi/agent/sessions/--home-u-app/2026-09-21T10_00_00_abc.jsonl";

test("a bare group route names no pane", () => {
  assert.deepEqual(groupRouteFromHash("#/g/g1"), { id: "g1", path: null });
});

test("the second segment is the focused pane, percent-decoded", () => {
  assert.deepEqual(groupRouteFromHash(groupHref("g1", PATH)), { id: "g1", path: PATH });
});

test("a group id with reserved characters survives the round trip", () => {
  const id = "g/1 &2";
  assert.deepEqual(groupRouteFromHash(groupHref(id)), { id, path: null });
  assert.deepEqual(groupRouteFromHash(groupHref(id, PATH)), { id, path: PATH });
});

test("other routes, and undecodable ones, are not group routes", () => {
  assert.equal(groupRouteFromHash(`#/s/${encodeURIComponent(PATH)}`), null);
  assert.equal(groupRouteFromHash("#/"), null);
  assert.equal(groupRouteFromHash("#/agents"), null);
  assert.equal(groupRouteFromHash("#/g/"), null);
  assert.equal(groupRouteFromHash("#/g/%E0%A4%A"), null);
});
