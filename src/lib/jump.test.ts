import assert from "node:assert/strict";
import { test } from "node:test";
import { entryIdOf, entrySelectors, JUMP_CLASS, JUMP_HIGHLIGHT_MS } from "./jump";

test("an entry id matches its own rows, and a block id also falls back to its entry", () => {
  assert.deepEqual(entrySelectors("abc"), ['[data-entry="abc"], [data-entry^="abc:"]']);
  assert.deepEqual(entrySelectors("abc:2"), ['[data-entry="abc:2"], [data-entry^="abc:2:"]', '[data-entry="abc"], [data-entry^="abc:"]']);
});

test("an id with a quote or a backslash can't break out of the selector", () => {
  for (const s of entrySelectors('a"b\\c')) assert.match(s, /\[data-entry="a\\"b\\\\c"/);
});

test("the landing highlight is a class with a bounded life", () => {
  assert.equal(JUMP_CLASS, "entry-jumped");
  assert.ok(JUMP_HIGHLIGHT_MS >= 1000 && JUMP_HIGHLIGHT_MS <= 2500);
});

test("entryIdOf unwraps a rendered row's id to the entry the server knows", () => {
  // An assistant message renders one row per content block, so a row id is usually NOT an entry id.
  assert.equal(entryIdOf("01a0c3c1:0"), "01a0c3c1");
  assert.equal(entryIdOf("01a0c3c1:stop"), "01a0c3c1");
  assert.equal(entryIdOf("01a0c3c1"), "01a0c3c1");
  assert.equal(entryIdOf(""), "");
});

test("a pending explain jump is claimed once, by its own session, on the explanation's row", async () => {
  const { requestExplainJump, claimExplainJump, pendingExplainJump, clearExplainJump, PENDING_JUMP_TTL_MS } = await import("./jump");
  const items = [{ id: "u1" }, { id: "row-9", report: { explain: { id: "exp-1" } } }, { id: "row-10", report: { explain: { id: "exp-2" } } }];
  requestExplainJump({ explainId: "exp-2", sessionId: "sid-a", path: "/a.jsonl" }, 1000);
  assert.equal(claimExplainJump({ path: "/b.jsonl", sessionId: "sid-b" }, items, 1001), null, "another session leaves it waiting");
  assert.ok(pendingExplainJump());
  assert.deepEqual(claimExplainJump({ path: "/a.jsonl" }, items, 1002), { kind: "jump", rowId: "row-10" });
  assert.equal(claimExplainJump({ path: "/a.jsonl" }, items, 1003), null, "consumed: a reload doesn't jump again");

  // Linked by id (#/sid/): no path, the view's session id matches.
  requestExplainJump({ explainId: "exp-1", sessionId: "sid-a", path: null }, 1000);
  assert.deepEqual(claimExplainJump({ path: "/a.jsonl", sessionId: "sid-a" }, items, 1001), { kind: "jump", rowId: "row-9" });

  // Off the branch on screen: consumed, and says so.
  requestExplainJump({ explainId: "exp-gone", sessionId: "sid-a", path: "/a.jsonl" }, 1000);
  assert.deepEqual(claimExplainJump({ path: "/a.jsonl" }, items, 1001), { kind: "missing" });
  assert.equal(pendingExplainJump(), null);

  // Unclaimed past its TTL: dropped, never fired late.
  requestExplainJump({ explainId: "exp-1", sessionId: "sid-a", path: "/a.jsonl" }, 1000);
  assert.equal(claimExplainJump({ path: "/a.jsonl" }, items, 1000 + PENDING_JUMP_TTL_MS + 1), null);
  assert.equal(pendingExplainJump(), null);
  clearExplainJump();
});

test("while older rows are arriving, a pending explain jump whose row isn't here waits; only a whole list says missing", async () => {
  const { requestExplainJump, claimExplainJump, pendingExplainJump, clearExplainJump } = await import("./jump");
  const tail = [{ id: "u9" }];
  requestExplainJump({ explainId: "exp-1", sessionId: "sid-a", path: "/a.jsonl" }, 1000);
  assert.equal(claimExplainJump({ path: "/a.jsonl" }, tail, 1001, false), null, "not whole: not missing yet");
  assert.ok(pendingExplainJump(), "still waiting");
  // The history lands with the row in it.
  const whole = [{ id: "row-2", report: { explain: { id: "exp-1" } } }, ...tail];
  assert.deepEqual(claimExplainJump({ path: "/a.jsonl" }, whole, 1002, false), { kind: "jump", rowId: "row-2" }, "found: claimed even before whole");
  requestExplainJump({ explainId: "exp-gone", sessionId: "sid-a", path: "/a.jsonl" }, 2000);
  assert.equal(claimExplainJump({ path: "/a.jsonl" }, whole, 2001, false), null);
  assert.deepEqual(claimExplainJump({ path: "/a.jsonl" }, whole, 2002, true), { kind: "missing" }, "whole, and not there");
  clearExplainJump();
});
