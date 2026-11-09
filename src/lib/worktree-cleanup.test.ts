import assert from "node:assert/strict";
import test from "node:test";
import { anywayBody, anywayMore, lockLine, showsLine, summaryLine } from "./worktree-cleanup.ts";

const ok = (total: number, merged: number, empty: number) => ({ state: "ok" as const, repo: "/r", total, merged, empty, unmerged: total - merged - empty });

test("the line shows only for a repository with a linked worktree", () => {
  assert.equal(showsLine({ state: "none" }), false);
  assert.equal(showsLine(ok(0, 0, 0)), false);
  assert.equal(showsLine(null), false);
  assert.equal(showsLine(ok(1, 0, 0)), true);
});

test("the line counts every linked worktree, with held and retired only when there are some", () => {
  assert.equal(summaryLine(ok(1, 0, 0)), "1 worktree");
  assert.equal(summaryLine(ok(265, 227, 0)), "265 worktrees");
  assert.equal(summaryLine({ ...ok(160, 3, 0), held: 12 }), "160 worktrees · 12 held");
  assert.equal(summaryLine({ ...ok(160, 3, 0), held: 12, retired: 4 }), "160 worktrees · 12 held · 4 retired");
  assert.equal(summaryLine({ ...ok(2, 0, 0), retired: 1 }), "2 worktrees · 1 retired");
});

test("the line says retirement is off only on an install with an agent directory of its own", () => {
  assert.equal(summaryLine({ ...ok(2, 0, 0), offFor: "install" }), "2 worktrees · automatic cleanup is off for this install");
  for (const offFor of ["test", "setting", "unknown"] as const) assert.equal(summaryLine({ ...ok(2, 0, 0), offFor }), "2 worktrees");
});

test("a taken lock names who holds it, and says it retries", () => {
  assert.equal(lockLine("Sova, process 123"), "Cleanup couldn't start here: its lock looks taken (Sova, process 123). It tries again at the next wake-up.");
});

test("Remove Anyway's listing says what goes that git can't bring back, and how many a cut list leaves out", () => {
  const a = (uncommitted: number, ignored: number, nested: number) => ({ uncommitted: [], ignored: [], nested: [], rebuildable: [], counts: { uncommitted, ignored, nested, rebuildable: 0 }, digest: "d" });
  assert.equal(anywayBody(a(0, 1, 0)), "1 file is deleted with it. Git can't bring it back.");
  assert.equal(anywayBody(a(1, 3, 1)), "4 files and 1 nested repository are deleted with it. Git can't bring them back.");
  assert.equal(anywayBody(a(0, 0, 2)), "2 nested repositories are deleted with it. Git can't bring them back.");
  assert.equal(anywayMore(500, 500), null);
  assert.equal(anywayMore(500, 3512), "and 3012 more");
});
