import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { CLAUDE_CODE_EXTENSION, MARKER_EXTENSION, MEMBER_EXTENSION, MEMBER_MCP, REMOTE_EXTENSION, REMOTE_MCP, REMOTE_MCP_TOOL_TIMEOUT_MS, registerSubagents, boundedText, installedPackageDir, type SubagentsOptions } from "./index.ts";
import { CLAUDE_PROVIDER_FLAG } from "../claude-code/provider/index.ts";
import { placeholderDir } from "../remote/argv.ts";
import { REMOTE_MCP_ENV, REMOTE_MCP_SERVER_NAME, REMOTE_SESSION_EVENT, decodeRemoteMcpIdentity } from "../remote/workers.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT, type SandboxStateEvent } from "../sandbox/state.ts";
import { CLAUDE_CODE_PROVIDER_FLAG, SubagentRunner } from "./runner.ts";
import { MEMBER_ENV, awaitResponse, decodeMemberContext, memberPaths, memberToolNames, readInbox, requestId, writeRequest, type MailboxRequest } from "./mailbox.ts";

import { BACKEND_DIALOG_EVENT, BACKEND_REGISTER_EVENT, BACKEND_DISCOVER_EVENT, registerBackend, type BackendRegistration } from "./contracts.ts";

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => { listeners.get(name)?.delete(handler); };
		},
		emit(name: string, data: unknown) { for (const handler of listeners.get(name) ?? []) handler(data); },
	};
}

/** A path that is never created: the user's real ~/.pi/agent model policy must not decide what a
 *  test sees. Tests about the policy pass their own file (see the policy tests below). */
const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");
/** Likewise the agent dir: no team-defaults.json there, so teams behave as without the file. */
const NO_AGENT_DIR = path.join(os.tmpdir(), "subagents-tests-absent-agent-dir");

function harness(bus = eventBus(), options: SubagentsOptions = {}) {
	options = { policyFile: NO_POLICY_FILE, agentDir: NO_AGENT_DIR, ...options };
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const workers: any[] = [];
	const notices: any[] = [];
	const messages: any[] = [];
	const userMessages: any[] = [];
	const updates: any[] = [];
	const appended: any[] = [];
	const ctx: any = {
		cwd: path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
		mode: "tui",
		hasUI: true,
		thinkingLevel: "high",
		isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined as string | undefined },
		modelRegistry: {
			find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined),
		},
		ui: { setStatus() {}, notify: (...a: any[]) => notices.push(a) },
	};
	registerSubagents(
		{
			events: bus,
			registerTool: (t: any) => tools.set(t.name, t),
			on: (e: string, f: any) => events.set(e, f),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerShortcut() {},
			appendEntry: (customType: unknown, data: unknown) => appended.push({ customType, data }),
			getAgentDir: () => path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
			getActiveTools: () => ["read", "bash", "agent_spawn"],
			sendMessage: (...m: any[]) => messages.push(m),
			sendUserMessage: (...m: any[]) => userMessages.push(m),
		} as any,
		(options, handlers) => {
			const worker: any = {
				...options,
				wake: options.wake ?? true,
				extensions: options.extensions ?? [],
				forked: Boolean(options.forkSession),
				status: "running",
				error: undefined,
				transcript: [],
				usage: { input: 0, output: 0, turns: 0 },
				steerCount: 0,
				isFinished() {
					return ["killed", "done", "error"].includes(this.status);
				},
				isSettled() {
					return this.isFinished() || this.status === "waiting";
				},
				finalOutput() {
					return this.output ?? "";
				},
				change() { handlers.onChange(); },
				async steer(message: string, signal?: AbortSignal, mode?: string) {
					this.lastSteer = { message, signal, mode };
					this.steerCount++;
					this.status = "running";
					return { ok: true };
				},
				async kill() {
					await new Promise((r) => setTimeout(r, 5));
					this.status = "killed";
				},
				async dispose() {
					await this.kill();
					this.disposed = true;
				},
				exit() {
					this.status = "done";
					this.processAlive = false;
					handlers.onExit(this);
				},
				settle(error?: string, status = "waiting") {
					this.status = status;
					this.error = error;
					handlers.onSettled(this);
				},
			};
			workers.push(worker);
			return worker;
		},
		options,
	);
	return {
		bus,
		workers,
		ctx,
		notices,
		messages,
		userMessages,
		updates,
		appended,
		tools,
		commands,
		call: (name: string, params: any = {}, signal?: AbortSignal) =>
			tools.get(name).execute("test", params, signal, (partial: any) => updates.push(partial), ctx),
		event: (name: string, data: any) => events.get(name)?.(data, ctx),
		start: () => events.get("session_start")({}, ctx),
		close: () => events.get("session_shutdown")({}, ctx),
	};
}

function fakeBackend(created: any[]): BackendRegistration {
	return {
		version: 1,
		id: "claude-code",
		validate(spec) {
			if (spec.fork || spec.extensions !== undefined || spec.agentType !== undefined) throw new Error("Unsupported Claude option");
			if (spec.model === "invalid") throw new Error("Invalid Claude model");
		},
		prepare(spec, ctx) {
			assert.ok(ctx.cwd);
			return { model: spec.model ?? "sonnet", backendOptions: { permissionMode: "default", ...spec.backendOptions } };
		},
		create(options, handlers) {
			const worker: any = {
				...options, extensions: [], status: "running", processAlive: true, transcript: [],
				usage: { input: 0, output: 0, turns: 0 }, steerCount: 0,
				isFinished() { return this.status === "killed"; },
				isSettled() { return this.status !== "running"; },
				finalOutput() { return "Claude result"; },
				async steer(message: string, signal?: AbortSignal, mode?: string) {
					this.lastSteer = { message, signal, mode }; this.steerCount++; return { ok: true };
				},
				async kill() { this.status = "killed"; },
				async dispose() { this.disposed = true; await this.kill(); },
				settle() { this.status = "waiting"; handlers.onSettled(this); },
			};
			created.push(worker);
			return worker;
		},
	};
}

test("worker snapshots answer before startup and publish bounded background state without UI", async () => {
	const h = harness();
	const snapshots: any[] = [];
	const off = h.bus.on("subagents:workers-snapshot", data => snapshots.push(data));
	const request = () => h.bus.emit("subagents:workers-request", { version: 1 });
	h.ctx.hasUI = false;
	h.ctx.mode = "json";
	try {
		request();
		const noUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, workers: 0 };
		assert.deepEqual(snapshots, [{ version: 1, workerUsage: noUsage, workers: [] }]);
		h.bus.emit("subagents:workers-request", { version: 2 });
		assert.equal(snapshots.length, 1);
		await h.start();
		assert.deepEqual(snapshots.at(-1), { version: 1, workerUsage: noUsage, workers: [] });
		await h.call("agent_spawn", { prompt: "background task", wake: false });
		const a = h.workers[0];
		assert.deepEqual(snapshots.at(-1).workers, [{ id: a.id, name: a.name,
			status: "running", model: "test/model", preview: "No response yet.", backend: "pi", effort: "high" }]);
		// Additive presence fields come straight from the Worker; unset/invalid values are omitted.
		Object.assign(a, { startedAt: 1_000, lastActivity: 2_000, endedAt: Number.NaN, taskOutcome: "bogus", pid: 4242 });
		request();
		assert.deepEqual(snapshots.at(-1).workers[0], { id: a.id, name: a.name, status: "running", model: "test/model",
			preview: "No response yet.", backend: "pi", effort: "high", startedAt: 1_000, lastActivity: 2_000 });
		for (const [taskOutcome, outcome] of [["success", "success"], ["error", "error"], ["aborted", "aborted"], [undefined, undefined]]) {
			a.taskOutcome = taskOutcome;
			request();
			assert.equal(snapshots.at(-1).workers[0].outcome, outcome);
			assert.equal("outcome" in snapshots.at(-1).workers[0], outcome !== undefined);
		}
		a.endedAt = 3_000;
		request();
		assert.equal(snapshots.at(-1).workers[0].endedAt, 3_000);
		a.endedAt = undefined;
		// The worker's own transcript path and backend session id; empty or non-string values are omitted.
		Object.assign(a, { sessionFile: "/tmp/sessions/worker.jsonl", sessionId: "0199-worker" });
		request();
		assert.deepEqual(snapshots.at(-1).workers[0], { id: a.id, name: a.name, status: "running", model: "test/model",
			preview: "No response yet.", backend: "pi", sessionFile: "/tmp/sessions/worker.jsonl", sessionId: "0199-worker",
			effort: "high", startedAt: 1_000, lastActivity: 2_000 });
		Object.assign(a, { sessionFile: "", sessionId: 42 });
		request();
		for (const key of ["sessionFile", "sessionId"]) assert.ok(!(key in snapshots.at(-1).workers[0]), key);
		Object.assign(a, { sessionFile: undefined, sessionId: undefined });
		// The effort it was spawned with (inherited from the parent here); empty, non-string or unknown ⇒ omitted.
		for (const effort of ["", 7, undefined]) {
			a.effort = effort;
			request();
			assert.ok(!("effort" in snapshots.at(-1).workers[0]), String(effort));
		}
		a.effort = "high";
		// Privacy: cwd, pid, and task text never cross the bus.
		for (const key of ["cwd", "pid", "task", "prompt"]) assert.ok(!(key in snapshots.at(-1).workers[0]), key);
		assert.ok(!JSON.stringify(snapshots.at(-1)).includes("background task"));
		a.output = "x".repeat(5000);
		a.change(); // Runner callback, not a parent tool event or an open monitor.
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.at(-1).workers[0].preview, "x".repeat(320));
		a.settle("failure ".repeat(100));
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.at(-1).workers[0].status, "waiting");
		assert.equal(snapshots.at(-1).workers[0].preview, a.error.slice(0, 320));
		a.settle("startup failed", "error");
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.at(-1).workers[0].status, "error");
		assert.equal(snapshots.at(-1).workers[0].preview, "startup failed");
		// Snapshots must not expose mutable manager objects.
		snapshots.at(-1).workers[0].name = "consumer mutation";
		request();
		assert.equal(snapshots.at(-1).workers[0].name, a.name);
		a.error = undefined;
		a.exit();
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.at(-1).workers[0].status, "done");
		// Pending refreshes cannot republish workers after shutdown.
		a.change();
		const closing = h.close();
		assert.deepEqual(snapshots.at(-1), { version: 1, workers: [] }, "shutdown publishes neither workers nor a total");
		const count = snapshots.length;
		request();
		await closing;
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.length, count);
	} finally { off(); await h.close(); }
});

test("worker snapshots carry the effort each worker was spawned with", async () => {
	const h = harness();
	const snapshots: any[] = [];
	const off = h.bus.on("subagents:workers-snapshot", data => snapshots.push(data));
	try {
		await h.start();
		await h.call("agent_spawn", { prompt: "low effort task", effort: "low", wake: false });
		await h.call("agent_spawn", { prompt: "inheriting task", wake: false });
		h.bus.emit("subagents:workers-request", { version: 1 });
		const [explicit, inherited] = snapshots.at(-1).workers;
		assert.equal(explicit.effort, "low", "an explicit spawn effort is published as-is");
		assert.equal(inherited.effort, "high", "an unset one publishes the parent level it inherited");
	} finally { off(); await h.close(); }
});

test("worker snapshots carry token counts and a session-lifetime total that survives eviction", async () => {
	const h = harness();
	const snapshots: any[] = [];
	const off = h.bus.on("subagents:workers-snapshot", data => snapshots.push(data));
	const request = () => h.bus.emit("subagents:workers-request", { version: 1 });
	const spend = (a: any, n: number) => Object.assign(a.usage, { input: n, output: n / 2, cacheRead: n * 10, cacheWrite: n, cost: n / 1000 });
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "one" }, { prompt: "two" }] });
		request();
		assert.ok(snapshots.at(-1).workers.every((w: any) => !("usage" in w)), "a worker that spent nothing carries no usage");
		assert.deepEqual(snapshots.at(-1).workerUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, workers: 2 });
		spend(h.workers[0], 100);
		spend(h.workers[1], 20);
		request();
		assert.deepEqual(snapshots.at(-1).workers[0].usage, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 100, cost: 0.1 });
		const { cost, ...counts } = snapshots.at(-1).workerUsage;
		assert.deepEqual(counts, { input: 120, output: 60, cacheRead: 1200, cacheWrite: 120, workers: 2 });
		assert.ok(Math.abs(cost - 0.12) < 1e-9, "costs are summed as reported, not rounded");
		// Garbage from a backend counts as 0 and never reaches a consumer.
		Object.assign(h.workers[1].usage, { input: Number.NaN, output: -5, cacheRead: "1000", cacheWrite: Infinity, cost: undefined });
		request();
		assert.ok(!("usage" in snapshots.at(-1).workers[1]), "all-garbage counts read as 0, so no usage is published");
		assert.deepEqual(snapshots.at(-1).workerUsage,
			{ input: 100, output: 50, cacheRead: 1000, cacheWrite: 100, cost: 0.1, workers: 2 });
		spend(h.workers[1], 20);
		// Retention evicts finished workers; their counts stay in the total, and so does their head count.
		for (let i = 0; i < 55; i++) {
			await h.call("agent_spawn", { prompt: `task ${i}` });
			spend(h.workers.at(-1), 2);
			h.workers.at(-1).settle(undefined, "done");
		}
		request();
		const total = snapshots.at(-1).workerUsage;
		assert.equal(snapshots.at(-1).workers.length, 52, "the list is capped");
		assert.equal(total.workers, 57, "the total counts every worker ever spawned");
		assert.equal(total.input, 100 + 20 + 55 * 2);
		assert.equal(total.cacheRead, (100 + 20 + 55 * 2) * 10);
		assert.ok(total.input > snapshots.at(-1).workers.reduce((n: number, w: any) => n + (w.usage?.input ?? 0), 0),
			"it is not the sum of the published rows");
	} finally { off(); await h.close(); }
});


test("worker snapshots include Claude and do not depend on working UI methods", async () => {
	const h = harness();
	const created: any[] = [];
	const offBackend = registerBackend(h.bus as any, fakeBackend(created));
	const snapshots: any[] = [];
	const off = h.bus.on("subagents:workers-snapshot", data => snapshots.push(data));
	h.ctx.ui.setStatus = () => { throw new Error("UI unavailable"); };
	try {
		await h.call("agent_spawn", { agents: [
			{ prompt: "Pi background task", wake: false },
			{ prompt: "Claude background task", backend: "claude-code", wake: false },
		] });
		assert.equal(snapshots.at(-1).workers.length, 2);
		assert.equal(snapshots.at(-1).workers[1].model, "sonnet");
		assert.equal(snapshots.at(-1).workers[1].preview, "Claude result");
		assert.equal(snapshots.at(-1).workers[1].backend, "claude-code");
		assert.equal(snapshots.at(-1).workers[0].backend, "pi");
		created[0].settle();
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.at(-1).workers[1].status, "waiting");
	} finally { off(); offBackend(); await h.close(); }
});

test("worker snapshots never publish an uncommitted failed spawn batch", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const create = backend.create;
	backend.create = (options, handlers) => {
		if (created.length) throw new Error("factory failed");
		return create(options, handlers);
	};
	const offBackend = registerBackend(h.bus as any, backend);
	const snapshots: any[] = [];
	const off = h.bus.on("subagents:workers-snapshot", data => snapshots.push(data));
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "task", backend: "claude-code", count: 2 }), /factory failed/);
		h.bus.emit("subagents:workers-request", { version: 1 });
		assert.ok(snapshots.length);
		assert.ok(snapshots.every(snapshot => snapshot.workers.length === 0));
	} finally { off(); offBackend(); await h.close(); }
});

test("agent_models discovers active Pi and native backend models with explicit errors", async () => {
	const h = harness();
	let cliCalls = 0;
	h.ctx.modelRegistry.getAvailable = () => [{ provider: "ollama-cloud", id: "deepseek-v4.1-flash", name: "DeepSeek" }];
	const backend = { ...fakeBackend([]), listModels: async () => { cliCalls++; return [{ id: "opus", name: "Opus", efforts: ["low", "medium"] }]; } };
	registerBackend(h.bus as any, backend);
	try {
		const pi = await h.call("agent_models", { query: "deepseek 4.1 flash", backend: "pi" });
		assert.equal(pi.details.models[0].id, "ollama-cloud/deepseek-v4.1-flash");
		assert.equal(cliCalls, 0);
		const all = await h.call("agent_models", {});
		assert.equal(all.details.models.length, 2);
		assert.equal(all.details.models.find((m: any) => m.backend === "claude-code").efforts[0], "low");
		assert.equal(cliCalls, 1);
		assert.equal((await h.call("agent_models", { backend: "missing" })).details.errors[0].backend, "missing");
		const limited = await h.call("agent_models", { limit: 1 });
		assert.equal(limited.details.models.length, 1);
		assert.equal(limited.details.totalMatches, 2);
	} finally { await h.close(); }
});

test("/subagents models selects a model without spawning a worker", async () => {
	const h = harness();
	h.ctx.modelRegistry.getAvailable = () => [{ provider: "ollama-cloud", id: "deepseek-v4.1-flash", name: "DeepSeek" }];
	let editor = "";
	h.ctx.ui.select = async (_title: string, choices: string[]) => choices[0];
	h.ctx.ui.setEditorText = (value: string) => { editor = value; };
	try {
		await h.commands.get("subagents").handler("models deepseek 4.1 flash", h.ctx);
		assert.match(editor, /ollama-cloud\/deepseek-v4\.1-flash/);
		assert.equal(h.workers.length, 0);
	} finally { await h.close(); }
});

test("team_create against the real Claude backend rejects an oversized composed prompt before any worker starts", async () => {
	const h = harness();
	const claudePi = {
		events: h.bus,
		registerTool: (_t: any) => {},
		on: (e: string, f: any) => (e === "session_shutdown" ? (() => { (h.shutdownHooks ??= []).push(f); return f; })() : (() => {})()),
		registerCommand: (_n: string, _c: any) => {},
		registerShortcut() {},
		appendEntry: () => {},
		getActiveTools: () => [],
		sendMessage: () => {},
		sendUserMessage: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
	};
	const { registerClaudeCode } = await import("../claude-code/index.ts");
	const { MAX_CLAUDE_INPUT_CHARS } = await import("../claude-code/runner.ts");
	registerClaudeCode(claudePi as any);
	try {
		await assert.rejects(
			h.call("team_create", {
				name: "oversized",
				objective: "Validate header composition reaches the real length limit",
				defaults: { backend: "claude-code" },
				members: [{ role: "builder", prompt: "x".repeat(MAX_CLAUDE_INPUT_CHARS), tools: [] }],
			}),
			/Claude prompt is \d+ characters/,
		);
		const listed = await h.call("team_list");
		assert.equal(listed.details.teams.length, 0);
		assert.equal(h.workers.length, 0);
	} finally {
		for (const f of h.shutdownHooks ?? []) await f({}, h.ctx);
		await h.close();
	}
});

for (const order of ["backend-first", "host-first"] as const) {
	test(`backend discovery is load-order independent: ${order}`, async () => {
		const bus = eventBus();
		const created: any[] = [];
		const backend = fakeBackend(created);
		let off: (() => void) | undefined;
		if (order === "backend-first") off = registerBackend(bus as any, backend);
		const h = harness(bus);
		if (order === "host-first") off = registerBackend(bus as any, backend);
		try {
			h.ctx.modelRegistry.find = () => { throw new Error("Pi registry must not be consulted"); };
			await h.start();
			const r = await h.call("agent_spawn", { prompt: "task", backend: "claude-code", backendOptions: { permissionMode: "plan" } });
			assert.equal(h.workers.length, 0);
			assert.equal(created.length, 1);
			assert.equal(created[0].model, "sonnet");
			assert.equal(created[0].effort, undefined);
			assert.equal(created[0].tools, undefined);
			assert.equal(created[0].backendOptions.permissionMode, "plan");
			assert.equal(r.details.spawned[0].backend, "claude-code");
			created[0].settle();
			assert.equal(h.messages.length, 1);
			const listed = await h.call("agent_list");
			assert.equal(listed.details.agents[0].backend, "claude-code");
			const signal = new AbortController().signal;
			await h.call("agent_steer", { id: "ag_01", message: "next", mode: "followUp" }, signal);
			assert.deepEqual(created[0].lastSteer, { message: "next", signal, mode: "followUp" });
		} finally {
			await h.close(); off?.();
		}
		assert.equal(created[0].disposed, true);
	});
}

test("monitor aliases compose steering without destroying the monitor", async () => {
	const h = harness();
	let view: any;
	let done: (value: null) => void;
	const visibility: boolean[] = [];
	let focusCount = 0;
	h.ctx.ui.custom = (factory: any, options: any) => new Promise((resolve) => {
		done = resolve;
		options.onHandle({ setHidden: (hidden: boolean) => visibility.push(hidden), focus: () => focusCount++ });
		view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
	});
	h.ctx.ui.editor = async () => "next instructions";
	try {
		assert.ok(h.commands.has("agents")); assert.ok(h.commands.has("subagents"));
		await h.call("agent_spawn", { prompt: "task" });
		const opened = h.commands.get("subagents").handler("", h.ctx);
		let accept!: () => void;
		const acceptance = new Promise<void>((resolve) => { accept = resolve; });
		const steer = h.workers[0].steer.bind(h.workers[0]);
		h.workers[0].steer = async (...args: any[]) => { await acceptance; return steer(...args); };
		const pending = view.host.steerAgent("ag_01", "followUp");
		await Promise.resolve();
		// The monitor is usable even though delivery acceptance has not arrived.
		assert.deepEqual(visibility, [true, false]); assert.equal(focusCount, 1);
		assert.equal(h.workers[0].steerCount, 0);
		await view.host.steerAgent("ag_01", "redirect");
		assert.deepEqual(visibility, [true, false]); // composing guard still held
		accept(); await pending;
		assert.deepEqual(h.workers[0].lastSteer, { message: "next instructions", signal: undefined, mode: "followUp" });
		h.ctx.ui.editor = async () => undefined;
		await view.host.steerAgent("ag_01", "redirect");
		assert.equal(h.workers[0].steerCount, 1);
		assert.deepEqual(visibility, [true, false, true, false]);
		let finishEditor!: (text: string) => void;
		h.ctx.ui.editor = () => new Promise<string>((resolve) => { finishEditor = resolve; });
		const editingAtShutdown = view.host.steerAgent("ag_01", "redirect");
		assert.deepEqual(visibility, [true, false, true, false, true]);
		await h.close();
		finishEditor("late instructions"); await editingAtShutdown;
		assert.deepEqual(visibility, [true, false, true, false, true]); // no stale restoration
		assert.equal(h.workers[0].steerCount, 1);
		done!(null); await opened;
	} finally { await h.close(); }
});

