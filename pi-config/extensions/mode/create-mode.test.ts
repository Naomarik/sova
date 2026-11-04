// The mode extension in Create (§chat/create-mode), on a fake pi: the block it composes, strict, the lookup in the
// loadout, what Save as Default keeps, and a terminal, which has no Create and must not break on a chat saved in it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "create-mode-ext-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_CHAT_STATE_ROOT = join(scratch, "state");
// index.ts imports pi's runtime: load it through the installed pi, like the other extension tests.
const { jiti } = await import("../subagents/tests/runtime.mjs");
const { default: modeExtension } = (await jiti.import(new URL("./index.ts", import.meta.url).pathname)) as { default: (pi: never) => void };
const { WEB_MODE_HOOK, loadState, orchestrates } = await import("./state.ts");
const { CREATE_INSTRUCTIONS } = await import("./create/guide.ts");
const { buildDelegateAlignBridge, buildDelegatePrompt, composePrompt, DEFAULT_ROUTES, statusLabel } = await import("./prompt.ts");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

type Entry = { type: string; customType?: string; data?: unknown; message?: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi as far as the mode extension uses it, with the file tools a strict chat loses. */
function fakePi(entries: Entry[], flags: Record<string, string> = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => { value: string }[] | null }>();
	const tools = new Map<string, { name: string }>();
	let active: string[] = ["read", "bash", "edit", "write"];
	const notes: { text: string; level: string }[] = [];
	const pi = {
		on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: { on: () => () => {}, emit: () => {} },
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => { value: string }[] | null }) => commands.set(name, command),
		registerShortcut: () => {},
		registerEntryRenderer: () => {},
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => {
			active = [...next];
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string }) => entries.push({ type: "custom_message", customType: message.customType }),
		sendUserMessage: () => {},
	};
	const ctx = {
		cwd: scratch,
		hasUI: false,
		mode: "rpc",
		signal: undefined,
		isIdle: () => true,
		sessionManager: { getBranch: () => entries, getSessionId: () => "s1", getHeader: () => ({ timestamp: new Date().toISOString() }) },
		ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: () => {}, setWidget: () => {}, theme: { fg: (_t: string, s: string) => s } },
		modelRegistry: { getAvailable: () => [] },
	};
	modeExtension(pi as never);
	const fire = async (name: string, event: unknown = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	return {
		notes,
		activeTools: () => [...active],
		start: (reason = "startup") => fire("session_start", { reason }),
		mode: (args: string) => commands.get("mode")!.handler(args, ctx),
		completions: (prefix: string) => (commands.get("mode")!.getArgumentCompletions?.(prefix) ?? []).map((item) => item.value),
		async prompt(): Promise<string | undefined> {
			entries.push({ type: "message", message: { role: "user" } });
			const sections: Record<string, string> = {};
			await fire("before_agent_start", { prompt: "go", systemPrompt: "base", systemPromptOptions: { sections } });
			await fire("agent_start");
			await fire("agent_settled");
			return sections.mode;
		},
	};
}

/** Run `fn` as Sova's server would: the hook installed, permitting the mode it is applying. */
async function inSova<T>(fn: () => Promise<T>): Promise<T> {
	const g = globalThis as Record<symbol, unknown>;
	g[WEB_MODE_HOOK] = () => true;
	try {
		return await fn();
	} finally {
		delete g[WEB_MODE_HOOK];
	}
}

const lastActive = (entries: Entry[]) => (entries.filter((e) => e.customType === "mode").at(-1)?.data as { active?: { mode: string; lastMode?: string } }).active;

test("orchestrates: Delegate and Create, and only they", () => {
	assert.deepEqual(["normal", "delegate", "create"].filter((m) => orchestrates(m as never)), ["delegate", "create"]);
});

