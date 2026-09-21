import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
	applyResultUsage, buildClaudeArgv, buildDiscoveryArgv, ClaudePrivateFiles, ClaudeTransport, claudeEnv,
	contextTokensFrom, DEFAULT_CLAUDE_TOOLS, isMessageStart, isUncorrelatedResult, mcpServerFailure,
	parseCanUseTool, permissionDenialsFrom, resultError, resultMatches, textBlocksText, textDelta,
	validEnv, validMcpServers, type ClaudeStreamEvent, type ClaudeTransportHooks, type ClaudeUsage,
} from "./transport.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MODES = ["bypassPermissions", "acceptEdits", "manual", "dontAsk", "plan"];

// ---------------------------------------------------------------------------
// Pure decoding and validation
// ---------------------------------------------------------------------------

test("resultError prefers useful diagnostics and falls back when they are missing or empty", () => {
	const cases: [Record<string, unknown>, string][] = [
		[{ errors: ["", "  ", 7, "real failure"], result: "API Error" }, "real failure"],
		[{ errors: [], result: "  API Error: overloaded  " }, "API Error: overloaded"],
		[{ errors: [""], result: "", terminal_reason: "max_turns" }, "Claude task ended: max_turns"],
		[{ subtype: "error_during_execution", result: "" }, "Claude task failed: error_during_execution"],
		[{ result: "" }, "Claude task failed"],
		[{ subtype: "", result: undefined, errors: null }, "Claude task failed"],
		[{ subtype: "success", result: "" }, "Claude task failed"],
	];
	for (const [event, expected] of cases) assert.equal(resultError(event), expected, JSON.stringify(event));
	// Bounded: a flood of error strings cannot be replayed in full.
	assert.equal(resultError({ errors: Array.from({ length: 50 }, (_, i) => `e${i}`) }).split("\n").length, 20);
});

test("usage uses cumulative model totals and cost, never a sum of cumulative results", () => {
	const usage: ClaudeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
	applyResultUsage(usage, { total_cost_usd: 0.2, num_turns: 1, modelUsage: { sonnet: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } } });
	applyResultUsage(usage, { total_cost_usd: 0.3, num_turns: 1, modelUsage: { sonnet: { inputTokens: 15, outputTokens: 9 }, haiku: { inputTokens: 1, outputTokens: 1 } } });
	assert.deepEqual(usage, { input: 16, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.3, turns: 2, contextTokens: 0 });
	// A lower cumulative cost never lowers the reported one; junk counts as zero.
	applyResultUsage(usage, { total_cost_usd: 0.1, num_turns: "many" });
	assert.equal(usage.cost, 0.3); assert.equal(usage.turns, 2);
	// Without modelUsage the per-result usage block is additive.
	const other: ClaudeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
	const block = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 6 };
	applyResultUsage(other, { usage: block });
	applyResultUsage(other, { usage: block });
	assert.deepEqual(other, { input: 8, output: 4, cacheRead: 2, cacheWrite: 12, cost: 0, turns: 0, contextTokens: 0 });
});

test("context tokens sum every cumulative input class of an assistant message", () => {
	assert.equal(contextTokensFrom({ input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 1 }), 16);
	assert.equal(contextTokensFrom({ input_tokens: -2, output_tokens: NaN }), 0);
	assert.equal(contextTokensFrom("nonsense"), 0);
	assert.equal(contextTokensFrom(undefined), 0);
});

test("message text accepts a string or a block array and ignores non-text blocks", () => {
	assert.equal(textBlocksText("plain"), "plain");
	assert.equal(textBlocksText([{ type: "text", text: "a" }, { type: "thinking", thinking: "no" }, { type: "text" }, null, { type: "text", text: "b" }]), "ab");
	assert.equal(textBlocksText(undefined), "");
	assert.equal(textBlocksText({ type: "text", text: "not an array" }), "");
});

test("stream deltas are recognized only in their exact shape", () => {
	assert.equal(isMessageStart({ type: "stream_event", event: { type: "message_start" } }), true);
	assert.equal(isMessageStart({ type: "assistant", event: { type: "message_start" } }), false);
	assert.equal(textDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }), "hi");
	assert.equal(textDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta" } } }), "");
	assert.equal(textDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }), undefined);
	assert.equal(textDelta({ type: "assistant" }), undefined);
});

