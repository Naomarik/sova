/**
 * Tests for the headless degradation of the forked pi-btw extension.
 *
 *   npx tsx --test btw.test.ts
 *
 * pi-tui and pi-ai are nested under pi-coding-agent's node_modules, so a resolve hook
 * retries @earendil-works/* specifiers from pi-coding-agent before btw.ts is imported.
 * The model boundary is a fake worker host (btw chats run in processes of their own): no model
 * is ever called, no process started.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { FakeWorkerHost } = await import("../subagents/tests/fake-worker-host.ts");
type WorkerStart = import("../subagents/worker-host.ts").WorkerStart;

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

/**
 * The shared fake worker host (subagents/tests/fake-worker-host.ts), answering btw's questions as a
 * btw chat would: `answer to <question>`, on the feed and in the chat's session file (which a
 * reattached session reads). `hold` keeps a question unanswered until `finish`.
 */
class BtwHost extends FakeWorkerHost {
	hold = false;
	private readonly pending = new Map<string, { text: string; key: string }>();
	constructor(dir: string) {
		super({ sessionDir: dir });
	}
	override async start(req: WorkerStart) {
		const ref = await super.start(req);
		writeFileSync(ref.sessionFile, `${JSON.stringify({ type: "session", id: ref.chatId })}\n`);
		return ref;
	}
	override async send(chatId: string, input: { text: string; delivery: "prompt" | "steer" | "followUp"; key: string }) {
		const receipt = await super.send(chatId, input);
		this.pending.set(chatId, input);
		this.state(chatId, { status: "running" });
		if (!this.hold) queueMicrotask(() => this.finish(chatId));
		return receipt;
	}
	/** Answer the question under way: one run on the feed, its two messages in the file. */
	finish(chatId: string) {
		const asked = this.pending.get(chatId);
		if (!asked) return;
		this.pending.delete(chatId);
		const w = this.get(chatId);
		const from = w.frames.length;
		// The host names a settle by the send before it and its count in the process.
		this.turn(chatId, { user: asked.text, reply: `answer to ${asked.text}`, key: `${asked.key}#1` });
		const ends = w.frames.slice(from).flatMap((f) => (f.t === "event" && (f.event as any).type === "message_end" ? [f.event as any] : []));
		const lines = ends.map((e) => JSON.stringify({ type: "message", id: e.entryId, message: e.message }));
		appendFileSync(w.ref.sessionFile, `${lines.join("\n")}\n`);
	}
	get sends() {
		return [...this.workers.values()].flatMap((w) => w.sends.map((send) => ({ chatId: w.ref.chatId, ...send })));
	}
	get stops() {
		return [...this.workers.values()].flatMap((w) => w.stops.map((reason) => ({ chatId: w.ref.chatId, reason })));
	}
}

/** The btw chats started, in order. */
const chatIds = (host: BtwHost): string[] => [...host.workers.keys()];
/** Every answer's entry id in its btw chat, in order. */
const answerIds = (host: BtwHost): string[] =>
	[...host.workers.values()].flatMap((w) => w.frames.flatMap((f) => (f.t === "event" && (f.event as any).type === "message_end" && (f.event as any).message.role === "assistant" ? [(f.event as any).entryId] : [])));

type HarnessOptions = {
	custom?: (factory: any, options: any) => Promise<unknown>;
	input?: string | undefined;
	confirm?: boolean;
	entries?: any[];
	idle?: boolean;
	/** The worker host the session sees; default a fresh fake. `null`: none (the pi TUI). */
	host?: BtwHost | null;
};

const roots: string[] = [];
after(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "btw-test-"));
	roots.push(dir);
	return dir;
}

