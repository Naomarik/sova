// Run: pnpm exec tsx --conditions=browser --test src/lib/session-feed.browser.test.ts. Solid's reactive (browser) build, a fake
// WebSocket and mocked timers: the feed's `llm_inflight` count across connect, unchanged and changed
// frames, a drop, a reconnect and cleanup — never stale, never a list re-read of its own.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
// The browser condition is this file's whole setup: without it every effect below is inert.
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");
import type { LlmInflight, SessionFeedMessage } from "../../shared/protocol";


class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  push(msg: SessionFeedMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

const g = globalThis as Record<string, unknown>;
g.WebSocket = FakeSocket;
g.location = { protocol: "http:", host: "sova.test" };
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const solid = await import("solid-js");
const { llmInflight, openSessionFeed } = await import("./session-feed");

const frame = (inflight: LlmInflight): SessionFeedMessage => ({ type: "llm_inflight", inflight });
const two: LlmInflight = { count: 2, approximate: 0, partial: false, gaps: [] };

test("the count: unknown until this connection's snapshot, quiet on unchanged frames, cleared on a drop and at cleanup", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    FakeSocket.all = [];
    let refreshes = 0;
    const seen: (number | null)[] = [];
    const dispose = solid.createRoot((dispose) => {
      openSessionFeed(() => refreshes++);
      solid.createRenderEffect(() => seen.push(llmInflight()?.count ?? null));
      return dispose;
    });
    const first = FakeSocket.all[0]!;
    assert.equal(first.url, "ws://sova.test/ws/watch?feed=sessions");
    assert.equal(llmInflight(), null, "connecting: unknown, never 0");

    first.open();
    assert.equal(llmInflight(), null, "open without a snapshot is still unknown");
    first.push(frame(two));
    assert.deepEqual(llmInflight(), two);

    const before = seen.length;
    first.push(frame({ ...two, gaps: [] }));
    assert.equal(seen.length, before, "an unchanged snapshot doesn't notify");

    first.push(frame({ count: 0, approximate: 0, partial: false, gaps: [] }));
    assert.equal(llmInflight()?.count, 0, "a complete 0 is a value, not unknown");
    first.push(frame({ count: 1, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }] }));
    assert.equal(llmInflight()?.partial, true);
    assert.equal(refreshes, 0, "a count frame never re-reads the list");

    first.push({ type: "list_changed" });
    assert.equal(refreshes, 1, "list_changed still does");

    first.drop();
    assert.equal(llmInflight(), null, "down: the last figure is gone at once");

    mock.timers.tick(1000);
    const second = FakeSocket.all[1]!;
    assert.ok(second, "the feed reconnects");
    second.open();
    assert.equal(llmInflight(), null, "reconnected: the previous connection's figure is never shown");
    second.push(frame(two));
    assert.deepEqual(llmInflight(), two);
    mock.timers.tick(1000);
    assert.equal(refreshes, 2, "only the reconnect itself re-reads the list");

    dispose();
    assert.equal(llmInflight(), null, "cleanup leaves it unknown");
    // Every value an observer saw (it is disposed with the root, so the last null is the signal's own).
    assert.deepEqual(seen, [null, 2, 0, 1, null, 2]);
  } finally {
    mock.timers.reset();
  }
});
