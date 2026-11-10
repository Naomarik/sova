// §app.merge-queue/view's Retired list, read from the ledger with no git.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemovedWorktree } from "./removed-worktrees";
import { retirementCounts, retirementViewOf, type PendingFile } from "./worktree-retire-view";

const commonDir = "/p/main/.git";
const pending: PendingFile = { v: 1, repos: { [commonDir]: { main: "/p/main", commonDir, held: [], waiting: [], at: 1 } } };
const e = (branch: string, at: number, x: Partial<RemovedWorktree> = {}): RemovedWorktree => ({ v: 1, path: `/p/.worktrees/${branch}`, branch, commonDir, tip: "a".repeat(40), merged: "ancestor", branchDeleted: true, at, retired: true, pinned: true, ...x });

test("newest first by when it retired, whatever the file's order, before the cut to 20", () => {
  const ledger = [e("old", 1), ...Array.from({ length: 25 }, (_, i) => e(`b${i}`, 100 + i)), e("newest", 1000)];
  const view = retirementViewOf("/p/main", { pending, ledger: [e("middle", 110), ...ledger] });
  assert.equal(view.retired[0]!.branch, "newest");
  assert.deepEqual(view.retired.map((r) => r.at), [...view.retired.map((r) => r.at)].sort((a, b) => b - a));
  assert.equal(view.retired.length, 20);
  assert.equal(view.retiredTotal, 28);
});

test("one that came back, by Restore or a message, leaves the list and every count; another beside it stays", () => {
  const ledger = [e("restored", 10, { restoredAt: 20 }), e("back", 11, { backAt: 21 }), e("still", 12)];
  const view = retirementViewOf("/p/main", { pending, ledger });
  assert.deepEqual(view.retired.map((r) => [r.branch, r.restorable]), [["still", true]]);
  assert.equal(view.retiredTotal, 1);
  assert.deepEqual(retirementCounts(commonDir, 13, { pending, ledger }), { retired: 1 });
});
