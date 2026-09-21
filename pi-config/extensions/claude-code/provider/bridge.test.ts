/**
 * The bridge against a fake CLI child: no live Claude, no network.
 *
 * The fake speaks the frames the team's protocol spike recorded from CLI
 * 2.1.278 — the `initialize` control handshake, the CLI-driven MCP handshake
 * over `mcp_message`, `tools/call` with a BARE tool name, and stream-json
 * output — so the tests exercise the real wire shapes rather than a paraphrase.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import {
	claudeSessionId, foldHistory, getSessionBridge, isPrefix, resetSessionBridge, SessionBridge, transcriptFingerprint, uuidv5,
} from "./session-bridge.ts";
import type { ClaudeFrame, ClaudeTurnRequest } from "./types.ts";

// ---------------------------------------------------------------------------
// Fake CLI child
// ---------------------------------------------------------------------------

class FakeClaude extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly argv: string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
	/** Every frame the bridge wrote to stdin, decoded. */
	readonly sent: Record<string, any>[] = [];
	pid: number;
	killed = false;
	exited = false;
	private buffer = "";
	/** Answer `initialize` automatically, as the CLI does. */
	autoInitialize = true;

	constructor(_command: string, argv: string[], options: any, pid = 4242) {
		super();
		this.pid = pid;
		this.argv = argv;
		this.env = options?.env ?? {};
		this.cwd = options?.cwd ?? "";
		this.stdin = new Writable({
			write: (chunk, _enc, cb) => { this.ingest(String(chunk)); cb(); },
		});
		// The real CLI exits on stdin EOF. Without this the fake would never
		// close, and the bridge is right to keep waiting rather than assume death.
		this.stdin.on("finish", () => { if (!this.exited) this.exit(0); });
	}

	private ingest(text: string): void {
		this.buffer += text;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (!line.trim()) continue;
			const frame = JSON.parse(line);
			this.sent.push(frame);
			if (this.autoInitialize && frame.type === "control_request" && frame.request?.subtype === "initialize") {
				this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
			}
			if (frame.type === "control_request" && frame.request?.subtype === "interrupt") {
				this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
			}
			this.emit("frame", frame);
		}
	}

	emitFrame(frame: unknown): void { this.stdout.write(`${JSON.stringify(frame)}\n`); }
	emitRaw(line: string): void { this.stdout.write(`${line}\n`); }

	/** The CLI's MCP handshake, in the order it was observed to arrive. */
	async handshake(): Promise<Record<string, any>[]> {
		const init = await this.mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.278" } } });
		const ready = await this.mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
		const list = await this.mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		return [init, ready, list];
	}

	/** Send one mcp_message and wait for the correlated control_response. */
	mcp(message: unknown, requestId = `req-${Math.random().toString(36).slice(2)}`): Promise<Record<string, any>> {
		const answered = this.waitFor((f) => f.type === "control_response" && f.response?.request_id === requestId);
		this.emitFrame({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name: "pi", message } });
		return answered;
	}

	/** Send a tools/call without waiting: it is held until pi answers. */
	toolCall(name: string, args: unknown, requestId: string, rpcId = 99): void {
		this.emitFrame({
			type: "control_request", request_id: requestId,
			request: { subtype: "mcp_message", server_name: "pi", message: { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } } },
		});
	}

	waitFor(predicate: (frame: Record<string, any>) => boolean, ms = 2000): Promise<Record<string, any>> {
		const existing = this.sent.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.off("frame", onFrame); reject(new Error("timed out waiting for a frame")); }, ms);
			const onFrame = (frame: Record<string, any>) => {
				if (!predicate(frame)) return;
				clearTimeout(timer); this.off("frame", onFrame); resolve(frame);
			};
			this.on("frame", onFrame);
		});
	}

	kill(): boolean { this.killed = true; this.exit(0); return true; }
	exit(code = 0): void {
		if (this.exited) return;
		this.exited = true;
		this.emit("exit", code, null);
		this.emit("close", code, null);
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tools: Tool[] = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
];

