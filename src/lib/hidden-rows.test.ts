// Run: npx tsx --test src/lib/hidden-rows.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryKind, TranscriptItem } from "../../shared/protocol";
import { emptyLive } from "./live";
import { liveHiddenCounts, splitHidden, thinkingHiddenLabel, toolsHiddenLabel, visibleCount, type HideKinds } from "./hidden-rows";

const row = (id: string, kind: EntryKind, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, kind, raw: {}, ...extra });
const call = (id: string, callId?: string) => row(id, "tool-call", { text: "bash", toolCallId: callId });
const TOOLS: HideKinds = { tools: true, thinking: false };
const THINKING: HideKinds = { tools: false, thinking: true };
const BOTH: HideKinds = { tools: true, thinking: true };
const result = (id: string, callId: string | undefined, isError = false) =>
  row(id, "tool-result", { toolCallId: callId, raw: { type: "message", message: { role: "toolResult", isError, content: "out" } } });

test("splitHidden: a call and its result leave together, everything else stays in order", () => {
  const items = [
    row("u1", "user"),
    row("t1", "thinking"),
    call("c1", "a"),
    result("r1", "a"),
    row("x1", "assistant-text"),
    row("rep", "report"),
    row("i1", "info"),
  ];
  const s = splitHidden(items, TOOLS);
  assert.deepEqual(s.shown.map((i) => i.id), ["u1", "t1", "x1", "rep", "i1"]);
  assert.deepEqual(s.hidden.map((i) => i.id), ["c1", "r1"]);
  assert.equal(s.calls, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.thinking, 0);
});

test("splitHidden: failures count once per card, orphan results included", () => {
  const items = [
    call("c1", "a"),
    result("r1", "a", true),
    call("c2", "b"),
    result("r2", "b"),
    result("r3", "gone", true), // its call is missing: its own card
    result("r4", undefined, false), // no id at all: its own card
    call("c3", "c"), // no result yet
  ];
  const s = splitHidden(items, TOOLS);
  assert.equal(s.calls, 5);
  assert.equal(s.failed, 2);
  assert.equal(s.shown.length, 0);
  assert.equal(s.hidden.length, 7);
});

test("splitHidden: openFrom points past the last user row", () => {
  const items = [call("c1", "a"), result("r1", "a"), row("u1", "user"), call("c2", "b")];
  assert.equal(splitHidden(items, TOOLS).openFrom, 2);
  assert.equal(splitHidden([call("c1", "a")], TOOLS).openFrom, 0);
});

test("splitHidden: thinking and tools hide independently", () => {
  const items = [row("u1", "user"), row("t1", "thinking"), call("c1", "a"), result("r1", "a", true), row("t2", "thinking"), row("x1", "assistant-text")];
  const thinking = splitHidden(items, THINKING);
  assert.deepEqual(thinking.shown.map((i) => i.id), ["u1", "c1", "r1", "x1"]);
  assert.deepEqual(thinking.hidden.map((i) => i.id), ["t1", "t2"]);
  assert.deepEqual([thinking.calls, thinking.failed, thinking.thinking], [0, 0, 2]);
  const both = splitHidden(items, BOTH);
  assert.deepEqual(both.shown.map((i) => i.id), ["u1", "x1"]);
  assert.deepEqual(both.hidden.map((i) => i.id), ["t1", "c1", "r1", "t2"]);
  assert.deepEqual([both.calls, both.failed, both.thinking], [1, 1, 2]);
  const none = splitHidden(items, { tools: false, thinking: false });
  assert.equal(none.shown.length, items.length);
  assert.equal(none.hidden.length, 0);
});

test("liveHiddenCounts: status from live tools, pending calls run only while the turn runs", () => {
  const live = emptyLive();
  live.running = true;
  live.entries.push({
    kind: "assistant",
    done: false,
    blocks: [
      { type: "text", text: "hi" },
      { type: "thinking", text: "hmm" },
      { type: "toolCall", id: "a", name: "bash", argsText: "" },
      { type: "toolCall", id: "b", name: "read", argsText: "" },
      { type: "toolCall", id: "c", name: "edit", argsText: "" },
    ],
  } as never);
  live.tools.a = { name: "bash", status: "error", output: "", images: [] };
  live.tools.b = { name: "read", status: "done", output: "", images: [] };
  assert.deepEqual(liveHiddenCounts(live, TOOLS), { calls: 3, failed: 1, running: 1, thinking: 0 });
  assert.deepEqual(liveHiddenCounts(live, THINKING), { calls: 0, failed: 0, running: 0, thinking: 1 });
  assert.deepEqual(liveHiddenCounts(live, BOTH), { calls: 3, failed: 1, running: 1, thinking: 1 });
  live.running = false;
  assert.deepEqual(liveHiddenCounts(live, TOOLS), { calls: 3, failed: 1, running: 0, thinking: 0 });
});

test("labels: digits, singular and plural", () => {
  assert.equal(toolsHiddenLabel(1), "1 tool call hidden");
  assert.equal(toolsHiddenLabel(12), "12 tool calls hidden");
  assert.equal(thinkingHiddenLabel(1), "1 thinking block hidden");
  assert.equal(thinkingHiddenLabel(8), "8 thinking blocks hidden");
});

test("visibleCount: hidden rows don't count, each kind on its own", () => {
  const items = [row("u1", "user"), row("t1", "thinking"), call("c1", "a"), result("r1", "a"), row("x1", "assistant-text")];
  assert.equal(visibleCount(items, { tools: false, thinking: false }), 5);
  assert.equal(visibleCount(items, TOOLS), 3);
  assert.equal(visibleCount(items, THINKING), 4);
  assert.equal(visibleCount(items, BOTH), 2);
});