test("backend dialog tokens hide the monitor until all close, without stale restoration", async () => {
	const h = harness();
	const visibility: boolean[] = [];
	let focusCount = 0;
	let view: any;
	h.ctx.ui.custom = (factory: any, options: any) => new Promise((resolve) => {
		view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
		options.onHandle({ setHidden: (hidden: boolean) => visibility.push(hidden), focus: () => focusCount++ });
	});
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const opened = h.commands.get("agents").handler("", h.ctx);
		h.event("ui_prompt_start", { kind: "custom" });
		h.event("ui_prompt_end", { kind: "custom" });
		assert.deepEqual(visibility, []);
		const dialog = (token: string, open: boolean) => h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token, open });
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 2, token: "bad", open: true });
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "", open: true });
		assert.deepEqual(visibility, []);
		dialog("one", true); dialog("one", true); dialog("two", true);
		assert.deepEqual(visibility, [true]);
		dialog("unknown", false); dialog("one", false);
		assert.deepEqual(visibility, [true]);
		dialog("two", false); dialog("two", false);
		assert.deepEqual(visibility, [true, false]); assert.equal(focusCount, 1);
		// Closing a backend dialog must not restore over an active composer.
		h.ctx.ui.editor = async () => {
			dialog("during-editor", true); dialog("during-editor", false);
			assert.deepEqual(visibility, [true, false, true]);
			return undefined;
		};
		await view.host.steerAgent("ag_01", "redirect");
		assert.deepEqual(visibility, [true, false, true, false]); assert.equal(focusCount, 2);
		// Conversely, editor completion cannot restore over an active backend dialog.
		h.ctx.ui.editor = async () => { dialog("outlasts-editor", true); return undefined; };
		await view.host.steerAgent("ag_01", "redirect");
		assert.deepEqual(visibility, [true, false, true, false, true]);
		dialog("outlasts-editor", false);
		assert.deepEqual(visibility, [true, false, true, false, true, false]);
		dialog("shutdown", true);
		await h.close(); await opened;
		dialog("shutdown", false); dialog("late", true); dialog("late", false);
		assert.deepEqual(visibility, [true, false, true, false, true, false, true]);
	} finally { await h.close(); }
});

test("transcript identifies backend sessions without files and discloses omitted history", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		worker.backend = "claude-code";
		worker.sessionId = "claude-session-123";
		worker.transcriptOmitted = { items: 7, approxBytes: 1234 };
		worker.transcript = [{ kind: "assistant", text: "retained output" }];
		let r = await h.call("agent_transcript", { id: worker.id, full: true });
		assert.match(r.content[0].text, /Session: claude-session-123/);
		assert.match(r.content[0].text, /7 earlier item\(s\) omitted, approximately 1234 bytes/);
		assert.equal(r.details.sessionId, "claude-session-123");
		assert.deepEqual(r.details.transcriptOmitted, { items: 7, approxBytes: 1234 });
		r = await h.call("agent_transcript", { id: worker.id });
		assert.match(r.content[0].text, /Session: claude-session-123/);
		worker.sessionFile = "/tmp/canonical.jsonl";
		r = await h.call("agent_transcript", { id: worker.id, full: true });
		assert.match(r.content[0].text, /Session: \/tmp\/canonical.jsonl/);
	} finally { await h.close(); }
});

test("completion summary states model, thinking level and non-pi backend", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		worker.sessionFile = "/tmp/s.jsonl";
		worker.output = "the answer";
		// Defaults: a pi worker inheriting the parent's model and thinking level.
		worker.model = undefined; worker.effort = undefined;
		let text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /^### ag_01 \(.*\) — running/);
		assert.match(text, /\nSession: \/tmp\/s\.jsonl\n/);
		assert.match(text, /\nModel: child default · thinking: default\n/);
		assert.doesNotMatch(text, /backend:/);
		assert.match(text, /\nthe answer$/);
		// Explicit model/effort on a non-pi backend names all three.
		worker.model = "opus"; worker.effort = "high"; worker.backend = "claude-code";
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\nModel: opus · thinking: high · backend: claude-code\n/);
		// Errors stay above the metadata; empty output is still disclosed.
		worker.backend = "pi"; worker.output = ""; worker.error = "boom";
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\nError: boom\nSession: .*\nModel: opus · thinking: high\n\(no output yet — task in progress\)$/);
	} finally { await h.close(); }
});

test("busy workers surface recent transcript activity instead of an empty task", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		worker.backend = "claude-code";
		worker.sessionId = "claude-session-123";
		// A tool-heavy Claude run: many tool items, no assistant text yet.
		worker.transcript = [
			{ kind: "task", text: "fix the menu" },
			...Array.from({ length: 40 }, (_, i) => ({
				kind: "tool" as const,
				toolName: i % 2 ? "Bash" : "Edit",
				text: i % 2 ? `{"command":"echo step ${i}"}` : `{"file_path":"/repo/src/File${i}.tsx"}`,
			})),
		];
		let text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /— running\n/);
		assert.match(text, /Still working — no final answer yet\. Recent activity \(last 6 of 41 retained item\(s\)\):/);
		assert.match(text, /\[tool:Edit\] \{"file_path":"\/repo\/src\/File38\.tsx"\}/);
		assert.match(text, /\[tool:Bash\] \{"command":"echo step 39"\}/);
		assert.doesNotMatch(text, /step 2\d\b/); // only the bounded tail, not the whole run
		assert.match(text, /full: true for the retained transcript/);
		assert.ok(text.length < 2500);
		// Items are one clipped line each: a huge tool input cannot flood the summary.
		worker.transcript.push({ kind: "system", text: "x".repeat(50_000) });
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		const line = text.split("\n").find((l: string) => l.includes("xxxxx"));
		assert.ok(line && line.length <= 200, `activity line not clipped: ${line?.length}`);
		// Partial assistant prose still wins over the activity tail while running.
		worker.output = "partial answer so far";
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\npartial answer so far$/);
		// A settled worker keeps the final-answer wording the completion message quotes.
		worker.output = "";
		worker.status = "waiting";
		worker.transcript = [];
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\(no output for this task\)$/);
	} finally { await h.close(); }
});

test("backend validation is atomic across mixed batches and fails closed without registration", async () => {
	const h = harness();
	const created: any[] = [];
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code" }), /unavailable backend/);
		h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), version: 2 });
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code" }), /unavailable backend/);
		h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "claude-code", model: "invalid" }] }), /Invalid Claude model/);
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "claude", backend: "claude-code" }, { prompt: "pi", model: "missing/model" }] }), /Unknown model/);
		assert.equal(h.workers.length, 0); assert.equal(created.length, 0);
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "x" }], backend: "pi" }), /Shorthand/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backendOptions: {} }), /not supported/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", fork: true }), /Unsupported/);
		await h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "claude-code", model: "opus" }] });
		assert.equal(h.workers.length, 1); assert.equal(created.length, 1);
	} finally { await h.close(); }
});

test("model policy disables providers and models for spawns, teams and discovery", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-policy-harness-"));
	const policyFile = path.join(dir, "settings.json");
	const writePolicy = (providers: string[], models: string[]) =>
		fs.writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: providers, disabledModels: models }));
	const h = harness(eventBus(), { policyFile });
	const created: any[] = [];
	h.ctx.modelRegistry.getAvailable = () => [
		{ provider: "test", id: "model", name: "Test Model" },
		{ provider: "zai", id: "glm-5.3", name: "GLM" },
	];
	const backend = { ...fakeBackend(created), listModels: async () => [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }] };
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		// No policy file yet: everything is spawnable and discoverable.
		let models = await h.call("agent_models", {});
		assert.deepEqual(models.details.models.map((m: any) => m.id).sort(), ["opus", "sonnet", "test/model", "zai/glm-5.3"]);
		await h.call("agent_spawn", { prompt: "control", wake: false });
		assert.equal(h.workers.length, 1);

		// Disabled pi model: explicit picks, and the inherited parent model, are rejected with a reason.
		writePolicy([], ["test/model"]);
		await assert.rejects(h.call("agent_spawn", { prompt: "explicit", model: "test/model", wake: false }), /test\/model is disabled as a subagent model/);
		await assert.rejects(h.call("agent_spawn", { prompt: "inherits parent", wake: false }), /test\/model is disabled as a subagent model/);

		// Disabled provider: any model of that provider is rejected, and hidden from discovery.
		writePolicy(["zai"], []);
		await assert.rejects(h.call("agent_spawn", { prompt: "provider gone", model: "zai/glm-5.3", wake: false }), /Provider zai is disabled/);
		models = await h.call("agent_models", {});
		assert.deepEqual(models.details.models.map((m: any) => m.id).sort(), ["opus", "sonnet", "test/model"]);

		// Backend-level rules: a disabled backend id rejects model-less specs (their default is
		// still that provider's model) and explicit ones; single backend models can be disabled
		// under the "backend/model" spelling while the backend stays allowed.
		writePolicy(["claude-code"], []);
		await assert.rejects(h.call("agent_spawn", { prompt: "default model", backend: "claude-code", wake: false }), /Backend claude-code is disabled/);
		await assert.rejects(h.call("agent_spawn", { prompt: "explicit model", backend: "claude-code", model: "sonnet", wake: false }), /Backend claude-code is disabled/);
		writePolicy([], ["claude-code/opus"]);
		await assert.rejects(h.call("agent_spawn", { prompt: "opus gone", backend: "claude-code", model: "Opus", wake: false }), /Opus is disabled/);
		await h.call("agent_spawn", { prompt: "sonnet stays", backend: "claude-code", model: "sonnet", wake: false });
		models = await h.call("agent_models", { backend: "claude-code" });
		assert.deepEqual(models.details.models.map((m: any) => m.id), ["sonnet"]);

		// The team path shares spawnBatch, so a disabled member model is rejected there too.
		writePolicy([], ["claude-code/sonnet"]);
		await assert.rejects(
			h.call("team_create", { name: "blocked", objective: "o", members: [{ role: "r", prompt: "p", backend: "claude-code", model: "sonnet" }] }),
			/sonnet is disabled/,
		);

		// Nothing but the two allowed controls ever started.
		assert.equal(h.workers.length, 1);
		assert.equal(created.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		await h.close();
	}
});

for (const killThrows of [false, true]) test(`factory failure rolls back the entire mixed batch (kill throws: ${killThrows})`, async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const create = backend.create;
	let release!: () => void;
	const cleanupGate = new Promise<void>(resolve => { release = resolve; });
	backend.create = (options, handlers) => {
		if (created.length === 2) throw new Error("later factory failed");
		const worker: any = create(options, handlers);
		const cleanup = async () => {
			worker.cleanupStarted = true;
			await cleanupGate;
			worker.status = "killed";
			worker.processAlive = false;
			handlers.onSettled(worker);
			handlers.onExit(worker);
		};
		worker.kill = () => {
			if (killThrows && worker === created[0]) throw new Error("kill failed synchronously");
			return cleanup();
		};
		worker.dispose = cleanup;
		// No callback may escape a batch which has not committed.
		worker.settle();
		assert.equal(h.messages.length, 0);
		return worker;
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		await h.call("agent_spawn", { prompt: "existing worker" });
		let rejected = false;
		const spawning = assert.rejects(h.call("agent_spawn", { agents: [
			{ prompt: "Pi member" }, { prompt: "backend members", backend: backend.id, count: 3 },
		] }), /later factory failed/).then(() => { rejected = true; });
		await Promise.resolve();
		assert.equal(rejected, false, "rollback must await all closures");
		assert.ok(created.every(w => w.cleanupStarted));
		assert.equal((await h.call("agent_list")).details.agents.length, 1);
		release(); await spawning;
		assert.equal(h.workers[0].status, "running", "pre-existing worker untouched");
		assert.equal(h.workers[1].status, "killed");
		assert.ok(created.every(w => w.status === "killed" && !w.processAlive));
		created.forEach(w => w.settle()); // even late callbacks from rollback are ignored
		assert.equal(h.messages.length, 0); assert.equal(h.notices.length, 0);
		const listed = await h.call("agent_list");
		assert.equal((listed.content[0].text.match(/run_\d+ —/g) ?? []).length, 1);
		assert.deepEqual(listed.details.retention, { maxFinished: 50, evictedWorkers: 0, evictedRuns: 0 });
		const next = await h.call("agent_spawn", { prompt: "next" });
		assert.equal(next.details.spawned[0].id, "ag_06");
		assert.equal(next.details.groupId, "run_03");
	} finally { release(); await h.close(); }
});

for (const throwsAfterCallback of [false, true]) test(`constructor settlement waits for registration (factory throws: ${throwsAfterCallback})`, async () => {
	const h = harness();
	const backend = fakeBackend([]);
	backend.create = (options, handlers) => {
		const worker = new SubagentRunner({ ...options, spawnImpl: () => { throw new Error("synchronous spawn failure"); } }, handlers);
		assert.equal(worker.status, "error");
		assert.equal(h.messages.length, 0, "no wake before registration");
		assert.equal(h.notices.length, 0);
		if (throwsAfterCallback) throw new Error("factory failed after callback");
		return worker;
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		const spawning = h.call("agent_spawn", { prompt: "task", backend: backend.id });
		if (throwsAfterCallback) {
			await assert.rejects(spawning, /factory failed after callback/);
			assert.equal((await h.call("agent_list")).details.agents.length, 0);
			assert.equal(h.messages.length, 0); assert.equal(h.notices.length, 0);
		} else {
			const result = await spawning;
			assert.equal(result.details.spawned[0].id, "ag_01");
			assert.equal(h.messages.length, 1); assert.equal(h.notices.length, 1);
			assert.match(h.messages[0][0].content, /synchronous spawn failure/);
			assert.equal(h.messages[0][1].triggerTurn, true);
			assert.equal((await h.call("agent_list")).details.agents[0].status, "error");
		}
	} finally { await h.close(); }
});

test("rollback attempts every worker and retains failed cleanup ownership for shutdown", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const create = backend.create;
	backend.create = (options, handlers) => {
		if (created.length === 2) throw new Error("factory failure");
		const worker: any = create(options, handlers);
		worker.kill = () => { throw new Error("kill failure"); };
		worker.dispose = async () => {
			worker.disposeCalls = (worker.disposeCalls ?? 0) + 1;
			if (worker.disposeCalls === 1) throw new Error("dispose failure");
			worker.status = "killed"; worker.processAlive = false;
			handlers.onSettled(worker); handlers.onExit(worker);
		};
		return worker;
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "task", backend: backend.id, count: 3 }), /factory failure.*rollback cleanup failed.*ag_01.*ag_02/);
		assert.ok(created.every(w => w.disposeCalls === 1));
		assert.equal((await h.call("agent_list")).details.agents.length, 0);
		assert.equal(h.messages.length, 0);
		await h.close();
		assert.ok(created.every(w => w.disposeCalls === 2 && !w.processAlive));
		assert.equal(h.messages.length, 0);
	} finally { await h.close(); }
});

test("backend prepare receives the same resolved cwd as its worker", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const preparedCwds: string[] = [];
	backend.prepare = (spec) => { preparedCwds.push(spec.cwd!); return {}; };
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		await h.call("agent_spawn", { prompt: "task", backend: "claude-code", cwd: "extensions" });
		await h.call("agent_spawn", { prompt: "task", backend: "claude-code" });
		assert.deepEqual(preparedCwds, [path.resolve(h.ctx.cwd, "extensions"), h.ctx.cwd]);
		assert.deepEqual(created.map(w => w.cwd), preparedCwds);
	} finally { await h.close(); }
});

for (const handleFirst of [true, false]) {
	test(`monitor opened during backend dialog synchronizes visibility (handle first: ${handleFirst})`, async () => {
		const h = harness();
		const visibility: boolean[] = [];
		let focusCount = 0;
		h.ctx.ui.custom = (factory: any, options: any) => new Promise((resolve) => {
			const handle = { setHidden: (hidden: boolean) => visibility.push(hidden), focus: () => focusCount++ };
			if (handleFirst) options.onHandle(handle);
			factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
			if (!handleFirst) options.onHandle(handle);
		});
		try {
			h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "already-open", open: true });
			const opened = h.commands.get("agents").handler("", h.ctx);
			assert.deepEqual(visibility, [true]);
			assert.equal(focusCount, 0);
			h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "already-open", open: false });
			assert.deepEqual(visibility, [true, false]);
			assert.equal(focusCount, 1);
			await h.close(); await opened;
		} finally { await h.close(); }
	});
}

test("finished retention is bounded, preserves live/idle and wait references, and never aliases old IDs", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "idle" }, { prompt: "live" }, { prompt: "selected" }] });
		h.workers[0].settle();
		const selected = h.workers[2];
		selected.output = "selected result survives eviction";
		const waiting = h.call("agent_wait", { ids: [selected.id] });
		selected.settle(undefined, "done");
		for (let i = 0; i < 55; i++) {
			await h.call("agent_spawn", { prompt: `task ${i}` });
			h.workers.at(-1).settle(undefined, i % 2 ? "killed" : "done");
		}
		const listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 52);
		assert.deepEqual(listed.details.agents.slice(0, 2).map((a: any) => a.status), ["waiting", "running"]);
		assert.deepEqual(listed.details.retention, { maxFinished: 50, evictedWorkers: 6, evictedRuns: 5 });
		assert.match(listed.content[0].text, /6 finished worker\(s\).*5 empty run\(s\) evicted cumulatively/);
		assert.equal((listed.content[0].text.match(/run_\d+ —/g) ?? []).length, 51);
		const waited = await waiting;
		assert.match(waited.content[0].text, /selected result survives eviction/);
		assert.doesNotMatch(waited.content[0].text, /\[Retention:/);
		assert.deepEqual(waited.details.retention, listed.details.retention);
		const models = await h.call("agent_models", { backend: "pi" });
		assert.doesNotMatch(models.content[0].text, /\[Retention:/);
		assert.deepEqual(models.details.retention, listed.details.retention);
		const controller = new AbortController();
		const liveWait = h.call("agent_wait", { ids: [h.workers[1].id] }, controller.signal);
		assert.doesNotMatch(h.updates.at(-1).content[0].text, /\[Retention:/);
		assert.deepEqual(h.updates.at(-1).details.retention, listed.details.retention);
		controller.abort();
		assert.doesNotMatch((await liveWait).content[0].text, /\[Retention:/);
		assert.equal(h.messages.length, 57); // idle + selected + all 55 completions
		assert.ok(h.messages.some(m => m[0].content.includes("selected result survives eviction")));
		await h.call("agent_spawn", { prompt: "new", name: selected.id, groupLabel: "run_02" });
		assert.equal(h.workers.at(-1).id, "ag_59");
		await assert.rejects(h.call("agent_transcript", { id: selected.id }), /unavailable.*6 finished worker/);
		await assert.rejects(h.call("agent_kill", { group: "run_02" }), /unavailable.*5 empty run/);
		await assert.rejects(h.call("agent_transcript", { id: "missing-name" }), /No such subagent: missing-name.*6 finished worker/);
		await assert.rejects(h.call("agent_kill", { group: "missing-label" }), /No such run: missing-label.*5 empty run/);
		assert.equal(h.workers.at(-1).status, "running");
	} finally { await h.close(); }
});

test("exit-only completion prunes finished workers and failed factories leave no empty runs", async () => {
	const h = harness();
	let view: any;
	h.ctx.ui.custom = (factory: any) => new Promise(resolve => {
		view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
	});
	const backend = fakeBackend([]);
	backend.create = () => { throw new Error("factory failed"); };
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		for (let i = 0; i < 55; i++) {
			await assert.rejects(h.call("agent_spawn", { prompt: "bad", backend: "claude-code" }), /factory failed/);
			await h.call("agent_spawn", { prompt: "task" });
			h.workers.at(-1).exit();
		}
		const opened = h.commands.get("agents").handler("", h.ctx);
		assert.equal(view.host.getGroups().length, 50);
		assert.ok(view.host.getGroups().every((g: any) => g.agents.length === 1));
		const listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 50);
		assert.deepEqual(listed.details.retention, { maxFinished: 50, evictedWorkers: 5, evictedRuns: 5 });
		await h.close(); await opened;
	} finally { await h.close(); }
});

test("exit events retain completion order within one refresh interval", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task", count: 3 });
		// No refresh/context scan between these exits; spawn order is the reverse.
		h.workers[2].exit();
		h.workers[1].exit();
		h.workers[0].exit();
		for (let i = 0; i < 49; i++) {
			await h.call("agent_spawn", { prompt: "later" });
			h.workers.at(-1).exit();
		}
		const listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 50);
		assert.ok(listed.details.agents.some((a: any) => a.id === "ag_01"));
		assert.ok(!listed.details.agents.some((a: any) => ["ag_02", "ag_03"].includes(a.id)));
		assert.deepEqual(listed.details.retention, { maxFinished: 50, evictedWorkers: 2, evictedRuns: 0 });
		// Late callbacks must not reinsert or announce an evicted reference.
		h.workers[2].exit();
		const messages = h.messages.length;
		h.workers[2].settle(undefined, "done");
		assert.equal(h.messages.length, messages);
		assert.deepEqual((await h.call("agent_list")).details.retention, listed.details.retention);
	} finally { await h.close(); }
});

test("constructor exit callbacks do not retain unregistered workers", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const create = backend.create;
	backend.create = (options, handlers) => {
		const worker = create(options, handlers);
		worker.status = "killed";
		worker.processAlive = false;
		handlers.onExit(worker);
		throw new Error("failed before registration");
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		for (let i = 0; i < 51; i++) {
			await assert.rejects(h.call("agent_spawn", { prompt: "bad", backend: backend.id }), /failed before registration/);
		}
		await h.call("agent_spawn", { prompt: "valid" });
		const listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 1);
		assert.equal(listed.details.agents[0].id, h.workers[0].id);
		assert.deepEqual(listed.details.retention, { maxFinished: 50, evictedWorkers: 0, evictedRuns: 0 });
	} finally { await h.close(); }
});

test("missing cwd reports the resolved working directory before starting any worker", async () => {
	const h = harness();
	const cwd = "definitely-missing-subagent-cwd-847392";
	try {
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "valid" }, { prompt: "bad", cwd }] }), (error: Error) => {
			assert.ok(error.message.startsWith(`Cannot access working directory ${path.resolve(h.ctx.cwd, cwd)}:`));
			return true;
		});
		assert.equal(h.workers.length, 0);
		await assert.rejects(h.call("agent_spawn", { prompt: "bad", cwd: "extensions/subagents/index.ts" }), /Not a directory:/);
	} finally { await h.close(); }
});

test("retention orders by finish rather than spawn and does not evict a process still alive", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "old but finishes last" });
		await h.call("agent_spawn", { prompt: "cleanup pending" });
		h.workers[1].processAlive = true;
		h.workers[1].settle("failure", "error");
		for (let i = 0; i < 50; i++) {
			await h.call("agent_spawn", { prompt: "short task" });
			h.workers.at(-1).settle(undefined, "done");
		}
		h.workers[0].settle(undefined, "done");
		let listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 51);
		assert.ok(listed.details.agents.some((a: any) => a.id === "ag_01"));
		assert.ok(listed.details.agents.some((a: any) => a.id === "ag_02"));
		await assert.rejects(h.call("agent_transcript", { id: "ag_03" }), /unavailable/);
		h.workers[1].processAlive = false;
		listed = await h.call("agent_list");
		assert.equal(listed.details.agents.length, 50);
		assert.equal(listed.details.retention.evictedWorkers, 2);
	} finally { await h.close(); }
});

