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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Api, type AssistantMessageEvent, type Model, normalizeContext, Type, type Message, type Tool } from "@earendil-works/pi-ai";
import {
	claudeSessionId, FOLD_CHARS_PER_TOKEN, foldBudgetChars, foldHistory, foldSizeEstimate, getSessionBridge, isPrefix, LIMITS, MAX_FOLD_CHARS, MIN_FOLD_CHARS,
	resetSessionBridge, SessionBridge, transcriptFingerprint, uuidv5, windowOverflow,
} from "./session-bridge.ts";
import { streamClaudeCode } from "./stream.ts";
import { STATIC_MODELS } from "./index.ts";
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
	/** Keep running this long after EOF or a signal, like a CLI mid-request. */
	lingerMs = 0;

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
		this.stdin.on("finish", () => { if (!this.exited) this.die(); });
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
		this.emitFrame({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name: "sova", message } });
		return answered;
	}

	/** Send a tools/call without waiting: it is held until pi answers. */
	toolCall(name: string, args: unknown, requestId: string, rpcId = 99): void {
		this.emitFrame({
			type: "control_request", request_id: requestId,
			request: { subtype: "mcp_message", server_name: "sova", message: { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } } },
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

	kill(): boolean { this.killed = true; this.die(); return true; }
	private die(): void {
		if (this.lingerMs) setTimeout(() => this.exit(0), this.lingerMs);
		else this.exit(0);
	}
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

/**
 * `refuseSessionId` makes the first N children behave like a CLI handed a
 * `--session-id` that already exists: one line on stderr, exit 1, and no answer
 * to `initialize`.
 */
/** An empty CLI projects dir, so no test reads the real ~/.claude. */
const EMPTY_PROJECTS = mkdtempSync(join(tmpdir(), "pi-bridge-projects-"));

function harness({ refuseSessionId = 0, manualInitialize = false, projectsRoot = EMPTY_PROJECTS, limits }: { refuseSessionId?: number; manualInitialize?: boolean; projectsRoot?: string; limits?: Partial<typeof LIMITS> } = {}) {
	const children: FakeClaude[] = [];
	const debug: Record<string, unknown>[] = [];
	const bridge = new SessionBridge({
		onDebug: (entry) => debug.push(entry),
		cwd: "/tmp/pi-bridge-test",
		projectsRoot,
		spawnImpl: ((command: string, argv: string[], options: any) => {
			const child = new FakeClaude(command, argv, options, 5000 + children.length);
			children.push(child);
			if (manualInitialize) child.autoInitialize = false;
			if (children.length <= refuseSessionId) {
				const id = argv[argv.indexOf("--session-id") + 1];
				child.autoInitialize = false;
				setTimeout(() => {
					child.stderr.write(`Error: Session ID ${id} is already in use.\n`);
					child.exit(1);
				}, 0);
			}
			return child as any;
		}) as any,
		signalGroupImpl: (pid) => {
			children.find((c) => c.pid === pid)?.kill();
		},
		timings: { requestTimeoutMs: 500, eofGraceMs: 20, termGraceMs: 20, pipeDrainMs: 5, toolDispatchTimeoutMs: 300, abortGraceMs: 200, heldCallTimeoutMs: 10_000 },
		limits,
	});
	return { bridge, children, debug };
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
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__sova__${name}`, input: {} } } },
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
	// Launch 0 is the bare name, so an existing session's first child keeps its
	// id; every later launch needs one of its own, since --session-id creates a
	// record and the CLI refuses an id it already wrote.
	assert.equal(id, claudeSessionId("pi-session-1", 0));
	const later = [1, 2, 3].map((n) => claudeSessionId("pi-session-1", n));
	assert.equal(new Set([id, ...later]).size, 4);
	assert.equal(later[0], claudeSessionId("pi-session-1", 1));
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

const FOLD_LIMITS = { maxLineBytes: 1, maxIdleSessions: 1, maxFoldedResultChars: 100, maxFoldedReportChars: 1_000, maxFoldedChars: 10_000 };
const JOINED_HEADER = "This conversation started before you joined it, possibly with a different model. What follows is a condensed transcript, not a verbatim record: reasoning is omitted and tool output may be truncated. Treat it as context you are being told about, not as your own memory.";
const RESTARTED_HEADER = "Your session was restarted, so this is a condensed, lossy replay of the conversation so far: reasoning is omitted and tool output may be truncated. Treat it as context you are being told about, not as your own verbatim memory.";
const FOLD_CLOSING = "Continue from here by answering the latest user message above.";

test("first fold of a lone user message is that message, unwrapped", () => {
	const system = { role: "system", content: "sys", timestamp: 0 } as unknown as Message;
	const folded = foldHistory([system, user("fix the bug")], FOLD_LIMITS, "first");
	assert.equal(folded.text, "fix the bug");
	assert.deepEqual(folded.images, []);
	assert.ok(!folded.text.includes("conversation-history"));
});

test("first fold of a lone user message keeps its image placeholder and images", () => {
	const lone: Message = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 };
	const folded = foldHistory([lone], FOLD_LIMITS, "first");
	assert.equal(folded.text, "look\n[1 image(s) attached to this message, included below]");
	assert.equal(folded.images.length, 1);
	assert.equal(folded.images[0]!.data, "AAAA");
});

test("first fold of a multi-message history is framed as joined", () => {
	const folded = foldHistory([user("one"), user("two")], FOLD_LIMITS, "first");
	assert.equal(folded.text, `<conversation-history>\n${JOINED_HEADER}\n\n## User\none\n\n## User\ntwo\n</conversation-history>\n\n${FOLD_CLOSING}`);
	assert.deepEqual(folded.text, foldHistory([user("one"), user("two")], FOLD_LIMITS, "joined").text);
});

test("first fold of a lone tool result falls back to joined", () => {
	const folded = foldHistory([toolResult("toolu_1", "read", "body")], FOLD_LIMITS, "first");
	assert.ok(folded.text.startsWith(`<conversation-history>\n${JOINED_HEADER}\n\n## Tool \`mcp__sova__read\``), folded.text);
	assert.ok(folded.text.endsWith(`</conversation-history>\n\n${FOLD_CLOSING}`));
});

test("restarted fold uses the restart header, even for a lone user message", () => {
	const folded = foldHistory([user("hi")], FOLD_LIMITS, "restarted");
	assert.equal(folded.text, `<conversation-history>\n${RESTARTED_HEADER}\n\n## User\nhi\n</conversation-history>\n\n${FOLD_CLOSING}`);
	assert.ok(!folded.text.includes("pi-conversation-history"));
});

test("the bridge sends a new session's first prompt unwrapped, and a later restart wrapped", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("hello")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		const sent = await cli.waitFor((f) => f.type === "user");
		assert.deepEqual(sent.message.content, [{ type: "text", text: "hello" }]);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	await collectAfter(bridge.runTurn(request([user("different")])), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		const sent = await cli.waitFor((f) => f.type === "user");
		assert.equal(sent.message.content[0].text, `<conversation-history>\n${RESTARTED_HEADER}\n\n## User\ndifferent\n</conversation-history>\n\n${FOLD_CLOSING}`);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	await bridge.disposeAll();
});

test("the bridge frames a new session's multi-message history as joined", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("one"), user("two")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		const sent = await cli.waitFor((f) => f.type === "user");
		assert.ok(sent.message.content[0].text.startsWith(`<conversation-history>\n${JOINED_HEADER}\n\n`));
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	await bridge.disposeAll();
});

