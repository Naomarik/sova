import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { ClaudeRunner, type ClaudeSpawnOptions, type ClaudePermissionDecision } from "./runner.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new PassThrough();
	stderr = new PassThrough();
	writes: any[] = [];
	signals: string[] = [];
	eof = false;
	onWrite?: (event: any) => void;
	stdin = new Writable({
		write: (chunk, _encoding, callback) => {
			const event = JSON.parse(String(chunk)); this.writes.push(event); this.onWrite?.(event); callback();
		},
		final: (callback) => { this.eof = true; callback(); },
	});
	kill(signal: string) { this.signals.push(signal); return true; }
	out(event: any) { this.stdout.write(JSON.stringify(event) + "\n"); }
	ack(request: any = this.writes.find((e) => e.request?.subtype === "initialize")) {
		this.out({ type: "control_response", response: { request_id: request.request_id, subtype: "success", response: { account: "PRIVATE" } } });
	}
	users() { return this.writes.filter((e) => e.type === "user"); }
	replay(user = this.users().at(-1)) { this.out({ type: "user", isReplay: true, uuid: user.uuid, session_id: "session-1" }); }
	result(user = this.users().at(-1), extra: Record<string, unknown> = {}) {
		this.out({ type: "result", subtype: "success", user_message_uuid: user.uuid, session_id: "session-1", result: "ANSWER", ...extra });
	}
	close(code: number | null = 0, signal: string | null = null) { this.emit("close", code, signal); }
}
function fixture(options: Partial<ClaudeSpawnOptions> = {}) {
	const child = new FakeChild();
	const settled: { outcome: string | undefined; output: string; isSettled: boolean }[] = [];
	let exits = 0; let argv: string[] = []; let spawnOptions: any;
	const runner = new ClaudeRunner({
		id: "c1", groupId: "g1", name: "claude", task: "FIRST", cwd: "/tmp", tools: [],
		timings: { requestTimeoutMs: 1000, settlementTimeoutMs: 1000, abortGraceMs: 20, eofGraceMs: 20, termGraceMs: 20 },
		...options,
		signalGroupImpl: (_pid, signal) => { child.kill(signal); },
		spawnImpl: (_command, args, opts) => { argv = args; spawnOptions = opts; return child as unknown as ChildProcess; },
	}, {
		onChange() {},
		onSettled(r) { settled.push({ outcome: r.taskOutcome, output: r.finalOutput(), isSettled: r.isSettled() }); },
		onExit() { exits++; },
	});
	return { runner, child, settled, get exits() { return exits; }, get argv() { return argv; }, get spawnOptions() { return spawnOptions; } };
}
async function ready(f: ReturnType<typeof fixture>) { await tick(); f.child.ack(); await tick(); f.child.replay(); }
function cleanup(t: any, f: ReturnType<typeof fixture>) { t.after(() => { void f.runner.dispose(); f.child.close(); }); }

test("direct persistent launch defaults to bypass, initialize gates input and private metadata is not exposed", async (t) => {
	const f = fixture(); cleanup(t, f);
	await tick(); assert.equal(f.child.users().length, 0);
	assert.equal(f.argv[f.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
	assert.equal(f.argv[f.argv.indexOf("--permission-prompts") + 1], "none");
	assert.equal(f.argv[f.argv.indexOf("--tools") + 1], "");
	assert.equal(f.argv[f.argv.indexOf("--setting-sources") + 1], "");
	assert.ok(f.argv.includes("--strict-mcp-config"));
	assert.ok(!f.argv.some((s) => /dangerously|safe-mode/.test(s)));
	assert.equal(f.spawnOptions.shell, false);
	assert.equal(f.spawnOptions.detached, process.platform !== "win32");
	assert.equal(f.spawnOptions.env.CLAUDECODE, undefined);
	assert.equal(f.spawnOptions.env.CLAUDE_CODE_ENTRYPOINT, undefined);
	f.child.ack(); await tick(); f.child.replay();
	assert.equal(f.runner.status, "running"); f.child.result();
	assert.equal(f.runner.status, "waiting"); assert.equal(f.runner.processAlive, true);
	assert.equal(f.runner.isFinished(), false); assert.equal(f.runner.isSettled(), true);
	assert.equal(f.runner.sessionId, "session-1"); assert.equal(f.settled.length, 1);
	assert.ok(!JSON.stringify(f.runner.transcript).includes("PRIVATE"));
});

for (const permissionMode of [undefined, "bypassPermissions", "acceptEdits", "manual", "dontAsk", "plan"] as const) {
	for (const withHost of [false, true]) test(`permission mode ${permissionMode ?? "default"} is preserved (host=${withHost})`, async (t) => {
		const f = fixture({ permissionMode, onPermission: withHost ? async () => ({ behavior: "deny", message: "Denied" }) : undefined });
		cleanup(t, f); await ready(f);
		assert.equal(f.argv[f.argv.indexOf("--permission-mode") + 1], permissionMode ?? "bypassPermissions");
		const host = withHost && permissionMode !== undefined && permissionMode !== "bypassPermissions";
		assert.equal(f.argv[f.argv.indexOf("--permission-prompts") + 1], host ? "host" : "none");
		assert.equal(f.argv.includes("--permission-prompt-tool"), host);
	});
}

test("correlation ignores stale replay/results and duplicate results, supports UUID array", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.result({ uuid: "wrong" }); assert.equal(f.settled.length, 0);
	const first = f.child.users()[0];
	f.child.result(first, { user_message_uuid: undefined, user_message_uuids: [first.uuid] });
	f.child.result(first); assert.equal(f.settled.length, 1);
	const steer = f.runner.steer("SECOND"); await tick();
	assert.equal(f.runner.finalOutput(), "");
	f.child.replay(first); f.child.result(first); assert.equal(f.runner.status, "running");
	f.child.replay(); assert.deepEqual(await steer, { ok: true });
	f.child.result(undefined, { result: "SECOND ANSWER" });
	assert.equal(f.runner.finalOutput(), "SECOND ANSWER"); assert.equal(f.settled.length, 2);
});

test("session-scoped failure result without user UUIDs fails the active task closed", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	assert.deepEqual(await f.runner.followUp("QUEUED"), { ok: true });
	f.child.out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "session-1", errors: ["worker crashed"] });
	await tick();
	assert.equal(f.runner.status, "error"); assert.match(f.runner.error ?? "", /without task correlation: worker crashed/);
	assert.ok(f.child.writes.some((e) => e.request?.subtype === "interrupt"));
	assert.ok(f.runner.transcript.some((i) => /Dropped 1 queued follow-up/.test(i.text)));
	assert.equal(f.runner.isStopping(), true, "fail-closed teardown is advertised");
	f.child.close(1); await f.runner.whenClosed;
	assert.equal(f.runner.isStopping(), false);
	assert.equal(f.runner.taskOutcome, "error"); assert.equal(f.settled.length, 1);
	assert.equal(f.child.users().length, 1);
});

