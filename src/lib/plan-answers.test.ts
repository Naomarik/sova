import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatonPlan } from "../../shared/baton";
import { isRecommended, openQuestions, planAcceptAllMessage, planAnswerMessage } from "./plan-answers";

const plan: BatonPlan = {
  doc: "al_1",
  title: "Online booking",
  summary: "Book a class from the website.",
  state: "open",
  findings: [],
  approach: [],
  rejected: [],
  questions: [
    { id: "q1", topic: "Who can book", ask: "Who can book?", options: [{ label: "Anyone", tradeoff: "More bookings." }, { label: "Members only", tradeoff: "Fewer no-shows." }], recommendation: { choice: "Anyone", why: "Simplest." } },
    { id: "q2", topic: "Pay", ask: "Pay when booking?", options: [{ label: "No", tradeoff: "Easy." }, { label: "Yes", tradeoff: "Fewer no-shows." }], recommendation: { choice: "No", why: "Start simple." } },
    { id: "q3", topic: "Done", ask: "Done?", options: [], recommendation: { choice: "Yes", why: "." }, decision: "Yes" },
  ],
};

test("Send My Answers words the picks as the alignment card does; the recommended option reads as the recommendation", () => {
  assert.equal(planAnswerMessage(plan, {}), "");
  assert.equal(planAnswerMessage(plan, { q1: 1 }), "al_1: my answers: 1b — Members only.");
  assert.equal(planAnswerMessage(plan, { q1: 0, q2: 1 }), "al_1: take your recommendation on q1. My answers: 2b — Yes.");
  assert.equal(planAnswerMessage(plan, { q1: "rec", q2: "rec" }), "al_1: take your recommendation on q1 and q2.");
  // A decided question sends nothing.
  assert.equal(planAnswerMessage(plan, { q3: "rec" }), "");
  assert.deepEqual(openQuestions(plan).map((q) => q.id), ["q1", "q2"]);
  assert.equal(isRecommended(plan.questions[0]!, 0), true);
  assert.equal(isRecommended(plan.questions[0]!, 1), false);
});

test("Go With Recommendations names the plan and never says go ahead (nothing is built here)", () => {
  assert.equal(planAcceptAllMessage(plan), "al_1: go with your recommendations for every open question.");
  assert.doesNotMatch(planAcceptAllMessage(plan), /go ahead/);
});