test("folded history is labelled lossy and carries images out of band", () => {
	const messages: Message[] = [
		user("hello"),
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
		assistantWithCall("toolu_1", "read", { path: "a.txt" }),
		toolResult("toolu_1", "read", "file body"),
	];
	const folded = foldHistory(messages, { maxLineBytes: 1, maxIdleSessions: 1, maxFoldedResultChars: 100, maxFoldedReportChars: 1_000, maxFoldedChars: 10_000 });
	assert.ok(folded.text.startsWith(`<conversation-history>\n${RESTARTED_HEADER}\n\n## User\nhello`), folded.text);
	assert.match(folded.text, /## User\nhello/);
	assert.match(folded.text, /tool call `mcp__sova__read`/);
	assert.match(folded.text, /file body/);
	assert.equal(folded.images.length, 1);
	assert.equal(folded.images[0]!.data, "AAAA");
});

test("a folded agent_transcript result under the report cap survives whole, prefixed or not", () => {
	const report = `${"r".repeat(29_990)}\nEND-REPORT`;
	for (const name of ["agent_transcript", "mcp__sova__agent_transcript", "agent_wait"]) {
		const folded = foldHistory([user("go"), toolResult("toolu_1", name, report)], LIMITS);
		assert.ok(folded.text.includes(`returned\n${report}\n</conversation-history>`), name);
	}
});

test("a clipped tool result keeps its head and tail around an omission marker", () => {
	const body = `${"x".repeat(19_980)}\nSENTINEL-TAIL-LINE`;
	assert.equal(body.length, 19_999);
	const folded = foldHistory([user("go"), toolResult("toolu_1", "bash", body)], LIMITS);
	const clipped = folded.text.slice(folded.text.indexOf("returned\n") + 9, folded.text.indexOf("\n</conversation-history>"));
	const marker = `\n… [truncated: ${body.length - LIMITS.maxFoldedResultChars} chars omitted]\n`;
	assert.ok(clipped.endsWith("\nSENTINEL-TAIL-LINE"));
	assert.ok(clipped.includes(marker));
	assert.equal(clipped.length, LIMITS.maxFoldedResultChars + marker.length);
	assert.equal(clipped, `${body.slice(0, 4_800)}${marker}${body.slice(-3_200)}`);
});

test("a folded tool result under its cap is verbatim", () => {
	const body = "y".repeat(LIMITS.maxFoldedResultChars);
	const folded = foldHistory([user("go"), toolResult("toolu_1", "bash", body)], LIMITS);
	assert.equal(folded.text, `<conversation-history>\n${RESTARTED_HEADER}\n\n## User\ngo\n\n## Tool \`mcp__sova__bash\` (id toolu_1) returned\n${body}\n</conversation-history>\n\n${FOLD_CLOSING}`);
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
	assert.deepEqual(cli.argv.slice(cli.argv.indexOf("--allowedTools"), cli.argv.indexOf("--allowedTools") + 2), ["--allowedTools", "mcp__sova"]);
	assert.equal(cli.argv[cli.argv.indexOf("--session-id") + 1], claudeSessionId("pi-session-1"));
	assert.equal(cli.argv[cli.argv.indexOf("--permission-mode") + 1], "dontAsk");
	assert.equal(cli.env.MCP_TOOL_TIMEOUT, "86400000");
	assert.equal(cli.env.CLAUDECODE, undefined);
	assert.equal(cli.env.CLAUDE_CODE_ENTRYPOINT, undefined);

	const initialize = await cli.waitFor((f) => f.request?.subtype === "initialize");
	assert.deepEqual(initialize.request.sdkMcpServers, ["sova"]);

	const [init, ready, list] = await cli.handshake();
	assert.equal(init!.response.response.mcp_response.result.protocolVersion, "2025-11-25");
	// A notification has no id but still has to be answered, or the CLI wedges.
	assert.deepEqual(ready!.response.response.mcp_response, { jsonrpc: "2.0", result: {}, id: 0 });
	// tools/list publishes BARE names; the mcp__sova__ prefix only appears on the way back.
	const listed = list!.response.response.mcp_response.result.tools;
	assert.deepEqual(listed.map((t: any) => t.name), ["read", "bash"]);
	assert.equal(listed[0].description, "Read a file");
	assert.equal(listed[0].inputSchema.type, "object");

	cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "done" });
	await pending;
	await collect({ [Symbol.asyncIterator]: () => frames } as AsyncIterable<ClaudeFrame>);
	await bridge.disposeAll();
});

/**
 * The bug this guards: `--session-id` CREATES a record, so once any child had
 * died (an API 500 ends one) every relaunch on a stable id was refused before
 * `initialize`, and the pi session was dead for good — "Claude did not answer
 * initialize" on every later turn, model switch included.
 */
test("a --session-id the CLI already wrote is probed past, not retried forever", { timeout: 8000 }, async () => {
	const { bridge, children } = harness({ refuseSessionId: 2 });
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 3);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	assert.equal(children.length, 3, "each refusal costs one spawn and no more");
	const ids = children.map((c) => c.argv[c.argv.indexOf("--session-id") + 1]);
	assert.deepEqual(ids, [0, 1, 2].map((n) => claudeSessionId("pi-session-1", n)));
	await bridge.disposeAll();
});

/**
 * The bug this guards: the launch counter lived only in memory, so a new
 * process re-probed launches 0..32 while a real session had already used
 * 0..42, and every turn failed with "session id already in use, for 33 ids in
 * a row". The first launch now starts past the records on disk.
 */
