// Run through tests/run.mjs (pi imports resolve from the installed package).
// Projects without a merge captain (al_4, plan "Worktree tool"): `worktree merge` makes a branch's drafts official
// on the branch first, as one docs commit, then merges code and docs together; a clash stops the merge with nothing
// changed unless the user said to merge without docs (withoutDocs). The REAL spec tools beside this extension do
// the work; each draft's state is read back with the draft tool itself.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worktrees from "./index.ts";

const DRAFT_TOOL = fileURLToPath(new URL("../spec/core/sova-spec-draft.mjs", import.meta.url));
const SPEC_TOOL = fileURLToPath(new URL("../spec/core/sova-spec.mjs", import.meta.url));
const TRAILER = "Sova-Spec-Landing";
const TOP = "# §a/top\n\nThe top does X.\n";

const env = () => {
	const e = { ...process.env };
	for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k) || k === "SPEC_AGREE_SOURCE" || k === "SPEC_AGREE_GIVEN") delete e[k];
	return e;
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();
const put = (cwd: string, rel: string, text: string) => {
	mkdirSync(dirname(join(cwd, rel)), { recursive: true });
	writeFileSync(join(cwd, rel), text);
};
function draftTool(cwd: string, ...args: string[]): any {
	const r = spawnSync(process.execPath, [DRAFT_TOOL, ...args, "--root", cwd, "--json"], { cwd, encoding: "utf8", env: env() });
	try {
		return JSON.parse(r.stdout);
	} catch {
		assert.fail(`draft tool ${args[0]}: no JSON (status ${r.status}): ${r.stdout}\n${r.stderr}`);
	}
}
const pendingOf = (cwd: string, name: string): string[] => {
	const d = draftTool(cwd, "drafts").drafts.find((x: { name: string }) => x.name === name);
	assert.ok(d, `no draft ${name}`);
	return [...d.pending, ...d.conflict];
};
const docsEntries = (cwd: string, range: string) => sh(cwd, "log", "--format=%H", `--grep=^${TRAILER}:`, range).split("\n").filter(Boolean);

