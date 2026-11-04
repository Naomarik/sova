// Run through tests/run.mjs (pi imports resolve from the installed package).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import worktrees, { queueServes } from "./index.ts";
import { restoreActive, WORKTREE_MERGE_MESSAGE, WORKTREES_ENTRY_TYPE, WORKTREES_STATE_EVENT } from "./state.ts";

// A run from inside a chat inherits these; each test says for itself which kind of chat it is.
delete process.env.SOVA_CHAT_STATE_ROOT;
delete process.env.SOVA_CHAT_SOCK;

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

test("under Sova, worktree merge into the branch others land into is refused (the merge queue lands it); into another branch it merges", async () => {
	const r = repo();
	try {
		const f = fakePi();
		worktrees(f.pi, { mergeQueue: true });
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "q" });
		const t = join(r.root, ".worktrees", "repo-q");
		writeFileSync(join(t, "q.txt"), "q\n");
		sh(t, "add", "q.txt");
		sh(t, "commit", "-q", "-m", "q");
		const before = sh(r.main, "rev-parse", "master");
		await assert.rejects(f.call(c, { action: "merge", path: t }), /master is the branch others land into: branches reach it only through Sova's merge queue/);
		await assert.rejects(f.call(c, { action: "merge", path: t, target: "master" }), /only through Sova's merge queue/);
		assert.equal(sh(r.main, "rev-parse", "master"), before);
		assert.equal(f.messages.length, 0);
		sh(r.main, "branch", "side");
		const out = await f.call(c, { action: "merge", path: t, target: "side" });
		assert.match(out.content[0].text, /^Merged feat\/q into side/);
	} finally {
		r.done();
	}
});

