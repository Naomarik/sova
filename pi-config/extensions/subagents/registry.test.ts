import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSubagents } from "./index.ts";
import { WORKER_MANIFEST_ENTRY_TYPE, WorkerRegistryRecorder } from "./registry.ts";
import { MANIFEST_TASK_CHARS, readWorkerManifests, type WorkerManifestRecord } from "./worker-transcript.ts";

const worker = (over: Record<string, unknown> = {}): any => ({
	id: "ag_01", groupId: "run_01", name: "w", backend: "claude-code", task: "do it", cwd: "/tmp", wake: true,
	model: "sonnet", status: "running", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	isFinished() { return ["done", "error", "killed"].includes(this.status); },
	isSettled() { return this.isFinished() || this.status === "waiting"; },
	...over,
});
const asEntries = (appended: { customType: string; data: unknown }[]) =>
	appended.map(({ customType, data }) => ({ type: "custom", customType, data }));

test("recorder: publication, identity on arrival only, task starts and settles, one final record", () => {
	const appended: { customType: string; data: WorkerManifestRecord }[] = [];
	const recorder = new WorkerRegistryRecorder((customType, data) => appended.push({ customType, data }));
	const w = worker({ task: "x".repeat(MANIFEST_TASK_CHARS + 10) });
	recorder.track(w, { teamId: "team_01", role: "reviewer" }, { backend: "claude-code", systemPrompt: "be terse", tools: ["Read"] });
	recorder.track(w); // idempotent
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, WORKER_MANIFEST_ENTRY_TYPE);
	const first = appended[0].data;
	assert.equal(first.v, 1); assert.equal(first.kind, "worker-manifest");
	assert.equal(first.ref, undefined);
	assert.equal(first.status, "running");
	assert.deepEqual(first.spec, { cwd: "/tmp", model: "sonnet", tools: ["Read"], taskPreview: "x".repeat(MANIFEST_TASK_CHARS), taskChars: MANIFEST_TASK_CHARS + 10, wake: true });
	assert.deepEqual(first.team, { teamId: "team_01", role: "reviewer" });
	assert.deepEqual(first.launch, { backend: "claude-code", systemPrompt: "be terse", tools: ["Read"] });
	// Nothing changed: no record.
	recorder.observe(w);
	assert.equal(appended.length, 1);
	// The id arrives later: exactly one fresh record carrying only the ref.
	w.sessionId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
	recorder.observe(w); recorder.observe(w);
	assert.equal(appended.length, 2);
	assert.deepEqual(Object.keys(appended[1].data).sort(), ["at", "backend", "kind", "ref", "v", "workerId"]);
	assert.deepEqual(appended[1].data.ref, { v: 1, backend: "claude-code", kind: "claude-session-id", locator: w.sessionId, cwd: "/tmp" });
	// A settle: status waiting, outcome, time and a usage snapshot (the lifetime numbers).
	Object.assign(w, { status: "waiting", taskOutcome: "success", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1 } });
	recorder.settled(w);
	const settle = appended[2].data;
	assert.equal(settle.status, "waiting"); assert.equal(settle.taskOutcome, "success"); assert.equal(typeof settle.settledAt, "number");
	assert.deepEqual({ ...settle.usageSnapshot, asOf: 0 }, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1, byModel: [], source: "snapshot", asOf: 0 });
	// A steer starts a new task: one "running" record, then nothing while it runs.
	w.status = "running";
	recorder.observe(w); recorder.observe(w);
	assert.equal(appended.length, 4);
	assert.equal(appended[3].data.status, "running");
	// End: final status record exactly once, and nothing after it.
	Object.assign(w, { status: "done", endedAt: 42 });
	recorder.finish(w); recorder.finish(w);
	w.sessionId = "other";
	recorder.observe(w); recorder.settled(w);
	assert.equal(appended.length, 5);
	assert.equal(appended[4].data.status, "done"); assert.equal(appended[4].data.endedAt, 42); assert.equal(appended[4].data.taskOutcome, "success");
	// Read back through the one canonical fold: newest value per field; the spec survives.
	const read = readWorkerManifests(asEntries(appended)).manifests.get("ag_01")!;
	assert.equal(read.ref?.locator, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
	assert.equal(read.status, "done"); assert.equal(read.team?.role, "reviewer"); assert.equal(read.spec?.model, "sonnet");
	assert.equal(read.usageSnapshot?.input, 10);
});

test("recorder: a resume record clears the ending in the fold; usage comes from the injected lifetime view", () => {
	const appended: any[] = [];
	const base = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1, turns: 3 };
	const recorder = new WorkerRegistryRecorder((customType, data) => appended.push({ customType, data }), (w) => ({
		input: base.input + w.usage.input, output: base.output + w.usage.output, cacheRead: 0, cacheWrite: 0, cost: base.cost + w.usage.cost, turns: base.turns + w.usage.turns,
	}));
	const w = worker({ backend: "pi", sessionFile: "/s/w.jsonl" });
	recorder.track(w);
	Object.assign(w, { status: "killed", taskOutcome: "aborted", error: "stopped", endedAt: 5 });
	recorder.finish(w);
	const resumed = worker({ backend: "pi", sessionFile: "/s/w.jsonl", status: "waiting" });
	recorder.resumed(resumed);
	Object.assign(resumed, { taskOutcome: "success", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1 } });
	recorder.settled(resumed);
	const read = readWorkerManifests(asEntries(appended)).manifests.get("ag_01")!;
	assert.equal(read.status, "waiting");
	assert.equal(read.endedAt, undefined); assert.equal(read.error, undefined);
	assert.equal(read.taskOutcome, "success");
	assert.equal(typeof read.resumedAt, "number");
	assert.deepEqual([read.usageSnapshot?.input, read.usageSnapshot?.cost, read.usageSnapshot?.turns], [101, 1.25, 4]);
	assert.equal(read.ref?.kind, "pi-session-file");
});

