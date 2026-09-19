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

// Launch flag values the fake host reports; scenarios mutate this.
const flagValues = {};

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
		getFlag: (name) => flagValues[name],
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

const { api, hooks, commands, shortcuts, renderers, entries, events, getTools } = makeApi();
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
assert.ok(api.flags.has("minor"), "--minor flag registered");
assert.ok(commands.has("mode-align"), "/mode-align registered as its own command");
assert.match(commands.get("mode-align").description, /align/i);

async function hook(name, ...args) {
	return hooks.get(name)?.(...args, ctx);
}

await hook("session_start", {});
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "normal status renders");

// before_agent_start is inert in normal mode
assert.equal(await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx), undefined);

// Toggle heavy with fable available
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy</accent>", "heavy status renders after probe");
const heavyPrompt = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
assert.match(heavyPrompt.systemPrompt, /^base\n/);
assert.match(heavyPrompt.systemPrompt, /# Mode: claude-heavy/);
assert.match(heavyPrompt.systemPrompt, /claude-fable-5-1\[1m\]/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.mode === "claude-heavy"), "transcript marker appended");

// Strict mode hides edit/write from the orchestrator and restores on mode exit
await commands.get("mode").handler("strict on", ctx);
assert.deepEqual(getTools(), ["read", "bash", "grep"], "strict removed edit/write");
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>");
await commands.get("mode").handler("normal", ctx);
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep"], "tools restored on leaving heavy");
assert.equal(store.status.get("mode"), "<dim>normal</dim>");

// Planner fallback: fable not offered → warning status + prompt names opus/high
offered = [{ id: "opus[1m]", name: "Opus" }];
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<warning>claude-heavy · plan:opus · strict</warning>", "fallback reflected in status (strict is still on from the previous scenario)");
const fallbackPrompt = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
assert.match(fallbackPrompt.systemPrompt, /model "opus\[1m\]", effort "high"/);
assert.ok(store.notices.some((n) => n.level === "warning"), "fallback notifies");

// Toggling via the shortcut flips modes
await shortcuts.get("alt+m").handler(ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "shortcut toggles back to normal");

// Minor mode align in normal mode: only the align block is appended
const alignHeader = /# Minor mode: align/;
await commands.get("mode").handler("align on", ctx);
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "align shows in normal status");
const normalAlign = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
assert.match(normalAlign.systemPrompt, /^base\n\n# Minor mode: align/);
assert.doesNotMatch(normalAlign.systemPrompt, /# Mode: claude-heavy/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === true), "minor marker appended");
const markerText = renderers.get("mode")({ data: { minor: "align", on: true } }, {}, ctx.ui.theme).render(80).join("");
assert.match(markerText, /── align on ──/, "minor marker renders");
const oldMarkerText = renderers.get("mode")({ data: { mode: "claude-heavy" } }, {}, ctx.ui.theme).render(80).join("");
assert.match(oldMarkerText, /── mode → claude-heavy ──/, "old major markers still render");

// Switching to heavy keeps align; the heavy block precedes the align block
offered = [
	{ id: "claude-fable-5-1[1m]", name: "Fable" },
	{ id: "opus[1m]", name: "Opus" },
];
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict · align</accent>");
const heavyAlign = (await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.ok(heavyAlign.indexOf("# Mode: claude-heavy") > 0, "heavy block present");
assert.ok(heavyAlign.indexOf("# Mode: claude-heavy") < heavyAlign.search(alignHeader), "heavy before align");

// /mode status reports minor modes
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: align$/m);

// Bare /mode align toggles off; prompt back to heavy only
await commands.get("mode").handler("align", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>");
const heavyOnly = (await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.match(heavyOnly, /# Mode: claude-heavy/);
assert.doesNotMatch(heavyOnly, alignHeader);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === false), "off marker appended");
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: \(none\)$/m);

// /mode-align toggles, and accepts on/off
await commands.get("mode-align").handler("", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict · align</accent>", "/mode-align toggles on");
await commands.get("mode-align").handler("off", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>", "/mode-align off");
await commands.get("mode-align").handler("sideways", ctx);
assert.equal(store.notices.at(-1).level, "warning", "bad /mode-align argument warns");

// Completions include minor modes
const completions = commands.get("mode").getArgumentCompletions("al").map((item) => item.value);
assert.deepEqual(completions, ["align", "align on", "align off"]);

// --minor launch flag: applies known names, warns once about unknown ones
await commands.get("mode").handler("normal", ctx);
flagValues.minor = "align,bogus";
const noticesBefore = store.notices.length;
await hook("session_start", {});
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "--minor applied at session start");
const flagNotices = store.notices.slice(noticesBefore);
assert.equal(flagNotices.length, 1, "exactly one notification for the flag");
assert.equal(flagNotices[0].level, "warning");
assert.match(flagNotices[0].message, /bogus/);

console.log("mode smoke tests passed");
