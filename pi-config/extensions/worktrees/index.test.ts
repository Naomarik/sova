// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import worktrees from "./index.ts";
import { restoreActive, WORKTREE_MERGE_MESSAGE, WORKTREES_ENTRY_TYPE, WORKTREES_STATE_EVENT } from "./state.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrees-ext-")));
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

/** Just enough of ExtensionAPI: handlers, the bus, the tool, entries and messages. */
function fakePi(sessionId = "s1") {
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const bus = new Map<string, ((d: unknown) => void)[]>();
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const messages: { customType: string; content: unknown; details: unknown; options: unknown }[] = [];
	const events: unknown[] = [];
	let tool: any;
	let confirmAnswer = true;
	const confirms: string[] = [];
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: {
			on: (name: string, fn: any) => bus.set(name, [...(bus.get(name) ?? []), fn]),
			emit: (name: string, data: unknown) => {
				if (name === WORKTREES_STATE_EVENT) events.push(data);
				for (const fn of bus.get(name) ?? []) fn(data);
			},
		},
		registerTool: (t: any) => (tool = t),
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (m: any, options: unknown) => messages.push({ ...m, options }),
	};
	const ctx = (cwd: string, hasUI = true): any => ({
		cwd,
		hasUI,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: { confirm: async (title: string) => (confirms.push(title), confirmAnswer) },
	});
	const fire = async (name: string, c: unknown) => {
		for (const fn of handlers.get(name) ?? []) await fn({ type: name }, c);
	};
	const call = (c: unknown, params: Record<string, unknown>) => tool.execute("t1", params, undefined, undefined, c);
	return { pi, ctx, fire, call, entries, messages, events, confirms, setConfirm: (v: boolean) => (confirmAnswer = v), emit: pi.events.emit };
}

test("create, attach, detach record whole snapshots; the bus hears the active set", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "a" });
		const a = join(r.root, ".worktrees", "repo-a");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/b", join(r.root, "other-b"));
		const b = join(r.root, "other-b");
		await f.call(c, { action: "attach", path: b });
		assert.deepEqual(restoreActive(f.entries)?.trees.map((t) => [t.path, t.status, t.how, t.session]), [
			[a, "active", "created", "s1"],
			[b, "active", "attached", "s1"],
		]);
		assert.deepEqual((f.events.at(-1) as { active: string[] }).active, [a, b]);
		const out = await f.call(c, { action: "detach", path: "feat/a" });
		assert.match(out.content[0].text, /Detached .*repo-a; nothing on disk was touched/);
		assert.deepEqual(Object.fromEntries(restoreActive(f.entries)!.trees.map((t) => [t.path, t.status])), { [a]: "dropped", [b]: "active" });
		assert.deepEqual((f.events.at(-1) as { active: string[] }).active, [b]);
		// A subdirectory is refused; nothing is appended.
		const n = f.entries.length;
		mkdirSync(join(b, "sub"));
		await assert.rejects(f.call(c, { action: "attach", path: join(b, "sub") }), /inside the worktree/);
		assert.equal(f.entries.length, n);
		// A fork (another session id reading the same entries) sees them as shared.
		const g = fakePi("s2");
		worktrees(g.pi);
		g.entries.push(...f.entries);
		await g.fire("session_start", g.ctx(r.main));
		const listed = await g.call(g.ctx(r.main), { action: "list" });
		assert.match(listed.content[0].text, /shared with session s1/);
	} finally {
		r.done();
	}
});

test("with the sandbox on, create and attach ask first; declined or unanswerable changes nothing", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		await f.fire("session_start", f.ctx(r.main));
		f.emit("sandbox:state", { version: 1, on: true });
		f.setConfirm(false);
		await assert.rejects(f.call(f.ctx(r.main), { action: "create", name: "no" }), /declined/);
		await assert.rejects(f.call(f.ctx(r.main, false), { action: "create", name: "no" }), /no one to ask/);
		assert.equal(f.entries.length, 0);
		assert.equal(sh(r.main, "branch", "--list", "feat/no"), "");
		f.setConfirm(true);
		await f.call(f.ctx(r.main), { action: "create", name: "yes" });
		assert.deepEqual(f.confirms, ["Create a worktree?", "Create a worktree?"]);
		assert.equal(restoreActive(f.entries)?.trees.length, 1);
		// Off: no question.
		f.emit("sandbox:state", { version: 1, on: false });
		await f.call(f.ctx(r.main), { action: "create", name: "free" });
		assert.equal(f.confirms.length, 2);
	} finally {
		r.done();
	}
});

