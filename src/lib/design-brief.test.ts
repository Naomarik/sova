import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignBrief, DesignBriefQuestion, DesignSetup } from "../../shared/design";
import { answerLine, coordinatorChangeLine, assetsOfRun, assetKindWord, briefStatus, imageUsed, kindChoices, parseShotWords, shotWordsToSave, pickIsRecommended, runScreenshots, screenUseOf, shotWordsText, usedCount, recommendedPick, setupLinks, stagedAnswers, startLabel, withLinkUse } from "./design-brief";

const q = (id: string, over: Partial<DesignBriefQuestion> = {}): DesignBriefQuestion => ({
  id,
  topic: "Prices",
  ask: "Which?",
  options: [
    { label: "Monthly", tradeoff: "" },
    { label: "Yearly", tradeoff: "" },
  ],
  recommendation: { choice: "Yearly", why: "" },
  ...over,
});
const noOptions = (id: string) => q(id, { options: undefined, recommendation: { choice: "Keep the header", why: "" } });
const brief = (over: Partial<DesignBrief> = {}): DesignBrief => ({ rev: 1, textRev: 1, summary: "s", prompt: "p", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {}, ...over });
const setup = (over: Partial<DesignSetup> = {}): DesignSetup => ({
  brief: "x",
  models: [{ ref: "a/b", name: "b", design: true, coordinator: true, vision: true, route: "tool" }],
  directions: [{ name: "Minimal", on: true }],
  ...over,
});

test("a recommendation as a pick takes the option it names, else its words", () => {
  assert.deepEqual(recommendedPick(q("q1")), { option: 1 });
  assert.deepEqual(recommendedPick(noOptions("q2")), { text: "Keep the header" });
});

test("a pick reads as the recommendation only when it is it", () => {
  assert.equal(pickIsRecommended(q("q1"), { option: 1 }), true);
  assert.equal(pickIsRecommended(q("q1"), { option: 0 }), false);
  assert.equal(pickIsRecommended(q("q1"), undefined), false);
});

test("Send Answers carries open questions' picks only, and never an empty one", () => {
  const answered = q("q3", { answer: { option: 0, by: "you", at: "t" } });
  const sent = stagedAnswers({ q1: { option: 0 }, q2: { text: "  " }, q3: { option: 1 }, q4: { text: " mine " } }, [q("q1"), noOptions("q2"), answered, noOptions("q4")]);
  assert.deepEqual(sent, [
    { id: "q1", option: 0 },
    { id: "q4", text: "mine" },
  ]);
});

test("the run's chip names the wait from the server's own reason", () => {
  assert.deepEqual(briefStatus({ brief: brief({ prompt: null, writing: { cause: "first" } }), setup: setup() }), { text: "Writing the prompt", live: true });
  assert.deepEqual(briefStatus({ brief: brief({ questions: [q("q1")] }), setup: setup() }), { text: "Waiting on you", live: false });
  assert.equal(briefStatus({ brief: brief({ writing: { cause: "told", stalled: true } }), setup: setup() }).live, false);
});

test("Start's label counts designs when nothing blocks, else says why", () => {
  assert.equal(startLabel({ brief: brief(), setup: setup() }, 1), "Start 1 Design");
  assert.equal(startLabel({ brief: brief(), setup: setup() }, 6), "Start 6 Designs");
  assert.equal(startLabel({ brief: brief({ questions: [q("q1"), q("q2")] }), setup: setup() }, 6), "Answer 2 Questions First");
});

const text = "Redo https://example.com/pricing and see https://other.example/";

test("Setup's link rows come from the text, keeping a choice made", () => {
  const rows = setupLinks({ brief: text, links: [{ url: "https://example.com/pricing", use: "feel", by: "user" }, { url: "https://gone.example/", use: "images" }] });
  assert.deepEqual(rows, [
    { url: "https://example.com/pricing", use: "feel", by: "user" },
    { url: "https://other.example/", use: null },
  ]);
});

test("choosing one link's use leaves the others", () => {
  assert.deepEqual(withLinkUse(setup({ brief: text }), "https://other.example/", "images").links, [
    { url: "https://example.com/pricing", use: null },
    { url: "https://other.example/", use: "images", by: "user" },
  ]);
});

test("a frozen answer's line says what was picked and by whom", () => {
  assert.equal(answerLine(q("q1", { answer: { option: 0, by: "you", at: "t" } })), "Monthly · you");
  assert.equal(answerLine(q("q1", { answer: { text: "Both", by: "you", at: "t" } })), "Both · you");
  assert.equal(answerLine(q("q1", { answer: { option: 1, text: "for now", by: "recommended", at: "t" } })), "Yearly: for now · recommended");
  assert.equal(answerLine(q("q1")), "Not answered");
});

const asset = (name: string, over: Record<string, unknown> = {}) => ({ name, source: "page", addedAt: "2026-11-10T01:00:00Z", ...over }) as never;
const capture = (url: string, names: string[]) => ({ url, names }) as never;

