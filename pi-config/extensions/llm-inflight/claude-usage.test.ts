// What a Claude Code CLI spent, from its stream-json frames (shapes as CLI 2.1.286 writes them with
// --include-partial-messages): one call per message id, merged by max; a residual per result
// against the session's persisted cumulative total, so a resume or a replay never counts twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeUsageCollector, fileBaselineStore, type ClaudeCallUsage, type ClaudeResidualUsage } from "./claude-usage.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-ccu-"));
const F = "claude-fable-5-1";
const S = "0a10b9a8-65a9-4aa5-916e-c4739d9b06f0";
const usage = (i: number, o: number, cr = 0, cw = 0, cw1h = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: cw - cw1h } });
const ev = (event: object, parent: string | null = null) => ({ type: "stream_event", event, session_id: S, parent_tool_use_id: parent });
const start = (id: string, u: object, parent: string | null = null) => ev({ type: "message_start", message: { id, model: "claude-fable-5-1", usage: u } }, parent);
const delta = (u: object, stop = "tool_use", parent: string | null = null) => ev({ type: "message_delta", delta: { stop_reason: stop }, usage: u }, parent);
const stop = (parent: string | null = null) => ev({ type: "message_stop" }, parent);
const assistant = (id: string, u: object, parent: string | null = null) => ({ type: "assistant", message: { id, model: "claude-fable-5-1", usage: u, content: [] }, session_id: S, parent_tool_use_id: parent });
const requesting = { type: "system", subtype: "status", status: "requesting", session_id: S };
const result = (models: Record<string, [number, number, number, number]>) => ({
	type: "result", subtype: "success", session_id: S,
	modelUsage: Object.fromEntries(Object.entries(models).map(([m, [i, o, cr, cw]]) => [m, { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw }])),
});

function collect(dir: string, fresh: boolean) {
	const calls: ClaudeCallUsage[] = [];
	const residuals: ClaudeResidualUsage[] = [];
	const c = createClaudeUsageCollector({ fresh, baseline: fileBaselineStore(dir), sink: { call: (u) => calls.push(u), residual: (r) => residuals.push(r) }, now: () => 1000 });
	return { c, calls, residuals };
}

test("one call per message id: start, delta and assistant echoes merge by the max per field, never summed", () => {
	const { c, calls, residuals } = collect(tmp(), true);
	c.frame({ type: "system", subtype: "init", session_id: S });
	c.frame(requesting);
	c.frame(start("msg_1", usage(2, 2, 0, 13605, 13605)));
	c.frame(assistant("msg_1", usage(2, 40, 0, 13605, 13605)));
	c.frame(assistant("msg_1", usage(2, 40, 0, 13605, 13605)));
	c.frame(delta(usage(2, 296, 0, 13605)));
	c.frame(stop());
	assert.equal(calls.length, 0, "an echo may still come: recorded at the next request");
	c.frame(requesting);
	assert.deepEqual(calls, [{ id: "msg_1", model: "claude-fable-5-1", lane: "", claudeSession: S, stop: "tool_use", at: 1000, tokens: { i: 2, o: 296, cr: 0, cw: 13605, cw1h: 13605 } }]);
	c.frame(start("msg_2", usage(1, 1, 13605, 50)));
	c.frame(delta(usage(1, 20, 13605, 50), "end_turn"));
	c.frame(stop());
	c.frame(result({ "claude-fable-5-1": [3, 316, 13605, 13655] }));
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1]!.tokens, { i: 1, o: 20, cr: 13605, cw: 50, cw1h: 0 });
	assert.deepEqual(residuals, [], "the streamed messages are the whole spend");
	c.close();
});

test("the result's cumulative totals beyond the streamed messages are one residual per model; a negative clamps to 0", () => {
	const { c, calls, residuals } = collect(tmp(), true);
	c.frame({ type: "system", subtype: "init", session_id: S });
	c.frame(start("msg_1", usage(10, 5, 100, 0)));
	c.frame(stop());
	// The CLI's own subagent (no stream) used haiku; its fable output was reported a little lower.
	c.frame(result({ "claude-fable-5-1": [10, 4, 300, 0], "claude-haiku-4-5": [50, 7, 0, 20] }));
	assert.equal(calls.length, 1);
	assert.deepEqual(
		residuals.map((r) => [r.model, r.tokens, r.total]),
		[
			["claude-fable-5-1", { i: 0, o: 0, cr: 200, cw: 0, cw1h: 0 }, 391],
			["claude-haiku-4-5", { i: 50, o: 7, cr: 0, cw: 20, cw1h: 0 }, 391],
		],
	);
	c.close();
});

