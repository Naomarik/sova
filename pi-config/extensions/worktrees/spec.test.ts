// The merge's spec report against throwaway repositories and the real spec tools (extensions/spec/core).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mergeWorktree, runGit } from "./git.ts";
import { mergeSpecReport, specLines } from "./spec.ts";

const DRAFT = join(import.meta.dirname, "..", "spec", "core", "sova-spec-draft.mjs");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, text: string) => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
};
const LIST = "# §app/list\n\nThe list.\n\n## §app.list/mark\n\nA speech bubble and the count.\n";

function repo(withSpec = true) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-spec-")));
	const main = join(root, "repo");
	mkdirSync(main);
	sh(main, "init", "-q", "-b", "master");
	sh(main, "config", "user.email", "t@example.invalid");
	sh(main, "config", "user.name", "t");
	sh(main, "config", "commit.gpgsign", "false");
	put(main, ".gitignore", ".sova/spec/drafts/\n");
	put(main, "src/list.ts", "v1\n");
	if (withSpec) {
		put(main, ".sova/spec/manifest.json", `${JSON.stringify({ formatVersion: 1, claims: { "§app/list": { kind: "surface", authority: "accepted" }, "§app.list/mark": { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] } } }, null, 2)}\n`);
		put(main, ".sova/spec/claims/app/list.md", LIST);
	}
	sh(main, "add", "-A");
	sh(main, "commit", "-q", "-m", "base");
	const tree = join(root, "wt");
	sh(main, "worktree", "add", "-q", "-b", "feat/x", tree);
	return { main, tree, done: () => rmSync(root, { recursive: true, force: true }) };
}

async function merge(r: { tree: string }) {
	const m = await mergeWorktree(runGit, { tree: { path: r.tree, branch: "feat/x" }, target: "master" });
	return mergeSpecReport(runGit, { path: r.tree, branch: "feat/x", before: m.before, after: m.sha, branchSha: m.branchSha });
}

test("a merge's foreign §, code after the last spec commit, unpromoted drafts and orphaned evidence", async () => {
	const r = repo();
	try {
		// Code, then its spec (prose of a foreign § changed, a child added under a foreign surface), then more code.
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code");
		put(r.tree, ".sova/spec/claims/app/list.md", `${LIST.replace("A speech bubble and", "Only")}\n## §app.list/filter\n\nA filter.\n`);
		const m = JSON.parse(readFileSync(join(r.tree, ".sova/spec/manifest.json"), "utf8"));
		m.claims["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [] };
		put(r.tree, ".sova/spec/manifest.json", `${JSON.stringify(m, null, 2)}\n`);
		sh(r.tree, "commit", "-qam", "spec");
		put(r.tree, "src/list.ts", "v3\n");
		sh(r.tree, "commit", "-qam", "more code");
		const late = sh(r.tree, "rev-parse", "--short=7", "HEAD");
		// A draft with a change never promoted.
		execFileSync(process.execPath, [DRAFT, "new", "left", "--write", "--root", r.tree]);
		const cur = readFileSync(join(r.tree, ".sova/spec/claims/app/list.md"), "utf8");
		put(r.tree, ".sova/spec/drafts/left/spec/claims/app/list.md", cur.replace("The list.", "The session list."));
		// A draft whose evidence names a commit the branch does not have (rebased away).
		sh(r.main, "checkout", "-q", "-b", "gone");
		put(r.main, "src/other.ts", "x\n");
		sh(r.main, "add", "-A");
		sh(r.main, "commit", "-qm", "gone");
		const gone = sh(r.main, "rev-parse", "HEAD");
		sh(r.main, "checkout", "-q", "master");
		put(r.tree, ".sova/spec/drafts/old/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: gone }] }));

		const rep = await merge(r);
		assert.ok(rep);
		assert.deepEqual(rep.foreign, ["§app.list/mark", "§app/list"]);
		assert.equal(rep.warnings.length, 3, rep.warnings.join("\n"));
		assert.match(rep.warnings[0]!, /^draft left has 1 unpromoted record \(§app\/list\)/);
		assert.match(rep.warnings[1]!, new RegExp(`^evidence commit ${gone.slice(0, 7)} \\(draft old\\) is not on feat/x`));
		assert.match(rep.warnings[2]!, new RegExp(`^1 code commit after the last spec commit [0-9a-f]{7} \\(${late}\\)`));
		assert.deepEqual(specLines(rep).slice(0, 2), ["Foreign § this merge changes: §app.list/mark, §app/list", `Spec warning: ${rep.warnings[0]}`]);
	} finally {
		r.done();
	}
});

test("a clean spec'd merge reports its foreign § and no warnings; code-only branches get no code-after warning", async () => {
	const r = repo();
	try {
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code only");
		const rep = await merge(r);
		assert.deepEqual(rep, { foreign: [], warnings: [] });
		assert.deepEqual(specLines(rep!), ["Foreign § this merge changes: none"]);
	} finally {
		r.done();
	}
});

test("B3: master changed other § and the branch merged master in; the note names only the branch's §", async () => {
	const r = repo();
	try {
		const m = JSON.parse(readFileSync(join(r.main, ".sova/spec/manifest.json"), "utf8"));
		m.claims["§app/list"].evidence = "verified";
		put(r.main, ".sova/spec/manifest.json", `${JSON.stringify(m, null, 2)}\n`);
		sh(r.main, "commit", "-qam", "master: another task's spec");
		put(r.tree, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and", "Only"));
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "feat: code and spec");
		sh(r.tree, "merge", "-q", "--no-edit", "master");
		const rep = await merge(r);
		assert.deepEqual(rep, { foreign: ["§app.list/mark"], warnings: [] });
	} finally {
		r.done();
	}
});

test("a project without a spec, or without the spec tools, gets no report", async () => {
	const r = repo(false);
	try {
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code");
		assert.equal(await merge(r), undefined);
	} finally {
		r.done();
	}
	const s = repo();
	try {
		put(s.tree, "src/list.ts", "v2\n");
		sh(s.tree, "commit", "-qam", "code");
		const m = await mergeWorktree(runGit, { tree: { path: s.tree, branch: "feat/x" }, target: "master" });
		assert.equal(await mergeSpecReport(runGit, { path: s.tree, branch: "feat/x", before: m.before, after: m.sha, branchSha: m.branchSha }, { coreDir: "/nonexistent" }), undefined);
	} finally {
		s.done();
	}
});
