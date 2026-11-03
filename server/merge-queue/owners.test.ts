import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import type { TrackedWorktree } from "../../pi-config/extensions/worktrees/state.ts";
import { pickOwner, WorktreeOwners } from "./owners";

const WT = "/w/.worktrees/proj-feat";
const row = (id: string, cwd: string, minAgo: number, x: Partial<SessionSummary> = {}) =>
  ({ id, path: `/s/${id}.jsonl`, cwd, archived: false, lastActiveAt: new Date(Date.UTC(2026, 10, 3, 12) - minAgo * 60_000).toISOString(), ...x }) as SessionSummary;
const tracker = (id: string) => ({ sessionPath: `/s/${id}.jsonl` });

describe("which chat a worktree's branch belongs to", () => {
  test("the chat that created and tracks it, before a newer chat or worker working inside it", () => {
    const sessions = [row("A", "/w/proj", 60), row("B", WT, 1, { workerSession: true }), row("C", `${WT}/src`, 2)];
    assert.deepEqual(pickOwner([WT], sessions, [tracker("A")]), { session: "A" });
  });

  test("else the newest chat working in its folder, a worker included", () => {
    const sessions = [row("B", WT, 1, { workerSession: true }), row("C", `${WT}/src`, 5), row("E", "/elsewhere", 0)];
    assert.deepEqual(pickOwner([WT], sessions, []), { session: "B" });
    assert.deepEqual(pickOwner([WT], [row("C", `${WT}/src`, 5)], []), { session: "C" });
    // A folder that only starts with the worktree's name is not inside it.
    assert.equal(pickOwner([WT], [row("X", `${WT}-other`, 0)], []), null);
    // Either spelling of the folder (git's, or canonical) matches a chat's cwd.
    assert.deepEqual(pickOwner(["/real/proj-feat", WT], [row("C", WT, 0)], []), { session: "C" });
  });

  test("an archived chat only when nothing else is found, and flagged; none at all is null", () => {
    const archivedTracker = row("A", "/w/proj", 60, { archived: true });
    assert.deepEqual(pickOwner([WT], [archivedTracker, row("C", WT, 5)], [tracker("A")]), { session: "C" });
    assert.deepEqual(pickOwner([WT], [archivedTracker], [tracker("A")]), { session: "A", archived: true });
    assert.deepEqual(pickOwner([WT], [row("C", WT, 5, { archived: true })], []), { session: "C", archived: true });
    assert.equal(pickOwner([WT], [row("E", "/elsewhere", 0)], []), null);
    // A tracker the session list doesn't carry (gone) counts for nothing.
    assert.equal(pickOwner([WT], [], [tracker("A")]), null);
  });
});

describe("the owners' index", () => {
  test("is built once per change of who tracks what: a view polled again and again reads nothing new", async () => {
    let version = 1;
    let walks = 0;
    let trees: [string, TrackedWorktree[]][] = [
      ["/s/A.jsonl", [{ path: WT, status: "active", how: "created" } as TrackedWorktree]],
      // A chat that only attached the worktree never owns it.
      ["/s/Z.jsonl", [{ path: WT, status: "active", how: "attached" } as TrackedWorktree]],
    ];
    let listed = 0;
    const owners = new WorktreeOwners({
      sessions: async () => {
        listed++;
        return [row("A", "/w/proj", 60), row("Z", "/w/proj", 0)];
      },
      tracked: () => ({
        version,
        each: () => {
          walks++;
          return trees;
        },
      }),
      canonical: (p) => p,
    });
    for (let i = 0; i < 10; i++) assert.deepEqual(await owners.ownerOf(WT), { session: "A" });
    assert.equal(owners.builds, 1);
    assert.equal(walks, 1, "the tracked records were walked once for ten reads");
    assert.equal(listed, 10, "the session list (the index's cached rows) is asked each time; no transcript is read here");
    // A drops it and Z creates it anew (removed and re-created): the version moves, the index is rebuilt once.
    trees = [
      ["/s/A.jsonl", [{ path: WT, status: "dropped", how: "created" } as TrackedWorktree]],
      ["/s/Z.jsonl", [{ path: WT, status: "active", how: "created" } as TrackedWorktree]],
    ];
    version++;
    assert.deepEqual(await owners.ownerOf(WT), { session: "Z" });
    assert.deepEqual(await owners.ownerOf(WT), { session: "Z" });
    assert.equal(owners.builds, 2);
    assert.equal(walks, 2);
  });
});
