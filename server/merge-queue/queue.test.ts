import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { MergeFailure, PUSH_HELD_NAMES } from "./queue";
import { DEF, makeKit, makeRepo, sh, until, untilAborted } from "./testing/queue-kit";

/** Landed, and its push answered (pushed or not). */
const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

describe("approval", () => {
  test("Land pins the commit; the run lands exactly the tested merge on master, the main folder moves with it, origin is pushed, the chat is told", async () => {
    const k = makeKit();
    try {
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      const q = await k.q();
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      assert.equal(entry.commit, b.head);
      assert.equal(entry.approval.by, "land-button");
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      const input = k.run.inputs[0]!;
      assert.equal(input.commit, b.head);
      assert.equal(e.landed!.sha, k.repo.head());
      assert.equal(sh(k.repo.root, "rev-parse", "HEAD"), e.landed!.sha, "the main folder is on the landed tip");
      assert.equal(sh(k.repo.root, "status", "--porcelain"), "");
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), e.landed!.sha);
      assert.equal(e.landed!.pushed, "pushed");
      assert.deepEqual(k.notices.map((n) => [n.kind, n.branch, n.session]), [["landed", "feat/a", "s1"]]);
      const v = await q.view();
      assert.equal(v.recent[0]!.entry.id, entry.id);
      assert.equal(v.heads.pushed, e.landed!.sha);
      assert.equal(v.state, "idle");
    } finally {
      await k.done();
    }
  });

  test("refused: the target itself, nothing ahead, a TEMP head, uncommitted files, an unknown branch", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await assert.rejects(q.add({ branch: "master", by: "land-button" }), /the branch others land into/);
      await assert.rejects(q.add({ branch: "nope", by: "land-button" }), (e: unknown) => e instanceof MergeFailure && e.code === "not-found");
      sh(k.repo.root, "branch", "feat/empty");
      await assert.rejects(q.add({ branch: "feat/empty", by: "land-button" }), /nothing to land/);
      const t = k.repo.branch("feat/temp", { "t.txt": "t\n" }, { message: "TEMP: wip" });
      await assert.rejects(q.add({ branch: "feat/temp", by: "land-button" }), /TEMP commit/);
      void t;
      const d = k.repo.branch("feat/dirty", { "d.txt": "d\n" });
      writeFileSync(join(d.path, "d.txt"), "changed\n");
      await assert.rejects(q.add({ branch: "feat/dirty", by: "land-button" }), /1 uncommitted file/);
      assert.equal(q.entries().length, 0);
    } finally {
      await k.done();
    }
  });

  test("a project not set up takes no approval", async () => {
    const k = makeKit({ checks: "unset" });
    try {
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      await assert.rejects((await k.q()).add({ branch: "feat/a", by: "land-button" }), /Not set up/);
    } finally {
      await k.done();
    }
  });

  test("the same commit twice is one entry; a new commit after approval lands the approved one and says how many are not included", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      const first = await q.add({ branch: "feat/a", by: "land-button" });
      const again = await q.add({ branch: "feat/a", by: "land-button" });
      assert.equal(again.entry.id, first.entry.id);
      assert.equal(again.changed, false);
      k.repo.commitOn(b.path, { "c.txt": "c\n" }, "later");
      const v = await q.view();
      assert.equal(v.waiting[0]!.newerCommits, 1);
      await q.resume();
      await landed(k, first.entry.id);
      const e = await k.entry(first.entry.id);
      assert.equal(sh(k.repo.root, "rev-parse", `${e.landed!.sha}^2`), b.head, "the approved commit, not the newer one");
      assert.equal(tryCat(k.repo.root, "c.txt"), null);
    } finally {
      await k.done();
    }
  });

  test("a new Land of a queued branch at a newer commit updates it in place, keeping its place", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      const a = k.repo.branch("feat/a", { "a1.txt": "a\n" });
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const ea = await q.add({ branch: "feat/a", by: "land-button" });
      await q.add({ branch: "feat/b", by: "land-button" });
      const newer = k.repo.commitOn(a.path, { "a2.txt": "a2\n" });
      const again = await q.add({ branch: "feat/a", by: "typed" });
      assert.equal(again.entry.id, ea.entry.id);
      assert.equal(again.entry.commit, newer);
      assert.deepEqual((await q.view()).waiting.map((e) => [e.branch, e.position]), [["feat/a", 1], ["feat/b", 2]]);
    } finally {
      await k.done();
    }
  });

  test("drafts changed since the approval: the entry waits for a new Land", async () => {
    let hash = "h1";
    const k = makeKit({ deps: { draftsHash: () => ({ hash, names: ["x"] }) } });
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      assert.deepEqual(entry.approval.drafts, { hash: "h1", names: ["x"] });
      hash = "h2";
      await q.resume();
      await until(async () => (await k.entry(entry.id)).state === "drafts-changed", "drafts-changed");
      assert.equal((await k.entry(entry.id)).reason, "drafts changed since you approved");
      assert.equal(k.run.inputs.length, 0);
      assert.ok(k.notices.some((n) => n.kind === "drafts-changed"));
      const again = await q.add({ branch: "feat/a", by: "land-button" });
      assert.notEqual(again.entry.id, entry.id);
      assert.equal((await k.entry(entry.id)).state, "cancelled");
      await landed(k, again.entry.id);
    } finally {
      await k.done();
    }
  });
});

