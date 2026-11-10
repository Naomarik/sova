import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HOLD_MS, HOLD_WORDS } from "./queue";
import { makeKit, makeRepo, until, untilAborted } from "./testing/queue-kit";

type Kit = ReturnType<typeof makeKit>;
/** After a kickSoon: its start has run (the kick's microtask queues it on the chain before this one). */
const settled = async (q: Awaited<ReturnType<Kit["q"]>>) => {
  await new Promise<void>((r) => queueMicrotask(r));
  await q.serial(async () => {});
};
const idles = (k: Kit) => k.thread.filter((t) => t.kind === "idle");
/** Landed, and its push answered. */
const landed = (k: Kit, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

describe("the thread's idle wake", () => {
  test("after a landing, once, naming the newest landing and the target's head", async () => {
    const k = makeKit();
    try {
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const q = await k.q();
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const [idle] = await until(() => (idles(k).length ? idles(k) : null), "idle");
      const e = await k.entry(entry.id);
      assert.equal(idle!.entry.id, entry.id);
      assert.deepEqual(idle!.lastLanded, { id: entry.id, branch: "feat/a", sha: e.landed!.sha });
      assert.equal(idle!.head, e.landed!.sha);
      // A later kick with nothing new to tell sends no second one.
      q.kickSoon();
      await settled(q);
      assert.equal(idles(k).length, 1);
    } finally {
      await k.done();
    }
  });

  test("after a failure and after a conflict left waiting for the merge thread", async () => {
    const k = makeKit({ threadAnswers: false });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      k.repo.branch("feat/bad", { "bad.txt": "x\n" });
      const q = await k.q();
      const bad = await q.add({ branch: "feat/bad", by: "land-button" });
      await until(async () => (await k.entry(bad.entry.id)).state === "with-chat", "sent back");
      await until(() => idles(k).length === 1, "idle after the failure");
      assert.equal(idles(k)[0]!.entry.id, bad.entry.id);
      assert.equal(idles(k)[0]!.lastLanded, undefined, "nothing landed yet");

      k.run.set(() => ({}));
      k.repo.branch("feat/c", { "a.txt": "one\nTWO-branch\nthree\n" });
      // The target moves after the Land (one conflicting at Land waits for a fix, al_3 q7).
      await q.pause("setting up a conflict");
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      k.repo.commitOn(k.repo.root, { "a.txt": "one\nTWO-master\nthree\n" }, "master side");
      await q.resume();
      // No thread to judge it: under the standing Land it waits for the thread, out of the line (never sent to the chat).
      await until(async () => /waiting for the merge thread/.test((await k.entry(c.entry.id)).reason ?? ""), "conflict waits for the thread");
      await until(() => idles(k).length === 2, "idle after the conflict");
      assert.equal(idles(k)[1]!.entry.id, c.entry.id);
    } finally {
      await k.done();
    }
  });

  test("not while another entry waits: one idle, after the last of the line", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await q.resume();
      await landed(k, a.entry.id);
      await landed(k, b.entry.id);
      await until(() => idles(k).length === 1, "idle");
      assert.equal(k.thread.filter((t) => t.kind === "idle").length, 1);
      assert.equal(idles(k)[0]!.lastLanded!.id, b.entry.id);
    } finally {
      await k.done();
    }
  });

  test("a cancel that empties the queue sends it; one that leaves an entry waiting doesn't", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await q.cancel(a.entry.id);
      await settled(q);
      assert.equal(idles(k).length, 0, "feat/b still waits");
      await q.cancel(b.entry.id);
      const [idle] = await until(() => (idles(k).length ? idles(k) : null), "idle after the last cancel");
      assert.equal(idle!.entry.id, b.entry.id);
    } finally {
      await k.done();
    }
  });

  test("a release's hold lifting sends it again (what the thread put off during the release is owed now)", async () => {
    const k = makeKit();
    try {
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const q = await k.q();
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, a.entry.id);
      await until(() => idles(k).length === 1, "idle after the landing");
      await q.freezeForRelease({ id: "rl_1" });
      await settled(q);
      assert.equal(idles(k).length, 1, "freezing alone tells nothing");
      await q.abandonRelease({ release: "rl_1" });
      await until(() => idles(k).length === 2, "idle after the release lifted");
      assert.equal(idles(k)[1]!.lastLanded!.id, a.entry.id);
    } finally {
      await k.done();
    }
  });

  test("a cancel of the running entry, with nothing behind it, sends it", async () => {
    const k = makeKit();
    try {
      k.run.set((input) => untilAborted(input));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const q = await k.q();
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "running");
      assert.equal(idles(k).length, 0);
      await q.cancel(a.entry.id);
      await until(() => idles(k).length === 1, "idle after the cancel");
    } finally {
      await k.done();
    }
  });
});

describe("the merge thread's hold (merge.hold)", () => {
  test("held: nothing starts and the waiting entry says Sova is restarting; cleared: it runs and the words go", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      const set = await q.hold("set");
      assert.equal(set.changed, true);
      assert.ok(set.hold && Date.parse(set.hold.until) > Date.now());
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await until(async () => (await k.entry(a.entry.id)).reason === HOLD_WORDS, "the hold's words");
      await settled(q);
      assert.equal(k.run.inputs.length, 0, "no run started under the hold");
      assert.equal((await k.entry(a.entry.id)).state, "queued");
      assert.equal(q.isPaused(), false, "a hold is not a pause");
      const clear = await q.hold("clear");
      assert.deepEqual(clear, { changed: true, hold: null });
      await landed(k, a.entry.id);
      assert.notEqual((await k.entry(a.entry.id)).reason, HOLD_WORDS);
      assert.equal((await q.hold("clear")).changed, false, "nothing to clear");
    } finally {
      await k.done();
    }
  });

  test("it lifts by itself after 5 minutes", async () => {
    let t = Date.parse("2026-11-05T10:00:00Z");
    const k = makeKit({ deps: { now: () => t } });
    try {
      const q = await k.q();
      await q.hold("set");
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await until(async () => (await k.entry(a.entry.id)).reason === HOLD_WORDS, "held");
      t += HOLD_MS - 1;
      q.kickSoon();
      await settled(q);
      assert.equal(k.run.inputs.length, 0, "still held a moment before");
      t += 2;
      q.kickSoon();
      await landed(k, a.entry.id);
      assert.equal(q.holdNow(), null);
      assert.equal(q.file.hold, undefined);
    } finally {
      await k.done();
    }
  });

  test("a server start lifts it", async () => {
    const repo = makeRepo();
    const k1 = makeKit({ repo });
    try {
      const q1 = await k1.q();
      await q1.hold("set");
      assert.ok(q1.file.hold);
      await k1.queues.stop();
      const k2 = makeKit({ repo });
      try {
        const q2 = await k2.q();
        assert.equal(q2.file.hold, undefined);
        assert.equal(q2.holdNow(), null);
        repo.branch("feat/a", { "a1.txt": "a\n" });
        const a = await q2.add({ branch: "feat/a", by: "land-button" });
        await landed(k2, a.entry.id);
      } finally {
        await k2.done();
      }
    } finally {
      await k1.done();
      repo.done();
    }
  });
});
