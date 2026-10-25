// Claude Code stream-json sequences (shapes as CLI 2.1.286 writes them with
// --include-partial-messages; `system/status "requesting"` comes from its stream_request_start).
import assert from "node:assert/strict";
import test from "node:test";
import { beginClaudeOneShot, createClaudeRequestObserver } from "./claude.ts";
import { snapshot } from "./tracker.ts";

const counts = () => {
	const { active, approximate, claudeTurns, degraded } = snapshot();
	return { active, approximate, claudeTurns, degraded };
};
const idle = { active: 0, approximate: 0, claudeTurns: 0, degraded: false };
const requesting = (extra = {}) => ({ type: "system", subtype: "status", status: "requesting", uuid: "u", session_id: "s", ...extra });
const stream = (type: string, parent: string | null = null) => ({ type: "stream_event", event: { type }, parent_tool_use_id: parent, session_id: "s" });
const assistant = (parent: string | null = null, content: unknown[] = [{ type: "text", text: "hi" }]) => ({ type: "assistant", message: { content }, parent_tool_use_id: parent, session_id: "s" });
const result = { type: "result", subtype: "success", is_error: false, session_id: "s" };

test("a bridge's running turn is reported from requesting to result, and never a call (the pi runtime counts those)", () => {
	const o = createClaudeRequestObserver();
	o.frame({ type: "system", subtype: "init", session_id: "s" });
	assert.deepEqual(counts(), idle, "init is no turn");
	o.frame(requesting());
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 });
	o.frame(stream("message_start"));
	o.frame(assistant(null, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]));
	o.frame(stream("message_stop"));
	o.frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
	o.frame(requesting());
	o.frame(stream("message_start", "toolu_A"));
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 }, "one turn however many requests and lanes");
	o.frame(stream("message_stop"));
	o.frame(result);
	assert.deepEqual(counts(), idle);
	o.close();
});

test("a reply with no requesting before it (an older CLI) still opens the turn", () => {
	const o = createClaudeRequestObserver();
	o.frame(stream("message_start"));
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 });
	o.frame(result);
	assert.deepEqual(counts(), idle);
	o.close();
});

test("process close mid-turn ends the turn; frames after close change nothing", () => {
	const o = createClaudeRequestObserver();
	o.frame(requesting());
	o.close();
	o.close();
	o.frame(requesting());
	assert.deepEqual(counts(), idle);
});

test("garbage frames are ignored", () => {
	const o = createClaudeRequestObserver();
	for (const f of [null, 1, "x", [], { type: "stream_event" }, { type: "system", subtype: "status", status: "compacting" }, { type: "system", subtype: "status", status: null }]) o.frame(f);
	assert.deepEqual(counts(), idle, "compacting status is no proof of a request");
	o.close();
});

test("a one-shot is approximate and its end idempotent", () => {
	const end = beginClaudeOneShot();
	assert.deepEqual(counts(), { ...idle, active: 1, approximate: 1 });
	end();
	end();
	assert.deepEqual(counts(), idle);
});

const tokens = () => snapshot().tokens.out.reduce((a, b) => a + b, 0);
const ev = (event: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "s" });

test("tokens: the bridge counts none: the pi runtime counts that call", () => {
	const o = createClaudeRequestObserver();
	const before = tokens();
	o.frame(requesting());
	o.frame(ev({ type: "message_start", message: { usage: { output_tokens: 1 } } }));
	o.frame(ev({ type: "message_delta", usage: { output_tokens: 500 } }));
	o.frame(ev({ type: "message_stop" }));
	o.frame(result);
	o.close();
	assert.equal(tokens(), before);
});
