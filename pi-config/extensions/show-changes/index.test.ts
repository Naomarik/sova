// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeShowChangesDetails, SHOW_CHANGES_TOOL } from "./details.ts";
import showChanges, { renderShowChangesResult } from "./index.ts";

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
	assert.match(t.promptSnippet, /diff viewer/);
	assert.ok(t.promptGuidelines.some((g: string) => /refuses the call otherwise/.test(g)));
	assert.ok(t.promptGuidelines.some((g: string) => /read the diff yourself/.test(g)));
	assert.doesNotMatch(t.description, /computes no diff/);
	assert.match(t.description, /checks the steps against the diff/);
	assert.ok(t.promptGuidelines.some((g: string) => /instead of pasting diffs/.test(g)));
	assert.equal(t.parameters.additionalProperties, false);
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
			steps: [{ title: "Change a", hunks: [{ path: "a.txt" }] }, { title: "Add b", buildsOn: [1], hunks: [{ path: "b.txt" }] }],
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