test("backend registration cannot replace Pi or hijack another backend", async () => {
	const h = harness();
	const first: any[] = [], second: any[] = [];
	try {
		h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(second), id: "pi" });
		h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(first));
		h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(second));
		await h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "claude-code" }] });
		assert.equal(h.workers.length, 1); assert.equal(first.length, 1); assert.equal(second.length, 0);
	} finally { await h.close(); }
});

test("registerBackend ignores incompatible discovery and unsubscribes", () => {
	const bus = eventBus(); let announcements = 0;
	bus.on(BACKEND_REGISTER_EVENT, () => announcements++);
	const off = registerBackend(bus as any, fakeBackend([]));
	assert.equal(announcements, 1);
	bus.emit(BACKEND_DISCOVER_EVENT, { version: 2 }); assert.equal(announcements, 1);
	bus.emit(BACKEND_DISCOVER_EVENT, { version: 1 }); assert.equal(announcements, 2);
	off(); bus.emit(BACKEND_DISCOVER_EVENT, { version: 1 }); assert.equal(announcements, 2);
});

test("spawn is non-blocking and inherits current parent model and effort", async () => {
	const h = harness();
	try {
		const r = await h.call("agent_spawn", { prompt: "task" });
		assert.equal(h.workers[0].status, "running");
		assert.equal(h.workers[0].model, "test/model");
		assert.equal(h.workers[0].effort, "high");
		assert.deepEqual(h.workers[0].tools, ["read", "bash"]);
		assert.equal(r.details.spawned[0].id, "ag_01");
	} finally {
		await h.close();
	}
});

test("batch validates before any process starts", async () => {
	const h = harness();
	try {
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "valid" }, { prompt: "bad", tools: ["agent_spawn"] }] }),
			/built-in/,
		);
		assert.equal(h.workers.length, 0);
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "valid" }, { prompt: "bad", model: "missing/model" }] }),
			/Unknown model/,
		);
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("empty allowlist remains empty and relative cwd resolves against parent", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task", tools: [], cwd: "." });
		assert.deepEqual(h.workers[0].tools, []);
		assert.equal(h.workers[0].cwd, path.resolve(h.ctx.cwd));
	} finally {
		await h.close();
	}
});

test("reject ambiguous spawn modes, fractions, missing definitions and blank tasks", async () => {
	const h = harness();
	try {
		for (const params of [
			{},
			{ prompt: "x", agents: [{ prompt: "x" }] },
			{ prompt: "x", count: 1.5 },
			{ prompt: "x", count: 9 },
			{ prompt: " " },
			{ agents: [{ prompt: "x", agentType: "../outside" }] },
			{ agents: [{ prompt: "x", agentType: "definitely-does-not-exist-734892" }] },
			{ agents: [{ prompt: "x" }], model: "test/model" },
		]) {
			await assert.rejects(h.call("agent_spawn", params));
		}
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("live cap includes waiting workers", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x", count: 8 });
		await h.call("agent_spawn", { prompt: "x", count: 4 });
		h.workers.forEach((w) => w.settle());
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /cap/);
	} finally {
		await h.close();
	}
});

test("agent IDs win over names; duplicate names require IDs", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", {
			agents: [
				{ prompt: "x", name: "ag_02" },
				{ prompt: "y", name: "same" },
				{ prompt: "z", name: "same" },
			],
		});
		await h.call("agent_steer", { id: "ag_02", message: "new" });
		assert.equal(h.workers[0].steerCount, 0);
		assert.equal(h.workers[1].steerCount, 1);
		await assert.rejects(h.call("agent_transcript", { id: "same" }), /Ambiguous/);
	} finally {
		await h.close();
	}
});

test("wait handles success, task failure, and timeout without killing workers", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		let r = await h.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 0 });
		assert.equal(r.details.timedOut, true);
		assert.equal(h.workers[0].status, "running");
		h.workers[0].settle("provider failed");
		r = await h.call("agent_wait", { ids: ["ag_01"] });
		assert.equal(r.details.timedOut, false);
		assert.match(r.content[0].text, /provider failed/);
		assert.equal(h.notices.at(-1)[1], "warning");
		h.workers[0].settle();
		assert.equal(h.notices.at(-1)[1], "info");
	} finally {
		await h.close();
	}
});

test("abort interrupts wait promptly but does not stop worker", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		const controller = new AbortController();
		const waiting = h.call("agent_wait", { ids: ["ag_01"] }, controller.signal);
		assert.equal(h.updates.length, 1);
		assert.match(h.updates[0].content[0].text, /Waiting: ag_01/);
		controller.abort();
		const r = await waiting;
		assert.equal(r.details.cancelled, true);
		assert.equal(h.workers[0].status, "running");
	} finally {
		await h.close();
	}
});

test("pre-aborted spawn starts no workers", async () => {
	const h = harness();
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }, AbortSignal.abort()));
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("kill selectors are exclusive and termination is awaited", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		await assert.rejects(h.call("agent_kill", { id: "ag_01", all: true }), /exactly one/);
		await h.call("agent_kill", { id: "ag_01" });
		assert.equal(h.workers[0].status, "killed");
	} finally {
		await h.close();
	}
});

test("shutdown awaits children and suppresses late notifications", async () => {
	const h = harness();
	await h.call("agent_spawn", { prompt: "x" });
	await h.close();
	assert.equal(h.workers[0].disposed, true);
	h.workers[0].settle();
	assert.equal(h.messages.length, 0);
	assert.equal(h.notices.length, 0);
	await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /shutting down/);
});

test("reload does not reuse IDs from this version or older tool results", async () => {
	const h = harness();
	try {
		h.ctx.sessionManager.getEntries = () => [
			{ type: "custom", customType: "subagents-counters-v2", data: { agentCounter: 5, groupCounter: 2 } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent_spawn",
					details: { groupId: "run_04", spawned: [{ id: "ag_07" }] },
				},
			},
		];
		await h.start();
		const r = await h.call("agent_spawn", { prompt: "x" });
		assert.equal(r.details.groupId, "run_05");
		assert.equal(h.workers[0].id, "ag_08");
	} finally {
		await h.close();
	}
});

test("large output is truncated with a private complete snapshot", () => {
	const original = "🌍".repeat(20000);
	const output = boundedText(original);
	const match = output.match(/Full snapshot: (.+)\]/);
	assert.ok(match);
	try {
		assert.equal(fs.readFileSync(match[1], "utf8"), original);
		assert.equal(fs.statSync(match[1]).mode & 0o777, 0o600);
		assert.ok(Buffer.byteLength(output) < 52000);
	} finally {
		fs.rmSync(path.dirname(match[1]), { recursive: true });
	}
});

/** A report-shaped answer of about `chars` characters: numbered lines, some multibyte, a unique last line. */
const longAnswer = (chars: number) => {
	const lines: string[] = [];
	for (let i = 0, n = 0; n < chars; i++) {
		const line = i % 7 ? `- finding ${i}: the parser keeps line ${i} verbatim` : `## Section ${i} — naïve café 🌍`;
		lines.push(line);
		n += line.length + 1;
	}
	return `${lines.join("\n")}\nEND OF REPORT`;
};
/** The Claude Code CLI swaps any MCP tool result longer than this for a 2 KB preview. */
const CLI_TOOL_RESULT_CHARS = 50_000;

test("agent_transcript pages a 60 KB final answer whole; each page fits the CLI's tool-result limit", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		worker.output = longAnswer(60_000);
		worker.settle();
		let pages = "";
		let params: any = { id: worker.id };
		for (let calls = 0; calls < 10; calls++) {
			const r = await h.call("agent_transcript", params);
			const text: string = r.content[0].text;
			assert.ok(text.length < CLI_TOOL_RESULT_CHARS, `page text is ${text.length} chars`);
			const range = text.match(/\n\[Final answer: ([\d,]+) chars; this page is chars [\d,]+–[\d,]+; (?:next page: agent_transcript \{"id":"ag_01","offset":(\d+)\}|end of answer)\.\]\n/);
			assert.ok(range, "a paged answer names its size, range and next offset");
			assert.equal(Number(range[1].replace(/,/g, "")), worker.output.length);
			pages += text.slice(range.index! + range[0].length);
			if (!range[2]) break;
			assert.equal(r.details.finalAnswer.nextOffset, Number(range[2]));
			params = { id: worker.id, offset: Number(range[2]) };
		}
		assert.equal(pages, worker.output);
		// An explicit small range works the same way and states it.
		const r = await h.call("agent_transcript", { id: worker.id, offset: 5, limit: 10 });
		assert.ok(r.content[0].text.endsWith(`\n${worker.output.slice(5, 15)}`));
		assert.deepEqual(r.details.finalAnswer, { total: worker.output.length, offset: 5, end: 15, nextOffset: 15 });
	} finally { await h.close(); }
});

test("full transcript leads with the snapshot path and the whole final answer despite 100 KB of tool traffic", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		const answer = longAnswer(20_000);
		worker.output = answer;
		worker.transcript = [
			{ kind: "task", text: "investigate" },
			...Array.from({ length: 100 }, (_, i) => ({ kind: "tool", toolName: "Bash", text: `cat file${i}\n${"x".repeat(1_000)}` })),
			{ kind: "assistant", text: answer },
		];
		worker.settle();
		const text: string = (await h.call("agent_transcript", { id: worker.id, full: true })).content[0].text;
		assert.ok(text.length < CLI_TOOL_RESULT_CHARS, `full text is ${text.length} chars`);
		assert.ok(text.includes(answer), "the final answer is whole");
		const snapshot = text.slice(0, 300).match(/Full snapshot: (\S+)\]/);
		assert.ok(snapshot, "the snapshot path is within the first 300 chars");
		try {
			const saved = fs.readFileSync(snapshot[1], "utf8");
			assert.ok(saved.includes("cat file99\n") && saved.endsWith(`[assistant] ${answer}`), "the snapshot keeps every retained item");
		} finally { fs.rmSync(path.dirname(snapshot[1]), { recursive: true }); }
	} finally { await h.close(); }
});

test("a cut completion message keeps its trailer last and names a file holding the whole answer", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task" });
		const worker = h.workers[0];
		const answer = longAnswer(20_000);
		worker.output = answer;
		worker.settle();
		const content: string = h.messages[0][0].content;
		// Sova's report parser (server/reports.ts) anchors on this trailer at the very end.
		assert.ok(content.endsWith("\n[Use agent_transcript for more.]"));
		const file = content.match(/^\[Final answer: ([\d,]+) chars, whole in (\S+); or page it with agent_transcript \{"id":"ag_01","offset":0\}\.\]$/m);
		assert.ok(file, "the size/path line precedes the trailer");
		assert.equal(Number(file[1].replace(/,/g, "")), answer.length);
		try {
			assert.equal(fs.readFileSync(file[2], "utf8"), answer);
			assert.equal(fs.statSync(file[2]).mode & 0o777, 0o600);
		} finally { fs.rmSync(path.dirname(file[2]), { recursive: true }); }
		// A message that fits is sent as is: no file, no trailer.
		worker.output = "short";
		worker.settle();
		assert.doesNotMatch(h.messages[1][0].content, /Final answer:|agent_transcript/);
	} finally { await h.close(); }
});

test("a settled worker wakes an idle parent by default; wake:false and kills only queue", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b", wake: false }, { prompt: "c" }] });
		assert.equal(h.workers[0].wake, true);
		assert.equal(h.workers[1].wake, false);
		h.workers[0].settle();
		h.workers[1].settle();
		h.workers[2].settle("stopped", "killed");
		assert.equal(h.messages.length, 3);
		assert.deepEqual(
			h.messages.map((m) => m[1]),
			[
				{ deliverAs: "followUp", triggerTurn: true },
				{ deliverAs: "followUp", triggerTurn: false },
				{ deliverAs: "followUp", triggerTurn: false },
			],
		);
		assert.equal(h.messages[0][0].customType, "subagent-complete");
	} finally {
		await h.close();
	}
});

test("fork needs a persisted parent session and passes its file to the child", async () => {
	const h = harness();
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "task", fork: true }), /persisted parent session/);
		assert.equal(h.workers.length, 0);
		const dir = fs.mkdtempSync(path.join(process.cwd(), ".fork-test-"));
		const file = path.join(dir, "session.jsonl");
		try {
			fs.writeFileSync(file, "{}\n");
			h.ctx.sessionManager.getSessionFile = () => file;
			const r = await h.call("agent_spawn", { prompt: "task", fork: true });
			assert.equal(h.workers[0].forkSession, file);
			assert.equal(h.workers[0].forked, true);
			assert.match(r.content[0].text, /forked/);
			await h.call("agent_spawn", { prompt: "fresh" });
			assert.equal(h.workers[1].forkSession, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		await h.close();
	}
});

test("child extensions: remote sources pass, missing paths fail, this extension is refused", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task", extensions: ["npm:definitely-not-installed-xyz", "git:github.com/x/y"] });
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, "npm:definitely-not-installed-xyz", "git:github.com/x/y"]);
		await assert.rejects(
			h.call("agent_spawn", { prompt: "task", extensions: ["./definitely-missing-extension.ts"] }),
			/not found/,
		);
		const self = path.join(path.dirname(new URL(import.meta.url).pathname), "index.ts");
		await assert.rejects(h.call("agent_spawn", { prompt: "task", extensions: [self] }), /do not nest/);
		await assert.rejects(
			h.call("agent_spawn", { prompt: "task", extensions: [path.dirname(self)] }),
			/do not nest/,
		);
		assert.equal(h.workers.length, 1);
		// Whole-batch validation: a bad source in the second spec starts nothing.
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "ok" }, { prompt: "bad", extensions: [self] }] }),
			/do not nest/,
		);
		assert.equal(h.workers.length, 1);
	} finally {
		await h.close();
	}
});

