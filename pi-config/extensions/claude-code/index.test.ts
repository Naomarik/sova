import assert from "node:assert/strict";
import test from "node:test";
import { registerClaudeCode } from "./index.ts";
import { BACKEND_DIALOG_EVENT, BACKEND_DISCOVER_EVENT, BACKEND_REGISTER_EVENT } from "../subagents/contracts.ts";

function harness() {
	const listeners = new Map<string, Set<(data: any) => void>>();
	const hooks = new Map<string, Function>();
	const registrations: any[] = [];
	const events = {
		on(name: string, handler: (data: any) => void) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
		emit(name: string, data: any) { for (const fn of listeners.get(name) ?? []) fn(data); },
	};
	events.on(BACKEND_REGISTER_EVENT, b => registrations.push(b));
	registerClaudeCode({ events, on: (name: string, hook: Function) => hooks.set(name, hook) } as any);
	return { events, hooks, registrations };
}
test("Claude extension registers versioned backend and handles discovery until shutdown", async () => {
	const h = harness();
	assert.equal(h.registrations[0].id, "claude-code");
	h.events.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
	assert.equal(h.registrations.length, 2);
	await h.hooks.get("session_shutdown")!();
	h.events.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
	assert.equal(h.registrations.length, 2);
});
test("Claude preparation has backend-specific defaults and rejects Pi-only options", () => {
	const b = harness().registrations[0];
	const ctx = { hasUI: false };
	const prepared = b.prepare({ prompt: "test", tools: [] }, ctx);
	assert.equal(prepared.model, "sonnet");
	assert.equal(prepared.effort, "medium");
	assert.deepEqual(prepared.tools, []);
	assert.equal(prepared.permissionMode, "bypassPermissions");
	for (const permissionMode of ["bypassPermissions", "acceptEdits", "manual", "dontAsk", "plan"]) {
		assert.equal(b.prepare({ prompt: "test", backendOptions: { permissionMode } }, ctx).permissionMode, permissionMode);
	}
	assert.equal(prepared.permissionTimeoutManagedByHost, true);
	for (const patch of [{ fork: true }, { extensions: [] }, { agentType: "worker" }, { model: "openai/astramodel" }, { tools: ["read"] }]) {
		assert.throws(() => b.validate({ prompt: "test", ...patch }, ctx));
	}
});
test("permission bridge serializes two workers without timing out unseen requests", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const flush = () => new Promise<void>(resolve => setImmediate(resolve));
	const h = harness(); const b = h.registrations[0];
	const messages: string[] = [];
	const answers: ((value: boolean) => void)[] = [];
	const ctx = { cwd: "/tmp/parent", hasUI: true, ui: { confirm: async (_title: string, message: string) => {
		messages.push(message); return new Promise<boolean>(resolve => answers.push(resolve));
	} } };
	// count>1: one prepared handler serves every instance of the spec.
	const shared = b.prepare({ prompt: "task", name: "reviewer", count: 2, cwd: "/tmp/resolved" }, ctx).onPermission;
	const req = { requestId: "r", toolName: "Bash", input: { command: "echo test" }, workerId: "ag_01", workerName: "reviewer-1", cwd: "/tmp/resolved-first" };
	const signal = new AbortController().signal;
	const first = shared(req, signal); await flush();
	t.mock.timers.tick(1000);
	const second = shared({ ...req, requestId: "second", workerId: "ag_02", workerName: "reviewer-2", cwd: "/tmp/resolved-second" }, signal);
	t.mock.timers.tick(58000); await flush();
	assert.equal(messages.length, 1);
	answers[0](true); assert.equal((await first).behavior, "allow"); await flush();
	assert.equal(messages.length, 2);
	assert.match(messages[0], /^Worker: reviewer-1 \(ag_01\)\nDirectory: \/tmp\/resolved-first/);
	assert.match(messages[1], /^Worker: reviewer-2 \(ag_02\)\nDirectory: \/tmp\/resolved-second/);
	t.mock.timers.tick(30000); await flush();
	answers[1](true); assert.equal((await second).behavior, "allow");
	await h.hooks.get("session_shutdown")!();
});

test("permission cancellation releases monitor dialog token even when UI ignores abort", async () => {
	const h = harness(); const b = h.registrations[0]; const dialogs: any[] = [];
	h.events.on(BACKEND_DIALOG_EVENT, event => dialogs.push(event));
	const permission = b.prepare({ prompt: "test" }, { hasUI: true, ui: { confirm: async () => new Promise(() => {}) } }).onPermission;
	const controller = new AbortController();
	const pending = permission({ requestId: "r", toolName: "Write", input: {}, workerId: "ag_01", workerName: "w", cwd: "/tmp" }, controller.signal);
	await new Promise(resolve => setImmediate(resolve));
	controller.abort();
	assert.equal((await pending).behavior, "deny");
	assert.deepEqual(dialogs.map(d => d.open), [true, false]);
	await h.hooks.get("session_shutdown")!();
});

test("permission bridge allows only explicit UI approval and denies unavailable, aborted or closed UI", async () => {
	const h = harness();const b=h.registrations[0];
	const dialogs: any[] = [];
	h.events.on(BACKEND_DIALOG_EVENT, event => dialogs.push(event));
	const req = { requestId: "r", toolName: "Bash", input: { command: "echo test" }, workerId: "ag_01", workerName: "w", cwd: "/tmp" };
	const signal = new AbortController().signal;
	const off = b.prepare({ prompt: "test" }, { hasUI: false }).onPermission;
	assert.equal((await off(req, signal)).behavior, "deny");
	const yes = b.prepare({ prompt: "test" }, { hasUI: true, ui: { confirm: async () => true } }).onPermission;
	assert.deepEqual(await yes(req, signal), { behavior: "allow", updatedInput: req.input });
	const aborted = new AbortController();aborted.abort();
	assert.equal((await yes(req, aborted.signal)).behavior, "deny");
	const broken = b.prepare({ prompt: "test" }, { hasUI: true, ui: { confirm: async () => { throw Error("closed"); } } }).onPermission;
	assert.equal((await broken(req, signal)).behavior, "deny");
	assert.deepEqual(dialogs.map(d => d.open), [true, false, true, false]);
	assert.ok(dialogs.every(d => d.version === 1));
	assert.equal(dialogs[0].token, dialogs[1].token);
	assert.equal(dialogs[2].token, dialogs[3].token);
	assert.notEqual(dialogs[0].token, dialogs[2].token);
	await h.hooks.get("session_shutdown")!();
	assert.equal((await yes(req, signal)).behavior, "deny");
});

test("oversized Claude prompts fail validation before any batch member starts", async () => {
	const { MAX_CLAUDE_INPUT_CHARS } = await import("./runner.ts");
	const b = harness().registrations[0];
	b.validate({ prompt: "x".repeat(MAX_CLAUDE_INPUT_CHARS) }, {});
	assert.throws(() => b.validate({ prompt: "x".repeat(MAX_CLAUDE_INPUT_CHARS + 1) }, {}), /limit is 262144/);
});