test("uncorrelated session failure reports API error text carried with a success subtype", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.out({ type: "result", subtype: "success", is_error: true, session_id: "session-1", result: "API Error: 529 overloaded_error" });
	await tick();
	assert.equal(f.runner.status, "error");
	assert.equal(f.runner.error, "Claude session failed without task correlation: API Error: 529 overloaded_error");
});

test("uncorrelated success and mismatched failure results never settle the active task", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const base = { type: "result", session_id: "session-1" };
	f.child.out({ ...base, subtype: "success", result: "NOT MINE" });
	f.child.out({ ...base, subtype: "success", result: "NOT MINE", user_message_uuids: [] });
	f.child.out({ ...base, subtype: "error_during_execution", is_error: true, user_message_uuid: "stale" });
	f.child.out({ ...base, subtype: "error_during_execution", is_error: true, user_message_uuids: ["other"] });
	await tick();
	assert.equal(f.runner.status, "running"); assert.equal(f.settled.length, 0); assert.equal(f.runner.error, undefined);
	f.child.result(); await tick();
	assert.equal(f.runner.taskOutcome, "success"); assert.equal(f.runner.finalOutput(), "ANSWER");
	assert.ok(!f.runner.transcript.some((i) => i.text.includes("NOT MINE")));
});

for (const order of ["ack-first", "result-first"]) test(`redirect requires interrupt acknowledgment AND settlement (${order})`, async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const first = f.child.users()[0];
	const steer = f.runner.steer("REPLACEMENT"); await tick();
	const interrupt = f.child.writes.find((e) => e.request?.subtype === "interrupt"); assert.ok(interrupt);
	if (order === "ack-first") f.child.ack(interrupt);
	else f.child.result(first, { is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_tools" });
	await tick(); assert.equal(f.child.users().length, 1); assert.equal(f.runner.isSettled(), false);
	if (order === "ack-first") f.child.result(first, { is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_tools" });
	else f.child.ack(interrupt);
	await tick(); assert.equal(f.child.users().length, 2); assert.equal(f.settled.length, 0);
	assert.equal(f.runner.finalOutput(), "");
	f.child.replay(); assert.deepEqual(await steer, { ok: true });
	f.child.result(); assert.equal(f.settled.length, 1); assert.equal(f.settled[0].outcome, "success");
	assert.equal(f.settled[0].isSettled, true);
});

for (const ack of [true, false]) for (const order of ["ack-first", "result-first"]) {
	for (const outcome of ["success", "error", "aborted"]) test(`redirect preserves actual result (${outcome}, ack=${ack}, ${order})`, async (t) => {
		const f = fixture(); cleanup(t, f); await ready(f);
		const first = f.child.users()[0];
		const steer = f.runner.steer("REPLACEMENT");
		const interrupt = f.child.writes.find((e) => e.request?.subtype === "interrupt");
		const respond = () => f.child.out({ type: "control_response", response: {
			request_id: interrupt.request_id, subtype: ack ? "success" : "error", error: ack ? undefined : "No active task",
		} });
		const settle = () => {
			f.child.result(first, outcome === "success" ? {} : {
				is_error: true, subtype: "error_during_execution", errors: ["original failure"],
				terminal_reason: outcome === "aborted" ? "aborted_tools" : undefined,
			});
			assert.equal(f.runner.taskOutcome, outcome, "interrupt intent must not replace actual result semantics");
		};
		if (order === "ack-first") respond(); else settle();
		await tick(); assert.equal(f.child.users().length, 1); assert.equal(f.runner.isSettled(), false);
		if (order === "ack-first") settle(); else respond();
		await tick(); assert.equal(f.child.users().length, 2); assert.equal(f.settled.length, 0);
		assert.equal(f.runner.processAlive, true); assert.equal(f.child.eof, false); assert.deepEqual(f.child.signals, []);
		if (outcome === "error") assert.ok(f.runner.transcript.some((i) => i.kind === "error" && i.text.includes("original failure")));
		f.child.replay(); assert.deepEqual(await steer, { ok: true });
		f.child.result(undefined, { result: "REPLACED" });
		assert.deepEqual(f.settled, [{ outcome: "success", output: "REPLACED", isSettled: true }]);
	});
}

for (const outcome of ["error", "aborted"]) test(`host queue stops on ${outcome}, reports predecessor and permits explicit recovery`, async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	await f.runner.followUp("NEVER SECOND"); await f.runner.followUp("NEVER THIRD");
	f.child.result(undefined, { is_error: true, subtype: "error_during_execution", errors: ["original failure"],
		terminal_reason: outcome === "aborted" ? "aborted_tools" : undefined, result: "PARTIAL" });
	await tick();
	assert.equal(f.child.users().length, 1); assert.equal(f.runner.taskOutcome, outcome);
	assert.deepEqual(f.settled, [{ outcome, output: "PARTIAL", isSettled: true }]);
	assert.equal(f.runner.error, outcome === "error" ? "original failure" : undefined);
	assert.ok(f.runner.transcript.some((i) => i.text === `Dropped 2 queued follow-up(s) after task ${outcome}`));
	assert.equal(f.runner.processAlive, true); assert.equal(f.runner.status, "waiting");
	const recovery = f.runner.steer("EXPLICIT RECOVERY"); f.child.replay(); assert.deepEqual(await recovery, { ok: true });
	f.child.result(); await tick();
	assert.equal(f.child.users().length, 2); assert.equal(f.runner.taskOutcome, "success");
	assert.equal(f.settled.length, 2);
	if (outcome === "error") assert.ok(f.runner.transcript.some((i) => i.kind === "error" && i.text.includes("original failure")));
});

test("host follow-up queue never injects mid-turn and is bounded", async (t) => {
	const f = fixture({ limits: { maxQueue: 1 } }); cleanup(t, f); await ready(f);
	assert.deepEqual(await f.runner.steer("SECOND", undefined, "followUp"), { ok: true });
	assert.equal((await f.runner.followUp("THIRD")).ok, false);
	assert.equal(f.child.users().length, 1);
	f.child.result(); assert.equal(f.settled.length, 0);
	await tick(); assert.equal(f.child.users().length, 2);
	f.child.replay(); f.child.result(undefined, { result: "SECOND" });
	assert.equal(f.runner.isSettled(), true); assert.equal(f.settled.length, 1);
});

test("failure in a queued task stops the remaining queue and wakes with the failure", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	await f.runner.followUp("SECOND"); await f.runner.followUp("NEVER THIRD");
	f.child.result(); await tick(); f.child.replay();
	assert.equal(f.child.users().length, 2); assert.equal(f.settled.length, 0);
	f.child.result(undefined, { is_error: true, subtype: "error_max_budget_usd", errors: ["Budget exceeded"], result: "" });
	await tick();
	assert.equal(f.child.users().length, 2); assert.equal(f.runner.error, "Budget exceeded");
	assert.deepEqual(f.settled, [{ outcome: "error", output: "", isSettled: true }]);
	assert.equal(f.runner.isStopping(), false, "recoverable task failure is not teardown");
});

test("API errors reported with success subtype surface the result text instead of the subtype", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.result(undefined, { is_error: true, subtype: "success", result: "API Error: 429 rate_limit_error" }); await tick();
	assert.equal(f.runner.error, "API Error: 429 rate_limit_error");
	assert.equal(f.settled[0]?.outcome, "error");
});

