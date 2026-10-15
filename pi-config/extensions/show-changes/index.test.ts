// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeShowChangesDetails, SHOW_CHANGES_TOOL } from "./details.ts";
import { runGit } from "./git.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import showChanges, { renderShowChangesResult, serverAgentDir } from "./index.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "show-changes-ext-")));
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

function fakePi(entries: unknown[] = []) {
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const bus = new Map<string, ((d: unknown) => void)[]>();
	const emitted: string[] = [];
	let tool: any;
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: {
			on: (name: string, fn: any) => bus.set(name, [...(bus.get(name) ?? []), fn]),
			emit: (name: string, data: unknown) => {
				emitted.push(name);
				for (const fn of bus.get(name) ?? []) fn(data);
			},
		},
		registerTool: (t: any) => (tool = t),
	};
	const ctx = (cwd: string): any => ({ cwd, sessionManager: { getBranch: () => entries } });
	const fire = async (name: string, c: unknown) => {
		for (const fn of handlers.get(name) ?? []) await fn({ type: name }, c);
	};
	return { pi, ctx, fire, emitted, tool: () => tool, call: (c: unknown, params: unknown) => tool.execute("t1", params, undefined, undefined, c) };
}

const plainTheme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

test("registers show_changes with its prompt snippet and guidelines", () => {
	const f = fakePi();
	showChanges(f.pi);
	const t = f.tool();
	assert.equal(t.name, SHOW_CHANGES_TOOL);
	assert.match(t.promptSnippet, /changes viewer/);
	assert.match(t.description, /every hunk must be in exactly one step, or the call is refused/);
	assert.match(t.description, /Read the diff first/);
	assert.ok(t.promptGuidelines.some((g: string) => /rather than pasting a diff/.test(g)));
	// The viewer opens only the session's checkout and its worktrees: no text may invite another folder.
	assert.ok(t.promptGuidelines.some((g: string) => /only git changes in this session's checkout or its tracked worktrees/.test(g)));
	assert.match(t.parameters.properties.worktree.description, /The viewer opens no other folder/);
	assert.doesNotMatch(JSON.stringify([t.description, t.promptGuidelines, t.parameters]), /or a directory/);
	assert.equal(t.parameters.additionalProperties, false);
	// The agent no longer sends "builds on": not in the schema, the description, the guidelines or the example.
	assert.doesNotMatch(JSON.stringify(t.parameters), /buildsOn/);
	assert.doesNotMatch(t.description, /buildsOn/);
	assert.ok(t.promptGuidelines.every((g: string) => !/buildsOn/.test(g)));
});

test("dirty scope: whole-file refs place every hunk; details Sova can read and the files in the text", async () => {
	const r = repo();
	try {
		writeFileSync(join(r.main, "a.txt"), "two\n");
		writeFileSync(join(r.main, "b.txt"), "b\n");
		const f = fakePi();
		showChanges(f.pi);
		const out = await f.call(f.ctx(r.main), {
			scope: "dirty",
			title: "Edits",
			steps: [{ title: "Change a", hunks: [{ path: "a.txt" }] }, { title: "Add b", hunks: [{ path: "b.txt" }] }],
		});
		assert.deepEqual(normalizeShowChangesDetails(out.details), out.details);
		assert.deepEqual(out.details.scope, { kind: "dirty", cwd: r.main, root: r.main, head: sh(r.main, "rev-parse", "HEAD") });
		const text = out.content[0].text;
		assert.match(text, /^Opened the changes viewer for the user: uncommitted changes vs HEAD/);
		assert.match(text, /2 changed files:\n {2}a\.txt\n {2}b\.txt\n2 steps; every hunk \(2 hunks\) is placed in a step\.\n/);
		const rendered = renderShowChangesResult(out, true, plainTheme).render(200).join("\n");
		assert.match(rendered, /Edits · uncommitted changes .* · 2 steps · open it in Sova/);
		assert.match(rendered, /1\. Change a · 1 ref/);
	} finally {
		r.done();
	}
});

/** A repository whose last commit changes a.txt in two places and adds b.txt: three hunks. */
function threeHunks() {
	const r = repo();
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
	writeFileSync(join(r.main, "a.txt"), `${lines.join("\n")}\n`);
	sh(r.main, "commit", "-q", "-am", "thirty");
	lines[2] = "line three";
	lines[26] = "line twenty-seven";
	writeFileSync(join(r.main, "a.txt"), `${lines.join("\n")}\n`);
	writeFileSync(join(r.main, "b.txt"), "b\n");
	sh(r.main, "add", ".");
	sh(r.main, "commit", "-q", "-m", "edits");
	return r;
}

test("refusal a: several hunks and no steps; nothing is shown, every hunk listed", async () => {
	const r = threeHunks();
	try {
		const f = fakePi();
		showChanges(f.pi);
		await assert.rejects(f.call(f.ctx(r.main), { scope: "commit", commit: "HEAD" }), (e: Error) => {
			assert.equal(
				e.message,
				[
					"Nothing was shown: this diff has 3 hunks in 2 files and the call sent no steps.",
					"Resend show_changes with steps that place every hunk below. If the change is one idea, send one step naming every file by path alone ({path} with no start takes all of a file's hunks).",
					"Hunks (path, then @@ +newStart,newLines: first changed line):",
					"a.txt",
					"  @@ +1,6: -line 3",
					"  @@ +24,7: -line 27",
					"b.txt",
					"  @@ +1,1: +b",
				].join("\n"),
			);
			return true;
		});
	} finally {
		r.done();
	}
});

test("refusal b: a hunk no step places, or a ref naming no hunk; one hunk alone needs no steps", async () => {
	const r = threeHunks();
	try {
		const f = fakePi();
		showChanges(f.pi);
		const c = f.ctx(r.main);
		await assert.rejects(
			f.call(c, { scope: "commit", commit: "HEAD", steps: [{ title: "Top", hunks: [{ path: "a.txt", newStart: 4 }, { path: "b.txt" }] }] }),
			/^Error: Nothing was shown: the steps leave 1 of 3 hunks placed by no step\. .*\nPlaced by no step .*\na\.txt\n {2}@@ \+24,7: -line 27$/s,
		);
		await assert.rejects(
			f.call(c, { scope: "commit", commit: "HEAD", steps: [{ title: "All", hunks: [{ path: "a.txt" }, { path: "b.txt" }, { path: "a.txt", newStart: 15 }] }] }),
			/^Error: Nothing was shown: the steps leave 1 ref naming no hunk\. .*\nRefs naming no hunk \(fix or remove them\):\n {2}step 1: \{path: "a\.txt", newStart: 15\}: new-side line inside none of its hunks \(\+1,6 \+24,7\)$/s,
		);
		const byHunk = await f.call(c, {
			scope: "commit",
			commit: "HEAD",
			steps: [{ title: "Top", hunks: [{ path: "a.txt", newStart: 3 }] }, { title: "Rest", hunks: [{ path: "a.txt", oldStart: 30 }, { path: "b.txt" }] }],
		});
		assert.match(byHunk.content[0].text, /2 steps; every hunk \(3 hunks\) is placed in a step\./);
		const one = await f.call(c, { scope: "commit", commit: "HEAD", paths: ["b.txt"] });
		assert.match(one.content[0].text, /1 changed file:\n {2}b\.txt\n1 hunk, no steps needed\./);
	} finally {
		r.done();
	}
});

test("worktree scope follows the tracked worktree from the session cwd; paths filter the listing", async () => {
	const r = repo();
	try {
		const wt = join(r.root, "wt");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/x", wt);
		mkdirSync(join(wt, "src"));
		writeFileSync(join(wt, "src", "c.ts"), "c\n");
		writeFileSync(join(wt, "d.txt"), "d\n");
		sh(wt, "add", ".");
		sh(wt, "commit", "-q", "-m", "c");
		const base = sh(r.main, "rev-parse", "HEAD");
		const entries = [{ type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path: wt, branch: "feat/x", base, status: "active", session: "s1", how: "created", at: 1_790_000_000_000 }] } }];
		const f = fakePi(entries);
		showChanges(f.pi);
		const out = await f.call(f.ctx(r.main), { scope: "worktree", paths: ["src"] });
		assert.equal(out.details.scope.kind, "worktree");
		assert.equal(out.details.scope.worktreePath, wt);
		assert.equal(out.details.scope.base, base);
		assert.deepEqual(out.details.paths, ["src"]);
		assert.match(out.content[0].text, /feat\/x vs master .*limited to src\.\n1 changed file:\n {2}src\/c\.ts\n/);
	} finally {
		r.done();
	}
});

