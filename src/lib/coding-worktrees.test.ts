// Run: npx tsx --test src/lib/coding-worktrees.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingWorktree } from "../../shared/project-overseer";
import { CODING_MODE_KEYS, codingModeKey, codingModeLabel, codingModeOf, mergeGate, modeWords, offersMerge, offersRemove, promotionCommitLine, removeGate, startedBy, worktreeOrder } from "./coding-worktrees";

const wt = (over: Partial<CodingWorktree> = {}): CodingWorktree => ({
  sessionId: "s1",
  path: "/sessions/a.jsonl",
  title: "Build it",
  startedBy: "overseer",
  worktree: "/src/.worktrees/app-build-it-abc123",
  branch: "sova/build-it-abc123",
  base: "0123456789abcdef",
  target: "main",
  state: "open",
  ahead: 2,
  dirty: false,
  merged: false,
  workers: 0,
  running: false,
  createdAt: "2026-09-27T10:00:00Z",
  ...over,
}) as CodingWorktree;

test("mode keys round-trip; Automatic is null", () => {
  for (const k of CODING_MODE_KEYS) assert.equal(codingModeKey(codingModeOf(k)), k);
  assert.equal(codingModeOf("auto"), null);
  assert.deepEqual(codingModeOf("delegate+spec"), { mode: "delegate", minorModes: ["spec"] });
  assert.equal(codingModeKey({ mode: "normal", minorModes: [] }), "normal");
  assert.equal(codingModeLabel("normal+spec"), "normal · spec");
  assert.equal(codingModeLabel("auto"), "Automatic");
  assert.equal(modeWords({ mode: "normal", minorModes: [] }), "normal");
});

test("gestures: which are offered", () => {
  assert.equal(offersMerge(wt()), true);
  assert.equal(offersMerge(wt({ state: "merged", merged: true })), false);
  // Removed before a merge: the branch is still there to merge.
  assert.equal(offersMerge(wt({ state: "removed" })), true);
  assert.equal(offersMerge(wt({ state: "removed", merged: true })), false);
  assert.equal(offersMerge(wt({ state: "root", branch: null })), false);
  // Its folder deleted by hand: the branch can still be merged.
  assert.equal(offersMerge(wt({ state: "missing" })), true);
  assert.equal(offersMerge(wt({ state: "missing", merged: true })), false);
  // Its branch deleted: nothing left to merge.
  assert.equal(offersMerge(wt({ state: "removed", branchGone: true })), false);
  assert.equal(offersRemove(wt()), true);
  assert.equal(offersRemove(wt({ state: "merged", merged: true })), true);
  assert.equal(offersRemove(wt({ state: "removed" })), false);
  assert.equal(offersRemove(wt({ state: "missing" })), false);
  assert.equal(offersRemove(wt({ state: "root", branch: null })), false);
});

test("gates: another host, then the session, then its workers", () => {
  assert.equal(mergeGate(wt()), null);
  assert.equal(mergeGate(wt({ path: null, running: true })), "On another host");
  assert.equal(mergeGate(wt({ running: true, workers: 2 })), "Session working");
  assert.equal(removeGate(wt({ workers: 1 })), "Workers running");
});

test("row words", () => {
  assert.equal(startedBy(wt()), "Started by the overseer");
  assert.equal(startedBy(wt({ startedBy: "operator" })), "Started by you");
  const order = worktreeOrder([wt({ sessionId: "a", createdAt: "2026-09-27T09:00:00Z" }), wt({ sessionId: "b", createdAt: "2026-09-27T11:00:00Z" })]).map((w) => w.sessionId);
  assert.deepEqual(order, ["b", "a"]);
});

test("promotion commit line", () => {
  assert.equal(promotionCommitLine(undefined), null);
  assert.deepEqual(promotionCommitLine({ sha: "abcdef1234", branch: "main", files: [".sova/spec/manifest.json", ".sova/spec/claims/x.md"], message: "m" }), {
    tone: "success",
    text: "Committed abcdef1 on main.",
  });
  assert.equal(promotionCommitLine({ skipped: "Not committed: the root is mid-rebase." })!.text, "Not committed: the root is mid-rebase.");
  assert.deepEqual(promotionCommitLine({ skipped: "The project root is mid-merge." }), { tone: "warn", text: "Not committed: the project root is mid-merge.", reason: "The project root is mid-merge." });
});
