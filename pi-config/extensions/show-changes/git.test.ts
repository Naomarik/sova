import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, inPaths, pickDir, resolveScope, runGit } from "./git.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "show-changes-")));
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

test("dirty: HEAD plus tracked and untracked changes, from a subdirectory", async () => {
	const r = repo();
	try {
		mkdirSync(join(r.main, "sub"));
		writeFileSync(join(r.main, "a.txt"), "two\n");
		writeFileSync(join(r.main, "sub", "new.ts"), "x\n");
		const dir = join(r.main, "sub");
		const scope = await resolveScope(runGit, { scope: "dirty" }, dir);
		assert.deepEqual(scope, { kind: "dirty", cwd: dir, root: r.main, head: sh(r.main, "rev-parse", "HEAD") });
		assert.deepEqual(await changedFiles(runGit, scope), ["a.txt", "sub/new.ts"]);
	} finally {
		r.done();
	}
});

test("commit: first parent, root commit, and a commit-ish that is no commit", async () => {
	const r = repo();
	try {
		const first = sh(r.main, "rev-parse", "HEAD");
		writeFileSync(join(r.main, "b.txt"), "b\n");
		sh(r.main, "add", "b.txt");
		sh(r.main, "commit", "-q", "-m", "two");
		const second = sh(r.main, "rev-parse", "HEAD");
		const s = await resolveScope(runGit, { scope: "commit", commit: "HEAD" }, r.main);
		assert.deepEqual(s, { kind: "commit", repoPath: r.main, root: r.main, sha: second, parent: first });
		assert.deepEqual(await changedFiles(runGit, s), ["b.txt"]);
		const root = await resolveScope(runGit, { scope: "commit", commit: first.slice(0, 8) }, r.main);
		assert.deepEqual(root, { kind: "commit", repoPath: r.main, root: r.main, sha: first });
		assert.deepEqual(await changedFiles(runGit, root), ["a.txt"]);
		await assert.rejects(resolveScope(runGit, { scope: "commit", commit: "nope" }, r.main), /No commit "nope"/);
	} finally {
		r.done();
	}
});

test("worktree: merge-base with master; the tracked base branch wins; on master it is refused", async () => {
	const r = repo();
	try {
		const wt = join(r.root, "wt");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/x", wt);
		writeFileSync(join(wt, "c.txt"), "c\n");
		sh(wt, "add", "c.txt");
		sh(wt, "commit", "-q", "-m", "c");
		// master moves on; the merge-base stays the fork point.
		const fork = sh(r.main, "rev-parse", "HEAD");
		writeFileSync(join(r.main, "m.txt"), "m\n");
		sh(r.main, "add", "m.txt");
		sh(r.main, "commit", "-q", "-m", "m");
		const tree = { path: wt, branch: "feat/x", base: fork };
		const picked = pickDir({ scope: "worktree" }, r.main, [tree]);
		assert.deepEqual(picked, { dir: wt, tree });
		const s = await resolveScope(runGit, { scope: "worktree" }, picked.dir, picked.tree);
		assert.deepEqual(s, { kind: "worktree", worktreePath: wt, root: wt, branch: "feat/x", head: sh(wt, "rev-parse", "HEAD"), base: fork, baseRef: "master" });
		assert.deepEqual(await changedFiles(runGit, s), ["c.txt"]);
		// A tracked baseBranch is used when it exists.
		sh(r.main, "branch", "dev", fork);
		const viaDev = await resolveScope(runGit, { scope: "worktree" }, wt, { ...tree, baseBranch: "dev" });
		assert.equal(viaDev.kind === "worktree" && viaDev.baseRef, "dev");
		await assert.rejects(resolveScope(runGit, { scope: "worktree" }, r.main), /on master, the base branch itself/);
		// With no master or main, origin/HEAD's target is the base.
		const bare = join(r.root, "clone");
		sh(r.root, "clone", "-q", r.main, bare);
		sh(bare, "branch", "-q", "-m", "master", "trunk");
		sh(bare, "checkout", "-q", "-b", "feat/y");
		const viaOrigin = await resolveScope(runGit, { scope: "worktree" }, bare);
		assert.equal(viaOrigin.kind === "worktree" && viaOrigin.baseRef, "origin/master");
		assert.equal(viaOrigin.kind === "worktree" && viaOrigin.base, sh(r.main, "rev-parse", "master"));
	} finally {
		r.done();
	}
});

test("pickDir: by branch, by path, the tree holding the cwd, else the cwd", () => {
	const r = repo();
	try {
		const t1 = { path: join(r.root, "w1"), branch: "feat/a", base: "x" };
		const t2 = { path: join(r.root, "w2"), branch: "feat/b", base: "x" };
		mkdirSync(join(t1.path, "deep"), { recursive: true });
		mkdirSync(t2.path);
		assert.deepEqual(pickDir({ scope: "dirty", worktree: "feat/b" }, r.main, [t1, t2]), { dir: t2.path, tree: t2 });
		assert.deepEqual(pickDir({ scope: "dirty", worktree: join(t1.path, "deep") }, r.main, [t1, t2]), { dir: join(t1.path, "deep"), tree: t1 });
		assert.deepEqual(pickDir({ scope: "dirty" }, join(t1.path, "deep"), [t1, t2]), { dir: join(t1.path, "deep"), tree: t1 });
		assert.deepEqual(pickDir({ scope: "worktree" }, r.main, [t1, t2]), { dir: r.main });
		assert.deepEqual(pickDir({ scope: "dirty" }, r.main, [t1]), { dir: r.main });
		assert.throws(() => pickDir({ scope: "dirty", worktree: "feat/zzz" }, r.main, [t1]), /neither a tracked worktree's branch nor a directory; tracked: feat\/a/);
	} finally {
		r.done();
	}
});

test("inPaths: files and directory prefixes", () => {
	assert.ok(inPaths("a/b.ts", undefined));
	assert.ok(inPaths("a/b.ts", ["a"]));
	assert.ok(inPaths("a/b.ts", ["a/"]));
	assert.ok(inPaths("a/b.ts", ["a/b.ts"]));
	assert.ok(!inPaths("ab/c.ts", ["a"]));
});
