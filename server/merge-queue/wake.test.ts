// The merge queue's request (wake.ts, §chat.merge-queue/requests): pushed to the branch's chat, or for a branch whose
// owner is a subagent's own session to the chat that runs it (up to the top chat), once, naming the worker; a chat
// that can't take notes throws, so the card keeps the line hidden instead (cards.ts), and nothing is sent twice.
// Each request has an id (rq_…), the caller's or a new one, returned to the caller.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/merge-queue";
import { MERGE_REQUEST_ID_RE } from "../../shared/topic-message";
import { sendMergeRequest, sendQueueWake, type MergeRequestInfo, type WakeDeps } from "./wake";

const row = (id: string, x: Partial<SessionSummary> = {}) => ({ id, path: `/s/${id}.jsonl`, title: `Chat ${id}`, archived: false, live: null, ...x }) as SessionSummary;
const TEXT = `${MERGE_QUEUE_SENT_PREFIX} Needs a fix: feat/x failed Unit tests (passes on master alone).`;

function kit(rows: SessionSummary[], parents: Record<string, string>) {
  const sent: { path: string; text: string }[] = [];
  const infos: (MergeRequestInfo & { sessionId: string })[] = [];
  const deps: WakeDeps = {
    summary: async (p) => rows.find((r) => r.path === p) ?? null,
    parentOf: async (p) => parents[p] ?? null,
    send: async (p, text, req) => {
      sent.push({ path: p, text });
      infos.push(req);
    },
  };
  return { sent, infos, deps };
}

describe("a merge queue wake", () => {
  test("a chat of its own: one request to it, its words without the old prefix, a new request id returned", async () => {
    const { sent, infos, deps } = kit([row("P")], {});
    const id = await sendQueueWake("/s/P.jsonl", TEXT, deps, { kind: "needs-fix", branch: "feat/x", entry: "mq_1" });
    assert.deepEqual(sent, [{ path: "/s/P.jsonl", text: TEXT.slice(MERGE_QUEUE_SENT_PREFIX.length).trim() }]);
    assert.match(id, MERGE_REQUEST_ID_RE);
    assert.deepEqual(infos, [{ id, kind: "needs-fix", branch: "feat/x", entry: "mq_1", sessionId: "P" }]);
  });

  test("the caller's own request id is kept; a malformed one is replaced", async () => {
    const { infos, deps } = kit([row("P")], {});
    assert.equal(await sendMergeRequest("/s/P.jsonl", { id: "rq_0123456789ab", branch: "feat/x", text: "fix it" }, deps), "rq_0123456789ab");
    const other = await sendMergeRequest("/s/P.jsonl", { id: "rq_nope", branch: "feat/x", text: "fix it" }, deps);
    assert.match(other, MERGE_REQUEST_ID_RE);
    assert.notEqual(other, "rq_nope");
    assert.deepEqual(infos.map((i) => i.id), ["rq_0123456789ab", other]);
  });

  test("a worker owns the branch: the chat that runs it gets exactly one wake, marked, naming the worker and the branch", async () => {
    const { sent, deps } = kit([row("P"), row("W", { workerSession: true, title: "Build the rows" })], { "/s/W.jsonl": "/s/P.jsonl" });
    await sendQueueWake("/s/W.jsonl", TEXT, deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.path, "/s/P.jsonl");
    assert.ok(!sent[0]!.text.startsWith(MERGE_QUEUE_SENT_PREFIX), "the batch says whose it is; the note has no prefix");
    assert.match(sent[0]!.text, /^For your worker/);
    assert.match(sent[0]!.text, /your worker "Build the rows"/);
    assert.match(sent[0]!.text, /feat\/x failed Unit tests/);
  });

  test("a worker of a worker: up to the top chat", async () => {
    const { sent, deps } = kit([row("P"), row("W", { workerSession: true }), row("V", { workerSession: true, title: "Nested" })], { "/s/V.jsonl": "/s/W.jsonl", "/s/W.jsonl": "/s/P.jsonl" });
    await sendQueueWake("/s/V.jsonl", TEXT, deps);
    assert.deepEqual(sent.map((s) => s.path), ["/s/P.jsonl"]);
    assert.match(sent[0]!.text, /your worker "Nested"/);
  });

  test("the running chat can't take notes (archived, unknown, a terminal holds it, an Overseer, a baton, a queue chat): it throws, nothing is sent", async () => {
    for (const [rows, parents] of [
      [[row("P", { archived: true }), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
      [[row("W", { workerSession: true })], {}],
      [[row("P", { live: { pid: 1, status: "idle" } }), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
      [[row("P", { overseer: true } as Partial<SessionSummary>), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
      [[row("P", { baton: {} } as Partial<SessionSummary>), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
      [[row("P", { queueChat: { role: "thread" } } as Partial<SessionSummary>), row("W", { workerSession: true })], { "/s/W.jsonl": "/s/P.jsonl" }],
    ] as [SessionSummary[], Record<string, string>][]) {
      const { sent, deps } = kit(rows, parents);
      await assert.rejects(sendQueueWake("/s/W.jsonl", TEXT, deps));
      assert.deepEqual(sent, []);
    }
  });
});
