// Run: npx tsx --test server/signals-store.test.ts
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-signals-store-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const store = await import("./signals-store");
import type { Answer } from "./decide";

const NOW = 1_800_000_000_000;
const asks = (p: number): Answer => ({ type: "boolean", p });
const outcome = (choice: string, confidence: number): Answer => ({ type: "choice", choice, probabilities: {}, confidence });
const stuck = (score: number, confidence: number): Answer => ({ type: "score", score, probabilities: [], confidence });

describe("thresholds, applied at read time", () => {
  test("each kind at and just below its threshold", () => {
    assert.deepEqual(store.signalKinds({ asks_user: asks(store.ASKS_USER_MIN) }), ["asks-you"]);
    assert.deepEqual(store.signalKinds({ asks_user: asks(store.ASKS_USER_MIN - 0.01) }), []);
    assert.deepEqual(store.signalKinds({ outcome: outcome("failed", store.FAILED_CONFIDENCE_MIN) }), ["task-failed"]);
    assert.deepEqual(store.signalKinds({ outcome: outcome("failed", store.FAILED_CONFIDENCE_MIN - 0.01) }), []);
    assert.deepEqual(store.signalKinds({ outcome: outcome("partial", 1) }), []);
    assert.deepEqual(store.signalKinds({ work_failed: asks(store.WORK_FAILED_MIN), outcome: outcome("done", 0.9) }), ["task-failed"]);
    assert.deepEqual(store.signalKinds({ work_failed: asks(store.WORK_FAILED_MIN - 0.01), outcome: outcome("done", 0.9) }), []);
    assert.deepEqual(store.signalKinds({ stuck: stuck(store.STUCK_SCORE_MIN, store.STUCK_CONFIDENCE_MIN) }), ["looping"]);
    assert.deepEqual(store.signalKinds({ stuck: stuck(store.STUCK_SCORE_MIN - 0.01, 1) }), []);
    assert.deepEqual(store.signalKinds({ stuck: stuck(2, store.STUCK_CONFIDENCE_MIN - 0.01) }), []);
    assert.deepEqual(store.signalKinds({ asks_user: asks(1), outcome: outcome("failed", 1), stuck: stuck(2, 1) }), ["asks-you", "task-failed", "looping"]);
  });
});

describe("the overlay shows a mark only while it should", () => {
  const file = join(agentDir, "sova", "signals.json");
  store.updateSignals((d) => {
    d.sessions.a = { turnId: "t1", replyAt: NOW - 10, at: NOW, provider: "jev", model: "jev-1", answers: { asks_user: asks(0.9) } };
    d.sessions.quiet = { turnId: "t1", replyAt: NOW - 10, at: NOW, provider: "jev", model: "jev-1", answers: { asks_user: asks(0.1) } };
  }, file);
  const data = store.readSignals(file);
  const ctx = { enabled: true, viewing: false, running: false };

  test("shown: unseen or seen before the classification; carries raw values and kinds", () => {
    const s = store.signalsOverlay("a", ctx, data)!;
    assert.deepEqual(s.kinds, ["asks-you"]);
    assert.equal(s.asksUser, 0.9);
    assert.equal(s.workFailed, undefined); // absent when the turn was not asked it (older records)
    assert.equal(s.provider, "jev");
    assert.ok(store.signalsOverlay("a", { ...ctx, seenAt: NOW - 1 }, data));
  });

  test("hidden: feature off, seen since, on screen, running, no kind fires, never classified", () => {
    assert.equal(store.signalsOverlay("a", { ...ctx, enabled: false }, data), undefined);
    assert.equal(store.signalsOverlay("a", { ...ctx, seenAt: NOW }, data), undefined);
    assert.equal(store.signalsOverlay("a", { ...ctx, viewing: true }, data), undefined);
    assert.equal(store.signalsOverlay("a", { ...ctx, running: true }, data), undefined);
    assert.equal(store.signalsOverlay("quiet", ctx, data), undefined);
    assert.equal(store.signalsOverlay("nope", ctx, data), undefined);
  });

  test("a worker's stuck check expires; a failed outcome stays until seen", () => {
    store.updateSignals((d) => {
      d.workers.w1 = { sessionId: "p", kind: "stuck", at: NOW, provider: "jev", model: "m", answers: { stuck: stuck(2, 1) } };
      d.workers.w2 = { sessionId: "p", kind: "outcome", at: NOW, endedAt: NOW - 5, provider: "jev", model: "m", answers: { outcome: outcome("failed", 0.9) } };
      d.workers.w3 = { sessionId: "other", kind: "outcome", at: NOW, provider: "jev", model: "m", answers: { outcome: outcome("failed", 0.9) } };
    }, file);
    const d = store.readSignals(file);
    const wctx = { enabled: true, viewing: false };
    assert.deepEqual(store.workerSignalsOverlay("p", wctx, NOW, d), { stuck: 1, failed: 1 });
    assert.deepEqual(store.workerSignalsOverlay("p", wctx, NOW + store.WORKER_STUCK_FRESH_MS + 1, d), { stuck: 0, failed: 1 });
    assert.equal(store.workerSignalsOverlay("p", { ...wctx, seenAt: NOW }, NOW, d), undefined);
    assert.equal(store.workerSignalsOverlay("p", { ...wctx, enabled: false }, NOW, d), undefined);
  });

  test("a malformed file or record reads as empty, never throws", () => {
    const bad = join(agentDir, "sova", "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(store.readSignals(bad), { version: 1, sessions: {}, workers: {} });
    writeFileSync(bad, JSON.stringify({ version: 1, sessions: { x: { turnId: 3 } }, workers: { y: { kind: "odd" } } }));
    assert.deepEqual(store.readSignals(join(agentDir, "sova", "bad.json")).sessions, {});
  });
});
