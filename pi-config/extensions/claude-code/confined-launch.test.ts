/**
 * A confined Claude worker: every launch path (start, a borrowed start, a move off a leaving login,
 * a failover, the refresh after a 401) goes through the sandbox's `confineLaunch`; the access token
 * reaches the process on fd 3 only; the spawn environment names the login's directory. A fake
 * launch module stands in for the sandbox; fake CLI children; no live Claude.
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
import { ClaudeLogins, loginDir, loginUsers, markLeaving, writeAccounts } from "./accounts.ts";
import { CLAUDE_API_HOSTS, TOKEN_FD, TOKEN_FD_ENV, claudeNeeds, privateConfigDir, releasePrivateConfigDir, sweepPrivateConfigDirs } from "./confined-launch.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 2));
	}
}

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	fd3 = "";
	writes: any[] = [];
	closed = false;
	stdin: Writable;
	stdio: any[];
	constructor(public pid: number, public command: string, public argv: string[], public options: any) {
		super();
		this.stdin = new Writable({
			write: (chunk, _e, cb) => { this.writes.push(JSON.parse(String(chunk))); cb(); },
			final: (cb) => { cb(); setImmediate(() => this.close()); },
		});
		const fd3 = new Writable({ write: (chunk, _e, cb) => { this.fd3 += String(chunk); cb(); } });
		this.stdio = [this.stdin, this.stdout, this.stderr, ...(options.stdio?.[3] === "pipe" ? [fd3] : [])];
	}
	out(event: any) { this.stdout.write(JSON.stringify(event) + "\n"); }
	ack() { const r = this.writes.find((e) => e.request?.subtype === "initialize"); this.out({ type: "control_response", response: { request_id: r.request_id, subtype: "success" } }); }
	users() { return this.writes.filter((e) => e.type === "user"); }
	close() { if (this.closed) return; this.closed = true; this.emit("exit", 0, null); this.emit("close", 0, null); }
	kill() { this.close(); return true; }
}

const A = "l-0000000a", B = "l-0000000b";
const SESSION = "00000000-0000-4000-8000-00000000c0f1";
const FAR = Date.now() + 8 * 3600_000;

/** The sandbox's launch module, faked: records every call, wraps argv, hands back the needs' fds. */
function fakeModule(root: string, refuse?: string): { file: string; calls: () => any[] } {
	const file = path.join(root, `launch-${Math.random().toString(36).slice(2)}.mjs`);
	const key = `__confine_${path.basename(file, ".mjs").replace(/-/g, "_")}`;
	fs.writeFileSync(file, `
import fs from "node:fs"; import path from "node:path";
const calls = globalThis[${JSON.stringify(key)}] = [];
export function workerTmpDir(scope, needs) { const host = needs?.tmpDir ?? path.join(${JSON.stringify(root)}, "wtmp-" + scope); fs.mkdirSync(host, { recursive: true, mode: 0o700 }); return { host, inside: "/tmp" }; }
export async function confineLaunch(scope, needs, launch) {
	calls.push({ scope, needs: structuredClone(needs), launch: structuredClone(launch), cleaned: false });
	const call = calls.at(-1);
	${refuse ? `return { refused: ${JSON.stringify(refuse)} };` : ""}
	return { command: "/fake/bwrap", args: ["--wrapped", launch.command, ...launch.args], env: { ...needs.env },
		spawnEnv: { PATH: "/usr/bin", ...needs.spawnEnv }, fds: needs.fds ?? [], tmpDir: workerTmpDir(scope, needs).host, tmpInside: "/tmp",
		enforcement: "full", async cleanup() { call.cleaned = true; } };
}
`);
	return { file, calls: () => (globalThis as any)[key] ?? [] };
}

function credentials(dir: string, token: string, expiresAt = FAR): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "REFRESH-never", expiresAt } }));
}

