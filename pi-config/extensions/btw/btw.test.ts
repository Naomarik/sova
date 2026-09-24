/**
 * Tests for the headless degradation of the forked pi-btw extension.
 *
 *   npx tsx --test btw.test.ts
 *
 * pi-tui and pi-ai are nested under pi-coding-agent's node_modules, so a resolve hook
 * retries @earendil-works/* specifiers from pi-coding-agent before btw.ts is imported.
 * The model boundary is a fake createAgentSession: no model is ever called.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const piAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (!specifier.startsWith("@earendil-works/") && !specifier.startsWith("typebox")) throw error;
			return nextResolve(specifier, { ...context, parentURL: piAgentUrl });
		}
	},
});

const { registerBtw } = await import("./btw.ts");

// ── fakes ───────────────────────────────────────────────────────────────────

const MODEL = { provider: "test", id: "m1", api: "openai-responses" };
const ALT_MODEL = { provider: "test", id: "m2", api: "openai-responses" };
const USAGE = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Headless custom(): what Sova's bridge and pi's rpc mode do. */
const headlessCustom = async () => undefined;

/** TUI custom(), shaped like interactive-mode: factory runs synchronously, onHandle after, resolves on close. */
function tuiCustom(factory: any, options: any) {
	return new Promise((resolve) => {
		const tui = { requestRender() {} };
		const keybindings = { matches: () => false };
		Promise.resolve(factory(tui, plainTheme, keybindings, resolve)).then(() => {
			let focused = false;
			options?.onHandle?.({
				focus: () => (focused = true),
				unfocus: () => (focused = false),
				isFocused: () => focused,
				setHidden() {},
				hide() {},
			});
		});
	});
}

type HarnessOptions = {
	custom?: (factory: any, options: any) => Promise<unknown>;
	input?: string | undefined;
	confirm?: boolean;
	entries?: any[];
	idle?: boolean;
};

function harness(options: HarnessOptions = {}) {
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const entries: any[] = options.entries ?? [];
	const sent: { message: any; options: any }[] = [];
	const userMessages: any[] = [];
	const notices: { message: string; level: string }[] = [];
	const inputs: any[] = [];
	const confirms: any[] = [];
	const prompts: string[] = [];
	const sessions: { options: any; seed: any[] }[] = [];

	const pi: any = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut() {},
		registerMessageRenderer() {},
		on: (name: string, handler: any) => events.set(name, handler),
		getThinkingLevel: () => "off",
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, sendOptions?: any) => {
			sent.push({ message, options: sendOptions });
			entries.push({ type: "custom_message", ...message });
		},
		sendUserMessage: (content: string, sendOptions?: any) => userMessages.push({ content, options: sendOptions }),
	};

	const ctx: any = {
		// Deliberately "rpc" for every harness: Sova binds with mode "rpc" but has a UI, so the
		// headless decision must come from the custom() probe, never from the mode.
		mode: "rpc",
		hasUI: true,
		model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			find: (provider: string, id: string) => [MODEL, ALT_MODEL].find((m) => m.provider === provider && m.id === id),
		},
		sessionManager: { getEntries: () => entries, getLeafId: () => null, getBranch: () => entries },
		getSystemPrompt: () => "system prompt",
		isIdle: () => options.idle ?? true,
		ui: {
			custom: options.custom ?? headlessCustom,
			input: async (...args: any[]) => {
				inputs.push(args);
				return options.input;
			},
			confirm: async (...args: any[]) => {
				confirms.push(args);
				return options.confirm ?? false;
			},
			notify: (message: string, level: string) => notices.push({ message, level }),
			setWidget() {},
			theme: plainTheme,
		},
	};

	async function createAgentSession(sessionOptions: any) {
		const agent: any = { state: { messages: [] } };
		const record = { options: sessionOptions, seed: [] as any[] };
		sessions.push(record);
		const session: any = {
			agent,
			get state() {
				return agent.state;
			},
			isStreaming: false,
			subscribe: () => () => {},
			async prompt(text: string) {
				record.seed = [...agent.state.messages];
				prompts.push(text);
				agent.state.messages.push(
					{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "text", text: `answer to ${text}` }],
						provider: sessionOptions.model.provider,
						model: sessionOptions.model.id,
						api: sessionOptions.model.api,
						usage: USAGE,
						stopReason: "stop",
						timestamp: Date.now(),
					},
				);
			},
			async abort() {},
			dispose() {},
		};
		return { session };
	}

	registerBtw(pi, { createAgentSession: createAgentSession as any });

	return {
		ctx,
		entries,
		sent,
		userMessages,
		notices,
		inputs,
		confirms,
		prompts,
		sessions,
		run: (name: string, args = "") => commands.get(name).handler(args, ctx),
		start: () => events.get("session_start")({ type: "session_start" }, ctx),
	};
}