describe("one at a time, in order", () => {
  test("two branches land one after the other, each onto the newest master", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "a.txt": "one\ntwo\nthree\nA\n" });
      k.repo.branch("feat/b", { "b.txt": "b\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      const v = await q.view();
      assert.deepEqual(v.waiting.map((e) => e.position), [1, 2]);
      assert.ok(v.waiting[1]!.eta!.startsInMs >= v.waiting[0]!.eta!.takesMs);
      await q.resume();
      await landed(k, b.entry.id);
      const ea = await k.entry(a.entry.id);
      assert.equal(k.run.inputs[1]!.base, ea.landed!.sha, "b ran on master after a landed");
    } finally {
      await k.done();
    }
  });

  test("cancel: a queued entry leaves the line; a checking one's run is voided and master stays", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set((input) => untilAborted(input));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const before = k.repo.head();
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "a's run");
      await q.cancel(b.entry.id);
      assert.equal((await k.entry(b.entry.id)).state, "cancelled");
      await q.cancel(a.entry.id);
      await q.idle();
      assert.equal((await k.entry(a.entry.id)).state, "cancelled");
      assert.equal(q.store.readRun(k.run.inputs[0]!.runId)!.verdict, "cancelled");
      assert.equal(k.repo.head(), before);
      assert.equal(k.run.inputs.length, 1);
      await assert.rejects(q.cancel(a.entry.id), /already cancelled/);
    } finally {
      await k.done();
    }
  });

  test("projects' queues run at the same time: two runs in progress at once, both land", async () => {
    const r1 = makeRepo({ prefix: "mq-p1-" });
    const r2 = makeRepo({ prefix: "mq-p2-" });
    const k1 = makeKit({ repo: r1 });
    const k2 = makeKit({ repo: r2 });
    try {
      let open = 0;
      let both = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const script = async () => {
        open++;
        if (open === 2) {
          both = true;
          release();
        }
        await gate;
        return {};
      };
      k1.run.set(script);
      k2.run.set(script);
      r1.branch("feat/x", { "x.txt": "x\n" });
      r2.branch("feat/y", { "y.txt": "y\n" });
      const a = await (await k1.q()).add({ branch: "feat/x", by: "land-button" });
      const b = await (await k2.q()).add({ branch: "feat/y", by: "land-button" });
      await landed(k1, a.entry.id);
      await landed(k2, b.entry.id);
      assert.ok(both, "both runs were in progress together");
    } finally {
      await k1.done();
      await k2.done();
      r1.done();
      r2.done();
    }
  });
});

