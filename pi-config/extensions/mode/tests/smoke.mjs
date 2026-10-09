// Offline wiring smoke test for the mode extension. No model requests.
// Drives the real index.ts through the globally installed pi runtime (jiti alias),
// with a fake ExtensionAPI/TUI and a fake claude-code backend registration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
// The align viewer renders through getMarkdownTheme(), whose colour functions need the theme the TUI initialises at startup.
const { initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
initTheme();

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
	const registeredTools = new Map();
	const entries = [];
	const sent = [];
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
		on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
		registerFlag: (name, options) => api.flags.set(name, options),
		getFlag: (name) => flagValues[name],
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (id, options) => shortcuts.set(id, options),
		appendEntry: (type, data) => entries.push({ type, data }),
		registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
		registerTool: (tool) => registeredTools.set(tool.name, tool),
		sendMessage: (message, options) => sent.push({ message, options }),
		getActiveTools: () => [...tools],
		setActiveTools: (next) => {
			tools = [...next];
		},
		flags: new Map(),
	};
	return { api, hooks, commands, shortcuts, renderers, registeredTools, entries, sent, events, getTools: () => tools };
}

const fakeTui = { terminal: { rows: 30, columns: 100 }, requestRender() {} };

function makeCtx(store) {
	const status = store.status;
	const notices = store.notices;
	const theme = { fg: (tone, text) => `<${tone}>${text}</${tone}>`, bold: (text) => text, bg: (_tone, text) => text };
	return {
		hasUI: true,
		mode: "rpc",
		cwd: process.env.PI_CODING_AGENT_DIR,
		sessionManager: {
			getBranch: () => store.branch,
			getEntries: () => store.branch,
			getSessionFile: () => "/tmp/smoke.jsonl",
		},
		ui: {
			setStatus: (key, text) => status.set(key, text),
			notify: (message, level) => notices.push({ message, level }),
			setWidget: (key, content) => {
				if (content === undefined) store.widgets.delete(key);
				else store.widgets.set(key, content);
			},
			custom: async (factory, options) => {
				let result;
				const component = await factory(fakeTui, theme, {}, (value) => (result = value));
				store.customCalls.push({ options, component });
				return result;
			},
			theme,
		},
	};
}

// Fake claude-code backend; models list is swappable per scenario.
let offered = [
	{ id: "claude-fable-5-1", name: "Fable" },
	{ id: "claude-opus-5-5", name: "Opus" },
];

const { api, hooks, commands, shortcuts, renderers, registeredTools, entries, sent, events, getTools } = makeApi();
const store = { status: new Map(), notices: [], widgets: new Map(), branch: [], customCalls: [] };
const ctx = makeCtx(store);

// Probe instrumentation for the in-flight scenarios: how many discoveries ran, and an optional
// gate that holds them open.
let listCalls = 0;
let gate;
events.on("subagents:backend-discover", () => {
	events.emit("subagents:backend-register", {
		version: 1,
		id: "claude-code",
		listModels: async () => {
			listCalls++;
			if (gate) await gate;
			if (offered instanceof Error) throw offered;
			return structuredClone(offered);
		},
		validate: () => {},
		create: () => {
			throw new Error("smoke test must not create workers");
		},
	});
});

modeExtension(api);

assert.ok(commands.has("mode"), "/mode registered");
assert.ok(shortcuts.has("alt+m"), "alt+m registered");
assert.ok(api.flags.has("major"), "--major flag registered");
assert.ok(!api.flags.has("mode"), "no --mode flag: pi core owns --mode (output mode)");
assert.ok(api.flags.has("minor"), "--minor flag registered");
assert.ok(!commands.has("mode-align"), "/mode-align is gone; the palette Mode category replaces it");
assert.ok(![...commands.keys()].some((name) => name.startsWith("mode-")), "no per-minor commands");
assert.ok(commands.has("align"), "/align registered");
assert.ok(shortcuts.has("alt+a"), "alt+a (align viewer) registered");

// The palette discovers the Mode category on demand; nothing announces at load.
const providers = [];
events.on("command-palette:category-register", (provider) => providers.push(provider));
events.emit("command-palette:category-discover", { version: 1 });
assert.equal(providers.length, 1, "exactly one provider answers discovery");
const provider = providers[0];
assert.equal(provider.version, 1);
assert.equal(provider.id, "mode");
assert.equal(provider.label, "Mode");
events.emit("command-palette:category-discover", { version: 2 });
assert.equal(providers.length, 1, "unknown discovery versions are ignored");

async function hook(name, ...args) {
	let result;
	for (const handler of hooks.get(name) ?? []) result = (await handler(...args, ctx)) ?? result;
	return result;
}
const beforeAgentStart = (event, c = ctx) => hooks.get("before_agent_start")[0](event, c);
// The prompt's minor blocks are the head's: fixed by the first run, rebuilt only after a compaction.
// Scenarios about how the blocks compose rebuild it first; the note scenarios below test toggles.
const rebuildHead = () => hook("session_compact", {});
// One run: its start (which fixes the head and steers in a pending note) and its settling.
const runStart = async () => {
	await hook("agent_start", {});
	await hook("agent_settled", {});
};

await hook("session_start", {});
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "normal status renders");

// before_agent_start is inert in normal mode
assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined);

// Toggle heavy with fable available
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate</accent>", "heavy status renders after probe");
const heavyPrompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(heavyPrompt.systemPrompt, /^base\n/);
assert.match(heavyPrompt.systemPrompt, /# Mode: delegate/);
assert.match(heavyPrompt.systemPrompt, /claude-fable-5-1/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.mode === "delegate"), "transcript marker appended");
const modeEntries = () => entries.filter((e) => e.type === "mode");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
	modeEntries().at(-1).data,
	{ mode: "delegate", active: { version: 1, mode: "delegate", strict: false, minorModes: [] } },
	"the switch entry carries the full post-switch snapshot",
);

// Strict mode hides edit/write from the orchestrator and restores on mode exit
await commands.get("mode").handler("strict on", ctx);
assert.deepEqual(getTools(), ["read", "bash", "grep"], "strict removed edit/write");
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>");
assert.deepEqual(
	modeEntries().at(-1).data,
	{ strict: true, active: { version: 1, mode: "delegate", strict: true, minorModes: [] } },
	"strict gets its own marker",
);
assert.match(
	renderers.get("mode")({ data: modeEntries().at(-1).data }, {}, ctx.ui.theme).render(80).join(""),
	/── strict on ──/,
	"strict marker renders",
);
await commands.get("mode").handler("normal", ctx);
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep"], "tools restored on leaving heavy");
assert.equal(store.status.get("mode"), "<dim>normal</dim>");

// Planner fallback: fable listed without medium → warning status + prompt names opus/high.
// (An alias the CLI's varying list omits is unverified and stays in use; see the routing tests.)
offered = [{ id: "claude-fable-5-1", name: "Fable", efforts: ["low"] }, { id: "claude-opus-5-5", name: "Opus" }];
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan · strict</warning>", "fallback reflected in status (strict is still on from the previous scenario)");
const fallbackPrompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(fallbackPrompt.systemPrompt, /- Planning & specs .* → backend "claude-code", model "claude-opus-5-5", effort "high"\. This is the configured FALLBACK/);
assert.match(store.notices.at(-1).message, /^Delegate routing:\nPlanning & specs: fallback claude-code · claude-opus-5-5 · high \(claude-fable-5-1 does not support effort "medium" \(supports: low\)\)$/, "fallback is disclosed");
assert.equal(store.notices.at(-1).level, "warning");

// Toggling via the shortcut flips modes
await shortcuts.get("alt+m").handler(ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "shortcut toggles back to normal");

