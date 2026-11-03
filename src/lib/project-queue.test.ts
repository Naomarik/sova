// The project page's rows read a branch's queue state from the project's view.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry } from "../../shared/merge-queue";
import { entryForBranch, queueInfoOf } from "./project-queue";

const e = (id: string, branch: string, state: MergeEntry["state"], updatedAt: string): MergeEntry =>
  ({ id, project: "p", target: "master", branch, commit: "c", approval: { by: "land-button", at: updatedAt, commit: "c" }, state, runs: [], picks: [], notes: [], createdAt: updatedAt, updatedAt }) as MergeEntry;

test("the newest entry for the branch, from any list; none for another branch or none at all", () => {
  const v = {
    checking: [],
    waiting: [e("q", "sova/a", "queued", "2026-11-02T10:00:00Z")],
    needsYou: [],
    needsFix: [e("f", "sova/a", "needs-fix", "2026-11-02T09:00:00Z")],
    recent: [{ entry: e("l", "sova/b", "landed", "2026-11-02T08:00:00Z") }],
  };
  assert.equal(entryForBranch(v, "sova/a")!.id, "q");
  assert.equal(entryForBranch(v, "sova/b")!.id, "l");
  assert.equal(entryForBranch(v, "sova/c"), undefined);
  assert.equal(entryForBranch(v, null), undefined);
  assert.deepEqual(Object.keys(queueInfoOf(v.waiting[0]!)).sort(), ["commit", "conflict", "eta", "id", "landed", "newerCommits", "notes", "position", "project", "reason", "review", "run", "state"]);
});

test("the newest entry is the one created last: a note on an old sent-back entry doesn't bring Needs a fix back", () => {
  const old = { ...e("f", "sova/a", "needs-fix", "2026-11-02T09:00:00Z"), updatedAt: "2026-11-02T12:00:00Z" };
  const v = { checking: [], waiting: [], needsYou: [], needsFix: [old], recent: [{ entry: e("l", "sova/a", "landed", "2026-11-02T10:00:00Z") }] };
  assert.equal(entryForBranch(v, "sova/a")!.id, "l");
});