test("a folder the viewer won't open is refused, nothing shown; a tracked worktree by branch, or a folder inside the cwd, opens", async () => {
	const r = repo();
	try {
		// The real failure: a scratch repository outside the session's folders, with the change uncommitted.
		const scratch = join(r.root, "scratch");
		mkdirSync(scratch);
		sh(scratch, "init", "-q", "-b", "master");
		writeFileSync(join(scratch, "a.txt"), "new\n");
		const wt = join(r.root, "wt");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/x", wt);
		writeFileSync(join(wt, "a.txt"), "two\n");
		const base = sh(r.main, "rev-parse", "HEAD");
		const entries = [{ type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path: wt, branch: "feat/x", base, status: "active", session: "s1", how: "created", at: 1_790_000_000_000 }] } }];
		const f = fakePi(entries);
		showChanges(f.pi);
		await assert.rejects(
			f.call(f.ctx(r.main), { scope: "dirty", worktree: scratch }),
			(e: Error) => {
				assert.equal(e.message, `${scratch} is outside this session's folder and its worktrees, so the viewer can't open it. Put the changes in a worktree (the worktree tool) and show that. Nothing was shown.`);
				return true;
			},
		);
		const byBranch = await f.call(f.ctx(r.main), { scope: "dirty", worktree: "feat/x" });
		assert.equal(byBranch.details.scope.cwd, wt);
		assert.match(byBranch.content[0].text, /^Opened the changes viewer/);
		mkdirSync(join(r.main, "sub"));
		const inside = await f.call(f.ctx(r.main), { scope: "dirty", worktree: "sub" });
		assert.equal(inside.details.scope.cwd, join(r.main, "sub"));
	} finally {
		r.done();
	}
});

