/**
 * Workers survive their manager: every worker's durable record (registry.ts) brings it
 * back at the next session_start as a restored entry, counted once in the lifetime Σ,
 * listed only on its branch, and resumable on demand (agent_resume / /agent-resume) idle:
 * never continued, never re-reported. Fake runners; no process, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSubagents } from "./index.ts";
import { MEMBER_ENV, awaitResponse, decodeMemberContext, requestId, writeRequest, type MailboxRequest } from "./mailbox.ts";
import { BACKEND_REGISTER_EVENT } from "./contracts.ts";
import { WORKER_MANIFEST_ENTRY_TYPE } from "./registry.ts";
import { resolvedModel } from "./worker-transcript.ts";

const SNAPSHOT = "subagents:workers-snapshot";
const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => { listeners.get(name)?.delete(handler); };
		},
		emit(name: string, data: unknown) { for (const handler of [...(listeners.get(name) ?? [])]) handler(data); },
	};
}

/** One owner session file, shared by successive managers (a restart = a new manager). */
function sessionFile() {
	const entries: any[] = [];
	let branchFilter: ((entry: any) => boolean) | undefined;
	return {
		entries,
		append(customType: string, data: unknown) { entries.push({ type: "custom", id: `e${entries.length + 1}`, customType, data }); },
		setBranch(filter?: (entry: any) => boolean) { branchFilter = filter; },
		branch() { return branchFilter ? entries.filter(branchFilter) : [...entries]; },
	};
}

interface Options { failResume?: boolean; agentDir?: string; mailboxRoot?: string }

function manager(file: ReturnType<typeof sessionFile>, options: Options = {}) {
	const bus = eventBus();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const workers: any[] = [];
	const messages: any[] = [];
	let snapshot: any;
	bus.on(SNAPSHOT, (data) => { snapshot = data; });
	const ctx: any = {
		cwd: os.tmpdir(), mode: "tui", hasUI: true, thinkingLevel: "high", isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [...file.entries], getBranch: () => file.branch(), getSessionFile: () => undefined, getSessionId: () => "owner" },
		modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	const factory = (spawn: any, handlers: any) => {
		const worker: any = {
			...spawn, wake: spawn.wake ?? true, extensions: spawn.extensions ?? [], forked: false,
			status: spawn.resume ? "starting" : "running", transcript: [], transcriptOmitted: { items: 0, approxBytes: 0 },
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }, steerCount: 0, startedAt: Date.now(), lastActivity: Date.now(),
			whenClosed: Promise.resolve(), processAlive: true,
			isFinished() { return ["killed", "done", "error"].includes(this.status); },
			isSettled() { return this.isFinished() || this.status === "waiting"; },
			finalOutput() { return this.output ?? ""; },
			async steer(message: string) { this.lastSteer = message; this.status = "running"; return { ok: true }; },
			async kill() { this.status = "killed"; this.processAlive = false; },
			async dispose() { this.status = "killed"; this.processAlive = false; },
			identify(sessionFile: string) { this.sessionFile = sessionFile; this.sessionId = path.basename(sessionFile, ".jsonl"); handlers.onChange(); },
			spend(input: number, output: number, cost: number) { this.usage.input += input; this.usage.output += output; this.usage.cost += cost; this.usage.turns++; },
			settle(outcome = "success") { this.status = "waiting"; this.taskOutcome = outcome; this.output = "answer"; handlers.onSettled(this); },
			exit(status = "done") { this.status = status; this.processAlive = false; this.endedAt = Date.now(); handlers.onExit(this); },
		};
		// A resumed worker comes up idle on its own, or fails to reopen its session.
		if (spawn.resume) setTimeout(() => {
			if (options.failResume) { worker.error = "No such session"; worker.exit("error"); }
			else { worker.status = "waiting"; handlers.onChange(); }
		}, 5);
		workers.push(worker);
		return worker;
	};
	registerSubagents({
		events: bus,
		registerTool: (t: any) => tools.set(t.name, t),
		on: (e: string, f: any) => events.set(e, f),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut() {},
		appendEntry: (customType: string, data: unknown) => file.append(customType, data),
		getActiveTools: () => ["read"],
		sendMessage: (...m: any[]) => messages.push(m),
	} as any, factory as any, {
		policyFile: NO_POLICY_FILE, hosting: { enabled: false },
		...(options.agentDir ? { agentDir: options.agentDir } : {}), ...(options.mailboxRoot ? { mailboxRoot: options.mailboxRoot, mailboxPollMs: 10 } : {}),
	});
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, () => {}, ctx);
	return {
		bus, ctx, workers, messages, call, commands,
		snapshot: () => snapshot,
		start: () => events.get("session_start")({}, ctx),
		tree: () => events.get("session_tree")({}, ctx),
		shutdown: () => events.get("session_shutdown")({}, ctx),
		list: async () => (await call("agent_list", {})).details.agents as any[],
	};
}