function repo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-landing-")));
	const main = join(root, "repo");
	mkdirSync(main);
	sh(main, "init", "-q", "-b", "master");
	sh(main, "config", "user.email", "t@example.invalid");
	sh(main, "config", "user.name", "t");
	sh(main, "config", "commit.gpgsign", "false");
	put(main, ".sova/spec/.gitignore", "/drafts/\n");
	put(main, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/top.txt"] } } }, null, 2) + "\n");
	put(main, ".sova/spec/claims/a/top.md", TOP);
	put(main, "lib/top.txt", "top v1\n");
	sh(main, "add", "-A");
	sh(main, "commit", "-q", "-m", "base: a spec with one claim");
	return { root, main, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Just enough of ExtensionAPI for the tool (as index.test.ts's fakePi). */
function fakePi() {
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const messages: { customType: string; content: unknown; details: unknown }[] = [];
	let tool: any;
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: { on: () => {}, emit: () => {} },
		registerTool: (t: any) => (tool = t),
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (m: any) => messages.push(m),
	};
	const ctx = (cwd: string): any => ({ cwd, hasUI: false, sessionManager: { getSessionId: () => "s1", getBranch: () => entries }, ui: { confirm: async () => true } });
	const fire = async (name: string, c: unknown) => {
		for (const fn of handlers.get(name) ?? []) await fn({ type: name }, c);
	};
	/** The tool's answer text, or the error it threw (a refused merge). */
	const call = async (c: unknown, params: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
		try {
			const out = await tool.execute("t1", params, undefined, undefined, c);
			return { ok: !out?.isError, text: (out?.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n") };
		} catch (e) {
			return { ok: false, text: (e as Error).message };
		}
	};
	return { pi, ctx, fire, call };
}

/** A tracked worktree with one code commit and one draft: §b/<name> mapping it, or `edit` instead; a verification note. */
async function branchWithDraft(f: ReturnType<typeof fakePi>, c: unknown, r: ReturnType<typeof repo>, name: string, edit?: (spec: string) => string) {
	await f.call(c, { action: "create", name });
	const t = join(r.root, ".worktrees", `repo-${name}`);
	assert.ok(existsSync(t), "the tool made the worktree");
	put(t, `lib/${name}.txt`, `${name} v1\n`);
	sh(t, "add", "--", `lib/${name}.txt`);
	sh(t, "commit", "-q", "-m", `${name}: the feature`);
	assert.equal(draftTool(t, "new", name, "--write").exit, 0);
	const spec = join(t, ".sova/spec/drafts", name, "spec");
	let id = `§b/${name}`;
	if (edit) id = edit(spec);
	else {
		const m = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));
		m.claims[id] = { kind: "behavior", authority: "accepted", requires: [], code: [`lib/${name}.txt`] };
		writeFileSync(join(spec, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
		put(spec, `claims/b/${name}.md`, `# ${id}\n\nThe ${name} feature does its one thing.\n`);
	}
	const ev = draftTool(t, "evidence", name, "--id", id, "--by", "s1", "--verification", `ran ${name} by hand`, "--note", "--write");
	assert.equal(ev.exit, 0, `evidence --note: ${JSON.stringify(ev)}`);
	assert.equal(sh(t, "status", "--porcelain", "--untracked-files=all"), "", "drafts are gitignored");
	return { t, id, head: sh(t, "rev-parse", "HEAD") };
}

test("worktree merge with pending drafts: one docs commit on the branch, then code and docs land in one merge", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		const { t, id, head } = await branchWithDraft(f, c, r, "landing");
		const before = sh(r.main, "rev-parse", "master");
		const out = await f.call(c, { action: "merge", path: t });
		assert.ok(out.ok, out.text);
		const branchTip = sh(r.main, "rev-parse", "feat/landing");
		assert.equal(sh(r.main, "rev-parse", `${branchTip}^1`), head, "the docs commit sits on the branch head");
		assert.deepEqual(docsEntries(r.main, `${before}..master`), [branchTip], "one docs commit, with the trailer");
		const docsFiles = sh(r.main, "diff", "--name-only", head, branchTip).split("\n");
		assert.ok(docsFiles.every((p) => p.startsWith(".sova/spec/")), `spec paths only: ${docsFiles}`);
		const landed = sh(r.main, "diff", "--name-only", before, "master").split("\n");
		assert.ok(landed.includes("lib/landing.txt") && landed.includes(`.sova/spec/claims/b/landing.md`), `code and docs in one merge: ${landed}`);
		assert.deepEqual(pendingOf(t, "landing"), [], `${id} reads landed`);
		const chk = spawnSync(process.execPath, [SPEC_TOOL, "check", "--root", r.main, "--json"], { encoding: "utf8", env: env() });
		assert.ok((chk.status ?? 2) <= 1, chk.stdout);
	} finally {
		r.done();
	}
});

test("worktree merge stops on a docs clash with nothing changed; withoutDocs merges the code and names the drafts left behind", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		const { t, head } = await branchWithDraft(f, c, r, "clash", (spec) => {
			put(spec, "claims/a/top.md", "# §a/top\n\nThe top does X, and Y on the branch.\n");
			return "§a/top";
		});
		// Meanwhile master's docs say something else for §a/top.
		put(r.main, ".sova/spec/claims/a/top.md", "# §a/top\n\nThe top does X, and Z on master.\n");
		sh(r.main, "commit", "-q", "-am", "master: §a/top changed");
		const before = sh(r.main, "rev-parse", "master");

		const out = await f.call(c, { action: "merge", path: t });
		assert.equal(out.ok, false, `refused: ${out.text}`);
		assert.match(out.text, /§a\/top/, "names the clashing record");
		assert.equal(sh(r.main, "rev-parse", "master"), before, "master unchanged");
		assert.equal(sh(t, "rev-parse", "HEAD"), head, "the branch unchanged");
		assert.equal(sh(t, "status", "--porcelain", "--untracked-files=all"), "", "the worktree clean");
		assert.equal(sh(t, "diff", "--name-only", head, "--", ".sova/spec"), "", "its spec as it was");
		for (const left of [".sova/spec/.txn", ".sova/spec/drafts/.land"]) assert.ok(!existsSync(join(t, left)), `no ${left} left`);
		assert.deepEqual(pendingOf(t, "clash"), ["§a/top"]);

		// The user's word: merge without the docs.
		const without = await f.call(c, { action: "merge", path: t, withoutDocs: true });
		assert.ok(without.ok, without.text);
		assert.ok(sh(r.main, "merge-base", "--is-ancestor", head, "master") === "", "the code landed");
		assert.deepEqual(docsEntries(r.main, `${before}..master`), [], "no docs commit");
		assert.match(without.text, /\bclash\b/, "the answer names the draft left behind");
		assert.match(readFileSync(join(r.main, ".sova/spec/claims/a/top.md"), "utf8"), /Z on master/, "master's docs kept");
	} finally {
		r.done();
	}
});

test("worktree merge in a project without a spec is unchanged: no docs commit, nothing about docs", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-landing-nospec-")));
	try {
		const main = join(root, "repo");
		mkdirSync(main);
		sh(main, "init", "-q", "-b", "master");
		sh(main, "config", "user.email", "t@example.invalid");
		sh(main, "config", "user.name", "t");
		sh(main, "config", "commit.gpgsign", "false");
		put(main, "a.txt", "a\n");
		sh(main, "add", "a.txt");
		sh(main, "commit", "-q", "-m", "a");
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "plain" });
		const t = join(root, ".worktrees", "repo-plain");
		put(t, "b.txt", "b\n");
		sh(t, "add", "b.txt");
		sh(t, "commit", "-q", "-m", "b");
		const head = sh(t, "rev-parse", "HEAD");
		const out = await f.call(c, { action: "merge", path: t });
		assert.ok(out.ok, out.text);
		assert.equal(sh(main, "rev-parse", "master"), head, "a fast-forward to the branch head itself");
		assert.doesNotMatch(out.text, /docs|Spec warning/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
