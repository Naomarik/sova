// A project's card declaration and the card's answers (§chat.transcript-cards/files, /answering), pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EAGER_TOOLS } from "./protocol.ts";
import { answerOf, CARD_TOOL, cardToolDescription, normalizeCardInfo, parseCardFile } from "./transcript-cards.ts";

const ok = (name: string, card: unknown, view = false) => parseCardFile(name, JSON.stringify(card), view);
const base = { version: 1, toolkit: 1, title: "T" };

test("card.json is strict: defaults, and the first thing wrong", () => {
  const q = ok("pick", { ...base, draws: "question", answer: "gather", when: "When asked." });
  assert.deepEqual(q, { ok: true, decl: { type: "project.pick", title: "T", when: "When asked.", draws: "question", answer: "gather", placement: "anchored" } });
  assert.deepEqual(ok("t", { ...base, draws: "table" }), { ok: true, decl: { type: "project.t", title: "T", draws: "table", answer: "none", placement: "anchored" } });
  const err = (card: unknown, re: RegExp, view = false) => {
    const r = ok("x", card, view);
    assert.ok(!r.ok && re.test(r.error), JSON.stringify(r));
  };
  err({ ...base, draws: "table", toolkit: 2 }, /toolkit must be 1/);
  err({ ...base, draws: "chart" }, /draws must be one of/);
  err({ ...base, draws: "question" }, /answer must be at-once or gather/);
  err({ ...base, draws: "table", data: {} }, /data is only for a view/);
  err({ ...base, draws: "view", data: { type: "object" }, height: 20 }, /height must be/, true);
  err({ ...base, draws: "status", when: "x".repeat(201) }, /when must be text of 1 to 200/);
  assert.equal(parseCardFile("1bad", "{}", false).ok, false);
});

test("answers are checked against the card's data and said in words", () => {
  const q = { draws: "question" as const, data: { title: "F", ask: "Which?", options: [{ label: "CSV" }, { label: "Parquet" }] } };
  assert.deepEqual(answerOf(q, { option: 1 }), { ok: true, value: { option: 1 }, text: "b: Parquet" });
  assert.equal(answerOf(q, { option: 2 }).ok, false);
  const c = { draws: "checklist" as const, data: { title: "C", items: [{ text: "a", done: false }, { text: "b", done: true }] } };
  assert.deepEqual(answerOf(c, { items: [true, true] }), { ok: true, value: { items: [true, true] }, text: "2 of 2 done" });
  assert.equal(answerOf(c, { items: [true] }).ok, false);
  assert.equal(answerOf({ draws: "status", data: { title: "S", tone: "ok", line: "x" } }, { option: 0 }).ok, false);
});

test("the tool's words come only from each type's when and shape; a card read back is checked", () => {
  const d = cardToolDescription({ v: 1, types: [{ type: "project.pick", title: "Pick", when: "When asked.", draws: "question", answer: "gather", placement: "follow" }, { type: "project.b", title: "B", draws: "status", answer: "none", placement: "anchored" }] });
  assert.match(d, /- project\.pick \(Pick\): When asked\. Data: \{title, ask/);
  assert.match(d, /Give a key/);
  assert.doesNotMatch(d, /project\.b/, "a type with no when isn't the agent's");
  assert.equal(normalizeCardInfo({ id: "cd_1" }), null);
});

test("the card tool's rows keep their details, so the page draws the agent's card, not a tool row", () => {
  assert.ok(EAGER_TOOLS.has(CARD_TOOL), "a slim card row would carry no card and draw as a plain tool call");
});
