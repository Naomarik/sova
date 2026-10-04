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
import { pickChatLogin } from "./login-command.ts";
import type { ClaudeFrame, ClaudeTurnRequest } from "./types.ts";
import { ACCOUNTS_DEV_ENV, ClaudeLogins, loginDir, loginUsers, markLeaving, readLeaving, readLoginPicks, updateAccounts, writeAccounts, type ClaudeLoginEntry } from "../accounts.ts";

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

function setup(t: { after: (fn: () => void) => void }, replyFor: (login: string, n: number) => Record<string, any>[], env: Record<string, string> = {}, pool = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-login-failover-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const claudeDir = path.join(root, "claude");
	fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	if (pool) {
		// The mesh is on: the pool's paths (leaving marks, failoverAsync).
		fs.mkdirSync(path.join(agentDir, "sova"));
		fs.writeFileSync(path.join(agentDir, "sova", "peers.json"), JSON.stringify({ version: 1, self: { id: "local", label: "Desk" }, peers: [{ id: "vps", label: "Vps", nodeId: "n-vps", dnsName: "vps.example.invalid" }] }));
	}
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
	updateAccounts(s.agentDir, (a) => { for (const l of a.logins) l.enabled = false; });
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

test("the pool: a limit marks the login leaving and the same turn answers on the next login", { timeout: 8000 }, async (t) => {
	const s = setup(t, (login) => login === A ? LIMIT(Math.floor(Date.now() / 1000) + 3600) : ANSWER("ok from B"), {}, true);
	const frames = await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal((frames.at(-1) as any).type, "result");
	assert.notEqual((frames.at(-1) as any).outcome, "error", "the turn succeeded, on B");
	assert.equal(s.loginOf(s.children.at(-1)!), B);
	assert.equal(readLeaving(s.agentDir, A)?.reason, "limit", "A goes back to the keeper");
	assert.ok(s.entries.some((e) => e.from === A && e.login === B && e.reason === "limit"));
});

test("the pool: an idle chat child whose login leaves is torn down, and the next turn starts on the next login", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("ok"), {}, true);
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.loginOf(s.children[0]!), A);
	const lease = path.join(loginDir(s.agentDir, A), ".sova-leases", `${process.pid}.json`);
	assert.ok(fs.existsSync(lease), "the child holds a lease on A");
	markLeaving(s.agentDir, A, "user");
	loginUsers().tick();
	for (let i = 0; i < 200 && !s.children[0]!.exited; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(s.children[0]!.exited, true, "the idle child on A was stopped");
	for (let i = 0; i < 200 && fs.existsSync(lease); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(fs.existsSync(lease), false, "and its lease is gone: A can leave");
	await collect(s.bridge.runTurn(request([user("hi"), { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } as any, user("again")])));
	assert.equal(s.loginOf(s.children[1]!), B, "the next turn starts on B");
	// Never silent: the move is recorded with the login it left and why.
	const moved = s.entries.at(-1)!;
	assert.deepEqual([moved.login, moved.from, moved.fromLabel, moved.reason], [B, A, "a@example.com", "moved"]);
	assert.equal(moved.text, "Claude: switched a@example.com → b@example.com (a@example.com left this device)");
});

test("the pool: a chat whose recorded login went free at the keeper takes it back, with no note", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("ok"), {}, true);
	signIn(s.agentDir);
	s.bridge.setSessionLogin("pi-session-1", A, (entry) => s.entries.push(entry));
	updateAccounts(s.agentDir, (a) => { a.logins.find((l) => l.id === A)!.device = null; });
	const taken: string[] = [];
	s.logins.take = async (id: string) => { taken.push(id); updateAccounts(s.agentDir, (a) => { a.logins.find((l) => l.id === id)!.device = "local"; }); };
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.deepEqual(taken, [A], "it asked for its own login by name");
	assert.equal(s.loginOf(s.children[0]!), A, "and runs on it again");
	assert.deepEqual(s.entries, [], "nothing changed, so nothing is recorded");
});

test("the pool: a recorded login that is gone (held elsewhere, removed) moves the chat with a note naming why", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("ok"), {}, true);
	s.bridge.setSessionLogin("pi-session-1", A, (entry) => s.entries.push(entry));
	updateAccounts(s.agentDir, (a) => { a.logins.find((l) => l.id === A)!.device = "vps"; });
	let took = 0;
	s.logins.take = async () => { took++; };
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(took, 0, "a login another device holds is not asked for");
	assert.equal(s.loginOf(s.children[0]!), B);
	assert.deepEqual(s.entries.map((e) => [e.login, e.from, e.reason, e.text]), [[B, A, "moved", "Claude: switched a@example.com → b@example.com (a@example.com left this device)"]]);

	const r = setup(t, () => ANSWER("ok"), {}, true);
	r.bridge.setSessionLogin("pi-session-1", A, (entry) => r.entries.push(entry));
	updateAccounts(r.agentDir, (a) => { a.logins = a.logins.filter((l) => l.id !== A); a.devices.local!.order = [B, "default"]; });
	await collect(r.bridge.runTurn(request([user("hi")])));
	assert.deepEqual(r.entries.map((e) => [e.login, e.from, e.fromLabel, e.reason, e.text]), [[B, A, A, "moved", `Claude: switched ${A} → b@example.com (${A} was removed)`]]);
});

// ---- A pick in the composer (§app.claude-logins/switch-login) ------------------------------------

const said = (text: string, n = 2): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: n } as any);
/** The session branch as pi holds it: the entries the bridge asked to append. */
const branchOf = (entries: ClaudeLoginEntry[]) => entries.map((data) => ({ type: "custom", customType: "claude-login", data }));
/** A pick needs a signed-in login: an empty synthetic credentials file is enough to say so. */
function signIn(agentDir: string): void {
	for (const id of [A, B]) {
		fs.mkdirSync(loginDir(agentDir, id), { recursive: true });
		fs.writeFileSync(path.join(loginDir(agentDir, id), ".credentials.json"), "{}");
	}
}

