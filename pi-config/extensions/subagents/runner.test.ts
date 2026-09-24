/**
 * Lifecycle tests for SubagentRunner, using a fake child process injected via
 * the spawnImpl seam plus local Node fake CLIs. No real pi processes are spawned. Run with:
 *
 *   node tests/run.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_TOOLS, getPiInvocation, PI_PACKAGE, type SpawnOptions, SubagentRunner } from "./runner.ts";

for (const exitMode of ["natural", "term", "kill"]) test(`detached pipe holder cannot hang Pi closure (${exitMode})`, { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const naturalExit = exitMode === "natural";
	let child: ChildProcess | undefined; let descendant: number | undefined;
	let settled = 0; let exits = 0; let leaderExited = false;
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const script = `
		const {spawn}=require('node:child_process');
		const gc=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)"],{detached:true,stdio:['ignore','inherit','inherit','ipc']});
		gc.once('message',()=>{process.send(gc.pid);gc.disconnect();gc.unref();});
		process.stdin.resume();
		if (${exitMode === "kill"}) process.on('SIGTERM',()=>{});
		process.on('message',()=>process.exit(7));
	`;
	const runner = new SubagentRunner({ id: "pipe-test", groupId: "g", name: "fake", task: "wait", cwd: "/tmp",
		timings: { requestTimeoutMs: 2000, abortGraceMs: 20, termGraceMs: 20, pipeDrainMs: 100 },
		spawnImpl: (_command, _args, opts) => {
			child = spawn(process.execPath, ["-e", script], { ...opts, stdio: ["pipe", "pipe", "pipe", "ipc"] });
			child.on("message", (pid) => { descendant = Number(pid); });
			child.on("exit", () => { leaderExited = true; });
			return child;
		},
	}, { onChange() {}, onSettled() { settled++; }, onExit() { exits++; } });
	t.after(async () => {
		if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
		if (child && !leaderExited) child.kill("SIGKILL");
		await runner.whenClosed;
	});
	for (let i = 0; i < 150 && !descendant; i++) await pause(10);
	assert.ok(descendant);
	let completed = false;
	if (naturalExit) child!.send("exit"); else void runner.kill();
	void runner.whenClosed.then(() => { completed = true; });
	for (let i = 0; i < 150 && !leaderExited; i++) await pause(5);
	assert.equal(leaderExited, true);
	assert.equal(runner.processAlive, false); assert.equal(runner.isFinished(), false);
	assert.equal(completed, false); assert.equal(settled, 0);
	assert.equal((await runner.steer("must not write to dead leader")).ok, false);
	await runner.whenClosed;
	assert.equal(runner.status, naturalExit ? "error" : "killed");
	assert.equal(child!.signalCode, naturalExit ? null : exitMode === "kill" ? "SIGKILL" : "SIGTERM");
	assert.equal(settled, 1); assert.equal(exits, 1);
	assert.equal(child!.stdout!.destroyed, true); assert.equal(child!.stderr!.destroyed, true);
	assert.equal(process.kill(descendant!, 0), true, "detached descendant is outside containment");
});

// ── fake child ─────────────────────────────────────────────────────────────

class FakeStdin extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	writable = true;
	writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(String(chunk));
		return true;
	}
	end(): void {
		this.writableEnded = true;
	}
}

class FakeStream extends EventEmitter {
	push(chunk: Buffer | string): void {
		this.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
}

class FakeChild extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	stdin = new FakeStdin();
	stdout = new FakeStream();
	stderr = new FakeStream();
	killSignals: string[] = [];
	/** Ignore SIGTERM (but never SIGKILL) — for escalation tests. */
	ignoreSigterm = false;

	kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
		this.killSignals.push(sig);
		if (this.ignoreSigterm && sig !== "SIGKILL") return true;
		this.killed = true;
		queueMicrotask(() => this.close(null, sig));
		return true;
	}

	close(code: number | null, signal: string | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdin.destroyed = true;
		this.emit("close", code, signal);
	}

	sentLines(): any[] {
		return this.stdin.writes.map((line) => JSON.parse(line.replace(/\n$/, "")));
	}

	reply(id: string, success: boolean, data?: any, error?: string): void {
		this.stdout.push(`${JSON.stringify({ id, type: "response", command: "reply", success, data, error })}\n`);
	}

	event(event: Record<string, unknown>): void {
		this.stdout.push(`${JSON.stringify(event)}\n`);
	}
}

// ── harness ────────────────────────────────────────────────────────────────

const TEST_TIMINGS = {
	requestTimeoutMs: 300,
	abortGraceMs: 25,
	termGraceMs: 40,
	disposeAbortMs: 20,
	disposeTermMs: 20,
};

interface Harness {
	runner: SubagentRunner;
	child: FakeChild;
	spawnCalls: { command: string; args: string[]; opts: any }[];
	counts: { change: number; settled: number; exits: number; snapshots: any[] };
}

function makeRunner(options: Partial<SpawnOptions> = {}): Harness {
	const child = new FakeChild();
	const spawnCalls: { command: string; args: string[]; opts: any }[] = [];
	const counts = { change: 0, settled: 0, exits: 0, snapshots: [] as any[] };
	const runner = new SubagentRunner(
		{
			id: "ag_01",
			groupId: "run_01",
			name: "test",
			task: "count to three",
			cwd: process.cwd(),
			spawnImpl: (command, args, opts) => {
				spawnCalls.push({ command, args, opts });
				return child as unknown as ChildProcess;
			},
			timings: TEST_TIMINGS,
			...options,
		},
		{
			onChange: () => counts.change++,
			onSettled: (r) => {
				counts.settled++;
				// Snapshot what the callback actually observed, not just the count.
				counts.snapshots.push({ status: r.status, taskOutcome: r.taskOutcome, finalOutput: r.finalOutput() });
			},
			onExit: () => counts.exits++,
		},
	);
	return { runner, child, spawnCalls, counts };
}

const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface BootOptions {
	state?: boolean;
	stateData?: any;
	prompt?: boolean;
	promptError?: string;
}

/** Answer the child's get_state and initial prompt requests. */
async function boot(child: FakeChild, opts: BootOptions = {}): Promise<void> {
	await flush();
	for (const line of child.sentLines()) {
		if (line.type === "get_state") {
			child.reply(
				line.id,
				opts.state ?? true,
				opts.stateData ?? {
					sessionId: "sess-1",
					sessionFile: "/tmp/sess-1.jsonl",
					model: null,
					thinkingLevel: "medium",
				},
			);
		}
	}
	await flush();
	for (const line of child.sentLines()) {
		if (line.type === "prompt") child.reply(line.id, opts.prompt ?? true, undefined, opts.promptError);
	}
	await flush();
}

function assistant(child: FakeChild, text: string, extra: Record<string, unknown> = {}): void {
	child.event({
		type: "message_end",
		message: {
			role: "assistant",
			content: text,
			usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } },
			...extra,
		},
	});
}

function settle(child: FakeChild): void {
	child.event({ type: "agent_settled" });
}

async function lastSteerLine(child: FakeChild): Promise<any> {
	await flush();
	const prompts = child.sentLines().filter((l) => l.type === "prompt");
	return prompts[prompts.length - 1];
}

/** Always finish the runner so no test leaks timers. */
async function fin(h: Harness): Promise<void> {
	await h.runner.dispose().catch(() => {});
	await flush();
}

// ── spawn configuration ────────────────────────────────────────────────────

test("spawn args: model, effort, tools, no-extensions, system prompt", async () => {
	const h = makeRunner({ model: "zai/glm-5.2", effort: "high", tools: ["read", "grep"], systemPrompt: "be terse" });
	await boot(h.child);
	const args = h.spawnCalls[0].args;
	assert.ok(args.includes("--mode") && args.includes("rpc"));
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai/glm-5.2"]);
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep"]);
	assert.ok(args.includes("--no-extensions"));
	const sysIdx = args.indexOf("--append-system-prompt");
	assert.ok(sysIdx !== -1 && args[sysIdx + 1].endsWith("system.md"));
	assert.equal(h.runner.status, "running");
	await fin(h);
});

test("getPiInvocation re-invokes argv[1] only when that script belongs to pi itself", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-invocation-"));
	try {
		// A host that loads this extension inside its own process (Sova's server): argv[1] exists
		// but it is not pi, so the worker must be the real `pi` — re-running that file is what killed
		// every pi-backend worker spawned from a Sova-hosted session.
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "sova" }));
		const host = path.join(root, "server.ts");
		await writeFile(host, "");
		assert.deepEqual(getPiInvocation(["--mode", "rpc"], host), { command: "pi", args: ["--mode", "rpc"] });

		// pi itself: re-invoke this script under this runtime.
		const piDir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
		await mkdir(path.join(piDir, "dist"), { recursive: true });
		await writeFile(path.join(piDir, "package.json"), JSON.stringify({ name: PI_PACKAGE }));
		const cli = path.join(piDir, "dist", "cli.js");
		await writeFile(cli, "");
		assert.deepEqual(getPiInvocation(["--mode", "rpc"], cli), { command: process.execPath, args: [cli, "--mode", "rpc"] });

		// A script that is not there at all is never re-invoked (the shipped example's own rule).
		assert.deepEqual(getPiInvocation([], path.join(root, "gone.js")), { command: "pi", args: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("env is merged over the parent's environment only when given", async () => {
	const withEnv = makeRunner({ env: { PI_SUBAGENTS_TEAM_MEMBER: "{\"version\":1}" } });
	await boot(withEnv.child);
	assert.equal(withEnv.spawnCalls[0].opts.env.PI_SUBAGENTS_TEAM_MEMBER, "{\"version\":1}");
	assert.equal(withEnv.spawnCalls[0].opts.env.PATH, process.env.PATH, "the child keeps the parent's environment");
	await fin(withEnv);
	const plain = makeRunner({});
	await boot(plain.child);
	assert.equal("env" in plain.spawnCalls[0].opts, false, "no env option means Node's default inheritance");
	await fin(plain);
});

test("empty tools allowlist uses --no-tools, absent tools uses no flag", async () => {
	const empty = makeRunner({ tools: [] });
	await boot(empty.child);
	assert.ok(empty.spawnCalls[0].args.includes("--no-tools"));
	assert.ok(!empty.spawnCalls[0].args.includes("--tools"));
	await fin(empty);

	const absent = makeRunner({});
	await boot(absent.child);
	assert.ok(!absent.spawnCalls[0].args.some((a) => a === "--no-tools" || a === "--tools"));
	await fin(absent);
});

test("resume reopens the worker's own session file idle: --session, never --fork, no prompt, no completion", async () => {
	const h = makeRunner({ resume: { sessionFile: "/tmp/w.jsonl" }, forkSession: "/tmp/parent.jsonl" });
	try {
		const args = h.spawnCalls[0].args;
		assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "/tmp/w.jsonl"]);
		assert.ok(!args.includes("--fork"));
		await boot(h.child, { stateData: { sessionId: "w", sessionFile: "/tmp/w.jsonl", model: null, thinkingLevel: "low" } });
		assert.deepEqual(h.child.sentLines().map((l) => l.type), ["get_state"], "never a prompt: it never auto-continues");
		assert.equal(h.runner.status, "waiting");
		assert.equal(h.runner.isSettled(), true);
		assert.equal(h.runner.taskOutcome, undefined);
		assert.equal(h.counts.settled, 0, "no completion is re-emitted");
		assert.equal((h.runner as { usageScope?: string }).usageScope, undefined, "pi counts only this process's spend: the manager adds the earlier spend as a base");
		assert.ok(!h.runner.transcript.some((t) => t.kind === "task"), "the old task is not presented as sent");
		// Steering an idle resumed worker is a fresh prompt, and its settle is announced normally.
		const p = h.runner.steer("continue");
		const line = await lastSteerLine(h.child);
		h.child.reply(line.id, true);
		assert.deepEqual(await p, { ok: true });
		assistant(h.child, "done again");
		settle(h.child);
		await flush();
		assert.equal(h.counts.settled, 1);
		assert.equal(h.runner.finalOutput(), "done again");
	} finally {
		await fin(h);
	}
});

