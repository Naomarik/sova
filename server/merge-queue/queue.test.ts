import type { QueueFile } from "./store";
import assert from "node:assert/strict";
import { decisionPush } from "./rulings";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { draftsHash } from "../spec-drafts-state";
import { MergeFailure, PUSH_HELD_NAMES, PUSH_WAITS_NEXT_LANDING, type QueueDeps } from "./queue";
import { writeOverride } from "./strategy";
import { DEF, makeKit, makeRepo, sh, tryGit, until, untilAborted } from "./testing/queue-kit";
import { WorktreeOwners } from "./owners";
import { BranchSummaries, readBranchFacts } from "./branch-summaries";
import { realGit } from "./guard";
import { SummarySweep } from "./summary-sweep";
import { makeScratchCopy } from "./scratch";
import type { SessionSummary } from "../../shared/protocol";

/** An approval given before al_3 (no standing approval): its hand-back is final (needs-fix), as it was then. The queue
 *  is paused while the entry's record is made legacy, so its run starts only after. */
async function legacyAdd(q: Awaited<ReturnType<ReturnType<typeof makeKit>["q"]>>, req: Parameters<Awaited<ReturnType<ReturnType<typeof makeKit>["q"]>>["add"]>[0]) {
  await q.pause("an approval from before the standing Land");
  const r = await q.add(req);
  const e = q.entry(r.entry.id)!;
  delete e.approval.standing;
  delete e.approval.userCommit;
  q.save();
  await q.resume();
  return r;
}

/** Landed, and its push answered (pushed or not). */
const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

describe("the session list's view", () => {
  test("a fresh view says a sent-back branch settled at once; the timed view may still say it hasn't", async () => {
    const k = makeKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      const q = await k.q();
      const b = k.repo.branch("feat/bad", { "bad.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/bad", by: "land-button" });
      // Back with its chat under the user's standing Land: it reads on the same list, and settles the same way.
      await until(async () => (await k.entry(entry.id)).state === "with-chat", "back with its chat");
      assert.equal((await q.view()).needsFix[0]?.settled, undefined);
      sh(k.repo.root, "worktree", "remove", "--force", b.path);
      sh(k.repo.root, "branch", "-D", "feat/bad");
      assert.equal((await q.view()).needsFix[0]?.settled, undefined, "the head is unmoved: the 15 s cache answers");
      assert.equal((await q.view({ fresh: true })).needsFix[0]?.settled, "gone");
    } finally {
      await k.done();
    }
  });
});

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
      await assert.rejects(q.add({ branch: "feat/empty", by: "land-button" }), /^.*Nothing to land: everything on this branch is already on master\.$/);
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

  describe("tracked drafts: only the branch's own", () => {
    // Many stale drafts committed on the target (a project that tracks .sova/spec/drafts).
    const stale = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`.sova/spec/drafts/old-${i}/spec/claims/a.md`, `stale ${i}\n`]));

    test("the kit's commits start no git background maintenance (its repack under the next reads loses objects)", () => {
      // `git commit` spawns `git maintenance run --auto --detach` before it exits whenever maintenance.auto is on, so the
      // commit's trace2 names it every time: no timing involved.
      const repo = makeRepo();
      const trace = join(repo.scratch, "trace2.json");
      const was = process.env.GIT_TRACE2_EVENT;
      try {
        process.env.GIT_TRACE2_EVENT = trace;
        repo.commitOn(repo.root, stale(300), "stale drafts");
        repo.branch("feat/comment", { "a.txt": "// a comment\n" });
        const events = readFileSync(trace, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { event: string; argv?: string[] });
        const argv = (kind: string) => events.filter((e) => e.event === kind).map((e) => (e.argv ?? []).join(" "));
        assert.equal(argv("start").filter((a) => / commit -q\b/.test(a)).length, 2, "both commits were traced");
        assert.deepEqual([...argv("start"), ...argv("child_start")].filter((a) => /(^|\/)git (maintenance|gc|repack)\b/.test(a)), [], "no background cleanup started");
      } finally {
        if (was === undefined) delete process.env.GIT_TRACE2_EVENT;
        else process.env.GIT_TRACE2_EVENT = was;
        repo.done();
      }
    });

    test("a comment-only branch over hundreds of stale tracked drafts names none and lands", async () => {
      const k = makeKit({ deps: { draftsHash: (dir: string) => draftsHash(dir) } });
      try {
        k.repo.commitOn(k.repo.root, stale(300), "stale drafts");
        const q = await k.q();
        await q.pause("hold");
        k.repo.branch("feat/comment", { "a.txt": "// a comment\n" });
        const { entry } = await q.add({ branch: "feat/comment", by: "land-button" });
        assert.equal(entry.approval.drafts, undefined, "no draft of the branch's own");
        await q.resume();
        await landed(k, entry.id);
        assert.equal(k.run.inputs[0]!.draftsDir, undefined, "no drafts handed to the docs step");
        assert.equal(sh(k.repo.root, "ls-tree", "-r", "--name-only", "master", "--", ".sova/spec/drafts").split("\n").length, 300, "stale drafts untouched");
      } finally {
        await k.done();
      }
    });

    test("a branch that changes one tracked draft (and adds an untracked one) names exactly those; a later edit to a stale draft in its worktree changes nothing", async () => {
      const k = makeKit({ deps: { draftsHash: (dir: string) => draftsHash(dir) } });
      try {
        k.repo.commitOn(k.repo.root, stale(20), "stale drafts");
        const q = await k.q();
        await q.pause("hold");
        const b = k.repo.branch("feat/one", { ".sova/spec/drafts/old-3/spec/claims/a.md": "changed\n", "x.txt": "x\n" });
        // An untracked draft (ignored locally, as Sova's own drafts are) is the branch's, as before.
        writeFileSync(join(k.repo.root, ".git/info/exclude"), ".sova/spec/drafts/fresh/\n");
        mkdirSync(join(b.path, ".sova/spec/drafts/fresh/spec"), { recursive: true });
        writeFileSync(join(b.path, ".sova/spec/drafts/fresh/spec/b.md"), "new\n");
        const { entry } = await q.add({ branch: "feat/one", by: "land-button" });
        assert.deepEqual(entry.approval.drafts?.names, ["fresh", "old-3"]);
        // Editing a draft the branch doesn't own (uncommitted, outside the approval) is not "drafts changed".
        writeFileSync(join(b.path, ".sova/spec/drafts/old-7/spec/claims/a.md"), "local edit\n");
        // What the run carried, read while it runs: the copy is deleted once the run is done with it.
        let carried: string[] = [];
        k.run.set((input) => {
          carried = input.draftsDir && existsSync(input.draftsDir) ? readdirSync(input.draftsDir).sort() : [];
          return {};
        });
        await q.resume();
        await landed(k, entry.id);
        const input = k.run.inputs[0]!;
        assert.ok(input.draftsDir);
        assert.deepEqual(carried, ["fresh", "old-3"], "the branch's own drafts, not old-7");
        assert.equal(existsSync(input.draftsDir!), false, "the run's drafts copy is gone once it ended");
        assert.ok(existsSync(join(input.runDir, "run.json")), "its record stays");
      } finally {
        await k.done();
      }
    });

    test("a change to the branch's own tracked draft after approval still waits for a new Land", async () => {
      const k = makeKit({ deps: { draftsHash: (dir: string) => draftsHash(dir) } });
      try {
        k.repo.commitOn(k.repo.root, stale(5), "stale drafts");
        const q = await k.q();
        await q.pause("hold");
        const b = k.repo.branch("feat/own", { ".sova/spec/drafts/old-1/spec/claims/a.md": "mine\n" });
        const { entry } = await q.add({ branch: "feat/own", by: "land-button" });
        assert.deepEqual(entry.approval.drafts?.names, ["old-1"]);
        writeFileSync(join(b.path, ".sova/spec/drafts/old-1/spec/claims/a.md"), "mine, edited\n");
        await q.resume();
        await until(async () => (await k.entry(entry.id)).decision?.kind === "drafts-changed", "a Drafts changed decision");
      } finally {
        await k.done();
      }
    });
  });

  test("drafts changed since the approval with no request: the entry waits for the user's decision; its Land takes them as they are now", async () => {
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
      await until(async () => (await k.entry(entry.id)).state === "needs-user", "waits for the user");
      const e = await k.entry(entry.id);
      assert.equal(e.decision?.kind, "drafts-changed");
      assert.match(e.reason ?? "", /spec drafts changed since your Land/);
      assert.equal(k.run.inputs.length, 0);
      assert.equal(k.notices.filter((n) => n.kind === "decision").length, 1, "one notice: the decision");
      await q.answer(entry.id, "land");
      assert.deepEqual((await k.entry(entry.id)).approval.drafts, { hash: "h2", names: ["x"] }, "re-pinned as they are now");
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });
});

