// The memory mode's shared vocabulary (§chat.memory/recall, §chat.memory/types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsSummary } from "../src/lib/message";
import { MEMORY_TYPE_INFO, MEMORY_TYPES, recallSummary } from "./memory";

test("a recall's slim row reads what it opened", () => {
  assert.equal(recallSummary("zoom", { id: 40, n: 8 }), "Recalled messages 40–47");
  assert.equal(recallSummary("zoom", { id: 40, n: 1 }), "Recalled message 40");
  assert.equal(recallSummary("date", { id: 40 }), "Date of message 40");
  assert.equal(recallSummary("zoom", { id: 40, n: 3 }), undefined, "n not a power of 2");
  assert.equal(recallSummary("read", { id: 1 }), undefined);
  // The transcript's folded line is the card's own argsSummary (§chat.transcript/slim-rows).
  assert.equal(argsSummary({ id: 0, n: 64 }, "zoom"), "Recalled messages 0–63");
  assert.equal(argsSummary({ path: "a.ts" }, "read"), "a.ts");
});

test("one row of copy per type, UniiChat credited to its author with its link", () => {
  assert.deepEqual(MEMORY_TYPE_INFO.map((t) => t.id), [...MEMORY_TYPES]);
  const u = MEMORY_TYPE_INFO[0]!;
  assert.equal(u.detail, "UniiChat — by Victor Taelin");
  assert.equal(u.by, "by Victor Taelin");
  assert.equal(u.link, "https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449");
  assert.equal(u.defaultSize, 128);
  assert.equal(MEMORY_TYPE_INFO[1]!.label, "Zoomable compaction");
});
