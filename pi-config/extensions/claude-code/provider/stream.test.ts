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
import { dropPiPreamble, PI_STOCK_PREAMBLE, streamClaudeCode, resolveClaudeEffort } from "./stream.ts";
import { parseClaudeFrame, parseToolInput, type ClaudeFrame, type ClaudeSessionBridge, type ClaudeTurnRequest } from "./types.ts";
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

test("the answering model and the 1-hour cache writes are recorded; a later usage without the split keeps it", async () => {
	const raw = [
		{ type: "system", subtype: "init", session_id: "s" },
		{ type: "stream_event", event: { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 90, ephemeral_5m_input_tokens: 0 } } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 90 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "result", subtype: "success", is_error: false },
	];
	const { bridge } = fakeBridge(raw.map((f) => parseClaudeFrame(f)).filter((f): f is ClaudeFrame => !!f));
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, model("opus[1m]"), context()))));
	assert.equal(message.model, "opus[1m]", "the pi model stays the alias");
	assert.equal(message.responseModel, "claude-opus-5-5");
	assert.equal(message.usage.cacheWrite, 90);
	assert.equal(message.usage.cacheWrite1h, 90);
	assert.equal(message.usage.output, 9);
	assert.equal(message.usage.cost.total, 0);
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

// ---------------------------------------------------------------------------
// Tool calls whose arguments are not valid JSON (§app.claude-code-provider/invalid-tool-input)
// ---------------------------------------------------------------------------

/** Parsed frames from raw stream-json objects, as the bridge hands them over. */
function frames(lines: unknown[]): ClaudeFrame[] {
	return lines.flatMap((line) => { const frame = parseClaudeFrame(line); return frame ? [frame] : []; });
}

type CliBlock = { text: string } | { tool: string; id: string; json: string };

/** One streamed CLI message: its blocks, its stop reason, and its usage at start and end. */
function cliMessage(blocks: CliBlock[], stop: string, usage: { input: number; cacheRead?: number; output: number } = { input: 10, output: 5 }): unknown[] {
	const u = (output: number) => ({ input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: 0, output_tokens: output });
	const out: unknown[] = [{ type: "stream_event", event: { type: "message_start", message: { usage: u(1) } } }];
	blocks.forEach((block, index) => {
		if ("text" in block) {
			out.push({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
			out.push({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
		} else {
			out.push({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: `mcp__sova__${block.tool}`, input: {} } } });
			out.push({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: block.json } } });
		}
		out.push({ type: "stream_event", event: { type: "content_block_stop", index } });
	});
	out.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: u(usage.output) } });
	out.push({ type: "stream_event", event: { type: "message_stop" } });
	return out;
}

const BAD_JSON = "{\"command\":\"ls\"}]}"; // closed early, closers left over: the shape seen live
const invalidDiagnostics = (message: ReturnType<typeof finalMessage>) => (message.diagnostics ?? []).filter((d) => d.type === "claude-code.invalid-tool-input");
const toolCallEnds = (events: AssistantMessageEvent[]) => events.flatMap((e) => e.type === "toolcall_end" ? [e.toolCall.id] : []);

test("parseToolInput: the block-start input for no deltas, a plain object only, never the input quoted", () => {
	assert.deepEqual(parseToolInput("", { a: 1 }), { ok: true, args: { a: 1 } });
	assert.deepEqual(parseToolInput(""), { ok: true, args: {} });
	assert.deepEqual(parseToolInput("{\"path\":\"a\"}"), { ok: true, args: { path: "a" } });
	for (const json of ["[1]", "\"x\"", "null", "3", "true"]) {
		const verdict = parseToolInput(json);
		assert.equal(verdict.ok, false, json);
		assert.match(!verdict.ok ? verdict.error : "", /^not a JSON object/);
	}
	const extra = parseToolInput(BAD_JSON);
	assert.ok(!extra.ok);
	assert.equal(extra.bytes, Buffer.byteLength(BAD_JSON));
	assert.equal(extra.position, BAD_JSON.indexOf("]}"));
	const cut = parseToolInput("{\"a\":");
	assert.ok(!cut.ok);
	assert.equal(cut.position, 5);
	// V8 quotes the input in some messages; a verdict never carries it.
	const quoted = parseToolInput("oops-secret");
	assert.ok(!quoted.ok);
	assert.doesNotMatch(quoted.error, /oops|secret/);
	const wide = parseToolInput("{\"é\":");
	assert.ok(!wide.ok);
	assert.equal(wide.bytes, 6, "bytes, not characters");
});

