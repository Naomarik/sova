// Offline wiring smoke test for the mode extension. No model requests.
// Drives the real index.ts through the globally installed pi runtime (jiti alias),
// with a fake ExtensionAPI/TUI and a fake claude-code backend registration.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "mode-smoke-"));

const modeModule = await jiti.import(pathToFileURL(path.resolve(new URL("../index.ts", import.meta.url).pathname)).href);
const modeExtension = modeModule.default;

function makeApi() {
	const listeners = new Map();
	const hooks = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const renderers = new Map();
	const entries = [];
	let tools = ["read", "bash", "edit", "write", "grep"];
	const events = {
		on(name, handler) {
			const set = listeners.get(name) ?? new Set();
			set.add(handler);
			listeners.set(name, set);
			return () => set.delete(handler);
		},
		emit(name, data) {
			for (const fn of listeners.get(name) ?? []) fn(data);
		},
	};
	const api = {
		events,
		on: (name, handler) => hooks.set(name, handler),
		registerFlag: (name, options) => api.flags.set(name, options),
		getFlag: () => undefined,
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (id, options) => shortcuts.set(id, options),
		appendEntry: (type, data) => entries.push({ type, data }),
		registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
		getActiveTools: () => [...tools],
		setActiveTools: (next) => {
			tools = [...next];
		},
		flags: new Map(),
	};
	return { api, hooks, commands, shortcuts, renderers, entries, events, getTools: () => tools };
}

function makeCtx(store) {
	const status = store.status;
	const notices = store.notices;
	return {
		ui: {
			setStatus: (key, text) => status.set(key, text),
			notify: (message, level) => notices.push({ message, level }),
			theme: { fg: (tone, text) => `<${tone}>${text}</${tone}>` },
		},
	};
}

// Fake claude-code backend; models list is swappable per scenario.
let offered = [
	{ id: "claude-fable-5-1[1m]", name: "Fable" },
	{ id: "opus[1m]", name: "Opus" },
];

const { api, hooks, commands, shortcuts, entries, events, getTools } = makeApi();
const store = { status: new Map(), notices: [] };
const ctx = makeCtx(store);

events.on("subagents:backend-discover", () => {
	events.emit("subagents:backend-register", {
		version: 1,
		id: "claude-code",
		listModels: async () => structuredClone(offered),
		validate: () => {},
		create: () => {
			throw new Error("smoke test must not create workers");
		},
	});
});

modeExtension(api);

assert.ok(commands.has("mode"), "/mode registered");
assert.ok(shortcuts.has("alt+m"), "alt+m registered");
assert.ok(api.flags.has("mode"), "--mode flag registered");

async function hook(name, ...args) {
	return hooks.get(name)?.(...args, ctx);
}

await hook("session_start", {});
assert.equal(store.status.get("mode"), "<dim>• normal</dim>", "normal status renders");

// before_agent_start is inert in normal mode
assert.equal(await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx), undefined);

// Toggle heavy with fable available
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<accent>◆ claude-heavy</accent>", "heavy status renders after probe");
const heavyPrompt = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
assert.match(heavyPrompt.systemPrompt, /^base\n/);
assert.match(heavyPrompt.systemPrompt, /# Mode: claude-heavy/);
assert.match(heavyPrompt.systemPrompt, /claude-fable-5-1\[1m\]/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.mode === "claude-heavy"), "transcript marker appended");

// Strict mode hides edit/write from the orchestrator and restores on mode exit
await commands.get("mode").handler("strict on", ctx);
assert.deepEqual(getTools(), ["read", "bash", "grep"], "strict removed edit/write");
assert.equal(store.status.get("mode"), "<accent>◆ claude-heavy · strict</accent>");
await commands.get("mode").handler("normal", ctx);
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep"], "tools restored on leaving heavy");
assert.equal(store.status.get("mode"), "<dim>• normal</dim>");

// Planner fallback: fable not offered → warning status + prompt names opus/high
offered = [{ id: "opus[1m]", name: "Opus" }];
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<warning>◆ claude-heavy · plan:opus · strict</warning>", "fallback reflected in status (strict is still on from the previous scenario)");
const fallbackPrompt = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
assert.match(fallbackPrompt.systemPrompt, /model "opus\[1m\]", effort "high"/);
assert.ok(store.notices.some((n) => n.level === "warning"), "fallback notifies");

// Toggling via the shortcut flips modes
await shortcuts.get("alt+m").handler(ctx);
assert.equal(store.status.get("mode"), "<dim>• normal</dim>", "shortcut toggles back to normal");

console.log("mode smoke tests passed");