test("resume without an absolute session file fails without spawning and without a completion", async () => {
	for (const resume of [{}, { sessionFile: "relative.jsonl" }]) {
		const h = makeRunner({ resume });
		await flush();
		assert.equal(h.spawnCalls.length, 0);
		assert.equal(h.runner.status, "error");
		assert.match(h.runner.error!, /no absolute pi session file/);
		assert.equal(h.counts.settled, 0);
		await fin(h);
	}
});

test("a resumed worker that dies before it is ready emits no completion", async () => {
	const h = makeRunner({ resume: { sessionFile: "/tmp/w.jsonl" } });
	await flush();
	h.child.close(1);
	await flush();
	assert.equal(h.runner.status, "error");
	assert.equal(h.counts.settled, 0);
	assert.equal(h.counts.exits, 1);
	await fin(h);
});

test("extensions and forkSession become -e and --fork child args after --no-extensions", async () => {
	const h = makeRunner({ extensions: ["npm:pi-web-access", "/tmp/ext.ts"], forkSession: "/tmp/parent.jsonl" });
	try {
		const args = h.spawnCalls[0].args;
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.indexOf("-e") > args.indexOf("--no-extensions"));
		assert.deepEqual(
			args.filter((_, i) => args[i - 1] === "-e"),
			["npm:pi-web-access", "/tmp/ext.ts"],
		);
		assert.deepEqual(args.slice(args.indexOf("--fork"), args.indexOf("--fork") + 2), ["--fork", "/tmp/parent.jsonl"]);
		assert.equal(h.runner.forked, true);
		assert.equal(h.runner.wake, true);
		assert.deepEqual(h.runner.extensions, ["npm:pi-web-access", "/tmp/ext.ts"]);
		const plain = makeRunner({ wake: false });
		assert.ok(!plain.spawnCalls[0].args.some((a) => a === "-e" || a === "--fork"));
		assert.equal(plain.runner.wake, false);
		plain.child.close(0);
		await plain.runner.whenClosed;
	} finally {
		h.child.close(0);
		await h.runner.whenClosed;
	}
});

test("with extensions, built-ins are restricted by exclusion so extension tools survive", async () => {
	const some = makeRunner({ extensions: ["npm:x"], tools: ["read", "grep"] });
	const none = makeRunner({ extensions: ["npm:x"], tools: [] });
	const all = makeRunner({ extensions: ["npm:x"], tools: [...BUILTIN_TOOLS] });
	try {
		const a = some.spawnCalls[0].args;
		assert.ok(!a.includes("--tools") && !a.includes("--no-tools"));
		assert.deepEqual(a.slice(a.indexOf("--exclude-tools"), a.indexOf("--exclude-tools") + 2), [
			"--exclude-tools",
			"bash,powershell,edit,write,find,ls",
		]);
		const b = none.spawnCalls[0].args;
		assert.ok(b.includes("--no-builtin-tools") && !b.includes("--no-tools"));
		const c = all.spawnCalls[0].args;
		assert.ok(!c.some((x) => x === "--tools" || x === "--exclude-tools" || x === "--no-tools" || x === "--no-builtin-tools"));
	} finally {
		for (const h of [some, none, all]) {
			h.child.close(0);
			await h.runner.whenClosed;
		}
	}
});

test("allowNestedExtensions drops --no-extensions", async () => {
	const h = makeRunner({ allowNestedExtensions: true });
	await boot(h.child);
	assert.ok(!h.spawnCalls[0].args.includes("--no-extensions"));
	await fin(h);
});

test("system prompt temp write failure fails closed (no spawn)", async () => {
	const h = makeRunner({ systemPrompt: "important", tmpDir: "/nonexistent/pi-subagent-test" });
	await flush();
	assert.equal(h.spawnCalls.length, 0, "must not spawn without its system prompt");
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /system prompt/i);
	assert.equal(h.runner.taskOutcome, "error");
	assert.equal(h.counts.settled, 1);
	assert.equal(h.counts.exits, 1);
	assert.ok(h.runner.isFinished());
	await fin(h);
});

// ── framing ────────────────────────────────────────────────────────────────

test("multi-byte UTF-8 split across chunks is reassembled", async () => {
	const h = makeRunner();
	await boot(h.child);
	const line = Buffer.from(
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "x🌍y" } })}\n`,
	);
	const emoji = Buffer.from("🌍");
	const split = line.indexOf(emoji) + 1; // split mid-codepoint
	h.child.stdout.push(line.subarray(0, split));
	h.child.stdout.push(line.subarray(split));
	await flush();
	assert.equal(h.runner.finalOutput(), "x🌍y");
	await fin(h);
});

test("U+2028 inside a JSON string is not treated as a line break", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.stdout.push(
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "a\u2028b" } })}\n`,
	);
	await flush();
	assert.equal(h.runner.finalOutput(), "a\u2028b");
	await fin(h);
});

test("CRLF stripped, blank lines and malformed JSON skipped", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.stdout.push("\r\n");
	h.child.stdout.push("this is not json\r\n");
	assistant(h.child, "still works");
	await flush();
	assert.equal(h.runner.finalOutput(), "still works");
	await fin(h);
});

test("final unterminated line is processed at stdout end", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.stdout.push(
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: "tail without newline" } }),
	);
	h.child.stdout.emit("end");
	await flush();
	assert.equal(h.runner.finalOutput(), "tail without newline");
	await fin(h);
});

// ── initial prompt acceptance ──────────────────────────────────────────────

test("get_state populates session id and actual model/effort", async () => {
	const h = makeRunner();
	await boot(h.child, {
		stateData: {
			sessionId: "s-9",
			sessionFile: "/tmp/s9.jsonl",
			model: { provider: "zai", id: "glm-5.2" },
			thinkingLevel: "high",
		},
	});
	assert.equal(h.runner.sessionId, "s-9");
	assert.equal(h.runner.sessionFile, "/tmp/s9.jsonl");
	assert.equal(h.runner.model, "zai/glm-5.2");
	assert.equal(h.runner.effort, "high");
	assert.equal(h.runner.pid, 4242);
	await fin(h);
});

test("get_state failure is tolerated; prompt still sent", async () => {
	const h = makeRunner();
	await boot(h.child, { state: false });
	assert.equal(h.runner.sessionId, undefined);
	assert.equal(h.runner.status, "running");
	await fin(h);
});

test("rejected initial prompt fails closed and terminates the child", async () => {
	const h = makeRunner();
	await boot(h.child, { prompt: false, promptError: "invalid model" });
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /invalid model/);
	assert.equal(h.runner.taskOutcome, "error");
	assert.ok(h.runner.processAlive, "teardown window: process still alive");
	assert.ok(!h.runner.isFinished(), "error status while alive is not finished");
	assert.ok(!h.runner.isSettled(), "waits must prove closure, not terminal status");
	await h.runner.whenClosed;
	assert.ok(h.child.killSignals.length >= 1, "child must be torn down");
	assert.equal(h.counts.exits, 1);
	assert.ok(h.runner.isFinished());
});

test("no response to initial prompt (timeout) fails closed", async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	await flush(); // answer get_state only
	for (const line of h.child.sentLines()) if (line.type === "get_state") h.child.reply(line.id, true, {});
	await flush(80); // let the prompt request time out
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /no response/);
	await h.runner.whenClosed;
	assert.equal(h.counts.exits, 1);
});

// ── task outcomes ──────────────────────────────────────────────────────────

test("clean settle parks in waiting with success outcome", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "done counting");
	settle(h.child);
	await flush();
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.error, undefined);
	assert.ok(h.runner.isSettled());
	assert.ok(!h.runner.isFinished());
	assert.equal(h.counts.settled, 1);
	await fin(h);
});

test("assistant failure marks the TASK failed while process parks steerable", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "partial", { errorMessage: "provider 500" });
	settle(h.child);
	await flush();
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "error");
	assert.equal(h.runner.error, "provider 500");
	assert.equal(h.runner.finalOutput(), "partial");
	assert.equal(h.counts.settled, 1);
	assert.equal(h.runner.isStopping(), false, "recoverable failure is steerable, not stopping");
	await fin(h);
});

test("aborted stopReason yields aborted outcome", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "", { stopReason: "aborted" });
	settle(h.child);
	await flush();
	assert.equal(h.runner.taskOutcome, "aborted");
	await fin(h);
});

test("transient failure then successful retry settles as success", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "", { errorMessage: "529 overloaded" });
	h.child.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" });
	h.child.event({ type: "auto_retry_end", success: true, attempt: 2 });
	assistant(h.child, "recovered answer");
	settle(h.child);
	await flush();
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.error, undefined);
	await fin(h);
});

test("final retry failure pins the error; missing finalError still fails generically", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "", { errorMessage: "529 overloaded" });
	h.child.event({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded_error" });
	settle(h.child);
	await flush();
	assert.equal(h.runner.taskOutcome, "error");
	assert.match(h.runner.error ?? "", /529/);
	await fin(h);

	const bare = makeRunner();
	await boot(bare.child);
	// No assistant errorMessage beforehand and no finalError: the retry failure
	// itself must still pin a generic task failure (it used to claim success).
	bare.child.event({ type: "auto_retry_end", success: false, attempt: 3 });
	settle(bare.child);
	await flush();
	assert.equal(bare.runner.taskOutcome, "error");
	assert.match(bare.runner.error ?? "", /auto-retry failed/);
	await fin(bare);
});

