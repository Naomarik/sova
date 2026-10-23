import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import * as os from "node:os";
import { CLAUDE_CODE_EXTENSION, MARKER_EXTENSION, MODEL_LEVELS_EXTENSION, PROVIDER_LIMITS_EXTENSION, SPEC_CORE_DIR, SPEC_WORKER_EXTENSION, SPEC_HOOK_STATE, MEMBER_EXTENSION, PROJECT_TOOLS_WORKER_EXTENSION, REMOTE_EXTENSION, registerSubagents, boundedText, installedPackageDir, resolveExtensionSource, type SubagentsOptions } from "./index.ts";
import { CLAUDE_PROVIDER_FLAG } from "../claude-code/provider/index.ts";
import { claudeOffer } from "../claude-code/catalog.ts";
import { placeholderDir } from "../remote/argv.ts";
import { REMOTE_SESSION_EVENT } from "../remote/workers.ts";
import { MODE_DISCOVER_EVENT, MODE_STATE_EVENT } from "../mode/state.ts";
/** The retired worker-ledger variable: no worker is given it now. */
const LEDGER_ENV = "SOVA_SPEC_LEDGER";
import { workerSpecBrief } from "./spec-brief.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT, type SandboxStateEvent, type WorkerLaunch } from "../sandbox/state.ts";
import { MODE_WORKER_DISCOVER_EVENT, MODE_WORKER_EVENT, WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT, type ModeWorkerEvent } from "../mode/events.ts";
import workerMarkExtension from "./worker-mark.ts";
import { CLAUDE_CODE_PROVIDER_FLAG } from "./runner.ts";
import { ChatWorker } from "./chat-worker.ts";
import type { WorkerHost } from "./worker-host.ts";
import { MEMBER_ENV, awaitResponse, decodeMemberContext, memberPaths, memberToolNames, readInbox, requestId, writeRequest, type MailboxRequest } from "./mailbox.ts";
import { readMemberItems, writeInboxCaps, type InboxItem } from "./inbox.ts";

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
					(this.steered ??= []).push({ message, mode });
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
		id: "native-cli",
		validate(spec) {
			if (spec.fork || spec.extensions !== undefined || spec.agentType !== undefined) throw new Error("Unsupported Claude option");
			if (spec.model === "invalid") throw new Error("Invalid Claude model");
		},
		prepare(spec, ctx) {
			assert.ok(ctx.cwd);
			return { model: spec.model ?? "claude-sonnet-5-5", backendOptions: { permissionMode: "default", ...spec.backendOptions } };
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
			status: "running", model: "test/model", preview: "No response yet.", backend: "pi", effort: "high", turns: 0 }]);
		// Additive presence fields come straight from the Worker; unset/invalid values are omitted.
		Object.assign(a, { startedAt: 1_000, lastActivity: 2_000, endedAt: Number.NaN, taskOutcome: "bogus" });
		request();
		assert.deepEqual(snapshots.at(-1).workers[0], { id: a.id, name: a.name, status: "running", model: "test/model",
			preview: "No response yet.", backend: "pi", effort: "high", startedAt: 1_000, lastActivity: 2_000, turns: 0 });
		// The live process's pid rides the in-process event only (Sova's resource monitor); the
		// sessions extension never copies it into the on-disk record (sessions/workers.test.ts).
		// Omitted once the process is gone, and when absent or not a positive integer.
		Object.assign(a, { pid: 4242, processAlive: true });
		request();
		assert.equal(snapshots.at(-1).workers[0].pid, 4242);
		a.processAlive = false;
		request();
		assert.ok(!("pid" in snapshots.at(-1).workers[0]));
		a.processAlive = true;
		for (const pid of [0, -1, 1.5, Number.NaN, undefined]) {
			a.pid = pid;
			request();
			assert.ok(!("pid" in snapshots.at(-1).workers[0]), String(pid));
		}
		Object.assign(a, { pid: undefined, processAlive: undefined });
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
			effort: "high", startedAt: 1_000, lastActivity: 2_000, turns: 0 });
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
		// Model replies ride top-level beside usage (sessions WorkerEntry.turns), so a usage trim keeps them.
		h.workers[0].usage.turns = 3;
		request();
		assert.equal(snapshots.at(-1).workers[0].turns, 3);
		assert.equal(snapshots.at(-1).workers[1].turns, 0, "a live worker with no reply yet has a known 0");
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
			{ prompt: "Claude background task", backend: "native-cli", wake: false },
		] });
		assert.equal(snapshots.at(-1).workers.length, 2);
		assert.equal(snapshots.at(-1).workers[1].model, "claude-sonnet-5-5");
		assert.equal(snapshots.at(-1).workers[1].preview, "Claude result");
		assert.equal(snapshots.at(-1).workers[1].backend, "native-cli");
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
		await assert.rejects(h.call("agent_spawn", { prompt: "task", backend: "native-cli", count: 2 }), /factory failed/);
		h.bus.emit("subagents:workers-request", { version: 1 });
		assert.ok(snapshots.length);
		assert.ok(snapshots.every(snapshot => snapshot.workers.length === 0));
	} finally { off(); offBackend(); await h.close(); }
});

test("agent_models discovers active Pi and native backend models with explicit errors", async () => {
	const h = harness();
	let cliCalls = 0;
	h.ctx.modelRegistry.getAvailable = () => [{ provider: "ollama-cloud", id: "deepseek-v4.1-flash", name: "DeepSeek" }];
	const backend = { ...fakeBackend([]), listModels: async () => { cliCalls++; return [{ id: "claude-opus-5-5", name: "Opus", efforts: ["low", "medium"] }]; } };
	registerBackend(h.bus as any, backend);
	try {
		const pi = await h.call("agent_models", { query: "deepseek 4.1 flash", backend: "pi" });
		assert.equal(pi.details.models[0].id, "ollama-cloud/deepseek-v4.1-flash");
		assert.equal(cliCalls, 0);
		const all = await h.call("agent_models", {});
		assert.equal(all.details.models.length, 2 + claudeOffer().length, "pi, the registered backend, and claude-code's catalog");
		assert.equal(all.details.models.find((m: any) => m.backend === "native-cli").efforts[0], "low");
		assert.deepEqual(all.details.models.filter((m: any) => m.backend === "claude-code").map((m: any) => m.id).sort(), claudeOffer().map((m) => m.id).sort());
		assert.ok(all.details.backends.includes("claude-code"));
		assert.equal(cliCalls, 1);
		assert.equal((await h.call("agent_models", { backend: "missing" })).details.errors[0].backend, "missing");
		const limited = await h.call("agent_models", { limit: 1 });
		assert.equal(limited.details.models.length, 1);
		assert.equal(limited.details.totalMatches, 2 + claudeOffer().length);
	} finally { await h.close(); }
});

test("/subagents and /agents only open the monitor: arguments are ignored, no model picker or editor text", async () => {
	const h = harness();
	h.ctx.modelRegistry.getAvailable = () => [{ provider: "ollama-cloud", id: "deepseek-v4.1-flash", name: "DeepSeek" }];
	const opened: string[] = [];
	h.ctx.ui.custom = async (factory: any) => new Promise((resolve) => {
		const view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
		opened.push(view.constructor.name);
		resolve(undefined);
	});
	h.ctx.ui.select = async () => { throw new Error("no picker"); };
	h.ctx.ui.setEditorText = () => { throw new Error("no editor text"); };
	try {
		for (const name of ["subagents", "agents"]) {
			const command = h.commands.get(name);
			assert.equal(command.description, "Open the subagent monitor");
			assert.equal(command.getArgumentCompletions, undefined);
			await command.handler("models deepseek 4.1 flash", h.ctx);
		}
		assert.deepEqual(opened, ["AgentsModal", "AgentsModal"]);
		assert.equal(h.workers.length, 0);
	} finally { await h.close(); }
});

test("a claude-code team member is a pi worker on the Claude Code provider: its model, effort, tools and the member extension", async () => {
	const h = harness();
	try {
		await h.call("team_create", {
			name: "claude",
			objective: "Claude members run on Sova's tools",
			defaults: { backend: "claude-code" },
			members: [{ role: "builder", prompt: "build", tools: ["Read", "Glob", "bash"], effort: "xhigh" }],
		});
		const w = h.workers[0];
		assert.equal(w.backend, "pi");
		assert.equal(w.model, "claude-code-cli/claude-sonnet-5-5");
		assert.equal(w.effort, "xhigh");
		assert.deepEqual(w.tools, ["read", "find", "bash"]);
		assert.ok(w.extensions.includes(MEMBER_EXTENSION));
		assert.ok(w.extensions.includes(CLAUDE_CODE_EXTENSION));
		assert.equal(w.flags[CLAUDE_CODE_PROVIDER_FLAG], true);
		assert.ok(decodeMemberContext(w.env?.[MEMBER_ENV]), "the member identity rides the pi worker's env");
		assert.equal(w.mcpServers, undefined);
	} finally { await h.close(); }
});

test("claude-code spawns: catalog ids, Claude tool names, effort and backendOptions map onto the pi worker, or are refused with the reason", async () => {
	const h = harness();
	try {
		h.ctx.modelRegistry.find = () => undefined; // the child registers the provider itself
		await h.call("agent_spawn", { prompt: "old id", backend: "claude-code", model: "opus[1m]", wake: false });
		assert.equal(h.workers[0].model, "claude-code-cli/claude-opus-5-5", "an old id runs as its catalog id");
		assert.equal(h.workers[0].effort, "medium");
		assert.deepEqual(h.workers[0].tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
		await h.call("agent_spawn", { prompt: "plan", backend: "claude-code", backendOptions: { permissionMode: "plan" }, wake: false });
		assert.deepEqual(h.workers[1].tools, ["read", "grep", "find", "ls"]);
		await h.call("agent_spawn", { prompt: "unknown", backend: "claude-code", model: "claude-opus-6", wake: false });
		assert.equal(h.workers[2].model, "claude-code-cli/claude-opus-6");
		assert.equal(h.workers[2].flags["claude-code-model"], "claude-opus-6", "an id the catalog doesn't know is registered by the child");
		const r = await h.call("agent_spawn", { prompt: "unknown again", backend: "claude-code", model: "claude-opus-6", wake: false });
		assert.match(r.content[0].text, /Not verified: claude-opus-6 is not in Sova's Claude catalog\. It will still be used\./);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", tools: ["WebFetch"] }), /Claude workers run on Sova's tools: .*"WebFetch" has no equivalent/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", backendOptions: { permissionMode: "manual" } }), /permissionMode manual is not supported/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", backendOptions: { maxBudgetUsd: 1 } }), /maxBudgetUsd is not supported/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", backendOptions: { allowedTools: ["Bash(git:*)"] } }), /allowedTools is not supported/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", effort: "minimal" }), /Claude effort must be low, medium, high, xhigh, or max/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "claude-code", model: "zai/glm-5.3" }), /Claude model must be a Claude model ID/);
		assert.equal(h.workers.length, 4, "a refused spec starts nothing");
		const listed = await h.call("agent_list");
		assert.equal(listed.details.agents[0].backend, "pi");
	} finally { await h.close(); }
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
			const r = await h.call("agent_spawn", { prompt: "task", backend: "native-cli", backendOptions: { permissionMode: "plan" } });
			assert.equal(h.workers.length, 0);
			assert.equal(created.length, 1);
			assert.equal(created[0].model, "claude-sonnet-5-5");
			assert.equal(created[0].effort, undefined);
			assert.equal(created[0].tools, undefined);
			assert.equal(created[0].backendOptions.permissionMode, "plan");
			assert.equal(r.details.spawned[0].backend, "native-cli");
			created[0].settle();
			assert.equal(h.messages.length, 1);
			const listed = await h.call("agent_list");
			assert.equal(listed.details.agents[0].backend, "native-cli");
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
		worker.model = "claude-opus-5-5"; worker.effort = "high"; worker.backend = "claude-code";
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\nModel: claude-opus-5-5 · thinking: high · backend: claude-code\n/);
		// Errors stay above the metadata; empty output is still disclosed.
		worker.backend = "pi"; worker.output = ""; worker.error = "boom";
		text = (await h.call("agent_transcript", { id: worker.id })).content[0].text;
		assert.match(text, /\nError: boom\nSession: .*\nModel: claude-opus-5-5 · thinking: high\n\(no output yet — task in progress\)$/);
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
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "native-cli" }), /unavailable backend/);
		h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), version: 2 });
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "native-cli" }), /unavailable backend/);
		h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "native-cli", model: "invalid" }] }), /Invalid Claude model/);
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "claude", backend: "native-cli" }, { prompt: "pi", model: "missing/model" }] }), /Unknown model/);
		assert.equal(h.workers.length, 0); assert.equal(created.length, 0);
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "x", backend: "native-cli" }], backend: "pi" }), /^Error: backend is set beside agents and differently in agents\[0\]/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backendOptions: {} }), /not supported/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", backend: "native-cli", fork: true }), /Unsupported/);
		await h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "native-cli", model: "claude-opus-5-5" }] });
		assert.equal(h.workers.length, 1); assert.equal(created.length, 1);
	} finally { await h.close(); }
});

test("model policy disables providers and models for spawns, teams and discovery", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-policy-harness-"));
	const policyFile = path.join(dir, "settings.json");
	const writePolicy = (providers: string[], models: string[]) =>
		fs.writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: providers, disabledModels: models }));
	const h = harness(eventBus(), { policyFile });
	h.ctx.modelRegistry.getAvailable = () => [
		{ provider: "test", id: "model", name: "Test Model" },
		{ provider: "zai", id: "glm-5.3", name: "GLM" },
	];
	const catalog = claudeOffer().map((m) => m.id);
	try {
		// No policy file yet: everything is spawnable and discoverable.
		let models = await h.call("agent_models", {});
		assert.deepEqual(models.details.models.map((m: any) => m.id).sort(), [...catalog, "test/model", "zai/glm-5.3"].sort());
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
		assert.deepEqual(models.details.models.map((m: any) => m.id).sort(), [...catalog, "test/model"].sort());

		// Backend-level rules: a disabled backend id rejects model-less specs (their default is
		// still that provider's model) and explicit ones; single backend models can be disabled
		// under the "backend/model" spelling while the backend stays allowed.
		writePolicy(["claude-code"], []);
		await assert.rejects(h.call("agent_spawn", { prompt: "default model", backend: "claude-code", wake: false }), /Backend claude-code is disabled/);
		await assert.rejects(h.call("agent_spawn", { prompt: "explicit model", backend: "claude-code", model: "claude-sonnet-5-5", wake: false }), /Backend claude-code is disabled/);
		writePolicy([], ["claude-code/claude-opus-5-5"]);
		await assert.rejects(h.call("agent_spawn", { prompt: "opus gone", backend: "claude-code", model: "Claude-Opus-5-5", wake: false }), /claude-opus-5-5 is disabled/i, "the policy matches whatever the case; the catalog id runs");
		await h.call("agent_spawn", { prompt: "sonnet stays", backend: "claude-code", model: "claude-sonnet-5-5", wake: false });
		assert.equal(h.workers.at(-1).model, "claude-code-cli/claude-sonnet-5-5");
		models = await h.call("agent_models", { backend: "claude-code" });
		assert.deepEqual(models.details.models.map((m: any) => m.id).sort(), catalog.filter((id) => id !== "claude-opus-5-5").sort());

		// The team path shares spawnBatch, so a disabled member model is rejected there too.
		writePolicy([], ["claude-code/claude-sonnet-5-5"]);
		await assert.rejects(
			h.call("team_create", { name: "blocked", objective: "o", members: [{ role: "r", prompt: "p", backend: "claude-code", model: "claude-sonnet-5-5" }] }),
			/claude-sonnet-5-5 is disabled/,
		);

		// Nothing but the two allowed controls ever started.
		assert.equal(h.workers.length, 2);
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
		const refusing = { start: () => { throw new Error("synchronous spawn failure"); } } as unknown as WorkerHost;
		const worker = new ChatWorker(options, handlers, { host: refusing, parent: { sessionId: "s", path: "/s.jsonl" }, start: { key: "k", defaultSessionDir: () => "/d" } });
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
		await h.call("agent_spawn", { prompt: "task", backend: "native-cli", cwd: "extensions" });
		await h.call("agent_spawn", { prompt: "task", backend: "native-cli" });
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
		assert.equal(h.messages.length, 56); // idle + all 55 completions; the wait returned selected's
		assert.ok(!h.messages.some(m => m[0].content.includes("selected result survives eviction")));
		await h.call("agent_spawn", { prompt: "new", name: selected.id, groupLabel: "run_02" });
		assert.equal(h.workers.at(-1).id, "ag_59");
		await assert.rejects(h.call("agent_transcript", { id: selected.id }), /unavailable.*6 finished worker/);
		await assert.rejects(h.call("agent_kill", { group: "run_02" }), /unavailable.*5 empty run/);
		await assert.rejects(h.call("agent_transcript", { id: "missing-name" }), /No such subagent: missing-name.*6 finished worker/);
		await assert.rejects(h.call("agent_kill", { group: "missing-label" }), /No such run: missing-label.*5 empty run/);
		assert.equal(h.workers.at(-1).status, "running");
	} finally { await h.close(); }
});

const completions = (h: { messages: any[] }) => h.messages.filter(([m]: any[]) => m.customType === "subagent-complete");

test("agent_wait: settles it returns are not also sent as subagent-complete; a later unwaited settle is", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] });
		const [w1, w2, w3] = h.workers;
		const waiting = h.call("agent_wait", { ids: [w1.id, w2.id, w3.id] });
		for (const [i, w] of [w1, w2, w3].entries()) {
			w.output = `answer ${i + 1}`;
			w.settle();
		}
		assert.equal(completions(h).length, 0, "nothing is sent while the wait collects");
		const text = (await waiting).content[0].text;
		for (const w of [w1, w2, w3]) assert.match(text, new RegExp(`### ${w.id} \\(${w.name}\\) — waiting\\n[\\s\\S]*${w.output}`));
		assert.equal(completions(h).length, 0, "the wait result is the parent's only copy");
		assert.equal(h.notices.length, 3, "the toast is unchanged");
		await h.call("agent_steer", { id: w2.id, message: "again" });
		w2.output = "answer 2b";
		w2.settle();
		assert.equal(completions(h).length, 1);
		assert.match(completions(h)[0][0].content, /answer 2b/);
		assert.equal(completions(h)[0][1].triggerTurn, true);
	} finally { await h.close(); }
});

for (const end of ["abort", "timeout"] as const) {
	test(`agent_wait (${end}): a settle the cancelled or timed-out wait returned is not sent; a later one is`, async () => {
		const h = harness();
		try {
			await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
			const [w1, w2] = h.workers;
			const controller = new AbortController();
			const waiting = h.call("agent_wait", { ids: [w1.id, w2.id], ...(end === "timeout" ? { timeoutSeconds: 0.3 } : {}) }, controller.signal);
			w1.output = "w1 done";
			w1.settle();
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(completions(h).length, 0, "no message while the wait is pending");
			if (end === "abort") controller.abort();
			const result = await waiting;
			assert.match(result.content[0].text, end === "abort" ? /^Cancelled wait/ : /^Timed out; still working: ag_02/);
			assert.match(result.content[0].text, /### ag_01 \(.*\) — waiting\n[^#]*w1 done/);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(completions(h).length, 0, "no message follows the returned settle");
			w2.output = "w2 done";
			w2.settle();
			assert.equal(completions(h).length, 1);
			assert.match(completions(h)[0][0].content, /^### ag_02[\s\S]*w2 done/);
		} finally { await h.close(); }
	});
}

test("agent_wait: a collected settle whose worker re-ran before the wait returned is sent once", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "a" });
		const [w1] = h.workers;
		const waiting = h.call("agent_wait", { ids: [w1.id], timeoutSeconds: 0.3 });
		w1.output = "first answer";
		w1.settle();
		// A queued steer starts the next task before the wait looks again.
		w1.status = "running";
		w1.output = undefined;
		assert.equal(completions(h).length, 0);
		const text = (await waiting).content[0].text;
		assert.match(text, /^Timed out; still working: ag_01/);
		assert.doesNotMatch(text, /first answer/);
		assert.equal(completions(h).length, 1, "the unreported settle is sent when the wait returns");
		assert.match(completions(h)[0][0].content, /— waiting\n[^#]*first answer/);
		assert.equal(completions(h)[0][1].triggerTurn, true);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(completions(h).length, 1, "exactly once");
	} finally { await h.close(); }
});

test("agent_wait: overlapping waits release a held settle once, after the last returns, unless one returned it", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
		const [w1, w2] = h.workers;
		// The first wait returns w1's settle; the second still sees it re-running and must not resend it.
		const a = h.call("agent_wait", { ids: [w1.id] });
		const b = h.call("agent_wait", { ids: [w1.id, w2.id], timeoutSeconds: 1 });
		w1.output = "w1 first";
		w1.settle();
		assert.match((await a).content[0].text, /w1 first/);
		w1.status = "running";
		w1.output = undefined;
		w2.output = "w2 done";
		w2.settle();
		assert.doesNotMatch((await b).content[0].text, /w1 first/);
		assert.equal(completions(h).length, 0, "the first wait returned w1's settle");
		// Neither wait returned it: one message, sent when the last of them returns.
		const c = h.call("agent_wait", { ids: [w1.id], timeoutSeconds: 0.2 });
		const d = h.call("agent_wait", { ids: [w1.id], timeoutSeconds: 0.6 });
		w1.output = "w1 second";
		w1.settle();
		w1.status = "running";
		w1.output = undefined;
		await c;
		assert.equal(completions(h).length, 0, "held until the last collector returns");
		await d;
		assert.equal(completions(h).length, 1);
		assert.match(completions(h)[0][0].content, /w1 second/);
	} finally { await h.close(); }
});

const TOOL_TURN = [{ type: "toolCall", id: "call", name: "agent_wait", arguments: {} }];
/** One parent turn ending, as pi's turn_end boundary reports it: a tool-call turn, or (no tool call) the one the run would stop after. */
const turnEnd = (h: { event: (name: string, data: any) => unknown }, content: any[] = [{ type: "text", text: "done" }], over: { outcome?: string; pendingMessages?: any[] } = {}) =>
	h.event("turn_end", {
		message: { role: "assistant", content, stopReason: over.outcome === "aborted" ? "aborted" : content.some((c) => c.type === "toolCall") ? "toolUse" : "stop" },
		outcome: over.outcome ?? "completed",
		context: { pendingMessages: over.pendingMessages ?? [] },
	});

test("run hold: settles before agent_wait in the same run that the wait returns are never sent", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
		const [w1, w2] = h.workers;
		w1.output = "answer 1";
		w1.settle();
		w2.output = "answer 2";
		w2.settle();
		assert.equal(completions(h).length, 0, "held while the run is in progress");
		turnEnd(h, TOOL_TURN);
		const text = (await h.call("agent_wait", { ids: [w1.id, w2.id] })).content[0].text;
		assert.match(text, /answer 1[\s\S]*answer 2/);
		turnEnd(h, TOOL_TURN);
		turnEnd(h);
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 0, "the wait result was the parent's only copy");
		assert.equal(h.notices.length, 2, "the toast is unchanged");
	} finally { await h.close(); }
});

test("run hold: an unwaited mid-run settle is sent once, waking, where the run would stop", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { prompt: "a" });
		h.workers[0].output = "answer";
		h.workers[0].settle();
		assert.equal(completions(h).length, 0, "nothing at settle");
		turnEnd(h, TOOL_TURN);
		assert.equal(completions(h).length, 0, "nothing at a tool-call turn end");
		turnEnd(h);
		assert.equal(completions(h).length, 1, "sent at the stopping turn end");
		assert.match(completions(h)[0][0].content, /answer/);
		assert.deepEqual(completions(h)[0][1], { deliverAs: "followUp", triggerTurn: true });
		turnEnd(h);
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 1, "exactly once");
	} finally { await h.close(); }
});

test("run hold: a queued user message defers the release to the next stopping turn end, or to agent_end", async () => {
	const h = harness();
	try {
		const user = [{ role: "user", content: "next", timestamp: 0 }];
		h.event("agent_start", {});
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
		const [w1, w2] = h.workers;
		w1.settle();
		turnEnd(h, undefined, { pendingMessages: user });
		assert.equal(completions(h).length, 0, "the user's message speaks first");
		turnEnd(h);
		assert.equal(completions(h).length, 1, "released at the next stopping turn end");
		h.event("agent_end", { messages: [] });
		h.event("agent_start", {});
		w2.settle();
		turnEnd(h, undefined, { pendingMessages: user });
		assert.equal(completions(h).length, 1);
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 2, "or at agent_end");
		assert.deepEqual(completions(h)[1][1], { deliverAs: "followUp", triggerTurn: true });
	} finally { await h.close(); }
});

test("run hold: an aborted run's held settles go into the transcript without starting a turn", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
		const [w1, w2] = h.workers;
		w1.settle();
		turnEnd(h, undefined, { outcome: "aborted" });
		assert.equal(completions(h).length, 0, "an aborted turn is not a release point");
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 1);
		assert.deepEqual(completions(h)[0][1], { deliverAs: "followUp", triggerTurn: false });
		// A Stop between turns: the run's signal is aborted though the last turn completed.
		h.event("agent_start", {});
		w2.settle();
		turnEnd(h, TOOL_TURN);
		h.ctx.signal = { aborted: true };
		h.event("agent_end", { messages: [] });
		delete h.ctx.signal;
		assert.equal(completions(h).length, 2);
		assert.deepEqual(completions(h)[1][1], { deliverAs: "followUp", triggerTurn: false });
	} finally { await h.close(); }
});

