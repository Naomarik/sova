/**
 * Lifecycle tests for SubagentRunner, using a fake child process injected via
 * the spawnImpl seam. No real pi processes are spawned. Run with:
 *
 *   node tests/run.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { BUILTIN_TOOLS, type SpawnOptions, SubagentRunner } from "./runner.ts";

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
	const killPromise = h.runner.kill();
	assert.equal(h.runner.status, "stopping");
	assert.equal((await h.runner.steer("x")).ok, false);
	await killPromise;
	assert.equal(h.runner.status, "killed");
	assert.equal((await h.runner.steer("x")).ok, false);
	// Also during the fail-teardown window (error status, process alive).
	const f = makeRunner();
	await boot(f.child);
	f.child.stdin.emit("error", new Error("write EPIPE"));
	await flush();
	assert.equal(f.runner.status, "error");
	assert.equal((await f.runner.steer("x")).ok, false);
	await f.runner.whenClosed;
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