test("a new bridge starts past the session records a previous process left", { timeout: 8000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-bridge-projects-"));
	const dir = join(root, "-tmp-pi-bridge-test");
	mkdirSync(dir);
	for (let n = 0; n <= 42; n++) writeFileSync(join(dir, `${claudeSessionId("pi-session-1", n)}.jsonl`), "{}\n");
	const { bridge, children } = harness({ projectsRoot: root });
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 1, "no id on disk is probed");
	assert.equal(children[0].argv[children[0].argv.indexOf("--session-id") + 1], claudeSessionId("pi-session-1", 43));
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
	assert.ok(text.startsWith(`<conversation-history>\n${RESTARTED_HEADER}\n\n`), text);
	assert.ok(text.endsWith(`</conversation-history>\n\n${FOLD_CLOSING}`), text);
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
// A dying child is not the current child
// ---------------------------------------------------------------------------

/** The tool_use ids a turn's frames announced, in order. */
function announced(frames: ClaudeFrame[]): string[] {
	return frames.flatMap((f) => f.type === "stream" && f.event.type === "content_block_start" && f.event.block.kind === "tool_use" ? [f.event.block.id] : []);
}

/**
 * Like the real CLI: when a held call is failed by a restart, the old child
 * calls the model again and streams a retry until the signal lands. With
 * `complete` the retry message finishes and dispatches its tools/call.
 */
function retryOnFailure(cli: FakeClaude, requestId: string, complete: boolean): void {
	cli.on("frame", (f) => {
		if (f.type !== "control_response" || f.response?.request_id !== requestId) return;
		if (complete) {
			for (const frame of toolUseFrames("toolu_STALE", "bash", { command: "ls -la" })) cli.emitFrame(frame);
			cli.toolCall("bash", { command: "ls -la" }, "stale-call");
			return;
		}
		cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } });
		cli.emitFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_STALE", name: "mcp__sova__bash", input: {} } } });
		cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\": \"ls -" } } });
	});
}

/** Turn 1 leaves one bash call held on child 1. */
async function holdOneCall(bridge: SessionBridge, children: FakeClaude[]): Promise<Message[]> {
	const m1 = [user("hi")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_1", "bash", { command: "ls" })) cli.emitFrame(frame);
		cli.toolCall("bash", { command: "ls" }, "held-1");
	});
	return [...m1, assistantWithCall("toolu_1", "bash", { command: "ls" }), toolResult("toolu_1", "bash", "README.md")];
}

test("after a restart, the new turn carries no frame from the dying child", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m2 = await holdOneCall(bridge, children);
	retryOnFailure(children[0]!, "held-1", false);

	// A model change restarts; the held call is failed and child 1 retries.
	const frames = await collectAfter(bridge.runTurn(request(m2, { model: "opus" })), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } } });
		cli.emitFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
		cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } } });
		cli.emitFrame({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});

	assert.equal(children.length, 2);
	assert.deepEqual(announced(frames), [], "child 1's retry reached the new turn");
	assert.equal(frames.filter((f) => f.type === "stream" && f.event.type === "message_start").length, 1);
	const terminal = frames.at(-1);
	assert.equal(terminal?.type === "result" && terminal.outcome, "success");
	await bridge.disposeAll();
});

test("a dying child's leaked tool call does not cascade into another restart", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m2 = await holdOneCall(bridge, children);
	retryOnFailure(children[0]!, "held-1", true);

	const frames = await collectAfter(bridge.runTurn(request(m2, { model: "opus" })), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const frame of toolUseFrames("toolu_NEW", "read", { path: "a.txt" })) cli.emitFrame(frame);
		cli.toolCall("read", { path: "a.txt" }, "held-new");
	});
	assert.deepEqual(announced(frames), ["toolu_NEW"]);

	// pi answers every tool call the turn showed it; that must resume child 2.
	const m3 = [...m2, ...announced(frames).flatMap((id) => [assistantWithCall(id, "read", { path: "a.txt" }), toolResult(id, "read", "body")])];
	await collectAfter(bridge.runTurn(request(m3, { model: "opus" })), async () => {
		const cli = children[1]!;
		await cli.waitFor((f) => f.response?.request_id === "held-new");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2, "answering the new child's calls must not restart it");
	await bridge.disposeAll();
});

test("a child still dying after a failure never reaches its replacement's turn or host", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	// Child 1 breaks the protocol, which tears it down outside any restart; it
	// then takes a while to die, so child 2 is launched while it still talks.
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		cli.lingerMs = 300;
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitRaw("{not json");
	});
	const old = children[0]!;
	const oldClosed = new Promise((resolve) => old.once("close", resolve));

	const turn = collect(bridge.runTurn(request([user("hi"), user("again")])));
	const cli = await child(children, 2);
	await cli.waitFor((f) => f.request?.subtype === "initialize");
	await cli.handshake();
	for (const frame of toolUseFrames("toolu_STALE", "bash", { command: "ls -la" })) old.emitFrame(frame);
	old.toolCall("bash", { command: "ls -la" }, "stale-call");
	await oldClosed;
	cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	const frames = await turn;

	assert.deepEqual(announced(frames), []);
	const terminal = frames.at(-1);
	assert.equal(terminal?.type === "result" && terminal.outcome, "success", "child 1's exit must not end child 2's turn");
	assert.ok(!cli.sent.some((f) => f.response?.request_id === "stale-call"), "the new host answered the old child's tools/call");
	assert.equal(children.length, 2);
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// One API message, one pi message: the CLI's per-block assistant frames
// ---------------------------------------------------------------------------

/** Raw CLI stdout lines of a recorded turn, control requests included. */
function fixtureLines(name: string): string[] {
	const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
	return readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
}

function streamOf(frames: ClaudeFrame[], type: string): ClaudeFrame[] {
	return frames.filter((f) => f.type === "stream" && f.event.type === type);
}

/** Frames of a text-only message that ends the CLI turn. */
function finalTextFrames(text: string): unknown[] {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 4 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "result", subtype: "success", is_error: false, result: text },
	];
}

function piModel(): Model<Api> {
	const definition = STATIC_MODELS.find((candidate) => candidate.id === "sonnet")!;
	return { ...definition, provider: "claude-code-cli", api: "claude-code-cli", baseUrl: "claude-code-cli://local" } as Model<Api>;
}

/** Run one pi assistant message through stream.ts against the bridge. */
async function piMessage(bridge: SessionBridge, messages: Message[], signal?: AbortSignal) {
	const context = normalizeContext({ systemPrompt: "You are pi.", tools, messages });
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamClaudeCode(bridge, piModel(), context, { sessionId: "pi-session-1", signal })) events.push(event);
	const terminal = events.at(-1)!;
	assert.ok(terminal.type === "done" || terminal.type === "error");
	return terminal.type === "done" ? terminal.message : terminal.error;
}