test("installed npm and git sources map to Pi's user-scope directories; others pass through", () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), ".pkg-test-"));
	try {
		fs.mkdirSync(path.join(dir, "npm", "node_modules", "@scope", "name"), { recursive: true });
		fs.mkdirSync(path.join(dir, "npm", "node_modules", "plain"), { recursive: true });
		fs.mkdirSync(path.join(dir, "git", "github.com", "owner", "repo"), { recursive: true });
		assert.equal(installedPackageDir("npm:plain", dir), path.join(dir, "npm", "node_modules", "plain"));
		assert.equal(installedPackageDir("npm:plain@1.2.3", dir), undefined); // no manifest
		fs.writeFileSync(path.join(dir, "npm", "node_modules", "plain", "package.json"), JSON.stringify({ name: "plain", version: "1.2.3" }));
		assert.equal(installedPackageDir("npm:plain@1.2.3", dir), path.join(dir, "npm", "node_modules", "plain"));
		for (const pin of ["1.2.4", "^1.2.3", "~1.2.3", "1", "1.2", "latest", "*", ""]) {
			assert.equal(installedPackageDir(`npm:plain@${pin}`, dir), undefined, pin);
		}
		const scopedManifest = path.join(dir, "npm", "node_modules", "@scope", "name", "package.json");
		fs.writeFileSync(scopedManifest, JSON.stringify({ name: "@scope/name", version: "2.0.0-beta.1" }));
		assert.equal(installedPackageDir("npm:@scope/name@2.0.0-beta.1", dir), path.dirname(scopedManifest));
		assert.equal(installedPackageDir("npm:@scope/name@2", dir), undefined);
		fs.writeFileSync(scopedManifest, "invalid json");
		assert.equal(installedPackageDir("npm:@scope/name@2.0.0-beta.1", dir), undefined);
		fs.writeFileSync(scopedManifest, JSON.stringify({ name: "wrong", version: "2.0.0" }));
		assert.equal(installedPackageDir("npm:@scope/name@2.0.0", dir), undefined);
		for (const pin of ["v1", "main", "abc123", "refs/tags/v1"]) {
			// Even a coincidentally named installed directory is not ref verification.
			fs.mkdirSync(path.join(dir, "git", "github.com", "owner", `repo@${pin}`), { recursive: true });
			assert.equal(installedPackageDir(`git:github.com/owner/repo@${pin}`, dir), undefined);
			assert.equal(installedPackageDir(`git:github.com/owner/repo.git@${pin}`, dir), undefined);
		}
		assert.equal(installedPackageDir("git:github.com/owner/repo", dir), path.join(dir, "git", "github.com", "owner", "repo"));
		assert.equal(installedPackageDir("git:github.com/owner/repo.git", dir), path.join(dir, "git", "github.com", "owner", "repo"));
		assert.equal(installedPackageDir("npm:missing", dir), undefined);
		assert.equal(installedPackageDir("git:github.com/owner/other", dir), undefined);
		assert.equal(installedPackageDir("npm:../escape", dir), undefined);
		assert.equal(installedPackageDir("git:github.com/../x", dir), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("cancelled rollback wait returns promptly but ownership lasts until confirmed closure", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const create = backend.create;
	let close!: () => void;
	const closed = new Promise<void>((resolve) => { close = resolve; });
	backend.create = (options, handlers) => {
		if (created.length === 2) throw new Error("factory failure");
		const worker: any = create(options, handlers);
		// Third-party kill resolving before termination must not release ownership.
		worker.kill = async () => { worker.killCalls = (worker.killCalls ?? 0) + 1; };
		worker.whenClosed = closed.then(() => { worker.status = "killed"; worker.processAlive = false; });
		return worker;
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		const controller = new AbortController();
		const spawning = h.call("agent_spawn", { prompt: "task", backend: backend.id, count: 3 }, controller.signal);
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		await assert.rejects(spawning, /factory failure; rollback termination wait cancelled for ag_01, ag_02 \(still owned/);
		assert.ok(created.every((w) => w.killCalls === 1));
		assert.equal((await h.call("agent_list")).details.agents.length, 0, "never published");
		await h.call("agent_spawn", { prompt: "fill", count: 8 });
		await assert.rejects(h.call("agent_spawn", { prompt: "over", count: 3 }), /Live-agent cap is 12 \(10 alive/);
		const killed = await h.call("agent_kill", { all: true });
		assert.equal(killed.details.killed.length, 8, "unpublished IDs are not public targets");
		assert.ok(!killed.details.killed.some((id: string) => ["ag_01", "ag_02"].includes(id)));
		assert.equal(killed.details.rollbackPending, 2);
		assert.match(killed.content[0].text, /2 unpublished worker\(s\) from a failed spawn are still terminating/);
		close(); await closed; await new Promise((r) => setTimeout(r, 0));
		await h.call("agent_spawn", { prompt: "after closure", count: 8 });
		assert.equal((await h.call("agent_kill", { all: true })).details.rollbackPending, 0);
		assert.equal(h.messages.length, 0, "rollback workers never wake the parent");
	} finally { close(); await h.close(); }
});

test("completion wake is sent even when the UI notification throws", async () => {
	const h = harness();
	h.ctx.ui.notify = () => { throw new Error("stale UI"); };
	try {
		await h.call("agent_spawn", { prompt: "task" });
		h.workers[0].output = "RESULT";
		h.workers[0].settle();
		assert.equal(h.messages.length, 1);
		assert.match(h.messages[0][0].content, /RESULT/);
		assert.equal(h.messages[0][1].triggerTurn, true);
	} finally { await h.close(); }
});

test("team_create composes headers before backend validation, commits membership and persists one create entry", async () => {
	const h = harness();
	const created: any[] = [];
	const validated: string[] = [];
	const backend = fakeBackend(created);
	const validate = backend.validate;
	backend.validate = (spec, ctx) => { validated.push(spec.prompt); return validate(spec, ctx); };
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	const snapshots: any[] = [];
	const offSnapshots = h.bus.on("subagents:workers-snapshot", (data) => snapshots.push(data));
	try {
		const r = await h.call("team_create", {
			name: "Alpha",
			objective: "Ship the thing",
			defaults: { backend: "claude-code", model: "opus[1m]", effort: "high" },
			members: [
				{ role: "builder", prompt: "Implement it.", ownedPaths: ["src/api"] },
				{ role: "reviewer", prompt: "Review it.", backend: "pi", wake: false },
			],
		});
		assert.equal(r.details.teamId, "team_01");
		assert.equal(r.details.groupId, "run_01");
		assert.deepEqual(r.details.members, [
			{ workerId: "ag_01", role: "builder", backend: "claude-code", model: "opus[1m]" },
			{ workerId: "ag_02", role: "reviewer", backend: "pi", model: "test/model" },
		]);
		assert.match(r.content[0].text, /Created team_01 \(Alpha\) with 2 member\(s\) in run_01/);
		assert.match(r.content[0].text, /advisory, not a lock/);
		// The composed header reached the backend before its validation ran.
		assert.equal(validated.length, 1);
		assert.ok(validated[0].startsWith([
			"[Team assignment from the parent Pi session]",
			"Team: Alpha (team_01)",
			"Objective: Ship the thing",
			"Your role: builder",
			"Your declared ownership: src/api",
			"Other members at team creation:",
			"- reviewer: none declared",
		].join("\n")));
		assert.ok(validated[0].endsWith("[Your task]\nImplement it."));
		// The pi member never inherits Claude defaults; roles are worker names.
		const reviewer = h.workers[0];
		assert.equal(reviewer.name, "reviewer");
		assert.equal(reviewer.wake, false);
		assert.equal(reviewer.model, "test/model");
		assert.equal(reviewer.effort, "high", "pi members inherit the parent effort, not team defaults");
		assert.match(reviewer.task, /Your role: reviewer/);
		assert.match(reviewer.task, /- builder: src\/api/);
		assert.equal(created[0].name, "builder");
		assert.equal(created[0].model, "opus[1m]");
		assert.equal(created[0].effort, "high");
		// The run cross-references the team in its label.
		const listed = await h.call("agent_list");
		assert.match(listed.content[0].text, /run_01 — team_01 · Alpha/);
		// Exactly one team entry, after the worker-ID reservation entry.
		const teamEntries = h.appended.filter((e) => e.customType === "subagents-team-v1");
		assert.equal(teamEntries.length, 1);
		assert.equal(teamEntries[0].data.version, 1);
		assert.equal(teamEntries[0].data.op, "create");
		assert.deepEqual(
			{ ...teamEntries[0].data.team, createdAt: undefined },
			{ id: "team_01", name: "Alpha", objective: "Ship the thing", createdAt: undefined },
		);
		assert.deepEqual(
			teamEntries[0].data.members.map((m: any) => [m.workerId, m.role, m.backend, m.model, m.groupId, m.ownedPaths]),
			[["ag_01", "builder", "claude-code", "opus[1m]", "run_01", ["src/api"]], ["ag_02", "reviewer", "pi", "test/model", "run_01", []]],
		);
		assert.equal(h.appended.findIndex((e) => e.customType === "subagents-counters-v2") > -1, true);
		assert.ok(h.appended.findIndex((e) => e.customType === "subagents-counters-v2") < h.appended.indexOf(teamEntries[0]));
		// Team members' snapshot rows add only teamId (still version 1); solo workers omit it.
		const committed = snapshots.find((s: any) => s.workers.length === 2);
		assert.deepEqual(committed.workers.map((w: any) => w.teamId), ["team_01", "team_01"], "first published rows already carry teamId");
		await h.call("agent_spawn", { prompt: "plain", wake: false });
		h.bus.emit("subagents:workers-request", { version: 1 });
		assert.equal(snapshots.at(-1).version, 1);
		const rows = snapshots.at(-1).workers;
		const byId = (id: string) => rows.find((w: any) => w.id === id);
		assert.ok(!("teamId" in byId("ag_03")));
		for (const id of ["ag_01", "ag_02"]) {
			assert.equal(byId(id).teamId, "team_01");
			assert.deepEqual(Object.keys(byId(id)).filter((k) => k !== "teamId").sort(), Object.keys(byId("ag_03")).sort(), `snapshot row for ${id} has the plain-worker shape plus teamId`);
			assert.ok(!("role" in byId(id)) && !("ownedPaths" in byId(id)) && !("team" in byId(id)));
		}
	} finally { offSnapshots(); await h.close(); }
});

test("team_create rejects cleanly: no team, no entry, no worker; reserved IDs are never reused", async () => {
	const h = harness();
	const created: any[] = [];
	const backend = fakeBackend(created);
	const original = backend.create;
	backend.create = (options, handlers) => {
		if (created.length === 1) throw new Error("factory failed for second member");
		return original(options, handlers);
	};
	h.bus.emit(BACKEND_REGISTER_EVENT, backend);
	try {
		// Whole-batch schema/shape validation happens inside TeamStore before any spec resolves.
		await assert.rejects(h.call("team_create", { name: "Dup", objective: "o", members: [{ role: "a", prompt: "x" }, { role: " A ", prompt: "y" }] }), /Duplicate role/);
		await assert.rejects(h.call("team_create", { name: "Count", objective: "o", members: [{ role: "a", prompt: "x", count: 2 }] }), /Unsupported team member option count/);
		await assert.rejects(h.call("team_create", { name: "Keys", objective: "o", members: [{ role: "a", prompt: "x" }], defaults: { count: 2 } }), /Unsupported team default count/);
		assert.equal(h.workers.length, 0);
		assert.equal(created.length, 0);
		// Backend validation rejects before any factory runs (pi and claude mixed).
		await assert.rejects(h.call("team_create", {
			name: "Mixed", objective: "o",
			members: [{ role: "one", prompt: "a", backend: "claude-code" }, { role: "two", prompt: "b", model: "missing/model" }],
		}), /Unknown model/);
		assert.equal(h.workers.length, 0);
		assert.equal(created.length, 0);
		// A factory failure after the first member rolls back the whole batch:
		// no team, no entry, no group; the created worker is confirmed terminated.
		await assert.rejects(h.call("team_create", {
			name: "Doomed", objective: "o",
			defaults: { backend: "claude-code" },
			members: [{ role: "one", prompt: "a" }, { role: "two", prompt: "b" }],
		}), /factory failed for second member/);
		assert.equal(created.length, 1);
		assert.equal(created[0].id, "ag_01");
		assert.equal(created[0].status, "killed");
		assert.equal(h.appended.filter((e) => e.customType === "subagents-team-v1").length, 0);
		assert.match((await h.call("team_list")).content[0].text, /No teams/);
		assert.equal((await h.call("agent_list")).details.agents.length, 0);
		assert.equal(h.messages.length, 0, "rolled-back members never wake the parent");
		// Consumed numbers stay consumed within the session: the Mixed validation
		// failure reserved team_01, the rolled-back Doomed reserved team_02.
		const next = await h.call("team_create", { name: "Next", objective: "o", members: [{ role: "solo", prompt: "p" }] });
		assert.equal(next.details.teamId, "team_03");
		assert.equal(next.details.members[0].workerId, "ag_03");
		// The shared live cap applies to team batches before any worker starts.
		await h.call("agent_spawn", { prompt: "slot", count: 8 });
		assert.equal(h.workers.length, 9);
		await assert.rejects(h.call("team_create", {
			name: "Over", objective: "o",
			members: Array.from({ length: 4 }, (_, i) => ({ role: `m${i}`, prompt: "p" })),
		}), /Live-agent cap is 12 \(9 alive/);
		assert.equal(h.workers.length, 9);
	} finally { await h.close(); }
});

test("team_add extends a session team in another run, reuses defaults and persists the addition", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		await h.call("team_create", {
			name: "Core", objective: "obj",
			defaults: { backend: "claude-code", model: "opus[1m]" },
			members: [{ role: "lead", prompt: "start" }],
		});
		const add = await h.call("team_add", { team: "core", members: [{ role: "docs", prompt: "write docs", ownedPaths: ["docs/"] }] });
		assert.equal(add.details.teamId, "team_01");
		assert.equal(add.details.groupId, "run_02", "teams span independent run groups");
		assert.match(add.content[0].text, /Added 1 member\(s\) to team_01 \(Core\) in run_02/);
		assert.deepEqual(add.details.members, [{ workerId: "ag_02", role: "docs", backend: "claude-code", model: "opus[1m]" }]);
		// The joiner's header lists the create-time roster; existing members are never rewritten.
		assert.match(created[1].task, /Other members when you joined:\n- lead: none declared/);
		assert.match(created[1].task, /Your declared ownership: docs\//);
		assert.doesNotMatch(created[0].task, /docs/);
		const adds = h.appended.filter((e) => e.customType === "subagents-team-v1" && e.data.op === "add");
		assert.equal(adds.length, 1);
		assert.equal(adds[0].data.teamId, "team_01");
		assert.deepEqual(adds[0].data.members.map((m: any) => [m.workerId, m.role, m.groupId]), [["ag_02", "docs", "run_02"]]);
		// Roles stay unique against committed members; nothing starts on rejection.
		await assert.rejects(h.call("team_add", { team: "team_01", members: [{ role: " DOCS ", prompt: "again" }] }), /already exists in this team/);
		assert.equal(created.length, 2);
		await assert.rejects(h.call("team_add", { team: "team_09", members: [{ role: "x", prompt: "p" }] }), /No such team: team_09/);
		const list = await h.call("team_list", { team: "team_01" });
		assert.match(list.content[0].text, /team_01 — Core \[this session\] · 2 working/);
		assert.match(list.content[0].text, /ag_01 lead \[claude-code\] working \(running\) · context — · owns: none declared/);
		assert.match(list.content[0].text, /ag_02 docs \[claude-code\] working \(running\) · context — · owns: docs\//);
		assert.deepEqual(list.details.teams.map((t: any) => t.id), ["team_01"]);
	} finally { await h.close(); }
});

test("team history restores read-only from the active branch; counters reserve across every entry", async () => {
	const h = harness();
	const teamEntry = (data: unknown) => ({ type: "custom", customType: "subagents-team-v1", data });
	const old = teamEntry({
		version: 1, op: "create",
		team: { id: "team_04", name: "Old", objective: "past", createdAt: 1 },
		members: [{ workerId: "ag_03", role: "lead", ownedPaths: ["src"], backend: "claude-code", model: "opus", groupId: "run_02", addedAt: 1 }],
	});
	const elsewhere = teamEntry({
		version: 1, op: "create",
		team: { id: "team_06", name: "Elsewhere", objective: "other branch", createdAt: 2 },
		members: [],
	});
	try {
		h.ctx.sessionManager.getEntries = () => [
			{ type: "custom", customType: "subagents-counters-v2", data: { agentCounter: 3, groupCounter: 2 } },
			old,
			elsewhere,
		];
		h.ctx.sessionManager.getBranch = () => [old];
		await h.start();
		let list = await h.call("team_list");
		assert.match(list.content[0].text, /team_04 — Old \[history, read-only\] · 1 unavailable/);
		assert.match(list.content[0].text, /ag_03 lead \[claude-code\] unavailable · owns: src · unavailable: Recorded in an earlier session or before reload/);
		assert.doesNotMatch(list.content[0].text, /Elsewhere/, "teams on other branches are never displayed");
		await assert.rejects(h.call("team_add", { team: "team_04", members: [{ role: "x", prompt: "p" }] }), /history from an earlier session/);
		await assert.rejects(h.call("team_add", { team: "old", members: [{ role: "x", prompt: "p" }] }), /history/);
		assert.equal(h.workers.length, 0, "restored members are never adopted");
		// IDs resume past every persisted entry, including other branches.
		const created = await h.call("team_create", { name: "Fresh", objective: "now", members: [{ role: "solo", prompt: "p" }] });
		assert.equal(created.details.teamId, "team_07");
		assert.equal(created.details.groupId, "run_03");
		assert.equal(created.details.members[0].workerId, "ag_04");
		list = await h.call("team_list");
		assert.match(list.content[0].text, /team_04 — Old \[history, read-only\]/);
		assert.match(list.content[0].text, /team_07 — Fresh \[this session\]/);
		// A tree jump re-reads history; session teams and their members stay put.
		h.ctx.sessionManager.getBranch = () => [teamEntry({
			version: 1, op: "create",
			team: { id: "team_07", name: "Shadow", objective: "stale", createdAt: 3 },
			members: [],
		})];
		h.event("session_tree", {});
		list = await h.call("team_list");
		assert.match(list.content[0].text, /team_07 — Fresh/, "a live team ID is never shadowed by history");
		assert.doesNotMatch(list.content[0].text, /Shadow/);
		assert.doesNotMatch(list.content[0].text, /team_04/, "teams from the abandoned branch disappear");
		assert.equal(h.workers.length, 1);
		assert.equal(h.workers[0].status, "running");
		// Filtering accepts names, lists one team, and rejects the unknown.
		assert.deepEqual((await h.call("team_list", { team: "fresh" })).details.teams.map((t: any) => t.id), ["team_07"]);
		await assert.rejects(h.call("team_list", { team: "missing" }), /No such team: missing/);
	} finally { await h.close(); }
});

test("team_list records bounded control actions and reports pruned members with last known status", async () => {
	const h = harness();
	try {
		await h.call("team_create", { name: "Ops", objective: "obj", members: [{ role: "worker", prompt: "p", wake: false }] });
		const member = h.workers[0];
		await h.call("agent_steer", { id: "ag_01", message: "keep going", mode: "followUp" });
		let list = await h.call("team_list");
		assert.match(list.content[0].text, /#1 parent followUp → ag_01 \(worker\): accepted-or-queued/);
		assert.equal(list.details.teams[0].actions[0].preview, "keep going");
		// Steering a non-member records nothing.
		await h.call("agent_spawn", { prompt: "plain", wake: false });
		await h.call("agent_steer", { id: "ag_02", message: "not a member" });
		assert.equal((await h.call("team_list")).details.teams[0].actions.length, 1);
		// Retention eviction leaves the member unavailable with its last observed state.
		member.settle("boom", "error");
		for (let i = 0; i < 50; i++) {
			await h.call("agent_spawn", { prompt: `filler ${i}`, wake: false });
			h.workers.at(-1).settle(undefined, "done");
		}
		list = await h.call("team_list");
		const view = list.details.teams[0].members[0];
		assert.equal(view.available, false);
		assert.equal(view.availability, "pruned");
		assert.equal(view.state, "unavailable");
		assert.equal(view.status, "error");
		assert.equal(view.reason, "Removed from the manager by finished-worker retention; last known status shown.");
		assert.match(list.content[0].text, /team_01 — Ops \[this session\] · 1 unavailable/);
		assert.match(list.content[0].text, /ag_01 worker \[pi\] unavailable \(error\)/);
		assert.match(list.content[0].text, /error: boom/);
		// Exact pruned IDs stay unavailable to control tools too.
		await assert.rejects(h.call("agent_steer", { id: "ag_01", message: "late" }), /unavailable/);
	} finally { await h.close(); }
});

test("/team opens the team workspace and never sends a message or starts work", async () => {
	const h = harness();
	let view: any;
	let done: (value: null) => void;
	let customCalls = 0;
	h.ctx.ui.custom = (factory: any, options: any) => new Promise((resolve) => {
		customCalls++;
		done = resolve;
		options?.onHandle?.({ setHidden() {}, focus() {} });
		view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
	});
	try {
		assert.ok(h.commands.has("team"));
		// Bare /team opens the workspace overlay; nothing reaches the model.
		const opened = h.commands.get("team").handler("", h.ctx);
		assert.equal(customCalls, 1, "bare /team opens one overlay");
		assert.ok(view, "workspace view created");
		assert.ok(typeof view.render === "function" && typeof view.dispose === "function");
		assert.ok(view.render(100).some((l: string) => /Teams \(0\)/.test(l)), "team workspace renders empty state");
		// Reopening the same workspace is a no-op without a second overlay.
		await h.commands.get("team").handler("", h.ctx);
		assert.equal(customCalls, 1);
		// `/team <objective>` sends exactly one extension-origin planning message
		// (never a user message) and opens no additional overlay.
		h.ctx.isIdle = () => true;
		await h.commands.get("team").handler("plan a refactor", h.ctx);
		assert.equal(customCalls, 1, "planning does not open an overlay");
		assert.equal(h.messages.length, 1, "exactly one planning message");
		const [message, options] = h.messages.at(-1);
		assert.equal(message.customType, "team-plan");
		assert.equal(message.display, true);
		assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
		assert.match(message.content, /plan a refactor/);
		assert.match(message.content, /team_create/);
		assert.doesNotMatch(h.notices.at(-1)?.[0] ?? "", /busy/, "an idle parent is not told it queued");
		assert.equal(h.userMessages.length, 0, "never a user turn");
		assert.equal(h.workers.length, 0);
		// Without a TUI the workspace refuses with a warning, still never sending.
		done!(null); await opened;
		h.ctx.mode = "rpc";
		await h.commands.get("team").handler("", h.ctx);
		assert.equal(customCalls, 1);
		assert.match(h.notices.at(-1)[0], /team workspace.*requires Pi's interactive TUI/);
		assert.equal(h.messages.length, 1, "bare /team in RPC mode sends nothing");
		assert.equal(h.workers.length, 0);
	} finally { await h.close(); }
});

test("/team <objective> while streaming queues the identical followUp and says so; works without a UI", async () => {
	const h = harness();
	h.ctx.isIdle = () => false;
	try {
		await h.commands.get("team").handler("untangle the deploy pipeline", h.ctx);
		assert.equal(h.messages.length, 1);
		const [message, options] = h.messages.at(-1);
		assert.equal(message.customType, "team-plan");
		assert.equal(message.display, true);
		assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true }, "same options whether idle or streaming; triggerTurn is inert while streaming");
		assert.match(message.content, /\[Team planning requested by the user with \/team\]/);
		assert.match(message.content, /Objective: untangle the deploy pipeline/);
		// The message carries the review-mandated instructions: explicit
		// team_create/team_add roles and ownership, obeying the tools, reporting
		// wake/default cost, and the mediated member tools.
		assert.match(message.content, /team_create with a short unique name/);
		assert.match(message.content, /team_add/);
		assert.match(message.content, /explicit unique role/);
		assert.match(message.content, /declared ownedPaths \(advisory/);
		assert.match(message.content, /Obey the team tool descriptions, schemas and limits/);
		assert.match(message.content, /team_msg .* team_ask/);
		assert.match(message.content, /orchestrator: true/);
		assert.match(message.content, /never spawn or stop anyone/);
		assert.match(message.content, /wake=true \(the default\) starts a parent turn/);
		assert.match(message.content, /default to the pi backend inheriting the parent model\/effort/);
		assert.match(h.notices.at(-1)[0], /busy; team planning was queued as a follow-up/);
		assert.equal(h.notices.at(-1)[1], "info");
		assert.equal(h.userMessages.length, 0, "never a user turn");
		assert.equal(h.workers.length, 0);
		// Overlong objectives are bounded to the team objective limit.
		const longObjective = `edge ${"x".repeat(6000)}`;
		await h.commands.get("team").handler(longObjective, h.ctx);
		const longContent = h.messages.at(-1)[0].content;
		assert.ok(longContent.length < longObjective.length, "objective is truncated");
		assert.match(longContent, /truncated to the 4000-character team objective limit/);
		// Without a UI the planning message is still sent; notices are skipped.
		h.ctx.mode = "print";
		h.ctx.hasUI = false;
		h.ctx.isIdle = () => false;
		await h.commands.get("team").handler("plan quietly", h.ctx);
		assert.equal(h.messages.length, 3);
		assert.match(h.messages.at(-1)[0].content, /plan quietly/);
		assert.doesNotMatch(h.notices.at(-1)[0], /plan quietly/, "no notice without a UI");
		assert.equal(h.userMessages.length, 0);
	} finally { await h.close(); }
});

test("team widget installs on refresh with fresh detached views, follows member state, and clears on shutdown", async () => {
	const h = harness();
	const widgetCalls: { key: string; content: any; options: any }[] = [];
	const components: any[] = [];
	h.ctx.ui.setWidget = (key: string, content: any, options: any) => {
		widgetCalls.push({ key, content, options });
		if (typeof content === "function")
			components.push(content({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }));
	};
	try {
		// No teams: the widget key is never installed.
		await h.call("agent_spawn", { prompt: "plain worker", wake: false });
		assert.equal(widgetCalls.length, 0, "no widget without teams");
		// team_create's refresh installs the component-form widget once, above the editor.
		const created = await h.call("team_create", {
			name: "Ops",
			objective: "Ship it",
			members: [{ role: "builder", prompt: "build", ownedPaths: ["src/api"], wake: false }],
		});
		const memberId = created.details.members[0].workerId;
		const member = () => h.workers.find((w: any) => w.id === memberId);
		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].key, "team");
		assert.equal(typeof widgetCalls[0].content, "function", "component form (never string rows)");
		assert.equal(widgetCalls[0].options, undefined, "default placement above the editor");
		assert.equal(components.length, 1);
		const widget = components[0];
		const first = widget.render(100);
		assert.ok(first.some((l: string) => l.includes("◆ Ops (team_01)") && l.includes("1 working")), first.join("\n"));
		assert.ok(first.some((l: string) => l.includes(`● builder [pi] ${memberId} · working`) && l.includes("owns: src/api")), first.join("\n"));
		assert.ok(first.at(-1).includes("session-scoped teams"), "legend row");
		assert.ok(first.every((l: string) => visibleWidth(l) === 100), "every row exactly 100 cells");
		// Later refreshes push fresh, detached views into the same component.
		const pushed: any[] = [];
		const original = widget.update.bind(widget);
		widget.update = (views: any) => { pushed.push(views); original(views); };
		member().settle();
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(pushed.length >= 1, "the throttled refresh pushed views");
		assert.equal(widgetCalls.length, 1, "updates never reinstall the widget");
		const last = pushed.at(-1)[0];
		assert.equal(last.id, "team_01");
		assert.equal(last.members[0].workerId, memberId);
		assert.equal(last.members[0].state, "idle", "failure-aware member state follows the worker");
		assert.ok(pushed.every((v, i) => i === 0 || v !== pushed[i - 1]), "every push is a fresh array");
		// Detached: mutating a pushed view corrupts neither the store nor the widget.
		last.name = "MUTATED";
		last.members[0].role = "MUTATED";
		last.members.length = 0;
		member().change();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(pushed.at(-1)[0].members[0].role, "builder");
		const listed = await h.call("team_list");
		assert.match(listed.content[0].text, new RegExp(`${memberId} builder`));
		const rendered = widget.render(100).join("\n");
		assert.match(rendered, /◐ builder/);
		assert.doesNotMatch(rendered, /MUTATED/);
		// Failure-aware idle: an errored task shows failed, never idle.
		member().settle("boom", "error");
		await new Promise((r) => setTimeout(r, 200));
		const failed = widget.render(100).join("\n");
		assert.match(failed, /1 failed/);
		assert.match(failed, new RegExp(`✗ builder \\[pi\\] ${memberId} · failed`));
		// A backend permission dialog owns the screen: the widget is cleared while
		// any dialog token is open (refreshes never reinstall it) and restored with
		// fresh views when the last token closes.
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "perm", open: true });
		assert.equal(widgetCalls.at(-1)!.key, "team");
		assert.equal(widgetCalls.at(-1)!.content, undefined, "widget hidden while a permission dialog is open");
		member().change();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(widgetCalls.at(-1)!.content, undefined, "refresh cannot reinstall while a dialog is open");
		const restoredBefore = widgetCalls.length;
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "perm", open: false });
		assert.equal(widgetCalls.length, restoredBefore + 1, "restored once the last dialog closes");
		assert.equal(typeof widgetCalls.at(-1)!.content, "function", "widget reinstalled after the dialog");
		const restored = components.at(-1)!;
		assert.ok(restored.render(100).join("\n").includes("Ops"), "restored widget shows fresh views");
		// Shutdown clears the widget key and nothing ever reinstalls it.
		const before = widgetCalls.length;
		await h.close();
		assert.equal(widgetCalls.length, before + 1, "exactly one clear on shutdown");
		assert.equal(widgetCalls.at(-1)!.key, "team");
		assert.equal(widgetCalls.at(-1)!.content, undefined, "widget removed on shutdown");
		member()?.change?.();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(widgetCalls.at(-1)!.content, undefined, "no reinstall after shutdown");
	} finally { await h.close(); }
});

// ── Team member mailbox: cross-communication, orchestrator powers, operator questions ──

