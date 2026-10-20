import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_SLACK_PX, keepUnchanged, nearEnd } from "./share-follow";

test("nearEnd: at the end, and within the slack, follows; scrolled further up to read, it doesn't", () => {
  assert.equal(nearEnd(1000, 800, 1800), true);
  assert.equal(nearEnd(1000 - FOLLOW_SLACK_PX, 800, 1800), true);
  assert.equal(nearEnd(1000 - FOLLOW_SLACK_PX - 1, 800, 1800), false);
  assert.equal(nearEnd(0, 800, 3000), false);
  // A page shorter than the window is at its end.
  assert.equal(nearEnd(0, 900, 600), true);
});

test("keepUnchanged: an unchanged message keeps its object; a changed or new one is the new read's", () => {
  const a = { role: "owner", text: "hi" };
  const b = { role: "assistant", text: "ok", versions: [{ handle: "v_a", state: "starting" }] };
  const next = [{ role: "owner", text: "hi" }, { role: "assistant", text: "ok", versions: [{ handle: "v_a", state: "running" }] }, { role: "owner", text: "new" }];
  const out = keepUnchanged([a, b], next);
  assert.equal(out[0], a);
  assert.equal(out[1], next[1]);
  assert.equal(out[2], next[2]);
  assert.equal(keepUnchanged([a], [{ role: "owner", text: "hi" }])[0], a);
  const fresh = [{ role: "owner", text: "x" }];
  assert.equal(keepUnchanged([], fresh), fresh);
});