test("worktree merge records the merge and sends the card; a plain-git merge in a turn is detected after it", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "tool" });
		await f.call(c, { action: "create", name: "plain" });
		const t = join(r.root, ".worktrees", "repo-tool");
		const p = join(r.root, ".worktrees", "repo-plain");
		writeFileSync(join(t, "t.txt"), "t\n");
		sh(t, "add", "t.txt");
		sh(t, "commit", "-q", "-m", "t");
		const out = await f.call(c, { action: "merge", path: t });
		assert.match(out.content[0].text, /^Merged feat\/tool into master at [0-9a-f]{7}, 1 commit, \+1 −0 \(fast-forward\)/);
		assert.equal(f.messages.length, 1);
		assert.equal(f.messages[0]!.customType, WORKTREE_MERGE_MESSAGE);
		assert.deepEqual(f.messages[0]!.options, { triggerTurn: false });
		assert.equal((f.messages[0]!.details as { how: string }).how, "tool");
		const merged = restoreActive(f.entries)!.trees.find((x) => x.path === t)!;
		assert.equal(merged.status, "merged");
		assert.equal(merged.merge?.sha, sh(r.main, "rev-parse", "master"));

		// A turn: the agent commits on feat/plain and merges it with plain git.
		await f.fire("agent_start", c);
		writeFileSync(join(p, "p.txt"), "p\nq\n");
		sh(p, "add", "p.txt");
		sh(p, "commit", "-q", "-m", "p");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "feat/plain");
		await f.fire("agent_settled", c);
		assert.equal(f.messages.length, 2);
		const d = f.messages[1]!.details as Record<string, unknown>;
		assert.deepEqual([d.branch, d.target, d.commits, d.added, d.removed, d.fastForward, d.how], ["feat/plain", "master", 1, 2, 0, false, "detected"]);
		assert.equal(f.messages[1]!.content, `Merged feat/plain into master at ${sh(r.main, "rev-parse", "--short=7", "master")}, 1 commit, +2 −0`);
		assert.equal(restoreActive(f.entries)!.trees.find((x) => x.path === p)!.merge?.how, "detected");
		// A turn that merges nothing records nothing.
		await f.fire("agent_start", c);
		await f.fire("agent_settled", c);
		assert.equal(f.messages.length, 2);
	} finally {
		r.done();
	}
});

test("branches merged into an integration branch that the tool then merges each get their own detected card", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		for (const name of ["a", "b", "i"]) await f.call(c, { action: "create", name });
		const [a, b, i] = ["a", "b", "i"].map((n) => join(r.root, ".worktrees", `repo-${n}`)) as [string, string, string];
		const before = sh(r.main, "rev-parse", "master");
		await f.fire("agent_start", c);
		writeFileSync(join(a, "a2.txt"), "a\n");
		sh(a, "add", "a2.txt");
		sh(a, "commit", "-q", "-m", "a");
		writeFileSync(join(b, "b.txt"), "b\nb\nb\n");
		sh(b, "add", "b.txt");
		sh(b, "commit", "-q", "-m", "b");
		sh(i, "merge", "-q", "--no-edit", "--no-ff", "feat/a");
		const ma = sh(i, "rev-parse", "HEAD");
		sh(i, "merge", "-q", "--no-edit", "--no-ff", "feat/b");
		const mb = sh(i, "rev-parse", "HEAD");
		await f.call(c, { action: "merge", path: i });
		await f.fire("agent_settled", c);
		const cards = f.messages.map((m) => m.details as Record<string, unknown>);
		assert.deepEqual(
			cards.map((d) => [d.branch, d.sha, d.commits, d.added, d.removed, d.fastForward, d.how]),
			[
				["feat/i", mb, 4, 4, 0, true, "tool"],
				["feat/a", ma, 1, 1, 0, false, "detected"],
				["feat/b", mb, 1, 3, 0, false, "detected"],
			],
		);
		assert.equal(sh(r.main, "rev-parse", "master"), mb);
		assert.notEqual(before, mb);
		// The pane's record and the model's line name the same commit as the card.
		const trees = restoreActive(f.entries)!.trees;
		assert.equal(trees.find((x) => x.path === a)!.merge?.sha, ma);
		assert.equal(trees.find((x) => x.path === b)!.merge?.sha, mb);
		assert.equal(f.messages[1]!.content, `Merged feat/a into master at ${ma.slice(0, 7)}, 1 commit, +1 −0`);
	} finally {
		r.done();
	}
});

