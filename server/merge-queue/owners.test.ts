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

  test("else the newest main chat working in its folder, never a newer worker there", () => {
    const sessions = [row("B", WT, 1, { workerSession: true, workerOf: { id: "P", path: "/s/P.jsonl" } }), row("P", "/w/proj", 90), row("C", `${WT}/src`, 5), row("E", "/elsewhere", 0)];
    assert.deepEqual(pickOwner([WT], sessions, []), { session: "C" });
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

describe("a worker never owns a branch: its chat does", () => {
  const worker = (id: string, cwd: string, minAgo: number, parent: string | null, x: Partial<SessionSummary> = {}) =>
    row(id, cwd, minAgo, { workerSession: true, ...(parent ? { workerOf: { id: parent, path: `/s/${parent}.jsonl`, name: `w-${id}` } } : {}), ...x });

  test("no tracked rows, one live worker in the worktree: the owner is the chat that runs it", () => {
    const sessions = [row("P", "/w/proj", 30), worker("W", WT, 1, "P")];
    assert.deepEqual(pickOwner([WT], sessions, []), { session: "P" });
  });

  test("a worker of a worker: up to the top chat", () => {
    const sessions = [row("P", "/w/proj", 30), worker("W1", "/w/proj", 10, "P"), worker("W2", WT, 1, "W1")];
    assert.deepEqual(pickOwner([WT], sessions, []), { session: "P" });
  });

  test("the tracking main chat before a newer worker in the same worktree; a worker that created it stands for its chat", () => {
    const sessions = [row("A", "/w/proj", 60), worker("W", WT, 1, "P"), row("P", "/w/proj", 30)];
    assert.deepEqual(pickOwner([WT], sessions, [tracker("A")]), { session: "A" });
    assert.deepEqual(pickOwner([WT], sessions, [tracker("W")]), { session: "P" }, "the worker's worktree is its chat's");
  });

  test("a worker with no known chat counts for nothing; neither does one of the queue's own chats", () => {
    assert.equal(pickOwner([WT], [worker("W", WT, 1, null)], []), null);
    assert.equal(pickOwner([WT], [row("R", WT, 1, { queueChat: { role: "reviewer" } })], []), null);
    assert.equal(pickOwner([WT], [row("T", "/w/proj", 1, { queueChat: { role: "thread" } }), worker("W", WT, 1, "T")], []), null, "never through a worker either");
    assert.deepEqual(pickOwner([WT], [row("R", WT, 1, { queueChat: { role: "reviewer" } }), row("C", WT, 9)], []), { session: "C" });
  });

  test("an archived parent is flagged archived, after any live candidate", () => {
    const sessions = [row("P", "/w/proj", 30, { archived: true }), worker("W", WT, 1, "P")];
    assert.deepEqual(pickOwner([WT], sessions, []), { session: "P", archived: true });
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

describe("a worktree one of the merge queue's own chats made", () => {
  test("queueMade: created by a queue chat (the merge thread's own scratch copy); never one it only attached, nor a user's", async () => {
    const OLD = "/w/.worktrees/proj-resolve-mq_1";
    const ATT = "/w/.worktrees/proj-attached";
    const trees: [string, TrackedWorktree[]][] = [
      ["/s/T.jsonl", [{ path: OLD, status: "active", how: "created" } as TrackedWorktree, { path: ATT, status: "active", how: "attached" } as TrackedWorktree]],
      ["/s/A.jsonl", [{ path: WT, status: "active", how: "created" } as TrackedWorktree, { path: ATT, status: "active", how: "created" } as TrackedWorktree]],
    ];
    const owners = new WorktreeOwners({
      sessions: async () => [row("T", "/w/proj", 5, { queueChat: { role: "thread" } }), row("A", "/w/proj", 60)],
      tracked: () => ({ version: 1, each: () => trees }),
      canonical: (p) => p,
    });
    assert.equal(await owners.queueMade(OLD), true);
    assert.equal(await owners.queueMade(WT), false, "a user's chat made it");
    assert.equal(await owners.queueMade(ATT), false, "the thread only attached it");
    assert.equal(await owners.queueMade("/w/.worktrees/nobody"), false);
    // And it owns no branch, as before: the scratch copy reads as no one's.
    assert.equal(await owners.ownerOf(OLD), null);
  });
});
