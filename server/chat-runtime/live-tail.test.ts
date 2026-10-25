// Run: pnpm test -- server/chat-runtime/live-tail.test.ts. The reply so far, for a hello mid-reply:
// what the snapshot holds at each point, and that a snapshot plus the events after it is the reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SovaEvent } from "../../shared/harness-wire";
import { LiveTail } from "./live-tail";

const run: SovaEvent[] = [
  { type: "run.start" },
  { type: "message.start", role: "user", text: "hi", images: [] },
  { type: "message.end", role: "user" },
  { type: "message.start", role: "assistant", model: "zai/glm-5.3", parts: [] },
  { type: "part.start", index: 0, kind: "thinking" },
  { type: "part.delta", index: 0, kind: "thinking", delta: "hm" },
  { type: "part.end", index: 0, kind: "thinking" },
  { type: "part.start", index: 1, kind: "text" },
  { type: "part.delta", index: 1, kind: "text", delta: "Hel" },
  { type: "part.delta", index: 1, kind: "text", delta: "lo" },
  { type: "part.start", index: 2, kind: "toolCall", id: "t1", name: "bash" },
  { type: "part.delta", index: 2, kind: "toolCall", delta: '{"cmd":' },
  { type: "part.end", index: 2, kind: "toolCall", args: { cmd: "ls" } },
  { type: "tool.start", callId: "t1", name: "bash", args: { cmd: "ls" } },
  { type: "tool.update", callId: "t1", output: "a", images: [] },
  { type: "tool.update", callId: "t1", output: "a\nb", images: [] },
];

test("mid-reply: the message's parts so far and the running tool with its latest output", () => {
  const tail = new LiveTail();
  for (const e of run) tail.apply(e);
  assert.deepEqual(tail.snapshot(), {
    message: {
      model: "zai/glm-5.3",
      parts: [
        { kind: "thinking", text: "hm" },
        { kind: "text", text: "Hello" },
        { kind: "toolCall", id: "t1", name: "bash", args: { cmd: "ls" } },
      ],
    },
    tools: [{ callId: "t1", name: "bash", args: { cmd: "ls" }, output: "a\nb", images: [] }],
  });
});

test("nothing streaming: no snapshot (the hello carries no live field)", () => {
  const tail = new LiveTail();
  assert.equal(tail.snapshot(), undefined);
  for (const e of run) tail.apply(e);
  tail.apply({ type: "message.end", role: "assistant", parts: [], stop: "ok" });
  tail.apply({ type: "tool.end", callId: "t1", isError: false, output: "a\nb", images: [] });
  assert.equal(tail.snapshot(), undefined);
  for (const e of run) tail.apply(e);
  tail.apply({ type: "run.settled" });
  assert.equal(tail.snapshot(), undefined, "a settled run leaves nothing behind");
});

test("parts without an index apply at the end; a delta with no start starts its part", () => {
  const tail = new LiveTail();
  tail.apply({ type: "message.start", role: "assistant", parts: [{ kind: "text", text: "a" }] });
  tail.apply({ type: "part.delta", index: 0, kind: "text", delta: "b" });
  tail.apply({ type: "part.delta", kind: "thinking", delta: "t" });
  tail.apply({ type: "part.end", index: 0, kind: "text", text: "AB" });
  assert.deepEqual(tail.snapshot()?.message, { parts: [{ kind: "text", text: "AB" }, { kind: "thinking", text: "t" }] });
});

test("a snapshot taken at any point, with the events after it, is the whole reply", () => {
  const whole = new LiveTail();
  for (const e of run) whole.apply(e);
  for (let cut = 0; cut <= run.length; cut++) {
    const early = new LiveTail();
    for (const e of run.slice(0, cut)) early.apply(e);
    // A new client seeds from the snapshot, then hears the rest.
    const seeded = new LiveTail();
    const snap = early.snapshot();
    if (snap?.message) seeded.apply({ type: "message.start", role: "assistant", ...(snap.message.model ? { model: snap.message.model } : {}), parts: snap.message.parts });
    for (const t of snap?.tools ?? []) {
      seeded.apply({ type: "tool.start", callId: t.callId, name: t.name, ...(t.args !== undefined ? { args: t.args } : {}) });
      seeded.apply({ type: "tool.update", callId: t.callId, output: t.output, images: t.images });
    }
    for (const e of run.slice(cut)) seeded.apply(e);
    assert.deepEqual(seeded.snapshot(), whole.snapshot(), `cut at ${cut}`);
  }
});

test("a snapshot is a copy: later events don't change one already sent", () => {
  const tail = new LiveTail();
  for (const e of run.slice(0, 9)) tail.apply(e);
  const snap = tail.snapshot();
  tail.apply({ type: "part.delta", index: 1, kind: "text", delta: "!" });
  assert.equal(snap?.message?.parts[1]?.kind === "text" && snap.message.parts[1].text, "Hel");
});
