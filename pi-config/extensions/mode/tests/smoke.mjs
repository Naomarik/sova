// Offline wiring smoke test for the mode extension. No model requests.
// Drives the real index.ts through the globally installed pi runtime (jiti alias),
// with a fake ExtensionAPI/TUI and a fake claude-code backend registration.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
		on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
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
	{ id: "claude-fable-5-1[1m]", name: "Fable" },
	{ id: "opus[1m]", name: "Opus" },
];

const { api, hooks, commands, shortcuts, renderers, entries, events, getTools } = makeApi();
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
assert.match(heavyPrompt.systemPrompt, /claude-fable-5-1\[1m\]/);
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
offered = [{ id: "claude-fable-5-1[1m]", name: "Fable", efforts: ["low"] }, { id: "opus[1m]", name: "Opus" }];
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan · strict</warning>", "fallback reflected in status (strict is still on from the previous scenario)");
const fallbackPrompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(fallbackPrompt.systemPrompt, /- Planning & specs .* → backend "claude-code", model "opus\[1m\]", effort "high"\. This is the configured FALLBACK/);
assert.match(store.notices.at(-1).message, /^Delegate routing:\nPlanning & specs: fallback claude-code · opus\[1m\] · high \(claude-fable-5-1\[1m\] does not support effort "medium" \(supports: low\)\)$/, "fallback is disclosed");
assert.equal(store.notices.at(-1).level, "warning");

// Toggling via the shortcut flips modes
await shortcuts.get("alt+m").handler(ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "shortcut toggles back to normal");

