import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeNumbers, NO_WORKTREES, worktreeChips, worktreesSummary, worktreeStatus } from "./worktrees";

const merge = { target: "master", sha: "abc1234def", how: "tool" as const, at: 1 };

test("status: recorded merge, dropped, merged elsewhere, active — each says who did what", () => {
  const recorded = worktreeStatus({ status: "merged", merge });
  assert.deepEqual([recorded.label, recorded.detail, recorded.tone], ["Merged", "into master at abc1234", "success"]);
  assert.match(worktreeStatus({ status: "merged", merge: { ...merge, how: "detected" } }).title, /during one of this session's turns/);
  assert.equal(worktreeStatus({ status: "dropped" }).label, "Dropped");
  const elsewhere = worktreeStatus({ status: "active", mergedInto: { target: "main", sha: "0123456789" } });
  assert.deepEqual([elsewhere.label, elsewhere.detail], ["Merged", "into main at 0123456"]);
  assert.match(elsewhere.title, /didn't record the merge/);
  assert.deepEqual(worktreeStatus({ status: "active" }), { label: "Active", tone: "info", title: "Workers of this session may start here." });
});

test("chips: only what is true, in reading order", () => {
  assert.deepEqual(worktreeChips({ exists: true, hasAgentDir: false, runningWorkers: 0 }), []);
  assert.deepEqual(worktreeChips({ exists: false, hasAgentDir: true, runningWorkers: 1 }).map((c) => c.label), ["Missing", ".agent", "1 worker"]);
  assert.equal(worktreeChips({ exists: true, hasAgentDir: false, runningWorkers: 3 })[0]!.label, "3 workers");
});

test("summary and merge numbers", () => {
  assert.equal(worktreesSummary([{ status: "active" }, { status: "dropped" }, { status: "active" }]), "2 active · 1 dropped");
  assert.equal(worktreesSummary([]), NO_WORKTREES);
  assert.equal(NO_WORKTREES, "This session tracks no worktrees.");
  // Every status a row can have is counted, so no non-empty set can read as the empty sentence.
  for (const status of ["active", "merged", "dropped"] as const) assert.notEqual(worktreesSummary([{ status }]), NO_WORKTREES);
  assert.equal(mergeNumbers({ commits: 5, added: 120, removed: 30, fastForward: true }), "5 commits · +120 −30 · fast-forward");
  assert.equal(mergeNumbers({ commits: 1, added: 0, removed: 2, fastForward: false }), "1 commit · +0 −2 · merge commit");
});