// Minor mode align in normal mode: only the align block is appended
const alignHeader = /# Minor mode: align/;
await commands.get("mode").handler("align on", ctx);
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "align shows in normal status");
await rebuildHead();
const normalAlign = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(normalAlign.systemPrompt, /^base\n\n# Minor mode: align/);
assert.doesNotMatch(normalAlign.systemPrompt, /# Mode: delegate/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === true), "minor marker appended");
assert.deepEqual(
	modeEntries().at(-1).data.active,
	{ version: 1, mode: "normal", strict: true, minorModes: ["align"] },
	"minor switches snapshot the whole triple too",
);
// memory is web-only (§chat.memory/where): typed by hand it is refused, turned on only while Sova's
// server applies a switch for this very session (the sova:web-minor hook); off is never refused.
{
	const WEB_MINOR = Symbol.for("sova:web-minor");
	const count = modeEntries().length;
	await commands.get("mode").handler("memory on", ctx);
	assert.equal(modeEntries().length, count, "no hook: /mode memory on writes nothing");
	assert.match(store.notices.at(-1).message, /memory is turned on from a Sova chat's mode menu/);
	assert.doesNotMatch(store.status.get("mode"), /memory/);
	ctx.sessionManager.getSessionId = () => "chat-a";
	globalThis[WEB_MINOR] = (sid, minor) => sid === "chat-b" && minor === "memory";
	await commands.get("mode").handler("memory on", ctx);
	assert.equal(modeEntries().length, count, "a hook permitting another session permits nothing here");
	globalThis[WEB_MINOR] = (sid, minor) => sid === "chat-a" && minor === "memory";
	await commands.get("mode").handler("memory on", ctx);
	assert.deepEqual(modeEntries().at(-1).data.active.minorModes, ["align", "memory"], "the server's switch turns it on");
	delete globalThis[WEB_MINOR];
	await commands.get("mode").handler("memory off", ctx);
	assert.deepEqual(modeEntries().at(-1).data.active.minorModes, ["align"], "off needs no hook");
	delete ctx.sessionManager.getSessionId;
}
const markerText = renderers.get("mode")({ data: { minor: "align", on: true } }, {}, ctx.ui.theme).render(80).join("");
assert.match(markerText, /── align on ──/, "minor marker renders");
assert.match(renderers.get("mode")({ data: { mode: "delegate" } }, {}, ctx.ui.theme).render(80).join(""), /── mode → delegate ──/);

// Switching to heavy keeps align; the heavy block precedes the align block
offered = [
	{ id: "claude-fable-5-1", name: "Fable" },
	{ id: "claude-opus-5-5", name: "Opus" },
];
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate · strict · align</accent>");
const heavyAlign = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.ok(heavyAlign.indexOf("# Mode: delegate") > 0, "heavy block present");
assert.ok(heavyAlign.indexOf("# Mode: delegate") < heavyAlign.search(alignHeader), "heavy before align");

// /mode status reports minor modes
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: align$/m);

// Bare /mode align toggles off; prompt back to heavy only
await commands.get("mode").handler("align", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>");
await rebuildHead();
const heavyOnly = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.match(heavyOnly, /# Mode: delegate/);
assert.doesNotMatch(heavyOnly, alignHeader);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === false), "off marker appended");
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: \(none\)$/m);

// The spec minor mode goes through the same generic /mode toggle, after align in every order
await commands.get("mode").handler("spec on", ctx);
await commands.get("mode").handler("align on", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate · strict · align · spec</accent>");
await rebuildHead();
const heavyAlignSpec = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.ok(heavyAlignSpec.search(alignHeader) < heavyAlignSpec.indexOf("# Minor mode: spec"), "align before spec");
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "spec" && e.data.on === true), "spec marker appended");
assert.deepEqual(modeEntries().at(-1).data.active.minorModes, ["align", "spec"]);
await commands.get("mode").handler("spec", ctx);
await commands.get("mode").handler("align off", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>");
await rebuildHead();
assert.doesNotMatch((await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt, /# Minor mode: spec/);

// Palette rows: align toggles in place with a live marker; major rows switch mode
let rows = provider.items(ctx);
const alignRow = () => rows.find((row) => row.id === "mode:minor:align");
assert.equal(rows.find((row) => row.id === "mode:delegate").label, "✓ delegate");
assert.equal(alignRow().toggle.isOn(), false);
alignRow().toggle.toggle();
assert.equal(alignRow().toggle.isOn(), true, "marker reads live state after toggling");
assert.equal(store.status.get("mode"), "<accent>delegate · strict · align</accent>", "palette toggle turns align on");
alignRow().toggle.toggle();
assert.equal(alignRow().toggle.isOn(), false);
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>", "palette toggle turns align off");
await rows.find((row) => row.id === "mode:normal").run();
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "normal row switches mode");
rows = provider.items(ctx);
assert.equal(rows.find((row) => row.id === "mode:normal").label, "✓ normal", "fresh rows mark the new mode");
await rows.find((row) => row.id === "mode:delegate").run();
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>", "delegate row switches mode");

assert.equal(rows.at(-2).id, "mode:align:view", "the align viewer row is second to last");
assert.equal(rows.at(-1).id, "mode:default:save", "save as default is the last palette row");

// Bare /mode never toggles: with no palette to claim it, it explains instead
const tuiCtx = { ...ctx, mode: "tui" };
for (const bareCtx of [ctx, tuiCtx]) {
	const before = store.status.get("mode");
	await commands.get("mode").handler("", bareCtx);
	assert.equal(store.status.get("mode"), before, "bare /mode does not toggle");
	assert.equal(store.notices.at(-1).level, "warning");
	assert.match(store.notices.at(-1).message, /^mode: delegate$/m);
	assert.match(store.notices.at(-1).message, /Usage: \/mode/);
}

// With a palette claimant, bare /mode opens it at the Mode category and waits for it
const requests = [];
let release;
const off = events.on("command-palette:open", (request) => {
	requests.push(request);
	if (request.version === 1 && request.ctx.mode === "tui") request.claim(new Promise((resolve) => (release = resolve)));
});
const noticesBeforeOpen = store.notices.length;
let finished = false;
const bare = commands.get("mode").handler("", tuiCtx).then(() => (finished = true));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(requests.length, 1);
assert.deepEqual(requests[0].path, ["mode"]);
assert.equal(requests[0].ctx, tuiCtx);
assert.equal(finished, false, "handler awaits the claimed palette promise");
release();
await bare;
assert.equal(finished, true);
assert.equal(store.notices.length, noticesBeforeOpen, "no fallback warning when the palette opened");
await commands.get("mode").handler("", ctx);
assert.equal(requests.length, 1, "non-TUI bare /mode does not ask the palette");
off();

// Completions include minor modes
const completions = commands.get("mode").getArgumentCompletions("al").map((item) => item.value);
assert.deepEqual(completions, ["align", "align on", "align off"]);

// ── Scope: mode.json is only the default; every switch lives in this session ──
const stateFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode.json");
const readDefault = () => JSON.parse(readFileSync(stateFile, "utf8"));
const writeDefault = (mode, minorModes) => writeFileSync(stateFile, `${JSON.stringify({ version: 1, mode, strict: false, minorModes }, null, 2)}\n`);
assert.ok(!existsSync(stateFile), "no switch so far has written mode.json");

// /mode default is the only session-side writer, and writes no entry
await commands.get("mode").handler("delegate", ctx);
await commands.get("mode").handler("align on", ctx);
let entriesBefore = entries.length;
await commands.get("mode").handler("default", ctx);
assert.equal(entries.length, entriesBefore, "/mode default appends no transcript entry");
assert.deepEqual(readDefault(), { version: 1, mode: "delegate", strict: true, minorModes: ["align"] }, "/mode default writes this session's triple");
assert.match(store.notices.at(-1).message, /^Default mode saved: delegate · strict · align/);

// /mode status shows both scopes
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^mode: delegate$/m, "status names this session's mode");
assert.match(store.notices.at(-1).message, /^default: delegate · strict · align/m, "status names the default too");

// The palette's last row saves the default as well
writeDefault("normal", []);
await provider.items(ctx).at(-1).run();
assert.equal(readDefault().mode, "delegate", "the save-as-default row writes the file");

// A snapshot on the branch beats both the launch flags and the default
writeDefault("normal", []);
flagValues.major = "normal";
flagValues.minor = "none";
store.branch = [
	{ type: "custom", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: [] } } },
	{ type: "custom", customType: "mode", data: { mode: "delegate", active: { version: 1, mode: "delegate", strict: true, minorModes: ["align"] } } },
	{ type: "custom", customType: "mode", data: { minor: "align", on: true } }, // legacy marker: renders, never restores
	{ type: "custom", customType: "mode", data: { active: { version: 2, mode: "normal", strict: false, minorModes: [] } } }, // newer schema: skipped
	{ type: "custom", customType: "mode", data: null }, // malformed: skipped
];
entriesBefore = entries.length;
await hook("session_start", { reason: "startup" });
await flush();
assert.equal(store.status.get("mode"), "<accent>delegate · strict · align</accent>", "the newest usable snapshot wins over --major/--minor and the default");
assert.deepEqual(getTools(), ["read", "bash", "grep", "align"], "restoring strict heavy reapplies the strict tool set, and align (on in the snapshot) brings its tool");
assert.match((await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt, /# Mode: delegate/, "the restored mode shapes the prompt");
assert.equal(entries.length, entriesBefore, "restoring appends nothing");

// An empty branch adopts the default as it is now, and still writes nothing
writeDefault("normal", ["align"]);
store.branch = [];
delete flagValues.major;
delete flagValues.minor;
entriesBefore = entries.length;
await hook("session_start", { reason: "resume" });
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "a never-switched session follows the default");
assert.equal(entries.length, entriesBefore, "adopting the default appends no entry");
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep", "align"], "the default is not strict (and has align on, so its tool)");

// Launch flags apply on top of the default, on a first start only
flagValues.minor = "none";
await hook("session_start", { reason: "startup" });
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "--minor none clears the default's minor modes");
await hook("session_start", { reason: "resume" });
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "flags are a launch override, not a resume one");
delete flagValues.minor;

// --major picks the launch mode; the old --mode name is core's and is ignored here
flagValues.mode = "delegate";
await hook("session_start", { reason: "startup" });
assert.equal(store.status.get("mode"), "<accent>normal \u00b7 align</accent>", "--mode is pi core's output-mode flag, not a mode override");
delete flagValues.mode;
flagValues.major = "delegate";
await hook("session_start", { reason: "startup" });
assert.equal(store.status.get("mode"), "<accent>delegate \u00b7 align</accent>", "--major starts that launch in the mode");
flagValues.major = "normal";
await hook("session_start", { reason: "startup" });
flagValues.major = "delegate";
await hook("session_start", { reason: "startup" });
assert.equal(store.status.get("mode"), "<accent>delegate \u00b7 align</accent>", "--major delegate after normal starts in delegate again");
delete flagValues.major;

