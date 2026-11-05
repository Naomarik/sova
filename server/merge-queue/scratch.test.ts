import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { realGit } from "./guard";
import { MergeFailure } from "./queue";
import { dropScratch, isScratchCopy, makeScratchCopy, pinResolution, resolveRef, scratchCopiesIn, scratchCopyPath, scratchEntries, scratchMarkOf, sweepScratch } from "./scratch";
import { makeKit, makeRepo, sh, tryGit, until } from "./testing/queue-kit";

const commonDir = (root: string) => sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
const refAt = (root: string, entry: string) => tryGit(root, "rev-parse", "--verify", "--quiet", resolveRef(entry)).out.trim();
const listed = (root: string) => sh(root, "worktree", "list", "--porcelain");
/** The Ready rows read from git now (the queue keeps them 15 s while the target stands still). */
async function freshReady(q: unknown): Promise<{ branch: string; worktree: string }[]> {
  const x = q as { readyCache: unknown; readyRows(): Promise<{ branch: string; worktree: string }[]> };
  x.readyCache = null;
  return x.readyRows();
}

describe("scratch copies: the helpers", () => {
  test("a copy is a detached worktree beside the project at the base, marked as the queue's; dropping it takes the copy and the ref", async () => {
    const repo = makeRepo();
    try {
      const base = repo.head();
      const path = await makeScratchCopy(realGit, { root: repo.root, entry: "mq_abc1", base });
      assert.equal(path, scratchCopyPath(repo.root, "mq_abc1"));
      assert.equal(path, join(repo.scratch, ".worktrees", "proj-conflict-mq_abc1"), "beside the project, like the merge copy");
      assert.equal(tryGit(path, "symbolic-ref", "-q", "HEAD").code, 1, "on no branch");
      assert.equal(sh(path, "rev-parse", "HEAD"), base);
      assert.deepEqual(scratchMarkOf(path), { root: repo.root, entry: "mq_abc1" });
      assert.deepEqual(scratchCopiesIn(commonDir(repo.root)).map((c) => [c.path, c.mark.entry]), [[path, "mq_abc1"]]);
      // A worktree of the user's is never one, whatever its name.
      const mine = repo.branch("feat/conflict-mq_abc2", { "m.txt": "m\n" });
      assert.equal(isScratchCopy(mine.path), false);
      assert.equal(isScratchCopy(repo.root), false);
      await pinResolution(realGit, repo.root, "mq_abc1", base);
      assert.equal(refAt(repo.root, "mq_abc1"), base);
      assert.deepEqual(sh(repo.root, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n"), ["refs/heads/feat/conflict-mq_abc2", "refs/heads/master"], "no branch was made");
      assert.deepEqual([...(await scratchEntries(realGit, repo.root))], ["mq_abc1"]);
      assert.deepEqual(await dropScratch(realGit, repo.root, "mq_abc1"), { copy: true, ref: true });
      assert.ok(!existsSync(path));
      assert.ok(!listed(repo.root).includes(path), "git's record of it went too");
      assert.equal(refAt(repo.root, "mq_abc1"), "");
      assert.ok(existsSync(mine.path), "the user's worktree is untouched");
    } finally {
      repo.done();
    }
  });

  test("a folder at the copy's path that the queue didn't make is never touched", async () => {
    const repo = makeRepo();
    try {
      const path = scratchCopyPath(repo.root, "mq_abc3");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "keep.txt"), "mine\n");
      await assert.rejects(makeScratchCopy(realGit, { root: repo.root, entry: "mq_abc3", base: repo.head() }), /isn't a scratch copy Sova made/);
      assert.deepEqual(await dropScratch(realGit, repo.root, "mq_abc3"), { copy: false, ref: false });
      assert.ok(existsSync(join(path, "keep.txt")));
    } finally {
      repo.done();
    }
  });

  test("the sweep drops every copy and ref its keep rule doesn't name, and keeps the rest", async () => {
    const repo = makeRepo();
    try {
      const base = repo.head();
      for (const id of ["mq_open1", "mq_final1", "mq_gone1"]) await makeScratchCopy(realGit, { root: repo.root, entry: id, base });
      await pinResolution(realGit, repo.root, "mq_open1", base);
      await pinResolution(realGit, repo.root, "mq_refonly1", base);
      const swept = await sweepScratch(realGit, repo.root, (id) => id === "mq_open1");
      assert.deepEqual(swept.sort(), ["mq_final1", "mq_gone1", "mq_refonly1"]);
      assert.ok(existsSync(scratchCopyPath(repo.root, "mq_open1")));
      assert.equal(refAt(repo.root, "mq_open1"), base);
      for (const id of ["mq_final1", "mq_gone1"]) assert.ok(!existsSync(scratchCopyPath(repo.root, id)));
      assert.equal(refAt(repo.root, "mq_refonly1"), "");
    } finally {
      repo.done();
    }
  });
});

/** The thread was told of the entry's conflict (the copy is made before the entry reads as a conflict). */
const told = (k: ReturnType<typeof makeKit>, id: string) => until(async () => k.thread.some((t) => t.kind === "conflict" && t.entry.id === id), `the thread told of ${id}'s conflict`);

describe("scratch copies: the queue", () => {
  const conflicting = (k: ReturnType<typeof makeKit>) => {
    k.repo.branch("feat/c", { "a.txt": "one\nTWO-branch\nthree\n" });
    k.repo.commitOn(k.repo.root, { "a.txt": "one\nTWO-master\nthree\n" }, "master side");
  };

  test("a conflict: Sova makes the copy and names it to the thread; it is never Ready, even on a branch; Land refuses it; the hand-back removes it", async () => {
    const k = makeKit({ threadAnswers: true, deps: { conflictWaitMs: 60_000 } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await told(k, c.entry.id);
      const ev = k.thread.find((t) => t.kind === "conflict")!;
      const path = scratchCopyPath(k.repo.root, c.entry.id);
      assert.equal(ev.scratch, path, `the thread is told where the copy is (${ev.scratchError ?? ""})`);
      assert.equal(sh(path, "rev-parse", "HEAD"), k.repo.head(), "at the target's head");
      // The thread resolves there and (against its playbook) puts the copy on a branch: still not Ready, and Land refuses.
      tryGit(path, "merge", "--no-ff", "--no-commit", c.entry.commit);
      writeFileSync(join(path, "a.txt"), "one\nTWO-both\nthree\n");
      sh(path, "add", "a.txt");
      sh(path, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit");
      sh(path, "switch", "-q", "-c", "feat/stray");
      const mine = k.repo.branch("feat/mine", { "m.txt": "m\n" });
      const rows = await freshReady(q);
      assert.deepEqual(rows.map((r) => r.branch), ["feat/mine"], "only the user's branch is Ready");
      await assert.rejects(q.add({ branch: "feat/stray", by: "land-button" }), (e: unknown) => e instanceof MergeFailure && /scratch copy the merge queue made to resolve a conflict/.test(e.message));
      await assert.rejects(q.add({ checkout: path, by: "land-button" }), /scratch copy the merge queue made/);
      void mine;
      sh(path, "switch", "-q", "--detach");
      sh(k.repo.root, "branch", "-D", "feat/stray");
      await q.cancel(c.entry.id);
      await q.scratchIdle();
      assert.ok(!existsSync(path), "cancelled: the copy went");
    } finally {
      await k.done();
    }
  });

  test("resolve pins the commit under the hidden ref; landing removes the copy and the ref", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await told(k, c.entry.id);
      const path = scratchCopyPath(k.repo.root, c.entry.id);
      const m = tryGit(path, "merge", "--no-ff", "--no-commit", c.entry.commit);
      assert.equal(m.code, 1, `the merge stops on the conflict: ${m.out}`);
      writeFileSync(join(path, "a.txt"), "one\nTWO-both\nthree\n");
      sh(path, "add", "a.txt");
      sh(path, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit");
      const res = sh(path, "rev-parse", "HEAD");
      await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "o", theirs: "t", proposal: "keep both", commit: res });
      assert.equal(refAt(k.repo.root, c.entry.id), res, "pinned");
      await until(async () => (await k.entry(c.entry.id)).state === "landed", "landed");
      await until(async () => !existsSync(path) && !refAt(k.repo.root, c.entry.id), "copy and ref removed");
    } finally {
      await k.done();
    }
  });

  test("a retry after the hand-back, its resolution's pin gone and git no longer having it: judged afresh, never run on the missing commit", async () => {
    const k = makeKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await k.q();
      conflicting(k);
      // The resolution's run fails on the branch: sent back with its resolution recorded.
      k.run.set((input) => (input.resolution ? { verdict: "failed", blame: "branch", why: "unit failed" } : {}));
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await told(k, c.entry.id);
      const path = scratchCopyPath(k.repo.root, c.entry.id);
      tryGit(path, "merge", "--no-ff", "--no-commit", c.entry.commit);
      writeFileSync(join(path, "a.txt"), "one\nTWO-both\nthree\n");
      sh(path, "add", "a.txt");
      sh(path, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit");
      const res = sh(path, "rev-parse", "HEAD");
      await q.resolve(c.entry.id, { verdict: "no-behaviour-change", ours: "o", theirs: "t", proposal: "keep both", commit: res });
      await until(async () => (await k.entry(c.entry.id)).state === "needs-fix", "sent back");
      assert.equal((await k.entry(c.entry.id)).conflict?.commit, res, "the hand-back keeps the recorded resolution");
      await until(async () => !existsSync(path) && !refAt(k.repo.root, c.entry.id), "copy and pin removed");
      // Nothing holds the resolution any more: git's cleanup drops it.
      sh(k.repo.root, "reflog", "expire", "--expire=now", "--all");
      sh(k.repo.root, "-c", "maintenance.auto=false", "gc", "-q", "--prune=now");
      assert.notEqual(tryGit(k.repo.root, "cat-file", "-e", `${res}^{commit}`).code, 0, "the resolution is gone from git");
      const runs = k.run.inputs.length;
      await q.retry(c.entry.id);
      await until(async () => k.run.inputs.length > runs, "the retry ran");
      assert.equal(k.run.inputs.at(-1)!.resolution, undefined, "the retry merges afresh, not the missing resolution");
      await until(async () => (await k.entry(c.entry.id)).state === "conflict", "a conflict again, for the thread to judge");
      assert.ok(!(await k.entry(c.entry.id)).notes.some((n) => n.kind === "resolved"), "the old resolution's note went with it");
    } finally {
      await k.done();
    }
  });

  test("sent back (the thread never judged in time): the copy goes", async () => {
    const k = makeKit({ threadAnswers: true, deps: { conflictWaitMs: 80 } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await until(async () => k.thread.some((t) => t.kind === "conflict"), "the thread told");
      await until(async () => (await k.entry(c.entry.id)).state === "needs-fix", "handed back");
      await until(async () => !existsSync(scratchCopyPath(k.repo.root, c.entry.id)), "copy removed");
    } finally {
      await k.done();
    }
  });

  test("no thread to tell: no copy is made", async () => {
    const k = makeKit({ deps: { thread: undefined } });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await until(async () => (await k.entry(c.entry.id)).state === "needs-fix", "handed back");
      await q.scratchIdle();
      assert.ok(!existsSync(scratchCopyPath(k.repo.root, c.entry.id)));
    } finally {
      await k.done();
    }
  });

  test("a copy the merge thread made itself (old style, a branch it tracks): hidden from Ready and refused by Land, by who made it", async () => {
    let made = new Set<string>();
    const k = makeKit({ deps: { queueMade: async (p) => made.has(p) } });
    try {
      const q = await k.q();
      const old = k.repo.branch("feat/resolve-mq_old1", { "x.txt": "x\n" });
      const mine = k.repo.branch("feat/resolve-mine", { "y.txt": "y\n" });
      made = new Set([old.path]);
      assert.deepEqual((await freshReady(q)).map((r) => r.branch), ["feat/resolve-mine"], "the name doesn't matter, the maker does");
      await assert.rejects(q.add({ branch: "feat/resolve-mq_old1", by: "land-button" }), /feat\/resolve-mq_old1 is a scratch copy the merge queue made/);
      assert.equal((await q.add({ branch: "feat/resolve-mine", by: "land-button" })).changed, true);
      void mine;
    } finally {
      await k.done();
    }
  });

  test("the start's sweep: an open entry keeps its copy and ref; a final one's and one gone from the queue file go", async () => {
    const k = makeKit({ threadAnswers: true });
    try {
      const q = await k.q();
      conflicting(k);
      const c = await q.add({ branch: "feat/c", by: "land-button" });
      await told(k, c.entry.id);
      const open = scratchCopyPath(k.repo.root, c.entry.id);
      assert.ok(existsSync(open));
      await pinResolution(realGit, k.repo.root, c.entry.id, k.repo.head());
      // A pruned entry's copy (not in queue.json: final) and a ref left by a stop.
      const gone = await makeScratchCopy(realGit, { root: k.repo.root, entry: "mq_pruned1", base: k.repo.head() });
      await pinResolution(realGit, k.repo.root, "mq_pruned2", k.repo.head());
      await k.queues.stop();
      const k2 = makeKit({ repo: k.repo, threadAnswers: true });
      try {
        const q2 = await k2.q();
        assert.equal(q2.entry(c.entry.id)?.state, "conflict");
        assert.ok(existsSync(open), "the open entry's copy stays");
        assert.equal(refAt(k.repo.root, c.entry.id), k.repo.head(), "and its pin");
        assert.ok(!existsSync(gone), "the pruned entry's copy went");
        assert.equal(refAt(k.repo.root, "mq_pruned2"), "");
        // Once it ends, it goes (the sweep remembered it).
        await q2.cancel(c.entry.id);
        await q2.scratchIdle();
        assert.ok(!existsSync(open));
        assert.equal(refAt(k.repo.root, c.entry.id), "");
      } finally {
        await k2.done();
      }
    } finally {
      await k.done();
    }
  });
});