describe("sent back for its drafts", () => {
  /** A kit whose drafts and docs check the test moves by hand. */
  const draftsKit = () => {
    const d = { hash: "h1", print: "p1", check: { problems: [] as string[] } as { problems: string[] } | "pending", checked: [] as string[] };
    const k = makeKit({
      deps: {
        draftsHash: () => ({ hash: d.hash, names: ["x"] }),
        draftsFingerprint: () => d.print,
        docsCheck: (_dir, commit) => (d.checked.push(commit), d.check),
      },
    });
    return { d, k };
  };
  const readyAt = (v: { ready?: { branch: string; commit: string }[] }, branch: string, commit: string) => (v.ready ?? []).some((r) => r.branch === branch && r.commit === commit);

  test("Land comes back at the same commit once its drafts changed and the docs check reads clean; a problem or a check still running keeps it sent back", async () => {
    const { d, k } = draftsKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", cause: "drafts", why: "your spec drafts don't fit" }));
      const q = await k.q();
      const b = k.repo.branch("feat/doc", { "b.txt": "b\n" });
      const { entry } = await legacyAdd(q, { branch: "feat/doc", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "needs-fix", "sent back");
      const e = await k.entry(entry.id);
      assert.equal(e.sentBackFor, "drafts");
      assert.equal(e.sentBackDrafts, "p1", "the drafts folder as it was at the hand-back");
      let v = await q.view({ fresh: true });
      assert.ok(!readyAt(v, "feat/doc", b.head), "unchanged drafts: no Land at the sent-back commit");
      assert.equal(v.needsFix[0]?.redrafted, undefined);
      assert.equal(v.needsFix[0]?.sentBackFor, "drafts");

      // Only a note recorded (draft.json): the drafts' hash is the same, the folder isn't.
      d.print = "p2";
      d.check = { problems: ["§b/x: no verification note"] };
      v = await q.view({ fresh: true });
      assert.ok(!readyAt(v, "feat/doc", b.head) && !v.needsFix[0]?.redrafted, "the docs check still finds a problem: still sent back");
      d.check = "pending";
      v = await q.view({ fresh: true });
      assert.ok(!readyAt(v, "feat/doc", b.head) && !v.needsFix[0]?.redrafted, "the check still running: not yet");
      assert.ok(d.checked.every((c) => c === b.head), "checked at the sent-back commit");

      d.check = { problems: [] };
      const published = k.views.length;
      v = await q.view({ fresh: true });
      assert.ok(readyAt(v, "feat/doc", b.head), "Ready to land again at the same commit");
      assert.equal(v.needsFix[0]?.redrafted, true);
      await until(() => k.views.slice(published).some((x) => x.needsFix.some((n) => n.id === entry.id && n.redrafted)), "the change is published with no save");

      // Land This Commit Again: a new approval of the same commit with the drafts as they are now, run from the start.
      k.run.set(null);
      d.hash = "h1";
      const again = await q.add({ branch: "feat/doc", commit: b.head, by: "land-button" });
      assert.notEqual(again.entry.id, entry.id);
      assert.equal(again.entry.commit, b.head);
      await landed(k, again.entry.id);
      assert.equal(k.run.inputs.length, 2, "every check ran again");
    } finally {
      await k.done();
    }
  });

  test("sent back for a failing check: no Land at the same commit, even with its drafts changed and clean", async () => {
    const { d, k } = draftsKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      const q = await k.q();
      const b = k.repo.branch("feat/bad", { "b.txt": "b\n" });
      const { entry } = await legacyAdd(q, { branch: "feat/bad", by: "land-button" });
      await until(async () => (await k.entry(entry.id)).state === "needs-fix", "sent back");
      assert.equal((await k.entry(entry.id)).sentBackFor, "checks");
      d.hash = "h2";
      d.print = "p2";
      const v = await q.view({ fresh: true });
      assert.ok(!readyAt(v, "feat/bad", b.head));
      assert.equal(v.needsFix[0]?.redrafted, undefined);
    } finally {
      await k.done();
    }
  });

  test("an entry sent back before its cause was kept loads; its cause is inferred once from a failed docs step, else it isn't the drafts'", async () => {
    const { d, k } = draftsKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "your spec drafts don't fit" }));
      const q = await k.q();
      const b = k.repo.branch("feat/old", { "b.txt": "b\n" });
      const { entry } = await legacyAdd(q, { branch: "feat/old", by: "land-button" });
      await until(async () => (await k.entry(entry.id)).state === "needs-fix", "sent back");
      await q.idle();
      const qf = join(q.store.dir, "queue.json");
      await k.queues.stop();
      // As an older Sova wrote it: no cause, no fingerprint; its run's docs step failed.
      const raw = JSON.parse(readFileSync(qf, "utf8"));
      for (const x of raw.entries) {
        delete x.sentBackFor;
        delete x.sentBackDrafts;
      }
      writeFileSync(qf, JSON.stringify(raw));
      const k2 = makeKit({ repo: k.repo, deps: { draftsHash: () => ({ hash: d.hash, names: ["x"] }), docsCheck: () => ({ problems: [] }) } });
      try {
        const q2 = await k2.q();
        const e = q2.entry(entry.id)!;
        assert.equal(e.state, "needs-fix");
        assert.equal(e.sentBackFor, undefined);
        const run = q2.store.readRun(e.run!)!;
        run.steps.push({ id: "docs", kind: "docs", label: "Docs", result: "failed", ms: 1, log: "logs/02-docs.log" });
        run.verdict = "failed";
        q2.store.writeRun(run);
        let v = await q2.view({ fresh: true });
        assert.equal(v.needsFix[0]?.sentBackFor, "drafts", "inferred from the run");
        assert.ok(!readyAt(v, "feat/old", b.head), "its drafts unchanged since the approval");
        d.hash = "h2";
        v = await q2.view({ fresh: true });
        assert.ok(readyAt(v, "feat/old", b.head), "changed since the approval pinned them, and clean");
      } finally {
        await k2.done();
      }
    } finally {
      await k.done().catch(() => {});
    }
  });

  test("Remove from Queue: an entry back with its chat is cancelled ('removed by you'), its standing Land ended, its chat told; nothing of the branch is deleted", async () => {
    const k = makeKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      const q = await k.q();
      const b = k.repo.branch("feat/gone", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/gone", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "with-chat", "back with its chat");
      const out = await q.cancel(entry.id);
      assert.equal(out.state, "cancelled");
      assert.equal(out.reason, "removed by you");
      assert.equal(out.standing, undefined, "its standing Land ended with it");
      assert.ok(k.notices.some((n) => n.kind === "removed" && n.session === "s1"), "its chat's card is told");
      assert.ok(existsSync(b.path));
      assert.equal(sh(k.repo.root, "rev-parse", "refs/heads/feat/gone"), b.head);
      assert.ok(existsSync(q.store.runDir(out.run!)));
      const v = await q.view({ fresh: true });
      assert.ok(!v.needsFix.some((e) => e.id === entry.id));
      assert.ok((v.ready ?? []).some((r) => r.branch === "feat/gone" && r.commit === b.head), "the branch reads as itself again");
      await assert.rejects(q.cancel(entry.id), /already cancelled/);
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
      assert.equal(e.state, "with-chat", "back with its chat, the user's Land standing");
      assert.equal(e.reason, "unit failed: src/a.test.ts");
      assert.equal(e.standing?.phase, "with-chat");
      assert.deepEqual(k.notices.filter((n) => n.branch === "feat/bad").map((n) => n.kind), ["needs-fix"]);
      assert.match(e.requests!.at(-1)!.text, /didn't land \(try 1 of 3\): unit failed: src\/a\.test\.ts/);
      assert.doesNotMatch(e.requests!.at(-1)!.text, /diagnosis/, "no thread answered: no diagnosis");
      assert.ok(k.thread.some((t) => t.kind === "failed" && t.entry.id === bad.entry.id && t.base === before), "the run's base, for the thread's diff");
      assert.ok(k.thread.some((t) => t.kind === "queued" && t.entry.id === bad.entry.id && t.base === before));
      assert.notEqual(k.repo.head(), before);
      assert.equal(sh(k.repo.root, "rev-parse", `${k.repo.head()}^2`), ok.entry.commit);
    } finally {
      await k.done();
    }
  });

  test("with a thread, the send-back waits for its diagnosis and carries it; a ruling on an entry not waiting is refused", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => k.thread.some((t) => t.kind === "failed" && t.entry.id === bad.entry.id), "the thread called in");
      await until(async () => (await k.entry(bad.entry.id)).ruling?.pending, "waiting for the diagnosis");
      assert.equal((await k.entry(bad.entry.id)).state, "with-chat");
      assert.deepEqual(k.notices.filter((n) => n.kind === "needs-fix"), [], "no request yet");
      await assert.rejects(q.rule(bad.entry.id, { ruling: "chat-fixes" }), /give your diagnosis/);
      await assert.rejects(q.rule(bad.entry.id, { ruling: "overrule" }), /ruling is/);
      const e = await q.rule(bad.entry.id, { ruling: "chat-fixes", text: "x.txt drops the export a.test.ts imports; export it again" });
      assert.equal(e.state, "with-chat");
      assert.equal(e.ruling?.pending, undefined);
      assert.match(e.requests!.at(-1)!.text, /The merge thread's diagnosis: x\.txt drops the export/);
      assert.deepEqual(k.notices.filter((n) => n.kind === "needs-fix").length, 1, "one request");
    } finally {
      await k.done();
    }
  });

  test("a thread that gives no diagnosis in time: the request goes without, or with the note it wrote for this failure", async () => {
    const k = makeKit({ threadAnswers: true, deps: { rulingWaitMs: 60 } });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => (await k.entry(bad.entry.id)).ruling?.pending, "waiting for the diagnosis");
      await q.note(bad.entry.id, "the export of a was removed", "thread");
      await until(async () => (await k.entry(bad.entry.id)).requests?.length, "sent after the wait");
      assert.match((await k.entry(bad.entry.id)).requests!.at(-1)!.text, /The merge thread's diagnosis: the export of a was removed/);
    } finally {
      await k.done();
    }
  });

  test("a send-back waiting for the thread's diagnosis when Sova stops still goes out after the restart", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => (await k.entry(bad.entry.id)).ruling?.pending, "waiting for the diagnosis");
      await k.queues.stop();
      const k2 = makeKit({ repo: k.repo, threadAnswers: true, deps: { rulingWaitMs: 50 } });
      try {
        await k2.q();
        await until(async () => (await k2.entry(bad.entry.id)).requests?.length, "sent after the restart");
        const e = await k2.entry(bad.entry.id);
        assert.equal(e.ruling?.pending, undefined);
        assert.match(e.requests!.at(-1)!.text, /unit failed: src\/a\.test\.ts/);
      } finally {
        await k2.done();
      }
    } finally {
      await k.done();
    }
  });

  test("a decision's held note, once the user answers, is a request the chat answers by its id; a later raise joins the open decision, never replaces it", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => (await k.entry(bad.entry.id)).ruling?.pending, "waiting for the diagnosis");
      await q.rule(bad.entry.id, { ruling: "chat-fixes", text: "export it again" });
      const pq = q as unknown as { chatNeedsYou(e: unknown, rq: string, question: string, options: string[]): void; serial<T>(f: () => Promise<T>): Promise<T>; entry(id: string): unknown };
      const rq1 = (await k.entry(bad.entry.id)).requests!.at(-1)!.id;
      await pq.serial(async () => pq.chatNeedsYou(pq.entry(bad.entry.id), rq1, "Keep the old label or the new one?", ["Old", "New"]));
      const d = (await k.entry(bad.entry.id)).decision!;
      assert.equal(d.raisedBy, "chat");
      // The thread's own question never replaces the chat's: refused, the chat's question and held note stay.
      await assert.rejects(q.rule(bad.entry.id, { ruling: "needs-user", text: "Which order?" }), /already waits for the user's decision/);
      const still = (await k.entry(bad.entry.id)).decision!;
      assert.equal(still.id, d.id);
      assert.equal(still.question, "Keep the old label or the new one?");
      assert.equal(still.raisedBy, "chat");
      assert.equal(k.notices.filter((n) => n.kind === "decision").length, 1, "one notification");
      // The user answers in the chat: the held note becomes a request, and the chat answers it by that id.
      const held = await q.decisionAnswered(bad.entry.id, d.id, "The new one", { session: "s-bad" });
      assert.equal(held?.request, d.heldNote!.request);
      const e = await k.entry(bad.entry.id);
      assert.equal(e.state, "with-chat");
      const rq = e.requests!.find((r) => r.id === d.heldNote!.request)!;
      assert.equal(rq.kind, "decision");
      assert.equal(rq.session, "s-bad");
      const r = await q.respond(rq.id, "s-bad", { answer: "cant", text: "the new label breaks the layout" });
      assert.equal(r.request.answer?.kind, "cant");
      assert.equal(await q.decisionAnswered(bad.entry.id, d.id, "again"), null, "answered once");
    } finally {
      await k.done();
    }
  });

  test("Can't goes to the thread first: one other approach, then the user; a Needs you is a decision nobody overrules", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => (await k.entry(bad.entry.id)).ruling?.pending, "waiting for the diagnosis");
      await q.rule(bad.entry.id, { ruling: "chat-fixes", text: "export it again" });
      const pq = q as unknown as { chatCant(e: unknown, rq: string, why: string): void; chatNeedsYou(e: unknown, rq: string, question: string, options: string[]): void; serial<T>(f: () => Promise<T>): Promise<T>; entry(id: string): unknown };
      const rq1 = (await k.entry(bad.entry.id)).requests!.at(-1)!.id;
      await pq.serial(async () => pq.chatCant(pq.entry(bad.entry.id), rq1, "the export is gone on master too"));
      assert.ok(k.thread.some((t) => t.kind === "chat-answer" && t.answer === "cant" && !t.otherTried));
      assert.equal((await k.entry(bad.entry.id)).ruling?.cant?.request, rq1);
      await assert.rejects(q.rule(bad.entry.id, { ruling: "try-again" }), /say the other approach/);
      const other = await q.rule(bad.entry.id, { ruling: "try-again", text: "import it from b instead" });
      assert.equal(other.requests!.at(-1)!.kind, "other-approach");
      assert.match(other.requests!.at(-1)!.text, /import it from b instead/);
      // A second Can't goes straight to the user, "can't be settled without you".
      const rq2 = other.requests!.at(-1)!.id;
      await pq.serial(async () => pq.chatCant(pq.entry(bad.entry.id), rq2, "b doesn't have it either"));
      const d = await k.entry(bad.entry.id);
      assert.equal(d.state, "needs-user");
      assert.equal(d.decision?.cantSettle, true);
      assert.equal(d.decision?.raisedBy, "chat");
      await assert.rejects(q.rule(bad.entry.id, { ruling: "chat-fixes", text: "just do it" }), /waits for the user's decision/);
      await assert.rejects(q.retry(bad.entry.id), /waits for the user's decision/);
      assert.equal(k.notices.filter((n) => n.kind === "decision").length, 1, "one notification");
    } finally {
      await k.done();
    }
  });

  test("merge.retry: an entry back with its chat goes back in line counting a try; out of tries it waits for the user", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      k.repo.branch("feat/bad", { "x.txt": "x\n" });
      const bad = await q.add({ branch: "feat/bad", by: "land-button", session: "s-bad" });
      await until(async () => (await k.entry(bad.entry.id)).requests?.length, "sent back");
      assert.equal((await k.entry(bad.entry.id)).tries?.used, 1);
      await q.retry(bad.entry.id);
      // The retry counted one; its run fails the same way: the third try is used up and it waits for the user.
      await until(async () => (await k.entry(bad.entry.id)).state === "needs-user", "out of tries");
      const e = await k.entry(bad.entry.id);
      assert.equal(e.decision?.kind, "out-of-tries");
      await assert.rejects(q.retry(bad.entry.id), /can't be retried/);
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
  // A Land on a branch that conflicts already waits for a fix (al_3 q7): a conflict reaches the queue when the target
  // moves after the Land. Paused while it is approved, then the target moves, then the queue goes on.
  const conflictingAdd = async (k: ReturnType<typeof makeKit>, q: Awaited<ReturnType<ReturnType<typeof makeKit>["q"]>>, branch = "feat/c", master = "TWO-master") => {
    k.repo.branch(branch, { "a.txt": `one\nTWO-${branch}\nthree\n` });
    await q.pause("setting up a conflict");
    const c = await q.add({ branch, by: "land-button", session: "s1" });
    k.repo.commitOn(k.repo.root, { "a.txt": `one\n${master}\nthree\n` }, "master side");
    await q.resume();
    return c;
  };

  test("no thread: the conflict waits for the merge thread, never sent to the chat unjudged; once the thread acts it is handed the conflict", async () => {
    let up = false;
    const told: string[] = [];
    const k = makeKit({ deps: { thread: (ev) => (ev.kind === "conflict" && told.push(ev.entry.id), up) } });
    try {
      const q = await k.q();
      const c = await conflictingAdd(k, q);
      await until(async () => /waiting for the merge thread/.test((await k.entry(c.entry.id)).reason ?? ""), "waits for the thread");
      const e = await k.entry(c.entry.id);
      assert.equal(e.state, "conflict");
      assert.match(e.reason!, /conflicts with master in 1 file: a\.txt/);
      assert.equal(e.requests, undefined, "nothing to the chat");
      assert.ok(!k.notices.some((n) => n.kind === "needs-fix"), "no send-back");
      up = true;
      const before = told.length;
      q.threadActed();
      await until(() => told.length > before, "handed to the thread once it runs");
      await until(async () => (await k.entry(c.entry.id)).fix?.told === true, "told");
    } finally {
      await k.done();
    }
  });

  test("the thread judges no behaviour change: its resolution carries the approval and runs first; a sanity failure makes it the user's", async () => {
    let sane = true;
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => (sane ? { ok: true, files: ["a.txt"] } : { ok: false, why: "it changes b.txt, which didn't conflict", files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      const c = await conflictingAdd(k, q);
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

  test("behaviour differs (needs-user): one decision with the thread's question; Accept runs the proposal; there is no Send Back", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      const c = await conflictingAdd(k, q);
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      // The old word still reads as needs-user.
      const e = await q.resolve(c.entry.id, { verdict: "behaviour-differs", ours: "master returns 2", theirs: "the branch returns 3", proposal: "return 3 behind a flag", text: "Return 2 or 3?", choices: ["2", "3", " "] });
      assert.equal(e.state, "behaviour-differs");
      assert.equal(e.decision?.kind, "behaviour-differs");
      assert.equal(e.decision?.question, "Return 2 or 3?");
      assert.deepEqual(e.decision?.choices, ["2", "3"], "empty choices dropped");
      assert.equal(e.decision?.raisedBy, "merge-thread");
      assert.equal((await q.view()).needsYou[0]!.id, c.entry.id);
      await assert.rejects(q.answer(c.entry.id, "accept"), /no proposed resolution/);
      await assert.rejects(q.answer(c.entry.id, "send-back" as never), /answer is/);
      assert.equal(k.notices.length, 0, "nothing goes to the chat until the user answers");
      // The thread can't overrule the decision it raised: only another needs-user is taken.
      await assert.rejects(q.rule(c.entry.id, { ruling: "try-again" }), /waits for the user's decision/);
      // Accept on another one with a proposed commit.
      const d = await conflictingAdd(k, q, "feat/d", "TWO-master-again");
      await until(async () => (await k.entry(d.entry.id)).state === "conflict", "conflict 2");
      const res = resolve(k, k.repo.head(), d.entry.commit, "one\nTWO-proposed\nthree\n");
      await q.resolve(d.entry.id, { verdict: "behaviour-differs", ours: "o", theirs: "t", proposal: "p", commit: res });
      await q.answer(d.entry.id, "accept");
      await landed(k, d.entry.id);
    } finally {
      await k.done();
    }
  });

  test("chat-fixes: the conflict goes back to the chat by itself, with the files as they are now and the thread's diagnosis", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      const c = await conflictingAdd(k, q);
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      const e = await q.resolve(c.entry.id, { verdict: "chat-fixes", ours: "master renamed it", theirs: "the branch calls the old name", proposal: "call the new name" });
      assert.equal(e.state, "with-chat");
      assert.equal(e.standing?.phase, "with-chat");
      const rq = e.requests!.at(-1)!;
      assert.equal(rq.kind, "fix");
      assert.equal(rq.try, 1);
      assert.match(rq.text, /conflicts with master in a\.txt/);
      assert.match(rq.text, /The merge thread's diagnosis: call the new name/);
      assert.deepEqual(k.notices.map((n) => n.kind), ["needs-fix"], "one request, no button");
    } finally {
      await k.done();
    }
  });

  test("a resolution judged safe that fails a check: the thread rules again; the branch isn't blamed and its chat isn't told", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }), conflictWaitMs: 80 } });
    try {
      const q = await k.q();
      k.run.set((input) => (input.resolution ? { verdict: "failed", blame: "resolution", why: "unit failed" } : {}));
      const c = await conflictingAdd(k, q);
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "conflict");
      await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "o", theirs: "t", proposal: "p", commit: resolve(k, k.repo.head(), c.entry.commit, "x\n") });
      await until(async () => k.thread.some((t) => t.kind === "resolution-failed"), "the thread told");
      const back = await k.entry(c.entry.id);
      assert.equal(back.state, "conflict", "the thread is ruling again");
      assert.match(back.reason!, /your branch isn't blamed/);
      assert.equal(k.notices.length, 0);
      // It doesn't rule in time: the user decides, never the branch's chat.
      await until(async () => (await k.entry(c.entry.id)).state === "behaviour-differs", "the user's");
      assert.equal((await k.entry(c.entry.id)).decision?.kind, "behaviour-differs");
      assert.equal(k.notices.filter((n) => n.kind === "needs-fix").length, 0);
    } finally {
      await k.done();
    }
  });

  test("a thread that never judges: after the wait the conflict is handed to the thread again, never to the chat unjudged", async () => {
    const told: string[] = [];
    const k = makeKit({ deps: { conflictWaitMs: 60, thread: (ev) => (ev.kind === "conflict" && told.push(ev.entry.id), true) } });
    try {
      const q = await k.q();
      const c = await conflictingAdd(k, q);
      await until(() => told.length >= 2, "handed to the thread again after the wait");
      const e = await k.entry(c.entry.id);
      assert.equal(e.state, "conflict");
      assert.equal(e.requests, undefined, "nothing to the chat");
    } finally {
      await k.done();
    }
  });
});