// /tree: no snapshot on the new branch falls back to the default; one with strict heavy retools
await hook("session_tree", { newLeafId: "a", oldLeafId: "b" });
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "a branch without a snapshot uses the default");
store.branch = [{ type: "custom", customType: "mode", data: { strict: true, active: { version: 1, mode: "delegate", strict: true, minorModes: [] } } }];
await hook("session_tree", { newLeafId: "c", oldLeafId: "a" });
await flush();
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>", "the branch's snapshot applies");
assert.deepEqual(getTools(), ["read", "bash", "grep"], "tree onto strict heavy removes edit/write");
store.branch = [];
await hook("session_tree", { newLeafId: "a", oldLeafId: "c" });
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep", "align"], "tree back off strict restores them (the default has align on)");

// Back to a plain default and a pristine branch for the scenarios below
writeDefault("normal", []);
await hook("session_start", { reason: "resume" });
assert.equal(store.status.get("mode"), "<dim>normal</dim>");

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

// ── Alignments: the align tool ───────────────────────────────────────────────
const ALIGN_WIDGET = "mode-align";
const alignTool = registeredTools.get("align");
assert.ok(alignTool, "the align tool is registered");
assert.equal(alignTool.executionMode, "sequential", "calls share state: one at a time");
assert.ok(alignTool.promptGuidelines.some((g) => /never as reply text/.test(g)), "the guideline survives a dropped mode section");

// The schema: one branch per op, its fields exactly the ones applyAlignCall takes, the required ones
// required, so pi's own argument check refuses a call missing one before execute runs.
{
	const { validateToolArguments } = await jiti.import("@earendil-works/pi-ai");
	const { ALIGN_OPS, ALIGN_OP_FIELDS } = await jiti.import(pathToFileURL(path.resolve(new URL("../align.ts", import.meta.url).pathname)).href);
	const branches = alignTool.parameters.properties.ops.items.anyOf;
	assert.deepEqual(branches.map((b) => b.properties.op.const), [...ALIGN_OPS], "one branch per op, in order");
	const minimal = {
		create: { title: "t", summary: "s" },
		import: { path: "/tmp/plan.json" },
		add: { findings: ["x"] },
		edit: { id: "a1", text: "x" },
		edit_question: { q: "q1", ask: "x" },
		edit_rejected: { id: "x1", why: "x" },
		edit_doc: { title: "x" },
		remove: { ids: ["f1"] },
		decide: { q: "q1", decision: "x" },
		accept: { qs: ["q1"] },
		accept_all: {},
		reopen: { q: "q1" },
		drop_question: { q: "q1", reason: "x" },
		drop_alignment: { reason: "x" },
		status: { to: "done" },
		exempt: { reason: "x" },
		get: {},
	};
	const check = (ops) => validateToolArguments(alignTool, { type: "toolCall", id: "v", name: "align", arguments: { ops } });
	for (const branch of branches) {
		const op = branch.properties.op.const;
		const { required, optional } = ALIGN_OP_FIELDS[op];
		assert.deepEqual([...branch.required].sort(), ["op", ...required].sort(), `${op}: required fields`);
		assert.deepEqual(Object.keys(branch.properties).sort(), ["op", ...required, ...optional].sort(), `${op}: fields`);
		assert.equal(branch.additionalProperties, false, `${op}: nothing else`);
		check([{ op, ...minimal[op] }]);
		for (const key of required) {
			const { [key]: _gone, ...rest } = minimal[op];
			assert.throws(() => check([{ op, ...rest }]), /Validation failed for tool "align"/, `${op} without ${key}`);
		}
	}
	assert.throws(() => check([{ op: "edit", id: "a1", newText: "x" }]), /Validation failed/, "an unknown field fails at the schema");
	assert.throws(() => check([{ op: "accept", qs: [] }]), /Validation failed/, "accept names at least one question");
	assert.throws(() => check([{ op: "edit_question", q: "q1" }]), /Validation failed/, "edit_question changes at least one field");
}
const resultEntry = (id, result, isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolCallId: `c${id}`, toolName: "align", content: result.content, details: result.details, isError },
});
const callAlign = async (params, c = ctx) => {
	const result = await alignTool.execute(`call-${Math.random()}`, params, undefined, undefined, c);
	store.branch.push(resultEntry(String(store.branch.length), result));
	return result;
};
const assistant = (text, stopReason = "stop", extra = []) => ({ role: "assistant", content: [{ type: "text", text }, ...extra], stopReason });

// Align off: the tool is out of the loadout, no widget, no note.
await commands.get("mode").handler("align off", ctx);
assert.ok(!getTools().includes("align"), "no align tool while align is off");
assert.ok(!store.widgets.has(ALIGN_WIDGET), "no widget while align is off");
await commands.get("align").handler("", ctx);
assert.match(store.notices.at(-1).message, /No alignments yet/);

// Align on: the tool joins the loadout; a create returns the snapshot and the echo.
await commands.get("mode").handler("align on", ctx);
assert.ok(getTools().includes("align"), "align on adds the tool");
store.branch = [];
const created = await callAlign({
	ops: [
		{
			op: "create",
			title: "Widget refresh",
			summary: "Keep the footer status after redraws.",
			findings: ["The footer redraws on model_select."],
			approach: ["Re-assert the status."],
			rejected: [{ option: "Global file", why: "one file for N sessions" }],
			questions: [
				{ topic: "Placement", ask: "Keep the widget above the editor?", recommendation: { choice: "above", why: "it is where the eye is" } },
				{ topic: "Key", ask: "Default key alt+a?", options: [{ label: "alt+a", tradeoff: "free today" }], recommendation: { choice: "alt+a", why: "free" } },
			],
		},
	],
});
assert.equal(created.details.doc.id, "al_1");
assert.match(created.content[0].text, /^al_1 "Widget refresh" · aligning · 2 of 2 open · v1 · created$/m);
assert.ok(store.widgets.has(ALIGN_WIDGET), "widget shows the open alignment");
assert.match(store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(80).join(""), /◇ align · al_1 2\/2 open/);
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^alignments: al_1 "Widget refresh" · aligning · 2 of 2 open$/m);

// A bad call fails whole, with a reason, and changes nothing.
await assert.rejects(alignTool.execute("bad", { ops: [{ op: "decide", q: "q9", decision: "x" }] }, undefined, undefined, ctx), /al_1 has no question q9.*Nothing was changed\./);

// The hidden note rides the user's prompt (never the system prompt) while something is open.
const withNote = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.equal(withNote.message.customType, "align-state");
assert.equal(withNote.message.display, false);
assert.match(withNote.message.content, /q1 Placement: Keep the widget above the editor\? \(rec: above\)/);
assert.doesNotMatch(withNote.systemPrompt, /Widget refresh/, "no alignment content in the system prompt");
const sectionsNote = { preamble: "base" };
const sectionResult = await beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { cwd: ctx.cwd, sections: sectionsNote } }, ctx);
assert.equal(sectionResult.message.customType, "align-state", "a sections host gets the note too");
assert.doesNotMatch(sectionsNote.mode, /Widget refresh/);

// Answers and the lifecycle go through ops; a second concern is its own document.
await callAlign({ ops: [{ op: "decide", q: "q1", decision: "above, like the status" }] });
const second = await callAlign({ ops: [{ op: "create", title: "Second concern", summary: "Another thing.", questions: [{ topic: "Scope", ask: "All of it?", recommendation: { choice: "yes", why: "simpler" } }] }] });
assert.equal(second.details.doc.id, "al_2");
await assert.rejects(alignTool.execute("x", { ops: [{ op: "accept_all" }] }, undefined, undefined, ctx), /doc is required while several are open/);
assert.match(store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(120).join(""), /al_1 1\/2 open · al_2 1\/1 open/);
const going = await callAlign({ doc: "al_1", ops: [{ op: "accept", qs: ["q2"] }, { op: "status", to: "implementing" }] });
assert.equal(going.details.line, "q2 accepted · → implementing");

// Widget lines never exceed the width
for (const width of [20, 40, 120]) {
	for (const line of store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(width)) {
		assert.ok(visibleWidth(line) <= width, `widget line fits ${width}`);
	}
}

// The TUI renderers: one dim call line, a compact result card.
const callLine = alignTool.renderCall({ doc: "al_1", ops: [{ op: "accept_all" }, { op: "accept", qs: ["q1", "q3"] }, { op: "drop_question", q: "q4", reason: "x" }, { op: "status", to: "implementing" }] }, ctx.ui.theme).render(200).join("");
assert.match(callLine, /◇ align al_1 · accept all · accept q1,q3 · drop q4 · → implementing/);
const importLine = alignTool.renderCall({ ops: [{ op: "import", path: "/tmp/p.json" }] }, ctx.ui.theme).render(100).join("");
assert.match(importLine, /◇ align · import \/tmp\/p\.json/);
// An older session's call rows still read.
const oldLine = alignTool.renderCall({ ops: [{ op: "create", fromFile: "/tmp/p.json" }, { op: "accept", q: "open" }, { op: "drop", why: "x" }] }, ctx.ui.theme).render(100).join("");
assert.match(oldLine, /◇ align · import \/tmp\/p\.json · accept open · drop/);
const card = alignTool.renderResult(going, { expanded: false, isPartial: false }, ctx.ui.theme).render(200).join("\n");
assert.match(card, /al_1 Widget refresh/);
assert.match(card, /implementing · all 2 decided · v3 · q2 accepted · → implementing/);
const full = alignTool.renderResult(going, { expanded: true, isPartial: false }, ctx.ui.theme).render(100).join("\n");
assert.match(full, /a\. \*\*alt\+a\*\* — free today[\s\S]*Recommended: a — \*\*alt\+a\*\*/, "expanded: the whole document");