test("result correlation covers both UUID fields, and only a truly bare result is uncorrelated", () => {
	assert.equal(resultMatches({ user_message_uuid: "a" }, "a"), true);
	assert.equal(resultMatches({ user_message_uuids: ["x", "a"] }, "a"), true);
	assert.equal(resultMatches({ user_message_uuid: "b", user_message_uuids: [] }, "a"), false);
	assert.equal(isUncorrelatedResult({}), true);
	assert.equal(isUncorrelatedResult({ user_message_uuid: null }), false);
	assert.equal(isUncorrelatedResult({ user_message_uuids: ["a"] }), false);
});

test("permission denials are stringified and bounded", () => {
	const denials = permissionDenialsFrom([{ tool_name: "Bash", tool_use_id: "t1" }, { tool_use_id: 9 }, { tool_name: "x".repeat(400), tool_use_id: "y".repeat(400) }]);
	assert.deepEqual(denials[0], { toolName: "Bash", toolUseId: "t1" });
	assert.deepEqual(denials[1], { toolName: "tool", toolUseId: undefined });
	assert.equal(denials[2]!.toolName.length, 256); assert.equal(denials[2]!.toolUseId!.length, 256);
	assert.equal(permissionDenialsFrom(Array.from({ length: 500 }, () => ({}))).length, 100);
	assert.deepEqual(permissionDenialsFrom("no"), []);
});

test("env and mcp server blocks are validated before they reach a child verbatim", () => {
	assert.equal(validEnv({ MCP_TOOL_TIMEOUT: "1000", _x1: "" }), true);
	assert.equal(validEnv({ "BAD NAME": "v" }), false);
	assert.equal(validEnv({ "1BAD": "v" }), false);
	assert.equal(validEnv({ OK: 7 }), false);
	assert.equal(validEnv(["OK=1"]), false);
	assert.equal(validEnv(null), false);
	const ok: [string, unknown][] = [["team-1", { command: "node", args: ["a.js"], env: { A: "b" } }]];
	assert.equal(validMcpServers(ok), true);
	assert.equal(validMcpServers([["bad name", { command: "node", args: [] }]]), false);
	assert.equal(validMcpServers([["n", { command: "no\nnewline", args: [] }]]), false);
	assert.equal(validMcpServers([["n", { command: "", args: [] }]]), false);
	assert.equal(validMcpServers([["n", { command: "node", args: [3] }]]), false);
	assert.equal(validMcpServers([["n", { command: "node", args: ["a"], env: { "BAD NAME": "v" } }]]), false);
	assert.equal(validMcpServers([["n", null]]), false);
});

test("a configured MCP server that did not connect is reported by name and status", () => {
	const event = { mcp_servers: [{ name: "team", status: "failed" }, { name: "other", status: "connected" }] };
	assert.match(mcpServerFailure(event, ["team"])!, /MCP server "team" did not connect \(status failed\)/);
	assert.equal(mcpServerFailure(event, ["other"]), undefined);
	assert.match(mcpServerFailure(event, ["missing"])!, /status missing/);
	assert.match(mcpServerFailure({ mcp_servers: [{ name: "team" }] }, ["team"])!, /status unknown/);
	assert.equal(mcpServerFailure({}, []), undefined, "nothing configured is never a failure");
	assert.match(mcpServerFailure({}, ["team"])!, /status missing/);
});

test("can_use_tool requests are decoded, and any other host request is refused", () => {
	const parsed = parseCanUseTool({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "u1", description: "list" } });
	assert.deepEqual(parsed, { requestId: "r1", toolName: "Bash", input: { command: "ls" }, toolUseId: "u1", description: "list" });
	assert.deepEqual(parseCanUseTool({ request_id: "r2", request: { subtype: "can_use_tool" } }), { requestId: "r2", toolName: "tool", input: {}, toolUseId: undefined, description: undefined });
	assert.equal(parseCanUseTool({ request_id: "r3", request: { subtype: "mcp_message" } }), undefined);
	assert.equal(parseCanUseTool({ request: { subtype: "can_use_tool" } }), undefined);
});

