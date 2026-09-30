/**
 * The unconfined worker launch, pinned: with the sandbox off and no worktree, a Claude worker's
 * command, argv, spawn options and environment are exactly these. Confinement (confined-launch.ts)
 * must leave this launch byte-identical; a change here is a change to every unconfined worker.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { registerClaudeCode } from "./index.ts";
import { ClaudeRunner, type ClaudeSpawnOptions } from "./runner.ts";
import { BACKEND_REGISTER_EVENT } from "../subagents/contracts.ts";

class Child extends EventEmitter {
	pid = 7331;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new Writable({ write: (_c, _e, cb) => cb() });
	kill() { return true; }
}
interface Spawned { command: string; args: string[]; options: any }

function backend() {
	const listeners = new Map<string, Set<(data: any) => void>>();
	const registrations: any[] = [];
	const hooks = new Map<string, Function>();
	const events = {
		on(name: string, handler: (data: any) => void) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
		emit(name: string, data: any) { for (const fn of listeners.get(name) ?? []) fn(data); },
	};
	events.on(BACKEND_REGISTER_EVENT, (b) => registrations.push(b));
	registerClaudeCode({ events, registerFlag() {}, getFlag: () => undefined, registerProvider() {}, unregisterProvider() {}, on: (name: string, hook: Function) => hooks.set(name, hook) } as any);
	return { b: registrations[0], shutdown: () => hooks.get("session_shutdown")?.() };
}

/** Launch one worker and capture its spawn; the private launch dir is normalized to <private>. */
async function launch(make: (spawnImpl: ClaudeSpawnOptions["spawnImpl"]) => ClaudeRunner): Promise<Spawned & { privateDir?: string }> {
	let spawned: Spawned | undefined;
	const child = new Child();
	const runner = make(((command: string, args: string[], options: any) => {
		spawned = { command, args: [...args], options };
		return child as unknown as ChildProcess;
	}) as any);
	await new Promise((resolve) => setImmediate(resolve));
	const closed = runner.dispose();
	child.emit("exit", 0, null); child.emit("close", 0, null);
	await closed;
	assert.ok(spawned, "spawned");
	const file = spawned.args.find((a) => /pi-claude-[^/]+\/(system\.md|mcp\.json)$/.test(a));
	const privateDir = file ? path.dirname(file) : undefined;
	return { ...spawned, args: privateDir ? spawned.args.map((a) => a.split(privateDir).join("<private>")) : spawned.args, privateDir };
}
const handlers = { onChange() {}, onSettled() {}, onExit() {} };
/** The environment every unconfined claude gets: the host's, minus the nested-session markers, plus `extra`. */
function hostEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
	return { ...env, ...extra };
}
const HEAD = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
	"--include-partial-messages", "--replay-user-messages"];

test("pin: a default Claude worker (sandbox off, no worktree) launches with exactly this argv and environment", async () => {
	const { b, shutdown } = backend();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pin-"));
	try {
		const prepared = b.prepare({ prompt: "task" }, { cwd, hasUI: false });
		const got = await launch((spawnImpl) => b.create({ ...prepared, id: "ag_01", groupId: "run_01", name: "agent", task: "task", cwd, spawnImpl }, handlers));
		assert.equal(got.command, "claude");
		assert.deepEqual(got.args, [...HEAD,
			"--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--setting-sources", "", "--strict-mcp-config",
			"--settings", '{"attribution":{"commit":"","pr":""}}',
			"--model", "sonnet", "--effort", "medium", "--tools", "Bash,Read,Edit,Write,Glob,Grep"]);
		assert.deepEqual(Object.keys(got.options).sort(), ["cwd", "detached", "env", "shell", "stdio"]);
		assert.equal(got.options.cwd, cwd);
		assert.equal(got.options.shell, false);
		assert.equal(got.options.detached, process.platform !== "win32");
		assert.deepEqual(got.options.stdio, ["pipe", "pipe", "pipe"]);
		assert.deepEqual(got.options.env, hostEnv(), "the host environment, markers dropped; the default login sets nothing");
		assert.equal(got.options.fds, undefined);
	} finally { await shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("pin: a team member with a system prompt, spec hooks, an MCP server and a resume keeps this argv; private files stay in os.tmpdir()", async () => {
	const { b, shutdown } = backend();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pin-"));
	try {
		const prepared = b.prepare({ prompt: "task", model: "opus", effort: "high", tools: ["Read", "Bash"], backendOptions: { permissionMode: "acceptEdits", allowedTools: ["Bash(git *)"] } }, { cwd, hasUI: false });
		const settingsJson = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node spec-hooks.ts stop" }] }] } });
		const mcpServers = { team: { command: "/usr/bin/node", args: ["member-mcp.ts"], env: { PI_MEMBER: "x" } } };
		const resume = "6c852daa-6abf-4bbd-9ef5-8950d9330968";
		const got = await launch((spawnImpl) => b.create({
			...prepared, systemPrompt: "be terse", settingsJson, mcpServers, env: { MCP_TOOL_TIMEOUT: "1000" },
			resume: { sessionId: resume }, id: "ag_02", groupId: "run_01", name: "member", task: "task", cwd, spawnImpl,
		}, handlers));
		assert.deepEqual(got.args, [...HEAD,
			"--permission-mode", "acceptEdits", "--permission-prompts", "host", "--setting-sources", "", "--strict-mcp-config",
			"--permission-prompt-tool", "stdio", "--resume", resume,
			"--settings", JSON.stringify({ ...JSON.parse(settingsJson), attribution: { commit: "", pr: "" } }),
			"--model", "opus", "--effort", "high", "--tools", "Read,Bash", "--allowedTools", "Bash(git *)", "mcp__team",
			"--append-system-prompt-file", "<private>/system.md", "--mcp-config", "<private>/mcp.json"]);
		assert.equal(path.dirname(got.privateDir!), os.tmpdir(), "the private launch dir is under os.tmpdir()");
		assert.deepEqual(got.options.env, hostEnv({ MCP_TOOL_TIMEOUT: "1000" }));
	} finally { await shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("pin: a worker on an added login names that login's directory in CLAUDE_CONFIG_DIR and nothing else changes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pin-"));
	const dir = path.join(os.tmpdir(), "pin-agent", "claude-accounts", "l-0000abcd");
	try {
		const got = await launch((spawnImpl) => new ClaudeRunner({
			id: "ag_03", groupId: "run_01", name: "w", task: "task", cwd, tools: [], spawnImpl,
			env: { CLAUDE_CONFIG_DIR: dir }, login: { id: "l-0000abcd", label: "second", env: { CLAUDE_CONFIG_DIR: dir } },
		}, handlers));
		assert.deepEqual(got.args, [...HEAD,
			"--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--setting-sources", "", "--strict-mcp-config",
			"--settings", '{"attribution":{"commit":"","pr":""}}', "--tools", ""]);
		assert.deepEqual(got.options.env, hostEnv({ CLAUDE_CONFIG_DIR: dir }));
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