// The settle nudge: once per run, only when the run made no align call and the reply plans in prose.
const plan = "The plan is ready.\n\n**Open questions, with my suggested answers:**\n1. **Cap:** 400\n2. **Group:** by worker\n\nShould I go ahead with those answers?";
const settle = () => hook("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" });
await hook("turn_end", { turnIndex: 0, message: assistant(plan), toolResults: [] });
const nudge = await settle();
assert.equal(nudge.continue, true);
assert.equal(nudge.entries.length, 1);
assert.equal(nudge.entries[0].customType, "align-nudge");
assert.equal(nudge.entries[0].display, false);
await hook("turn_end", { turnIndex: 1, message: assistant(plan), toolResults: [] });
assert.equal(await settle(), undefined, "never twice in one run");
await hook("agent_settled", {});
await hook("turn_end", { turnIndex: 2, message: assistant("Recorded it.", "toolUse", [{ type: "toolCall", id: "t", name: "align", arguments: {} }]), toolResults: [] });
await hook("tool_execution_end", { type: "tool_execution_end", toolCallId: "t", toolName: "align", isError: false, result: { details: { v: 1, doc: { id: "al_1" }, changes: [], line: "" } } });
await hook("turn_end", { turnIndex: 3, message: assistant(plan), toolResults: [] });
assert.equal(await settle(), undefined, "a run that recorded with align is not nudged");
await hook("agent_settled", {});
// A refused call, or a bare get, recorded nothing: the prose plan still gets its nudge.
await hook("turn_end", { turnIndex: 3, message: assistant("", "toolUse", [{ type: "toolCall", id: "t2", name: "align", arguments: {} }, { type: "toolCall", id: "t3", name: "align", arguments: {} }]), toolResults: [] });
await hook("tool_execution_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "align", isError: true, result: { content: [] } });
await hook("tool_execution_end", { type: "tool_execution_end", toolCallId: "t3", toolName: "align", isError: false, result: { details: undefined } });
await hook("turn_end", { turnIndex: 3, message: assistant(plan), toolResults: [] });
assert.equal((await settle())?.continue, true, "a failed align call does not count as recorded");
await hook("agent_settled", {});
// The final message has no text: the nudge judges it, not the plan an earlier turn wrote.
await hook("turn_end", { turnIndex: 3, message: assistant(plan), toolResults: [] });
await hook("turn_end", { turnIndex: 4, message: assistant("", "stop", []), toolResults: [] });
assert.equal(await settle(), undefined, "no stale reply text");
await hook("agent_settled", {});
// Options offered back to a user who asked a question answer it; the same reply to a work request is a decision.
const options = "The two options are:\n- A: a flag\n- B: a subcommand\n\nWhich do you prefer?";
await beforeAgentStart({ systemPrompt: "base", prompt: "What are my options for the export?" }, ctx);
await hook("turn_end", { turnIndex: 5, message: assistant(options), toolResults: [] });
assert.equal(await settle(), undefined, "a choice answering the user's question");
await hook("agent_settled", {});
await beforeAgentStart({ systemPrompt: "base", prompt: "Add an export." }, ctx);
await hook("turn_end", { turnIndex: 6, message: assistant(options), toolResults: [] });
assert.equal((await settle())?.continue, true, "the same choice after a work request");
await hook("agent_settled", {});
await hook("turn_end", { turnIndex: 4, message: assistant("Lane E is finished; lanes B–D are still running."), toolResults: [] });
assert.equal(await settle(), undefined, "a report is not nudged");
await hook("agent_settled", {});
await commands.get("mode").handler("align off", ctx);
await hook("turn_end", { turnIndex: 5, message: assistant(plan), toolResults: [] });
assert.equal(await settle(), undefined, "align off: no nudge");
await hook("agent_settled", {});
await commands.get("mode").handler("align on", ctx);

// /align in rpc: notifies the markdown; in tui: opens an overlay viewer that steps between alignments
await commands.get("align").handler("", ctx);
assert.match(store.notices.at(-1).message, /## al_2: Second concern/);
assert.equal(store.customCalls.length, 0, "no overlay outside tui");
await commands.get("align").handler("", tuiCtx);
assert.equal(store.customCalls.length, 1, "overlay opened in tui");
assert.equal(store.customCalls[0].options.overlay, true);
const viewer = store.customCalls[0].component;
const viewerLines = viewer.render(80);
assert.ok(viewerLines.every((line) => visibleWidth(line) <= 80), "viewer lines fit the width");
assert.ok(viewerLines[0].includes("al_1") && viewerLines[0].includes("2/2"), "opens on the last-touched open alignment, of two");
viewer.handleInput("\x1b[D");
assert.ok(viewer.render(80)[0].includes("al_2"), "← steps to the other alignment");
viewer.handleInput("q");
await shortcuts.get("alt+a").handler(tuiCtx);
assert.equal(store.customCalls.length, 2, "shortcut opens the viewer too");
store.customCalls[1].component.handleInput("\x1b");

// /align export writes the open alignments as markdown
const exportPath = path.join(process.env.PI_CODING_AGENT_DIR, "out", "a.md");
await commands.get("align").handler(`export ${exportPath}`, ctx);
const exported = readFileSync(exportPath, "utf8");
assert.match(exported, /## al_1: Widget refresh/);
assert.match(exported, /## al_2: Second concern/);
await commands.get("align").handler("clear", ctx);
assert.match(store.notices.at(-1).message, /Unknown argument "clear"/, "nothing clears the tool's state: the agent drops an alignment");

// session_start and session_tree fold the branch: a rewind lands on the earlier state
const branchSoFar = [...store.branch];
store.branch = [
	// The session's own align toggle: without it the restore would take align from the default (off).
	{ type: "custom", customType: "mode", data: { minor: "align", on: true, active: { version: 1, mode: "normal", strict: false, minorModes: ["align"] } } },
	...branchSoFar.slice(0, 2),
];
await hook("session_tree", { newLeafId: "x", oldLeafId: "y" });
assert.match(store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(80).join(""), /◇ align · al_1 1\/2 open/, "the rewound branch's state");
assert.ok(!store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(80).join("").includes("al_2"));
await commands.get("mode").handler("align off", ctx);
assert.ok(!store.widgets.has(ALIGN_WIDGET), "widget hidden when align is off");
await commands.get("align").handler("status", ctx);
assert.match(store.notices.at(-1).message, /al_1 "Widget refresh" · aligning · 1 of 2 open/, "alignments kept while align is off");
await commands.get("mode").handler("align on", ctx);
assert.ok(store.widgets.has(ALIGN_WIDGET), "widget back when align is on");

// An older session's align-doc entries: read-only, in the viewer and the marker renderer; no widget.
const legacyData = { version: 1, doc: { version: 1, title: "Old doc", markdown: "## Alignment: Old doc\n### Open questions\n- [x] **1. A:** yes\n- [ ] **2. B:** ?", questions: [{ n: 1, text: "A", checked: true }, { n: 2, text: "B", checked: false }], revision: 2, capturedAt: "2026-09-20T00:00:00.000Z" } };
store.branch = [
	{ type: "custom", customType: "mode", data: { minor: "align", on: true, active: { version: 1, mode: "normal", strict: false, minorModes: ["align"] } } },
	{ type: "custom", customType: "align-doc", data: legacyData },
];
await hook("session_start", { reason: "resume" });
assert.ok(!store.widgets.has(ALIGN_WIDGET), "a legacy doc counts toward nothing");
await commands.get("align").handler("status", ctx);
assert.match(store.notices.at(-1).message, /older doc, read-only: v2 · questions open · 1\/2 settled/);
await commands.get("align").handler("", tuiCtx);
const legacyViewer = store.customCalls.at(-1).component;
assert.ok(legacyViewer.render(80).some((line) => line.includes("☑") || line.includes("☐")), "legacy markdown keeps its checklist glyphs");
assert.ok(legacyViewer.render(80)[0].includes("read-only"));
legacyViewer.handleInput("q");
assert.match(renderers.get("align-doc")({ data: legacyData }, {}, ctx.ui.theme).render(80).join(""), /alignment v2 · questions open · 1\/2 settled/);
assert.match(renderers.get("align-doc")({ data: { version: 1, doc: null } }, {}, ctx.ui.theme).render(80).join(""), /alignment cleared/);

// /align on|off aliases the minor toggle
await commands.get("align").handler("off", ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "/align off turns the minor off");
assert.ok(!getTools().includes("align"), "/align off removes the tool");

// ── Prompt delivery: diffed sections on pi ≥ 0.86, whole-prompt append on 0.85 hosts ──
await commands.get("mode").handler("delegate", ctx);
const promptSections = { preamble: "base" };
const sectionHost = () => ({ systemPrompt: "base", systemPromptOptions: { cwd: ctx.cwd, sections: promptSections } });
assert.equal(await beforeAgentStart(sectionHost(), ctx), undefined, "a sections host gets no systemPrompt return");
assert.match(promptSections.mode, /# Mode: delegate/, "the block lands in the mode section");
assert.deepEqual(Object.keys(promptSections), ["preamble", "mode"], "no other section is touched");

// Back to normal: the section must go, or the replayed prompt keeps the heavy instruction live.
await commands.get("mode").handler("normal", ctx);
assert.equal(await beforeAgentStart(sectionHost(), ctx), undefined);
assert.ok(!("mode" in promptSections), "normal mode deletes the section");
assert.deepEqual(promptSections, { preamble: "base" });

// A 0.85 host has no sections at all: the whole-prompt append is unchanged.
const legacyHost = () => ({ systemPrompt: "base", systemPromptOptions: { cwd: ctx.cwd } });
assert.equal(await beforeAgentStart(legacyHost(), ctx), undefined, "normal mode appends nothing on a 0.85 host");
await commands.get("mode").handler("delegate", ctx);
assert.match((await beforeAgentStart(legacyHost(), ctx)).systemPrompt, /^base\n\n# Mode: delegate/, "0.85 hosts still get the appended prompt");
await commands.get("mode").handler("normal", ctx);

// ── Delegate routing: /mode delegate, settings re-read per turn, policy, discovery failure ──
const delegateFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode-delegate.json");
// The legacy files reach a session through subagent-profiles.json, seeded from them when it is
// absent: these tests edit a legacy file, then drop the profiles file so the next read seeds again.
const profilesFile = path.join(process.env.PI_CODING_AGENT_DIR, "subagent-profiles.json");
const profilesDefaultFile = path.join(process.env.PI_CODING_AGENT_DIR, "subagent-profiles-default.json");
const reseed = () => { rmSync(profilesFile, { force: true }); rmSync(profilesDefaultFile, { force: true }); };
const policyFile = path.join(process.env.PI_CODING_AGENT_DIR, "model-policy.json");
const writeRouting = (mutate) => {
	const settings = { version: 1, profiles: {
		planning: { primary: { backend: "claude-code", model: "claude-fable-5-1", effort: "medium" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" } },
		investigation: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" }, fallback: null },
		routine: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" }, fallback: null },
		complex: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null },
	} };
	mutate(settings);
	// Atomic replace, the way Sova writes it: a new inode, so the per-turn stat sees the change.
	writeFileSync(`${delegateFile}.tmp`, JSON.stringify(settings));
	renameSync(`${delegateFile}.tmp`, delegateFile);
	reseed();
};
offered = [
	{ id: "claude-fable-5-1", name: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "claude-opus-5-5", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
];
const delegateEntriesBefore = modeEntries().length;
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate</accent>", "/mode delegate selects delegate");
assert.deepEqual(modeEntries().at(-1).data, { mode: "delegate", active: { version: 1, mode: "delegate", strict: false, minorModes: [] } }, "and writes the canonical name");
assert.equal(modeEntries().length, delegateEntriesBefore + 1);
assert.ok(!existsSync(delegateFile), "no switch writes the routing file");
let turn = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.match(turn, /- Routine implementation .* → backend "claude-code", model "claude-opus-5-5", effort "low"; no fallback — if it fails, ask the user\./, "defaults without a file");
assert.match(turn, /- Investigation .* → backend "claude-code", model "claude-opus-5-5", effort "low"; no fallback — if it fails, ask the user\./);

// An edit to the routing reaches this already-delegate session at its next turn boundary.
const piCtx = {
	...ctx,
	modelRegistry: { getAvailable: () => [{ provider: "zai", id: "glm-5.3", name: "GLM", api: "openai-completions", reasoning: true, input: ["text"] }] },
};
writeRouting((s) => {
	s.profiles.routine = { primary: { backend: "pi", model: "zai/glm-5.3", effort: "high" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" } };
});
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Routine implementation .* → backend "pi", model "zai\/glm-5.3", effort "high"; fallback backend "claude-code", model "claude-opus-5-5", effort "low"\./, "re-read at the turn boundary");
await flush();
await flush();
await commands.get("mode").handler("status", piCtx);
assert.match(store.notices.at(-1).message, /^  Routine implementation: pi · zai\/glm-5.3 · high, fallback claude-code · claude-opus-5-5 · low — using primary$/m, "the background probe verified the pi tuple");
assert.match(store.notices.at(-1).message, /^delegate routing:$/m);
assert.match(store.notices.at(-1).message, /^subagent profile: My setup \(the default\)$/m, "the seeded profile is the default");

// Normal mode never reads the routing: the prompt is untouched whatever the file says.
await commands.get("mode").handler("normal", ctx);
assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined, "normal mode is unaffected");
await commands.get("mode").handler("delegate", piCtx);

// The subagent policy is re-read per turn too: a denied primary reroutes to the configured fallback, disclosed.
writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: ["claude-code/claude-fable-5-1"] }));
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Planning & specs .* → backend "claude-code", model "claude-opus-5-5", effort "high"\. This is the configured FALLBACK: .* is disabled as a subagent model by user settings\./);
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan</warning>");

// With the provider denied outright nothing is routed around it: every claude-only profile asks.
writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: [], disabledModels: [], subagentDisabledProviders: ["claude-code"], subagentDisabledModels: [] }));
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Complex implementation .* → NO AVAILABLE WORKER \(Backend claude-code is disabled for subagents by user settings\..*; no fallback is set\)/);
assert.match(turn, /- Routine implementation .* → backend "pi", model "zai\/glm-5.3"/, "the pi primary is unaffected");
assert.equal(store.status.get("mode"), "<warning>delegate · ask:plan,investigate,complex</warning>");
rmSync(policyFile);

