// Run: npx tsx --test src/lib/coding-worktrees.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingSession, CodingWorktree } from "../../shared/project-overseer";
import type { SessionSummary } from "../../shared/protocol";
import { codingFromList, codingModeHint, codingRows, folderNote, mergeGate, mergeNote, offersMerge, offersRemove, promotionCommitLine, READING_BRANCH, removeGate, rowGestures, startedBy, worktreeOrder } from "./coding-worktrees";

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

test("the read-only mode line: this computer's defaults, mode words in mono, vis said as visuals", () => {
  const h = codingModeHint({ mode: "delegate", minorModes: ["spec", "vis"], subagents: { id: "house", name: "House" } });
  assert.equal(h.mode, "delegate · spec · visuals");
  assert.equal(
    h.before + h.mode + h.after,
    "Coding sessions start in delegate · spec · visuals, with the House subagent profile: this computer's defaults. Save as default in any chat's mode menu changes them.",
  );
  const none = codingModeHint({ mode: "normal", minorModes: [], subagents: null });
  assert.equal(none.before + none.mode + none.after, "Coding sessions start in normal: this computer's default mode. Save as default in any chat's mode menu changes it.");
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

/** The same session as the overseer read records it: no git facts. */
const rec = (over: Partial<CodingSession> = {}): CodingSession => ({
  sessionId: "s1",
  path: "/sessions/a.jsonl",
  title: "Build it",
  startedBy: "overseer",
  branch: "sova/build-it-abc123",
  base: "0123456789abcdef",
  target: "main",
  workers: 0,
  running: false,
  createdAt: "2026-09-27T10:00:00Z",
  ...over,
});

test("branch gestures stay disabled while a row has no branch facts, and follow git's once they arrive", () => {
  const [before] = codingRows([rec()], [], undefined);
  assert.equal(before!.facts, false);
  assert.deepEqual(rowGestures(before!), { merge: READING_BRANCH, remove: READING_BRANCH }, "both disabled, saying why");
  // A merged row would offer no Merge: until git says so, neither can run.
  const [merged] = codingRows([rec({ mergedAt: "2026-09-27T11:00:00Z" })], [], undefined);
  assert.deepEqual(rowGestures(merged!), { merge: READING_BRANCH, remove: READING_BRANCH });
  // Nothing to offer: a row in the root, a removed one.
  assert.deepEqual(rowGestures(codingRows([rec({ branch: null, later: true })], [], undefined)[0]!), { merge: false, remove: false });
  assert.deepEqual(rowGestures(codingRows([rec({ removedAt: "2026-09-27T11:00:00Z" })], [], undefined)[0]!), { merge: false, remove: false });
  // The facts arrive: git's gates.
  const [after] = codingRows([rec()], [], [wt()]);
  assert.equal(after!.facts, true);
  assert.deepEqual(rowGestures(after!), { merge: null, remove: null });
  assert.deepEqual(rowGestures(codingRows([rec()], [], [wt({ state: "merged", merged: true })])[0]!), { merge: false, remove: null });
  // The recorded row's working state is the fresher one.
  assert.deepEqual(rowGestures(codingRows([rec({ running: true })], [], [wt()])[0]!), { merge: "Session working", remove: "Session working" });
});

test("rows: the session list's before any read, the recorded ones after, git's facts merged in by session", () => {
  const list = [
    { id: "s1", path: "/sessions/a.jsonl", title: "Build it", createdAt: "2026-09-27T10:00:00Z", busy: true, project: { projectId: "prj_a", projectName: "A", kind: "coding", operator: true } },
    { id: "s2", path: "/sessions/b.jsonl", title: "Untitled", createdAt: "2026-09-28T10:00:00Z", busy: false, workers: { working: 2, total: 2 }, project: { projectId: "prj_a", projectName: "A", kind: "coding" } },
    { id: "s3", path: "/sessions/c.jsonl", title: "Folder", createdAt: "2026-09-28T10:00:00Z", busy: false, project: { projectId: "prj_a", projectName: "A", kind: "folder" } },
    { id: "s4", path: "/sessions/d.jsonl", title: "Other", createdAt: "2026-09-28T10:00:00Z", busy: false, project: { projectId: "prj_b", projectName: "B", kind: "coding" } },
  ] as unknown as SessionSummary[];
  const fromList = codingFromList(list, "prj_a");
  assert.deepEqual(
    fromList.map((r) => [r.sessionId, r.title, r.startedBy, r.running, r.workers]),
    [
      ["s1", "Build it", "operator", true, 0],
      ["s2", "", "overseer", false, 2],
    ],
  );
  // Before the overseer read: the list's rows, newest first, with no facts.
  assert.deepEqual(codingRows(undefined, fromList, undefined).map((r) => [r.sessionId, r.facts]), [["s2", false], ["s1", false]]);
  // Once it answers, its rows replace the list's; a row only the branch read knows is listed too.
  const rows = codingRows([rec()], fromList, [wt(), wt({ sessionId: "s9", createdAt: "2026-09-29T10:00:00Z" })]);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.facts]), [["s9", true], ["s1", true]]);
  // A `later` row adopted in the branch read: its branch is git's read's.
  const adopted = codingRows([rec({ branch: null, later: true })], [], [wt({ branch: "feat/pay", later: undefined })])[0]!;
  assert.deepEqual([adopted.branch, adopted.later], ["feat/pay", undefined]);
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