test("a merge made outside this session's turns gets no card", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi);
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "x" });
		const x = join(r.root, ".worktrees", "repo-x");
		writeFileSync(join(x, "x.txt"), "x\n");
		sh(x, "add", "x.txt");
		sh(x, "commit", "-q", "-m", "x");
		// Merged by someone else between turns: the next turn starts with it already merged.
		sh(r.main, "merge", "-q", "--no-edit", "feat/x");
		await f.fire("agent_start", c);
		await f.fire("agent_settled", c);
		assert.equal(f.messages.length, 0);
		assert.equal(restoreActive(f.entries)!.trees[0]!.status, "active");
	} finally {
		r.done();
	}
});

test("in a spec project the warnings are said once: a tool merge's answer (its card is the merge line), a detected merge's message", async () => {
	const r = repo();
	try {
		const seen: unknown[] = [];
		const calls: unknown[] = [];
		const f = fakePi();
		f.pi.events.on("worktrees:merged", (d: unknown) => seen.push(d));
		const draft = { text: "draft d has 1 unpromoted record (§a/b): promote what shipped", key: "d§a/b" };
		let warnings = [draft, { text: "1 changed file no claim maps (x.txt): spec any whose change a user sees" }];
		worktrees(f.pi, { specReport: async (_git, req) => (calls.push(req), { warnings }) });
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "s" });
		await f.call(c, { action: "create", name: "p" });
		const t = join(r.root, ".worktrees", "repo-s");
		const p = join(r.root, ".worktrees", "repo-p");
		const before = sh(r.main, "rev-parse", "master");
		writeFileSync(join(t, "s.txt"), "s\n");
		sh(t, "add", "s.txt");
		sh(t, "commit", "-q", "-m", "s");
		const out = await f.call(c, { action: "merge", path: t });
		const tip = sh(r.main, "rev-parse", "master");
		assert.deepEqual(calls, [{ path: t, branch: "feat/s", before, after: tip, branchSha: tip, onDefault: true }], "into master, the default branch (q14)");
		assert.match(out.content[0].text, /\(fast-forward\)\.\nSpec warning: draft d has 1 unpromoted record \(§a\/b\): promote what shipped\nSpec warning: 1 changed file no claim maps \(x\.txt\): spec any whose change a user sees\n/);
		assert.doesNotMatch(out.content[0].text, /Foreign §|last line|Plumbing|Deferred/);
		assert.equal(f.messages[0]!.content, `Merged feat/s into master at ${tip.slice(0, 7)}, 1 commit, +1 −0`, "the card's message is the merge line alone");
		assert.deepEqual(Object.keys(f.messages[0]!.details as object).sort(), ["added", "branch", "commits", "fastForward", "how", "path", "removed", "sha", "target", "version"], "the card's details are unchanged");

		// A merge seen after a turn: its message carries the warnings, the draft already said left out.
		await f.fire("agent_start", c);
		writeFileSync(join(p, "p.txt"), "p\n");
		sh(p, "add", "p.txt");
		sh(p, "commit", "-q", "-m", "p");
		sh(r.main, "merge", "-q", "--no-edit", "--no-ff", "feat/p");
		await f.fire("agent_settled", c);
		assert.equal(f.messages.length, 2);
		assert.equal(f.messages[1]!.content, `Merged feat/p into master at ${sh(r.main, "rev-parse", "--short=7", "master")}, 1 commit, +1 −0\nSpec warning: 1 changed file no claim maps (x.txt): spec any whose change a user sees`);

		// Its pending § changed: said again.
		warnings = [{ ...draft, key: "d§a/b,§a/c" }];
		await f.call(c, { action: "create", name: "q" });
		const q = join(r.root, ".worktrees", "repo-q");
		writeFileSync(join(q, "q.txt"), "q\n");
		sh(q, "add", "q.txt");
		sh(q, "commit", "-q", "-m", "q");
		const again = await f.call(c, { action: "merge", path: q });
		assert.match(again.content[0].text, /\nSpec warning: draft d has 1 unpromoted record/);
		assert.deepEqual(seen, [], "no merge event on the bus");
	} finally {
		r.done();
	}
});