describe("failures and blame", () => {
  test("a failure blamed on the branch hands it back to its chat; master stays; the next entry runs", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set((input) => (input.entry.branch === "feat/bad" ? { verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" } : {}));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      k.repo.branch("feat/ok", { "y.txt": "y\n" });
      const before = k.repo.head();
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      const ok = await q.add({ branch: "feat/ok", by: "land-button", session: "s-ok" });
      await landed(k, ok.entry.id);
      const e = await k.entry(bad.entry.id);
      assert.equal(e.state, "needs-fix");
      assert.equal(e.reason, "unit failed: src/a.test.ts");
      assert.deepEqual(k.notices.filter((n) => n.branch === "feat/bad").map((n) => n.kind), ["needs-fix"]);
      assert.ok(k.thread.some((t) => t.kind === "failed" && t.entry.id === bad.entry.id));
      assert.notEqual(k.repo.head(), before);
      assert.equal(sh(k.repo.root, "rev-parse", `${k.repo.head()}^2`), ok.entry.commit);
    } finally {
      await k.done();
    }
  });

  test("flaky and master-red are noted on the landing and don't block", async () => {
    const k = makeKit();
    try {
      k.run.set(() => ({ notes: [{ kind: "flaky", text: "src/x.test.ts passed on a rerun", at: "t" }, { kind: "master-red", text: "src/y.test.ts fails on master too", at: "t" }], targetRed: ["Unit tests"] }));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await (await k.q()).add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.deepEqual(e.notes.map((n) => n.kind), ["flaky", "master-red"]);
      assert.deepEqual((await (await k.q()).view()).heads.targetRed, ["Unit tests"]);
    } finally {
      await k.done();
    }
  });

  test("machine failure: retried once, then the queue pauses; no branch is blamed or told; resume runs it again", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      let fail = true;
      k.run.set(() => (fail ? { verdict: "machine", why: "setup failed on master too" } : {}));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(() => q.isPaused(), "paused");
      assert.equal(k.run.inputs.length, 2, "one retry");
      const v = await q.view();
      assert.equal(v.paused!.kind, "machine");
      assert.match(v.paused!.why, /No branch is blamed/);
      assert.equal((await k.entry(entry.id)).state, "queued");
      assert.deepEqual(k.notices, []);
      assert.ok(k.thread.some((t) => t.kind === "paused"));
      fail = false;
      await q.resume();
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });

  test("a run that throws is a machine failure, never the branch's", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set(() => {
        throw new Error("boom");
      });
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(() => q.isPaused(), "paused");
      assert.equal((await q.view()).paused!.kind, "machine");
      assert.deepEqual(k.notices, []);
    } finally {
      await k.done();
    }
  });
});

