// Run: npx tsx --test src/lib/align-picks.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlignDocInfo, AlignQuestionInfo } from "../../shared/protocol";
import { acceptAllMessage, clearPicks, composeWithPicks, pickCount, picksLabel, picksMessage, picksOf, prunePicks, samePicks, setPicks, togglePick, withPick, type Picks } from "./align-picks";

const q = (id: string, extra: Partial<AlignQuestionInfo> = {}): AlignQuestionInfo => ({ id, topic: id, ask: "?", recommendation: { choice: "x", why: "y" }, ...extra });
const decided = { text: "yes", by: "user" as const, at: "" };

const doc = (id: string, questions: AlignQuestionInfo[], extra: Partial<AlignDocInfo> = {}): AlignDocInfo => ({
  id,
  title: id,
  summary: "",
  findings: [],
  approach: [],
  rejected: [],
  questions,
  phase: "open",
  next: { f: 1, a: 1, x: 1, q: questions.length + 1 },
  rev: 1,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

test("withPick adds and removes, and a doc left with none goes", () => {
  let p: Picks = {};
  p = withPick(p, "al_3", "q3", true);
  p = withPick(p, "al_3", "q1", true);
  assert.deepEqual(p, { al_3: ["q3", "q1"] });
  assert.equal(withPick(p, "al_3", "q1", true), p, "ticking a ticked question changes nothing");
  p = withPick(p, "al_3", "q3", false);
  p = withPick(p, "al_3", "q1", false);
  assert.deepEqual(p, {});
});

test("prunePicks keeps open questions of open docs, in the card's order and the fold's doc order", () => {
  const entries = [
    { doc: doc("al_4", [q("q1"), q("q2")]) },
    { doc: doc("al_3", [q("q1"), q("q2", { decision: decided }), q("q3"), q("q4", { dropped: { why: "n/a", at: "" } })]) },
    { doc: doc("al_5", [q("q1")], { phase: "done" }) },
    { doc: doc("al_6", [q("q1")], { phase: "dropped" }) },
  ];
  const picks: Picks = { al_3: ["q4", "q3", "q2", "q1"], al_4: ["q2"], al_5: ["q1"], al_6: ["q1"], al_9: ["q1"] };
  const pruned = prunePicks(picks, entries);
  assert.deepEqual(Object.keys(pruned), ["al_4", "al_3"]);
  assert.deepEqual(pruned, { al_4: ["q2"], al_3: ["q1", "q3"] });
});

test("a revision that settles a ticked question drops that tick, and only that one", () => {
  const before = [{ doc: doc("al_3", [q("q1"), q("q2")]) }];
  const after = [{ doc: doc("al_3", [q("q1", { decision: { ...decided, by: "accepted-recommendation" } }), q("q2")], { rev: 2 }) }];
  const picks = prunePicks({ al_3: ["q1", "q2"] }, before);
  assert.deepEqual(prunePicks(picks, after), { al_3: ["q2"] });
});

test("the message is one line per alignment, in the align tool's accept wording", () => {
  assert.equal(picksMessage({ al_3: ["q1"] }), "al_3: take your recommendation on q1.");
  assert.equal(picksMessage({ al_3: ["q1", "q3"] }), "al_3: take your recommendation on q1 and q3.");
  assert.equal(picksMessage({ al_3: ["q1", "q2", "q3"], al_4: ["q2"] }), "al_3: take your recommendation on q1, q2 and q3.\nal_4: take your recommendation on q2.");
  assert.equal(picksMessage({}), "");
});

test("picks and typed text make one message: the picks line, a blank line, then the text", () => {
  const picks: Picks = { al_3: ["q1", "q3"] };
  assert.equal(composeWithPicks(picks, "q2: no, use X"), "al_3: take your recommendation on q1 and q3.\n\nq2: no, use X");
  assert.equal(composeWithPicks(picks, ""), "al_3: take your recommendation on q1 and q3.");
  assert.equal(composeWithPicks({}, "hello"), "hello", "no picks leaves the text exactly as typed");
});

test("the staged row names each alignment's ticked questions", () => {
  assert.equal(picksLabel({ al_3: ["q1", "q3"] }), "al_3 q1, q3");
  assert.equal(picksLabel({ al_3: ["q1", "q3"], al_4: ["q2"] }), "al_3 q1, q3; al_4 q2");
  assert.equal(pickCount({ al_3: ["q1", "q3"], al_4: ["q2"] }), 3);
});

test("the button's message is accept-all and a go-ahead, for that alignment only", () => {
  const m = acceptAllMessage("al_3");
  assert.equal(m, "al_3: go with your recommendations for every open question, and go ahead.");
  assert.ok(!/\bq\d/.test(m), "it names no question: every one still open when the agent reads it");
});

test("the store is per session path, and clearing one doc leaves the others", () => {
  togglePick("/a.jsonl", "al_3", "q1", true);
  togglePick("/a.jsonl", "al_4", "q2", true);
  togglePick("/b.jsonl", "al_3", "q2", true);
  assert.deepEqual(picksOf("/a.jsonl"), { al_3: ["q1"], al_4: ["q2"] });
  clearPicks("/a.jsonl", "al_3");
  assert.deepEqual(picksOf("/a.jsonl"), { al_4: ["q2"] });
  assert.deepEqual(picksOf("/b.jsonl"), { al_3: ["q2"] });
  clearPicks("/a.jsonl");
  setPicks("/b.jsonl", {});
  assert.deepEqual(picksOf("/a.jsonl"), {});
  assert.deepEqual(picksOf("/b.jsonl"), {});
  assert.ok(samePicks({ al_3: ["q1"] }, { al_3: ["q1"] }) && !samePicks({ al_3: ["q1"] }, { al_3: ["q2"] }));
});