// Discovery that fails is not absence: the primary stays in use, unverified, and no fallback is claimed.
offered = new Error("Claude model discovery timed out");
writeRouting((s) => {
	s.profiles.planning.primary.effort = "high"; // a changed routing re-probes
});
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
await flush();
await flush();
assert.equal(store.status.get("mode"), "<accent>delegate</accent>", "a failed discovery degrades nothing");
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Planning & specs .* → backend "claude-code", model "claude-fable-5-1", effort "high"; fallback/);
await commands.get("mode").handler("status", piCtx);
assert.match(store.notices.at(-1).message, /^  Planning & specs: .* — using primary \(not verified\)$/m);

// Discovered but without the configured effort: unavailable, so the fallback, disclosed.
offered = [
	{ id: "claude-fable-5-1", name: "Fable", efforts: ["low", "medium"] },
	{ id: "claude-opus-5-5", name: "Opus", efforts: ["low", "medium", "high"] },
];
writeRouting(() => {});
writeRouting((s) => {
	s.profiles.planning.primary.effort = "max";
});
await beforeAgentStart({ systemPrompt: "base" }, piCtx);
await flush();
await flush();
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan</warning>", "an unsupported effort is not clamped silently");
assert.match(store.notices.at(-1).message, /Planning & specs: fallback claude-code · claude-opus-5-5 · high \(claude-fable-5-1 does not support effort "max"/, "a routing change that degrades a profile is announced");
rmSync(delegateFile);
reseed();
await commands.get("mode").handler("normal", ctx);

// ── A turn during the entry probe joins it: no restart, and the entry's fallback notice survives ──
offered = [{ id: "claude-fable-5-1", name: "Fable", efforts: ["low"] }, { id: "claude-opus-5-5", name: "Opus" }]; // planning will be on its fallback
let releaseProbe;
gate = new Promise((resolve) => (releaseProbe = resolve));
listCalls = 0;
const noticesBeforeEntry = store.notices.length;
const entering = commands.get("mode").handler("delegate", ctx); // awaits its probe, which is gated
await flush();
assert.equal(listCalls, 1, "entering delegate started one probe");
await beforeAgentStart({ systemPrompt: "base" }, ctx);
await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.equal(listCalls, 1, "turns during the probe join it instead of restarting it");
releaseProbe();
gate = undefined;
await entering;
await flush();
assert.ok(
	store.notices.slice(noticesBeforeEntry).some((n) => n.level === "warning" && /^Delegate routing:\nPlanning & specs: fallback/.test(n.message)),
	"the fallback notice the switch asked for is delivered, though turns joined the probe",
);
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan</warning>");
await beforeAgentStart({ systemPrompt: "base" }, ctx);
await flush();
assert.equal(listCalls, 1, "a fresh discovery is not repeated on the next turn");
await commands.get("mode").handler("normal", ctx);

// ── A backend that wasn't loaded is asked again at the next turn, not after 10 minutes ──
{
	const late = makeApi();
	let loaded = false;
	late.events.on("subagents:backend-discover", () => {
		if (!loaded) return;
		late.events.emit("subagents:backend-register", { version: 1, id: "claude-code", listModels: async () => [{ id: "claude-fable-5-1", name: "F" }, { id: "claude-opus-5-5", name: "O" }], validate() {}, create() {} });
	});
	const lateStore = { status: new Map(), notices: [], widgets: new Map(), branch: [], customCalls: [] };
	const lateCtx = makeCtx(lateStore);
	modeExtension(late.api);
	const lateStart = (event) => late.hooks.get("before_agent_start")[0](event, lateCtx);
	await late.commands.get("mode").handler("delegate", lateCtx);
	assert.equal(lateStore.status.get("mode"), "<warning>delegate · ask:plan,investigate,routine,complex</warning>", "no backend loaded: every claude profile asks");
	assert.match((await lateStart({ systemPrompt: "base" })).systemPrompt, /- Routine implementation .* → NO AVAILABLE WORKER \(the claude-code backend is not loaded/);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 60)); // a missing backend's probe waits 25ms for registration
	await settle(); // that turn's own re-ask (still not loaded) lands
	loaded = true; // e.g. the claude-code extension came up after a /reload of its own
	await lateStart({ systemPrompt: "base" }); // this turn re-asks in the background
	await settle();
	assert.equal(lateStore.status.get("mode"), "<accent>delegate</accent>", "the next turn found the backend");
	assert.match((await lateStart({ systemPrompt: "base" })).systemPrompt, /- Routine implementation .* → backend "claude-code", model "claude-opus-5-5", effort "low"/);
}