test("the CLI environment keeps credentials but drops nested-session markers", () => {
	const previous = { code: process.env.CLAUDECODE, entry: process.env.CLAUDE_CODE_ENTRYPOINT, path: process.env.PATH };
	process.env.CLAUDECODE = "1"; process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
	try {
		const env = claudeEnv({ MCP_TOOL_TIMEOUT: "5000", PATH: "/override" });
		assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
		assert.equal(env.MCP_TOOL_TIMEOUT, "5000");
		assert.equal(env.PATH, "/override", "a caller's variable is what the CLI sees");
		assert.equal(claudeEnv().PATH, previous.path);
	} finally {
		if (previous.code === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous.code;
		if (previous.entry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = previous.entry;
	}
});

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

const argvFor = (o: Partial<Parameters<typeof buildClaudeArgv>[0]> = {}) =>
	buildClaudeArgv({ permissionMode: "bypassPermissions", permissionModes: MODES, hostPermissions: false, ...o });

test("the persistent argv defaults to bypass with no inherited settings or MCP config", () => {
	const built = argvFor();
	assert.equal(built.error, undefined);
	const args = built.args!;
	assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
	assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
	assert.equal(args[args.indexOf("--setting-sources") + 1], "");
	assert.equal(args[args.indexOf("--tools") + 1], DEFAULT_CLAUDE_TOOLS.join(","));
	assert.ok(args.includes("--strict-mcp-config"));
	assert.ok(args.includes("--include-partial-messages") && args.includes("--replay-user-messages"));
	assert.ok(!args.includes("--permission-prompt-tool"));
	assert.ok(!args.some((s) => /dangerously|safe-mode/.test(s)));
	assert.equal(args[args.indexOf("--tools") + 1], "Bash,Read,Edit,Write,Glob,Grep");
	assert.equal(argvFor({ tools: [] }).args![argvFor({ tools: [] }).args!.indexOf("--tools") + 1], "");
});

test("host permission prompts add the stdio prompt tool, model/effort/budget are passed through", () => {
	const host = argvFor({ permissionMode: "manual", hostPermissions: true, model: "sonnet", effort: "high", maxBudgetUsd: 1.5 }).args!;
	assert.equal(host[host.indexOf("--permission-prompts") + 1], "host");
	assert.equal(host[host.indexOf("--permission-prompt-tool") + 1], "stdio");
	assert.equal(host[host.indexOf("--model") + 1], "sonnet");
	assert.equal(host[host.indexOf("--effort") + 1], "high");
	assert.equal(host[host.indexOf("--max-budget-usd") + 1], "1.5");
	assert.deepEqual(argvFor({ maxBudgetUsd: 0 }), { error: "maxBudgetUsd must be positive" });
	assert.deepEqual(argvFor({ maxBudgetUsd: Number.POSITIVE_INFINITY }), { error: "maxBudgetUsd must be positive" });
});

test("an operator allow rule keeps its place, and MCP tools are allowed only outside bypass", () => {
	const servers = { team: { command: "node", args: ["team.js"] } };
	const bypass = argvFor({ allowedTools: ["Bash(npm test *)"], mcpServers: servers }).args!;
	assert.deepEqual(bypass.slice(bypass.indexOf("--allowedTools")), ["--allowedTools", "Bash(npm test *)"]);
	const manual = argvFor({ permissionMode: "manual", allowedTools: ["Bash(npm test *)"], mcpServers: servers }).args!;
	assert.deepEqual(manual.slice(manual.indexOf("--allowedTools")), ["--allowedTools", "Bash(npm test *)", "mcp__team"]);
	assert.ok(!argvFor().args!.includes("--allowedTools"));
});

test("argv validation fails closed, in the order a launcher must report it", () => {
	for (const tool of ["--dangerously-skip-permissions", " --permission-mode", "Bash\n--foo", "Bash\x00", ""]) {
		assert.deepEqual(argvFor({ allowedTools: [tool] }), { error: "Invalid allowedTools: flags and control characters are not allowed" });
	}
	assert.deepEqual(argvFor({ permissionMode: "yolo" }), { error: "Unsupported permission mode" });
	// An invalid mode is reported even when allowedTools would also fail later.
	assert.deepEqual(argvFor({ permissionMode: "yolo", mcpServers: { "bad name": {} } }), { error: "Unsupported permission mode" });
	assert.deepEqual(argvFor({ mcpServers: { "bad name": { command: "node", args: [] } } }), { error: "Invalid mcpServers: names must be [A-Za-z0-9_-], commands/args/env plain strings" });
	assert.deepEqual(argvFor({ env: { "BAD NAME": "v" } }), { error: "Invalid env: names must be [A-Za-z_][A-Za-z0-9_]*, values strings" });
	// mcpServers is checked before env, so a launcher never reports the second first.
	assert.deepEqual(argvFor({ mcpServers: { "bad name": {} }, env: { "BAD NAME": "v" } }).error, "Invalid mcpServers: names must be [A-Za-z0-9_-], commands/args/env plain strings");
});

test("discovery argv asks only for initialize: no tools, settings or prompts", () => {
	const args = buildDiscoveryArgv();
	assert.equal(args[args.indexOf("--tools") + 1], "");
	assert.equal(args[args.indexOf("--setting-sources") + 1], "");
	assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
	assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
	assert.ok(args.includes("--strict-mcp-config"));
	assert.ok(!args.includes("--replay-user-messages"), "discovery never sends a user message");
});

// ---------------------------------------------------------------------------
// Private launch files
// ---------------------------------------------------------------------------

test("private files are 0600 in a 0700 directory, passed by path, and cleaned up in the right order", { skip: process.platform === "win32" }, (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transport-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
	const files = new ClaudePrivateFiles();
	const args = files.write({ tmpDir, systemPrompt: "SECRET INSTRUCTIONS", mcpServers: [["team", { command: "node", args: ["team.js"], env: { TOKEN: "s3cret" } }]] });
	assert.deepEqual(args, ["--append-system-prompt-file", files.systemPromptFile!, "--mcp-config", files.mcpConfigFile!]);
	assert.ok(!args.join(" ").includes("SECRET INSTRUCTIONS") && !args.join(" ").includes("s3cret"));
	assert.equal(fs.statSync(files.dir!).mode & 0o777, 0o700);
	assert.equal(fs.statSync(files.systemPromptFile!).mode & 0o777, 0o600);
	assert.equal(fs.statSync(files.mcpConfigFile!).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(files.systemPromptFile!, "utf8"), "SECRET INSTRUCTIONS");
	assert.deepEqual(JSON.parse(fs.readFileSync(files.mcpConfigFile!, "utf8")), { mcpServers: { team: { command: "node", args: ["team.js"], env: { TOKEN: "s3cret" } } } });
	// The prompt is read at startup; the MCP config must outlive it.
	const promptPath = files.systemPromptFile!; const dir = files.dir!;
	files.releaseSystemPrompt();
	assert.equal(fs.existsSync(promptPath), false);
	assert.equal(fs.existsSync(files.mcpConfigFile!), true);
	files.cleanup();
	assert.equal(fs.existsSync(dir), false);
	assert.equal(files.dir, undefined);
});

test("a system prompt alone leaves nothing behind once it has been read", { skip: process.platform === "win32" }, (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transport-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
	const files = new ClaudePrivateFiles();
	assert.deepEqual(files.write({ tmpDir, mcpServers: [] }), [], "nothing configured writes nothing");
	assert.equal(files.dir, undefined);
	const args = files.write({ tmpDir, systemPrompt: "hi", mcpServers: [] });
	assert.deepEqual(args, ["--append-system-prompt-file", files.systemPromptFile!]);
	const dir = files.dir!;
	files.releaseSystemPrompt();
	assert.equal(fs.existsSync(dir), false, "no MCP config to keep, so the whole directory goes");
});

test("an unwritable private directory fails closed and leaves no partial launch state", (t) => {
	const tmpDir = path.join(os.tmpdir(), "transport-test-missing", "deeper");
	const files = new ClaudePrivateFiles();
	t.after(() => files.cleanup());
	assert.throws(() => files.write({ tmpDir, systemPrompt: "hi", mcpServers: [] }), /Could not write system prompt file:/);
	assert.equal(files.dir, undefined);
	assert.throws(() => files.write({ tmpDir, mcpServers: [["team", { command: "node", args: [] }]] }), /Could not write private launch file:/);
	assert.equal(files.dir, undefined);
});

// ---------------------------------------------------------------------------
// The transport itself
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new PassThrough();
	stderr = new PassThrough();
	writes: any[] = [];
	signals: string[] = [];
	eof = false;
	stdin = new Writable({
		write: (chunk, _encoding, callback) => { this.writes.push(JSON.parse(String(chunk))); callback(); },
		final: (callback) => { this.eof = true; callback(); },
	});
	kill(signal: string) { this.signals.push(signal); return true; }
	out(event: any) { this.stdout.write(JSON.stringify(event) + "\n"); }
	close(code: number | null = 0, signal: string | null = null) { this.emit("close", code, signal); }
}
interface Harness {
	transport: ClaudeTransport;
	child: FakeChild;
	events: ClaudeStreamEvent[];
	stderr: string[];
	errors: string[];
	closes: [number | null, string | null][];
	interrupts: (boolean | undefined)[];
	order: string[];
	spawned: { command: string; args: string[]; options: any } | undefined;
}
function harness(hooks: Partial<ClaudeTransportHooks> = {}, options: { maxLineBytes?: number; beforeEof?: () => Promise<void> } = {}): Harness {
	const child = new FakeChild();
	const h: Harness = { transport: undefined as any, child, events: [], stderr: [], errors: [], closes: [], interrupts: [], order: [], spawned: undefined };
	h.transport = new ClaudeTransport({
		timings: { requestTimeoutMs: 60, eofGraceMs: 20, termGraceMs: 20, pipeDrainMs: 20 },
		limits: { maxLineBytes: options.maxLineBytes ?? 4 * 1024 * 1024 },
		spawnImpl: (command, args, opts) => { h.spawned = { command, args, options: opts }; return child as unknown as ChildProcess; },
		signalGroupImpl: (_pid, signal) => { child.kill(signal); },
		hooks: {
			onEvent: (event) => h.events.push(event),
			onStderr: (text) => h.stderr.push(text),
			onProtocolError: (message) => h.errors.push(message),
			onStdinError: (message) => h.errors.push(message),
			onProcessError: (message) => h.errors.push(message),
			onClose: (code, signal) => { h.order.push("onClose"); h.closes.push([code, signal]); },
			onInterruptSettled: (ack) => h.interrupts.push(ack),
			beforeEof: options.beforeEof,
			...hooks,
		},
	});
	return h;
}

test("launch passes the CLI argv with a scrubbed environment, no shell, and its own process group", () => {
	const h = harness();
	h.transport.launch("claude", ["-p", "--verbose"], { cwd: "/tmp/work", env: { MCP_TOOL_TIMEOUT: "10" } });
	assert.equal(h.spawned!.command, "claude");
	assert.deepEqual(h.spawned!.args, ["-p", "--verbose"]);
	assert.equal(h.spawned!.options.cwd, "/tmp/work");
	assert.equal(h.spawned!.options.shell, false);
	assert.equal(h.spawned!.options.detached, process.platform !== "win32");
	assert.deepEqual(h.spawned!.options.stdio, ["pipe", "pipe", "pipe"]);
	assert.equal(h.spawned!.options.env.CLAUDECODE, undefined);
	assert.equal(h.spawned!.options.env.MCP_TOOL_TIMEOUT, "10");
	assert.equal(h.transport.processAlive, true);
	assert.equal(h.transport.pid, 4242);
	assert.equal(h.transport.isClosed(), false);
});

test("attach re-adopts a running process without argv or an environment of ours", () => {
	const h = harness();
	h.transport.attach({ cwd: "/tmp/work" });
	assert.equal(h.spawned!.command, "");
	assert.deepEqual(h.spawned!.args, []);
	assert.equal(h.spawned!.options.env, undefined);
	assert.equal(h.spawned!.options.shell, undefined);
	assert.equal(h.transport.child, h.child as unknown as ChildProcess);
});

test("a spawn failure is thrown to the caller, which owns the message", () => {
	const transport = new ClaudeTransport({
		timings: { requestTimeoutMs: 10, eofGraceMs: 10, termGraceMs: 10, pipeDrainMs: 10 },
		limits: { maxLineBytes: 1024 },
		spawnImpl: () => { throw new Error("ENOENT"); },
		hooks: { onEvent() {}, onProtocolError() {}, onStdinError() {}, onProcessError() {}, onClose() {} },
	});
	assert.throws(() => transport.launch("claude", [], { cwd: "/tmp" }), /ENOENT/);
	assert.equal(transport.processAlive, false);
});

test("frames are written one JSON line at a time and bounded by the record limit", () => {
	const h = harness({}, { maxLineBytes: 200 });
	h.transport.launch("claude", [], { cwd: "/tmp" });
	assert.equal(h.transport.sendUser("u-1", "hello"), true);
	assert.deepEqual(h.child.writes[0], { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
	assert.equal(h.transport.respond("r1", { behavior: "allow" }), true);
	assert.deepEqual(h.child.writes[1], { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow" } } });
	assert.equal(h.transport.respondError("r2", "Unsupported host control request"), true);
	assert.deepEqual(h.child.writes[2], { type: "control_response", response: { subtype: "error", request_id: "r2", error: "Unsupported host control request" } });
	assert.equal(h.transport.sendUser("u-2", "x".repeat(300)), false, "an oversized frame is rejected, not buffered");
	assert.equal(h.child.writes.length, 3);
});

test("writes are refused once the process is gone", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.emit("exit", 0, null); await tick();
	assert.equal(h.transport.hasExited(), true);
	assert.equal(h.transport.sendUser("u-1", "hi"), false);
	assert.equal(await h.transport.control("initialize"), undefined, "an unwritable control request resolves as unanswered");
	h.child.close(0, null);
});

test("control requests correlate by id: success, rejection, timeout and extra fields", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const init = h.transport.control("initialize", { sdkMcpServers: [{ name: "pi" }] });
	const frame = h.child.writes[0];
	assert.equal(frame.type, "control_request");
	assert.equal(typeof frame.request_id, "string");
	assert.deepEqual(frame.request, { subtype: "initialize", sdkMcpServers: [{ name: "pi" }] });
	// A response for another request never settles this one.
	h.child.out({ type: "control_response", response: { request_id: "other", subtype: "success" } });
	await tick();
	h.child.out({ type: "control_response", response: { request_id: frame.request_id, subtype: "success", response: { account: "PRIVATE" } } });
	assert.equal(await init, true);
	const rejected = h.transport.control("set_model", { model: "sonnet" });
	h.child.out({ type: "control_response", response: { request_id: h.child.writes[1].request_id, subtype: "error", error: "no" } });
	assert.equal(await rejected, false);
	const unknown = h.transport.control("set_max_thinking_tokens", { max_thinking_tokens: 1024 });
	h.child.out({ type: "control_response", response: { request_id: h.child.writes[2].request_id, subtype: "weird" } });
	assert.equal(await unknown, undefined, "an unknown response subtype is no known answer");
	const late = h.transport.control("interrupt");
	assert.equal(await late, undefined, "silence through the deadline resolves unanswered");
	// Every control_response still reaches the owner, correlated or not.
	assert.equal(h.events.filter((e) => e.type === "control_response").length, 4);
	h.child.close();
});

test("request() returns the CLI's own payload, and control() reduces it to the ack", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const listed = h.transport.request("mcp_message", { server_name: "pi", message: { method: "tools/list" } });
	const frame = h.child.writes[0];
	assert.deepEqual(frame.request, { subtype: "mcp_message", server_name: "pi", message: { method: "tools/list" } });
	h.child.out({ type: "control_response", response: { request_id: frame.request_id, subtype: "success", response: { tools: [{ name: "read_file" }] } } });
	assert.deepEqual(await listed, { ack: true, response: { tools: [{ name: "read_file" }] }, error: undefined });
	// A rejection carries its message; a payload-less success has no response.
	const denied = h.transport.request("set_model", { model: "nope" });
	h.child.out({ type: "control_response", response: { request_id: h.child.writes[1].request_id, subtype: "error", error: "unknown model" } });
	assert.deepEqual(await denied, { ack: false, response: undefined, error: "unknown model" });
	const bare = h.transport.request("interrupt");
	h.child.out({ type: "control_response", response: { request_id: h.child.writes[2].request_id, subtype: "success", response: "not an object" } });
	assert.deepEqual(await bare, { ack: true, response: undefined, error: undefined });
	// Silence is still no known response, for the payload API too.
	assert.deepEqual(await h.transport.request("initialize"), { ack: undefined });
	assert.equal(await h.transport.control("initialize"), undefined);
	h.child.close();
});

test("an owner can answer inbound control requests generically; unhandled ones are refused", async () => {
	const seen: { requestId: string; subtype: string; payload: any }[] = [];
	const h = harness({
		onControlRequest: (request) => {
			seen.push({ requestId: request.requestId, subtype: request.subtype, payload: (request.frame.request as any)?.message });
			if (request.subtype !== "mcp_message") return false;
			h.transport.respond(request.requestId, { result: { tools: [] } });
			return true;
		},
	});
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.out({ type: "control_request", request_id: "m1", request: { subtype: "mcp_message", message: { method: "tools/list" } } });
	h.child.out({ type: "control_request", request_id: "x1", request: { subtype: "invented" } });
	h.child.out({ type: "control_request", request: { subtype: "mcp_message" } });
	await tick();
	assert.deepEqual(seen, [
		{ requestId: "m1", subtype: "mcp_message", payload: { method: "tools/list" } },
		{ requestId: "x1", subtype: "invented", payload: undefined },
	], "a frame without a request id is never dispatched");
	assert.deepEqual(h.child.writes[0], { type: "control_response", response: { subtype: "success", request_id: "m1", response: { result: { tools: [] } } } });
	assert.deepEqual(h.child.writes[1], { type: "control_response", response: { subtype: "error", request_id: "x1", error: "Unsupported host control request" } });
	assert.equal(h.child.writes.length, 2);
	// The raw feed still sees every inbound frame, before the answering dispatch.
	assert.equal(h.events.filter((e) => e.type === "control_request").length, 3);
	h.child.close();
});

test("without the hook the transport answers nothing by itself, leaving the policy to onEvent", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash" } });
	await tick();
	assert.deepEqual(h.child.writes, [], "the worker runner keeps its own can_use_tool policy");
	assert.equal(h.events.length, 1);
	h.child.close();
});

test("stdout framing survives split UTF-8, CRLF, blank lines and a final unterminated record", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.stdout.write("\n  \n");
	h.child.stdout.write(JSON.stringify({ type: "assistant", text: "first" }) + "\r\n");
	const bytes = Buffer.from(JSON.stringify({ type: "result", result: "☃ ok" }));
	for (const b of bytes) h.child.stdout.write(Buffer.from([b]));
	h.child.stdout.end(); await tick();
	assert.deepEqual(h.events.map((e) => e.type), ["assistant", "result"]);
	assert.equal((h.events[1] as any).result, "☃ ok");
	assert.deepEqual(h.errors, []);
	h.child.close();
});

