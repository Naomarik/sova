// Run: pnpm exec tsx --test src/lib/saved-sessions.test.ts. The Save Session gate, sizes and words (§chat/saved-sessions).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SAVE_LIMIT_BYTES, SAVE_WARN_BYTES, type SavedSessionRow, type SaveReviewItem } from "../../shared/session-bundle";
import {
  cardLine,
  cleaningLine,
  decisionsToSend,
  excerptParts,
  filterRows,
  modelLine,
  reviewLine,
  saveBlocked,
  sizeFor,
  sizeNote,
  sizeState,
  undecided,
  workerLine,
} from "./saved-sessions";

const secret: SaveReviewItem = { id: "s1", kind: "possible-secret", where: "bash result", excerpt: "KEY=[[abc]]", bytes: 3 };
const image: SaveReviewItem = { id: "i1", kind: "image", where: "You", excerpt: "", bytes: 2048, mimeType: "image/png" };
const gate = { title: "T", branches: ["main"], size: 10, review: [secret, image], decisions: {}, includeImages: true, busy: false };
const MB = 1024 * 1024;

test("Save stays disabled until every possible secret and image has a decision", () => {
  assert.equal(saveBlocked(gate), "Decide every possible secret and image first.");
  assert.equal(saveBlocked({ ...gate, decisions: { s1: "keep" } }), "Decide every possible secret and image first.");
  assert.equal(saveBlocked({ ...gate, decisions: { s1: "keep", i1: "remove" } }), null);
});

test("with images left out, no image needs a decision, and each is sent as removed", () => {
  assert.equal(saveBlocked({ ...gate, includeImages: false, decisions: { s1: "remove" } }), null);
  assert.deepEqual(undecided([secret, image], {}, false), [secret]);
  assert.deepEqual(decisionsToSend([secret, image], { s1: "keep", i1: "keep" }, false), { s1: "keep", i1: "remove" });
});

test("Save is disabled with no branch and over the limit, whatever was decided", () => {
  const decided = { ...gate, decisions: { s1: "keep" as const, i1: "keep" as const } };
  assert.equal(saveBlocked({ ...decided, branches: [] }), "Name at least one branch.");
  assert.equal(saveBlocked({ ...decided, size: SAVE_LIMIT_BYTES + 1 }), "Over the 50 MB limit.");
});

test("size states warn above 10 MB and refuse above 50 MB", () => {
  assert.equal(sizeState(SAVE_WARN_BYTES), "ok");
  assert.equal(sizeState(SAVE_WARN_BYTES + 1), "warn");
  assert.equal(sizeState(SAVE_LIMIT_BYTES + 1), "over");
  assert.equal(sizeNote(1), null);
  assert.match(sizeNote(SAVE_LIMIT_BYTES + 1)!, /^Over the 50 MB limit/);
});

test("the cleaning card leaves out zero parts, and says when everything is checked", () => {
  const c = { secretsRemoved: 2, possibleKept: 0, possibleRemoved: 0, imagesKept: 0, imagesRemoved: 0, thinkingDropped: 0, pathsRewritten: 1, absolutePathsLeft: 0, toolOutputsTrimmed: 0 };
  assert.equal(cleaningLine(c), "2 secrets removed · 1 path made portable");
  assert.equal(cleaningLine({ ...c, secretsRemoved: 0, pathsRewritten: 0, thinkingDropped: 3 }), "thinking left out");
  assert.equal(reviewLine([secret, image], {}, true), "1 possible secret and 1 image to check");
  assert.equal(reviewLine([secret, image], { s1: "keep" }, false), "Everything is checked.");
});

test("an excerpt's marked match is split out, wherever it sits", () => {
  assert.deepEqual(excerptParts("a [[b]] c"), [
    { text: "a ", match: false },
    { text: "b", match: true },
    { text: " c", match: false },
  ]);
  assert.deepEqual(excerptParts("[[x]]"), [{ text: "x", match: true }]);
  assert.deepEqual(excerptParts("plain"), [{ text: "plain", match: false }]);
});

