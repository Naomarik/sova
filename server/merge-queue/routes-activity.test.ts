import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeEvent } from "../../shared/merge-queue";
import type { Caller } from "../project-services/engine";
import { merger } from "./routes";
import { makeKit } from "./testing/queue-kit";

/** The verbs' side of the event memory (§app.merge-queue/activity): the merge thread's rulings with what it read, and
 *  merge.events / merge.status {entry} reading it back. */

const op: Caller = { kind: "operator" };

function setup() {
  const k = makeKit();
  const thread = "thread-1";
  const call = merger({
    queues: k.queues,
    served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("every root here is served"); } },
    rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
    isThreadChat: (root, sid) => root === k.repo.root && sid === thread,
  });
  const session = (id: string): Caller => ({ kind: "session", id, root: k.repo.root, own: [] });
  return { k, call, thread: session(thread), chat: session("chat-1") };
}

describe("the merge thread's rulings in the event memory", () => {
  test("each act is recorded with its reason and what the thread read since its last ruling; the next ruling starts afresh", async () => {
    const { k, call, thread, chat } = setup();
    try {
      await call("merge.pause", { project: k.repo.root, why: "hold" }, op);
      const b = k.repo.branch("feat/a", { "statecharts/x.txt": "x\n" });
      const added = await call("merge.add", { checkout: b.path, chat: "chat-1" }, op);
      const id = added.merge!.entry!.id;
      assert.equal((await call("merge.status", { entry: id }, thread)).ok, true);
      assert.equal((await call("merge.events", { entry: id }, thread)).ok, true);
      assert.equal((await call("merge.extend", { entry: id, checks: ["statecharts"], why: "statecharts/ changed" }, thread)).ok, true);
      assert.equal((await call("merge.note", { entry: id, note: "changes the charts" }, thread)).ok, true);
      const ruled = (await call("merge.events", { entry: id, lines: 50 }, chat)).merge!.events!.events.filter((e): e is Extract<MergeEvent, { kind: "ruled" }> => e.kind === "ruled").reverse();
      assert.deepEqual(
        ruled.map((e) => [e.act, e.by, e.read]),
        [
          ["extend", "thread", [`status of ${id}`, `events of ${id}`]],
          ["note", "thread", []],
        ],
      );
      assert.equal(ruled[0]!.why, "The merge thread added statecharts: statecharts/ changed.");
      const picked = (await call("merge.events", { entry: id }, op)).merge!.events!.events.find((e) => e.kind === "picked");
      assert.deepEqual(picked && picked.kind === "picked" ? picked.checks : null, ["statecharts"]);
      // The operator's own status of the entry answers its events too, newest first.
      const status = await call("merge.status", { entry: id }, op);
      assert.equal(status.merge!.events!.events[0]!.kind, "ruled");
      assert.ok(status.merge!.events!.events.some((e) => e.kind === "approved"));
    } finally {
      await k.done();
    }
  });

  test("the operator's and a chat's reads are no thread evidence, and their acts are no ruling", async () => {
    const { k, call, chat } = setup();
    try {
      await call("merge.pause", { project: k.repo.root, why: "hold" }, op);
      const b = k.repo.branch("feat/a", { "a.txt": "x\n" });
      const id = (await call("merge.add", { checkout: b.path }, op)).merge!.entry!.id;
      await call("merge.status", { entry: id }, chat);
      await call("merge.note", { entry: id, note: "mine" }, op);
      const events = (await call("merge.events", { entry: id }, op)).merge!.events!.events;
      assert.equal(events.filter((e) => e.kind === "ruled").length, 0);
    } finally {
      await k.done();
    }
  });
});
