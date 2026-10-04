// Run: npx tsx --test src/lib/context.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryMeta, TranscriptItem } from "../../shared/protocol";
import { contextFromItems, messageContextTokens } from "./context";

const usage = (input: number, cacheRead = 0, cacheWrite = 0) => ({ input, output: 5, cacheRead, cacheWrite });
let n = 0;
const item = (meta: EntryMeta): TranscriptItem => ({ id: `e${++n}`, kind: "info", meta });
const assistant = (u: unknown, stopReason = "stop") => item({ type: "message", role: "assistant", usage: u, stopReason });

test("a zero-usage error reply does not read as an empty context", () => {
  const items = [assistant(usage(1000, 20_000)), assistant(usage(0), "error")];
  assert.deepEqual(contextFromItems(items, 200_000), { tokens: 21_000, window: 200_000 });
});

test("error, aborted and zero-usage replies are passed over; a compaction still ends the walk", () => {
  assert.deepEqual(contextFromItems([assistant(usage(10)), assistant(usage(9), "aborted"), assistant(usage(9), "error"), assistant(usage(0))], null), { tokens: 10, window: null });
  assert.equal(contextFromItems([assistant(usage(10)), item({ type: "compaction" }), assistant(usage(0), "error")], null), "compacted");
  assert.equal(contextFromItems([assistant(usage(0), "error")], null), null);
});

test("only an entry's first row carries its facts: a reply's later blocks are passed over", () => {
  const reply = assistant(usage(500));
  const later: TranscriptItem = { id: `${reply.id}:1`, kind: "assistant-text", text: "more" };
  assert.deepEqual(contextFromItems([reply, later], null), { tokens: 500, window: null });
  assert.equal(contextFromItems([item({ type: "message", role: "compactionSummary" }), later], null), "compacted");
});

test("messageContextTokens: assistant replies that report a context only", () => {
  assert.equal(messageContextTokens({ role: "assistant", usage: usage(1, 2, 3), stopReason: "toolUse" }), 6);
  assert.equal(messageContextTokens({ role: "assistant", usage: usage(0) }), null);
  assert.equal(messageContextTokens({ role: "assistant", usage: usage(4), stopReason: "error" }), null);
  assert.equal(messageContextTokens({ role: "user", usage: usage(4) }), null);
});