const until = async (check: () => boolean, what: string, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

/** First process: ag_01 finished and idle, ag_02 mid-turn, ag_03 ended (done). */
async function firstProcess(file: ReturnType<typeof sessionFile>) {
	const m = manager(file);
	m.start();
	await m.call("agent_spawn", { agents: [{ prompt: "one", name: "idle" }, { prompt: "two", name: "busy" }, { prompt: "three", name: "ended" }] });
	const [idle, busy, ended] = m.workers;
	idle.identify("/nowhere/idle.jsonl"); busy.identify("/nowhere/busy.jsonl"); ended.identify("/nowhere/ended.jsonl");
	await new Promise((r) => setTimeout(r, 150)); // the throttled refresh writes the refs
	idle.spend(100, 10, 0.5); idle.settle();
	busy.spend(40, 4, 0.25); busy.settle(); busy.status = "running"; busy.spend(1000, 1, 0); // a steer's turn in flight, not settled
	await new Promise((r) => setTimeout(r, 150)); // records "running" for busy
	ended.spend(7, 7, 0.07); ended.settle(); ended.exit("done");
	const before = m.snapshot().workerUsage;
	// The restart: the process dies with its workers; nothing more is written.
	return { m, before };
}

test("restart: every recorded worker comes back restored, with snapshot usage, statuses by ending", async () => {
	const file = sessionFile();
	await firstProcess(file);
	assert.ok(file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).length >= 9, "records for every inline worker");
	const m = manager(file);
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 3, "restored workers");
	const byId = Object.fromEntries(m.snapshot().workers.map((w: any) => [w.id, w]));
	// Idle at the restart: restored, not interrupted; mid-turn: interrupted; ended: keeps its ending.
	assert.equal(byId.ag_01.status, "restored"); assert.equal(byId.ag_01.interruptedAt, undefined);
	assert.equal(byId.ag_02.status, "restored"); assert.equal(typeof byId.ag_02.interruptedAt, "number");
	assert.equal(byId.ag_03.status, "done");
	for (const w of Object.values(byId) as any[]) {
		assert.equal(w.restored, true); assert.equal(w.resumable, true);
		// The transcripts are unreadable here, so the usage is the last snapshot, marked as of.
		assert.equal(w.usageSource, "snapshot"); assert.equal(typeof w.usageAsOf, "number");
	}
	assert.deepEqual([byId.ag_01.usage.input, byId.ag_02.usage.input, byId.ag_03.usage.input], [100, 40, 7]);
	// Σ: each worker once; ag_02's unsettled in-flight turn was never snapshotted.
	assert.deepEqual([m.snapshot().workerUsage.input, m.snapshot().workerUsage.workers, m.snapshot().workerUsage.restored], [147, 3, 3]);
	// The Σ is true as of its stalest snapshot.
	assert.equal(m.snapshot().workerUsage.asOf, Math.min(...Object.values(byId).map((w: any) => w.usageAsOf)));
	// Not live: no live-cap slot, nothing to wait for, a steer names the way back.
	const listed = await m.list();
	assert.deepEqual(listed.map((a) => a.status), ["restored", "restored", "done"]);
	assert.match((await m.call("agent_wait", {})).content[0].text, /Nothing to wait for/);
	await assert.rejects(m.call("agent_steer", { id: "ag_01", message: "hi" }), /restored after a restart .*agent_resume/);
	assert.equal(m.messages.length, 0, "a restore never re-reports a completion");
	await m.shutdown();
});