test("run hold: a wake:false settle reaches the context at the next turn end, unless a wait in that turn returned it", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { agents: [{ prompt: "a", wake: false }, { prompt: "b", wake: false }] });
		const [w1, w2] = h.workers;
		w1.output = "quiet 1";
		w1.settle();
		assert.equal(completions(h).length, 0);
		turnEnd(h, TOOL_TURN);
		assert.equal(completions(h).length, 1, "sent at the next turn end, tool call or not");
		assert.deepEqual(completions(h)[0][1], { deliverAs: "followUp", triggerTurn: false });
		w2.output = "quiet 2";
		w2.settle();
		assert.match((await h.call("agent_wait", { ids: [w2.id] })).content[0].text, /quiet 2/);
		turnEnd(h, TOOL_TURN);
		turnEnd(h);
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 1, "the wait returned w2's settle");
	} finally { await h.close(); }
});

test("run hold: a settle a steered re-run moved past is sent at the stop; the one a wait returned is not", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { prompt: "a" });
		const [w1] = h.workers;
		w1.output = "first answer";
		w1.settle();
		await h.call("agent_steer", { id: w1.id, message: "again" });
		turnEnd(h, TOOL_TURN);
		const waiting = h.call("agent_wait", { ids: [w1.id] });
		w1.output = "second answer";
		w1.settle();
		const text = (await waiting).content[0].text;
		assert.match(text, /second answer/);
		assert.doesNotMatch(text, /first answer/);
		turnEnd(h, TOOL_TURN);
		assert.equal(completions(h).length, 0);
		turnEnd(h);
		h.event("agent_end", { messages: [] });
		assert.equal(completions(h).length, 1, "only the unreported settle");
		assert.match(completions(h)[0][0].content, /first answer/);
		assert.equal(completions(h)[0][1].triggerTurn, true);
	} finally { await h.close(); }
});

test("run hold: shutting down mid-run sends the leftovers context-only", async () => {
	const h = harness();
	try {
		h.event("agent_start", {});
		await h.call("agent_spawn", { prompt: "a" });
		h.workers[0].output = "unsent";
		h.workers[0].settle();
		assert.equal(completions(h).length, 0);
	} finally { await h.close(); }
	assert.equal(completions(h).length, 1);
	assert.match(completions(h)[0][0].content, /unsent/);
	assert.deepEqual(completions(h)[0][1], { deliverAs: "followUp", triggerTurn: false });
});

test("run hold: an idle parent is sent a settle at once, and a new session forgets an unfinished run", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b" }] });
		h.workers[0].settle();
		assert.equal(completions(h).length, 1);
		assert.deepEqual(completions(h)[0][1], { deliverAs: "followUp", triggerTurn: true });
		h.event("agent_start", {});
		h.start();
		h.workers[1].settle();
		assert.equal(completions(h).length, 2, "session_start resets the run count");
	} finally { await h.close(); }
});

/** A real AgentSession on a faux model, with the subagents extension and fake workers the test settles.
 *  `order` records the run's boundaries and every custom message as pi emits them. */
async function realSession() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-hold-contract-"));
	const faux = fauxProvider();
	const order: string[] = [];
	const workers: any[] = [];
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				registerSubagents(pi, (options: any, handlers: any) => {
					const worker: any = {
						...options, wake: options.wake ?? true, extensions: [], status: "running", transcript: [],
						usage: { input: 0, output: 0, turns: 0 }, steerCount: 0, output: "",
						isFinished() { return ["killed", "done", "error"].includes(this.status); },
						isSettled() { return this.isFinished() || this.status === "waiting"; },
						finalOutput() { return this.output; },
						async steer() { return { ok: true }; },
						async kill() { this.status = "killed"; },
						async dispose() { this.status = "killed"; },
						settle(output: string) { this.output = output; this.status = "waiting"; handlers.onSettled(this); },
					};
					workers.push(worker);
					return worker;
				}, { policyFile: NO_POLICY_FILE, agentDir: NO_AGENT_DIR });
				pi.on("agent_start", () => { order.push("agent_start"); });
				pi.on("agent_end", () => { order.push("agent_end"); });
				pi.on("agent_settled", () => { order.push("agent_settled"); });
				pi.on("message_start", (event) => {
					if (event.message.role === "custom") order.push(`custom:${event.message.customType}`);
				});
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(dir) });
	await session.bindExtensions({ mode: "rpc" });
	session.modelRuntime.registerNativeProvider(faux.provider);
	await session.setModel(faux.getModel());
	const completed = () => session.sessionManager.getEntries().filter((e: any) => e.type === "custom_message" && e.customType === "subagent-complete");
	// As pi's own runtime quits: session_shutdown first (the extension stops its refresh timer), then dispose.
	const close = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	};
	return { session, faux, order, workers, completed, close };
}

test("contract (real AgentSession): held settles leave pi at the run's own boundaries — once, before agent_end, never duplicated", async () => {
	// 1. Settled before the wait in the same run: the wait returns it, nothing else follows.
	{
		const s = await realSession();
		try {
			s.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("agent_spawn", { prompt: "a" }), { stopReason: "toolUse" }),
				() => {
					s.workers[0].settle("early answer");
					return fauxAssistantMessage(fauxToolCall("agent_wait", { ids: [s.workers[0].id] }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);
			await s.session.prompt("go");
			await s.session.waitForIdle?.();
			assert.equal(s.faux.state.callCount, 3, "no extra wake turn");
			assert.equal(s.completed().length, 0, "the wait result was the only copy");
			assert.deepEqual(s.order, ["agent_start", "agent_end", "agent_settled"]);
		} finally { await s.close(); }
	}
	// 2. Never waited: the followUp sent from the stopping turn's turn_end continues the same run.
	{
		const s = await realSession();
		try {
			s.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("agent_spawn", { prompt: "a" }), { stopReason: "toolUse" }),
				() => {
					s.workers[0].settle("late answer");
					return fauxAssistantMessage("stopping");
				},
				fauxAssistantMessage("ack"),
			]);
			await s.session.prompt("go");
			await s.session.waitForIdle?.();
			assert.equal(s.faux.state.callCount, 3, "one wake turn");
			assert.equal(s.completed().length, 1);
			assert.deepEqual(s.order, ["agent_start", "custom:subagent-complete", "agent_end", "agent_settled"], "delivered before agent_end, no agent_settled in between");
		} finally { await s.close(); }
	}
	// 3. Aborted: triggerTurn:false at agent_end is persisted, and no turn starts.
	{
		const s = await realSession();
		try {
			s.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("agent_spawn", { prompt: "a" }), { stopReason: "toolUse" }),
				() => {
					s.workers[0].settle("stopped answer");
					void s.session.abort();
					return fauxAssistantMessage("cut", { stopReason: "aborted" });
				},
				fauxAssistantMessage("must not run"),
			]);
			await s.session.prompt("go");
			await s.session.waitForIdle?.();
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(s.faux.state.callCount, 2, "the Stop never wakes the parent");
			assert.equal(s.completed().length, 1, "the held settle is in the transcript");
			assert.equal(s.session.agent.hasQueuedMessages(), false, "nothing stranded in pi's queue");
			assert.deepEqual(s.order.filter((e) => e === "agent_start"), ["agent_start"]);
		} finally { await s.close(); }
	}
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
			await assert.rejects(h.call("agent_spawn", { prompt: "bad", backend: "native-cli" }), /factory failed/);
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
		await h.call("agent_spawn", { agents: [{ prompt: "pi" }, { prompt: "claude", backend: "native-cli" }] });
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
			{ prompt: "x", count: 0 },
			{ prompt: " " },
			{ agents: [{ prompt: "x", agentType: "../outside" }] },
			{ agents: [{ prompt: "x", agentType: "definitely-does-not-exist-734892" }] },
			{ agents: [{ prompt: "x", model: "other/model" }], model: "test/model" },
			{ agents: [{ prompt: "x" }], name: "shared" },
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
		await h.call("agent_spawn", { prompt: "x", count: 16 });
		await h.call("agent_spawn", { prompt: "x", count: 8 });
		h.workers.forEach((w) => w.settle());
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /A chat runs at most 24 workers at once/);
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

test("child extensions: uninstalled remote sources and missing paths fail, this extension is refused", async () => {
	const h = harness();
	try {
		for (const source of ["npm:definitely-not-installed-xyz", "git:github.com/x/definitely-not-installed"]) {
			await assert.rejects(
				h.call("agent_spawn", { prompt: "task", extensions: [source] }),
				(err: Error) => err.message.includes(`${source} isn't installed: install it first (\`pi install ${source}\`)`),
			);
		}
		assert.equal(h.workers.length, 0);
		await h.call("agent_spawn", { prompt: "task" });
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

test("installed npm and git sources map to Pi's user-scope directories; others refuse the spawn", () => {
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
		// At spawn validation: an installed exact pin and a checkout resolve to their directories;
		// an uninstalled package, a range pin and a git ref pin refuse the spawn.
		fs.writeFileSync(path.join(dir, "npm", "node_modules", "plain", "package.json"), JSON.stringify({ name: "plain", version: "1.2.3" }));
		assert.equal(resolveExtensionSource("npm:plain@1.2.3", dir, dir), path.join(dir, "npm", "node_modules", "plain"));
		assert.equal(resolveExtensionSource("git:github.com/owner/repo", dir, dir), path.join(dir, "git", "github.com", "owner", "repo"));
		for (const source of ["npm:missing", "npm:plain@^1", "git:github.com/owner/repo@v1"]) {
			assert.throws(() => resolveExtensionSource(source, dir, dir), { message: `${source} isn't installed: install it first (\`pi install ${source}\`)` }, source);
		}
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
		await h.call("agent_spawn", { prompt: "fill", count: 20 });
		await assert.rejects(h.call("agent_spawn", { prompt: "over", count: 3 }), /This request starts 3 workers\. A chat runs at most 24 workers at once .*; 22 are live now, so 2 more fit\. Stop 1 with agent_kill first/);
		const killed = await h.call("agent_kill", { all: true });
		assert.equal(killed.details.killed.length, 20, "unpublished IDs are not public targets");
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
			defaults: { backend: "native-cli", model: "claude-opus-5-5", effort: "high" },
			members: [
				{ role: "builder", prompt: "Implement it.", ownedPaths: ["src/api"] },
				{ role: "reviewer", prompt: "Review it.", backend: "pi", wake: false },
			],
		});
		assert.equal(r.details.teamId, "team_01");
		assert.equal(r.details.groupId, "run_01");
		assert.deepEqual(r.details.members, [
			{ workerId: "ag_01", role: "builder", backend: "native-cli", model: "claude-opus-5-5" },
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
		assert.equal(created[0].model, "claude-opus-5-5");
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
			[["ag_01", "builder", "native-cli", "claude-opus-5-5", "run_01", ["src/api"]], ["ag_02", "reviewer", "pi", "test/model", "run_01", []]],
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
		await assert.rejects(h.call("team_create", { name: "Count", objective: "o", members: [{ role: "a", prompt: "x", count: 2 }] }), /^Error: members\[0\] \(a\): count is not a member setting; a member is one role/);
		await assert.rejects(h.call("team_create", { name: "Keys", objective: "o", members: [{ role: "a", prompt: "x" }], defaults: { count: 2 } }), /Unsupported team default count/);
		assert.equal(h.workers.length, 0);
		assert.equal(created.length, 0);
		// Backend validation rejects before any factory runs (pi and claude mixed).
		await assert.rejects(h.call("team_create", {
			name: "Mixed", objective: "o",
			members: [{ role: "one", prompt: "a", backend: "native-cli" }, { role: "two", prompt: "b", model: "missing/model" }],
		}), /Unknown model/);
		assert.equal(h.workers.length, 0);
		assert.equal(created.length, 0);
		// A factory failure after the first member rolls back the whole batch:
		// no team, no entry, no group; the created worker is confirmed terminated.
		await assert.rejects(h.call("team_create", {
			name: "Doomed", objective: "o",
			defaults: { backend: "native-cli" },
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
		await h.call("agent_spawn", { prompt: "slot", count: 20 });
		assert.equal(h.workers.length, 21);
		await assert.rejects(h.call("team_create", {
			name: "Over", objective: "o",
			members: Array.from({ length: 4 }, (_, i) => ({ role: `m${i}`, prompt: "p" })),
		}), /^Error: This team needs 4 workers running: the 4 members you named\. A chat runs at most 24 workers at once .*; 21 are live now, so 3 more fit\. Stop 1 with agent_kill first/);
		assert.equal(h.workers.length, 21);
	} finally { await h.close(); }
});

test("team_add extends a session team in another run, reuses defaults and persists the addition", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		await h.call("team_create", {
			name: "Core", objective: "obj",
			defaults: { backend: "native-cli", model: "claude-opus-5-5" },
			members: [{ role: "lead", prompt: "start" }],
		});
		const add = await h.call("team_add", { team: "core", members: [{ role: "docs", prompt: "write docs", ownedPaths: ["docs/"] }] });
		assert.equal(add.details.teamId, "team_01");
		assert.equal(add.details.groupId, "run_02", "teams span independent run groups");
		assert.match(add.content[0].text, /Added 1 member\(s\) to team_01 \(Core\) in run_02/);
		assert.deepEqual(add.details.members, [{ workerId: "ag_02", role: "docs", backend: "native-cli", model: "claude-opus-5-5" }]);
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
		assert.match(list.content[0].text, /ag_01 lead \[native-cli\] working \(running\) · context — · owns: none declared/);
		assert.match(list.content[0].text, /ag_02 docs \[native-cli\] working \(running\) · context — · owns: docs\//);
		assert.deepEqual(list.details.teams.map((t: any) => t.id), ["team_01"]);
	} finally { await h.close(); }
});

test("team history restores read-only from the active branch; counters reserve across every entry", async () => {
	const h = harness();
	const teamEntry = (data: unknown) => ({ type: "custom", customType: "subagents-team-v1", data });
	const old = teamEntry({
		version: 1, op: "create",
		team: { id: "team_04", name: "Old", objective: "past", createdAt: 1 },
		members: [{ workerId: "ag_03", role: "lead", ownedPaths: ["src"], backend: "claude-code", model: "claude-opus-5-5", groupId: "run_02", addedAt: 1 }],
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
		assert.match(list.content[0].text, /team_04 — Old \[history, read-only but team_eject\] · 1 unavailable/);
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
		assert.match(list.content[0].text, /team_04 — Old \[history, read-only but team_eject\]/);
		assert.match(list.content[0].text, /team_07 — Fresh \[this session\]/);
		// After a reload the team is history, yet its unavailable member's seat can be released: the
		// entry goes on this branch, so it folds back with the team.
		const ejected = await h.call("team_eject", { team: "old", member: "lead" });
		assert.match(ejected.content[0].text, /^Ejected ag_03 \(lead\) from team_04 at /);
		assert.deepEqual(h.appended.filter((e) => e.customType === "subagents-team-v1" && e.data.op === "eject").map((e) => [e.data.teamId, e.data.workerId]), [["team_04", "ag_03"]]);
		assert.match((await h.call("team_list", { team: "team_04" })).content[0].text, /team_04 — Old \[history, read-only but team_eject\] · 1 ejected/);
		await assert.rejects(h.call("team_add", { team: "team_04", members: [{ role: "x", prompt: "p" }] }), /history from an earlier session/, "team_add still refuses it");
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
		const objectiveLine = longContent.split("\n").find((line: string) => line.startsWith("Objective: "));
		assert.ok(objectiveLine && objectiveLine.length < longObjective.length, "objective is truncated");
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
/** Poll until `pred` holds (inbox wakes are asynchronous: stored first, listed by the scheduler). */
async function waitFor(pred: () => unknown, what: string, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One member's inbox as [id, kind, from role, status] rows. */
const itemRows = (dir: string) => readMemberItems(dir).map((i) => [i.id, i.kind, i.from.role, i.status]);
const INBOX_FOOT = "(Items shown in full above count as read. Answer an item with team_msg and replyTo set to its id.)";

function teamHarness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-index-mailbox-"));
	const h = harness(eventBus(), { mailboxRoot: root, mailboxPollMs: 10, inboxDebounceMs: 30, inboxRetryMs: [30, 60] });
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

test("team members get a parent-issued identity, private mailbox and only the member extension; Claude members are pi workers with the same tools", async () => {
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
		assert.deepEqual(lead.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, MEMBER_EXTENSION], "the marker, then member.ts, never the manager");
		assert.deepEqual(lead.tools, ["read"], "the built-in allowlist is unchanged; the runner restricts by exclusion when extensions are present");
		const me = h.memberOf("ag_01")!;
		assert.deepEqual({ ...me, dir: undefined }, { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_01", role: "lead", orchestrator: true, dir: undefined });
		assert.equal(me.dir, path.join(h.root, "team_01", "ag_01"));
		assert.ok(fs.statSync(memberPaths(me.dir).requests).isDirectory() && fs.statSync(memberPaths(me.dir).responses).isDirectory());
		assert.equal(h.memberOf("ag_02")!.orchestrator, false);
		// A Claude member is a pi worker on the Claude Code provider: the member extension, the identity in its env.
		assert.equal(created.length, 0, "no native Claude process");
		const claude = h.workers.find((w: any) => w.id === "ag_03");
		assert.equal(claude.model, "claude-code-cli/claude-sonnet-5-5");
		assert.deepEqual(claude.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, MEMBER_EXTENSION, CLAUDE_CODE_EXTENSION]);
		assert.equal(claude.mcpServers, undefined);
		const writer = h.memberOf("ag_03")!;
		assert.deepEqual({ ...writer, dir: undefined }, { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_03", role: "writer", orchestrator: false, dir: undefined });
		assert.equal(writer.dir, path.join(h.root, "team_01", "ag_03"));
		assert.ok(fs.statSync(memberPaths(writer.dir).requests).isDirectory(), "a Claude member has a mailbox too");
		assert.match(claude.task, /Team tools: team_msg/);
		assert.doesNotMatch(claude.task, /mcp__team__|no tool to reply/);
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
		assert.deepEqual(h.workers.at(-1).extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION]);
		await assert.rejects(
			h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true, backend: "other" }] }),
			/must use the pi or claude-code backend/,
		);
		await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "test" }] });
		assert.equal(h.memberOf("ag_05")!.role, "qa");
		assert.match(h.workers.find((w: any) => w.id === "ag_05").task, /- lead \(orchestrator\): none declared/);
		// A Claude orchestrator is accepted; its identity carries the flag and its header names the sibling powers.
		await h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true, backend: "claude-code" }] });
		const boss = h.memberOf("ag_06")!;
		assert.deepEqual([boss.workerId, boss.role, boss.orchestrator], ["ag_06", "boss", true]);
		assert.match(h.workers.at(-1).task, /You are this team's orchestrator/);
		assert.match((await h.call("team_list")).content[0].text, /ag_06 boss \(orchestrator\) \[pi\]/, "recorded as the pi worker it is");
	} finally { await h.cleanup(); }
});

test("member messages are queued as inbox items: answered at once, listed when a turn ends, with provenance and action records", async () => {
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
		const writerWorker = h.workers.find((w: any) => w.id === "ag_03");
		const leadDir = h.memberOf("ag_01")!.dir;
		// dev → lead by role (normalized): stored and answered at once; lead is busy, so nothing interrupts it.
		const one = await h.ask("ag_02", { type: "message", to: " LEAD ", message: "API is ready" });
		assert.equal(one.ok, true);
		assert.equal(one.text, "Queued for lead (ag_01): item i_1");
		assert.deepEqual(itemRows(leadDir), [["i_1", "message", "dev", "new"]]);
		await pause(60);
		assert.equal(lead.steerCount, 0, "a busy member is never interrupted for a normal item");
		// Its turn ends: one list, sent as a plain steer (a prompt to the now idle member).
		lead.settle();
		await waitFor(() => lead.steerCount === 1 && readMemberItems(leadDir)[0].listedAt, "the list at the end of lead's turn");
		assert.equal(lead.lastSteer.mode, undefined);
		assert.equal(lead.lastSteer.message, ["[Team inbox: 1 new — team_inbox open <ids> to read, done <ids> to mark addressed]", "- i_1 message from dev — API is ready", INBOX_FOOT].join("\n"));
		assert.deepEqual(itemRows(leadDir), [["i_1", "message", "dev", "read"]], "shown in full counts as read");
		assert.ok(readMemberItems(leadDir)[0].listedAt, "listed");
		assert.deepEqual(readInbox(leadDir), [], "no legacy copy for a member on inbox-aware code");
		// lead → the Claude member (a pi worker) by ID while it is idle: items gathered for the debounce, then one list.
		writerWorker.settle();
		const writerDir = h.memberOf("ag_03")!.dir;
		assert.equal((await h.ask("ag_01", { type: "message", to: "ag_03", message: "Document the API" })).text, "Queued for writer (ag_03): item i_2");
		assert.equal((await h.ask("ag_01", { type: "message", to: "writer", subject: "Docs", message: "Second\nline" })).text, "Queued for writer (ag_03): item i_3");
		await waitFor(() => writerWorker.steerCount === 1, "one list for both items");
		assert.equal(writerWorker.lastSteer.message, [
			"[Team inbox: 2 new — team_inbox open <ids> to read, done <ids> to mark addressed]",
			"- i_2 message from lead — Document the API",
			"- i_3 message from lead — Docs",
			"    Second",
			"    line",
			INBOX_FOOT,
		].join("\n"));
		await pause(60);
		assert.equal(writerWorker.steerCount, 1, "one wake for the gathered items");
		// The Claude member answers through the same mailbox: sender identity comes from its directory.
		const back = await h.ask("ag_03", { type: "message", to: "lead", message: "Done", urgent: true });
		assert.equal(back.text, "Queued for lead (ag_01): item i_4");
		// lead is busy (the first list started a turn): an urgent item reaches it at its next step.
		await waitFor(() => lead.steerCount === 2, "the urgent item at lead's next step");
		assert.equal(lead.lastSteer.mode, undefined, "a mid-turn steer");
		assert.match(lead.lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) — .*\]\n! i_4 message from writer — Done\n/);
		// Broadcast: one copy per live member, never the sender; a stopped member is named, not a failure.
		writerWorker.status = "killed";
		const all = await h.ask("ag_02", { type: "message", to: "all", message: "sync" });
		assert.equal(all.ok, true);
		assert.equal(all.text, "Queued for lead (ag_01): item i_5\nskipped (stopped): writer (ag_03)");
		assert.deepEqual((all.details as any).skipped, ["ag_03"]);
		assert.equal(dev.steerCount, 0, "a broadcast never loops back to the sender");
		// A direct message to a stopped member with no successor is refused, naming how it comes back.
		const stopped = await h.ask("ag_02", { type: "message", to: "writer", message: "hello?" });
		assert.equal(stopped.ok, false);
		assert.match(stopped.text, /writer \(ag_03\) has stopped \(killed\) and has no live successor\. agent_resume \{ id: "ag_03" \} in the main chat brings it back/);
		// Scope errors are answered, never stored.
		for (const [to, pattern] of [["dev", /cannot address yourself/], ["ag_02", /cannot address yourself/], ["ghost", /No member with role ghost in team_01\. Known roles: lead, writer\./], ["ag_42", /not a member of team_01/]] as const) {
			const bad = await h.ask("ag_02", { type: "message", to, message: "x" });
			assert.equal(bad.ok, false);
			assert.match(bad.text, pattern);
		}
		assert.equal((await h.ask("ag_02", { type: "message", to: "lead", message: "  " })).ok, false);
		assert.equal((await h.ask("ag_02", { type: "message", to: "lead", message: "x", replyTo: "i_99" })).ok, false, "replyTo must name an existing item");
		assert.equal(readMemberItems(leadDir).length, 3, "nothing refused was stored");
		// Records: recipient-keyed actions with source member and kind message, queued with their item.
		const listed = await h.call("team_list");
		const actions = listed.details.teams[0].actions;
		assert.deepEqual(actions.map((a: any) => [a.source, a.kind, a.workerId, a.state]), [
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_03", "accepted-or-queued"],
			["member", "message", "ag_03", "accepted-or-queued"],
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_01", "accepted-or-queued"],
			["member", "message", "ag_03", "failed"],
		]);
		assert.match(listed.content[0].text, /#1 member message → ag_01 \(lead\): accepted-or-queued — queued as i_1/);
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
		fs.writeFileSync(path.join(memberPaths(leadDir).requests, "zz.json"), "{broken");
		await pause(60);
		assert.deepEqual(fs.readdirSync(memberPaths(leadDir).requests), []);
		assert.equal(readMemberItems(leadDir).length, 3, "nothing forged or malformed was stored");
	} finally { await h.cleanup(); }
});

