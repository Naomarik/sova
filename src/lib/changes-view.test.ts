import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShowChangesDetails } from "../../pi-config/extensions/show-changes/details";
import { diffScopeQuery } from "../../shared/protocol";
import { commitsCaption, commitsSummary, emptyReason, scopeFromDetails, scopeHasCommits } from "./changes-view";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("a branch card opens pinned to the base and head it saved, with its paths", () => {
  const d: ShowChangesDetails = {
    v: 1,
    scope: { kind: "worktree", worktreePath: "/w/x", root: "/w/x", branch: "feat/x", head: B, base: A, baseRef: "master" },
    paths: ["src/a.ts", "docs"],
  };
  const s = scopeFromDetails(d, "/s.jsonl");
  assert.deepEqual(s, { kind: "worktree", sessionPath: "/s.jsonl", worktreePath: "/w/x", pin: { base: A, head: B, baseRef: "master", branch: "feat/x" }, paths: ["src/a.ts", "docs"] });
  const q = new URLSearchParams(diffScopeQuery(s));
  assert.equal(q.get("base"), A);
  assert.equal(q.get("head"), B);
  assert.deepEqual(q.getAll("paths"), ["src/a.ts", "docs"]);
});

test("commit and uncommitted cards keep their paths; only uncommitted has no commits", () => {
  const commit = scopeFromDetails({ v: 1, scope: { kind: "commit", repoPath: "/r", root: "/r", sha: C }, paths: ["a"] } as ShowChangesDetails, "/s");
  assert.deepEqual(commit, { kind: "commit", sessionPath: "/s", repoPath: "/r", sha: C, paths: ["a"] });
  const dirty = scopeFromDetails({ v: 1, scope: { kind: "dirty", cwd: "/r", root: "/r", head: C } }, "/s");
  assert.deepEqual(dirty, { kind: "dirty", sessionPath: "/s", cwd: "/r" });
  assert.equal(scopeHasCommits(dirty), false);
  assert.equal(scopeHasCommits(commit), true);
});

test("commit captions name the first and last short ids, oldest first", () => {
  assert.equal(commitsCaption([A]), "aaaaaaa · 1 commit");
  assert.equal(commitsCaption([A, B, C]), "aaaaaaa → ccccccc · 3 commits");
  assert.equal(commitsSummary([A]), "From 1 commit · aaaaaaa");
  assert.equal(commitsSummary([A, C]), "From 2 commits · aaaaaaa → ccccccc");
});

test("an empty step says which earlier steps hold its changes, or that they're gone", () => {
  assert.equal(emptyReason({}), null);
  assert.equal(emptyReason({ empty: "gone" }), "Nothing left to show: these changes are no longer in the diff");
  assert.equal(emptyReason({ empty: "taken", heldBy: [2] }), "Nothing left to show: step 2 already holds these changes");
  assert.equal(emptyReason({ empty: "taken", heldBy: [1, 2] }), "Nothing left to show: steps 1 and 2 already hold these changes");
  assert.equal(emptyReason({ empty: "taken", heldBy: [1, 2, 4] }), "Nothing left to show: steps 1, 2, and 4 already hold these changes");
});