describe("review", () => {
  test("blocking: its findings wait for the thread, which may rule them the user's; Land Anyway is never offered over a review", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "review-flagged", review: { verdict: "blocking", text: "dead code left in x.ts", commit: "c", at: "t" } }));
      k.repo.branch("feat/r", { "r.txt": "r\n" });
      const r = await q.add({ branch: "feat/r", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(r.entry.id)).state === "with-chat", "back with the chat");
      const e = await k.entry(r.entry.id);
      assert.match(e.reason!, /dead code/);
      assert.equal(e.requests?.length ?? 0, 0, "the thread hands it on (queue-review.test.ts)");
      assert.deepEqual(k.notices.map((n) => n.kind), []);
      assert.ok(k.thread.some((t) => t.kind === "review" && t.findings === "dead code left in x.ts"));
      await assert.rejects(q.answer(r.entry.id, "land-anyway"), /Land Anyway answers a failure no one can be blamed for/);
      // The thread may rule a finding the user's.
      const d = await q.rule(r.entry.id, { ruling: "needs-user", text: "Keep the old setting or drop it?", choices: ["Keep it", "Drop it"] });
      assert.equal(d.state, "needs-user");
      assert.equal(d.decision?.raisedBy, "merge-thread");
      assert.deepEqual(k.notices.map((n) => n.kind), ["decision"]);
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

  test("after a send-back, the thread's diagnosis reaches the chat as its own request (merge.rule); a note stays on the card", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "with-chat", "with-chat");
      await q.note(entry.id, "the test expects the old error text", "thread");
      assert.deepEqual(k.notices.map((n) => n.kind), ["needs-fix"], "a note is no request");
      const e = await q.rule(entry.id, { ruling: "chat-fixes", text: "the test expects the old error text; update it" });
      assert.deepEqual(k.notices.map((n) => n.kind), ["needs-fix", "needs-fix"]);
      assert.match(e.requests!.at(-1)!.text, /diagnosis for feat\/a's last request: the test expects/);
      assert.equal(e.requests!.at(-1)!.try, undefined, "no try counted");
      assert.equal(e.tries?.used, 1);
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

describe("setting up the checks", () => {
  const DEF_TEXT = '{"version":1,"services":{"web":{"cmd":["true"]}}}\n';

  test("no definition: Try It runs on a minimal one and Save creates it (version plus merge) as one commit; one answer only", async () => {
    const k = makeKit({ checks: "unset" });
    try {
      const q = await k.q();
      await assert.rejects(q.setup({ none: true, command: "make test" }), /give one answer/);
      const before = k.repo.head();
      const t = await q.setup({ command: "make test", dryRun: true });
      await q.tryingNow();
      assert.deepEqual(k.run.inputs[0]!.project.def!.services, []);
      assert.equal(q.store.readRun(t.run!.id)!.verdict, "passed");
      assert.equal(k.repo.head(), before, "a try saves nothing");
      const r = await q.setup({ command: "make test" });
      assert.equal(sh(k.repo.root, "rev-parse", `${r.commit}^`), before, "one commit on the target");
      assert.equal(sh(k.repo.root, "diff", "--name-only", before, r.commit!), ".sova/project.json");
      const saved = JSON.parse(sh(k.repo.root, "show", "master:.sova/project.json"));
      assert.deepEqual(saved, { version: 1, merge: { checks: [{ id: "tests", label: "Tests", run: ["sh", "-c", "make test"] }] } });
      assert.match(sh(k.repo.root, "log", "-1", "--format=%s"), /new \.sova\/project\.json/);
      assert.equal(sh(k.repo.root, "status", "--porcelain"), "");
    } finally {
      await k.done();
    }
  });

  test("A dry run (merge.setup dryRun) runs the answer's checks on the target alone, merging nothing, and saves nothing", async () => {
    const k = makeKit({ checks: "unset" });
    try {
      k.repo.commitOn(k.repo.root, { ".sova/project.json": DEF_TEXT }, "definition");
      const q = await k.q();
      const before = k.repo.head();
      const r = await q.setup({ commands: ["Unit tests: npm test", "Lint: npm run lint"], takesMin: 3, dryRun: true });
      assert.equal(r.run!.verdict, "running");
      await q.tryingNow();
      const input = k.run.inputs[0]!;
      assert.equal(input.tryOnly, true, "nothing merged");
      assert.equal(input.base, before);
      assert.deepEqual((input.project.def!.merge!.checks as { id: string; label: string; run: string[]; timeout: number }[]).map((c) => [c.id, c.label, c.run, c.timeout]), [
        ["unit-tests", "Unit tests", ["sh", "-c", "npm test"], 360],
        ["lint", "Lint", ["sh", "-c", "npm run lint"], 360],
      ]);
      assert.equal(q.store.readRun(r.run!.id)!.verdict, "passed");
      assert.equal(k.repo.head(), before, "nothing saved");
      assert.equal((await q.view()).tryRun!.id, r.run!.id);
      k.run.set(() => ({ verdict: "failed", why: "Unit tests failed" }));
      const r2 = await q.setup({ command: "npm test", dryRun: true });
      await q.tryingNow();
      assert.match(q.store.readRun(r2.run!.id)!.why!, /fails on master itself, so it is the project's setup to fix, not any branch's/);

    } finally {
      await k.done();
    }
  });

  test("A dry run never runs beside a landing run in the same copy", async () => {
    const k = makeKit();
    try {
      k.repo.commitOn(k.repo.root, { ".sova/project.json": DEF_TEXT }, "definition");
      const q = await k.q();
      k.run.set((inp) => untilAborted(inp));
      k.repo.branch("feat/x", { "x.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/x", by: "land-button" });
      await until(() => q.currentRun(), "a run");
      await assert.rejects(q.setup({ command: "npm test", dryRun: true }), (e: unknown) => e instanceof MergeFailure && e.code === "busy");
      await q.cancel(entry.id);
    } finally {
      await k.done();
    }
  });

  test("Save writes the merge section on the target as one commit the main folder moves to; a dirty main folder is refused", async () => {
    const k = makeKit({ checks: "unset" });
    try {
      k.repo.commitOn(k.repo.root, { ".sova/project.json": DEF_TEXT }, "definition");
      const q = await k.q();
      writeFileSync(join(k.repo.root, "a.txt"), "dirty\n");
      await assert.rejects(q.setup({ none: true }), /uncommitted changes/);
      sh(k.repo.root, "checkout", "--", "a.txt");
      const r = await q.setup({ none: true });
      assert.equal(k.repo.head(), r.commit);
      assert.equal(sh(k.repo.root, "rev-parse", "HEAD"), r.commit);
      const saved = JSON.parse(sh(k.repo.root, "show", "master:.sova/project.json"));
      assert.deepEqual(saved.merge, { checks: "none" });
      assert.deepEqual(saved.services, { web: { cmd: ["true"] } });
      assert.equal(sh(k.repo.root, "status", "--porcelain"), "");
      // The queue moved the target itself: not a move from outside, and pushable with the next landing.
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      assert.ok(q.file.landed.includes(r.commit!));
      assert.equal(q.isPaused(), false);
    } finally {
      await k.done();
    }
  });
});

/** Whether `ref` has `commit` in its history. */
const contains = (root: string, ref: string, commit: string): boolean => {
  try {
    sh(root, "merge-base", "--is-ancestor", commit, ref);
    return true;
  } catch {
    return false;
  }
};

describe("an invalid definition", () => {
  test("is said, never read as Not set up: merge.add refuses with the parser's path and message, the view carries it, a line with entries pauses; once fixed, resume runs", async () => {
    const ERR = '$.merge.checks[0].run[2]: a lone "$"';
    let broken = false;
    const fixes = new Set<string>();
    const k = makeKit({ deps: { definitionAt: async (root, ref) => (broken && ![...fixes].some((f) => f === ref || contains(root, ref, f)) ? { def: null, error: ERR } : { def: DEF, error: null }), checksOf: (def) => (def ? "declared" : "unset") } });
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/in", { "in.txt": "in\n" });
      const { entry } = await q.add({ branch: "feat/in", by: "land-button" });
      // The definition breaks on the target (a new commit, so nothing cached is read).
      k.repo.commitOn(k.repo.root, { "b.txt": "b\n" }, "breaks the definition");
      broken = true;
      k.repo.branch("feat/new", { "n.txt": "n\n" });
      await assert.rejects(q.add({ branch: "feat/new", by: "land-button" }), (e: unknown) => e instanceof MergeFailure && e.code === "invalid-request" && e.message.startsWith(`The project's .sova/project.json is invalid: ${ERR}`) && !/Not set up/.test(e.message));
      let v = await q.view();
      assert.equal(v.invalid, ERR);
      await q.resume();
      await until(async () => (await q.view()).paused?.kind === "definition-invalid", "paused for the definition");
      v = await q.view();
      assert.match(v.paused!.why, /is invalid: \$\.merge\.checks\[0\]\.run\[2\]/);
      assert.equal((await k.entry(entry.id)).state, "queued", "nothing ran, nothing handed back");
      assert.equal(k.run.inputs.length, 0);
      // A branch that fixes the definition is taken and runs on its own declaration; the others wait for it.
      const fix = k.repo.branch("feat/fix", { "fix.txt": "fix\n" });
      fixes.add(fix.head);
      const f = await q.add({ branch: "feat/fix", by: "land-button" });
      await q.resume();
      await landed(k, f.entry.id);
      assert.equal(k.run.inputs[0]!.entry.id, f.entry.id, "the fix ran first, the broken line waited");
      assert.ok(k.run.inputs[0]!.project.def, "checked by its own definition");
      // The fix is on the target now (its definition is the target's): the rest runs.
      assert.equal((await q.view()).invalid, undefined);
      if (q.isPaused()) await q.resume();
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });
});

describe("can't tell whose failure", () => {
  const WHY = "Unit tests failed on the merge and on master alone, and named no failing file";
  test("waits for the user, blamed on no one, never landed on its own, the queue not paused; Land Anyway lands the tested tip", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/u", { "u.txt": "u\n" });
      k.repo.branch("feat/next", { "n.txt": "n\n" });
      const u = await q.add({ branch: "feat/u", by: "land-button", session: "s1" });
      const n = await q.add({ branch: "feat/next", by: "land-button" });
      const before = k.repo.head();
      k.run.set((inp) => (inp.entry.id === u.entry.id ? { verdict: "unattributed", why: WHY } : {}));
      await q.resume();
      await landed(k, n.entry.id);
      const e = await k.entry(u.entry.id);
      assert.equal(e.state, "unattributed");
      assert.equal(e.reason, WHY);
      assert.equal(q.isPaused(), false, "the queue doesn't pause");
      assert.deepEqual(k.notices.filter((x) => x.branch === "feat/u").map((x) => x.kind), [], "never handed back to the chat");
      const v = await q.view();
      assert.deepEqual(v.needsYou.map((x) => [x.id, x.state]), [[u.entry.id, "unattributed"]]);
      assert.notEqual(k.repo.head(), before);
      assert.equal(sh(k.repo.root, "rev-parse", `${k.repo.head()}^2`), n.entry.commit, "only feat/next landed");
      // The line moved on since its run: Land Anyway reruns it on the new target; again can't tell, so that tip lands.
      await q.answer(u.entry.id, "land-anyway");
      await landed(k, u.entry.id);
      const done = await k.entry(u.entry.id);
      assert.ok(done.approval.overUnattributed);
      assert.ok(done.notes.some((x) => x.kind === "master-red" && /^Landed anyway: /.test(x.text)));
      assert.equal(k.run.inputs.filter((i) => i.entry.id === u.entry.id).length, 2, "rerun on the moved target");
    } finally {
      await k.done();
    }
  });

  test("exactly one notification per decision: none while the thread rules first, one when raised, none for a question joining it", async () => {
    const sent: { tag: string; title: string }[] = [];
    const k = makeKit({ threadAnswers: true, deps: { rulingWaitMs: 60, decided: (e) => void sent.push(decisionPush(e, "p1")) } });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "unattributed", why: WHY }));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(a.entry.id)).ruling?.unattributed, "the thread rules first");
      assert.equal(sent.length, 0, "nothing while the thread rules");
      await until(async () => (await k.entry(a.entry.id)).decision, "raised");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.tag, `sova:merge-decision:${a.entry.id}`);
      assert.equal(sent[0]!.title, "The merge queue needs you · feat/a");
      const pq = q as unknown as { chatNeedsYou(e: unknown, rq: string, question: string, options: string[]): void; serial<T>(f: () => Promise<T>): Promise<T>; entry(id: string): unknown };
      await pq.serial(async () => pq.chatNeedsYou(pq.entry(a.entry.id), "rq_x", "Which wording?", []));
      assert.equal(sent.length, 1, "a question joining the open decision sends none");
      assert.match((await k.entry(a.entry.id)).decision!.question, /Also, from the branch's chat: Which wording\?/);
      // A joining decision brings its click-only answers along, so the answer it needs (Land) is never refused.
      const rq = q as unknown as { raiseDecision(e: unknown, d: unknown): void };
      await pq.serial(async () => rq.raiseDecision(pq.entry(a.entry.id), { kind: "out-of-tries", question: "Tried 3 times", choices: [], raisedBy: "queue", actions: ["land", "remove"] }));
      const joined = (await k.entry(a.entry.id)).decision!;
      assert.deepEqual(joined.actions, ["land-anyway", "try-again", "land", "remove"]);
      assert.equal(joined.kind, "unattributed", "still the first decision");
      assert.equal(sent.length, 1, "still one notification");
    } finally {
      await k.done();
    }
  });

  test("the thread rules first: its try-again settles it with no word to the user; no ruling in time raises it, and then only the user settles it", async () => {
    // Long enough that the first ruling always beats the timer; under load the steps before it took over 150 ms.
    const k = makeKit({ threadAnswers: true, deps: { rulingWaitMs: 600 } });
    try {
      const q = await k.q();
      let calls = 0;
      k.run.set(() => (++calls === 1 ? { verdict: "unattributed", why: WHY } : calls === 2 ? {} : { verdict: "unattributed", why: WHY }));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(a.entry.id)).ruling?.unattributed, "the thread rules first");
      const waiting = await k.entry(a.entry.id);
      assert.equal(waiting.decision, undefined, "not raised to the user yet");
      assert.ok(!(await q.view()).needsYou.some((x) => x.id === a.entry.id), "not in Needs you yet");
      await q.rule(a.entry.id, { ruling: "try-again", text: "the host ran out of temp space" });
      await landed(k, a.entry.id);
      assert.equal(k.notices.filter((n) => n.kind === "decision").length, 0, "the user never heard of it");
      // The next one: no ruling in time, raised to the user; the thread can't settle it after that.
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const b = await q.add({ branch: "feat/b", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(b.entry.id)).decision?.kind === "unattributed", "raised to the user");
      await assert.rejects(q.rule(b.entry.id, { ruling: "try-again", text: "flake" }), /already waits for the user's decision/);
      await assert.rejects(q.rule(b.entry.id, { ruling: "chat-fixes", text: "the branch's" }), /already waits for the user's decision/);
      assert.equal((await k.entry(b.entry.id)).state, "unattributed");
    } finally {
      await k.done();
    }
  });

  test("Land Anyway onto the target it was tested on lands with no rerun; Send Back hands it back with the reason; Accept is refused", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "unattributed", why: WHY, unclear: [{ check: "unit", label: "Unit tests", step: "rerun-master:unit" }] }));
      k.repo.branch("feat/a", { "a1.txt": "a\n" });
      const a = await q.add({ branch: "feat/a", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(a.entry.id)).state === "unattributed", "unattributed");
      const ua = await k.entry(a.entry.id);
      assert.deepEqual(ua.unclear, [{ check: "unit", label: "Unit tests", run: ua.run!, step: "rerun-master:unit" }]);
      await assert.rejects(q.answer(a.entry.id, "accept"), /Accept answers a conflict/);
      await q.answer(a.entry.id, "land-anyway");
      await landed(k, a.entry.id);
      assert.equal(k.run.inputs.length, 1, "no rerun");
      k.repo.branch("feat/b", { "b1.txt": "b\n" });
      const b = await q.add({ branch: "feat/b", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(b.entry.id)).state === "unattributed", "unattributed b");
      const ub = await k.entry(b.entry.id);
      assert.equal(ub.decision?.kind, "unattributed");
      assert.deepEqual(ub.decision?.actions, ["land-anyway", "try-again"]);
      assert.deepEqual(k.notices.filter((x) => x.branch === "feat/b" && x.kind !== "approved").map((x) => x.kind), [], "nothing to the chat; the card's revision comes from the view");
      await q.answer(b.entry.id, "try-again");
      const again = await k.entry(b.entry.id);
      assert.equal(again.state === "queued" || again.state === "checking" || again.state === "unattributed", true);
      assert.equal(again.tries?.used ?? 0, 0, "Try Again uses no try");
    } finally {
      await k.done();
    }
  });
});