describe("conflicts", () => {
  const conflicting = (k: ReturnType<typeof makeKit>) => {
    k.repo.branch("feat/c", { "a.txt": "one\nTWO-branch\nthree\n" });
    k.repo.commitOn(k.repo.root, { "a.txt": "one\nTWO-master\nthree\n" }, "master side");
  };

  test("no thread: handed back at once with the files; the line moves on", async () => {
    const k = makeKit({ threadAnswers: false });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(c.entry.id)).state === "needs-fix", "handed back");
      assert.match((await k.entry(c.entry.id)).reason!, /conflicts with master in 1 file: a\.txt.*no merge thread/);
      assert.deepEqual(k.notices.map((n) => n.kind), ["needs-fix"]);
    } finally {
      await k.done();
    }
  });

  test("the thread judges no behaviour change: its resolution carries the approval and runs first; a sanity failure makes it the user's", async () => {
    let sane = true;
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => (sane ? { ok: true, files: ["a.txt"] } : { ok: false, why: "it changes b.txt, which didn't conflict", files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      assert.deepEqual((await k.entry(c.entry.id)).conflictFiles, ["a.txt"]);
      assert.ok(k.thread.some((t) => t.kind === "conflict" && t.files?.[0] === "a.txt"));
      // A resolution: the merge of master and the pinned commit, by hand.
      const head = k.repo.head();
      const tree = sh(k.repo.root, "write-tree");
      void tree;
      const resolution = resolve(k, head, c.entry.commit, "one\nTWO-both\nthree\n");
      sane = false;
      const bad = await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "says TWO-master", theirs: "says TWO-branch", proposal: "keep both words", commit: resolution });
      assert.equal(bad.state, "behaviour-differs");
      assert.match(bad.reason!, /changes b\.txt/);
      sane = true;
      const good = await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "says TWO-master", theirs: "says TWO-branch", proposal: "keep both words", commit: resolution });
      assert.equal(good.state, "queued");
      await landed(k, c.entry.id);
      const input = k.run.inputs.at(-1)!;
      assert.equal(input.resolution, resolution);
      const e = await k.entry(c.entry.id);
      assert.equal(e.landed!.sha, resolution);
      assert.ok(e.notes.some((n) => n.kind === "resolved" && /keep both words/.test(n.text)));
    } finally {
      await k.done();
    }
  });

  test("behaviour differs: waits for the user; Accept runs the proposal; Send Back hands it back with both sides", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      const e = await q.resolve(c.entry.id, { verdict: "behaviour-differs", ours: "master returns 2", theirs: "the branch returns 3", proposal: "return 3 behind a flag" });
      assert.equal(e.state, "behaviour-differs");
      assert.equal((await q.view()).needsYou[0]!.id, c.entry.id);
      await assert.rejects(q.answer(c.entry.id, "accept"), /no proposed resolution/);
      await q.answer(c.entry.id, "send-back");
      const back = await k.entry(c.entry.id);
      assert.equal(back.state, "needs-fix");
      assert.deepEqual(k.notices.map((n) => n.kind), ["sent-back"]);
      // Accept on another one with a proposed commit.
      const k2 = conflicting2(k);
      const d = await q.add({ branch: k2, by: "land-button" });
      await until(async () => (await k.entry(d.entry.id)).state === "conflict", "conflict 2");
      const res = resolve(k, k.repo.head(), d.entry.commit, "one\nTWO-proposed\nthree\n");
      await q.resolve(d.entry.id, { verdict: "behaviour-differs", ours: "o", theirs: "t", proposal: "p", commit: res });
      await q.answer(d.entry.id, "accept");
      await landed(k, d.entry.id);
    } finally {
      await k.done();
    }
  });

  test("a resolution judged safe that fails a check comes back to the user; the branch isn't blamed", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      conflicting(k);
      k.run.set((input) => (input.resolution ? { verdict: "failed", blame: "resolution", why: "unit failed" } : {}));
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "o", theirs: "t", proposal: "p", commit: resolve(k, k.repo.head(), c.entry.commit, "x\n") });
      await until(async () => (await k.entry(c.entry.id)).state === "behaviour-differs", "back to the user");
      assert.match((await k.entry(c.entry.id)).reason!, /your branch isn't blamed/);
      assert.deepEqual(k.notices, []);
    } finally {
      await k.done();
    }
  });

  test("a thread that never judges: the conflict is handed back after the wait", async () => {
    const k = makeKit({ threadAnswers: true, deps: { conflictWaitMs: 60 } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(c.entry.id)).state === "needs-fix", "handed back");
      assert.match((await k.entry(c.entry.id)).reason!, /didn't judge it in time/);
    } finally {
      await k.done();
    }
  });
});

describe("review", () => {
  test("blocking: waits for the user; Land Anyway lands the tested tip without a rerun; Send Back hands it back", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set((input) => (!input.entry.approval.withoutReview ? { verdict: "review-flagged", review: { verdict: "blocking", text: "dead code left in x.ts", commit: "c", at: "t" } } : {}));
      k.repo.branch("feat/r", { "r.txt": "r\n" });
      const r = await q.add({ branch: "feat/r", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(r.entry.id)).state === "review-flagged", "flagged");
      assert.match((await k.entry(r.entry.id)).reason!, /dead code/);
      const runs = k.run.inputs.length;
      await q.answer(r.entry.id, "land-anyway");
      await landed(k, r.entry.id);
      assert.equal(k.run.inputs.length, runs, "no rerun");
      assert.ok((await k.entry(r.entry.id)).notes.some((n) => n.kind === "review" && /Landed over the review/.test(n.text)));
      k.repo.branch("feat/s", { "s.txt": "s\n" });
      const s = await q.add({ branch: "feat/s", by: "land-button", session: "s2" });
      await until(async () => (await k.entry(s.entry.id)).state === "review-flagged", "flagged 2");
      await q.answer(s.entry.id, "send-back");
      assert.equal((await k.entry(s.entry.id)).state, "needs-fix");
    } finally {
      await k.done();
    }
  });

  test("Land without review reaches the run; a review on a run not checking is refused", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "typed", withoutReview: true });
      assert.equal(entry.approval.withoutReview, true);
      await landed(k, entry.id);
      await assert.rejects(q.review(k.run.inputs[0]!.runId, { verdict: "ok" }), /isn't checking now/);
    } finally {
      await k.done();
    }
  });
});