test("failed compaction settles as a task failure; aborted compaction does not; usage counted", async () => {
	const failed = makeRunner();
	await boot(failed.child);
	failed.child.event({
		type: "compaction_end",
		reason: "threshold",
		result: { usage: { input: 999, output: 10, totalTokens: 1009, cost: { total: 0.2 } } },
		aborted: false,
		errorMessage: "API quota exceeded",
	});
	failed.child.event({ type: "agent_settled" }); // settles with NO new assistant error
	await flush();
	assert.equal(failed.runner.taskOutcome, "error");
	assert.match(failed.runner.error ?? "", /quota/);
	assert.equal(failed.runner.usage.input, 999, "compaction model work counted");
	assert.equal(failed.runner.usage.cost, 0.2);
	await fin(failed);

	const aborted = makeRunner();
	await boot(aborted.child);
	assistant(aborted.child, "partial work");
	aborted.child.event({ type: "compaction_end", reason: "manual", result: null, aborted: true });
	aborted.child.event({ type: "agent_settled" });
	await flush();
	assert.equal(aborted.runner.taskOutcome, "success", "aborted compaction is not a task failure");
	await fin(aborted);
});

// ── steering ───────────────────────────────────────────────────────────────

test("steer from waiting sends a fresh prompt and clears stale outcome/error", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "first", { errorMessage: "boom" });
	settle(h.child);
	await flush();
	assert.equal(h.runner.taskOutcome, "error");

	const p = h.runner.steer("now do it this way");
	const line = await lastSteerLine(h.child);
	assert.equal(line.streamingBehavior, undefined, "idle agent gets a plain prompt");
	h.child.reply(line.id, true);
	assert.deepEqual(await p, { ok: true });

	assert.equal(h.runner.status, "running");
	assert.equal(h.runner.taskOutcome, undefined);
	assert.equal(h.runner.error, undefined);
	assert.equal(h.runner.steerCount, 1);
	assert.equal(h.runner.finalOutput(), "", "previous task's output is not the current answer");
	await fin(h);
});

test("steer while running uses streamingBehavior steer", async () => {
	const h = makeRunner();
	await boot(h.child);
	const p = h.runner.steer("redirect");
	const line = await lastSteerLine(h.child);
	assert.equal(line.streamingBehavior, "steer");
	h.child.reply(line.id, true);
	assert.equal((await p).ok, true);
	await fin(h);
});

test("rejected steer reports ok:false and changes nothing", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "answer");
	settle(h.child);
	await flush();

	const p = h.runner.steer("new plan");
	const line = await lastSteerLine(h.child);
	h.child.reply(line.id, false, undefined, "message too long");
	const result = await p;
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /too long/);
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.steerCount, 0);
	await fin(h);
});

test("steer retries with the opposite streaming variant on streaming-mismatch errors", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "answer");
	settle(h.child);
	await flush();

	const p = h.runner.steer("again");
	const first = await lastSteerLine(h.child);
	h.child.reply(first.id, false, undefined, "Agent is streaming; streamingBehavior required");
	await flush();
	const second = await lastSteerLine(h.child);
	assert.notEqual(second.id, first.id);
	assert.equal(second.streamingBehavior, "steer");
	h.child.reply(second.id, true);
	assert.equal((await p).ok, true);
	await fin(h);
});

test("regression: fast child completes the steered task BEFORE the ACK", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "original answer");
	settle(h.child);
	await flush();
	assert.equal(h.runner.status, "waiting");

	const p = h.runner.steer("new task");
	const line = await lastSteerLine(h.child);
	// The child races ahead of its own ACK: the full new task first.
	h.child.event({ type: "agent_start" });
	assistant(h.child, "NEW output");
	settle(h.child);
	await flush();
	// The settle was processed under the ARMED new task — completion announced
	// with the new output, parked in waiting, even before the ACK.
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.finalOutput(), "NEW output");
	h.child.reply(line.id, true);
	assert.deepEqual(await p, { ok: true });
	// Post-ACK nothing resets: the completed new task stands.
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.finalOutput(), "NEW output");
	const snap = h.counts.snapshots[h.counts.snapshots.length - 1];
	assert.equal(snap.status, "waiting");
	assert.equal(snap.taskOutcome, "success");
	assert.equal(snap.finalOutput, "NEW output");
	await fin(h);
});

test("regression: ACK and the whole new task in ONE stdout chunk (normal order)", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "original answer");
	settle(h.child);
	await flush();

	const p = h.runner.steer("new task");
	const line = await lastSteerLine(h.child);
	// consume() parses all lines of a chunk synchronously; the steer's await
	// continuation runs only afterwards — so ACK-first-in-chunk still races.
	h.child.stdout.push(
		[
			JSON.stringify({ id: line.id, type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: "SAME CHUNK output" } }),
			JSON.stringify({ type: "agent_settled" }),
		].join("\n") + "\n",
	);
	assert.deepEqual(await p, { ok: true });
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.finalOutput(), "SAME CHUNK output");
	const snap = h.counts.snapshots[h.counts.snapshots.length - 1];
	assert.equal(snap.status, "waiting");
	assert.equal(snap.taskOutcome, "success");
	assert.equal(snap.finalOutput, "SAME CHUNK output");
	await fin(h);
});

test("queued steer: old output after the marker is not exposed as the new task's", async () => {
	const h = makeRunner();
	await boot(h.child); // initial task running
	const p = h.runner.steer("redirect");
	const line = await lastSteerLine(h.child);
	// The old task streams its answer AFTER the provisional marker, then settles.
	assistant(h.child, "old late answer");
	settle(h.child);
	await flush();
	assert.equal(h.counts.settled, 1);
	h.child.reply(line.id, true);
	assert.equal((await p).ok, true);
	// Between old completion and new run: the old answer is the last completed
	// task's output — correct.
	assert.equal(h.runner.finalOutput(), "old late answer");
	assert.equal(h.runner.taskOutcome, "success");
	// New run starts: fresh boundary — no stale answer, outcome, or error.
	h.child.event({ type: "agent_start" });
	assert.equal(h.runner.status, "running");
	assert.equal(h.runner.finalOutput(), "", "old answer not exposed as new");
	assert.equal(h.runner.taskOutcome, undefined);
	assert.equal(h.runner.error, undefined);
	// New completion announces separately with fresh output.
	assistant(h.child, "fresh answer");
	settle(h.child);
	await flush();
	assert.equal(h.counts.settled, 2);
	assert.equal(h.runner.finalOutput(), "fresh answer");
	assert.equal(h.runner.taskOutcome, "success");
	await fin(h);
});

test("explicit rejection after the old task settled keeps its completion", async () => {
	const h = makeRunner();
	await boot(h.child);
	const p = h.runner.steer("redirect");
	const line = await lastSteerLine(h.child);
	settle(h.child); // old task settles while we ask
	await flush();
	assert.equal(h.counts.settled, 1);
	h.child.reply(line.id, false, undefined, "nope");
	const result = await p;
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /nope/);
	assert.equal(h.counts.settled, 1, "no duplicate announcement");
	assert.equal(h.runner.status, "waiting");
	assert.equal(h.runner.taskOutcome, "success");
	assert.equal(h.runner.steerCount, 0);
	assert.ok(!h.runner.transcript.some((t) => t.kind === "steer"), "rejected steer leaves no marker");
	await fin(h);
});

test("a second steer while acceptance is pending is rejected", async () => {
	const h = makeRunner();
	await boot(h.child);
	const first = h.runner.steer("one");
	await lastSteerLine(h.child);
	const second = await h.runner.steer("two");
	assert.equal(second.ok, false);
	assert.match(second.reason ?? "", /another steer/);
	const line = await lastSteerLine(h.child);
	h.child.reply(line.id, true);
	assert.equal((await first).ok, true);
	assert.equal(h.runner.steerCount, 1);
	await fin(h);
});

for (const mode of ["redirect", "followUp"] as const) {
	for (const reply of ["accept", "reject", "missing"] as const) {
		test(`cancel in-flight ${mode} wait without stopping worker (${reply} ACK)`, { timeout: 2000 }, async () => {
			const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 100 } });
			try {
				await boot(h.child);
				const controller = new AbortController();
				const waiting = h.runner.steer("new instructions", controller.signal, mode);
				const line = await lastSteerLine(h.child);
				controller.abort();
				const result = await waiting;
				assert.equal(result.ok, false);
				assert.match(result.reason ?? "", /cancelled.*delivery unknown.*not stopped/);
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
				assert.equal(h.runner.status, "running");
				assert.equal(h.runner.taskOutcome, undefined);
				assert.equal(h.counts.settled, 0, "cancelling a wait is not task completion");
				assert.match((await h.runner.steer("duplicate")).reason ?? "", /awaiting acceptance/);
				if (reply !== "missing") h.child.reply(line.id, reply === "accept", undefined, "not allowed");
				await flush(120); // cancellation must not become a delayed timeout kill
				assert.equal(h.runner.processAlive, true);
				assert.deepEqual(h.child.killSignals, []);
				assert.ok(!h.child.sentLines().some(l => l.type === "abort"));
				assert.equal(h.runner.steerCount, reply === "reject" ? 0 : 1);
				assert.equal(h.runner.transcript.filter(t => t.kind === "steer").length, reply === "reject" ? 0 : 1);
				if (reply !== "reject") h.child.event({ type: "agent_start" });
				assistant(h.child, "actual output"); settle(h.child);
				assert.equal(h.runner.status, "waiting");
				assert.equal(h.runner.taskOutcome, "success");
				assert.equal(h.runner.finalOutput(), "actual output");
				assert.equal(h.counts.settled, 1);
				const next = h.runner.steer("another task");
				const nextLine = await lastSteerLine(h.child);
				h.child.reply(nextLine.id, true);
				assert.equal((await next).ok, true);
			} finally { await fin(h); }
		});
	}
}