describe("the setup commit's push", () => {
  test("Save Checks isn't pushed on its own: the view shows the pushed sha and why, until the next landing pushes both", async () => {
    let saved = false;
    const k = makeKit({ deps: { checksOf: () => (saved ? "none" : "unset") } });
    try {
      const pushedBefore = k.repo.head();
      const q = await k.q();
      // The stand-in reads "the file at the target's head": declared from the save on. Flipped before the save returns,
      // so a read the save's own publish makes (cached per head) never sees the old answer at the new head.
      saved = true;
      const r = await q.setup({ none: true });
      let v = await q.view();
      assert.equal(v.heads.target, r.commit);
      assert.equal(v.heads.pushed, pushedBefore, "origin's sha, from its tracking ref");
      assert.equal(v.heads.pushWhy, PUSH_WAITS_NEXT_LANDING);
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), pushedBefore, "nothing pushed yet");
      k.repo.branch("feat/after", { "after.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/after", by: "land-button" });
      await landed(k, entry.id);
      v = await q.view();
      assert.equal(v.heads.pushWhy, undefined);
      assert.equal(v.heads.pushed, v.heads.target);
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), v.heads.target, "the setup commit went out with the landing");
      sh(k.repo.origin, "merge-base", "--is-ancestor", r.commit!, "master");
    } finally {
      await k.done();
    }
  });
});

