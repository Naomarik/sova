import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLandBlock, landThisAgainOf, type MergeEntry, type QueueRowInput, queueRow, rowButtons, SENT_BACK_LINE, stillSentBack, type WorktreeQueueInfo } from "./merge-queue";

/**
 * al_4, as al_1 changed it: a branch the queue sent back to its chat (needs-fix) offers no Land until its chat fixes it:
 * a fix committed and the branch finished again at that newer commit, or (sent back for its drafts only) the queue
 * saying its drafts are fixed at the same commit (`redrafted`). Then the row is Ready with Land. Meanwhile every Needs
 * a fix row offers its re-land (a new approval of the newest commit) and Remove from Queue. The Land button and
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
    assert.deepEqual(rowButtons(r, "prj_1"), ["Land This Commit Again", "Remove from Queue"], "never left without a button");
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

test("the Overseer's coding-worktree menu (no readiness): Land is off on a sent-back branch, with the sent-back line, until its drafts are fixed", () => {
  assert.equal(entryLandBlock(sentBack()), SENT_BACK_LINE);
  assert.equal(SENT_BACK_LINE, "Sent back to its chat. Land comes back once its chat fixes it, or land its newest commit now.");
  assert.equal(entryLandBlock(sentBack({ redrafted: true })), undefined, "sent back for its drafts, fixed: Land on");
  // The menu offers what that line names: Land This Commit Again, at the sent-back commit, while it still needs a fix.
  assert.equal(landThisAgainOf(sentBack()), SENT);
  assert.equal(landThisAgainOf(sentBack({ redrafted: true })), undefined, "its drafts fixed: Land is on instead");
  for (const settled of ["superseded", "merged", "gone"] as const) {
    assert.equal(landThisAgainOf(sentBack({ settled })), undefined, `settled ${settled}: nothing to land again`);
    assert.equal(entryLandBlock(sentBack({ settled })), undefined, `settled ${settled}: the row reads as the branch itself`);
  }
  for (const state of ["queued", "landed", "drafts-changed"] as const) assert.equal(landThisAgainOf(sentBack({ state })), undefined, state);
  // In line: off as before; nothing in the queue, or Drafts changed (Land re-approves): on.
  for (const state of ["queued", "checking", "conflict", "behaviour-differs", "review-flagged"] as const) assert.equal(entryLandBlock(sentBack({ state })), "Already in the merge queue.", state);
  assert.equal(entryLandBlock(undefined), undefined);
  assert.equal(entryLandBlock(sentBack({ state: "drafts-changed" })), undefined);
});

test("the re-land takes the branch's newest commit: Land This Commit Again at the sent-back head, Land Newest Commit once the branch has commits of its own past it, with what it brings in and why the newest isn't ready", async () => {
  const { landAgainOf } = await import("./merge-queue");
  assert.deepEqual(landAgainOf(sentBack()), { label: "Land This Commit Again", included: null, blocked: null });
  assert.deepEqual(landAgainOf(sentBack({ newerCommits: 1 })), { label: "Land Newest Commit", included: "1 newer commit included", blocked: null });
  assert.deepEqual(landAgainOf(sentBack({ newerCommits: 2, newerBlocked: "3 uncommitted files in its folder: commit or remove them first" })), {
    label: "Land Newest Commit",
    included: "2 newer commits included",
    blocked: "The newest commit isn't Ready to land: 3 uncommitted files in its folder: commit or remove them first.",
  });
  // The row draws the same words: the one button relabelled, its line in place of "not included".
  const r = queueRow(wt({ queue: sentBack({ newerCommits: 2, newerBlocked: "its newest commit is a temporary commit (\"temp\")" }) }));
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land Newest Commit", "Remove from Queue"], "still one re-land button");
  assert.equal(r.newer, "2 newer commits included · The newest commit isn't Ready to land: its newest commit is a temporary commit (\"temp\").");
  assert.doesNotMatch(r.newer ?? "", /not included/);
  assert.deepEqual(rowButtons(queueRow(wt({ queue: sentBack() })), "prj_1"), ["Land This Commit Again", "Remove from Queue"]);
});

test("a rewritten branch (the sent-back commit is no ancestor of its tip): Land Newest Commit, says it was rewritten, no count, and why the newest isn't ready", async () => {
  const { landAgainOf } = await import("./merge-queue");
  assert.deepEqual(landAgainOf(sentBack({ newerRewritten: true })), { label: "Land Newest Commit", included: "the branch was rewritten since it was sent back", blocked: null });
  assert.deepEqual(landAgainOf(sentBack({ newerRewritten: true, newerBlocked: "conflicts with master: 2 files" })), {
    label: "Land Newest Commit",
    included: "the branch was rewritten since it was sent back",
    blocked: "The newest commit isn't Ready to land: conflicts with master: 2 files.",
  });
  const r = queueRow(wt({ queue: sentBack({ newerRewritten: true }) }));
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land Newest Commit", "Remove from Queue"]);
  assert.equal(r.newer, "the branch was rewritten since it was sent back");
});

test("a sent-back row with no reason names no button its label may contradict", () => {
  const r = queueRow(wt({ queue: sentBack({ newerCommits: 2, reason: undefined }) }));
  assert.equal(r.reason, SENT_BACK_LINE);
  assert.doesNotMatch(r.reason!, /Land This Commit Again/);
});

test("the Overseer's re-land item names what lands: the head it read, never the sent-back commit once the branch moved", async () => {
  const { landAgainItem } = await import("./merge-queue");
  const NEW = "c".repeat(40);
  assert.deepEqual(landAgainItem(sentBack(), SENT), { label: "Land This Commit Again", description: "Approves aaaaaaa again: every check runs from the start." });
  assert.deepEqual(landAgainItem(sentBack({ newerCommits: 2 }), NEW), { label: "Land Newest Commit", description: "Approves ccccccc: every check runs from the start. 2 newer commits included." });
  assert.deepEqual(landAgainItem(sentBack({ newerRewritten: true, newerBlocked: "working now" }), NEW), { label: "Land Newest Commit", description: "Approves ccccccc: every check runs from the start. the branch was rewritten since it was sent back. The newest commit isn't Ready to land: working now." });
  // The page's head moved before the queue's reading did: the words still follow the head that lands.
  assert.equal(landAgainItem(sentBack(), NEW).description, "Approves ccccccc: every check runs from the start.");
  assert.equal(landAgainItem(sentBack(), NEW).label, "Land Newest Commit");
});
