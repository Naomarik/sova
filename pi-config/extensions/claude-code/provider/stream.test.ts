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
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Tool,
	Type,
} from "@earendil-works/pi-ai";
import { streamClaudeCode, resolveClaudeEffort } from "./stream.ts";
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