test("cancelled idle steer preserves completion which races its late ACK", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		assistant(h.child, "old result"); settle(h.child);
		const controller = new AbortController();
		const waiting = h.runner.steer("new task", controller.signal);
		const line = await lastSteerLine(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "new result", { errorMessage: "actual task failure" }); settle(h.child);
		controller.abort();
		assert.equal((await waiting).ok, false);
		h.child.reply(line.id, true);
		await flush();
		assert.equal(h.counts.settled, 2);
		assert.equal(h.runner.status, "waiting");
		assert.equal(h.runner.taskOutcome, "error");
		assert.equal(h.runner.error, "actual task failure");
		assert.equal(h.runner.finalOutput(), "new result");
		assert.deepEqual(h.child.killSignals, []);
	} finally { await fin(h); }
});

test("cancelled steer reconciles streaming rejection without resending", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		assistant(h.child, "old result"); settle(h.child);
		const controller = new AbortController();
		const waiting = h.runner.steer("new task", controller.signal);
		const line = await lastSteerLine(h.child);
		controller.abort(); await waiting;
		h.child.reply(line.id, false, undefined, "Agent is streaming");
		await flush();
		assert.equal(h.child.sentLines().filter(l => l.type === "prompt").length, 2);
		assert.equal(h.runner.status, "waiting");
		assert.equal(h.runner.taskOutcome, "success");
		assert.equal(h.runner.finalOutput(), "old result");
		assert.equal(h.runner.steerCount, 0);
		assert.equal(h.counts.settled, 1);
	} finally { await fin(h); }
});

test("steer cancellation listeners are removed on ACK and pre-aborted steers send nothing", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		const before = h.child.sentLines().length;
		await assert.rejects(h.runner.steer("no send", AbortSignal.abort()), /abort/i);
		assert.equal(h.child.sentLines().length, before);
		assert.equal(h.runner.steerCount, 0);
		const controller = new AbortController();
		const waiting = h.runner.steer("accepted", controller.signal);
		const line = await lastSteerLine(h.child);
		h.child.reply(line.id, true);
		assert.equal((await waiting).ok, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(h.runner.status, "running");
		assert.deepEqual(h.child.killSignals, []);
	} finally { await fin(h); }
});

test("steer with no ACK fails closed as acceptance-unknown", async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	await boot(h.child);
	settle(h.child);
	await flush();
	const result = await h.runner.steer("into the void");
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /unknown/i);
	await h.runner.whenClosed;
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /acceptance unknown/);
	assert.ok(h.child.killSignals.length >= 1, "ambiguous delivery must stop the worker");
});

test("steer is rejected until the initial prompt is accepted", async () => {
	const h = makeRunner();
	// Phase 1: begin() still awaiting get_state — the initial prompt is not even submitted.
	const tooEarly = await h.runner.steer("too early");
	assert.equal(tooEarly.ok, false);
	assert.match(tooEarly.reason ?? "", /starting/);
	// Phase 2: initial prompt submitted, ACK still pending — the child's async
	// preflight could still race a second prompt, so steer stays rejected.
	await flush();
	for (const line of h.child.sentLines()) if (line.type === "get_state") h.child.reply(line.id, true, {});
	await flush(); // the prompt line is on the wire now
	assert.equal(h.runner.status, "running", "status leaves starting at submit");
	const beforeAck = await h.runner.steer("still too early");
	assert.equal(beforeAck.ok, false);
	assert.match(beforeAck.reason ?? "", /starting/);
	// Phase 3: the success ACK makes the runner steerable.
	for (const line of h.child.sentLines()) if (line.type === "prompt") h.child.reply(line.id, true);
	await flush();
	const p = h.runner.steer("now");
	const line = await lastSteerLine(h.child);
	h.child.reply(line.id, true);
	assert.equal((await p).ok, true);
	await fin(h);
});

test("steer is refused while starting, stopping, or finished", async () => {
	const starting = makeRunner();
	assert.equal((await starting.runner.steer("x")).ok, false);
	await boot(starting.child);
	await fin(starting);

	const h = makeRunner();
	await boot(h.child);
	assert.equal(h.runner.isStopping(), false);
	const killPromise = h.runner.kill();
	assert.equal(h.runner.status, "stopping");
	assert.equal(h.runner.isStopping(), true);
	assert.equal((await h.runner.steer("x")).ok, false);
	await killPromise;
	assert.equal(h.runner.status, "killed");
	assert.equal(h.runner.isStopping(), false, "finished, no longer stopping");
	assert.equal((await h.runner.steer("x")).ok, false);
	// Also during the fail-teardown window (error status, process alive).
	const f = makeRunner();
	await boot(f.child);
	f.child.stdin.emit("error", new Error("write EPIPE"));
	await flush();
	assert.equal(f.runner.status, "error");
	assert.equal(f.runner.isStopping(), true, "fail() teardown is advertised");
	assert.equal((await f.runner.steer("x")).ok, false);
	await f.runner.whenClosed;
	assert.equal(f.runner.isStopping(), false);
});

test("finalOutput is scoped to the current task after an accepted steer", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "old answer");
	settle(h.child);
	await flush();
	assert.equal(h.runner.finalOutput(), "old answer");

	const p = h.runner.steer("second task");
	const line = await lastSteerLine(h.child);
	h.child.reply(line.id, true);
	await p;
	assert.equal(h.runner.finalOutput(), "");
	assistant(h.child, "new answer");
	assert.equal(h.runner.finalOutput(), "new answer");
	await fin(h);
});

// ── kill / dispose ─────────────────────────────────────────────────────────

test("kill: stopping immediately, settle announced, resolves on close, then killed", async () => {
	const h = makeRunner();
	await boot(h.child);
	const killPromise = h.runner.kill("by test");
	assert.equal(h.runner.status, "stopping");
	assert.ok(!h.runner.isFinished());
	assert.ok(!h.runner.isSettled(), "stopping is not settled — waits prove closure");
	assert.equal(h.runner.taskOutcome, "aborted");
	assert.equal(h.counts.settled, 0, "onSettled deferred to actual closure");
	assert.ok(
		h.child.sentLines().some((l) => l.type === "abort"),
		"abort command sent first",
	);
	await killPromise;
	assert.equal(h.runner.status, "killed");
	assert.equal(h.counts.settled, 1, "announced once at closure");
	assert.equal(h.counts.snapshots[0].status, "killed", "callback saw the closed state");
	assert.ok(!h.runner.processAlive);
	assert.ok(h.runner.isSettled(), "settled once actually closed");
	assert.equal(h.runner.exitCode, null);
	assert.equal(h.runner.signal, "SIGTERM");
	assert.equal(h.counts.exits, 1);
	assert.ok(h.runner.isFinished());
	// Killing an already-dead runner resolves immediately, no double exit.
	await h.runner.kill();
	await h.runner.dispose();
	assert.equal(h.counts.exits, 1);
});

test("kill escalates SIGTERM → SIGKILL when the child ignores SIGTERM", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.ignoreSigterm = true;
	const killPromise = h.runner.kill();
	await flush(120); // abort(25) → SIGTERM(ignored) → SIGKILL at +40
	assert.deepEqual(h.child.killSignals, ["SIGTERM", "SIGKILL"]);
	h.child.close(null, "SIGKILL");
	await killPromise;
	assert.equal(h.runner.status, "killed");
	assert.equal(h.counts.exits, 1);
});

test("failed signals never prove Pi death or settle shutdown", async (t) => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, pipeDrainMs: 10 } });
	t.after(() => h.child.close(null, "SIGKILL"));
	await boot(h.child);
	h.child.kill = (signal = "SIGTERM") => { h.child.killSignals.push(signal); return false; };
	let closed = false; void h.runner.kill().then(() => { closed = true; });
	await flush(150);
	assert.deepEqual(h.child.killSignals, ["SIGTERM", "SIGKILL"]);
	assert.equal(h.runner.processAlive, true); assert.equal(h.runner.isFinished(), false);
	assert.equal(h.runner.isSettled(), false); assert.equal(closed, false);
	assert.equal(h.counts.settled, 0); assert.equal(h.counts.exits, 0);
	h.child.close(null, "SIGKILL"); await h.runner.whenClosed;
	assert.equal(h.counts.settled, 1); assert.equal(h.counts.exits, 1);
});

test("dispose uses the fast ladder and resolves on close", async () => {
	const h = makeRunner();
	await boot(h.child);
	const disposePromise = h.runner.dispose();
	assert.equal(h.runner.status, "stopping");
	await disposePromise;
	assert.equal(h.runner.status, "killed");
	assert.ok(h.child.sentLines().some((l) => l.type === "abort"));
	assert.equal(h.counts.exits, 1);
});

test("late agent_start/settled after kill cannot resurrect the runner", async () => {
	const h = makeRunner();
	await boot(h.child);
	const killPromise = h.runner.kill();
	h.child.event({ type: "agent_start" });
	h.child.event({ type: "agent_settled" });
	h.child.event({ type: "message_end", message: { role: "assistant", content: "ghost output" } });
	await flush();
	assert.equal(h.runner.status, "stopping");
	assert.equal(h.counts.settled, 0, "no announcement while stopping");
	assert.equal(h.runner.finalOutput(), "", "stale output dropped");
	await killPromise;
	assert.equal(h.runner.status, "killed");
	assert.equal(h.counts.settled, 1, "single announcement at closure");
});

test("killing an idle settled agent does not emit a second completion", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "done");
	settle(h.child);
	await flush();
	assert.equal(h.counts.settled, 1);
	await h.runner.kill();
	assert.equal(h.counts.settled, 1, "already-done task gets no second completion");
	assert.equal(h.runner.status, "killed");
	assert.equal(h.runner.taskOutcome, "success");
});

// ── process exit semantics ─────────────────────────────────────────────────

test("death by external signal is an error, not a success", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.close(null, "SIGKILL");
	await h.runner.whenClosed;
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /SIGKILL/);
	assert.equal(h.runner.taskOutcome, "error", "task died mid-flight");
	assert.equal(h.counts.settled, 1);
	assert.equal(h.counts.exits, 1);
});

test("nonzero exit code is an error; clean exit after settle is done", async () => {
	const crashed = makeRunner();
	await boot(crashed.child);
	crashed.child.close(3, null);
	await crashed.runner.whenClosed;
	assert.equal(crashed.runner.status, "error");
	assert.match(crashed.runner.error ?? "", /code 3/);
	assert.equal(crashed.runner.taskOutcome, "error");

	const clean = makeRunner();
	await boot(clean.child);
	settle(clean.child);
	await flush();
	clean.child.close(0, null);
	await clean.runner.whenClosed;
	assert.equal(clean.runner.status, "done");
	assert.equal(clean.runner.taskOutcome, "success");
	assert.equal(clean.counts.settled, 1);
});

