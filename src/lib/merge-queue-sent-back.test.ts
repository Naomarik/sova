import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLandBlock, type MergeEntry, type QueueRowInput, queueRow, rowButtons, SENT_BACK_LINE, stillSentBack, type WorktreeQueueInfo } from "./merge-queue";

/**
 * al_4, as al_1 changed it: a branch the queue sent back to its chat (needs-fix) offers no Land until its chat fixes it:
 * a fix committed and the branch finished again at that newer commit, or (sent back for its drafts only) the queue
 * saying its drafts are fixed at the same commit (`redrafted`). Then the row is Ready with Land. Meanwhile, as al_3
 * changed it, every Needs a fix row offers only Remove from Queue: no re-land, the user's Land stands. The Land button and
 * its ▾ menu (Land Without Review, Land Without Its Specs…) are drawn only when rowButtons holds "Land"
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
    assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"], "never left without a button, never a re-land");
  }
});

test("sent back for its drafts, fixed at the same commit (the queue says redrafted): Ready, with Land at that commit", () => {
  const r = queueRow(wt({ queue: sentBack({ redrafted: true }), readiness: finishedAt(SENT) }));
  assert.equal(r.key, "ready");
  assert.equal(r.action, "land");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land"]);
  assert.equal(r.detail, SENT.slice(0, 7), "Land pins the same commit");
  // A check's send-back at the same commit never reads redrafted (the server says it only for drafts): still no Land.
  assert.equal(queueRow(wt({ queue: sentBack(), readiness: finishedAt(SENT) })).key, "needs-fix");
});

test("the tab's Sent back list: a redrafted entry leaves it (the Ready to land row, at the same commit, stands for it)", () => {
  const e = { id: "me_1", branch: "feat/x", commit: SENT, state: "needs-fix" } as MergeEntry;
  const ready = [{ branch: "feat/x", commit: SENT } as never];
  assert.deepEqual(stillSentBack({ needsFix: [e], ready }), [e], "not redrafted: still sent back at its commit");
  assert.deepEqual(stillSentBack({ needsFix: [{ ...e, redrafted: true }], ready }), []);
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

test("the Overseer's coding-worktree menu (no readiness): Land is off on a sent-back branch, with the standing line, until its drafts are fixed", () => {
  assert.equal(entryLandBlock(sentBack()), SENT_BACK_LINE);
  assert.equal(SENT_BACK_LINE, "Your Land stands: it goes back in line by itself once its chat's fix is checked.");
  assert.equal(entryLandBlock(sentBack({ state: "with-chat" })), SENT_BACK_LINE, "back with the chat: the same");
  assert.equal(entryLandBlock(sentBack({ redrafted: true })), undefined, "sent back for its drafts, fixed: Land on");
  for (const settled of ["superseded", "merged", "gone"] as const) assert.equal(entryLandBlock(sentBack({ settled })), undefined, `settled ${settled}: the row reads as the branch itself`);
  // In line: off as before; nothing in the queue, or Drafts changed (Land re-approves): on.
  for (const state of ["queued", "checking", "conflict", "behaviour-differs", "review-flagged"] as const) assert.equal(entryLandBlock(sentBack({ state })), "Already in the merge queue.", state);
  assert.equal(entryLandBlock(undefined), undefined);
  assert.equal(entryLandBlock(sentBack({ state: "drafts-changed" })), undefined);
});

test("no row offers a re-land or a Send Back, however far the branch moved or was rewritten (al_3)", () => {
  for (const x of [{}, { newerCommits: 2 }, { newerRewritten: true as const }, { newerCommits: 1, newerBlocked: "conflicts with master: 2 files" }]) {
    const r = queueRow(wt({ queue: sentBack(x) }));
    assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"], JSON.stringify(x));
    assert.equal(r.newer, undefined, "no 'newer commits included': nothing re-lands");
  }
  for (const state of ["behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "needs-fix", "with-chat", "needs-user", "queued", "checking", "conflict"] as const) {
    const b = rowButtons(queueRow(wt({ queue: sentBack({ state }) })), "prj_1") as string[];
    for (const gone of ["Send Back", "Land This Commit Again", "Land Newest Commit"]) assert.ok(!b.includes(gone), `${state}: ${gone}`);
  }
});

test("a sent-back row with no reason reads the standing line", () => {
  const r = queueRow(wt({ queue: sentBack({ newerCommits: 2, reason: undefined }) }));
  assert.equal(r.reason, SENT_BACK_LINE);
});
