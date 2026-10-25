// Reply timing's accumulator (§app.insights/reply-timing) on a fake clock: the wait runs from the
// request going out (R1), every part's writing window counts toward the reply (R2), and each skip rule
// is its own branch (R3: a provider's measurement-invalid mark; errored, aborted, compaction).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HarnessEvent, HarnessReplySummary, HarnessStreamDelta } from "../shared/harness";
import { perfRecordOf, reasoningOf, ReplyTimer, type ReplyOutcome } from "./reply-timing";
import { normalizePerfRecord } from "./perf-record";

const frame = () => ({ type: "event" as const, event: {} });

/** A fake clock and a timer on it; `at(ms)` moves the clock, then feeds the event. */
function rig() {
  let t = 1_000_000;
  const timer = new ReplyTimer(() => t);
  const out: ReplyOutcome[] = [];
  const feed = (e: Record<string, unknown>) => {
    const r = timer.observe({ frame, ...e } as unknown as HarnessEvent);
    if (r) out.push(r);
    return r;
  };
  return {
    out,
    /** Advance the clock by `ms`. */
    wait: (ms: number) => void (t += ms),
    now: () => t,
    turn: () => feed({ type: "turn.start" }),
    request: () => feed({ type: "request.start", at: t }),
    start: () => feed({ type: "message.start", role: "assistant", handle: {} }),
    piece: (stream: HarnessStreamDelta) => feed({ type: "message.update", role: "assistant", handle: {}, stream }),
    end: (reply?: Partial<HarnessReplySummary> | null) =>
      feed({ type: "message.end", role: "assistant", handle: {}, ...(reply === null ? {} : { reply: { provider: "zai", model: "glm-5.3", stop: "stop", output: 500, ...reply } }) }),
    feed,
  };
}

const measured = (r: ReplyOutcome | null) => {
  assert.ok(r && "measured" in r, `measured, got ${JSON.stringify(r)}`);
  return r.measured;
};
const skipped = (r: ReplyOutcome | null) => (r && "skipped" in r ? r.skipped : `not skipped: ${JSON.stringify(r)}`);

