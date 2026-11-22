// The merge thread's health (§chat.merge-queue/thread-health): failed deliveries recorded, not only logged; a fix or
// conflict waiting 15 minutes gets a fresh thread by itself; that failing too tells the user; nothing lands unchecked.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { THREAD_DEADLINE_MS } from "./queue";
import { makeKit, until } from "./testing/queue-kit";
import { MergeThread, type ThreadDeps, type ThreadEvent, threadInfo } from "./thread";

const T0 = Date.parse("2026-11-02T10:00:00Z");
const entry = { id: "mq_1", branch: "feat/x", commit: "a".repeat(40), target: "master" };
const conflict: ThreadEvent = { kind: "conflict", entry, run: "mr_1", files: ["a.txt"] };

function keeper(over: Partial<ThreadDeps> = {}) {
  const dir = scratchRoot("mq-health-");
  let n = 0;
  const created: string[] = [];
  const retired: string[] = [];
  const t = new MergeThread({
    now: () => T0,
    file: join(dir, "threads.json"),
    session: async (id, path) => ({ id, path, createdAt: new Date(T0).toISOString() }),
    create: async () => {
      const id = `s${++n}`;
      created.push(id);
      return { ok: true, id, path: `/sessions/${id}.jsonl` };
    },
    wake: async () => ({ ok: true }),
    retire: async (p) => void retired.push(p),
    retryMs: [0, 0],
    log: () => {},
    ...over,
  });
  return { t, created, retired };
}

describe("the thread keeper records how the thread answers", () => {
  test("fresh: the thread there is retired with why and the event goes to a new one; its start is recorded", async () => {
    const { t, created, retired } = keeper();
    t.notify("/p", conflict);
    await t.idle("/p");
    t.notify("/p", conflict, { fresh: "it didn't answer for 15 minutes" });
    await t.idle("/p");
    assert.deepEqual(created, ["s1", "s2"]);
    assert.deepEqual(retired, ["/sessions/s1.jsonl"]);
    assert.equal(t.history("/p").at(-1)?.why, "it didn't answer for 15 minutes");
    assert.deepEqual(t.health("/p").restarts?.map((r) => [r.why, r.ok]), [["it didn't answer for 15 minutes", true]]);
    assert.equal(threadInfo(t, "/p")?.health?.restarts.length, 1, "the card's facts carry it");
  });

  test("a refused wake and a fresh thread that can't start are recorded as failures, not only logged", async () => {
    let refuse = false;
    const { t } = keeper({ wake: async () => (refuse ? { ok: false, error: "busy" } : { ok: true }) });
    t.notify("/p", conflict);
    await t.idle("/p");
    refuse = true;
    const k2 = t as unknown as { deps: ThreadDeps };
    k2.deps.create = async () => ({ ok: false, error: "no model" });
    t.notify("/p", conflict);
    await t.idle("/p");
    t.notify("/p", conflict, { fresh: "it didn't answer for 15 minutes" });
    await t.idle("/p");
    const h = t.health("/p");
    assert.ok(h.failures!.some((f) => /refused the message three times \(busy\)/.test(f.error)));
    assert.ok(h.failures!.some((f) => /couldn't start a thread: no model/.test(f.error)));
    assert.deepEqual(h.restarts?.map((r) => [r.ok, r.error]), [[false, "couldn't start a thread: no model"]]);
  });
});

describe("a conflict waiting on the merge thread", () => {
  test("15 minutes: a fresh thread is called in; it failing too tells the user once; the conflict never goes to the chat unjudged", async () => {
    let now = Date.now();
    let restarts: { at: number; ok: boolean; error?: string }[] = [];
    const alerts: string[] = [];
    const k = makeKit({ threadAnswers: true, deps: { now: () => now, threadHealth: () => ({ restarts }), alert: (a) => void alerts.push(a.title) } });
    try {
      // The branch and the target change the same line: a real conflict.
      k.repo.branch("feat/c", { "a.txt": "branch side\n" });
      k.repo.commitOn(k.repo.root, { "a.txt": "main side\n" }, "main moves");
      const q = await k.q();
      const { entry: e0 } = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(e0.id)).state === "conflict", "the conflict waits on the thread");
      await q.recheckNow();
      assert.equal((await k.entry(e0.id)).threadWait?.what, "conflict");
      const before = k.thread.filter((ev) => ev.kind === "conflict").length;
      now += THREAD_DEADLINE_MS + 1000;
      await q.recheckNow();
      const fresh = k.thread.filter((ev) => ev.kind === "conflict");
      assert.equal(fresh.length, before + 1, "handed over again");
      assert.match(fresh.at(-1)!.fresh ?? "", /didn't answer for 15 minutes/);
      let e = await k.entry(e0.id);
      assert.ok(e.threadWait?.fresh, "the fresh start is on the entry");
      assert.equal(alerts.length, 0);
      restarts = [{ at: now, ok: false, error: "no model" }];
      await q.recheckNow();
      await q.recheckNow();
      e = await k.entry(e0.id);
      assert.equal(alerts.length, 1, "told once");
      assert.match(alerts[0]!, /The merge thread isn't answering/);
      assert.equal(e.state, "conflict", "still waiting for a judgement: never to the chat unjudged");
      assert.equal(e.requests?.length ?? 0, 0);
    } finally {
      await k.done();
    }
  });
});