describe("the view's extras", () => {
  test("ready, not approved: clean worktree branches ahead of the target, without TEMP heads or entries; the thread's chat", async () => {
    const k = makeKit({ deps: { threadOf: () => ({ session: "t1", startedAt: "2026-11-02T00:00:00.000Z", state: "idle" as const }) } });
    try {
      const q = await k.q();
      await q.pause("hold");
      const a = k.repo.branch("feat/ready", { "r.txt": "r\n" });
      k.repo.branch("feat/temp", { "t.txt": "t\n" }, { message: "TEMP wip" });
      const d = k.repo.branch("feat/dirty", { "d.txt": "d\n" });
      writeFileSync(join(d.path, "d.txt"), "x\n");
      k.repo.branch("feat/queued", { "q.txt": "q\n" });
      await q.add({ branch: "feat/queued", by: "land-button" });
      const v = await q.view();
      assert.deepEqual(v.ready!.map((r) => [r.branch, r.commit, r.ahead]), [["feat/ready", a.head, 1]]);
      assert.deepEqual(v.thread, { session: "t1", startedAt: "2026-11-02T00:00:00.000Z", state: "idle" });
    } finally {
      await k.done();
    }
  });
  test("branch summaries: a Ready row and an entry carry theirs, at their commits; a write publishes the view again; none is started by a read", async () => {
    let asked = 0;
    let summaries: BranchSummaries | null = null;
    const k = makeKit({
      deps: {
        summaryOf: (root, branch, commit) => summaries!.summaryOf(root, branch, commit),
        pruneSummaries: (root, live, shown) => void summaries!.prune(root, live, shown),
      },
    });
    try {
      const q = await k.q();
      summaries = new BranchSummaries({
        fileOf: () => join(q.store.dir, "branch-summaries.json"),
        facts: async (root, branch, commit) => readBranchFacts(realGit, root, { branch, commit, target: q.target, targetHead: (await q.declared()).head ?? "" }),
        writer: () => async (prompt) => (asked++, { bullets: [prompt.includes("Adds the ready file") ? "Adds the ready file" : "Something else"], model: "prov/a" }),
        projectOf: () => "p1",
        changed: () => q.republish(),
      });
      await q.pause("hold");
      const a = k.repo.branch("feat/ready", { "r.txt": "r\n" }, { message: "Adds the ready file" });
      const b = k.repo.branch("feat/queued", { "q.txt": "q\n" });
      await q.add({ branch: "feat/queued", by: "land-button" });
      let v = await q.view();
      assert.equal(v.ready![0]!.summary, undefined, "nothing before it reads Ready");
      assert.equal(v.waiting[0]!.summary, undefined);
      assert.equal(asked, 0, "a view never starts a write");
      const published = k.views.length;
      await summaries.ensure(q.root, "feat/ready", a.head).done;
      await summaries.ensure(q.root, "feat/queued", b.head).done;
      await until(async () => k.views.length > published, "the view published again");
      v = await q.view();
      assert.deepEqual(v.ready![0]!.summary, { commit: a.head, state: "ready", bullets: ["Adds the ready file"] });
      assert.deepEqual(v.waiting[0]!.summary, { commit: b.head, state: "ready", bullets: ["Something else"] });
      assert.equal(asked, 2);
      // Never stored with the queue's records.
      assert.ok(!readFileSync(join(q.store.dir, "queue.json"), "utf8").includes("Adds the ready file"));
    } finally {
      await k.done();
    }
  });
  test("the sweep, not a view, writes a Ready row's bullets: no chat or an idle one is written, a busy chat's waits; the row carries its date", async () => {
    let asked = 0;
    let summaries: BranchSummaries | null = null;
    const busy = new Set(["c-busy"]);
    const k = makeKit({
      deps: {
        summaryOf: (root, branch, commit) => summaries!.summaryOf(root, branch, commit),
        ownerOf: async (_r, branch) => (branch === "feat/busy" ? "c-busy" : branch === "feat/idle" ? "c-idle" : null),
      },
    });
    try {
      const q = await k.q();
      summaries = new BranchSummaries({
        fileOf: () => join(q.store.dir, "branch-summaries.json"),
        facts: async (root, branch, commit) => readBranchFacts(realGit, root, { branch, commit, target: q.target, targetHead: (await q.declared()).head ?? "" }),
        writer: () => async () => (asked++, { bullets: ["Adds a file"], model: "prov/a" }),
        projectOf: () => "p1",
        changed: () => q.republish(),
      });
      await q.pause("hold");
      const none = k.repo.branch("feat/nochat", { "n.txt": "n\n" });
      const idle = k.repo.branch("feat/idle", { "i.txt": "i\n" });
      const b = k.repo.branch("feat/busy", { "b.txt": "b\n" });
      // Two page reads: no model call.
      await q.view();
      const v0 = await q.view({ fresh: true });
      assert.equal(asked, 0, "a view never starts a write");
      assert.ok(v0.ready!.every((r) => r.summary === undefined));
      const row = v0.ready!.find((r) => r.branch === "feat/nochat")!;
      assert.equal(row.headAt, sh(k.repo.root, "log", "-1", "--format=%cI", none.head), "the head's committer date");
      const sweep = new SummarySweep({
        roots: () => [q.root],
        readyOf: () => q.readyRows(),
        targetHead: async () => (await q.declared()).head || null,
        chatIdle: async (s) => !busy.has(s),
        summaries,
      });
      await sweep.tick();
      await until(async () => asked === 2, "the idle rows written");
      await until(async () => !summaries!.isWriting(q.root, idle.head), "the writes ended");
      const v = await q.view({ fresh: true });
      const of = (br: string) => v.ready!.find((r) => r.branch === br)!.summary;
      assert.deepEqual(of("feat/nochat"), { commit: none.head, state: "ready", bullets: ["Adds a file"] });
      assert.deepEqual(of("feat/idle"), { commit: idle.head, state: "ready", bullets: ["Adds a file"] });
      assert.equal(of("feat/busy"), undefined, "a busy chat's branch waits");
      // Nothing moved: the next look passes over nothing; once the chat is idle and pokes, it is written.
      await sweep.tick();
      assert.equal(asked, 2);
      busy.clear();
      sweep.poke(q.root);
      await sweep.tick();
      await until(async () => asked === 3 && !summaries!.isWriting(q.root, b.head), "the busy chat's branch written once idle");
      // Reads after the writes still start none.
      await q.view({ fresh: true });
      await q.view({ fresh: true });
      assert.equal(asked, 3);
    } finally {
      await k.done();
    }
  });
  test("the sweep never writes bullets for the queue's own copies: a scratch copy on a branch, or one the merge thread made itself", async () => {
    const written: string[] = [];
    let summaries: BranchSummaries | null = null;
    const made = new Set<string>();
    const k = makeKit({ deps: { summaryOf: (root, branch, commit) => summaries!.summaryOf(root, branch, commit), queueMade: async () => (p) => made.has(p) } });
    try {
      const q = await k.q();
      summaries = new BranchSummaries({
        fileOf: () => join(q.store.dir, "branch-summaries.json"),
        facts: async (root, branch, commit) => readBranchFacts(realGit, root, { branch, commit, target: q.target, targetHead: (await q.declared()).head ?? "" }),
        writer: () => async (prompt) => (written.push(prompt), { bullets: ["Adds a file"], model: "prov/a" }),
        projectOf: () => "p1",
        changed: () => q.republish(),
      });
      await q.pause("hold");
      const mine = k.repo.branch("feat/mine", { "m.txt": "m\n" });
      const old = k.repo.branch("feat/resolve-mq_old2", { "o.txt": "o\n" });
      made.add(old.path);
      // A scratch copy the queue made, put on a branch ahead of master.
      const copy = await makeScratchCopy(realGit, { root: k.repo.root, entry: "mq_sweep1", base: k.repo.head() });
      k.repo.commitOn(copy, { "s.txt": "s\n" }, "in the copy");
      sh(copy, "switch", "-q", "-c", "feat/in-copy");
      const sweep = new SummarySweep({ roots: () => [q.root], readyOf: () => q.readyRows(), targetHead: async () => (await q.declared()).head || null, chatIdle: async () => true, summaries });
      await sweep.tick();
      await until(async () => written.length >= 1 && !summaries!.isWriting(q.root, mine.head), "the user's branch written");
      await sweep.tick();
      assert.equal(written.length, 1, "one model call: the user's branch alone, none for a queue copy");
      assert.match(written[0]!, /m\.txt/, "it is the user's branch");
    } finally {
      await k.done();
    }
  });
  test("one owner: the Ready row names the chat that created the worktree, and Land with no chat named records that same chat", async () => {
    // Chat A created and tracks the worktree, working from the main checkout; worker B, newer, works inside it.
    let wt = "";
    const row = (id: string, cwd: string, minAgo: number, x: Partial<SessionSummary> = {}) =>
      ({ id, path: `/s/${id}.jsonl`, cwd, archived: false, lastActiveAt: new Date(Date.now() - minAgo * 60_000).toISOString(), ...x }) as SessionSummary;
    const owners = new WorktreeOwners({
      sessions: async () => [row("A", "/proj", 30), row("B", wt, 1, { workerSession: true })],
      tracked: () => ({ version: 1, each: () => [["/s/A.jsonl", [{ path: wt, status: "active", how: "created" } as never]]] }),
      canonical: (p) => p,
    });
    const k = makeKit({ deps: { ownerOf: async (_r, _b, w) => (w ? owners.ownerOf(w) : null) } });
    try {
      const q = await k.q();
      await q.pause("hold");
      wt = k.repo.branch("feat/owned", { "o.txt": "o\n" }).path;
      const v = await q.view();
      assert.deepEqual(v.ready!.map((r) => [r.branch, r.session, r.sessionArchived, r.added, r.removed]), [["feat/owned", "A", undefined, 1, 0]]);
      const a = await q.add({ branch: "feat/owned", by: "land-button" });
      assert.equal(a.entry.session, "A", "Land records the row's chat, not the newer worker");
    } finally {
      await k.done();
    }
  });
});