test("under Sova, merge into the merge queue's declared target (merge.target, not master) is refused too; with no declaration it merges", async () => {
	const r = repo();
	try {
		sh(r.main, "branch", "release");
		sh(r.main, "branch", "other");
		mkdirSync(join(r.main, ".sova"));
		writeFileSync(join(r.main, ".sova", "project.json"), JSON.stringify({ version: 1, merge: { target: "release", checks: "none" } }));
		sh(r.main, "add", ".sova/project.json");
		sh(r.main, "commit", "-q", "-m", "declare release");
		const f = fakePi();
		worktrees(f.pi, { mergeQueue: true });
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "d" });
		const t = join(r.root, ".worktrees", "repo-d");
		writeFileSync(join(t, "d.txt"), "d\n");
		sh(t, "add", "d.txt");
		sh(t, "commit", "-q", "-m", "d");
		const before = sh(r.main, "rev-parse", "release");
		await assert.rejects(f.call(c, { action: "merge", path: t, target: "release" }), /release is the branch others land into: branches reach it only through Sova's merge queue/);
		assert.equal(sh(r.main, "rev-parse", "release"), before, "nothing merged");
		const out = await f.call(c, { action: "merge", path: t, target: "other" });
		assert.match(out.content[0].text, /^Merged feat\/d into other/);
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

test("outside Sova's merge queue, merge brings a branch into master at once, with no go-ahead recorded; a retired mainMerges switch left in the repo changes nothing", async () => {
	const r = repo();
	try {
		// The retired switch, as master may still hold it: it does nothing.
		mkdirSync(join(r.main, ".sova"));
		writeFileSync(join(r.main, ".sova", "offers.json"), JSON.stringify({ version: 1, mainMerges: "go-ahead", offers: {} }));
		sh(r.main, "add", ".sova/offers.json");
		sh(r.main, "commit", "-q", "-m", "leftover switch");
		const f = fakePi();
		// A chat Sova didn't start (no SOVA_CHAT_STATE_ROOT): no merge queue.
		worktrees(f.pi, { mergeQueue: (root) => queueServes(root, {}) });
		const c = f.ctx(r.main);
		await f.fire("session_start", c);
		await f.call(c, { action: "create", name: "g" });
		const t = join(r.root, ".worktrees", "repo-g");
		writeFileSync(join(t, "g.txt"), "g\n");
		sh(t, "add", "g.txt");
		sh(t, "commit", "-q", "-m", "g");
		const head = sh(t, "rev-parse", "HEAD");
		const out = await f.call(c, { action: "merge", path: t });
		assert.match(out.content[0].text, /^Merged feat\/g into master/);
		assert.equal(sh(r.main, "rev-parse", "master"), head, "master is the branch's head");
	} finally {
		r.done();
	}
});

test("queueServes: a terminal chat merges plainly; a chat Sova started and missing its state root fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "served-"));
	try {
		assert.equal(queueServes("/repo", {}), false, "neither variable: a chat Sova didn't start");
		assert.equal(queueServes("/repo", { SOVA_CHAT_SOCK: "/s/c.sock" }), true, "Sova's socket and no state root: served, whatever the repo");
		assert.equal(queueServes("/repo", { SOVA_CHAT_STATE_ROOT: root, SOVA_CHAT_SOCK: "/s/c.sock" }), true, "no file yet: served");
		writeFileSync(join(root, "merge-served.json"), JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z", roots: [{ root: "/repo", target: "master" }] }));
		const env = { SOVA_CHAT_STATE_ROOT: root, SOVA_CHAT_SOCK: "/s/c.sock" };
		assert.equal(queueServes("/repo", env), "master");
		assert.equal(queueServes("/other", env), false, "the file's answer holds for a repo it doesn't serve");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** Runs `fn` as a chat Sova started with state root `root` (undefined: a chat Sova didn't start), restoring the env after. */
async function asChat<T>(root: string | undefined, fn: () => Promise<T>): Promise<T> {
	const was = process.env.SOVA_CHAT_STATE_ROOT;
	if (root === undefined) delete process.env.SOVA_CHAT_STATE_ROOT;
	else process.env.SOVA_CHAT_STATE_ROOT = root;
	try {
		return await fn();
	} finally {
		if (was === undefined) delete process.env.SOVA_CHAT_STATE_ROOT;
		else process.env.SOVA_CHAT_STATE_ROOT = was;
	}
}

/** The server's merge-served.json in state root `state`, serving `roots` (null: no file). */
function serve(state: string, roots: { root: string; target: string }[] | null) {
	mkdirSync(state, { recursive: true });
	const file = join(state, "merge-served.json");
	if (roots === null) rmSync(file, { force: true });
	else writeFileSync(file, JSON.stringify({ v: 1, at: "2026-11-03T12:00:00.000Z", roots }));
}

test("in a chat Sova started, worktree merge into master is a plain merge where the merge queue doesn't serve the repo, refused where it does, and refused when the served answer is missing or damaged", async () => {
	const r = repo();
	try {
		const state = join(r.root, "state");
		await asChat(state, async () => {
			const f = fakePi();
			worktrees(f.pi);
			const c = f.ctx(r.main);
			await f.fire("session_start", c);
			await f.call(c, { action: "create", name: "s" });
			const t = join(r.root, ".worktrees", "repo-s");
			writeFileSync(join(t, "s.txt"), "s\n");
			sh(t, "add", "s.txt");
			sh(t, "commit", "-q", "-m", "s");
			const head = sh(t, "rev-parse", "HEAD");
			const before = sh(r.main, "rev-parse", "master");
			// Served (the file names this repo's main checkout): refused, nothing merged.
			serve(state, [{ root: r.main, target: "master" }]);
			await assert.rejects(f.call(c, { action: "merge", path: t }), /master is the branch others land into: branches reach it only through Sova's merge queue/);
			// Fail closed: no answer, or a damaged one, reads as served.
			serve(state, null);
			await assert.rejects(f.call(c, { action: "merge", path: t }), /only through Sova's merge queue/);
			writeFileSync(join(state, "merge-served.json"), "{damaged");
			await assert.rejects(f.call(c, { action: "merge", path: t }), /only through Sova's merge queue/);
			assert.equal(sh(r.main, "rev-parse", "master"), before, "nothing merged while served");
			assert.equal(f.messages.length, 0);
			// Not served (another repo listed, read afresh at this call, no restart): a plain merge into master.
			serve(state, [{ root: join(r.root, "elsewhere"), target: "master" }]);
			const out = await f.call(c, { action: "merge", path: t });
			assert.match(out.content[0].text, /^Merged feat\/s into master/);
			assert.equal(sh(r.main, "rev-parse", "master"), head, "master is the branch's head");
			assert.equal(f.messages.length, 1, "the merge card");
			assert.equal(existsSync(join(state, "landing.json")), false, "no go-ahead recorded");
		});
	} finally {
		r.done();
	}
});

test("served under its declared target (merge-served.json's target, not master): merge into it is refused, into master it merges", async () => {
	const r = repo();
	try {
		const state = join(r.root, "state");
		sh(r.main, "branch", "release");
		await asChat(state, async () => {
			const f = fakePi();
			worktrees(f.pi);
			const c = f.ctx(r.main);
			await f.fire("session_start", c);
			await f.call(c, { action: "create", name: "t" });
			const t = join(r.root, ".worktrees", "repo-t");
			writeFileSync(join(t, "t.txt"), "t\n");
			sh(t, "add", "t.txt");
			sh(t, "commit", "-q", "-m", "t");
			serve(state, [{ root: r.main, target: "release" }]);
			await assert.rejects(f.call(c, { action: "merge", path: t, target: "release" }), /release is the branch others land into/);
		});
	} finally {
		r.done();
	}
});

test("land, where the merge queue doesn't serve the repo: the user's word is a plain merge into the main checkout's branch, drafts made official first unless they said without its specs; nothing is recorded", async () => {
	const r = repo();
	try {
		const state = join(r.root, "state");
		const docsCalls: unknown[] = [];
		await asChat(state, async () => {
			serve(state, []);
			const f = fakePi();
			worktrees(f.pi, { docs: async (_git, req) => (docsCalls.push(req), { state: "none" }) as never });
			const tree = join(r.root, "wt-u");
			sh(r.main, "worktree", "add", "-q", "-b", "feat/u", tree);
			writeFileSync(join(tree, "u.txt"), "u\n");
			sh(tree, "add", "u.txt");
			sh(tree, "commit", "-q", "-m", "u");
			const c = f.ctx(tree);
			await f.fire("session_start", c);
			const say = (text: string) => f.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } } as never);
			// Still only the user's own word.
			say("what's left before we land?");
			await assert.rejects(f.call(c, { action: "land" }), /Only the user's own word lands a branch/);
			say("land it");
			const out = await f.call(c, { action: "land" });
			assert.match(out.content[0].text, /^Merged feat\/u into master/);
			assert.match(out.content[0].text, /No merge queue serves this repo/);
			assert.doesNotMatch(out.content[0].text, /Queued/);
			assert.equal(sh(r.main, "rev-parse", "master"), sh(tree, "rev-parse", "HEAD"));
			assert.deepEqual(docsCalls, [{ path: tree, branch: "feat/u", target: "master" }], "drafts made official first");
			assert.equal(f.messages.length, 1, "the merge card");
			assert.equal(existsSync(join(state, "landing.json")), false, "no go-ahead recorded");
			// "without its specs": the drafts step is skipped.
			writeFileSync(join(tree, "v.txt"), "v\n");
			sh(tree, "add", "v.txt");
			sh(tree, "commit", "-q", "-m", "v");
			say("merge it without its specs");
			await f.call(c, { action: "land" });
			assert.equal(docsCalls.length, 1);
			assert.equal(sh(r.main, "rev-parse", "master"), sh(tree, "rev-parse", "HEAD"));
			assert.equal(existsSync(join(state, "landing.json")), false, "still no go-ahead recorded");
		});
	} finally {
		r.done();
	}
});

test("land, where the merge queue doesn't serve the repo, with the sandbox on: asks first like merge; declined or unanswerable merges nothing", async () => {
	const r = repo();
	try {
		const state = join(r.root, "state");
		await asChat(state, async () => {
			serve(state, []);
			const f = fakePi();
			worktrees(f.pi, { docs: async () => ({ state: "none" }) as never });
			const tree = join(r.root, "wt-z");
			sh(r.main, "worktree", "add", "-q", "-b", "feat/z", tree);
			writeFileSync(join(tree, "z.txt"), "z\n");
			sh(tree, "add", "z.txt");
			sh(tree, "commit", "-q", "-m", "z");
			const before = sh(r.main, "rev-parse", "master");
			await f.fire("session_start", f.ctx(tree));
			f.emit("sandbox:state", { version: 1, on: true });
			f.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "land it" }] } } as never);
			f.setConfirm(false);
			await assert.rejects(f.call(f.ctx(tree), { action: "land" }), /declined/);
			await assert.rejects(f.call(f.ctx(tree, false), { action: "land" }), /no one to ask/);
			assert.equal(sh(r.main, "rev-parse", "master"), before, "nothing merged");
			assert.equal(f.messages.length, 0);
			f.setConfirm(true);
			const out = await f.call(f.ctx(tree), { action: "land" });
			assert.match(out.content[0].text, /^Merged feat\/z into master/);
			assert.deepEqual(f.confirms, ["Merge a worktree?", "Merge a worktree?"]);
			assert.equal(existsSync(join(state, "landing.json")), false);
		});
	} finally {
		r.done();
	}
});

test("land, where the merge queue serves the repo: the go-ahead is recorded and nothing is merged", async () => {
	const r = repo();
	try {
		const state = join(r.root, "state");
		await asChat(state, async () => {
			serve(state, [{ root: r.main, target: "master" }]);
			const f = fakePi();
			worktrees(f.pi);
			const tree = join(r.root, "wt-w");
			sh(r.main, "worktree", "add", "-q", "-b", "feat/w", tree);
			writeFileSync(join(tree, "w.txt"), "w\n");
			sh(tree, "add", "w.txt");
			sh(tree, "commit", "-q", "-m", "w");
			const before = sh(r.main, "rev-parse", "master");
			const c = f.ctx(tree);
			await f.fire("session_start", c);
			f.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "land it" }] } } as never);
			const out = await f.call(c, { action: "land" });
			assert.match(out.content[0].text, /^Queued feat\/w at [0-9a-f]{7} to land/);
			assert.equal(sh(r.main, "rev-parse", "master"), before);
			assert.equal(JSON.parse(readFileSync(join(state, "landing.json"), "utf8")).goAheads.at(-1).branch, "feat/w");
		});
	} finally {
		r.done();
	}
});

