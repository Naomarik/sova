import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeKit, until, untilAborted } from "./testing/queue-kit";

/** Landed, and its push answered. */
const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

describe("clean runs in the queue", () => {
  test("the first run with none recorded is the weekly one; then the copy is reused; Clean Run makes the next one clean, once", async () => {
    const k = makeKit();
    try {
      // The run says it was clean exactly when the queue asked it to be.
      k.run.set((input) => (input.clean ? { clean: input.clean } : {}));
      const q = await k.q();
      k.repo.branch("feat/a", { "a.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, a.entry.id);
      assert.equal(k.run.inputs[0]!.clean, "weekly");
      const v1 = await q.view();
      assert.equal(v1.clean?.last?.why, "weekly");
      assert.equal(v1.clean?.last?.run, (await k.entry(a.entry.id)).run);
      assert.equal(v1.clean?.next, undefined);

      k.repo.branch("feat/b", { "b.txt": "b\n" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await landed(k, b.entry.id);
      assert.equal(k.run.inputs[1]!.clean, undefined, "a week hasn't passed: the copy is reused");

      const asked = await q.cleanRun();
      assert.equal(asked.clean?.next?.why, "operator");
      k.repo.branch("feat/c", { "c.txt": "c\n" });
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await landed(k, c.entry.id);
      assert.equal(k.run.inputs[2]!.clean, "operator");
      assert.equal((await q.view()).clean?.next, undefined, "the ask is spent by the run that was clean");

      k.repo.branch("feat/d", { "d.txt": "d\n" });
      const d = await q.add({ branch: "feat/d", by: "land-button" });
      await landed(k, d.entry.id);
      assert.equal(k.run.inputs[3]!.clean, undefined);
    } finally {
      await k.done();
    }
  });

  test("Clean Run on the entry checking now stops its run and starts it again, clean; the voided run spends nothing", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      // Spend the first-run weekly clean, so the restart's clean can only come from the ask.
      k.run.set((input) => (input.clean ? { clean: input.clean } : {}));
      k.repo.branch("feat/warm", { "w.txt": "w\n" });
      await landed(k, (await q.add({ branch: "feat/warm", by: "land-button" })).entry.id);
      k.run.set((input) => (input.clean === "operator" ? { clean: "operator" } : untilAborted(input)));
      k.repo.branch("feat/a", { "a.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 2 && q.currentRun(), "its run started");
      const first = q.currentRun()!.id;
      await q.cleanRun(entry.id);
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.equal(e.runs.length, 2);
      assert.equal(e.runs[0], first);
      const voided = q.store.readRun(first)!;
      assert.equal(voided.verdict, "void");
      assert.match(voided.why ?? "", /clean run/);
      assert.equal(k.run.inputs[1]!.clean, undefined);
      assert.equal(k.run.inputs[2]!.clean, "operator");
      assert.equal((await q.view()).clean?.last?.run, e.runs[1]);
    } finally {
      await k.done();
    }
  });

  test("Clean Run on a failed run whose Land stands checks the same commit again, clean, counting no try", async () => {
    const k = makeKit();
    try {
      let n = 0;
      k.run.set((input) => (n++ === 0 ? { verdict: "failed", blame: "branch", why: "unit failed" } : input.clean ? { clean: input.clean } : {}));
      const q = await k.q();
      const b = k.repo.branch("feat/a", { "a.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(async () => (await k.entry(entry.id)).state === "with-chat", "back with its chat");
      const tries = (await k.entry(entry.id)).tries?.used;
      await q.cleanRun(entry.id);
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.equal(e.commit, b.head);
      assert.equal(e.tries?.used, tries);
      assert.equal(k.run.inputs.at(-1)!.clean, "operator");
    } finally {
      await k.done();
    }
  });
});

describe("a Clean Run's ask and its entry", () => {
  test("asked on an entry that is then removed: the ask goes with it", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold the line");
      k.repo.branch("feat/a", { "a.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      assert.equal((await q.cleanRun(entry.id)).clean?.next?.entry, entry.id);
      await q.cancel(entry.id);
      assert.equal((await q.view()).clean?.next, undefined);
    } finally {
      await k.done();
    }
  });
});

describe("flaky tests in the queue", () => {
  test("a run's flaky tests are counted across landings and shown on the view; a voided run's are not", async () => {
    const k = makeKit();
    try {
      const seen = [{ check: "unit", label: "Unit", file: "a.test.ts" }];
      let voidOnce = true;
      k.run.set(async (input) => {
        if (input.entry.branch === "feat/v" && voidOnce) {
          voidOnce = false;
          return { verdict: "void", flaky: seen };
        }
        return { flaky: seen };
      });
      const q = await k.q();
      for (const name of ["feat/a", "feat/v", "feat/b"]) {
        k.repo.branch(name, { [`${name.slice(5)}.txt`]: "x\n" });
        await landed(k, (await q.add({ branch: name, by: "land-button" })).entry.id);
      }
      const [t] = q.flaky.list();
      assert.equal(t?.count, 3, "feat/a, feat/v's second run and feat/b: never the voided run");
      assert.deepEqual(t!.runs.map((r) => r.branch), ["feat/b", "feat/v", "feat/a"]);
      assert.equal((await q.view()).flaky?.[0]?.key, t!.key);
      const h = q.health(30);
      assert.equal(h.flaky[0]?.count, 3);
      assert.equal(q.historyPage({ branch: "feat/v" }).rows[0]?.runs, 2);
    } finally {
      await k.done();
    }
  });
});
