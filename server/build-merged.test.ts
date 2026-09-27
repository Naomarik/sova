// Run: pnpm exec tsx --test server/build-merged.test.ts. Whether a project's coding session (a
// build) is merged, as the session list says it (`org.finished`, §app.organizations/org-sessions):
// git's answer, read in the background at most every 30 s per session; until git has answered, what
// started.json recorded; a Merge Branch updates it at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMerged, noteBuildMerged, resetBuildMerged, setBuildReader, BUILD_TTL_MS } from "./build-merged";
import type { StartedRow } from "./project-overseer-store";

const tree = { path: "/w/proj-x", branch: "sova/x", base: "abc", target: "main" };
const row = (extra: Partial<StartedRow> = {}): StartedRow => ({ sessionId: "s1", kind: "coding", createdAt: "2026-09-01T00:00:00Z", worktree: tree, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("git decides once it has answered; until then the recorded merge; at most one read per TTL", async () => {
  resetBuildMerged();
  let reads = 0;
  let merged = true;
  setBuildReader(async () => (reads++, { merged, branch: true }));
  let now = 1_000;
  assert.equal(buildMerged(row(), "/w/proj", now), false, "nothing recorded, git not read yet");
  await tick();
  assert.equal(buildMerged(row(), "/w/proj", now), true, "git's answer");
  assert.equal(reads, 1);
  merged = false; // the branch gained commits
  now += BUILD_TTL_MS - 1;
  assert.equal(buildMerged(row(), "/w/proj", now), true, "still the last answer inside the TTL");
  await tick();
  assert.equal(reads, 1, "no second read inside the TTL");
  now += 2;
  assert.equal(buildMerged(row(), "/w/proj", now), true, "a stale answer is served while git is read again");
  await tick();
  assert.equal(buildMerged(row(), "/w/proj", now), false, "merged before, new commits now: not merged");
  assert.equal(reads, 2);
});

test("a recorded merge or a deleted branch stands only while git can't say otherwise", async () => {
  resetBuildMerged();
  setBuildReader(async () => ({ merged: false, branch: false }));
  assert.equal(buildMerged(row({ merged: { at: "t", commit: "c" } }), "/w/proj", 1), true, "recorded, before git answers");
  await tick();
  assert.equal(buildMerged(row({ merged: { at: "t", commit: "c" } }), "/w/proj", 1), true, "the branch is gone: the record decides");
  resetBuildMerged();
  setBuildReader(async () => ({ merged: false, branch: true }));
  buildMerged(row({ sessionId: "s2", merged: { at: "t", commit: "c" } }), "/w/proj", 1);
  await tick();
  assert.equal(buildMerged(row({ sessionId: "s2", merged: { at: "t", commit: "c" } }), "/w/proj", 1), false, "the branch exists and git says not merged");
});

test("a build in the project root is never merged; a Merge Branch is known at once", async () => {
  resetBuildMerged();
  let reads = 0;
  setBuildReader(async () => (reads++, { merged: true, branch: true }));
  assert.equal(buildMerged(row({ worktree: undefined, inRoot: "it isn't a Git repository." }), "/w/proj", 1), false);
  await tick();
  assert.equal(reads, 0, "no worktree, no git");
  noteBuildMerged("s3", true, 2);
  assert.equal(buildMerged(row({ sessionId: "s3" }), "/w/proj", 2), true);
  await tick();
  assert.equal(reads, 0, "fresh: no read");
});