test("a member whose turn ends with items waiting: its completion reports that turn's answer, then the list wakes it (never a 'still working' copy)", async () => {
	const h = teamHarness();
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "alpha", prompt: "ask" }, { role: "beta", prompt: "talk" }] });
		const alpha = h.workers.find((w: any) => w.id === "ag_01");
		// beta writes to the busy alpha: the item waits for alpha's turn end.
		assert.equal((await h.ask("ag_02", { type: "message", to: "alpha", message: "HELLO from beta" })).ok, true);
		alpha.transcript.push({ kind: "tool", toolName: "team_ask", text: '{"question":"ASK-MARK"}' });
		h.messages.length = 0;
		alpha.output = "ALPHA-FINAL";
		alpha.settle();
		await waitFor(() => alpha.steerCount === 1, "the list at the end of alpha's turn");
		const done = h.messages.filter(([m]: any[]) => m.customType === "subagent-complete").map(([m]: any[]) => m.content as string);
		assert.equal(done.length, 1, "one completion for the turn that ended");
		assert.match(done[0], /^### ag_01 \(alpha\) — waiting\n[\s\S]*ALPHA-FINAL/, "the settle as it was: waiting, with its final answer");
		assert.doesNotMatch(done[0], /Still working|ASK-MARK/, "never the next run's activity");
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
		await waitFor(() => readMemberItems(h.memberOf("ag_02")!.dir).length === 1, "the instruction's history copy");
		assert.deepEqual(readMemberItems(h.memberOf("ag_02")!.dir).map((i) => [i.kind, i.from.role, i.status, i.body]), [["instruction", "lead", "read", "Run the tests first."]], "an instruction copy: history, never open");
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
		assert.match(gone.text, /^Cannot steer: dev \(ag_02\) has stopped \(killed\) and has no live successor\. agent_resume/);
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

test("the mailbox root is created only for teams, beside the session's handover notes, and kept at shutdown", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-"));
	let root: string | undefined;
	try {
		const h = harness(eventBus(), { mailboxPollMs: 10, agentDir });
		try {
			await h.call("agent_spawn", { prompt: "plain", wake: false });
			assert.ok(!fs.existsSync(path.join(agentDir, "sova", "teams")), "no team, no mailbox");
			await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
			const me = decodeMemberContext(h.workers[1].env[MEMBER_ENV])!;
			root = path.dirname(path.dirname(me.dir));
			assert.equal(path.basename(root), "mailbox");
			assert.equal(path.dirname(path.dirname(root)), path.join(agentDir, "sova", "teams"));
			assert.ok(fs.existsSync(me.dir));
		} finally { await h.close(); }
		assert.ok(root && fs.existsSync(root), "kept for the next manager");
	} finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
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

test("a remote session's workers run on the target: pi and claude-code workers load the remote extension with --target", async () => {
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
		assert.deepEqual(piWorker.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION], "the marker and the remote extension, nothing else");
		assert.deepEqual(piWorker.flags, { target: "box" });
		assert.equal(piWorker.cwd, h.ctx.cwd, "the session's placeholder is the local cwd");
		assert.deepEqual(piWorker.tools, ["read", "bash"], "the allowlist is unchanged; the runner restricts by exclusion when extensions are present");
		assert.equal(piWorker.mcpServers, undefined);

		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", tools: ["Read"], systemPrompt: "be terse", cwd: "sub/dir" });
		const claude = h.workers[1];
		assert.equal(created.length, 0, "no native Claude process");
		assert.equal(claude.model, "claude-code-cli/claude-sonnet-5-5");
		assert.deepEqual(claude.tools, ["read"], "Claude's names map to Sova's, which run on the target");
		assert.deepEqual(claude.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION, CLAUDE_CODE_EXTENSION]);
		assert.deepEqual(claude.flags, { target: "box", [CLAUDE_CODE_PROVIDER_FLAG]: true });
		assert.equal(claude.cwd, placeholderDir(agentDir, "box", "/srv/app/sub/dir"), "its local cwd is the placeholder of that far directory");
		assert.equal(claude.systemPrompt, "be terse");
		assert.equal(claude.mcpServers, undefined);

		// A team member of a remote session gets both extensions, on either backend.
		await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "lead", prompt: "t", orchestrator: true }, { role: "writer", prompt: "w", backend: "claude-code" }] });
		const lead = h.workers.find((w: any) => w.id === "ag_03");
		assert.deepEqual(lead.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION, MEMBER_EXTENSION]);
		assert.deepEqual(lead.flags, { target: "box" });
		const writer = h.workers.find((w: any) => w.id === "ag_04");
		assert.deepEqual(writer.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION, MEMBER_EXTENSION, CLAUDE_CODE_EXTENSION]);
		assert.ok(decodeMemberContext(writer.env[MEMBER_ENV]));

		// A cwd the parent cannot resolve, and a backend without remote tooling, are refused before any worker starts.
		await assert.rejects(h.call("agent_spawn", { prompt: "t", cwd: "~/x" }), /absolute path on the target/);
		await assert.rejects(h.call("agent_spawn", { prompt: "t", backend: "other" }), /cannot run workers of a remote session/);
		assert.equal(h.workers.length + created.length, 4);
		assert.equal(created.length, 0);
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
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION]);
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
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION]);
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli" });
		assert.equal(created[0].mcpServers, undefined);
		assert.equal(created[0].env, undefined);
		assert.equal(created[0].tools, undefined, "the backend's default tool list applies");
	} finally { await h.close(); }
});

test("worker session marker: every pi worker loads worker-mark.ts first; another backend's workers never do", async () => {
	assert.equal(path.basename(MARKER_EXTENSION), "worker-mark.ts");
	assert.ok(fs.existsSync(MARKER_EXTENSION));
	assert.equal(path.dirname(MARKER_EXTENSION), path.dirname(MEMBER_EXTENSION), "a sibling of member.ts, under this extension's own directory");
	assert.ok(fs.existsSync(PROVIDER_LIMITS_EXTENSION), "the request limits load right after the marker");
	assert.equal(path.basename(path.dirname(PROVIDER_LIMITS_EXTENSION)), "provider-limits");
	assert.ok(fs.existsSync(MODEL_LEVELS_EXTENSION), "the model levels load right after the limits (a worker chat counts its own model calls)");
	assert.equal(path.basename(path.dirname(MODEL_LEVELS_EXTENSION)), "model-levels");
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		const plain = await h.call("agent_spawn", { prompt: "plain", tools: ["read"] });
		assert.equal(h.workers[0].extensions[0], MARKER_EXTENSION, "a plain worker");
		assert.doesNotMatch(plain.content[0].text, /extensions=/, "the spawn summary does not list the marker");
		const btw = path.resolve(fileURLToPath(new URL("../btw", import.meta.url)));
		const given = await h.call("agent_spawn", { prompt: "given", extensions: ["extensions/btw"] });
		assert.deepEqual(h.workers[1].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, btw], "a worker with its own extensions");
		assert.ok(given.content[0].text.split("\n").some((line: string) => line.includes(`  extensions=${btw}`) && !line.includes("worker-mark")), "only the user's extensions are listed");
		await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "lead", prompt: "t", orchestrator: true }, { role: "writer", prompt: "w", backend: "native-cli" }] });
		const member = h.workers.at(-1);
		assert.deepEqual(member.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, MEMBER_EXTENSION], "a team member");
		await h.call("agent_spawn", { prompt: "claude", backend: "native-cli" });
		assert.equal(created.length, 2);
		for (const other of created) assert.equal(other.extensions.length, 0, "another backend's workers are untouched");
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
	h.ctx.modelRegistry.find = (p: string, m: string) => (p === "claude-code-cli" && m === "claude-opus-5-5") || (p === "ollama-cloud" && m === "kimi-k3") ? { provider: p, id: m } : undefined;
	try {
		await h.call("agent_spawn", { prompt: "1M task", model: "claude-code-cli/claude-opus-5-5", effort: "low" });
		const scoped = h.workers[0];
		assert.equal(scoped.model, "claude-code-cli/claude-opus-5-5", "the ref reaches the runner unchanged; the runner sets it over RPC");
		assert.deepEqual(scoped.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, CLAUDE_CODE_EXTENSION], "the marker, then the claude-code extension");
		assert.deepEqual(scoped.flags, { "claude-code-provider": true });
		assert.equal(CLAUDE_CODE_EXTENSION, path.join(fs.realpathSync(path.resolve(fileURLToPath(new URL("../claude-code", import.meta.url)))), "index.ts"), "the sibling directory, by real path");
		assert.equal(CLAUDE_CODE_PROVIDER_FLAG, CLAUDE_PROVIDER_FLAG, "the switch the provider extension registers");
		await h.call("agent_spawn", { prompt: "plain task", model: "ollama-cloud/kimi-k3" });
		const plain = h.workers[1];
		assert.equal(plain.model, "ollama-cloud/kimi-k3");
		assert.deepEqual(plain.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION]);
		assert.equal(plain.flags, undefined);
	} finally { await h.close(); }
});

// The sandbox extension's directory, as its state event names it (a real path).
const SANDBOX_DIR = fs.realpathSync(path.resolve(fileURLToPath(new URL("../sandbox", import.meta.url))));
const SANDBOX_OFF: SandboxStateEvent = { version: 1, on: false, extensionPath: SANDBOX_DIR, enforcement: "none" };
const WORKER_FLAGS = { sandbox: "on", "sandbox-parent": '{"version":1}' };
/** The one call, faked: pi gets flags (narrowed ones for a root), any other backend a confinement named by its owner and root. */
const workerLaunchOf = (flagsIn: (root: string) => Record<string, string> = (root) => ({ sandbox: "on", "sandbox-parent": root }), top = WORKER_FLAGS) =>
	(req: { cwd: string; root?: string; backend: string; owner: string }): WorkerLaunch => req.backend === "pi"
		? { kind: "pi", extensionPath: SANDBOX_DIR, flags: req.root ? flagsIn(req.root) : top }
		: { kind: "confine", scope: JSON.stringify({ owner: req.owner, root: req.root ?? null }) };
const SANDBOX_ON: SandboxStateEvent = { version: 1, on: true, extensionPath: SANDBOX_DIR, enforcement: "full", workerLaunch: workerLaunchOf() };
/** A worker's launch options without the per-worker identity or the fake worker's own closures. */
const launchShape = ({ id, groupId, name, ...rest }: any) => Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== "function"));

test("pin: with the sandbox off and no worktree, a claude-code worker's launch options are exactly these", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", systemPrompt: "be terse", wake: false });
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", systemPrompt: "be terse", wake: false });
		const want = {
			model: "claude-code-cli/claude-sonnet-5-5", effort: "medium", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], systemPrompt: "be terse",
			extensions: [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, CLAUDE_CODE_EXTENSION], forkSession: undefined,
			backendOptions: undefined, flags: { [CLAUDE_CODE_PROVIDER_FLAG]: true }, backend: "pi", groupId: "run_01", name: "agent", task: "claude task", cwd: h.ctx.cwd, wake: false,
		};
		const shape = (w: any) => ({ ...launchShape(w), id: undefined });
		for (const w of h.workers) for (const key of Object.keys(want)) if (key !== "groupId") assert.deepEqual(w[key], (want as any)[key], key);
		assert.equal(h.workers[0].env, undefined, "no env, settings, confinement or mcp key");
		assert.equal(h.workers[0].mcpServers, undefined);
		assert.equal(h.workers[0].confine, undefined);
		assert.deepEqual({ ...shape(h.workers[1]), groupId: undefined }, { ...shape(h.workers[0]), groupId: undefined }, "an off sandbox changes nothing");
	} finally { await h.close(); }
});

test("sandbox off: workers launch exactly as without the sandbox extension; on: pi workers load it with --sandbox on", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	try {
		await h.call("agent_spawn", { prompt: "pi task" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli", backendOptions: { permissionMode: "bypassPermissions" } });
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		await h.call("agent_spawn", { prompt: "pi task" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli", backendOptions: { permissionMode: "bypassPermissions" } });
		assert.deepEqual(launchShape(h.workers[1]), launchShape(h.workers[0]), "an off parent's pi worker is today's");
		assert.deepEqual(h.workers[1].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION]);
		assert.equal(h.workers[1].flags, undefined);
		assert.deepEqual(launchShape(created[1]), launchShape(created[0]), "an off parent's claude worker is today's");
		assert.ok(!("settingsJson" in created[1]) && !("permissionMode" in created[1]));

		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(h.workers[2].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SANDBOX_DIR]);
		assert.deepEqual(h.workers[2].flags, WORKER_FLAGS, "the extension's flags, as is");
		// Naming the extension itself neither loads it twice nor drops the flag.
		await h.call("agent_spawn", { prompt: "pi task", extensions: [path.join(SANDBOX_DIR, "index.ts")] });
		assert.deepEqual(h.workers[3].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SANDBOX_DIR]);
		assert.deepEqual(h.workers[3].flags, WORKER_FLAGS);
		await h.call("agent_spawn", { prompt: "pi task", model: "test/model" });
		assert.deepEqual(h.workers[4].flags, WORKER_FLAGS);

		// Back off: today's launch again.
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.deepEqual(launchShape(h.workers[5]), launchShape(h.workers[0]));
	} finally { await h.close(); }
});

test("sandbox on: a claude-code worker is sandboxed as a pi worker (the extension and its flags); a refusal or another backend fails the spawn", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, { ...fakeBackend(created), id: "other" });
	const asked: any[] = [];
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: (req: any) => (asked.push(req), workerLaunchOf()(req)) });
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", backendOptions: { permissionMode: "bypassPermissions" } });
		const claude = h.workers[0];
		assert.equal(asked.length, 1, "asked once, as for any pi worker");
		assert.equal(asked[0].backend, "pi");
		assert.deepEqual(claude.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SANDBOX_DIR, CLAUDE_CODE_EXTENSION]);
		assert.deepEqual(claude.flags, { ...WORKER_FLAGS, [CLAUDE_CODE_PROVIDER_FLAG]: true });
		assert.equal(claude.confine, undefined);
		assert.equal(claude.backendOptions, undefined);

		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, enforcement: "partial", workerLaunch: () => ({ kind: "refused", reason: "Sandbox enforcement is partial (x); set acceptPartial." }) });
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), { message: "Sandbox enforcement is partial (x); set acceptPartial." });
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: undefined });
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), /gave no worker launch/);
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_ON);
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "other" }), /cannot run workers while this session's sandbox is on/);
		// A mixed batch fails as a whole: the pi worker never starts either.
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "p" }, { prompt: "c", backend: "other" }] }), /sandbox is on/);
		assert.equal(created.length, 0);
		assert.equal(h.workers.length, 1);
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
		bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: "not a function" });
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
		assert.deepEqual(r.workers[0].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, REMOTE_EXTENSION]);
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
	const workerLaunch = (req: { cwd: string; root?: string; backend: string; owner: string }): WorkerLaunch => {
		asked.push({ cwd: req.cwd, backend: req.backend });
		return req.cwd === outside ? { kind: "refused", reason: `Sandbox: worker cwd ${outside} is outside the parent's sandbox` } : workerLaunchOf()(req);
	};
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch });
		await h.call("agent_spawn", { prompt: "p", cwd: "extensions" });
		await h.call("agent_spawn", { prompt: "c", backend: "claude-code" });
		assert.deepEqual(asked, [{ cwd: path.join(h.ctx.cwd, "extensions"), backend: "pi" }, { cwd: h.ctx.cwd, backend: "pi" }], "the resolved cwd and the backend (a claude-code worker is a pi worker)");
		for (const backend of [undefined, "claude-code"]) {
			await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "fine" }, { prompt: "p", cwd: outside, backend }] }), { message: `Sandbox: worker cwd ${outside} is outside the parent's sandbox` });
		}
		assert.equal(h.workers.length + created.length, 2, "nothing of a refused batch started");

		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: undefined });
		await assert.rejects(h.call("agent_spawn", { prompt: "p" }), /gave no worker launch/);
		await assert.rejects(h.call("agent_spawn", { prompt: "c", backend: "claude-code" }), /gave no worker launch/);
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: () => ({ kind: "none" }) });
		await assert.rejects(h.call("agent_spawn", { prompt: "p" }), /gave no worker launch/);
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: () => ({ kind: "confine", scope: "s" }) });
		await assert.rejects(h.call("agent_spawn", { prompt: "p" }), /gave a pi worker no extension flags/);
		assert.equal(h.workers.length + created.length, 2);

		// Off: the sandbox checks nothing (the worktrees gate still refuses a cwd outside the session's).
		asked.length = 0;
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch });
		await h.call("agent_spawn", { prompt: "p", cwd: "extensions" });
		await assert.rejects(h.call("agent_spawn", { prompt: "p", cwd: outside }), /outside this session's cwd and its worktrees/);
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
		for (const list of [MEMBER_TOOLS, ORCHESTRATOR_TOOLS]) assert.ok(!(list as readonly string[]).includes("team_eject"));
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
		assert.equal(all.text, "Queued for writer (ag_03): item i_1\nskipped (stopped): dev (ag_02, ejected)", "an ejected member is skipped, never a failure");
		for (const request of [{ type: "message", to: "dev", message: "x" }, { type: "steer", to: "ag_02", message: "x" }] as const) {
			const direct = await h.ask("ag_01", request);
			assert.equal(direct.ok, false);
			assert.match(direct.text, /dev \(ag_02\) was ejected from team_01 at .*; it no longer receives team messages/);
		}
		assert.deepEqual(itemRows(h.memberOf("ag_03")!.dir), [["i_1", "message", "lead", "new"]], "queued for the busy writer; nothing for dev");
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
	coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null, instructions: "" },
	monitor: { enabled: true, role: "monitor", primary: { backend: "claude-code", model: "claude-haiku-4-5", effort: "medium" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
	handover: { retireTimeoutMinutes: 10 },
};
/** The parent session id coordinatedHarness reports; handover notes live under it (N1). */
const SESSION_ID = "0199aaaa-0000-7000-8000-00000000c0de";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A team harness whose agent dir holds `file` as team-defaults.json (omit it: no file), with timers fired by hand. */
/** A member's inbox has an item of `kind` whose body matches (waits for it to be stored). */
async function assertItem(h: { memberOf(id: string): { dir: string } | undefined }, workerId: string, kind: string, re: RegExp): Promise<InboxItem> {
	let found: InboxItem | undefined;
	const bodies = () => readMemberItems(h.memberOf(workerId)!.dir).filter((i) => i.kind === kind);
	try {
		await waitFor(() => (found = bodies().find((i) => re.test(i.body))), `a ${kind} item for ${workerId} matching ${re}`);
	} catch {
		assert.fail(`no ${kind} item for ${workerId} matches ${re}; have:\n${bodies().map((i) => i.body).join("\n---\n")}`);
	}
	return found!;
}
function coordinatedHarness(file?: unknown, opts: { claude?: boolean; sessionId?: string } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-team-defaults-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	if (file !== undefined) fs.writeFileSync(path.join(agentDir, "team-defaults.json"), typeof file === "string" ? file : JSON.stringify(file));
	const timers: { fn: () => void; ms: number }[] = [];
	const h = harness(eventBus(), {
		mailboxRoot: path.join(root, "mail"), mailboxPollMs: 10, agentDir, inboxDebounceMs: 30, inboxRetryMs: [30, 60],
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
		assert.doesNotMatch(r.content[0].text, /Team defaults/);
		assert.match(r.content[0].text, /Standing roles: none; this chat's subagent settings give teams no coordinator or monitor\./);
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
		const r = await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build", ownedPaths: ["src"] }, { role: "writer", prompt: "docs", backend: "claude-code", model: "claude-sonnet-5-5" }] });
		const text = r.content[0].text;
		assert.match(text, /Team defaults: coordinator coordinator added on claude-code\/claude-opus-5-5\/medium \(primary\)\./);
		assert.match(text, /Team defaults: monitor monitor added on claude-code\/claude-haiku-4-5\/medium \(primary\)\./);
		const handoffs = path.join(h.agentDir, "sova", "teams", SESSION_ID, "team_01", "handoffs");
		assert.match(text, new RegExp(`Handover notes: ${handoffs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.ok(fs.statSync(handoffs).isDirectory());
		assert.match(text, /ag_01 {2}coordinator \(coordinator\) {2}running {2}backend=pi {2}model=claude-code-cli\/claude-opus-5-5 {2}effort=medium/);
		assert.match(text, /ag_04 {2}monitor \(monitor\) .* wake=false/);
		assert.match(text, /Coordinated team: only the coordinator reaches you/);
		assert.deepEqual(r.details.members.map((m: any) => [m.workerId, m.role, m.duty]), [["ag_01", "coordinator", "coordinator"], ["ag_02", "dev", undefined], ["ag_03", "writer", undefined], ["ag_04", "monitor", "monitor"]]);
		const entry = h.appended.find((e) => e.customType === "subagents-team-v1");
		assert.deepEqual(entry.data.members.map((m: any) => [m.role, m.duty, m.orchestrator]), [["coordinator", "coordinator", true], ["dev", undefined, undefined], ["writer", undefined, undefined], ["monitor", "monitor", undefined]]);
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), writer = h.worker("ag_03"), monitor = h.worker("ag_04");
		assert.deepEqual([coordinator.wake, dev.wake, writer.wake, monitor.wake], [true, false, false, false], "only the coordinator wakes the parent");
		assert.deepEqual(monitor.tools, [], "the monitor has no built-in tools");
		assert.deepEqual(coordinator.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"], "a claude-code coordinator's default: Sova's seven tools");
		assert.deepEqual(h.memberOf("ag_01"), { ...h.memberOf("ag_01")!, orchestrator: true, duty: "coordinator" });
		assert.equal(h.memberOf("ag_01")!.coordinated, undefined);
		assert.equal(h.memberOf("ag_02")!.coordinated, true);
		assert.deepEqual([h.memberOf("ag_04")!.duty, h.memberOf("ag_04")!.coordinated, h.memberOf("ag_04")!.orchestrator], ["monitor", true, false]);
		assert.doesNotMatch(coordinator.task, /mcp__team__/, "a claude-code coordinator loads the member extension like a pi member");
		assert.match(coordinator.task, /Your role: coordinator \(coordinator\)/);
		assert.match(coordinator.task, /You are this team's coordinator\. You do no implementation yourself/);
		assert.match(coordinator.task, /- monitor \(monitor\): none declared/);
		assert.match(dev.task, /This team has a coordinator, coordinator: report to it, not to the operator\./);
		assert.match(dev.task, new RegExp(`Your handover note path: ${path.join(handoffs, "dev.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
		assert.match(dev.task, /team_ask sends a question to your team's coordinator/);
		assert.doesNotMatch(monitor.task, /mcp__team__/);
		assert.match(monitor.task, /at or over 60% of its context window: team_msg it with notice "wrap-up"/);
		assert.match(monitor.task, /AT\/OVER the pause threshold \(it marks one only when no login of that provider has headroom — a non-weekly window such as 5h at 90% or more, or a 7d window at 100%; a 7d window below 100% is informational[^)]*\): team_msg coordinator with notice "pause".*plus 5 min/);
		assert.match(monitor.task, /wake_nudge schedule delay "10m" and end your turn\. Never sleep or poll in a shell/);
		assert.doesNotMatch(monitor.task, /team_ask/);
		for (const [w, role] of [[coordinator, "coordinator"], [dev, "dev"], [writer, "writer"]])
			assert.ok(w.task.includes(`Your handover note path: ${path.join(handoffs, `${role}.md`)}.`), `${role}'s header names its own note`);
		assert.doesNotMatch(monitor.task, /handover note path|read its handover note/, "a monitor has no file tools: it hands over by team_msg");
		const list = (await h.call("team_list")).content[0].text;
		assert.match(list, /Coordinated \(team defaults\)/);
		assert.match(list, /ag_01 coordinator \(coordinator\) \[pi\]/);
		assert.match(list, /ag_04 monitor \(monitor\) \[pi\]/);
		// team_add into a coordinated team: routed and wake:false; another orchestrator is refused.
		await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "test", wake: true }] });
		assert.equal(h.worker("ag_05").wake, false);
		assert.equal(h.memberOf("ag_05")!.coordinated, true);
		assert.match(h.worker("ag_05").task, /This team has a coordinator, coordinator/);
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "t", orchestrator: true }] }), /^Error: Team team_01 has a coordinator, coordinator \(ag_01\), and only the coordinator is a team's orchestrator: boss can't join with orchestrator: true\. The coordinator hands a member, itself included, over to a successor with its own team_succeed step\. A member that only watches or reports needs no orchestrator mark: add boss without it\. The coordinator coordinator \(ag_01\) is live, so it hands over itself/);
	} finally { await h.cleanup(); }
});