test("a run's grid is its Use Its Images links' captures in their order, then images you added since it began", () => {
  const run = { createdAt: "2026-11-10T00:30:00Z", setup: setup({ links: [{ url: "https://shop.example/pricing", use: "images" }, { url: "https://feel.example/", use: "feel" }] }) };
  const catalogue = {
    assets: [asset("a1"), asset("a2"), asset("a3"), asset("a4", { source: "yours" }), asset("a5", { source: "yours", addedAt: "2026-11-10T00:00:00Z" })],
    captures: [capture("https://shop.example/other", ["a2", "a1"]), capture("https://feel.example/", ["a3"])],
  };
  assert.deepEqual(assetsOfRun(catalogue, run).map((a) => a.name), ["a2", "a1", "a4"]);
  assert.deepEqual(assetsOfRun(null, run), []);
});

test("an image is used unless unticked, and a click not yet confirmed counts", () => {
  const b = { imageUse: { a1: { use: false, by: "user" as const } } };
  assert.equal(imageUsed(b, {}, "a1"), false);
  assert.equal(imageUsed(b, {}, "a2"), true);
  assert.equal(imageUsed(b, { a1: true }, "a1"), true);
  assert.equal(usedCount([asset("a1"), asset("a2")], {}, b), 1);
});

test("a later run's Setup says when the coordinator changes, and nothing when it doesn't", () => {
  const s = setup();
  assert.equal(coordinatorChangeLine(s, "a/b"), "");
  assert.equal(coordinatorChangeLine(s, "other/model"), "This starts a new Creative Director on b; it keeps the notes, not the conversation.");
});

test("a page capture's image is never offered screenshot; a pasted one is", () => {
  assert.equal(kindChoices({ source: "page" }).includes("screenshot"), false);
  assert.equal(kindChoices({ source: "yours" }).includes("screenshot"), true);
});

test("the kind shown is the user's, then the Creative Director's, then the helper's", () => {
  const described = { description: { kind: "photo", description: "", placement: "", usage: "", at: "t" } };
  assert.equal(assetKindWord(asset("a1", { source: "yours", ...described, cdKind: "screenshot" })), "screenshot");
  assert.equal(assetKindWord(asset("a1", { source: "yours", ...described, cdKind: "screenshot", chosenKind: "photo" })), "photo");
});

test("Start waits for each ticked screenshot's Rebuild or Just Its Feel; an unticked one or a page image doesn't count", () => {
  const shot = (name: string, source = "yours") => asset(name, { source, chosenKind: "screenshot" });
  const assets = [shot("a1"), shot("a2"), shot("a3", "page"), asset("a4", { source: "yours", chosenKind: "photo" })];
  const b = brief({ imageUse: { a2: { use: false, by: "user" } } });
  const names = runScreenshots(assets, b);
  assert.deepEqual(names, ["a1"]);
  const run = { brief: b, setup: setup() };
  assert.equal(startLabel(run, 2, names), "Choose Rebuild or Just Its Feel");
  assert.equal(startLabel({ ...run, brief: { ...b, screenUse: { a1: { use: "feel", by: "coordinator" } } } }, 2, names), "Start 2 Designs");
});

test("a screenshot's choice: a click not yet confirmed, then the brief's, else none", () => {
  const b = brief({ screenUse: { a1: { use: "rebuild", by: "coordinator" } } });
  assert.equal(screenUseOf(b, {}, "a1"), "rebuild");
  assert.equal(screenUseOf(b, { a1: "feel" }, "a1"), "feel");
  assert.equal(screenUseOf(b, {}, "a2"), null);
});

test("a screenshot's words edit as one text and read back as feel and colours with roles", () => {
  const w = { feel: "Calm, airy, lots of white.", colors: [{ hex: "#1e1e26", role: "background" }, { hex: "#8e88ff", role: "" }] };
  const text = shotWordsText(w);
  assert.equal(text, "Calm, airy, lots of white.\n\n#1e1e26 background\n#8e88ff");
  assert.deepEqual(parseShotWords(text), w);
  assert.deepEqual(parseShotWords("Dark and dense.\n#FFF — text\n#4A43D8: accent"), { feel: "Dark and dense.", colors: [{ hex: "#ffffff", role: "text" }, { hex: "#4a43d8", role: "accent" }] });
});

test("typed colours are kept as #rrggbb, as the server stores them: #rgb spelled out, an alpha dropped", () => {
  assert.deepEqual(parseShotWords("#fff page background\n#4a43d8cc accent\n#0f08 text").colors, [
    { hex: "#ffffff", role: "page background" },
    { hex: "#4a43d8", role: "accent" },
    { hex: "#00ff00", role: "text" },
  ]);
});

test("Save sends null when nothing is left, and refuses more than 8 colours with why", () => {
  assert.equal(shotWordsToSave("  \n "), null);
  assert.deepEqual(shotWordsToSave("Calm."), { feel: "Calm.", colors: [] });
  const nine = Array.from({ length: 9 }, (_, i) => `#00000${i}`).join("\n");
  assert.throws(() => shotWordsToSave(nine), /Keep it to 8 colours; this has 9/);
});
