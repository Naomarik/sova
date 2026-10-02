// Run: npx tsx --test src/lib/coding-worktrees.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingWorktree } from "../../shared/project-overseer";
import { CODING_MODE_KEYS, codingModeKey, folderNote, codingModeLabel, codingModeOf, mergeGate, mergeNote, modeWords, offersMerge, offersRemove, promotionCommitLine, removeGate, startedBy, worktreeOrder } from "./coding-worktrees";

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

test("the folder line: removed; on another host, never 'missing' there; missing only on its own host", () => {
  assert.equal(folderNote(wt()), null);
  assert.equal(folderNote(wt({ state: "missing" })), "Worktree folder missing");
  assert.equal(folderNote(wt({ state: "missing", path: null })), "On another host: its worktree is there.");
  assert.equal(folderNote(wt({ state: "open", path: null })), "On another host: its worktree is there.");
  assert.equal(folderNote(wt({ state: "removed", path: null })), "Worktree removed");
  assert.equal(folderNote(wt({ state: "root", path: null, branch: null, worktree: null })), null);
});

test("the merge line: merged into its target; merged before, with commits since; else none", () => {
  assert.equal(mergeNote(wt()), null);
  assert.equal(mergeNote(wt({ state: "merged", merged: true, mergedAt: "2026-09-27T10:00:00Z" })), "Merged into");
  // Merged by hand: git says so, no record.
  assert.equal(mergeNote(wt({ state: "merged", merged: true })), "Merged into");
  // Merged, then removed with its branch: the record says so.
  assert.equal(mergeNote(wt({ state: "removed", merged: true, branchGone: true, mergedAt: "2026-09-27T10:00:00Z" })), "Merged into");
  // Merged once, then more commits: not merged now, and the record never says it is.
  const again = wt({ state: "open", merged: false, mergedAt: "2026-09-27T10:00:00Z", newSinceMerge: 3 });
  assert.equal(mergeNote(again), "3 new commits since the last merge into");
  assert.equal(offersMerge(again), true);
  assert.equal(mergeNote(wt({ merged: false, mergedAt: "2026-09-27T10:00:00Z", newSinceMerge: 1 })), "1 new commit since the last merge into");
});

test("row words", () => {
  assert.equal(startedBy(wt()), "Started by the overseer");
  assert.equal(startedBy(wt({ startedBy: "operator" })), "Started by you");
  assert.equal(startedBy(wt({ startedBy: "operator", via: "overseer" })), "Started by you, via the Overseer");
  assert.equal(startedBy(wt({ playbook: true })), "Project verbs playbook run · Started by the overseer", "a Project verbs run: labelled, by its real starter");
  assert.equal(startedBy(wt({ startedBy: "operator", playbook: true })), "Project verbs playbook run · Started by you");
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