/** A team harness with a fast-polled mailbox in a private root the test owns. */
function teamHarness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-index-mailbox-"));
	const h = harness(eventBus(), { mailboxRoot: root, mailboxPollMs: 10 });
	/** Identity of any worker: pi members carry it in env, Claude members in their MCP server's env. */
	const memberOf = (id: string, claude: any[] = []) => {
		const w = [...h.workers, ...claude].find((w: any) => w.id === id);
		return decodeMemberContext(w?.env?.[MEMBER_ENV] ?? w?.mcpServers?.team?.env?.[MEMBER_ENV]);
	};
	/** Act as the member child: enqueue a request in its own directory and wait for the parent's answer. */
	const ask = async (id: string, request: Omit<MailboxRequest, "version" | "id" | "at">, claude: any[] = []) => {
		const me = memberOf(id, claude)!;
		const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
		writeRequest(me.dir, full);
		const response = await awaitResponse(me.dir, full.id, 3000, undefined, 5);
		assert.ok(response, `parent answered ${request.type} from ${id}`);
		return response!;
	};
	return { ...h, root, memberOf, ask, cleanup: async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("team members get a parent-issued identity, private mailbox and only the member extension; Claude members get the tools through an MCP server", async () => {
	const h = teamHarness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), id: "other" });
	try {
		await assert.rejects(
			h.call("team_create", { name: "Bad", objective: "o", members: [{ role: "lead", prompt: "t", orchestrator: true, backend: "other" }] }),
			/must use the pi or claude-code backend/,
		);
		assert.equal(h.workers.length + created.length, 0);
		const r = await h.call("team_create", {
			name: "Crew", objective: "Ship", members: [
				{ role: "lead", prompt: "coordinate", orchestrator: true, tools: ["read"] },
				{ role: "dev", prompt: "build", ownedPaths: ["src"] },
				{ role: "writer", prompt: "document", backend: "claude-code" },
			],
		});
		assert.match(r.content[0].text, /ag_01  lead \(orchestrator\)  running/);
		assert.match(r.content[0].text, /team_msg\/team_inbox\/team_ask/);
		assert.deepEqual(r.details.members.map((m: any) => [m.workerId, m.orchestrator]), [["ag_01", true], ["ag_02", undefined], ["ag_03", undefined]]);
		const lead = h.workers.find((w: any) => w.id === "ag_01");
		const dev = h.workers.find((w: any) => w.id === "ag_02");
		assert.deepEqual(lead.extensions, [MARKER_EXTENSION, MEMBER_EXTENSION], "the marker, then member.ts, never the manager");
		assert.deepEqual(lead.tools, ["read"], "the built-in allowlist is unchanged; the runner restricts by exclusion when extensions are present");
		const me = h.memberOf("ag_01")!;
		assert.deepEqual({ ...me, dir: undefined }, { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_01", role: "lead", orchestrator: true, dir: undefined });
		assert.equal(me.dir, path.join(h.root, "team_01", "ag_01"));
		assert.ok(fs.statSync(memberPaths(me.dir).requests).isDirectory() && fs.statSync(memberPaths(me.dir).responses).isDirectory());
		assert.equal(h.memberOf("ag_02")!.orchestrator, false);
		// The Claude worker's own environment never carries the identity; the MCP server's does.
		assert.equal(created[0].env, undefined, "the CLI process gets no identity");
		assert.equal(created[0].extensions.length, 0);
		const server = created[0].mcpServers.team;
		assert.deepEqual([server.command, server.args], [process.execPath, [MEMBER_MCP]]);
		const writer = decodeMemberContext(server.env[MEMBER_ENV])!;
		assert.deepEqual({ ...writer, dir: undefined }, { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_03", role: "writer", orchestrator: false, dir: undefined });
		assert.equal(writer.dir, path.join(h.root, "team_01", "ag_03"));
		assert.ok(fs.statSync(memberPaths(writer.dir).requests).isDirectory(), "a Claude member has a mailbox too");
		assert.match(created[0].task, /call them as mcp__team__team_msg, mcp__team__team_inbox, mcp__team__team_ask; .*\nTeam tools: team_msg/);
		assert.doesNotMatch(created[0].task, /no tool to reply/);
		assert.match(dev.task, /Team tools: team_msg/);
		assert.equal(dev.mcpServers, undefined, "pi members load member.ts instead");
		// Persisted with the flag; team_list marks the orchestrator.
		const entry = h.appended.find((e) => e.customType === "subagents-team-v1");
		assert.deepEqual(entry.data.members.map((m: any) => m.orchestrator), [true, undefined, undefined]);
		assert.match((await h.call("team_list")).content[0].text, /ag_01 lead \(orchestrator\) \[pi\]/);
		// The user-facing extensions option still refuses the member file, and ad hoc workers never get an identity.
		await assert.rejects(h.call("agent_spawn", { prompt: "x", extensions: [MEMBER_EXTENSION] }), /do not nest/);
		await h.call("agent_spawn", { prompt: "plain", wake: false });
		assert.equal(h.workers.at(-1).env, undefined);
		assert.deepEqual(h.workers.at(-1).extensions, [MARKER_EXTENSION]);
		await assert.rejects(
			h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true, backend: "other" }] }),
			/must use the pi or claude-code backend/,
		);
		await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "test" }] });
		assert.equal(h.memberOf("ag_05")!.role, "qa");
		assert.match(h.workers.find((w: any) => w.id === "ag_05").task, /- lead \(orchestrator\): none declared/);
		// A Claude orchestrator is accepted; its MCP identity carries the flag and its header names the sibling powers with the prefix.
		await h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true, backend: "claude-code" }] });
		const boss = decodeMemberContext(created.at(-1).mcpServers.team.env[MEMBER_ENV])!;
		assert.deepEqual([boss.workerId, boss.role, boss.orchestrator], ["ag_06", "boss", true]);
		assert.match(created.at(-1).task, /call them as mcp__team__team_roster, mcp__team__team_steer, mcp__team__team_msg, .*\nYou are this team's orchestrator/);
		assert.match((await h.call("team_list")).content[0].text, /ag_06 boss \(orchestrator\) \[claude-code\]/);
	} finally { await h.cleanup(); }
});

test("member messages are delivered through the steer path with provenance, inbox copies and action records", async () => {
	const h = teamHarness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		await h.call("team_create", {
			name: "Crew", objective: "Ship", members: [
				{ role: "lead", prompt: "coordinate", orchestrator: true },
				{ role: "dev", prompt: "build" },
				{ role: "writer", prompt: "document", backend: "claude-code" },
			],
		});
		const dev = h.workers.find((w: any) => w.id === "ag_02");
		const lead = h.workers.find((w: any) => w.id === "ag_01");
		// dev → lead by role (normalized), pi recipient: default steering, reply hint, inbox copy.
		const one = await h.ask("ag_02", { type: "message", to: " LEAD ", message: "API is ready" });
		assert.equal(one.ok, true);
		assert.match(one.text, /^Delivered \(accepted or queued; not proof they acted\)\.\nlead \(ag_01\): accepted or queued$/);
		assert.equal(lead.lastSteer.mode, undefined);
		assert.equal(lead.lastSteer.message, "[Team message from dev (ag_02), team_01]\nAPI is ready\n(Reply with team_msg to \"dev\" if needed; team_inbox lists delivered messages.)");
		assert.deepEqual(readInbox(h.memberOf("ag_01")!.dir).map((r) => [r.kind, r.from, r.fromId, r.text]), [["message", "dev", "ag_02", "API is ready"]]);
		// lead → Claude member by ID: queued as a follow-up with a reply hint naming the MCP tools, plus an inbox copy.
		const two = await h.ask("ag_01", { type: "message", to: "ag_03", message: "Document the API" });
		assert.equal(two.ok, true);
		assert.equal(created[0].lastSteer.mode, "followUp");
		assert.equal(created[0].lastSteer.message, "[Team message from lead, orchestrator (ag_01), team_01]\nDocument the API\n(Reply with the mcp__team__team_msg tool to \"lead\" if needed; mcp__team__team_inbox lists delivered messages.)");
		const writerDir = decodeMemberContext(created[0].mcpServers.team.env[MEMBER_ENV])!.dir;
		assert.deepEqual(readInbox(writerDir).map((r) => [r.kind, r.from, r.text]), [["message", "lead", "Document the API"]]);
		// The Claude member answers through the same mailbox: sender identity comes from its directory.
		const back = await h.ask("ag_03", { type: "message", to: "lead", message: "Done" }, created);
		assert.equal(back.ok, true);
		assert.equal(lead.lastSteer.message, "[Team message from writer (ag_03), team_01]\nDone\n(Reply with team_msg to \"writer\" if needed; team_inbox lists delivered messages.)");
		// Broadcast reaches every sibling, never the sender; partial failure is reported per recipient.
		created[0].status = "killed";
		const all = await h.ask("ag_02", { type: "message", to: "all", message: "sync" });
		assert.equal(all.ok, true, "one delivery succeeded");
		assert.match(all.text, /^Partially delivered\.\nlead \(ag_01\): accepted or queued\nwriter \(ag_03\): failed — writer \(ag_03\) is no longer live$/);
		assert.equal(dev.steerCount, 0, "a broadcast never loops back to the sender");
		// Scope errors are answered, never delivered.
		for (const [to, pattern] of [["dev", /cannot address yourself/], ["ag_02", /cannot address yourself/], ["ghost", /No member with role ghost in team_01\. Known roles: lead, writer\./], ["ag_42", /not a member of team_01/]] as const) {
			const bad = await h.ask("ag_02", { type: "message", to, message: "x" });
			assert.equal(bad.ok, false);
			assert.match(bad.text, pattern);
		}
		assert.equal((await h.ask("ag_02", { type: "message", to: "lead", message: "  " })).ok, false);
		assert.equal(lead.steerCount, 3);
		// Records: recipient-keyed actions with source member and kind message.
		const listed = await h.call("team_list");
		const actions = listed.details.teams[0].actions;
		assert.deepEqual(actions.map((a: any) => [a.source, a.kind, a.workerId, a.state]), [
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_03", "accepted-or-queued"],
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_03", "failed"],
		]);
		assert.match(listed.content[0].text, /#1 member message → ag_01 \(lead\): accepted-or-queued/);
		// A finished sender and a forged directory are refused; malformed files are dropped silently.
		dev.status = "done";
		const dead = await h.ask("ag_02", { type: "message", to: "lead", message: "late" });
		assert.equal(dead.ok, false);
		assert.match(dead.text, /not a live member/);
		const forged = path.join(h.root, "team_01", "ag_77");
		fs.mkdirSync(memberPaths(forged).requests, { recursive: true });
		fs.mkdirSync(memberPaths(forged).responses, { recursive: true });
		const forgedId = requestId();
		writeRequest(forged, { version: 1, id: forgedId, at: Date.now(), type: "message", to: "lead", message: "spoof" });
		const answer = await awaitResponse(forged, forgedId, 3000, undefined, 5);
		assert.equal(answer?.ok, false);
		assert.match(answer!.text, /not a live member/);
		fs.writeFileSync(path.join(memberPaths(h.memberOf("ag_01")!.dir).requests, "zz.json"), "{broken");
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(fs.readdirSync(memberPaths(h.memberOf("ag_01")!.dir).requests), []);
		assert.equal(lead.steerCount, 3, "nothing forged or malformed was delivered");
	} finally { await h.cleanup(); }
});

test("orchestrator powers are sibling-scoped: roster and steer for orchestrators only, never spawn or kill", async () => {
	const h = teamHarness();
	try {
		await h.call("team_create", {
			name: "Crew", objective: "Ship", members: [
				{ role: "lead", prompt: "coordinate", orchestrator: true },
				{ role: "dev", prompt: "build", ownedPaths: ["src"] },
			],
		});
		await h.call("team_create", { name: "Other", objective: "Elsewhere", members: [{ role: "solo", prompt: "alone" }] });
		const dev = h.workers.find((w: any) => w.id === "ag_02");
		const solo = h.workers.find((w: any) => w.id === "ag_03");
		// Non-orchestrators are refused before any lookup.
		const refusedSteer = await h.ask("ag_02", { type: "steer", to: "lead", message: "do it" });
		assert.equal(refusedSteer.ok, false);
		assert.match(refusedSteer.text, /Only an orchestrator member can steer/);
		assert.match((await h.ask("ag_02", { type: "roster" })).text, /orchestrator members only/);
		// The orchestrator steers a sibling with the requested mode; the record names the orchestrator source.
		const steered = await h.ask("ag_01", { type: "steer", to: "dev", message: "Run the tests first.", mode: "followUp" });
		assert.equal(steered.ok, true);
		assert.match(steered.text, /Accepted or queued for dev \(ag_02\); this is not execution/);
		assert.deepEqual([dev.lastSteer.mode, dev.lastSteer.message], ["followUp", "[Instruction from orchestrator lead (ag_01), team_01]\nRun the tests first."]);
		assert.deepEqual(readInbox(h.memberOf("ag_02")!.dir).map((r) => [r.kind, r.text]), [["instruction", "Run the tests first."]]);
		const plain = await h.ask("ag_01", { type: "steer", to: "ag_02", message: "Now fix lint." });
		assert.equal(plain.ok, true);
		assert.equal(dev.lastSteer.mode, undefined);
		// Never itself, never "all", never another team.
		for (const [to, pattern] of [["lead", /cannot address yourself/], ["all", /one sibling at a time/], ["solo", /No member with role solo/], ["ag_03", /not a member of team_01/]] as const) {
			const bad = await h.ask("ag_01", { type: "steer", to, message: "x" });
			assert.equal(bad.ok, false, to);
			assert.match(bad.text, pattern);
		}
		assert.equal(solo.steerCount, 0, "another team's worker is unreachable");
		// Roster: own team only, tool availability per backend, honest action states.
		const roster = await h.ask("ag_01", { type: "roster" });
		assert.equal(roster.ok, true);
		assert.match(roster.text, /^team_01 — Crew · 2 working\nObjective: Ship\n  ag_01 lead \(orchestrator\) \[pi, has team tools\] working \(running\) · context — · owns: none declared\n  ag_02 dev \[pi, has team tools\] working \(running\) · context — · owns: src\n  Recent actions:\n    #1 orchestrator followUp → ag_02 \(dev\): accepted-or-queued/);
		assert.doesNotMatch(roster.text, /Other|solo|ag_03/);
		assert.match(roster.text, /accepted-or-queued never means executed/);
		// A stopping sibling cannot be steered; the failure is reported, not hidden.
		dev.status = "killed";
		const gone = await h.ask("ag_01", { type: "steer", to: "dev", message: "x" });
		assert.equal(gone.ok, false);
		assert.match(gone.text, /no longer live/);
		const actions = (await h.call("team_list", { team: "Crew" })).details.teams[0].actions;
		assert.deepEqual(actions.map((a: any) => [a.source, a.kind, a.state]), [["orchestrator", "followUp", "accepted-or-queued"], ["orchestrator", "steer", "accepted-or-queued"], ["orchestrator", "steer", "failed"]]);
	} finally { await h.cleanup(); }
});

test("team_ask surfaces a team-question message that starts an idle parent turn and points at agent_steer", async () => {
	const h = teamHarness();
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build", wake: false }] });
		const before = h.messages.length;
		const asked = await h.ask("ag_01", { type: "question", message: "Postgres or SQLite?" });
		assert.equal(asked.ok, true);
		assert.match(asked.text, /surfaced to the operator.*starts a parent turn if the parent is idle.*continue with independent work or end your turn/);
		assert.equal(h.messages.length, before + 1);
		const [message, delivery] = h.messages.at(-1);
		assert.deepEqual(delivery, { deliverAs: "followUp", triggerTurn: true }, "questions always wake an idle parent, even for wake:false members");
		assert.equal(message.customType, "team-question");
		assert.equal(message.display, true);
		assert.equal(message.content, [
			"[Team question from dev (ag_01), team_01 — Crew]",
			"Postgres or SQLite?",
			"",
			"Answer with agent_steer { id: \"ag_01\", message: \"<answer>\" }; the member continues (or resumes, if idle) from your message. If only the user can decide, ask them and relay their answer the same way.",
		].join("\n"));
		assert.deepEqual(h.notices.at(-1), ["Team question from dev (ag_01).", "info"]);
		const actions = (await h.call("team_list")).details.teams[0].actions;
		assert.deepEqual(actions.map((a: any) => [a.source, a.kind, a.workerId, a.state, a.preview]), [["member", "question", "ag_01", "accepted-or-queued", "Postgres or SQLite?"]]);
		// The relay is the ordinary steer path.
		await h.call("agent_steer", { id: "ag_01", message: "SQLite." });
		assert.equal(h.workers[0].lastSteer.message, "SQLite.");
		assert.equal((await h.ask("ag_01", { type: "question", message: " " })).ok, false);
		// Without an interactive parent the member is told to report instead.
		h.ctx.mode = "print";
		const offline = await h.ask("ag_01", { type: "question", message: "anyone?" });
		assert.equal(offline.ok, false);
		assert.match(offline.text, /cannot be reached from this parent session mode/);
		assert.equal(h.messages.length, before + 1);
	} finally { await h.cleanup(); }
});

test("the mailbox root is created only for teams, and an owned root is removed on shutdown", async () => {
	const h = harness(eventBus(), { mailboxPollMs: 10 });
	let root: string | undefined;
	try {
		await h.call("agent_spawn", { prompt: "plain", wake: false });
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const me = decodeMemberContext(h.workers[1].env[MEMBER_ENV])!;
		root = path.dirname(path.dirname(me.dir));
		assert.ok(path.basename(root).startsWith("pi-subagents-teams-"));
		assert.ok(fs.existsSync(me.dir));
	} finally { await h.close(); }
	assert.ok(root && !fs.existsSync(root), "owned root removed at shutdown");
	// An injected root belongs to the caller and survives.
	const injected = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-injected-"));
	try {
		const h2 = harness(eventBus(), { mailboxRoot: injected, mailboxPollMs: 10 });
		await h2.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		await h2.close();
		assert.ok(fs.existsSync(injected));
	} finally { fs.rmSync(injected, { recursive: true, force: true }); }
});

// ── Remote sessions: every worker runs on the target ──────────────────────

/** A remote session, as the remote extension announces it (or as the placeholder cwd implies it). */
function remoteHarness(agentDir: string, announce: boolean) {
	const h = teamHarness();
	if (announce) h.bus.emit(REMOTE_SESSION_EVENT, { version: 1, target: "box", farCwd: "/srv/app", label: "The box" });
	// The session's local cwd is the placeholder for /srv/app on target "box".
	h.ctx.cwd = placeholderDir(agentDir, "box", "/srv/app");
	fs.mkdirSync(h.ctx.cwd, { recursive: true });
	return h;
}

test("a remote session's workers run on the target: pi loads the remote extension with --target, claude gets the remote MCP server and no built-in tools", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-remote-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const h = remoteHarness(agentDir, true);
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), id: "other" });
	try {
		const spawned = await h.call("agent_spawn", { prompt: "pi task", tools: ["read", "bash"] });
		assert.match(spawned.content[0].text, /^Remote session: workers run on target box in \/srv\/app\.$/m, "the parent can see it runs the remote wiring");
		assert.match((await h.call("agent_list")).content[0].text, /Remote session: workers run on target box in \/srv\/app\./);
		const piWorker = h.workers[0];
		assert.deepEqual(piWorker.extensions, [MARKER_EXTENSION, REMOTE_EXTENSION], "the marker and the remote extension, nothing else");
		assert.deepEqual(piWorker.flags, { target: "box" });
		assert.equal(piWorker.cwd, h.ctx.cwd, "the session's placeholder is the local cwd");
		assert.deepEqual(piWorker.tools, ["read", "bash"], "the allowlist is unchanged; the runner restricts by exclusion when extensions are present");
		assert.equal(piWorker.mcpServers, undefined);

		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", tools: ["Read"], systemPrompt: "be terse", cwd: "sub/dir" });
		const claude = created[0];
		assert.deepEqual(claude.tools, [], "every built-in tool is gone (--tools \"\")");
		assert.equal(claude.extensions.length, 0);
		assert.deepEqual(claude.env, { MCP_TOOL_TIMEOUT: String(REMOTE_MCP_TOOL_TIMEOUT_MS) }, "claude's own env carries only the MCP deadline");
		assert.deepEqual(Object.keys(claude.mcpServers), [REMOTE_MCP_SERVER_NAME]);
		const server = claude.mcpServers.remote;
		assert.deepEqual([server.command, server.args], [process.execPath, [REMOTE_MCP]]);
		const identity = decodeRemoteMcpIdentity(server.env[REMOTE_MCP_ENV])!;
		assert.deepEqual(identity, { version: 1, target: "box", farCwd: "/srv/app/sub/dir", agentDir, label: "The box" }, "a relative worker cwd is resolved on the target");
		assert.equal(claude.cwd, placeholderDir(agentDir, "box", "/srv/app/sub/dir"), "its local cwd is the placeholder of that far directory");
		assert.ok(fs.statSync(claude.cwd).isDirectory(), "created so the CLI can start there");
		assert.match(claude.systemPrompt, /^be terse\n\n/);
		assert.match(claude.systemPrompt, /remote target "The box \(box\)" in \/srv\/app\/sub\/dir/);
		assert.match(claude.systemPrompt, /no local file or shell tools/);
		assert.equal(claude.model, "sonnet", "the backend's own preparation is kept");

		// A team member of a remote session gets both servers; a pi member both extensions.
		await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "lead", prompt: "t", orchestrator: true }, { role: "writer", prompt: "w", backend: "claude-code" }] });
		const lead = h.workers.find((w: any) => w.id === "ag_03");
		assert.deepEqual(lead.extensions, [MARKER_EXTENSION, REMOTE_EXTENSION, MEMBER_EXTENSION]);
		assert.deepEqual(lead.flags, { target: "box" });
		const writer = created[1];
		assert.deepEqual(Object.keys(writer.mcpServers).sort(), [REMOTE_MCP_SERVER_NAME, "team"]);
		assert.equal(decodeRemoteMcpIdentity(writer.mcpServers.remote.env[REMOTE_MCP_ENV])!.farCwd, "/srv/app");
		assert.ok(decodeMemberContext(writer.mcpServers.team.env[MEMBER_ENV]));

		// A cwd the parent cannot resolve, and a backend without remote tooling, are refused before any worker starts.
		await assert.rejects(h.call("agent_spawn", { prompt: "t", cwd: "~/x" }), /absolute path on the target/);
		await assert.rejects(h.call("agent_spawn", { prompt: "t", backend: "other" }), /cannot run workers of a remote session/);
		assert.equal(h.workers.length + created.length, 4);
	} finally {
		await h.close();
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("the placeholder cwd alone identifies a remote session when the remote extension has not announced it; a target that failed to load refuses workers", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-remote-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const h = remoteHarness(agentDir, false);
	try {
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, REMOTE_EXTENSION]);
		assert.deepEqual(h.workers[0].flags, { target: "box" });
		// The announcement wins over the placeholder, and carries what the placeholder cannot say.
		h.bus.emit(REMOTE_SESSION_EVENT, { version: 1, target: "box", farCwd: "/srv/app", channelOff: true });
		await h.call("agent_spawn", { prompt: "pi task 2" });
		assert.deepEqual(h.workers[1].flags, { target: "box", "no-channel": true });
		// Announced before the preflight resolved the far cwd (a CLI `pi --target` from a plain dir): refused, never local.
		h.bus.emit(REMOTE_SESSION_EVENT, { version: 1, target: "box" });
		await assert.rejects(h.call("agent_spawn", { prompt: "t" }), /far working directory is not known yet/);
		assert.match((await h.call("agent_list")).content[0].text, /far working directory not resolved yet/);
		h.bus.emit(REMOTE_SESSION_EVENT, { version: 1, target: "box", error: 'no target named "box"' });
		await assert.rejects(h.call("agent_spawn", { prompt: "t" }), /could not be loaded \(no target named "box"\)/);
		assert.equal(h.workers.length, 2);
	} finally {
		await h.close();
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a local session's workers are untouched by the remote wiring", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		const spawned = await h.call("agent_spawn", { prompt: "pi task" });
		assert.doesNotMatch(spawned.content[0].text, /Remote session/);
		assert.doesNotMatch((await h.call("agent_list")).content[0].text, /Remote session/);
		assert.equal(h.workers[0].flags, undefined);
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION]);
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code" });
		assert.equal(created[0].mcpServers, undefined);
		assert.equal(created[0].env, undefined);
		assert.equal(created[0].tools, undefined, "the backend's default tool list applies");
	} finally { await h.close(); }
});