test("land records the user's go-ahead typed in this chat for the branch at its head, and only then", async () => {
	const r = repo();
	try {
		const file = join(r.root, "state", "landing.json");
		const f = fakePi();
		worktrees(f.pi, { mergeQueue: true, landingFile: () => file, now: () => Date.parse("2026-10-26T10:00:00Z") });
		const tree = join(r.root, "wt-x");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/x", tree);
		writeFileSync(join(tree, "b.txt"), "two\n");
		sh(tree, "add", "b.txt");
		sh(tree, "commit", "-q", "-m", "two");
		const head = sh(tree, "rev-parse", "HEAD");
		const c = f.ctx(tree); // the session runs in the worktree: it needn't track it
		await f.fire("session_start", c);
		const say = (text: string) => f.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } } as never);
		const recorded = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).goAheads : []);
		// Not the user's word: refused, nothing recorded.
		say("Sova: feat/x is finished. Once nothing blocks it, the user can type \"land it\" here.");
		await assert.rejects(f.call(c, { action: "land" }), /Only the user's own word lands a branch/);
		say("don't merge it yet");
		await assert.rejects(f.call(c, { action: "land" }), /Only the user's own word/);
		assert.deepEqual(recorded(), []);
		// Their word, but something is uncommitted: the go-ahead is for a commit.
		say("land it");
		writeFileSync(join(tree, "c.txt"), "loose\n");
		await assert.rejects(f.call(c, { action: "land" }), /1 uncommitted file: the go-ahead is for a commit/);
		assert.deepEqual(recorded(), []);
		rmSync(join(tree, "c.txt"));
		const out = await f.call(c, { action: "land" });
		assert.match(out.content[0].text, /Queued feat\/x at [0-9a-f]{7} to land\. Sova's merge queue merges it onto the newest master in its own copy/);
		assert.doesNotMatch(out.content[0].text, /captain|landing card/i);
		assert.doesNotMatch(out.content[0].text, /press|Land It/);
		assert.deepEqual(recorded(), [{ branch: "feat/x", commit: head, session: "s1", at: "2026-10-26T10:00:00.000Z", by: "owner-chat" }]);
		// Without its specs, as the user said; by its branch name once tracked.
		await f.call(c, { action: "attach", path: tree });
		say("ok, merge it without its specs");
		await f.call(c, { action: "land", path: "feat/x" });
		assert.equal(recorded().at(-1).withoutSpecs, true);
		// "skip review": the queue lands it without its review step.
		say("land it, skip review");
		const skipped = await f.call(c, { action: "land", path: "feat/x" });
		assert.equal(recorded().at(-1).withoutReview, true);
		assert.match(skipped.content[0].text, /to land, without review\./);
		// The branch everything lands into has nothing to land.
		say("land it");
		await assert.rejects(f.call(f.ctx(r.main), { action: "land" }), /on master, which branches land into/);
	} finally {
		r.done();
	}
});

