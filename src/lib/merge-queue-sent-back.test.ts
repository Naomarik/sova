import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLandBlock, type QueueRowInput, queueRow, rowButtons, SENT_BACK_LINE, type WorktreeQueueInfo } from "./merge-queue";

/**
 * al_4: a branch the queue sent back to its chat (needs-fix) offers no Land anywhere until its chat commits a fix and
 * the branch reads finished again at that newer commit; then that commit wins and the row is Ready with Land. The Land
 * button and its ▾ menu (Land Without Review, Land Without Its Specs…) are drawn only when rowButtons holds "Land"
 * (WorktreesModal.tsx), so "no Land" here means no button and no menu items.
 */

const SENT = "a".repeat(40);
const FIX = "b".repeat(40);
const wt = (x: Partial<QueueRowInput> = {}): QueueRowInput => ({ status: "active", exists: true, branch: "feat/x", readiness: undefined, mergeServed: true, ...x });
const sentBack = (x: Partial<WorktreeQueueInfo> = {}): WorktreeQueueInfo =>
  ({ id: "me_1", state: "needs-fix", commit: SENT, notes: [], project: "prj_1", reason: "unit failed: src/a.test.ts", ...x }) as WorktreeQueueInfo;
const finishedAt = (commit: string) => ({ path: "/w", branch: "feat/x", state: "ready" as const, landing: { state: "ready" as const, commit } });

test("sent back, at its sent-back commit: Needs a fix, no Land button and no Land menu", () => {
  // As it was sent back (readiness unknown), and finished again at that same commit: neither brings Land back.
  for (const readiness of [undefined, finishedAt(SENT)]) {
    const r = queueRow(wt({ queue: sentBack(), readiness }));
    assert.equal(r.key, "needs-fix", JSON.stringify(readiness));
    assert.equal(r.label, "Needs a fix");
    assert.notEqual(r.action, "land", "no Land on a sent-back row");
    assert.deepEqual(rowButtons(r, "prj_1").filter((b) => b === "Land" || b === "Land Anyway"), [], "no Land button (and so no Land menu)");
  }
});

test("sent back, a newer commit not finished yet (uncommitted files, or still in progress): still no Land", () => {
  for (const readiness of [
    { path: "/w", branch: "feat/x", state: "in-progress" as const, dirtyCount: 2 },
    { path: "/w", branch: "feat/x", state: "in-progress" as const },
  ]) {
    const r = queueRow(wt({ queue: sentBack(), readiness }));
    assert.notEqual(r.action, "land", JSON.stringify(readiness));
    assert.ok(!rowButtons(r, "prj_1").includes("Land"));
  }
});

test("the same branch after a new commit, finished (clean, no conflicts, chat idle): Ready, with Land", () => {
  const r = queueRow(wt({ queue: sentBack(), readiness: finishedAt(FIX) }));
  assert.equal(r.key, "ready");
  assert.equal(r.label, "Ready");
  assert.equal(r.action, "land");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land"]);
});

test("the Overseer's coding-worktree menu (no readiness): Land is off on a sent-back branch, with the sent-back line", () => {
  assert.equal(entryLandBlock(sentBack()), SENT_BACK_LINE);
  assert.match(SENT_BACK_LINE, /Sent back to its chat/);
  // In line: off as before; nothing in the queue, or Drafts changed (Land re-approves): on.
  for (const state of ["queued", "checking", "conflict", "behaviour-differs", "review-flagged"] as const) assert.equal(entryLandBlock(sentBack({ state })), "Already in the merge queue.", state);
  assert.equal(entryLandBlock(undefined), undefined);
  assert.equal(entryLandBlock(sentBack({ state: "drafts-changed" })), undefined);
});
