// Run: pnpm test -- src/lib/branch-summary.test.ts
// What a row shows for a branch summary (branch-summary.ts): nothing until anything is known, "Summarizing…" while
// written, the failure line (Try Again) only after a failure, an earlier commit's bullets marked, at most 5 bullets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchSummaryShown } from "./branch-summary";

const c = "a".repeat(40);

test("nothing known, nothing shown", () => {
  assert.equal(branchSummaryShown(undefined), null);
  assert.equal(branchSummaryShown({ commit: c, state: "ready" }), null);
});

test("each state's line and bullets", () => {
  assert.deepEqual(branchSummaryShown({ commit: c, state: "writing" }), { line: "writing", bullets: [], stale: false });
  assert.deepEqual(branchSummaryShown({ commit: c, state: "failed" }), { line: "failed", bullets: [], stale: false });
  assert.deepEqual(branchSummaryShown({ commit: c, state: "ready", bullets: ["One", "Two"] }), { line: "none", bullets: ["One", "Two"], stale: false });
  assert.deepEqual(branchSummaryShown({ commit: c, state: "writing", bullets: ["Old"], stale: { commit: "b".repeat(40) } }), { line: "writing", bullets: ["Old"], stale: true });
  assert.equal(branchSummaryShown({ commit: c, state: "ready", bullets: ["1", "2", "3", "4", "5", "6", "7"] })!.bullets.length, 5);
});

test("Try Again only after a failure: a written summary has no failure line", () => {
  for (const state of ["ready", "writing"] as const) assert.notEqual(branchSummaryShown({ commit: c, state, bullets: ["x"] })!.line, "failed");
});
