import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSubagents } from "./index.ts";
import {
	REGISTRY_TASK_CHARS,
	WORKER_REGISTRY_ENTRY_TYPE,
	WorkerRegistryRecorder,
	readWorkerRegistry,
	type WorkerRegistryRecord,
} from "./registry.ts";

const worker = (over: Record<string, unknown> = {}): any => ({
	id: "ag_01", groupId: "run_01", name: "w", backend: "claude-code", task: "do it", cwd: "/tmp", wake: true,
	model: "sonnet", status: "running", ...over,
});
const asEntries = (appended: { customType: string; data: unknown }[]) =>
	appended.map(({ customType, data }) => ({ type: "custom", customType, data }));

test("recorder: publish record, identity on arrival only, one final record", () => {
	const appended: { customType: string; data: WorkerRegistryRecord }[] = [];
	const recorder = new WorkerRegistryRecorder((customType, data) => appended.push({ customType, data }));
	const w = worker({ task: "x".repeat(REGISTRY_TASK_CHARS + 10) });
	recorder.track(w, { teamId: "team_01", role: "reviewer" });
	recorder.track(w); // idempotent
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, WORKER_REGISTRY_ENTRY_TYPE);
	const first = appended[0].data;
	assert.equal(first.v, 1); assert.equal(first.kind, "worker-registry");
	assert.equal(first.backendSessionId, undefined);
	assert.deepEqual(first.spec, { name: "w", model: "sonnet", cwd: "/tmp", task: "x".repeat(REGISTRY_TASK_CHARS), taskChars: REGISTRY_TASK_CHARS + 10, teamId: "team_01", role: "reviewer", wake: true });
	// Nothing changed: no record. An empty identity never writes.
	recorder.observe(w);
	assert.equal(appended.length, 1);
	// The id arrives later: exactly one fresh record, no spec repeated.
	w.sessionId = "sess-1";
	recorder.observe(w); recorder.observe(w);
	assert.equal(appended.length, 2);
	assert.deepEqual({ ...appended[1].data, at: 0 }, { v: 1, kind: "worker-registry", at: 0, workerId: "ag_01", backend: "claude-code", backendSessionId: "sess-1" });
	// A session file arriving after the id is a changed identity.
	w.sessionFile = "/s/w.jsonl";
	recorder.observe(w);
	assert.equal(appended.length, 3);
	assert.equal(appended[2].data.backendSessionFile, "/s/w.jsonl");
	// Settle: final status record exactly once, and nothing after it.
	Object.assign(w, { status: "done", taskOutcome: "success", endedAt: 42 });
	recorder.finish(w); recorder.finish(w);
	w.sessionId = "sess-2";
	recorder.observe(w);
	assert.equal(appended.length, 4);
	assert.equal(appended[3].data.status, "done"); assert.equal(appended[3].data.endedAt, 42); assert.equal(appended[3].data.taskOutcome, "success");
	// Read back: newest value per field wins; the spec from the first record survives.
	const read = readWorkerRegistry(asEntries(appended)).get("ag_01")!;
	assert.equal(read.backendSessionId, "sess-1"); assert.equal(read.backendSessionFile, "/s/w.jsonl");
	assert.equal(read.status, "done"); assert.equal(read.spec?.role, "reviewer");
});

test("recorder: identity already known at publication is in the first record; lost/killed statuses", () => {
	const appended: any[] = [];
	const recorder = new WorkerRegistryRecorder((customType, data) => appended.push({ customType, data }));
	const a = worker({ id: "ag_02", sessionId: "early", backend: undefined });
	recorder.track(a);
	assert.equal(appended[0].data.backendSessionId, "early"); assert.equal(appended[0].data.backend, "pi");
	recorder.finish(a, "lost");
	assert.equal(appended.at(-1).data.status, "lost");
	const b = worker({ id: "ag_03", status: "killed" });
	recorder.finish(b); // untracked: nothing
	recorder.track(b); recorder.finish(b);
	assert.equal(appended.at(-1).data.status, "killed");
	// A throwing append (replaced session) never escapes.
	const broken = new WorkerRegistryRecorder(() => { throw new Error("stale ctx"); });
	assert.doesNotThrow(() => broken.track(worker()));
});