test("the folders the viewer opens: the header's cwd (not the process cwd), workers' folders, never a remote placeholder", async () => {
	const r = repo();
	try {
		// Two other repositories: one a worker runs in, one a worker on a remote target maps to locally.
		const agentDir = join(r.root, "agent");
		const mk = (dir: string) => {
			mkdirSync(dir, { recursive: true });
			sh(dir, "init", "-q", "-b", "master");
			sh(dir, "config", "user.email", "t@example.invalid");
			sh(dir, "config", "user.name", "t");
			sh(dir, "config", "commit.gpgsign", "false");
			writeFileSync(join(dir, "w.txt"), "w\n");
			sh(dir, "add", ".");
			sh(dir, "commit", "-q", "-m", "w");
			writeFileSync(join(dir, "w.txt"), "w2\n");
			return dir;
		};
		const worker = mk(join(r.root, "worker"));
		const placeholder = mk(join(agentDir, "sova", "targets", "box", "repo"));
		const manifest = (workerId: string, cwd: string) => ({ type: "custom", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", workerId, backend: "pi", at: 1, spec: { cwd } } });
		const entries = [manifest("w1", worker), manifest("w2", placeholder)];
		const f = fakePi(entries);
		showChanges(f.pi, { agentDir: () => agentDir });
		const ctx = (cwd: string, headerCwd: string) => ({ ...f.ctx(cwd), sessionManager: { getHeader: () => ({ type: "session", cwd: headerCwd }), getEntries: () => entries, getBranch: () => entries } });
		const inWorker = await f.call(ctx(r.main, r.main), { scope: "dirty", worktree: worker });
		assert.equal(inWorker.details.scope.cwd, worker);
		await assert.rejects(f.call(ctx(r.main, r.main), { scope: "dirty", worktree: placeholder }), /is outside this session's folder and its worktrees/);
		// The viewer knows the session by its header's cwd: a process cwd elsewhere (pi's cwd override) is not known.
		const elsewhere = mk(join(r.root, "elsewhere"));
		await assert.rejects(f.call(ctx(elsewhere, r.main), { scope: "dirty" }), new RegExp(`^Error: ${elsewhere} is outside`));
		assert.equal((await f.call(ctx(elsewhere, elsewhere), { scope: "dirty" })).details.scope.cwd, elsewhere);
	} finally {
		r.done();
	}
});

test("a worktree recorded on another branch of the session is known: the viewer reads the whole file, not the branch", async () => {
	const r = repo();
	try {
		const wt = join(r.root, "wt");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/x", wt);
		writeFileSync(join(wt, "a.txt"), "two\n");
		const base = sh(r.main, "rev-parse", "HEAD");
		const set = { type: "custom", id: "b1", parentId: "root", customType: "worktrees", data: { version: 1, trees: [{ path: wt, branch: "feat/x", base, status: "active", session: "s1", how: "created", at: 1_790_000_000_000 }] } };
		const here = { type: "custom", id: "c1", parentId: "root", customType: "note", data: {} };
		// The file holds both branches; the current branch (c1) never saw the worktree entry (b1).
		const all = [set, here];
		const f = fakePi();
		showChanges(f.pi, { agentDir: () => join(r.root, "agent") });
		const ctx = { ...f.ctx(r.main), sessionManager: { getHeader: () => ({ type: "session", cwd: r.main }), getEntries: () => all, getBranch: () => [here] } };
		const out = await f.call(ctx, { scope: "dirty", worktree: wt });
		assert.equal(out.details.scope.cwd, wt);
		// The branch alone would not know it.
		const branchOnly = { ...ctx, sessionManager: { getHeader: () => ({ type: "session", cwd: r.main }), getEntries: () => [here], getBranch: () => [here] } };
		await assert.rejects(f.call(branchOnly, { scope: "dirty", worktree: wt }), /is outside this session's folder/);
	} finally {
		r.done();
	}
});

test("placeholders are the hosting server's: a worker with its own agent dir uses SOVA_CHAT_STATE_ROOT", () => {
	assert.equal(serverAgentDir({ SOVA_CHAT_STATE_ROOT: "/srv/agent/sova", PI_CODING_AGENT_DIR: "/loadout/agent" }), "/srv/agent");
	assert.equal(serverAgentDir({ PI_CODING_AGENT_DIR: "/srv/agent" }), getAgentDir());
});

test("refusals: bad input, no repository, a remote session; nothing is shown", async () => {
	const r = repo();
	try {
		const f = fakePi();
		showChanges(f.pi);
		await assert.rejects(f.call(f.ctx(r.main), { scope: "commit" }), /commit \(required with scope commit\) must be a non-empty string\. Nothing was shown\./);
		const empty = realpathSync(mkdtempSync(join(tmpdir(), "show-changes-norepo-")));
		try {
			await assert.rejects(f.call(f.ctx(empty), { scope: "dirty" }), /is not in a git repository/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
		const clean = await f.call(f.ctx(r.main), { scope: "dirty" });
		assert.match(clean.content[0].text, /There are no changes in this scope\./);
		await f.fire("session_start", f.ctx(r.main));
		assert.ok(f.emitted.includes("remote:discover"));
		f.pi.events.emit("remote:session", { version: 1 });
		await assert.rejects(f.call(f.ctx(r.main), { scope: "dirty" }), /local only/);
	} finally {
		r.done();
	}
});

test("past 3,000 files, counted within the paths given, the call is refused with a hint to narrow it", async () => {
	const r = repo();
	try {
		writeFileSync(join(r.main, "a.txt"), "two\n");
		// A git that lists 3,001 changed files under big/ besides a.txt.
		const many = Array.from({ length: 3001 }, (_, i) => `big/f${i}.txt`);
		const git = async (args: string[], cwd: string, opts?: any) => {
			const out = await runGit(args, cwd, opts);
			return args.includes("--name-only") ? { ...out, stdout: `${out.stdout}${many.join("\0")}\0` } : out;
		};
		const f = fakePi();
		showChanges(f.pi, { git });
		await assert.rejects(f.call(f.ctx(r.main), { scope: "dirty" }), /^Error: 3002 files changed, more than the 3000 the viewer shows: narrow it with paths .*Nothing was shown\.$/);
		await assert.rejects(f.call(f.ctx(r.main), { scope: "dirty", paths: ["big"] }), /3001 files changed within the paths given, more than the 3000/);
		const narrowed = await f.call(f.ctx(r.main), { scope: "dirty", paths: ["a.txt"] });
		assert.match(narrowed.content[0].text, /1 changed file:\n {2}a\.txt\n/);
	} finally {
		r.done();
	}
});