test("recorder: lost/killed statuses; untracked workers write nothing; a throwing append never escapes", () => {
	const appended: any[] = [];
	const recorder = new WorkerRegistryRecorder((customType, data) => appended.push({ customType, data }));
	const a = worker({ id: "ag_02", sessionId: "early", backend: undefined });
	recorder.track(a);
	assert.equal(appended[0].data.backend, "pi");
	recorder.finish(a, "lost");
	assert.equal(appended.at(-1).data.status, "lost");
	const b = worker({ id: "ag_03", status: "killed" });
	recorder.finish(b); recorder.settled(b); // untracked: nothing
	assert.equal(appended.length, 2);
	recorder.track(b); recorder.finish(b);
	assert.equal(appended.at(-1).data.status, "killed");
	const broken = new WorkerRegistryRecorder(() => { throw new Error("stale ctx"); });
	assert.doesNotThrow(() => broken.track(worker()));
});

// ── manager wiring ──────────────────────────────────────────────────────────

/** hosted: PI_WORKER_TRANSPORT=host equivalent with a private registry root (the fake runners ignore spawnImpl, so no host starts). */
function harness(hosted = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-registry-test-"));
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const appended: any[] = [];
	const workers: any[] = [];
	const ctx: any = {
		cwd: path.resolve(fileURLToPath(new URL("../../", import.meta.url))), mode: "tui", hasUI: true, thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getSessionId: () => "owner-1", getSessionFile: () => path.join(root, "owner.jsonl") },
		modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	registerSubagents({
		events: { on: () => () => {}, emit() {} },
		registerTool: (t: any) => tools.set(t.name, t),
		on: (e: string, f: any) => events.set(e, f),
		registerCommand() {}, registerShortcut() {},
		appendEntry: (customType: unknown, data: unknown) => appended.push({ customType, data }),
		getActiveTools: () => ["read"],
		sendMessage() {},
	} as any, (options: any, handlers) => {
		const w: any = {
			...options, wake: options.wake ?? true, extensions: [], forked: false, status: "running", transcript: [],
			usage: { input: 0, output: 0, turns: 0 }, steerCount: 0, whenClosed: Promise.resolve(),
			isFinished() { return ["killed", "done", "error"].includes(this.status); },
			isSettled() { return this.isFinished() || this.status === "waiting"; },
			finalOutput: () => "",
			async kill() { this.status = "killed"; }, async dispose() { this.status = "killed"; },
			change() { handlers.onChange(); },
			exit() { this.status = "done"; this.processAlive = false; this.endedAt = 7; handlers.onExit(this); },
		};
		workers.push(w);
		return w;
	}, { hosting: { root, enabled: hosted }, agentDir: path.join(root, "agent") });
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, () => {}, ctx);
	return {
		appended, workers, call, root, start: () => events.get("session_start")({}, ctx),
		close: async () => { await events.get("session_shutdown")({}, ctx); fs.rmSync(root, { recursive: true, force: true }); },
	};
}

test("manager appends a registry record per published worker, identity updates, and a final record at exit", async () => {
	const h = harness();
	h.start();
	await h.call("agent_spawn", { prompt: "task one", name: "one", count: 2 });
	const records = () => h.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data);
	// Publication follows the ID reservation entry, one record per worker.
	assert.equal(h.appended[0].customType, "subagents-counters-v2");
	assert.deepEqual(records().map((r) => [r.workerId, r.name, r.groupId]), [["ag_01", "one-1", "run_01"], ["ag_02", "one-2", "run_01"]]);
	// The identity arrives: refresh (throttled) writes one record for that worker only.
	h.workers[0].sessionId = "pi-sess"; h.workers[0].sessionFile = "/s/pi.jsonl";
	h.workers[0].change();
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(records().length, 3);
	assert.deepEqual([records()[2].workerId, records()[2].ref?.locator, records()[2].ref?.sessionId], ["ag_01", "/s/pi.jsonl", "pi-sess"]);
	h.workers[0].exit();
	assert.equal(records().length, 4);
	assert.deepEqual([records()[3].workerId, records()[3].status, records()[3].endedAt], ["ag_01", "done", 7]);
	await h.close();
});

test("manager: team members carry teamId and role in their registry spec", async () => {
	const h = harness();
	h.start();
	await h.call("team_create", { name: "alpha", objective: "ship", members: [{ role: "lead", prompt: "lead it" }, { role: "dev", prompt: "build it" }] });
	const teams = h.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data.team);
	assert.deepEqual(teams.map((t: any) => [t.teamId, t.role]), [["team_01", "lead"], ["team_01", "dev"]]);
	await h.close();
});

test("inline transport: the durable record is written all the same, but no registry directory and no host", async () => {
	const h = harness(false);
	h.start();
	await h.call("agent_spawn", { prompt: "task one", name: "one" });
	h.workers[0].sessionId = "pi-sess";
	h.workers[0].change();
	await new Promise((r) => setTimeout(r, 150));
	h.workers[0].exit();
	assert.deepEqual(h.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data.status), ["running", "done"], "a pi session id alone is no transcript ref yet");
	assert.equal(h.workers[0].spawnImpl, undefined);
	assert.equal(h.workers[0].adopt, undefined);
	assert.deepEqual(fs.readdirSync(h.root), []);
	await h.close();
});