test("a pick moves an idle chat now: the manual entry and note, the next turn folded on the picked login, then the device order again", { timeout: 8000 }, async (t) => {
	let bTurns = 0;
	const s = setup(t, (login) => {
		if (login !== B) return ANSWER(`ok from ${login}`);
		bTurns++;
		return bTurns === 2 ? LIMIT(Math.floor(Date.now() / 1000) + 3600) : ANSWER("ok from B");
	});
	signIn(s.agentDir);
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.loginOf(s.children[0]!), A);

	assert.equal(await pickChatLogin(B, { id: "pi-session-1", branch: branchOf(s.entries) }, { bridge: s.bridge, logins: s.logins }), "switched");
	const pick = s.entries.at(-1)!;
	assert.deepEqual([pick.login, pick.from, pick.reason], [B, A, "manual"]);
	assert.equal(pick.text, "Claude: switched a@example.com → b@example.com (chosen by you)");
	assert.deepEqual(readLoginPicks(s.agentDir, B).map((p) => p.session), ["pi-session-1"], "the pick is marked on B");
	for (let i = 0; i < 200 && !s.children[0]!.exited; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(s.children[0]!.exited, true, "the idle child on A stops at once");
	// A worker starts on the device's order, whatever the chat picked.
	assert.equal(s.logins.select().id, A, "workers are unaffected");

	const second = await collect(s.bridge.runTurn(request([user("hi"), said("ok from l-0000000a"), user("again")])));
	assert.equal((second.at(-1) as any).outcome, "success");
	assert.equal(s.children.length, 2);
	assert.equal(s.loginOf(s.children[1]!), B, "the next turn runs on the pick");
	const folded = JSON.stringify(s.children[1]!.users[0]!.message.content);
	assert.ok(folded.includes("hi") && folded.includes("again"), "with the history folded into its one message");
	assert.equal(s.entries.length, 2, "and the pick is not recorded twice");

	// Nothing pins it: a limit on B moves on in the device's order (to A), as for any chat.
	const third = await collect(s.bridge.runTurn(request([user("hi"), said("ok from l-0000000a"), user("again"), said("ok from B", 3), user("more")])));
	assert.equal((third.at(-1) as any).outcome, "success");
	assert.equal(s.loginOf(s.children.at(-1)!), A);
	assert.deepEqual([s.entries.at(-1)!.from, s.entries.at(-1)!.login, s.entries.at(-1)!.reason], [B, A, "limit"]);
	assert.deepEqual(readLoginPicks(s.agentDir, B), [], "and the chat's mark on B goes with it");
});

test("a pick before the chat's first Claude turn only records it, and the first turn starts there", { timeout: 8000 }, async (t) => {
	const s = setup(t, () => ANSWER("ok"));
	signIn(s.agentDir);
	assert.equal(await pickChatLogin(B, { id: "pi-session-1", branch: [] }, { bridge: s.bridge, logins: s.logins }), "switched");
	assert.deepEqual(s.entries.map((e) => [e.login, e.from, e.reason]), [[B, A, "manual"]], "from the login it would have started on");
	assert.deepEqual(readLoginPicks(s.agentDir, B).map((p) => p.session), ["pi-session-1"], "the pick is marked before any child");
	await collect(s.bridge.runTurn(request([user("hi")])));
	assert.equal(s.loginOf(s.children[0]!), B);
	assert.equal(s.entries.length, 1);
	assert.equal(await pickChatLogin(A, { id: "pi-session-1", branch: branchOf(s.entries) }, { bridge: s.bridge, logins: s.logins }), "switched");
	assert.deepEqual([readLoginPicks(s.agentDir, A).length, readLoginPicks(s.agentDir, B).length], [1, 0], "a second pick moves the mark");
	assert.equal(await pickChatLogin(B, { id: "pi-session-1", branch: branchOf(s.entries) }, { bridge: s.bridge, logins: s.logins }), "switched");
	assert.deepEqual([readLoginPicks(s.agentDir, A).length, readLoginPicks(s.agentDir, B).length], [0, 1]);
});

test("a pick of the chat's own login changes nothing; an unusable one, or one mid-turn, is refused", { timeout: 8000 }, async (t) => {
	let hold = true;
	const s = setup(t, () => (hold ? [] : ANSWER("ok")));
	signIn(s.agentDir);
	const pick = (id: string) => pickChatLogin(id, { id: "pi-session-1", branch: branchOf(s.entries) }, { bridge: s.bridge, logins: s.logins });
	// Mid-turn: the child has the message and has not answered yet.
	const ctl = new AbortController();
	const running = collect(s.bridge.runTurn(request([user("hi")]), ctl.signal));
	for (let i = 0; i < 200 && !s.children[0]?.users.length; i++) await new Promise((r) => setTimeout(r, 5));
	await assert.rejects(pick(B), /still answering/);
	ctl.abort();
	await running;
	hold = false;
	assert.equal(await pick(A), "same");
	assert.ok(!s.entries.some((e) => e.reason === "manual"), "no entry for either");
	assert.equal(readLoginPicks(s.agentDir, A).length, 0, "picking the login it is on marks nothing either");
	s.logins.recordFailure({ id: B, label: "b@example.com", env: {}, accountUuid: "acct-b" }, { kind: "limit", resetsAt: Date.now() + 3_600_000 });
	await assert.rejects(pick(B), /limited until/);
	await assert.rejects(pick("l-0000dead"), /no such Claude login/);
});