describe("master moved and the main folder", () => {
  test("master moved from outside during a run: the run is void, the queue pauses and flags it; resume reruns on the new master", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      let wait = true;
      k.run.set((input) => (wait ? untilAborted(input) : {}));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "run");
      const outside = k.repo.commitOn(k.repo.root, { "o.txt": "outside\n" }, "hand commit");
      await until(() => q.isPaused(), "paused");
      const v = await q.view();
      assert.equal(v.paused!.kind, "master-moved");
      assert.match(v.paused!.why, /moved outside the queue/);
      assert.equal(q.store.readRun(k.run.inputs[0]!.runId)!.verdict, "void");
      assert.equal((await k.entry(entry.id)).state, "queued");
      assert.equal(k.repo.head(), outside, "the outside move is allowed");
      wait = false;
      await q.resume();
      await landed(k, entry.id);
      assert.equal(k.run.inputs[1]!.base, outside);
    } finally {
      await k.done();
    }
  });

  test("with an empty line, a move of master from outside is just taken: the next branch runs on it", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, a.entry.id);
      const outside = k.repo.commitOn(k.repo.root, { "o.txt": "1\n" }, "settings apply");
      k.repo.branch("feat/b", { "c.txt": "c\n" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await landed(k, b.entry.id);
      assert.equal(k.run.inputs[1]!.base, outside);
      assert.equal(q.isPaused(), false);
    } finally {
      await k.done();
    }
  });

  test("master moved while Sova was stopped with a branch in line: the queue starts paused and flagged", async () => {
    const repo = makeRepo();
    const k1 = makeKit({ repo });
    try {
      k1.run.set((input) => untilAborted(input));
      repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await (await k1.q()).add({ branch: "feat/a", by: "land-button" });
      await until(() => k1.run.inputs.length === 1, "run");
      await k1.queues.stop();
      repo.commitOn(repo.root, { "o.txt": "x\n" }, "while stopped");
      const k2 = makeKit({ repo });
      try {
        const q2 = await k2.q();
        await until(() => q2.isPaused(), "paused");
        assert.equal((await q2.view()).paused!.kind, "master-moved");
        assert.equal((await k2.entry(entry.id)).state, "queued");
        await q2.resume();
        await landed(k2, entry.id);
      } finally {
        await k2.done();
      }
    } finally {
      await k1.done();
      repo.done();
    }
  });

  test("the main folder has uncommitted edits: nothing is forced, the queue pauses; once clean, resume lands the tested tip", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      writeFileSync(join(k.repo.root, "a.txt"), "edited by hand\n");
      const before = k.repo.head();
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => q.isPaused(), "paused");
      const v = await q.view();
      assert.equal(v.paused!.kind, "main-checkout-dirty");
      assert.match(v.paused!.why, /uncommitted changes/);
      assert.equal(k.repo.head(), before);
      assert.equal(readFileSync(join(k.repo.root, "a.txt"), "utf8"), "edited by hand\n");
      assert.equal(v.checking[0]!.id, entry.id);
      sh(k.repo.root, "checkout", "--", "a.txt");
      await q.resume();
      await landed(k, entry.id);
      assert.equal(k.run.inputs.length, 1, "the tested tip, no rerun");
    } finally {
      await k.done();
    }
  });

  test("a target no checkout holds moves by compare-and-swap; motorsaif-style main", async () => {
    const repo = makeRepo({ target: "main" });
    const k = makeKit({ repo, deps: { definitionAt: async () => ({ def: { ...DEF, merge: { ...DEF.merge!, target: "main" } }, error: null }) } });
    try {
      sh(repo.root, "checkout", "-q", "-b", "elsewhere");
      const q = await k.q();
      assert.equal(q.target, "main");
      repo.branch("feat/m", { "m.txt": "m\n" });
      const { entry } = await q.add({ branch: "feat/m", by: "land-button" });
      await landed(k, entry.id);
      assert.equal(sh(repo.root, "rev-parse", "main"), (await k.entry(entry.id)).landed!.sha);
      assert.equal(sh(repo.origin, "rev-parse", "main"), (await k.entry(entry.id)).landed!.sha);
    } finally {
      await k.done();
      repo.done();
    }
  });
});