function details(question: string, extra: Record<string, unknown> = {}) {
	return {
		question,
		thinking: "",
		answer: `answer to ${question}`,
		provider: MODEL.provider,
		model: MODEL.id,
		api: MODEL.api,
		thinkingLevel: "off",
		timestamp: 1_700_000_000_000 + question.length,
		...extra,
	};
}

const threadEntry = (d: any) => ({ type: "custom", customType: "btw-thread-entry", data: d });
const noteEntry = (d: any) => ({
	type: "custom_message",
	customType: "btw-note",
	content: `Q: ${d.question}\n\nA: ${d.answer}`,
	display: true,
	details: d,
});

/** Handoff text of the restored thread, read through /btw:inject (TUI harness: no confirm). */
async function injectedThread(h: ReturnType<typeof harness>): Promise<string> {
	await h.run("btw:inject");
	assert.equal(h.userMessages.length, 1);
	return h.userMessages[0].content;
}

// ── probe ───────────────────────────────────────────────────────────────────

test("probe: custom() resolving without onHandle marks the session headless", async () => {
	const h = harness({ input: undefined });
	await h.run("btw");
	assert.equal(h.inputs.length, 1, "bare /btw falls back to ui.input once headless");
});

test("probe: custom() that builds the overlay and fires onHandle is not headless", async () => {
	const h = harness({ custom: tuiCustom });
	await h.run("btw");
	assert.equal(h.inputs.length, 0);
	await h.run("btw", "still tui?");
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].customType, "btw-thread-entry");
});

test("probe: custom() that fires onHandle and resolves at once is not headless", async () => {
	const custom = async (_factory: any, options: any) => {
		options.onHandle({ focus() {}, unfocus() {}, isFocused: () => false, setHidden() {}, hide() {} });
		return undefined;
	};
	const h = harness({ custom });
	await h.run("btw");
	assert.equal(h.inputs.length, 0);
});

// ── single-entry invariant ──────────────────────────────────────────────────

test("headless run writes exactly one displayable btw-note and no hidden thread entry", async () => {
	const h = harness();
	await h.run("btw", "what is x?");

	assert.deepEqual(h.prompts, ["what is x?"]);
	assert.equal(h.entries.length, 1);
	const [entry] = h.entries;
	assert.equal(entry.type, "custom_message");
	assert.equal(entry.customType, "btw-note");
	assert.equal(entry.display, true);
	assert.equal(entry.content, "Q: what is x?\n\nA: answer to what is x?");
	assert.equal(entry.details.question, "what is x?");
	assert.equal(entry.details.answer, "answer to what is x?");
	assert.equal(entry.details.provider, "test");
	assert.equal(entry.details.model, "m1");
	assert.deepEqual(h.sent[0].options, { triggerTurn: false });
	assert.deepEqual(h.notices, [], "success needs no toast");
});

test("headless --save and a busy main agent still write one note, never a followUp turn", async () => {
	const h = harness({ idle: false });
	await h.run("btw", "--save busy question");
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].customType, "btw-note");
	assert.deepEqual(h.sent[0].options, { triggerTurn: false });
});

test("TUI run writes the hidden thread entry and no note", async () => {
	const h = harness({ custom: tuiCustom });
	await h.run("btw", "what is y?");
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].type, "custom");
	assert.equal(h.entries[0].customType, "btw-thread-entry");
	assert.equal(h.entries[0].data.question, "what is y?");
	assert.equal(h.sent.length, 0);
});

test("TUI --save keeps upstream behavior: hidden entry plus a note", async () => {
	const h = harness({ custom: tuiCustom });
	await h.run("btw", "--save keep me");
	assert.deepEqual(
		h.entries.map((e) => e.customType),
		["btw-thread-entry", "btw-note"],
	);
	assert.equal(h.sent[0].options, undefined);
});

// ── restoreThread ───────────────────────────────────────────────────────────

test("restoreThread rehydrates the same thread from a btw-note as from a btw-thread-entry", async () => {
	const d = details("restored?");
	const fromEntry = harness({ custom: tuiCustom, entries: [threadEntry(d)] });
	const fromNote = harness({ custom: tuiCustom, entries: [noteEntry(d)] });
	await fromEntry.start();
	await fromNote.start();

	const a = await injectedThread(fromEntry);
	const b = await injectedThread(fromNote);
	assert.equal(a, b);
	assert.match(a, /User: restored\?\nAssistant: answer to restored\?/);
});

