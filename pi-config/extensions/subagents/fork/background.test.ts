/**
 * The background-fork runner (background.ts) against a fake pi process: argv, environment,
 * extension order, settle. Run with the subagents runner (`node tests/run.mjs`).
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_FORK_ENV, decodeForkPoint } from "../../claude-code/provider/fork-point.ts";
import { CHILD_EXTENSION, claudeForkPointFor, startBackgroundFork, WORKER_MARK_EXTENSION } from "./background.ts";
import { decodePolicy, FORK_POLICY_ENV } from "./mirror.ts";

class FakeStream extends EventEmitter {
	push(chunk: string): void {
		this.emit("data", Buffer.from(chunk));
	}
}

class FakeChild extends EventEmitter {
	pid = 4242;
	stdin = Object.assign(new EventEmitter(), {
		writes: [] as string[],
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(chunk: string) {
			this.writes.push(String(chunk));
			return true;
		},
		end() {
			this.writableEnded = true;
		},
		destroy() {
			this.destroyed = true;
		},
	});
	stdout = new FakeStream();
	stderr = new FakeStream();
	kill(): boolean {
		queueMicrotask(() => this.emit("close", 0, null));
		return true;
	}
	lines(): any[] {
		return this.stdin.writes.map((line) => JSON.parse(line.replace(/\n$/, "")));
	}
	reply(id: string, data?: any): void {
		this.stdout.push(`${JSON.stringify({ id, type: "response", command: "reply", success: true, data })}\n`);
	}
}

/** The `-e` sources in argv order. */
function extensionArgs(args: string[]): string[] {
	return args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
}

