// Run: node scripts/run-tests.mjs server/events-ws.test.ts
// One /ws/events socket's queue and serving (§app.events/backpressure, /resume): fake sockets
// whose sends finish when the test says, fake timers, a real hub with fake sources. No sockets, no files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EventsServerFrame } from "../shared/events";
import { type Entry, EventHub, type EventSources } from "./events";
import { FULL_CLOSE_MS, Outbox, QUEUE_BYTES, QUEUE_MAX, serveEvents, WRITABLE_BYTES, type EventsSocket } from "./events-ws";

/** A socket whose sends finish only when the test says (`drain`), or at once (`auto`). */
function fakeSocket(auto = true) {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const handlers: Record<string, (() => void)[]> = {};
  const ws = {
    readyState: 1,
    OPEN: 1,
    closed: null as null | { code?: number; reason?: string },
    send(data: string, cb: () => void) {
      sent.push(data);
      if (auto) queueMicrotask(cb);
      else pending.push(cb);
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
      this.readyState = 3;
      for (const fn of handlers.close ?? []) fn();
    },
    on(event: string, fn: () => void) {
      (handlers[event] ??= []).push(fn);
    },
  };
  return {
    ws: ws as typeof ws & EventsSocket,
    sent,
    frames: () => sent.map((x) => JSON.parse(x) as EventsServerFrame),
    /** Finish every send so far (each finish may send more, which waits for the next drain). */
    drain() {
      for (const cb of pending.splice(0)) cb();
    },
    unfinished: () => pending.length,
  };
}

/** Timeouts a test fires by hand. */
function fakeTimers() {
  let t = 0;
  const timeouts = new Map<object, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const h = {};
      timeouts.set(h, { at: t + ms, fn });
      return h;
    },
    clearTimeout: (h: unknown) => void timeouts.delete(h as object),
    advance(ms: number) {
      t += ms;
      for (const [h, x] of [...timeouts]) if (x.at <= t) (timeouts.delete(h), x.fn());
    },
    armed: () => timeouts.size,
  };
}