test("team defaults pick the fallback when the primary cannot run, and refuse the team when neither can", async () => {
	const withFallback = { ...DEFAULTS_FILE, coordinator: { ...DEFAULTS_FILE.coordinator, primary: { backend: "claude-code", model: "zai/glm-5.3" }, fallback: { backend: "pi", model: "test/model", effort: "high" } } };
	const h = coordinatedHarness(withFallback);
	try {
		const r = await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		assert.match(r.content[0].text, /coordinator coordinator added on pi\/test\/model\/high \(fallback; primary claude-code\/zai\/glm-5\.3 refused: Claude model must be a Claude model ID/);
		assert.equal(h.worker("ag_01").backend, "pi");
		assert.equal(h.memberOf("ag_01")!.duty, "coordinator");
	} finally { await h.cleanup(); }
	const neither = { ...withFallback, coordinator: { ...withFallback.coordinator, fallback: { backend: "pi", model: "nope/x" } } };
	const n = coordinatedHarness(neither);
	try {
		await assert.rejects(
			n.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] }),
			/Team not created: team defaults require a coordinator \(coordinator\), but no configured model can run — primary claude-code\/zai\/glm-5\.3: Claude model must be a Claude model ID.*; fallback pi\/nope\/x: unknown model nope\/x .*defaults\.coordinator: false/,
		);
		assert.equal(n.workers.length + n.created.length, 0, "nothing started");
		assert.equal(n.appended.filter((e) => e.customType === "subagents-team-v1").length, 0, "nothing recorded");
		const ok = await n.call("team_create", { name: "Crew", objective: "o", defaults: { coordinator: false }, members: [{ role: "dev", prompt: "p" }] });
		assert.match(ok.content[0].text, /^Created team_01 \(Crew\)/, "the name was never reserved; the escape hatch creates it plainly");
		assert.match(ok.content[0].text, /coordinator turned off for this team \(defaults\.coordinator: false\); no coordinator or monitor/);
		assert.equal(n.workers[0].wake, true);
	} finally { await n.cleanup(); }
	// claude-code is built in: a harness with no registered backend still runs the Claude defaults.
	const noBackend = coordinatedHarness(DEFAULTS_FILE, { claude: false });
	try {
		const r = await noBackend.call("team_create", { name: "Crew", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		assert.match(r.content[0].text, /coordinator coordinator added on claude-code\/claude-opus-5-5\/medium \(primary\)/);
	} finally { await noBackend.cleanup(); }
	// The model policy is a denial like any other.
	const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-td-policy-"));
	const policyFile = path.join(policyDir, "policy.json");
	fs.writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: [], disabledModels: ["claude-code/claude-haiku-4-5"] }));
	const p = coordinatedHarness({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, fallback: { backend: "pi", model: "test/model" } } });
	try {
		const r2 = await registerAgain(p, policyFile);
		assert.match(r2, /monitor monitor added on pi\/test\/model \(fallback; primary claude-code\/claude-haiku-4-5\/medium refused: .*claude-haiku-4-5/);
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

test("team defaults: the caller's orchestrator is the coordinator; conflicts are refused; no per-call limit; monitor escape hatch", async () => {
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
		// No per-call limit: 10 named members start with the coordinator and monitor Sova adds.
		const before = h.workers.length + h.created.length;
		const big = await h.call("team_create", { name: "Big", objective: "o", members: Array.from({ length: 10 }, (_, i) => ({ role: `m${i}`, prompt: "p" })) });
		assert.equal(big.details.members.length, 12);
		assert.deepEqual(big.details.members.filter((m: any) => m.duty).map((m: any) => m.duty), ["coordinator", "monitor"]);
		assert.equal(h.workers.length + h.created.length, before + 12);
		assert.match(big.content[0].text, /Standing roles — coordinator: "coordinator", added by Sova; monitor: "monitor", added by Sova\./);
		const noMonitor = await h.call("team_create", { name: "Quiet", objective: "o", defaults: { monitor: false }, members: [{ role: "dev", prompt: "p" }] });
		assert.match(noMonitor.content[0].text, /monitor turned off for this team \(defaults\.monitor: false\)/);
		assert.match(noMonitor.content[0].text, /Standing roles — coordinator: "coordinator", added by Sova; monitor: off for this team \(defaults\.monitor: false\)\./);
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
		coordinator.status = "waiting"; // idle: a normal item is listed after the debounce
		dev.output = "built it";
		dev.settle();
		await h.tick();
		assert.equal(h.parentMessages("subagent-complete").length, 0, "a member's completion never reaches the parent");
		// A report item, listed to the idle coordinator with its short body in full.
		await waitFor(() => coordinator.lastSteer?.message.includes("report from dev"), "the report listed to the coordinator");
		assert.match(coordinator.lastSteer.message, /^\[Team inbox: 1 new — [^\n]*\]\n- (i_\w+) report from dev — finished: built it\n    \[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\]\n    ### ag_02 \(dev\) — waiting[\s\S]*built it/);
		const report = readMemberItems(h.memberOf("ag_01")!.dir).find((i) => i.kind === "report")!;
		assert.deepEqual([report.from, report.urgent], [{ role: "dev", workerId: "ag_02" }, false]);
		const steers = coordinator.steerCount;
		monitor.settle();
		await h.tick();
		await pause(80);
		assert.equal(coordinator.steerCount, steers, "a monitor check settles silently");
		monitor.status = "running";
		monitor.settle("rate limited");
		await h.tick();
		await waitFor(() => coordinator.lastSteer.message.includes("report from monitor"), "the failed report listed");
		assert.match(coordinator.lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) — [^\n]*\]\n! i_\w+ report from monitor — failed: /);
		assert.match(coordinator.lastSteer.message, /Team report from monitor \(ag_04\), team_01: failed/);
		monitor.error = undefined;
		// A killed member's completion goes nowhere.
		const before = coordinator.steerCount;
		qa.settle(undefined, "killed");
		await h.tick();
		await pause(80);
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
		const qid = /^Question queued for your coordinator coordinator \(ag_01\): item (i_\w+)\. The answer arrives in your inbox/.exec(q.text)?.[1];
		assert.ok(qid, q.text);
		await waitFor(() => coordinator.lastSteer.message.includes(qid!), "the question listed to the idle coordinator");
		assert.match(coordinator.lastSteer.message, new RegExp(`^\\[Team inbox: 1 new — [^\\n]*\\]\\n- ${qid} question from dev — Which schema\\?\\n`));
		assert.equal(h.memberOf("ag_01") && readMemberItems(h.memberOf("ag_01")!.dir).find((i) => i.id === qid)?.kind, "question");
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

test("routing: a parent agent_wait returns the coordinator's completion instead of a subagent-complete; a waited member still reports to the coordinator", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02");
		h.messages.length = 0;
		const onCoordinator = h.call("agent_wait", { ids: ["ag_01"] });
		coordinator.output = "Claude result";
		coordinator.settle();
		assert.match((await onCoordinator).content[0].text, /### ag_01 \(coordinator\) — waiting[\s\S]*Claude result/);
		assert.equal(h.parentMessages("subagent-complete").length, 0, "the wait returned the coordinator's completion");
		const onDev = h.call("agent_wait", { ids: ["ag_02"] });
		dev.output = "built it";
		dev.settle();
		await waitFor(() => coordinator.lastSteer?.message.includes("report from dev"), "the report listed to the idle coordinator");
		assert.match(coordinator.lastSteer.message, /- i_\w+ report from dev — finished: built it\n    \[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\][\s\S]*built it/);
		assert.match((await onDev).content[0].text, /built it/);
		assert.equal(h.parentMessages("subagent-complete").length, 0);
	} finally { await h.cleanup(); }
});

test("routing: a member's settle during the parent's run still reaches the coordinator at once", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02");
		h.messages.length = 0;
		h.event("agent_start", {});
		coordinator.status = "waiting";
		dev.output = "built it mid-run";
		dev.settle();
		await waitFor(() => coordinator.lastSteer?.message.includes("report from dev"), "the report listed to the idle coordinator");
		assert.match(coordinator.lastSteer.message, /- i_\w+ report from dev — finished: built it mid-run\n    \[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\][\s\S]*built it mid-run/);
		h.event("agent_end", { messages: [] });
		assert.equal(h.parentMessages("subagent-complete").length, 0, "only the parent's copy is ever held");
	} finally { await h.cleanup(); }
});

test("routing: a member woken by its inbox at its turn end still reports that turn's answer to the coordinator", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02");
		assert.equal((await h.ask("ag_03", { type: "message", to: "dev", message: "HELLO from qa" })).ok, true);
		coordinator.status = "waiting";
		dev.output = "DEV-FINAL";
		dev.settle();
		await waitFor(() => dev.steerCount === 1, "the list at the end of dev's turn");
		await waitFor(() => coordinator.lastSteer?.message.includes("report from dev"), "the report listed to the idle coordinator");
		assert.match(coordinator.lastSteer.message, /report from dev — finished: DEV-FINAL[\s\S]*### ag_02 \(dev\) — waiting\n/);
		assert.doesNotMatch(coordinator.lastSteer.message, /Still working/);
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
		assert.match(roster.text, /ag_01 coordinator \(coordinator\) \[pi, has team tools\] working \(running\) · context 640k\/1M \(64%\)/);
		assert.match(roster.text, /ag_02 dev \[pi, has team tools\] working \(running\) · context — /);
		assert.match(roster.text, /ag_03 monitor \(monitor\) .* context 150k\/200k \(75%\)/);
		assert.match(roster.text, /Thresholds \(team defaults, read now\): wrap-up at 60% context · check every 10 min · usage pause when no login of a provider has headroom \(a non-weekly window at 90%, a 7d window at 100%\), resume 5 min after the reset/);
		assert.ok(roster.text.includes(`claude 5h: 92%, resets ${reset} — AT/OVER the 90% pause threshold`), roster.text);
		assert.doesNotMatch(roster.text, /openai/, "only providers this team's models spend from");
		// Thresholds are re-read: editing the chat's profile shows at the next roster; a legacy
		// team-defaults.json written later does not move it (the library shadows the legacy file).
		const lib = JSON.parse(fs.readFileSync(path.join(h.agentDir, "subagent-profiles.json"), "utf8"));
		lib.profiles[0].teams.monitor.contextPct = 70;
		fs.writeFileSync(path.join(h.agentDir, "subagent-profiles.json"), JSON.stringify(lib));
		fs.writeFileSync(path.join(h.agentDir, "team-defaults.json"), JSON.stringify({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, contextPct: 80 } }));
		const reread = (await h.ask("ag_03", { type: "roster" })).text;
		assert.match(reread, /wrap-up at 70% context/);
		assert.doesNotMatch(reread, /wrap-up at 80%/, "the library shadows a legacy team-defaults.json written after seeding");
		assert.equal((await h.ask("ag_02", { type: "roster" })).ok, false, "a worker has no roster");
		assert.match((await h.call("team_list")).content[0].text, /ag_01 coordinator \(coordinator\) \[pi\] working \(running\) · context 640k\/1M \(64%\)/);
		// Notices: delivered with their kind, recorded as actions; pause/resume also as session events.
		const paused = await h.ask("ag_03", { type: "message", to: "coordinator", message: "claude 5h at 92%, resets 18:19Z", notice: "pause" });
		assert.equal(paused.ok, true);
		assert.match(paused.text, /^Queued for coordinator \(ag_01\): item i_\w+$/);
		// An urgent notice item: the busy coordinator gets it at its next step.
		await waitFor(() => coordinator.lastSteer?.message.includes("PAUSE:"), "the pause notice listed to the coordinator");
		assert.match(coordinator.lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) — [^\n]*\]\n! i_\w+ notice from monitor — PAUSE: claude 5h at 92%, resets 18:19Z\n/);
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
		// An urgent notice item from Sova: the busy monitor gets it at its next step.
		await waitFor(() => monitor.lastSteer?.message.includes("[wake_nudge n2]"), "the fire listed to the monitor");
		assert.match(monitor.lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) — [^\n]*\]\n! i_\w+ notice from Sova — \[wake_nudge n2\] after reset\n    \[wake_nudge n2\] Scheduled wakeup fired \(set \d+s ago\)\.\n    Reason: after reset\n    Continue your standing instruction/);
		assert.equal(monitor.lastSteer.mode, undefined);
		const fire = readMemberItems(h.memberOf("ag_03")!.dir).find((i) => i.subject.startsWith("[wake_nudge n2]"))!;
		assert.deepEqual([fire.kind, fire.urgent, fire.from], ["notice", true, { role: "Sova", workerId: "parent" }]);
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
		await waitFor(() => monitor.lastSteer?.message.includes("Wake limit"), "the 30th fire listed");
		assert.match(monitor.lastSteer.message, /Wake limit \(30 fires with no teammate working\) reached: do not schedule more nudges/);
		assert.match((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } })).text, /Wake limit/);
		dev.status = "running";
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "10m" } })).ok, true, "a working teammate resets the count");
	} finally { await h.cleanup(); }
});

test("pending wake_nudges are kept in the mailbox on each change, and the next manager re-arms them", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	const mail = path.join(h.root, "mail");
	const kept = () => JSON.parse(fs.readFileSync(path.join(mail, "nudges.json"), "utf8"));
	let next: ReturnType<typeof coordinatedHarness> | undefined;
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "1h", reason: "next check" } });
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "2h", reason: "later" } });
		assert.deepEqual(kept().ag_03.active.map((n: any) => [n.id, n.reason]), [["n1", "next check"], ["n2", "later"]]);
		await h.ask("ag_03", { type: "nudge", nudge: { action: "cancel", id: "n2" } });
		assert.deepEqual(kept().ag_03.active.map((n: any) => n.id), ["n1"]);
		await h.close();
		assert.deepEqual(kept().ag_03.active.map((n: any) => n.id), ["n1"], "a closing manager keeps them");
		// The next manager on the same mailbox: n1 is armed again for the time left.
		next = coordinatedHarness();
		const again = harness(eventBus(), { mailboxRoot: mail, mailboxPollMs: 10, agentDir: next.agentDir, setTimer: (fn, ms) => { next!.timers.push({ fn, ms }); return { fn, ms } as any; } });
		await again.call("team_create", { name: "Other", objective: "o", members: [{ role: "dev", prompt: "p" }] });
		const armed = next.timers.find((t) => t.ms > 3_500_000 && t.ms <= 3_600_000);
		assert.ok(armed, `n1 re-armed (${next.timers.map((t) => t.ms).join(", ")})`);
		await again.close();
	} finally {
		fs.rmSync(h.root, { recursive: true, force: true });
		await next?.cleanup();
	}
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
		assert.equal(r.text, `Handover started: dev (ag_02) was told to write its handover note at ${note} and end its turn. Its successor starts as soon as the note exists, or after 10 min at the latest; a message here names it then.`);
		assert.match(dev.lastSteer.message, new RegExp(`^\\[Handover from coordinator coordinator \\(ag_01\\), team_01\\]\\nYour context is running out and a successor will take over your work\\. Finish the step you are in, then write or update your handover note at ${esc(note)} .*do no new work, and end your turn\\. Your successor starts as soon as the note exists \\(at the latest in 10 min\\)\\. It inherits your assignment and every instruction the main thread gave you, including any still queued for you: do not start those`));
		assert.equal(dev.lastSteer.mode, "redirect", "N7: a redirect, ahead of anything queued");
		assert.equal(h.worker("ag_04"), undefined, "no successor before the note");
		assert.match((await h.ask("ag_01", { type: "succeed", to: "dev" })).text, /A successor for dev is already taking over/);
		dev.settle();
		await h.tick();
		assert.equal(h.worker("ag_04"), undefined, "a turn that ended without the note starts nothing");
		h.writeNote("dev");
		dev.status = "running";
		dev.settle();
		await h.tick();
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: dev's note is written\]\nStarted dev-2 \(ag_04\) to succeed dev \(ag_02\) on pi\/test\/model\/low\. dev was told to brief it; it is retired when dev-2 calls team_ready, or after 10 min\.$/);
		const successor = h.worker("ag_04");
		assert.deepEqual([successor.name, successor.backend, successor.model, successor.effort, successor.tools, successor.wake], ["dev-2", "pi", "test/model", "low", ["read"], false]);
		assert.deepEqual([h.memberOf("ag_04")!.successorOf, h.memberOf("ag_04")!.coordinated, h.memberOf("ag_04")!.duty], ["dev", true, undefined]);
		assert.match(successor.task, new RegExp(`You succeed dev, whose context is running out\\. Start from its handover note at ${esc(note)}: continue from the state it records, do not redo steps it marks done`));
		assert.match(successor.task, /Your declared ownership: src/);
		assert.match(successor.task, /\[Your task\]\nContinue the work of dev \(ag_02\)[\s\S]*Call team_ready as soon as you have taken over/);
		assert.doesNotMatch(successor.task, /may be missing/, "the note was written first");
		assert.match(dev.lastSteer.message, new RegExp(`^\\[Handover from coordinator coordinator \\(ag_01\\), team_01\\]\\nYour successor dev-2 \\(ag_04\\) has started and is reading your handover note at ${esc(note)}\\. Stop any work in progress now\\. Your assignment and every instruction the main thread gave you, including any still queued for you, are dev-2's now: do not act on them; if one reaches you, reply only that dev-2 has it\\. Answer its team_msg questions`));
		assert.equal(h.timers.at(-1)!.ms, 600_000);
		const persisted = h.appended.filter((e) => e.customType === "subagents-team-v1").at(-1);
		assert.deepEqual([persisted.data.op, persisted.data.members[0].role, persisted.data.members[0].successorOf], ["add", "dev-2", "ag_02"], "contract: successorOf is the predecessor's worker ID");
		const again = await h.ask("ag_01", { type: "succeed", to: "dev" });
		assert.match(again.text, /A successor for dev is already taking over/);
		const stray = await h.ask("ag_03", { type: "ready" });
		assert.equal(stray.ok, false, "the monitor is nobody's successor");
		// N10: dev is mid-turn (it may be answering dev-2): team_ready retires it when that turn ends, not now.
		assert.equal(dev.status, "running");
		const ready = await h.ask("ag_04", { type: "ready" });
		assert.equal(ready.ok, true);
		assert.equal(ready.text, "dev (ag_02) is still in a turn (it may be answering you): it is retired as soon as that turn ends, or at the retire timeout. You now carry its work; its answer, if any, still reaches you.");
		await h.tick();
		assert.equal(dev.status, "running", "not cut off mid-turn");
		dev.settle();
		await h.tick();
		assert.equal(dev.status, "killed", "retired on confirmation, once its turn ended");
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
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: timed out waiting for dev-2's note\]\nStarted dev-3 \(ag_05\) .* The note may be missing \(dev-2 had not written it 10 min after it was asked to\); the successor was told so\.$/);
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
		await assertItem(h, "ag_06", "report", /Team report from dev-3 \(ag_05\), team_01: finished — routed to you as coordinator/);
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

test("N7: with main-thread follow-ups queued on the old member, its successor starts once the note exists, without a settle, and inherits them", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "Write f01..f06." }, { role: "qa", prompt: "Test it." }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02");
		// e2e 3: a follow-up queued before team_succeed runs straight after the wrap-up turn, so dev never settles.
		await h.call("agent_steer", { id: "ag_02", message: "After f06, also write summary.txt.", mode: "followUp" });
		await h.ask("ag_01", { type: "succeed", to: "dev" });
		assert.equal(dev.lastSteer.mode, "redirect", "the handover instruction is a redirect: it lands ahead of the queued follow-up");
		assert.match(dev.lastSteer.message, /including any still queued for you: do not start those; if one reaches you, reply only that your successor has it\./);
		h.writeNote("dev");
		await h.tick();
		assert.equal(dev.status, "running", "dev never settled");
		const successor = h.worker("ag_05");
		assert.equal(successor?.name, "dev-2", "the gate opened on the note alone");
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: dev's note is written\]\nStarted dev-2 \(ag_05\)/);
		assert.ok(!readMemberItems(h.memberOf("ag_01")!.dir).some((i) => i.kind === "handover" && /timed out/.test(i.body)));
		// N2: the queued follow-up is the successor's now; dev is told to leave it.
		assert.match(successor.task, /Instructions from the main thread to dev, oldest first [^\n]* They are binding and part of your assignment now[^\n]*\n- After f06, also write summary\.txt\.$/);
		assert.equal(dev.lastSteer.mode, "redirect", "the started notice is a redirect too");
		assert.match(dev.lastSteer.message, /Stop any work in progress now\. Your assignment and every instruction the main thread gave you, including any still queued for you, are dev-2's now: do not act on them/);
		// The coordinator is told the real reason in the other orders too, read from the note at that moment.
		await h.ask("ag_01", { type: "succeed", to: "qa" });
		h.writeNote("qa");
		h.worker("ag_03").settle(undefined, "killed"); // Ends before the next poll sees the note.
		await h.tick();
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: qa ended after writing its note\]\nStarted qa-2 /);
		await h.ask("ag_01", { type: "succeed", to: "qa-2" });
		const timer = h.timers.at(-1)!;
		h.writeNote("qa-2");
		timer.fn(); // The timeout fires before the next poll sees the note.
		await h.tick();
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: the wait ran out just as qa-2's note appeared\]\nStarted qa-3 /);
		assert.doesNotMatch((await assertItem(h, "ag_01", "handover", /Started qa-3 /)).body, /may be missing/);
	} finally { await h.cleanup(); }
});

test("N9: a resume notice is refused until the pausing window's reset plus the resume margin", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		fs.mkdirSync(path.join(h.agentDir, "cache"));
		const cache = (pct: number, resetsAt: string) => fs.writeFileSync(path.join(h.agentDir, "cache", "usage-status.json"), JSON.stringify({
			fetchedAt: Date.now(), nextFetchAt: Date.now(), errors: {}, claude: { state: "ok", limits: [{ label: "5h", pct, resetsAt }] },
		}));
		const reset = new Date(Math.ceil((Date.now() + 3 * 3600_000) / 1000) * 1000).toISOString();
		cache(92, reset);
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01");
		assert.match(h.worker("ag_03").task, /When woken after a pause: once that window's reset time plus 5 min has passed, team_msg coordinator with notice "resume"; otherwise schedule again\. The parent refuses a resume before then, and its refusal says when to try\./);
		assert.equal((await h.ask("ag_03", { type: "message", to: "coordinator", message: "claude 5h at 92%", notice: "pause" })).ok, true);
		await waitFor(() => coordinator.lastSteer?.message.includes("PAUSE:"), "the pause notice listed");
		const steers = coordinator.steerCount;
		// e2e 3: the monitor judged the time itself and resumed early, while the roster still said AT/OVER.
		const early = await h.ask("ag_03", { type: "message", to: "coordinator", message: "resume", notice: "resume" });
		assert.equal(early.ok, false);
		const from = new Date(Date.parse(reset) + 5 * 60_000).toISOString();
		assert.match(early.text, new RegExp(`^Resume refused: claude 5h paused this team and resets at ${esc(reset)}; resume is allowed from ${esc(from)} \\(the reset plus 5 min\\), in 3h\\d*m?\\. Schedule wake_nudge at that time and end your turn\\.$`));
		assert.equal(coordinator.steerCount, steers, "nothing was delivered");
		const kinds = () => h.appended.filter((e) => e.customType === "subagents-team-event-v1").map((e) => e.data.kind);
		assert.deepEqual(kinds(), ["pause"], "no resume event");
		// A fresh cache after the reset does not lift the hold early: the time does (margin 0 here, a reset 300ms away).
		fs.writeFileSync(path.join(h.agentDir, "team-defaults.json"), JSON.stringify({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, usage: { ...DEFAULTS_FILE.monitor.usage, resumeMarginMinutes: 0 } } }));
		assert.equal((await h.ask("ag_03", { type: "message", to: "coordinator", message: "still paused", notice: "resume" })).ok, false, "the hold is the pause-time window's, read with the margin now");
		const h2 = coordinatedHarness({ ...DEFAULTS_FILE, monitor: { ...DEFAULTS_FILE.monitor, usage: { ...DEFAULTS_FILE.monitor.usage, resumeMarginMinutes: 0 } } });
		try {
			fs.mkdirSync(path.join(h2.agentDir, "cache"));
			const soon = new Date(Date.now() + 300).toISOString();
			fs.writeFileSync(path.join(h2.agentDir, "cache", "usage-status.json"), JSON.stringify({
				fetchedAt: Date.now(), nextFetchAt: Date.now(), errors: {}, claude: { state: "ok", limits: [{ label: "5h", pct: 95, resetsAt: soon }] },
			}));
			await h2.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
			await h2.ask("ag_03", { type: "message", to: "coordinator", message: "pause", notice: "pause" });
			assert.match((await h2.ask("ag_03", { type: "message", to: "coordinator", message: "resume", notice: "resume" })).text, /^Resume refused: claude 5h/);
			await h2.tick(Math.max(0, Date.parse(soon) - Date.now()) + 50);
			const resumed = await h2.ask("ag_03", { type: "message", to: "coordinator", message: "resume", notice: "resume" });
			assert.equal(resumed.ok, true, resumed.text);
			await waitFor(() => h2.worker("ag_01").lastSteer?.message.includes("RESUME:"), "the resume notice listed");
			assert.match(h2.worker("ag_01").lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) — [^\n]*\]\n! i_\w+ notice from monitor — RESUME: resume\n/);
			// A pause with no window at or over the threshold holds nothing: resume is not delayed.
			fs.rmSync(path.join(h2.agentDir, "cache"), { recursive: true });
			await h2.ask("ag_03", { type: "message", to: "coordinator", message: "pause", notice: "pause" });
			assert.equal((await h2.ask("ag_03", { type: "message", to: "coordinator", message: "resume", notice: "resume" })).ok, true);
		} finally { await h2.cleanup(); }
	} finally { await h.cleanup(); }
});

