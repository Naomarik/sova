import assert from "node:assert/strict";
import test from "node:test";
import { branchFate, confirmBody, confirmTitle, doneText, doneTitle, offersCleanup, removeLabel, showsLine, summaryLine } from "./worktree-cleanup.ts";

const ok = (total: number, merged: number, empty: number) => ({ state: "ok" as const, repo: "/r", total, merged, empty, unmerged: total - merged - empty });

test("the line shows only for a repository with a linked worktree", () => {
  assert.equal(showsLine({ state: "none" }), false);
  assert.equal(showsLine(ok(0, 0, 0)), false);
  assert.equal(showsLine(null), false);
  assert.equal(showsLine(ok(1, 0, 0)), true);
});

test("the line counts every linked worktree, and says empty leftovers only when there are some", () => {
  assert.equal(summaryLine(ok(1, 0, 0)), "1 worktree · 0 merged");
  assert.equal(summaryLine(ok(265, 227, 0)), "265 worktrees · 227 merged");
  assert.equal(summaryLine(ok(264, 227, 18)), "264 worktrees · 227 merged · 18 empty");
});

test("the button is offered while a merged or empty tree exists", () => {
  assert.equal(offersCleanup(ok(3, 0, 0)), false);
  assert.equal(offersCleanup(ok(3, 0, 1)), true);
  assert.equal(offersCleanup(ok(3, 2, 0)), true);
});

test("the dialog's words follow the dry run's count", () => {
  assert.equal(confirmTitle(1), "Remove 1 merged worktree?");
  assert.equal(confirmTitle(4), "Remove 4 merged worktrees?");
  assert.equal(confirmTitle(0), "Nothing to remove right now.");
  assert.equal(removeLabel(1), "Remove 1 Worktree");
  assert.equal(removeLabel(12), "Remove 12 Worktrees");
  assert.match(confirmBody(2, "master"), /in master is deleted too/);
  assert.equal(confirmBody(0, "master"), "Every worktree here stays, for the reasons below.");
});

test("a going branch says whether it is deleted", () => {
  assert.equal(branchFate({ path: "/a", branch: "feat/a", kind: "ancestor", branchDeleted: true }), "feat/a · branch deleted");
  assert.equal(branchFate({ path: "/b", branch: "feat/b", kind: "content", branchDeleted: false }), "feat/b · branch kept, merged by content");
  assert.equal(branchFate({ path: "/c", kind: "empty", branchDeleted: false }), "");
});

test("the result reads removed, then kept", () => {
  assert.equal(doneTitle(3, 2), "Removed 3 · kept 2");
  assert.equal(doneText(1, 0), "Removed 1 worktree. Kept 0.");
  assert.equal(doneText(0, 5), "Removed 0 worktrees. Kept 5.");
});
