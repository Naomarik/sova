import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeNumbers, NO_WORKTREES, readinessChip, readinessReason, worktreeChips, worktreesSummary, worktreeStatus } from "./worktrees";
import { readinessCount } from "./readiness";

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
  assert.deepEqual(worktreeChips({ exists: false, hasAgentDir: true, runningWorkers: 1 }).map((c) => c.label), ["Removed", ".agent", "1 worker"]);
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

test("a worktree tracked active whose folder is gone never reads Active: its chips and the count say what its work came to", () => {
  const gone = (g: "merged" | "unmerged" | "empty" | "unknown") => ({ status: "active" as const, exists: false, hasAgentDir: false, runningWorkers: 0, gone: g });
  const read = (w: ReturnType<typeof gone>) => [worktreeStatus(w).label, worktreeStatus(w).tone, ...worktreeChips(w).map((c) => c.label)];
  assert.deepEqual(read(gone("merged")), ["Merged", "success", "Cleaned up"]);
  assert.deepEqual(read(gone("unmerged")), ["Removed", "warn"]);
  assert.deepEqual(read(gone("unknown")), ["Removed", "warn"]);
  assert.deepEqual(read(gone("empty")), ["Removed", "neutral"]);
  for (const g of ["merged", "unmerged", "empty", "unknown"] as const) assert.notEqual(worktreeStatus(gone(g)).label, "Active");
  // Recorded merged or dropped, folder gone: the status chip stays, the extra chip says what happened.
  assert.deepEqual(worktreeChips({ status: "merged", merge: { target: "master", sha: "abc1234", how: "tool", at: 1 }, exists: false, hasAgentDir: false, runningWorkers: 0 }).map((c) => c.label), ["Cleaned up"]);
  assert.deepEqual(worktreeChips({ status: "dropped", exists: false, hasAgentDir: false, runningWorkers: 0 }).map((c) => c.label), ["Removed"]);
  // No readiness chip for removed: the status chip already says it.
  assert.equal(readinessChip({ readiness: { path: "/w", branch: "b", state: "removed", why: "not merged", reason: "Removed · not merged" } }), null);
  assert.equal(readinessReason({ readiness: { path: "/w", branch: "b", state: "removed", why: "not merged", reason: "Removed · not merged" } }), "Removed · not merged");
  assert.equal(worktreesSummary([{ status: "active" }, { status: "active", gone: "merged" }, { status: "active", gone: "unmerged" }, { status: "dropped" }]), "1 active · 1 merged · 1 removed · 1 dropped");
});

test("readinessChip's tone follows mergeability: success exactly where the row's count lights", () => {
  const tones = (["ready", "waiting-approval", "in-progress", "blocked", "stale"] as const).map((state) => {
    const chip = readinessChip({ readiness: { path: "/w", branch: "b", state } });
    const lit = readinessCount({ trees: [{ path: "/w", branch: "b", state }] } as never)!.ready;
    return [state, chip?.tone, lit];
  });
  assert.deepEqual(tones, [
    ["ready", "success", true],
    ["waiting-approval", "success", true],
    ["in-progress", "neutral", false],
    ["blocked", "warn", false],
    ["stale", "warn", false],
  ]);
});