test("duplicate close and post-close error fire exactly one exit", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.close(0, null);
	h.child.close(0, null);
	h.child.emit("error", new Error("late error"));
	await h.runner.whenClosed;
	assert.equal(h.counts.exits, 1);
	assert.equal(h.counts.settled, 1);
});

test("stdin pipe error while healthy fails closed", async () => {
	const h = makeRunner();
	await boot(h.child);
	h.child.stdin.emit("error", new Error("write EPIPE"));
	await flush();
	assert.equal(h.runner.status, "error");
	assert.ok(h.runner.processAlive, "teardown window: process still alive");
	assert.ok(!h.runner.isFinished(), "error while alive is not finished");
	assert.match(h.runner.error ?? "", /EPIPE/);
	// kill during the fail-teardown window still works and awaits closure.
	await h.runner.kill("cleanup after pipe error");
	assert.ok(h.runner.isFinished());
	assert.equal(h.counts.exits, 1);
});

test("in-flight steer resolves immediately when the process closes", async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 5000 } });
	await boot(h.child);
	settle(h.child);
	await flush();
	const steerPromise = h.runner.steer("too late");
	const line = await lastSteerLine(h.child);
	assert.ok(line, "steer prompt was sent");
	h.child.close(0, null);
	const started = Date.now();
	const result = await steerPromise;
	assert.ok(Date.now() - started < 1000, `resolved fast, not via timeout (${Date.now() - started}ms)`);
	assert.equal(result.ok, false);
});

// ── memory bounds ──────────────────────────────────────────────────────────

test("unterminated RPC line beyond the bound fails closed with SIGKILL", async () => {
	const h = makeRunner({ limits: { maxLineBytes: 1024 } });
	await boot(h.child);
	h.child.stdout.push(Buffer.alloc(600, 0x61));
	h.child.stdout.push(Buffer.alloc(600, 0x62)); // 1200 > 1024, no newline
	await h.runner.whenClosed;
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /RPC line exceeded/);
	assert.ok(h.child.killSignals.includes("SIGKILL"));
});

test("many valid lines in one chunk are all processed regardless of total size", async () => {
	const h = makeRunner({ limits: { maxLineBytes: 512 } });
	await boot(h.child);
	const lines: string[] = [];
	for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ type: "extension_error", error: `e${i}` }));
	h.child.stdout.push(`${lines.join("\n")}\n`); // far over 512 bytes TOTAL, each record tiny
	await flush();
	assert.equal(h.runner.status, "running", "the bound is per record, not per batch");
	assert.ok(
		h.runner.transcript.some((t) => t.kind === "error" && t.text === "e39"),
		"last line processed",
	);
	// But a single unterminated record beyond the bound still fails closed.
	h.child.stdout.push("x".repeat(600));
	await h.runner.whenClosed;
	assert.equal(h.runner.status, "error");
});

test("transcript tail is bounded in UTF-8 bytes with an omission marker", async () => {
	const h = makeRunner({ limits: { maxTranscriptBytes: 3000 } });
	await boot(h.child);
	// Each CJK char is 3 UTF-8 bytes but 1 UTF-16 code unit: 40 × 100 chars.
	for (let i = 0; i < 40; i++) assistant(h.child, "計".repeat(100));
	await flush();
	assert.ok(h.runner.transcriptOmitted.items > 0, "bytes-based trimming must trigger");
	assert.ok(h.runner.transcriptOmitted.approxBytes > 0);
	assert.equal(h.runner.transcript[0].kind, "task", "task item is never trimmed");
	assert.equal(h.runner.transcript[1].kind, "system");
	assert.match(h.runner.transcript[1].text, /trimmed/);
	let bytes = 0;
	for (const item of h.runner.transcript) bytes += Buffer.byteLength(item.text, "utf8");
	assert.ok(bytes <= 3000, `retained transcript must be within the cap (got ${bytes})`);
	await fin(h);
});

test("individual transcript items are truncated in memory", async () => {
	const h = makeRunner({ limits: { maxItemChars: 50 } });
	await boot(h.child);
	assistant(h.child, "y".repeat(500));
	await flush();
	const item = h.runner.transcript.find((t) => t.kind === "assistant");
	assert.ok(item);
	assert.ok(item.text.length < 200);
	assert.match(item.text, /truncated/);
	await fin(h);
});

test("transcriptRevision bumps on push, trim, and rollback splice", async () => {
	const h = makeRunner();
	await boot(h.child);
	const r0 = h.runner.transcriptRevision;
	assistant(h.child, "one");
	await flush();
	assert.equal(h.runner.transcriptRevision, r0 + 1, "one bump per push");

	// Trim path (marker rewrite) still yields exactly one bump per push.
	const tight = makeRunner({ limits: { maxTranscriptBytes: 3000 } });
	await boot(tight.child);
	const start = tight.runner.transcriptRevision;
	for (let i = 0; i < 40; i++) assistant(tight.child, "計".repeat(100)); // forces trims
	await flush();
	assert.equal(tight.runner.transcriptRevision, start + 40, "trim folded into the push bump");
	assert.ok(tight.runner.transcriptOmitted.items > 0);
	await fin(tight);

	// Rejected steer removes its marker — still a visible change, still a bump.
	settle(h.child);
	await flush();
	const beforeRollback = h.runner.transcriptRevision;
	const p = h.runner.steer("doomed");
	const line = await lastSteerLine(h.child);
	h.child.reply(line.id, false, undefined, "no");
	await p;
	assert.equal(h.runner.transcriptRevision, beforeRollback + 2, "arm push + rollback splice");
	await fin(h);
});

// ── usage accounting ───────────────────────────────────────────────────────

test("usage accumulates across assistant turns and tool results", async () => {
	const h = makeRunner();
	await boot(h.child);
	assistant(h.child, "one");
	h.child.event({
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } },
		},
	});
	assistant(h.child, "two");
	await flush();
	assert.equal(h.runner.usage.turns, 2);
	assert.equal(h.runner.usage.input, 21); // 2 × 10 + 1
	assert.equal(h.runner.usage.output, 12); // 2 × 5 + 2
	assert.equal(h.runner.usage.cost, 0.52); // 2 × 0.01 + 0.5
	assert.equal(h.runner.usage.contextTokens, 15);
	assert.equal(h.runner.unreadCount, 2);
	await fin(h);
});

// ── task boundaries across queued continuation (Pi 0.85 agent-session semantics) ──

/** Pi's user-message event for delivered prompts/steers. */
function userMessage(child: FakeChild, text: string): void {
	child.event({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
}

for (const mode of ["followUp", "redirect"] as const) {
	test(`failed run followed by Pi's queued continuation reports the failure (${mode})`, async () => {
		const h = makeRunner();
		try {
			await boot(h.child);
			h.child.event({ type: "agent_start" });
			const p = h.runner.steer("FOLLOW", undefined, mode);
			const line = await lastSteerLine(h.child);
			h.child.reply(line.id, true);
			assert.equal((await p).ok, true);
			// Non-retryable failure ends the run; Pi's post-run loop continues the queue.
			assistant(h.child, "partial", { stopReason: "error", errorMessage: "400 invalid request" });
			h.child.event({ type: "agent_end", messages: [], willRetry: false });
			h.child.event({ type: "agent_start" });
			userMessage(h.child, "FOLLOW");
			assistant(h.child, "follow-up done", { stopReason: "stop" });
			h.child.event({ type: "agent_end", messages: [], willRetry: false });
			settle(h.child);
			await flush();
			assert.equal(h.counts.settled, 1, "one session-level settle, one announcement");
			assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "error", finalOutput: "follow-up done" });
			assert.match(h.runner.error ?? "", /Earlier instructions failed.*400 invalid request/);
			assert.ok(h.runner.transcript.some((t) => t.kind === "error" && /400 invalid request.*continuing queued/.test(t.text)));
			// The next explicit task starts clean.
			const next = h.runner.steer("NEXT");
			h.child.reply((await lastSteerLine(h.child)).id, true);
			await next;
			h.child.event({ type: "agent_start" });
			assistant(h.child, "clean");
			settle(h.child);
			await flush();
			assert.equal(h.runner.taskOutcome, "success");
			assert.equal(h.runner.error, undefined);
		} finally { await fin(h); }
	});
}

test("continuation failure after a carried failure keeps both errors", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "", { stopReason: "error", errorMessage: "first failure" });
		h.child.event({ type: "agent_start" }); // extension-queued continuation, no steer armed
		assistant(h.child, "", { stopReason: "error", errorMessage: "second failure" });
		settle(h.child);
		await flush();
		assert.equal(h.runner.taskOutcome, "error");
		assert.match(h.runner.error ?? "", /first failure.*final run error: second failure/);
	} finally { await fin(h); }
});

test("auto-retry and overflow-compaction runs are recovery, not carried failures", async () => {
	for (const recovery of ["retry", "agent_end", "compaction"] as const) {
		const h = makeRunner();
		try {
			await boot(h.child);
			h.child.event({ type: "agent_start" });
			assistant(h.child, "", { stopReason: "error", errorMessage: "transient" });
			if (recovery === "retry") h.child.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "transient" });
			if (recovery === "agent_end") h.child.event({ type: "agent_end", messages: [], willRetry: true });
			if (recovery === "compaction") h.child.event({ type: "compaction_end", reason: "overflow", result: {}, aborted: false, willRetry: true });
			h.child.event({ type: "agent_start" });
			assistant(h.child, "recovered");
			settle(h.child);
			await flush();
			assert.equal(h.runner.taskOutcome, "success", recovery);
			assert.equal(h.runner.error, undefined);
			assert.ok(!h.runner.transcript.some((t) => /continuing queued/.test(t.text)));
		} finally { await fin(h); }
	}
});

test("exhausted retry followed by queued continuation is carried", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "", { stopReason: "error", errorMessage: "529" });
		h.child.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "529" });
		h.child.event({ type: "agent_start" });
		assistant(h.child, "", { stopReason: "error", errorMessage: "529 again" });
		h.child.event({ type: "auto_retry_end", success: false, attempt: 1, finalError: "529 again" });
		h.child.event({ type: "agent_start" });
		assistant(h.child, "queued work");
		settle(h.child);
		await flush();
		assert.equal(h.runner.taskOutcome, "error");
		assert.match(h.runner.error ?? "", /529 again/);
		assert.equal(h.runner.finalOutput(), "queued work");
	} finally { await fin(h); }
});

