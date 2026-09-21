import assert from "node:assert/strict";
import test from "node:test";
import { registerSubagents } from "../subagents/index.ts";
import { registerClaudeCode } from "./index.ts";
import { BACKEND_REGISTER_EVENT } from "../subagents/contracts.ts";

test("real Claude permission emitter hides the real manager overlay and restores it", async () => {
	const listeners = new Map<string, Set<Function>>();
	const hooks = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	let backend: any;
	const events = {
		on(name: string, fn: Function) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => { set.delete(fn); }; },
		emit(name: string, data: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
	};
	events.on(BACKEND_REGISTER_EVENT, (b: any) => { backend = b; });
	const pi: any = { events, registerFlag() {}, getFlag: () => undefined, registerProvider() {}, unregisterProvider() {}, registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, registerShortcut() {}, appendEntry() {}, getActiveTools: () => [], sendMessage() {},
		on(name: string, fn: Function) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); } };
	registerClaudeCode(pi); registerSubagents(pi);
	const visibility: boolean[] = [];
	let close!: (value: null) => void;
	const ctx: any = { cwd: "/tmp", mode: "tui", hasUI: true, ui: {
		setStatus() {}, notify() {},
		custom(factory: Function, options: any) { return new Promise(resolve => {
			close = resolve;
			options.onHandle({ setHidden: (hidden: boolean) => visibility.push(hidden), focus() {} });
			factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, resolve);
		}); },
		async confirm() { assert.equal(visibility.at(-1), true, "permission dialog must not be covered by monitor"); return true; },
	} };
	const monitor = commands.get("agents").handler("", ctx);
	try {
		const permission = backend.prepare({ prompt: "task" }, ctx).onPermission;
		const decision = await permission({ requestId: "permission", toolName: "Bash", input: { command: "echo test" }, workerId: "ag_01", workerName: "task", cwd: "/tmp" }, new AbortController().signal);
		assert.equal(decision.behavior, "allow");
		assert.deepEqual(visibility.slice(-2), [true, false]);
	} finally {
		close(null); await monitor;
		for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
	}
});