describe("push", () => {
  test("a commit on master the queue didn't land (an unpublished release) holds the push, with the reason", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.commitOn(k.repo.root, { "release.txt": "v1\n" }, "release v1");
      await q.resume();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.equal(e.landed!.pushed, "not-pushed");
      assert.match(e.landed!.pushWhy!, /1 commit the queue didn't land/);
      assert.match((await q.view()).heads.pushWhy!, /didn't land/);
      assert.notEqual(sh(k.repo.origin, "rev-parse", "master"), e.landed!.sha);
    } finally {
      await k.done();
    }
  });

  test("origin refusing (it moved on): landed, not pushed, never forced", async () => {
    const k = makeKit();
    try {
      // Someone pushed to origin from elsewhere.
      const other = join(k.repo.scratch, "other");
      sh(k.repo.scratch, "clone", "-q", k.repo.origin, other);
      writeFileSync(join(other, "z.txt"), "z\n");
      sh(other, "add", "z.txt");
      sh(other, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "elsewhere");
      sh(other, "push", "-q", "origin", "master");
      const remote = sh(k.repo.origin, "rev-parse", "master");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await (await k.q()).add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.equal(e.landed!.pushed, "not-pushed");
      assert.match(e.landed!.pushWhy!, /has commits this repository doesn't|isn't in master's history/);
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), remote);
    } finally {
      await k.done();
    }
  });

  test("no private names file: the landing completes, the push is held with exactly the decided words; once written, resume pushes", async () => {
    const k = makeKit({ threadAnswers: true, deps: { legacyNames: undefined } });
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      const e = await k.entry(entry.id);
      assert.equal(e.landed!.pushWhy, PUSH_HELD_NAMES);
      assert.equal((await q.view()).heads.pushWhy, "push held: private names not set up yet");
      const ev = k.thread.find((t) => t.kind === "names")!;
      assert.ok(ev.namesFile!.endsWith("names.json"));
      assert.equal(k.run.inputs[0]!.namesFile, undefined);
      writeFileSync(ev.namesFile!, JSON.stringify({ v: 1, privateNames: ["acme"] }));
      await q.pause("x");
      await q.resume();
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), e.landed!.sha);
      assert.equal((await k.entry(entry.id)).landed!.pushed, "pushed");
      assert.equal((await q.view()).heads.pushWhy, undefined);
    } finally {
      await k.done();
    }
  });

  test("a push hold file holds the push", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      mkdirSync(q.store.dir, { recursive: true });
      writeFileSync(join(q.store.dir, "push-hold"), "release v2 in progress\n");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await landed(k, entry.id);
      assert.equal((await k.entry(entry.id)).landed!.pushWhy, "held: release v2 in progress");
    } finally {
      await k.done();
    }
  });
});