test("with several Claude logins the roster marks nothing while one has 5h headroom, and a full pause holds until the soonest login frees", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		fs.mkdirSync(path.join(h.agentDir, "cache"));
		const at = (hours: number) => new Date(Math.ceil((Date.now() + hours * 3600_000) / 1000) * 1000).toISOString();
		const weekly = at(96), soonest = at(2), later = at(4);
		const login = (pct: number, resetsAt: string) => ({ state: "ok", limits: [{ label: "5h", pct, resetsAt }, { label: "7d", pct: 96, resetsAt: weekly }] });
		const cache = (other: number) => fs.writeFileSync(path.join(h.agentDir, "cache", "usage-status.json"), JSON.stringify({
			fetchedAt: Date.now(), nextFetchAt: Date.now(), errors: {},
			claude: login(95, later), claudeAccounts: { "l-b": { data: login(other, soonest), nextFetchAt: 0 } },
		}));
		cache(30);
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const roster = (await h.ask("ag_03", { type: "roster" })).text;
		assert.doesNotMatch(roster, /AT\/OVER/);
		assert.ok(roster.includes(`claude 7d [l-b]: 96%, resets ${weekly} (weekly, informational below 100%)`), roster);
		assert.ok(roster.includes("claude: headroom on 1 of 2 logins — not a reason to pause"), roster);
		cache(92);
		assert.ok((await h.ask("ag_03", { type: "roster" })).text.includes(`claude 5h [l-b]: 92%, resets ${soonest} — AT/OVER the 90% pause threshold`));
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "pause", notice: "pause" });
		const early = await h.ask("ag_03", { type: "message", to: "coordinator", message: "resume", notice: "resume" });
		assert.match(early.text, new RegExp(`^Resume refused: claude 5h \\[l-b\\] paused this team and resets at ${esc(soonest)};`));
	} finally { await h.cleanup(); }
});

test("N10: team_ready while the predecessor is answering retires it when that turn ends, or at the retire timeout", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "counter", prompt: "count" }, { role: "writer", prompt: "write" }] });
		const events = () => h.appended.filter((e) => e.customType === "subagents-team-event-v1").map((e) => [e.data.kind, e.data.role, e.data.detail]);
		const counter = h.worker("ag_02");
		await h.ask("ag_01", { type: "succeed", to: "counter" });
		h.writeNote("counter");
		await h.tick();
		counter.settle();
		// e2e 3: counter-2 asked its predecessor, then called team_ready 5 s later, which aborted the answer.
		assert.equal((await h.ask("ag_05", { type: "message", to: "counter", message: "Which h-files are done?" })).ok, true);
		await waitFor(() => counter.status === "running", "the question listed to the idle predecessor");
		assert.match(counter.lastSteer.message, /- i_\w+ message from counter-2 — Which h-files are done\?/);
		assert.match((await h.ask("ag_05", { type: "ready" })).text, /^counter \(ag_02\) is still in a turn/);
		assert.match((await h.ask("ag_05", { type: "ready" })).text, /^counter \(ag_02\) is still in a turn/, "asking again changes nothing");
		await h.tick();
		assert.equal(counter.status, "running");
		assert.deepEqual(events().map((e) => e[0]), ["handover"], "no retirement yet");
		// Its turn ends by exiting: retired then, as confirmed, and its seat released.
		counter.exit();
		await h.tick();
		assert.deepEqual(events().at(-1), ["retire", "counter", "retired: successor counter-2 (ag_05) confirmed the takeover"]);
		assert.ok(h.appended.some((e) => e.customType === "subagents-team-v1" && e.data.op === "eject" && e.data.workerId === "ag_02"));
		// A predecessor that never ends its turn is still retired at the timeout.
		const writer = h.worker("ag_03");
		await h.ask("ag_01", { type: "succeed", to: "writer" });
		h.writeNote("writer");
		await h.tick();
		const retireTimer = h.timers.at(-1)!;
		assert.equal(retireTimer.ms, 600_000);
		assert.match((await h.ask("ag_06", { type: "ready" })).text, /^writer \(ag_03\) is still in a turn/);
		retireTimer.fn();
		await h.tick();
		assert.equal(writer.status, "killed");
		assert.deepEqual(events().at(-1), ["retire", "writer", "retired: handover to writer-2 (ag_06) timed out"]);
	} finally { await h.cleanup(); }
});

test("handovers eject automatically: a retired member and an ended member succeeded release their seats; team_eject refuses a member mid-handover", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const ejects = () => h.appended.filter((e) => e.customType === "subagents-team-v1" && e.data.op === "eject").map((e) => [e.data.teamId, e.data.workerId]);
		const dev = h.worker("ag_02");
		// (c) The predecessor while its successor has not started.
		await h.ask("ag_01", { type: "succeed", to: "dev" });
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "dev" }), /^Error: dev \(ag_02\) is mid-handover in team_01: its successor has not started yet \(it starts once the handover note at .*dev\.md exists, or at the handover timeout\); it is then retired and its seat released automatically\.$/);
		h.writeNote("dev");
		await h.tick();
		const successor = h.worker("ag_05");
		assert.equal(successor.name, "dev-2");
		// (c) Both sides of an unconfirmed handover, even once the successor itself has ended.
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "dev" }), /dev \(ag_02\) is mid-handover in team_01: its successor dev-2 \(ag_05\) has not confirmed with team_ready yet; it is retired and its seat released automatically on team_ready or at the retire timeout\./);
		successor.settle(undefined, "error");
		await assert.rejects(h.call("team_eject", { team: "Crew", member: "dev-2" }), /dev-2 \(ag_05\) is mid-handover in team_01: it is taking over from dev \(ag_02\) and has not confirmed with team_ready yet; wait for that handover to finish/);
		assert.deepEqual(ejects(), []);
		// (a) The retire timeout kills dev and releases its seat, recorded as the system's.
		h.timers.at(-1)!.fn();
		await h.tick();
		assert.equal(dev.status, "killed");
		assert.deepEqual(ejects(), [["team_01", "ag_02"]]);
		let list = (await h.call("team_list")).content[0].text;
		assert.match(list, /system eject → ag_02 \(dev\): accepted-or-queued/);
		assert.match(list, /1 ejected/);
		// Once the handover is over, the ended successor is the operator's to eject again.
		await h.call("team_eject", { team: "Crew", member: "dev-2" });
		assert.deepEqual(ejects().at(-1), ["team_01", "ag_05"]);
		// (a) team_ready retires and ejects too.
		await h.ask("ag_01", { type: "succeed", to: "qa" });
		h.writeNote("qa");
		await h.tick();
		const qa2 = h.worker("ag_06");
		assert.equal(qa2.name, "qa-2");
		h.worker("ag_03").settle();
		assert.equal((await h.ask("ag_06", { type: "ready" })).ok, true);
		await h.tick();
		assert.equal(h.worker("ag_03").status, "killed");
		assert.deepEqual(ejects().at(-1), ["team_01", "ag_03"]);
		// (b) team_succeed on a member that has already ended: started at once, the ended one ejected.
		qa2.settle(undefined, "killed");
		await h.tick();
		const late = await h.ask("ag_01", { type: "succeed", to: "qa-2" });
		assert.match(late.text, /^Started qa-3 .* qa-2 has already ended; the successor works from the handover note\./);
		assert.deepEqual(ejects().at(-1), ["team_01", "ag_06"]);
		list = (await h.call("team_list")).content[0].text;
		assert.match(list, /system eject → ag_06 \(qa-2\): accepted-or-queued/);
		assert.match(list, /4 ejected/);
		// Each eject, the system's and the operator's alike, was persisted as one eject op.
		assert.equal(ejects().length, 4);
	} finally { await h.cleanup(); }
});

