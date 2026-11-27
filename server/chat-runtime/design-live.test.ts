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
    fire,
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

test("a page that ended isn't told again when the link comes back, or it reads as a new page", () => {
  const h = harness();
  h.start();
  h.tool('{"html":"abc');
  h.timer();
  h.fire({ type: "message.end", role: "assistant" });
  const before = h.frames.length;
  h.live.resync();
  assert.equal(h.frames.length, before);
});

test("thinking says so at once and then once an interval, with no page text", () => {
  const h = harness();
  h.start();
  const think = () => h.fire({ type: "message.update", role: "assistant", handle: undefined, stream: { kind: "thinking", delta: "hm" } });
  think();
  think();
  think();
  assert.deepEqual(h.frames.map((f) => [f.thinking, f.text]), [[true, ""]]);
  h.timer();
  think();
  assert.equal(h.frames.length, 2);
});

test("a part added to the end of the draft is a page of its own, its frames marked as continuing the draft", () => {
  const h = harness();
  h.start();
  h.tool('{"label":"A","html":"<p>one</p>"}');
  h.toolEnd();
  h.start();
  h.tool('{"label":"A","append":"<p>two');
  h.timer();
  h.tool('</p>"}', 0);
  h.toolEnd();
  assert.deepEqual(
    h.frames.map((f) => [f.gen, f.at, f.text, f.append ?? false]),
    [
      [1, 0, "<p>one</p>", false],
      [2, 0, "<p>two", true],
      [2, 6, "</p>", true],
    ],
  );
});

test("a part told again after the link came back still says it continues the draft", () => {
  const h = harness();
  h.start();
  h.tool('{"append":"abc');
  h.timer();
  h.live.resync();
  assert.deepEqual(h.frames.at(-1), { gen: 1, at: 0, text: "abc", append: true });
});

test("a whole page after a part is a whole page again, unmarked", () => {
  const h = harness();
  h.start();
  h.tool('{"append":"x"}');
  h.toolEnd();
  h.tool('{"html":"y"}', 1);
  h.toolEnd();
  assert.deepEqual(h.frames.map((f) => [f.gen, f.append ?? false]), [[1, true], [2, false]]);
});