const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a background fork forks the parent with the parent's tools, loads the marker first and child.ts last, and reports its outcome", async () => {
	const child = new FakeChild();
	const calls: { command: string; args: string[] }[] = [];
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	const settles: any[] = [];
	const handle = startBackgroundFork(
		{
			id: "vector-clocks-1",
			name: "explain",
			task: "write the page",
			cwd: process.cwd(),
			model: "zai/glm-5.3",
			effort: "high",
			forkSession: "/tmp/parent.jsonl",
			sessionDir: "/agent/explanations/.sessions/vector-clocks-1",
			policy: { label: "The /explain worker", web: true, writeDir: "/agent/explanations/vector-clocks-1" },
			spawnImpl: (command, args, options) => {
				calls.push({ command, args });
				envs.push(options.env);
				return child as unknown as ChildProcess;
			},
			timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
		},
		{ onSettled: (result) => settles.push(result) },
	);

	const args = calls[0].args;
	assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "rpc"]);
	// No tool flag of any kind: a changed tool set would cost the parent's prompt cache. child.ts
	// declares the parent's tools and restricts what runs at call time (mirror.ts).
	for (const flag of ["--tools", "--exclude-tools", "--no-tools", "--no-builtin-tools"]) assert.equal(args.includes(flag), false, flag);
	assert.ok(args.includes("--no-extensions"), "the child cannot spawn children of its own");
	assert.deepEqual(extensionArgs(args), [WORKER_MARK_EXTENSION, CHILD_EXTENSION], "the marker first, child.ts last");
	assert.deepEqual(decodePolicy(envs[0]?.[FORK_POLICY_ENV]), { label: "The /explain worker", web: true, writeDir: "/agent/explanations/vector-clocks-1" }, "the policy travels to child.ts");
	assert.equal(Object.keys(envs[0] ?? {}).some((name) => /PARENT_SESSION|STORE_DIR/.test(name)), false, "the cache key comes from the copy, not the environment");
	assert.deepEqual(args.slice(args.indexOf("--session-dir"), args.indexOf("--session-dir") + 2), ["--session-dir", "/agent/explanations/.sessions/vector-clocks-1"]);
	assert.equal(envs[0]?.[CLAUDE_FORK_ENV], undefined, "no Claude fork point for a pi model");
	assert.deepEqual(args.slice(args.indexOf("--fork"), args.indexOf("--fork") + 2), ["--fork", "/tmp/parent.jsonl"]);
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai/glm-5.3"]);
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);

	await flush();
	for (const line of child.lines()) {
		if (line.type === "get_state") child.reply(line.id, { sessionId: "child-1", sessionFile: "/tmp/child.jsonl", model: { provider: "zai", id: "glm-5.4" } });
	}
	await flush();
	for (const line of child.lines()) if (line.type === "prompt") child.reply(line.id);
	await flush();
	assert.ok(child.lines().some((line) => line.type === "prompt" && line.message === "write the page"));

	child.stdout.push(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "wrote the page" } })}\n`);
	child.stdout.push(`${JSON.stringify({ type: "agent_settled" })}\n`);
	await flush();

	assert.equal(settles.length, 1);
	assert.equal(settles[0].outcome, "success");
	assert.equal(settles[0].model, "zai/glm-5.4");
	assert.equal(settles[0].finalOutput.includes("wrote the page"), true);
	assert.equal(handle.sessionId, "child-1");
	assert.equal(handle.sessionFile, "/tmp/child.jsonl");
	await handle.stop();
	await flush();
	assert.equal(settles.length, 1, "teardown after a recorded run does not settle twice");
});

test("the worker marker is loaded first, before web search", () => {
	assert.ok(WORKER_MARK_EXTENSION.endsWith(join("subagents", "worker-mark.ts")));
	assert.ok(existsSync(WORKER_MARK_EXTENSION), "resolved from background.ts's own location");
	assert.ok(existsSync(CHILD_EXTENSION));
	const calls: string[][] = [];
	const child = new FakeChild();
	const handle = startBackgroundFork(
		{
			id: "x-1",
			name: "explain",
			task: "t",
			cwd: process.cwd(),
			policy: { label: "x" },
			extensions: ["/agent/npm/node_modules/pi-web-access"],
			spawnImpl: (_command, args) => {
				calls.push(args);
				return child as unknown as ChildProcess;
			},
			timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
		},
		{ onSettled: () => {} },
	);
	assert.deepEqual(extensionArgs(calls[0]), [WORKER_MARK_EXTENSION, "/agent/npm/node_modules/pi-web-access", CHILD_EXTENSION], "mark first, like every subagents pi worker");
	void handle.stop();
});

test("a claude-code-cli model loads the claude-code extension last, with its provider flag; other models load neither", () => {
	const fork = { v: 1 as const, claudeSessionId: "3708bfa3-4e74-5f1f-a32e-cd209e9231e1", messages: 4, prefix: "abc", cwd: "/repo" };
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	const argvFor = (model: string): string[] => {
		const calls: string[][] = [];
		const handle = startBackgroundFork(
			{
				id: "cc-1",
				name: "explain",
				task: "t",
				cwd: process.cwd(),
				model,
				policy: { label: "x" },
				forkSession: "/tmp/copy.jsonl",
				claudeFork: fork,
				extensions: ["/agent/npm/node_modules/pi-web-access"],
				spawnImpl: (_command, args, options) => {
					calls.push(args);
					envs.push(options.env);
					return new FakeChild() as unknown as ChildProcess;
				},
				timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
			},
			{ onSettled: () => {} },
		);
		void handle.stop();
		return calls[0];
	};
	const claudeCode = join(realpathSync(fileURLToPath(new URL("../../claude-code", import.meta.url))), "index.ts");
	const scoped = argvFor("claude-code-cli/opus[1m]");
	assert.deepEqual(extensionArgs(scoped), [WORKER_MARK_EXTENSION, "/agent/npm/node_modules/pi-web-access", claudeCode, CHILD_EXTENSION], "the claude-code extension by real path, then child.ts");
	assert.ok(scoped.includes("--claude-code-provider"));
	assert.deepEqual(decodeForkPoint(envs[0]?.[CLAUDE_FORK_ENV]), fork, "the fork point travels in the environment");
	const plain = argvFor("zai/glm-5.3");
	assert.deepEqual(extensionArgs(plain), [WORKER_MARK_EXTENSION, "/agent/npm/node_modules/pi-web-access", CHILD_EXTENSION]);
	assert.equal(plain.includes("--claude-code-provider"), false);
	assert.equal(plain.some((arg) => arg.endsWith(join("claude-code", "index.ts"))), false);
});

test("a Claude fork point travels only with a fork to resume, and only a claude-code-cli model looks for one", () => {
	const fork = { v: 1 as const, claudeSessionId: "3708bfa3-4e74-5f1f-a32e-cd209e9231e1", messages: 4, prefix: "abc", cwd: "/repo" };
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	const handle = startBackgroundFork(
		{
			id: "cc-2",
			name: "explain",
			task: "t",
			cwd: process.cwd(),
			model: "claude-code-cli/opus",
			policy: { label: "x" },
			claudeFork: fork,
			spawnImpl: (_command, _args, options) => {
				envs.push(options.env);
				return new FakeChild() as unknown as ChildProcess;
			},
			timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
		},
		{ onSettled: () => {} },
	);
	void handle.stop();
	assert.equal(envs[0]?.[CLAUDE_FORK_ENV], undefined, "an unforked child has no parent conversation to resume");

	const registry = Symbol.for("sova.claude-code.session-bridge");
	const host = globalThis as unknown as Record<symbol, unknown>;
	const saved = host[registry];
	host[registry] = { bridge: { forkPoint: (id: string) => (id === "parent" ? fork : undefined) } };
	try {
		assert.deepEqual(claudeForkPointFor("claude-code-cli/opus", "parent"), fork);
		assert.equal(claudeForkPointFor("zai/glm-5.3", "parent"), undefined, "a pi model never resumes a Claude session");
		assert.equal(claudeForkPointFor(undefined, "parent"), undefined);
		assert.equal(claudeForkPointFor("claude-code-cli/opus", "other"), undefined);
	} finally {
		if (saved === undefined) delete host[registry];
		else host[registry] = saved;
	}
});
