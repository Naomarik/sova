import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktree, forkPoint, GitError, inspectWorktree, landedStats, mergeStats, mergeWorktree, probeMerge, runGit } from "./git.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

/** A throwaway repo `<root>/repo` on master with one commit; git identity set locally. */
function repo(): { root: string; main: string; done: () => void } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-git-")));
	const main = join(root, "repo");
	mkdirSync(main);
	sh(main, "init", "-q", "-b", "master");
	sh(main, "config", "user.email", "t@example.invalid");
	sh(main, "config", "user.name", "t");
	sh(main, "config", "commit.gpgsign", "false");
	writeFileSync(join(main, "a.txt"), "one\n");
	sh(main, "add", "a.txt");
	sh(main, "commit", "-q", "-m", "one");
	return { root, main, done: () => rmSync(root, { recursive: true, force: true }) };
}

function commit(dir: string, file: string, body: string, msg: string): void {
	writeFileSync(join(dir, file), body);
	sh(dir, "add", file);
	sh(dir, "commit", "-q", "-m", msg);
}

test("create puts feat/<name> under <parent>/.worktrees/<repo>-<name> and inspect reads it back", async () => {
	const r = repo();
	try {
		const f = await createWorktree(runGit, { repoCwd: r.main, name: "x" });
		assert.equal(f.path, join(r.root, ".worktrees", "repo-x"));
		assert.equal(f.branch, "feat/x");
		assert.equal(f.baseBranch, "master");
		assert.equal(f.base, sh(r.main, "rev-parse", "HEAD"));
		assert.deepEqual(await inspectWorktree(runGit, f.path), { path: f.path, branch: "feat/x", head: f.base, commonDir: realpathSync(join(r.main, ".git")) });
		// Refusals change nothing.
		await assert.rejects(createWorktree(runGit, { repoCwd: r.main, name: "x" }), GitError);
		await assert.rejects(createWorktree(runGit, { repoCwd: r.main, name: "--force" }), /Worktree name/);
		await assert.rejects(createWorktree(runGit, { repoCwd: r.main, name: "y", base: "--orphan" }), /Not a valid base/);
		mkdirSync(join(f.path, "sub"));
		await assert.rejects(inspectWorktree(runGit, join(f.path, "sub")), /inside the worktree/);
	} finally {
		r.done();
	}
});

test("merge: fast-forward where the target is checked out, stats counted", async () => {
	const r = repo();
	try {
		const f = await createWorktree(runGit, { repoCwd: r.main, name: "ff" });
		commit(f.path, "b.txt", "1\n2\n3\n", "b");
		commit(f.path, "a.txt", "uno\n", "a");
		const before = await probeMerge(runGit, f);
		assert.equal(before?.merged, false);
		const m = await mergeWorktree(runGit, { tree: f, target: "master" });
		assert.equal(m.fastForward, true);
		assert.equal(m.commits, 2);
		assert.equal(m.added, 4);
		assert.equal(m.removed, 1);
		assert.equal(m.sha, sh(r.main, "rev-parse", "master"));
		assert.equal(m.sha, sh(f.path, "rev-parse", "HEAD"));
		// The checked-out master's files moved with it.
		assert.ok(existsSync(join(r.main, "b.txt")));
		assert.equal((await probeMerge(runGit, f))?.merged, true);
		await assert.rejects(mergeWorktree(runGit, { tree: f, target: "master" }), /already merged/);
	} finally {
		r.done();
	}
});

test("merge: a merge commit when master moved on; a dirty checkout or a conflict refuses and changes nothing", async () => {
	const r = repo();
	try {
		const f = await createWorktree(runGit, { repoCwd: r.main, name: "mc" });
		commit(f.path, "b.txt", "b\n", "b");
		commit(r.main, "c.txt", "c\n", "c");
		writeFileSync(join(r.main, "a.txt"), "dirty\n");
		const master = sh(r.main, "rev-parse", "master");
		await assert.rejects(mergeWorktree(runGit, { tree: f, target: "master" }), /uncommitted changes/);
		assert.equal(sh(r.main, "rev-parse", "master"), master);
		sh(r.main, "checkout", "--", "a.txt");
		const m = await mergeWorktree(runGit, { tree: f, target: "master" });
		assert.equal(m.fastForward, false);
		assert.equal(m.commits, 1);
		assert.equal(sh(r.main, "rev-list", "--parents", "-n1", "master").split(" ").length, 3);

		const g = await createWorktree(runGit, { repoCwd: r.main, name: "conflict" });
		commit(g.path, "a.txt", "theirs\n", "theirs");
		commit(r.main, "a.txt", "ours\n", "ours");
		const head = sh(r.main, "rev-parse", "master");
		await assert.rejects(mergeWorktree(runGit, { tree: g, target: "master" }), /failed and was aborted/);
		assert.equal(sh(r.main, "rev-parse", "master"), head);
		assert.equal(sh(r.main, "status", "--porcelain", "--untracked-files=no"), "");
	} finally {
		r.done();
	}
});