test("worker session marker: every pi worker loads worker-mark.ts first; claude-code workers never do", async () => {
	assert.equal(path.basename(MARKER_EXTENSION), "worker-mark.ts");
	assert.ok(fs.existsSync(MARKER_EXTENSION));
	assert.equal(path.dirname(MARKER_EXTENSION), path.dirname(MEMBER_EXTENSION), "a sibling of member.ts, under this extension's own directory");
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		const plain = await h.call("agent_spawn", { prompt: "plain", tools: ["read"] });
		assert.equal(h.workers[0].extensions[0], MARKER_EXTENSION, "a plain worker");
		assert.doesNotMatch(plain.content[0].text, /extensions=/, "the spawn summary does not list the marker");
		const given = await h.call("agent_spawn", { prompt: "given", extensions: ["npm:definitely-not-installed-xyz"] });
		assert.deepEqual(h.workers[1].extensions, [MARKER_EXTENSION, "npm:definitely-not-installed-xyz"], "a worker with its own extensions");
		assert.match(given.content[0].text, /  extensions=npm:definitely-not-installed-xyz(  |$)/m, "only the user's extensions are listed");
		await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "lead", prompt: "t", orchestrator: true }, { role: "writer", prompt: "w", backend: "claude-code" }] });
		const member = h.workers.at(-1);
		assert.deepEqual(member.extensions, [MARKER_EXTENSION, MEMBER_EXTENSION], "a team member");
		await h.call("agent_spawn", { prompt: "claude", backend: "claude-code" });
		assert.equal(created.length, 2);
		for (const claude of created) assert.equal(claude.extensions.length, 0, "claude-code workers are untouched");
		// The marker is spawn plumbing, never a user-facing source.
		await assert.rejects(h.call("agent_spawn", { prompt: "x", extensions: [MARKER_EXTENSION] }), /do not nest/);
	} finally {
		await h.close();
	}
});

test("worker session marker: one subagents-worker-session entry at session_start, inert everywhere else", async () => {
	const { default: workerMark, WORKER_SESSION_ENTRY, workerSessionMarker } = await import(MARKER_EXTENSION);
	// The literal is a contract with Sova's reader (server/worker-sessions.ts); a rename must fail here.
	assert.equal(WORKER_SESSION_ENTRY, "subagents-worker-session");
	const stub = (opts: { append?: unknown; file?: string | undefined; entries?: unknown[]; on?: unknown } = {}) => {
		const appended: { customType: string; data: unknown }[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi: any = {
			on: opts.on ?? ((name: string, fn: any) => handlers.set(name, fn)),
			appendEntry: "append" in opts ? opts.append : (customType: string, data: unknown) => appended.push({ customType, data }),
		};
		const ctx = { sessionManager: { getSessionFile: () => ("file" in opts ? opts.file : "/tmp/worker.jsonl"), getEntries: () => opts.entries ?? [] } };
		return { pi, appended, handlers, start: () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx) };
	};
	const prev = process.env[MEMBER_ENV];
	delete process.env[MEMBER_ENV];
	try {
		// Load registers only the handler: nothing is appended while pi refuses actions.
		const plain = stub();
		assert.doesNotThrow(() => workerMark(plain.pi));
		assert.deepEqual([...plain.handlers.keys()], ["session_start"]);
		assert.equal(plain.appended.length, 0);
		plain.start();
		assert.deepEqual(plain.appended, [{ customType: "subagents-worker-session", data: { v: 1 } }]);

		// A team member carries its identity from the existing member env.
		process.env[MEMBER_ENV] = JSON.stringify({ version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_02", role: "dev", orchestrator: false, dir: path.join(os.tmpdir(), "m") });
		const member = stub();
		workerMark(member.pi);
		member.start();
		assert.deepEqual(member.appended, [{ customType: "subagents-worker-session", data: { v: 1, workerId: "ag_02", teamId: "team_01", role: "dev" } }]);
		process.env[MEMBER_ENV] = "not json";
		assert.deepEqual(workerSessionMarker(), { v: 1 }, "an invalid identity degrades to presence-only");

		// Already marked (a resumed worker session): no second entry.
		const resumed = stub({ entries: [{ type: "custom", customType: "subagents-worker-session", data: { v: 1 } }] });
		workerMark(resumed.pi);
		resumed.start();
		assert.equal(resumed.appended.length, 0);

		// No session file, no append API, a throwing append, a throwing event API: nothing happens, nothing throws.
		const ephemeral = stub({ file: undefined });
		workerMark(ephemeral.pi);
		ephemeral.start();
		assert.equal(ephemeral.appended.length, 0);
		const missing = stub({ append: undefined });
		workerMark(missing.pi);
		assert.doesNotThrow(() => missing.start());
		const throwing = stub({ append: () => { throw new Error("Extension runtime not initialized"); } });
		workerMark(throwing.pi);
		assert.doesNotThrow(() => throwing.start());
		assert.doesNotThrow(() => workerMark(stub({ on: () => { throw new Error("no events"); } }).pi));
		assert.doesNotThrow(() => workerMark({} as any));
	} finally {
		if (prev === undefined) delete process.env[MEMBER_ENV]; else process.env[MEMBER_ENV] = prev;
	}
});

test("worker marker: the requested built-ins the default set lacks are activated at session_start, nothing else", async () => {
	const { default: workerMark, WORKER_TOOLS_ENV, requestedTools } = await import(MARKER_EXTENSION);
	const run = (env: string | undefined, all: string[], active: string[]) => {
		const prev = process.env[WORKER_TOOLS_ENV];
		if (env === undefined) delete process.env[WORKER_TOOLS_ENV]; else process.env[WORKER_TOOLS_ENV] = env;
		try {
			let set: string[] | null = null;
			const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
			const pi: any = {
				on: (name: string, fn: any) => handlers.set(name, fn),
				appendEntry: () => {},
				getActiveTools: () => active,
				getAllTools: () => all.map((name) => ({ name })),
				setActiveTools: (names: string[]) => { set = names; },
			};
			workerMark(pi);
			handlers.get("session_start")?.({}, { sessionManager: { getSessionFile: () => undefined, getEntries: () => [] } });
			return set;
		} finally {
			if (prev === undefined) delete process.env[WORKER_TOOLS_ENV]; else process.env[WORKER_TOOLS_ENV] = prev;
		}
	};
	// --exclude-tools bash,powershell,edit,write left read active and grep/find/ls registered but off.
	assert.deepEqual(run("read,grep,find,ls", ["read", "grep", "find", "ls", "x_ext"], ["read", "x_ext"]), ["read", "x_ext", "grep", "find", "ls"]);
	// An excluded tool is not registered, so the variable cannot turn it on.
	assert.deepEqual(run("read,bash", ["read"], ["read"]), null);
	assert.equal(run(undefined, ["read", "grep"], ["read"]), null, "no request: pi's defaults stand");
	assert.deepEqual(requestedTools({ [WORKER_TOOLS_ENV]: " read, ,grep " }), ["read", "grep"]);
});

test("a pi worker on a claude-code-cli model gets the claude-code extension and its provider switch; other models get neither", async () => {
	const h = harness();
	h.ctx.modelRegistry.find = (p: string, m: string) => (p === "claude-code-cli" && m === "opus[1m]") || (p === "ollama-cloud" && m === "kimi-k3") ? { provider: p, id: m } : undefined;
	try {
		await h.call("agent_spawn", { prompt: "1M task", model: "claude-code-cli/opus[1m]", effort: "low" });
		const scoped = h.workers[0];
		assert.equal(scoped.model, "claude-code-cli/opus[1m]", "the ref reaches the runner unchanged; the runner sets it over RPC");
		assert.deepEqual(scoped.extensions, [MARKER_EXTENSION, CLAUDE_CODE_EXTENSION], "the marker, then the claude-code extension");
		assert.deepEqual(scoped.flags, { "claude-code-provider": true });
		assert.equal(CLAUDE_CODE_EXTENSION, path.join(fs.realpathSync(path.resolve(fileURLToPath(new URL("../claude-code", import.meta.url)))), "index.ts"), "the sibling directory, by real path");
		assert.equal(CLAUDE_CODE_PROVIDER_FLAG, CLAUDE_PROVIDER_FLAG, "the switch the provider extension registers");
		await h.call("agent_spawn", { prompt: "plain task", model: "ollama-cloud/kimi-k3" });
		const plain = h.workers[1];
		assert.equal(plain.model, "ollama-cloud/kimi-k3");
		assert.deepEqual(plain.extensions, [MARKER_EXTENSION]);
		assert.equal(plain.flags, undefined);
	} finally { await h.close(); }
});

// The sandbox extension's directory, as its state event names it (a real path).
const SANDBOX_DIR = fs.realpathSync(path.resolve(fileURLToPath(new URL("../sandbox", import.meta.url))));
const SANDBOX_OFF: SandboxStateEvent = { version: 1, on: false, extensionPath: SANDBOX_DIR, enforcement: "none" };
const WORKER_FLAGS = { sandbox: "on", "sandbox-parent": '{"version":1}' };
const SANDBOX_ON: SandboxStateEvent = {
	version: 1, on: true, extensionPath: SANDBOX_DIR, enforcement: "full", workerFlags: WORKER_FLAGS, checkWorker: () => undefined,
	claudeSettingsJson: '{"sandbox":{"enabled":true}}', claudePermissionMode: "dontAsk",
};
/** A worker's launch options without the per-worker identity or the fake worker's own closures. */
const launchShape = ({ id, groupId, name, ...rest }: any) => Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== "function"));

test("sandbox off: workers launch exactly as without the sandbox extension; on: pi workers load it with --sandbox on", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		await h.call("agent_spawn", { prompt: "pi task" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", backendOptions: { permissionMode: "bypassPermissions" } });
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		await h.call("agent_spawn", { prompt: "pi task" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", backendOptions: { permissionMode: "bypassPermissions" } });
		assert.deepEqual(launchShape(h.workers[1]), launchShape(h.workers[0]), "an off parent's pi worker is today's");
		assert.deepEqual(h.workers[1].extensions, [MARKER_EXTENSION]);
		assert.equal(h.workers[1].flags, undefined);
		assert.deepEqual(launchShape(created[1]), launchShape(created[0]), "an off parent's claude worker is today's");
		assert.ok(!("settingsJson" in created[1]) && !("permissionMode" in created[1]));

		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(h.workers[2].extensions, [MARKER_EXTENSION, SANDBOX_DIR]);
		assert.deepEqual(h.workers[2].flags, WORKER_FLAGS, "the extension's flags, as is");
		// Naming the extension itself neither loads it twice nor drops the flag.
		await h.call("agent_spawn", { prompt: "pi task", extensions: [path.join(SANDBOX_DIR, "index.ts")] });
		assert.deepEqual(h.workers[3].extensions, [MARKER_EXTENSION, SANDBOX_DIR]);
		assert.deepEqual(h.workers[3].flags, WORKER_FLAGS);
		await h.call("agent_spawn", { prompt: "pi task", model: "test/model" });
		assert.deepEqual(h.workers[4].flags, WORKER_FLAGS);

		// Back off: today's launch again.
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(launchShape(h.workers[5]), launchShape(h.workers[0]));
	} finally { await h.close(); }
});

test("sandbox on: claude workers get the extension's settings and permission mode, never bypassPermissions or a host prompt; a refusal or another backend fails the spawn", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), id: "other" });
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", backendOptions: { permissionMode: "bypassPermissions" } });
		const claude = created[0];
		assert.equal(claude.settingsJson, SANDBOX_ON.claudeSettingsJson, "passed through as is");
		assert.equal(claude.permissionMode, "dontAsk", "forced over the spec's bypassPermissions");
		assert.ok("onPermission" in claude && claude.onPermission === undefined, "no host prompt can approve past the rules");
		assert.deepEqual(claude.extensions, []);

		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, enforcement: "partial", claudeRefusal: "Sandbox enforcement is partial (x); set acceptPartial." });
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), { message: "Sandbox enforcement is partial (x); set acceptPartial." });
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, claudeSettingsJson: undefined });
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), /gave no Claude Code settings/);
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "other" }), /cannot run workers while this session's sandbox is on/);
		// A mixed batch fails as a whole: the pi worker never starts either.
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "p" }, { prompt: "c", backend: "other" }] }), /sandbox is on/);
		assert.equal(created.length, 1);
		assert.equal(h.workers.length, 0);
	} finally { await h.close(); }
});

test("sandbox: the state is asked for at load, malformed announcements are ignored, and a remote session's workers never load the extension", async () => {
	const bus = eventBus();
	let asked = 0;
	bus.on(SANDBOX_DISCOVER_EVENT, (data: any) => { if (data?.version === 1) { asked++; bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON); } });
	const h = harness(bus);
	try {
		assert.equal(asked, 1);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(h.workers[0].flags, WORKER_FLAGS, "a sandbox loaded first is learned by discovery");
		bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, version: 2 });
		bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, extensionPath: "relative/sandbox" });
		bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerFlags: { sandbox: true } });
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(h.workers[1].flags, WORKER_FLAGS, "the last valid state stands");
	} finally { await h.close(); }

	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-remote-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const r = remoteHarness(agentDir, true);
	try {
		r.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await r.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(r.workers[0].extensions, [MARKER_EXTENSION, REMOTE_EXTENSION]);
		assert.deepEqual(r.workers[0].flags, { target: "box" });
	} finally {
		await r.close();
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("sandbox on: every worker is checked by the extension first, and its refusal fails the whole batch before any start; an on state without a check or flags fails closed", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sandbox-outside-"));
	const asked: { cwd: string; backend: string }[] = [];
	const checkWorker = (req: { cwd: string; backend: string }) => {
		asked.push(req);
		return req.cwd === outside ? `Sandbox: worker cwd ${outside} is outside the parent's sandbox` : undefined;
	};
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, checkWorker });
		await h.call("agent_spawn", { prompt: "p", cwd: "extensions" });
		await h.call("agent_spawn", { prompt: "c", backend: "claude-code" });
		assert.deepEqual(asked, [{ cwd: path.join(h.ctx.cwd, "extensions"), backend: "pi" }, { cwd: h.ctx.cwd, backend: "claude-code" }], "the resolved cwd and the backend");
		for (const backend of [undefined, "claude-code"]) {
			await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "fine" }, { prompt: "p", cwd: outside, backend }] }), { message: `Sandbox: worker cwd ${outside} is outside the parent's sandbox` });
		}
		assert.equal(h.workers.length + created.length, 2, "nothing of a refused batch started");

		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, checkWorker: undefined });
		await assert.rejects(h.call("agent_spawn", { prompt: "p" }), /gave no worker check/);
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), /gave no worker check/);
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerFlags: undefined });
		await assert.rejects(h.call("agent_spawn", { prompt: "p" }), /gave no worker flags/);
		assert.equal(h.workers.length + created.length, 2);

		// Off: no check at all.
		asked.length = 0;
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, checkWorker });
		await h.call("agent_spawn", { prompt: "p", cwd: outside });
		assert.equal(asked.length, 0);
	} finally {
		await h.close();
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("team_eject: parent-only, refuses occupied members, persists the op, frees a seat, and ejected members drop out of messaging", async () => {
	const h = teamHarness();
	try {
		// Members and orchestrators never get the tool.
		const { MEMBER_TOOLS, ORCHESTRATOR_TOOLS } = await import("./member.ts");
		const mcp = await import("./member-mcp.ts");
		for (const list of [MEMBER_TOOLS, ORCHESTRATOR_TOOLS, mcp.MEMBER_TOOLS, mcp.ORCHESTRATOR_TOOLS]) assert.ok(!(list as readonly string[]).includes("team_eject"));
		assert.ok(h.tools.has("team_eject"));
		await h.call("team_create", {
			name: "Crew", objective: "Ship", members: [
				{ role: "lead", prompt: "coordinate", orchestrator: true, wake: false },
				{ role: "dev", prompt: "build", wake: false },
				{ role: "writer", prompt: "document", wake: false },
			],
		});
		const [lead, dev, writer] = ["ag_01", "ag_02", "ag_03"].map((id) => h.workers.find((w: any) => w.id === id));
		// Occupied members are refused with the agent_kill hint; nothing is persisted.
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "dev" }), /dev \(ag_02\) is still working; stop it with agent_kill first/);
		dev.settle(undefined, "waiting");
		await assert.rejects(h.call("team_eject", { team: "team_01", member: "ag_02" }), /is still idle/);
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "ghost" }), /No member ghost in team_01/);
		await assert.rejects(h.call("team_eject", { team: "team_09", member: "dev" }), /No such team: team_09/);
		assert.equal(h.appended.filter((e) => e.data?.op === "eject").length, 0);

		await h.call("agent_kill", { id: "ag_02" });
		const out = await h.call("team_eject", { team: "crew", member: " DEV " });
		assert.match(out.content[0].text, /^Ejected ag_02 \(dev\) from team_01 at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\. 2 of 24 seats taken; the role dev stays reserved\.$/);
		const ops = h.appended.filter((e) => e.customType === "subagents-team-v1" && e.data.op === "eject");
		assert.deepEqual(ops.map((e) => ({ ...e.data, at: typeof e.data.at })), [{ version: 1, op: "eject", teamId: "team_01", workerId: "ag_02", at: "number" }]);
		assert.equal(out.details.ejectedAt, ops[0].data.at);
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "ag_02" }), /already ejected/);

		const list = await h.call("team_list", { team: "Crew" });
		assert.match(list.content[0].text, /team_01 — Crew \[this session\] · 2 working · 1 ejected\n/);
		assert.match(list.content[0].text, /ag_02 dev \[pi\] stopped \(killed\) · context — · owns: none declared · ejected \d{4}-[^\n]*Z\n/);
		assert.match(list.content[0].text, /#\d+ parent eject → ag_02 \(dev\): accepted-or-queued/);
		assert.equal(list.details.teams[0].members[1].ejectedAt, ops[0].data.at);
		assert.equal(list.details.teams[0].actions.filter((a: any) => a.kind === "eject").length, 1);
		const roster = await h.ask("ag_01", { type: "roster" });
		assert.match(roster.text, /^team_01 — Crew · 2 working · 1 ejected\n/);
		assert.match(roster.text, /ag_02 dev \[pi, has team tools\] stopped \(killed\) · context — · owns: none declared · ejected /);

		// Broadcast skips the ejected member (no failed delivery); a direct message says it was ejected.
		const all = await h.ask("ag_01", { type: "message", to: "all", message: "sync" });
		assert.match(all.text, /^Delivered \(accepted or queued; not proof they acted\)\.\nwriter \(ag_03\): accepted or queued$/);
		for (const request of [{ type: "message", to: "dev", message: "x" }, { type: "steer", to: "ag_02", message: "x" }] as const) {
			const direct = await h.ask("ag_01", request);
			assert.equal(direct.ok, false);
			assert.match(direct.text, /dev \(ag_02\) was ejected from team_01 at .*; it no longer receives team messages/);
		}
		assert.equal(writer.steerCount, 1);
		// An ejected member cannot be resumed back into a seat.
		await assert.rejects(h.call("agent_resume", { id: "ag_02" }), /Cannot resume ag_02: it was ejected from its team/);

		// Fill every seat with finished members; the cap names the ejectable ones; an eject lets the next one in.
		lead.settle(undefined, "done");
		writer.settle(undefined, "done");
		for (let batch = 0; batch < 3; batch++) {
			const count = batch < 2 ? 8 : 6;
			await h.call("team_add", { team: "Crew", members: Array.from({ length: count }, (_, i) => ({ role: `r${batch}-${i}`, prompt: "p", wake: false })) });
			for (const w of h.workers.slice(-count)) w.settle(undefined, "done");
		}
		assert.equal((await h.call("team_list", { team: "Crew" })).details.teams[0].members.length, 25, "24 seated plus one ejected");
		const refused = await h.call("team_add", { team: "Crew", members: [{ role: "late", prompt: "p" }] }).then(() => "", (e: Error) => e.message);
		assert.match(refused, /would exceed 24 members/);
		assert.match(refused, /Ended members you can release with team_eject: ag_01 \(lead\), ag_03 \(writer\), ag_04 \(r0-0\)/);
		assert.doesNotMatch(refused, /ag_02/, "an already-ejected member is not offered again");
		await h.call("team_eject", { team: "Crew", member: "r0-0" });
		const added = await h.call("team_add", { team: "Crew", members: [{ role: "late", prompt: "p", wake: false }] });
		assert.match(added.content[0].text, /Added 1 member\(s\) to team_01/);
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "dev", prompt: "p" }] }), /Role dev already exists/);
	} finally { await h.cleanup(); }
});

// ── Team defaults (team-defaults.json): coordinator, monitor, routing, handovers ──

const DEFAULTS_FILE = {
	version: 1,
	coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
	monitor: { enabled: true, role: "monitor", primary: { backend: "claude-code", model: "haiku", effort: "medium" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
	handover: { retireTimeoutMinutes: 10 },
};
/** The parent session id coordinatedHarness reports; handover notes live under it (N1). */
const SESSION_ID = "0199aaaa-0000-7000-8000-00000000c0de";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A team harness whose agent dir holds `file` as team-defaults.json (omit it: no file), with timers fired by hand. */
function coordinatedHarness(file?: unknown, opts: { claude?: boolean; sessionId?: string } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-team-defaults-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	if (file !== undefined) fs.writeFileSync(path.join(agentDir, "team-defaults.json"), typeof file === "string" ? file : JSON.stringify(file));
	const timers: { fn: () => void; ms: number }[] = [];
	const h = harness(eventBus(), {
		mailboxRoot: path.join(root, "mail"), mailboxPollMs: 10, agentDir,
		setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t as any; },
	});
	h.ctx.sessionManager.getSessionId = () => opts.sessionId ?? SESSION_ID;
	const created: any[] = [];
	if (opts.claude !== false) h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	const all = () => [...h.workers, ...created];
	const worker = (id: string) => all().find((w: any) => w.id === id);
	const memberOf = (id: string) => {
		const w = worker(id);
		return decodeMemberContext(w?.env?.[MEMBER_ENV] ?? w?.mcpServers?.team?.env?.[MEMBER_ENV]);
	};
	const ask = async (id: string, request: Omit<MailboxRequest, "version" | "id" | "at">) => {
		const me = memberOf(id)!;
		const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
		writeRequest(me.dir, full);
		const response = await awaitResponse(me.dir, full.id, 3000, undefined, 5);
		assert.ok(response, `parent answered ${request.type} from ${id}`);
		return response!;
	};
	const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
	const parentMessages = (type: string) => h.messages.filter(([m]: any[]) => m.customType === type);
	const handoffs = (teamId = "team_01") => path.join(agentDir, "sova", "teams", opts.sessionId ?? SESSION_ID, teamId, "handoffs");
	/** The old member writes its note and ends its turn: team_succeed's successor starts then (N3). */
	const writeNote = (role: string, text = `# ${role}\nDone: step 1.\nOpen: step 2.`) => {
		fs.mkdirSync(handoffs(), { recursive: true });
		fs.writeFileSync(path.join(handoffs(), `${role}.md`), text);
	};
	return {
		...h, root, agentDir, timers, created, worker, memberOf, ask, tick, parentMessages, handoffs, writeNote,
		cleanup: async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); },
	};
}