// ── Spec writer: re-read at the turn boundary and probed while spec is on, outside delegate too ──
{
	const specFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode-spec.json");
	const writeSpec = (settings) => {
		writeFileSync(`${specFile}.tmp`, JSON.stringify(settings));
		renameSync(`${specFile}.tmp`, specFile);
		reseed();
	};
	const all = ["low", "medium", "high", "xhigh", "max"];
	offered = [{ id: "claude-fable-5-1", name: "Fable", efforts: all }, { id: "claude-opus-5-5", name: "Opus", efforts: ["low"] }];
	await commands.get("mode").handler("normal", ctx);
	await commands.get("mode").handler("spec on", ctx);
	await rebuildHead();
	listCalls = 0;
	let prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /# Minor mode: spec/);
	assert.doesNotMatch(prompt, /Spec writer:/, "no writer set: no paragraph, the session writes the spec itself");
	await flush();
	assert.equal(listCalls, 0, "no writer, not in delegate: nothing to probe");

	writeSpec({ version: 1, writer: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: { backend: "claude-code", model: "claude-fable-5-1", effort: "high" } } });
	const noticesBefore = store.notices.length;
	prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /# Minor mode: spec\n[\s\S]*\n\nSpec writer: .* → backend "claude-code", model "claude-opus-5-5", effort "medium";/, "re-read at the turn boundary, on the last discovery until this probe lands");
	assert.doesNotMatch(prompt, /# Mode: delegate/, "the writer needs no delegate");
	await flush();
	await flush();
	assert.equal(listCalls, 1, "outside delegate, spec on probes the writer's backend");
	assert.equal(store.status.get("mode"), "<warning>normal · spec · writer:fallback</warning>");
	assert.ok(
		store.notices.slice(noticesBefore).some((n) => n.level === "warning" && /^Spec writer: fallback claude-code · claude-fable-5-1 · high \(claude-opus-5-5 does not support effort "medium"/.test(n.message)),
		"a writer on its fallback is announced",
	);
	prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /Spec writer: .* → backend "claude-code", model "claude-fable-5-1", effort "high"\. This is the configured FALLBACK/);
	await commands.get("mode").handler("status", ctx);
	assert.match(store.notices.at(-1).message, /^spec writer: claude-code · claude-opus-5-5 · medium, fallback claude-code · claude-fable-5-1 · high — using FALLBACK/m);

	// Spec off mid-session: the head keeps its spec block, writer paragraph included, byte for byte;
	// the note says it no longer applies. Rebuilt (as after a compaction): no block, no paragraph.
	await commands.get("mode").handler("spec off", ctx);
	assert.equal((await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt, prompt, "a minor toggle leaves the prompt alone");
	assert.match(sent.at(-1).message.content, /^Mode change: the user turned the spec minor mode off\. Its instructions \(the "# Minor mode: spec" block in your system prompt\) no longer apply/);
	await rebuildHead();
	assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined);
	assert.equal(store.status.get("mode"), "<dim>normal</dim>");
	assert.ok(existsSync(specFile), "nothing here writes or removes the writer file");
	rmSync(specFile);
	reseed();
}