test("branches: only the active branch's workers are listed; the Σ covers every branch, once", async () => {
	const file = sessionFile();
	await firstProcess(file);
	// Put ag_02's records on another branch.
	const onOther = (e: any) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.workerId === "ag_02";
	file.setBranch((e) => !onOther(e));
	const m = manager(file);
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 2, "active-branch workers");
	assert.deepEqual(m.snapshot().workers.map((w: any) => w.id), ["ag_01", "ag_03"]);
	assert.deepEqual([m.snapshot().workerUsage.input, m.snapshot().workerUsage.workers], [147, 3]);
	// Switching branches moves the listing, never the Σ.
	file.setBranch(undefined);
	m.tree();
	assert.deepEqual(m.snapshot().workers.map((w: any) => w.id), ["ag_01", "ag_02", "ag_03"]);
	assert.deepEqual([m.snapshot().workerUsage.input, m.snapshot().workerUsage.workers], [147, 3]);
	await m.shutdown();
});

test("resume: idle in its own session, no prompt, no completion; usage kept as a base; recorded", async () => {
	const file = sessionFile();
	await firstProcess(file);
	const m = manager(file);
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 3, "restored workers");
	const out = await m.call("agent_resume", { id: "ag_02" });
	assert.match(out.content[0].text, /Resumed ag_02 .* idle .*nothing was sent/);
	const runner = m.workers.at(-1);
	assert.deepEqual(runner.resume, { sessionFile: "/nowhere/busy.jsonl", sessionId: "busy" }, "pi reopens its own session file");
	assert.equal(runner.id, "ag_02"); assert.equal(runner.groupId, "run_01");
	assert.equal(runner.status, "waiting");
	assert.equal(m.messages.length, 0, "no completion, no wake");
	// One entry per ID, the live one; its earlier spend is its base, so the Σ does not drop.
	const snap = m.snapshot();
	assert.deepEqual(snap.workers.filter((w: any) => w.id === "ag_02").map((w: any) => [w.status, w.restored]), [["waiting", undefined]]);
	assert.deepEqual([snap.workerUsage.input, snap.workerUsage.workers, snap.workerUsage.restored], [147, 3, 2]);
	runner.spend(5, 5, 0.05);
	runner.settle();
	await until(() => m.snapshot().workerUsage.input === 152, "the throttled refresh after its settle");
	assert.equal(m.messages.length, 1, "its next task reports normally");
	// The durable record: resumedAt clears nothing it should keep, then the settle carries lifetime usage.
	const records = file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.workerId === "ag_02").map((e) => e.data);
	const resumed = records.find((r) => r.resumedAt);
	assert.equal(resumed?.status, "waiting");
	assert.equal(records.at(-1).usageSnapshot.input, 45);
	// Live now: a second resume is refused.
	await assert.rejects(m.call("agent_resume", { id: "ag_02" }), /is live/);
	await m.shutdown();
	// And after the next restart it is restored again with the resumed history's usage.
	const next = manager(file);
	next.start();
	await until(() => (next.snapshot()?.workers ?? []).length === 3, "restored again");
	assert.equal(next.snapshot().workerUsage.input, 152);
	await next.shutdown();
});

test("resume refusals: unknown ID, live worker, a backend that cannot resume, a failed reopen keeps the entry", async () => {
	const file = sessionFile();
	await firstProcess(file);
	// A worker of a backend with no transcript adapter.
	file.append(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", workerId: "ag_09", backend: "future", at: 1, name: "f", groupId: "run_09", status: "waiting", ref: { v: 1, backend: "future", kind: "future-id", locator: "x" } });
	const m = manager(file, { failResume: true });
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 4, "restored workers");
	const future = m.snapshot().workers.find((w: any) => w.id === "ag_09");
	assert.deepEqual([future.resumable, future.usageSource], [false, "none"]);
	assert.equal(future.usage, undefined, "unavailable usage is never published as 0");
	await assert.rejects(m.call("agent_resume", { id: "ag_09" }), /backend future cannot resume workers/);
	await assert.rejects(m.call("agent_resume", { id: "ag_77" }), /No record of ag_77/);
	await assert.rejects(m.commands.get("agent-resume").handler("not-an-id", m.ctx), /one worker ID/);
	// The backend cannot reopen the session: the restored entry stays, and nothing was recorded.
	const recordsBefore = file.entries.length;
	await assert.rejects(m.commands.get("agent-resume").handler(" ag_01 ", m.ctx), /Could not resume ag_01: No such session/);
	assert.equal(file.entries.length, recordsBefore);
	const ag01 = m.snapshot().workers.filter((w: any) => w.id === "ag_01");
	assert.deepEqual(ag01.map((w: any) => [w.status, w.restored]), [["restored", true]]);
	assert.equal(m.messages.length, 0);
	await m.shutdown();
});

