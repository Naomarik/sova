// Run: pnpm test -- server/session-tokens.test.ts
// The per-session token store behind the board's Tokens/min column (§app.insights/session-token-rate):
// virtual time, hand-made reports, nothing else.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TOKEN_BUCKET_MS, TOKEN_SLOTS } from "./llm-inflight";
import { type ProcessReport, SessionTokenStore } from "./session-tokens";

const SLOT = 1_000_000;
let clock = SLOT * TOKEN_BUCKET_MS;
const store = () => {
  clock = SLOT * TOKEN_BUCKET_MS;
  return new SessionTokenStore(() => clock);
};
/** A ring at the current slot with `last` as its newest slots (oldest first). */
const ring = (last: number[], end = Math.floor(clock / TOKEN_BUCKET_MS)) => ({
  bucketMs: TOKEN_BUCKET_MS,
  end,
  out: [...new Array<number>(TOKEN_SLOTS - last.length).fill(0), ...last],
});
const report = (producer: string, last: number[], over: Partial<ProcessReport> = {}): ProcessReport => ({ producer, tokens: ring(last), ...over });
const main = (id: string) => ({ sessionId: id });
const worker = (id: string, parent: string) => ({ sessionId: id, parent });
const sum = (xs: number[] | undefined) => (xs ?? []).reduce((a, b) => a + b, 0);

