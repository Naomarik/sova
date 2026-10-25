// The viewer's folder rule (folders.ts), shared with Sova's diff endpoint. Its pin against the
// endpoint's own reading of a session file is server/git-diff.test.ts "the show_changes tool's roots".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { folderKnown, knownRoots, sessionFolderCandidates } from "./folders.ts";

const AGENT = "/agent";
const tree = (path: string, status: string) => ({ path, branch: "feat/x", base: "abc1234", status, session: "s1", how: "created", at: 1_790_000_000_000 });
const merge = (path: string) => ({ version: 1, path, branch: "feat/m", target: "master", sha: "d".repeat(40), commits: 1, added: 1, removed: 0, fastForward: false, how: "tool" });
const manifest = (workerId: string, cwd: string) => ({ type: "custom", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", workerId, backend: "pi", at: 1, spec: { cwd } } });

test("roots: the session's folder, its workers', every worktree any entry names, merge cards; in that order", () => {
	const entries = [
		{ type: "custom", customType: "worktrees", data: { version: 1, trees: [tree("/w/dropped", "dropped")] } },
		manifest("w1", "/w/worker"),
		{ type: "custom", customType: "worktrees", data: { version: 1, trees: [tree("/w/active/", "active")] } },
		// A malformed set names nothing, and a merge card names its folder only when it is absolute.
		{ type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path: "/w/malformed" }] } },
		{ type: "custom_message", customType: "worktree-merge", details: merge("/w/merged") },
		{ type: "custom_message", customType: "worktree-merge", details: merge("relative/merged") },
		// A worker on a remote target runs in its local placeholder: the folder is on the target.
		manifest("w2", `${AGENT}/sova/targets/box/home/u/repo`),
		manifest("w3", "/w/main"),
	];
	assert.deepEqual(knownRoots(sessionFolderCandidates("/w/main", entries), AGENT), ["/w/main", "/w/worker", "/w/dropped", "/w/active", "/w/merged"]);
	assert.deepEqual(knownRoots(sessionFolderCandidates(undefined, []), AGENT), []);
	assert.deepEqual(knownRoots(["/", "//x//", "x"], AGENT), ["/", "/x"]);
});

test("folderKnown: at or below a root, canonical on both sides; a shared name prefix or a symlink out is not", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "show-changes-folders-")));
	try {
		const cwd = join(root, "repo");
		const sibling = join(root, "repo2");
		const outside = join(root, "scratch");
		for (const d of [join(cwd, "sub"), sibling, outside]) mkdirSync(d, { recursive: true });
		symlinkSync(outside, join(cwd, "out"));
		symlinkSync(cwd, join(root, "alias"));
		const roots = [cwd];
		assert.equal(folderKnown(cwd, roots), true);
		assert.equal(folderKnown(join(cwd, "sub"), roots), true);
		assert.equal(folderKnown(join(root, "alias", "sub"), roots), true);
		assert.equal(folderKnown(join(root, "alias"), [join(root, "alias")]), true);
		assert.equal(folderKnown(join(cwd, "sub"), [join(root, "alias")]), true);
		assert.equal(folderKnown(sibling, roots), false);
		assert.equal(folderKnown(outside, roots), false);
		assert.equal(folderKnown(join(cwd, "out"), roots), false);
		// A folder that no longer exists is judged by its spelling under its deepest existing ancestor.
		assert.equal(folderKnown(join(cwd, "gone", "deeper"), roots), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
