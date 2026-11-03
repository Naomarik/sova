// Who tracks which worktree (merge-readiness.ts trackedWorktrees): the readings' version moves only when a session's
// tracked set changes, so the merge queue's owner index (server/merge-queue/owners.ts) rebuilds only then.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Readings } from "./merge-readiness";

const reading = (trees: { path: string; status?: string; how?: string }[] | null) =>
  ({ facts: trees ? { trees: trees.map((t) => ({ status: "active", how: "created", ...t })), merges: [] } : null, key: "", file: "", at: 0, scan: null, row: {} }) as never;

test("the version moves on a change of tracked worktrees, never on a re-read that tracks the same", () => {
  const r = new Readings();
  r.set("/s/a", reading(null));
  assert.equal(r.version, 0, "a session tracking none moves nothing");
  r.set("/s/a", reading([{ path: "/wt/1" }]));
  assert.equal(r.version, 1);
  r.set("/s/a", reading([{ path: "/wt/1" }]));
  assert.equal(r.version, 1, "the same trees read again");
  r.set("/s/a", reading([{ path: "/wt/1", status: "dropped" }]));
  assert.equal(r.version, 2, "a status change counts");
  r.delete("/s/b");
  assert.equal(r.version, 2, "an unknown session's removal");
  r.delete("/s/a");
  assert.equal(r.version, 3);
  r.set("/s/c", reading([{ path: "/wt/2" }]));
  r.clear();
  assert.equal(r.version, 5);
});
