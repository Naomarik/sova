// A measured reply on the wire: its entry's first row carries `reply` on wire 2 (never wire 1), the
// live message.end carries the frame's tag on wire 2 and wire 1's frame stays as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplyTiming } from "../shared/harness-wire";
import type { ChatServerMessage, TranscriptItem, V1EventFrame } from "../shared/protocol";
import { fromV1 } from "../shared/wire-v1";
import { replyTimingsOf, sessionIdOfPath, setReplyTimingsSource } from "./reply-facts";
import { onWire, rowFor, rowsFor } from "./wire-rows";

const timing: ReplyTiming = { effort: "high", ttftMs: 900, thinkingMs: 1200, replyMs: 3000, output: 640, reasoning: 200 };
const lookup = (id: string) => (id === "a1" ? timing : undefined);
const row = (id: string, meta?: TranscriptItem["meta"]) => ({ id, kind: "assistant-text", text: "hi", ...(meta ? { meta } : {}) }) as unknown as TranscriptItem;

test("the reply's first row gets its timing on wire 2; its other rows, other entries and wire 1 don't", () => {
  const first = row("a1:0", { type: "message", role: "assistant", provider: "zai", model: "glm-5.3" });
  assert.deepEqual(rowFor(first, 2, lookup).facts?.reply, timing);
  assert.equal(rowFor(row("a1:1"), 2, lookup).facts, undefined);
  assert.equal(rowFor(row("b1:0", { type: "message", role: "assistant" }), 2, lookup).facts?.reply, undefined);
  assert.equal(rowFor(first, 1, lookup), first);
  assert.equal(rowFor(first, 2).facts?.reply, undefined);
  assert.deepEqual(rowsFor([first], 2, lookup)[0]!.facts?.reply, timing);
});

test("a message_end's timing tag: in wire 2's message.end when the reply ended ok, dropped from wire 1's frame", () => {
  const end = (stopReason: string): V1EventFrame => ({
    type: "event",
    entryId: "a1",
    reply: timing,
    event: { type: "message_end", message: { role: "assistant", content: [], stopReason, provider: "zai", model: "glm-5.3" } },
  });
  const [ok] = fromV1(end("stop"));
  assert.ok(ok?.type === "message.end" && ok.role === "assistant");
  assert.deepEqual(ok.reply, timing);
  const [err] = fromV1(end("error"));
  assert.ok(err?.type === "message.end" && err.role === "assistant" && err.reply === undefined);
  const frame = end("stop");
  const [v1] = onWire(frame as ChatServerMessage, 1);
  assert.equal("reply" in (v1 as object), false);
  assert.equal((v1 as V1EventFrame).entryId, "a1");
  assert.equal(frame.reply, timing, "the original frame is left as it was");
  const untagged = { type: "event", event: { type: "agent_start" } } as ChatServerMessage;
  assert.equal(onWire(untagged, 1)[0], untagged);
});

test("a session file's id", () => {
  assert.equal(sessionIdOfPath("/x/2026-10-13T10-00-00-000Z_0198abcd-1234.jsonl"), "0198abcd-1234");
});

test("a session's lookup comes from the process's source (a chat process asks the server); none reads as no facts", async () => {
  const asked: string[] = [];
  setReplyTimingsSource(async (sid) => (asked.push(sid), sid === "s1" ? { v: "1.1", timings: { a1: timing } } : null));
  try {
    const got = await replyTimingsOf("s1");
    assert.equal(got?.v, "1.1");
    assert.deepEqual(got?.get("a1"), timing);
    assert.equal(got?.get("toString"), undefined);
    assert.equal(await replyTimingsOf("s2"), null);
    setReplyTimingsSource(async () => {
      throw new Error("down");
    });
    assert.equal(await replyTimingsOf("s1"), null);
    assert.deepEqual(asked, ["s1", "s2"]);
  } finally {
    setReplyTimingsSource(null);
  }
});