function setup(t: { after: (fn: () => void) => void }, o: { pool?: boolean; refuse?: string; hosted?: boolean; noToken?: boolean; systemPrompt?: string; settingsJson?: string; resume?: string } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-confined-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const claudeDir = path.join(root, "claude");
	fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
	fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "user memory");
	fs.mkdirSync(agentDir);
	if (o.pool) {
		fs.mkdirSync(path.join(agentDir, "sova"));
		fs.writeFileSync(path.join(agentDir, "sova", "peers.json"), JSON.stringify({ version: 1, self: { id: "desk", label: "Desk" }, peers: [{ id: "vps", label: "Vps", nodeId: "n-vps", dnsName: "vps.example.invalid" }] }));
	}
	writeAccounts(agentDir, {
		version: 1,
		logins: [
			{ id: A, addedAt: 1, enabled: true, device: o.pool ? "desk" : "local", identity: { accountUuid: "acct-a", email: "a@example.com" } },
			{ id: B, addedAt: 2, enabled: true, device: o.pool ? "desk" : "local", identity: { accountUuid: "acct-b", email: "b@example.com" } },
		],
		devices: { local: { order: [A, B, "default"], defaultEnabled: false } },
	});
	const logins = new ClaudeLogins({ agentDir, env: { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir } });
	for (const id of [A, B]) {
		fs.mkdirSync(loginDir(agentDir, id), { recursive: true });
		for (const name of ["projects", "CLAUDE.md"]) fs.symlinkSync(path.join(claudeDir, name), path.join(loginDir(agentDir, id), name));
		if (!o.noToken) credentials(loginDir(agentDir, id), `tok-${id}-1`);
	}
	const login = logins.select();
	const children: FakeChild[] = [];
	const spawn = (command: string, argv: string[], options: any) => {
		const child = new FakeChild(9000 + children.length, command, argv, options);
		children.push(child);
		return child as unknown as ChildProcess;
	};
	const module = fakeModule(root, o.refuse);
	const refreshed: { dir: string }[] = [];
	const refreshImpl = async (dir: string) => {
		refreshed.push({ dir });
		if (o.noToken) return false;
		credentials(dir, `tok-${path.basename(dir)}-${refreshed.length + 1}`);
		return true;
	};
	const cwd = path.join(root, "work");
	fs.mkdirSync(cwd);
	const settled: string[] = [];
	let exits = 0;
	const runner = new ClaudeRunner({
		id: "w1", groupId: "g1", name: "worker", task: "FIRST", cwd, tools: [],
		timings: { requestTimeoutMs: 1000, settlementTimeoutMs: 1000, abortGraceMs: 20, eofGraceMs: 20, termGraceMs: 20 },
		env: { MCP_TOOL_TIMEOUT: "1000", ...login.env }, login, logins, refreshImpl,
		...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
		...(o.settingsJson ? { settingsJson: o.settingsJson } : {}),
		...(o.resume ? { resume: { sessionId: o.resume } } : {}),
		confine: { scope: "SCOPE", module: module.file, key: "sess-w1", agentDir, writable: [path.join(root, "mailbox")], ...(o.hosted ? { hostedTmpDir: path.join(root, "hosted-tmp") } : {}) },
		spawnImpl: spawn, respawnImpl: spawn,
		signalGroupImpl: (pid) => { children.find((c) => c.pid === pid)?.kill(); },
	} as ClaudeSpawnOptions, {
		onChange() {},
		onSettled(r) { settled.push(`${r.taskOutcome}:${r.finalOutput()}`); },
		onExit() { exits++; },
	});
	t.after(() => { void runner.dispose(); });
	return { root, agentDir, claudeDir, cwd, runner, children, settled, logins, module, refreshed, get exits() { return exits; } };
}

const TOKENS = [A, B].flatMap((id) => [1, 2, 3, 4].map((n) => `tok-${id}-${n}`));
/** No token anywhere a local user or the model could read it: argv, the spawn environment, the environment inside. */
function assertNoToken(s: ReturnType<typeof setup>, child: FakeChild): void {
	const visible = JSON.stringify([child.command, child.argv, child.options.env, s.module.calls().map((c) => [c.launch, c.needs.env, c.needs.spawnEnv])]);
	for (const token of TOKENS) assert.ok(!visible.includes(token), `${token} leaked`);
	assert.ok(!visible.includes("REFRESH-never"), "the refresh token is never read out");
}
const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1]!);

