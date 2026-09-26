// Run: pnpm exec tsx --test server/stream-guard.test.ts. A fake session and a fake clock; no model.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { attachStreamGuard, BATON_RUN_WALL_MS, capsFor, setStreamCapsForTest, type GuardClock, type StreamCaps, type StreamTrip } from "./stream-guard";

type Listener = (e: any) => void;

function harness(caps: Partial<StreamCaps> = {}) {
  let listener: Listener | null = null;
  let aborts = 0;
  const trips: StreamTrip[] = [];
  let starts = 0;
  let now = 1_000_000;
  let beat = now;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const clock: GuardClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (t) => void timers.delete(t as number),
    lastBeat: () => beat,
  };
  const session = {
    subscribe(fn: Listener) {
      listener = fn;
      return () => (listener = null);
    },
    abort: async () => void aborts++,
  };
  const all: StreamCaps = { ...capsFor(null), ...caps };
  const off = attachStreamGuard(session as never, () => all, { onTrip: (t) => trips.push(t), onRunStart: () => starts++ }, clock);
  const emit = (e: any) => listener?.(e);
  const upd = (type: string, extra: Record<string, unknown> = {}) => emit({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });
  return {
    emit,
    start: () => emit({ type: "agent_start" }),
    end: () => emit({ type: "agent_end" }),
    toolStart: (i = 0) => upd("toolcall_start", { contentIndex: i }),
    args: (delta: string, i = 0) => upd("toolcall_delta", { delta, contentIndex: i }),
    text: (delta: string) => upd("text_delta", { delta }),
    thinking: (delta: string) => upd("thinking_delta", { delta }),
    /** Move the clock; `beating` keeps the heartbeat fresh (a healthy loop). Due timers fire. */
    advance(ms: number, beating = true) {
      now += ms;
      if (beating) beat = now;
      for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.fn());
    },
    get aborts() {
      return aborts;
    },
    trips,
    get starts() {
      return starts;
    },
    get attached() {
      return listener !== null;
    },
    timers,
    off,
  };
}

afterEach(() => setStreamCapsForTest(null));

