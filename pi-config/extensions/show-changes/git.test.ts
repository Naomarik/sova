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

test("worktree once merged: what the merge brought in, a fast-forward against the tracked base, new commits alone", async () => {
	const r = repo();
	try {
		const commit = (cwd: string, file: string) => {
			writeFileSync(join(cwd, file), `${file}\n`);
			sh(cwd, "add", file);
			sh(cwd, "commit", "-q", "-m", file);
		};
		const c0 = sh(r.main, "rev-parse", "HEAD");
		const setup = (name: string) => {
			const wt = join(r.root, name);
			sh(r.main, "worktree", "add", "-q", "-b", `feat/${name}`, wt, c0);
			commit(wt, `${name}.txt`);
			return { wt, tree: { path: wt, branch: `feat/${name}`, base: c0, baseBranch: "master" } };
		};
		const worktree = async (t: { wt: string; tree: { path: string; branch: string; base: string; baseBranch: string } }) => {
			const s = await resolveScope(runGit, { scope: "worktree" }, t.wt, t.tree);
			assert.equal(s.kind, "worktree");
			return { s: s as Extract<typeof s, { kind: "worktree" }>, files: await changedFiles(runGit, s) };
		};

		// (a) A merge commit into master: that merge's own change, named by it.
		const a = setup("a");
		commit(r.main, "m1.txt");
		sh(r.main, "merge", "-q", "--no-ff", "--no-edit", "feat/a");
		const la = sh(r.main, "rev-parse", "HEAD");
		let got = await worktree(a);
		assert.deepEqual(got.files, ["a.txt"]);
		assert.equal(got.s.baseRef, `master before ${la.slice(0, 7)}`);
		assert.deepEqual(got.files, sh(r.main, "diff", "--name-only", `${la}^1`, la).split("\n"));

		// (b) master merged into the branch first, then the branch merged: master's work stays out.
		const b = setup("b");
		sh(b.wt, "merge", "-q", "--no-edit", "master");
		commit(r.main, "m2.txt");
		sh(r.main, "merge", "-q", "--no-ff", "--no-edit", "feat/b");
		const lb = sh(r.main, "rev-parse", "HEAD");
		got = await worktree(b);
		assert.deepEqual(got.files, ["b.txt"]);
		assert.equal(got.s.baseRef, `master before ${lb.slice(0, 7)}`);

		// (d) New commits after the merge: only those, against the plain merge-base.
		sh(a.wt, "merge", "-q", "--ff-only", "master");
		commit(a.wt, "a2.txt");
		got = await worktree(a);
		assert.deepEqual(got.files, ["a2.txt"]);
		assert.equal(got.s.baseRef, "master");
		assert.equal(got.s.base, lb);

		// (c) A fast-forward: against the tracked base when it is an ancestor, else empty.
		const c = setup("c");
		sh(c.wt, "merge", "-q", "--no-edit", "master");
		sh(r.main, "merge", "-q", "--ff-only", "feat/c");
		const fork = sh(r.main, "merge-base", "feat/c", "master");
		got = await worktree({ wt: c.wt, tree: { ...c.tree, base: lb } });
		assert.deepEqual(got.files, ["c.txt"]);
		assert.equal(got.s.baseRef, `${lb.slice(0, 7)} (created from)`);
		got = await worktree({ wt: c.wt, tree: { ...c.tree, base: "0" } });
		assert.deepEqual(got.files, []);
		assert.equal(got.s.base, fork);
		// A branch with no commits beyond its tracked base stays empty.
		const d = { wt: c.wt, tree: { ...c.tree, base: sh(c.wt, "rev-parse", "HEAD") } };
		got = await worktree(d);
		assert.deepEqual(got.files, []);
		assert.equal(got.s.baseRef, "master");
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