function harness() {
	const children: FakeClaude[] = [];
	const bridge = new SessionBridge({
		cwd: "/tmp/pi-bridge-test",
		spawnImpl: ((command: string, argv: string[], options: any) => {
			const child = new FakeClaude(command, argv, options, 5000 + children.length);
			children.push(child);
			return child as any;
		}) as any,
		signalGroupImpl: (pid) => {
			children.find((c) => c.pid === pid)?.kill();
		},
		timings: { requestTimeoutMs: 500, eofGraceMs: 20, termGraceMs: 20, pipeDrainMs: 5, toolDispatchTimeoutMs: 300, abortGraceMs: 200, heldCallTimeoutMs: 10_000 },
	});
	return { bridge, children };
}

function request(messages: Message[], overrides: Partial<ClaudeTurnRequest> = {}): ClaudeTurnRequest {
	return { model: "sonnet", sessionId: "pi-session-1", tools, messages, ...overrides };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

function assistantWithCall(id: string, name: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages", provider: "anthropic", model: "sonnet",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 2,
	} as Message;
}

function toolResult(id: string, name: string, text: string, isError = false): Message {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3 } as Message;
}

/** Wait until the harness has spawned child number `n` (1-based). */
async function child(children: FakeClaude[], n: number, ms = 2000): Promise<FakeClaude> {
	const deadline = Date.now() + ms;
	while (children.length < n) {
		if (Date.now() > deadline) throw new Error(`child ${n} was never spawned`);
		await new Promise((r) => setTimeout(r, 2));
	}
	return children[n - 1]!;
}

async function collect(frames: AsyncIterable<ClaudeFrame>): Promise<ClaudeFrame[]> {
	const out: ClaudeFrame[] = [];
	for await (const frame of frames) out.push(frame);
	return out;
}