describe("stream guard", () => {
  test("the caps table, by runtime kind", () => {
    const K = 1024;
    assert.deepEqual(capsFor("baton"), { whitespaceRunChars: 8 * K, toolArgChars: 64 * K, outputChars: 256 * K, runWallMs: 600_000, starvedMs: 750, starvedMinArgChars: 128 * K });
    assert.deepEqual(capsFor("overseer"), { whitespaceRunChars: 8 * K, toolArgChars: 64 * K, outputChars: null, runWallMs: 600_000, starvedMs: 750, starvedMinArgChars: 128 * K });
    assert.deepEqual(capsFor("project-overseer"), capsFor("overseer"));
    assert.deepEqual(capsFor(null), { whitespaceRunChars: 8 * K, toolArgChars: K * K, outputChars: null, runWallMs: null, starvedMs: 750, starvedMinArgChars: 128 * K });
    assert.equal(BATON_RUN_WALL_MS, 600_000);
  });

  test("the test override raises every kind's caps, and null restores the table", () => {
    setStreamCapsForTest({ toolArgChars: 5 });
    assert.equal(capsFor("baton").toolArgChars, 5);
    assert.equal(capsFor(null).toolArgChars, 5);
    setStreamCapsForTest(null);
    assert.equal(capsFor(null).toolArgChars, 1024 * 1024);
  });

  test("a whitespace run trips at the cap, carrying across deltas; exactly one abort", () => {
    const h = harness({ whitespaceRunChars: 10 });
    h.start();
    h.toolStart();
    h.args('{"a":"');
    h.args("\t\t \t");
    h.args("\n\r   ");
    assert.equal(h.aborts, 0, "9 in a row, under the cap");
    h.args(" ");
    assert.equal(h.aborts, 1);
    assert.equal(h.trips.length, 1);
    assert.equal(h.trips[0]!.kind, "whitespace");
    assert.equal(h.trips[0]!.chars, 10);
    assert.match(h.trips[0]!.detail, /10 whitespace characters in a row/);
    h.args("          ");
    h.text("more");
    assert.equal(h.aborts, 1, "nothing more after the trip");
  });

  test("a non-whitespace character resets the run; a new tool call and a new run start at zero", () => {
    const h = harness({ whitespaceRunChars: 10 });
    h.start();
    h.toolStart();
    h.args("         x         "); // 9, reset, 9
    h.args("a");
    h.args("         ");
    assert.equal(h.aborts, 0);
    h.toolStart(); // the same index again: its counters start over
    h.args("         ");
    assert.equal(h.aborts, 0);
    h.end();
    h.start();
    h.toolStart();
    h.args("         ");
    assert.equal(h.aborts, 0);
    h.args(" ");
    assert.equal(h.aborts, 1, "control: the tenth trips");
  });

  test("tool-argument size trips per call, counted from the deltas", () => {
    const h = harness({ toolArgChars: 100 });
    h.start();
    h.toolStart(0);
    h.args("a".repeat(60), 0);
    h.toolStart(1);
    h.args("a".repeat(60), 1);
    assert.equal(h.aborts, 0, "two calls of 60 each: none over 100");
    h.args("a".repeat(41), 0);
    assert.equal(h.aborts, 1);
    assert.equal(h.trips[0]!.kind, "tool-args");
    assert.equal(h.trips[0]!.chars, 101);
  });

  test("output trips on text + thinking + tool arguments of one message; a new message starts over", () => {
    const h = harness({ outputChars: 100 });
    h.start();
    h.text("a".repeat(40));
    h.thinking("a".repeat(40));
    h.emit({ type: "message_start" });
    h.text("a".repeat(40));
    assert.equal(h.aborts, 0, "80 then a new message of 40");
    h.thinking("a".repeat(40));
    h.toolStart();
    h.args("a".repeat(21));
    assert.equal(h.aborts, 1);
    assert.equal(h.trips[0]!.kind, "output");
  });

  test("no output cap for an ordinary chat", () => {
    const h = harness();
    h.start();
    h.text("a".repeat(2_000_000));
    assert.equal(h.aborts, 0);
  });

  test("the wall clock trips from its timer", () => {
    const h = harness({ runWallMs: 1000 });
    h.start();
    h.advance(999);
    assert.equal(h.aborts, 0);
    h.advance(2);
    assert.equal(h.aborts, 1);
    assert.equal(h.trips[0]!.kind, "wall-clock");
  });

  test("the wall clock trips from the next event when its timer is late", () => {
    const h = harness({ runWallMs: 1000 });
    h.start();
    h.timers.clear(); // the timer never got to run (a starved loop)
    h.advance(1500);
    assert.equal(h.aborts, 0);
    h.text("x");
    assert.equal(h.aborts, 1);
    assert.equal(h.trips[0]!.kind, "wall-clock");
  });

  test("no wall clock for an ordinary chat; a finished run disarms it", () => {
    const h = harness();
    h.start();
    assert.equal(h.timers.size, 0);
    h.advance(60 * 60_000);
    h.text("x");
    assert.equal(h.aborts, 0);
    const b = harness({ runWallMs: 1000 });
    b.start();
    b.end();
    assert.equal(b.timers.size, 0);
    b.advance(5000);
    assert.equal(b.aborts, 0);
  });

  test("the starvation breaker: a stale heartbeat trips only with a big tool call", () => {
    const h = harness({ starvedMs: 750, starvedMinArgChars: 1000 });
    h.start();
    h.toolStart();
    h.args("a".repeat(999));
    h.advance(800, false); // the loop didn't turn
    h.args("b".repeat(0));
    h.text("x");
    assert.equal(h.aborts, 0, "999 characters: under the size floor");
    h.args("a");
    assert.equal(h.aborts, 1);
    assert.equal(h.trips[0]!.kind, "starved");
    assert.match(h.trips[0]!.detail, /stalled 800 ms/);
  });

  test("a healthy loop never starves, however big the call", () => {
    const h = harness({ starvedMs: 750, starvedMinArgChars: 1000 });
    h.start();
    h.toolStart();
    for (let i = 0; i < 100; i++) {
      h.args("a".repeat(100));
      h.advance(700);
    }
    assert.equal(h.aborts, 0);
  });

  test("nothing before agent_start or after agent_end; onRunStart per run; unsubscribe detaches", () => {
    const h = harness({ toolArgChars: 10 });
    h.toolStart();
    h.args("a".repeat(50));
    assert.equal(h.aborts, 0, "before the run");
    h.start();
    h.end();
    h.args("a".repeat(50));
    assert.equal(h.aborts, 0, "after the run");
    h.start();
    assert.equal(h.starts, 2);
    h.off();
    assert.equal(h.attached, false);
  });

  test("one abort per run, and a new run can trip again", () => {
    const h = harness({ toolArgChars: 10 });
    h.start();
    h.toolStart();
    h.args("a".repeat(11));
    h.args("a".repeat(11));
    h.end();
    h.start();
    h.toolStart();
    h.args("a".repeat(11));
    assert.equal(h.aborts, 2);
    assert.equal(h.trips.length, 2);
  });
});
