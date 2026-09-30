// Run: npx tsx --test server/signals-store.test.ts
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(store.signalKinds({ stuck: stuck(store.STUCK_SCORE_MIN, store.STUCK_CONFIDENCE_MIN) }), ["looping"]);
    assert.deepEqual(store.signalKinds({ stuck: stuck(store.STUCK_SCORE_MIN - 0.01, 1) }), []);
    assert.deepEqual(store.signalKinds({ stuck: stuck(2, store.STUCK_CONFIDENCE_MIN - 0.01) }), []);
    assert.deepEqual(store.signalKinds({ asks_user: asks(store.ASKS_USER_MIN) }), ["asks-you"]);
    assert.deepEqual(store.signalKinds({ asks_user: asks(store.ASKS_USER_MIN - 0.01) }), []);
    assert.deepEqual(store.signalKinds({ asks_user: asks(1), stuck: stuck(2, 1) }), ["asks-you", "looping"]);
  });

  test("an old record's failure answers are read by nothing: no kind, no wire field", () => {
    const old = { outcome: outcome("failed", 1), work_failed: asks(1) };
    assert.deepEqual(store.signalKinds(old), []);
    const wire = store.toWire({ turnId: "t", replyAt: 1, at: 2, provider: "jev", model: "m", answers: old });
    assert.deepEqual(Object.keys(wire).sort(), ["at", "kinds", "provider", "turnId"]);
  });

  test("asks_user reaches the wire as a probability; asksUserOf reads it whatever was seen", () => {
    const t = { turnId: "t", replyAt: 1, at: 2, provider: "jev" as const, model: "m", answers: { asks_user: asks(0.8) }, schema: 2 as const };
    assert.equal(store.toWire(t).asksUser, 0.8);
    const data = { version: 1 as const, sessions: { s: t, quiet: { ...t, answers: { stuck: stuck(0, 1) } } }, workers: {}, stalls: {} };
    assert.deepEqual(store.asksUserOf("s", data), { turnId: "t", replyAt: 1, p: 0.8, asks: true });
    assert.equal(store.asksUserOf("quiet", data), undefined, "a turn not asked has no answer");
    assert.equal(store.asksUserOf("nope", data), undefined);
  });

  test("a record from before asks_user came back (every turn was asked, 26-28 Sep) loses that answer on load", () => {
    const f = join(agentDir, "sova", "old-asks.json");
    writeFileSync(f, JSON.stringify({ version: 1, workers: {}, sessions: {
      old: { turnId: "t", replyAt: 1, at: 2, provider: "jev", model: "m", answers: { asks_user: asks(0.99), stuck: stuck(0, 1) }, detail: "Should I?" },
      now: { turnId: "t", replyAt: 1, at: 2, provider: "jev", model: "m", answers: { asks_user: asks(0.99) }, schema: 2 },
    } }));
    const d = store.readSignals(f);
    assert.deepEqual(Object.keys(d.sessions.old!.answers), ["stuck"]);
    assert.deepEqual(store.toWire(d.sessions.old!).kinds, []);
    assert.deepEqual(store.toWire(d.sessions.now!).kinds, ["asks-you"]);
  });
});