test("merge into a branch checked out nowhere: fast-forward only", async () => {
	const r = repo();
	try {
		sh(r.main, "branch", "release");
		const f = await createWorktree(runGit, { repoCwd: r.main, name: "rel" });
		commit(f.path, "r.txt", "r\n", "r");
		const m = await mergeWorktree(runGit, { tree: f, target: "release" });
		assert.equal(m.fastForward, true);
		assert.equal(sh(r.main, "rev-parse", "release"), sh(f.path, "rev-parse", "HEAD"));
		commit(r.main, "m.txt", "m\n", "m");
		sh(r.main, "branch", "-f", "release", "master");
		commit(f.path, "r2.txt", "r\n", "r2");
		await assert.rejects(mergeWorktree(runGit, { tree: f, target: "release" }), /does not fast-forward/);
	} finally {
		r.done();
	}
});

test("probeMerge: a branch with no commits beyond its base is not merged", async () => {
	const r = repo();
	try {
		const f = await createWorktree(runGit, { repoCwd: r.main, name: "empty" });
		assert.equal((await probeMerge(runGit, f))?.merged, false);
		// Attached later: the fork point is the base, so earlier work still counts as unmerged.
		commit(f.path, "e.txt", "e\n", "e");
		assert.equal(await forkPoint(runGit, f.path, "feat/empty", "master"), f.base);
		assert.equal(await probeMerge(runGit, { ...f, path: join(r.root, "missing") }), undefined);
	} finally {
		r.done();
	}
});

/** A branch `name` off master's current tip with one commit writing `file`; master stays checked out. */
function branchWith(main: string, name: string, file: string, body: string): string {
	sh(main, "checkout", "-q", "-b", name, "master");
	commit(main, file, body, name);
	sh(main, "checkout", "-q", "master");
	return sh(main, "rev-parse", name);
}

test("landedStats: two branches merged one after the other each name their own merge commit and lines", async () => {
	const r = repo();
	try {
		const x = branchWith(r.main, "x", "x.txt", "1\n2\n");
		sh(r.main, "checkout", "-q", "-b", "y", "master");
		commit(r.main, "y.txt", "1\n2\n3\n", "y");
		commit(r.main, "a.txt", "uno\n", "y2");
		const y = sh(r.main, "rev-parse", "HEAD");
		sh(r.main, "checkout", "-q", "master");
		const before = sh(r.main, "rev-parse", "master");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "x");
		const mx = sh(r.main, "rev-parse", "master");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "y");
		const my = sh(r.main, "rev-parse", "master");
		assert.deepEqual(await landedStats(runGit, r.main, before, my, x), { sha: mx, commits: 1, added: 2, removed: 0, fastForward: false });
		assert.deepEqual(await landedStats(runGit, r.main, before, my, y), { sha: my, commits: 2, added: 4, removed: 1, fastForward: false });
	} finally {
		r.done();
	}
});

test("landedStats: through an integration branch, a merged branch names the integration merge, one taken directly its own tip", async () => {
	const r = repo();
	try {
		const x = branchWith(r.main, "x", "x.txt", "x\n");
		const y = branchWith(r.main, "y", "y.txt", "y\ny\n");
		const before = sh(r.main, "rev-parse", "master");
		sh(r.main, "checkout", "-q", "-b", "i", "master");
		sh(r.main, "merge", "-q", "--ff-only", "y");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "x");
		const mi = sh(r.main, "rev-parse", "HEAD");
		sh(r.main, "checkout", "-q", "master");
		sh(r.main, "merge", "-q", "--ff-only", "i");
		const after = sh(r.main, "rev-parse", "master");
		assert.equal(after, mi);
		assert.deepEqual(await landedStats(runGit, r.main, before, after, x), { sha: mi, commits: 1, added: 1, removed: 0, fastForward: false });
		assert.deepEqual(await landedStats(runGit, r.main, before, after, y), { sha: y, commits: 1, added: 2, removed: 0, fastForward: true });
	} finally {
		r.done();
	}
});

test("landedStats: a commit made directly on the target during the run is in no branch's lines", async () => {
	const r = repo();
	try {
		const x = branchWith(r.main, "x", "x.txt", "x\n");
		const before = sh(r.main, "rev-parse", "master");
		commit(r.main, "m.txt", "m\nm\nm\n", "direct");
		commit(r.main, "a.txt", "changed\n", "direct2");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "x");
		const after = sh(r.main, "rev-parse", "master");
		assert.deepEqual(await landedStats(runGit, r.main, before, after, x), { sha: after, commits: 1, added: 1, removed: 0, fastForward: false });
		// The whole run's diff would have counted them.
		assert.deepEqual(await mergeStats(runGit, r.main, before, after, x), { commits: 1, added: 5, removed: 1, fastForward: false });
	} finally {
		r.done();
	}
});

test("landedStats: a single merge gives mergeStats' numbers at the target's new tip", async () => {
	const r = repo();
	try {
		const x = branchWith(r.main, "x", "x.txt", "1\n2\n");
		const before = sh(r.main, "rev-parse", "master");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "x");
		const after = sh(r.main, "rev-parse", "master");
		const { sha, ...stats } = await landedStats(runGit, r.main, before, after, x);
		assert.equal(sha, after);
		assert.deepEqual(stats, await mergeStats(runGit, r.main, before, after, x));
		assert.deepEqual(stats, { commits: 1, added: 2, removed: 0, fastForward: false });
	} finally {
		r.done();
	}
});
