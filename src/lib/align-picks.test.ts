// Run: npx tsx --test src/lib/align-picks.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlignDocInfo, AlignQuestionInfo } from "../../shared/protocol";
import { acceptAllMessage, choosePick, clearPicks, composeWithPicks, optionPick, pickCount, picksLabel, picksMessage, picksOf, prunePicks, samePicks, setPicks, withPick, type Picks } from "./align-picks";

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

const rec = (qid: string) => ({ q: qid });
const opt = (qid: string, index: number, label: string) => ({ q: qid, option: { index, label } });
const withOpts = (id: string, recChoice = "CSV") => q(id, { options: [{ label: "CSV", tradeoff: "" }, { label: "Parquet", tradeoff: "" }], recommendation: { choice: recChoice, why: "" } });

test("withPick sets, replaces and clears one pick per question, and a doc left with none goes", () => {
  let p: Picks = {};
  p = withPick(p, "al_3", "q3", rec("q3"));
  p = withPick(p, "al_3", "q1", rec("q1"));
  assert.deepEqual(p, { al_3: [rec("q3"), rec("q1")] });
  assert.equal(withPick(p, "al_3", "q1", rec("q1")), p, "picking the same answer again changes nothing");
  p = withPick(p, "al_3", "q3", opt("q3", 1, "Parquet"));
  assert.deepEqual(p, { al_3: [opt("q3", 1, "Parquet"), rec("q1")] }, "an option replaces the question's recommendation, in place");
  p = withPick(p, "al_3", "q3", opt("q3", 0, "CSV"));
  assert.equal(p.al_3!.filter((x) => x.q === "q3").length, 1, "still one pick for q3");
  p = withPick(p, "al_3", "q1", opt("q1", 1, "Parquet"));
  p = withPick(p, "al_3", "q1", rec("q1"));
  assert.deepEqual(p.al_3!.find((x) => x.q === "q1"), rec("q1"), "the recommendation replaces an option too");
  p = withPick(p, "al_3", "q3", null);
  p = withPick(p, "al_3", "q1", null);
  assert.deepEqual(p, {});
  assert.equal(withPick(p, "al_3", "q1", null), p, "clearing nothing changes nothing");
});

test("picking the option the recommendation names is the recommendation, and any other option is itself", () => {
  const question = withOpts("q2", "**Parquet** — smaller files");
  assert.deepEqual(optionPick(question, 1), rec("q2"), "b is what the recommendation names");
  assert.deepEqual(optionPick(question, 0), opt("q2", 0, "CSV"));
  assert.deepEqual(optionPick(q("q4", { options: [{ label: "A", tradeoff: "" }], recommendation: { choice: "neither", why: "" } }), 0), opt("q4", 0, "A"), "a recommendation naming no option matches none");
});

test("prunePicks keeps open questions of open docs, in the card's order and the fold's doc order", () => {
  const entries = [
    { doc: doc("al_4", [q("q1"), q("q2")]) },
    { doc: doc("al_3", [q("q1"), q("q2", { decision: decided }), q("q3"), q("q4", { dropped: { why: "n/a", at: "" } })]) },
    { doc: doc("al_5", [q("q1")], { phase: "done" }) },
    { doc: doc("al_6", [q("q1")], { phase: "dropped" }) },
  ];
  const picks: Picks = { al_3: [rec("q4"), rec("q3"), rec("q2"), rec("q1")], al_4: [rec("q2")], al_5: [rec("q1")], al_6: [rec("q1")], al_9: [rec("q1")] };
  const pruned = prunePicks(picks, entries);
  assert.deepEqual(Object.keys(pruned), ["al_4", "al_3"]);
  assert.deepEqual(pruned, { al_4: [rec("q2")], al_3: [rec("q1"), rec("q3")] });
});

test("a revision that settles a picked question drops that pick, and only that one", () => {
  const before = [{ doc: doc("al_3", [withOpts("q1"), withOpts("q2")]) }];
  const after = [{ doc: doc("al_3", [withOpts("q1"), { ...withOpts("q2"), decision: decided }], { rev: 2 }) }];
  const picks = prunePicks({ al_3: [rec("q1"), opt("q2", 1, "Parquet")] }, before);
  assert.deepEqual(picks, { al_3: [rec("q1"), opt("q2", 1, "Parquet")] });
  assert.deepEqual(prunePicks(picks, after), { al_3: [rec("q1")] });
});