test("result error text prefers useful diagnostics and falls back when they are missing or empty", async (t) => {
	const cases: [Record<string, unknown>, string][] = [
		[{ errors: ["", "  ", 7, "real failure"], result: "API Error" }, "real failure"],
		[{ errors: [], result: "  API Error: overloaded  " }, "API Error: overloaded"],
		[{ errors: [""], result: "", terminal_reason: "max_turns" }, "Claude task ended: max_turns"],
		[{ subtype: "error_during_execution", result: "" }, "Claude task failed: error_during_execution"],
		[{ result: "" }, "Claude task failed"],
		[{ subtype: "", result: undefined, errors: null }, "Claude task failed"],
	];
	for (const [extra, expected] of cases) {
		const f = fixture(); cleanup(t, f); await ready(f);
		f.child.result(undefined, { is_error: true, subtype: "success", ...extra }); await tick();
		assert.equal(f.runner.error, expected, JSON.stringify(extra));
	}
	const f = fixture({ limits: { maxItemChars: 40 } }); cleanup(t, f); await ready(f);
	f.child.result(undefined, { is_error: true, result: "x".repeat(500) }); await tick();
	assert.ok((f.runner.error?.length ?? 0) <= 40); assert.match(f.runner.error ?? "", /truncated\]$/);
});

test("natural completion and negative interrupt response can arrive synchronously during interrupt write", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.onWrite = (e) => {
		if (e.request?.subtype !== "interrupt") return;
		f.child.result(); assert.equal(f.runner.taskOutcome, "success");
		f.child.out({ type: "control_response", response: { request_id: e.request_id, subtype: "error" } });
	};
	const steer = f.runner.steer("NEXT"); await tick();
	assert.equal(f.child.users().length, 2); assert.equal(f.child.eof, false);
	f.child.replay(); assert.deepEqual(await steer, { ok: true });
	f.child.result(); assert.equal(f.runner.taskOutcome, "success"); assert.equal(f.settled.length, 1);
});

test("synchronous replay/result during stdin write cannot lose accepted task", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f); f.child.result();
	f.child.onWrite = (e) => { if (e.type === "user") { f.child.replay(e); f.child.result(e, { result: "FAST" }); } };
	assert.deepEqual(await f.runner.steer("fast"), { ok: true });
	assert.equal(f.runner.status, "waiting"); assert.equal(f.runner.finalOutput(), "FAST");
	assert.equal(f.settled.length, 2);
});

test("permission host allow defaults original input and uses acceptEdits host/stdio", async (t) => {
	let request: any; let signal: AbortSignal | undefined;
	const f = fixture({ permissionMode: "acceptEdits", onPermission: async (r, s) => { request = r; signal = s; return { behavior: "allow" }; } });
	cleanup(t, f); await ready(f);
	assert.equal(f.argv[f.argv.indexOf("--permission-mode") + 1], "acceptEdits");
	assert.equal(f.argv[f.argv.indexOf("--permission-prompt-tool") + 1], "stdio");
	f.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, tool_use_id: "tool1" } });
	assert.equal(f.runner.isSettled(), false);
	assert.ok(f.runner.transcript.some((i) => i.text === "Permission pending: Bash"));
	await tick();
	assert.equal(request.toolUseId, "tool1");
	const reply = f.child.writes.find((e) => e.response?.request_id === "p1");
	assert.deepEqual(reply.response.response, { behavior: "allow", updatedInput: { command: "pwd" } });
	assert.equal(signal?.aborted, true);
});

test("host-managed permission deadlines exclude queue time", async (t) => {
	let decide!: (decision: ClaudePermissionDecision) => void; let signal!: AbortSignal;
	const f = fixture({ permissionTimeoutManagedByHost: true, timings: { permissionTimeoutMs: 10 },
		onPermission: (_request, s) => { signal = s; return new Promise((resolve) => { decide = resolve; }); } });
	cleanup(t, f); await ready(f);
	f.child.out({ type: "control_request", request_id: "queued", request: { subtype: "can_use_tool", tool_name: "Read", input: {} } });
	await sleep(40);
	assert.equal(signal.aborted, false);
	assert.equal(f.child.writes.some((e) => e.response?.request_id === "queued"), false);
	decide({ behavior: "allow" }); await tick();
	assert.equal(f.child.writes.find((e) => e.response?.request_id === "queued").response.response.behavior, "allow");
	assert.equal(signal.aborted, true);
});

test("permissions cancel on redirect and late allow cannot authorize stale work", async (t) => {
	let resolve!: (decision: ClaudePermissionDecision) => void; let permissionSignal!: AbortSignal;
	const f = fixture({ onPermission: (_r, s) => { permissionSignal = s; return new Promise((r) => { resolve = r; }); } });
	cleanup(t, f); await ready(f);
	f.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "x" } } });
	await tick(); const steer = f.runner.steer("STOP");
	assert.equal(permissionSignal.aborted, true);
	resolve({ behavior: "allow" }); await tick();
	const replies = f.child.writes.filter((e) => e.response?.request_id === "p1");
	assert.equal(replies.length, 1); assert.equal(replies[0].response.response.behavior, "deny");
	f.child.ack(f.child.writes.find((e) => e.request?.subtype === "interrupt")); f.child.result();
	await tick(); f.child.replay(); await steer;
});

