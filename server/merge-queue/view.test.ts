import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeQueueView } from "../../shared/merge-queue";
import { pushedOf, worktreeQueueInfo } from "./view";

// §app.merge-queue/view

const entry = (o: Partial<MergeEntry>): MergeEntry =>
  ({ id: "mq_1", project: "p", target: "master", branch: "feat/a", commit: "c".repeat(40), approval: { by: "land-button", at: "t", commit: "c" }, state: "queued", runs: [], picks: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...o }) as MergeEntry;
const view = (o: Partial<MergeQueueView>): MergeQueueView =>
  ({ project: "p", root: "/r", target: "master", batch: 1, state: "idle", checks: "declared", review: false, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [], heads: { target: "t" }, at: "x", ...o }) as MergeQueueView;

test("a branch waiting on the host still has its worktree row, with its request", () => {
  const request = { how: "github-pr", branch: "feat/a", base: "master", number: 7, url: "https://example.invalid/pr/7" } as unknown as MergeEntry["request"];
  const info = worktreeQueueInfo(view({ waitingOnHost: [entry({ state: "requested", request })] }), "feat/a");
  assert.equal(info?.state, "requested");
  assert.deepEqual(info?.request, request);
  assert.equal(worktreeQueueInfo(view({}), "feat/a"), undefined);
});

test("pushedOf: the queue's record wins, else origin's tracking ref; No remote only without origin", () => {
  assert.deepEqual(pushedOf(undefined, { has: true, tracking: "abc" }), { pushed: "abc", hasOrigin: true });
  assert.deepEqual(pushedOf("own", { has: true, tracking: "abc" }), { pushed: "own", hasOrigin: true });
  assert.deepEqual(pushedOf(undefined, { has: false, tracking: null }), { hasOrigin: false });
  assert.deepEqual(pushedOf("own", undefined), { pushed: "own" });
});