// Minor mode align in normal mode: only the align block is appended
const alignHeader = /# Minor mode: align/;
await commands.get("mode").handler("align on", ctx);
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "align shows in normal status");
const normalAlign = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(normalAlign.systemPrompt, /^base\n\n# Minor mode: align/);
assert.doesNotMatch(normalAlign.systemPrompt, /# Mode: delegate/);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === true), "minor marker appended");
assert.deepEqual(
	modeEntries().at(-1).data.active,
	{ version: 1, mode: "normal", strict: true, minorModes: ["align"] },
	"minor switches snapshot the whole triple too",
);
const markerText = renderers.get("mode")({ data: { minor: "align", on: true } }, {}, ctx.ui.theme).render(80).join("");
assert.match(markerText, /── align on ──/, "minor marker renders");
assert.match(renderers.get("mode")({ data: { mode: "delegate" } }, {}, ctx.ui.theme).render(80).join(""), /── mode → delegate ──/);

// Switching to heavy keeps align; the heavy block precedes the align block
offered = [
	{ id: "claude-fable-5-1[1m]", name: "Fable" },
	{ id: "opus[1m]", name: "Opus" },
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
const heavyAlignSpec = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.ok(heavyAlignSpec.search(alignHeader) < heavyAlignSpec.indexOf("# Minor mode: spec"), "align before spec");
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "spec" && e.data.on === true), "spec marker appended");
assert.deepEqual(modeEntries().at(-1).data.active.minorModes, ["align", "spec"]);
await commands.get("mode").handler("spec", ctx);
await commands.get("mode").handler("align off", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate · strict</accent>");
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
assert.deepEqual(getTools(), ["read", "bash", "grep"], "restoring strict heavy reapplies the strict tool set");
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
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep"], "the default is not strict");

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
assert.deepEqual(getTools(), ["read", "bash", "edit", "write", "grep"], "tree back off strict restores them");

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

// ── Alignment doc ────────────────────────────────────────────────────────────
const ALIGN_WIDGET = "mode-align";
const blockV1 = `Here is what I found.

## Alignment: Widget refresh
### Findings
The footer redraws on model_select.
### Approach
Re-assert the status.
### Open questions
1. [ ] Keep the widget above the editor?
2. [ ] Default key alt+a?
### Rejected
- Global file — one file for N sessions.
### Status
aligning`;
const blockV2 = blockV1.replace("1. [ ] Keep the widget above the editor?", "1. [x] Keep the widget above the editor? — yes");
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
const alignEntries = () => entries.filter((e) => e.type === "align-doc");

// Align off: nothing is captured
await commands.get("mode").handler("align off", ctx);
await hook("turn_end", { turnIndex: 0, message: assistant(blockV1), toolResults: [] });
assert.equal(alignEntries().length, 0, "no capture while align is off");
assert.ok(!store.widgets.has(ALIGN_WIDGET), "no widget while align is off");
await commands.get("align").handler("", ctx);
assert.match(store.notices.at(-1).message, /No alignment doc yet/);

// Align on: the block is captured, persisted, and shown in the widget and /mode status
await commands.get("mode").handler("align on", ctx);
await hook("turn_end", { turnIndex: 1, message: assistant(blockV1), toolResults: [] });
assert.equal(alignEntries().length, 1, "one align-doc entry appended");
assert.equal(alignEntries()[0].data.version, 1);
assert.equal(alignEntries()[0].data.doc.title, "Widget refresh");
assert.equal(alignEntries()[0].data.doc.revision, 1);
assert.ok(store.widgets.has(ALIGN_WIDGET), "widget set after capture");
const widgetText = store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(60).join("");
assert.match(widgetText, /questions open/);
assert.match(widgetText, /0\/2 settled/);
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^align doc: v1 · questions open · 0\/2 settled · \d+ lines$/m);

// Identical re-emit: no new revision; an updated block bumps the revision
await hook("turn_end", { turnIndex: 2, message: assistant(blockV1), toolResults: [] });
assert.equal(alignEntries().length, 1, "identical block is not re-captured");
await hook("turn_end", { turnIndex: 3, message: assistant(blockV2), toolResults: [] });
assert.equal(alignEntries().length, 2, "changed block captured");
assert.equal(alignEntries()[1].data.doc.revision, 2);
assert.match(store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(60).join(""), /1\/2 settled/);

// Aborted or errored turns never overwrite a good doc
await hook("turn_end", { turnIndex: 4, message: assistant("## Alignment: truncated\n### Open q", "aborted"), toolResults: [] });
await hook("turn_end", { turnIndex: 5, message: assistant("## Alignment: truncated\n### Open q", "error"), toolResults: [] });
assert.equal(alignEntries().length, 2, "aborted/error turns ignored");

// A bold, anchorless block (the shape the agent actually emitted once) is captured, not dropped
const boldBlock = `Summary:

**Findings**
- footer redraws
**Approach** (option a)
1. re-assert
**Open questions**
- keep it above the editor?
**Rejected**
- global file
**Status: aligning** — proceed?`;
const warningsBefore = store.notices.filter((n) => n.level === "warning").length;
await hook("turn_end", { turnIndex: 6, message: assistant(boldBlock), toolResults: [] });
assert.equal(alignEntries().length, 3, "bold anchorless block captured");
assert.equal(alignEntries()[2].data.doc.title, "");
assert.equal(alignEntries()[2].data.doc.revision, 3);
assert.equal(alignEntries()[2].data.doc.explicitStatus, "aligning");
assert.equal(alignEntries()[2].data.doc.questions.length, 1);
assert.equal(store.notices.filter((n) => n.level === "warning").length, warningsBefore, "captured blocks never warn");
await hook("turn_end", { turnIndex: 7, message: assistant(boldBlock), toolResults: [] });
assert.equal(alignEntries().length, 3, "re-emitted bold block is not a new revision");

// A block that looks like an alignment doc but has unparseable headings warns once; a plain answer stays silent
const bareLabels = "Findings:\n- a\nApproach:\n- b\nStatus: aligning";
await hook("turn_end", { turnIndex: 8, message: assistant(bareLabels), toolResults: [] });
assert.equal(alignEntries().length, 3, "bare labels are not captured");
const captureWarnings = () => store.notices.filter((n) => /looked like an alignment doc but was not captured/.test(n.message));
assert.equal(captureWarnings().length, 1, "one warning for the malformed block");
assert.equal(captureWarnings()[0].level, "warning");
await hook("turn_end", { turnIndex: 9, message: assistant("Done. I changed the approach in two files; status is green."), toolResults: [] });
assert.equal(captureWarnings().length, 1, "a plain answer never warns");
await hook("turn_end", { turnIndex: 10, message: assistant(bareLabels, "aborted"), toolResults: [] });
assert.equal(captureWarnings().length, 1, "aborted turns never warn");
await commands.get("mode").handler("align off", ctx);
await hook("turn_end", { turnIndex: 11, message: assistant(bareLabels), toolResults: [] });
assert.equal(captureWarnings().length, 1, "no warning while align is off");
await commands.get("mode").handler("align on", ctx);

// Restore the markdown block so the viewer scenarios below see a titled doc
await hook("turn_end", { turnIndex: 12, message: assistant(blockV2), toolResults: [] });
assert.equal(alignEntries().length, 4);

// Widget lines never exceed the width
for (const width of [20, 40, 120]) {
	for (const line of store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(width)) {
		assert.ok(visibleWidth(line) <= width, `widget line fits ${width}`);
	}
}

// /align in rpc: notifies the markdown; in tui: opens an overlay viewer
await commands.get("align").handler("", ctx);
assert.match(store.notices.at(-1).message, /## Alignment: Widget refresh/);
assert.equal(store.customCalls.length, 0, "no overlay outside tui");
await commands.get("align").handler("", tuiCtx);
assert.equal(store.customCalls.length, 1, "overlay opened in tui");
assert.equal(store.customCalls[0].options.overlay, true);
const viewer = store.customCalls[0].component;
const viewerLines = viewer.render(80);
assert.ok(viewerLines.every((line) => visibleWidth(line) <= 80), "viewer lines fit the width");
assert.ok(viewerLines.some((line) => line.includes("Widget refresh")), "viewer shows the title");
assert.ok(viewerLines.some((line) => line.includes("☑") || line.includes("☐")), "viewer shows checklist glyphs");
viewer.handleInput("q");
await shortcuts.get("alt+a").handler(tuiCtx);
assert.equal(store.customCalls.length, 2, "shortcut opens the viewer too");
store.customCalls[1].component.handleInput("\x1b");

// Marker renderer
const alignMarker = renderers.get("align-doc")({ data: alignEntries()[1].data }, {}, ctx.ui.theme).render(80).join("");
assert.match(alignMarker, /alignment v2 · questions open · 1\/2 settled/);

// /align export writes the markdown
const exportPath = path.join(process.env.PI_CODING_AGENT_DIR, "out", "a.md");
await commands.get("align").handler(`export ${exportPath}`, ctx);
assert.equal(readFileSync(exportPath, "utf8"), `${alignEntries()[1].data.doc.markdown}\n`);

// /align clear: widget gone, doc:null entry, cleared marker
await commands.get("align").handler("clear", ctx);
assert.equal(alignEntries().at(-1).data.doc, null, "clear appends doc:null");
assert.ok(!store.widgets.has(ALIGN_WIDGET), "widget cleared");
assert.match(renderers.get("align-doc")({ data: { version: 1, doc: null } }, {}, ctx.ui.theme).render(80).join(""), /alignment cleared/);

// session_start restores the newest doc from the branch; a later doc:null hides it; align off hides the widget but keeps the doc
store.branch = [
	// The session's own align toggle: without it the restore would take align from the default (off).
	{ type: "custom", customType: "mode", data: { minor: "align", on: true, active: { version: 1, mode: "normal", strict: false, minorModes: ["align"] } } },
	{ type: "custom", customType: "align-doc", data: alignEntries()[0].data },
	{ type: "custom", customType: "align-doc", data: alignEntries()[1].data },
];
delete flagValues.minor;
await hook("session_start", { reason: "resume" });
assert.ok(store.widgets.has(ALIGN_WIDGET), "widget restored from the branch");
assert.match(store.widgets.get(ALIGN_WIDGET)(fakeTui, ctx.ui.theme).render(80).join(""), /1\/2 settled/, "newest revision restored");
await commands.get("mode").handler("align off", ctx);
assert.ok(!store.widgets.has(ALIGN_WIDGET), "widget hidden when align is off");
await commands.get("align").handler("status", ctx);
assert.match(store.notices.at(-1).message, /v2 · questions open/, "doc kept while align is off");
await commands.get("mode").handler("align on", ctx);
assert.ok(store.widgets.has(ALIGN_WIDGET), "widget back when align is on");
store.branch.push({ type: "custom", customType: "align-doc", data: { version: 1, doc: null } });
await hook("session_tree", { newLeafId: "x", oldLeafId: "y" });
assert.ok(!store.widgets.has(ALIGN_WIDGET), "doc:null on the branch clears the widget");

// /align on|off aliases the minor toggle
await commands.get("align").handler("off", ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "/align off turns the minor off");

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
const policyFile = path.join(process.env.PI_CODING_AGENT_DIR, "model-policy.json");
const writeRouting = (mutate) => {
	const settings = { version: 1, profiles: {
		planning: { primary: { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "medium" }, fallback: { backend: "claude-code", model: "opus[1m]", effort: "high" } },
		investigation: { primary: { backend: "claude-code", model: "opus[1m]", effort: "low" }, fallback: null },
		routine: { primary: { backend: "claude-code", model: "opus[1m]", effort: "low" }, fallback: null },
		complex: { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null },
	} };
	mutate(settings);
	// Atomic replace, the way Sova writes it: a new inode, so the per-turn stat sees the change.
	writeFileSync(`${delegateFile}.tmp`, JSON.stringify(settings));
	renameSync(`${delegateFile}.tmp`, delegateFile);
};
offered = [
	{ id: "claude-fable-5-1[1m]", name: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "opus[1m]", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
];
const delegateEntriesBefore = modeEntries().length;
await commands.get("mode").handler("delegate", ctx);
assert.equal(store.status.get("mode"), "<accent>delegate</accent>", "/mode delegate selects delegate");
assert.deepEqual(modeEntries().at(-1).data, { mode: "delegate", active: { version: 1, mode: "delegate", strict: false, minorModes: [] } }, "and writes the canonical name");
assert.equal(modeEntries().length, delegateEntriesBefore + 1);
assert.ok(!existsSync(delegateFile), "no switch writes the routing file");
let turn = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.match(turn, /- Routine implementation .* → backend "claude-code", model "opus\[1m\]", effort "low"; no fallback — if it fails, ask the user\./, "defaults without a file");
assert.match(turn, /- Investigation .* → backend "claude-code", model "opus\[1m\]", effort "low"; no fallback — if it fails, ask the user\./);

// An edit to the routing reaches this already-delegate session at its next turn boundary.
const piCtx = {
	...ctx,
	modelRegistry: { getAvailable: () => [{ provider: "zai", id: "glm-5.3", name: "GLM", api: "openai-completions", reasoning: true, input: ["text"] }] },
};
writeRouting((s) => {
	s.profiles.routine = { primary: { backend: "pi", model: "zai/glm-5.3", effort: "high" }, fallback: { backend: "claude-code", model: "opus[1m]", effort: "low" } };
});
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Routine implementation .* → backend "pi", model "zai\/glm-5.3", effort "high"; fallback backend "claude-code", model "opus\[1m\]", effort "low"\./, "re-read at the turn boundary");
await flush();
await flush();
await commands.get("mode").handler("status", piCtx);
assert.match(store.notices.at(-1).message, /^  Routine implementation: pi · zai\/glm-5.3 · high, fallback claude-code · opus\[1m\] · low — using primary$/m, "the background probe verified the pi tuple");
assert.match(store.notices.at(-1).message, /^delegate routing \(.*mode-delegate\.json\):$/m);

// Normal mode never reads the routing: the prompt is untouched whatever the file says.
await commands.get("mode").handler("normal", ctx);
assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined, "normal mode is unaffected");
await commands.get("mode").handler("delegate", piCtx);

// The subagent policy is re-read per turn too: a denied primary reroutes to the configured fallback, disclosed.
writeFileSync(policyFile, JSON.stringify({ version: 1, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: ["claude-code/claude-fable-5-1[1m]"] }));
turn = (await beforeAgentStart({ systemPrompt: "base" }, piCtx)).systemPrompt;
assert.match(turn, /- Planning & specs .* → backend "claude-code", model "opus\[1m\]", effort "high"\. This is the configured FALLBACK: .* is disabled as a subagent model by user settings\./);
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
assert.match(turn, /- Planning & specs .* → backend "claude-code", model "claude-fable-5-1\[1m\]", effort "high"; fallback/);
await commands.get("mode").handler("status", piCtx);
assert.match(store.notices.at(-1).message, /^  Planning & specs: .* — using primary \(not verified\)$/m);

// Discovered but without the configured effort: unavailable, so the fallback, disclosed.
offered = [
	{ id: "claude-fable-5-1[1m]", name: "Fable", efforts: ["low", "medium"] },
	{ id: "opus[1m]", name: "Opus", efforts: ["low", "medium", "high"] },
];
writeRouting(() => {});
writeRouting((s) => {
	s.profiles.planning.primary.effort = "max";
});
await beforeAgentStart({ systemPrompt: "base" }, piCtx);
await flush();
await flush();
assert.equal(store.status.get("mode"), "<warning>delegate · fallback:plan</warning>", "an unsupported effort is not clamped silently");
assert.match(store.notices.at(-1).message, /Planning & specs: fallback claude-code · opus\[1m\] · high \(claude-fable-5-1\[1m\] does not support effort "max"/, "a routing change that degrades a profile is announced");
rmSync(delegateFile);
await commands.get("mode").handler("normal", ctx);

// ── A turn during the entry probe joins it: no restart, and the entry's fallback notice survives ──
offered = [{ id: "claude-fable-5-1[1m]", name: "Fable", efforts: ["low"] }, { id: "opus[1m]", name: "Opus" }]; // planning will be on its fallback
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
		late.events.emit("subagents:backend-register", { version: 1, id: "claude-code", listModels: async () => [{ id: "claude-fable-5-1[1m]", name: "F" }, { id: "opus[1m]", name: "O" }], validate() {}, create() {} });
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
	assert.match((await lateStart({ systemPrompt: "base" })).systemPrompt, /- Routine implementation .* → backend "claude-code", model "opus\[1m\]", effort "low"/);
}

// ── Spec writer: re-read at the turn boundary and probed while spec is on, outside delegate too ──
{
	const specFile = path.join(process.env.PI_CODING_AGENT_DIR, "mode-spec.json");
	const writeSpec = (settings) => {
		writeFileSync(`${specFile}.tmp`, JSON.stringify(settings));
		renameSync(`${specFile}.tmp`, specFile);
	};
	const all = ["low", "medium", "high", "xhigh", "max"];
	offered = [{ id: "claude-fable-5-1[1m]", name: "Fable", efforts: all }, { id: "opus[1m]", name: "Opus", efforts: ["low"] }];
	await commands.get("mode").handler("normal", ctx);
	await commands.get("mode").handler("spec on", ctx);
	listCalls = 0;
	let prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /# Minor mode: spec/);
	assert.doesNotMatch(prompt, /Spec writer:/, "no writer set: no paragraph, the session writes the spec itself");
	await flush();
	assert.equal(listCalls, 0, "no writer, not in delegate: nothing to probe");

	writeSpec({ version: 1, writer: { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "high" } } });
	const noticesBefore = store.notices.length;
	prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /# Minor mode: spec\n[\s\S]*\n\nSpec writer: .* → backend "claude-code", model "opus\[1m\]", effort "medium";/, "re-read at the turn boundary, on the last discovery until this probe lands");
	assert.doesNotMatch(prompt, /# Mode: delegate/, "the writer needs no delegate");
	await flush();
	await flush();
	assert.equal(listCalls, 1, "outside delegate, spec on probes the writer's backend");
	assert.equal(store.status.get("mode"), "<warning>normal · spec · writer:fallback</warning>");
	assert.ok(
		store.notices.slice(noticesBefore).some((n) => n.level === "warning" && /^Spec writer: fallback claude-code · claude-fable-5-1\[1m\] · high \(opus\[1m\] does not support effort "medium"/.test(n.message)),
		"a writer on its fallback is announced",
	);
	prompt = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
	assert.match(prompt, /Spec writer: .* → backend "claude-code", model "claude-fable-5-1\[1m\]", effort "high"\. This is the configured FALLBACK/);
	await commands.get("mode").handler("status", ctx);
	assert.match(store.notices.at(-1).message, /^spec writer \(.*mode-spec\.json\): claude-code · opus\[1m\] · medium, fallback claude-code · claude-fable-5-1\[1m\] · high — using FALLBACK/m);

	// Spec off: no block, no paragraph, nothing probed; the file stays as it was.
	await commands.get("mode").handler("spec off", ctx);
	assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined);
	assert.equal(store.status.get("mode"), "<dim>normal</dim>");
	assert.ok(existsSync(specFile), "nothing here writes or removes the writer file");
	rmSync(specFile);
}

// ── The host's base prompt sections: kept in step, so a turn an extension's message starts reads the same prompt ──
// pi builds a user turn's prompt in before_agent_start; a turn started by sendMessage({triggerTurn})
// skips it and rebuilds later requests from the base options. Only a command context exposes them.
{
	let base = { sections: { preamble: "base" } };
	const commandCtx = { ...ctx, getSystemPromptOptions: () => base };
	await commands.get("mode").handler("align on", commandCtx);
	assert.match(base.sections.mode, /# Minor mode: align/, "a switch through /mode writes the block into the host's base sections");
	assert.deepEqual(Object.keys(base.sections), ["preamble", "mode"], "no other base section is touched");

	// pi replaces the base object when tools change; the run start re-syncs whichever object is current.
	base = { sections: { preamble: "rebuilt" } };
	await hook("agent_start", {});
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
	await commands.get("mode").handler("align off", ctx);
	assert.ok(!("mode" in base.sections), "no block: the base section is deleted");
	assert.deepEqual(base.sections, { preamble: "rebuilt again" });

	// A getter whose runner is gone throws; it is dropped and nothing else fails.
	const stale = { ...ctx, getSystemPromptOptions: () => { throw new Error("extension runner is no longer active"); } };
	await commands.get("mode").handler("align on", stale);
	await hook("agent_start", {});
	assert.ok(!("mode" in base.sections), "a dead getter is dropped, not retried");
	await commands.get("mode").handler("align off", ctx);
	assert.equal(await beforeAgentStart({ systemPrompt: "base" }, ctx), undefined, "back to normal with no host: inert");
}

console.log("mode smoke tests passed");