test("permission timeout, thrown callback, no callback all deny; denials don't imply transport failure", async (t) => {
	for (const onPermission of [undefined, async () => { throw Error("bad"); }, () => new Promise<ClaudePermissionDecision>(() => {})]) {
		const f = fixture({ onPermission, timings: { ...{ requestTimeoutMs: 1000, settlementTimeoutMs: 1000, abortGraceMs: 20, eofGraceMs: 20, termGraceMs: 20 }, permissionTimeoutMs: 10 } });
		cleanup(t, f); await ready(f);
		f.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", input: {} } });
		await sleep(20);
		assert.equal(f.child.writes.find((e) => e.response?.request_id === "p1").response.response.behavior, "deny");
		f.child.result(undefined, { permission_denials: [{ tool_name: "Write", tool_use_id: "t1" }] });
		assert.equal(f.runner.taskOutcome, "success"); assert.equal(f.runner.permissionDenials.length, 1);
	}
});

test("shutdown interrupts before EOF; nonzero aborted-last-turn exit is successful cleanup", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const killed = f.runner.kill();
	assert.equal(f.runner.status, "stopping"); assert.equal(f.child.eof, false);
	assert.equal(f.child.writes.at(-1).request.subtype, "interrupt");
	f.child.ack(f.child.writes.at(-1)); f.child.result(undefined, { is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_tools" });
	await tick(); assert.equal(f.child.eof, true); assert.equal(f.settled.length, 0);
	f.child.close(1); await killed;
	assert.equal(f.runner.status, "killed"); assert.equal(f.runner.taskOutcome, "aborted");
	assert.equal(f.runner.isFinished(), true); assert.equal(f.exits, 1); assert.equal(f.settled.length, 1);
	f.child.close(1); assert.equal(f.exits, 1); assert.deepEqual(f.child.signals, []);
});

for (const exitAfterEscalation of [false, true]) test(`exit proof gates pipe drain, not settlement (late exit=${exitAfterEscalation})`, async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 1000, abortGraceMs: 10, eofGraceMs: 10, termGraceMs: 10, pipeDrainMs: 20 } });
	cleanup(t, f); await ready(f);
	if (exitAfterEscalation) { void f.runner.kill(); await sleep(60); }
	f.child.emit("exit", 1, null);
	assert.equal(f.runner.processAlive, false); assert.equal(f.runner.isFinished(), false);
	assert.equal(f.runner.isSettled(), false); assert.equal(f.settled.length, 0);
	assert.equal((await f.runner.steer("NEVER")).ok, false);
	await sleep(80);
	assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.stderr.destroyed, true);
	// Stream destruction is not itself synthetic process closure.
	assert.equal(f.runner.isFinished(), false); assert.equal(f.settled.length, 0);
	f.child.close(1); await f.runner.whenClosed;
	assert.equal(f.runner.status, exitAfterEscalation ? "killed" : "error");
	assert.equal(f.settled.length, 1); assert.equal(f.exits, 1);
});

test("shutdown escalates after bounded grace, and closure clears escalation", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const killed = f.runner.dispose(); await sleep(70);
	assert.equal(f.child.eof, true); assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]);
	await sleep(300); // Past pipe-drain deadline: no exit proof, so do not fake closure.
	assert.equal(f.runner.processAlive, true); assert.equal(f.runner.isFinished(), false);
	assert.equal(f.settled.length, 0); assert.equal(f.child.stdout.destroyed, false);
	f.child.close(null, "SIGKILL"); await killed;
	assert.equal(f.runner.isFinished(), true);
});

for (const detached of [false, true]) for (const forceKill of [false, true]) test(`shutdown drains inherited pipes (detached=${detached}, forced leader=${forceKill})`, { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const signals: string[] = []; let child: ChildProcess | undefined; let descendant: number | undefined;
	// The grandchild ignores TERM, retains stdout/stderr, and outlives the CLI
	// leader. Signaling only child.kill() cannot cause a close event here.
	const script = `
		const {spawn}=require('node:child_process');
		const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),10000)"],{detached:${detached},stdio:['ignore','inherit','inherit','ipc']});
		const ready=new Promise(r=>grandchild.once('message',()=>{process.send(grandchild.pid); r();}));
		const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
		let buffer='', user;
		process.stdin.on('data', chunk=>{buffer+=chunk; let n; while((n=buffer.indexOf('\\n'))>=0){const e=JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1); ready.then(()=>{
			if(e.type==='user'){user=e.uuid;send({type:'user',uuid:user,isReplay:true,session_id:'fake-session'});}
			if(e.type==='control_request'){send({type:'control_response',response:{request_id:e.request_id,subtype:'success'}});if(e.request.subtype==='interrupt')send({type:'result',user_message_uuid:user,subtype:'error_during_execution',is_error:true});}
		});}});
		if (${forceKill}) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
		process.stdin.on('end',()=>{if(!${forceKill})process.exit(1);});
	`;
	const settled: string[] = [];
	const runner = new ClaudeRunner({ id: "real-fake", groupId: "g", name: "fake", cwd: "/tmp", task: "wait", tools: [],
		timings: { requestTimeoutMs: 1000, abortGraceMs: 50, eofGraceMs: 30, termGraceMs: 30, pipeDrainMs: 30 },
		spawnImpl: (_command, _args, opts) => {
			child = spawn(process.execPath, ["-e", script], { ...opts, stdio: ["pipe", "pipe", "pipe", "ipc"] });
			child.on("message", (pid) => { descendant = Number(pid); });
			return child;
		},
		signalGroupImpl: (pid, signal) => { signals.push(signal); process.kill(-pid, signal); },
	}, { onChange() {}, onSettled(r) { assert.equal(r.isSettled(), true); settled.push(r.status); }, onExit() {} });
	t.after(() => {
		if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
		if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
	});
	for (let i = 0; i < 150 && !runner.sessionId; i++) await sleep(10);
	assert.equal(runner.sessionId, "fake-session");
	await runner.kill();
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(runner.status, "killed"); assert.deepEqual(settled, ["killed"]);
	assert.equal(runner.processAlive, false);
	assert.equal(child?.exitCode, forceKill ? null : 1);
	assert.equal(child?.signalCode, forceKill ? "SIGKILL" : null);
	assert.equal(child?.stdout?.destroyed, true); assert.equal(child?.stderr?.destroyed, true);
	if (detached) assert.equal(process.kill(descendant!, 0), true, "pipe release does not claim detached service containment");
});

test("allowedTools cannot smuggle CLI flags or controls", async () => {
	for (const tool of ["--dangerously-skip-permissions", " --permission-mode", "Bash\n--foo", "Bash\x00", ""]) {
		const f = fixture({ allowedTools: [tool] });
		await f.runner.whenClosed;
		assert.equal(f.argv.length, 0); assert.equal(f.runner.status, "error");
		assert.match(f.runner.error!, /Invalid allowedTools/);
	}
});

test("close mid-task is task error even exit zero; callbacks exactly once", async () => {
	const f = fixture(); await ready(f); f.child.close(0);
	await f.runner.whenClosed;
	assert.equal(f.runner.status, "error"); assert.equal(f.runner.taskOutcome, "error");
	assert.equal(f.exits, 1); assert.equal(f.settled.length, 1);
});

