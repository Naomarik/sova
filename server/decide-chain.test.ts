// Run: npx tsx --test server/decide-chain.test.ts — the chain over fake providers (no network).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DecisionError, type Question } from "./decide";
import { AUTH_SKIP_MS, createDecisionChain, ESCALATING_SKIP_MS, skipFor } from "./decide-chain";
import { createFakeProvider } from "./decide-fake";

const qs: Record<string, Question> = { asks: { type: "boolean", instructions: "asks?" } };
const yes = { asks: { p: 0.9 } };
const req = (extra: object = {}) => ({ purpose: "attention" as const, state: "s", questions: qs, ...extra });

async function failure(p: Promise<unknown>): Promise<DecisionError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof DecisionError, String(err));
    return err;
  }
  assert.fail("expected a DecisionError");
}

describe("fall-through", () => {
  test("A rate-limited, B answers → B's result carries fellBackFrom", async () => {
    const a = createFakeProvider({ id: "jev", reply: { fail: "rate-limit", message: "429" } });
    const b = createFakeProvider({ id: "pi", reply: yes });
    const chain = createDecisionChain({ providers: () => [a, b] });
    const r = await chain.decide(req());
    assert.equal(r.provider, "pi");
    assert.deepEqual(r.fellBackFrom, { provider: "jev", failure: "rate-limit", message: "429" });
  });

  test("A bad-request → B is never called, the error surfaces", async () => {
    const a = createFakeProvider({ id: "jev", reply: { fail: "bad-request" } });
    const b = createFakeProvider({ id: "pi", reply: yes });
    const e = await failure(createDecisionChain({ providers: () => [a, b] }).decide(req()));
    assert.equal(e.failure, "bad-request");
    assert.equal(b.calls.length, 0);
  });

  test("a malformed question is refused before any provider", async () => {
    const a = createFakeProvider({ id: "jev", reply: yes });
    const e = await failure(createDecisionChain({ providers: () => [a] }).decide({ purpose: "probe", state: "s", questions: { q: { type: "boolean", instructions: "" } } }));
    assert.equal(e.failure, "bad-request");
    assert.equal(a.calls.length, 0);
  });

  test("both fail → the error names both", async () => {
    const a = createFakeProvider({ id: "jev", reply: { fail: "overloaded", message: "529" } });
    const b = createFakeProvider({ id: "pi", reply: { fail: "auth", message: "no auth configured" } });
    const e = await failure(createDecisionChain({ providers: () => [a, b] }).decide(req()));
    assert.equal(e.failure, "auth");
    assert.match(e.message, /jev: overloaded/);
    assert.match(e.message, /pi: auth/);
    assert.equal((e.cause as DecisionError[]).length, 2);
  });

  test("no providers → unavailable with the configured reason; status says not ready", async () => {
    const chain = createDecisionChain({ providers: () => [], unavailableReason: () => "Jev is off and no fallback model is set." });
    const e = await failure(chain.decide(req()));
    assert.equal(e.failure, "unavailable");
    assert.equal(e.message, "Jev is off and no fallback model is set.");
    assert.deepEqual(chain.status(), { ready: false, providers: [], reason: "Jev is off and no fallback model is set." });
  });
});

describe("breaker", () => {
  test("auth twice: the second call skips A without invoking it, until the reset", async () => {
    let t = 1_000_000;
    const a = createFakeProvider({ id: "jev", reply: { fail: "auth" } });
    const b = createFakeProvider({ id: "pi", reply: yes });
    const chain = createDecisionChain({ providers: () => [a, b], now: () => t });
    await chain.decide(req());
    await chain.decide(req());
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 2);
    const st = chain.status().providers[0]!;
    assert.equal(st.state, "skipped");
    assert.equal(st.until, t + AUTH_SKIP_MS);
    assert.equal(st.lastFailure?.failure, "auth");
    t += AUTH_SKIP_MS + 1;
    await chain.decide(req());
    assert.equal(a.calls.length, 2);
    chain.resetBreakers("jev");
    await chain.decide(req());
    assert.equal(a.calls.length, 3);
  });

  test("the skip durations: rate-limit honours retry-after, server errors escalate, per-request failures don't trip", () => {
    assert.equal(skipFor("rate-limit", 0, 7000), 7000);
    assert.equal(skipFor("rate-limit", 0), 30_000);
    assert.deepEqual([1, 2, 3, 9].map((n) => skipFor("server", n)), [ESCALATING_SKIP_MS[0], ESCALATING_SKIP_MS[1], ESCALATING_SKIP_MS[2], ESCALATING_SKIP_MS[2]]);
    for (const f of ["too-large", "malformed-answer", "unavailable", "bad-request"] as const) assert.equal(skipFor(f, 1), 0, f);
  });

  test("a success clears the strikes and records lastOkAt", async () => {
    let n = 0;
    const a = createFakeProvider({ id: "jev", reply: () => (n++ === 0 ? { fail: "server" as const } : yes) });
    let t = 0;
    const chain = createDecisionChain({ providers: () => [a], now: () => t });
    await failure(chain.decide(req()));
    t += ESCALATING_SKIP_MS[0] + 1;
    await chain.decide(req());
    const st = chain.status().providers[0]!;
    assert.equal(st.state, "ok");
    assert.equal(st.lastOkAt, t);
  });

  test("onAttempt sees each provider's outcome", async () => {
    const seen: string[] = [];
    const a = createFakeProvider({ id: "jev", reply: { fail: "auth" } });
    const b = createFakeProvider({ id: "pi", reply: yes });
    await createDecisionChain({ providers: () => [a, b], onAttempt: (id, o) => seen.push(`${id}:${o.ok ? "ok" : o.error.failure}`) }).decide(req());
    assert.deepEqual(seen, ["jev:auth", "pi:ok"]);
  });
});

describe("dedupe and concurrency", () => {
  test("two concurrent calls with one key share one provider call", async () => {
    const a = createFakeProvider({ id: "jev", reply: yes, delayMs: 10 });
    const chain = createDecisionChain({ providers: () => [a] });
    const [r1, r2] = await Promise.all([chain.decide(req({ dedupeKey: "s1:t1" })), chain.decide(req({ dedupeKey: "s1:t1" }))]);
    assert.equal(a.calls.length, 1);
    assert.equal(r1, r2);
    await chain.decide(req({ dedupeKey: "s1:t1" })); // settled: a later call runs again
    assert.equal(a.calls.length, 2);
  });

  test("the cap of 2 holds under 10 parallel calls", async () => {
    const a = createFakeProvider({ id: "jev", reply: yes, delayMs: 5 });
    const chain = createDecisionChain({ providers: () => [a] });
    await Promise.all(Array.from({ length: 10 }, (_, i) => chain.decide(req({ dedupeKey: `k${i}` }))));
    assert.equal(a.calls.length, 10);
    assert.equal(a.maxInFlight, 2);
  });

  test("a queued call aborted while waiting → timeout, and never runs", async () => {
    const a = createFakeProvider({ id: "jev", reply: yes, delayMs: 20 });
    const chain = createDecisionChain({ providers: () => [a], concurrency: 1 });
    const first = chain.decide(req());
    const ctl = new AbortController();
    const second = chain.decide(req({ signal: ctl.signal }));
    ctl.abort();
    assert.equal((await failure(second)).failure, "timeout");
    await first;
    assert.equal(a.calls.length, 1);
  });
});