test("a claude-code worker resumes by session id through its backend; not loaded means refused", async () => {
	const file = sessionFile();
	const id = "6c852daa-6abf-4bbd-9ef5-8950d9330968";
	file.append(WORKER_MANIFEST_ENTRY_TYPE, {
		v: 1, kind: "worker-manifest", workerId: "ag_04", backend: "claude-code", at: 1, name: "c", groupId: "run_04", status: "running",
		spec: { cwd: os.tmpdir(), taskPreview: "review", wake: true }, ref: { v: 1, backend: "claude-code", kind: "claude-session-id", locator: id, cwd: os.tmpdir() },
		launch: { backend: "claude-code", model: "sonnet", systemPrompt: "be terse", backendOptions: { permissionMode: "acceptEdits" } },
	});
	const m = manager(file);
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 1, "restored claude worker");
	assert.equal(m.snapshot().workers[0].resumable, false, "claude-code is not loaded in this manager");
	await assert.rejects(m.call("agent_resume", { id: "ag_04" }), /backend claude-code is not loaded/);
	// Load a claude-code backend: the resume goes through its own create(), with the resume id.
	const created: any[] = [];
	m.bus.emit(BACKEND_REGISTER_EVENT, {
		version: 1, id: "claude-code", validate() {}, prepare: (spec: any) => ({ model: spec.model, systemPrompt: spec.systemPrompt, permissionMode: spec.backendOptions?.permissionMode }),
		create: (options: any, handlers: any) => {
			created.push(options);
			const w = m.workers.length;
			void w;
			const worker: any = {
				...options, backend: "claude-code", extensions: [], forked: false, status: "starting", transcript: [], transcriptOmitted: { items: 0, approxBytes: 0 },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }, steerCount: 0, startedAt: Date.now(), lastActivity: Date.now(),
				whenClosed: Promise.resolve(), processAlive: true, sessionId: options.resume?.sessionId,
				isFinished() { return false; }, isSettled() { return this.status === "waiting"; }, finalOutput: () => "",
				async steer() { return { ok: true }; }, async kill() {}, async dispose() {},
			};
			setTimeout(() => { worker.status = "waiting"; handlers.onChange(); }, 5);
			return worker;
		},
	});
	await m.call("agent_resume", { id: "ag_04" });
	assert.deepEqual(created[0].resume, { sessionId: id });
	assert.deepEqual([created[0].model, created[0].systemPrompt, created[0].permissionMode], ["sonnet", "be terse", "acceptEdits"]);
	await m.shutdown();
});

test("a backend reporting session-cumulative usage is not counted twice after a resume (e2e B1)", async () => {
	// The e2e's checker: before the restart 10/116/0/13,846 $0.028282; after resume + one turn the
	// Claude CLI reports its whole session, 20/168/13,846/14,016 $0.0303 — the transcript's truth.
	const file = sessionFile();
	// An id with no record on disk: the rebuilt usage is the snapshot (a real record would be read instead).
	const id = "00000000-0000-4000-8000-00000000b001";
	const base = { input: 10, output: 116, cacheRead: 0, cacheWrite: 13846, cost: 0.028282, turns: 1 };
	file.append(WORKER_MANIFEST_ENTRY_TYPE, {
		v: 1, kind: "worker-manifest", workerId: "ag_04", backend: "claude-code", at: 1, name: "checker", groupId: "run_04", status: "waiting",
		spec: { cwd: os.tmpdir(), taskPreview: "check", wake: true }, ref: { v: 1, backend: "claude-code", kind: "claude-session-id", locator: id, cwd: os.tmpdir() },
		usageSnapshot: { ...base, byModel: [], source: "snapshot", asOf: 1 }, launch: { backend: "claude-code", model: "haiku" },
	});
	const m = manager(file);
	let worker: any;
	let settled: ((w: any) => void) | undefined;
	m.bus.emit(BACKEND_REGISTER_EVENT, {
		version: 1, id: "claude-code", validate() {}, prepare: () => ({}),
		create: (options: any, handlers: any) => {
			settled = handlers.onSettled;
			worker = {
				...options, backend: "claude-code", usageScope: "session", extensions: [], forked: false, status: "starting", transcript: [], transcriptOmitted: { items: 0, approxBytes: 0 },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }, steerCount: 0, startedAt: Date.now(), lastActivity: Date.now(),
				whenClosed: Promise.resolve(), processAlive: true, sessionId: id,
				isFinished() { return false; }, isSettled() { return this.status === "waiting"; }, finalOutput: () => "CHECKER-9",
				async steer() { return { ok: true }; }, async kill() {}, async dispose() {},
			};
			setTimeout(() => { worker.status = "waiting"; handlers.onChange(); }, 5);
			return worker;
		},
	});
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 1, "restored checker");
	assert.deepEqual([m.snapshot().workerUsage.input, m.snapshot().workerUsage.cacheWrite], [10, 13846]);
	await m.call("agent_resume", { id: "ag_04" });
	// Before its first report the rebuilt total stands; nothing drops, nothing doubles.
	await until(() => m.snapshot().workers[0]?.status === "waiting", "resumed idle");
	assert.deepEqual([m.snapshot().workerUsage.input, m.snapshot().workerUsage.cacheWrite, m.snapshot().workerUsage.cost], [10, 13846, 0.028282]);
	// One turn: the CLI's cumulative figures, whole session included.
	Object.assign(worker.usage, { input: 20, output: 168, cacheRead: 13846, cacheWrite: 14016, cost: 0.0303, turns: 2 });
	worker.taskOutcome = "success";
	settled!(worker);
	await until(() => m.snapshot().workerUsage.input === 20, "the settle's refresh");
	const u = m.snapshot().workerUsage;
	assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite, u.cost], [20, 168, 13846, 14016, 0.0303], "equals the transcript, not base + cumulative");
	// And the durable snapshot is the true total, so no inflated cost outlives the next restart.
	const snap = file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.workerId === "ag_04").at(-1).data.usageSnapshot;
	assert.deepEqual([snap.input, snap.output, snap.cacheRead, snap.cacheWrite, snap.cost, snap.turns], [20, 168, 13846, 14016, 0.0303, 2]);
	await m.shutdown();
});

