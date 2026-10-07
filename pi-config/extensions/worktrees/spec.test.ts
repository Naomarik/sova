// The merge's spec report against throwaway repositories and the real spec tools (extensions/spec/core).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const texts = (r: { warnings: { text: string }[] } | undefined) => (r?.warnings ?? []).map((w) => w.text);

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

async function merge(r: { tree: string }, extra: { onDefault?: boolean } = {}) {
	const m = await mergeWorktree(runGit, { tree: { path: r.tree, branch: "feat/x" }, target: "master" });
	return mergeSpecReport(runGit, { path: r.tree, branch: "feat/x", before: m.before, after: m.sha, branchSha: m.branchSha, ...extra });
}

test("a merge's unpromoted drafts and orphaned evidence; no foreign §, no code-after-spec warning", async () => {
	const r = repo();
	try {
		// Code, then its spec, then more code: no longer a warning.
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code");
		put(r.tree, ".sova/spec/claims/app/list.md", `${LIST.replace("A speech bubble and", "Only")}\n## §app.list/filter\n\nA filter.\n`);
		const m = JSON.parse(readFileSync(join(r.tree, ".sova/spec/manifest.json"), "utf8"));
		m.claims["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [] };
		put(r.tree, ".sova/spec/manifest.json", `${JSON.stringify(m, null, 2)}\n`);
		sh(r.tree, "commit", "-qam", "spec");
		put(r.tree, "src/list.ts", "v3\n");
		sh(r.tree, "commit", "-qam", "more code");
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
		assert.equal(rep.warnings.length, 2, texts(rep).join("\n"));
		assert.equal(rep.warnings[0]!.text, "draft left has 1 unpromoted record (§app/list): promote what shipped");
		assert.match(rep.warnings[1]!.text, new RegExp(`^evidence commit ${gone.slice(0, 7)} \\(draft old\\) is not on feat/x`));
		assert.deepEqual(specLines(rep), texts(rep).map((t) => `Spec warning: ${t}`));
		assert.ok(!specLines(rep).some((l) => /Foreign §|last line|Deferred|Plumbing/.test(l)));
	} finally {
		r.done();
	}
});

test("a clean spec'd merge says nothing, code under an unchanged § included", async () => {
	const r = repo();
	try {
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code only");
		const rep = await merge(r);
		assert.deepEqual(rep?.warnings, []);
		assert.equal(rep?.top, r.main);
		assert.deepEqual(specLines(rep!), []);
	} finally {
		r.done();
	}
});

test("B3: master changed other § and the branch merged master in; nothing to warn about", async () => {
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
		assert.deepEqual(rep?.warnings, []);
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

test("the landing lists: an unmapped file and an unpromoted draft, worded with no closing line", async () => {
	const r = repo();
	try {
		execFileSync(process.execPath, [DRAFT, "new", "links", "--write", "--root", r.tree]);
		put(r.tree, ".sova/spec/drafts/links/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "The count, and a link out."));
		put(r.tree, "src/list.ts", "v2 links\n");
		put(r.tree, "scripts/links.sh", "echo\n");
		sh(r.tree, "add", "-A");
		sh(r.tree, "commit", "-qm", "links, spec deferred");
		const rep = await merge(r);
		assert.ok(rep?.landing);
		assert.deepEqual(rep.landing.unmappedChanged, [{ path: "scripts/links.sh", status: "A", inBoundary: false }]);
		assert.deepEqual(rep.landing.unpromotedDrafts.map((d) => [d.draft, d.ids]), [["links", ["§app.list/mark"]]]);
		assert.equal(rep.warnings[0]!.text, "1 changed file no claim maps (scripts/links.sh): spec any whose change a user sees");
		assert.equal(rep.warnings[1]!.text, "draft links has 1 unpromoted record (§app.list/mark): promote what shipped");
		assert.ok(rep.warnings[1]!.key);
	} finally {
		r.done();
	}
});

test("q14: into the default branch, the landing's own draft is to be promoted now", async () => {
	const r = repo();
	try {
		execFileSync(process.execPath, [DRAFT, "new", "links", "--write", "--root", r.tree]);
		put(r.tree, ".sova/spec/drafts/links/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "The count, and a link out."));
		put(r.tree, "src/list.ts", "v2 links\n");
		sh(r.tree, "commit", "-qam", "links, spec deferred");
		const rep = await merge(r, { onDefault: true });
		assert.deepEqual(texts(rep).filter((w) => w.startsWith("draft links")), ["draft links has 1 unpromoted record (§app.list/mark): this landed on the default branch, so promote it now"]);
	} finally {
		r.done();
	}
});

test("a draft is said once a session, and again when its pending § change", () => {
	const said = new Set<string>();
	const rep = (key: string) => ({ warnings: [{ text: "draft d has 1 unpromoted record (§a/b): promote what shipped", key }, { text: "1 changed file no claim maps (x): spec any whose change a user sees" }] });
	assert.equal(specLines(rep("d§a/b"), said).length, 2);
	assert.deepEqual(specLines(rep("d§a/b"), said), ["Spec warning: 1 changed file no claim maps (x): spec any whose change a user sees"]);
	assert.equal(specLines(rep("d§a/b,§a/c"), said).length, 2);
	assert.equal(specLines(rep("d§a/b")).length, 2, "without a set, every warning");
});

test("F8: a draft already promoted is not 'unpromoted' when master later changed the same §", async () => {
	const r = repo();
	try {
		execFileSync(process.execPath, [DRAFT, "new", "done", "--write", "--root", r.tree]);
		put(r.tree, ".sova/spec/drafts/done/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "Only the count."));
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code");
		const ev = (...a: string[]) => execFileSync(process.execPath, [DRAFT, ...a, "--root", r.tree, "--json"], { encoding: "utf8" });
		ev("evidence", "done", "--id", "§app.list/mark", "--by", "t", "--verification", "ran", "--commit", "HEAD", "--write");
		const plan = JSON.parse(ev("promote", "done", "--id", "§app.list/mark")).plan;
		ev("promote", "done", "--id", "§app.list/mark", "--plan", plan, "--write");
		sh(r.tree, "commit", "-qam", "spec");
		// Another task changes the same § on master; the branch merges it in, taking master's text.
		put(r.main, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "The count, in bold."));
		sh(r.main, "commit", "-qam", "master: mark");
		try { sh(r.tree, "merge", "-q", "--no-edit", "master"); } catch { sh(r.tree, "checkout", "--theirs", ".sova/spec/claims/app/list.md"); sh(r.tree, "commit", "-qam", "merge master"); }
		const st = JSON.parse(spawnSync(process.execPath, [DRAFT, "status", "done", "--root", r.tree, "--json"], { encoding: "utf8" }).stdout);
		assert.deepEqual(st.ids.map((i: { current: string }) => i.current), ["conflict"], "the old check counted this as unpromoted");
		const rep = await merge(r);
		assert.deepEqual(rep?.landing?.unpromotedDrafts, []);
		assert.ok(!texts(rep).some((w) => /unpromoted/.test(w)), texts(rep).join("\n"));
	} finally {
		r.done();
	}
});

test("a hand merge on the branch is no landing hand resolution", async () => {
	const r = repo();
	try {
		// Master and the branch both reword §app.list/mark; the branch's merge resolves it with a third text.
		put(r.main, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "Master's words."));
		sh(r.main, "commit", "-qam", "master: mark");
		put(r.tree, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "The branch's words."));
		sh(r.tree, "commit", "-qam", "feat: mark");
		try { sh(r.tree, "merge", "-q", "--no-edit", "master"); } catch { /* the conflict, resolved below */ }
		put(r.tree, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "A third text."));
		sh(r.tree, "add", "-A");
		sh(r.tree, "commit", "-qm", "merge master by hand");
		const before = sh(r.main, "rev-parse", "HEAD");
		sh(r.main, "merge", "-q", "--no-ff", "--no-edit", "feat/x");
		const after = sh(r.main, "rev-parse", "HEAD");
		const rep = await mergeSpecReport(runGit, { path: r.tree, branch: "feat/x", before, after, branchSha: sh(r.tree, "rev-parse", "HEAD") });
		assert.deepEqual(rep?.landing?.handResolved, [], "the landing merge is clean; the hand merge is on the branch");
		assert.deepEqual(rep?.warnings, []);
	} finally {
		r.done();
	}
});

test("the note's hand-resolution warning: a landing merge commit whose § differ from both parents", async () => {
	const r = repo();
	try {
		put(r.main, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "Master's words."));
		sh(r.main, "commit", "-qam", "master: mark");
		put(r.tree, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "The branch's words."));
		sh(r.tree, "commit", "-qam", "feat: mark");
		const before = sh(r.main, "rev-parse", "HEAD");
		try { sh(r.main, "merge", "-q", "--no-edit", "feat/x"); } catch { /* the conflict */ }
		put(r.main, ".sova/spec/claims/app/list.md", LIST.replace("A speech bubble and the count.", "A third text."));
		sh(r.main, "add", "-A");
		sh(r.main, "commit", "-qm", "merge by hand");
		const after = sh(r.main, "rev-parse", "HEAD");
		const rep = await mergeSpecReport(runGit, { path: r.tree, branch: "feat/x", before, after, branchSha: sh(r.tree, "rev-parse", "HEAD") });
		assert.deepEqual(rep?.landing?.handResolved, [{ commit: after, ids: ["§app.list/mark"] }]);
		assert.ok(texts(rep).some((w) => w.startsWith(`merge ${after.slice(0, 7)} resolved §app.list/mark by hand`) && w.includes(`git show --cc ${after.slice(0, 7)}`)), texts(rep).join("\n"));
	} finally {
		r.done();
	}
});

test("when the core can't compute the landing, the note says so", async () => {
	const r = repo();
	try {
		put(r.tree, "src/list.ts", "v2\n");
		sh(r.tree, "commit", "-qam", "code");
		const m = await mergeWorktree(runGit, { tree: { path: r.tree, branch: "feat/x" }, target: "master" });
		const rep = await mergeSpecReport(runGit, { path: r.tree, branch: "feat/x", before: m.before, after: m.sha, branchSha: m.branchSha }, { node: async () => ({ code: 2, stdout: "" }) });
		assert.deepEqual(texts(rep), ["the merge's unmapped files and unpromoted drafts could not be computed (no output); check them yourself"]);
	} finally {
		r.done();
	}
});