test("predecessor settle racing a steer marker announces the predecessor's own output", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "OLD ANSWER");
		await flush();
		const p = h.runner.steer("NEW TASK"); // the runner still believes Pi is running
		const line = await lastSteerLine(h.child);
		settle(h.child); // the old task's settle was already in flight
		await flush();
		assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "success", finalOutput: "OLD ANSWER" });
		h.child.reply(line.id, true);
		assert.equal((await p).ok, true);
		h.child.event({ type: "agent_start" });
		assert.equal(h.runner.finalOutput(), "", "the new run does not inherit the old answer");
		assistant(h.child, "NEW ANSWER");
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots[1], { status: "waiting", taskOutcome: "success", finalOutput: "NEW ANSWER" });
	} finally { await fin(h); }
});

// Transcript trimming may evict the armed steer marker; output boundaries must not depend on it.
for (const delivery of ["agent_start", "user message"] as const) {
	for (const next of ["empty", "new output"] as const) {
		test(`trimmed steer marker keeps the task output boundary (${delivery}, ${next})`, async () => {
			const h = makeRunner({ limits: { maxTranscriptBytes: 120 } });
			try {
				await boot(h.child);
				h.child.event({ type: "agent_start" });
				const p = h.runner.steer("NEW TASK");
				h.child.reply((await lastSteerLine(h.child)).id, true);
				assert.equal((await p).ok, true);
				// The predecessor keeps streaming after the provisional marker until it
				// is evicted; its answer is the newest surviving transcript item.
				h.child.event({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "echo evict" } });
				assistant(h.child, "PREDECESSOR ANSWER");
				assert.ok(!h.runner.transcript.some((t) => t.kind === "steer"), "steer marker was trimmed");
				assert.equal(h.runner.transcript.at(-1)?.text, "PREDECESSOR ANSWER");
				if (delivery === "agent_start") {
					settle(h.child); // predecessor settles first: its own output is announced
					await flush();
					assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "success", finalOutput: "PREDECESSOR ANSWER" });
					h.child.event({ type: "agent_start" });
				} else {
					userMessage(h.child, "NEW TASK");
				}
				assert.equal(h.runner.finalOutput(), "", "the new task does not inherit the predecessor's output");
				assert.equal(h.runner.transcript.at(-1)?.kind, "steer", "the boundary is shown again at the new run");
				if (next === "new output") assistant(h.child, "NEW ANSWER");
				else h.child.event({ type: "tool_execution_start", toolName: "bash", toolCallId: "t2", args: { command: "true" } });
				settle(h.child);
				await flush();
				assert.deepEqual(h.counts.snapshots.at(-1), {
					status: "waiting",
					taskOutcome: "success",
					finalOutput: next === "new output" ? "NEW ANSWER" : "",
				});
				assert.equal(h.counts.settled, delivery === "agent_start" ? 2 : 1);
			} finally { await fin(h); }
		});
	}
}

test("trimmed steer marker: predecessor output before the arm is not the pending steer's", async () => {
	const h = makeRunner({ limits: { maxTranscriptBytes: 120 } });
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "OLD ANSWER");
		const p = h.runner.steer("NEW TASK");
		h.child.reply((await lastSteerLine(h.child)).id, true);
		assert.equal((await p).ok, true);
		for (let i = 0; i < 3; i++) h.child.event({ type: "tool_execution_start", toolName: "bash", toolCallId: `t${i}`, args: { command: `step ${i}` } });
		assert.ok(!h.runner.transcript.some((t) => t.kind === "steer"), "steer marker was trimmed");
		// Before the predecessor settles, the armed steer is the boundary, as without trimming.
		assert.equal(h.runner.finalOutput(), "");
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "success", finalOutput: "OLD ANSWER" });
	} finally { await fin(h); }
});

test("steer delivered inside the running run moves the boundary without agent_start", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		const p = h.runner.steer("STEERED");
		h.child.reply((await lastSteerLine(h.child)).id, true);
		await p;
		assistant(h.child, "old output after the provisional marker");
		userMessage(h.child, "STEERED"); // delivered before the next LLM call
		assert.equal(h.runner.finalOutput(), "", "old output is not the steered task's answer");
		h.child.event({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "success", finalOutput: "" });
		const texts = h.runner.transcript.map((t) => `${t.kind}:${t.text}`);
		assert.ok(texts.indexOf("steer:STEERED") > texts.indexOf("assistant:old output after the provisional marker"));
	} finally { await fin(h); }
});

// Pi expands /skill: commands and prompt templates before queueing a streaming
// prompt: queue_update (sent before the ACK) and the delivered user message carry
// the expanded text, and Pi dequeues the entry right before that user message.

/** Pi's queue_update event. */
function queueUpdate(child: FakeChild, steering: string[], followUp: string[] = []): void {
	child.event({ type: "queue_update", steering, followUp });
}

const SKILL_BODY = '<skill name="review" location="/skills/review/SKILL.md">\nReview carefully.\n</skill>\n\ndo it';

/** Steer while Pi streams; Pi queues `expanded` (after `ahead`) before ACKing. */
async function queuedSteer(h: Harness, raw: string, queue: string[], mode?: "followUp"): Promise<void> {
	const p = h.runner.steer(raw, undefined, mode);
	const line = await lastSteerLine(h.child);
	if (mode === "followUp") queueUpdate(h.child, [], queue);
	else queueUpdate(h.child, queue);
	h.child.reply(line.id, true);
	assert.deepEqual(await p, { ok: true });
}

test("expanded /skill steer delivered in-run: a failed steered task does not inherit old output", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "OLD ANSWER");
		await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY);
		assert.equal(h.runner.finalOutput(), "", "boundary moved at the expanded delivery");
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.equal(h.counts.settled, 1);
		assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "error", finalOutput: "" });
		const texts = h.runner.transcript.map((t) => `${t.kind}:${t.text}`);
		assert.ok(texts.indexOf("steer:/skill:review do it") > texts.indexOf("assistant:OLD ANSWER"));
	} finally { await fin(h); }
});

test("expanded prompt-template follow-up delivered in-run starts a fresh task", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/fix auth", ["Fix the bug in auth. Add a regression test."], "followUp");
		assistant(h.child, "OLD ANSWER");
		queueUpdate(h.child, [], []);
		userMessage(h.child, "Fix the bug in auth. Add a regression test.");
		assert.equal(h.runner.finalOutput(), "");
		assistant(h.child, "FIXED");
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "success", finalOutput: "FIXED" }]);
	} finally { await fin(h); }
});

test("a same-text user message Pi did not dequeue is not the armed steer's delivery", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
		userMessage(h.child, SKILL_BODY); // e.g. the initial prompt or a replay: not from the queue
		assistant(h.child, "OLD ANSWER");
		assert.equal(h.runner.finalOutput(), "OLD ANSWER", "boundary not moved yet");
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY);
		assert.equal(h.runner.finalOutput(), "");
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
		const texts = h.runner.transcript.map((t) => `${t.kind}:${t.text}`);
		assert.ok(texts.indexOf("steer:/skill:review do it") > texts.indexOf("assistant:OLD ANSWER"));
	} finally { await fin(h); }
});

test("an earlier queued steer with the same expanded text does not start the armed steer", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/skill:review first", [SKILL_BODY]);
		await queuedSteer(h, "/skill:review second", [SKILL_BODY, SKILL_BODY]);
		queueUpdate(h.child, [SKILL_BODY]);
		userMessage(h.child, SKILL_BODY); // the FIRST steer
		assistant(h.child, "FIRST ANSWER");
		assert.equal(h.runner.finalOutput(), "FIRST ANSWER", "second steer not delivered yet");
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY); // the armed (second) steer
		assert.equal(h.runner.finalOutput(), "");
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
	} finally { await fin(h); }
});

test("a rejected steer restores the earlier armed steer's queue entry", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
		assistant(h.child, "OLD ANSWER");
		const p = h.runner.steer("second");
		h.child.reply((await lastSteerLine(h.child)).id, false, undefined, "nope");
		assert.equal((await p).ok, false);
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY);
		assert.equal(h.runner.finalOutput(), "");
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
	} finally { await fin(h); }
});

// An earlier accepted steer can be delivered while a later steer awaits its ACK;
// if that later steer is rejected, the earlier one's delivery must not be lost.
for (const tracked of [true, false]) {
	test(`earlier steer delivered in-run while a later steer is pending, then the later is rejected (${tracked ? "queue-tracked" : "text match"})`, async () => {
		const h = makeRunner();
		try {
			await boot(h.child);
			h.child.event({ type: "agent_start" });
			const earlier = tracked ? SKILL_BODY : "EARLIER";
			if (tracked) await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
			else {
				const p = h.runner.steer("EARLIER");
				h.child.reply((await lastSteerLine(h.child)).id, true);
				assert.equal((await p).ok, true);
			}
			assistant(h.child, "OLD ANSWER");
			const p = h.runner.steer("LATER");
			const line = await lastSteerLine(h.child);
			if (tracked) queueUpdate(h.child, []);
			userMessage(h.child, earlier); // the earlier steer starts inside the run
			assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
			h.child.reply(line.id, false, undefined, "nope");
			assert.equal((await p).ok, false);
			assert.equal(h.runner.finalOutput(), "", "the earlier steer's task does not inherit OLD ANSWER");
			settle(h.child);
			await flush();
			assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
			assert.ok(!h.runner.transcript.some((t) => t.text === "LATER"), "rejected marker removed");
			// Nothing is left armed: a later run is not mistaken for the earlier steer's.
			h.child.event({ type: "agent_start" });
			assistant(h.child, "NEXT");
			settle(h.child);
			await flush();
			assert.equal(h.counts.settled, 1, "an unarmed follow-on run does not re-announce");
		} finally { await fin(h); }
	});
}

test("earlier follow-up started by agent_start while a later steer is pending, then the later is rejected", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/fix auth", ["FIX"], "followUp");
		assistant(h.child, "OLD ANSWER");
		settle(h.child); // the predecessor settles and is announced; the follow-up is still queued
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "success", finalOutput: "OLD ANSWER" }]);
		const p = h.runner.steer("LATER");
		const line = await lastSteerLine(h.child);
		queueUpdate(h.child, [], []);
		h.child.event({ type: "agent_start" }); // Pi drains the earlier follow-up
		userMessage(h.child, "FIX");
		h.child.reply(line.id, false, undefined, "nope");
		assert.equal((await p).ok, false);
		assistant(h.child, "FIXED");
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots[1], { status: "waiting", taskOutcome: "success", finalOutput: "FIXED" });
		assert.equal(h.counts.settled, 2);
	} finally { await fin(h); }
});