test("resolvedModel: the transcript's model, else the snapshot's biggest row, else the spawn model; claude/ dropped for claude-code only", () => {
	const rows = [
		{ model: "claude/claude-sonnet-4-6", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		{ model: "claude/claude-haiku-4-5-20251001", input: 10, output: 100, cacheRead: 5000, cacheWrite: 9000 },
	];
	const claude: any = { v: 1, workerId: "ag_01", backend: "claude-code", at: 1, spec: { cwd: "/", model: "haiku", taskPreview: "", wake: true }, usageSnapshot: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: rows, source: "snapshot" } };
	assert.equal(resolvedModel(claude, { summary: { model: "claude/claude-haiku-4-5-20251001" } as any }), "claude-haiku-4-5-20251001");
	assert.equal(resolvedModel(claude, { summary: undefined }), "claude-haiku-4-5-20251001", "the biggest snapshot row, not the first");
	assert.equal(resolvedModel({ ...claude, usageSnapshot: undefined }, undefined), "haiku", "the spawn model last");
	// pi models are provider/id in every state: nothing is stripped.
	const pi: any = { v: 1, workerId: "ag_02", backend: "pi", at: 1, spec: { cwd: "/", model: "zai/glm-5.3", taskPreview: "", wake: true } };
	assert.equal(resolvedModel(pi, { summary: { model: "claude/odd-provider-model" } as any }), "claude/odd-provider-model");
	assert.equal(resolvedModel(pi, undefined), "zai/glm-5.3");
});

test("a restored and then resumed Claude worker shows the model it ran under, until its runner reports one", async () => {
	const file = sessionFile();
	const id = "00000000-0000-4000-8000-00000000b002";
	file.append(WORKER_MANIFEST_ENTRY_TYPE, {
		v: 1, kind: "worker-manifest", workerId: "ag_05", backend: "claude-code", at: 1, name: "c", groupId: "run_05", status: "waiting",
		spec: { cwd: os.tmpdir(), model: "haiku", taskPreview: "t", wake: true }, ref: { v: 1, backend: "claude-code", kind: "claude-session-id", locator: id, cwd: os.tmpdir() },
		usageSnapshot: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, byModel: [{ model: "claude/claude-haiku-4-5-20251001", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], source: "snapshot", asOf: 1 },
		launch: { backend: "claude-code", model: "haiku" },
	});
	const m = manager(file);
	let worker: any;
	let launchedWith: string | undefined;
	m.bus.emit(BACKEND_REGISTER_EVENT, {
		version: 1, id: "claude-code", validate() {}, prepare: (spec: any) => ({ model: spec.model }),
		create: (options: any, handlers: any) => {
			launchedWith = options.model;
			worker = {
				...options, backend: "claude-code", usageScope: "session", extensions: [], forked: false, status: "starting", transcript: [], transcriptOmitted: { items: 0, approxBytes: 0 },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }, steerCount: 0, startedAt: Date.now(), lastActivity: Date.now(),
				whenClosed: Promise.resolve(), processAlive: true, sessionId: id,
				isFinished() { return false; }, isSettled() { return this.status === "waiting"; }, finalOutput: () => "",
				async steer() { return { ok: true }; }, async kill() {}, async dispose() {},
			};
			setTimeout(() => { worker.status = "waiting"; handlers.onChange(); }, 5);
			return worker;
		},
	});
	m.start();
	await until(() => (m.snapshot()?.workers ?? []).length === 1, "restored");
	assert.equal(m.snapshot().workers[0].model, "claude-haiku-4-5-20251001", "restored: not the spawn alias");
	await m.call("agent_resume", { id: "ag_05" });
	assert.equal(worker.model, "claude-haiku-4-5-20251001", "resumed: the same label before its first turn");
	assert.equal(launchedWith, "haiku", "the CLI is still launched with the spawn model");
	await m.shutdown();
});