describe("SessionTokenStore", () => {
  test("a session's own last 5 minutes, from its oldest non-zero slot, and its 30-minute total, under its session id", () => {
    const s = store();
    s.note(main("m"), report("pm", [0, 0, 100, 0, 50]));
    assert.deepEqual(s.view(), { "m": { end: SLOT, own: [100, 0, 50], own30: 150 } });
  });

  test("workers at any depth roll up to the main thread's row, apart from its own; nothing counts twice", () => {
    const s = store();
    s.note(main("m"), report("pm", [10]));
    s.note(worker("w1", "m"), report("p1", [20]));
    s.note(worker("w2", "w1"), report("p2", [30]));
    const v = s.view();
    assert.deepEqual(Object.keys(v), ["m"]);
    assert.deepEqual(v["m"]!.own, [10]);
    assert.deepEqual(v["m"]!.workers, [50]);
    // The same reports again replace, never add.
    s.note(worker("w1", "m"), report("p1", [20]));
    s.note(worker("w2", "w1"), report("p2", [30]));
    assert.equal(sum(s.view()["m"]!.workers), 50);
  });

  test("a process whose report already folds another's in is the only one counted for it", () => {
    const s = store();
    s.note(main("m"), report("pm", [10]));
    s.note(worker("w1", "m"), report("p1", [25], { folded: ["p2"] })); // its ring includes p2's 5
    s.note(worker("w2", "w1"), report("p2", [5]));
    assert.equal(sum(s.view()["m"]!.workers), 25);
  });

  test("a worker's tokens stay on its parent's row after its process exits, until they age out", () => {
    const s = store();
    s.note(main("m"), report("pm", [0]));
    s.note(worker("w1", "m"), report("p1", [400]));
    s.release("w1");
    assert.equal(sum(s.view()["m"]!.workers), 400);
    // A late report from the process that went adds nothing.
    s.note(worker("w1", "m"), report("p1", [400]));
    assert.equal(sum(s.view()["m"]!.workers), 400);
    // Past 5 minutes the row has no recent tokens: not sent.
    clock += 10 * TOKEN_BUCKET_MS;
    assert.deepEqual(s.view(), {});
    // Past 30 minutes it is gone from memory too.
    clock += TOKEN_SLOTS * TOKEN_BUCKET_MS;
    s.release("m");
    s.view();
    assert.equal(s.size, 0);
  });

  test("a reload's new process adds to the old one's tokens, never replaces them", () => {
    const s = store();
    s.note(main("m"), report("old", [300]));
    s.note(main("m"), report("new", [7]));
    assert.equal(sum(s.view()["m"]!.own), 307);
  });

  test("a main thread that exited keeps its own tokens on its row", () => {
    const s = store();
    s.note(main("m"), report("pm", [90]));
    s.release("m");
    assert.deepEqual(s.view()["m"], { end: SLOT, own: [90], own30: 90 });
  });

  test("only the last 5 minutes' slots travel; the older ones only in the 30-minute total", () => {
    const s = store();
    s.note(main("m"), report("pm", [7, ...new Array<number>(12).fill(1)]));
    assert.deepEqual(s.view()["m"], { end: SLOT, own: new Array<number>(10).fill(1), own30: 19 });
  });

  test("only rows with tokens in the last 5 minutes are sent; hidden chats and their workers never", () => {
    const s = store();
    s.note(main("old"), { producer: "po", tokens: ring([5, ...new Array<number>(10).fill(0)]) });
    s.note({ ...main("ov"), hidden: true }, report("ph", [70]));
    s.note(worker("wv", "ov"), report("pw", [70]));
    s.note(main("quiet"), report("pq", []));
    assert.deepEqual(s.view(), {});
  });

  test("partial: a running Claude Code turn, a degraded process, a report without a ring", () => {
    const s = store();
    s.note(main("a"), report("pa", [1], { claudeTurns: 1 }));
    s.note(main("b"), report("pb", [1], { degraded: true }));
    s.note(main("c"), report("pc", [1]));
    s.note(worker("w", "c"), { producer: "pw" });
    s.note(main("d"), report("pd", [1]));
    const v = s.view();
    assert.equal(v["a"]!.partial, true);
    assert.equal(v["b"]!.partial, true);
    assert.equal(v["c"]!.partial, true);
    assert.equal(v["d"]!.partial, undefined);
  });

  test("a worker whose parent never reported lands on the parent's row", () => {
    const s = store();
    s.note(worker("w", "tui"), report("pw", [12]));
    assert.deepEqual(s.view(), { "tui": { end: SLOT, workers: [12], workers30: 12 } });
  });

  test("a parent cycle lands nowhere", () => {
    const s = store();
    s.note(worker("a", "b"), report("pa", [1]));
    s.note(worker("b", "a"), report("pb", [1]));
    assert.deepEqual(s.view(), {});
  });

  test("one build per change and 30 s slot: a repeated report changes nothing, and the wire is the view encoded", () => {
    const s = store();
    s.note(main("m"), report("pm", [5]));
    const first = s.wire();
    assert.deepEqual(first, { m: `${SLOT} 5 0 5 -` });
    s.note(main("m"), report("pm", [5]));
    assert.equal(s.wire(), first, "the same report again: the same answer, not rebuilt");
    s.note(main("m"), report("pm", [6]));
    assert.notEqual(s.wire(), first, "a changed ring: rebuilt");
    const second = s.wire();
    clock += TOKEN_BUCKET_MS;
    assert.notEqual(s.wire(), second, "the next slot: rebuilt");
  });

  test("a malformed ring is unknown (partial), never a number", () => {
    const s = store();
    s.note(main("m"), report("pm", [3]));
    s.note(worker("w", "m"), { producer: "pw", tokens: { bucketMs: 1, end: 1, out: [] } });
    assert.deepEqual(s.view()["m"], { end: SLOT, own: [3], own30: 3, partial: true });
  });

  test("1,000 exited workers: held while their tokens are in the window, all pruned once they age out, with no board asking", () => {
    const s = store();
    s.note(main("m"), report("pm", [1]));
    for (let k = 0; k < 1000; k++) {
      s.note(worker(`w${k}`, "m"), report(`p${k}`, [k + 1]));
      s.release(`w${k}`);
    }
    assert.equal(s.size, 1001, "their tokens still count on the parent's row");
    // 29 minutes on, a live chat's ordinary state report: every exited worker's slot is still in the 30-minute ring.
    clock += 29 * 60_000;
    s.note(main("m"), report("pm", [1]));
    assert.equal(s.size, 1001);
    // 31 minutes after they wrote: gone, on the next ordinary call; no view() was asked for.
    clock += 2 * 60_000;
    s.note(main("m"), report("pm", [1]));
    assert.equal(s.size, 1, "only the live chat is left");
    // A release alone prunes too (an exit with no other chat reporting).
    s.note(worker("late", "m"), report("pl", [9]));
    s.release("late");
    clock += 31 * 60_000;
    s.release("m");
    assert.equal(s.size, 0);
  });

  test("a repeated report takes the fast path and changes nothing; any difference takes the full one", () => {
    const s = store();
    s.note(main("m"), report("pm", [5, 6]));
    const first = s.wire();
    s.note(main("m"), report("pm", [5, 6]));
    assert.equal(s.wire(), first, "identical: not rebuilt");
    s.note(main("m"), report("pm", [5, 6], { claudeTurns: 1 }));
    assert.equal(s.view()["m"]!.partial, true, "a Claude turn running: partial");
    s.note(main("m"), report("pm", [5, 6]));
    assert.equal(s.view()["m"]!.partial, undefined, "and back");
    s.note(main("m"), report("pm", [5, 6], { folded: ["px"] }));
    s.note(main("m"), report("pm", [5, 7], { folded: ["px"] }));
    assert.deepEqual(s.view()["m"]!.own, [5, 7], "one slot changed: read");
    // An out-of-bounds slot is stored clamped, so its repeat never matches in place, and still reads clamped.
    s.note(main("m"), report("pm", [Number.MAX_SAFE_INTEGER]));
    s.note(main("m"), report("pm", [Number.MAX_SAFE_INTEGER]));
    assert.deepEqual(s.view()["m"]!.own, [10_000_000]);
  });
});
