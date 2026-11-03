// The merge queue's wake (wake.ts): a branch whose owner is a subagent's own session wakes the chat that runs it (up to
// the top chat), once, marked as the queue's and naming the worker; a chat that can't take it throws, so the card
// keeps the line hidden instead (cards.ts), and nothing is sent twice.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/merge-queue";
import { sendQueueWake, type WakeDeps } from "./wake";

const row = (id: string, x: Partial<SessionSummary> = {}) => ({ id, path: `/s/${id}.jsonl`, title: `Chat ${id}`, archived: false, live: null, ...x }) as SessionSummary;
const TEXT = `${MERGE_QUEUE_SENT_PREFIX} Needs a fix: feat/x failed Unit tests (passes on master alone).`;

function kit(rows: SessionSummary[], parents: Record<string, string>) {
  const sent: { path: string; text: string }[] = [];
  const deps: WakeDeps = {
    summary: async (p) => rows.find((r) => r.path === p) ?? null,
    parentOf: async (p) => parents[p] ?? null,
    send: async (p, text) => {
      sent.push({ path: p, text });
    },
  };
  return { sent, deps };
}

describe("a merge queue wake", () => {
  test("a chat of its own: woken itself, the text as given", async () => {
    const { sent, deps } = kit([row("P")], {});
    await sendQueueWake("/s/P.jsonl", TEXT, deps);
    assert.deepEqual(sent, [{ path: "/s/P.jsonl", text: TEXT }]);
  });

  test("a worker owns the branch: the chat that runs it gets exactly one wake, marked, naming the worker and the branch", async () => {
    const { sent, deps } = kit([row("P"), row("W", { workerSession: true, title: "Build the rows" })], { "/s/W.jsonl": "/s/P.jsonl" });
    await sendQueueWake("/s/W.jsonl", TEXT, deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.path, "/s/P.jsonl");
    assert.ok(sent[0]!.text.startsWith(MERGE_QUEUE_SENT_PREFIX), "marked as the queue's");
    assert.match(sent[0]!.text, /your worker "Build the rows"/);
    assert.match(sent[0]!.text, /feat\/x failed Unit tests/);
  });

  test("a worker of a worker: up to the top chat", async () => {
    const { sent, deps } = kit([row("P"), row("W", { workerSession: true }), row("V", { workerSession: true, title: "Nested" })], { "/s/V.jsonl": "/s/W.jsonl", "/s/W.jsonl": "/s/P.jsonl" });
    await sendQueueWake("/s/V.jsonl", TEXT, deps);
    assert.deepEqual(sent.map((s) => s.path), ["/s/P.jsonl"]);
    assert.match(sent[0]!.text, /your worker "Nested"/);
  });

  test("the running chat can't take it (archived, unknown, a terminal holds it): it throws, nothing is sent", async () => {
    for (const [rows, parents] of [
      [[row("P", { archived: true }), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
      [[row("W", { workerSession: true })], {}],
      [[row("P", { live: { pid: 1, status: "idle" } }), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
    ] as [SessionSummary[], Record<string, string>][]) {
      const { sent, deps } = kit(rows, parents);
      await assert.rejects(sendQueueWake("/s/W.jsonl", TEXT, deps));
      assert.deepEqual(sent, []);
    }
  });
});