test("N8: inherited main-thread steers are the successor's binding assignment, in its task and wherever the coordinator reads them", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "counter", prompt: "Count lines." }] });
		const coordinator = h.worker("ag_01");
		assert.match(coordinator.task, /You never tell a member that work from the main thread is not its work, and that includes the instructions a successor inherited from its predecessor, which are the successor's assignment; check team_roster before you tell a member what not to do\./);
		await h.call("agent_steer", { id: "ag_02", message: "Also write h01..h06.", mode: "followUp" });
		await h.ask("ag_01", { type: "succeed", to: "counter" });
		h.writeNote("counter");
		await h.tick();
		const successor = h.worker("ag_04");
		assert.equal(successor.name, "counter-2");
		// The successor: binding, from the main thread, and not to be given up when told otherwise.
		assert.match(successor.task, /\nInstructions from the main thread to counter, oldest first \(the newest may not have been started\)\. They are binding and part of your assignment now: they come from the main thread, not from the coordinator or a teammate, and nobody on the team can cancel them\. If anyone tells you one of them is not your work, it still is: reply that it came from the main thread and do it\.\n- Also write h01\.\.h06\.$/);
		assert.match(successor.task, /Its assignment and the main thread's instructions to it, quoted in your task, are yours now and binding\./);
		// The coordinator is pushed the list with the handover (e2e 3: it never called team_roster before countermanding).
		await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: counter's note is written\]\nStarted counter-2 \(ag_04\) [^\n]*\nLater instructions from the main thread \(binding: part of counter-2's assignment, including any inherited from counter \(ag_02\); never tell counter-2 they are not its work\), newest last:\n> Also write h01\.\.h06\.$/);
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_04 counter-2:\n {6}\| Count lines\.\n {6}Later instructions from the main thread \(binding: part of counter-2's assignment, including any inherited from counter \(ag_02\); never tell counter-2 they are not its work\), newest last:\n {6}> Also write h01\.\.h06\./);
		// A coordinator's successor reads them in its header too.
		await h.ask("ag_01", { type: "succeed", to: "coordinator" });
		h.writeNote("coordinator");
		await h.tick();
		const next = h.worker("ag_05");
		assert.equal(next.name, "coordinator-2");
		assert.match(next.task, /- counter-2: none declared\n {2}Assigned task \(from the main thread\):\n {2}\| Count lines\.\n {2}Later instructions from the main thread \(binding: part of counter-2's assignment; never tell counter-2 they are not its work\), newest last:\n {2}> Also write h01\.\.h06\.\n/);
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
		assert.match(roster, /Assignments from the main thread \(the work you route; never replace or cancel it\):\n {4}ag_02 dev:\n {6}\| Write c\.txt with the parser notes\.\n {6}Later instructions from the main thread \(binding: part of dev's assignment; never tell dev they are not its work\), newest last:\n {6}> Also read CLAUDE\.md and summarise it\.\n {4}ag_03 writer:\n {6}\| Write the docs\./);
		assert.doesNotMatch((await h.ask("ag_04", { type: "roster" })).text, /Assignments from the main thread/);
		const coordinatorSteers = await h.ask("ag_01", { type: "steer", to: "dev", message: "focus" });
		assert.equal(coordinatorSteers.ok, true);
		assert.doesNotMatch((await h.ask("ag_01", { type: "roster" })).text, /> focus/, "the coordinator's own steers are not the main thread's");
		// team_add: the coordinator is told, with the new member's task, and the roster lists it.
		const added = await h.call("team_add", { team: "Crew", members: [{ role: "qa", prompt: "Test the parser." }] });
		assert.match(added.content[0].text, /Queued for coordinator coordinator \(ag_01\): item i_\w+, naming the new member\(s\) and their assignments\./);
		const change = await assertItem(h, "ag_01", "notice", /^\[Team change from the main thread, team_01: 1 member\(s\) added — their assignments are legitimate work for you to route, not to replace\]\n- qa \(ag_05\), owns: none declared\n {2}\| Test the parser\.\nteam_roster lists every assignment\.$/);
		assert.deepEqual([change.from, change.subject], [{ role: "main thread", workerId: "parent" }, "1 member(s) added: qa"]);
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_05 qa:\n {6}\| Test the parser\./);
		// N2: a successor carries its predecessor's assignment AND every main-thread steer, in its own
		// task and in the coordinator's view (e2e: a follow-up was lost across a succession).
		await h.call("agent_steer", { id: "ag_02", message: "After c.txt, also write summary.txt.", mode: "followUp" });
		await h.ask("ag_01", { type: "succeed", to: "dev" });
		h.writeNote("dev");
		dev.settle();
		await h.tick();
		const successor = h.worker("ag_06");
		assert.match(successor.task, /\[Your task\]\nContinue the work of dev \(ag_02\)[\s\S]*\n\nIts assignment from the main thread:\nWrite c\.txt with the parser notes\.\n\nInstructions\ from\ the\ main\ thread\ to\ dev,\ oldest\ first\ \(the\ newest\ may\ not\ have\ been\ started\)\.\ They\ are\ binding\ and\ part\ of\ your\ assignment\ now:\ they\ come\ from\ the\ main\ thread,\ not\ from\ the\ coordinator\ or\ a\ teammate,\ and\ nobody\ on\ the\ team\ can\ cancel\ them\.\ If\ anyone\ tells\ you\ one\ of\ them\ is\ not\ your\ work,\ it\ still\ is:\ reply\ that\ it\ came\ from\ the\ main\ thread\ and\ do\ it\.\n- Also read CLAUDE\.md\n {2}and summarise it\.\n- After c\.txt, also write summary\.txt\.$/);
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_06 dev-2:\n {6}\| Write c\.txt with the parser notes\.\n {6}Later instructions from the main thread \(binding: part of dev-2's assignment, including any inherited from dev \(ag_02\); never tell dev-2 they are not its work\), newest last:\n {6}> Also read CLAUDE\.md and summarise it\.\n {6}> After c\.txt, also write summary\.txt\./);
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
			assert.equal(next.backend, "pi", "a claude-code monitor is a pi worker on the provider");
			if (backend === "claude-code") assert.match(next.model, /^claude-code-cli\//);
			const me = h.memberOf("ag_04")!;
			assert.deepEqual([me.duty, me.successorOf], ["monitor", "monitor"]);
			// B2: the successor monitor really has team_ready (the list member.ts serves).
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
			old.settle();
			const ready = await h.ask("ag_04", { type: "ready" });
			assert.equal(ready.ok, true, ready.text);
			assert.match(ready.text, /is being retired; you now carry its work\.$/, "a settled predecessor is retired at once");
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
		assert.match(monitor.lastSteer.message, /^\[Team inbox: 1 new \(1 urgent\) [^\n]*\n! i_\w+ notice from Sova — \[wake_nudge n1\] next check\n    \[wake_nudge n1\] Scheduled wakeup fired \(set \d+s ago\); held while no teammate was working, delivered now that one is\.\n    Reason: next check\n    Continue your standing instruction/);
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
		assert.match(monitor.lastSteer?.message ?? "", /\n! i_\w+ notice from Sova — \[wake_nudge n3\] scheduled wakeup fired\n/);
		// Paused: everyone idle, yet the resume check fires on time.
		dev.status = "waiting";
		await h.ask("ag_03", { type: "message", to: "coordinator", message: "zai 5h at 95%", notice: "pause" });
		coordinator.status = "waiting";
		monitor.lastSteer = undefined;
		await h.ask("ag_03", { type: "nudge", nudge: { action: "schedule", delay: "30m", reason: "resume check" } });
		h.timers.at(-1)!.fn();
		await waitFor(() => monitor.lastSteer?.message.includes("[wake_nudge n4]"), "the paused team's resume check");
		assert.match(monitor.lastSteer?.message ?? "", /\n    \[wake_nudge n4\] Scheduled wakeup fired \(set \d+s ago\)\.\n    Reason: resume check/);
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

test("members default: member's own model, then the call's, then the profile's; a denied default is said, never used, and a successor keeps the tuple it ran on", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		// The seeded "My setup" configures no members default; give it one: pi/test/model/high.
		// (Seeding is lazy: a first read — here /team defaults — writes the library.)
		await h.commands.get("team").handler("defaults", h.ctx);
		const libPath = path.join(h.agentDir, "subagent-profiles.json");
		const lib = JSON.parse(fs.readFileSync(libPath, "utf8"));
		lib.profiles[0].members = { backend: "pi", model: "test/model", effort: "high" };
		fs.writeFileSync(libPath, JSON.stringify(lib));
		const created = await h.call("team_create", {
			name: "Crew", objective: "Ship",
			members: [
				{ role: "dev", prompt: "build" },
				{ role: "own", prompt: "mine", backend: "pi", model: "test/model", effort: "low" },
				{ role: "cc", prompt: "claude work", backend: "claude-code" },
			],
		});
		assert.match(created.content[0].text, /Members default: dev run on pi\/test\/model\/high \(subagent profile "My setup"\)/);
		const dev = h.worker("ag_02"), own = h.worker("ag_03"), cc = h.worker("ag_04");
		assert.deepEqual([dev.backend, dev.model, dev.effort], ["pi", "test/model", "high"], "the profile fills the member nobody gave a model");
		assert.deepEqual([own.backend, own.model, own.effort], ["pi", "test/model", "low"], "the member's own choice wins over the profile");
		assert.equal(cc.model, "claude-code-cli/claude-sonnet-5-5", "a member naming claude-code keeps to it: Claude's default (Sonnet), never the pi default");
		assert.equal(cc.effort, "medium");
		const entry = h.appended.filter((e) => e.customType === "subagents-team-v1" && e.data.op === "create").at(-1);
		const recOf = (id: string) => entry.data.members.find((m: any) => m.workerId === id);
		assert.deepEqual(recOf("ag_02").modelOverride, {}, "a profile-filled member records no explicit choice");
		assert.deepEqual(recOf("ag_03").modelOverride, { backend: "pi", model: "test/model", effort: "low" }, "the member's own choice is recorded apart from the resolved tuple");
		assert.deepEqual(recOf("ag_04").modelOverride, { backend: "claude-code" }, "an explicit backend is recorded");
		// team_add reads the current profile too.
		const add = await h.call("team_add", { team: "team_01", members: [{ role: "docs", prompt: "write" }] });
		assert.match(add.content[0].text, /Members default: docs run on pi\/test\/model\/high/);
		assert.equal(h.worker("ag_06").model, "test/model");
		// A default that can't run here is said, never used: the member runs on the parent's model.
		lib.profiles[0].members = { backend: "pi", model: "zai/not-here", effort: "low" };
		fs.writeFileSync(libPath, JSON.stringify(lib));
		const denied = await h.call("team_add", { team: "team_01", members: [{ role: "late", prompt: "join" }] });
		assert.match(denied.content[0].text, /Members default pi\/zai\/not-here\/low \(subagent profile "My setup"\) can't run here — unknown model zai\/not-here in this session's registry — so late run on this session's model\./);
		assert.equal(h.worker("ag_07").model, "test/model", "a denied default is not used: the member runs on the session's model (the harness's test/model), as the line said");
		// Succession under a working default: the profile-filled member's successor takes the CURRENT default…
		lib.profiles[0].members = { backend: "pi", model: "test/model", effort: "low" };
		fs.writeFileSync(libPath, JSON.stringify(lib));
		const r = await h.ask("ag_01", { type: "succeed", to: "dev" });
		assert.equal(r.ok, true, r.text);
		h.writeNote("dev");
		dev.status = "running";
		dev.settle();
		await h.tick();
		const startedDev2 = (await assertItem(h, "ag_01", "handover", /Started dev-2/)).body;
		assert.match(
			startedDev2,
			/Started dev-2 \(ag_\d+\) to succeed dev \(ag_02\) on pi\/test\/model\/low\.[\s\S]*Members default: dev-2 run on pi\/test\/model\/low/,
			"the current default (not the tuple dev started with) fills the successor, and says so",
		);
		// …whereas a member's own recorded choice is preserved.
		const r2 = await h.ask("ag_01", { type: "succeed", to: "own" });
		assert.equal(r2.ok, true, r2.text);
		h.writeNote("own");
		own.status = "running";
		own.settle();
		await h.tick();
		await assertItem(h, "ag_01", "handover", /Started own-2 \(ag_\d+\) to succeed own \(ag_03\) on pi\/test\/model\/low\./);
		// And a default that went bad since is said and NOT used: the successor keeps the tuple it ran on.
		lib.profiles[0].members = { backend: "pi", model: "zai/not-here", effort: "low" };
		fs.writeFileSync(libPath, JSON.stringify(lib));
		const r3 = await h.ask("ag_01", { type: "succeed", to: "docs" });
		assert.equal(r3.ok, true, r3.text);
		h.writeNote("docs");
		const docs = h.worker("ag_06");
		docs.status = "running";
		docs.settle();
		await h.tick();
		await assertItem(
			h, "ag_01", "handover",
			/Started docs-2 \(ag_\d+\) to succeed docs \(ag_06\) on pi\/test\/model\/high\.[\s\S]*can't run here — unknown model zai\/not-here[\s\S]*keep the tuple they ran on\./,
		); // a denied default leaves the predecessor's tuple in place, and the notice says so
	} finally { await h.cleanup(); }
});

test("/team defaults prints the effective defaults, off, or the malformed reason, and sends nothing", async () => {
	for (const [file, expected] of [[undefined, /^Team defaults: off \(the subagent profile "My setup" configures none\)/], ["{", /is malformed[\s\S]*not valid JSON/], [DEFAULTS_FILE, /^Team defaults \(.*subagent-profiles\.json \(subagent profile "My setup"\)\):\n {2}Coordinator: on — role "coordinator"/]] as const) {
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
		assert.match(h.messages[0][0].content, /- Team defaults are on: team_create adds a coordinator "coordinator" \(claude-code\/claude-opus-5-5\)[\s\S]*a monitor "monitor"/);
	} finally { await h.cleanup(); }
});

/** A session branch holding one `worktrees` snapshot (worktrees/state.ts). */
const worktreesBranch = (trees: { path: string; status?: string; merge?: unknown }[]) => [{
	type: "custom", customType: "worktrees",
	data: { version: 1, trees: trees.map((t) => ({ branch: "feat/x", base: "abc", session: "s1", how: "created", at: 1, status: "active", ...t })) },
}];

test("worktrees: a worker starts only in the session cwd or an active tracked worktree; every spawn path is gated, and a pi worker there is confined to it", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-worktrees-")));
	const wt = path.join(root, "wt-a");
	const dropped = path.join(root, "wt-b");
	fs.mkdirSync(path.join(wt, "src"), { recursive: true });
	fs.mkdirSync(dropped);
	const h = teamHarness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	let branch: unknown[] = [];
	h.ctx.sessionManager.getBranch = () => branch;
	const flagsFor: string[] = [];
	const workerLaunch = workerLaunchOf((r: string) => (flagsFor.push(r), { sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [r] }) }));
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch });
		// Nothing tracked: only the session cwd (and below it).
		await h.call("agent_spawn", { prompt: "here", cwd: "extensions" });
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION], "no confinement in the session cwd");
		for (const backend of [undefined, "claude-code"])
			await assert.rejects(h.call("agent_spawn", { prompt: "there", cwd: wt, backend }), /outside this session's cwd and its worktrees \(none tracked\)/);
		await assert.rejects(h.call("team_create", { name: "T", objective: "o", members: [{ role: "dev", prompt: "p", cwd: wt }] }), /outside this session's cwd/);

		branch = worktreesBranch([{ path: wt }, { path: dropped, status: "dropped" }]);
		await h.call("agent_spawn", { prompt: "in tree", cwd: path.join(wt, "src") });
		const pi = h.workers.at(-1);
		assert.deepEqual(flagsFor, [wt], "confined to the worktree's top level, not its subdir");
		assert.deepEqual(pi.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SANDBOX_DIR]);
		assert.deepEqual(pi.flags, { sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [wt] }) });
		// Claude Code: a pi worker, confined to the worktree the same way (write-only while off).
		await h.call("agent_spawn", { prompt: "claude in tree", cwd: wt, backend: "claude-code" });
		const claude = h.workers.at(-1);
		assert.equal(created.length, 0);
		assert.deepEqual(flagsFor, [wt, wt]);
		assert.deepEqual(claude.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SANDBOX_DIR, CLAUDE_CODE_EXTENSION]);
		assert.deepEqual(claude.flags, { sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [wt] }), [CLAUDE_CODE_PROVIDER_FLAG]: true });
		assert.equal(claude.cwd, wt);
		// Another backend cannot be confined to it.
		await assert.rejects(h.call("agent_spawn", { prompt: "other in tree", cwd: wt, backend: "native-cli" }), /cannot run workers in a tracked worktree/);
		// A dropped worktree admits nothing; the refusal names the active set.
		await assert.rejects(h.call("agent_spawn", { prompt: "d", cwd: dropped }), new RegExp(`outside this session's cwd and its worktrees \\(${wt}\\)`));
		await assert.rejects(h.call("team_add", { team: "team_01", members: [{ role: "x", prompt: "p", cwd: dropped }] }), /outside this session's cwd|No such team/);
		// On: the sandbox's narrowed scope replaces its session-wide worker flags.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch });
		await h.call("agent_spawn", { prompt: "on", cwd: wt });
		assert.deepEqual(h.workers.at(-1).flags, { sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [wt] }) });
		await h.call("agent_spawn", { prompt: "claude on", cwd: wt, backend: "claude-code" });
		assert.deepEqual(h.workers.at(-1).flags, { sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [wt] }), [CLAUDE_CODE_PROVIDER_FLAG]: true });
		await h.call("agent_spawn", { prompt: "on, session cwd" });
		assert.deepEqual(h.workers.at(-1).flags, WORKER_FLAGS);
		// Fail closed: a worktree worker the sandbox cannot scope does not start, of either backend.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch: () => ({ kind: "none" }) });
		await assert.rejects(h.call("agent_spawn", { prompt: "x", cwd: wt }), /Cannot confine a worker to the worktree .*: this session's sandbox gave no scope for it/);
		h.bus.emit(SANDBOX_STATE_EVENT, SANDBOX_OFF);
		for (const backend of [undefined, "claude-code"])
			await assert.rejects(h.call("agent_spawn", { prompt: "x", cwd: wt, backend }), /Cannot confine a worker to the worktree .*: this session's sandbox gave no scope for it/);
		// A worker cannot load the worktrees extension (any copy), so it never has the tool.
		await assert.rejects(h.call("agent_spawn", { prompt: "x", extensions: [path.resolve(fileURLToPath(new URL("../worktrees", import.meta.url)))] }), /Refusing to load the worktrees extension/);
		const copy = path.join(root, "copy", "subagents");
		fs.mkdirSync(copy, { recursive: true });
		fs.writeFileSync(path.join(copy, "index.ts"), "export default () => {};\n");
		await assert.rejects(h.call("agent_spawn", { prompt: "x", extensions: [copy] }), /Refusing to load the subagents extension/);
	} finally {
		await h.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("sandbox Off (§chat.sandbox/states): a worktree's workers start unconfined only when the sandbox says workers off; agent_list names each worker's confinement", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-off-")));
	const wt = path.join(root, "wt-a");
	fs.mkdirSync(wt, { recursive: true });
	const h = teamHarness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	h.ctx.sessionManager.getBranch = () => worktreesBranch([{ path: wt }]);
	const writeOnly = workerLaunchOf((r: string) => ({ sandbox: "on", "sandbox-parent": JSON.stringify({ version: 1, writeOnly: true, writable: [r] }) }));
	try {
		// Off: the sandbox answers none for every worker, and says workers off.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workers: "off", workerLaunch: () => ({ kind: "none" }) });
		await h.call("agent_spawn", { prompt: "pi off", cwd: wt });
		assert.deepEqual(h.workers.at(-1).extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION], "no sandbox extension, no flags");
		assert.equal(h.workers.at(-1).flags, undefined);
		await h.call("agent_spawn", { prompt: "claude off", cwd: wt, backend: "claude-code" });
		assert.deepEqual(h.workers.at(-1).flags, { [CLAUDE_CODE_PROVIDER_FLAG]: true }, "a Claude Code worker is not confined either");
		// Fail closed: the same none without workers off (an older sandbox) still refuses, of either backend.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch: () => ({ kind: "none" }) });
		for (const backend of [undefined, "claude-code"])
			await assert.rejects(h.call("agent_spawn", { prompt: "x", cwd: wt, backend }), /Cannot confine a worker to the worktree .*: this session's sandbox gave no scope for it/);
		// An on parent never takes none, whatever its event says about workers.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workers: "off", workerLaunch: () => ({ kind: "none" }) });
		await assert.rejects(h.call("agent_spawn", { prompt: "x", cwd: wt }), /Cannot confine a worker to the worktree/);
		// Subagents only: write-only again.
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch: writeOnly });
		await h.call("agent_spawn", { prompt: "pi sub", cwd: wt });
		await h.call("agent_spawn", { prompt: "pi here" });
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_ON, workerLaunch: writeOnly });
		await h.call("agent_spawn", { prompt: "pi on", cwd: wt });
		await h.call("agent_spawn", { prompt: "pi on here" });
		const list = (await h.call("agent_list", {})).content[0].text as string;
		const lineOf = (id: string) => list.split("\n").find((l) => l.includes(` ${id} `)) ?? "";
		const ids = h.workers.map((w: any) => w.id ?? w.options?.id).filter(Boolean);
		assert.equal(ids.length, 6, `pi workers (a claude-code one included): ${ids.join(",")}`);
		assert.match(lineOf(ids[0]), /· sandbox: none(\s|$|·)/, "pi off");
		assert.match(lineOf(ids[1]), /· sandbox: none(\s|$|·)/, "claude-code off");
		assert.match(list, new RegExp(`sandbox: write-only to ${wt.replace(/[/.]/g, "\\$&")}`), "pi sub");
		assert.match(list, new RegExp(`sandbox: on, narrowed to ${wt.replace(/[/.]/g, "\\$&")}`), "pi on");
		assert.match(lineOf(ids.at(-1)), /· sandbox: on(\s|$|·)/, "pi on here");
	} finally {
		await h.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("worktrees: useWorktreeConfig runs a pi worker on <worktree>/.agent with its mode, the parent's session dir and trust; recorded for resume", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wtconfig-")));
	const parentAgent = path.join(root, "parent-agent");
	const wt = path.join(root, "wt");
	const mode = path.join(wt, "pi-config", "extensions", "mode");
	fs.mkdirSync(mode, { recursive: true });
	fs.writeFileSync(path.join(mode, "index.ts"), "export default () => {};\n");
	fs.mkdirSync(path.join(wt, ".agent", "extensions"), { recursive: true });
	fs.symlinkSync(mode, path.join(wt, ".agent", "extensions", "mode"));
	fs.mkdirSync(path.join(root, "plain"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = parentAgent;
	const h = harness();
	h.ctx.sessionManager.getBranch = () => worktreesBranch([{ path: wt }, { path: path.join(root, "plain") }]);
	try {
		h.bus.emit(SANDBOX_STATE_EVENT, { ...SANDBOX_OFF, workerLaunch: workerLaunchOf() });
		// The parent's worker modes are on: the tree's own mode extension gives this worker spec instead.
		h.bus.emit(MODE_WORKER_EVENT, SPEC_ON);
		await h.call("agent_spawn", { prompt: "trial", cwd: wt, useWorktreeConfig: true, systemPrompt: "BRIEF" });
		const w = h.workers[0];
		assert.equal(w.systemPrompt, "BRIEF", "no parent block on top of the tree's own");
		assert.deepEqual(w.env, { PI_CODING_AGENT_DIR: path.join(wt, ".agent") });
		assert.equal(w.sessionDir, path.join(parentAgent, "sessions", `--${wt.slice(1).replace(/\//g, "-")}--`));
		assert.ok(fs.existsSync(w.sessionDir));
		assert.equal(w.approve, undefined, "a worker trusts its project's files as every chat does: nothing to pass");
		assert.deepEqual(w.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, mode, SANDBOX_DIR], "the tree's mode by its real path; never its subagents");
		assert.deepEqual(w.flags, { major: "normal", minor: "spec", sandbox: "on", "sandbox-parent": wt });
		const record = h.appended.find((e) => e.customType === "subagents-worker-manifest" && e.data.launch);
		assert.equal(record.data.launch.useWorktreeConfig, true);
		assert.deepEqual(record.data.modes, ["spec"], "recorded as given spec: its flags start it with spec on");
		// Refused: not a pi worker, no tracked worktree, no .agent.
		await assert.rejects(h.call("agent_spawn", { prompt: "x", useWorktreeConfig: true }), /needs a cwd inside an active worktree/);
		await assert.rejects(h.call("agent_spawn", { prompt: "x", cwd: path.join(root, "plain"), useWorktreeConfig: true }), /has no \.agent directory/);
		// Beside agents it is a shared setting, applied to each agent (and so checked like one).
		await assert.rejects(h.call("agent_spawn", { agents: [{ prompt: "x" }], useWorktreeConfig: true }), /useWorktreeConfig needs a cwd inside an active worktree/);
	} finally {
		await h.close();
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const STATE_SPEC_ON = { version: 1, mode: "normal", strict: false, minorModes: ["spec"] };
const STATE_SPEC_OFF = { version: 1, mode: "normal", strict: false, minorModes: [] };

test("spec on: every code-writing worker (pi, claude-code, team member) gets the worker spec brief and the census hook; no worker gets a spec ledger", async () => {
	const bus = eventBus();
	let asked = 0;
	bus.on(MODE_DISCOVER_EVENT, (data: any) => { if (data?.version === 1) asked++; });
	const h = harness(bus);
	const brief = workerSpecBrief(SPEC_CORE_DIR);
	try {
		assert.equal(asked, 1, "the mode state is asked for at load");
		await h.call("agent_spawn", { prompt: "pi task" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code" });
		for (const w of h.workers) {
			assert.equal(w.systemPrompt, undefined, "spec off: no brief");
			assert.ok(!w.extensions.includes(SPEC_WORKER_EXTENSION), "spec off: no census hook");
		}

		h.bus.emit(MODE_STATE_EVENT, STATE_SPEC_ON);
		await h.call("agent_spawn", { prompt: "pi task", systemPrompt: "Be terse." });
		assert.equal(h.workers[2].systemPrompt, `Be terse.\n\n${brief}`);
		// pi workers run with --no-extensions: the census hook comes in by -e, a sibling of subagents/.
		assert.deepEqual(h.workers[2].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SPEC_WORKER_EXTENSION]);
		assert.equal(SPEC_WORKER_EXTENSION, fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mode", "spec-worker.ts")));
		assert.equal(h.workers[2].env?.[LEDGER_ENV], undefined, "no spec ledger");
		await h.call("agent_spawn", { prompt: "reader", tools: ["read", "grep"] });
		assert.equal(h.workers[3].systemPrompt, undefined, "a worker that cannot write gets no brief");
		assert.deepEqual(h.workers[3].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION], "nor the census hook");
		// A claude-code worker is a pi worker: the same brief and census hook, its landed file named in its env.
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", systemPrompt: "Own words." });
		const claude = h.workers[4];
		assert.equal(claude.systemPrompt, `Own words.\n\n${brief}`);
		assert.deepEqual(claude.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SPEC_WORKER_EXTENSION, CLAUDE_CODE_EXTENSION]);
		assert.equal(claude.settingsJson, undefined, "no Claude Code hooks");
		assert.ok(Object.values(claude.env ?? {}).some((v) => typeof v === "string" && v.includes(path.join(SPEC_HOOK_STATE, "landed"))), "its landed file is named in its env");
		assert.equal(claude.env?.[LEDGER_ENV], undefined);
		await h.call("agent_spawn", { prompt: "claude reader", backend: "claude-code", tools: ["Read"] });
		assert.equal(h.workers[5].systemPrompt, undefined, "a read-only claude worker gets no brief");
		assert.ok(!h.workers[5].extensions.includes(SPEC_WORKER_EXTENSION));

		await h.call("team_create", { name: "T", objective: "o", members: [
			{ role: "a", prompt: "p", backend: "claude-code", model: "claude-sonnet-5-5" },
			{ role: "b", prompt: "p", backend: "pi" },
		] });
		const [a, b] = h.workers.slice(-2);
		assert.ok(a.systemPrompt.endsWith(brief), "a claude member");
		assert.deepEqual(a.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SPEC_WORKER_EXTENSION, MEMBER_EXTENSION, CLAUDE_CODE_EXTENSION]);
		assert.ok(b.systemPrompt.endsWith(brief), "a pi member");
		assert.deepEqual(b.extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SPEC_WORKER_EXTENSION, MEMBER_EXTENSION], "a pi member gets the census hook too");
		assert.equal(b.env?.[LEDGER_ENV], undefined, "and no ledger beside its member identity");
		assert.ok(Object.keys(b.env).length > 1);

		h.bus.emit(MODE_STATE_EVENT, { ...STATE_SPEC_ON, version: 2 });
		h.bus.emit(MODE_STATE_EVENT, STATE_SPEC_OFF);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.equal(h.workers.at(-1).systemPrompt, undefined, "spec switched off: no brief again");
		assert.ok(!h.workers.at(-1).extensions.includes(SPEC_WORKER_EXTENSION), "nor the census hook");
	} finally { await h.close(); }
});
// ── The parent's worker modes (§chat.mode-menu/workers) ─────────────────────

const WORKER_BLOCK = "# Minor mode: spec (worker form, test)";
const SPEC_ON: ModeWorkerEvent = { version: 1, minorModes: ["spec"], prompt: WORKER_BLOCK };
const SPEC_OFF: ModeWorkerEvent = { version: 1, minorModes: [] };
const manifestOf = (h: { appended: any[] }, id: string) => h.appended.filter((e) => e.customType === "subagents-worker-manifest" && e.data.workerId === id).map((e) => e.data);

test("mode: pi and another backend's workers get the parent's worker prompt last, as a snapshot; the launch keeps the raw brief; modes are recorded and published", async () => {
	const h = harness();
	const created: any[] = [];
	h.bus.emit(BACKEND_REGISTER_EVENT, fakeBackend(created));
	const snapshots: any[] = [];
	h.bus.on("subagents:workers-snapshot", (d) => snapshots.push(d));
	try {
		// No mode extension: exactly as before.
		await h.call("agent_spawn", { prompt: "pi task", systemPrompt: "BRIEF" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli", systemPrompt: "BRIEF" });
		assert.equal(h.workers[0].systemPrompt, "BRIEF");
		assert.equal(created[0].systemPrompt, "BRIEF");
		assert.deepEqual(manifestOf(h, "ag_01")[0].modes, [], "given none: recorded as none");

		h.bus.emit(MODE_WORKER_EVENT, SPEC_ON);
		await h.call("agent_spawn", { prompt: "pi task", systemPrompt: "BRIEF" });
		await h.call("agent_spawn", { prompt: "pi task, no brief" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli", systemPrompt: "BRIEF" });
		assert.equal(h.workers[1].systemPrompt, `BRIEF\n\n${WORKER_BLOCK}`, "after the brief");
		assert.equal(h.workers[2].systemPrompt, WORKER_BLOCK);
		assert.equal(created[1].systemPrompt, `BRIEF\n\n${WORKER_BLOCK}`, "another backend: in the prepared prompt the runner uses");
		const record = manifestOf(h, "ag_03")[0];
		assert.equal(record.launch.systemPrompt, "BRIEF", "the launch keeps the raw brief: a resume takes the modes afresh");
		assert.deepEqual(record.modes, ["spec"]);
		assert.deepEqual(manifestOf(h, "ag_05")[0].modes, ["spec"]);
		const published = snapshots.at(-1).workers;
		assert.deepEqual(published.find((w: any) => w.id === "ag_03").modes, ["spec"]);
		assert.deepEqual(published.find((w: any) => w.id === "ag_05").modes, ["spec"]);
		assert.ok(!("modes" in published.find((w: any) => w.id === "ag_01")), "given none: no field");

		// Malformed or other-version announcements are ignored; the last valid one stands.
		h.bus.emit(MODE_WORKER_EVENT, { version: 2, minorModes: [] });
		h.bus.emit(MODE_WORKER_EVENT, { version: 1, minorModes: [7], prompt: "x" });
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.equal(h.workers[3].systemPrompt, WORKER_BLOCK);

		// Spec off: new workers get nothing; running ones keep what they started with.
		h.bus.emit(MODE_WORKER_EVENT, SPEC_OFF);
		await h.call("agent_spawn", { prompt: "pi task", systemPrompt: "BRIEF" });
		await h.call("agent_spawn", { prompt: "claude task", backend: "native-cli", systemPrompt: "BRIEF" });
		assert.equal(h.workers[4].systemPrompt, "BRIEF");
		assert.equal(created[2].systemPrompt, "BRIEF");
		assert.equal(h.workers[1].systemPrompt, `BRIEF\n\n${WORKER_BLOCK}`, "a switch never reaches a running worker");
		assert.deepEqual(manifestOf(h, "ag_07")[0].modes, []);
	} finally { await h.close(); }
});

test("mode: the worker modes are asked for at load; a remote claude-code worker gets its brief, then the block", async () => {
	const bus = eventBus();
	let asked = 0;
	bus.on(MODE_WORKER_DISCOVER_EVENT, (d: any) => { if (d?.version === 1) { asked++; bus.emit(MODE_WORKER_EVENT, SPEC_ON); } });
	const h = harness(bus);
	try {
		assert.equal(asked, 1);
		await h.call("agent_spawn", { prompt: "pi task" });
		assert.equal(h.workers[0].systemPrompt, WORKER_BLOCK, "a mode extension loaded first is learned by discovery");
	} finally { await h.close(); }

	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-remote-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const r = remoteHarness(agentDir, true);
	try {
		r.bus.emit(MODE_WORKER_EVENT, SPEC_ON);
		await r.call("agent_spawn", { prompt: "claude task", backend: "claude-code", systemPrompt: "be terse" });
		assert.equal(r.workers[0].systemPrompt, `be terse\n\n${WORKER_BLOCK}`, "brief → block; the remote extension tells it the rest");
		assert.ok(r.workers[0].extensions.includes(REMOTE_EXTENSION));
		await r.call("agent_spawn", { prompt: "pi task", systemPrompt: "be terse" });
		assert.equal(r.workers[1].systemPrompt, `be terse\n\n${WORKER_BLOCK}`);
	} finally {
		await r.close();
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("mode: team members get the block on both backends, the coordinator too; the monitor (no tools) gets none", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		h.bus.emit(MODE_WORKER_EVENT, SPEC_ON);
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "writer", prompt: "docs", backend: "claude-code", model: "claude-sonnet-5-5" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), writer = h.worker("ag_03"), monitor = h.worker("ag_04");
		for (const [name, w] of [["coordinator", coordinator], ["dev", dev], ["writer", writer]] as const)
			assert.ok(w.systemPrompt.endsWith(WORKER_BLOCK), `${name} ends with the block`);
		assert.ok(!(monitor.systemPrompt ?? "").includes(WORKER_BLOCK), "the monitor gets none");
		assert.deepEqual(manifestOf(h, "ag_04")[0].modes, []);
		assert.deepEqual(manifestOf(h, "ag_02")[0].modes, ["spec"]);
	} finally { await h.cleanup(); }
});

test("worker marker: says it is a worker at load and to anyone who asks later (a tree's mode extension loads after it)", () => {
	const bus = eventBus();
	const heard: unknown[] = [];
	bus.on(WORKER_ROLE_EVENT, (d) => heard.push(d));
	workerMarkExtension({ events: bus, on() {} } as any);
	assert.deepEqual(heard, [{ version: 1 }], "announced at load");
	bus.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 1 });
	assert.deepEqual(heard, [{ version: 1 }, { version: 1 }], "answered when asked");
	bus.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 2 });
	assert.equal(heard.length, 2, "an unknown question version is ignored");
	assert.doesNotThrow(() => workerMarkExtension({ on() {} } as any), "no bus: inert");
});

test("spec on with the parent's worker modes (mode:worker) too: the spec block comes once, from the mode prompt; the census hook stays", async () => {
	const h = harness();
	const brief = workerSpecBrief(SPEC_CORE_DIR);
	try {
		h.bus.emit(MODE_STATE_EVENT, STATE_SPEC_ON);
		h.bus.emit(MODE_WORKER_EVENT, SPEC_ON);
		await h.call("agent_spawn", { prompt: "pi task", systemPrompt: "Be terse." });
		assert.equal(h.workers[0].systemPrompt, `Be terse.\n\n${WORKER_BLOCK}`, "the mode prompt, no brief on top");
		assert.deepEqual(h.workers[0].extensions, [MARKER_EXTENSION, PROVIDER_LIMITS_EXTENSION, MODEL_LEVELS_EXTENSION, SPEC_WORKER_EXTENSION]);
		await h.call("agent_spawn", { prompt: "claude task", backend: "claude-code", systemPrompt: "Own words." });
		assert.equal(h.workers[1].systemPrompt, `Own words.\n\n${WORKER_BLOCK}`);
		assert.ok(!h.workers[1].systemPrompt.includes(brief));
		assert.ok(h.workers[1].extensions.includes(SPEC_WORKER_EXTENSION), "the census hook still comes");
	} finally { await h.close(); }
});

test("mode: a worker with bash gets the parent's project mode tools (the -e hook and the copies file); a read-only worker gets the block only", async () => {
	const { PROJECT_TOOLS_FILE_ENV, readWorkerToolsFile } = await import("../mode/project-tools.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-project-tools-"));
	const h = harness(eventBus(), { agentDir });
	const copy = (id: string, tools: unknown[]) => ({ v: 1, id, dir: `/repo/.sova/minor-modes/${id}`, description: "d", workers: true, tools, text: `# Project minor mode: ${id}`, sha: "a".repeat(64), toolsHash: tools.length ? "b".repeat(64) : "" });
	const tool = { name: "status", description: "s", params: { type: "object", properties: {} }, command: ["./bin/status"], timeoutS: 60 };
	try {
		h.bus.emit(MODE_WORKER_EVENT, { version: 1, minorModes: [], prompt: "# Project minor mode: release-check", projectModes: [copy("release-check", [tool]), copy("notes", [])] });
		await h.call("agent_spawn", { prompt: "pi task", tools: ["read", "bash"] });
		const w = h.workers.at(-1);
		assert.ok(w.extensions.includes(PROJECT_TOOLS_WORKER_EXTENSION));
		assert.equal(PROJECT_TOOLS_WORKER_EXTENSION, fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mode", "project-tools-worker.ts")));
		const file = w.env[PROJECT_TOOLS_FILE_ENV];
		assert.ok(file.startsWith(path.join(agentDir, "sova", "project-tools")));
		assert.deepEqual(readWorkerToolsFile(file).map((c: { id: string }) => c.id), ["release-check"], "only copies with tools");
		await h.call("agent_spawn", { prompt: "read-only task", tools: ["read", "grep"] });
		const ro = h.workers.at(-1);
		assert.ok(!ro.extensions.includes(PROJECT_TOOLS_WORKER_EXTENSION), "a read-only worker never gains a program to run");
		assert.equal(ro.env?.[PROJECT_TOOLS_FILE_ENV], undefined);
		assert.ok(ro.systemPrompt.includes("# Project minor mode: release-check"), "it still gets the block");
		h.bus.emit(MODE_WORKER_EVENT, { version: 1, minorModes: [], prompt: "# Project minor mode: notes", projectModes: [copy("notes", [])] });
		await h.call("agent_spawn", { prompt: "pi task", tools: ["read", "bash"] });
		assert.ok(!h.workers.at(-1).extensions.includes(PROJECT_TOOLS_WORKER_EXTENSION), "no tools, no hook");
	} finally {
		await h.close();
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

// ── al_1: limits said up front, lenient reads, refusals in Sova's words ─────────────────────

/** The tool results a real session recorded, in order. */
const toolResults = (s: Awaited<ReturnType<typeof realSession>>) => s.session.sessionManager.getEntries()
	.filter((e: any) => e.type === "message" && e.message.role === "toolResult")
	.map((e: any) => ({ name: e.message.toolName, isError: e.message.isError, text: e.message.content.map((c: any) => c.text ?? "").join("") }));

test("through pi's own argument check: members and agents as JSON strings are read as lists, shared settings beside agents are filled in, and refusals are Sova's own words", async () => {
	const s = await realSession();
	try {
		s.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("team_create", { name: "Text", objective: "o", members: JSON.stringify([{ role: "a", prompt: "pa" }, { role: "b", prompt: "pb" }]) }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("team_create", { name: "Count", objective: "o", members: [{ role: "a", prompt: "p", count: 2 }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("team_create", { name: "Odd", objective: "o", members: [{ role: "a", prompt: "p", colour: "red" }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("team_create", { name: "Defaults", objective: "o", defaults: { tools: ["read"] }, members: [{ role: "a", prompt: "p" }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("team_create", { name: "One", objective: "o", members: { role: "a", prompt: "p" } }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("agent_spawn", { agents: [{ prompt: "x" }, { prompt: "y", effort: "low" }], effort: "low", tools: ["read"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("agent_spawn", { agents: [{ prompt: "x", effort: "high" }, { prompt: "y" }], effort: "low" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("agent_spawn", { agents: JSON.stringify([{ prompt: "z" }]) }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("agent_spawn", { agents: [{}, {}], prompt: "shared" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await s.session.prompt("go");
		await s.session.waitForIdle?.();
		const r = toolResults(s);
		assert.equal(r.length, 9);
		for (const one of r) assert.doesNotMatch(one.text, /schema is false|must be object|must be array/, "never pi's schema words");
		assert.equal(r[0].isError, false, r[0].text);
		assert.match(r[0].text, /^Created team_01 \(Text\) with 2 member\(s\)/);
		assert.equal(r[1].isError, true);
		assert.match(r[1].text, /^members\[0\] \(a\): count is not a member setting; a member is one role\. Add one member per role instead/);
		assert.equal(r[2].isError, true);
		assert.match(r[2].text, /^members\[0\] \(a\): unknown setting "colour"\. A member takes role, prompt, ownedPaths, orchestrator, backend, model, effort, tools, systemPrompt, cwd, wake, backendOptions, extensions\.$/);
		assert.equal(r[3].isError, true);
		assert.match(r[3].text, /^Unsupported team default tools; defaults accept backend, model, effort, backendOptions, coordinator and monitor\. Put tools on each member that needs it\.$/);
		assert.equal(r[4].isError, true);
		assert.match(r[4].text, /^members must be a list of member objects, \[\{"role": "\.\.\.", "prompt": "\.\.\."\}, \.\.\.\], even for one member\.$/);
		assert.equal(r[5].isError, false, r[5].text);
		assert.equal(r[6].isError, true);
		assert.match(r[6].text, /^effort is set beside agents and differently in agents\[0\]: set it in one place/);
		assert.equal(r[7].isError, false, r[7].text);
		assert.equal(r[8].isError, false, r[8].text);
		// Team Text (2), the shared-settings pair, the JSON-string agent, the shared-prompt pair; nothing for the refusals.
		assert.equal(s.workers.length, 7);
		assert.deepEqual(s.workers.slice(2, 4).map((w: any) => [w.task, w.effort, w.tools]), [["x", "low", ["read"]], ["y", "low", ["read"]]]);
		assert.equal(s.workers[4].task, "z");
		assert.deepEqual(s.workers.slice(5).map((w: any) => w.task), ["shared", "shared"]);
	} finally { await s.close(); }
});

test("lenient reads stay intent-preserving: every conflict and every missing role, task, name or objective is refused before anything starts", async () => {
	const h = harness();
	try {
		const refusals: [string, any, RegExp][] = [
			["agent_spawn", { agents: [{ prompt: "x", extensions: ["./a.ts"] }, { prompt: "y" }], extensions: ["./b.ts"] }, /^extensions is set beside agents and differently in agents\[0\]/],
			["agent_spawn", { agents: [{ prompt: "x", cwd: "a" }, { prompt: "y", cwd: "b" }], cwd: "c" }, /^cwd is set beside agents and differently in agents\[0\], agents\[1\]: set it in one place, or give those agents the same value\.$/],
			["agent_spawn", { agents: [{}, { prompt: "own" }], prompt: "shared" }, /^A prompt beside agents is used only when no agent has its own, and agents\[1\] has one: put each task inside its agent\.$/],
			["agent_spawn", { agents: [{ prompt: "x" }, {}] }, /^agents\[1\] has no prompt/],
			["agent_spawn", { agents: [{ prompt: "x" }], count: 2 }, /^count cannot sit beside agents: put it inside each agent that needs it\.$/],
			["agent_spawn", { agents: [{ prompt: "x" }], name: "n", fork: true }, /^name, fork cannot sit beside agents/],
			["agent_spawn", { agents: "not json" }, /^agents must be a list of agent objects/],
			["agent_spawn", { agents: "[1, 2]" }, /^agents must be a list of agent objects/],
			["agent_spawn", { agents: [{ prompt: "x", role: "r" }] }, /^agents\[0\]: unknown setting "role"/],
			["agent_spawn", { prompt: "x", members: [] }, /^Unknown setting "members"/],
			["team_create", { name: "T", objective: "o", members: "a, b" }, /^members must be a list of member objects/],
			["team_create", { name: "T", objective: "o", members: "{\"role\": \"a\", \"prompt\": \"p\"}" }, /^members must be a list of member objects/],
			["team_create", { name: "T", objective: "o", members: [{ prompt: "p" }] }, /^members\[0\] has no role: every member needs a unique role, which Sova never makes up\.$/],
			["team_create", { name: "T", objective: "o", members: [{ role: "a" }] }, /^members\[0\] \(a\) has no prompt/],
			["team_create", { name: "T", members: [{ role: "a", prompt: "p" }] }, /^Missing objective: give it explicitly; Sova never makes it up\.$/],
			["team_create", { objective: "o", members: [{ role: "a", prompt: "p" }] }, /^Missing name/],
			["team_create", { name: "T", objective: "o", members: [{ role: "a", prompt: "p", fork: true }] }, /^members\[0\] \(a\): fork is for agent_spawn only/],
			["team_create", { name: "T", objective: "o", members: [{ role: "a", prompt: "p", agentType: "x" }] }, /^members\[0\] \(a\): agentType is for agent_spawn only/],
			["team_create", { name: "T", objective: "o", model: "test/model", members: [{ role: "a", prompt: "p" }] }, /^model is a member setting: put it inside each member that needs it\.$/],
			["team_create", { name: "T", objective: "o", members: [{ role: "a", prompt: "p", extensions: "npm:x" }] }, /^members\[0\] \(a\): extensions must be a list of extension sources/],
			["team_add", { team: "T", members: "nope" }, /^members must be a list of member objects/],
		];
		for (const [tool, params, expected] of refusals) {
			const prepared = (() => { try { h.tools.get(tool).prepareArguments(params); return undefined; } catch (error) { return (error as Error).message; } })();
			assert.ok(prepared, `${tool} ${JSON.stringify(params)} is refused before pi's schema check`);
			assert.match(prepared!, expected);
			await assert.rejects(h.call(tool, params), (err: Error) => expected.test(err.message), `${tool} ${JSON.stringify(params)}`);
		}
		assert.equal(h.workers.length, 0, "nothing started");
		// The same value beside and inside is no conflict; a list given as text changes nothing else.
		await h.call("agent_spawn", { agents: [{ prompt: "x", effort: "low" }, { prompt: "y" }], effort: "low", wake: false });
		assert.deepEqual(h.workers.map((w) => [w.task, w.effort, w.wake]), [["x", "low", false], ["y", "low", false]]);
		const team = await h.call("team_create", { name: "Text", objective: "o", members: JSON.stringify([{ role: "a", prompt: "pa", ownedPaths: ["src"] }]) });
		assert.equal(team.details.members.length, 1);
		assert.match(team.content[0].text, /ag_03 {2}a {2}running .*owns=src/);
	} finally { await h.close(); }
});

test("running limit: 24 per chat, idle workers included; the refusal names the need per caller, the live count, the idle workers and how many to stop", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("agent_spawn", { prompt: "x", count: 20 });
		h.worker("ag_01").settle();
		h.worker("ag_02").settle();
		const tail = "Stop 1 with agent_kill first, then retry. Idle (waiting) workers you could stop: ag_01 (agent-1), ag_02 (agent-2). Sova stops nothing itself.";
		await assert.rejects(h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "a", prompt: "p" }, { role: "b", prompt: "p" }, { role: "c", prompt: "p" }] }), (err: Error) => {
			assert.equal(err.message, `This team needs 5 workers running: the 3 members you named + the coordinator "coordinator" and monitor "monitor" Sova adds from this chat's team defaults. A chat runs at most 24 workers at once (idle ones, and a team's coordinator and monitor, count); 20 are live now, so 4 more fit. ${tail}`);
			return true;
		});
		await assert.rejects(h.call("agent_spawn", { prompt: "x", count: 5 }), (err: Error) => {
			assert.equal(err.message, `This request starts 5 workers. A chat runs at most 24 workers at once (idle ones count); 20 are live now, so 4 more fit. ${tail}`);
			return true;
		});
		assert.equal(h.workers.length + h.created.length, 20, "nothing started, nothing stopped");
		assert.ok(h.workers.every((w) => w.status !== "killed"), "Sova stops nothing itself");
		// Two named members + coordinator + monitor fit exactly.
		const team = await h.call("team_create", { name: "Crew", objective: "o", members: [{ role: "a", prompt: "p" }, { role: "b", prompt: "p" }] });
		assert.equal(team.details.members.length, 4);
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "c", prompt: "p" }] }), (err: Error) => {
			assert.equal(err.message, `Adding this member needs 1 worker running. A chat runs at most 24 workers at once (idle ones count); 24 are live now, so 0 more fit. ${tail}`);
			assert.doesNotMatch(err.message, /coordinator|monitor/, "team_add never mentions roles it does not add");
			return true;
		});
		// With nobody idle the refusal says so.
		h.worker("ag_01").status = "running";
		h.worker("ag_02").status = "running";
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /This request starts 1 worker\. .*Stop 1 with agent_kill first, then retry\. None is idle: every live worker is busy, so stopping one ends work in progress\. Sova stops nothing itself\.$/);
	} finally { await h.cleanup(); }
});

test("seats: team_create past 24 members, the standing roles included, is refused before anything starts", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await assert.rejects(
			h.call("team_create", { name: "Huge", objective: "o", members: Array.from({ length: 23 }, (_, i) => ({ role: `m${i}`, prompt: "p" })) }),
			/^Error: A team seats 24 members, and this one would have 25: the 23 you named \+ the coordinator "coordinator" and monitor "monitor" Sova adds from this chat's team defaults\. Name at most 22 members/,
		);
		assert.equal(h.workers.length + h.created.length, 0);
		const full = await h.call("team_create", { name: "Full", objective: "o", members: Array.from({ length: 22 }, (_, i) => ({ role: `m${i}`, prompt: "p" })) });
		assert.equal(full.details.members.length, 24);
	} finally { await h.cleanup(); }
});

test("team members take extensions by agent_spawn's rules, beside their team tools", async () => {
	const h = harness();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-member-ext-"));
	try {
		const ext = path.join(dir, "web.ts");
		fs.writeFileSync(ext, "export default () => {};\n");
		const r = await h.call("team_create", { name: "Web", objective: "o", members: [{ role: "researcher", prompt: "p", extensions: [ext] }, { role: "plain", prompt: "p" }] });
		assert.ok(h.workers[0].extensions.includes(MEMBER_EXTENSION), "still its team tools");
		assert.ok(h.workers[0].extensions.includes(ext), "and the extension it was given");
		assert.ok(!h.workers[1].extensions.includes(ext));
		assert.match(r.content[0].text, new RegExp(`ag_01 {2}researcher .*extensions=${esc(ext)}`));
		const self = path.join(path.dirname(new URL(import.meta.url).pathname), "index.ts");
		await assert.rejects(h.call("team_add", { team: "Web", members: [{ role: "nested", prompt: "p", extensions: [self] }] }), /do not nest/);
		await assert.rejects(h.call("team_add", { team: "Web", members: [{ role: "uninstalled", prompt: "p", extensions: ["npm:definitely-not-installed-xyz"] }] }), /isn't installed/);
		assert.equal(h.workers.length, 2);
	} finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the main chat's team_succeed replaces an ended coordinator or monitor, only when none with that duty is live", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), monitor = h.worker("ag_03");
		await assert.rejects(h.call("team_succeed", { team: "Crew", role: "coordinator" }), /^Error: coordinator \(ag_01\) is team_01's live coordinator\. A live coordinator hands over itself with its own team_succeed step \(tell it with agent_steer if it should\), so two coordinators are never live at once\./);
		await assert.rejects(h.call("team_succeed", { team: "Crew", role: "dev" }), /^Error: dev is not team_01's coordinator or monitor: the main chat replaces only those, once none is live\. The coordinator coordinator \(ag_01\) succeeds other members/);
		await assert.rejects(h.call("team_succeed", { team: "Crew", role: "monitor" }), /monitor \(ag_03\) is team_01's live monitor/);
		// A second orchestrator is refused while the coordinator is live, saying how a handover works.
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "p", orchestrator: true }] }), /only the coordinator is a team's orchestrator[\s\S]*A member that only watches or reports needs no orchestrator mark[\s\S]*The coordinator coordinator \(ag_01\) is live, so it hands over itself/);
		coordinator.exit();
		await assert.rejects(h.call("team_add", { team: "Crew", members: [{ role: "boss", prompt: "p", orchestrator: true }] }), /No coordinator is live now: the main chat can start a replacement with team_succeed \{ team: "team_01", role: "coordinator" \}\.$/);
		const r = await h.call("team_succeed", { team: "team_01", role: "coordinator" });
		assert.match(r.content[0].text, /^Started coordinator-2 \(ag_04\) to succeed coordinator \(ag_01\) on pi\/claude-code-cli\/claude-opus-5-5\/medium\. coordinator has already ended; the successor works from the handover note\. The note may be missing \(coordinator had already ended without writing it\); the successor was told so\. It routes team_01 from now on: members report to it, and only it reaches you\.$/);
		const successor = h.worker("ag_04");
		assert.deepEqual([h.memberOf("ag_04")!.duty, h.memberOf("ag_04")!.successorOf, h.memberOf("ag_04")!.orchestrator], ["coordinator", "coordinator", true]);
		assert.match(successor.task, /coordinator has already ended: there is nobody to ask and no team_ready to call/);
		assert.match(successor.task, /Its assignment from the main thread:\nCoordinate this team toward the objective/);
		const events = h.appended.filter((e) => e.customType === "subagents-team-v1").map((e) => e.data.op);
		assert.deepEqual(events, ["create", "add", "eject"], "the ended coordinator's seat is released");
		assert.equal(r.details.successorId, "ag_04");
		// Exactly one live coordinator: the replaced one is ejected, the new one is live.
		await assert.rejects(h.call("team_succeed", { team: "Crew", role: "coordinator" }), /coordinator \(ag_01\) was ejected from team_01/);
		await assert.rejects(h.call("team_succeed", { team: "Crew", role: "coordinator-2" }), /coordinator-2 \(ag_04\) is team_01's live coordinator/);
		// Members now report to the new coordinator.
		const dev = h.worker("ag_02");
		dev.output = "built";
		dev.settle();
		await h.tick();
		await assertItem(h, "ag_04", "report", /^\[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\]/);
		// The monitor: replaced once it has ended, told nobody is left to ask.
		monitor.exit();
		const m = await h.call("team_succeed", { team: "Crew", role: "ag_03" });
		assert.match(m.content[0].text, /^Started monitor-2 \(ag_05\) to succeed monitor \(ag_03\)/);
		assert.match(h.worker("ag_05").task, /You take over from the monitor monitor \(ag_03\), which has already ended: there is nobody to ask and no team_ready to call\. Run your standing instruction now/);
		assert.equal(h.memberOf("ag_05")!.duty, "monitor");
	} finally { await h.cleanup(); }
});

test("every limit is said up front: team_create, team_add and agent_spawn descriptions and the /team planning text", async () => {
	const h = harness();
	try {
		for (const name of ["team_create", "team_add"]) {
			const d = h.tools.get(name).description as string;
			assert.match(d, /no per-request limit/, name);
			assert.match(d, /A team seats 24 members, the coordinator and monitor Sova adds included/, name);
			assert.match(d, /This chat runs at most 24 workers at once, idle ones and every team member \(coordinator and monitor included\) counted/, name);
			assert.match(d, /members must be a list of member objects/, name);
			assert.match(d, /count, fork and agentType are refused/, name);
			assert.match(d, /Only the coordinator hands a member over to a successor \(its team_succeed\); once no coordinator is live, the main chat can start a replacement with team_succeed\./, name);
		}
		const spawn = h.tools.get("agent_spawn");
		assert.match(spawn.description, /Limits: no per-request limit; this chat runs at most 24 workers at once, idle ones and team members/);
		assert.match(spawn.description, /name, count, fork and agentType go inside each agent/);
		assert.doesNotMatch(JSON.stringify(spawn.parameters), /maxItems|"maximum"/, "no per-request cap in the schema");
		assert.doesNotMatch(JSON.stringify(h.tools.get("team_create").parameters), /maxItems":8|"maximum":8/);
		assert.equal(typeof h.tools.get("team_succeed").execute, "function", "the main chat's replacement tool");
		await h.commands.get("team").handler("Ship the thing", h.ctx);
		const plan = h.messages.at(-1)[0].content as string;
		assert.match(plan, /Limits: no per-request limit\. A team seats 24 members/);
		assert.match(plan, /at most 24 workers at once/);
	} finally { await h.close(); }
});

test("the declared schema lets members and agents be a list or a string (as a host that checks it, the Claude Code CLI, sees it), so readList judges the string", () => {
	const h = harness();
	const list = JSON.stringify([{ role: "a", prompt: "p" }]);
	const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
		["team_create", { name: "T", objective: "o", members: list }, { name: "T", objective: "o", members: [{ role: "a" }] }],
		["team_add", { team: "T", members: list }, { team: "T", members: [{ role: "a" }] }],
		["agent_spawn", { agents: JSON.stringify([{ prompt: "x" }]) }, { agents: [{ name: "x" }] }],
	];
	for (const [name, ok, bad] of cases) {
		const tool = h.tools.get(name);
		// The schema as declared to a model or an MCP host: JSON, typebox's symbols gone.
		for (const parameters of [tool.parameters, JSON.parse(JSON.stringify(tool.parameters))]) {
			const asTool = { name, description: "", parameters };
			assert.doesNotThrow(() => validateToolArguments(asTool as any, { type: "toolCall", id: "1", name, arguments: ok } as any), `${name} accepts a string`);
			assert.throws(() => validateToolArguments(asTool as any, { type: "toolCall", id: "1", name, arguments: bad } as any), `${name} still checks the list form (an item without its prompt)`);
		}
		const key = name === "agent_spawn" ? "agents" : "members";
		const declared = JSON.parse(JSON.stringify(tool.parameters)).properties[key];
		assert.deepEqual(declared.anyOf.map((s: any) => s.type).sort(), ["array", "string"], `${name}.${key} is array | string`);
	}
});

// ── Team inbox (§app.teams/inbox) ─────────────────────────────────────────

test("team_inbox is served by the parent, the inbox's only writer: list, open, done, sent; a mark racing a new delivery keeps the new item", async () => {
	const h = teamHarness();
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "lead", prompt: "coordinate", orchestrator: true }, { role: "dev", prompt: "build" }] });
		const leadDir = h.memberOf("ag_01")!.dir, devDir = h.memberOf("ag_02")!.dir;
		await h.ask("ag_01", { type: "message", to: "dev", subject: "Task 1", message: "Write the parser." });
		await h.ask("ag_01", { type: "message", to: "dev", message: "FYI\nthe schema moved." });
		const list = await h.ask("ag_02", { type: "inbox" });
		assert.equal(list.ok, true);
		assert.match(list.text, /^2 open items:\n- i_1 \[new\] message from lead — Task 1 \(\d\d:\d\d:\d\d\)\n- i_2 \[new\] message from lead — FYI \(\d\d:\d\d:\d\d\)\nteam_inbox open <ids>/);
		const opened = await h.ask("ag_02", { type: "inbox", action: "open", ids: ["i_1"] });
		assert.match(opened.text, /^i_1 message from lead \(ag_01\) · [^\n]+ · read\nSubject: Task 1\nWrite the parser\.$/);
		// The race: dev marks both addressed while lead's next message is being delivered, in the same poll.
		const doneId = requestId(), msgId = requestId();
		writeRequest(devDir, { version: 1, id: doneId, at: Date.now(), type: "inbox", action: "done", ids: ["i_1", "i_2"], note: "handled" });
		writeRequest(leadDir, { version: 1, id: msgId, at: Date.now(), type: "message", to: "dev", message: "A new task" });
		const [done, sent] = await Promise.all([awaitResponse(devDir, doneId, 3000, undefined, 5), awaitResponse(leadDir, msgId, 3000, undefined, 5)]);
		assert.equal(done!.text, "Marked addressed: i_1, i_2 (note: handled).");
		assert.equal(sent!.text, "Queued for dev (ag_02): item i_3");
		assert.deepEqual(readMemberItems(devDir).map((i) => [i.id, i.status, i.note ?? ""]), [["i_1", "addressed", "handled"], ["i_2", "addressed", "handled"], ["i_3", "new", ""]], "the new item is kept");
		// The sender looks up status and note; it is never woken for it.
		const steersBefore = h.workers[0].steerCount;
		const lookup = await h.ask("ag_01", { type: "inbox", action: "sent" });
		assert.match(lookup.text, /^Items you sent \(newest last\):\ni_1 → dev \(ag_02\) \[addressed\] message: Task 1 · note: handled\ni_2 → dev \(ag_02\) \[addressed\] message: FYI · note: handled\ni_3 → dev \(ag_02\) \[new\] message: A new task$/);
		await pause(50);
		assert.equal(h.workers[0].steerCount, steersBefore);
		// Marks only what the member holds.
		const bad = await h.ask("ag_02", { type: "inbox", action: "done", ids: ["i_9"] });
		assert.equal(bad.ok, false);
		assert.match(bad.text, /No item i_9/);
		assert.equal((await h.ask("ag_01", { type: "inbox", action: "done", ids: ["i_3"] })).ok, false, "lead cannot mark dev's item");
		// The roster carries each member's open count; over 50, the queued answer says so.
		assert.match((await h.ask("ag_01", { type: "roster" })).text, /ag_02 dev \[pi, has team tools\] working \(running\) · context — · 1 open item · owns/);
		let last = "";
		for (let i = 0; i < 50; i++) last = (await h.ask("ag_01", { type: "message", to: "dev", message: `m${i}` })).text;
		assert.match(last, /^Queued for dev \(ag_02\): item i_\w+ · dev has 51 open items$/);
		assert.match((await h.call("team_list")).content[0].text, /ag_02 dev \[pi\] working \(running\) · context — · 51 open items/);
	} finally { await h.cleanup(); }
});

test("a question moved to a successor keeps its id and sender; the successor's reply marks it addressed in the asker's lookup; a message to the replaced member is forwarded", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const coordinator = h.worker("ag_01");
		const asked = await h.ask("ag_02", { type: "question", message: "Which schema?" });
		const qid = /item (i_\w+)/.exec(asked.text)![1];
		// The coordinator hands over to coordinator-2 (ag_05).
		await h.ask("ag_01", { type: "succeed", to: "coordinator" });
		h.writeNote("coordinator");
		await h.tick();
		const next = h.worker("ag_05");
		assert.equal(next?.name, "coordinator-2");
		const own = await h.ask("ag_03", { type: "message", to: "coordinator-2", message: "hello successor" });
		const ownId = /item (i_\w+)/.exec(own.text)![1];
		// Its turn ends and lists the question (a new turn); team_ready then retires it when that turn ends.
		coordinator.settle();
		await waitFor(() => readMemberItems(h.memberOf("ag_01")!.dir).find((i) => i.id === qid)?.listedAt, "the question listed to the old coordinator");
		assert.match((await h.ask("ag_05", { type: "ready" })).text, /still in a turn/);
		coordinator.settle();
		await h.tick();
		const nextDir = h.memberOf("ag_05")!.dir;
		await waitFor(() => readMemberItems(nextDir).some((i) => i.id === qid), "the open question moved to the successor");
		const moved = readMemberItems(nextDir).find((i) => i.id === qid)!;
		assert.deepEqual([moved.kind, moved.from.workerId, moved.to.workerId, moved.movedFrom?.[0].workerId, moved.movedFrom?.[0].why], ["question", "ag_02", "ag_05", "ag_01", "handover"]);
		assert.ok(!readMemberItems(h.memberOf("ag_01")!.dir).some((i) => i.id === qid), "it left the old inbox");
		const ownBefore = readMemberItems(nextDir).find((i) => i.id === ownId)!;
		// coordinator-2 answers with replyTo: the question is addressed, and the asker's lookup follows the move.
		const answer = await h.ask("ag_05", { type: "message", to: "dev", message: "Use v2.", replyTo: qid });
		assert.equal(answer.ok, true, answer.text);
		const lookup = await h.ask("ag_02", { type: "inbox", action: "sent" });
		assert.match(lookup.text, new RegExp(`${qid} → coordinator-2 \\(ag_05\\) \\[addressed\\] question: Which schema\\? · note: answered in i_\\w+`));
		assert.deepEqual(readMemberItems(nextDir).find((i) => i.id === ownId), ownBefore, "its other items are unchanged");
		// A message to the retired coordinator now reaches its successor, and the sender is told.
		await waitFor(() => coordinator.status === "killed", "the old coordinator retired");
		const fwd = await h.ask("ag_03", { type: "message", to: "coordinator", message: "status?" });
		assert.equal(fwd.ok, true, fwd.text);
		assert.match(fwd.text, /^Queued for coordinator-2 \(ag_05\): item (i_\w+) — coordinator \(ag_01\) was replaced: forwarded to coordinator-2 \(ag_05\)$/);
		const fid = /item (i_\w+)/.exec(fwd.text)![1];
		assert.deepEqual(readMemberItems(nextDir).find((i) => i.id === fid)?.movedFrom?.map((m) => [m.workerId, m.why]), [["ag_01", "forward"]], "it records whom it was first sent to");
		// The successor cannot reach itself through its predecessor.
		assert.match((await h.ask("ag_05", { type: "message", to: "coordinator", message: "x" })).text, /was succeeded by you/);
	} finally { await h.cleanup(); }
});

/** Hold a fake worker's next steer until the returned release is called (a delivery in progress). */
function holdNextSteer(w: any): () => void {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const orig = w.steer;
	let first = true;
	w.steer = async function (this: any, ...args: any[]) {
		if (first) {
			first = false;
			await gate;
			w.steer = orig;
		}
		return orig.apply(this, args);
	};
	return release;
}

test("inbox lifecycle: every Sova notice and handover instruction gets through while the recipient's first steer is still held (R2-R8)", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const coordinator = h.worker("ag_01"), dev = h.worker("ag_02"), monitor = h.worker("ag_04");
		const itemsOf = (id: string) => readMemberItems(h.memberOf(id)!.dir);
		// The main chat's steer to the idle coordinator is in progress (held).
		coordinator.status = "waiting";
		const releaseCoordinator = holdNextSteer(coordinator);
		const steering = h.call("agent_steer", { id: "ag_01", message: "Status?" });
		await pause(20);
		// R2: a completion while it is held is stored at once as a report item.
		dev.output = "built it";
		dev.settle();
		await waitFor(() => itemsOf("ag_01").some((i) => i.kind === "report"), "the report stored");
		// R8: so is the additions notice; team_add says it was queued, never "could not tell".
		const added = await h.call("team_add", { team: "Crew", members: [{ role: "docs", prompt: "Write docs." }] });
		assert.match(added.content[0].text, /Queued for coordinator coordinator \(ag_01\): item i_\w+, naming the new member\(s\)/);
		assert.doesNotMatch(added.content[0].text, /could not/);
		releaseCoordinator();
		assert.equal((await steering).details?.accepted ?? true, true);
		// The steer took it into a turn; when that turn ends, both items are listed in one wake.
		coordinator.settle();
		await waitFor(() => /report from dev[\s\S]*notice from main thread/.test(coordinator.lastSteer?.message ?? ""), "report and notice listed together");
		// R3: a wake_nudge fire while the monitor's first steer is held.
		const releaseMonitor = holdNextSteer(monitor);
		const toMonitor = h.call("agent_steer", { id: "ag_04", message: "check now" });
		await h.ask("ag_04", { type: "nudge", nudge: { action: "schedule", delay: "10m", reason: "next check" } });
		h.timers.at(-1)!.fn();
		assert.ok(itemsOf("ag_04").some((i) => i.kind === "notice" && i.urgent && i.subject === "[wake_nudge n1] next check"), "the fire is stored at once");
		releaseMonitor();
		await toMonitor;
		await waitFor(() => monitor.lastSteer?.message.includes("[wake_nudge n1]"), "the fire listed after the held steer");
		// R7: team_succeed's "write your note" redirect waits behind dev's held delivery, and is never refused for it.
		dev.status = "waiting";
		const releaseDev = holdNextSteer(dev);
		const more = h.call("agent_steer", { id: "ag_02", message: "more work" });
		await pause(20);
		const succeed = h.ask("ag_01", { type: "succeed", to: "dev" });
		await pause(50);
		releaseDev();
		await more;
		const started = await succeed;
		assert.equal(started.ok, true, started.text);
		assert.match(started.text, /^Handover started: dev \(ag_02\) was told to write its handover note/);
		const order = dev.steered.slice(-2).map((s: any) => [s.message.split("\n")[0], s.mode]);
		assert.deepEqual(order, [["more work", undefined], ["[Handover from coordinator coordinator (ag_01), team_01]", "redirect"]], "after the delivery in progress, never ahead of it");
		// R6 + R5: the "your successor has started" instruction waits behind another held delivery; the
		// result says dev was told, and the coordinator's handover item says so too.
		const releaseDev2 = holdNextSteer(dev);
		const again = h.call("agent_steer", { id: "ag_02", message: "and this" });
		await pause(20);
		h.writeNote("dev");
		await pause(80);
		releaseDev2();
		await again;
		const handover = await assertItem(h, "ag_01", "handover", /^\[Handover in team_01: dev's note is written\]\nStarted dev-2 \(ag_\d+\) to succeed dev \(ag_02\) [^\n]*\. dev was told to brief it;/);
		assert.equal(handover.from.role, "Sova");
		assert.match(dev.steered.at(-1).message, /Your successor dev-2 \(ag_\d+\) has started/);
		assert.equal(dev.steered.at(-1).mode, "redirect");
	} finally { await h.cleanup(); }
});

test("inbox lifecycle: a successor's start names honestly whether the old monitor could be told to brief it", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const monitor = h.worker("ag_03");
		// The old monitor's process takes no delivery any more (its briefing request is refused): not told.
		monitor.steer = async () => ({ ok: false, reason: "The worker's process did not start" });
		const r = await h.ask("ag_01", { type: "succeed", to: "monitor" });
		assert.equal(r.ok, true, r.text);
		assert.doesNotMatch(r.text, /monitor was told to brief it/);
		assert.match(r.text, /monitor could not be told to brief it \(/);
	} finally { await h.cleanup(); }
});

test("inbox lifecycle: a member that ends with no successor returns its open items, one notice per sender; Sova's go to the coordinator, the main thread's to the main chat", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const coordinator = h.worker("ag_01"), qa = h.worker("ag_03"), monitor = h.worker("ag_04");
		const itemsOf = (id: string) => readMemberItems(h.memberOf(id)!.dir);
		// A member's item: dev → qa, then qa stops.
		const sent = await h.ask("ag_02", { type: "message", to: "qa", message: "Please test the parser" });
		const id = /item (i_\w+)/.exec(sent.text)![1];
		qa.exit();
		const back = await assertItem(h, "ag_02", "notice", new RegExp(`^\\[Not addressed: 1 item\\(s\\) returned from qa \\(ag_03\\), team_01 — it ended, with no successor\\]\\n- ${id} message sent [^\\n]* — Please test the parser\\n`));
		assert.deepEqual([back.from, back.subject], [{ role: "Sova", workerId: "parent" }, "Not addressed: 1 item(s) returned from qa (ag_03)"]);
		assert.match(back.body, /agent_resume ag_03\.$/);
		assert.equal(itemsOf("ag_03").find((i) => i.id === id)?.returned?.why, "not addressed: it ended");
		// Sova's item (a wake_nudge fire) held by the monitor goes to the routing coordinator.
		await h.ask("ag_04", { type: "nudge", nudge: { action: "schedule", delay: "10m", reason: "next check" } });
		h.timers.at(-1)!.fn();
		await waitFor(() => itemsOf("ag_04").some((i) => i.subject.startsWith("[wake_nudge n1]")), "the fire stored");
		monitor.exit();
		await assertItem(h, "ag_01", "notice", /^\[Not addressed: 1 item\(s\) returned from monitor \(ag_04\), team_01 — it ended, with no successor\]\n- i_\w+ notice \(urgent\) sent [^\n]* — \[wake_nudge n1\] next check[\s\S]*These were Sova's notices to monitor/);
		// The coordinator ends: the main thread's item (an additions notice) comes back to the main chat, starting no turn.
		await h.call("team_add", { team: "Crew", members: [{ role: "docs", prompt: "Write docs." }] });
		h.messages.length = 0;
		coordinator.exit();
		const notices = h.parentMessages("team-notice");
		assert.ok(notices.length >= 1, "returned to the main chat");
		assert.ok(notices.every(([, opts]: any[]) => opts.triggerTurn === false && opts.deliverAs === "followUp"));
		assert.ok(notices.some(([m]: any[]) => /^\[Not addressed: \d+ item\(s\) returned from coordinator \(ag_01\), team_01 — it ended, with no successor\][\s\S]*1 member\(s\) added: docs/.test(m.content)), notices.map(([m]: any[]) => m.content).join("\n---\n"));
		assert.equal(readMemberItems(h.memberOf("ag_01")!.dir).filter((i) => i.kind !== "instruction" && !i.returned && i.status !== "addressed").length, 0, "nothing left open");
	} finally { await h.cleanup(); }
});

test("inbox lifecycle: at retirement the old member's open items move to its successor, ids and senders kept, and are listed to it", async () => {
	const h = coordinatedHarness(DEFAULTS_FILE);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
		const dev = h.worker("ag_02");
		const devDir = h.memberOf("ag_02")!.dir;
		const sent = await h.ask("ag_03", { type: "message", to: "dev", message: "Found a bug in parse()" });
		const id = /item (i_\w+)/.exec(sent.text)![1];
		await h.ask("ag_01", { type: "succeed", to: "dev" });
		h.writeNote("dev");
		dev.status = "running";
		dev.settle();
		await waitFor(() => h.worker("ag_05"), "dev-2 started");
		const successor = h.worker("ag_05");
		assert.equal(successor.name, "dev-2");
		assert.ok(readMemberItems(devDir).some((i) => i.id === id), "still dev's until it is retired");
		const ready = await h.ask("ag_05", { type: "ready" });
		assert.equal(ready.ok, true, ready.text);
		dev.settle(); // its turn (the "successor started" redirect) ends: it is retired now
		await waitFor(() => readMemberItems(h.memberOf("ag_05")!.dir).some((i) => i.id === id), "moved to dev-2");
		const moved = readMemberItems(h.memberOf("ag_05")!.dir).find((i) => i.id === id)!;
		assert.deepEqual([moved.from, moved.to, moved.movedFrom?.map((m) => [m.workerId, m.role, m.why])], [{ role: "qa", workerId: "ag_03" }, { role: "dev-2", workerId: "ag_05" }, [["ag_02", "dev", "handover"]]]);
		assert.ok(!readMemberItems(devDir).some((i) => i.id === id), "gone from dev's inbox");
		assert.equal(moved.status, "new", "new to its new holder, though dev had read it");
		successor.settle(); // busy on its first task: a normal item is listed when that turn ends
		await waitFor(() => (successor.steered ?? []).some((s: any) => s.message.includes(`${id} message from qa (sent to dev) — Found a bug in parse()`)), "listed to dev-2");
		await waitFor(() => dev.status === "killed", "dev retired");
		// Nothing came back as "not addressed": the successor has it.
		assert.ok(!readMemberItems(h.memberOf("ag_03")!.dir).some((i) => /Not addressed/.test(i.body)));
	} finally { await h.cleanup(); }
});

