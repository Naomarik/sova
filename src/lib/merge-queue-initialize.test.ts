import assert from "node:assert/strict";
import { test } from "node:test";
import { notSetUp, requestInitialize, takeInitialize } from "./merge-queue-initialize";

test("not set up: unserved, or checks unset; an invalid definition is a setup, said as such", () => {
  assert.equal(notSetUp({ served: false, checks: "declared" }), true);
  assert.equal(notSetUp({ served: true, checks: "unset" }), true);
  assert.equal(notSetUp({ served: true, checks: "declared" }), false);
  assert.equal(notSetUp({ served: false, checks: "unset", invalid: "bad json" }), false);
});

test("Settings' Initialize opens that project's tab on the setup once, and no other project's", () => {
  requestInitialize("prj_a");
  assert.equal(takeInitialize("prj_b"), false);
  assert.equal(takeInitialize("prj_a"), true);
  assert.equal(takeInitialize("prj_a"), false, "taken once");
});