test("a rejected-only tool call and the CLI's valid retry stay one pi message, on the retry's usage", async () => {
	const lines = readFileSync(`${fixtures}invalid-tool-input-turn.ndjson`, "utf8").split("\n").filter((l) => l.trim());
	const raw = JSON.parse(lines.find((l) => l.includes("__unparsedToolInput"))!).message.content[0].input.__unparsedToolInput.raw as string;
	const { bridge } = fakeBridge(load("invalid-tool-input-turn.ndjson"));
	const events = await collect(streamClaudeCode(bridge, model("opus"), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "done");
	const message = finalMessage(terminal);
	assert.equal(message.stopReason, "toolUse");
	// The rejected attempt's thinking and text stay, in order; only the retry's call is a call.
	assert.deepEqual(message.content.map((block) => block.type), ["thinking", "text", "toolCall"]);
	const call = message.content[2];
	assert.ok(call?.type === "toolCall");
	assert.equal(call.id, "toolu_IJ_GOOD");
	assert.equal(call.name, "align");
	assert.deepEqual(call.arguments, { ops: [{ op: "decide", q: "q1", decision: "Diagnostic only" }, { op: "accept", qs: ["q2"] }] });
	assert.deepEqual(toolCallEnds(events), ["toolu_IJ_GOOD"], "the rejected call must never reach toolcall_end");
	assertNoPartialToolCalls(message.content);
	assert.ok(!JSON.stringify(message.content).includes("toolu_IJ_BAD"));
	// One diagnostic, with no raw arguments in it.
	const [diagnostic, ...more] = invalidDiagnostics(message);
	assert.equal(more.length, 0);
	assert.deepEqual(diagnostic?.details, {
		tool: "align", toolCallId: "toolu_IJ_BAD", bytes: Buffer.byteLength(raw), position: raw.length - 2,
		// The superseded attempt's own counts: its usage is not the message's.
		usage: { input: 6, output: 1224, cacheRead: 60000, cacheWrite: 800, cacheWrite1h: 800 },
	});
	assert.ok(!JSON.stringify(message.diagnostics).includes("Diagnostic only"), "the diagnostic kept argument text");
	// Usage is the last CLI message's, its 1h split included: context fill reads 2 + 61500 + 1300.
	assert.equal(message.usage.input, 2);
	assert.equal(message.usage.cacheRead, 61500);
	assert.equal(message.usage.cacheWrite, 1300);
	assert.equal(message.usage.cacheWrite1h, 0);
	assert.equal(message.usage.output, 310);
	assert.equal(message.usage.totalTokens, 2 + 61500 + 1300 + 310);
	assert.equal(message.responseModel, "claude-opus-5-5");
});

test("the rejected attempt's 1-hour cache split never carries into the retry's usage", async () => {
	const split = { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 }, output_tokens: 1 };
	// The rejected attempt: its start and delta both report the 1h split, as the API does.
	const attemptLines = cliMessage([{ tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use").map((line) => {
		const event = (line as { event: { type: string } }).event;
		if (event.type === "message_start") return { type: "stream_event", event: { type: "message_start", message: { usage: split } } };
		if (event.type === "message_delta") return { type: "stream_event", event: { ...event, usage: { ...split, output_tokens: 40 } } };
		return line;
	});
	const { bridge } = fakeBridge(frames([
		...attemptLines,
		// The retry's usage carries no split at all.
		...cliMessage([{ tool: "read", id: "toolu_OK", json: "{\"path\":\"a\"}" }], "tool_use", { input: 7, output: 9 }),
	]));
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, model(), context()))));
	assert.equal(message.stopReason, "toolUse");
	assert.equal(message.usage.cacheWrite, 0);
	assert.equal(message.usage.cacheWrite1h, undefined);
	assert.equal(invalidDiagnostics(message)[0]?.details?.usage && (invalidDiagnostics(message)[0]!.details!.usage as { cacheWrite1h?: number }).cacheWrite1h, 900);
});