test("the composed prompt is Delegate's block, the align bridge, then Create's block, in that order, with Delegate's unchanged", () => {
	const delegate = composePrompt({ mode: "delegate", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!;
	const create = composePrompt({ mode: "create", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!;
	const block = buildDelegatePrompt(DEFAULT_ROUTES);
	const bridge = buildDelegateAlignBridge();
	assert.ok(delegate.includes(block) && delegate.includes(bridge));
	assert.ok(!delegate.includes(CREATE_INSTRUCTIONS), "Delegate has no Create block");
	const at = [create.indexOf(block), create.indexOf(bridge), create.indexOf(CREATE_INSTRUCTIONS)];
	assert.ok(at.every((i) => i >= 0), `all three are there: ${at}`);
	assert.deepEqual([...at].sort((a, b) => a - b), at, "in that order");
	assert.ok(!composePrompt({ mode: "create", strict: false, minorModes: [] }, DEFAULT_ROUTES)!.includes(bridge), "no bridge once align is off");
	assert.equal(composePrompt({ mode: "normal", strict: false, minorModes: [] }, DEFAULT_ROUTES), undefined);
});

test("the status line reads as Delegate's does: strict shows, and it is lit", () => {
	assert.deepEqual(statusLabel("create", DEFAULT_ROUTES, true, []), { text: "create · strict", tone: "accent" });
});

test("a strict Create chat has lost edit and write; they stay gone into Delegate and come back in normal", async () => {
	await inSova(async () => {
		const entries: Entry[] = [];
		const p = fakePi(entries);
		await p.start();
		await p.mode("strict on");
		assert.ok(p.activeTools().includes("edit"), "strict does nothing in normal");
		await p.mode("align on");
		await p.mode("create");
		const tools = p.activeTools();
		assert.ok(!tools.includes("edit") && !tools.includes("write"), `lost: ${tools}`);
		assert.ok(tools.includes("create_guide"), `the lookup: ${tools}`);
		const prompt = await p.prompt();
		assert.ok(prompt?.includes("# Mode: delegate"), "Delegate's block");
		assert.ok(prompt?.includes("takes precedence over delegation"), "the align bridge");
		assert.ok(prompt?.includes(CREATE_INSTRUCTIONS), "Create's block");

		await p.mode("delegate");
		assert.ok(!p.activeTools().includes("edit"), "moving to Delegate keeps them away");
		assert.ok(!p.activeTools().includes("create_guide"), "only Create has the lookup");
		await p.mode("create");
		assert.ok(!p.activeTools().includes("write"), "and back");
		assert.ok(p.activeTools().includes("create_guide"));
		await p.mode("normal");
		assert.ok(p.activeTools().includes("edit") && p.activeTools().includes("write"), "leaving both brings them back");
		assert.ok(!p.activeTools().includes("create_guide"), "leaving Create takes the lookup, strict snapshot included");
	});
});

test("a strict chat restored in Create applies strict on open", async () => {
	await inSova(async () => {
		const entries: Entry[] = [];
		const a = fakePi(entries);
		await a.start();
		await a.mode("strict on");
		await a.mode("create");
		const b = fakePi(entries);
		await b.start("resume");
		assert.ok(!b.activeTools().includes("edit"));
		assert.ok(b.activeTools().includes("create_guide"));
	});
});

test("the chat keeps its last normal or Delegate choice, and /mode default saves that, never Create", async () => {
	await inSova(async () => {
		const file = join(agentDir, "mode.json");
		const entries: Entry[] = [];
		const p = fakePi(entries);
		await p.start();
		await p.mode("delegate");
		await p.mode("create");
		assert.equal(lastActive(entries)?.lastMode, "delegate");
		await p.mode("default");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).mode, "delegate");

		// A reopen reads it back from the entry.
		const b = fakePi(entries);
		await b.start("resume");
		await b.mode("default");
		assert.equal(loadState(file).mode, "delegate");

		// Out of Create the field goes; a later entry into Create takes the newer choice.
		await b.mode("normal");
		assert.equal(lastActive(entries)?.lastMode, undefined);
		await b.mode("create");
		assert.equal(lastActive(entries)?.lastMode, "normal");
		await b.mode("default");
		assert.equal(loadState(file).mode, "normal");
	});
});

test("a terminal has no Create: /mode create is refused and changes nothing", async () => {
	const entries: Entry[] = [];
	const p = fakePi(entries);
	await p.start();
	await p.mode("create");
	assert.equal(entries.filter((e) => e.customType === "mode").length, 0, "no entry");
	assert.ok(!p.activeTools().includes("create_guide"));
	assert.ok(p.notes.some((n) => n.level === "warning" && n.text.includes("mode menu")), JSON.stringify(p.notes));
});

test("a terminal's `--major create` doesn't start in Create, and `--major delegate` still does", async () => {
	const flagged = async (major: string) => {
		const entries: Entry[] = [];
		const p = fakePi(entries, { major });
		await p.start();
		return p.prompt();
	};
	assert.equal(await flagged("create"), undefined, "normal: no mode section");
	assert.ok((await flagged("delegate"))?.includes("# Mode: delegate"));
});

test("`/mode` completions leave Create out, and keep the modes a terminal has", async () => {
	const p = fakePi([]);
	await p.start();
	assert.deepEqual(p.completions("cre"), []);
	assert.ok(p.completions("").includes("delegate") && !p.completions("").includes("create"));
});

test("a Sova chat that isn't applying a switch can't type its way in: the hook says no", async () => {
	const g = globalThis as Record<symbol, unknown>;
	g[WEB_MODE_HOOK] = () => false;
	try {
		const entries: Entry[] = [];
		const p = fakePi(entries);
		await p.start();
		await p.mode("create");
		assert.equal(entries.filter((e) => e.customType === "mode").length, 0);
	} finally {
		delete g[WEB_MODE_HOOK];
	}
});

test("a terminal opening a chat saved in Create doesn't break: it runs as Delegate and the entry stays", async () => {
	const entries: Entry[] = [{ type: "custom", customType: "mode", data: { mode: "create", active: { version: 1, mode: "create", strict: true, minorModes: ["align"], lastMode: "normal" } } }];
	const before = JSON.stringify(entries);
	const p = fakePi(entries);
	await p.start("resume");
	assert.equal(JSON.stringify(entries), before, "opening writes nothing");
	assert.ok(!p.activeTools().includes("edit"), "strict still holds");
	assert.ok(!p.activeTools().includes("create_guide"));
	const prompt = await p.prompt();
	assert.ok(prompt?.includes("# Mode: delegate"));
	assert.ok(!prompt?.includes(CREATE_INSTRUCTIONS));
});