test("expanded steer delivered in-run after its marker was trimmed keeps the sequence boundary", async () => {
	const h = makeRunner({ limits: { maxTranscriptBytes: 160 } });
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
		for (let i = 0; i < 3; i++) h.child.event({ type: "tool_execution_start", toolName: "bash", toolCallId: `t${i}`, args: { command: `step ${i}` } });
		assistant(h.child, "OLD ANSWER");
		assert.ok(!h.runner.transcript.some((t) => t.kind === "steer"), "steer marker was trimmed");
		assert.equal(h.runner.finalOutput(), "OLD ANSWER", "predecessor output after the arm is still current");
		userMessage(h.child, SKILL_BODY); // not dequeued: not the steer's delivery
		assert.equal(h.runner.finalOutput(), "OLD ANSWER");
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY);
		assert.equal(h.runner.finalOutput(), "", "boundary moved at the expanded delivery");
		assert.equal(h.runner.transcript.at(-1)?.text, "/skill:review do it", "marker shown again at the new run");
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
	} finally { await fin(h); }
});

test("queue tracking holds at most the armed and superseded steers' entries", async () => {
	const h = makeRunner();
	const tracked = () => (h.runner as any).queuedSteers.length as number;
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "one", ["ONE"]);
		await queuedSteer(h, "two", ["ONE", "TWO"]);
		await queuedSteer(h, "three", ["ONE", "TWO", "THREE"]);
		assert.equal(tracked(), 1, "superseded, accepted steers are no longer tracked");
		queueUpdate(h.child, []); // e.g. an abort clears Pi's queues
		assert.equal(tracked(), 0);
		userMessage(h.child, "THREE");
		settle(h.child);
		await flush();
		assert.equal(tracked(), 0);
	} finally { await fin(h); }
});

/** Reply to every unanswered get_state request. */
function answerState(child: FakeChild, answered: Set<string>, data: Record<string, unknown>): number {
	let n = 0;
	for (const line of child.sentLines()) {
		if (line.type !== "get_state" || answered.has(line.id)) continue;
		answered.add(line.id); n++;
		child.reply(line.id, true, { sessionId: "sess-1", ...data });
	}
	return n;
}

test("cancelled unacknowledged steer is reconciled with get_state when Pi is idle", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 60 } });
	try {
		await boot(h.child);
		assistant(h.child, "old");
		settle(h.child);
		await flush();
		const answered = new Set<string>(h.child.sentLines().filter((l) => l.type === "get_state").map((l) => l.id));
		const controller = new AbortController();
		const waiting = h.runner.steer("LOST", controller.signal);
		await lastSteerLine(h.child);
		controller.abort();
		assert.equal((await waiting).ok, false);
		await flush(80); // ACK deadline passes: reconciliation starts instead of a kill
		assert.equal(h.runner.status, "running");
		assert.equal(answerState(h.child, answered, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }), 1);
		await flush();
		assert.equal(h.counts.settled, 1, "one idle reading is not enough");
		assert.equal(answerState(h.child, answered, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }), 1);
		await flush();
		assert.equal(h.runner.status, "waiting");
		assert.equal(h.runner.taskOutcome, "error");
		assert.match(h.runner.error ?? "", /acceptance unknown.*may not have been delivered/);
		assert.equal(h.counts.settled, 2);
		assert.equal(h.counts.snapshots[1].finalOutput, "", "no false completion output");
		assert.deepEqual(h.child.killSignals, []);
		assert.ok(!h.child.sentLines().some((l) => l.type === "abort"));
		// A late run for the steer still begins and announces normally.
		h.child.event({ type: "agent_start" });
		assert.equal(h.runner.taskOutcome, undefined);
		assistant(h.child, "late but real");
		settle(h.child);
		await flush();
		assert.equal(h.counts.settled, 3);
		assert.equal(h.runner.taskOutcome, "success");
		assert.equal(h.runner.finalOutput(), "late but real");
	} finally { await fin(h); }
});

test("reconciliation leaves a streaming or queued Pi to its own settle", { timeout: 3000 }, async () => {
	for (const data of [{ isStreaming: true, pendingMessageCount: 0 }, { isStreaming: false, pendingMessageCount: 1 }]) {
		const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 60 } });
		try {
			await boot(h.child);
			const answered = new Set<string>(h.child.sentLines().filter((l) => l.type === "get_state").map((l) => l.id));
			const controller = new AbortController();
			const waiting = h.runner.steer("QUEUED", controller.signal, "followUp");
			await lastSteerLine(h.child);
			controller.abort();
			await waiting;
			await flush(80);
			assert.equal(answerState(h.child, answered, data), 1);
			await flush(150);
			assert.equal(h.child.sentLines().filter((l) => l.type === "get_state").length, answered.size, "no further polling");
			assert.equal(h.runner.status, "running");
			assert.equal(h.counts.settled, 0);
			assistant(h.child, "done");
			settle(h.child);
			await flush();
			assert.equal(h.runner.status, "waiting");
			assert.equal(h.runner.taskOutcome, "success");
		} finally { await fin(h); }
	}
});

test("unanswered reconciliation records a diagnostic but never kills", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 30 } });
	try {
		await boot(h.child);
		assistant(h.child, "old");
		settle(h.child);
		await flush();
		const controller = new AbortController();
		const waiting = h.runner.steer("LOST", controller.signal);
		await lastSteerLine(h.child);
		controller.abort();
		await waiting;
		await flush(250); // ACK deadline + four unanswered get_state deadlines
		assert.equal(h.runner.status, "running");
		assert.match(h.runner.error ?? "", /could not confirm.*agent_kill/);
		assert.ok(h.runner.transcript.some((t) => t.kind === "error" && /could not confirm/.test(t.text)));
		assert.equal(h.counts.settled, 1, "no fabricated completion");
		assert.deepEqual(h.child.killSignals, []);
		assert.equal(h.runner.processAlive, true);
	} finally { await fin(h); }
});

// ── readiness and progress-aware prompt ACKs ───────────────────────────────
// Real Pi ACKs a prompt only after preflight, which may run a whole compaction
// LLM call; it answers get_state concurrently meanwhile.

/** Answer every get_state as a compacting Pi until `stop()`; counts answered probes. */
function answerProbes(child: FakeChild, answered: Set<string>, data: Record<string, unknown> = { isCompacting: true, isStreaming: false }) {
	let probes = 0;
	const timer = setInterval(() => { probes += answerState(child, answered, data); }, 5);
	return { stop: () => clearInterval(timer), count: () => probes };
}

function stateIds(child: FakeChild): Set<string> {
	return new Set(child.sentLines().filter((l) => l.type === "get_state").map((l) => l.id));
}

test("initial prompt ACK delayed by preflight compaction is not a timeout", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await flush();
		for (const line of h.child.sentLines()) if (line.type === "get_state") h.child.reply(line.id, true, {});
		await flush();
		h.child.event({ type: "compaction_start", reason: "threshold" });
		const probes = answerProbes(h.child, stateIds(h.child));
		assert.match((await h.runner.steer("early")).reason ?? "", /compacting/);
		await flush(250); // several quiet windows past the old fixed deadline
		probes.stop();
		assert.equal(h.runner.status, "running");
		assert.equal(h.runner.error, undefined);
		assert.deepEqual(h.child.killSignals, []);
		assert.ok(probes.count() >= 2, "liveness probed each quiet window");
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: {} });
		const prompts = h.child.sentLines().filter((l) => l.type === "prompt");
		assert.equal(prompts.length, 1, "prompt never resent");
		h.child.reply(prompts[0].id, true);
		await flush();
		const p = h.runner.steer("now steerable");
		h.child.reply((await lastSteerLine(h.child)).id, true);
		assert.equal((await p).ok, true);
		h.child.event({ type: "agent_start" }); assistant(h.child, "done"); settle(h.child);
		assert.equal(h.runner.taskOutcome, "success");
	} finally { await fin(h); }
});

test("ACK shortly after compaction_end gets one more window", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await flush();
		const answered = new Set<string>();
		assert.equal(answerState(h.child, answered, {}), 1, "readiness");
		await flush();
		h.child.event({ type: "compaction_start", reason: "threshold" });
		await flush(20);
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, result: {} });
		await flush(30); // first window ends: compaction activity seen, probe answered
		assert.equal(answerState(h.child, answered, { isCompacting: false }), 1);
		await flush(20);
		const prompt = h.child.sentLines().find((l) => l.type === "prompt");
		h.child.reply(prompt.id, true);
		await flush();
		assert.equal(h.runner.status, "running");
		assert.deepEqual(h.child.killSignals, []);
	} finally { await fin(h); }
});

test("compaction ACK wait fails closed when the probe goes unanswered", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	await flush();
	for (const line of h.child.sentLines()) if (line.type === "get_state") h.child.reply(line.id, true, {});
	await flush();
	h.child.event({ type: "compaction_start", reason: "threshold" });
	await flush(120); // quiet window + unanswered probe deadline
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /Initial prompt rejected: no response/);
	await h.runner.whenClosed;
	assert.equal(h.child.sentLines().filter((l) => l.type === "prompt").length, 1);
});

test("compaction ACK wait is capped by ackMaxMs; a late ACK changes nothing", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 30, ackMaxMs: 150 } });
	await flush();
	for (const line of h.child.sentLines()) if (line.type === "get_state") h.child.reply(line.id, true, {});
	await flush();
	h.child.event({ type: "compaction_start", reason: "threshold" });
	const probes = answerProbes(h.child, stateIds(h.child));
	await flush(260);
	probes.stop();
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /no response within 1\d\dms/);
	const prompt = h.child.sentLines().find((l) => l.type === "prompt");
	h.child.reply(prompt.id, true);
	await h.runner.whenClosed;
	assert.equal(h.runner.status, "error");
	assert.equal(h.child.sentLines().filter((l) => l.type === "prompt").length, 1);
});

test("idle steer ACK delayed by preflight compaction is accepted", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await boot(h.child);
		assistant(h.child, "old"); settle(h.child);
		await flush();
		const answered = stateIds(h.child);
		const steer = h.runner.steer("continue after compaction");
		const line = await lastSteerLine(h.child);
		assert.equal(line.streamingBehavior, undefined);
		h.child.event({ type: "compaction_start", reason: "threshold" });
		const probes = answerProbes(h.child, answered);
		await flush(200);
		probes.stop();
		assert.equal(h.runner.processAlive, true);
		assert.deepEqual(h.child.killSignals, []);
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, result: {} });
		h.child.reply(line.id, true);
		assert.equal((await steer).ok, true);
		h.child.event({ type: "agent_start" }); assistant(h.child, "new"); settle(h.child);
		assert.equal(h.runner.taskOutcome, "success");
		assert.equal(h.runner.finalOutput(), "new");
	} finally { await fin(h); }
});

