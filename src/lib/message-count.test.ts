// Run: npx tsx --test src/lib/message-count.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { messageCount } from "./message-count";

const item = (id: string, kind: TranscriptItem["kind"]): TranscriptItem => ({ id, kind, raw: null });

test("a block-rich reply is one message: the count is entries, not rows", () => {
  const list = [
    item("u1", "user"),
    item("a1:0", "assistant-text"),
    item("a1:1", "thinking"),
    item("a1:2", "tool-call"),
    item("a1:3", "assistant-text"),
    item("a1:stop", "info"), // the Aborted/Error row an entry can add
  ];
  // Six rendered rows, two messages. The row count is what the number used to be.
  assert.equal(list.length, 6);
  assert.equal(messageCount(list), 2);
});

test("info, report, tool-result and unknown rows are not messages", () => {
  const list = [
    item("u1", "user"),
    item("m1", "info"), // "Model changed to …"
    item("r1", "report"), // a subagent's report
    item("t1", "tool-result"),
    item("x1", "unknown"),
    item("c1", "info"), // compaction
  ];
  assert.equal(messageCount(list), 1);
});

test("a wake row is a message: a nudge really is a user message under the hood", () => {
  assert.equal(messageCount([item("u1", "wake"), item("a1:0", "assistant-text")]), 2);
});

test("a tool-only reply still counts: its tool rows are one assistant entry", () => {
  const list = [item("u1", "user"), item("a1:0", "tool-call"), item("a1:1", "tool-call"), item("a2:0", "assistant-text")];
  assert.equal(messageCount(list), 3);
});

test("an empty branch is zero, which the dialog never shows (the row is absent instead)", () => {
  assert.equal(messageCount([]), 0);
  assert.equal(messageCount([item("m1", "info")]), 0);
});
