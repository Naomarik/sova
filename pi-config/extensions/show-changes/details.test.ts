import assert from "node:assert/strict";
import test from "node:test";
import { isRepoPath, normalizeShowChangesDetails, scopeLine, type ShowChangesDetails } from "./details.ts";
import { checkShowChangesParams, ShowChangesError } from "./input.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const good: ShowChangesDetails = {
	v: 1,
	scope: { kind: "worktree", worktreePath: "/r/wt", root: "/r/wt", branch: "feat/x", head: A, base: B, baseRef: "master" },
	title: "Rate limits",
	paths: ["server/", "src/a.ts"],
	steps: [
		{ title: "Limiter", why: "shared", hunks: [{ path: "server/limit.ts" }] },
		{ title: "Wire it", buildsOn: [1], hunks: [{ path: "server/routes.ts", newStart: 120 }, { path: "server/routes.ts", oldStart: 3, newStart: 4 }] },
	],
};

test("a well-formed details object round-trips as a fresh copy", () => {
	const out = normalizeShowChangesDetails(structuredClone(good));
	assert.deepEqual(out, good);
	assert.notEqual(out, good);
	assert.deepEqual(normalizeShowChangesDetails({ v: 1, scope: { kind: "dirty", cwd: "/r/sub", root: "/r", head: A } }), {
		v: 1,
		scope: { kind: "dirty", cwd: "/r/sub", root: "/r", head: A },
	});
	assert.deepEqual(normalizeShowChangesDetails({ v: 1, scope: { kind: "commit", repoPath: "/r", root: "/r", sha: A } })?.scope, { kind: "commit", repoPath: "/r", root: "/r", sha: A });
});

test("the normalizer refuses anything off, never throws", () => {
	const bad = (mut: (d: any) => void) => {
		const d: any = structuredClone(good);
		mut(d);
		return normalizeShowChangesDetails(d);
	};
	assert.equal(bad((d) => (d.v = 2)), undefined);
	assert.equal(bad((d) => (d.extra = 1)), undefined);
	assert.equal(bad((d) => (d.scope.kind = "range")), undefined);
	assert.equal(bad((d) => (d.scope.head = "abc")), undefined);
	assert.equal(bad((d) => (d.scope.worktreePath = "rel")), undefined);
	assert.equal(bad((d) => (d.scope.sha = A)), undefined);
	assert.equal(bad((d) => (d.paths = [])), undefined);
	assert.equal(bad((d) => (d.paths = ["../x"])), undefined);
	assert.equal(bad((d) => (d.steps = [])), undefined);
	assert.equal(bad((d) => (d.steps[0].hunks = [])), undefined);
	assert.equal(bad((d) => (d.steps[0].hunks[0].path = "dir/")), undefined);
	assert.equal(bad((d) => (d.steps[1].buildsOn = [2])), undefined);
	assert.equal(bad((d) => (d.steps[1].buildsOn = [1, 1])), undefined);
	assert.equal(bad((d) => (d.steps[1].hunks[0].newStart = -1)), undefined);
	assert.equal(bad((d) => d.steps[1].hunks.push({ path: "server/limit.ts" })), undefined);
	assert.equal(bad((d) => (d.title = " ")), undefined);
	for (const v of [null, undefined, 1, "x", [], { v: 1 }]) assert.equal(normalizeShowChangesDetails(v), undefined);
	const hostile = { v: 1, get scope() { throw new Error("boom"); } };
	assert.equal(normalizeShowChangesDetails(hostile), undefined);
});

test("repo paths: relative, posix, no dot segments", () => {
	for (const p of ["a", "a/b.ts", "dir/", ".github/x.yml", "a..b"]) assert.ok(isRepoPath(p), p);
	for (const p of ["", "/abs", "a//b", "./a", "a/../b", "..", "a\\b", "a/\n", "dir//"]) assert.ok(!isRepoPath(p), JSON.stringify(p));
});

test("scopeLine names each scope", () => {
	assert.equal(scopeLine(good.scope), `feat/x vs master (bbbbbbb..aaaaaaa) in /r/wt`);
	assert.equal(scopeLine({ kind: "commit", repoPath: "/r", root: "/r", sha: A }), "commit aaaaaaa (root commit) in /r");
	assert.equal(scopeLine({ kind: "dirty", cwd: "/r", root: "/r", head: B }), "uncommitted changes vs HEAD bbbbbbb in /r");
});

test("input: a valid call becomes a request; paths are tidied", () => {
	const req = checkShowChangesParams({
		scope: "worktree",
		worktree: "feat/x",
		title: " Rate limits ",
		paths: ["./server/", "server/", "src/a.ts"],
		steps: [
			{ title: "Limiter", hunks: [{ path: "./server/limit.ts" }] },
			{ title: "Wire", buildsOn: [1], hunks: [{ path: "server/routes.ts", newStart: 120 }] },
		],
	});
	assert.deepEqual(req, {
		scope: "worktree",
		worktree: "feat/x",
		title: "Rate limits",
		paths: ["server/", "src/a.ts"],
		steps: [
			{ title: "Limiter", hunks: [{ path: "server/limit.ts" }] },
			{ title: "Wire", buildsOn: [1], hunks: [{ path: "server/routes.ts", newStart: 120 }] },
		],
	});
	assert.deepEqual(checkShowChangesParams({ scope: "commit", commit: "HEAD~1" }), { scope: "commit", commit: "HEAD~1" });
});

test("input: each refusal says what to fix", () => {
	const refuse = (p: unknown, re: RegExp) => assert.throws(() => checkShowChangesParams(p), (e: unknown) => e instanceof ShowChangesError && re.test(e.message));
	refuse({ scope: "range" }, /scope must be one of dirty, worktree, commit/);
	refuse({ scope: "commit" }, /commit \(required with scope commit\)/);
	refuse({ scope: "commit", commit: "--output=/tmp/x" }, /commit-ish/);
	refuse({ scope: "commit", commit: "HEAD", worktree: "x" }, /worktree is for scope dirty or worktree/);
	refuse({ scope: "dirty", commit: "HEAD" }, /commit is only for scope commit/);
	refuse({ scope: "dirty", files: [] }, /unknown field "files"/);
	refuse({ scope: "dirty", paths: ["/etc/passwd"] }, /relative to the repository/);
	refuse({ scope: "dirty", paths: ["a/../../b"] }, /no "\." or "\.\." segment/);
	refuse({ scope: "dirty", steps: [{ title: "x", hunks: [] }] }, /steps\[0\]\.hunks must list at least one hunk/);
	refuse({ scope: "dirty", steps: [{ title: "x", buildsOn: [1], hunks: [{ path: "a" }] }] }, /not an earlier step's number .*this is step 1/);
	refuse({ scope: "dirty", steps: [{ title: "x", hunks: [{ path: "a/" }] }] }, /must name a file, not a directory/);
	refuse({ scope: "dirty", steps: [{ title: "x", hunks: [{ path: "a", newStart: 1.5 }] }] }, /newStart must be a line number/);
	refuse(
		{ scope: "dirty", steps: [{ title: "x", hunks: [{ path: "a", newStart: 3 }] }, { title: "y", hunks: [{ path: "a", newStart: 3 }] }] },
		/steps\[1\]\.hunks\[0\] \(a @3\) is already in step 1: each hunk belongs to exactly one step/,
	);
	refuse({ scope: "dirty", steps: [{ title: "x", why: "", hunks: [{ path: "a" }] }] }, /why must be a non-empty string/);
});