/** A tool_use block that streams no input_json: its block-start input is all there is. */
function noDeltaToolMessage(id: string, input: { value: unknown } | undefined): unknown[] {
	const block: Record<string, unknown> = { type: "tool_use", id, name: "mcp__sova__read" };
	if (input) block.input = input.value;
	return [
		{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: block } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 4, output_tokens: 3 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
	];
}

test("with no deltas, a block-start input that is not an object is rejected, never coerced to {}", async () => {
	for (const [label, value] of [["null", null], ["a string", "a.txt"], ["an array", ["a.txt"]], ["a number", 3]] as const) {
		const { bridge } = fakeBridge(frames([
			...noDeltaToolMessage("toolu_START", { value }),
			...cliMessage([{ text: "Never mind." }], "end_turn"),
			{ type: "result", subtype: "success", is_error: false, result: "" },
		]));
		const events = await collect(streamClaudeCode(bridge, model(), context()));
		const message = finalMessage(last(events));
		assert.equal(message.stopReason, "stop", label);
		assert.ok(!message.content.some((block) => block.type === "toolCall"), `${label} start input reached pi as a call`);
		assert.deepEqual(toolCallEnds(events), [], label);
		assert.equal(invalidDiagnostics(message)[0]?.details?.toolCallId, "toolu_START", label);
		assert.equal(invalidDiagnostics(message)[0]?.details?.bytes, 0, label);
	}
});

test("with no deltas, an absent block-start input is {} and an object one is the arguments", async () => {
	for (const [input, expected] of [[undefined, {}], [{ value: {} }, {}], [{ value: { path: "a.txt" } }, { path: "a.txt" }]] as const) {
		const { bridge } = fakeBridge(frames(noDeltaToolMessage("toolu_START", input)));
		const message = finalMessage(last(await collect(streamClaudeCode(bridge, model(), context()))));
		assert.equal(message.stopReason, "toolUse", JSON.stringify(input));
		const call = message.content.find((block) => block.type === "toolCall");
		assert.ok(call?.type === "toolCall");
		assert.deepEqual(call.arguments, expected);
		assert.equal(invalidDiagnostics(message).length, 0);
		assertNoPartialToolCallState(message.content);
	}
});

/** No adapter state on a message (an empty-argument call may be legitimate here). */
function assertNoPartialToolCallState(content: ReturnType<typeof finalMessage>["content"]) {
	for (const block of content) {
		assert.ok(!Object.hasOwn(block, "partialJson"), "partialJson leaked onto the message");
		assert.ok(!Object.hasOwn(block, "index"), "the CLI block index leaked onto the message");
	}
}

