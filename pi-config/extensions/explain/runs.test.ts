/**
 * Offline tests for /explain's run lifecycle around its background fork: the interrupted-run
 * reconcile, the per-run session copy, and the prompt's tool names. The fork itself (mirror, gate,
 * copy, cache identity) is tested in `../subagents/fork/`. Run with `node tests/run.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExplainRuns, FORK_DIR, type ExplainHost } from "./explain.ts";
import { EXPLAIN_ENTRY_TYPE, INTERRUPTED_NO_PAGE, INTERRUPTED_WITH_PAGE, runningEntryData, storeDir, writeMeta, type ExplainEntryData, type KnownMeta } from "./store.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "explain-runs-"));
}

function harness(env: NodeJS.ProcessEnv) {
	const entries: ExplainEntryData[] = [];
	const started: { spec: any; settle: (r: any) => void }[] = [];
	const host: ExplainHost = {
		env,
		now: () => Date.parse("2026-09-28T10:00:00.000Z"),
		appendEntry: (data) => entries.push(data),
		notify: () => {},
		wake: () => {},
		start: (spec, handlers) => {
			started.push({ spec, settle: handlers.onSettled });
			return { stop: async () => {} };
		},
	};
	return { runs: new ExplainRuns(host), entries, started };
}

const known = (id: string): KnownMeta => ({ id, topic: `topic ${id}`, parentSessionId: "sess-1", cwd: "/repo", createdAt: "2026-09-28T09:00:00.000Z", model: "zai/glm-5.3" });

test("reconcile settles leftover running entries as interrupted: linked when the page is there, not otherwise", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const { runs, entries } = harness(env);
		// "paged": the child finished its page right before the kill. "blank": it never wrote one.
		const paged = storeDir("paged-1", env);
		mkdirSync(paged, { recursive: true });
		writeFileSync(join(paged, "index.html"), "<!doctype html><h1>t</h1><p>Explained by x</p>");
		writeMeta(paged, { ...known("paged-1"), summary: "What the page says." });
		mkdirSync(storeDir("blank-1", env), { recursive: true });
		const branch: ExplainEntryData[] = [
			runningEntryData(known("paged-1")),
			runningEntryData(known("blank-1")),
			runningEntryData(known("done-1")),
			{ ...runningEntryData(known("done-1")), status: undefined, summary: "finished" },
			runningEntryData(known("gone-1")),
		];
		assert.equal(runs.reconcile(branch), 3);
		assert.deepEqual(entries.map((e) => [e.id, e.status, e.note ?? null, e.error ?? null]), [
			["paged-1", "interrupted", INTERRUPTED_WITH_PAGE, null],
			["blank-1", "interrupted", null, INTERRUPTED_NO_PAGE],
			["gone-1", "interrupted", null, INTERRUPTED_NO_PAGE],
		]);
		assert.equal(entries[0]!.summary, "What the page says.", "the store's summary, for the card");
		assert.equal(runs.reconcile([...branch, ...entries]), 0, "settled entries stay settled");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile leaves a run this process is still running alone", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const { runs, entries } = harness(env);
		runs.begin({ topic: "live one", cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		const running = entries[0]!;
		assert.equal(running.status, "running");
		assert.equal(runs.reconcile([running]), 0);
		assert.equal(entries.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a forked run's session copy is deleted when it settles and when it is stopped", async () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const parent = join(root, "parent.jsonl");
		writeFileSync(parent, '{"type":"session"}\n{"type":"message","message":{"role":"user"}}\n');
		const { runs, started } = harness(env);
		runs.begin({ topic: "a", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: parent, model: "m" });
		runs.begin({ topic: "b", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: parent, model: "m" });
		const [a, b] = started.map((s) => s.spec.forkSession as string);
		assert.ok(a!.startsWith(join(root, "explanations", FORK_DIR)) && readFileSync(a!, "utf8").length > 0);
		started[0]!.settle({ outcome: "error", error: "x", finalOutput: "" });
		assert.throws(() => readFileSync(a!), /ENOENT/);
		await runs.stopAll();
		assert.throws(() => readFileSync(b!), /ENOENT/);
		assert.equal(EXPLAIN_ENTRY_TYPE, "explain-doc");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the prompt names the search tools the child actually has", async () => {
	const { searchTools } = await import("./prompt.ts");
	assert.equal(searchTools({ forked: false }), "read/grep/find/ls", "unforked: the child's own tools");
	assert.equal(searchTools({ forked: true, parentTools: ["read", "grep", "find", "ls", "bash"] }), "read/grep/find/ls");
	const shell = searchTools({ forked: true, parentTools: ["read", "bash", "edit", "write", "agent_spawn"] });
	assert.ok(shell.startsWith("read, and `bash` for ONE read-only command line"), shell);
	assert.equal(searchTools({ forked: true, parentTools: ["read", "write"] }), "read");
});