test("'open a PR/MR': on a served repo a go-ahead naming the request; unserved, nothing recorded and the chat opens it itself", async () => {
	const r = repo();
	try {
		const file = join(r.root, "state", "landing.json");
		const tree = join(r.root, "wt-pr");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/pr", tree);
		writeFileSync(join(tree, "p.txt"), "p\n");
		sh(tree, "add", "p.txt");
		sh(tree, "commit", "-q", "-m", "p");
		const recorded = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).goAheads : []);
		let served = false;
		const asked: string[] = [];
		const f = fakePi();
		worktrees(f.pi, { landingFile: () => file, mergeQueue: (root) => (asked.push(root), served ? "master" : false) });
		const c = f.ctx(tree);
		await f.fire("session_start", c);
		const say = (text: string) => f.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } } as never);
		say("open a PR");
		const unserved = await f.call(c, { action: "land" });
		assert.match(unserved.content[0].text, /doesn't serve this repo, so nothing was queued: open the request yourself, as the user asked, with gh pr create or glab mr create, whichever origin's host uses/);
		assert.deepEqual(recorded(), []);
		assert.equal(asked.length, 1);
		say("open an MR");
		assert.match((await f.call(c, { action: "land" })).content[0].text, /open the request yourself, as the user asked, with gh pr create or glab mr create/);
		served = true;
		say("open a PR");
		const queued = await f.call(c, { action: "land" });
		assert.match(queued.content[0].text, /^Queued feat\/pr at [0-9a-f]{7} to land as a request on origin's host \(a merge request on GitLab, a pull request on GitHub\)\./);
		assert.equal(recorded().at(-1).via, "github-pr");
		say("open an MR, skip review");
		assert.match((await f.call(c, { action: "land" })).content[0].text, /to land as a request on origin's host \(a merge request on GitLab, a pull request on GitHub\), without review\./);
		assert.equal(recorded().at(-1).via, "gitlab-mr");
		// Plain "land it" on the served repo records no request.
		say("land it");
		await f.call(c, { action: "land" });
		assert.equal(recorded().at(-1).via, undefined);
	} finally {
		r.done();
	}
});