function harness(options: HarnessOptions = {}) {
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const entries: any[] = options.entries ?? [];
	const sent: { message: any; options: any }[] = [];
	const userMessages: any[] = [];
	const notices: { message: string; level: string }[] = [];
	const inputs: any[] = [];
	const confirms: any[] = [];
	const root = tempDir();
	const host = options.host === undefined ? new BtwHost(root) : options.host;

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
		cwd: "/repo",
		model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			find: (provider: string, id: string) => [MODEL, ALT_MODEL].find((m) => m.provider === provider && m.id === id),
		},
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
			getBranch: () => entries,
			getSessionId: () => "parent-sid",
			getSessionFile: () => "/sessions/parent.jsonl",
		},
		getSystemPrompt: () => "system prompt\nCurrent date and time: now\nCurrent working directory: /repo",
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

	registerBtw(pi, { workerHost: () => (host ?? undefined) as any, root: () => root });

	return {
		ctx,
		host: host!,
		root,
		entries,
		sent,
		userMessages,
		notices,
		inputs,
		confirms,
		/** The questions sent to btw chats. */
		get prompts() {
			return host ? host.sends.map((s) => s.text) : [];
		},
		/** Each btw chat started: its loadout and seed. */
		get sessions() {
			return host ? host.starts.map((start) => ({ start, spec: start.spec, seed: (start.session as any).seed.messages })) : [];
		},
		run: (name: string, args = "") => commands.get(name).handler(args, ctx),
		start: () => events.get("session_start")({ type: "session_start" }, ctx),
		shutdown: () => events.get("session_shutdown")({ type: "session_shutdown" }, ctx),
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("inject hands off the restored thread and the new exchange, in order", async () => {
	const h = harness({ entries: [noteEntry(details("first"))], confirm: true });
	await h.start();
	await h.run("btw", "second");
	assert.match(await injectedThread(h), /first[\s\S]*second/);
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
	const next = harness({ custom: tuiCustom, entries: entries() });
	await next.start();
	await next.run("btw:tangent", "check");
	assert.equal(next.sessions[0]!.spec.model, "test/m2", "model override restored");
	assert.equal(next.sessions[0]!.spec.thinking, "high", "thinking override restored");

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

// ── the side thread as a hidden chat ─────────────────────────────────────────

const WORKER_MARK = join(import.meta.dirname, "..", "subagents", "worker-mark.ts");
const BTW_CHILD = join(import.meta.dirname, "child.ts");

test("the first question starts one hidden btw chat: seeded, the coding tools, the marker and child.ts, the prompt in a 0600 file named by path", async () => {
	const h = harness({ entries: [{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "main work" }], timestamp: 1 } }] });
	await h.run("btw", "what is x?");
	await h.run("btw", "and y?");

	assert.equal(h.sessions.length, 1, "a follow-up continues the same chat");
	const { start, spec, seed } = h.sessions[0]!;
	assert.match(start.key, /^parent-sid:btw-contextual-/);
	assert.equal(spec.kind, "btw");
	assert.deepEqual(spec.parent, { sessionId: "parent-sid", path: "/sessions/parent.jsonl", workerId: start.key.slice("parent-sid:".length) });
	assert.equal(spec.cwd, "/repo");
	assert.equal(spec.model, "test/m1");
	assert.equal(spec.thinking, "off");
	assert.deepEqual(spec.builtins, ["read", "bash", "edit", "write"]);
	assert.deepEqual(spec.extensions, [WORKER_MARK, BTW_CHILD], "the marker first, child.ts last");
	assert.equal(spec.appendSystemPrompt, null);
	assert.equal(start.task, null, "it comes up idle; the question is a send");
	assert.equal((start.session as any).seed.dir, join(h.root, ".sessions"));
	assert.equal(seed[0].content[0].text, "main work", "the main thread's conversation is the seed");

	const file = spec.env.PI_BTW_SYSTEM_PROMPT_FILE;
	assert.ok(file.startsWith(join(h.root, ".runs")), "the variable is a path in the thread's run dir");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const prompt = readFileSync(file, "utf8");
	assert.ok(prompt.startsWith("system prompt\n\nYou are having an aside conversation"), "the main thread's prompt without its footer, then the aside text");
	assert.doesNotMatch(prompt, /Current date and time/);

	assert.deepEqual(h.prompts, ["what is x?", "and y?"]);
	assert.equal(h.host.sends[0]!.chatId, h.host.sends[1]!.chatId);
	assert.notEqual(h.host.sends[0]!.key, h.host.sends[1]!.key, "each question is its own keyed send");
	assert.equal(h.entries.filter((e) => e.customType === "btw-note").length, 2);
	assert.equal(h.entries.find((e) => e.customType === "btw-note").details.entryId, answerIds(h.host)[0], "the answer's entry id in the btw chat is recorded with it");
});

test("a thread switch, /btw:new, /btw:clear and a model change stop the chat and remove its run dir", async () => {
	const h = harness();
	await h.run("btw", "one");
	const promptFile = h.sessions[0]!.spec.env.PI_BTW_SYSTEM_PROMPT_FILE;
	await h.run("btw:tangent", "two");
	assert.deepEqual(h.host.stops.map((s) => s.chatId), chatIds(h.host).slice(0, 1));
	assert.throws(() => statSync(promptFile), /ENOENT/, "the prompt file goes with the chat");
	assert.match(h.sessions[1]!.start.key, /btw-tangent-/);
	assert.deepEqual(h.sessions[1]!.seed, [], "a tangent starts with no main-thread context");
	await h.run("btw:new");
	await h.run("btw:model", "test m2 openai-responses");
	await h.run("btw:clear");
	assert.deepEqual(h.host.stops.map((s) => s.chatId), chatIds(h.host).slice(0, 3));
	assert.equal(readdirSync(join(h.root, ".runs")).length, 0);
});

