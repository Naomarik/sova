import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../../shared/harness";
import { DESIGN_PAGE_END, DESIGN_PAGE_START } from "../../pi-config/extensions/mode/design-guide.ts";
import { DesignLive, type DesignLiveFrame } from "./design-live";

function harness() {
  let fn: (e: HarnessEvent) => void = () => {};
  const timers: (() => void)[] = [];
  const frames: DesignLiveFrame[] = [];
  const live = new DesignLive((f) => frames.push(f), 300, { setTimeout: (cb) => (timers.push(cb), timers.length), clearTimeout: (t) => void (timers[(t as number) - 1] = () => {}) });
  live.attach({ subscribe: (f) => ((fn = f), () => {}) });
  const fire = (e: unknown) => fn(e as HarnessEvent);
  return {
    live,
    frames,
    start: () => fire({ type: "message.start", role: "assistant", handle: undefined }),
    tool: (delta: string, index = 0) => fire({ type: "message.update", role: "assistant", handle: undefined, stream: { kind: "tool-call", index, delta } }),
    text: (delta: string) => fire({ type: "message.update", role: "assistant", handle: undefined, stream: { kind: "text", delta } }),
    toolEnd: () => fire({ type: "message.update", role: "assistant", handle: undefined, stream: { kind: "tool-call.end" } }),
    timer: () => timers.splice(0).forEach((t) => t()),
  };
}

test("slices of a page are contiguous, however many timers fire while it is written", () => {
  const h = harness();
  h.start();
  h.tool('{"label":"A","html":"<p>');
  h.timer();
  h.tool("one ");
  h.timer();
  h.tool('two</p>"}');
  h.timer();
  assert.deepEqual(h.frames.map((f) => [f.gen, f.at, f.text]), [[1, 0, "<p>"], [1, 3, "one "], [1, 7, "two</p>"]]);
});

test("slices are coalesced: nothing goes out until the timer, then all of it in one", () => {
  const h = harness();
  h.start();
  h.tool('{"html":"a');
  h.tool("b");
  h.tool("c");
  assert.equal(h.frames.length, 0);
  h.timer();
  assert.deepEqual(h.frames.map((f) => f.text), ["abc"]);
});

test("a second page is a new one, starting again from the start", () => {
  const h = harness();
  h.start();
  h.tool('{"html":"first"}');
  h.toolEnd();
  h.tool('{"html":"second"}', 1);
  h.toolEnd();
  assert.deepEqual(h.frames.map((f) => [f.gen, f.at, f.text]), [[1, 0, "first"], [2, 0, "second"]]);
});

test("a page between marker lines goes out the same way, and the text around it does not", () => {
  const h = harness();
  h.start();
  h.text(`Plan.\n${DESIGN_PAGE_START}\n<p>hi</p>\nmore\n`);
  h.timer();
  h.text(`${DESIGN_PAGE_END}\nthanks`);
  h.timer();
  assert.equal(h.frames.map((f) => f.text).join(""), "<p>hi</p>\nmore");
});

test("after the link comes back the whole page so far is said again from the start", () => {
  const h = harness();
  h.start();
  h.tool('{"html":"abc');
  h.timer();
  h.tool("def");
  h.timer();
  h.live.resync();
  assert.deepEqual(h.frames.at(-1), { gen: 1, at: 0, text: "abcdef" });
});