describe("notes and picks", () => {
  test("a note: at most 300 characters, latest wins, empty clears, the operator's stands over the thread's", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await assert.rejects(q.note(entry.id, "x".repeat(301), "thread"), /at most 300/);
      await q.note(entry.id, "changes server code; restart Sova to pick it up", "thread");
      await q.note(entry.id, "regenerated the lockfile", "thread");
      assert.deepEqual((await k.entry(entry.id)).notes.map((n) => [n.kind, n.text]), [["thread", "regenerated the lockfile"]]);
      await q.note(entry.id, "", "thread");
      assert.deepEqual((await k.entry(entry.id)).notes, []);
      await q.note(entry.id, "mine", "operator");
      await q.note(entry.id, "thread's", "thread");
      assert.deepEqual((await k.entry(entry.id)).notes.map((n) => n.text), ["mine"]);
      await q.resume();
      await landed(k, entry.id);
      assert.equal((await q.view()).recent[0]!.entry.notes[0]!.text, "mine");
    } finally {
      await k.done();
    }
  });

  test("the thread's note on a handed-back entry reaches the branch's chat", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "needs-fix", "needs-fix");
      await q.note(entry.id, "the test expects the old error text", "thread");
      assert.deepEqual(k.notices.map((n) => n.kind), ["needs-fix", "explained"]);
    } finally {
      await k.done();
    }
  });

  test("extend adds picks with their reason, never an unknown check; the run gets them", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "statecharts/x.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await assert.rejects(q.extend(entry.id, ["nope"], "why"), /no check "nope"/);
      await assert.rejects(q.extend(entry.id, ["statecharts"], " "), /say why/);
      await q.extend(entry.id, ["statecharts"], "statecharts/ changed");
      await q.resume();
      await landed(k, entry.id);
      assert.deepEqual(k.run.inputs[0]!.picks, [{ id: "statecharts", label: "Statecharts", source: "picked", why: "statecharts/ changed" }]);
      void DEF;
    } finally {
      await k.done();
    }
  });
});

