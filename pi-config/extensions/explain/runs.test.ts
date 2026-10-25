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
import type { BackgroundForkHandle } from "../subagents/fork/background.ts";
import type { WorkerHost } from "../subagents/worker-host.ts";
import { ExplainRuns, FORK_DIR, type ExplainHost } from "./explain.ts";
import { EXPLAIN_ENTRY_TYPE, INTERRUPTED_NO_PAGE, INTERRUPTED_WITH_PAGE, runningEntryData, storeDir, writeMeta, type ExplainEntryData, type KnownMeta } from "./store.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "explain-runs-"));
}

/** `live`: the explain forks the worker host still runs for this session, by run id. */
function harness(env: NodeJS.ProcessEnv, live: string[] = []) {
	const entries: ExplainEntryData[] = [];
	const started: { spec: any; settle: (r: any) => void }[] = [];
	const reattached: { id: string; settle: (r: any) => void; stopped: number }[] = [];
	const wakes: string[] = [];
	const host: ExplainHost = {
		env,
		now: () => Date.parse("2026-09-28T10:00:00.000Z"),
		appendEntry: (data) => entries.push(data),
		notify: () => {},
		wake: (text) => wakes.push(text),
		workerHost: () => ({}) as WorkerHost,
		start: (spec, handlers) => {
			started.push({ spec, settle: handlers.onSettled });
			return { stop: async () => {}, detach: () => {} };
		},
		reattach: async (_host, kind, _name, handlersFor) => {
			const handles = new Map<string, BackgroundForkHandle>();
			for (const id of live) {
				const handlers = kind === "explain" ? handlersFor(id) : undefined;
				if (!handlers) continue;
				const fork = { id, settle: handlers.onSettled, stopped: 0 };
				reattached.push(fork);
				handles.set(id, { stop: async () => { fork.stopped++; }, detach: () => {} });
			}
			return handles;
		},
	};
	return { runs: new ExplainRuns(host), entries, started, reattached, wakes };
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

test("a forked run's session copy is deleted when it settles, and kept while a closed session leaves its child running", async () => {
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
		assert.equal(started[0]!.spec.sessionDir, join(root, "explanations", FORK_DIR, started[0]!.spec.id), "the fork's own session beside its copy");
		runs.detachAll();
		assert.ok(readFileSync(b!, "utf8").length > 0, "the child still runs; the next session reattaches it");
		assert.equal(EXPLAIN_ENTRY_TYPE, "explain-doc");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reattach makes a running entry whose fork the host still runs a live run again: it records its end once and is never interrupted", async () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		// "live-1" still runs in its own chat; "gone-1" has no chat any more; "done-1" settled earlier.
		const { runs, entries, reattached, wakes } = harness(env, ["live-1", "done-1", "stray-1"]);
		const branch: ExplainEntryData[] = [
			runningEntryData(known("live-1")),
			runningEntryData(known("gone-1")),
			runningEntryData(known("done-1")),
			{ ...runningEntryData(known("done-1")), status: undefined, summary: "finished" },
		];
		assert.equal(await runs.reattach(branch), 1);
		assert.deepEqual(reattached.map((r) => r.id), ["live-1"], "only a running entry claims a chat");
		assert.equal(runs.live, 1);
		assert.equal(runs.reconcile(branch), 1, "the gone run is interrupted, the reattached one is not");
		assert.deepEqual(entries.map((e) => [e.id, e.status]), [["gone-1", "interrupted"]]);

		const dir = storeDir("live-1", env);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.html"), "<!doctype html><meta name=viewport content=\"width=device-width\"><h1>t</h1><p>Explained by x</p>");
		writeMeta(dir, { ...known("live-1"), summary: "What it says." });
		reattached[0]!.settle({ outcome: "success", finalOutput: "done", model: "zai/glm-5.3" });
		assert.deepEqual(entries.map((e) => [e.id, e.status ?? "final"]), [["gone-1", "interrupted"], ["live-1", "final"]]);
		assert.equal(entries[1]!.error, undefined);
		assert.equal(wakes.length, 1, "the parent is woken once");
		assert.equal(reattached[0]!.stopped, 1, "its chat is stopped once the run is recorded");
		assert.equal(runs.live, 0);
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
