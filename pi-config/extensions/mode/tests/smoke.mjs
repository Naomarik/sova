// Offline wiring smoke test for the mode extension. No model requests.
// Drives the real index.ts through the globally installed pi runtime (jiti alias),
// with a fake ExtensionAPI/TUI and a fake claude-code backend registration.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
await commands.get("mode").handler("claude-heavy", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy</accent>", "heavy status renders after probe");
const heavyPrompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
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
const fallbackPrompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
assert.match(fallbackPrompt.systemPrompt, /model "opus\[1m\]", effort "high"/);
assert.ok(store.notices.some((n) => n.level === "warning"), "fallback notifies");

// Toggling via the shortcut flips modes
await shortcuts.get("alt+m").handler(ctx);
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "shortcut toggles back to normal");

// Minor mode align in normal mode: only the align block is appended
const alignHeader = /# Minor mode: align/;
await commands.get("mode").handler("align on", ctx);
assert.equal(store.status.get("mode"), "<accent>normal · align</accent>", "align shows in normal status");
const normalAlign = await beforeAgentStart({ systemPrompt: "base" }, ctx);
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
const heavyAlign = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.ok(heavyAlign.indexOf("# Mode: claude-heavy") > 0, "heavy block present");
assert.ok(heavyAlign.indexOf("# Mode: claude-heavy") < heavyAlign.search(alignHeader), "heavy before align");

// /mode status reports minor modes
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: align$/m);

// Bare /mode align toggles off; prompt back to heavy only
await commands.get("mode").handler("align", ctx);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>");
const heavyOnly = (await beforeAgentStart({ systemPrompt: "base" }, ctx)).systemPrompt;
assert.match(heavyOnly, /# Mode: claude-heavy/);
assert.doesNotMatch(heavyOnly, alignHeader);
assert.ok(entries.some((e) => e.type === "mode" && e.data.minor === "align" && e.data.on === false), "off marker appended");
await commands.get("mode").handler("status", ctx);
assert.match(store.notices.at(-1).message, /^minor: \(none\)$/m);

// Palette rows: align toggles in place with a live marker; major rows switch mode
let rows = provider.items(ctx);
const alignRow = () => rows.find((row) => row.id === "mode:minor:align");
assert.equal(rows.find((row) => row.id === "mode:claude-heavy").label, "✓ claude-heavy");
assert.equal(alignRow().toggle.isOn(), false);
alignRow().toggle.toggle();
assert.equal(alignRow().toggle.isOn(), true, "marker reads live state after toggling");
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict · align</accent>", "palette toggle turns align on");
alignRow().toggle.toggle();
assert.equal(alignRow().toggle.isOn(), false);
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>", "palette toggle turns align off");
await rows.find((row) => row.id === "mode:normal").run();
assert.equal(store.status.get("mode"), "<dim>normal</dim>", "normal row switches mode");
rows = provider.items(ctx);
assert.equal(rows.find((row) => row.id === "mode:normal").label, "✓ normal", "fresh rows mark the new mode");
await rows.find((row) => row.id === "mode:claude-heavy").run();
assert.equal(store.status.get("mode"), "<accent>claude-heavy · strict</accent>", "claude-heavy row switches mode");

assert.equal(rows.at(-1).id, "mode:align:view", "last palette row opens the align viewer");

// Bare /mode never toggles: with no palette to claim it, it explains instead
const tuiCtx = { ...ctx, mode: "tui" };
for (const bareCtx of [ctx, tuiCtx]) {
	const before = store.status.get("mode");
	await commands.get("mode").handler("", bareCtx);
	assert.equal(store.status.get("mode"), before, "bare /mode does not toggle");
	assert.equal(store.notices.at(-1).level, "warning");
	assert.match(store.notices.at(-1).message, /^mode: claude-heavy$/m);
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

console.log("mode smoke tests passed");
