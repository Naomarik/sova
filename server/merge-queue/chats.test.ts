// Run: pnpm test server/merge-queue/chats.test.ts
// The queue's own chats as the tab's Queue chats lists them: threads (current and replaced) and reviewer chats with
// run, attempt and verdict; the running reviewer for the head's button; Clear and Clear All delete for good, never
// the current thread or a running reviewer, and a cleared reviewer's row keeps its verdict.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { clearQueueChats, QueueChats } from "./chats";
import type { ThreadHistoryItem, ThreadRecord } from "./thread";

const T0 = Date.parse("2026-11-03T10:00:00Z");
const thread: ThreadRecord = { sessionId: "t2", path: "/s/t2.jsonl", startedAt: T0 + 3_000, playbook: "/pb", memory: { type: "uniichat" } };
const history: ThreadHistoryItem[] = [{ sessionId: "t1", path: "/s/t1.jsonl", startedAt: T0 - 60_000, endedAt: T0 + 2_000, why: "you started a fresh one", memory: { type: "uniichat" } }];

function store() {
  let clock = T0;
  const c = new QueueChats(join(scratchRoot("mq-chats-"), "chats.json"), () => clock);
  return { c, tick: (ms: number) => (clock += ms) };
}

test("reviewers are recorded with run, attempt and verdict; the running one is the head's; the History lists every chat, newest first, the current thread on top", () => {
  const { c, tick } = store();
  c.reviewerStarted("/p", { session: "r1", path: "/s/r1.jsonl", run: "mr_1", branch: "feat/x", attempt: 1 });
  assert.equal(c.running("/p")?.session, "r1");
  tick(1_000);
  c.reviewerEnded("/p", "r1", { why: "no verdict within 20 min" });
  c.reviewerStarted("/p", { session: "r2", path: "/s/r2.jsonl", run: "mr_1", branch: "feat/x", attempt: 2 });
  assert.equal(c.running("/p", "mr_1")?.attempt, 2, "a retry: the current attempt");
  tick(4_000);
  c.reviewerEnded("/p", "r2", { verdict: "notes" });
  c.reviewerEnded("/p", "r2", { verdict: "ok" });
  assert.equal(c.running("/p"), undefined);
  const rows = c.list("/p", thread, history);
  assert.deepEqual(rows.map((r) => [r.kind, r.session]), [["thread", "t2"], ["reviewer", "r2"], ["reviewer", "r1"], ["thread", "t1"]]);
  assert.equal(rows[0]!.current, true);
  assert.equal(rows[1]!.verdict, "notes", "the first end wins");
  assert.deepEqual([rows[2]!.verdict, rows[2]!.why], ["failed", "no verdict within 20 min"]);
  assert.equal(rows[3]!.why, "you started a fresh one");
});

test("Clear and Clear All: never the current thread or a running reviewer; deleted ones stay listed, cleared, with their verdict", async () => {
  const { c } = store();
  c.reviewerStarted("/p", { session: "r1", path: "/s/r1.jsonl", run: "mr_1", branch: "feat/x", attempt: 1 });
  c.reviewerEnded("/p", "r1", { verdict: "blocking" });
  c.reviewerStarted("/p", { session: "r9", path: "/s/r9.jsonl", run: "mr_2", branch: "feat/y", attempt: 1 });
  const removed: string[][] = [];
  const archived: string[] = [];
  const deps = { archive: async (p: string) => (archived.push(p), { ok: true }), remove: async (paths: string[]) => (removed.push(paths), paths) };
  assert.equal(await clearQueueChats(c, "/p", thread, history, "t2", deps), 0, "the current thread is never cleared");
  assert.equal(await clearQueueChats(c, "/p", thread, history, "r9", deps), 0, "a running reviewer is never cleared");
  assert.equal(await clearQueueChats(c, "/p", thread, history, "r1", deps), 1);
  assert.deepEqual(removed, [["/s/r1.jsonl"]]);
  const r1 = c.list("/p", thread, history).find((r) => r.session === "r1")!;
  assert.ok(r1.cleared);
  assert.equal(r1.verdict, "blocking", "the verdict stays");
  assert.equal(await clearQueueChats(c, "/p", thread, history, "all", deps), 1, "Clear All: the ended thread only now");
  assert.deepEqual(removed[1], ["/s/t1.jsonl"]);
  assert.deepEqual(archived, ["/s/r1.jsonl", "/s/t1.jsonl"], "archived before deletion (a replaced thread never was)");
  assert.ok(c.list("/p", thread, history).find((r) => r.session === "t1")!.cleared);
  assert.equal(await clearQueueChats(c, "/p", thread, history, "all", deps), 0, "nothing left to clear");
});

test("a delete that is refused keeps the row uncleared", async () => {
  const { c } = store();
  c.reviewerStarted("/p", { session: "r1", path: "/s/r1.jsonl", run: "mr_1", branch: "feat/x", attempt: 1 });
  c.reviewerEnded("/p", "r1", { verdict: "ok" });
  assert.equal(await clearQueueChats(c, "/p", undefined, [], "all", { archive: async () => ({ ok: true }), remove: async () => [] }), 0);
  assert.equal(c.list("/p", undefined, []).find((r) => r.session === "r1")!.cleared, undefined);
});