describe("a settings save during a run", () => {
  // Plan review al_2 b1: a settings save while a branch is checking never moves the target under the run. It waits
  // (state "waiting", the view's pendingSave), the run passes and lands, then the save is applied as the queue's own
  // move: not paused master-moved, the run not void, knownTarget is the save's commit.
  test("start a run, save settings, let the run pass: not paused master-moved, the run not void, the save applied after", async () => {
    const k = makeKit();
    let released = () => {};
    try {
      const q = await k.q();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      released = () => release();
      // Passes once released; a voided run ends at once (so a failure here never hangs the teardown).
      k.run.set(async (input) => {
        await Promise.race([gate, untilAborted(input)]);
        return {};
      });
      // The project file on master that the save edits (the kit's definition, as a file).
      k.repo.commitOn(k.repo.root, { ".sova/project.json": `${JSON.stringify({ version: 1, services: { web: { cmd: ["true"] } }, merge: (DEF as unknown as { merge: unknown }).merge }, null, 2)}\n` }, "definition");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const before = k.repo.head();
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "a's run started");
      const answer = await saveSettings(q);
      assert.equal(answer.state, "waiting", `a save during a run waits for it, got ${JSON.stringify(answer)}`);
      assert.ok(pendingSaveOf(await q.view()), "the view says a save waits for the current branch");
      assert.equal(k.repo.head(), before, "the target didn't move under the checking run");
      release();
      await landed(k, entry.id);
      const run = q.store.readRun(k.run.inputs[0]!.runId)!;
      assert.equal(run.verdict, "passed", "the run is not voided by the save");
      assert.equal(q.isPaused(), false, `not paused: ${JSON.stringify((await q.view()).paused)}`);
      const e = await k.entry(entry.id);
      assert.equal(e.state, "landed");
      // Applied after the landing, on top of it, as the queue's own move.
      // Applied once nothing waits any more (the target moves a moment before the queue records it).
      await until(async () => pendingSaveOf(await q.view()) === undefined && k.repo.head() !== e.landed!.sha, "the waiting save applied");
      const saved = k.repo.head();
      assert.equal(sh(k.repo.root, "rev-parse", `${saved}^`), e.landed!.sha, "the save commit sits on the landed tip");
      assert.equal(q.file.knownTarget, saved, "knownTarget is the save's commit");
      assert.ok(q.file.landed.includes(saved), "the save is the queue's own move (push guard)");
      assert.equal(pendingSaveOf(await q.view()), undefined, "nothing waits any more");
      assert.equal(JSON.parse(sh(k.repo.root, "show", "master:.sova/project.json")).merge.push, false, "the change is in the file");
      // A later branch runs on the newest target with no pause.
      k.repo.branch("feat/b", { "c.txt": "c\n" });
      const b = await q.add({ branch: "feat/b", by: "land-button" });
      await landed(k, b.entry.id);
      assert.equal(k.run.inputs.at(-1)!.base, saved, "the next run starts from the saved commit");
      assert.equal(q.isPaused(), false);
    } finally {
      released();
      await k.done();
    }
  });
});