test("team defaults: no file changes nothing; a malformed file turns them off visibly and is never rewritten", async () => {
	const none = coordinatedHarness();
	try {
		const r = await none.call("team_create", { name: "Plain", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		assert.doesNotMatch(r.content[0].text, /Team defaults|coordinator/);
		assert.equal(none.workers.length, 1);
		assert.equal(none.workers[0].wake, true);
		assert.equal(none.memberOf("ag_01")!.coordinated, undefined);
		assert.equal(fs.existsSync(path.join(none.agentDir, "sova")), false, "no handover directory for an uncoordinated team");
	} finally { await none.cleanup(); }
	const bad = '{"version":1,"monitor":{"contextPct":"sixty"}}';
	const h = coordinatedHarness(bad);
	try {
		const r = await h.call("team_create", { name: "Plain", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		assert.match(r.content[0].text, /^Created team_01 \(Plain\).*\nWarning: team defaults are OFF for this team — .*team-defaults\.json is malformed \(monitor\.contextPct: must be a number from 1 to 100\)/);
		assert.equal(h.workers.length + h.created.length, 1, "no coordinator or monitor");
		assert.equal(h.workers[0].wake, true);
		const added = await h.call("team_add", { team: "Plain", members: [{ role: "qa", prompt: "p" }] });
		assert.match(added.content[0].text, /Warning: team defaults are OFF/);
		assert.equal(fs.readFileSync(path.join(h.agentDir, "team-defaults.json"), "utf8"), bad, "never overwritten");
	} finally { await h.cleanup(); }
});

test("team defaults synthesize a coordinator and a monitor in code, with role headers, identities and wake:false for the rest", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		const r = await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build", ownedPaths: ["src"] }, { role: "writer", prompt: "docs", backend: "claude-code", model: "sonnet" }] });
		const text = r.content[0].text;
		assert.match(text, /Team defaults: coordinator coordinator added on claude-code\/opus\[1m\]\/medium \(primary\)\./);
		assert.match(text, /Team defaults: monitor monitor added on claude-code\/haiku\/medium \(primary\)\./);
		const handoffs = path.join(h.agentDir, "sova", "teams", SESSION_ID, "team_01", "handoffs");
		assert.match(text, new RegExp(`Handover notes: ${handoffs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.ok(fs.statSync(handoffs).isDirectory());
		assert.match(text, /ag_01 {2}coordinator \(coordinator\) {2}running {2}backend=claude-code {2}model=opus\[1m\] {2}effort=medium/);
		assert.match(text, /ag_04 {2}monitor \(monitor\) .* wake=false/);
		assert.match(text, /Coordinated team: only the coordinator reaches you/);
		assert.deepEqual(r.details.members.map((m: any) => [m.workerId, m.role, m.duty]), [["ag_01", "coordinator", "coordinator"], ["ag_02", "dev", undefined], ["ag_03", "writer", undefined], ["ag_04", "monitor", "monitor"]]);
		const entry = h.appended.find((e) => e.customType === "subagents-team-v1");
		assert.deepEqual(entry.data.members.map((m: any) => [m.role, m.duty, m.orchestrator]), [["coordinator", "coordinator", true], ["dev", undefined, undefined], ["writer", undefined, undefined], ["monitor", "monitor", undefined]]);
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), writer = h.worker("ag_03"), monitor = h.worker("ag_04");
		assert.deepEqual([coordinator.wake, dev.wake, writer.wake, monitor.wake], [true, false, false, false], "only the coordinator wakes the parent");
		assert.deepEqual(monitor.tools, [], "the monitor has no built-in tools");
		assert.equal(coordinator.tools, undefined);
		assert.deepEqual(h.memberOf("ag_01"), { ...h.memberOf("ag_01")!, orchestrator: true, duty: "coordinator" });
		assert.equal(h.memberOf("ag_01")!.coordinated, undefined);
		assert.equal(h.memberOf("ag_02")!.coordinated, true);
		assert.deepEqual([h.memberOf("ag_04")!.duty, h.memberOf("ag_04")!.coordinated, h.memberOf("ag_04")!.orchestrator], ["monitor", true, false]);
		assert.match(coordinator.task, /call them as mcp__team__team_roster, mcp__team__team_steer, mcp__team__team_msg, mcp__team__team_inbox, mcp__team__team_ask, mcp__team__team_report, mcp__team__team_succeed;/);
		assert.match(coordinator.task, /Your role: coordinator \(coordinator\)/);
		assert.match(coordinator.task, /You are this team's coordinator\. You do no implementation yourself/);
		assert.match(coordinator.task, /- monitor \(monitor\): none declared/);
		assert.match(dev.task, /This team has a coordinator, coordinator: report to it, not to the operator\./);
		assert.match(dev.task, new RegExp(`Your handover note path: ${path.join(handoffs, "dev.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
		assert.match(dev.task, /team_ask sends a question to your team's coordinator/);
		assert.match(monitor.task, /call them as mcp__team__team_msg, mcp__team__team_inbox, mcp__team__team_roster, mcp__team__wake_nudge;/);
		assert.match(monitor.task, /at or over 60% of its context window: team_msg it with notice "wrap-up"/);
		assert.match(monitor.task, /AT\/OVER the 90% pause threshold: team_msg coordinator with notice "pause".*plus 5 min/);
		assert.match(monitor.task, /wake_nudge schedule delay "10m" and end your turn\. Never sleep or poll in a shell/);
		assert.doesNotMatch(monitor.task, /team_ask/);
		for (const [w, role] of [[coordinator, "coordinator"], [dev, "dev"], [writer, "writer"]])
			assert.ok(w.task.includes(`Your handover note path: ${path.join(handoffs, `${role}.md`)}.`), `${role}'s header names its own note`);
		assert.doesNotMatch(monitor.task, /handover note path|read its handover note/, "a monitor has no file tools: it hands over by team_msg");
		const list = (await h.call("team_list")).content[0].text;
		assert.match(list, /Coordinated \(team defaults\)/);
		assert.match(list, /ag_01 coordinator \(coordinator\) \[claude-code\]/);
		assert.match(list, /ag_04 monitor \(monitor\) \[claude-code\]/);
		// team_add into a coordinated team: routed and wake:false; another orchestrator is refused.
		await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "test", wake: true }] });
		assert.equal(h.worker("ag_05").wake, false);
		assert.equal(h.memberOf("ag_05")!.coordinated, true);
		assert.match(h.worker("ag_05").task, /This team has a coordinator, coordinator/);
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true }] }), /has a coordinator; it cannot take another orchestrator/);
	} finally { await h.cleanup(); }
});

test("team defaults pick the fallback when the primary cannot run, and refuse the team when neither can", async () => {
	const withFallback = { ...DEFAULTS_FILE, coordinator: { ...DEFAULTS_FILE.coordinator, primary: { backend: "claude-code", model: "invalid" }, fallback: { backend: "pi", model: "test/model", effort: "high" } } };
	const h = coordinatedHarness(withFallback);
	try {
		const r = await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		assert.match(r.content[0].text, /coordinator coordinator added on pi\/test\/model\/high \(fallback; primary claude-code\/invalid refused: Invalid Claude model\)/);
		assert.equal(h.worker("ag_01").backend, "pi");
		assert.equal(h.memberOf("ag_01")!.duty, "coordinator");
	} finally { await h.cleanup(); }
	const neither = { ...withFallback, coordinator: { ...withFallback.coordinator, fallback: { backend: "pi", model: "nope/x" } } };
	const n = coordinatedHarness(neither);
	try {
		await assert.rejects(
			n.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] }),
			/Team not created: team defaults require a coordinator \(coordinator\), but no configured model can run — primary claude-code\/invalid: Invalid Claude model; fallback pi\/nope\/x: unknown model nope\/x .*defaults\.coordinator: false/,
		);
		assert.equal(n.workers.length + n.created.length, 0, "nothing started");
		assert.equal(n.appended.filter((e) => e.customType === "subagents-team-v1").length, 0, "nothing recorded");
		const ok = await n.call("team_create", { name: "Crew", objective: "o", defaults: { coordinator: false }, members: [{ role: "dev", prompt: "p" }] });
		assert.match(ok.content[0].text, /^Created team_01 \(Crew\)/, "the name was never reserved; the escape hatch creates it plainly");
		assert.match(ok.content[0].text, /coordinator turned off for this team \(defaults\.coordinator: false\); no coordinator or monitor/);
		assert.equal(n.workers[0].wake, true);
	} finally { await n.cleanup(); }
	const noClaude = coordinatedHarness(DEFAULTS_FILE, { claude: false });
	try {
		await assert.rejects(noClaude.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] }), /primary claude-code\/opus\[1m\]\/medium: backend claude-code is not loaded; fallback: no fallback is configured/);
	} finally { await noClaude.cleanup(); }
	// The model policy is a denial like any other.
	const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-td-policy-"));
	const policyFile = path.join(policyDir, "policy.json");
	fs.writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: [], disabledModels: ["claude-code/haiku"] }));
	const p = coordinatedHarness({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, fallback: { backend: "pi", model: "test/model" } } });
	try {
		const r2 = await registerAgain(p, policyFile);
		assert.match(r2, /monitor monitor added on pi\/test\/model \(fallback; primary claude-code\/haiku\/medium refused: .*haiku/);
	} finally { await p.cleanup(); fs.rmSync(policyDir, { recursive: true, force: true }); }
});
/** A second manager on the same agent dir with a policy file: returns its team_create text. */
async function registerAgain(p: ReturnType<typeof coordinatedHarness>, policyFile: string): Promise<string> {
	const h = harness(eventBus(), { mailboxRoot: path.join(p.root, "mail2"), mailboxPollMs: 10, agentDir: p.agentDir, policyFile, setTimer: (() => ({})) as any });
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend([]));
	try {
		return (await h.call("team_create", { name: "Policy", objective: "o", members: [{ role: "dev", prompt: "p" }] })).content[0].text;
	} finally { await h.close(); }
}

test("team defaults: the caller's orchestrator is the coordinator; conflicts and the per-call limit are refused; monitor escape hatch", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		const r = await h.call("team_create", { name: "Led", objective: "o", members: [{ role: "lead", prompt: "lead", orchestrator: true }, { role: "dev", prompt: "p" }] });
		assert.match(r.content[0].text, /Team defaults: orchestrator lead is this team's coordinator\./);
		assert.doesNotMatch(r.content[0].text, /coordinator coordinator added/);
		assert.deepEqual(r.details.members.map((m: any) => [m.role, m.duty]), [["lead", "coordinator"], ["dev", undefined], ["monitor", "monitor"]]);
		assert.deepEqual([h.worker("ag_01").wake, h.worker("ag_02").wake], [true, false]);
		await assert.rejects(h.call("team_create", { name: "Two", objective: "o", members: [{ role: "a", prompt: "p", orchestrator: true }, { role: "b", prompt: "p", orchestrator: true }] }), /at most one member may have orchestrator: true \(got a, b\)/);
		await assert.rejects(h.call("team_create", { name: "Clash", objective: "o", members: [{ role: "Coordinator", prompt: "p" }] }), /Role Coordinator is the team-defaults coordinator's role \(coordinator\); rename that member, or pass defaults\.coordinator: false/);
		await assert.rejects(h.call("team_create", { name: "Clash2", objective: "o", members: [{ role: "monitor", prompt: "p" }] }), /team-defaults monitor's role/);
		await assert.rejects(
			h.call("team_create", { name: "Big", objective: "o", members: Array.from({ length: 8 }, (_, i) => ({ role: `m${i}`, prompt: "p" })) }),
			/Team defaults add 2 member\(s\) \(coordinator\/monitor\), making 10; at most 8 members start per call/,
		);
		const noMonitor = await h.call("team_create", { name: "Quiet", objective: "o", defaults: { monitor: false }, members: [{ role: "dev", prompt: "p" }] });
		assert.match(noMonitor.content[0].text, /monitor turned off for this team \(defaults\.monitor: false\)/);
		assert.deepEqual(noMonitor.details.members.map((m: any) => m.role), ["coordinator", "dev"]);
		const workers = h.workers.length + h.created.length;
		await assert.rejects(h.call("team_create", { name: "X", objective: "o", defaults: { coordinator: "no" }, members: [{ role: "dev", prompt: "p" }] }), /^Error: defaults\.coordinator must be true or false\.$/);
		assert.equal(h.workers.length + h.created.length, workers, "refused before anything starts");
	} finally { await h.cleanup(); }
});

test("routing: members report to the coordinator, the monitor stays silent, and only the coordinator reaches the parent", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), qa = h.worker("ag_03"), monitor = h.worker("ag_04");
		h.messages.length = 0;
		dev.output = "built it";
		dev.settle();
		await h.tick();
		assert.equal(h.parentMessages("subagent-complete").length, 0, "a member's completion never reaches the parent");
		assert.match(coordinator.lastSteer.message, /^\[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\]\n### ag_02 \(dev\) — waiting[\s\S]*built it[\s\S]*mcp__team__team_msg tool to "dev"/);
		assert.equal(coordinator.lastSteer.mode, "followUp");
		const steers = coordinator.steerCount;
		monitor.settle();
		await h.tick();
		assert.equal(coordinator.steerCount, steers, "a monitor check settles silently");
		monitor.status = "running";
		monitor.error = "rate limited";
		monitor.settle();
		await h.tick();
		assert.match(coordinator.lastSteer.message, /Team report from monitor \(ag_04\), team_01: failed/);
		monitor.error = undefined;
		// A killed member's completion goes nowhere.
		const before = coordinator.steerCount;
		qa.settle(undefined, "killed");
		await h.tick();
		assert.equal(coordinator.steerCount, before);
		assert.equal(h.parentMessages("subagent-complete").length, 0);
		// The coordinator's own completion: no wake while a teammate works, a wake once none does.
		dev.status = "running";
		coordinator.settle();
		assert.equal(h.parentMessages("subagent-complete").length, 1);
		assert.equal(h.parentMessages("subagent-complete")[0][1].triggerTurn, false, "an interim status does not wake the parent");
		dev.status = "waiting";
		coordinator.status = "running";
		coordinator.settle();
		assert.equal(h.parentMessages("subagent-complete")[1][1].triggerTurn, true, "a quiescent team wakes the parent");
		// Questions: a member's go to the coordinator; the coordinator's reach the operator; the monitor has none.
		h.messages.length = 0;
		const q = await h.ask("ag_02", { type: "question", message: "Which schema?" });
		assert.equal(q.ok, true);
		assert.match(q.text, /delivered to your coordinator coordinator \(ag_01\)/);
		assert.match(coordinator.lastSteer.message, /^\[Team question from dev \(ag_02\), team_01 — routed to you as coordinator\]\nWhich schema\?\nAnswer with team_msg to "dev"\./);
		assert.equal(h.parentMessages("team-question").length, 0);
		const up = await h.ask("ag_01", { type: "question", message: "Ship now?" });
		assert.equal(up.ok, true);
		assert.equal(h.parentMessages("team-question").length, 1);
		assert.equal(h.parentMessages("team-question")[0][1].triggerTurn, true);
		const mute = await h.ask("ag_04", { type: "question", message: "hello?" });
		assert.equal(mute.ok, false);
		assert.match(mute.text, /never reaches the operator/);
		// team_report: the coordinator's milestones reach the parent without starting a turn.
		const rep = await h.ask("ag_01", { type: "report", message: "Milestone: schema merged." });
		assert.equal(rep.ok, true);
		const [msg, opts] = h.parentMessages("team-report")[0];
		assert.deepEqual([msg.display, opts.deliverAs, opts.triggerTurn], [true, "followUp", false]);
		assert.match(msg.content, /^\[Team report from coordinator coordinator \(ag_01\), team_01 — Crew\]\nMilestone: schema merged\.\n\n\(Informational: no action is requested/, "no kind: the header is unchanged");
		await h.ask("ag_01", { type: "report", message: "Tests are flaky on CI.", reportKind: "concern" });
		await h.ask("ag_01", { type: "report", message: "Schema merged.", reportKind: "milestone" });
		assert.deepEqual(h.parentMessages("team-report").slice(1).map(([m]: any[]) => m.content), [
			"[Team report from coordinator coordinator (ag_01), team_01 — Crew · concern]\nTests are flaky on CI.\n\n(Informational: no action is requested. The coordinator asks questions as team-question messages.)",
			"[Team report from coordinator coordinator (ag_01), team_01 — Crew · milestone]\nSchema merged.\n\n(Informational: no action is requested. The coordinator asks questions as team-question messages.)",
		]);
		const notMine = await h.ask("ag_02", { type: "report", message: "I did it" });
		assert.equal(notMine.ok, false);
		assert.match(notMine.text, /Only the team's coordinator reports to the operator/);
		assert.match((await h.call("team_list")).content[0].text, /orchestrator report → ag_01 \(coordinator\): accepted-or-queued/);
		// No live coordinator: the parent hears a member and is woken, so the team is never orphaned.
		coordinator.status = "killed";
		h.messages.length = 0;
		dev.status = "running";
		dev.settle();
		await h.tick();
		assert.equal(h.parentMessages("subagent-complete").length, 1);
		assert.equal(h.parentMessages("subagent-complete")[0][1].triggerTurn, true);
		const orphan = await h.ask("ag_02", { type: "question", message: "Anyone?" });
		assert.equal(orphan.ok, true);
		assert.equal(h.parentMessages("team-question").length, 1, "with no live coordinator, questions reach the operator again");
	} finally { await h.cleanup(); }
});

test("the monitor: roster with context, thresholds and usage; notices recorded; wake_nudge held by the parent and bounded", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		fs.mkdirSync(path.join(h.agentDir, "cache"));
		const reset = new Date(Math.ceil((Date.now() + 3 * 3600_000) / 1000) * 1000).toISOString();
		fs.writeFileSync(path.join(h.agentDir, "cache", "usage-status.json"), JSON.stringify({
			fetchedAt: Date.now(), nextFetchAt: Date.now(), errors: {},
			claude: { state: "ok", limits: [{ label: "5h", pct: 92, resetsAt: reset }] },
			openai: { state: "ok", windows: [{ label: "7d", pct: 100, resetsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }] },
		}));
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), monitor = h.worker("ag_03");
		coordinator.usage.contextTokens = 640_000;
		monitor.usage.contextTokens = 150_000;
		const roster = await h.ask("ag_03", { type: "roster" });
		assert.equal(roster.ok, true);
		assert.match(roster.text, /ag_01 coordinator \(coordinator\) \[claude-code, has team tools\] working \(running\) · context 640k\/1M \(64%\)/);
		assert.match(roster.text, /ag_02 dev \[pi, has team tools\] working \(running\) · context — /);
		assert.match(roster.text, /ag_03 monitor \(monitor\) .* context 150k\/200k \(75%\)/);
		assert.match(roster.text, /Thresholds \(team defaults, read now\): wrap-up at 60% context · check every 10 min · usage pause at 90%, resume 5 min after the reset/);
		assert.ok(roster.text.includes(`claude 5h: 92%, resets ${reset} — AT/OVER the 90% pause threshold`), roster.text);
		assert.doesNotMatch(roster.text, /openai/, "only providers this team's models spend from");
		// Thresholds are re-read: a later file change shows at the next roster.
		fs.writeFileSync(path.join(h.agentDir, "team-defaults.json"), JSON.stringify({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, contextPct: 70 } }));
		assert.match((await h.ask("ag_03", { type: "roster" })).text, /wrap-up at 70% context/);
		assert.equal((await h.ask("ag_02", { type: "roster" })).ok, false, "a worker has no roster");
		assert.match((await h.call("team_list")).content[0].text, /ag_01 coordinator \(coordinator\) \[claude-code\] working \(running\) · context 640k\/1M \(64%\)/);
		// Notices: delivered with their kind, recorded as actions; pause/resume also as session events.
		const paused = await h.ask("ag_03", { type: "message", to: "coordinator", message: "claude 5h at 92%, resets 18:19Z", notice: "pause" });
		assert.equal(paused.ok, true);
		assert.match(coordinator.lastSteer.message, /^\[Monitor notice: PAUSE — from monitor \(ag_03\), team_01\]\nclaude 5h at 92%/);
		await h.ask("ag_03", { type: "message", to: "dev", message: "wrap up", notice: "wrap-up" });
		const actions = (await h.call("team_list")).content[0].text;
		assert.match(actions, /monitor pause → ag_01 \(coordinator\): accepted-or-queued/);
		assert.match(actions, /monitor wrap-up → ag_02 \(dev\): accepted-or-queued/);
		const events = () => h.appended.filter((e) => e.customType === "subagents-team-event-v1");
		assert.deepEqual(events().map((e) => [e.data.version, e.data.teamId, e.data.kind, e.data.workerId, e.data.role, e.data.detail]), [
			[1, "team_01", "pause", "ag_03", "monitor", "pause → coordinator: claude 5h at 92%, resets 18:19Z"],
			[1, "team_01", "wrap-up", "ag_02", "dev", "context unknown"],
		], "a delivered wrap-up is an event about the member told, not the monitor");
		// The coordinator also hears of each wrap-up; it is the member told only when it is itself over the threshold (70% now).
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "dev is over 70%", notice: "wrap-up" });
		assert.equal(events().length, 2, "64% is under the threshold: a notice about dev, not about the coordinator");
		coordinator.usage.contextTokens = 750_000;
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "you are at 75%", notice: "wrap-up" });
		assert.deepEqual(events().slice(2).map((e) => [e.data.kind, e.data.workerId, e.data.role, e.data.detail]), [["wrap-up", "ag_01", "coordinator", "context 75% of 1M"]]);
		coordinator.usage.contextTokens = 640_000;
		const forged = await h.ask("ag_02", { type: "message", to: "coordinator", message: "pause!", notice: "pause" });
		assert.equal(forged.ok, false);
		assert.match(forged.text, /Only the team's monitor sends notices/);
		// wake_nudge: schedule, list, cancel, fire; bounds from the wake-nudge extension.
		const s1 = await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m", reason: "next check" } });
		assert.match(s1.text, /^Scheduled n1 at .* \(in 10m\): next check\nWakes you as \[wake_nudge n1\]; end your turn now\.$/);
		assert.equal(h.timers.at(-1)!.ms, 600_000);
		assert.match((await h.ask("ag_03", { type: "nudge", nudge: { action: "list" } })).text, /^n1 at /);
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "cancel", id: "n1" } })).text, "Cancelled n1.");
		h.timers.at(-1)!.fn();
		assert.doesNotMatch(monitor.lastSteer?.message ?? "", /wake_nudge n1/, "a cancelled nudge never fires");
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", at: new Date(Date.now() + 3600_000).toISOString(), reason: "after reset" } });
		h.timers.at(-1)!.fn();
		await h.tick();
		assert.match(monitor.lastSteer.message, /^\[wake_nudge n2\] Scheduled wakeup fired \(set \d+s ago\)\.\nReason: after reset\nContinue your standing instruction/);
		assert.equal(monitor.lastSteer.mode, "followUp");
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "5s" } })).ok, false, "at least 10s");
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "25h" } })).ok, false, "at most 24h");
		for (let i = 0; i < 5; i++) assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "1h" } })).ok, true);
		const sixth = await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "1h" } });
		assert.match(sixth.text, /Max 5 active nudges/);
		const notMonitor = await h.ask("ag_02", { type: "nudge", nudge: { action: "list" } });
		assert.equal(notMonitor.ok, false);
		assert.match(notMonitor.text, /the team monitor's tool/);
		// 30 fires with no teammate working stop further scheduling until a teammate works again.
		for (const t of h.timers.slice(-5)) t.fn();
		dev.status = "waiting";
		coordinator.status = "waiting";
		for (let i = 0; i < 30; i++) {
			const s = await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } });
			assert.equal(s.ok, true, `fire ${i}`);
			h.timers.at(-1)!.fn();
		}
		await h.tick();
		assert.match(monitor.lastSteer.message, /Wake limit \(30 fires with no teammate working\) reached: do not schedule more nudges/);
		assert.match((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } })).text, /Wake limit/);
		dev.status = "running";
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } })).ok, true, "a working teammate resets the count");
	} finally { await h.cleanup(); }
});