describe("the overlay shows a mark only while it should", () => {
  const file = join(agentDir, "sova", "signals.json");
  store.updateSignals((d) => {
    d.sessions.a = { turnId: "t1", replyAt: NOW - 10, at: NOW, provider: "jev", model: "jev-1", answers: { stuck: stuck(2, 0.9) } };
    d.sessions.quiet = { turnId: "t1", replyAt: NOW - 10, at: NOW, provider: "jev", model: "jev-1", answers: { stuck: stuck(0.2, 0.9), asks_user: asks(0.1) }, schema: 2 };
  }, file);
  const data = store.readSignals(file);
  const ctx = { enabled: true, viewing: false, running: false };

  test("shown: unseen or seen before the classification; carries raw values and kinds", () => {
    const s = store.signalsOverlay("a", ctx, data)!;
    assert.deepEqual(s.kinds, ["looping"]);
    assert.deepEqual(s.stuck, { score: 2, confidence: 0.9 });
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

  test("a worker's stuck check counts from its second looping answer, and expires; old outcome and bare ag_NN records are dropped on load", () => {
    const w1 = store.workerKey("p", "ag_1");
    store.updateSignals((d) => {
      d.workers[w1] = { sessionId: "p", workerId: "ag_1", kind: "stuck", at: NOW, provider: "jev", model: "m", answers: { stuck: stuck(2, 1) }, strikes: 2 };
      d.workers[store.workerKey("p", "ag_2")] = { sessionId: "p", workerId: "ag_2", kind: "stuck", at: NOW, provider: "jev", model: "m", answers: { stuck: stuck(2, 1) }, strikes: 1 };
      d.workers[store.workerKey("p", "ag_3")] = { sessionId: "p", workerId: "ag_3", kind: "stuck", at: NOW, mechanical: true, answers: {} };
    }, file);
    // A worker outcome check from before failure left the classifier, and a stuck check keyed by
    // ag_NN alone (it collided across sessions), as an older server wrote them.
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.workers.w2 = { sessionId: "p", kind: "outcome", at: NOW, endedAt: NOW - 5, provider: "jev", model: "m", answers: { outcome: outcome("failed", 0.9), work_failed: asks(1) } };
    raw.workers.ag_05 = { sessionId: "p", kind: "stuck", at: NOW, provider: "jev", model: "m", answers: { stuck: stuck(2, 1) } };
    const legacy = join(agentDir, "sova", "legacy.json");
    writeFileSync(legacy, JSON.stringify(raw));
    const d = store.readSignals(legacy);
    assert.deepEqual(Object.keys(d.workers).sort(), [w1, store.workerKey("p", "ag_2"), store.workerKey("p", "ag_3")]);
    const wctx = { enabled: true, viewing: false };
    assert.deepEqual(store.workerSignalsOverlay("p", wctx, NOW, d), { stuck: 1 });
    assert.equal(store.workerSignalsOverlay("p", wctx, NOW + store.WORKER_STUCK_FRESH_MS + 1, d), undefined);
    assert.equal(store.workerSignalsOverlay("p", { ...wctx, seenAt: NOW }, NOW, d), undefined);
    assert.equal(store.workerSignalsOverlay("p", { ...wctx, enabled: false }, NOW, d), undefined);
  });

  test("asks-you stays after a look or a view, until the user answers; looping is gone once seen", () => {
    const d = { version: 1 as const, workers: {}, stalls: {}, sessions: {
      both: { turnId: "t", replyAt: NOW - 10, at: NOW, provider: "jev" as const, model: "m", answers: { asks_user: asks(0.9), stuck: stuck(2, 0.9) }, schema: 2 as const },
    } };
    assert.deepEqual(store.signalsOverlay("both", ctx, d)!.kinds, ["asks-you", "looping"]);
    assert.deepEqual(store.signalsOverlay("both", { ...ctx, seenAt: NOW + 5 }, d)!.kinds, ["asks-you"], "seen after the reply (01a0edc0)");
    assert.deepEqual(store.signalsOverlay("both", { ...ctx, viewing: true }, d)!.kinds, ["asks-you"], "on screen");
    assert.equal(store.signalsOverlay("both", { ...ctx, running: true }, d), undefined, "the user answered: a turn runs");
    assert.equal(store.signalsOverlay("both", { ...ctx, enabled: false }, d), undefined);
  });

  test("a malformed file or record reads as empty, never throws", () => {
    const bad = join(agentDir, "sova", "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(store.readSignals(bad), { version: 1, sessions: {}, workers: {}, stalls: {} });
    writeFileSync(bad, JSON.stringify({ version: 1, sessions: { x: { turnId: 3 } }, workers: { y: { kind: "odd" } } }));
    assert.deepEqual(store.readSignals(join(agentDir, "sova", "bad.json")).sessions, {});
  });
});