test("readWorkerRegistry ignores foreign and malformed entries and keeps order per worker", () => {
	const entries = [
		{ type: "custom", customType: "other", data: { v: 1, kind: "worker-registry", workerId: "ag_01", backend: "pi" } },
		{ type: "custom", customType: WORKER_REGISTRY_ENTRY_TYPE, data: { v: 2, kind: "worker-registry", workerId: "ag_01", backend: "pi" } },
		{ type: "custom", customType: WORKER_REGISTRY_ENTRY_TYPE, data: { v: 1, kind: "worker-registry", workerId: "", backend: "pi" } },
		{ type: "message", customType: WORKER_REGISTRY_ENTRY_TYPE, data: { v: 1, kind: "worker-registry", workerId: "ag_01", backend: "pi" } },
		{ type: "custom", customType: WORKER_REGISTRY_ENTRY_TYPE, data: { v: 1, kind: "worker-registry", workerId: "ag_05", backend: "pi", at: 1, backendSessionId: "a" } },
		{ type: "custom", customType: WORKER_REGISTRY_ENTRY_TYPE, data: { v: 1, kind: "worker-registry", workerId: "ag_05", backend: "pi", at: 2, backendSessionId: "b" } },
		null,
	];
	const read = readWorkerRegistry(entries);
	assert.deepEqual([...read.keys()], ["ag_05"]);
	assert.equal(read.get("ag_05")!.backendSessionId, "b");
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
	}, { hosting: { root, enabled: hosted } });
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
	const records = () => h.appended.filter((e) => e.customType === WORKER_REGISTRY_ENTRY_TYPE).map((e) => e.data);
	// Publication follows the ID reservation entry, one record per worker.
	assert.equal(h.appended[0].customType, "subagents-counters-v2");
	assert.deepEqual(records().map((r) => [r.workerId, r.spec?.name, r.groupId]), [["ag_01", "one-1", "run_01"], ["ag_02", "one-2", "run_01"]]);
	// The identity arrives: refresh (throttled) writes one record for that worker only.
	h.workers[0].sessionId = "pi-sess"; h.workers[0].sessionFile = "/s/pi.jsonl";
	h.workers[0].change();
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(records().length, 3);
	assert.deepEqual([records()[2].workerId, records()[2].backendSessionId, records()[2].backendSessionFile], ["ag_01", "pi-sess", "/s/pi.jsonl"]);
	h.workers[0].exit();
	assert.equal(records().length, 4);
	assert.deepEqual([records()[3].workerId, records()[3].status, records()[3].endedAt], ["ag_01", "done", 7]);
	await h.close();
});

test("manager: team members carry teamId and role in their registry spec", async () => {
	const h = harness();
	h.start();
	await h.call("team_create", { name: "alpha", objective: "ship", members: [{ role: "lead", prompt: "lead it" }, { role: "dev", prompt: "build it" }] });
	const specs = h.appended.filter((e) => e.customType === WORKER_REGISTRY_ENTRY_TYPE).map((e) => e.data.spec);
	assert.deepEqual(specs.map((s: any) => [s.teamId, s.role]), [["team_01", "lead"], ["team_01", "dev"]]);
	await h.close();
});

test("inline transport: no registry records and no registry directory", async () => {
	const h = harness(false);
	h.start();
	await h.call("agent_spawn", { prompt: "task one", name: "one" });
	h.workers[0].sessionId = "pi-sess";
	h.workers[0].change();
	await new Promise((r) => setTimeout(r, 150));
	h.workers[0].exit();
	assert.deepEqual(h.appended.filter((e) => e.customType === WORKER_REGISTRY_ENTRY_TYPE), []);
	assert.equal(h.workers[0].spawnImpl, undefined);
	assert.equal(h.workers[0].adopt, undefined);
	assert.deepEqual(fs.readdirSync(h.root), []);
	await h.close();
});