/** A member's request through its mailbox, as member.ts would send it. */
async function ask(worker: any, request: Omit<MailboxRequest, "version" | "id" | "at">) {
	const me = decodeMemberContext(worker.env?.[MEMBER_ENV])!;
	const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
	writeRequest(me.dir, full);
	const response = await awaitResponse(me.dir, full.id, 3000, undefined, 5);
	assert.ok(response, `answered ${request.type}`);
	return response!;
}

test("restart: a paused team stays paused (its resumed monitor is sent the resume check) and the coordinator's roster keeps tasks and steers", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-restore-team-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const tuple = { backend: "pi", model: "test/model", effort: "low" };
	fs.writeFileSync(path.join(agentDir, "team-defaults.json"), JSON.stringify({
		version: 1,
		coordinator: { enabled: true, role: "coordinator", primary: tuple, fallback: null, instructions: "" },
		monitor: { enabled: true, role: "monitor", primary: tuple, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
		handover: { retireTimeoutMinutes: 10 },
	}));
	const file = sessionFile();
	const first = manager(file, { agentDir, mailboxRoot: path.join(root, "mail1") });
	const second = manager(file, { agentDir, mailboxRoot: path.join(root, "mail2") });
	try {
		first.start();
		await first.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "Write f01-f10." }] });
		for (const w of first.workers) w.identify(`/nowhere/${w.id}.jsonl`);
		await new Promise((r) => setTimeout(r, 150)); // the throttled refresh writes the refs
		const monitor = first.workers.find((w) => w.name === "monitor");
		await first.call("agent_steer", { id: "ag_02", message: "After f10, also write summary.txt.", mode: "followUp" });
		assert.equal((await ask(monitor, { type: "message", to: "coordinator", message: "zai 5h at 95%", notice: "pause" })).ok, true);
		for (const w of first.workers) w.settle();
		// The reload: this manager and its workers end; a new one reads the same session file.
		await first.shutdown();
		second.start();
		await until(() => (second.snapshot()?.workers ?? []).length === 3, "restored members");
		const resumedMonitor = await second.call("agent_resume", { id: "ag_03" });
		assert.match(resumedMonitor.content[0].text, /^Resumed ag_03 \(monitor\) .*It is the monitor of team_01, which is paused: it was sent its resume check, since its wake_nudges ended with the earlier parent\.$/);
		assert.match(second.workers.at(-1).lastSteer, /^\[Team team_01 restored while paused\]\n.*your pending wake_nudges ended with it\. Run your standing instruction now: call team_roster;/);
		await second.call("agent_resume", { id: "ag_01" });
		const roster = await ask(second.workers.at(-1), { type: "roster" });
		assert.match(roster.text, /Assignments from the main thread \(the work you route; never replace or cancel it\):\n {4}ag_02 dev:\n {6}\| Write f01-f10\.\n {6}Later instructions from the main thread \(assignments too\), newest last:\n {6}> After f10, also write summary\.txt\./);
		// A resumed non-monitor member is sent nothing, paused team or not.
		const resumedDev = await second.call("agent_resume", { id: "ag_02" });
		assert.match(resumedDev.content[0].text, /idle .*nothing was sent to it/);
		assert.equal(second.workers.at(-1).lastSteer, undefined);
	} finally {
		await second.shutdown();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