type Q = Awaited<ReturnType<ReturnType<typeof makeKit>["q"]>>;

/**
 * The settings section's save (contracts §4), push turned off. Before it exists, today's only writer of the merge
 * section, Save Checks (`setup`), stands in: it commits at once, which is what b1 forbids.
 */
async function saveSettings(q: Q): Promise<{ state: string; commit?: string }> {
  const s = (q as unknown as { saveSettings?: (changes: unknown) => Promise<{ state: string; commit?: string }> }).saveSettings;
  if (s) return s.call(q, { push: false });
  const r = await q.setup({ none: true });
  return { state: "saved", ...(r.commit ? { commit: r.commit } : {}) };
}

const pendingSaveOf = (v: unknown) => (v as { settings?: { pendingSave?: unknown } }).settings?.pendingSave;

describe("a request project: the host merges", () => {
  // Plan review al_3 b2: once the host merges request 1, a branch waiting behind it is tested against the host's main
  // (fetched origin/<target>), never the stale local one, and the host's merge never reads as "moved outside the queue".
  test("the stand-in host merges request 1 while a branch waits: no master-moved pause; the next run's base is the host's main", async () => {
    const host = standInHost();
    const k = makeKit({ deps: hostDeps(host) as Partial<QueueDeps> });
    try {
      const q = await k.q();
      writeOverride(q.store.dir, "github-pr");
      host.setOrigin(k.repo.origin);
      const localBefore = k.repo.head();
      k.repo.branch("feat/one", { "one.txt": "1\n" });
      const one = await q.add({ branch: "feat/one", by: "land-button", session: "s1" });
      // Sova's checks pass, then the request's text waits for your review (q10).
      await until(async () => ["request-review", "landed"].includes((await k.entry(one.entry.id)).state), "feat/one checked");
      assert.equal((await k.entry(one.entry.id)).state, "request-review", "a request project opens a request; it doesn't land locally");
      assert.equal(k.repo.head(), localBefore, "the local target never moves on a request project");
      await publish(q, one.entry.id);
      await until(async () => ((await k.entry(one.entry.id)).state as string) === "requested", "request 1 open");
      const req1 = (await k.entry(one.entry.id)) as unknown as { request?: { number?: number; publishedHead?: string } };
      assert.ok(req1.request?.number, "the request is recorded with its number");
      // A second branch waits while the request is open (the line is held so it can't start before the host merges).
      await q.pause("hold");
      k.repo.branch("feat/two", { "two.txt": "2\n" });
      const two = await q.add({ branch: "feat/two", by: "land-button", session: "s2" });
      // The host merges request 1: origin's master moves to the host's merge commit.
      const hostMain = host.merge(k.repo.origin, req1.request!.number!);
      await poll(q);
      await until(async () => (await k.entry(one.entry.id)).state === "landed", "request 1 landed on the host's word");
      assert.equal((await q.view()).paused?.kind, "operator", "only the operator's own hold; never master-moved");
      await q.resume();
      await until(() => k.run.inputs.some((i) => i.entry.id === two.entry.id), "feat/two's run");
      const input2 = k.run.inputs.find((i) => i.entry.id === two.entry.id)!;
      assert.equal(input2.base, hostMain, "the next run's base is the host's main, fetched");
      await until(async () => ["request-review", "landed", "needs-fix"].includes((await k.entry(two.entry.id)).state), "feat/two checked");
      const v = await q.view();
      assert.equal(v.paused, undefined, `not paused: ${JSON.stringify(v.paused)}`);
      assert.equal(k.repo.head(), localBefore, "local main is only moved by Update Local Main (q11)");
      assert.ok(((v.heads as { behind?: number }).behind ?? 0) >= 1, "the view says local main is behind");
      // Update Local Main is the queue's own move: local catches up to the host's main and nothing pauses.
      await (q as unknown as { updateLocalMain: () => Promise<unknown> }).updateLocalMain();
      assert.equal(k.repo.head(), hostMain);
      assert.equal(q.isPaused(), false);
    } finally {
      await k.done();
    }
  });
});