const entry = (seq: number, pad = 0): Entry => {
  const json = JSON.stringify({ type: "event", seq, at: 0, name: "attention.changed", ...(pad ? { pad: "x".repeat(pad) } : {}) });
  return { seq, json, bytes: Buffer.byteLength(json) };
};
const label = (f: EventsServerFrame) => (f.type === "event" ? f.seq : f.type === "gap" && f.reason !== "restarted" ? `gap:${f.reason}:${f.from}-${f.to}` : f.type);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the queue", () => {
  test("a socket that never drains stays within its cap through 10,000 events, with under 64 KB in flight", () => {
    const s = fakeSocket(false);
    const box = new Outbox(s.ws, fakeTimers());
    for (let i = 1; i <= 10_000; i++) {
      box.push(entry(i, i % 7 === 0 ? 3000 : 0));
      assert.ok(box.size <= QUEUE_MAX && box.queuedBytes <= QUEUE_BYTES, `at ${i}: ${box.size} entries, ${box.queuedBytes} bytes`);
      assert.ok(box.inflightBytes < WRITABLE_BYTES + 4000, `at ${i}: ${box.inflightBytes} in flight`);
    }
    assert.ok(s.sent.length < 1000, `${s.sent.length} sent to a socket that took nothing`);
  });

  test("dropped while full, then drained: one gap naming exactly the dropped seqs, before the next event", async () => {
    const s = fakeSocket(false);
    const box = new Outbox(s.ws, fakeTimers());
    const big = 1000;
    const first = Math.ceil(WRITABLE_BYTES / (big + 60)); // what goes out before the socket is full
    const total = 2000;
    for (let i = 1; i <= total; i++) box.push(entry(i, big));
    const out = s.frames().map(label);
    assert.equal(out.length, first, "only what fits in flight went out");
    assert.deepEqual(out, Array.from({ length: first }, (_, i) => i + 1));
    const keptFrom = total - box.size + 1;
    for (let r = 0; r < 100 && s.unfinished(); r++) {
      s.drain();
      await tick();
    }
    const after = s.frames().map(label).slice(first);
    assert.equal(after[0], `gap:overflow:${first + 1}-${keptFrom - 1}`);
    assert.deepEqual(after.slice(1), Array.from({ length: total - keptFrom + 1 }, (_, i) => keptFrom + i));
  });

  test("a socket that takes everything is never queued; one full for 60 s straight is closed 4408, one that recovers is not", async () => {
    const s = fakeSocket(true);
    const timers = fakeTimers();
    const box = new Outbox(s.ws, timers);
    for (let i = 1; i <= 300; i++) {
      box.push(entry(i, 500));
      if (i % 50 === 0) await tick();
    }
    assert.equal(s.sent.length, 300);
    assert.equal(timers.armed(), 0);

    const stuck = fakeSocket(false);
    const t2 = fakeTimers();
    const b2 = new Outbox(stuck.ws, t2);
    for (let i = 1; i <= QUEUE_MAX + 200; i++) b2.push(entry(i, 500));
    assert.equal(t2.armed(), 1);
    t2.advance(FULL_CLOSE_MS - 1);
    assert.equal(stuck.ws.closed, null);
    t2.advance(1);
    assert.deepEqual(stuck.ws.closed, { code: 4408, reason: "too slow" });

    const slow = fakeSocket(false);
    const t3 = fakeTimers();
    const b3 = new Outbox(slow.ws, t3);
    for (let i = 1; i <= QUEUE_MAX + 200; i++) b3.push(entry(i, 500));
    t3.advance(FULL_CLOSE_MS / 2);
    for (let r = 0; r < 100 && slow.unfinished(); r++) {
      slow.drain();
      await tick();
    }
    assert.equal(t3.armed(), 0, "drained: no close pending");
    t3.advance(FULL_CLOSE_MS);
    assert.equal(slow.ws.closed, null);
  });
});

describe("a resume's replay", () => {
  const renamed = (i: number) => ({ name: "session.renamed" as const, source: "observed" as const, id: "s", path: "/s/s.jsonl", from: "x".repeat(200), title: `t${i}` });
  const drainAll = async (s: ReturnType<typeof fakeSocket>) => {
    for (let r = 0; r < 2000 && s.unfinished(); r++) {
      s.drain();
      await tick();
    }
  };

  test("a whole ring (1,000 entries of ~300 B) reaches a healthy socket: every entry after since, no gap", async () => {
    const { hub } = hubWith();
    const first = fakeSocket(true);
    serveEvents(first.ws, new URLSearchParams(), hub, fakeTimers()); // wakes: the marker is seq 1
    for (let i = 2; i <= 1000; i++) hub.record(renamed(i));
    first.ws.close();
    const s = fakeSocket(false);
    serveEvents(s.ws, new URLSearchParams(`stream=${hub.stream}&since=0`), hub, fakeTimers());
    await drainAll(s);
    const got = s.frames().slice(1).map(label);
    assert.deepEqual(got, ["gap:unobserved:1-1", ...Array.from({ length: 999 }, (_, i) => i + 2)]);
    hub.close();
  });

  test("live events during a long replay come after it; past the queue's cap they are dropped with one exact gap", async () => {
    const { hub } = hubWith();
    const first = fakeSocket(true);
    serveEvents(first.ws, new URLSearchParams(), hub, fakeTimers());
    for (let i = 2; i <= 1000; i++) hub.record(renamed(i));
    first.ws.close();
    const s = fakeSocket(false);
    serveEvents(s.ws, new URLSearchParams(`stream=${hub.stream}&since=500`), hub, fakeTimers());
    for (let i = 1001; i <= 1000 + QUEUE_MAX + 40; i++) hub.record(renamed(i)); // the socket has taken nothing yet
    await drainAll(s);
    const got = s.frames().slice(1).map(label);
    const replayed = Array.from({ length: 500 }, (_, i) => 501 + i);
    assert.deepEqual(got.slice(0, 500), replayed, "the replay is whole and first");
    assert.equal(got[500], "gap:overflow:1001-1040");
    assert.deepEqual(got.slice(501), Array.from({ length: QUEUE_MAX }, (_, i) => 1041 + i));
    hub.close();
  });

  test("an evicted gap leads a replay, intact, whatever its length", async () => {
    const chat = new Set<(e: { chatId: string; type: string }) => void>();
    const hub = new EventHub({ onChatEvent: (fn) => (chat.add(fn), () => chat.delete(fn)), onAttention: () => () => {}, holdFeed: () => null, isHosted: () => true, idOf: (p) => p }, { ringMax: 600 });
    const first = fakeSocket(true);
    serveEvents(first.ws, new URLSearchParams(), hub, fakeTimers());
    for (let i = 0; i < 900; i++) hub.record(renamed(i)); // seqs 2..901; kept 302..901: more than the queue holds
    const s = fakeSocket(false);
    serveEvents(s.ws, new URLSearchParams(`stream=${hub.stream}&since=3`), hub, fakeTimers());
    await drainAll(s);
    assert.deepEqual(s.frames().slice(1).map(label), ["gap:evicted:4-301", ...Array.from({ length: 600 }, (_, i) => 302 + i)]);
    hub.close();
  });
});

