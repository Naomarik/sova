// Run: pnpm test src/lib/merge-queue-chats.test.ts
// The words of the tab's own-chat surfaces: the thread card's state and facts, the running-review button, the
// History's filters, rows and Clear All set, and a run's reviewer links (a cleared one keeps its verdict, no link).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeQueueChat } from "../../shared/merge-queue";
import { clearableRows, historyRows, historyWords, lastEventWords, memoryWords, reviewersOfRun, reviewerLinkWords, reviewingWords, threadStateChip } from "./merge-queue-chats";

const chats: MergeQueueChat[] = [
  { kind: "thread", session: "t2", path: "/s/t2.jsonl", startedAt: "2026-11-03T10:00:00Z", current: true, memory: "uniichat" },
  { kind: "reviewer", session: "r2", path: "/s/r2.jsonl", startedAt: "2026-11-03T09:00:00Z", running: true, run: "mr_2", branch: "feat/y", attempt: 1 },
  { kind: "reviewer", session: "r1b", path: "/s/r1b.jsonl", startedAt: "2026-11-03T08:30:00Z", endedAt: "2026-11-03T08:40:00Z", run: "mr_1", branch: "feat/x", attempt: 2, verdict: "notes" },
  { kind: "reviewer", session: "r1", path: "/s/r1.jsonl", startedAt: "2026-11-03T08:00:00Z", endedAt: "2026-11-03T08:20:00Z", run: "mr_1", branch: "feat/x", attempt: 1, verdict: "failed", cleared: "2026-11-03T11:00:00Z" },
  { kind: "thread", session: "t1", path: "/s/t1.jsonl", startedAt: "2026-11-01T08:00:00Z", endedAt: "2026-11-03T10:00:00Z", why: "you started a fresh one", memory: "uniichat" },
];

test("the thread card's chip, memory and last event", () => {
  assert.deepEqual(threadStateChip({ state: "asking" }), { label: "Asking you", tone: "warn" });
  assert.equal(threadStateChip({ state: "working" }).label, "Working");
  assert.equal(threadStateChip({ state: "idle" }).label, "Idle");
  assert.equal(memoryWords("uniichat"), "UniiChat");
  assert.equal(memoryWords(undefined), "No memory");
  assert.equal(lastEventWords({ kind: "queued", at: "x", branch: "feat/x" }), "Read a queued branch · feat/x");
  assert.equal(lastEventWords(undefined), null);
});

test("the running-review button names the branch, and a retry's attempt", () => {
  assert.equal(reviewingWords({ run: "mr_2", branch: "feat/y", session: "r2", path: "/p", attempt: 1, startedAt: "x" }), "Review running · feat/y · Open");
  assert.equal(reviewingWords({ run: "mr_2", branch: "feat/y", session: "r2", path: "/p", attempt: 2, startedAt: "x" }), "Review running · feat/y (attempt 2) · Open");
});

test("History: All, Merge threads and Reviews; Clear All never takes the current thread, a running review or a cleared chat", () => {
  assert.equal(historyRows(chats, "all").length, 5);
  assert.deepEqual(historyRows(chats, "threads").map((c) => c.session), ["t2", "t1"]);
  assert.deepEqual(historyRows(chats, "reviews").map((c) => c.session), ["r2", "r1b", "r1"]);
  assert.deepEqual(clearableRows(chats).map((c) => c.session), ["r1b", "t1"]);
  assert.deepEqual(historyWords(chats[0]!), { title: "Merge thread (current)", facts: "UniiChat" });
  assert.deepEqual(historyWords(chats[4]!), { title: "Merge thread", facts: "UniiChat · ended: you started a fresh one" });
  assert.deepEqual(historyWords(chats[2]!), { title: "Review · feat/x · attempt 2", facts: "Review: notes · mr_1" });
  assert.deepEqual(historyWords(chats[3]!).facts, "Review: no verdict · mr_1 · Reviewer chat cleared");
});

test("a run's reviewer links: one per attempt, oldest first; a cleared chat keeps its verdict and has no link", () => {
  const list = reviewersOfRun(chats, "mr_1");
  assert.deepEqual(list.map((c) => c.session), ["r1", "r1b"]);
  assert.deepEqual(reviewerLinkWords(list[0]!, true), { lead: "Review (attempt 1): no verdict · Reviewer chat cleared", link: null });
  assert.deepEqual(reviewerLinkWords(list[1]!, true), { lead: "Review (attempt 2): notes", link: "Open Reviewer Chat" });
  assert.deepEqual(reviewerLinkWords(chats[1]!, false), { lead: "Review running", link: "Open Reviewer Chat" });
  assert.deepEqual(reviewersOfRun(chats, undefined), []);
});