test("an oversized or malformed record is protocol corruption, not silently dropped", async () => {
	const big = harness({}, { maxLineBytes: 64 });
	big.transport.launch("claude", [], { cwd: "/tmp" });
	big.child.stdout.write(JSON.stringify({ type: "assistant", text: "x".repeat(200) }) + "\n");
	await tick();
	assert.deepEqual(big.errors, ["Claude stream-json record exceeds limit"]);
	assert.deepEqual(big.events, []);
	big.child.close();
	const bad = harness();
	bad.transport.launch("claude", [], { cwd: "/tmp" });
	bad.child.stdout.write("{not json}\n{\"type\":\"result\"}\n");
	await tick();
	assert.deepEqual(bad.errors, ["Malformed Claude stream-json record"]);
	assert.deepEqual(bad.events, [], "nothing after corruption is trusted");
	bad.child.close();
});

test("stderr is decoded for the owner and stops at closure; process errors are reported", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.stderr.write(Buffer.from("warn"));
	h.child.emit("error", new Error("boom"));
	await tick();
	assert.deepEqual(h.stderr, ["warn"]);
	assert.deepEqual(h.errors, ["Process error: boom"]);
	h.child.close();
	h.child.stderr.write(Buffer.from("after"));
	await tick();
	assert.deepEqual(h.stderr, ["warn"], "a closed transport reports no more output");
});