test("an option pick drops when its option's label changes or the option goes, and keeps otherwise", () => {
  const picks: Picks = { al_3: [opt("q1", 1, "Parquet"), opt("q2", 1, "Parquet"), opt("q3", 1, "Parquet")] };
  const renamed = { ...withOpts("q2"), options: [{ label: "CSV", tradeoff: "" }, { label: "Avro", tradeoff: "" }] };
  const shrunk = { ...withOpts("q3"), options: [{ label: "CSV", tradeoff: "" }] };
  const tradeoffEdited = { ...withOpts("q1"), options: [{ label: "CSV", tradeoff: "" }, { label: "Parquet", tradeoff: "now columnar" }] };
  assert.deepEqual(prunePicks(picks, [{ doc: doc("al_3", [tradeoffEdited, renamed, shrunk]) }]), { al_3: [opt("q1", 1, "Parquet")] });
});

test("an option pick the recommendation comes to name reads as the recommendation", () => {
  const picks: Picks = { al_3: [opt("q1", 1, "Parquet")] };
  assert.deepEqual(prunePicks(picks, [{ doc: doc("al_3", [withOpts("q1", "Parquet")], { rev: 2 }) }]), { al_3: [rec("q1")] });
});

test("the message is one line per alignment: recommendations in the align tool's accept wording, then the options as typed", () => {
  assert.equal(picksMessage({ al_3: [rec("q1")] }), "al_3: take your recommendation on q1.");
  assert.equal(picksMessage({ al_3: [rec("q1"), rec("q3")] }), "al_3: take your recommendation on q1 and q3.");
  assert.equal(picksMessage({ al_3: [rec("q1"), rec("q2"), rec("q3")], al_4: [rec("q2")] }), "al_3: take your recommendation on q1, q2 and q3.\nal_4: take your recommendation on q2.");
  assert.equal(
    picksMessage({ al_3: [rec("q1"), opt("q2", 1, "Parquet"), opt("q4", 0, "1 per 10 min")] }),
    "al_3: take your recommendation on q1. My answers: 2b — Parquet; 4a — 1 per 10 min.",
  );
  assert.equal(picksMessage({ al_3: [opt("q2", 1, "Parquet")], al_4: [rec("q1")] }), "al_3: my answers: 2b — Parquet.\nal_4: take your recommendation on q1.");
  assert.equal(picksMessage({}), "");
});

test("picks and typed text make one message: the picks line, a blank line, then the text", () => {
  const picks: Picks = { al_3: [rec("q1"), rec("q3")] };
  assert.equal(composeWithPicks(picks, "q2: no, use X"), "al_3: take your recommendation on q1 and q3.\n\nq2: no, use X");
  assert.equal(composeWithPicks(picks, ""), "al_3: take your recommendation on q1 and q3.");
  assert.equal(composeWithPicks({}, "hello"), "hello", "no picks leaves the text exactly as typed");
});

test("the staged row names each alignment's picked questions and what each takes", () => {
  assert.equal(picksLabel({ al_3: [rec("q1"), rec("q3")] }), "al_3 q1 rec, q3 rec");
  assert.equal(picksLabel({ al_3: [rec("q1"), opt("q2", 1, "Parquet")], al_4: [opt("q2", 0, "CSV")] }), "al_3 q1 rec, q2 b; al_4 q2 a");
  assert.equal(pickCount({ al_3: [rec("q1"), opt("q2", 1, "Parquet")], al_4: [rec("q2")] }), 3);
});

test("the button's message is accept-all and a go-ahead, for that alignment only", () => {
  const m = acceptAllMessage("al_3");
  assert.equal(m, "al_3: go with your recommendations for every open question, and go ahead.");
  assert.ok(!/\bq\d/.test(m), "it names no question: every one still open when the agent reads it");
});

test("the store is per session path, and clearing one doc leaves the others", () => {
  choosePick("/a.jsonl", "al_3", "q1", rec("q1"));
  choosePick("/a.jsonl", "al_4", "q2", opt("q2", 1, "Parquet"));
  choosePick("/b.jsonl", "al_3", "q2", rec("q2"));
  assert.deepEqual(picksOf("/a.jsonl"), { al_3: [rec("q1")], al_4: [opt("q2", 1, "Parquet")] });
  clearPicks("/a.jsonl", "al_3");
  assert.deepEqual(picksOf("/a.jsonl"), { al_4: [opt("q2", 1, "Parquet")] });
  assert.deepEqual(picksOf("/b.jsonl"), { al_3: [rec("q2")] });
  clearPicks("/a.jsonl");
  setPicks("/b.jsonl", {});
  assert.deepEqual(picksOf("/a.jsonl"), {});
  assert.deepEqual(picksOf("/b.jsonl"), {});
  assert.ok(samePicks({ al_3: [rec("q1")] }, { al_3: [rec("q1")] }) && !samePicks({ al_3: [rec("q1")] }, { al_3: [rec("q2")] }));
  assert.ok(!samePicks({ al_3: [rec("q1")] }, { al_3: [opt("q1", 0, "CSV")] }) && !samePicks({ al_3: [opt("q1", 0, "CSV")] }, { al_3: [opt("q1", 1, "CSV")] }));
});
