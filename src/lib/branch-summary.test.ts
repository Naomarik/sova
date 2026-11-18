// Run: pnpm test -- src/lib/branch-summary.test.ts
// What a row shows for a branch summary (branch-summary.ts): nothing until anything is known, "Summarizing…" while
// written, the failure line (Try Again) only after a failure, an earlier commit's bullets marked, at most 5 bullets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchSummaryShown, RETRY_SETTLE_MS, retryAfter, type SummaryRetry } from "./branch-summary";

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

test("a taken Try Again reads Summarizing… where the error was, until the new summary or the error is back", () => {
  const failed = { commit: c, state: "failed" as const };
  const writing = { commit: c, state: "writing" as const };
  const ready = { commit: c, state: "ready" as const, bullets: ["New"] };
  const T = 1_000_000;
  const taken: SummaryRetry = { commit: c, at: T, sawWriting: false };
  const soon = T + RETRY_SETTLE_MS - 1;
  const later = T + RETRY_SETTLE_MS;
  // The reading it had, from a read that may have left before Try Again was taken: it waits, and the row says it is
  // being written, not the error.
  assert.deepEqual(retryAfter(failed, taken, soon), taken);
  assert.equal(branchSummaryShown(failed, taken)!.line, "writing");
  // Seen being written, the wait goes on; then whatever comes next ends it, however soon.
  const seen = retryAfter(writing, taken, soon)!;
  assert.deepEqual(seen, { commit: c, at: T, sawWriting: true });
  assert.equal(branchSummaryShown(writing, seen)!.line, "writing");
  assert.equal(retryAfter(writing, seen, later), seen);
  assert.equal(retryAfter(failed, seen, soon), null, "the error is back");
  assert.equal(retryAfter(ready, seen, soon), null, "the new summary is there");
  assert.deepEqual(branchSummaryShown(ready, null), { line: "none", bullets: ["New"], stale: false });
  // One that failed again at once is never caught being written: a later read that still says failed is the error, back.
  assert.equal(retryAfter(failed, taken, later), null);
  assert.equal(branchSummaryShown(failed, retryAfter(failed, taken, later))!.line, "failed");
  // Over as well when it ended with no read catching it being written, when the branch moved to another commit (whose
  // failure is its own), and when there is no summary to read at all.
  assert.equal(retryAfter(ready, taken, soon), null);
  assert.equal(retryAfter({ commit: "b".repeat(40), state: "failed" }, taken, soon), null);
  assert.equal(branchSummaryShown({ commit: "b".repeat(40), state: "failed" }, taken)!.line, "failed");
  assert.equal(retryAfter(undefined, taken, soon), null);
  // With no Try Again taken, nothing changes what a failure reads.
  assert.equal(retryAfter(failed, null, later), null);
  assert.equal(branchSummaryShown(failed, null)!.line, "failed");
});

test("Try Again only after a failure: a written summary has no failure line", () => {
  for (const state of ["ready", "writing"] as const) assert.notEqual(branchSummaryShown({ commit: c, state, bullets: ["x"] })!.line, "failed");
});