test("a message sent as one assistant frame per block stays one pi message with every tool call", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const m1 = [user("check the readme and the tree")];
	const lines = fixtureLines("per-block-tools-turn.ndjson");
	const frames = await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		for (const line of lines) cli.emitRaw(line);
	});

	// The first tool_use's assistant frame and held call arrive mid-message;
	// the pi message still runs to the message's own end.
	assert.deepEqual(announced(frames), ["toolu_PB_READ", "toolu_PB_BASH"]);
	assert.equal(frames.filter((f) => f.type === "assistant").length, 4);
	const lastFrame = frames.at(-1);
	assert.ok(lastFrame?.type === "stream" && lastFrame.event.type === "message_stop", "the turn ended before its message did");
	assert.deepEqual(debug.filter((e) => e.event === "frame-dropped"), []);

	// pi answers both calls; the same child carries on, and the next message
	// sees nothing left over from the last one.
	const m2 = [
		...m1,
		{ ...assistantWithCall("toolu_PB_READ", "read", { path: "README.md" }), content: [
			{ type: "toolCall", id: "toolu_PB_READ", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "toolu_PB_BASH", name: "bash", arguments: { command: "git status --short" } },
		] } as Message,
		toolResult("toolu_PB_READ", "read", "# readme"),
		toolResult("toolu_PB_BASH", "bash", " M a.ts"),
	];
	const next = await collectAfter(bridge.runTurn(request(m2)), async () => {
		const cli = children[0]!;
		await cli.waitFor((f) => f.response?.request_id === "pb-read");
		await cli.waitFor((f) => f.response?.request_id === "pb-bash");
		for (const frame of finalTextFrames("Clean tree.")) cli.emitFrame(frame);
	});
	assert.equal(children.length, 1, "answering both calls must not restart the CLI");
	const first = next[0];
	assert.ok(first?.type === "stream" && first.event.type === "message_start", "a stray frame led the next message");
	assert.equal(streamOf(next, "content_block_delta").length, 1);
	assert.equal(next.at(-1)?.type === "result" && (next.at(-1) as { outcome: string }).outcome, "success");
	await bridge.disposeAll();
});

test("through stream.ts, the per-block message reaches pi whole: thinking, text and both tool calls", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const lines = fixtureLines("per-block-tools-turn.ndjson");
	const [message] = await Promise.all([
		piMessage(bridge, [user("check the readme and the tree")]),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			for (const line of lines) cli.emitRaw(line);
		})(),
	]);
	assert.equal(message.stopReason, "toolUse", message.errorMessage);
	assert.deepEqual(message.content.map((block) => block.type), ["thinking", "text", "toolCall", "toolCall"]);
	const calls = message.content.filter((block) => block.type === "toolCall");
	assert.deepEqual(calls.map((call) => call.type === "toolCall" && call.arguments), [{ path: "README.md" }, { command: "git status --short" }]);
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// Tool dispatch order: what CLI 2.1.280 was observed to do live
// ---------------------------------------------------------------------------

function isToolsCall(frame: Record<string, any>): boolean {
	return frame.type === "control_request" && frame.request?.message?.method === "tools/call";
}

/**
 * Replay recorded stdout lines the way the real CLI paces them. It calls the
 * model again (a later `message_start`) only once every tool call it sent has
 * been answered; with `serial` — an MCP tool not marked read-only, the 2.1.280
 * default — it also sends a `tools/call` only once the previous one is answered.
 */
async function replayLikeCli(cli: FakeClaude, lines: string[], { serial }: { serial: boolean }): Promise<void> {
	const sentCalls: string[] = [];
	const answered = (id: string) => cli.waitFor((f) => f.type === "control_response" && f.response?.request_id === id);
	let messages = 0;
	for (const line of lines) {
		const frame = JSON.parse(line);
		const startsMessage = frame.type === "stream_event" && frame.event?.type === "message_start" && messages++ > 0;
		if (startsMessage || (serial && isToolsCall(frame))) for (const id of sentCalls) await answered(id);
		if (isToolsCall(frame)) sentCalls.push(frame.request_id);
		cli.emitRaw(line);
	}
}

/**
 * pi's agent loop, reduced to what the provider sees: stream one assistant
 * message, execute its tool calls, call again with the results, until the
 * message stops for any other reason.
 */
async function agentLoop(bridge: SessionBridge, messages: Message[], limit = 5): Promise<Message[]> {
	const transcript = [...messages];
	for (let i = 0; i < limit; i++) {
		const message = await piMessage(bridge, transcript);
		transcript.push(message as Message);
		if (message.stopReason !== "toolUse") return transcript;
		for (const block of message.content) {
			if (block.type === "toolCall") transcript.push(toolResult(block.id, block.name, `pi ran ${block.name}`));
		}
	}
	throw new Error("the agent loop never stopped");
}

function assistantMessages(transcript: Message[]) {
	return transcript.filter((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant");
}

test("serially dispatched tool calls: pi gets both, answers both, and the final text arrives", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const lines = [...fixtureLines("serial-tools-turn.ndjson"), ...finalTextFrames("Both done.").map((f) => JSON.stringify(f))];
	const driving = (async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		await replayLikeCli(cli, lines, { serial: true });
	})();
	const transcript = await agentLoop(bridge, [user("check the readme and the tree")]);
	await driving;

	const [calling, final] = assistantMessages(transcript);
	assert.equal(calling?.stopReason, "toolUse", calling?.errorMessage);
	assert.deepEqual(calling?.content.flatMap((b) => b.type === "toolCall" ? [[b.id, b.arguments]] : []), [
		["toolu_SR_READ", { path: "README.md" }],
		["toolu_SR_BASH", { command: "git status --short" }],
	]);
	assert.equal(final?.stopReason, "stop", final?.errorMessage);
	assert.deepEqual(final?.content.map((b) => b.type === "text" && b.text), ["Both done."]);

	// Each call got pi's own result, and the second was only asked for after
	// the first was answered — the order the CLI imposes, not one pi chose.
	const cli = children[0]!;
	const answers = cli.sent.filter((f) => f.type === "control_response" && /^sr-/.test(f.response?.request_id));
	assert.deepEqual(answers.map((f) => [f.response.request_id, f.response.response.mcp_response.result.content[0].text]), [
		["sr-read", "pi ran read"],
		["sr-bash", "pi ran bash"],
	]);
	assert.equal(children.length, 1);
	assert.deepEqual(debug, []);
	await bridge.disposeAll();
});

test("concurrently dispatched tool calls in the recorded order complete the same way", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const lines = [...fixtureLines("per-block-tools-turn.ndjson"), ...finalTextFrames("Clean tree.").map((f) => JSON.stringify(f))];
	const driving = (async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		await replayLikeCli(cli, lines, { serial: false });
	})();
	const transcript = await agentLoop(bridge, [user("check the readme and the tree")]);
	await driving;
	const [calling, final] = assistantMessages(transcript);
	assert.deepEqual(calling?.content.map((b) => b.type), ["thinking", "text", "toolCall", "toolCall"]);
	assert.equal(final?.stopReason, "stop", final?.errorMessage);
	assert.equal(children.length, 1);
	assert.deepEqual(debug, []);
	await bridge.disposeAll();
});

test("a tools/call that arrives after pi's message ended is held for pi, not failed", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const lines = fixtureLines("serial-tools-turn.ndjson");
	const late = lines.pop()!; // sr-bash, sent here with no pi turn open
	const m1 = [user("check the readme and the tree")];
	const first = await Promise.all([
		piMessage(bridge, m1),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			for (const line of lines) cli.emitRaw(line);
		})(),
	]).then(([message]) => message);
	assert.equal(first.stopReason, "toolUse", first.errorMessage);
	const cli = children[0]!;
	cli.emitRaw(late);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!cli.sent.some((f) => f.response?.request_id === "sr-bash"), "the late call was failed before pi could answer it");

	const results = first.content.flatMap((b) => b.type === "toolCall" ? [toolResult(b.id, b.name, `pi ran ${b.name}`)] : []);
	const [final] = await Promise.all([
		piMessage(bridge, [...m1, first as Message, ...results]),
		(async () => {
			await cli.waitFor((f) => f.response?.request_id === "sr-read");
			await cli.waitFor((f) => f.response?.request_id === "sr-bash");
			for (const frame of finalTextFrames("Done.")) cli.emitFrame(frame);
		})(),
	]);
	assert.equal(final.stopReason, "stop", final.errorMessage);
	assert.equal(children.length, 1);
	assert.deepEqual(debug, []);
	await bridge.disposeAll();
});

