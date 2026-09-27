// Run: pnpm exec tsx --test src/lib/commit-now.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitNowWords } from "./commit-now";

test("Commit Now says what it did: committed (and pushed), pushed only, or nothing", () => {
  assert.equal(commitNowWords({ committed: true, sha: "a1b2c3d", pushed: true }), "Committed a1b2c3d and pushed.");
  assert.equal(commitNowWords({ committed: true, sha: "a1b2c3d" }), "Committed a1b2c3d.");
  assert.equal(commitNowWords({ committed: false, pushed: true }), "Nothing new to commit. Pushed the commits the remote lacked.");
  assert.equal(commitNowWords({ committed: false }), "Nothing new to commit.");
  assert.equal(commitNowWords(undefined), "Committed.", "an older server that doesn't say");
});