describe("recovery", () => {
  test("a stop during a run: the entry is first in line again and runs from the start", async () => {
    const repo = makeRepo();
    const k1 = makeKit({ repo });
    try {
      k1.run.set((input) => untilAborted(input));
      repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await (await k1.q()).add({ branch: "feat/a", by: "land-button" });
      await until(() => k1.run.inputs.length === 1, "run");
      await k1.queues.stop();
      const k2 = makeKit({ repo });
      try {
        await landed(k2, entry.id);
        assert.equal((await k2.q()).store.readRun(k1.run.inputs[0]!.runId)!.verdict, "void");
      } finally {
        await k2.done();
      }
    } finally {
      await k1.done();
      repo.done();
    }
  });

  test("a landing intent left by a stop: after the move it is finished once (pushed, told); before it, requeued; elsewhere, paused", async () => {
    const repo = makeRepo();
    try {
      // Before the move: the intent names a tip master never reached.
      repo.branch("feat/a", { "b.txt": "b\n" });
      const k1 = makeKit({ repo });
      const q1 = await k1.q();
      await q1.pause("hold");
      const a = await q1.add({ branch: "feat/a", by: "land-button" });
      await k1.queues.stop();
      const file = join(q1.store.dir, "queue.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      delete raw.paused;
      const base = repo.head();
      const tip = sh(repo.root, "commit-tree", sh(repo.root, "rev-parse", `${a.entry.commit}^{tree}`), "-p", base, "-p", a.entry.commit, "-m", "Merge");
      raw.entries[0].state = "checking";
      raw.entries[0].run = "mr_0intent";
      raw.intent = { run: "mr_0intent", entry: a.entry.id, from: base, to: tip, at: "t" };
      writeFileSync(file, JSON.stringify(raw));
      q1.store.writeRun({ id: "mr_0intent", entry: a.entry.id, project: repo.root, branch: "feat/a", base, commit: a.entry.commit, tip, steps: [], checks: [], verdict: "running", startedAt: "t" });
      // After the move (master at the tip): finished once.
      sh(repo.root, "merge", "-q", "--ff-only", tip);
      const k2 = makeKit({ repo });
      try {
        await landed(k2, a.entry.id);
        const e = await k2.entry(a.entry.id);
        assert.equal(e.landed!.sha, tip);
        assert.equal(sh(repo.origin, "rev-parse", "master"), tip);
        assert.deepEqual(k2.notices.map((n) => n.kind), ["landed"]);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).intent, undefined);
        assert.equal(sh(repo.root, "rev-list", "--count", `${base}..master`), "2", "one merge, never two");
      } finally {
        await k2.done();
      }
    } finally {
      repo.done();
    }
  });

  test("an intent whose move never happened is requeued and lands normally; master elsewhere pauses for a look", async () => {
    const repo = makeRepo();
    try {
      repo.branch("feat/a", { "b.txt": "b\n" });
      const k1 = makeKit({ repo });
      const q1 = await k1.q();
      await q1.pause("hold");
      const a = await q1.add({ branch: "feat/a", by: "land-button" });
      await k1.queues.stop();
      const file = join(q1.store.dir, "queue.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      delete raw.paused;
      raw.entries[0].state = "checking";
      raw.intent = { run: "mr_0x", entry: a.entry.id, from: repo.head(), to: "f".repeat(40), at: "t" };
      writeFileSync(file, JSON.stringify(raw));
      const k2 = makeKit({ repo });
      try {
        await landed(k2, a.entry.id);
      } finally {
        await k2.done();
      }
      // Elsewhere.
      repo.branch("feat/b", { "c.txt": "c\n" });
      const k3 = makeKit({ repo });
      const q3 = await k3.q();
      await q3.pause("hold");
      const b = await q3.add({ branch: "feat/b", by: "land-button" });
      await k3.queues.stop();
      const raw3 = JSON.parse(readFileSync(file, "utf8"));
      delete raw3.paused;
      raw3.entries.find((x: { id: string }) => x.id === b.entry.id).state = "checking";
      raw3.intent = { run: "mr_0y", entry: b.entry.id, from: "e".repeat(40), to: "f".repeat(40), at: "t" };
      writeFileSync(file, JSON.stringify(raw3));
      const k4 = makeKit({ repo });
      try {
        const q4 = await k4.q();
        assert.equal((await q4.view()).paused?.kind, "recovery");
        assert.equal((await k4.entry(b.entry.id)).state, "queued");
      } finally {
        await k4.done();
      }
    } finally {
      repo.done();
    }
  });

  test("a damaged queue file reads as empty and is kept aside", async () => {
    const repo = makeRepo();
    const k = makeKit({ repo });
    try {
      const q = await k.q();
      await q.pause("hold");
      writeFileSync(join(q.store.dir, "queue.json"), "{not json");
      const read = q.store.read({ project: "p", target: "master" });
      assert.deepEqual(read.entries, []);
      assert.ok(!existsSync(join(q.store.dir, "queue.json")));
    } finally {
      await k.done();
      repo.done();
    }
  });
});

// ---- helpers ------------------------------------------------------------------------------------

function tryCat(root: string, file: string): string | null {
  try {
    return sh(root, "show", `master:${file}`);
  } catch {
    return null;
  }
}

/** A hand-made resolution: a merge commit of `base` and `commit` whose a.txt is `text`. */
function resolve(k: ReturnType<typeof makeKit>, base: string, commit: string, text: string): string {
  const blob = execGit(k.repo.root, ["hash-object", "-w", "--stdin"], text);
  const tree = sh(k.repo.root, "rev-parse", `${commit}^{tree}`);
  const entries = sh(k.repo.root, "ls-tree", tree).split("\n").map((l) => (l.endsWith("\ta.txt") ? l.replace(/blob [0-9a-f]+/, `blob ${blob}`) : l));
  const newTree = execGit(k.repo.root, ["mktree"], `${entries.join("\n")}\n`);
  return sh(k.repo.root, "commit-tree", newTree, "-p", base, "-p", commit, "-m", "resolve");
}

function conflicting2(k: ReturnType<typeof makeKit>): string {
  k.repo.branch("feat/d", { "a.txt": "one\nTWO-d\nthree\n" });
  k.repo.commitOn(k.repo.root, { "a.txt": "one\nTWO-master-again\nthree\n" }, "master side again");
  return "feat/d";
}

import { execFileSync } from "node:child_process";
function execGit(cwd: string, args: string[], input: string): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}