test("restored notes seed the next headless exchange (thread continuity)", async () => {
	const h = harness({ entries: [noteEntry(details("first"))] });
	await h.start();
	await h.run("btw", "second");

	const seedTexts = h.sessions[0].seed.map((m: any) => m.content[0].text);
	assert.ok(seedTexts.includes("first"));
	assert.ok(seedTexts.includes("answer to first"));
	assert.equal(h.entries.filter((e) => e.customType === "btw-note").length, 2);
});

test("an exchange stored as both kinds (TUI --save) is restored once", async () => {
	const d = details("saved twice");
	const h = harness({ custom: tuiCustom, entries: [threadEntry(d), noteEntry(d)] });
	await h.start();
	const text = await injectedThread(h);
	assert.equal(text.match(/User: saved twice/g)?.length, 1);
});

test("resets and overrides still apply across both entry kinds", async () => {
	const entries = () => [
			noteEntry(details("before reset")),
			threadEntry(details("before reset too")),
			{ type: "custom", customType: "btw-thread-reset", data: { timestamp: 1, mode: "tangent" } },
			noteEntry(details("after reset (note)")),
			threadEntry(details("after reset (entry)")),
			{ type: "custom", customType: "btw-model-override", data: { timestamp: 2, action: "set", ...ALT_MODEL } },
			{ type: "custom", customType: "btw-thinking-override", data: { timestamp: 3, action: "set", thinkingLevel: "high" } },
	];
	const h = harness({ custom: tuiCustom, entries: entries() });
	await h.start();
	const text = await injectedThread(h);

	assert.doesNotMatch(text, /before reset/);
	assert.match(text, /User: after reset \(note\)[\s\S]*User: after reset \(entry\)/);
	assert.equal(h.sessions[0].options.model.id, "m2", "model override restored");
	assert.equal(h.sessions[0].options.thinkingLevel, "high", "thinking override restored");

	// The reset's tangent mode is restored too: bare /btw headless asks under the tangent title.
	const headless = harness({ entries: entries() });
	await headless.start();
	await headless.run("btw");
	assert.equal(headless.inputs[0][0], "BTW tangent");
});

// ── bare /btw headless ──────────────────────────────────────────────────────

test("bare /btw headless asks via ui.input and runs the typed question", async () => {
	const h = harness({ input: "  typed question  " });
	await h.run("btw");
	assert.deepEqual(h.inputs[0], ["BTW", "Ask a side question…"]);
	assert.deepEqual(h.prompts, ["typed question"]);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].customType, "btw-note");
});

test("bare /btw headless with cancelled or empty input writes nothing and calls no model", async () => {
	for (const input of [undefined, "   "]) {
		const h = harness({ input });
		await h.run("btw");
		assert.equal(h.inputs.length, 1);
		assert.deepEqual(h.prompts, []);
		assert.deepEqual(h.entries, []);
	}
});

// ── inject / summarize confirmation ─────────────────────────────────────────

test("headless /btw:inject confirms first; declining keeps the thread", async () => {
	const declined = harness({ confirm: false, entries: [noteEntry(details("q"))] });
	await declined.start();
	await declined.run("btw:inject");
	assert.equal(declined.confirms.length, 1);
	assert.equal(declined.userMessages.length, 0);
	assert.ok(!declined.entries.some((e) => e.customType === "btw-thread-reset"));

	const accepted = harness({ confirm: true, entries: [noteEntry(details("q"))] });
	await accepted.start();
	await accepted.run("btw:inject");
	assert.equal(accepted.userMessages.length, 1);
	assert.match(accepted.userMessages[0].content, /User: q\nAssistant: answer to q/);
	assert.ok(accepted.entries.some((e) => e.customType === "btw-thread-reset"));
});

test("headless /btw:summarize confirms with the summary before injecting", async () => {
	const h = harness({ confirm: true, entries: [noteEntry(details("q"))] });
	await h.start();
	await h.run("btw:summarize");
	assert.equal(h.confirms.length, 1);
	assert.equal(h.confirms[0][0], "Inject BTW summary?");
	assert.match(h.confirms[0][1], /^answer to User: q/);
	assert.equal(h.userMessages.length, 1);
});

test("TUI /btw:inject never asks for confirmation", async () => {
	const h = harness({ custom: tuiCustom, entries: [threadEntry(details("q"))] });
	await h.start();
	await injectedThread(h);
	assert.equal(h.confirms.length, 0);
});