test("a message to a member that ended while its successor is still to start is queued and moves to the successor; with none started it goes back to its sender", async () => {
	for (const startsSuccessor of [true, false]) {
		const h = coordinatedHarness(DEFAULTS_FILE);
		try {
			await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "counter", prompt: "count" }, { role: "writer", prompt: "write" }] });
			const counter = h.worker("ag_02");
			await h.ask("ag_01", { type: "succeed", to: "counter" });
			// Its process is going away (not live, not yet finished): the succession is still pending.
			counter.isStopping = () => true;
			const sent = await h.ask("ag_03", { type: "message", to: "counter", message: "Which files are done?" });
			assert.equal(sent.ok, true, sent.text);
			assert.match(sent.text, /^Queued for counter \(ag_02\): item (i_\w+) — counter has ended and its successor is starting: the item moves to it$/);
			const id = /item (i_\w+)/.exec(sent.text)![1];
			assert.deepEqual(readMemberItems(h.memberOf("ag_02")!.dir).filter((i) => i.id === id).map((i) => [i.kind, i.from.role, i.status]), [["message", "writer", "new"]]);
			// team_steer has no inbox to wait in: refused, saying why.
			assert.match((await h.ask("ag_01", { type: "steer", to: "counter", message: "x" })).text, /has ended and its successor is still starting/);
			if (!startsSuccessor) {
				// Every seat taken (the old member still holds its own): the successor cannot start.
				await h.call("team_add", { team: "Crew", members: Array.from({ length: 20 }, (_, i) => ({ role: `filler${i}`, prompt: `p${i}`, wake: false })) });
			}
			counter.exit();
			await h.tick(60);
			if (startsSuccessor) {
				const next = h.worker("ag_05");
				assert.equal(next?.name, "counter-2");
				await waitFor(() => readMemberItems(h.memberOf("ag_05")!.dir).some((i) => i.id === id), "the item moved to counter-2");
				const moved = readMemberItems(h.memberOf("ag_05")!.dir).find((i) => i.id === id)!;
				assert.deepEqual([moved.from.workerId, moved.movedFrom?.[0].workerId, moved.status], ["ag_03", "ag_02", "new"]);
			} else {
				assert.equal(h.workers.some((w: any) => w.name === "counter-2"), false, "no successor started");
				await waitFor(() => readMemberItems(h.memberOf("ag_02")!.dir).find((i) => i.id === id)?.returned, "the item returned");
				await waitFor(() => readMemberItems(h.memberOf("ag_03")!.dir).some((i) => i.kind === "notice" && i.body.includes(id)), "the sender told it was not addressed");
			}
		} finally { await h.cleanup(); }
	}
});