test("a call pi answered that the CLI never dispatches fails the turn and restarts the child", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const lines = fixtureLines("serial-tools-turn.ndjson");
	lines.pop(); // sr-bash is never sent
	const m1 = [user("check the readme and the tree")];
	const first = await Promise.all([
		piMessage(bridge, m1),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			for (const line of lines) cli.emitRaw(line);
		})(),
	]).then(([message]) => message);
	assert.equal(first.stopReason, "toolUse", first.errorMessage);

	const results = first.content.flatMap((b) => b.type === "toolCall" ? [toolResult(b.id, b.name, `pi ran ${b.name}`)] : []);
	const m2 = [...m1, first as Message, ...results];
	const stuck = await piMessage(bridge, m2);
	assert.equal(stuck.stopReason, "error");
	assert.match(stuck.errorMessage ?? "", /never dispatched/);
	assert.ok(debug.some((e) => e.event === "desynced"));

	await collectAfter(bridge.runTurn(request([...m2, user("again")])), async () => {
		const next = await child(children, 2);
		await next.waitFor((f) => f.request?.subtype === "initialize");
		await next.handshake();
		next.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2, "the child that skipped pi's result was reused");
	await bridge.disposeAll();
});

test("a CLI that moves on without asking pi for an answered call is out of step", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const lines = fixtureLines("serial-tools-turn.ndjson");
	lines.pop(); // sr-bash is never sent: the CLI settles it on its own
	const m1 = [user("check the readme and the tree")];
	const first = await Promise.all([
		piMessage(bridge, m1),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			for (const line of lines) cli.emitRaw(line);
		})(),
	]).then(([message]) => message);
	const cli = children[0]!;
	const results = first.content.flatMap((b) => b.type === "toolCall" ? [toolResult(b.id, b.name, `pi ran ${b.name}`)] : []);
	const [final] = await Promise.all([
		piMessage(bridge, [...m1, first as Message, ...results]),
		(async () => {
			await cli.waitFor((f) => f.response?.request_id === "sr-read");
			for (const frame of finalTextFrames("Done.")) cli.emitFrame(frame);
		})(),
	]);
	// The model's reply still reaches pi; the child is not trusted again.
	assert.equal(final.stopReason, "stop", final.errorMessage);
	assert.ok(debug.some((e) => e.event === "desynced" && /without dispatching/.test(String(e.reason))), JSON.stringify(debug));
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// A child that fell out of step with pi is not reused
// ---------------------------------------------------------------------------

test("a protocol error in stream.ts makes the next turn restart the child, and only the next", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const [broken] = await Promise.all([
		piMessage(bridge, [user("hi")]),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } });
			cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } } });
		})(),
	]);
	assert.equal(broken.stopReason, "error");
	assert.match(broken.errorMessage ?? "", /unknown content block 3/);
	assert.ok(debug.some((e) => e.event === "desynced"));

	// A clean append would normally continue on the same child.
	await collectAfter(bridge.runTurn(request([user("hi"), user("again")])), async () => {
		const cli = await child(children, 2);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		const folded = await cli.waitFor((f) => f.type === "user");
		assert.ok(folded.message.content[0].text.startsWith(`<conversation-history>\n${RESTARTED_HEADER}\n`));
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2, "the desynced child was reused");

	// The flag died with the child it described.
	await collectAfter(bridge.runTurn(request([user("hi"), user("again"), user("third")])), async () => {
		const cli = children[1]!;
		await cli.waitFor((f) => f.type === "user" && f.message.content[0]?.text === "third");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2, "a healthy replacement must be reused");
	await bridge.disposeAll();
});

test("a frame that arrives with no turn open is logged and restarts the child next turn", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	const cli = children[0]!;
	cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } } });
	const until = Date.now() + 1000;
	while (!debug.some((e) => e.event === "frame-dropped") && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(debug.find((e) => e.event === "frame-dropped")?.frame, "content_block_delta[0]");

	await collectAfter(bridge.runTurn(request([user("hi"), user("again")])), async () => {
		const next = await child(children, 2);
		await next.waitFor((f) => f.request?.subtype === "initialize");
		await next.handshake();
		next.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2);
	await bridge.disposeAll();
});

