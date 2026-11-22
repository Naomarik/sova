import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type PauseInfo, restartCount } from "../../shared/merge-queue";
import { makeKit, makeRepo, until, untilAborted } from "./testing/queue-kit";

/** The event memory and the plan, driven through the queue (§app.merge-queue/activity, §app.merge-queue/plan). */

const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

describe("a landing's recorded changes", () => {
  test("approved, run started with its plan, steps, run ended, landed and pushed, in that order; every run event names its run and a plan step", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await landed(k, entry.id);
      const run = q.store.readRun(k.run.inputs[0]!.runId)!;
      const events = q.events({ entry: entry.id }).events.reverse();
      assert.deepEqual(
        events.map((e) => e.kind),
        ["approved", "run-started", "step-ended", "run-ended", "landed", "pushed"],
      );
      assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq));
      const started = events[1]! as Extract<(typeof events)[number], { kind: "run-started" }>;
      assert.equal(started.fingerprint, run.plan!.fingerprint, "the run started on its saved plan");
      for (const e of events.filter((x) => x.kind === "step-ended" || x.kind === "landed" || x.kind === "pushed")) {
        assert.equal(e.run, run.id);
        assert.ok(run.plan!.steps.some((s) => s.id === e.step), `${e.kind} names plan step ${e.step}`);
      }
      assert.match(events[0]!.why, /^Approved at [0-9a-f]{7} by Land\.$/);
      assert.deepEqual(
        (await q.view()).events!.slice(0, 2).map((e) => e.kind),
        ["pushed", "landed"],
        "the view carries the newest first",
      );
      const report = q.events({ entry: entry.id, limit: 1 });
      assert.equal(report.more, true);
    } finally {
      await k.done();
    }
  });

  test("the run gets the plan's own check list, and its plan says which optional checks it leaves out and why", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const input = k.run.inputs[0]!;
      assert.deepEqual(input.planned?.map((c) => `check:${c.id}`), input.plan!.steps.filter((s) => s.kind === "check" && s.will === "run").map((s) => s.id));
      assert.equal(q.store.readRun(input.runId)!.plan!.fingerprint, input.plan!.fingerprint);
      assert.ok(q.store.readRun(input.runId)!.ranWith!.settings.some((s) => s.name === "How it lands"));
    } finally {
      await k.done();
    }
  });
});

describe("restarts", () => {
  test("the target moving under a run counts one restart by its cause, kept across a reload; the next run plans afresh on the new base", async () => {
    const repo = makeRepo();
    const k = makeKit({ repo });
    try {
      const q = await k.q();
      let wait = true;
      k.run.set((input) => (wait ? untilAborted(input) : {}));
      repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "run");
      repo.commitOn(repo.root, { "o.txt": "outside\n" }, "hand commit");
      await until(() => q.isPaused(), "paused");
      assert.deepEqual((await k.entry(entry.id)).restarts, { "target-moved": 1 });
      const kinds = q.events({ entry: entry.id }).events.map((e) => e.kind);
      assert.ok(kinds.indexOf("run-ended") > kinds.indexOf("run-restarted"), "newest first: the run's end is recorded before what came of it");
      await k.queues.stop();
      const k2 = makeKit({ repo });
      const q2 = await k2.q();
      assert.equal(restartCount(q2.entry(entry.id)!), 1, "the count survives a reload");
      wait = false;
      k2.run.set(() => ({}));
      await q2.resume();
      await landed(k2, entry.id);
      const first = k.run.inputs[0]!.plan!;
      const second = k2.run.inputs[0]!.plan!;
      assert.notEqual(second.inputs.base, first.inputs.base);
      assert.notEqual(second.fingerprint, first.fingerprint);
      await k2.done();
    } finally {
      await k.done();
    }
  });
});

describe("pauses", () => {
  test("the queue pausing itself is recorded so and notified once; the operator's own pause is neither", async () => {
    const told: PauseInfo[] = [];
    const k = makeKit({ deps: { pausedSelf: (p) => told.push(p) } });
    try {
      const q = await k.q();
      await q.pause("lunch");
      await q.resume();
      assert.equal(told.length, 0);
      let wait = true;
      k.run.set((input) => (wait ? untilAborted(input) : {}));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "run");
      k.repo.commitOn(k.repo.root, { "o.txt": "x\n" }, "hand commit");
      await until(() => q.isPaused(), "paused");
      wait = false;
      assert.deepEqual(told.map((p) => [p.kind, p.self]), [["master-moved", true]]);
      const paused = q.events({ kind: "paused" }).events.map((e) => (e.kind === "paused" ? [e.pause, e.self, e.by] : []));
      assert.deepEqual(paused, [
        ["master-moved", true, "queue"],
        ["operator", false, "user"],
      ]);
      assert.equal(q.events({ kind: "resumed" }).events.length, 1);
    } finally {
      await k.done();
    }
  });
});

describe("waiting", () => {
  test("a branch behind another is recorded waiting behind it once, not at every save", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      let wait = true;
      k.run.set((input) => (wait ? new Promise((r) => setTimeout(() => r({}), 150)) : {}));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      q.save();
      q.save();
      wait = false;
      await landed(k, a.entry.id);
      await landed(k, b.entry.id);
      const waits = q.events({ entry: b.entry.id, kind: "waiting" }).events;
      assert.equal(waits.length, 1);
      assert.equal(waits[0]!.kind === "waiting" && waits[0]!.behind, "feat/a's run");
    } finally {
      await k.done();
    }
  });
});