test("a message with valid and invalid calls ends as toolUse with only the valid ones", async () => {
	const { bridge } = fakeBridge(frames([
		{ type: "system", subtype: "init", session_id: "s" },
		...cliMessage([{ text: "Both." }, { tool: "read", id: "toolu_OK", json: "{\"path\":\"a.txt\"}" }, { tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use", { input: 40, output: 30 }),
	]));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "done");
	const message = finalMessage(terminal);
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content.map((block) => block.type), ["text", "toolCall"]);
	assert.deepEqual(toolCallEnds(events), ["toolu_OK"]);
	assertNoPartialToolCalls(message.content);
	const [diagnostic] = invalidDiagnostics(message);
	// Its usage IS the message's: nothing superseded it, so the diagnostic carries none.
	assert.deepEqual(diagnostic?.details, { tool: "bash", toolCallId: "toolu_BAD", bytes: Buffer.byteLength(BAD_JSON), position: BAD_JSON.indexOf("]}") });
	assert.equal(message.usage.output, 30);
});

test("a call valid as JSON but not an object is rejected, never run with other arguments", async () => {
	const { bridge } = fakeBridge(frames([
		...cliMessage([{ tool: "read", id: "toolu_ARR", json: "[\"a.txt\"]" }], "tool_use"),
		...cliMessage([{ text: "Sorry." }], "end_turn"),
		{ type: "result", subtype: "success", is_error: false, result: "Sorry." },
	]));
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, model(), context()))));
	assert.equal(message.stopReason, "stop");
	assert.ok(!message.content.some((block) => block.type === "toolCall"));
	assert.match(invalidDiagnostics(message)[0]?.error?.message ?? "", /not a JSON object \(array\)/);
});