test("an interrupted turn winding down is not a desync: the child is reused once it settles", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const controller = new AbortController();
	const [aborted] = await Promise.all([
		piMessage(bridge, [user("long job")], controller.signal),
		(async () => {
			const cli = await child(children, 1);
			await cli.waitFor((f) => f.request?.subtype === "initialize");
			await cli.handshake();
			cli.emitFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } } });
			cli.emitFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
			await cli.waitFor((f) => f.type === "user");
			await new Promise((r) => setTimeout(r, 20));
			controller.abort();
		})(),
	]);
	assert.equal(aborted.stopReason, "aborted");
	const cli = children[0]!;
	await cli.waitFor((f) => f.request?.subtype === "interrupt");
	// What the CLI still says before its result is the interrupt settling.
	// The first frame still reaches the abandoned turn (its drain was waiting
	// on it); the result arrives after pi let go of the turn entirely.
	cli.emitFrame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "work" } } });
	await new Promise((r) => setTimeout(r, 20));
	cli.emitFrame({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" });
	const until = Date.now() + 1000;
	while (!debug.some((e) => e.event === "frame-dropped") && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(debug.find((e) => e.event === "frame-dropped"), { event: "frame-dropped", session: "pi-session-1", frame: "result", settling: true });
	assert.ok(!debug.some((e) => e.event === "desynced"), JSON.stringify(debug));

	const [next] = await Promise.all([
		piMessage(bridge, [user("long job"), user("never mind")]),
		(async () => {
			await cli.waitFor((f) => f.type === "user" && f.message.content[0]?.text === "never mind");
			for (const frame of finalTextFrames("Stopped.")) cli.emitFrame(frame);
		})(),
	]);
	assert.equal(next.stopReason, "stop", next.errorMessage);
	assert.equal(children.length, 1, "an abort must not cost a restart");
	await bridge.disposeAll();
});

test("a turn aborted during a restart sends the new child nothing, and the next turn restarts it", { timeout: 8000 }, async () => {
	const { bridge, children } = harness({ manualInitialize: true });
	const controller = new AbortController();
	const frames = await collectAfter(bridge.runTurn(request([user("hi")]), controller.signal), async () => {
		const cli = await child(children, 1);
		const init = await cli.waitFor((f) => f.request?.subtype === "initialize");
		controller.abort();
		cli.emitFrame({ type: "control_response", response: { subtype: "success", request_id: init.request_id } });
	});
	assert.deepEqual(frames, []);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!children[0]!.sent.some((f) => f.type === "user"), "the aborted turn's history reached the child with no turn to hear it");

	// Otherwise this clean append would be sent as-is to a child that never
	// received "hi".
	await collectAfter(bridge.runTurn(request([user("hi"), user("again")])), async () => {
		const cli = await child(children, 2);
		const init = await cli.waitFor((f) => f.request?.subtype === "initialize");
		cli.emitFrame({ type: "control_response", response: { subtype: "success", request_id: init.request_id } });
		const folded = await cli.waitFor((f) => f.type === "user");
		assert.match(folded.message.content[0].text, /## User\nhi/);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2);
	await bridge.disposeAll();
});

test("pi's tools make no read-only claim: the bridge copes with serial dispatch instead", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		const [, , list] = await cli.handshake();
		for (const tool of list!.response.response.mcp_response.result.tools) assert.equal(tool.annotations, undefined);
		assert.equal(cli.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY, undefined);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
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

test("a system prompt differing only in its untagged lead-in restarts the child: the strip is the stream's job", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const finish = async (n: number) => {
		const cli = await child(children, n);
		await cli.waitFor((f) => f.request?.subtype === "initialize");
		await cli.handshake();
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	};
	const sections = "<tools>\n- read\n</tools>\n\n<cwd>\n/x\n</cwd>";
	const first = [user("hi")];
	await collectAfter(bridge.runTurn(request(first, { systemPrompt: `You are pi.\n\n${sections}` })), () => finish(1));
	await collectAfter(bridge.runTurn(request([...first, user("again")], { systemPrompt: `You are sova.\n\n${sections}` })), () => finish(2));
	assert.equal(children.length, 2, "the bridge hashes the prompt it is given, lead-in included");
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
// ---------------------------------------------------------------------------
// Fold budget, tail-preserving clip, CLI tool names
// ---------------------------------------------------------------------------

function assistantText(text: string): Message {
	return {
		role: "assistant", content: [{ type: "text", text }],
		api: "anthropic-messages", provider: "anthropic", model: "sonnet",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 2,
	} as Message;
}

/** `pairs` user/assistant exchanges of about `size` characters each, numbered from 1. */
function longHistory(pairs: number, size: number): Message[] {
	const out: Message[] = [];
	for (let n = 1; n <= pairs; n++) {
		out.push(user(`QUESTION-${n} ${"q".repeat(size)}`));
		out.push(assistantText(`ANSWER-${n} ${"a".repeat(size)}`));
	}
	return out;
}

const bodyOf = (text: string) => text.slice(text.indexOf("\n\n") + 2, text.indexOf("\n</conversation-history>"));

test("the fold budget scales with the context window: 1M gets a bigger cap than 200K", () => {
	const small = foldBudgetChars({ contextWindow: 200_000, maxTokens: 64_000 });
	const large = foldBudgetChars({ contextWindow: 1_000_000, maxTokens: 64_000 });
	assert.equal(FOLD_CHARS_PER_TOKEN, 2.2, "measured live: 524,682 fold chars cost 231,491 input tokens");
	// (200_000 - 16_384 reserve - 4_000 overhead - 64_000 output) * 0.85 tokens * 2.2 chars.
	assert.equal(small, Math.floor((200_000 - 16_384 - 4_000 - 64_000) * 0.85 * 2.2));
	assert.equal(small, 216_201);
	assert.equal(large, Math.floor((1_000_000 - 16_384 - 4_000 - 64_000) * 0.85 * 2.2));
	assert.equal(large, 1_712_201);
	assert.ok(large < MAX_FOLD_CHARS, "at 2.2 chars/token the 1M window, not the line ceiling, sets the cap");
	assert.ok(small > MIN_FOLD_CHARS && small < large);
	// What shares the window comes off the fold, at the same density.
	const prompt = "p".repeat(22_000);
	assert.equal(foldBudgetChars({ contextWindow: 200_000, maxTokens: 64_000, systemPrompt: prompt }), Math.floor((200_000 - 16_384 - 4_000 - 10_000 - 64_000) * 0.85 * 2.2));
	// The ceiling still binds for a window past it.
	assert.equal(foldBudgetChars({ contextWindow: 2_000_000, maxTokens: 64_000 }), MAX_FOLD_CHARS);
	assert.ok(foldBudgetChars({ contextWindow: 200_000, maxTokens: 64_000, tools }) < small);
	// No window: the fixed cap. A tiny window: the floor.
	assert.equal(foldBudgetChars({}), LIMITS.maxFoldedChars);
	assert.equal(foldBudgetChars({}, 1234), 1234);
	assert.equal(foldBudgetChars({ contextWindow: 50_000, maxTokens: 64_000 }), MIN_FOLD_CHARS);
});

test("an over-budget fold drops the oldest messages, keeps the newest and the task, and says so at the head", () => {
	const history = [...longHistory(40, 1_000), user("LATEST please finish")];
	const folded = foldHistory(history, LIMITS, "restarted", 20_000);
	const body = bodyOf(folded.text);
	assert.ok(folded.omitted > 0);
	assert.match(body, new RegExp(`^\\[${folded.omitted} earlier message\\(s\\) omitted to fit the context window\\]\n\n## User\nQUESTION-1 `), "marker first, then the task");
	assert.ok(body.endsWith("## User\nLATEST please finish"), "the newest message is last and whole");
	assert.ok(body.includes("ANSWER-40 "), "the newest exchange survives");
	assert.ok(!body.includes("ANSWER-1 ") && !body.includes("QUESTION-2 "), "the oldest go first");
	assert.match(body, /\n\n\[… \d+ message\(s\) omitted here …\]\n\n/, "the gap after the task is marked");
	assert.ok(folded.text.startsWith(`<conversation-history>\n${RESTARTED_HEADER} The conversation is longer than fits: its oldest messages are left out`), "the framing says so too");
	assert.ok(body.length <= 20_000, `${body.length}`);
	// Kept messages are contiguous from the end: nothing newer than a dropped one is missing.
	const kept = [...body.matchAll(/(?:QUESTION|ANSWER)-(\d+) /g)].map((m) => Number(m[1]));
	const tail = kept.slice(2); // after QUESTION-1 and ... its gap
	assert.deepEqual(tail, [...tail].sort((a, b) => a - b));
	assert.equal(tail.at(-1), 40);
	assert.equal(folded.omitted, history.length - (kept.length + 1));
});

test("a clipped fold never splits a message, and keeps the last user message even when it alone is over budget", () => {
	const huge = `LAST ${"z".repeat(30_000)}`;
	const folded = foldHistory([...longHistory(5, 1_000), user(huge)], LIMITS, "restarted", 10_000);
	const body = bodyOf(folded.text);
	assert.ok(body.startsWith("[10 earlier message(s) omitted to fit the context window]\n\n"), body.slice(0, 80));
	assert.ok(body.endsWith(`## User\n${huge}`));
	assert.ok(!body.includes("[truncated]"));
});

test("a task statement too big for a quarter of the budget is dropped like any old message", () => {
	const history = [user(`TASK ${"t".repeat(8_000)}`), ...longHistory(20, 500).slice(1), user("LATEST")];
	const body = bodyOf(foldHistory(history, LIMITS, "restarted", 12_000).text);
	assert.ok(!body.includes("TASK "));
	assert.match(body, /^\[\d+ earlier message\(s\) omitted to fit the context window\]\n\n## (User|Assistant)\n/);
	assert.ok(!body.includes("omitted here"), "one leading gap, one marker");
});

test("a fold within budget is unchanged: no marker, nothing omitted", () => {
	const history = longHistory(3, 100);
	const folded = foldHistory(history, LIMITS, "restarted", 1_000_000);
	assert.equal(folded.omitted, 0);
	assert.ok(!folded.text.includes("omitted to fit") && !folded.text.includes("omitted here"));
	assert.equal(foldHistory(history, LIMITS).text, folded.text);
	assert.equal(foldSizeEstimate(history), folded.text.length);
});

test("images of dropped messages are dropped with them; kept ones stay in order", () => {
	const image = (data: string): Message => ({ role: "user", content: [{ type: "text", text: `img ${data} ${"i".repeat(3_000)}` }, { type: "image", data, mimeType: "image/png" }], timestamp: 1 });
	const history = [image("OLD"), ...longHistory(10, 1_000), image("NEW")];
	const folded = foldHistory(history, LIMITS, "restarted", 8_000);
	assert.deepEqual(folded.images.map((i) => i.data), ["NEW"]);
});

test("folded tool calls and results carry the CLI's full tool names, never doubled", () => {
	const folded = foldHistory([
		user("go"),
		assistantWithCall("toolu_1", "bash", { command: "ls" }),
		toolResult("toolu_1", "bash", "a.txt"),
		toolResult("toolu_2", "mcp__sova__agent_transcript", "report"),
	], LIMITS);
	assert.match(folded.text, /## Assistant tool call `mcp__sova__bash` \(id toolu_1\)/);
	assert.match(folded.text, /## Tool `mcp__sova__bash` \(id toolu_1\) returned\na\.txt/);
	assert.match(folded.text, /## Tool `mcp__sova__agent_transcript` \(id toolu_2\) returned\nreport/);
	assert.ok(!folded.text.includes("mcp__sova__mcp__sova__"));
	assert.ok(!/`(bash|read)`/.test(folded.text), "no bare pi name the CLI would refuse");
});

test("a restart sizes its fold from the request's context window", { timeout: 8000 }, async () => {
	// ~660K characters of history: over the 200K model's budget, under the 1M model's.
	const history = [...longHistory(300, 1_100), user("LATEST")];
	const sent: Record<string, string> = {};
	for (const [label, contextWindow] of [["200k", 200_000], ["1m", 1_000_000]] as const) {
		const { bridge, children } = harness();
		await collectAfter(bridge.runTurn(request(history, { contextWindow, maxTokens: 64_000, sessionId: `window-${label}` })), async () => {
			const cli = await child(children, 1);
			const frame = await cli.waitFor((f) => f.type === "user");
			sent[label] = frame.message.content[0].text;
			cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
		});
		await bridge.disposeAll();
	}
	const budget200k = foldBudgetChars({ contextWindow: 200_000, maxTokens: 64_000, tools });
	assert.match(sent["200k"]!, /\[\d+ earlier message\(s\) omitted to fit the context window\]/);
	assert.ok(bodyOf(sent["200k"]!).length <= budget200k);
	assert.ok(sent["200k"]!.includes("## User\nLATEST"));
	assert.ok(!sent["1m"]!.includes("omitted to fit"), "the 1M window takes the whole history");
	assert.ok(sent["1m"]!.includes("QUESTION-1 ") && sent["1m"]!.includes("## User\nLATEST"));
});

// ---------------------------------------------------------------------------
// Every new user message reaches the CLI
// ---------------------------------------------------------------------------

test("several user messages in one tail are all sent, in order, as one CLI message", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	const m1 = [user("start")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.type === "user");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	const cli = children[0]!;
	const before = cli.sent.filter((f) => f.type === "user").length;
	const m2 = [...m1, assistantText("ok"), user("FIRST queued"), user("SECOND queued"), user("THIRD queued")];
	await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.type === "user" && JSON.stringify(f.message?.content).includes("THIRD"));
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	const users = cli.sent.filter((f) => f.type === "user").slice(before);
	assert.equal(users.length, 1, "one stream-json message, not a steer per message");
	assert.deepEqual(users[0]!.message.content, [{ type: "text", text: "FIRST queued\n\nSECOND queued\n\nTHIRD queued" }]);
	assert.equal(children.length, 1, "a clean append, no restart");
	await bridge.disposeAll();
});

test("steering messages queued behind a held call are all sent after its answer", { timeout: 8000 }, async () => {
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
	const image: Message = { role: "user", content: [{ type: "text", text: "and this" }, { type: "image", data: "BBBB", mimeType: "image/png" }], timestamp: 1 };
	const m2 = [...m1, assistantWithCall("toolu_1", "read", { path: "a.txt" }), toolResult("toolu_1", "read", "body"), user("one"), image];
	await collectAfter(bridge.runTurn(request(m2)), async () => {
		await cli.waitFor((f) => f.type === "user" && JSON.stringify(f.message?.content).includes("and this"));
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	const answerAt = cli.sent.findIndex((f) => f.response?.request_id === "held-1");
	const steers = cli.sent.map((f, i) => [f, i] as const).filter(([f]) => f.type === "user" && JSON.stringify(f.message?.content).includes("and this"));
	assert.equal(steers.length, 1);
	const [steer, steerAt] = steers[0]!;
	assert.ok(answerAt >= 0 && answerAt < steerAt);
	assert.deepEqual(steer.message.content, [
		{ type: "text", text: "one\n\nand this" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
	]);
	await bridge.disposeAll();
});

// ---------------------------------------------------------------------------
// pi owns compaction
// ---------------------------------------------------------------------------

test("the child is launched with the CLI's auto-compact disabled, manual /compact left alone", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	await collectAfter(bridge.runTurn(request([user("hi")])), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.type === "user");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children[0]!.env.DISABLE_AUTO_COMPACT, "1");
	assert.equal(children[0]!.env.DISABLE_COMPACT, undefined);
	await bridge.disposeAll();
});

test("a compact_boundary from the child makes the next turn restart onto pi's transcript", { timeout: 8000 }, async () => {
	const { bridge, children, debug } = harness();
	const m1 = [user("hi")];
	await collectAfter(bridge.runTurn(request(m1)), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.type === "user");
		cli.emitFrame({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } });
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.deepEqual(debug.map((d) => d.event), ["desynced"]);
	await collectAfter(bridge.runTurn(request([...m1, assistantText("ok"), user("next")])), async () => {
		const cli = await child(children, 2);
		const sent = await cli.waitFor((f) => f.type === "user");
		assert.match(sent.message.content[0].text, /^<conversation-history>\n/);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	assert.equal(children.length, 2);
	await bridge.disposeAll();
});

/** pi 0.87.1's summarization request: a fresh uuid session id, pi's summarizer prompt, no tools. */
function summaryRequest(text: string, sessionId = "0199b6e2-7c1a-7000-8000-000000000001"): ClaudeTurnRequest {
	return request([user(text)], { sessionId, systemPrompt: "You are a context summarization assistant.", tools: [] });
}

test("a compaction summary runs on its own child, which is disposed after; the conversation restarts once", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	bridge.setSessionCwd("pi-session-1", "/tmp/pi-bridge-test");
	const finish = async (n: number) => {
		const cli = await child(children, n);
		await cli.waitFor((f) => f.type === "user");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	};
	const conversation = [user("one"), assistantText("two")];
	await collectAfter(bridge.runTurn(request(conversation)), () => finish(1));

	const frames = await collectAfter(bridge.runTurn(summaryRequest("<conversation>…</conversation> Summarize.")), () => finish(2));
	assert.equal(frames.at(-1)?.type, "result");
	assert.equal(children.length, 2);
	// The summary's child was a first contact: its prompt went as-is.
	assert.equal(children[1]!.sent.find((f) => f.type === "user")!.message.content[0].text, "<conversation>…</conversation> Summarize.");
	const deadline = Date.now() + 2000;
	while (!children[1]!.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	assert.ok(children[1]!.exited, "the summarizer child is disposed, not left idling until reaped");
	assert.ok(!children[0]!.exited, "the conversation's child is untouched");
	assert.deepEqual(bridge.activeSessionIds(), ["pi-session-1"]);

	await collectAfter(bridge.runTurn(request([user("<summary of the conversation>"), user("three")])), () => finish(3));
	assert.equal(children.length, 3, "resuming after compaction restarts once");
	await bridge.disposeAll();
});

test("a pi session's own tool-less turn is not mistaken for a one-shot request", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	bridge.setSessionCwd("pi-session-7", "/tmp/pi-bridge-test");
	await collectAfter(bridge.runTurn(request([user("hi")], { sessionId: "pi-session-7", tools: [] })), async () => {
		const cli = await child(children, 1);
		await cli.waitFor((f) => f.type === "user");
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(!children[0]!.exited);
	assert.deepEqual(bridge.activeSessionIds(), ["pi-session-7"]);
	await bridge.disposeAll();
});

test("an oversized summary request fails loudly at once instead of hanging, and its child is disposed", { timeout: 8000 }, async () => {
	const { bridge, children } = harness({ limits: { maxLineBytes: 64 * 1024 } });
	const started = Date.now();
	const frames = await collect(bridge.runTurn(summaryRequest(`Summarize ${"x".repeat(100_000)}`)));
	assert.ok(Date.now() - started < 1_500, "no wait on a message the child never received");
	const last = frames.at(-1);
	assert.equal(last?.type, "result");
	assert.equal(last?.type === "result" && last.outcome, "error");
	assert.match(last?.type === "result" ? last.message ?? "" : "", /over the 65536-byte limit for one stdin line/);
	assert.ok(!children[0]!.sent.some((f) => f.type === "user"), "nothing partial was written");
	const deadline = Date.now() + 2000;
	while (!children[0]!.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	assert.ok(children[0]!.exited);
	assert.deepEqual(bridge.activeSessionIds(), []);
	await bridge.disposeAll();
});

test("an oversized message fails the turn through stream.ts as an error pi reports, not a hang", { timeout: 8000 }, async () => {
	const { bridge } = harness({ limits: { maxLineBytes: 64 * 1024 } });
	const model = { ...STATIC_MODELS.find((m) => m.id === "sonnet")!, provider: "claude-code-cli", api: "claude-code-cli", baseUrl: "x" } as Model<Api>;
	const context = normalizeContext({ systemPrompt: "You are a context summarization assistant.", messages: [user(`Summarize ${"x".repeat(100_000)}`)] });
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamClaudeCode(bridge, model, context, { sessionId: "0199b6e2-7c1a-7000-8000-000000000002" })) events.push(event);
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(last?.type === "error" ? last.error.errorMessage ?? "" : "", /stdin line/);
	await bridge.disposeAll();
});

test("a request over the model's window fails at once with the sizes, not after an upload", { timeout: 8000 }, async () => {
	const { bridge, children } = harness();
	// pi's summary input for one real 3 MB session: 549K characters, fine for [1m], never for a 200K model.
	const req = summaryRequest(`Summarize ${"x".repeat(549_000)}`);
	const frames = await collect(bridge.runTurn({ ...req, contextWindow: 200_000, maxTokens: 64_000 }));
	const last = frames.at(-1);
	assert.equal(last?.type === "result" && last.outcome, "error");
	// (549_010 message + 42 system prompt chars) / 2.2, rounded up.
	assert.match(last?.type === "result" ? last.message ?? "" : "", /its input is about 249570 tokens, which with 64000 for the reply exceeds sonnet's 200000-token context window/);
	assert.ok(!children[0]!.sent.some((f) => f.type === "user"), "nothing was sent");
	// The same request on a 1M window goes through whole, never shortened.
	const { bridge: large, children: largeChildren } = harness();
	await collectAfter(large.runTurn({ ...req, contextWindow: 1_000_000, maxTokens: 64_000 }), async () => {
		const cli = await child(largeChildren, 1);
		const sent = await cli.waitFor((f) => f.type === "user");
		assert.equal(sent.message.content[0].text, `Summarize ${"x".repeat(549_000)}`);
		cli.emitFrame({ type: "result", subtype: "success", is_error: false, result: "ok" });
	});
	await bridge.disposeAll();
	await large.disposeAll();
});

test("the window pre-check refuses only what certainly cannot fit", () => {
	const at = { model: "sonnet", contextWindow: 200_000, maxTokens: 64_000, systemPrompt: "" };
	// Exactly the window less the reserve and the reply fits; one token more does not.
	const room = (200_000 - 16_384 - 64_000) * FOLD_CHARS_PER_TOKEN;
	assert.equal(windowOverflow(Math.floor(room), at), undefined);
	assert.match(windowOverflow(Math.floor(room) + 3, at) ?? "", /exceeds sonnet's 200000-token context window/);
	// The system prompt counts; no window, no verdict.
	assert.ok(windowOverflow(Math.floor(room) - 100, { ...at, systemPrompt: "s".repeat(1_000) }));
	assert.equal(windowOverflow(10_000_000, { model: "sonnet" }), undefined);
});