test("interrupt is single-flight and reports whether it was answered", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const first = h.transport.interrupt();
	const second = h.transport.interrupt();
	assert.equal(first, second, "a second caller joins the interrupt in flight");
	assert.equal(h.child.writes.length, 1);
	assert.equal(h.transport.isInterruptPending(), true);
	h.child.out({ type: "control_response", response: { request_id: h.child.writes[0].request_id, subtype: "success" } });
	assert.equal(await first, true);
	await tick();
	assert.equal(h.transport.isInterruptPending(), false);
	assert.deepEqual(h.interrupts, [true]);
	// A later interrupt is a new request, and silence is reported as unanswered.
	const third = h.transport.interrupt();
	assert.notEqual(third, first);
	assert.equal(await third, undefined);
	await tick();
	assert.deepEqual(h.interrupts, [true, undefined]);
	h.child.close();
});

test("shutdown runs the owner's abort work, then EOF, SIGTERM and SIGKILL, and never fakes closure", async () => {
	const order: string[] = [];
	const h = harness({}, { beforeEof: async () => { order.push("beforeEof"); } });
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const done = h.transport.shutdown();
	await sleep(70);
	assert.deepEqual(order, ["beforeEof"]);
	assert.equal(h.child.eof, true);
	assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
	await sleep(60); // Past the pipe-drain deadline: no exit proof, so no closure.
	assert.equal(h.transport.isClosed(), false);
	assert.equal(h.transport.processAlive, true);
	assert.equal(h.child.stdout.destroyed, false);
	assert.deepEqual(h.closes, []);
	h.child.close(null, "SIGKILL"); await done;
	assert.equal(h.transport.isClosed(), true);
	assert.deepEqual(h.closes, [[null, "SIGKILL"]]);
	assert.equal(h.transport.processAlive, false);
	// A second shutdown after closure is a no-op.
	await h.transport.shutdown();
	assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a proven leader exit drains inherited pipes after escalation, then releases the handles", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const done = h.transport.shutdown();
	await sleep(70);
	assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
	h.child.stdout.write(JSON.stringify({ type: "result", result: "last words" }) + "\n");
	h.child.emit("exit", null, "SIGKILL");
	await sleep(60);
	assert.equal(h.child.stdout.destroyed, true, "handles are released only after proven exit");
	assert.equal(h.events.at(-1)!.type, "result", "output written before the drain is not lost");
	h.child.close(null, "SIGKILL"); await done;
});