test("failed spawn and disposal before microtask do not launch or leave pending lifecycle", async () => {
	let spawns = 0; let exits = 0;
	const runner = new ClaudeRunner({ id: "x", groupId: "g", name: "x", cwd: "/tmp", task: "test", spawnImpl: () => { spawns++; throw Error("missing binary"); } }, { onChange() {}, onSettled() {}, onExit() { exits++; } });
	await runner.whenClosed; assert.equal(runner.status, "error"); assert.equal(spawns, 1); assert.equal(exits, 1);
	const f = fixture(); await f.runner.dispose(); await tick(); assert.equal(f.argv.length, 0); assert.equal(f.runner.status, "killed");
});

test("interrupt timeout fails closed without sending redirect", async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 1000, settlementTimeoutMs: 10, abortGraceMs: 10, eofGraceMs: 10, termGraceMs: 10 } });
	cleanup(t, f); await ready(f);
	const result = await f.runner.steer("NEVER"); assert.equal(result.ok, false);
	assert.equal(f.child.users().length, 1); assert.equal(f.runner.status, "error");
	f.child.close(1); await f.runner.whenClosed;
});

for (const missing of ["ack", "result"]) test(`negative interrupt requires correlated settlement and a response (missing ${missing})`, async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 20, settlementTimeoutMs: 40 } }); cleanup(t, f); await ready(f);
	const steer = f.runner.steer("NEVER");
	const interrupt = f.child.writes.find((e) => e.request?.subtype === "interrupt");
	if (missing === "ack") f.child.result();
	else {
		f.child.out({ type: "control_response", response: { request_id: interrupt.request_id, subtype: "error" } });
		f.child.result({ uuid: "stale" });
	}
	assert.equal((await steer).ok, false); assert.equal(f.child.users().length, 1);
	assert.equal(f.runner.status, "error");
});

test("pre-aborted steer has no side effects", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const count = f.child.writes.length;
	for (const mode of ["redirect", "followUp"] as const) {
		assert.deepEqual(await f.runner.steer("NEVER", AbortSignal.abort(), mode), { ok: false, reason: "cancelled" });
	}
	assert.equal(f.child.writes.length, count); assert.equal(f.runner.steerCount, 0);
	f.child.result(); assert.equal(f.runner.taskOutcome, "success");
});

for (const phase of ["interrupt", "settlement", "acceptance"]) test(`cancelling steer wait during ${phase} preserves worker and completes transaction`, async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const first = f.child.users()[0];
	if (phase === "acceptance") f.child.result();
	const controller = new AbortController(); const steer = f.runner.steer("NEXT", controller.signal);
	const interrupt = f.child.writes.find((e) => e.request?.subtype === "interrupt");
	if (phase === "settlement") f.child.ack(interrupt);
	controller.abort();
	const result = await Promise.race([steer, sleep(100).then(() => { throw Error("cancel did not release caller promptly"); })]);
	assert.equal(result.ok, false); assert.match(result.reason!, /cancelled.*delivery unknown/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(f.runner.processAlive, true); assert.equal(f.child.eof, false); assert.deepEqual(f.child.signals, []);
	assert.equal((await f.runner.steer("COMPETING")).ok, false, "transaction retains redirect barrier");
	await f.runner.followUp("QUEUED");
	if (phase !== "acceptance") {
		assert.equal(f.child.users().length, 1);
		if (phase === "interrupt") f.child.ack(interrupt);
		f.child.result(first); await tick();
	}
	assert.equal(f.child.users().length, 2);
	// A late correlated result alone proves delivery, clears acceptance timeout,
	// releases redirect ownership, and lets queued work continue normally.
	f.child.result(undefined, { result: "NEXT RESULT" }); await tick();
	assert.equal(f.child.users().length, 3);
	f.child.replay(); f.child.result(undefined, { result: "QUEUED RESULT" }); await tick();
	assert.equal(f.runner.isSettled(), true); assert.equal(f.runner.taskOutcome, "success");
	assert.equal(f.settled.at(-1)?.output, "QUEUED RESULT");
	const recovery = f.runner.steer("LATER"); f.child.replay(); assert.deepEqual(await recovery, { ok: true });
	f.child.result(); assert.equal(f.runner.isSettled(), true);
	assert.equal(f.child.eof, false); assert.deepEqual(f.child.signals, []);
});

test("cancellation during synchronous stdin write cannot miss the abort listener", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f); f.child.result();
	const controller = new AbortController();
	f.child.onWrite = (e) => { if (e.type === "user") controller.abort(); };
	const result = await f.runner.steer("NEXT", controller.signal);
	assert.equal(result.ok, false); assert.match(result.reason!, /delivery unknown/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(f.child.eof, false); assert.equal(f.runner.processAlive, true);
	f.child.replay(); f.child.result(); await tick();
	assert.equal(f.runner.taskOutcome, "success"); assert.equal(f.runner.isSettled(), true);
});

test("cancelled acceptance wait retains delivery timeout", async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 30 } }); cleanup(t, f); await ready(f); f.child.result();
	const controller = new AbortController(); const steer = f.runner.steer("UNACKNOWLEDGED", controller.signal);
	controller.abort(); assert.equal((await steer).ok, false);
	assert.equal(f.runner.processAlive, true); assert.equal(f.runner.status, "running");
	await sleep(60);
	assert.equal(f.runner.status, "error"); assert.match(f.runner.error!, /delivery unknown.*timeout/);
	f.child.close(1); await f.runner.whenClosed;
	assert.equal(f.runner.isSettled(), true);
});

test("late replay after waiter cancellation clears acceptance deadline and preserves permissions", async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 50 }, onPermission: async () => ({ behavior: "allow" }) });
	cleanup(t, f); await ready(f); f.child.result();
	const controller = new AbortController(); const steer = f.runner.steer("NEXT", controller.signal);
	controller.abort(); assert.equal((await steer).ok, false);
	f.child.replay(); await tick();
	f.child.out({ type: "control_request", request_id: "late", request: { subtype: "can_use_tool", tool_name: "Read", input: {} } });
	await tick(); assert.equal(f.child.writes.find((e) => e.response?.request_id === "late").response.response.behavior, "allow");
	await sleep(80); assert.equal(f.runner.status, "running"); assert.equal(f.child.eof, false);
	f.child.result(); assert.equal(f.runner.isSettled(), true); assert.equal(f.runner.taskOutcome, "success");
});