function hubWith() {
  const chat = new Set<(e: { chatId: string; type: string }) => void>();
  const sources: EventSources = {
    onChatEvent: (fn) => (chat.add(fn), () => chat.delete(fn)),
    onAttention: () => () => {},
    holdFeed: () => null,
    isHosted: () => true,
    idOf: (p) => p,
  };
  const hub = new EventHub(sources, { now: () => 7, lingerMs: 60_000 });
  return { hub, fire: (type: string) => chat.forEach((fn) => fn({ chatId: "/s/a.jsonl", type })) };
}

describe("serving a socket", () => {
  test("hello first, then the resume's replay, then live events; closing leaves the hub", () => {
    const { hub, fire } = hubWith();
    const first = fakeSocket();
    serveEvents(first.ws, new URLSearchParams(), hub, fakeTimers());
    fire("started");
    fire("settled");
    const hello = first.frames()[0] as EventsServerFrame & { type: "hello" };
    assert.deepEqual(hello, { type: "hello", stream: hub.stream, seq: 1, oldest: 1 });
    assert.deepEqual(first.frames().slice(1).map(label), [2, 3]);
    first.ws.close();
    assert.equal(hub.subscribers, 0);

    const again = fakeSocket();
    serveEvents(again.ws, new URLSearchParams(`stream=${hub.stream}&since=2`), hub, fakeTimers());
    fire("started");
    assert.deepEqual(again.frames().map((f) => (f.type === "hello" ? "hello" : label(f))), ["hello", 3, 4]);
    hub.close();
  });

  test("a bad cursor gets an error frame and close 4400, and wakes nothing", () => {
    for (const q of ["since=3", "stream=abcdefgh12345678&since=x"]) {
      const { hub } = hubWith();
      const s = fakeSocket();
      serveEvents(s.ws, new URLSearchParams(q), hub, fakeTimers());
      assert.equal(s.frames()[0]!.type, "error", q);
      assert.equal(s.ws.closed?.code, 4400, q);
      assert.equal(hub.running, false, q);
    }
    const { hub } = hubWith();
    const s = fakeSocket();
    serveEvents(s.ws, new URLSearchParams(`stream=${hub.stream}&since=5`), hub, fakeTimers());
    assert.deepEqual(s.frames()[0], { type: "error", message: "since is ahead of this stream." });
    assert.equal(s.ws.closed?.code, 4400);
  });
});