test("a nested (Task subagent) lane is its own message; nothing is dropped when a lane is cut at close", () => {
	const { c, calls } = collect(tmp(), true);
	c.frame(start("msg_root", usage(5, 1)));
	c.frame(start("msg_sub", usage(7, 1), "toolu_A"));
	c.frame(delta(usage(7, 9), "end_turn", "toolu_A"));
	c.frame(delta(usage(5, 3)));
	c.close();
	assert.deepEqual(calls.map((u) => [u.id, u.lane, u.tokens.i, u.tokens.o]).sort(), [["msg_root", "", 5, 3], ["msg_sub", "toolu_A", 7, 9]]);
});

test("the baseline persists: a resumed session's history is never counted again, and a resume with no baseline only establishes it", () => {
	const dir = tmp();
	const one = collect(dir, true);
	one.c.frame({ type: "system", subtype: "init", session_id: S });
	one.c.frame(start("msg_1", usage(10, 10)));
	one.c.frame(result({ [F]: [10, 10, 0, 0] }));
	one.c.close();
	assert.deepEqual(one.residuals, []);
	// A failover or restart resumes the same Claude session: cumulative includes the history.
	const two = collect(dir, false);
	two.c.frame(start("msg_2", usage(4, 1)));
	two.c.frame(result({ [F]: [14, 11, 0, 0], h: [0, 0, 0, 0] }));
	two.c.frame(start("msg_3", usage(1, 1)));
	two.c.frame(result({ [F]: [20, 12, 0, 0] }));
	assert.deepEqual(two.calls.map((u) => u.id), ["msg_2", "msg_3"]);
	assert.deepEqual(two.residuals.map((r) => [r.model, r.tokens.i, r.tokens.o]), [["claude-fable-5-1", 5, 0]], "only what no message showed, since the last total");
	// A session from before the ledger, resumed: its first result is history.
	const other = collect(tmp(), false);
	other.c.frame(start("msg_9", usage(3, 3)));
	other.c.frame(result({ [F]: [5000, 900, 0, 0] }));
	other.c.frame(start("msg_10", usage(2, 2)));
	other.c.frame(result({ [F]: [5003, 902, 0, 0] }));
	assert.deepEqual(other.residuals.map((r) => [r.tokens.i, r.tokens.o]), [[1, 0]]);
});

test("a re-adopted worker's replay adds nothing: old results sit at or under the persisted total", () => {
	const dir = tmp();
	const frames = [
		{ type: "system", subtype: "init", session_id: S },
		start("msg_1", usage(10, 2)),
		result({ [F]: [12, 2, 0, 0] }),
		start("msg_2", usage(5, 5)),
		result({ [F]: [17, 7, 0, 0] }),
	];
	const live = collect(dir, true);
	for (const f of frames) live.c.frame(f);
	live.c.close();
	assert.deepEqual(live.residuals.map((r) => [r.tokens.i, r.tokens.o]), [[2, 0]]);
	// The manager restarted; the host kept the CLI running, which did one more turn meanwhile.
	const replay = collect(dir, false);
	for (const f of [...frames, start("msg_3", usage(1, 1)), result({ [F]: [20, 8, 0, 0] })]) replay.c.frame(f);
	assert.deepEqual(replay.residuals.map((r) => [r.tokens.i, r.tokens.o]), [[2, 0]], "only the turn the old manager never saw");
	assert.deepEqual(replay.calls.map((u) => u.id), ["msg_1", "msg_2", "msg_3"], "replayed messages repeat their keys (the reader dedups)");
});

test("a synthetic failure reply and a result without modelUsage record nothing", () => {
	const { c, calls, residuals } = collect(tmp(), true);
	c.frame({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }, session_id: S });
	c.frame({ type: "result", subtype: "success", is_error: true, usage: { input_tokens: 0, output_tokens: 0 } });
	c.close();
	assert.deepEqual([calls, residuals], [[], []]);
});