// ── The host's base prompt sections: kept in step, so a turn an extension's message starts reads the same prompt ──
// pi builds a user turn's prompt in before_agent_start; a turn started by sendMessage({triggerTurn})
// skips it and rebuilds later requests from the base options. Only a command context exposes them.
{
	let base = { sections: { preamble: "base" } };
	const commandCtx = { ...ctx, getSystemPromptOptions: () => base };
	await rebuildHead();
	await commands.get("mode").handler("align on", commandCtx);
	assert.match(base.sections.mode, /# Minor mode: align/, "a switch through /mode writes the block into the host's base sections");
	assert.deepEqual(Object.keys(base.sections), ["preamble", "mode"], "no other base section is touched");

	// pi replaces the base object when tools change; the run start re-syncs whichever object is current.
	base = { sections: { preamble: "rebuilt" } };
	await runStart();
	assert.match(base.sections.mode, /# Minor mode: align/, "agent_start writes the block into a rebuilt base");

	// A user turn: the block goes into the turn's own sections and into the base alike.
	base = { sections: { preamble: "rebuilt again" } };
	const turnSections = { preamble: "turn" };
	await beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { cwd: ctx.cwd, sections: turnSections } }, ctx);
	assert.equal(base.sections.mode, turnSections.mode, "before_agent_start syncs the base with the block the turn was built with");

	// Off again, through a plain context (a shortcut): the adopted getter still reaches the base.
	await shortcuts.get("alt+m").handler(ctx); // normal → delegate
	assert.match(base.sections.mode, /# Mode: delegate/, "a shortcut switch reaches the base through the adopted getter");
	await shortcuts.get("alt+m").handler(ctx); // back to normal
	assert.match(base.sections.mode, /# Minor mode: align/);
	await rebuildHead();
	await commands.get("mode").handler("align off", ctx);
	assert.ok(!("mode" in base.sections), "no block: the base section is deleted");
	assert.deepEqual(base.sections, { preamble: "rebuilt again" });

	// A getter whose runner is gone throws; it is dropped and nothing else fails.
	const stale = { ...ctx, getSystemPromptOptions: () => { throw new Error("extension runner is no longer active"); } };
	await commands.get("mode").handler("align on", stale);
	await runStart();
	assert.ok(!("mode" in base.sections), "a dead getter is dropped, not retried");
	await commands.get("mode").handler("align off", ctx);
	await rebuildHead();
	assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined, "back to normal with no host: inert");
}

// ── Workers (§chat.mode-menu/workers): what a worker gets, published on the bus; the worker role ──
{
	const { composeWorkerPrompt } = await jiti.import(pathToFileURL(path.resolve(new URL("../prompt.ts", import.meta.url).pathname)).href);
	const published = [];
	const off = events.on("mode:worker", (e) => published.push(e));
	const last = () => published.at(-1);
	await commands.get("mode").handler("normal", ctx);
	await commands.get("mode").handler("align on", ctx);
	events.emit("mode:worker-discover", { version: 1 });
	assert.deepEqual(last(), { version: 1, minorModes: [] }, "align alone: nothing reaches a worker, and discover is answered");
	events.emit("mode:worker-discover", { version: 2 });
	const count = published.length;
	await commands.get("mode").handler("spec on", ctx);
	assert.equal(published.length, count + 1, "a minor switch publishes");
	assert.deepEqual(last().minorModes, ["spec"]);
	assert.equal(last().prompt, composeWorkerPrompt({ minorModes: ["spec"] }), "the worker form: spec block plus note");
	assert.doesNotMatch(last().prompt, /# Minor mode: align|# Mode: delegate|Spec writer:/);
	await commands.get("mode").handler("delegate", ctx);
	assert.equal(last().prompt, composeWorkerPrompt({ minorModes: ["spec"] }), "a major switch changes nothing a worker gets");
	await commands.get("mode").handler("normal", ctx);
	await commands.get("mode").handler("spec off", ctx);
	assert.deepEqual(last(), { version: 1, minorModes: [] }, "spec off: no prompt");
	await commands.get("mode").handler("vis on", ctx);
	assert.deepEqual(last(), { version: 1, minorModes: [] }, "vis on publishes, and reaches no worker");
	await commands.get("mode").handler("spec on", ctx);
	assert.deepEqual(last().minorModes, ["spec"], "vis beside spec: only spec");
	assert.doesNotMatch(last().prompt, /# Minor mode: vis/);
	const beforeSync = published.length;
	await commands.get("mode").handler("sync", ctx);
	assert.equal(published.length, beforeSync + 1, "/mode sync (Sova's, at every chat open) republishes");
	assert.deepEqual(last().minorModes, ["spec"]);
	await commands.get("mode").handler("spec off", ctx);
	await commands.get("mode").handler("vis off", ctx);
	await hook("session_start", { reason: "resume" });
	assert.deepEqual(last(), { version: 1, minorModes: [] }, "a restore publishes the resolved state");
	await commands.get("mode").handler("align off", ctx);
	off();

	// A worker on its worktree's own agent dir: the marker (loaded first) says so, and a fork copied
	// the parent's delegate + strict + align snapshot onto its branch; mode-spec.json names a writer.
	const specFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode-spec.json");
	writeFileSync(specFile, JSON.stringify({ version: 1, writer: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null } }));
	reseed();
	const forkedBranch = [{ type: "custom", customType: "mode", data: { mode: "delegate", active: { version: 1, mode: "delegate", strict: true, minorModes: ["align", "vis"] } } }];
	const saved = { ...flagValues };
	flagValues.major = "normal";
	flagValues.minor = "spec,vis"; // vis is not worker-scope: the worker role drops it
	const load = (asWorker) => {
		const w = makeApi();
		if (asWorker) w.events.on("subagents:worker-discover", () => w.events.emit("subagents:worker", { version: 1 }));
		modeExtension(w.api);
		const wStore = { status: new Map(), notices: [], widgets: new Map(), branch: forkedBranch, customCalls: [] };
		return { ...w, ctx: makeCtx(wStore), wStore };
	};
	const worker = load(true);
	for (const fn of worker.hooks.get("session_start")) await fn({ reason: "startup" }, worker.ctx);
	assert.equal(worker.wStore.status.get("mode"), "<accent>normal · spec</accent>", "the copied snapshot is ignored: normal, spec, not strict");
	assert.deepEqual(worker.getTools(), ["read", "bash", "edit", "write", "grep"], "strict never strips a worker's edit/write");
	const block = (await worker.hooks.get("before_agent_start")[0]({ systemPrompt: "base" }, worker.ctx)).systemPrompt;
	assert.equal(block, `base\n\n${composeWorkerPrompt({ minorModes: ["spec"] })}`, "the worker form, with no writer paragraph although one is set");
	// The full worktree-config mode extension writes no spec ledger, even with an old parent's ledger env set.
	const ledgerFixture = mkdtempSync(path.join(tmpdir(), "mode-worker-ledger-"));
	const oldLedger = process.env.SOVA_SPEC_LEDGER;
	try {
		const ledger = path.join(ledgerFixture, "parent.jsonl");
		const repo = path.join(ledgerFixture, "repo");
		mkdirSync(repo);
		const git = (...args) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
		git("init", "-qb", "main");
		writeFileSync(path.join(repo, "code.txt"), "before\n");
		git("add", "."); git("commit", "-qm", "base");
		worker.ctx.cwd = repo;
		worker.ctx.sessionManager.getSessionId = () => "worker-fixture";
		worker.ctx.sessionManager.getHeader = () => undefined;
		process.env.SOVA_SPEC_LEDGER = ledger;
		for (const fn of worker.hooks.get("agent_start")) await fn({}, worker.ctx);
		writeFileSync(path.join(repo, "code.txt"), "after\n");
		const call = { toolCallId: "worker-commit", toolName: "bash", input: { command: "git commit -qam work" } };
		for (const fn of worker.hooks.get("tool_call")) await fn(call, worker.ctx);
		git("commit", "-qam", "work");
		for (const fn of worker.hooks.get("tool_result")) await fn({ ...call, content: [], isError: false }, worker.ctx);
		assert.ok(!existsSync(ledger), "a worker's commit is written to no ledger");
	} finally { if (oldLedger === undefined) delete process.env.SOVA_SPEC_LEDGER; else process.env.SOVA_SPEC_LEDGER = oldLedger; rmSync(ledgerFixture, { recursive: true, force: true }); }
	// The same branch and flags without the marker: the snapshot wins, as before (the regression's other side).
	const parent = load(false);
	for (const fn of parent.hooks.get("session_start")) await fn({ reason: "startup" }, parent.ctx);
	assert.match(parent.wStore.status.get("mode"), /delegate/, "without the marker the fork's snapshot is restored");
	for (const [k, v] of Object.entries(saved)) flagValues[k] = v;
	for (const k of Object.keys(flagValues)) if (!(k in saved)) delete flagValues[k];
	rmSync(specFile);
	reseed();
}

// ── /mode sync: adopt the host and re-apply the session's block, and nothing else ──
// Sova runs it at every chat open, on a session whose mode session_start already restored.
{
	await rebuildHead();
	await commands.get("mode").handler("spec on", ctx);
	const entriesBefore = entries.length;
	const noticesBefore = store.notices.length;
	const statusBefore = store.status.get("mode");
	const base = { sections: { preamble: "fresh runtime" } };
	await commands.get("mode").handler("sync", { ...ctx, getSystemPromptOptions: () => base });
	assert.match(base.sections.mode, /# Minor mode: spec/, "sync writes the session's block into the base");
	assert.equal(entries.length, entriesBefore, "sync appends no entry");
	assert.equal(store.notices.length, noticesBefore, "sync notifies nothing");
	assert.equal(store.status.get("mode"), statusBefore, "sync leaves the status alone");
	const block = base.sections.mode;
	await commands.get("mode").handler("sync", { ...ctx, getSystemPromptOptions: () => base });
	assert.equal(base.sections.mode, block, "a second sync changes no byte");
	await runStart();
	assert.equal(base.sections.mode, block, "a run start keeps the same bytes");
	assert.ok(commands.get("mode").getArgumentCompletions("sy").some((item) => item.value === "sync"), "sync is completed");
	await commands.get("mode").handler("spec off", ctx);
	assert.equal(base.sections.mode, block, "a minor toggle after the run started keeps the same bytes too");
	await commands.get("mode").handler("delegate", ctx);
	assert.match(base.sections.mode, /# Mode: delegate/, "a later switch still reaches the base sync adopted");
	await commands.get("mode").handler("normal", ctx);
}

// ── A minor toggle keeps the prompt head: the switch reaches the model as a hidden note ──
// The head's minor blocks are fixed by the first run and rebuilt only after a compaction, so the
// cached prefix survives a toggle on every provider. Each fake here records, in order, what pi would
// put on the branch: the extension's entries and the notes it delivers.
{
	const { VIS_INSTRUCTIONS, SPEC_INSTRUCTIONS, VIS_KINDS, visGuide } = await jiti.import(pathToFileURL(path.resolve(new URL("../minor.ts", import.meta.url).pathname)).href);
	const branch = [{ type: "custom", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: ["spec"] } } }];
	const open = () => {
		const host = makeApi();
		const hostStore = { status: new Map(), notices: [], widgets: new Map(), branch, customCalls: [] };
		const hostCtx = makeCtx(hostStore);
		const { appendEntry, sendMessage } = host.api;
		host.api.appendEntry = (type, data) => {
			appendEntry(type, data);
			branch.push({ type: "custom", customType: type, data });
		};
		host.api.sendMessage = (message, options) => {
			sendMessage(message, options);
			branch.push({ type: "custom_message", ...message });
		};
		modeExtension(host.api);
		const fire = async (name, event = {}) => {
			let result;
			for (const handler of host.hooks.get(name) ?? []) result = (await handler(event, hostCtx)) ?? result;
			return result;
		};
		/** A run a user prompt starts: its mode section, and the notes it delivered. */
		const userTurn = async () => {
			const sections = { preamble: "base" };
			const sentBefore = host.sent.length;
			await host.hooks.get("before_agent_start")[0]({ systemPrompt: "base", prompt: "go", systemPromptOptions: { cwd: hostCtx.cwd, sections } }, hostCtx);
			await fire("agent_start");
			await fire("agent_settled");
			return { section: sections.mode, notes: host.sent.slice(sentBefore) };
		};
		/** A run an extension's message starts: no before_agent_start. */
		const messageTurn = async () => {
			const sentBefore = host.sent.length;
			await fire("agent_start");
			await fire("agent_settled");
			return host.sent.slice(sentBefore);
		};
		const mode = (args) => host.commands.get("mode").handler(args, hostCtx);
		return { host, fire, userTurn, messageTurn, mode };
	};

	let session = open();
	await session.fire("session_start", { reason: "startup" });
	const first = await session.userTurn();
	const head = first.section;
	assert.match(head, /# Minor mode: spec/, "the first run builds the head from the active modes");
	assert.doesNotMatch(head, /# Minor mode: vis/);
	assert.deepEqual(first.notes, [], "nothing to tell on the first run");
	const hasGuideTool = () => session.host.getTools().includes("vis_guide");
	assert.ok(!hasGuideTool(), "no vis_guide while vis is off");
	// The tool: in-process, kind is exactly the listed kinds, and a lookup is the shared rules then the kind's file.
	const guideTool = session.host.registeredTools.get("vis_guide");
	assert.deepEqual(guideTool.parameters.properties.kind.enum, [...VIS_KINDS]);
	const looked = await guideTool.execute("t1", { kind: "wireframe" });
	assert.equal(looked.content[0].text, visGuide("wireframe"));
	assert.match(looked.content[0].text, /^# vis: rules for every kind\n[\s\S]*\n# vis wireframe\n/);

	await session.mode("vis on");
	assert.deepEqual(branch.at(-1).data.head, ["spec"], "the switch records the head it leaves in place");
	assert.ok(hasGuideTool(), "between runs the tool set follows the switch at once (a new session's card lists it)");
	let turn = await session.userTurn();
	assert.ok(hasGuideTool(), "vis on: the run that carries the note has vis_guide");
	assert.equal(turn.section, head, "a minor toggle leaves the prompt's mode section byte-identical");
	assert.equal(turn.notes.length, 1, "one note for the switch");
	const onNote = turn.notes[0];
	assert.deepEqual(onNote.options, { deliverAs: "nextTurn" }, "the note rides the user's prompt");
	assert.equal(onNote.message.customType, "mode-note");
	assert.equal(onNote.message.display, false, "hidden in the TUI and in Sova");
	assert.ok(onNote.message.content.startsWith("Mode change: the user turned the vis minor mode on. Its instructions follow and apply from now on"), "it says what changed");
	assert.ok(onNote.message.content.endsWith(`\n\n${VIS_INSTRUCTIONS}`), "turning on carries the mode's whole block (the kind list), as the head would have");
	assert.deepEqual(onNote.message.details, { v: 1, minorModes: ["spec", "vis"], guides: ["vis"] });
	assert.deepEqual((await session.userTurn()).notes, [], "told once: the next run sends nothing");

	// Off during a run: that run keeps its tools, and they follow when it settles.
	await session.fire("agent_start");
	await session.mode("vis off");
	assert.ok(!("head" in branch.at(-1).data), "no head recorded while it equals the active minor modes");
	assert.ok(hasGuideTool(), "a switch during a run leaves that run's tools alone");
	await session.fire("agent_settled");
	assert.ok(!hasGuideTool(), "the run settling brings the tool set in step");
	turn = await session.userTurn();
	assert.ok(!hasGuideTool(), "vis off: the next run has no vis_guide");
	assert.equal(turn.section, head);
	assert.equal(
		turn.notes[0].message.content,
		'Mode change: the user turned the vis minor mode off. Its instructions (the "# Minor mode: vis" block given earlier in this conversation) no longer apply; do not follow them unless a later note turns it back on.',
	);

	// On again, in a run a worker's report starts: steered in ahead of its first request, and the guide
	// still in context is pointed at, not repeated.
	await session.mode("vis on");
	const steered = await session.messageTurn();
	assert.equal(steered.length, 1);
	assert.equal(steered[0].options, undefined, "a steer: lands before the run's first request");
	assert.match(steered[0].message.content, /^Mode change: the user turned the vis minor mode back on\. Its instructions \(the "# Minor mode: vis" block given earlier in this conversation\) apply again/);
	assert.ok(!steered[0].message.content.includes(VIS_INSTRUCTIONS), "no second copy of the block");
	assert.deepEqual(steered[0].message.details.guides, []);

	// Reopen (a new runtime on the same branch) with a switch the model hasn't heard of yet.
	await session.mode("spec off");
	session = open();
	await session.fire("session_start", { reason: "resume" });
	turn = await session.userTurn();
	assert.equal(turn.section, head, "a reopened session rebuilds the head it started with, whatever is active now");
	assert.equal(turn.notes.length, 1, "the pending switch is told after the reopen");
	assert.match(turn.notes[0].message.content, /^Mode change: the user turned the spec minor mode off\. Its instructions \(the "# Minor mode: spec" block in your system prompt\) no longer apply/);
	assert.ok(!turn.notes[0].message.content.includes(SPEC_INSTRUCTIONS));

	// Compaction: the next run rebuilds the head from the modes active then, with no note.
	const notesBefore = branch.filter((e) => e.type === "custom_message").map((e, i) => ({ role: "custom", customType: e.customType, content: e.content, timestamp: 1000 + i }));
	const summary = { role: "compactionSummary", summary: "…", tokensBefore: 1, timestamp: 5000 };
	const context = { type: "context", messages: [...notesBefore.slice(0, 1), summary, ...notesBefore.slice(1), { role: "user", content: "hi", timestamp: 6000 }] };
	branch.push({ type: "compaction", summary: "…" });
	await session.fire("session_compact", { reason: "threshold", willRetry: false });
	assert.equal(await session.fire("context", context), undefined, "until a run rebuilds the head, the kept notes stay: a run under way still has the old prompt");
	turn = await session.userTurn();
	assert.deepEqual(turn.notes, [], "no guide twice: the rebuilt head has it");
	assert.match(turn.section, /# Minor mode: vis/, "the head now carries the modes active at the compaction");
	assert.doesNotMatch(turn.section, /# Minor mode: spec/);
	const rebuilt = turn.section;
	const filtered = await session.fire("context", context);
	assert.deepEqual(filtered.messages.map((m) => m.role), ["compactionSummary", "user"], "notes the compaction kept are dropped once the head is rebuilt");
	session = open();
	await session.fire("session_start", { reason: "resume" });
	turn = await session.userTurn();
	assert.equal(turn.section, rebuilt, "reopened after the compaction: the rebuilt head again");
	assert.deepEqual(turn.notes, []);
}

// Note-only spec activation gets subsequent writer changes, including a worker-wake run.
{
	const host = makeApi();
	const s = { status: new Map(), notices: [], widgets: new Map(), branch: [{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "normal", strict: false, minorModes: [] } } }], customCalls: [] };
	const c = makeCtx(s);
	modeExtension(host.api);
	const fire = async (name, event = {}) => { for (const fn of host.hooks.get(name) ?? []) await fn(event, c); };
	const specFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode-spec.json");
	const writer = (model) => { writeFileSync(`${specFile}.tmp`, JSON.stringify({ version: 1, writer: { primary: { backend: "pi", model, effort: "high" }, fallback: null } })); renameSync(`${specFile}.tmp`, specFile); reseed(); };
	try {
		await fire("session_start", { reason: "startup" });
		await fire("before_agent_start", { systemPrompt: "base", prompt: "go" });
		await fire("agent_start"); await fire("agent_settled");
		writer("fixture/writer-a");
		await host.commands.get("mode").handler("spec on", c);
		await fire("before_agent_start", { systemPrompt: "base", prompt: "go" });
		await fire("agent_start"); await fire("agent_settled");
		assert.match(host.sent.at(-1).message.content, /fixture\/writer-a/);
		const at = host.sent.length;
		writer("fixture/writer-b");
		await fire("agent_start"); // deliberately no before_agent_start: worker wake
		await fire("agent_settled");
		assert.equal(host.sent.length, at + 1, "writer-only change emits fresh context");
		assert.match(host.sent.at(-1).message.content, /routing now applies instead of any earlier writer routing/);
		assert.match(host.sent.at(-1).message.content, /fixture\/writer-b/);
		assert.doesNotMatch(host.sent.at(-1).message.content, /fixture\/writer-a/);
	} finally { rmSync(specFile, { force: true }); reseed(); }
}

// Subagent profiles: a chat's pick (its hidden entry, which Sova writes into a held chat
// directly) is re-read at each turn boundary; Off names the work kinds with no worker; the
// default moves a chat with no pick; /mode subagents writes the entry itself.
{
	const host = makeApi();
	const s = { status: new Map(), notices: [], widgets: new Map(), branch: [{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "delegate", strict: false, minorModes: [] } } }], customCalls: [] };
	host.api.appendEntry = (type, data) => s.branch.push({ type: "custom", customType: type, data });
	const c = makeCtx(s);
	modeExtension(host.api);
	const fire = async (name, event = {}) => { let out; for (const fn of host.hooks.get(name) ?? []) out = (await fn(event, c)) ?? out; return out; };
	const route = (model) => Object.fromEntries(["planning", "investigation", "routine", "complex"].map((k) => [k, { primary: { backend: "claude-code", model, effort: "low" }, fallback: null }]));
	const empty = { teams: null, members: null, specWriter: null };
	writeFileSync(profilesFile, JSON.stringify({ version: 1, profiles: [{ id: "a", name: "A", delegate: route("claude-opus-5-5"), ...empty }, { id: "b", name: "B", delegate: route("claude-sonnet-5-5"), ...empty }] }));
	writeFileSync(profilesDefaultFile, JSON.stringify({ version: 1, default: "a" }));
	try {
		await fire("session_start", { reason: "startup" });
		let prompt = (await fire("before_agent_start", { systemPrompt: "base", prompt: "go" })).systemPrompt;
		assert.match(prompt, /Routine implementation .* → backend "claude-code", model "claude-opus-5-5"/, "no pick: the default profile routes");
		await fire("agent_start"); await fire("agent_settled");
		s.branch.push({ type: "custom", customType: "subagent-profile", data: { v: 1, profile: "b" } });
		prompt = (await fire("before_agent_start", { systemPrompt: "base", prompt: "go" })).systemPrompt;
		assert.match(prompt, /Routine implementation .* → backend "claude-code", model "claude-sonnet-5-5"/, "a pick written into the branch applies from the next turn");
		await fire("agent_start"); await fire("agent_settled");
		s.branch.push({ type: "custom", customType: "subagent-profile", data: { v: 1, profile: "off" } });
		prompt = (await fire("before_agent_start", { systemPrompt: "base", prompt: "go" })).systemPrompt;
		assert.match(prompt, /# Mode: delegate/, "Off still asks the agent to delegate");
		assert.match(prompt, /no subagent profile routes them/);
		assert.match(prompt, /- Routine implementation \(mechanical/);
		assert.doesNotMatch(prompt, /→ backend/, "Off carries no worker line");
		await fire("agent_start"); await fire("agent_settled");
		const before = s.branch.length;
		await host.commands.get("mode").handler("subagents B", c);
		assert.deepEqual(s.branch.at(-1), { type: "custom", customType: "subagent-profile", data: { v: 1, profile: "b" } }, "/mode subagents takes a name and writes the entry");
		assert.equal(s.branch.length, before + 1);
		await host.commands.get("mode").handler("subagents b", c);
		assert.equal(s.branch.length, before + 1, "the same pick again writes nothing");
		await host.commands.get("mode").handler("subagents nope", c);
		assert.match(s.notices.at(-1).message, /No subagent profile "nope"/);
		await host.commands.get("mode").handler("status", c);
		assert.match(s.notices.at(-1).message, /^subagent profile: B \(this chat's pick\)$/m);
	} finally { reseed(); }
}

console.log("mode smoke tests passed");