test("cancelling a steer during a compaction ACK wait still never kills", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await boot(h.child);
		settle(h.child);
		await flush();
		const answered = stateIds(h.child);
		const controller = new AbortController();
		const steer = h.runner.steer("x", controller.signal);
		const line = await lastSteerLine(h.child);
		h.child.event({ type: "compaction_start", reason: "threshold" });
		const probes = answerProbes(h.child, answered);
		await flush(60);
		controller.abort();
		assert.match((await steer).reason ?? "", /cancelled/);
		await flush(100);
		probes.stop();
		assert.match((await h.runner.steer("dup")).reason ?? "", /awaiting acceptance/, "steers stay serialized");
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, result: {} });
		h.child.reply(line.id, true);
		await flush();
		assert.deepEqual(h.child.killSignals, []);
		assert.equal(h.runner.steerCount, 1);
	} finally { await fin(h); }
});

test("slow startup: prompt is sent only after get_state, without spending its ACK budget", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40, startupTimeoutMs: 1000 } });
	try {
		await flush(120); // longer than requestTimeoutMs: still booting
		assert.equal(h.runner.status, "starting");
		assert.ok(!h.child.sentLines().some((l) => l.type === "prompt"));
		assert.equal(h.child.sentLines().filter((l) => l.type === "get_state").length, 1, "readiness query never resent");
		await boot(h.child);
		assert.equal(h.runner.status, "running");
		assert.equal(h.runner.sessionId, "sess-1");
		assert.equal(h.child.sentLines().filter((l) => l.type === "prompt").length, 1);
		assert.deepEqual(h.child.killSignals, []);
	} finally { await fin(h); }
});

test("child that never becomes ready fails closed without sending the task", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, startupTimeoutMs: 60 } });
	await flush(100);
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /did not become ready.*get_state/);
	assert.ok(!h.child.sentLines().some((l) => l.type === "prompt"));
	await h.runner.whenClosed;
	assert.equal(h.counts.exits, 1);
});

// ── delayed ACK × queue correlation ─────────────────────────────────────────
// Pi emits queue_update (and may even deliver the steer) before the ACK; an
// extended ACK wait must keep that correlation and the output boundaries.

test("queue_update and in-run delivery before a delayed steer ACK start the expanded task once", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		assistant(h.child, "OLD ANSWER");
		const answered = stateIds(h.child);
		const p = h.runner.steer("/skill:review do it");
		const line = await lastSteerLine(h.child);
		queueUpdate(h.child, [SKILL_BODY]); // queued (expanded) before the ACK
		h.child.event({ type: "compaction_start", reason: "threshold" });
		const probes = answerProbes(h.child, answered);
		await flush(150); // several quiet windows past the old fixed deadline
		probes.stop();
		assert.deepEqual(h.child.killSignals, []);
		assert.ok(probes.count() >= 2);
		assistant(h.child, "STILL OLD"); // the predecessor streams on after the arm
		assert.equal(h.runner.finalOutput(), "STILL OLD", "not delivered yet");
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, result: {} });
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY); // delivered while the ACK is still outstanding
		assert.equal(h.runner.finalOutput(), "", "boundary moved before the ACK");
		h.child.reply(line.id, true);
		assert.deepEqual(await p, { ok: true });
		assistant(h.child, "", { stopReason: "error", errorMessage: "api boom" });
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "error", finalOutput: "" }]);
		assert.equal(h.child.sentLines().filter((l) => l.type === "prompt" && l.streamingBehavior).length, 1, "steer never resent");
		assert.equal((h.runner as any).queuedSteers.length, 0);
	} finally { await fin(h); }
});

test("earlier steer delivered during a later steer's extended ACK wait stands when the later is rejected", { timeout: 3000 }, async () => {
	const h = makeRunner({ timings: { ...TEST_TIMINGS, requestTimeoutMs: 40 } });
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		await queuedSteer(h, "/skill:review do it", [SKILL_BODY]);
		assistant(h.child, "OLD ANSWER");
		const answered = stateIds(h.child);
		const p = h.runner.steer("LATER");
		const line = await lastSteerLine(h.child);
		h.child.event({ type: "compaction_start", reason: "threshold" });
		const probes = answerProbes(h.child, answered);
		await flush(100);
		queueUpdate(h.child, []);
		userMessage(h.child, SKILL_BODY); // the earlier steer starts mid-wait
		assistant(h.child, "EARLIER ANSWER");
		await flush(100);
		probes.stop();
		h.child.event({ type: "compaction_end", reason: "threshold", aborted: false, result: {} });
		h.child.reply(line.id, false, undefined, "nope");
		assert.equal((await p).ok, false);
		assert.equal(h.runner.finalOutput(), "EARLIER ANSWER");
		settle(h.child);
		await flush();
		assert.deepEqual(h.counts.snapshots, [{ status: "waiting", taskOutcome: "success", finalOutput: "EARLIER ANSWER" }]);
		assert.deepEqual(h.child.killSignals, []);
	} finally { await fin(h); }
});

test("transcript: write/edit tool items carry a render-only +/− summary; text keeps the one-liner", async () => {
	const h = makeRunner();
	try {
		await boot(h.child);
		h.child.event({ type: "agent_start" });
		h.child.event({ type: "tool_execution_start", toolName: "write", toolCallId: "t1", args: { path: "/r/member.ts", content: "a\nb\nc\n" } });
		h.child.event({
			type: "tool_execution_start",
			toolName: "edit",
			toolCallId: "t2",
			args: { path: "/r/teams.ts", edits: [{ oldText: "x\ny", newText: "x\nz\nw" }] },
		});
		h.child.event({ type: "tool_execution_start", toolName: "bash", toolCallId: "t3", args: { command: "ls" } });
		const tools = h.runner.transcript.filter((t) => t.kind === "tool");
		assert.deepEqual(
			tools.map((t) => [t.text, t.summary]),
			[
				["/r/member.ts", "✎ write /r/member.ts  +3"],
				["/r/teams.ts", "✎ edit /r/teams.ts  +2 −1"],
				["ls", undefined],
			],
		);
		assert.ok(!("summary" in tools[2]), "items without a summary keep their original shape");
	} finally { await fin(h); }
});

test("extension flags follow the -e sources as --name value / --name; a malformed flag fails the worker before spawn", async () => {
	const h = makeRunner({ extensions: ["/x/remote/index.ts"], flags: { target: "box", "no-channel": true } });
	await boot(h.child);
	const args = h.spawnCalls[0].args;
	const e = args.indexOf("-e");
	assert.deepEqual(args.slice(e, e + 5), ["-e", "/x/remote/index.ts", "--target", "box", "--no-channel"]);
	assert.ok(args.indexOf("--target") > args.indexOf("--no-extensions"));
	await fin(h);
	const bad = makeRunner({ flags: { "Bad Name": "x" } });
	await flush();
	assert.equal(bad.spawnCalls.length, 0);
	assert.equal(bad.runner.status, "error");
	assert.match(bad.runner.error ?? "", /Invalid extension flag --Bad Name/);
});

// ── claude-code-cli models: set over RPC, never argv ────────────────────────

test("a claude-code-cli model is kept out of argv and set over RPC after readiness, before the task prompt", async () => {
	const h = makeRunner({ model: "claude-code-cli/opus[1m]", effort: "medium", extensions: ["/x/claude-code/index.ts"], flags: { "claude-code-provider": true } });
	await flush();
	const args = h.spawnCalls[0].args;
	assert.ok(!args.includes("--model"), "argv-time validation would refuse a provider that registers at session_start");
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "medium"], "effort stays argv");
	const e = args.indexOf("-e");
	assert.deepEqual(args.slice(e, e + 3), ["-e", "/x/claude-code/index.ts", "--claude-code-provider"]);
	// Readiness first: only get_state is on the wire.
	assert.deepEqual(h.child.sentLines().map((l) => l.type), ["get_state"]);
	assert.equal(h.runner.status, "starting");
	const state = h.child.sentLines()[0];
	h.child.reply(state.id, true, { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl", model: { provider: "zai", id: "glm-5.3" }, thinkingLevel: "medium" });
	await flush();
	// Then set_model, and still no prompt: the task never runs on the child's default model.
	assert.deepEqual(h.child.sentLines().map((l) => l.type), ["get_state", "set_model"]);
	const set = h.child.sentLines()[1];
	assert.equal(set.provider, "claude-code-cli");
	assert.equal(set.modelId, "opus[1m]");
	assert.equal(h.runner.status, "starting");
	h.child.reply(set.id, true, { provider: "claude-code-cli", id: "opus[1m]" });
	await flush();
	assert.deepEqual(h.child.sentLines().map((l) => l.type), ["get_state", "set_model", "prompt"]);
	assert.equal(h.runner.model, "claude-code-cli/opus[1m]", "the runner reports the model it set, not the default get_state showed");
	const prompt = h.child.sentLines()[2];
	assert.equal(prompt.message, "count to three");
	h.child.reply(prompt.id, true);
	await flush();
	assert.equal(h.runner.status, "running");
	await fin(h);
});

test("a refused set_model fails the worker before any task prompt", async () => {
	const h = makeRunner({ model: "claude-code-cli/opus[1m]" });
	await flush();
	const state = h.child.sentLines()[0];
	h.child.reply(state.id, true, { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl", model: null, thinkingLevel: "medium" });
	await flush();
	const set = h.child.sentLines()[1];
	assert.equal(set.type, "set_model");
	h.child.reply(set.id, false, undefined, "Model not found: claude-code-cli/opus[1m]");
	await flush();
	assert.equal(h.runner.status, "error");
	assert.match(h.runner.error ?? "", /Model claude-code-cli\/opus\[1m\] could not be set on the worker \(Model not found: claude-code-cli\/opus\[1m\]\); the task was not started/);
	assert.ok(!h.child.sentLines().some((l) => l.type === "prompt"), "no prompt after a refused set_model");
	assert.equal(h.runner.taskOutcome, "error");
	await h.runner.whenClosed;
	assert.equal(h.counts.exits, 1);
});

test("every other model keeps --model argv and never sends set_model", async () => {
	const h = makeRunner({ model: "ollama-cloud/kimi-k3", effort: "low" });
	await boot(h.child);
	const args = h.spawnCalls[0].args;
	assert.deepEqual(args, ["--mode", "rpc", "--model", "ollama-cloud/kimi-k3", "--thinking", "low", "--no-extensions"]);
	assert.deepEqual(h.child.sentLines().map((l) => l.type), ["get_state", "prompt"]);
	assert.equal(h.runner.status, "running");
	await fin(h);
});
