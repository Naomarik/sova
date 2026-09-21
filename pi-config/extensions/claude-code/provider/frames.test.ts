/** The validation boundary: what the adapter accepts, ignores, and refuses. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProtocolError, parseClaudeFrame, PI_MCP_TOOL_PREFIX, toPiToolName } from "./types.ts";
import { Type, type Tool } from "@earendil-works/pi-ai";

const tools: Tool[] = [{ name: "read", description: "", parameters: Type.Object({}) }];

test("init, usage and terminal frames are normalized", () => {
	assert.deepEqual(parseClaudeFrame({ type: "system", subtype: "init", session_id: "s1" }), { type: "init", sessionId: "s1" });
	assert.deepEqual(
		parseClaudeFrame({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } } }),
		{ type: "stream", event: { type: "message_start", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } } },
	);
	assert.deepEqual(parseClaudeFrame({ type: "result", subtype: "success", is_error: false }), { type: "result", outcome: "success", message: undefined, usage: undefined });
	assert.deepEqual(parseClaudeFrame({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }), {
		type: "result", outcome: "error", message: "boom", usage: undefined,
	});
	// Every aborted* terminal reason is a cancellation, not a failure.
	for (const reason of ["aborted_tools", "aborted_streaming"]) {
		const frame = parseClaudeFrame({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: reason });
		assert.equal(frame?.type === "result" && frame.outcome, "aborted");
	}
});

test("frames this layer does not consume are ignored, not rejected", () => {
	assert.equal(parseClaudeFrame({ type: "user", isReplay: true, uuid: "u" }), undefined);
	assert.equal(parseClaudeFrame({ type: "control_request", request_id: "r" }), undefined);
	assert.equal(parseClaudeFrame({ type: "system", subtype: "compact_boundary" }), undefined);
	assert.equal(parseClaudeFrame({ type: "stream_event", event: { type: "ping" } }), undefined);
});

test("a missing content index defaults to the first block", () => {
	const frame = parseClaudeFrame({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
	assert.deepEqual(frame, { type: "stream", event: { type: "content_block_delta", index: 0, delta: { kind: "text", text: "hi" } } });
});

test("corrupt frames throw instead of being smoothed over", () => {
	assert.throws(() => parseClaudeFrame("not a frame"), ClaudeProtocolError);
	assert.throws(() => parseClaudeFrame({ type: "assistant" }), ClaudeProtocolError);
	assert.throws(() => parseClaudeFrame({ type: "assistant", message: { content: "text" } }), ClaudeProtocolError);
	assert.throws(
		() => parseClaudeFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "x" } } }),
		ClaudeProtocolError,
	);
	assert.throws(
		() => parseClaudeFrame({ type: "stream_event", event: { type: "content_block_delta", index: -1, delta: { type: "text_delta", text: "" } } }),
		ClaudeProtocolError,
	);
	assert.throws(
		() => parseClaudeFrame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "a", name: "b" } } }),
		ClaudeProtocolError,
	);
});

test("MCP facade names map back to pi tool names", () => {
	assert.equal(toPiToolName(`${PI_MCP_TOOL_PREFIX}read`, tools), "read");
	assert.equal(toPiToolName("mcp__pi__Read", tools), "read");
	// A native Claude tool name (facade bypassed) is passed through untouched.
	assert.equal(toPiToolName("Bash", tools), "Bash");
});