test("the branch filter keeps rows tagged with that branch; none keeps all", () => {
  const row = (id: string, branches: string[]): SavedSessionRow => ({
    bundleId: id, rev: 1, title: id, savedBy: { name: "A" }, savedAt: "2026-10-01T00:00:00Z", branches, bytes: 1, approxTokens: 1, messages: 1, badge: null,
  });
  const rows = [row("a", ["feat/x"]), row("b", ["feat/y", "feat/x"]), row("c", ["main"])];
  assert.deepEqual(filterRows(rows, null).map((r) => r.bundleId), ["a", "b", "c"]);
  assert.deepEqual(filterRows(rows, "feat/x").map((r) => r.bundleId), ["a", "b"]);
});

test("the model notice names the fallback and why", () => {
  assert.equal(modelLine({ provider: "zai", id: "glm-5.3", saved: true }), "Continues on glm-5.3, the model it was saved with.");
  assert.equal(
    modelLine({ provider: "anthropic", id: "claude-x", saved: false, reason: "No zai key on this computer." }, { provider: "zai", id: "glm-5.3" }),
    "glm-5.3 isn't available here, so it continues on claude-x, your default. No zai key on this computer.",
  );
  assert.equal(workerLine({ kind: "team-member", team: "Alpha", role: "backend", task: "t", outcome: "done" }), "Alpha · backend · done");
});

test("a row's meta line leaves out what an unreadable card doesn't have", async () => {
  const { savedMetaLine } = await import("./saved-sessions");
  const row: SavedSessionRow = { bundleId: "x", rev: 0, title: "", savedBy: { name: "" }, savedAt: "", branches: [], bytes: 0, approxTokens: 0, messages: 0, badge: null, unreadable: "bad JSON" };
  assert.equal(savedMetaLine(row, ""), "");
  assert.equal(savedMetaLine({ ...row, savedBy: { name: "Bob" }, branches: ["a", "b"], bytes: 2048 }, "2h ago"), "Bob · a, b · 2 KB");
});

test("over the limit, Save waits for the user's own smaller choice", () => {
  const sizes = { whole: 60 * MB, wholeTrimmed: 20 * MB, sinceSummary: 5 * MB, sinceSummaryTrimmed: null };
  const decided = { ...gate, review: [], decisions: {} };
  assert.equal(saveBlocked({ ...decided, size: sizeFor(sizes, "whole", false) }), "Over the 50 MB limit.");
  assert.equal(saveBlocked({ ...decided, size: sizeFor(sizes, "whole", true) }), null);
  assert.equal(sizeFor(sizes, "since-summary", true), null);
});

test("the fallback reason always ends as a sentence", () => {
  assert.equal(
    modelLine({ provider: "zai", id: "glm-5.3", saved: false, reason: "No acme key on this computer" }, { provider: "acme", id: "ghost-1" }),
    "ghost-1 isn't available here, so it continues on glm-5.3, your default. No acme key on this computer.",
  );
});

test("the fallback names the saved model from the server's savedId, even with no card at hand", () => {
  assert.equal(
    modelLine({ provider: "zai", id: "glm-5.3", saved: false, savedId: "ghost-1" }),
    "ghost-1 isn't available here, so it continues on glm-5.3, your default.",
  );
});

test("the Saved sessions card counts every saved session, then New, Updated, unreadable and merged, leaving out zeros", () => {
  const r = (id: string, badge: SavedSessionRow["badge"], unreadable?: string): SavedSessionRow => ({
    bundleId: id, rev: 1, title: id, savedBy: { name: "A" }, savedAt: "", branches: [], bytes: 0, approxTokens: 0, messages: 0, badge, unreadable,
  });
  assert.equal(cardLine([]), "No saved sessions yet");
  assert.equal(cardLine(null), "Couldn't read them");
  assert.equal(cardLine([r("a", null), r("b", null)]), "2 saved");
  assert.equal(cardLine([r("a", "new"), r("b", null)]), "2 saved · 1 new");
  assert.equal(cardLine([r("a", "new"), r("b", "updated"), r("c", "new", "bad JSON")]), "3 saved · 2 new · 1 updated · 1 can't be read");
  assert.equal(cardLine([r("a", null)], 1), "1 saved · 1 branch merged");
  assert.equal(cardLine([], 2), "No saved sessions yet · 2 branches merged");
});