/** The stream-json frames of one assistant message that calls one tool. */
function toolUseFrames(id: string, name: string, args: Record<string, unknown>): unknown[] {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__pi__${name}`, input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
	];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("uuidv5 matches the RFC 4122 vector and is stable per pi session", () => {
	assert.equal(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
	const id = claudeSessionId("pi-session-1");
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(id, claudeSessionId("pi-session-1"));
	assert.notEqual(id, claudeSessionId("pi-session-2"));
});

test("the fingerprint is cumulative, so appends are prefixes and edits are not", () => {
	const base = [user("one"), user("two")];
	const appended = [...base, user("three")];
	const edited = [user("one"), user("CHANGED"), user("three")];
	assert.ok(isPrefix(transcriptFingerprint(base), transcriptFingerprint(appended)));
	assert.ok(!isPrefix(transcriptFingerprint(base), transcriptFingerprint(edited)));
	// A truncation (rewind) is not a prefix relationship either.
	assert.ok(!isPrefix(transcriptFingerprint(appended), transcriptFingerprint(base)));
});

test("folded history is labelled lossy and carries images out of band", () => {
	const messages: Message[] = [
		user("hello"),
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
		assistantWithCall("toolu_1", "read", { path: "a.txt" }),
		toolResult("toolu_1", "read", "file body"),
	];
	const folded = foldHistory(messages, { maxLineBytes: 1, maxIdleSessions: 1, maxFoldedResultChars: 100, maxFoldedChars: 10_000 });
	assert.match(folded.text, /LOSSY/);
	assert.match(folded.text, /## User\nhello/);
	assert.match(folded.text, /tool call `read`/);
	assert.match(folded.text, /file body/);
	assert.equal(folded.images.length, 1);
	assert.equal(folded.images[0]!.data, "AAAA");
});

// ---------------------------------------------------------------------------
// Launch and handshake
// ---------------------------------------------------------------------------

test("argv, env and the MCP handshake match the spike's recorded shapes", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const frames = bridge.runTurn(request([user("hi")]))[Symbol.asyncIterator]();
	const pending = frames.next();
	const cli = await child(children, 1);

	// Argv: no built-in tools, and the allowlist entry without which dontAsk
	// auto-denies every MCP call and tools/call never arrives.
	assert.ok(cli.argv.includes("-p"));
	assert.deepEqual(cli.argv.slice(cli.argv.indexOf("--tools"), cli.argv.indexOf("--tools") + 2), ["--tools", ""]);
	assert.deepEqual(cli.argv.slice(cli.argv.indexOf("--allowedTools"), cli.argv.indexOf("--allowedTools") + 2), ["--allowedTools", "mcp__pi"]);
	assert.equal(cli.argv[cli.argv.indexOf("--session-id") + 1], claudeSessionId("pi-session-1"));
	assert.equal(cli.argv[cli.argv.indexOf("--permission-mode") + 1], "dontAsk");
	assert.equal(cli.env.MCP_TOOL_TIMEOUT, "86400000");
	assert.equal(cli.env.CLAUDECODE, undefined);
	assert.equal(cli.env.CLAUDE_CODE_ENTRYPOINT, undefined);

	const initialize = await cli.waitFor((f) => f.request?.subtype === "initialize");
	assert.deepEqual(initialize.request.sdkMcpServers, ["pi"]);

	const [init, ready, list] = await cli.handshake();
	assert.equal(init!.response.response.mcp_response.result.protocolVersion, "2025-11-25");
	// A notification has no id but still has to be answered, or the CLI wedges.
	assert.deepEqual(ready!.response.response.mcp_response, { jsonrpc: "2.0", result: {}, id: 0 });
	// tools/list publishes BARE names; the mcp__pi__ prefix only appears on the way back.
	const listed = list!.response.response.mcp_response.result.tools;
	assert.deepEqual(listed.map((t: any) => t.name), ["read", "bash"]);
	assert.equal(listed[0].description, "Read a file");
	assert.equal(listed[0].inputSchema.type, "object");

	cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "done" });
	await pending;
	await collect({ [Symbol.asyncIterator]: () => frames } as AsyncIterable<ClaudeFrame>);
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// Tool calls held across provider calls
// ---------------------------------------------------------------------------

test("a held tool call ends the pi message, and pi's result resumes the same turn", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const first = request([user("read a.txt")]);
	const collecting = collect(bridge.runTurn(first));
	const cli = await child(children, 1);
	await cli.waitFor((f) => f.request?.subtype === "initialize");
	await cli.handshake();

	for (const frame of toolUseFrames("toolu_1", "read", { path: "a.txt" })) cli.emitFrame(frame);
	cli.toolCall("read", { path: "a.txt" }, "held-1");

	// The pi message ends here even though the CLI turn is still running.
	const frames = await collecting;
	assert.ok(frames.some((f) => f.type === "stream" && f.event.type === "content_block_start"));
	assert.ok(!frames.some((f) => f.type === "result"), "a held call must not look like a finished turn");

	// pi executes the tool; the result arrives on the NEXT provider call.
	const second = request([...first.messages, assistantWithCall("toolu_1", "read", { path: "a.txt" }), toolResult("toolu_1", "read", "file body")]);
	const resuming = collect(bridge.runTurn(second));
	const answer = await cli.waitFor((f) => f.type === "control_response" && f.response?.request_id === "held-1");
	assert.deepEqual(answer.response.response.mcp_response.result, { content: [{ type: "text", text: "file body" }] });
	assert.equal(children.length, 1, "answering a held call must not restart the CLI");

	cli.emitFrame({ type: "assistant", message: { content: [{ type: "text", text: "It says hello." }], stop_reason: "end_turn" } });
	cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "It says hello." });
	const done = await resuming;
	const terminal = done.at(-1);
	assert.equal(terminal?.type, "result");
	assert.equal(terminal?.type === "result" && terminal.outcome, "success");
	await bridge.disposeAll();
});

test("two sequential tool calls run on one CLI child", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("do two things")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "read", { path: "a.txt" })) cli.emitFrame(frame);
		cli.toolCall("read", { path: "a.txt" }, "held-1", 1);
	});

	const cli = children[0]!;
	const m2 = [...m1, assistantWithCall("toolu_1", "read", { path: "a.txt" }), toolResult("toolu_1", "read", "body")];
	await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.response?.request_id === "held-1");
		for (const frame of toolUseFrames("toolu_2", "bash", { command: "ls" })) cli.emitFrame(frame);
		cli.toolCall("bash", { command: "ls" }, "held-2", 2);
	});

	const m3 = [...m2, assistantWithCall("toolu_2", "bash", { command: "ls" }), toolResult("toolu_2", "bash", "a.txt")];
	const final = await collectAfter(bridge.runTurn(request(m3)), async () => {
		await cli.waitFor((f) => f.response?.request_id === "held-2");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "Both done." });
	});

	const terminal = final.at(-1);
	assert.equal(terminal?.type === "result" && terminal.outcome, "success");
	assert.equal(children.length, 1, "one CLI child served all three provider calls");
	await bridge.disposeAll();
});

test("a steering message is sent after the held call is answered, not before", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("start")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "read", { path: "a.txt" })) cli.emitFrame(frame);
		cli.toolCall("read", { path: "a.txt" }, "held-1");
	});

	const cli = children[0]!;
	const m2 = [...m1, assistantWithCall("toolu_1", "read", { path: "a.txt" }), toolResult("toolu_1", "read", "body"), user("actually, stop after this")];
	await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.type === "user" && JSON.stringify(f.message?.content).includes("actually"));
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	const answerAt = cli.sent.findIndex((f) => f.response?.request_id === "held-1");
	const steerAt = cli.sent.findIndex((f) => f.type === "user" && JSON.stringify(f.message?.content).includes("actually"));
	assert.ok(answerAt >= 0 && steerAt >= 0);
	assert.ok(answerAt < steerAt, "the held call must be answered before the steering message is written");
	await bridge.disposeAll();
});

test("an image tool result is sent in MCP's flat shape", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("screenshot")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "read", { path: "shot.png" })) cli.emitFrame(frame);
		cli.toolCall("read", { path: "shot.png" }, "held-img");
	});

	const cli = children[0]!;
	const image: Message = {
		role: "toolResult", toolCallId: "toolu_1", toolName: "read", isError: false, timestamp: 3,
		content: [{ type: "text", text: "here" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
	} as Message;
	const m2 = [...m1, assistantWithCall("toolu_1", "read", { path: "shot.png" }), image];
	await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.response?.request_id === "held-img");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "seen" });
	});

	const answered = cli.sent.find((f) => f.response?.request_id === "held-img")!;
	assert.deepEqual(answered.response.response.mcp_response.result.content, [
		{ type: "text", text: "here" },
		// Flat data + mimeType: the CLI converts to the Anthropic source shape itself.
		{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
	]);
	await bridge.disposeAll();
});

test("a failed pi tool is a tool failure, not a turn failure", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("break it")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "bash", { command: "false" })) cli.emitFrame(frame);
		cli.toolCall("bash", { command: "false" }, "held-err");
	});

	const cli = children[0]!;
	const m2 = [...m1, assistantWithCall("toolu_1", "bash", { command: "false" }), toolResult("toolu_1", "bash", "exit 1", true)];
	const frames = await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.response?.request_id === "held-err");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "recovered" });
	});

	const answered = cli.sent.find((f) => f.response?.request_id === "held-err")!;
	assert.equal(answered.response.response.mcp_response.result.isError, true);
	const terminal = frames.at(-1);
	assert.equal(terminal?.type === "result" && terminal.outcome, "success");
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// Divergence, abort and failure
// ---------------------------------------------------------------------------

test("a diverged transcript restarts the child with folded history", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("one"), user("two")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	// A rewind: "two" is gone and a different message took its place.
	const rewound = [user("one"), user("different")];
	await collectAfter(bridge.runTurn(request(rewound)), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	assert.equal(children.length, 2, "divergence must restart the child");
	const folded = children[1]!.sent.find((f) => f.type === "user")!;
	const text = folded.message.content.map((b: any) => b.text ?? "").join("");
	assert.match(text, /pi-conversation-history/);
	assert.match(text, /LOSSY/);
	assert.match(text, /different/);
	assert.ok(!text.includes("\n## User\ntwo"), "the rewound message must not be replayed");
	await bridge.disposeAll();
});

test("a model change restarts rather than continuing on a stale child", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const messages = [user("hi")];
	await collectAfter(bridge.runTurn(request(messages)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	const next = [...messages, user("again")];
	await collectAfter(bridge.runTurn(request(next, { model: "opus" })), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	assert.equal(children.length, 2);
	assert.equal(children[1]!.argv[children[1]!.argv.indexOf("--model") + 1], "opus");
	await bridge.disposeAll();
});

test("abort interrupts the CLI and the aborted result ends the turn", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const controller = new AbortController();
	const collecting = collect(bridge.runTurn(request([user("long job")]), controller.signal));
	const cli = await child(children, 1);
	await cli.waitFor((f) => f.request?.subtype === "initialize");
	await cli.handshake();
	cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } } });
	cli.emitFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
	cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } } });

	controller.abort();
	await cli.waitFor((f) => f.request?.subtype === "interrupt");
	// Acknowledgment is not settlement: the CLI still owes a terminal result.
	cli.emitFrame({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" });

	const frames = await collecting;
	const last = frames.at(-1);
	assert.equal(last?.type, "result");
	assert.equal(last?.type === "result" && last.outcome, "aborted");
	await bridge.disposeAll();
});

test("tearing a session down rejects its held call so the CLI cannot wedge", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("long job")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "bash", { command: "sleep 100" })) cli.emitFrame(frame);
		cli.toolCall("bash", { command: "sleep 100" }, "held-abort");
	});

	const cli = children[0]!;
	assert.ok(!cli.sent.some((f) => f.response?.request_id === "held-abort"), "the call is held while pi runs the tool");

	await bridge.disposeSession("pi-session-1");
	const rejected = cli.sent.find((f) => f.response?.request_id === "held-abort");
	assert.ok(rejected, "a held call must be answered before the child goes away");
	assert.equal(rejected!.response.response.mcp_response.result.isError, true);
	await bridge.disposeAll();
});

test("a malformed frame surfaces as an error result rather than a throw", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const collecting = collect(bridge.runTurn(request([user("hi")])));
	const cli = await child(children, 1);
	await cli.waitFor((f) => f.request?.subtype === "initialize");
	await cli.handshake();
	cli.emitRaw("{not json");
	const frames = await collecting;
	const last = frames.at(-1);
	assert.equal(last?.type, "result");
	assert.equal(last?.type === "result" && last.outcome, "error");
	await bridge.disposeAll();
});

test("a child that crashes mid-turn ends the pi message with an error", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const collecting = collect(bridge.runTurn(request([user("hi")])));
	const cli = await child(children, 1);
	await cli.waitFor((f) => f.request?.subtype === "initialize");
	await cli.handshake();
	cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } });
	cli.exit(9);
	const frames = await collecting;
	const last = frames.at(-1);
	assert.equal(last?.type, "result");
	assert.equal(last?.type === "result" && last.outcome, "error");
	await bridge.disposeAll();
});

test("a tools/call with no turn listening is failed immediately", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	const cli = children[0]!;
	cli.toolCall("read", { path: "x" }, "orphan");
	const answered = await cli.waitFor((f) => f.response?.request_id === "orphan");
	assert.equal(answered.response.response.mcp_response.result.isError, true);
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("disposeSession and disposeAll leave no live children", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	let expected = 0;
	for (const id of ["s1", "s2"]) {
		expected += 1;
		const index = expected;
		await collectAfter(bridge.runTurn(request([user("hi")], { sessionId: id })), async () => {
			const cli = await child(children, index);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
		});
	}
	assert.equal(children.length, 2, "one child per pi session");

	await bridge.disposeSession("s1");
	assert.ok(children[0]!.killed || children[0]!.stdin.writableEnded);

	await bridge.disposeAll();
	for (const cli of children) assert.ok(cli.killed || cli.stdin.writableEnded, "every child was shut down");
});

// ---------------------------------------------------------------------------

/** Start consuming a turn, run `drive` to feed the fake, then await the frames. */
async function collectAfter(frames: AsyncIterable<ClaudeFrame>, drive: () => Promise<void>): Promise<ClaudeFrame[]> {
	const collecting = collect(frames);
	await drive();
	return collecting;
}

test("the process-global bridge hooks only `exit`, never SIGINT/SIGTERM, and exit kills children synchronously", async () => {
	await resetSessionBridge();
	const sigint = process.listenerCount("SIGINT");
	const sigterm = process.listenerCount("SIGTERM");
	const exits = process.listenerCount("exit");
	const bridge = getSessionBridge();
	assert.equal(getSessionBridge(), bridge, "one registry per process");
	assert.equal(process.listenerCount("SIGINT"), sigint, "a SIGINT listener would disable Node's default exit");
	assert.equal(process.listenerCount("SIGTERM"), sigterm);
	assert.equal(process.listenerCount("exit"), exits + 1);
	// killAllNow is synchronous and safe with no live children.
	bridge.killAllNow();
	await resetSessionBridge();
});

// ---------------------------------------------------------------------------
// Session cwd
// ---------------------------------------------------------------------------

test("the child is spawned in the pi session's cwd, not the host process's", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	bridge.setSessionCwd("pi-session-1", "/tmp/session-one");
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children[0]!.cwd, "/tmp/session-one");
	assert.notEqual(children[0]!.cwd, process.cwd());
	await bridge.disposeAll();
});

test("each pi session's child gets its own cwd", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	bridge.setSessionCwd("s1", "/tmp/one");
	bridge.setSessionCwd("s2", "/tmp/two");
	let n = 0;
	for (const id of ["s1", "s2"]) {
		n += 1;
		const index = n;
		await collectAfter(bridge.runTurn(request([user("hi")], { sessionId: id })), async () => {
			const cli = await child(children, index);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
		});
	}
	assert.deepEqual(children.map((c) => c.cwd), ["/tmp/one", "/tmp/two"]);
	await bridge.disposeAll();
});

test("a cwd change restarts the child, like a model change", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	bridge.setSessionCwd("pi-session-1", "/tmp/before");
	const first = [user("hi")];
	await collectAfter(bridge.runTurn(request(first)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	// A cwd is fixed at spawn, so the only honest response is a new child.
	bridge.setSessionCwd("pi-session-1", "/tmp/after");
	await collectAfter(bridge.runTurn(request([...first, user("again")])), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	assert.equal(children.length, 2, "a cwd change must restart the child");
	assert.equal(children[1]!.cwd, "/tmp/after");
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * What pi's compaction actually sends, from `buildSummarizationContext` in
 * 0.86.1: its own summarization system prompt, NO tools, and a single user
 * message holding the transcript to summarize. It is not an extension of the
 * conversation, so it cannot reuse the conversation's child.
 */
test("a compaction summary costs two restarts: one for the summary, one to resume", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const finish = async (n: number) => {
		const cli = await child(children, n);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	};

	const conversation = [user("one"), user("two")];
	await collectAfter(bridge.runTurn(request(conversation)), () => finish(1));
	assert.equal(children.length, 1);

	// The summarization request: same pi session, different everything else.
	const summary = request([user("Summarize the conversation so far.")], {
		systemPrompt: "You are a conversation summarizer.",
		tools: [],
	});
	await collectAfter(bridge.runTurn(summary), () => finish(2));
	assert.equal(children.length, 2, "the summary request cannot reuse the conversation's child");

	// The next real turn carries the compacted transcript, which is not an
	// extension of what child 2 saw either.
	const compacted = request([user("<summary of the conversation>"), user("three")]);
	await collectAfter(bridge.runTurn(compacted), () => finish(3));
	assert.equal(children.length, 3, "resuming after compaction restarts again");

	assert.equal(children[1]!.argv.filter((a) => a === "--session-id").length, 1);
	await bridge.disposeAll();
});
