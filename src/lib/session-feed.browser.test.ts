// Run: pnpm exec tsx --conditions=browser --test src/lib/session-feed.browser.test.ts. Solid's reactive (browser) build, a fake
// WebSocket and mocked timers: the feed's `llm_inflight` count across connect, unchanged and changed
// frames, a drop, a reconnect and cleanup — never stale, never a list re-read of its own; the pushed Overseer and attention values and the
// open flag; and createPoll with no interval (the pushed values' reads).
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

test("pushed values: each open asks for a resync, frames reach the listeners, and the open flag follows the socket", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    FakeSocket.all = [];
    const { onFeedPush, sessionFeedOpen } = await import("./session-feed");
    const calls: string[] = [];
    const dispose = solid.createRoot((dispose) => {
      openSessionFeed(() => {});
      solid.onCleanup(
        onFeedPush({
          resync: () => calls.push("resync"),
          attention: (d) => calls.push(`attention:${d.items.length}`),
          overseer: (o) => calls.push(`overseer:${o.badge}`),
        }),
      );
      return dispose;
    });
    const first = FakeSocket.all[0]!;
    assert.equal(sessionFeedOpen(), false, "connecting is not open");
    first.open();
    assert.equal(sessionFeedOpen(), true);
    assert.deepEqual(calls, ["resync"], "the first open reads both once");
    first.push({ type: "attention", digest: { items: [] } } as unknown as SessionFeedMessage);
    first.push({ type: "overseer", info: { badge: 3 } } as unknown as SessionFeedMessage);
    assert.deepEqual(calls, ["resync", "attention:0", "overseer:3"]);
    first.drop();
    assert.equal(sessionFeedOpen(), false, "down is not open");
    mock.timers.tick(1000);
    FakeSocket.all[1]!.open();
    assert.deepEqual(calls.at(-1), "resync", "every reopen reads both again");
    dispose();
    assert.equal(sessionFeedOpen(), false);
    const n = calls.length;
    FakeSocket.all[1]!.push({ type: "overseer", info: { badge: 1 } } as unknown as SessionFeedMessage);
    assert.equal(calls.length, n, "a listener that let go hears nothing");
  } finally {
    mock.timers.reset();
  }
});

test("createPoll with no interval: read once, never again on a timer; a failure still retries; set replaces", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { createPoll } = await import("./poll");
    let reads = 0;
    let fail = false;
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    let poll!: ReturnType<typeof createPoll<{ n: number }>>;
    const dispose = solid.createRoot((dispose) => {
      poll = createPoll(async () => {
        reads++;
        if (fail) throw new Error("down");
        return { n: reads };
      }, null);
      return dispose;
    });
    await flush();
    assert.equal(reads, 1);
    assert.equal(poll.data()?.n, 1);
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(reads, 1, "no timer while it reads well");
    poll.set({ n: 42 });
    assert.equal(poll.data()?.n, 42, "a pushed value replaces it");
    mock.timers.tick(60_000);
    await flush();
    assert.equal(reads, 1, "set starts no timer either");
    fail = true;
    poll.refetch();
    await flush();
    assert.equal(reads, 2);
    assert.equal(poll.data()?.n, 42, "a failure keeps the last value");
    fail = false;
    mock.timers.tick(5000);
    await flush();
    assert.equal(reads, 3, "the failure's backoff retry runs");
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(reads, 3, "and then no timer again");
    dispose();
  } finally {
    mock.timers.reset();
  }
});

test("rows: a following list asks for rows=1, takes the rows frames, and re-reads through the feed's throttle; a server with no rows_hello is read the old way", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    FakeSocket.all = [];
    const { followListRows, requestListRead } = await import("./session-feed");
    const { ListRows } = await import("./list-rows");
    let refreshes = 0;
    const published: number[] = [];
    const lr = new ListRows({ refetch: () => requestListRead(() => refreshes++), publish: (r) => published.push(r.length) });
    const unfollow = followListRows(lr);
    const row = (id: string) => ({ id, path: `/s/${id}`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "2026-01-01T00:00:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false }) as const;
    const dispose = solid.createRoot((dispose) => {
      openSessionFeed(() => refreshes++);
      return dispose;
    });
    const first = FakeSocket.all[0]!;
    assert.equal(first.url, "ws://sova.test/ws/watch?feed=sessions&rows=1");
    lr.fetchStarted();
    first.open();
    first.push({ type: "rows_hello", epoch: "e", version: 4 });
    lr.snapshot([row("a")], { epoch: "e", version: 4 });
    first.push({ type: "marks", full: true, sessions: [] });
    first.push({ type: "rows", epoch: "e", from: 4, to: 5, upsert: [row("b")], remove: [] });
    assert.deepEqual(published, [2], "the delta is merged, no re-read");
    assert.equal(refreshes, 0);
    // A gap: one re-read, at once, through the throttle; a second in the same second folds into one.
    first.push({ type: "rows", epoch: "e", from: 9, to: 10, upsert: [], remove: ["/s/a"] });
    first.push({ type: "list_changed" });
    assert.equal(refreshes, 1);
    mock.timers.tick(1000);
    assert.equal(refreshes, 2);

    // A reconnect to a server without rows: list_changed re-reads as before.
    first.drop();
    mock.timers.tick(1000);
    const second = FakeSocket.all[1]!;
    second.open();
    mock.timers.tick(1000);
    const before = refreshes;
    second.push({ type: "marks", full: true, sessions: [] });
    second.push({ type: "list_changed" });
    assert.equal(refreshes, before + 1);
    dispose();
    unfollow();
  } finally {
    mock.timers.reset();
  }
});