test("without Sova's worker host /btw says it needs the chat runtime, and records nothing", async () => {
	const h = harness({ host: null });
	await h.run("btw", "anyone there?");
	assert.equal(h.entries.length, 0);
	assert.match(h.notices.at(-1)!.message, /\/btw needs Sova's chat runtime/);
});

test("/btw:summarize runs in a second hidden chat with no tools and the summary prompt alone, stopped when it answers", async () => {
	const h = harness({ confirm: true, entries: [noteEntry(details("q"))] });
	await h.start();
	await h.run("btw:summarize");
	const summary = h.sessions.at(-1)!;
	assert.match(summary.start.key, /btw-summarize-/);
	assert.deepEqual(summary.spec.builtins, []);
	assert.equal(summary.spec.thinking, "off");
	assert.deepEqual(h.host.stops.map((s) => s.reason), ["btw summary done"]);
	assert.equal(h.userMessages.length, 1);
});

test("a reload mid-question leaves the chat running; the reopened session reattaches it and records the answer once, even across a second reload", async () => {
	const dir = tempDir();
	const host = new BtwHost(dir);
	host.hold = true;
	const first = harness({ host });
	void first.run("btw", "slow question");
	await tick();
	assert.equal(host.sends.length, 1);
	await first.shutdown();
	assert.equal(host.stops.length, 0, "the closing session leaves the chat running");

	const second = harness({ host, entries: first.entries });
	await second.start();
	host.finish(chatIds(host)[0]!);
	await tick();
	const notes = () => second.entries.filter((e) => e.customType === "btw-note");
	assert.equal(notes().length, 1);
	assert.equal(notes()[0].details.question, "slow question");
	assert.equal(notes()[0].details.answer, "answer to slow question");
	assert.equal(notes()[0].details.entryId, answerIds(host)[0]);

	await second.shutdown();
	const third = harness({ host, entries: second.entries });
	await third.start();
	await tick();
	assert.equal(third.entries.filter((e) => e.customType === "btw-note").length, 1, "an answer already on the branch is not recorded again");
	host.hold = false;
	await third.run("btw", "follow-up");
	assert.equal(host.starts.length, 1, "the follow-up continues the reattached chat");
	assert.equal(third.entries.filter((e) => e.customType === "btw-note").length, 2);
});

test("an answer whose feed was missed (a gap) is read from the chat's file when its state says it settled", async () => {
	const h = harness();
	h.host.hold = true;
	const asked = h.run("btw", "missed?");
	await tick();
	const w = h.host.get(chatIds(h.host)[0]!);
	const watchers = [...w.watchers];
	w.watchers.clear();
	h.host.finish(w.ref.chatId);
	for (const fn of watchers) w.watchers.add(fn);
	h.host.state(w.ref.chatId, {});
	await asked;
	const note = h.entries.find((e) => e.customType === "btw-note");
	assert.equal(note?.details.answer, "answer to missed?");
	assert.equal(note?.details.entryId, answerIds(h.host)[0]);
});

test("at session_start a btw chat of another mode than the restored thread is stopped and records nothing", async () => {
	const dir = tempDir();
	const host = new BtwHost(dir);
	const first = harness({ host });
	await first.run("btw", "contextual one");
	await first.shutdown();
	const entries = [...first.entries, { type: "custom", customType: "btw-thread-reset", data: { timestamp: 1, mode: "tangent" } }];
	const second = harness({ host, entries });
	await second.start();
	await tick();
	assert.deepEqual(host.stops.map((s) => s.reason), ["no btw thread records it"]);
	assert.equal(second.entries.filter((e) => e.customType === "btw-note").length, 1);
});

test("no pi session is created in this process anywhere in pi-config: every side chat goes through the worker host", () => {
	const root = join(import.meta.dirname, "..", "..");
	const offenders: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			// Test tooling (`tests/`) may drive a pi session of its own; product code never does.
			if (name === "node_modules" || name === "tests" || name.startsWith(".")) continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(ts|mjs|js)$/.test(name) && !name.endsWith(".test.ts") && /\bcreateAgentSession\s*\(/.test(readFileSync(path, "utf8"))) offenders.push(path.slice(root.length + 1));
		}
	};
	walk(root);
	assert.deepEqual(offenders, []);
});