// ── Runtime fallback of standing roles (§teams.defaults/runtime-fallback) ─────────────────────
/** The real Ollama error a monitor whose monthly quota ran out ends every turn with. */
const OLLAMA_MONTHLY = '429: {"message":"you (alex) have reached your monthly usage limit, add usage credits: …"}';
/** The text a Claude Code member's turn ends with once the bridge has tried every Claude login (the CLI's own synthetic message, claude-code/tests/fixtures/failures/limit-rejected.ndjson; session-bridge.ts fail()). */
const CLAUDE_ALL_LOGINS_OUT = "You've hit your limit · resets 3pm";
/** A plain rate limit: retried where it happens, never a switch. */
const PLAIN_429 = '429: {"code":"1302","message":"Rate limit reached for requests"}';
const MONITOR_PRIMARY = { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "low" };
const FALLBACK_FILE = {
	...DEFAULTS_FILE,
	coordinator: { ...DEFAULTS_FILE.coordinator, fallback: { backend: "pi", model: "test/model", effort: "high" } },
	monitor: { ...DEFAULTS_FILE.monitor, primary: MONITOR_PRIMARY, fallback: { backend: "claude-code", model: "claude-sonnet-5-5", effort: "low" } },
};
/** A coordinated harness whose registry also knows the Ollama model the monitor's primary names. */
function fallbackHarness(file: unknown = FALLBACK_FILE) {
	const h = coordinatedHarness(file);
	h.ctx.modelRegistry.find = (p: string, m: string) => ((p === "test" && m === "model") || (p === "ollama-cloud" && m === "deepseek-v4.1-flash") ? { provider: p, id: m } : undefined);
	return h;
}
/** One failed turn, as the fold settles it: parked in `waiting`, task outcome "error", the provider's errorMessage as the error. */
const failTurn = (w: any, error: string) => {
	w.status = "running";
	w.taskOutcome = "error";
	w.settle(error);
};
const okTurn = (w: any) => {
	w.status = "running";
	w.taskOutcome = "success";
	w.output = "checked";
	w.settle();
};
const itemsOf = (h: { memberOf(id: string): { dir: string } | undefined }, id: string, kind?: string) => readMemberItems(h.memberOf(id)!.dir).filter((i) => !kind || i.kind === kind);
const teamOps = (h: { appended: any[] }) => h.appended.filter((e) => e.customType === "subagents-team-v1").map((e) => e.data.op);
const deadEntries = (h: { appended: any[] }) => h.appended.filter((e) => e.customType === "subagents-dead-tuple-v1").map((e) => e.data);

test("runtime fallback: a monitor out of its monthly Ollama usage moves to its fallback once, its seat freed first; the coordinator gets one item", async () => {
	const h = fallbackHarness();
	try {
		const created = await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		assert.match(created.content[0].text, /monitor monitor added on pi\/ollama-cloud\/deepseek-v4\.1-flash\/low \(primary\)/);
		const monitor = h.worker("ag_03");
		assert.equal(monitor.model, "ollama-cloud/deepseek-v4.1-flash");
		failTurn(monitor, OLLAMA_MONTHLY);
		await waitFor(() => h.worker("ag_04"), "the monitor's successor");
		const successor = h.worker("ag_04");
		assert.equal(successor.name, "monitor-2");
		assert.equal(successor.model, "claude-code-cli/claude-sonnet-5-5", "on the fallback");
		assert.deepEqual([h.memberOf("ag_04")!.duty, h.memberOf("ag_04")!.successorOf], ["monitor", "monitor"]);
		assert.equal(monitor.status, "killed", "the failed monitor is stopped");
		assert.match(successor.task, /You take over from the monitor monitor \(ag_03\), which has already ended: there is nobody to ask and no team_ready to call\. Run your standing instruction now/, "its first check runs at once");
		// The seat is released before the successor is added (a full team still gets it).
		assert.deepEqual(teamOps(h), ["create", "eject", "add"]);
		const ev = h.appended.filter((e) => e.customType === "subagents-team-event-v1" && e.data.kind === "handover").map((e) => e.data);
		assert.equal(ev.length, 1);
		assert.equal(ev[0].workerId, "ag_03");
		assert.match(ev[0].detail, /^successor monitor-2 \(ag_04\) on pi\/claude-code-cli\/claude-sonnet-5-5; fallback: primary pi\/ollama-cloud\/deepseek-v4\.1-flash\/low hit its monthly usage limit \(429: /);
		assert.deepEqual(deadEntries(h).map((d) => [d.backend, d.model, d.teamId, d.duty]), [["pi", "ollama-cloud/deepseek-v4.1-flash", undefined, undefined], ["pi", "ollama-cloud/deepseek-v4.1-flash", "team_01", "monitor"]]);
		const list = (await h.call("team_list")).content[0].text;
		assert.match(list, /system handover → ag_03 \(monitor\): accepted-or-queued — old member already ended; nothing to retire/, "a team action row");
		await h.tick(60);
		// One item about the switch, and no "failed" report for the turn.
		const handover = itemsOf(h, "ag_01", "handover");
		assert.equal(handover.length, 1);
		assert.match(handover[0].body, /Monitor moved to its fallback claude-sonnet-5-5: ollama-cloud\/deepseek-v4\.1-flash hit its monthly usage limit\./);
		assert.equal(itemsOf(h, "ag_01", "report").length, 0, "no urgent failed report");
		// Its stop is said nowhere else: still one item.
		await h.tick(60);
		assert.equal(itemsOf(h, "ag_01").length, 1);
		// The successor runs the fallback: its own failure is routed as before, never a second switch.
		failTurn(successor, OLLAMA_MONTHLY);
		await h.tick(60);
		assert.equal(h.workers.length + h.created.length, 4, "a member not on its primary is not switched");
	} finally { await h.cleanup(); }
});

test("runtime fallback: 3 failed turns in a row of any kind switch; a single 429 rate limit or a streak broken by a good turn doesn't; the backstop re-arms the check", async () => {
	const h = fallbackHarness();
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const monitor = h.worker("ag_03");
		const armed = () => h.timers.filter((t) => t.ms === 10 * 60_000).length;
		failTurn(monitor, PLAIN_429);
		await h.tick(60);
		assert.equal(h.workers.length + h.created.length, 3, "a single rate limit is not a switch");
		assert.equal(itemsOf(h, "ag_01", "report").length, 1, "it is reported as before");
		assert.equal(armed(), 1, "the parent schedules the monitor's next check itself");
		assert.equal((await h.ask("ag_03", { type: "nudge", nudge: { action: "list" } })).text.match(/scheduled by Sova after a failed check/g)?.length, 1);
		failTurn(monitor, "Connection reset by peer");
		await h.tick(60);
		assert.equal(armed(), 1, "a pending check is not doubled");
		okTurn(monitor);
		failTurn(monitor, "Connection reset by peer");
		failTurn(monitor, "Connection reset by peer");
		await h.tick(60);
		assert.equal(h.workers.length + h.created.length, 3, "a good turn starts the count again");
		failTurn(monitor, "Connection reset by peer");
		await waitFor(() => h.worker("ag_04"), "the successor after 3 failures in a row");
		assert.equal(h.worker("ag_04").model, "claude-code-cli/claude-sonnet-5-5");
		const ev = h.appended.find((e) => e.customType === "subagents-team-event-v1" && e.data.kind === "handover").data;
		assert.match(ev.detail, /fallback: primary pi\/ollama-cloud\/deepseek-v4\.1-flash\/low failed 3 turns in a row \(Connection reset by peer\)$/);
	} finally { await h.cleanup(); }
});

test("runtime fallback: with no fallback the dead monitor is stopped and said once; a dead coordinator is said to the main chat once", async () => {
	const none = { ...FALLBACK_FILE, monitor: { ...FALLBACK_FILE.monitor, fallback: null }, coordinator: { ...FALLBACK_FILE.coordinator, fallback: null } };
	const h = fallbackHarness(none);
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01"), monitor = h.worker("ag_03");
		failTurn(monitor, OLLAMA_MONTHLY);
		await waitFor(() => monitor.status === "killed", "the monitor stopped");
		await h.tick(60);
		const items = itemsOf(h, "ag_01");
		assert.equal(items.length, 1, "one item, no failed report");
		assert.equal(items[0].kind, "notice");
		assert.match(items[0].body, /Monitor monitor \(ag_03\) in team_01 stopped: its primary pi\/ollama-cloud\/deepseek-v4\.1-flash\/low hit its monthly usage limit \(429: .*\), and no fallback is set\./);
		const notices = () => h.parentMessages("team-notice").map(([m, o]: any[]) => [m.content, o.triggerTurn]);
		assert.equal(notices().length, 1);
		assert.equal(notices()[0][1], false, "displayed, no turn");
		// Stopped: its timers are gone, so nothing wakes the coordinator again.
		for (const t of [...h.timers]) t.fn();
		await h.tick(60);
		assert.equal(itemsOf(h, "ag_01").length, 1, "no repeated follow-ups");
		assert.equal(h.workers.length + h.created.length, 3, "nothing started");
		// The coordinator: not stopped, said to the main chat once.
		failTurn(coordinator, CLAUDE_ALL_LOGINS_OUT);
		await h.tick(60);
		assert.notEqual(coordinator.status, "killed");
		assert.equal(notices().length, 2);
		assert.match(notices()[1][0], /^Coordinator coordinator \(ag_01\) in team_01 can't run: its primary claude-code\/claude-opus-5-5\/medium hit its usage limit \(You've hit your limit · resets 3pm\), and no fallback is set\. .*team_succeed \{ team: "team_01", role: "coordinator" \}/);
		assert.equal(completions(h).length, 0, "that turn's completion is the notice");
		failTurn(coordinator, CLAUDE_ALL_LOGINS_OUT);
		await h.tick(60);
		assert.equal(notices().length, 2, "once per member");
	} finally { await h.cleanup(); }
});

test("runtime fallback: a team with all 24 seats taken still gets the successor", async () => {
	const h = fallbackHarness();
	try {
		const members = Array.from({ length: 22 }, (_, i) => ({ role: `m${i}`, prompt: `p${i}` }));
		await h.call("team_create", { name: "Full", objective: "o", members });
		await assert.rejects(h.call("team_add", { team: "Full", members: [{ role: "extra", prompt: "p" }] }), /would exceed 24 members/, "full");
		const monitor = h.worker("ag_24");
		assert.equal(h.memberOf("ag_24")!.duty, "monitor");
		failTurn(monitor, OLLAMA_MONTHLY);
		await waitFor(() => h.worker("ag_25"), "the successor of a full team's monitor");
		assert.equal(h.worker("ag_25").name, "monitor-2");
		const team = (await h.call("team_list")).content[0].text;
		assert.match(team, /ag_24 monitor \(monitor\).*ejected/);
		assert.match(team, /ag_25 monitor-2 \(monitor\)/);
	} finally { await h.cleanup(); }
});

test("runtime fallback: a claude-code coordinator with every login out switches, and routing moves to its successor", async () => {
	const h = fallbackHarness();
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		const coordinator = h.worker("ag_01");
		assert.equal(coordinator.model, "claude-code-cli/claude-opus-5-5");
		failTurn(coordinator, CLAUDE_ALL_LOGINS_OUT);
		await waitFor(() => h.worker("ag_04"), "the coordinator's successor");
		const next = h.worker("ag_04");
		assert.equal(next.name, "coordinator-2");
		assert.deepEqual([next.model, next.effort], ["test/model", "high"], "on the fallback");
		assert.deepEqual([h.memberOf("ag_04")!.duty, h.memberOf("ag_04")!.orchestrator], ["coordinator", true]);
		assert.equal(coordinator.status, "killed");
		assert.match(next.task, /coordinator stopped when its primary claude-code\/claude-opus-5-5\/medium hit its usage limit, without writing a handover note/);
		assert.match(next.task, /Its assignment from the main thread:\nCoordinate this team toward the objective/);
		assert.match(next.task, /- dev: none declared\n {2}Assigned task \(from the main thread\):\n {2}\| build/, "every teammate's assignment");
		assert.equal(completions(h).length, 0, "the failed turn reaches nobody");
		const ev = h.appended.find((e) => e.customType === "subagents-team-event-v1" && e.data.kind === "handover").data;
		assert.match(ev.detail, /^successor coordinator-2 \(ag_04\) on pi\/test\/model; fallback: primary claude-code\/claude-opus-5-5\/medium hit its usage limit \(You've hit your limit · resets 3pm\)$/);
		// Members now report to the successor.
		const dev = h.worker("ag_02");
		dev.output = "built";
		dev.settle();
		await assertItem(h, "ag_04", "report", /^\[Team report from dev \(ag_02\), team_01: finished — routed to you as coordinator\]/);
	} finally { await h.cleanup(); }
});

test("runtime fallback: the out primary survives a reload; new teams, the members default and replacements skip it; after an hour it is tried again", async () => {
	const h = fallbackHarness();
	let entries: any[];
	try {
		await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
		failTurn(h.worker("ag_03"), OLLAMA_MONTHLY);
		await waitFor(() => h.worker("ag_04"), "the switch");
		entries = h.appended.map((e, i) => ({ type: "custom", id: `e${i}`, customType: e.customType, data: e.data }));
	} finally { await h.cleanup(); }
	const reloaded = (at?: number) => {
		const r = fallbackHarness();
		const list = entries.map((e) => (e.customType === "subagents-dead-tuple-v1" && at !== undefined ? { ...e, data: { ...e.data, at } } : e));
		r.ctx.sessionManager.getEntries = () => list;
		return r;
	};
	const r = reloaded();
	try {
		await r.start();
		const created = (await r.call("team_create", { name: "Next", objective: "o", members: [{ role: "dev", prompt: "p" }] })).content[0].text;
		assert.match(created, /monitor monitor added on claude-code\/claude-sonnet-5-5\/low \(fallback; primary pi\/ollama-cloud\/deepseek-v4\.1-flash\/low refused: it ran out at runtime .* ago \(hit its monthly usage limit\); it is tried again from /);
		// The members default is a tuple check too.
		await r.commands.get("team").handler("defaults", r.ctx);
		const libPath = path.join(r.agentDir, "subagent-profiles.json");
		const lib = JSON.parse(fs.readFileSync(libPath, "utf8"));
		lib.profiles[0].members = { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "low" };
		fs.writeFileSync(libPath, JSON.stringify(lib));
		const added = (await r.call("team_add", { team: "Next", members: [{ role: "late", prompt: "p" }] })).content[0].text;
		assert.match(added, /Members default pi\/ollama-cloud\/deepseek-v4\.1-flash\/low \(subagent profile "My setup"\) can't run here — it ran out at runtime/);
		// A replacement from the main chat skips it as well.
		const monitorId = (await r.call("team_list", { team: "Next" })).content[0].text.match(/(ag_\d+) monitor \(monitor\)/)[1];
		r.worker(monitorId).exit();
		const replaced = (await r.call("team_succeed", { team: "Next", role: "monitor" })).content[0].text;
		assert.match(replaced, /^Started monitor-2 \(ag_\d+\) to succeed monitor \(ag_\d+\) on pi\/claude-code-cli\/claude-sonnet-5-5\/low/);
	} finally { await r.cleanup(); }
	const later = reloaded(Date.now() - 61 * 60_000);
	try {
		await later.start();
		const created = (await later.call("team_create", { name: "Later", objective: "o", members: [{ role: "dev", prompt: "p" }] })).content[0].text;
		assert.match(created, /monitor monitor added on pi\/ollama-cloud\/deepseek-v4\.1-flash\/low \(primary\)/, "after the hour the primary is tried again");
	} finally { await later.cleanup(); }
});
