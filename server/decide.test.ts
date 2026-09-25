// Run: npx tsx --test server/decide.test.ts — the pure seam: validation, normalization, confidence.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  choiceConfidence,
  DecisionError,
  estimateTokens,
  extractJsonObject,
  FALLS_THROUGH,
  normalizeAnswers,
  peakConfidence,
  validateQuestions,
  type Question,
} from "./decide";

const failureOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DecisionError, `not a DecisionError: ${String(err)}`);
    return err.failure;
  }
  return "no error";
};

const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);

describe("validateQuestions", () => {
  test("cardinality and empty instructions are bad requests, before any network", () => {
    assert.equal(failureOf(() => validateQuestions({ q: { type: "choice", instructions: "x", options: options(256) } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({ q: { type: "choice", instructions: "x", options: options(1) } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({ q: { type: "score", instructions: "x", levels: levels(11) } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({ q: { type: "score", instructions: "x", levels: levels(1) } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({ q: { type: "boolean", instructions: "  " } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({ q: { type: "boolean", instructions: {} } })), "bad-request");
    assert.equal(failureOf(() => validateQuestions({})), "bad-request");
  });
  test("the limits themselves are accepted", () => {
    assert.equal(failureOf(() => validateQuestions({ a: { type: "choice", instructions: "x", options: options(255) }, b: { type: "score", instructions: { rubric: "y" }, levels: levels(10) }, c: { type: "boolean", instructions: "z" } })), "no error");
  });
});

describe("the fall-through policy", () => {
  test("bad-request is the one failure the chain never moves past", () => {
    assert.equal(FALLS_THROUGH.has("bad-request"), false);
    for (const f of ["unavailable", "auth", "quota", "rate-limit", "overloaded", "timeout", "network", "too-large", "malformed-answer", "server"] as const) assert.ok(FALLS_THROUGH.has(f), f);
  });
});

describe("confidence (Jev's formula)", () => {
  test("pins the docs' worked number and the extremes", () => {
    assert.ok(Math.abs(choiceConfidence({ a: 0.88, b: 0.12, c: 0 }) - 0.82) < 1e-9);
    assert.equal(peakConfidence([0.25, 0.25, 0.25, 0.25]), 0);
    assert.equal(peakConfidence([0, 1, 0]), 1);
  });
});

describe("normalizeAnswers", () => {
  const qs: Record<string, Question> = {
    asks: { type: "boolean", instructions: "asks?" },
    outcome: { type: "choice", instructions: "outcome?", options: { done: "d", failed: null } },
    stuck: { type: "score", instructions: "stuck?", levels: ["no", "some", "yes"] },
  };
  test("renormalizes, clamps, picks argmax and the score expectation", () => {
    const a = normalizeAnswers(qs, { asks: { p: 1.3 }, outcome: { probabilities: { done: 0.6, failed: 0.6 } }, stuck: { probabilities: [-0.1, 0.5, 0.5] } });
    assert.deepEqual(a.asks, { type: "boolean", p: 1 });
    assert.equal(a.outcome?.type, "choice");
    if (a.outcome?.type === "choice") {
      assert.deepEqual(a.outcome.probabilities, { done: 0.5, failed: 0.5 });
      assert.equal(a.outcome.confidence, 0);
    }
    if (a.stuck?.type === "score") {
      assert.deepEqual(a.stuck.probabilities, [0, 0.5, 0.5]);
      assert.equal(a.stuck.score, 1.5);
    } else assert.fail("score");
  });
  test("score probabilities may come keyed \"0\"..\"n\" (Jev's shape)", () => {
    const a = normalizeAnswers({ s: qs.stuck! }, { s: { probabilities: { "0": 0, "1": 0, "2": 1 } } });
    assert.equal(a.s?.type === "score" && a.s.score, 2);
  });
  test("a missing id, an unknown option, a wrong shape → malformed-answer", () => {
    assert.equal(failureOf(() => normalizeAnswers(qs, { asks: { p: 0.1 }, outcome: { probabilities: { done: 1 } } })), "malformed-answer");
    assert.equal(failureOf(() => normalizeAnswers({ o: qs.outcome! }, { o: { probabilities: { done: 0.5, maybe: 0.5 } } })), "malformed-answer");
    assert.equal(failureOf(() => normalizeAnswers({ a: qs.asks! }, { a: { p: "high" } })), "malformed-answer");
    assert.equal(failureOf(() => normalizeAnswers({ s: qs.stuck! }, { s: { probabilities: [1, 0] } })), "malformed-answer");
    assert.equal(failureOf(() => normalizeAnswers(qs, [])), "malformed-answer");
  });
});

describe("extractJsonObject", () => {
  test("fenced, with prose around, with braces inside strings", () => {
    assert.deepEqual(extractJsonObject('Sure!\n```json\n{"a": {"p": 0.5}, "b": "x}y"}\n```\nDone.'), { a: { p: 0.5 }, b: "x}y" });
  });
  test("junk → malformed-answer", () => {
    assert.equal(failureOf(() => extractJsonObject("no json here")), "malformed-answer");
    assert.equal(failureOf(() => extractJsonObject("{\"a\": ")), "malformed-answer");
    assert.equal(failureOf(() => extractJsonObject("{a: 1}")), "malformed-answer");
  });
});

test("estimateTokens is chars/4 over the JSON text", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens({ a: "b" }), Math.ceil('{"a":"b"}'.length / 4));
});
