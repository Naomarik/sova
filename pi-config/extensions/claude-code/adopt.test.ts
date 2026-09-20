/**
 * ClaudeRunner adopt mode (PI_WORKER_TRANSPORT=host re-adoption): the runner
 * is fed by a HostTransport replaying the worker's stdout. No socket, no CLI:
 * lines are delivered directly with their out.jsonl end offsets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { HostTransport } from "../subagents/host-transport.ts";
import { ClaudeRunner, type ClaudeSpawnOptions } from "./runner.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function adopted(lines: object[], historyLines: number, adopt: Partial<NonNullable<ClaudeSpawnOptions["adopt"]>> = {}, options: Partial<ClaudeSpawnOptions> = {}) {
	const encoded = lines.map((l) => JSON.stringify(l));
	let offset = 0;
	const ends = encoded.map((l) => (offset += Buffer.byteLength(l) + 1));
	const transport = new HostTransport(undefined, { historyEnd: historyLines ? ends[historyLines - 1] : 0 });
	const frames: any[] = [];
	transport.sendFrame = (frame) => { frames.push(frame); };
	const settled: { outcome?: string; output: string }[] = [];
	let spawned: { command: string; args: string[] } | undefined;
	const runner = new ClaudeRunner({
		id: "c1", groupId: "g1", name: "claude", task: "FIRST", cwd: "/tmp", tools: [],
		timings: { requestTimeoutMs: 1000, settlementTimeoutMs: 1000, abortGraceMs: 20, eofGraceMs: 20, termGraceMs: 20 },
		...options,
		adopt: { replaying: () => transport.replaying, sessionId: "session-1", ...adopt },
		spawnImpl: (command, args) => { spawned = { command, args }; return transport as unknown as ChildProcess; },
	}, {
		onChange() {},
		onSettled(r) { settled.push({ outcome: r.taskOutcome, output: r.finalOutput() }); },
		onExit() {},
	});
	const stdin = () => frames.filter((f) => f.type === "stdin").map((f) => JSON.parse(f.data));
	const replay = async () => {
		await tick();
		encoded.forEach((l, i) => transport.deliver(ends[i], l));
		transport.goLive();
		await tick();
	};
	return { runner, transport, settled, stdin, replay, get spawned() { return spawned; } };
}

const user = (uuid: string, text: string) => ({ type: "user", isReplay: true, uuid, session_id: "session-1", message: { role: "user", content: [{ type: "text", text }] } });
const result = (uuid: string, text: string) => ({ type: "result", subtype: "success", user_message_uuid: uuid, session_id: "session-1", result: text });
const permission = (id: string, tool = "Bash") => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input: {} } });

test("adopt: no argv/initialize/first prompt; history settles are silent; a new completion settles once; idle after replay", async (t) => {
	const f = adopted([
		{ type: "system", subtype: "init", session_id: "session-1", model: "claude-x" },
		user("u1", "FIRST"), result("u1", "ANSWER1"),
		user("u2", "STEER"), result("u2", "ANSWER2"),
	], 3);
	t.after(() => { void f.runner.dispose(); f.transport.finish(null, "SIGTERM"); });
	await f.replay();
	assert.deepEqual(f.spawned, { command: "", args: [] });
	assert.deepEqual(f.stdin(), [], "nothing is (re)sent to an adopted worker");
	assert.deepEqual(f.settled, [{ outcome: "success", output: "ANSWER2" }]);
	assert.equal(f.runner.status, "waiting");
	assert.equal(f.runner.sessionId, "session-1");
	assert.equal(f.runner.model, "claude-x");
	assert.deepEqual(f.runner.transcript.filter((i) => i.kind === "task" || i.kind === "steer").map((i) => [i.kind, i.text]), [["task", "FIRST"], ["steer", "STEER"]]);
	// Live steering works normally after adoption.
	const steer = f.runner.steer("NEXT");
	await tick();
	const sent = f.stdin().find((e) => e.type === "user");
	assert.equal(sent?.message.content[0].text, "NEXT");
	f.transport.deliver(1e9, JSON.stringify(user(sent.uuid, "NEXT")));
	assert.equal((await steer).ok, true);
});

test("adopt: a replayed permission nobody answered is prompted again once live; answered or cancelled ones are not", async (t) => {
	const asked: string[] = [];
	const f = adopted([
		user("u1", "FIRST"),
		permission("answered"), permission("cancelled"), permission("pending", "Write"),
		{ type: "control_cancel_request", request_id: "cancelled" },
	], 5, { sent: [JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "answered", response: { behavior: "allow" } } }), "not json"] }, {
		permissionMode: "acceptEdits",
		onPermission: async (request) => { asked.push(request.requestId); return { behavior: "allow" }; },
	});
	t.after(() => { void f.runner.dispose(); f.transport.finish(null, "SIGTERM"); });
	await f.replay();
	await tick();
	assert.deepEqual(asked, ["pending"]);
	const replies = f.stdin().filter((e) => e.type === "control_response").map((e) => [e.response.request_id, e.response.response.behavior]);
	assert.deepEqual(replies, [["pending", "allow"]]);
	assert.equal(f.runner.status, "running", "the task is still in flight");
});

test("adopt of a dead host: permissions are never prompted and the unfinished task ends in error", async () => {
	const asked: string[] = [];
	const f = adopted([user("u1", "FIRST"), permission("p1")], 0, { ended: true }, {
		permissionMode: "acceptEdits",
		onPermission: async (request) => { asked.push(request.requestId); return { behavior: "allow" }; },
	});
	await f.replay();
	f.transport.finish(null, "SIGKILL");
	await f.runner.whenClosed;
	assert.deepEqual(asked, []);
	assert.deepEqual(f.stdin(), []);
	assert.equal(f.runner.status, "error");
	assert.deepEqual(f.settled.map((s) => s.outcome), ["error"], "the ending is new: reported once");
});

// Same reduction as runner.test.ts: a settled task followed by a turn the CLI
// started itself. Nothing in history is re-announced; a live one is.
const backgroundRun = [
	{ type: "system", subtype: "init", session_id: "session-1", model: "claude-x" },
	user("u1", "FIRST"), result("u1", "running in the background…"),
	{ type: "system", subtype: "init", session_id: "session-1", model: "claude-x" },
	{ type: "assistant", session_id: "session-1", message: { role: "assistant", content: [{ type: "text", text: "done: 24 ticks" }] } },
	{ type: "result", subtype: "success", session_id: "session-1", user_message_uuid: null, user_message_uuids: [], result: "done: 24 ticks" },
];

test("adopt: a fully historical CLI-initiated turn announces nothing but is the worker's answer", async (t) => {
	const f = adopted(backgroundRun, 6);
	t.after(() => { void f.runner.dispose(); f.transport.finish(null, "SIGTERM"); });
	await f.replay();
	assert.deepEqual(f.settled, [], "the earlier manager already announced it");
	assert.equal(f.runner.finalOutput(), "done: 24 ticks");
	assert.equal(f.runner.status, "waiting");
	assert.deepEqual(f.runner.transcript.filter((i) => i.kind === "assistant").map((i) => i.text), ["running in the background…", "done: 24 ticks"]);
});

test("adopt: a CLI-initiated turn past the consumed offset is announced exactly once", async (t) => {
	const f = adopted(backgroundRun, 3);
	t.after(() => { void f.runner.dispose(); f.transport.finish(null, "SIGTERM"); });
	await f.replay();
	assert.deepEqual(f.settled, [{ outcome: "success", output: "done: 24 ticks" }]);
	assert.equal(f.runner.finalOutput(), "done: 24 ticks");
	assert.equal(f.runner.status, "waiting");
	assert.deepEqual(f.stdin(), [], "nothing is (re)sent to an adopted worker");
	assert.deepEqual(f.runner.transcript.filter((i) => i.kind === "assistant").map((i) => i.text), ["running in the background…", "done: 24 ticks"]);
});
