/**
 * The chat bridge moving a turn to the next Claude login on a usage limit or a failed sign-in,
 * against a fake CLI and a temporary login registry (accounts.ts): no live Claude, no real login.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { SessionBridge } from "./session-bridge.ts";
import type { ClaudeFrame, ClaudeTurnRequest } from "./types.ts";
import { ACCOUNTS_DEV_ENV, ClaudeLogins, loginDir, updateAccounts, writeAccounts, type ClaudeLoginEntry } from "../accounts.ts";

/** A CLI child that answers initialize, and answers each user message with `reply(frame)`'s events. */
class FakeCli extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly env: Record<string, string>;
	readonly users: Record<string, any>[] = [];
	exited = false;
	private buffer = "";
	readonly pid: number;
	private readonly reply: (user: Record<string, any>) => Record<string, any>[];
	constructor(options: any, pid: number, reply: (user: Record<string, any>) => Record<string, any>[]) {
		super();
		this.pid = pid; this.reply = reply;
		this.env = options?.env ?? {};
		this.stdin = new Writable({ write: (chunk, _e, cb) => { this.ingest(String(chunk)); cb(); } });
		this.stdin.on("finish", () => this.exit());
	}
	private ingest(text: string): void {
		this.buffer += text;
		for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
			const frame = JSON.parse(this.buffer.slice(0, nl));
			this.buffer = this.buffer.slice(nl + 1);
			if (frame.type === "control_request") this.out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
			if (frame.type === "user") {
				this.users.push(frame);
				setTimeout(() => { for (const e of this.reply(frame)) this.out(e); }, 5);
			}
		}
	}
	out(frame: unknown): void { if (!this.exited) this.stdout.write(`${JSON.stringify(frame)}\n`); }
	kill(): boolean { this.exit(); return true; }
	exit(): void {
		if (this.exited) return;
		this.exited = true;
		this.emit("exit", 0, null); this.emit("close", 0, null);
	}
}

const LIMIT = (resetsAt: number) => [
	{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } },
	{ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your limit" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } }, error: "rate_limit", parent_tool_use_id: null },
	{ type: "result", subtype: "success", is_error: true, result: "You've hit your limit" },
];
const AUTH = [
	{ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } }, error: "authentication_failed", parent_tool_use_id: null },
	{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" },
];
const ANSWER = (text: string) => [
	{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 2 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
	{ type: "result", subtype: "success", is_error: false, result: text },
];

const tools: Tool[] = [];
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const request = (messages: Message[]): ClaudeTurnRequest => ({ model: "sonnet", sessionId: "pi-session-1", tools, messages });
const A = "l-0000000a", B = "l-0000000b";

function setup(t: { after: (fn: () => void) => void }, replyFor: (login: string, n: number) => Record<string, any>[], env: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-login-failover-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const claudeDir = path.join(root, "claude");
	fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	writeAccounts(agentDir, {
		version: 1,
		logins: [
			{ id: A, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: "acct-a", email: "a@example.com" } },
			{ id: B, addedAt: 2, enabled: true, device: "local", identity: { accountUuid: "acct-b", email: "b@example.com" } },
		],
		devices: { local: { order: [A, B, "default"] } },
	});
	const logins = new ClaudeLogins({ agentDir, env: { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir, ...env } });
	const children: FakeCli[] = [];
	const loginOf = (child: FakeCli) => child.env.CLAUDE_CONFIG_DIR === loginDir(agentDir, A) ? A : child.env.CLAUDE_CONFIG_DIR === loginDir(agentDir, B) ? B : "default";
	const bridge = new SessionBridge({
		cwd: root, projectsRoot: path.join(claudeDir, "projects"), logins,
		spawnImpl: ((_c: string, _argv: string[], options: any) => {
			const n = children.length;
			let child!: FakeCli;
			child = new FakeCli(options, 7000 + n, () => replyFor(loginOf(child), n));
			children.push(child);
			return child as any;
		}) as any,
		signalGroupImpl: (pid) => { children.find((c) => c.pid === pid)?.kill(); },
		timings: { requestTimeoutMs: 500, eofGraceMs: 20, termGraceMs: 20, pipeDrainMs: 5, abortGraceMs: 200 },
		onDebug: () => {},
	});
	const entries: ClaudeLoginEntry[] = [];
	bridge.setSessionLogin("pi-session-1", undefined, (entry) => entries.push(entry));
	// An announced session: without it a tool-less request is a one-shot, torn down after its turn.
	bridge.setSessionCwd("pi-session-1", root);
	t.after(() => bridge.disposeAll());
	return { bridge, children, entries, agentDir, loginOf, logins };
}

