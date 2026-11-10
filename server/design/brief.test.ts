import assert from "node:assert/strict";
import { test } from "node:test";
import { designBriefBlock, designLinksIn, type DesignBrief, type DesignSetup } from "../../shared/design";
import { coordinatorWrote, linksFromText, mergeLinks, newBrief, turnEnded, userEditedPrompt, userEditedSummary, userTold } from "./brief";
import { cleanSetup } from "./setup";

const setup = (over: Partial<DesignSetup> = {}): DesignSetup => ({ brief: "x", models: [{ ref: "a/b", name: "b", design: true, coordinator: true, vision: true, route: "tool" }], directions: [{ name: "D", on: true }], ...over });
const settled = (prompt: string | null = "P", by: DesignBrief["promptBy"] = "coordinator"): DesignBrief => ({ ...newBrief(), summary: "S", prompt, promptBy: by, writing: null });

test("what Start waits for, in the order the card should say it", () => {
  const b = settled();
  const block = () => designBriefBlock({ brief: b, setup: setup() })?.code ?? null;
  assert.equal(block(), null);
  b.conflict = { cause: "told" };
  assert.equal(block(), "conflict");
  b.questions.push({ id: "q1", topic: "t", ask: "a", recommendation: { choice: "c", why: "w" } });
  assert.equal(block(), "question", "a question comes first: answering it may raise more");
  b.questions.length = 0;
  b.conflict = null;
  b.writing = { cause: "summary" };
  assert.equal(block(), "writing");
  b.writing = { cause: "summary", stalled: true };
  assert.equal(block(), "stalled");
  b.writing = null;
  assert.equal(designBriefBlock({ brief: b, setup: setup(), imagesBusy: "describing" })?.code, "images");
  assert.equal(designBriefBlock({ brief: b, setup: setup({ directions: [{ name: "D", on: false }] }) })?.code, "no-designs");
  assert.equal(designBriefBlock({ brief: undefined, setup: setup() })?.code, "writing");
});

test("a person's saved prompt: any later word is a choice; a coordinator-owned one just goes back to being written", () => {
  for (const change of [(b: DesignBrief) => userEditedSummary(b, "new"), (b: DesignBrief) => userTold(b)]) {
    const mine = settled("Mine", "user");
    change(mine);
    assert.ok(mine.conflict, "conflict");
    assert.equal(mine.writing, null);
    assert.equal(mine.prompt, "Mine");
    const its = settled();
    change(its);
    assert.equal(its.conflict, null);
    assert.ok(its.writing, "writing");
  }
});

test("a prompt the person saved launches at once, whatever was being written", () => {
  const b = settled(null, null);
  b.writing = { cause: "first", stalled: true };
  userEditedPrompt(b, "Mine");
  assert.equal(b.promptBy, "user");
  assert.equal(b.writing, null);
  assert.equal(designBriefBlock({ brief: b, setup: setup() }), null);
});

test("every edit by the coordinator or person raises the card's version; only text raises what baseRev is held to", () => {
  const b = settled();
  const rev = b.rev;
  const text = b.textRev;
  userTold(b);
  assert.deepEqual([b.rev, b.textRev], [rev + 1, text]);
  assert.equal(coordinatorWrote(b, { prompt: "new" }), null);
  assert.deepEqual([b.rev, b.textRev], [rev + 2, text + 1]);
});

test("a summary with the old prompt under it can't start: the prompt has to follow", () => {
  const b = settled();
  assert.equal(coordinatorWrote(b, { summary: "changed" }), null);
  assert.equal(b.writing?.cause, "summary");
  assert.equal(coordinatorWrote(b, { promptEdits: [{ find: "P", replace: "Q" }] }), null);
  assert.equal(b.writing, null);
  assert.equal(b.prompt, "Q");
});

test("questions keep their ids: replacing open ones never reuses one, and answered ones stay", () => {
  const b = newBrief();
  const q = { topic: "t", ask: "a", recommendation: { choice: "c", why: "w" } };
  coordinatorWrote(b, { summary: "S", questions: [q, q] });
  assert.deepEqual(b.questions.map((x) => x.id), ["q1", "q2"]);
  b.questions[0]!.answer = { text: "x", by: "you", at: "t" };
  coordinatorWrote(b, { questions: [q] });
  assert.deepEqual(b.questions.map((x) => x.id), ["q1", "q3"]);
});

test("a told turn settles when it ends; a required rewrite is reminded, then stalls; a question or an ask leaves it be", () => {
  const told = settled();
  userTold(told);
  assert.equal(turnEnded(told, false), null);
  assert.equal(told.writing, null);
  const must = settled();
  must.writing = { cause: "summary" };
  assert.equal(turnEnded(must, true), null, "waiting on the user");
  assert.equal(turnEnded(must, false), "nudge");
  assert.equal(turnEnded(must, false), null);
  assert.equal(must.writing?.stalled, true);
});

test("a whole address finds its way to Setup's row; the end of a sentence isn't part of it", () => {
  assert.deepEqual(designLinksIn("See https://a.test/x?y=1. Then http://b.test/, and localhost:3000/z or 127.0.0.1:9000"), ["https://a.test/x?y=1", "http://b.test/", "http://localhost:3000/z", "http://127.0.0.1:9000"]);
});

test("Setup's rows keep a choice for an address still there, drop the one removed, and take a click", () => {
  const prev = [{ url: "https://a.test", use: "feel" as const, by: "user" as const }, { url: "https://b.test", use: "images" as const, by: "user" as const }];
  assert.deepEqual(linksFromText("t", prev, ["https://a.test"]), [prev[0]]);
  assert.deepEqual(linksFromText("t", prev, ["https://c.test"], [{ url: "https://c.test", use: "images" }]), [{ url: "https://c.test", use: "images", by: "user" }]);
});

test("the coordinator's reading fills in a link, never over a person's click", () => {
  const s = setup({ links: [{ url: "https://a.test", use: "images", by: "user" }, { url: "https://b.test", use: null }] });
  mergeLinks(s, [{ url: "https://a.test", use: "feel" }, { url: "https://b.test", use: "feel" }, { url: "https://c.test", use: "images" }]);
  assert.deepEqual(s.links!.map((l) => [l.url, l.use, l.by]), [["https://a.test", "images", "user"], ["https://b.test", "feel", "coordinator"], ["https://c.test", "images", "coordinator"]]);
});

test("Change on the brief reopens only models and directions", () => {
  const before = setup({ brief: "Original", links: [{ url: "https://a.test", use: "feel" }] });
  const after = cleanSetup(before, { brief: "Replaced", models: [{ ref: "a/b", design: false, coordinator: false }], directions: [{ name: "D", on: false }] }, true) as DesignSetup;
  assert.equal(after.brief, "Original");
  assert.deepEqual(after.links, before.links);
  assert.equal(after.models[0]!.design, false);
  assert.equal(after.models[0]!.coordinator, true, "it is already running");
  assert.equal(after.directions[0]!.on, false);
});