test("usage uses cumulative model totals and cost, not sum of cumulative results", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.result(undefined, { total_cost_usd: 0.2, modelUsage: { sonnet: { inputTokens: 10, outputTokens: 5 } }, num_turns: 1 });
	const steer = f.runner.steer("NEXT"); f.child.replay(); await steer;
	f.child.result(undefined, { total_cost_usd: 0.3, modelUsage: { sonnet: { inputTokens: 15, outputTokens: 9 } }, num_turns: 1 });
	assert.equal(f.runner.usage.cost, 0.3); assert.equal(f.runner.usage.input, 15); assert.equal(f.runner.usage.output, 9); assert.equal(f.runner.usage.turns, 2);
});

test("UTF8 split chunks, CRLF, Unicode separators and final unterminated result", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const user = f.child.users()[0];
	const bytes = Buffer.from(JSON.stringify({ type: "result", subtype: "success", user_message_uuid: user.uuid, result: "☃\u2028ok" }));
	for (const b of bytes) f.child.stdout.write(Buffer.from([b]));
	f.child.stdout.end(); await tick();
	assert.equal(f.runner.finalOutput(), "☃\u2028ok"); assert.equal(f.runner.taskOutcome, "success");
});

test("stream text blocks and completed assistant/result render once, later messages reset output", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const stream = (event: any) => f.child.out({ type: "stream_event", event });
	stream({ type: "message_start" });
	stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ONE" } });
	stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
	stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "TWO" } });
	f.child.out({ type: "assistant", message: { content: [{ type: "text", text: "ONE" }, { type: "text", text: "TWO" }] } });
	assert.deepEqual(f.runner.transcript.filter((i) => i.kind === "assistant").map((i) => i.text), ["ONETWO"]);
	stream({ type: "message_start" });
	stream({ type: "content_block_delta", delta: { type: "text_delta", text: "FINAL" } });
	f.child.out({ type: "assistant", message: { content: [{ type: "text", text: "FINAL" }] } });
	f.child.result(undefined, { result: "FINAL" });
	assert.deepEqual(f.runner.transcript.filter((i) => i.kind === "assistant").map((i) => i.text), ["ONETWO", "FINAL"]);
	assert.equal(f.runner.finalOutput(), "FINAL");
});

test("only failed tool results use modal's failed tool-result kind", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.out({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }, { type: "tool_result", is_error: true, content: "failed" }] } });
	assert.ok(f.runner.transcript.some((i) => i.text === "ok" && i.kind === "system"));
	assert.ok(f.runner.transcript.some((i) => i.text === "failed" && i.kind === "tool-result"));
});

test("initialize timeout and missing user acknowledgment fail closed", async (t) => {
	for (const initialize of [false, true]) {
		const f = fixture({ timings: { requestTimeoutMs: 10, abortGraceMs: 10, eofGraceMs: 10, termGraceMs: 10 } }); cleanup(t, f);
		await tick(); if (initialize) { f.child.ack(); await tick(); }
		await sleep(20); assert.equal(f.runner.status, "error");
		assert.equal(f.child.users().length, initialize ? 1 : 0);
		f.child.close(1); await f.runner.whenClosed; assert.equal(f.settled.length, 1);
	}
});

test("queued followups are dropped during kill and pending permission gets denial", async (t) => {
	let signal!: AbortSignal;
	const f = fixture({ onPermission: (_r, s) => { signal = s; return new Promise(() => {}); } }); cleanup(t, f); await ready(f);
	await f.runner.followUp("NEVER");
	f.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
	await tick(); const killed = f.runner.kill(); assert.equal(signal.aborted, true);
	assert.equal(f.child.writes.find((e) => e.response?.request_id === "p1").response.response.behavior, "deny");
	f.child.result(); await tick(); assert.equal(f.child.users().length, 1);
	f.child.close(1); await killed;
});

for (const newline of [true, false]) test(`oversized record fails closed (newline=${newline})`, async (t) => {
	const f = fixture({ limits: { maxLineBytes: 512 } }); cleanup(t, f); await ready(f);
	f.child.stdout.write(JSON.stringify({ type: "system", value: "x".repeat(600) }) + (newline ? "\n" : ""));
	assert.equal(f.runner.status, "error"); assert.match(f.runner.error!, /record exceeds/);
	assert.equal(f.runner.isFinished(), false); assert.equal(f.runner.isStopping(), true, "fail() teardown is advertised");
});

test("bounded transcript/output/stderr and stale output isolation", async (t) => {
	const f = fixture({ limits: { maxTranscriptBytes: 300, maxItemChars: 64 } }); cleanup(t, f); await ready(f);
	for (let i = 0; i < 50; i++) {
		f.child.stderr.write("🦄".repeat(100));
		f.child.out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "X".repeat(100) } } });
	}
	assert.ok(f.runner.finalOutput().length <= 64);
	assert.ok(f.runner.transcript.reduce((n, i) => n + Buffer.byteLength(i.text) + Buffer.byteLength(i.toolName ?? "") + 48, 0) <= 300);
	assert.ok(f.runner.transcriptOmitted.items > 0);
	f.child.result(undefined, { result: "OLD" });
	const steer = f.runner.steer("NEXT"); assert.equal(f.runner.finalOutput(), "");
	f.child.replay(); await steer;
});

const ABORTED = { is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_tools" };
const texts = (f: ReturnType<typeof fixture>) => f.child.users().map((u) => u.message.content[0].text);

for (const when of ["before", "after"]) test(`requested redirect abort keeps follow-ups queued ${when} the redirect`, async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const first = f.child.users()[0];
	if (when === "before") assert.deepEqual(await f.runner.followUp("F"), { ok: true });
	const steer = f.runner.steer("R"); await tick();
	if (when === "after") assert.deepEqual(await f.runner.followUp("F"), { ok: true });
	f.child.ack(f.child.writes.find((e) => e.request?.subtype === "interrupt"));
	f.child.result(first, ABORTED); await tick();
	assert.ok(f.runner.transcript.some((i) => i.text === "Task aborted by redirect"));
	assert.ok(!f.runner.transcript.some((i) => /Dropped/.test(i.text)));
	f.child.replay(); assert.deepEqual(await steer, { ok: true });
	f.child.result(undefined, { result: "R DONE" }); await tick();
	assert.deepEqual(texts(f), ["FIRST", "R", "F"]);
	assert.equal(f.settled.length, 0, "no wake between redirect and queued follow-up");
	f.child.replay(); f.child.result(undefined, { result: "F DONE" }); await tick();
	assert.deepEqual(f.settled, [{ outcome: "success", output: "F DONE", isSettled: true }]);
});