async function collect(frames: AsyncIterable<ClaudeFrame>): Promise<ClaudeFrame[]> {
	const out: ClaudeFrame[] = [];
	for await (const frame of frames) out.push(frame);
	return out;
}
const texts = (frames: ClaudeFrame[]) => JSON.stringify(frames);

test("a limit before anything streamed moves the turn to the next login and answers in the same turn", { timeout: 8000 }, async (t) => {
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	const s = setup(t, (login) => login === A ? LIMIT(resetsAt) : ANSWER("hello from B"));
	const frames = await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.children.length, 2);
	assert.equal(s.loginOf(s.children[0]!), A);
	assert.equal(s.loginOf(s.children[1]!), B);
	assert.equal(s.children[0]!.exited, true, "the failed login's child is gone");
	const result = frames.at(-1) as any;
	assert.equal(result.type, "result");
	assert.equal(result.outcome, "success");
	assert.ok(texts(frames).includes("hello from B"));
	assert.ok(!texts(frames).includes("hit your limit"), "the synthetic failure message never reaches pi");
	// The new child heard the same first-contact message, unwrapped.
	assert.deepEqual(s.children[1]!.users[0]!.message.content, [{ type: "text", text: "hi" }]);
	// Recorded: first A (the initial selection), then the switch with its notice.
	assert.deepEqual(s.entries.map((e) => [e.login, e.from]), [[A, undefined], [B, A]]);
	assert.match(s.entries[1]!.text!, /^Claude: switched a@example.com → b@example.com \(5h limit, resets /);
	assert.equal(s.logins.readinessOf(A).state, "limited");
	// The next turn continues on B's live child.
	const next = await collect(s.bridge.runTurn(request([user("hi"), { role: "assistant", content: [{ type: "text", text: "hello from B" }], api: "anthropic-messages", provider: "claude-code-cli", model: "sonnet", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } as Message, user("again")])));
	assert.equal(s.children.length, 2);
	assert.equal((next.at(-1) as any).outcome, "success");
});

test("a session records the login it starts on, default included, and a recorded one is not recorded again", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("ok"));
	updateAccounts(s.agentDir, (a) => { a.devices.local = { order: ["default", A, B] }; });
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.loginOf(s.children[0]!), "default");
	assert.deepEqual(s.entries.map((e) => [e.login, e.from]), [["default", undefined]], "the first turn records its login, even default");

	const r = setup(t, () => ANSWER("ok"));
	r.bridge.setSessionLogin("pi-session-1", B, (entry) => r.entries.push(entry));
	await collect(r.bridge.runTurn(request([user("hi")])));
	assert.equal(r.loginOf(r.children[0]!), B, "a recorded login that is still usable is kept");
	assert.deepEqual(r.entries, [], "and is not recorded a second time");
});

test("an auth failure on every login ends the turn with the error, as before", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => AUTH);
	const frames = await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.children.length, 3, "A, then B, then default: each tried once");
	const result = frames.at(-1) as any;
	assert.equal(result.outcome, "error");
	assert.match(result.message, /Not logged in/);
	assert.deepEqual(s.entries.map((e) => e.login), [A, B, "default"]);
});

test("a failure after the answer began ends the turn, and the next turn starts on the next login", { timeout: 8000 }, async (t) => {
	const partial = [ANSWER("partial")[0], ANSWER("partial")[1], ANSWER("partial")[2]];
	const s = setup(t, (login, n) => login === A && n === 0 ? [...partial, ...LIMIT(Math.floor(Date.now() / 1000) + 60)] : ANSWER("ok"));
	const frames = await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal((frames.at(-1) as any).outcome, "error");
	assert.equal(s.children.length, 1, "no switch once part of the answer reached pi");
	await collect(s.bridge.runTurn(request([user("hi"), user("retry")])));
	assert.equal(s.children.length, 2);
	assert.equal(s.loginOf(s.children[1]!), B);
});

test("the development switch makes a login fail without sending the message", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("real answer"), { [ACCOUNTS_DEV_ENV]: "1" });
	fs.writeFileSync(path.join(s.agentDir, "claude-accounts-dev.json"), JSON.stringify({ forceLimit: [A] }));
	const frames = await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.children[0]!.users.length, 0, "A's CLI never received the message");
	assert.equal(s.loginOf(s.children[1]!), B);
	assert.ok(texts(frames).includes("real answer"));
});
