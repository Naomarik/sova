import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	activeTrees,
	mergeNote,
	normalizeActive,
	normalizeMergeDetails,
	restoreActive,
	sharedWith,
	statusText,
	type TrackedWorktree,
	treeOf,
	withTree,
	workerCwdRefusal,
	WORKTREES_ENTRY_TYPE,
	type WorktreesActive,
} from "./state.ts";

const tree = (over: Partial<TrackedWorktree> = {}): TrackedWorktree => ({
	path: "/w/repo-a",
	branch: "feat/a",
	base: "1111111aaaa",
	status: "active",
	session: "s1",
	how: "created",
	at: 1,
	...over,
});
const set = (...trees: TrackedWorktree[]): WorktreesActive => ({ version: 1, trees });
const entry = (data: unknown, customType = WORKTREES_ENTRY_TYPE) => ({ type: "custom", customType, data });

test("normalizeActive refuses a set with any malformed worktree, whole", () => {
	assert.deepEqual(normalizeActive(set(tree())), set(tree()));
	assert.equal(normalizeActive({ version: 2, trees: [] }), undefined);
	assert.equal(normalizeActive({ version: 1 }), undefined);
	assert.equal(normalizeActive(set(tree(), { ...tree(), path: "relative/x" })), undefined);
	assert.equal(normalizeActive(set(tree({ status: "gone" as never }))), undefined);
	// merged without its merge record is not a merged worktree.
	assert.equal(normalizeActive(set(tree({ status: "merged" }))), undefined);
	const merged = tree({ status: "merged", merge: { target: "master", sha: "abc", at: 2, how: "tool" } });
	assert.deepEqual(normalizeActive(set(merged)), set(merged));
	// A stale merge record on an active tree is dropped, not believed.
	assert.equal(normalizeActive(set({ ...tree(), merge: merged.merge }))?.trees[0]?.merge, undefined);
});

test("restoreActive takes the newest usable entry on the branch", () => {
	const a = set(tree());
	const b = set(tree(), tree({ path: "/w/repo-b", branch: "feat/b" }));
	assert.equal(restoreActive([]), undefined);
	assert.equal(restoreActive([entry(a, "sandbox")]), undefined);
	assert.deepEqual(restoreActive([entry(a), entry(b)]), b);
	// An unreadable newer entry falls back to the one before it.
	assert.deepEqual(restoreActive([entry(a), entry(b), entry({ version: 1, trees: [{ path: 3 }] })]), b);
	assert.deepEqual(restoreActive([entry(b), { type: "message" }, entry(a)]), a);
	assert.equal(restoreActive("nope" as never), undefined);
});

test("withTree replaces by path and keeps history", () => {
	const s = withTree(set(tree()), tree({ status: "dropped" }));
	assert.deepEqual(s.trees.map((t) => t.status), ["dropped"]);
	const two = withTree(s, tree({ path: "/w/repo-b" }));
	assert.deepEqual(activeTrees(two).map((t) => t.path), ["/w/repo-b"]);
	assert.equal(two.trees.length, 2);
});

test("workerCwdRefusal: the session cwd or an ACTIVE worktree, nothing else", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-state-")));
	try {
		const live = join(root, "live");
		const a = join(root, "wt-a");
		const b = join(root, "wt-b");
		for (const d of [live, join(live, "sub"), a, join(a, "src"), b]) mkdirSync(d, { recursive: true });
		const s = set(tree({ path: a }), tree({ path: b, status: "dropped" }));
		assert.equal(workerCwdRefusal({ sessionCwd: live, cwd: live, set: s }), undefined);
		assert.equal(workerCwdRefusal({ sessionCwd: live, cwd: join(live, "sub"), set: s }), undefined);
		assert.equal(workerCwdRefusal({ sessionCwd: live, cwd: a, set: s }), undefined);
		assert.equal(workerCwdRefusal({ sessionCwd: live, cwd: join(a, "src"), set: s }), undefined);
		// A dropped worktree no longer admits workers; the refusal names the active set.
		const refusal = workerCwdRefusal({ sessionCwd: live, cwd: b, set: s });
		assert.match(refusal ?? "", /outside this session's cwd and its worktrees/);
		assert.ok(refusal?.includes(a) && !refusal.includes(`${b},`));
		// A prefix that is not a path boundary is outside.
		mkdirSync(`${a}-evil`);
		assert.ok(workerCwdRefusal({ sessionCwd: live, cwd: `${a}-evil`, set: s }));
		// A symlink inside the session cwd that leads out is judged by where it leads.
		symlinkSync(b, join(live, "link"));
		assert.ok(workerCwdRefusal({ sessionCwd: live, cwd: join(live, "link"), set: s }));
		assert.equal(treeOf(s, join(a, "src"))?.path, a);
		// No set at all: only the session cwd.
		assert.match(workerCwdRefusal({ sessionCwd: live, cwd: a, set: undefined }) ?? "", /none tracked/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sharedWith names the session a tree was inherited from", () => {
	assert.equal(sharedWith(tree(), "s1"), undefined);
	assert.equal(sharedWith(tree(), "s2"), "s1");
});

test("merge note and card details", () => {
	const d = { version: 1, path: "/w/a", branch: "feat/x", target: "master", sha: "abc1234def", commits: 5, added: 120, removed: 30, fastForward: true, how: "tool" };
	assert.equal(mergeNote(d), "Merged feat/x into master at abc1234, 5 commits, +120 −30");
	assert.equal(mergeNote({ ...d, commits: 1 }), "Merged feat/x into master at abc1234, 1 commit, +120 −30");
	assert.deepEqual(normalizeMergeDetails(d), d);
	assert.equal(normalizeMergeDetails({ ...d, commits: -1 }), undefined);
	assert.equal(normalizeMergeDetails({ ...d, how: "guess" }), undefined);
	assert.equal(normalizeMergeDetails({ ...d, version: 2 }), undefined);
	assert.equal(statusText(tree({ status: "merged", merge: { target: "master", sha: "abc1234def", at: 1, how: "detected" } })), "merged into master at abc1234");
	assert.equal(statusText(tree({ status: "dropped" })), "dropped");
});