test("land refuses a newest message the Overseer, a baton or another session sent, whatever it says, and never looks past it", async () => {
	const r = repo();
	try {
		const file = join(r.root, "state", "landing.json");
		const f = fakePi();
		worktrees(f.pi, { mergeQueue: true, landingFile: () => file, now: () => Date.parse("2026-10-26T10:00:00Z") });
		const tree = join(r.root, "wt-y");
		sh(r.main, "worktree", "add", "-q", "-b", "feat/y", tree);
		writeFileSync(join(tree, "b.txt"), "two\n");
		sh(tree, "add", "b.txt");
		sh(tree, "commit", "-q", "-m", "two");
		const c = f.ctx(tree);
		await f.fire("session_start", c);
		let n = 0;
		const say = (text: string) => {
			const id = `u${++n}`;
			f.entries.push({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } } as never);
			return id;
		};
		// As the server writes them: the marker after its message, then the reply after the marker.
		const mark = (customType: string, targetId: string) => f.entries.push({ type: "custom", id: `m${++n}`, customType, data: { v: 1, targetId } } as never);
		const reply = () => f.entries.push({ type: "message", id: `a${++n}`, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as never);
		const recorded = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).goAheads : []);
		// The user's own "land it" came first; the newest is another sender's: refused, and the older one isn't used.
		say("land it");
		reply();
		for (const [customType, who] of [["sova-overseer-sent", "the Overseer"], ["sova-baton-sent", "a baton participant"], ["sova-session-sent", "another session"]] as const) {
			mark(customType, say("land it"));
			reply();
			await assert.rejects(f.call(c, { action: "land" }), new RegExp(`sent by ${who}, not typed by the user.*Nothing was recorded`));
			assert.deepEqual(recorded(), []);
		}
		// A marker naming an older message doesn't touch the user's newest one.
		const older = say("please look at the build");
		reply();
		say("land it");
		mark("sova-overseer-sent", older);
		await f.call(c, { action: "land" });
		assert.equal(recorded().length, 1);
		assert.equal(recorded()[0].by, "owner-chat");
	} finally {
		r.done();
	}
});