test("leader exit starts shutdown by itself and tells the owner before escalation", async () => {
	const seen: string[] = [];
	const h = harness({ onLeaderExit: () => seen.push("leaderExit"), onActivity: () => seen.push("activity") });
	h.transport.launch("claude", [], { cwd: "/tmp" });
	h.child.emit("exit", 0, null);
	await tick();
	assert.deepEqual(seen, ["leaderExit", "activity"]);
	assert.equal(h.transport.processAlive, false);
	assert.equal(h.child.eof, true, "EOF still follows, without the owner's abort work");
	h.child.close(0, null);
});

test("closure resolves pending controls as unanswered and settles whenClosed after the owner's close hook", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const pending = h.transport.control("initialize");
	void h.transport.whenClosed.then(() => h.order.push("whenClosed"));
	h.child.close(0, null);
	assert.equal(await pending, undefined);
	await h.transport.whenClosed;
	await tick();
	assert.deepEqual(h.order, ["onClose", "whenClosed"]);
	assert.deepEqual(h.closes, [[0, null]]);
	h.child.close(1, null);
	assert.deepEqual(h.closes, [[0, null]], "close is announced exactly once");
});

test("bounded work loses its deadline to process closure and never outlives the transport", async () => {
	const h = harness();
	h.transport.launch("claude", [], { cwd: "/tmp" });
	const never = new Promise<string>(() => {});
	const timed = h.transport.bounded(never, 20, "fallback");
	assert.equal(await timed, "fallback");
	const atClose = h.transport.bounded(never, 60000, "fallback");
	h.child.close(0, null);
	assert.equal(await atClose, "fallback", "closure settles a bounded wait immediately");
});

test("shutdown without a process closes straight away", async () => {
	const h = harness();
	await h.transport.shutdown();
	assert.deepEqual(h.closes, [[null, null]]);
	assert.equal(h.transport.isClosed(), true);
});
