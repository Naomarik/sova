/**
 * Fixture-driven tests for the CLI-frames → pi-ai event adapter.
 * No CLI runs: every turn comes from recorded stream-json in ./fixtures.
 *
 *   node ~/pi-config/extensions/claude-code/tests/run.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessageEvent,
	type Api,
	calculateCost,
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Tool,
	Type,
} from "@earendil-works/pi-ai";
import { dropLeadingUntaggedSection, streamClaudeCode, resolveClaudeEffort } from "./stream.ts";
import { parseClaudeFrame, type ClaudeFrame, type ClaudeSessionBridge, type ClaudeTurnRequest } from "./types.ts";
import { STATIC_MODELS, toProviderModel } from "./index.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

function load(name: string): ClaudeFrame[] {
	const lines = readFileSync(`${fixtures}${name}`, "utf8").split("\n").filter((line) => line.trim());
	const frames: ClaudeFrame[] = [];
	for (const line of lines) {
		const frame = parseClaudeFrame(JSON.parse(line));
		if (frame) frames.push(frame);
	}
	return frames;
}

const tools: Tool[] = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
];

function model(id = "sonnet"): Model<Api> {
	const definition = STATIC_MODELS.find((candidate) => candidate.id === id) ?? toProviderModel({ id, name: id });
	return { ...definition, provider: "claude-code-cli", api: "claude-code-cli", baseUrl: "claude-code-cli://local" } as Model<Api>;
}

function context(messages: Message[] = [{ role: "user", content: "hi", timestamp: 1 }]) {
	return normalizeContext({ systemPrompt: "You are pi.", tools, messages });
}

/** A bridge that replays frames, recording the request it was handed. */
function fakeBridge(frames: ClaudeFrame[], options: { pauseAfter?: number; hang?: boolean } = {}) {
	const state: { request?: ClaudeTurnRequest; signal?: AbortSignal; closed: boolean; delivered: number } = { closed: false, delivered: 0 };
	const bridge: ClaudeSessionBridge = {
		runTurn(request, signal) {
			state.request = request;
			state.signal = signal;
			return (async function* () {
				try {
					for (const frame of frames) {
						yield frame;
						state.delivered++;
						if (options.pauseAfter !== undefined && state.delivered === options.pauseAfter && options.hang) {
							// Like the real bridge: stay quiet until the caller aborts.
							await new Promise<void>((resolve) => {
								if (signal?.aborted) resolve();
								else signal?.addEventListener("abort", () => resolve(), { once: true });
							});
							return;
						}
					}
				} finally {
					state.closed = true;
				}
			})();
		},
	};
	return { bridge, state };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const types = (events: AssistantMessageEvent[]) => events.map((event) => event.type);

/** The assistant message carried by a terminal event, whichever it is. */
function finalMessage(event: AssistantMessageEvent) {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	throw new Error(`not a terminal event: ${event.type}`);
}

function last(events: AssistantMessageEvent[]) {
	const event = events[events.length - 1];
	assert.ok(event.type === "done" || event.type === "error", `expected a terminal event, got ${event.type}`);
	return event;
}

test("a text turn maps to start, text events, and done/stop", async () => {
	const { bridge, state } = fakeBridge(load("text-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);
	assert.deepEqual(deltas, ["Hello", ", world"]);
	const terminal = last(events);
	assert.equal(terminal.type, "done");
	assert.equal(terminal.type === "done" && terminal.reason, "stop");
	const message = finalMessage(terminal);
	assert.deepEqual(message.content, [{ type: "text", text: "Hello, world" }]);
	assert.equal(message.model, "sonnet");
	assert.equal(message.provider, "claude-code-cli");
	// The whole-message `assistant` frame must not duplicate the streamed text.
	assert.equal(message.content.length, 1);
	assert.deepEqual(state.request?.messages.length, 2); // system + user
	assert.equal(state.closed, true);
});

test("usage comes from the stream and costs nothing", async () => {
	const { bridge } = fakeBridge(load("text-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	const message = finalMessage(terminal);
	assert.deepEqual(message.usage, {
		input: 120,
		output: 7,
		cacheRead: 40,
		cacheWrite: 10,
		totalTokens: 177,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("a multi-step turn's summed result usage does not replace the last step's", async () => {
	// The final step of a seven-step CLI turn: its `result.usage` is the sum over
	// all seven API calls. The message's usage, and so the context fill, is the last call's.
	const { bridge } = fakeBridge(load("summed-usage-turn.ndjson"));
	const priced = { ...model(), cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } as Model<Api>;
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, priced, context()))));
	assert.equal(message.stopReason, "stop");
	assert.equal(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, 33 + 265186 + 1805);
	assert.equal(message.usage.output, 690);
	assert.equal(message.usage.totalTokens, 33 + 690 + 265186 + 1805);
	// Cost is priced from the same per-message tokens, not the turn's sum.
	const expected = { ...message.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	assert.deepEqual(message.usage.cost, calculateCost(priced, expected));
	assert.ok(message.usage.cost.total > 0);
});

test("result usage is the fallback when the message carried none", async () => {
	const { bridge } = fakeBridge(load("result-only-usage-turn.ndjson"));
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, model(), context()))));
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.usage, {
		input: 11,
		output: 5,
		cacheRead: 7,
		cacheWrite: 3,
		totalTokens: 26,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("a tool turn accumulates JSON, unwraps the MCP name, and stops with toolUse", async () => {
	const { bridge } = fakeBridge(load("tool-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	assert.deepEqual(types(events), [
		"start",
		"thinking_start", "thinking_delta", "thinking_delta", "thinking_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
		"done",
	]);
	const end = events.find((event) => event.type === "toolcall_end");
	assert.ok(end?.type === "toolcall_end");
	assert.deepEqual(end.toolCall, { type: "toolCall", id: "toolu_01", name: "read", arguments: { path: "README.md" } });
	const thinking = events.find((event) => event.type === "thinking_end");
	assert.equal(thinking?.type === "thinking_end" && thinking.content, "The file needs reading.");
	const terminal = last(events);
	assert.equal(terminal.type === "done" && terminal.reason, "toolUse");
	const message = finalMessage(terminal);
	const block = message.content[0];
	assert.equal(block.type === "thinking" && block.thinkingSignature, "sig-abc");
	// The provider must not leave internal accumulation state on the message.
	assert.equal(Object.hasOwn(message.content[1], "partialJson"), false);
	assert.equal(Object.hasOwn(message.content[1], "index"), false);
});

test("a turn without partial messages is replayed from the assistant frame", async () => {
	const { bridge } = fakeBridge(load("whole-message-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	assert.deepEqual(types(events), [
		"start",
		"text_start", "text_delta", "text_end",
		"toolcall_start", "toolcall_delta", "toolcall_end",
		"done",
	]);
	const terminal = last(events);
	assert.equal(terminal.type === "done" && terminal.reason, "toolUse");
	const message = finalMessage(terminal);
	assert.deepEqual(message.content[1], { type: "toolCall", id: "toolu_07", name: "bash", arguments: { command: "ls" } });
});

test("per-block assistant frames inside a streamed message are not replayed on top of the stream", async () => {
	// The real CLI under --include-partial-messages: one assistant frame per
	// content block, each carrying the final stop_reason, interleaved with
	// the stream and with the tools/call control requests.
	const { bridge } = fakeBridge(load("per-block-tools-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	assert.deepEqual(types(events), [
		"start",
		"thinking_start", "thinking_end",
		"text_start", "text_delta", "text_delta", "text_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
		"done",
	]);
	const terminal = last(events);
	assert.equal(terminal.type === "done" && terminal.reason, "toolUse");
	const message = finalMessage(terminal);
	assert.deepEqual(message.content.slice(2), [
		{ type: "toolCall", id: "toolu_PB_READ", name: "read", arguments: { path: "README.md" } },
		{ type: "toolCall", id: "toolu_PB_BASH", name: "bash", arguments: { command: "git status --short" } },
	]);
});

test("a failed result ends the stream with an error carrying the CLI message", async () => {
	const { bridge } = fakeBridge(load("failed-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "error");
	const message = finalMessage(terminal);
	assert.equal(message.errorMessage, "Claude API error: overloaded_error");
	assert.equal(message.stopReason, "error");
});

test("an aborted terminal reason is reported as aborted, not as a failure", async () => {
	const { bridge } = fakeBridge(load("aborted-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "aborted");
});

test("a stream that just ends is protocol corruption, not a silent stop", async () => {
	const frames = load("text-turn.ndjson").filter(
		(frame) => frame.type !== "result" && frame.type !== "assistant" && !(frame.type === "stream" && frame.event.type === "message_delta"),
	);
	const { bridge } = fakeBridge(frames);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	const message = finalMessage(terminal);
	assert.match(message.errorMessage ?? "", /without a stop reason/);
});

test("invalid tool-call JSON fails the stream instead of inventing arguments", async () => {
	const frames = load("tool-turn.ndjson").map((frame) => {
		if (frame.type === "stream" && frame.event.type === "content_block_delta" && frame.event.delta.kind === "input_json") {
			return { ...frame, event: { ...frame.event, delta: { kind: "input_json" as const, partialJson: "{oops" } } };
		}
		return frame;
	});
	const { bridge } = fakeBridge(frames);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	const message = finalMessage(terminal);
	assert.match(message.errorMessage ?? "", /invalid JSON arguments for tool "read"/);
});

test("a delta for an unknown content block is reported, never dropped", async () => {
	const frames: ClaudeFrame[] = [
		{ type: "init", sessionId: "s" },
		{ type: "stream", event: { type: "content_block_delta", index: 4, delta: { kind: "text", text: "x" } } },
	];
	const { bridge } = fakeBridge(frames);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	const message = finalMessage(terminal);
	assert.match(message.errorMessage ?? "", /unknown content block 4/);
});

/** No tool call on a terminal message may be half-built or carry adapter state. */
function assertNoPartialToolCalls(content: ReturnType<typeof finalMessage>["content"]) {
	for (const block of content) {
		assert.ok(!Object.hasOwn(block, "partialJson"), "partialJson leaked onto the message");
		assert.ok(!Object.hasOwn(block, "index"), "the CLI block index leaked onto the message");
		if (block.type === "toolCall") assert.notDeepEqual(block.arguments, {}, `tool call ${block.id} kept empty arguments`);
	}
}

test("a new message while a block is still open is a protocol error", async () => {
	const frames = load("tool-turn.ndjson");
	const open = frames.findIndex((f) => f.type === "stream" && f.event.type === "content_block_start");
	const { bridge } = fakeBridge([...frames.slice(0, open + 1), { type: "stream", event: { type: "message_start" } }]);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.match(finalMessage(terminal).errorMessage ?? "", /started a new message while content block 0 was open/);
});

test("a dying child's cut-off retry ahead of the next child's message ends cleanly", async () => {
	// Recovered from a live session: the old child's tool_use never closed, and
	// the replacement's thinking block reused index 0.
	const { bridge } = fakeBridge(load("leaked-retry-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	const message = finalMessage(terminal);
	assert.match(message.errorMessage ?? "", /started a new message while content block 0 was open/);
	assert.ok(!message.content.some((block) => block.type === "toolCall"), "the stale tool call survived");
	assertNoPartialToolCalls(message.content);
});

test("an errored turn never persists a half-built tool call", async () => {
	const frames = load("tool-turn.ndjson");
	const delta = frames.findIndex((f) => f.type === "stream" && f.event.type === "content_block_delta" && f.event.delta.kind === "input_json");
	const cut: ClaudeFrame[] = [
		...frames.slice(0, delta),
		{ type: "stream", event: { type: "content_block_delta", index: 1, delta: { kind: "input_json", partialJson: "{\"path\": \"a." } } },
		{ type: "result", outcome: "error", message: "Claude Code reported a failed turn" },
	];
	const { bridge } = fakeBridge(cut);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	const message = finalMessage(terminal);
	assert.ok(!message.content.some((block) => block.type === "toolCall"));
	assertNoPartialToolCalls(message.content);
});

test("a delta of the wrong kind names the block it hit", async () => {
	const frames: ClaudeFrame[] = [
		{ type: "stream", event: { type: "message_start" } },
		{ type: "stream", event: { type: "content_block_start", index: 2, block: { kind: "tool_use", id: "toolu_X", name: "mcp__sova__read", input: {} } } },
		{ type: "stream", event: { type: "content_block_delta", index: 2, delta: { kind: "thinking", thinking: "hm" } } },
	];
	const { bridge } = fakeBridge(frames);
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.match(finalMessage(terminal).errorMessage ?? "", /thinking delta for toolCall block 2 \(toolu_X\)/);
});

test("abort mid-stream ends the turn and closes the bridge iterator", async () => {
	const controller = new AbortController();
	const { bridge, state } = fakeBridge(load("text-turn.ndjson"), { pauseAfter: 4, hang: true });
	const stream = streamClaudeCode(bridge, model(), context(), { signal: controller.signal });
	const events: AssistantMessageEvent[] = [];
	const done = (async () => {
		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") controller.abort();
		}
	})();
	await done;
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "aborted");
	assert.equal(state.signal, controller.signal, "the bridge must receive the caller's signal");
	assert.equal(state.closed, true, "the bridge iterator must be closed on abort");
	// Nothing after the abort leaks through.
	assert.equal(events.filter((event) => event.type === "text_end").length, 0);
});

test("an already-aborted signal never starts a turn", async () => {
	const { bridge } = fakeBridge(load("text-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context(), { signal: AbortSignal.abort() }));
	assert.deepEqual(types(events), ["start", "error"]);
	const terminal = last(events);
	assert.equal(terminal.type === "error" && terminal.reason, "aborted");
});

test("onPayload and onResponse are both called, and a replacement payload is used", async () => {
	const { bridge, state } = fakeBridge(load("text-turn.ndjson"));
	const seen: { payload?: unknown; status?: number } = {};
	const options: SimpleStreamOptions = {
		reasoning: "high",
		sessionId: "pi-session-9",
		onPayload: (payload) => {
			seen.payload = payload;
			return { ...(payload as object), model: "haiku" };
		},
		onResponse: (response) => {
			seen.status = response.status;
		},
	};
	await collect(streamClaudeCode(bridge, model(), context(), options));
	assert.equal(seen.status, 200);
	assert.deepEqual((seen.payload as ClaudeTurnRequest).effort, "high");
	assert.equal((seen.payload as ClaudeTurnRequest).sessionId, "pi-session-9");
	assert.equal((seen.payload as ClaudeTurnRequest).systemPrompt?.startsWith("You are pi."), true);
	assert.deepEqual((seen.payload as ClaudeTurnRequest).tools.map((tool) => tool.name), ["read", "bash"]);
	assert.equal(state.request?.model, "haiku", "the replacement payload must reach the bridge");
});

test("thinking level maps to the CLI effort ladder, and off means no effort", () => {
	assert.equal(resolveClaudeEffort(model(), undefined), undefined);
	assert.equal(resolveClaudeEffort(model(), "low"), "low");
	assert.equal(resolveClaudeEffort(model(), "max"), "max");
	assert.equal(resolveClaudeEffort(model(), "minimal"), undefined, "the CLI has no minimal effort");
	assert.equal(resolveClaudeEffort(model("haiku"), "high"), undefined, "haiku reports no effort levels");
});

test("redacted thinking keeps its opaque signature and emits no empty deltas", async () => {
	const { bridge } = fakeBridge(load("redacted-thinking-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	// The empty thinking deltas the subscription CLI sends produce no events.
	assert.deepEqual(types(events), ["start", "thinking_start", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	const message = finalMessage(last(events));
	assert.deepEqual(message.content[0], { type: "thinking", thinking: "", thinkingSignature: "EqoBCkYIBRgCKkB0", redacted: true });
	assert.deepEqual(message.content[1], { type: "text", text: "Done." });
});

test("a success subtype with is_error still ends as an error", async () => {
	const { bridge } = fakeBridge(load("success-with-error-flag.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "error");
	assert.equal(finalMessage(terminal).errorMessage, "Credit balance is too low");
});

test("a compaction request with no tools streams normally", async () => {
	const { bridge, state } = fakeBridge(load("text-turn.ndjson"));
	const bare = normalizeContext({ messages: [{ role: "user", content: "Summarize the conversation.", timestamp: 1 }] });
	const events = await collect(streamClaudeCode(bridge, model(), bare));
	assert.equal(last(events).type, "done");
	assert.deepEqual(state.request?.tools, []);
	assert.equal(state.request?.systemPrompt, undefined);
});

// ---------------------------------------------------------------------------
// The preamble strip: pi's untagged lead-in never reaches the CLI
// ---------------------------------------------------------------------------

const STOCK_PREAMBLE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** A transcript whose head system message is pi's structured prompt: preamble plus tagged sections. */
function sectioned(sections: Record<string, string>) {
	const head = { role: "system", content: "", sections, toolsAdded: tools, timestamp: 0 } as unknown as Message;
	return normalizeContext({ messages: [head, { role: "user", content: "hi", timestamp: 1 }] });
}

async function sentPrompt(transcript: ReturnType<typeof normalizeContext>): Promise<string | undefined> {
	const { bridge, state } = fakeBridge(load("text-turn.ndjson"));
	await collect(streamClaudeCode(bridge, model(), transcript));
	return state.request?.systemPrompt;
}

test("the stock preamble is dropped and the tagged sections pass through byte-for-byte", async () => {
	const sent = await sentPrompt(sectioned({
		preamble: STOCK_PREAMBLE,
		tools: "<tools>\n- read: …\n</tools>",
		cwd: "<cwd>\n/x\n</cwd>",
	}));
	assert.equal(sent, "<tools>\n- read: …\n</tools>\n\n<cwd>\n/x\n</cwd>");
});

test("a custom SYSTEM.md preamble occupies the same slot and is dropped too", async () => {
	const sent = await sentPrompt(sectioned({
		preamble: "You are Grace.\nYou answer in haiku.\n\nNever apologise.",
		addendum: "<addendum>\nBe brief.\n</addendum>",
		cwd: "<cwd>\n/x\n</cwd>",
	}));
	assert.equal(sent, "<addendum>\nBe brief.\n</addendum>\n\n<cwd>\n/x\n</cwd>");
});

test("a tagless prompt, like the summarizer's, passes through verbatim", async () => {
	const prompt = "You are a conversation summarizer.\n\nKeep file paths.";
	assert.equal(await sentPrompt(normalizeContext({ systemPrompt: prompt, messages: [] })), prompt);
});

test("an inline tag mid-line is not a section boundary", async () => {
	const prompt = "Wrap answers in <x> tags.\nUse <answer> for the final one.\n<x>not alone</x>";
	assert.equal(await sentPrompt(normalizeContext({ systemPrompt: prompt, messages: [] })), prompt);
	assert.equal(dropLeadingUntaggedSection("lead\n <tools>\n"), "lead\n <tools>\n", "the tag must be the whole line");
	assert.equal(dropLeadingUntaggedSection("lead\n<Tools>\nx"), "lead\n<Tools>\nx", "section names are lowercase");
});

test("a prompt that already opens with a tag is unchanged", async () => {
	const prompt = "<tools>\n- read\n</tools>\n\nloose line\n\n<cwd>\n/x\n</cwd>";
	assert.equal(await sentPrompt(normalizeContext({ systemPrompt: prompt, messages: [] })), prompt);
	assert.equal(dropLeadingUntaggedSection(""), "");
});

test("two prompts differing only in preamble send the same system prompt", async () => {
	const rest = { tools: "<tools>\n- read: …\n</tools>", cwd: "<cwd>\n/x\n</cwd>" };
	const one = await sentPrompt(sectioned({ preamble: STOCK_PREAMBLE, ...rest }));
	const two = await sentPrompt(sectioned({ preamble: "You are someone else entirely.", ...rest }));
	assert.equal(one, two, "a preamble-only change must not change what the bridge hashes");
});

test("drift alarm: the strip matches pi's own buildSystemPrompt from <tools> onward", async (t) => {
	// Not exported from the package root in every pi version; skip rather than deep-import.
	const agent = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
	const build = agent.buildSystemPrompt as ((input: Record<string, unknown>) => string) | undefined;
	if (typeof build !== "function") {
		t.skip("buildSystemPrompt is not exported by the installed @earendil-works/pi-coding-agent");
		return;
	}
	const original = build({ selectedTools: ["read", "bash"], toolSnippets: { read: "Read files", bash: "Run commands" }, cwd: "/x" });
	const sent = await sentPrompt(normalizeContext({ systemPrompt: original, messages: [] }));
	assert.ok(original.includes("<tools>"));
	assert.equal(sent, original.slice(original.indexOf("<tools>")));
});

test("a tool turn with no terminal result ends as toolUse: the CLI turn is still open", async () => {
	// The primary tool path. The bridge holds the CLI turn open across the
	// held tools/call, so the iterator just ends after the tool block and no
	// `result` frame arrives until the whole CLI turn finishes, several
	// runTurn calls later.
	const frames = load("tool-turn-open.ndjson");
	assert.equal(frames.some((frame) => frame.type === "result"), false, "the fixture must not carry a terminal result");
	const events = await collect(streamClaudeCode(fakeBridge(frames).bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "done");
	assert.equal(terminal.type === "done" && terminal.reason, "toolUse");
	assert.equal(finalMessage(terminal).stopReason, "toolUse");

	// Same turn from a bridge that also sends no message_delta/message_stop:
	// the stop reason then comes only from the emitted tool call. Turning that
	// into a protocol error would break every tool-using turn.
	const bare = frames.filter((frame) => !(frame.type === "stream" && (frame.event.type === "message_delta" || frame.event.type === "message_stop")));
	const bareEvents = await collect(streamClaudeCode(fakeBridge(bare).bridge, model(), context()));
	const bareTerminal = last(bareEvents);
	assert.equal(bareTerminal.type, "done");
	assert.equal(bareTerminal.type === "done" && bareTerminal.reason, "toolUse");
	const call = bareEvents.find((event) => event.type === "toolcall_end");
	assert.equal(call?.type === "toolcall_end" && call.toolCall.name, "read");
});