test("confined start: wrapped by the sandbox, Claude's own sandbox off, bypassPermissions, the token on fd 3 only, the login dir in the spawn env", { timeout: 8000 }, async (t) => {
	const s = setup(t, { systemPrompt: "be terse", settingsJson: JSON.stringify({ hooks: { Stop: [] } }) });
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const child = s.children[0]!;
	const [call] = s.module.calls();
	assert.equal(call.scope, "SCOPE");
	assert.equal(child.command, "/fake/bwrap");
	assert.deepEqual(child.argv.slice(0, 2), ["--wrapped", "claude"]);
	assert.deepEqual(settingsOf(child.argv), { hooks: { Stop: [] }, sandbox: { enabled: false }, attribution: { commit: "", pr: "" } }, "the spec hooks stay, Claude's sandbox is off, no attribution");
	assert.equal(child.argv[child.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
	assert.equal(child.fd3, `tok-${A}-1`, "the token arrives on fd 3");
	assert.deepEqual(child.options.stdio, ["pipe", "pipe", "pipe", "pipe"]);
	assert.deepEqual(child.options.env, { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: loginDir(s.agentDir, A) }, "the spawn env is the sandbox's, exactly, naming the login dir");
	assertNoToken(s, child);
	// What the worker's own state needs.
	const home = privateConfigDir(s.agentDir, "sess-w1");
	const slug = s.cwd.replace(/[^a-zA-Z0-9]/g, "-");
	assert.equal(call.needs.env.CLAUDE_CONFIG_DIR, home, "inside, its own config dir");
	assert.equal(call.needs.env[TOKEN_FD_ENV], String(TOKEN_FD));
	assert.equal(call.needs.env.MCP_TOOL_TIMEOUT, "1000", "the worker's own variables");
	assert.deepEqual(call.needs.fds, [{ fd: TOKEN_FD, data: `tok-${A}-1` }]);
	assert.deepEqual(call.needs.writable, [home, path.join(s.claudeDir, "projects", slug), path.join(s.root, "mailbox")]);
	assert.deepEqual(call.needs.proxyHosts, CLAUDE_API_HOSTS);
	assert.equal(fs.readlinkSync(path.join(home, "projects", slug)), path.join(s.claudeDir, "projects", slug), "its transcripts land in Claude Code's own projects/");
	assert.equal(fs.readlinkSync(path.join(home, "CLAUDE.md")), path.join(s.claudeDir, "CLAUDE.md"));
	assert.equal(fs.statSync(home).mode & 0o777, 0o700);
	assert.ok(!("CLAUDE_CONFIG_DIR" in call.launch.env) || call.launch.env.CLAUDE_CONFIG_DIR !== loginDir(s.agentDir, A));
	// Private launch files: in the worker's sandbox tmp, named by their inside path.
	const file = child.argv[child.argv.indexOf("--append-system-prompt-file") + 1]!;
	assert.match(file, /^\/tmp\/pi-claude-[^/]+\/system\.md$/);
	assert.equal(fs.readFileSync(path.join(s.root, "wtmp-SCOPE", file.slice("/tmp/".length)), "utf8"), "be terse");
});

test("every launch goes through the sandbox: a failover to the next login re-reads that login's token; a 401 refreshes the same login once and resumes, a second 401 fails over", { timeout: 10000 }, async (t) => {
	const s = setup(t);
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const first = s.children[0]!;
	first.ack();
	await until(() => first.users().length === 1);
	const auth401 = (child: FakeChild) => {
		const uuid = child.users().at(-1)!.uuid;
		child.out({ type: "system", subtype: "api_retry", error: "authentication_failed", session_id: SESSION });
		child.out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate. API Error: 401" }] }, error: "authentication_failed", session_id: SESSION });
		child.out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.", user_message_uuid: uuid, session_id: SESSION });
	};
	auth401(first);
	await until(() => s.children.length === 2);
	assert.deepEqual(s.refreshed, [{ dir: loginDir(s.agentDir, A) }], "the login was refreshed, unconfined, before anything else");
	const second = s.children[1]!;
	assert.equal(s.runner.login?.id, A, "the same login");
	assert.equal(second.argv[second.argv.indexOf("--resume") + 1], SESSION);
	assert.equal(second.fd3, `tok-${A}-2`, "the refreshed token, read again");
	assert.equal(s.logins.readinessOf(A).state, "ready", "a refused token is not the login's failure");
	assert.ok(s.runner.transcript.some((i) => i.kind === "system" && /refused the worker's token; refreshing it/.test(i.text)));
	await until(() => second.writes.length > 0);
	second.ack();
	await until(() => second.users().length === 1);
	auth401(second);
	await until(() => s.children.length === 3);
	const third = s.children[2]!;
	assert.equal(s.runner.login?.id, B, "the second refusal fails over");
	assert.equal(s.logins.readinessOf(A).state, "auth", "now the login itself is out");
	assert.equal(third.fd3, `tok-${B}-1`);
	assert.deepEqual(third.options.env, { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: loginDir(s.agentDir, B) });
	assert.equal(s.module.calls().length, 3, "three launches, three confinements");
	for (const child of s.children) assertNoToken(s, child);
	await until(() => third.writes.length > 0);
	third.ack();
	await until(() => third.users().length === 1);
	third.out({ type: "result", subtype: "success", result: "DONE", user_message_uuid: third.users()[0]!.uuid, session_id: SESSION });
	await until(() => s.settled.length === 1);
	assert.deepEqual(s.settled, ["success:DONE"]);
	await until(() => s.module.calls().slice(0, 2).every((c) => c.cleaned), 3000);
});

test("the pool: a borrowed start and a move off a leaving login are confined too", { timeout: 10000 }, async (t) => {
	const s = setup(t, { pool: true });
	await until(() => s.children.length === 1 && s.children[0]!.writes.length > 0);
	const first = s.children[0]!;
	assert.equal(first.command, "/fake/bwrap", "the start on an acquired login");
	first.ack();
	await until(() => first.users().length === 1);
	first.out({ type: "result", subtype: "success", result: "DONE", user_message_uuid: first.users()[0]!.uuid, session_id: SESSION });
	await until(() => s.settled.length === 1);
	markLeaving(s.agentDir, A, "user");
	loginUsers().tick();
	await until(() => s.children.length === 2);
	const second = s.children[1]!;
	assert.equal(second.command, "/fake/bwrap", "the relocated process");
	assert.equal(second.fd3, `tok-${B}-1`);
	assert.deepEqual(second.options.env, { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: loginDir(s.agentDir, B) });
	assert.equal(s.module.calls().length, 2);
});

test("a refusal, or a login without an access token, fails the worker; nothing runs unconfined", { timeout: 8000 }, async (t) => {
	const refused = setup(t, { refuse: "Sandbox: no" });
	await until(() => refused.runner.status === "error");
	assert.equal(refused.runner.error, "Sandbox: no");
	assert.equal(refused.children.length, 0);
	const empty = setup(t, { noToken: true });
	await until(() => empty.runner.status === "error");
	assert.match(empty.runner.error ?? "", /cannot start confined by the sandbox: the Claude login a@example.com has no access token/);
	assert.equal(empty.children.length, 0);
	assert.equal(empty.module.calls().length, 0);
	assert.deepEqual(empty.refreshed, [{ dir: loginDir(empty.agentDir, A) }], "a login with no token is refreshed first, then refused");
});

test("hosted: the host confines the launch itself; the runner hands it plain data and reads no token", { timeout: 8000 }, async (t) => {
	const s = setup(t, { hosted: true, systemPrompt: "be terse" });
	await until(() => s.children.length === 1);
	const child = s.children[0]!;
	assert.equal(child.command, "claude", "the host wraps it");
	assert.equal(s.module.calls().length, 0);
	const hosted = child.options.hosted;
	assert.equal(hosted.scope, "SCOPE");
	assert.deepEqual(hosted.token, { module: fileURLToPathOf("./accounts.ts"), dir: loginDir(s.agentDir, A), fd: TOKEN_FD, force: false });
	assert.equal(hosted.needs.tmpDir, path.join(s.root, "hosted-tmp"));
	assert.equal(hosted.needs.fds, undefined);
	assert.ok(hosted.dropEnv.includes("CLAUDE_CODE_OAUTH_TOKEN") && hosted.dropEnv.includes("CLAUDE_CONFIG_DIR"));
	assert.ok(!JSON.stringify(hosted).includes("tok-"), "no token in what crosses to the host");
	const file = child.argv[child.argv.indexOf("--append-system-prompt-file") + 1]!;
	assert.match(file, /^\/tmp\/pi-claude-[^/]+\/system\.md$/);
	assert.ok(fs.existsSync(path.join(s.root, "hosted-tmp", file.slice("/tmp/".length))), "written in the host's own tmp");
});

test("claudeNeeds: an over-long transcript folder name is refused; the private dir is released", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-needs-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const confine = { scope: "S", module: "/m", key: "sess-ag_01", agentDir: root };
	assert.throws(() => claudeNeeds({ confine, cwd: "/" + "x".repeat(250), login: { env: { CLAUDE_CONFIG_DIR: root } } }), /path is too long/);
	assert.throws(() => privateConfigDir(root, "../x"), /Not a worker key/);
	const needs = claudeNeeds({ confine, cwd: root, login: { env: { CLAUDE_CONFIG_DIR: path.join(root, "login") } }, env: { CLAUDE_CODE_OAUTH_TOKEN: "leak", ANTHROPIC_API_KEY: "leak", KEEP: "1" } });
	assert.equal(needs.env!.KEEP, "1");
	assert.ok(!JSON.stringify(needs).includes("leak"), "credentials in the worker's env never reach the inside");
	assert.deepEqual(needs.spawnEnv, { CLAUDE_CONFIG_DIR: path.join(root, "login") });
	releasePrivateConfigDir(root, "sess-ag_01");
	assert.ok(!fs.existsSync(privateConfigDir(root, "sess-ag_01")));
});

function fileURLToPathOf(rel: string): string { return new URL(rel, import.meta.url).pathname; }
void tick;

test("sweepPrivateConfigDirs: removes a worker's dir once its owner session file is gone (or its record, for this session); never a kept, fresh or still-owned one", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sweep-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sessions = path.join(root, "sessions");
	fs.mkdirSync(path.join(sessions, "--cwd--"), { recursive: true });
	fs.writeFileSync(path.join(sessions, "--cwd--", "2026-09-30T00-00-00-000Z_live-session.jsonl"), "");
	const now = Date.now();
	const old = (now - 2 * 24 * 3600_000) / 1000;
	const make = (key: string, fresh = false) => {
		const dir = privateConfigDir(root, key);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
		if (!fresh) { fs.utimesSync(path.join(dir, ".claude.json"), old, old); fs.utimesSync(dir, old, old); }
		return dir;
	};
	make("live-session-ag_01");
	make("deleted-session-ag_01");
	make("deleted-session-ag_02", true);
	make("deleted-session-ag_03");
	make("this-session-ag_01");
	make("this-session-ag_02");
	make("unsaved-999999999-x-ag_01");
	make("not-a-worker");
	const removed = sweepPrivateConfigDirs({
		agentDir: root, sessionDirs: [sessions], now,
		current: { key: "this-session", recorded: (id) => id === "ag_01" },
		keep: (key) => key === "deleted-session-ag_03",
		alive: () => false,
	}).sort();
	assert.deepEqual(removed, ["deleted-session-ag_01", "this-session-ag_02", "unsaved-999999999-x-ag_01"]);
	for (const kept of ["live-session-ag_01", "deleted-session-ag_02", "deleted-session-ag_03", "this-session-ag_01", "not-a-worker"]) {
		assert.ok(fs.existsSync(privateConfigDir(root, kept)), kept);
	}
});

test("a resume after the private config dir was swept starts on a fresh one, resuming the same Claude session (its transcript is in Claude Code's own projects/)", { timeout: 8000 }, async (t) => {
	const s = setup(t, { resume: SESSION });
	await until(() => s.children.length === 1);
	const child = s.children[0]!;
	assert.equal(child.argv[child.argv.indexOf("--resume") + 1], SESSION);
	const home = privateConfigDir(s.agentDir, "sess-w1");
	const slug = s.cwd.replace(/[^a-zA-Z0-9]/g, "-");
	assert.ok(fs.statSync(home).isDirectory(), "made again");
	assert.equal(fs.realpathSync(path.join(home, "projects", slug)), path.join(s.claudeDir, "projects", slug), "the record it resumes is reachable");
});