test("genuine error while redirecting still drops and reports the queue", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	const first = f.child.users()[0];
	await f.runner.followUp("F");
	const steer = f.runner.steer("R"); await tick();
	f.child.ack(f.child.writes.find((e) => e.request?.subtype === "interrupt"));
	f.child.result(first, { is_error: true, subtype: "error_during_execution", errors: ["real failure"] }); await tick();
	assert.ok(f.runner.transcript.some((i) => i.kind === "error" && /real failure/.test(i.text)));
	assert.ok(f.runner.transcript.some((i) => i.text === "Dropped 1 queued follow-up(s) after task error"));
	f.child.replay(); assert.deepEqual(await steer, { ok: true });
	f.child.result(); await tick();
	assert.deepEqual(texts(f), ["FIRST", "R"]);
});

test("aborted_streaming (interrupted pure generation) is an aborted outcome", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	f.child.result(undefined, { is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_streaming" });
	assert.equal(f.runner.taskOutcome, "aborted"); assert.equal(f.runner.error, undefined);
});

test("settled task with an unanswered interrupt rejects the redirect without stopping the worker", async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 200, settlementTimeoutMs: 20 } }); cleanup(t, f); await ready(f);
	const first = f.child.users()[0];
	const steer = f.runner.steer("R"); await tick();
	const interrupt = f.child.writes.find((e) => e.request?.subtype === "interrupt");
	f.child.result(first); // natural completion; the interrupt response never arrives in time
	const result = await steer;
	assert.equal(result.ok, false); assert.match(result.reason!, /interrupt was not acknowledged.*kept idle/);
	assert.equal(f.runner.status, "waiting"); assert.equal(f.runner.processAlive, true);
	assert.equal(f.child.eof, false); assert.deepEqual(f.child.signals, []);
	assert.deepEqual(f.settled, [{ outcome: "success", output: "ANSWER", isSettled: true }]);
	// No new turn may start under the unanswered interrupt.
	assert.match((await f.runner.steer("R2")).reason!, /still unanswered/);
	assert.deepEqual(await f.runner.followUp("F"), { ok: true });
	assert.ok(f.runner.transcript.some((i) => /not yet delivered/.test(i.text)));
	assert.deepEqual(texts(f), ["FIRST"]); assert.equal(f.runner.isSettled(), false);
	f.child.ack(interrupt); await tick(); await tick();
	assert.deepEqual(texts(f), ["FIRST", "F"]);
	f.child.replay(); f.child.result(undefined, { result: "F DONE" }); await tick();
	assert.equal(f.settled.at(-1)?.output, "F DONE"); assert.deepEqual(f.child.signals, []);
});

test("an interrupt never answered through its control deadline stops the worker", async (t) => {
	const f = fixture({ timings: { requestTimeoutMs: 40, settlementTimeoutMs: 10, abortGraceMs: 10, eofGraceMs: 10, termGraceMs: 10 } });
	cleanup(t, f); await ready(f);
	const steer = f.runner.steer("R"); await tick();
	f.child.result(f.child.users()[0]);
	assert.equal((await steer).ok, false); assert.equal(f.runner.status, "waiting");
	await sleep(60);
	assert.equal(f.runner.status, "error"); assert.match(f.runner.error!, /never answered an interrupt/);
	f.child.close(1); await f.runner.whenClosed;
});

test("clean exit with undelivered follow-ups is an error, not done", async () => {
	// Idle with an unanswered interrupt: the acknowledged follow-up waits in the host.
	const g = fixture({ timings: { requestTimeoutMs: 500, settlementTimeoutMs: 10 } }); await ready(g);
	const steer = g.runner.steer("R"); await tick();
	g.child.result(g.child.users()[0]); await steer;
	await g.runner.followUp("QUEUED");
	g.child.close(0); await g.runner.whenClosed;
	assert.equal(g.runner.status, "error");
	assert.match(g.runner.error!, /before delivering 1 queued follow-up/);
	assert.ok(g.runner.transcript.some((i) => i.kind === "error" && /Dropped 1 queued follow-up\(s\) because Claude exited/.test(i.text)));
	assert.equal(g.settled.at(-1)?.isSettled, true);
});

test("kill reports queued follow-ups it discards", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f);
	await f.runner.followUp("A"); await f.runner.followUp("B");
	assert.equal(f.runner.isStopping(), false);
	const killed = f.runner.kill(); assert.equal(f.runner.isStopping(), true);
	assert.ok(f.runner.transcript.some((i) => i.text === "Dropped 2 queued follow-up(s) because the worker was stopped"));
	f.child.close(1); await killed; assert.equal(f.runner.isStopping(), false);
});

test("idle follow-up is dispatched immediately without a misleading queued note", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f); f.child.result();
	assert.deepEqual(await f.runner.followUp("NOW"), { ok: true });
	assert.deepEqual(texts(f), ["FIRST", "NOW"]);
	assert.ok(!f.runner.transcript.some((i) => /not yet delivered/.test(i.text)));
	assert.equal(f.runner.transcript.at(-1)?.kind, "steer");
});

test("idle follow-up whose immediate write is rejected reports failure, not ok", async (t) => {
	const f = fixture({ limits: { maxLineBytes: 200 } }); cleanup(t, f); await ready(f); f.child.result(); await tick();
	assert.equal(f.runner.status, "waiting");
	const r = await f.runner.followUp("x".repeat(190));
	assert.deepEqual(r, { ok: false, reason: "follow-up not delivered: Could not send user message" });
	assert.equal(f.runner.status, "error"); assert.equal(f.child.users().length, 1);
	assert.ok(!f.runner.transcript.some((i) => /not yet delivered/.test(i.text)));
});

test("worker failing during an idle follow-up's written dispatch reports unknown delivery", async (t) => {
	const f = fixture(); cleanup(t, f); await ready(f); f.child.result(); await tick();
	f.child.onWrite = (e) => { if (e.type === "user") f.child.emit("error", new Error("EPIPE")); };
	const r = await f.runner.followUp("NOW");
	assert.deepEqual(r, { ok: false, reason: "agent stopped during follow-up delivery; delivery unknown: Process error: EPIPE" });
	assert.equal(f.runner.status, "error");
});

test("busy follow-up is acknowledged as host-queued only; a later failed dispatch drops it", async (t) => {
	const f = fixture({ limits: { maxLineBytes: 200 } }); cleanup(t, f); await ready(f);
	assert.deepEqual(await f.runner.followUp("x".repeat(190)), { ok: true });
	assert.ok(f.runner.transcript.some((i) => i.text === "Follow-up queued in host (not yet delivered)"));
	f.child.result(); await tick();
	assert.equal(f.runner.status, "error"); assert.equal(f.runner.error, "Could not send user message");
	assert.equal(f.child.users().length, 1);
});

