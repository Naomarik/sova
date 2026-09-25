// Run: npx tsx --test server/decide-jev.test.ts — Jev's mapping against a fake fetch (never the network).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DecisionError, type Question } from "./decide";
import { createJevProvider, jevFailure, JEV_MAX_TOKENS } from "./decide-jev";

const KEY = "tsk-fake-" + "k".repeat(60);
const qs: Record<string, Question> = {
  asks: { type: "boolean", instructions: "asks?", criteria: { true: "asks", false: "reports" } },
  outcome: { type: "choice", instructions: "outcome?", options: { done: "finished", failed: null } },
  stuck: { type: "score", instructions: "stuck?", levels: ["no", "some", "yes"] },
};

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? "not json" : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function failure(p: Promise<unknown>): Promise<DecisionError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof DecisionError);
    return err;
  }
  assert.fail("expected a DecisionError");
}

describe("happy path", () => {
  test("maps questions out and answers back; the key only in the header", async () => {
    const { f, calls } = fakeFetch(
      200,
      {
        model: "jev-1.13.0",
        answers: {
          asks: { type: "noul", noul: 0.94 },
          outcome: { type: "choice", choice: "failed", probabilities: { done: 0.28, failed: 0.72 }, confidence: 0.44 },
          stuck: { type: "score", score: 0, legend: "no", probabilities: { "0": 0.99, "1": 0.01, "2": 0 }, confidence: 0.985 },
        },
        usage: { input_tokens: 612, output_tokens: 20 },
      },
      { "x-typesafe-request-id": "req-1" },
    );
    const jev = createJevProvider({ key: () => KEY, fetch: f });
    const r = await jev.decide({ purpose: "attention", state: { assistant_last: "Should I push?" }, questions: qs });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(String(calls[0]!.init.body).includes(KEY), false);
    assert.deepEqual(sent.questions.asks, { type: "noul", instructions: "asks?", criteria: { true: "asks", false: "reports" } });
    assert.deepEqual(sent.questions.outcome.criteria, { done: "finished", failed: null });
    assert.deepEqual(sent.questions.stuck, { type: "score", instructions: "stuck?", criteria: ["no", "some", "yes"] });
    assert.equal(sent.model, "jev-latest");
    assert.deepEqual(r.answers.asks, { type: "boolean", p: 0.94 });
    assert.equal(r.answers.outcome?.type === "choice" && r.answers.outcome.choice, "failed");
    assert.equal(r.answers.outcome?.type === "choice" && r.answers.outcome.confidence, 0.44);
    assert.deepEqual(r.answers.stuck?.type === "score" && r.answers.stuck.probabilities, [0.99, 0.01, 0]);
    assert.equal(r.model, "jev-1.13.0");
    assert.equal(r.provider, "jev");
    assert.deepEqual(r.usage, { inputTokens: 612, outputTokens: 20 });
  });
});

describe("errors (observed bodies, plan §1.4)", () => {
  const cases: [number, unknown, string][] = [
    [401, { detail: { error_type: "authentication_error", message: "Cannot authenticate" } }, "auth"],
    [403, { detail: { error_type: "authentication_error", message: "Must supply an API key!" } }, "auth"],
    [422, { detail: [{ type: "missing", loc: ["body", "questions", "q", "choice", "criteria"], msg: "Field required" }] }, "bad-request"],
    [400, { detail: { error_type: "max_tokens_exceeded" } }, "too-large"],
    [400, { detail: { error_type: "api_usage_error", message: "Unknown model: jev-9" } }, "bad-request"],
    [400, { detail: "Too many choices. Must have at most 255 choices." }, "bad-request"],
    [402, { detail: "Payment required" }, "quota"],
    [400, { detail: { error_type: "insufficient_credits", message: "Out of credits" } }, "quota"],
    [429, { detail: "slow down" }, "rate-limit"],
    [529, null, "overloaded"],
    [503, null, "overloaded"],
    [500, null, "server"],
    [418, { detail: "teapot" }, "server"],
  ];
  for (const [status, body, expected] of cases)
    test(`${status} ${JSON.stringify(body)?.slice(0, 50)} → ${expected}`, async () => {
      assert.equal(jevFailure(status, body).failure, expected);
      const { f } = fakeFetch(status, body ?? undefined, { "x-typesafe-request-id": "req-e" });
      const e = await failure(createJevProvider({ key: () => KEY, fetch: f }).decide({ purpose: "probe", state: "x", questions: qs }));
      assert.equal(e.failure, expected);
      assert.equal(e.requestId, "req-e");
      assert.equal(e.message.includes(KEY), false);
    });

  test("retry-after: 7 → retryAfterMs 7000", async () => {
    const { f } = fakeFetch(429, { detail: "rate" }, { "retry-after": "7" });
    const e = await failure(createJevProvider({ key: () => KEY, fetch: f }).decide({ purpose: "probe", state: "x", questions: qs }));
    assert.equal(e.retryAfterMs, 7000);
  });

  test("fetch throwing → network; our deadline → timeout; neither message carries the key", async () => {
    const thrower = (async () => {
      throw new Error(`connect ECONNREFUSED (auth ${KEY})`);
    }) as unknown as typeof fetch;
    const e1 = await failure(createJevProvider({ key: () => KEY, fetch: thrower }).decide({ purpose: "probe", state: "x", questions: qs }));
    assert.equal(e1.failure, "network");
    assert.equal(e1.message.includes(KEY), false);
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const e2 = await failure(createJevProvider({ key: () => KEY, fetch: hang, timeoutMs: 20 }).decide({ purpose: "probe", state: "x", questions: qs }));
    assert.equal(e2.failure, "timeout");
  });

  test("an oversized state and a missing key never call fetch", async () => {
    const { f, calls } = fakeFetch(200, {});
    const big = "x".repeat(JEV_MAX_TOKENS * 4 + 100);
    assert.equal((await failure(createJevProvider({ key: () => KEY, fetch: f }).decide({ purpose: "probe", state: big, questions: qs }))).failure, "too-large");
    assert.equal((await failure(createJevProvider({ key: () => null, fetch: f }).decide({ purpose: "probe", state: "x", questions: qs }))).failure, "unavailable");
    assert.equal(calls.length, 0);
  });

  test("a 200 without an answer for every question → malformed-answer", async () => {
    const { f } = fakeFetch(200, { answers: { asks: { noul: 0.1 } } });
    assert.equal((await failure(createJevProvider({ key: () => KEY, fetch: f }).decide({ purpose: "probe", state: "x", questions: qs }))).failure, "malformed-answer");
  });
});

describe("checkKey", () => {
  test("GET /v1/models: ok, rejected, unreachable", async () => {
    const ok = fakeFetch(200, { data: [] });
    assert.deepEqual(await createJevProvider({ key: () => null, fetch: ok.f }).checkKey(KEY), { ok: true });
    assert.equal(ok.calls[0]!.url, "https://api.typesafe.ai/v1/models");
    const bad = fakeFetch(401, { detail: { error_type: "authentication_error", message: "Cannot authenticate" } });
    const r = await createJevProvider({ key: () => null, fetch: bad.f }).checkKey(KEY);
    assert.equal(r.ok, false);
    assert.equal(r.failure, "auth");
    const gone = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.equal((await createJevProvider({ key: () => null, fetch: gone }).checkKey(KEY)).failure, "network");
  });
});
