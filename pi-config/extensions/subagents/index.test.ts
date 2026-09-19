import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { MEMBER_EXTENSION, MEMBER_MCP, registerSubagents, boundedText, installedPackageDir, type SubagentsOptions } from "./index.ts";
import { SubagentRunner } from "./runner.ts";
import { MEMBER_ENV, awaitResponse, decodeMemberContext, memberPaths, readInbox, requestId, writeRequest, type MailboxRequest } from "./mailbox.ts";

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

function harness(bus = eventBus(), options: SubagentsOptions = {}) {
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
		assert.deepEqual(snapshots, [{ version: 1, workers: [] }]);
		h.bus.emit("subagents:workers-request", { version: 2 });
		assert.equal(snapshots.length, 1);
		await h.start();
		assert.deepEqual(snapshots.at(-1), { version: 1, workers: [] });
		await h.call("agent_spawn", { prompt: "background task", wake: false });
		const a = h.workers[0];
		assert.deepEqual(snapshots.at(-1).workers, [{ id: a.id, name: a.name,
			status: "running", model: "test/model", preview: "No response yet.", backend: "pi" }]);
		// Additive presence fields come straight from the Worker; unset/invalid values are omitted.
		Object.assign(a, { startedAt: 1_000, lastActivity: 2_000, endedAt: Number.NaN, taskOutcome: "bogus", pid: 4242 });
		request();
		assert.deepEqual(snapshots.at(-1).workers[0], { id: a.id, name: a.name, status: "running", model: "test/model",
			preview: "No response yet.", backend: "pi", startedAt: 1_000, lastActivity: 2_000 });
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
			startedAt: 1_000, lastActivity: 2_000 });
		Object.assign(a, { sessionFile: "", sessionId: 42 });
		request();
		for (const key of ["sessionFile", "sessionId"]) assert.ok(!(key in snapshots.at(-1).workers[0]), key);
		Object.assign(a, { sessionFile: undefined, sessionId: undefined });
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
		assert.deepEqual(snapshots.at(-1), { version: 1, workers: [] });
		const count = snapshots.length;
		request();
		await closing;
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(snapshots.length, count);
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
		assert.deepEqual(h.workers[0].extensions, ["npm:definitely-not-installed-xyz", "git:github.com/x/y"]);
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
		assert.match(list.content[0].text, /ag_01 lead \[claude-code\] working \(running\) · owns: none declared/);
		assert.match(list.content[0].text, /ag_02 docs \[claude-code\] working \(running\) · owns: docs\//);
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
		assert.deepEqual(lead.extensions, [MEMBER_EXTENSION], "only member.ts, never the manager");
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
		assert.deepEqual(h.workers.at(-1).extensions, []);
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
		assert.match(roster.text, /^team_01 — Crew · 2 working\nObjective: Ship\n  ag_01 lead \(orchestrator\) \[pi, has team tools\] working \(running\) · owns: none declared\n  ag_02 dev \[pi, has team tools\] working \(running\) · owns: src\n  Recent actions:\n    #1 orchestrator followUp → ag_02 \(dev\): accepted-or-queued/);
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