/** An in-process stand-in host (a GitHub that never leaves the test): requests by number over the bare origin. */
function standInHost() {
  const reqs = new Map<number, { head: string; base: string; title: string; body: string; state: "open" | "merged"; mergeCommit: string | null }>();
  let next = 1;
  const facts = (n: number, origin?: string) => {
    const r = reqs.get(n)!;
    const headSha = origin ? tryGit(origin, "rev-parse", `refs/heads/${r.head}`).out || null : null;
    return { number: n, url: `https://github.com/o/r/pull/${n}`, state: r.state, checks: "pass", review: "approved", mergeable: "mergeable", headSha, headBranch: r.head, baseBranch: r.base, mergeCommit: r.mergeCommit, mergedAt: r.mergeCommit ? "2026-11-03T00:00:00.000Z" : null };
  };
  let origin = "";
  const adapter = {
    kind: "github" as const,
    cli: "gh" as const,
    auth: async () => ({ ok: true as const }),
    find: async (_repo: unknown, q: { head: string; base: string }) => {
      for (const [n, r] of reqs) if (r.head === q.head && r.base === q.base && r.state === "open") return { ok: true as const, request: facts(n, origin) };
      return { ok: true as const, request: null };
    },
    create: async (_repo: unknown, req: { head: string; base: string; title: string; body: string }) => {
      const n = next++;
      reqs.set(n, { ...req, state: "open", mergeCommit: null });
      return { ok: true as const, request: facts(n, origin) };
    },
    update: async () => ({ ok: true as const }),
    view: async (_repo: unknown, n: number) => (reqs.has(n) ? { ok: true as const, request: facts(n, origin) } : { ok: false as const, code: "not-found" as const, why: "no such request" }),
  };
  return {
    adapter,
    reqs,
    setOrigin: (o: string) => void (origin = o),
    /** The host's merge button: a merge commit of its main and the request's head, on origin. Returns the new main. */
    merge(o: string, n: number): string {
      origin = o;
      const r = reqs.get(n)!;
      const main = sh(o, "rev-parse", r.base);
      const head = sh(o, "rev-parse", `refs/heads/${r.head}`);
      const tree = sh(o, "merge-tree", "--write-tree", main, head).split("\n")[0]!;
      const commit = sh(o, "commit-tree", tree, "-p", main, "-p", head, "-m", `Merge pull request #${n}`);
      sh(o, "update-ref", `refs/heads/${r.base}`, commit, main);
      r.state = "merged";
      r.mergeCommit = commit;
      return commit;
    },
  };
}

/** The queue's host seams (landing-core): the stand-in adapter, and the kit's local origin read as github.com/o/r. */
const hostDeps = (host: ReturnType<typeof standInHost>) => ({
  hostAdapter: () => host.adapter,
  hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }),
});

/** q10's Publish, with the text as drafted. */
async function publish(q: Q, id: string): Promise<void> {
  const f = (q as unknown as { publish?: (id: string, t: { title: string; body: string; draft: boolean }) => Promise<unknown> }).publish;
  assert.ok(f, "ProjectQueue.publish (q10's review step) isn't built");
  await f.call(q, id, { title: "One", body: "Opened by Sova", draft: false });
}

/** Read the host now (the view's GET does it, contracts §5). */
async function poll(q: Q): Promise<void> {
  const f = (q as unknown as { pollHost?: () => Promise<unknown> }).pollHost;
  if (f) await f.call(q);
  else await q.view();
}

describe("sent back: the tab's Ready list", () => {
  // al_4: a branch handed back to its chat is never offered as Ready (and so never Land) at the commit it was sent back
  // at. al_3: under the user's standing Land it isn't offered at a newer commit either: the chat's checked fix puts it
  // back in line, with no new Land. A legacy hand-back (approved before the standing Land) is Ready again at its fix.
  test("back with its chat: not Ready at its sent-back commit nor at a new one; a legacy hand-back is Ready at its fix", async () => {
    let t = Date.parse("2026-11-03T00:00:00.000Z");
    const k = makeKit({ deps: { now: () => t } as Partial<QueueDeps> });
    try {
      const q = await k.q();
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      const b = k.repo.branch("feat/back", { "x.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/back", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "with-chat", "back with its chat");
      let v = await q.view();
      assert.deepEqual(v.needsFix.map((e) => e.branch), ["feat/back"]);
      assert.deepEqual((v.ready ?? []).filter((r) => r.branch === "feat/back"), [], "not Ready at the commit it was sent back at");
      k.repo.commitOn(b.path, { "x.txt": "fixed\n" }, "fix");
      t += 60_000; // past the view's ready cache
      v = await q.view();
      assert.deepEqual((v.ready ?? []).filter((r) => r.branch === "feat/back"), [], "its Land stands: no second Land is offered");
      // An approval from before the standing Land: its hand-back is final, and Land comes back at the fix.
      const old = k.repo.branch("feat/old-back", { "o.txt": "o\n" });
      const legacy = await legacyAdd(q, { branch: "feat/old-back", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(legacy.entry.id)).state === "needs-fix", "sent back");
      const fix = k.repo.commitOn(old.path, { "o.txt": "fixed\n" }, "fix");
      t += 60_000;
      v = await q.view();
      assert.deepEqual((v.ready ?? []).filter((r) => r.branch === "feat/old-back").map((r) => r.commit), [fix], "Ready at the fix");
    } finally {
      await k.done();
    }
  });
});

describe("a host's landing outlives its entry", () => {
  test("a landing recorded before pins were kept is read from its entry at load, and survives the entry's pruning", async () => {
    const { queueReadingAt } = await import("../nothing-left");
    const repo = makeRepo();
    const pin = "a".repeat(40);
    const at = (s: number) => `2026-02-01T00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`;
    const landedEntry = (id: string, branch: string, commit: string, seq: number, via?: "host") =>
      ({ id, project: "p", branch, commit, target: "master", state: "landed", seq, runs: [], notes: [], picks: [], approval: { by: "land-button", at: at(seq) }, createdAt: at(seq), updatedAt: at(seq), landed: { sha: "b".repeat(40), from: "c".repeat(40), at: at(seq), pushed: "pushed", ...(via ? { via } : {}) } }) as unknown as QueueFile["entries"][number];
    const open = async () => {
      const k = makeKit({ repo });
      return { k, q: await k.q() };
    };
    try {
      // The file as an older Sova left it: the host's landing in its entry, no pins kept.
      const first = await open();
      first.q.file.entries.push(landedEntry("host1", "feat/squashed", pin, 1, "host"));
      delete first.q.file.hostPins;
      first.q.save();
      await first.k.done();
      assert.equal((JSON.parse(readFileSync(join(first.q.store.dir, "queue.json"), "utf8")) as { hostPins?: unknown }).hostPins, undefined, "as written: no pins");

      const second = await open();
      assert.deepEqual(queueReadingAt(repo.root)!.landings("feat/squashed").pins, [pin], "seeded at load");
      // Newer final entries past what the store keeps, then a save: the old entry goes.
      for (let i = 0; i < 61; i++) second.q.file.entries.push(landedEntry(`n${i}`, `feat/n${i}`, "d".repeat(40), i + 2));
      second.q.save();
      await second.k.done();
      const kept = JSON.parse(readFileSync(join(second.q.store.dir, "queue.json"), "utf8")) as { entries: { id: string }[] };
      assert.ok(!kept.entries.some((e) => e.id === "host1"), "its entry was pruned");

      const third = await open();
      assert.deepEqual(queueReadingAt(repo.root)!.landings("feat/squashed").pins, [pin], "still pinned with its entry gone");
      await third.k.done();
    } finally {
      repo.done();
    }
  });
});

describe("the queue's reading while it loads", () => {
  test("a read while the target is still being worked out says nothing and doesn't throw; once loaded it speaks", async () => {
    const { NO_LANDINGS, queueReadingAt } = await import("../nothing-left");
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let asked = false;
    const k = makeKit({
      deps: {
        definitionAt: async () => {
          asked = true;
          await gate;
          return { def: null, error: "no .sova/project.json" };
        },
      },
    });
    try {
      const loading = k.queues.get(k.repo.root);
      await until(() => asked, "the load reached the definition");
      const reading = queueReadingAt(k.repo.root);
      assert.ok(reading, "registered before the records are read");
      assert.equal(reading.landings("feat/x"), NO_LANDINGS);
      assert.equal(reading.approvedAt("feat/x", "a".repeat(40)), false);
      release();
      await loading;
      assert.deepEqual(reading.landings("feat/x").pins, []);
    } finally {
      release();
      await k.done();
    }
  });
});
