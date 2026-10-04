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

test("requesting counts before the first token; message_stop ends it; tool time counts nothing", () => {
	const o = createClaudeRequestObserver();
	o.frame({ type: "system", subtype: "init", session_id: "s" });
	assert.deepEqual(counts(), idle, "init is no request");
	o.frame(requesting());
	assert.deepEqual(counts(), { ...idle, active: 1, claudeTurns: 1 }, "requesting: in flight before any response frame");
	o.frame(stream("message_start"));
	o.frame(stream("content_block_start"));
	o.frame(assistant(null, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]));
	assert.equal(snapshot().active, 1, "block echoes change nothing");
	o.frame(stream("message_delta"));
	o.frame(stream("message_stop"));
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 }, "tool_use reply over: the tool runs, no call in flight, the turn still runs");
	o.frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
	assert.equal(snapshot().active, 0);
	o.frame(requesting());
	assert.equal(snapshot().active, 1, "the next request");
	o.frame(stream("message_start"));
	o.frame(stream("message_stop"));
	o.frame(result);
	assert.deepEqual(counts(), idle);
	o.close();
});

test("a CLI-initiated turn with no active task still counts", () => {
	const o = createClaudeRequestObserver();
	o.frame(requesting());
	assert.equal(snapshot().active, 1);
	o.frame(result);
	assert.deepEqual(counts(), idle, "result ends the request and the turn");
	o.close();
});

test("an API error reply (no stream) ends the request; a retry's requesting replaces, never adds", () => {
	const o = createClaudeRequestObserver();
	o.frame(requesting());
	o.frame(requesting());
	assert.equal(snapshot().active, 1, "one lane, one request");
	o.frame({ ...assistant(), error: "rate_limit", isApiErrorMessage: true });
	assert.equal(snapshot().active, 0);
	o.frame(result);
	o.close();
	assert.deepEqual(counts(), idle);
});

test("a response with no requesting before it (an older CLI) counts from message_start, approximate and degraded", () => {
	const o = createClaudeRequestObserver();
	o.frame(stream("message_start"));
	assert.deepEqual(counts(), { active: 1, approximate: 1, claudeTurns: 1, degraded: true });
	o.frame(stream("message_stop"));
	o.frame(result);
	assert.equal(snapshot().active, 0);
	assert.equal(snapshot().degraded, true, "this process can't see pre-response time");
	o.close();
	assert.deepEqual(counts(), idle, "released with the process");
});

test("root and child lanes count apart; a child's echoes never close the root", () => {
	const o = createClaudeRequestObserver();
	o.frame(requesting());
	o.frame(stream("message_start"));
	o.frame(stream("message_start", "toolu_A"));
	o.frame(stream("message_start", "toolu_B"));
	assert.equal(snapshot().active, 3);
	o.frame(assistant("toolu_A"));
	o.frame(stream("message_stop", "toolu_A"));
	assert.equal(snapshot().active, 2);
	o.frame(stream("message_stop"));
	assert.equal(snapshot().active, 1, "the root ended; child B still streams");
	o.close();
	assert.deepEqual(counts(), idle, "close ends everything");
});

test("process close mid-request ends the call and the turn; frames after close change nothing", () => {
	const o = createClaudeRequestObserver();
	o.frame(requesting());
	o.close();
	o.close();
	o.frame(requesting());
	assert.deepEqual(counts(), idle);
});

test("replay rebuilds state only; activate counts what is still open, from now", () => {
	const o = createClaudeRequestObserver({ active: false });
	o.frame(requesting());
	o.frame(stream("message_start"));
	o.frame(stream("message_stop"));
	o.frame(result);
	o.frame(requesting());
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 }, "history never counts a call; until live, a running turn is assumed (partial)");
	o.activate();
	assert.deepEqual(counts(), { ...idle, active: 1, claudeTurns: 1 }, "the request open at adoption counts once live");
	o.activate();
	assert.equal(snapshot().active, 1, "activate is idempotent");
	o.frame(stream("message_stop"));
	o.frame(result);
	o.close();
	assert.deepEqual(counts(), idle);
});

test("an adopted worker that turns out idle, or whose host dies before going live, leaves nothing", () => {
	const idleWorker = createClaudeRequestObserver({ active: false });
	assert.equal(snapshot().claudeTurns, 1);
	idleWorker.frame(requesting());
	idleWorker.frame(result);
	idleWorker.activate();
	assert.deepEqual(counts(), idle);
	idleWorker.close();
	const dead = createClaudeRequestObserver({ active: false });
	dead.frame(requesting());
	dead.close();
	assert.deepEqual(counts(), idle);
});

test("a bridge observer (countRequests: false) reports its running turn and never a call", () => {
	const o = createClaudeRequestObserver({ countRequests: false });
	o.frame(requesting());
	o.frame(stream("message_start"));
	assert.deepEqual(counts(), { ...idle, claudeTurns: 1 });
	o.frame(stream("message_stop"));
	o.frame(result);
	assert.deepEqual(counts(), idle);
	o.close();
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

test("tokens: a reply's output tokens (thinking included, never input or cache) land at its message_stop", () => {
	const o = createClaudeRequestObserver();
	const before = tokens();
	o.frame(requesting());
	o.frame(ev({ type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 50_000, output_tokens: 1 } } }));
	o.frame(ev({ type: "message_delta", usage: { output_tokens: 120 } }));
	o.frame(ev({ type: "message_delta", usage: { input_tokens: 900, cache_creation_input_tokens: 77, output_tokens: 310 } }));
	assert.equal(tokens(), before, "nothing before the reply ends");
	o.frame(ev({ type: "message_stop" }));
	assert.equal(tokens() - before, 310, "the reply's last output_tokens, once");
	// A reply with no stream (an API error, a non-streamed reply): its assistant usage.
	o.frame(requesting());
	o.frame({ type: "assistant", message: { content: [], usage: { input_tokens: 5, output_tokens: 9 } }, parent_tool_use_id: null, session_id: "s" });
	assert.equal(tokens() - before, 319);
	o.frame(result);
	o.close();
});

test("tokens: the bridge (countRequests: false) counts none: the pi runtime counts that call", () => {
	const o = createClaudeRequestObserver({ countRequests: false });
	const before = tokens();
	o.frame(requesting());
	o.frame(ev({ type: "message_start", message: { usage: { output_tokens: 1 } } }));
	o.frame(ev({ type: "message_delta", usage: { output_tokens: 500 } }));
	o.frame(ev({ type: "message_stop" }));
	o.frame(result);
	o.close();
	assert.equal(tokens(), before);
});
