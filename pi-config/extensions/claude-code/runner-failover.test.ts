/**
 * A claude-code worker moving to the next Claude login on a usage limit or a failed sign-in: the
 * failed process is stopped and a new one resumes the same Claude session on the next login.
 * Fake CLI children and a temporary login registry; no live Claude.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { ClaudeRunner, type ClaudeSpawnOptions } from "./runner.ts";
import { ClaudeLogins, loginDir, writeAccounts } from "./accounts.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 2));
	}
}

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	writes: any[] = [];
	closed = false;
	stdin: Writable;
	pid: number;
	argv: string[];
	env: Record<string, string>;
	constructor(pid: number, argv: string[], env: Record<string, string>) {
		super();
		this.pid = pid; this.argv = argv; this.env = env;
		this.stdin = new Writable({
			write: (chunk, _e, cb) => { this.writes.push(JSON.parse(String(chunk))); cb(); },
			final: (cb) => { cb(); setImmediate(() => this.close()); },
		});
	}
	out(event: any) { this.stdout.write(JSON.stringify(event) + "\n"); }
	ack() { const r = this.writes.find((e) => e.request?.subtype === "initialize"); this.out({ type: "control_response", response: { request_id: r.request_id, subtype: "success" } }); }
	users() { return this.writes.filter((e) => e.type === "user"); }
	close() { if (this.closed) return; this.closed = true; this.emit("exit", 0, null); this.emit("close", 0, null); }
	kill() { this.close(); return true; }
}

const A = "l-0000000a", B = "l-0000000b";
const SESSION = "6c852daa-6abf-4bbd-9ef5-8950d9330968";

function setup(t: { after: (fn: () => void) => void }, sameAccount = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runner-failover-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
	fs.mkdirSync(agentDir);
	writeAccounts(agentDir, {
		version: 1,
		logins: [
			{ id: A, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: "acct-a", email: "a@example.com" } },
			{ id: B, addedAt: 2, enabled: true, device: "local", identity: { accountUuid: sameAccount ? "acct-a" : "acct-b", email: "b@example.com" } },
		],
		devices: { local: { order: [A, B, "default"], defaultEnabled: false } },
	});
	const logins = new ClaudeLogins({ agentDir, env: { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: path.join(root, "claude") } });
	const login = logins.select();
	const children: FakeChild[] = [];
	const spawn = (_c: string, argv: string[], options: any) => {
		const child = new FakeChild(9000 + children.length, argv, options.env);
		children.push(child);
		return child as unknown as ChildProcess;
	};
	const settled: string[] = [];
	let exits = 0;
	const runner = new ClaudeRunner({
		id: "w1", groupId: "g1", name: "worker", task: "FIRST", cwd: root, tools: [],
		timings: { requestTimeoutMs: 1000, settlementTimeoutMs: 1000, abortGraceMs: 20, eofGraceMs: 20, termGraceMs: 20 },
		env: { MCP_TOOL_TIMEOUT: "1000", ...login.env }, login, logins,
		spawnImpl: spawn, respawnImpl: spawn,
		signalGroupImpl: (pid) => { children.find((c) => c.pid === pid)?.kill(); },
	} as ClaudeSpawnOptions, {
		onChange() {},
		onSettled(r) { settled.push(`${r.taskOutcome}:${r.finalOutput()}`); },
		onExit() { exits++; },
	});
	t.after(() => { void runner.dispose(); });
	return { runner, children, settled, logins, agentDir, get exits() { return exits; } };
}

const limitFor = (uuid: string) => [
	{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "seven_day" }, session_id: SESSION },
	{ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your limit" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } }, error: "rate_limit", parent_tool_use_id: null, session_id: SESSION },
	{ type: "result", subtype: "success", is_error: true, result: "You've hit your limit", user_message_uuid: uuid, session_id: SESSION },
];

test("a worker on a limit resumes its own Claude session on the next login and sends the task again", { timeout: 8000 }, async (t) => {
	const s = setup(t);
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const first = s.children[0]!;
	assert.equal(first.env.CLAUDE_CONFIG_DIR, loginDir(s.agentDir, A));
	first.ack();
	await until(() => first.users().length === 1);
	const uuid = first.users()[0]!.uuid;
	first.out({ type: "user", isReplay: true, uuid, session_id: SESSION });
	for (const e of limitFor(uuid)) first.out(e);
	await until(() => s.children.length === 2);
	assert.equal(first.closed, true, "the failed login's process was stopped");
	const second = s.children[1]!;
	assert.equal(second.argv[second.argv.indexOf("--resume") + 1], SESSION, "the same Claude session, resumed");
	assert.equal(second.env.CLAUDE_CONFIG_DIR, loginDir(s.agentDir, B));
	assert.equal(second.env.MCP_TOOL_TIMEOUT, "1000", "the worker's own environment carries over");
	assert.equal(s.runner.status, "running", "never error, never finished, while switching");
	assert.equal(s.runner.isFinished(), false);
	assert.equal(s.settled.length, 0, "no completion for the failed attempt");
	await until(() => second.writes.length > 0);
	second.ack();
	await until(() => second.users().length === 1);
	assert.deepEqual(second.users()[0]!.message.content, [{ type: "text", text: "FIRST" }], "nothing ran yet: the message is sent as it was");
	const again = second.users()[0]!.uuid;
	second.out({ type: "result", subtype: "success", result: "DONE", user_message_uuid: again, session_id: SESSION });
	await until(() => s.settled.length === 1);
	assert.deepEqual(s.settled, ["success:DONE"]);
	assert.equal(s.runner.login?.id, B);
	assert.equal(s.runner.sessionId, SESSION);
	assert.ok(s.runner.transcript.some((i) => i.kind === "system" && /^Claude: switched a@example.com → b@example.com \(weekly limit, resets /.test(i.text)));
	assert.equal(s.logins.readinessOf(A).state, "limited");
	assert.equal(s.exits, 0);
});

test("a worker whose only other login shares the account ends the task with the limit, as before", { timeout: 8000 }, async (t) => {
	const s = setup(t, true);
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const first = s.children[0]!;
	first.ack();
	await until(() => first.users().length === 1);
	const uuid = first.users()[0]!.uuid;
	for (const e of limitFor(uuid)) first.out(e);
	await until(() => s.settled.length === 1);
	assert.equal(s.children.length, 1, "no switch: B has the same quota");
	assert.equal(s.settled[0]!.split(":")[0], "error");
	assert.match(s.runner.error ?? "", /hit your limit/);
	assert.equal(s.logins.readinessOf(B).state, "limited", "B is out with A: same account");
});

test("a worker killed while switching closes cleanly", { timeout: 8000 }, async (t) => {
	const s = setup(t);
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const first = s.children[0]!;
	first.ack();
	await until(() => first.users().length === 1);
	const uuid = first.users()[0]!.uuid;
	// The failure, and a kill before the old process is gone.
	const closeOnFinal = first.stdin;
	void closeOnFinal;
	for (const e of limitFor(uuid)) first.out(e);
	await tick(); await tick();
	const killed = s.runner.kill("stop");
	await killed;
	assert.equal(s.runner.isFinished(), true);
	assert.equal(s.runner.status, "killed");
	assert.equal(s.exits, 1);
	assert.ok(s.children.length <= 2);
});