test("team_succeed starts <role>-<n+1> on the same backend/model/effort; team_ready or the timeout retires the old member", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build", ownedPaths: ["src"], model: "test/model", effort: "low", tools: ["read"] }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02");
		const handoffs = h.handoffs();
		const note = path.join(handoffs, "dev.md");
		const refused = await h.ask("ag_02", { type: "succeed", to: "dev" });
		assert.equal(refused.ok, false);
		assert.match(refused.text, /Only the team's coordinator can start a successor/);
		const r = await h.ask("ag_01", { type: "succeed", to: "dev" });
		assert.equal(r.ok, true, r.text);
		// N3: the old member writes its note first; nothing starts yet.
		assert.equal(r.text, `Handover started: dev (ag_02) was told to write its handover note at ${note} and end its turn. Its successor starts once the note exists and that turn has ended, or after 10 min at the latest; a message here names it then.`);
		assert.match(dev.lastSteer.message, new RegExp(`^\\[Handover from coordinator coordinator \\(ag_01\\), team_01\\]\\nYour context is running out and a successor will take over your work\\. Finish the step you are in, then write or update your handover note at ${esc(note)} .*do no new work, and end your turn\\. Your successor starts once the note exists and your turn has ended \\(at the latest in 10 min\\)`));
		assert.equal(h.worker("ag_04"), undefined, "no successor before the note");
		assert.match((await h.ask("ag_01", { type: "succeed", to: "dev" })).text, /A successor for dev is already taking over/);
		dev.settle();
		await h.tick();
		assert.equal(h.worker("ag_04"), undefined, "a turn that ended without the note starts nothing");
		h.writeNote("dev");
		dev.status = "running";
		dev.settle();
		await h.tick();
		assert.match(coordinator.lastSteer.message, /^\[Handover in team_01: the note is written\]\nStarted dev-2 \(ag_04\) to succeed dev \(ag_02\) on pi\/test\/model\/low\. dev was told to brief it; it is retired when dev-2 calls team_ready, or after 10 min\.$/);
		const successor = h.worker("ag_04");
		assert.deepEqual([successor.name, successor.backend, successor.model, successor.effort, successor.tools, successor.wake], ["dev-2", "pi", "test/model", "low", ["read"], false]);
		assert.deepEqual([h.memberOf("ag_04")!.successorOf, h.memberOf("ag_04")!.coordinated, h.memberOf("ag_04")!.duty], ["dev", true, undefined]);
		assert.match(successor.task, new RegExp(`You succeed dev, whose context is running out\\. Start from its handover note at ${esc(note)}: continue from the state it records, do not redo steps it marks done`));
		assert.match(successor.task, /Your declared ownership: src/);
		assert.match(successor.task, /\[Your task\]\nContinue the work of dev \(ag_02\)[\s\S]*Call team_ready as soon as you have taken over/);
		assert.doesNotMatch(successor.task, /may be missing/, "the note was written first");
		assert.match(dev.lastSteer.message, new RegExp(`^\\[Handover from coordinator coordinator \\(ag_01\\), team_01\\]\\nYour successor dev-2 \\(ag_04\\) has started and is reading your handover note at ${esc(note)}\\. Answer its team_msg questions`));
		assert.equal(h.timers.at(-1)!.ms, 600_000);
		const persisted = h.appended.filter((e) => e.customType === "subagents-team-v1").at(-1);
		assert.deepEqual([persisted.data.op, persisted.data.members[0].role, persisted.data.members[0].successorOf], ["add", "dev-2", "ag_02"], "contract: successorOf is the predecessor's worker ID");
		const again = await h.ask("ag_01", { type: "succeed", to: "dev" });
		assert.match(again.text, /A successor for dev is already taking over/);
		const stray = await h.ask("ag_03", { type: "ready" });
		assert.equal(stray.ok, false, "the monitor is nobody's successor");
		const ready = await h.ask("ag_04", { type: "ready" });
		assert.equal(ready.ok, true);
		await h.tick();
		assert.equal(dev.status, "killed", "retired on confirmation");
		let list = (await h.call("team_list")).content[0].text;
		assert.match(list, /orchestrator handover → ag_02 \(dev\): accepted-or-queued/);
		assert.match(list, /member retire → ag_02 \(dev\): accepted-or-queued/);
		// Succeeding a successor: dev-2 → dev-3. dev-2 never writes a note: the wait times out and dev-3
		// starts anyway, told the note may be missing; then the retire timeout retires dev-2.
		const r2 = await h.ask("ag_01", { type: "succeed", to: "dev-2" });
		assert.match(r2.text, /^Handover started: dev-2 \(ag_04\)/);
		h.timers.at(-1)!.fn();
		await h.tick();
		assert.match(h.worker("ag_05").task, /The note may be missing or incomplete: dev-2 had not written it 10 min after it was asked to\. If it is not there, ask dev-2 with team_msg for its state before you do anything else\./);
		assert.match(coordinator.lastSteer.message, /^\[Handover in team_01: timed out waiting for the note\]\nStarted dev-3 \(ag_05\) .* The note may be missing \(dev-2 had not written it 10 min after it was asked to\); the successor was told so\.$/);
		h.timers.at(-1)!.fn();
		await h.tick();
		assert.equal(h.worker("ag_04").status, "killed");
		list = (await h.call("team_list")).content[0].text;
		assert.match(list, /system retire → ag_04 \(dev-2\): accepted-or-queued/);
		assert.equal((await h.ask("ag_05", { type: "ready" })).ok, false, "a timed-out handover is over");
		const events = h.appended.filter((e) => e.customType === "subagents-team-event-v1").map((e) => [e.data.kind, e.data.role]);
		assert.deepEqual(events, [["handover", "dev"], ["retire", "dev"], ["handover", "dev-2"], ["retire", "dev-2"]]);
		// The coordinator can succeed itself: it writes its note and ends its turn, then the successor takes over routing.
		const self = await h.ask("ag_01", { type: "succeed", to: "coordinator" });
		assert.match(self.text, new RegExp(`^Handover started for you, coordinator \\(ag_01\\): Finish the step you are in, then write or update your handover note at ${esc(path.join(handoffs, "coordinator.md"))} `));
		h.writeNote("coordinator");
		coordinator.settle();
		await h.tick();
		const next = h.worker("ag_06");
		assert.equal(next.name, "coordinator-2");
		assert.deepEqual([h.memberOf("ag_06")!.duty, h.memberOf("ag_06")!.orchestrator, h.memberOf("ag_06")!.successorOf, next.wake], ["coordinator", true, "coordinator", true]);
		h.worker("ag_05").settle();
		await h.tick();
		assert.match(next.lastSteer.message, /Team report from dev-3 \(ag_05\), team_01: finished — routed to you as coordinator/);
		const old = await h.ask("ag_01", { type: "succeed", to: "dev-3" });
		assert.match(old.text, /coordinator-2 \(ag_06\) is this team's coordinator now; only it starts successors/);
		assert.notEqual(coordinator.status, "killed", "the old coordinator stays until its successor confirms");
		// The old member ends before writing its note: its successor starts at once, told the note may be missing.
		const qa = await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "Test it." }] });
		const qaId = qa.details.members[0].workerId;
		await h.ask("ag_06", { type: "succeed", to: "qa" });
		h.worker(qaId).settle(undefined, "killed");
		await h.tick();
		const qa2 = [...h.workers, ...h.created].find((w: any) => w.name === "qa-2");
		assert.ok(qa2, "started when its predecessor ended");
		assert.match(qa2.task, /The note may be missing or incomplete: qa ended without writing it\. If it is not there, work out the state from the files it owned/);
		assert.match(qa2.task, /qa has already ended: there is nobody to ask and no team_ready to call\./);
		// Succeeding a member that had already ended: at once, and told the note may be missing.
		const late = await h.ask("ag_06", { type: "succeed", to: "qa-2" });
		assert.equal(late.ok, true, late.text);
		qa2.settle(undefined, "killed");
		await h.tick();
		[...h.workers, ...h.created].find((w: any) => w.name === "qa-3").settle(undefined, "killed");
		await h.tick();
		const r3 = await h.ask("ag_06", { type: "succeed", to: "qa-3" });
		assert.match(r3.text, /^Started qa-4 .* qa-3 has already ended; the successor works from the handover note\. The note may be missing \(qa-3 had already ended without writing it\); the successor was told so\.$/);
	} finally { await h.cleanup(); }
});

test("the coordinator sees every teammate's assignment: in its header, in team_roster with the main thread's steers, and for members added later", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		const long = `Write the docs.\n${"d".repeat(2000)}`;
		const r = await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "Write c.txt with the parser notes.", ownedPaths: ["src"] }, { role: "writer", prompt: long }] });
		const text = r.content[0].text;
		// O7: a coordinated team's result names where questions go instead of the generic paragraph.
		assert.doesNotMatch(text, /questions arrive here as team-question messages/);
		assert.match(text, /their team_ask questions go to the coordinator, not to you: only the coordinator's team_ask .* and team_report \(informational\) reach the main thread/);
		// Q6: never stop the coordinator or the monitor while a member works.
		assert.match(text, /Do not stop \(agent_kill\) the coordinator or the monitor while any member is still working: .* Once no member is working, stopping them is fine\./);
		assert.ok(h.tools.get("team_create").promptGuidelines.some((g: string) => /Never stop a coordinated team's coordinator or monitor while any of its members is still working/.test(g)));
		// N6: team_list says the same, not "questions arrive here".
		const listed = (await h.call("team_list")).content[0].text;
		assert.doesNotMatch(listed, /questions arrive here/);
		assert.match(listed, /their team_ask questions go to the coordinator, not to you/);
		assert.match(listed, /Coordinated \(team defaults\): members report to the coordinator; only it reaches you\. Do not stop \(agent_kill\) the coordinator or the monitor while any member is still working/);
		const plain = coordinatedHarness();
		try {
			assert.match((await plain.call("team_create", { name: "Plain", objective: "o", members: [{ role: "dev", prompt: "p" }] })).content[0].text, /questions arrive here as team-question messages/, "an uncoordinated team keeps the generic paragraph");
			assert.match((await plain.call("team_list")).content[0].text, /questions arrive here as team-question messages/);
		} finally { await plain.cleanup(); }
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), monitor = h.worker("ag_04");
		// B1: the header quotes each teammate's task; long ones are cut with a marker.
		assert.match(coordinator.task, /- dev: src\n {2}Assigned task \(from the main thread\):\n {2}\| Write c\.txt with the parser notes\.\n- writer: none declared\n {2}Assigned task \(from the main thread\):\n {2}\| Write the docs\.\n {2}| d{1484}\n {2}\| \[… 516 more chars; ask writer with team_msg for the rest\]\n- monitor \(monitor\): none declared\n/);
		assert.match(coordinator.task, /Never invent tasks, never reassign or cancel a teammate's assigned work, and never tell a teammate that its task was not assigned: the main thread's steers and follow-ups to a member are legitimate assignments you must not countermand\./);
		assert.match(coordinator.task, /\[Your task\]\nCoordinate this team toward the objective\. Check team_roster and read each teammate's assigned task/);
		// O1 and O3 in the coordinator's standing text.
		assert.match(coordinator.task, /When the monitor flags a member over its context threshold and that member's assigned work is not verifiably finished, call team_succeed \{ role \}.*Decline only if the member has already completed its assigned task\./);
		assert.match(coordinator.task, /On a monitor "pause" notice: .*report the pause to the operator with team_report .* On "resume": restart them with team_steer and report the resume with team_report\./);
		assert.doesNotMatch(dev.task, /Assigned task/, "only the coordinator is shown teammates' tasks");
		assert.doesNotMatch(monitor.task, /Assigned task/);
		// The main thread's steers are kept as assignments; the roster shows them to the coordinator only.
		await h.call("agent_steer", { id: "ag_02", message: "Also read CLAUDE.md\nand summarise it.", mode: "followUp" });
		const roster = (await h.ask("ag_01", { type: "roster" })).text;
		assert.match(roster, /Assignments from the main thread \(the work you route; never replace or cancel it\):\n {4}ag_02 dev:\n {6}\| Write c\.txt with the parser notes\.\n {6}Later instructions from the main thread \(assignments too\), newest last:\n {6}> Also read CLAUDE\.md and summarise it\.\n {4}ag_03 writer:\n {6}\| Write the docs\./);
		assert.doesNotMatch((await h.ask("ag_04", { type: "roster" })).text, /Assignments from the main thread/);
		const coordinatorSteers = await h.ask("ag_01", { type: "steer", to: "dev", message: "focus" });
		assert.equal(coordinatorSteers.ok, true);
		assert.doesNotMatch((await h.ask("ag_01", { type: "roster" })).text, /> focus/, "the coordinator's own steers are not the main thread's");
		// team_add: the coordinator is told, with the new member's task, and the roster lists it.
		const added = await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "Test the parser." }] });
		assert.match(added.content[0].text, /Coordinator coordinator \(ag_01\) was told about the new member\(s\) and their assignments\./);
		assert.match(coordinator.lastSteer.message, /^\[Team change from the main thread, team_01: 1 member\(s\) added — their assignments are legitimate work for you to route, not to replace\]\n- qa \(ag_05\), owns: none declared\n {2}\| Test the parser\.\nteam_roster lists every assignment\.$/);
		assert.equal(coordinator.lastSteer.mode, "followUp");
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_05 qa:\n {6}\| Test the parser\./);
		// N2: a successor carries its predecessor's assignment AND every main-thread steer, in its own
		// task and in the coordinator's view (e2e: a follow-up was lost across a succession).
		await h.call("agent_steer", { id: "ag_02", message: "After c.txt, also write summary.txt.", mode: "followUp" });
		await h.ask("ag_01", { type: "succeed", to: "dev" });
		h.writeNote("dev");
		dev.settle();
		await h.tick();
		const successor = h.worker("ag_06");
		assert.match(successor.task, /\[Your task\]\nContinue the work of dev \(ag_02\)[\s\S]*\n\nIts assignment from the main thread:\nWrite c\.txt with the parser notes\.\n\nLater instructions from the main thread to dev \(assignments too, oldest first; the newest may not have been started\):\n- Also read CLAUDE\.md\n {2}and summarise it\.\n- After c\.txt, also write summary\.txt\.$/);
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_06 dev-2:\n {6}\| Write c\.txt with the parser notes\.\n {6}Later instructions from the main thread \(assignments too\), newest last:\n {6}> Also read CLAUDE\.md and summarise it\.\n {6}> After c\.txt, also write summary\.txt\./);
		// Persisted for a reload: the task, every steer, and the successor's inheritance.
		assert.deepEqual(h.appended.filter((e) => e.customType === "subagents-team-assignment-v1").map((e) => [e.data.workerId, e.data.op]), [
			["ag_02", "task"], ["ag_03", "task"], ["ag_02", "steer"], ["ag_05", "task"], ["ag_02", "steer"], ["ag_06", "task"], ["ag_06", "inherit"],
		]);
		// A coordinator's successor is shown every assignment in its header too.
		await h.ask("ag_01", { type: "succeed", to: "coordinator" });
		h.writeNote("coordinator");
		coordinator.settle();
		await h.tick();
		assert.match(h.worker("ag_07").task, /- dev-2: src\n {2}Assigned task \(from the main thread\):\n {2}\| Write c\.txt with the parser notes\./);
		assert.match(h.worker("ag_07").task, /- qa: none declared\n {2}Assigned task \(from the main thread\):\n {2}\| Test the parser\./);
	} finally { await h.cleanup(); }
});

test("a monitor's successor: the monitor task, team_ready on both backends, and a handover by team_msg with no note", async () => {
	for (const backend of ["claude-code", "pi"] as const) {
		const file = { ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, primary: backend === "pi" ? { backend: "pi", model: "test/model", effort: "low" } : DEFAULTS_FILE.monitor.primary } };
		const h = coordinatedHarness(file);
		try {
			await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
			const old = h.worker("ag_03");
			const r = await h.ask("ag_01", { type: "succeed", to: "monitor" });
			assert.equal(r.ok, true, r.text);
			const next = h.worker("ag_04");
			assert.equal(next.backend, backend);
			const me = h.memberOf("ag_04")!;
			assert.deepEqual([me.duty, me.successorOf], ["monitor", "monitor"]);
			// B2: the successor monitor really has team_ready (the same list feeds member.ts and member-mcp.ts).
			assert.ok(memberToolNames(me).includes("team_ready"), `${backend}: team_ready`);
			assert.deepEqual(next.tools, [], "still no built-in tools");
			// B4: the monitor's task, not a worker's.
			assert.match(next.task, /\[Your task\]\nYou take over from the monitor monitor \(ag_03\)\. .*call team_ready once you have taken over, then: Run your standing instruction now: call team_roster once/);
			assert.doesNotMatch(next.task, /Continue the work of/);
			// B3: no note anywhere in the monitor handover.
			assert.doesNotMatch(next.task, /handover note at|handover note path/);
			assert.match(next.task, /You succeed the monitor monitor\. It has no handover note: it briefs you over team_msg\./);
			assert.match(old.lastSteer.message, /^\[Handover from coordinator coordinator \(ag_01\), team_01\]\nYour successor monitor-2 \(ag_04\) is starting\. You have no handover note: brief it with team_msg now/);
			assert.doesNotMatch(old.lastSteer.message, /Finish or update that note|will read your handover note/);
			const ready = await h.ask("ag_04", { type: "ready" });
			assert.equal(ready.ok, true, ready.text);
			await h.tick();
			assert.equal(old.status, "killed", `${backend}: retired on team_ready, not at the timeout`);
		} finally { await h.cleanup(); }
	}
});

test("an idle team holds the monitor's checks until a teammate works again; a paused team's resume check still fires", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), monitor = h.worker("ag_03");
		dev.status = "waiting";
		coordinator.status = "waiting";
		monitor.lastSteer = undefined;
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m", reason: "next check" } });
		h.timers.at(-1)!.fn();
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m", reason: "later check" } });
		h.timers.at(-1)!.fn();
		await h.tick(150);
		assert.equal(monitor.lastSteer, undefined, "nobody is working: no monitor turn");
		assert.match((await h.ask("ag_03", { type: "nudge", nudge: { action: "list" } })).text, /^n1 held: came due while no teammate was working; delivered when one starts: next check$/, "later fires collapse into the held one");
		// A teammate starts working (the main thread steers it): the held check goes out.
		await h.call("agent_steer", { id: "ag_02", message: "more work" });
		await h.tick(150);
		assert.match(monitor.lastSteer.message, /^\[wake_nudge n1\] Scheduled wakeup fired \(set \d+s ago\); held while no teammate was working, delivered now that one is\.\nReason: next check\nContinue your standing instruction/);
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "list" } })).text, "No pending nudges.");
		// A worker state change alone (no steer) releases a held check too.
		dev.status = "waiting";
		monitor.lastSteer = undefined;
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } });
		h.timers.at(-1)!.fn();
		await h.tick(150);
		assert.equal(monitor.lastSteer, undefined);
		dev.status = "running";
		dev.change();
		await h.tick(150);
		assert.match(monitor.lastSteer?.message ?? "", /^\[wake_nudge n3\]/);
		// Paused: everyone idle, yet the resume check fires on time.
		dev.status = "waiting";
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "zai 5h at 95%", notice: "pause" });
		coordinator.status = "waiting";
		monitor.lastSteer = undefined;
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "30m", reason: "resume check" } });
		h.timers.at(-1)!.fn();
		await h.tick();
		assert.match(monitor.lastSteer?.message ?? "", /^\[wake_nudge n4\] Scheduled wakeup fired \(set \d+s ago\)\.\nReason: resume check/);
		// After resume, an idle team is held again.
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "window reset", notice: "resume" });
		coordinator.status = "waiting";
		monitor.lastSteer = undefined;
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } });
		h.timers.at(-1)!.fn();
		await h.tick(150);
		assert.equal(monitor.lastSteer, undefined);
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "cancel", id: "n5" } })).text, "Cancelled n5.", "a held check can be cancelled");
	} finally { await h.cleanup(); }
});

test("/team defaults prints the effective defaults, off, or the malformed reason, and sends nothing", async () => {
	for (const [file, expected] of [[undefined, /^Team defaults: off \(no file at .*team-defaults\.json\)/], ["{", /is malformed[\s\S]*not valid JSON/], [DEFAULTS_FILE, /^Team defaults \(.*\):\n {2}Coordinator: on — role "coordinator"/]] as const) {
		const h = coordinatedHarness(file);
		try {
			await h.commands.get("team").handler("defaults", h.ctx);
			assert.match(h.notices.at(-1)[0], expected);
			assert.equal(h.messages.length, 0);
			assert.equal(h.workers.length, 0);
		} finally { await h.cleanup(); }
	}
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.commands.get("team").handler("ship the parser", h.ctx);
		assert.match(h.messages[0][0].content, /- Team defaults are on: team_create adds a coordinator "coordinator" \(claude-code\/opus\[1m\]\)[\s\S]*a monitor "monitor"/);
	} finally { await h.cleanup(); }
});