describe("reply timing (§app.insights/reply-timing)", () => {
  test("R1: the wait runs from the request going out: it counts the HTTP response's and first part's delays, never the prep before the send", () => {
    const r = rig();
    r.turn();
    r.wait(700); // prep: context build, credentials, a provider-slot wait
    r.request();
    const sent = r.now();
    r.wait(400); // the HTTP response (openai-completions' message start comes only then)
    r.start();
    r.wait(250); // the first token
    r.piece({ kind: "text.start", index: 0 });
    r.wait(2000);
    r.piece({ kind: "text", index: 0, delta: "hello" });
    r.piece({ kind: "text.end", index: 0 });
    const m = measured(r.end({ output: 300 }));
    assert.equal(m.sentAt, sent);
    assert.equal(m.firstAt - m.sentAt, 650, "HTTP response + first part, without the 700 ms of prep");
    assert.deepEqual(m.text, { ms: 2000, n: 1 });
    const rec = perfRecordOf(m, { sid: "s1", entryId: "e1", device: null, producer: "p1" });
    assert.equal(rec.ttftMs, 650);
    assert.equal(rec.endMs, 2650);
  });

  test("R1: a request sent again before any part (a rate-limit retry after a delay) keeps the first send: the wait includes the retry", () => {
    const r = rig();
    r.turn();
    r.wait(100);
    r.request();
    const sent = r.now();
    r.start(); // a provider whose message starts before its response
    r.wait(5000); // 429, cooldown
    r.request();
    r.wait(300);
    r.piece({ kind: "thinking.start", index: 0 });
    r.wait(1000);
    r.piece({ kind: "thinking.end", index: 0 });
    const m = measured(r.end());
    assert.equal(m.sentAt, sent);
    assert.equal(m.firstAt - m.sentAt, 5300);
  });

  test("R1: pi's auto-retry: the errored attempt writes nothing, and the retried reply's wait runs from the first attempt's send", () => {
    let t = 0;
    const timer = new ReplyTimer(() => t);
    const feed = (e: Record<string, unknown>) => timer.observe({ frame, ...e } as unknown as HarnessEvent);
    const reply = (stop: string) => ({ provider: "zai", model: "glm-5.3", stop, output: stop === "error" ? 0 : 300 });
    feed({ type: "turn.start" });
    feed({ type: "request.start", at: 0 });
    feed({ type: "message.start", role: "assistant", handle: {} });
    assert.equal(skipped(feed({ type: "message.end", role: "assistant", handle: {}, reply: reply("error") })), "errored");
    feed({ type: "retry.start" });
    feed({ type: "run.end" });
    t = 5000;
    feed({ type: "turn.start" });
    feed({ type: "request.start", at: 5000 });
    feed({ type: "message.start", role: "assistant", handle: {} });
    t = 6000;
    feed({ type: "message.update", role: "assistant", handle: {}, stream: { kind: "text", index: 0, delta: "ok" } });
    const m = measured(feed({ type: "message.end", role: "assistant", handle: {}, reply: reply("stop") }));
    const rec = perfRecordOf(m, { sid: "s", entryId: "e", device: null, producer: "p" });
    assert.equal(rec.ttftMs, 6000);
    feed({ type: "retry.end" });
    feed({ type: "run.end" });
  });

  test("R1: an ordinary next turn after a measured reply never inherits an old send", () => {
    const r = rig();
    r.turn();
    r.request();
    r.start();
    r.wait(400);
    r.piece({ kind: "text", index: 0, delta: "x" });
    r.wait(1000);
    measured(r.end({ stop: "toolUse" }));
    r.wait(3000); // the tool runs
    r.turn();
    r.wait(200);
    r.request();
    const sent = r.now();
    r.start();
    r.wait(250);
    r.piece({ kind: "text", index: 0, delta: "y" });
    const m = measured(r.end());
    assert.equal(m.sentAt, sent);
    assert.equal(m.firstAt - m.sentAt, 250);
    // A next prompt after a run whose attempt failed with no retry starts afresh too.
    r.turn();
    r.request();
    r.start();
    assert.equal(skipped(r.end({ stop: "error" })), "errored");
    r.feed({ type: "run.end" });
    r.wait(10_000);
    r.turn();
    r.request();
    const fresh = r.now();
    r.start();
    r.wait(100);
    r.piece({ kind: "text", index: 0, delta: "z" });
    assert.equal(measured(r.end()).sentAt, fresh);
  });

  test("R1: a retry that gives up: the next prompt's wait is its own", () => {
    const r = rig();
    r.turn();
    r.request();
    r.start();
    assert.equal(skipped(r.end({ stop: "error" })), "errored");
    r.feed({ type: "retry.start" });
    r.feed({ type: "run.end" });
    r.turn();
    r.request();
    r.start();
    assert.equal(skipped(r.end({ stop: "error" })), "errored");
    r.feed({ type: "retry.end" });
    r.feed({ type: "run.end" });
    r.wait(60_000);
    r.turn();
    r.request();
    const fresh = r.now();
    r.start();
    r.wait(100);
    r.piece({ kind: "text", index: 0, delta: "z" });
    assert.equal(measured(r.end()).sentAt, fresh);
  });

  test("R1: a start heard outside a request's wait (a cache warm) is never a reply's", () => {
    const r = rig();
    r.request(); // a warm while idle
    r.wait(60_000);
    r.turn();
    r.start(); // no request heard this turn
    r.piece({ kind: "text", index: 0, delta: "x" });
    assert.equal(skipped(r.end()), "no-request-start");
    r.turn();
    r.request();
    const sent = r.now();
    r.start();
    r.wait(100);
    r.piece({ kind: "text.start", index: 0 });
    r.wait(500);
    r.request(); // a warm while streaming
    r.wait(500);
    r.piece({ kind: "text.end", index: 0 });
    const m = measured(r.end());
    assert.equal(m.sentAt, sent);
    assert.equal(m.firstAt - m.sentAt, 100);
  });

  test("R2: every part's writing window counts: a short preamble then a long, slow tool-call stream", () => {
    const r = rig();
    r.turn();
    r.request();
    r.start();
    r.wait(200);
    r.piece({ kind: "text.start", index: 0 });
    r.wait(150);
    r.piece({ kind: "text", index: 0, delta: "Let me edit that." });
    r.piece({ kind: "text.end", index: 0 });
    r.wait(400); // the gap between parts is in no window
    r.piece({ kind: "tool-call.start", index: 1 });
    for (let i = 0; i < 40; i++) {
      r.wait(250);
      r.piece({ kind: "tool-call", index: 1, delta: "x".repeat(80) });
    }
    r.piece({ kind: "tool-call.end", index: 1 });
    const m = measured(r.end({ stop: "toolUse", output: 900 }));
    assert.deepEqual(m.text, { ms: 150, n: 1 });
    assert.deepEqual(m.tool, { ms: 10_000, n: 1 });
    const rec = perfRecordOf(m, { sid: "s", entryId: "e", device: null, producer: "p" });
    assert.equal(rec.replyMs, 10_150, "overall speed's denominator holds the tool window");
    assert.deepEqual(rec.tool, { ms: 10_000, n: 1 }, "the record says the reply had a tool call: no reply-text speed");
  });

  test("parts of a kind are summed when they come back; parallel tool calls each add their own window", () => {
    const r = rig();
    r.request();
    r.start();
    r.wait(100);
    r.piece({ kind: "thinking.start", index: 0 });
    r.wait(1000);
    r.piece({ kind: "thinking.end", index: 0 });
    r.piece({ kind: "text.start", index: 1 });
    r.wait(500);
    r.piece({ kind: "text.end", index: 1 });
    r.piece({ kind: "thinking.start", index: 2 });
    r.wait(3000);
    r.piece({ kind: "thinking.end", index: 2 });
    r.piece({ kind: "tool-call.start", index: 3 });
    r.wait(200);
    r.piece({ kind: "tool-call.end", index: 3 });
    r.piece({ kind: "tool-call.start", index: 4 });
    r.wait(300);
    // characters with no start open a window; a part still open at the end closes at its last characters
    r.piece({ kind: "text", index: 5, delta: "tail" });
    r.wait(100);
    r.piece({ kind: "text", index: 5, delta: "more" });
    r.wait(100);
    const m = measured(r.end({ stop: "toolUse" }));
    assert.deepEqual(m.thinking, { ms: 4000, n: 2 });
    assert.deepEqual(m.tool, { ms: 700, n: 2 }, "the second call had no characters: open until the reply's end");
    assert.deepEqual(m.text, { ms: 600, n: 2 });
  });

  test("a part ends at its last characters: every end sent at the stream's end (pi-ai openai-completions) never overlaps thinking with the text after it", () => {
    const r = rig();
    r.request();
    r.start();
    r.wait(500);
    r.piece({ kind: "thinking.start", index: 0 });
    r.piece({ kind: "thinking", index: 0, delta: "hm" });
    for (let i = 0; i < 10; i++) {
      r.wait(100);
      r.piece({ kind: "thinking", index: 0, delta: "hm" });
    }
    r.wait(50);
    r.piece({ kind: "text.start", index: 1 });
    r.piece({ kind: "text", index: 1, delta: "a" });
    for (let i = 0; i < 20; i++) {
      r.wait(100);
      r.piece({ kind: "text", index: 1, delta: "b" });
    }
    r.wait(30);
    r.piece({ kind: "thinking.end", index: 0 });
    r.piece({ kind: "text.end", index: 1 });
    const m = measured(r.end());
    assert.deepEqual(m.thinking, { ms: 1000, n: 1 });
    assert.deepEqual(m.text, { ms: 2000, n: 1 });
    assert.ok(m.thinking.ms + m.text.ms <= m.endAt - m.firstAt, "the windows never add up past the stream");
  });

  test("a part with no characters (Claude's hidden thinking) runs from its start to its end", () => {
    const r = rig();
    r.request();
    r.start();
    r.piece({ kind: "thinking.start", index: 0 });
    r.wait(3000);
    r.piece({ kind: "thinking.end", index: 0 });
    r.piece({ kind: "text.start", index: 1 });
    r.wait(10);
    r.piece({ kind: "text", index: 1, delta: "x" });
    r.wait(500);
    const m = measured(r.end());
    assert.deepEqual(m.thinking, { ms: 3000, n: 1 });
    assert.deepEqual(m.text, { ms: 10, n: 1 }, "still open at the end: closed at its last characters");
  });

  test("R3: a reply a provider marked as no measurement (a Claude invalid-tool retry inside it) writes no sample", () => {
    const r = rig();
    r.request();
    r.start();
    r.piece({ kind: "text", index: 0, delta: "attempt 1" });
    r.wait(2000);
    assert.equal(skipped(r.end({ invalid: "invalid-tool-retry" })), "invalid");
  });

  test("skips: errored, aborted, an unfinished stop, a compaction's message, no summary, no part, no start", () => {
    const one = (setup: (r: ReturnType<typeof rig>) => void, reply?: Partial<HarnessReplySummary> | null) => {
      const r = rig();
      r.request();
      setup(r);
      return skipped(r.end(reply));
    };
    const streamed = (r: ReturnType<typeof rig>) => {
      r.start();
      r.piece({ kind: "text", index: 0, delta: "x" });
    };
    assert.equal(one(streamed, { stop: "error" }), "errored");
    assert.equal(one(streamed, { stop: "aborted" }), "aborted");
    assert.equal(one(streamed, { stop: "other" }), "unfinished");
    assert.equal(one(streamed, null), "no-summary");
    assert.equal(one((r) => r.start()), "no-first-token");
    assert.equal(one(() => undefined), "no-start");
    assert.equal(
      one((r) => {
        r.feed({ type: "compaction.start" });
        streamed(r);
      }),
      "compaction",
    );
    // A compaction that started mid-reply also rules it out.
    assert.equal(
      one((r) => {
        streamed(r);
        r.feed({ type: "compaction.start" });
      }),
      "compaction",
    );
    // After the compaction ends, replies count again.
    const r = rig();
    r.feed({ type: "compaction.start" });
    r.feed({ type: "compaction.end", wrote: true, willRetry: true });
    r.turn();
    r.request();
    streamed(r);
    measured(r.end());
  });

  test("a run's end forgets a reply in flight and a pending start; a user's or a note's messages are not replies", () => {
    const r = rig();
    r.request();
    r.feed({ type: "run.settled" });
    r.start();
    r.piece({ kind: "text", index: 0, delta: "x" });
    assert.equal(skipped(r.end()), "no-request-start");
    assert.equal(r.feed({ type: "message.end", role: "user", handle: {}, text: "hi" }), null);
    assert.equal(r.feed({ type: "message.start", role: "other", handle: {} }), null);
  });

  test("thinking tokens: kept only where the split is real; a 0 with a thinking part is 'not reported'", () => {
    const s = (reasoning: number | undefined, output = 500): HarnessReplySummary => ({ provider: "p", model: "m", stop: "stop", output, ...(reasoning !== undefined ? { reasoning } : {}) });
    const thought = { ms: 4000, n: 1 };
    const none = { ms: 0, n: 0 };
    assert.equal(reasoningOf(s(undefined), thought), undefined, "not reported");
    assert.equal(reasoningOf(s(0), thought), undefined, "openai-completions' 0 beside a thinking window");
    assert.equal(reasoningOf(s(0), none), 0, "no thinking part: a real 0");
    assert.equal(reasoningOf(s(300), thought), 300);
    assert.equal(reasoningOf(s(600, 500), thought), undefined, "more than the whole output: a bad report");
  });

  test("the record: canonical, strictly parseable, effort and the model that answered carried", () => {
    const r = rig();
    r.request();
    r.start();
    r.wait(100);
    r.piece({ kind: "thinking.start", index: 0 });
    r.wait(1000);
    r.piece({ kind: "thinking.end", index: 0 });
    r.piece({ kind: "text.start", index: 1 });
    r.wait(2000);
    r.piece({ kind: "text.end", index: 1 });
    const m = measured(r.end({ output: 400, reasoning: 0, effort: "high", providerEffort: "enabled", responseModel: "glm-5.3-x" }));
    const rec = perfRecordOf(m, { sid: "sid1", entryId: "ent1", device: "h_abcdefgh", producer: "prod-1", kind: "worker" });
    assert.deepEqual(normalizePerfRecord(JSON.parse(JSON.stringify(rec))), rec);
    assert.equal(rec.key, "sid1:ent1");
    assert.equal(rec.effort, "high");
    assert.equal(rec.providerEffort, "enabled");
    assert.equal(rec.responseModel, "glm-5.3-x");
    assert.equal("reasoning" in rec, false, "0 with a thinking window: absent");
    assert.equal(rec.thinkingMs, 1000);
    assert.equal(rec.replyMs, 2000);
  });
});