test("permission requests carry the requesting worker's identity and directory", async (t) => {
	let request: any;
	const f = fixture({ id: "ag_07", name: "reviewer-2", cwd: "/tmp", permissionMode: "manual", onPermission: async (r) => { request = r; return { behavior: "deny", message: "no" }; } });
	cleanup(t, f); await ready(f);
	f.child.out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
	await tick();
	assert.equal(request.workerId, "ag_07"); assert.equal(request.workerName, "reviewer-2"); assert.equal(request.cwd, "/tmp");
});

test("system prompt is passed as a private 0600 file, never argv, and removed after initialize", { skip: process.platform === "win32" }, async (t) => {
	const { mkdtempSync, statSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join, dirname } = await import("node:path");
	const tmp = mkdtempSync(join(tmpdir(), "claude-sp-test-")); t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const secret = "SECRET-INSTRUCTIONS ".repeat(20000); // > 128 KiB single argv string limit
	const f = fixture({ systemPrompt: secret, tmpDir: tmp }); cleanup(t, f);
	await tick();
	assert.ok(!f.argv.some((a) => a.includes("SECRET")), "not visible in the process list");
	assert.ok(!f.argv.includes("--append-system-prompt"));
	const file = f.argv[f.argv.indexOf("--append-system-prompt-file") + 1];
	assert.equal(dirname(dirname(file)), tmp);
	assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
	assert.equal(readFileSync(file, "utf8"), secret);
	f.child.ack(); await tick();
	assert.equal(existsSync(file), false); assert.deepEqual(readdirSync(tmp), []);
	assert.equal(f.child.users().length, 1);
});

test("mcpServers become a private mcp.json passed by path that outlives startup, plus an allow rule outside bypass", { skip: process.platform === "win32" }, async (t) => {
	const { mkdtempSync, statSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join, dirname, basename } = await import("node:path");
	const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-test-")); t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const mcpServers = { team: { command: "/usr/bin/node", args: ["/srv/member-mcp.ts"], env: { PI_SUBAGENTS_TEAM_MEMBER: "{\"secret\":true}" } } };
	const f = fixture({ systemPrompt: "instructions", mcpServers, tmpDir: tmp }); cleanup(t, f);
	await tick();
	assert.ok(!f.argv.some((a) => a.includes("secret")), "server env never appears in the process list");
	const file = f.argv[f.argv.indexOf("--mcp-config") + 1];
	assert.equal(basename(file), "mcp.json");
	assert.equal(dirname(dirname(file)), tmp);
	assert.equal(dirname(file), dirname(f.argv[f.argv.indexOf("--append-system-prompt-file") + 1]), "one private directory per worker");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers });
	assert.ok(f.argv.includes("--strict-mcp-config"), "only the configured server is loaded");
	assert.ok(!f.argv.includes("--allowedTools"), "bypass mode needs no allow rule");
	assert.equal(f.spawnOptions.env.PI_SUBAGENTS_TEAM_MEMBER, undefined, "the identity reaches the server process only");
	f.child.ack(); await tick();
	assert.deepEqual(readdirSync(dirname(file)), ["mcp.json"], "the system prompt is gone after initialize; the MCP config stays");
	f.child.result(); await tick();
	assert.ok(existsSync(file), "still present while the process runs");
	f.child.close(0); await f.runner.whenClosed;
	assert.deepEqual(readdirSync(tmp), [], "removed with the private directory at close");
	// Outside bypass the server's tools are allowed by an mcp__<name> rule, appended after the caller's own rules.
	const restricted = fixture({ mcpServers, permissionMode: "acceptEdits", allowedTools: ["Bash(npm test *)"], tmpDir: tmp }); cleanup(t, restricted);
	await tick();
	const at = restricted.argv.indexOf("--allowedTools");
	assert.deepEqual(restricted.argv.slice(at + 1, at + 3), ["Bash(npm test *)", "mcp__team"]);
	assert.ok(!restricted.argv.includes("--append-system-prompt-file"));
	restricted.child.ack(); await tick();
	assert.equal(readdirSync(tmp).length, 1, "an mcp.json-only directory survives initialize");
	restricted.child.close(0); await restricted.runner.whenClosed;
	assert.deepEqual(readdirSync(tmp), []);
	// Without servers nothing changes: no file, no flag, no rule.
	const plain = fixture({ mcpServers: {}, permissionMode: "acceptEdits", tmpDir: tmp }); cleanup(t, plain);
	await tick();
	assert.ok(!plain.argv.includes("--mcp-config") && !plain.argv.includes("--allowedTools"));
	assert.deepEqual(readdirSync(tmp), []);
});

test("mcpServers that cannot be written verbatim fail closed before launch", async (t) => {
	const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-test-")); t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const good = { command: "node", args: ["x.ts"] };
	for (const mcpServers of [
		{ "bad name": good }, { "": good }, { team: { command: "", args: [] } }, { team: { command: "node\n", args: [] } },
		{ team: { command: "node", args: "x.ts" } }, { team: { command: "node", args: [1] } }, { team: { command: "node", args: [], env: ["A=1"] } },
		{ team: { command: "node", args: [], env: { "A B": "1" } } }, { team: { command: "node", args: [], env: { A: 1 } } }, { team: null },
	] as any[]) {
		const f = fixture({ mcpServers, tmpDir: tmp });
		await f.runner.whenClosed;
		assert.equal(f.argv.length, 0, JSON.stringify(mcpServers));
		assert.match(f.runner.error!, /Invalid mcpServers/);
	}
	assert.deepEqual(readdirSync(tmp), []);
	const missing = fixture({ mcpServers: { team: good }, tmpDir: join(tmp, "does-not-exist") });
	await missing.runner.whenClosed;
	assert.equal(missing.argv.length, 0, "never launched without its tools");
	assert.match(missing.runner.error!, /Could not write private launch file/);
});

test("system prompt file is removed when startup fails, and write failure fails closed", { skip: process.platform === "win32" }, async (t) => {
	const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const tmp = mkdtempSync(join(tmpdir(), "claude-sp-test-")); t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const f = fixture({ systemPrompt: "x", tmpDir: tmp, timings: { requestTimeoutMs: 10, abortGraceMs: 10, eofGraceMs: 10, termGraceMs: 10 } });
	await sleep(20); assert.equal(f.runner.status, "error");
	f.child.close(1); await f.runner.whenClosed;
	assert.deepEqual(readdirSync(tmp), []);
	const missing = fixture({ systemPrompt: "x", tmpDir: join(tmp, "does-not-exist") });
	await missing.runner.whenClosed;
	assert.equal(missing.argv.length, 0, "never launched without its instructions");
	assert.match(missing.runner.error!, /Could not write system prompt file/);
});