test("a reply in text instead of a retry ends the message as stop and keeps every text", async () => {
	const { bridge } = fakeBridge(frames([
		...cliMessage([{ text: "Recording." }, { tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use", { input: 50, output: 70 }),
		...cliMessage([{ text: "I could not record it; here it is in prose." }], "end_turn", { input: 60, output: 12 }),
		{ type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 110, output_tokens: 82 } },
	]));
	const events = await collect(streamClaudeCode(bridge, model(), context()));
	const terminal = last(events);
	assert.equal(terminal.type, "done");
	assert.equal(terminal.type === "done" && terminal.reason, "stop");
	const message = finalMessage(terminal);
	assert.deepEqual(message.content, [{ type: "text", text: "Recording." }, { type: "text", text: "I could not record it; here it is in prose." }]);
	assert.deepEqual(toolCallEnds(events), []);
	// The last call's usage, never the result's sum.
	assert.equal(message.usage.input, 60);
	assert.equal(message.usage.output, 12);
	assert.deepEqual(invalidDiagnostics(message)[0]?.details?.usage, { input: 50, output: 70, cacheRead: 0, cacheWrite: 0 });
});

test("a reply cut at max_tokens after a rejected call ends as length with its text", async () => {
	const { bridge } = fakeBridge(frames([
		...cliMessage([{ tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use"),
		...cliMessage([{ text: "Long answer" }], "max_tokens"),
		{ type: "result", subtype: "success", is_error: false, result: "" },
	]));
	const message = finalMessage(last(await collect(streamClaudeCode(bridge, model(), context()))));
	assert.equal(message.stopReason, "length");
	assert.deepEqual(message.content, [{ type: "text", text: "Long answer" }]);
});

test("the bridge's give-up after repeated rejections ends the message as an error, keeping text and diagnostics", async () => {
	const bad = (n: number) => cliMessage([{ text: `try ${n}` }, { tool: "bash", id: `toolu_BAD${n}`, json: BAD_JSON }], "tool_use");
	const { bridge } = fakeBridge(frames([
		...bad(1), ...bad(2), ...bad(3),
		{ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude sent invalid JSON arguments for tool \"bash\" 3 times in a row" },
	]));
	const terminal = last(await collect(streamClaudeCode(bridge, model(), context())));
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "error");
	const message = finalMessage(terminal);
	assert.match(message.errorMessage ?? "", /invalid JSON arguments for tool "bash" 3 times in a row/);
	assert.deepEqual(message.content.map((block) => block.type === "text" && block.text), ["try 1", "try 2", "try 3"]);
	assertNoPartialToolCalls(message.content);
	assert.deepEqual(invalidDiagnostics(message).map((d) => d.details?.toolCallId), ["toolu_BAD1", "toolu_BAD2", "toolu_BAD3"]);
	// Two attempts were superseded; the third's counts are the message's own.
	assert.deepEqual(invalidDiagnostics(message).map((d) => d.details?.usage !== undefined), [true, true, false]);
});

test("an abort between the rejected attempt and its retry ends the message as aborted, with no call", async () => {
	const lines = frames([...cliMessage([{ text: "Recording." }, { tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use")]);
	const { bridge, state } = fakeBridge(lines, { pauseAfter: lines.length, hang: true });
	const controller = new AbortController();
	const streaming = collect(streamClaudeCode(bridge, model(), context(), { signal: controller.signal }));
	while (state.delivered < lines.length) await new Promise((resolve) => setTimeout(resolve, 1));
	controller.abort();
	const terminal = last(await streaming);
	assert.equal(terminal.type, "error");
	assert.equal(terminal.type === "error" && terminal.reason, "aborted");
	const message = finalMessage(terminal);
	assert.deepEqual(message.content, [{ type: "text", text: "Recording." }]);
	assert.equal(invalidDiagnostics(message).length, 1);
});

test("a stream that ends after only a rejected call is still corruption, not a tool turn", async () => {
	const { bridge } = fakeBridge(frames(cliMessage([{ tool: "bash", id: "toolu_BAD", json: BAD_JSON }], "tool_use")));
	const terminal = last(await collect(streamClaudeCode(bridge, model(), context())));
	assert.equal(terminal.type, "error");
	assert.match(finalMessage(terminal).errorMessage ?? "", /without a stop reason/);
	assert.ok(!finalMessage(terminal).content.some((block) => block.type === "toolCall"));
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

test("the model's context window and output cap reach the bridge, so the fold can be sized from them", async () => {
	for (const [id, window] of [["claude-sonnet-4-6", 200_000], ["sonnet", 1_000_000], ["opus[1m]", 1_000_000]] as const) {
		const { bridge, state } = fakeBridge(load("text-turn.ndjson"));
		await collect(streamClaudeCode(bridge, model(id), context()));
		assert.equal(state.request?.contextWindow, window, id);
		assert.equal(state.request?.maxTokens, 64_000, id);
	}
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
// The preamble cut: only pi's own stock preamble never reaches the CLI
// ---------------------------------------------------------------------------

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

/** A baton/gathering session's prompt: its whole steering text is the untagged preamble. */
const BATON_PREAMBLE = [
	"You are the facilitator of a gathering.",
	"",
	"## Goal",
	"Idea 1, WhatsApp: decide whether to ship it.",
	"",
	"## Drawing guide",
	"An HTML example:",
	"<html>",
	"<script>",
	"draw();",
	"</script>",
	"</html>",
	"<tools>",
	"Never reveal another member's private notes.",
].join("\n");

test("pi's stock prompt loses exactly its preamble; the tagged sections pass through byte-for-byte", async () => {
	const sent = await sentPrompt(sectioned({
		preamble: PI_STOCK_PREAMBLE,
		tools: "<tools>\n- read: …\n</tools>",
		cwd: "<cwd>\n/x\n</cwd>",
	}));
	assert.equal(sent, "<tools>\n- read: …\n</tools>\n\n<cwd>\n/x\n</cwd>");
});

test("a baton-style custom preamble arrives whole, cwd section first or last", async () => {
	const cwd = "<cwd>\n(none)\n</cwd>";
	assert.equal(await sentPrompt(sectioned({ cwd, preamble: BATON_PREAMBLE })), `${cwd}\n\n${BATON_PREAMBLE}`);
	assert.equal(await sentPrompt(sectioned({ preamble: BATON_PREAMBLE, cwd })), `${BATON_PREAMBLE}\n\n${cwd}`);
});

test("the stock preamble is cut wherever its section sits", async () => {
	const cwd = "<cwd>\n/x\n</cwd>";
	assert.equal(await sentPrompt(sectioned({ cwd, preamble: PI_STOCK_PREAMBLE, mode: "<mode>\nm\n</mode>" })), `${cwd}\n\n<mode>\nm\n</mode>`);
});

test("a custom SYSTEM.md preamble arrives whole", async () => {
	const preamble = "You are Grace.\nYou answer in haiku.\n\nNever apologise.";
	const sent = await sentPrompt(sectioned({ preamble, addendum: "<addendum>\nBe brief.\n</addendum>", cwd: "<cwd>\n/x\n</cwd>" }));
	assert.equal(sent, `${preamble}\n\n<addendum>\nBe brief.\n</addendum>\n\n<cwd>\n/x\n</cwd>`);
});

test("a flat prompt with tag lines deep inside arrives whole", async () => {
	for (const prompt of [
		"You are a conversation summarizer.\n\nKeep file paths.",
		"Wrap answers in <x> tags.\nUse <answer> for the final one.\n<x>not alone</x>",
		"lead\n<script>\nx\n</script>\n\n<tools>\n- read\n</tools>",
		"<tools>\n- read\n</tools>\n\nloose line\n\n<cwd>\n/x\n</cwd>",
		BATON_PREAMBLE,
	]) assert.equal(await sentPrompt(normalizeContext({ systemPrompt: prompt, messages: [] })), prompt);
});

test("a flat prompt that opens with pi's stock preamble paragraph loses only that paragraph", async () => {
	const rest = "<tools>\n- read\n</tools>";
	assert.equal(await sentPrompt(normalizeContext({ systemPrompt: `${PI_STOCK_PREAMBLE}\n\n${rest}`, messages: [] })), rest);
});

test("dropPiPreamble cuts only the exact stock text as a whole opening paragraph", () => {
	assert.equal(dropPiPreamble(PI_STOCK_PREAMBLE), "");
	assert.equal(dropPiPreamble(`${PI_STOCK_PREAMBLE}\n\nmore`), "more");
	assert.equal(dropPiPreamble(`${PI_STOCK_PREAMBLE} Also be terse.`), `${PI_STOCK_PREAMBLE} Also be terse.`, "a longer first paragraph is custom");
	assert.equal(dropPiPreamble(`${PI_STOCK_PREAMBLE}\nmore`), `${PI_STOCK_PREAMBLE}\nmore`, "not a whole paragraph");
	assert.equal(dropPiPreamble(`intro\n\n${PI_STOCK_PREAMBLE}`), `intro\n\n${PI_STOCK_PREAMBLE}`, "only at the start");
	assert.equal(dropPiPreamble(""), "");
});

test("drift alarm: PI_STOCK_PREAMBLE is the installed pi's own preamble, and the cut matches its buildSystemPrompt", async () => {
	// Not exported from the package root; the alarm must fail, never skip, if pi moves it.
	const root = import.meta.resolve("@earendil-works/pi-coding-agent");
	const mod = (await import(new URL("./core/system-prompt.js", root).href)) as {
		buildSystemPromptSections: (input: Record<string, unknown>) => Record<string, string>;
		buildSystemPrompt: (input: Record<string, unknown>) => string;
	};
	const input = { selectedTools: ["read", "bash"], toolSnippets: { read: "Read files", bash: "Run commands" }, cwd: "/x" };
	assert.equal(mod.buildSystemPromptSections(input).preamble, PI_STOCK_PREAMBLE);
	assert.equal(mod.buildSystemPromptSections({ ...input, customPrompt: "Mine." }).preamble, "Mine.");
	const original = mod.buildSystemPrompt(input);
	assert.equal(await sentPrompt(sectioned(mod.buildSystemPromptSections(input))), original.slice(original.indexOf("<tools>")));
	assert.equal(await sentPrompt(normalizeContext({ systemPrompt: original, messages: [] })), original.slice(original.indexOf("<tools>")));
	const custom = mod.buildSystemPrompt({ ...input, customPrompt: BATON_PREAMBLE });
	assert.equal(await sentPrompt(sectioned(mod.buildSystemPromptSections({ ...input, customPrompt: BATON_PREAMBLE }))), custom);
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
