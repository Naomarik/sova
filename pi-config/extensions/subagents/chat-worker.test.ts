/**
 * ChatWorker (al_3 stage 4): a worker as a chat process of its own, driven through a WorkerHost. These
 * run over the in-memory FakeWorkerHost: the host's feed carries the worker's pi events, folded by
 * fold.ts exactly as the RPC worker's stdout was (the fold's tests moved here from runner.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatWorker, lastSettledRun, sessionDirName, workerStartOf } from "./chat-worker.ts";
import type { SpawnOptions } from "./runner.ts";
import { noAnswer, type WorkerHost, type WorkerRef } from "./worker-host.ts";
import { FakeWorkerHost, type FakeWorkerHostOptions } from "./tests/fake-worker-host.ts";
import { WORKER_TOOLS_ENV } from "./worker-mark.ts";

const PARENT = { sessionId: "parent-1", path: "/sessions/parent-1.jsonl" };
const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host whose sends can be held open (an acceptance still in flight) and answered by the test. */
class GatedHost extends FakeWorkerHost {
	gate: { open: boolean; waiting: { resolve: () => void; reject: (e: Error) => void }[] } = { open: true, waiting: [] };
	async send(chatId: string, input: Parameters<WorkerHost["send"]>[1]): Promise<{ queued: boolean }> {
		if (!this.gate.open) await new Promise<void>((resolve, reject) => this.gate.waiting.push({ resolve, reject }));
		return super.send(chatId, input);
	}
	/** Answer the oldest held send: accepted, or rejected with `reason`. */
	answer(reason?: string): void {
		const w = this.gate.waiting.shift()!;
		if (reason) w.reject(new Error(reason));
		else w.resolve();
	}
}

/** The feeds a worker's parent may read: one naming each user message's send key (WorkerState.keys),
    and one from a worker on code from before keys (the legacy, best-effort correlation). */
type Feed = "legacy" | "keyed";
const FEEDS: Feed[] = ["legacy", "keyed"];

interface Harness {
	feed: Feed;
	/** Send keys whose user message the test has delivered. */
	delivered: Set<string>;
	worker: ChatWorker;
	host: GatedHost;
	counts: { change: number; settled: number; exits: number; snapshots: { status: string; taskOutcome?: string; finalOutput: string }[] };
	ev(event: Record<string, unknown>): void;
	chatId(): string;
}

function make(options: Partial<SpawnOptions> = {}, hostOptions: FakeWorkerHostOptions = {}, host = new GatedHost(hostOptions), feed: Feed = "legacy"): Harness {
	const counts: Harness["counts"] = { change: 0, settled: 0, exits: 0, snapshots: [] };
	const worker = new ChatWorker(
		{ id: "ag_01", groupId: "run_01", name: "test", task: "count to three", cwd: "/work", ...options },
		{
			onChange: () => counts.change++,
			onSettled: (w) => {
				counts.settled++;
				counts.snapshots.push({ status: w.status, taskOutcome: w.taskOutcome, finalOutput: w.finalOutput() });
			},
			onExit: () => counts.exits++,
		},
		{ host, parent: PARENT, start: { key: "parent-1:ag_01:x.1", defaultSessionDir: (cwd) => `/agent/sessions/${sessionDirName(cwd)}` } },
	);
	const chatId = () => worker.chatId!;
	return { feed, delivered: new Set(), worker, host, counts, chatId, ev: (event) => host.event(chatId(), event) };
}

/** The start answered: the worker is bound to its chat and its task accepted (a keyed feed says so in its state). */
async function boot(h: Harness): Promise<void> {
	await flush();
	assert.ok(h.worker.chatId, "bound");
	if (h.feed === "keyed") h.host.state(h.chatId(), { keys: true });
}

function assistant(h: Harness, text: string, extra: Record<string, unknown> = {}): void {
	h.ev({ type: "message_end", message: { role: "assistant", content: text, usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } }, ...extra } });
}
const settle = (h: Harness) => h.ev({ type: "agent_settled" });
/** pi delivers a user message: on a keyed feed it names its send's key (`key`, else the oldest send of that text not delivered yet). */
function userMessage(h: Harness, text: string, key?: string): void {
	const message = { role: "user", content: [{ type: "text", text }] };
	if (h.feed === "keyed") key ??= h.host.get(h.chatId()).sends.find((x) => x.text === text && !h.delivered.has(x.key))?.key;
	if (h.feed !== "keyed" || key === undefined) return h.ev({ type: "message_end", message });
	h.delivered.add(key);
	h.ev({ type: "message_start", message, sendKey: key });
	h.ev({ type: "message_end", message, sendKey: key });
}
/** The key of the worker's `n`th send (0-based). */
const sendKeyOf = (h: Harness, n: number) => h.host.get(h.chatId()).sends[n]!.key;
const settleRun = (h: Harness) => (h.ev({ type: "agent_end", messages: [] }), settle(h));
/** The task's run is going (its agent_start). */
const h_start = (h: Harness) => h.ev({ type: "agent_start" });

// ── the start ──────────────────────────────────────────────────────────────

test("a start is today's loadout as data, keyed; the task is the host's to deliver; the worker runs", async () => {
	const h = make({ model: "zai/glm-5.3", effort: "high", tools: ["read", "bash"], extensions: ["/ext/a.ts"], flags: { target: "box" }, systemPrompt: "be brief", env: { A: "1", PI_CODING_AGENT_DIR: "/tree/.agent" } });
	await boot(h);
	const req = h.host.starts[0]!;
	assert.equal(req.key, "parent-1:ag_01:x.1");
	assert.equal(req.task, "count to three");
	assert.deepEqual(req.session, { new: { dir: `/agent/sessions/${sessionDirName("/work")}` } });
	assert.deepEqual(req.spec.parent, { ...PARENT, workerId: "ag_01" });
	assert.equal(req.spec.model, "zai/glm-5.3");
	assert.equal(req.spec.thinking, "high");
	assert.deepEqual(req.spec.builtins, ["read", "bash"]);
	assert.deepEqual(req.spec.extensions, ["/ext/a.ts"]);
	assert.deepEqual(req.spec.flags, { target: "box" });
	assert.equal(req.spec.appendSystemPrompt, "be brief");
	assert.equal(req.spec.agentDir, "/tree/.agent");
	assert.deepEqual(req.spec.env, { A: "1", [WORKER_TOOLS_ENV]: "read,bash" });
	assert.equal(h.worker.status, "running");
	assert.equal(h.worker.transcript[0]!.kind, "task");
	assert.equal(h.host.get(h.chatId()).sends.length, 0, "the task rode the start");
	await h.worker.dispose();
});

test("a fork, a session dir, a resume: the session the chat opens", () => {
	const base: SpawnOptions = { id: "ag_02", groupId: "g", name: "n", task: "t", cwd: "/w" };
	const dir = () => "/default";
	assert.deepEqual(workerStartOf({ ...base, forkSession: "/p.jsonl" }, PARENT, "k", dir).session, { fork: { from: "/p.jsonl", dir: "/default" } });
	assert.deepEqual(workerStartOf({ ...base, sessionDir: "/tree/s" }, PARENT, "k", dir).session, { new: { dir: "/tree/s" } });
	const resumed = workerStartOf({ ...base, resume: { sessionFile: "/old.jsonl" } }, PARENT, "k", dir);
	assert.deepEqual(resumed.session, { resume: { file: "/old.jsonl" } });
	assert.equal(resumed.task, null);
	assert.equal(sessionDirName("/home/u/proj"), "--home-u-proj--");
});

test("a start the host refuses ends the worker in error, announced once", async () => {
	const h = make({}, { failStart: () => "Workers need Bun to run Sova's chat runtime" });
	await flush();
	assert.equal(h.worker.status, "error");
	assert.equal(h.worker.taskOutcome, "error");
	assert.match(h.worker.error ?? "", /Bun/);
	assert.equal(h.counts.settled, 1);
	assert.equal(h.counts.exits, 1);
});

test("a resume reopens the worker's own file idle: no task, no completion", async () => {
	const h = make({ resume: { sessionFile: "/s/old.jsonl", startedAt: 1234 } });
	await boot(h);
	assert.deepEqual(h.host.starts[0]!.session, { resume: { file: "/s/old.jsonl" } });
	assert.equal(h.host.starts[0]!.task, null);
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.worker.startedAt, 1234);
	assert.equal(h.counts.settled, 0);
	await h.worker.dispose();
});

// ── task outcomes ──────────────────────────────────────────────────────────

test("clean settle parks in waiting with success outcome", async () => {
	const h = make();
	await boot(h);
	assistant(h, "done counting");
	settle(h);
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.worker.taskOutcome, "success");
	assert.equal(h.worker.error, undefined);
	assert.ok(h.worker.isSettled());
	assert.ok(!h.worker.isFinished());
	assert.equal(h.counts.settled, 1);
	await h.worker.dispose();
});

test("assistant failure marks the TASK failed while the worker parks steerable", async () => {
	const h = make();
	await boot(h);
	assistant(h, "partial", { errorMessage: "provider 500" });
	settle(h);
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.worker.taskOutcome, "error");
	assert.equal(h.worker.error, "provider 500");
	assert.equal(h.worker.finalOutput(), "partial");
	assert.equal(h.worker.isStopping(), false);
	await h.worker.dispose();
});

test("aborted stopReason yields aborted outcome", async () => {
	const h = make();
	await boot(h);
	assistant(h, "", { stopReason: "aborted" });
	settle(h);
	assert.equal(h.worker.taskOutcome, "aborted");
	await h.worker.dispose();
});

test("transient failure then successful retry settles as success; a final retry failure pins the error", async () => {
	const h = make();
	await boot(h);
	assistant(h, "", { errorMessage: "529 overloaded" });
	h.ev({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" });
	h.ev({ type: "auto_retry_end", success: true, attempt: 2 });
	assistant(h, "recovered answer");
	settle(h);
	assert.equal(h.worker.taskOutcome, "success");
	assert.equal(h.worker.error, undefined);
	await h.worker.dispose();

	const bare = make();
	await boot(bare);
	bare.ev({ type: "auto_retry_end", success: false, attempt: 3 });
	settle(bare);
	assert.equal(bare.worker.taskOutcome, "error");
	assert.match(bare.worker.error ?? "", /auto-retry failed/);
	await bare.worker.dispose();
});

test("failed compaction settles as a task failure; aborted compaction does not; usage counted", async () => {
	const failed = make();
	await boot(failed);
	failed.ev({ type: "compaction_end", reason: "threshold", result: { usage: { input: 999, output: 10, totalTokens: 1009, cost: { total: 0.2 } } }, aborted: false, errorMessage: "API quota exceeded" });
	settle(failed);
	assert.equal(failed.worker.taskOutcome, "error");
	assert.match(failed.worker.error ?? "", /quota/);
	assert.equal(failed.worker.usage.input, 999);
	await failed.worker.dispose();

	const aborted = make();
	await boot(aborted);
	assistant(aborted, "partial work");
	aborted.ev({ type: "compaction_end", reason: "manual", result: null, aborted: true });
	settle(aborted);
	assert.equal(aborted.worker.taskOutcome, "success");
	await aborted.worker.dispose();
});

// ── steering ───────────────────────────────────────────────────────────────

for (const feed of FEEDS) {

	test(`a steer from waiting is a fresh prompt and clears the stale outcome; while running it steers; a follow-up queues [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		assistant(h, "first", { errorMessage: "boom" });
		settle(h);
		assert.deepEqual(await h.worker.steer("now do it this way"), { ok: true });
		const sends = h.host.get(h.chatId()).sends;
		assert.equal(sends[0]!.delivery, "prompt");
		assert.equal(h.worker.status, "running");
		assert.equal(h.worker.taskOutcome, undefined);
		assert.equal(h.worker.error, undefined);
		assert.equal(h.worker.steerCount, 1);
		assert.equal(h.worker.finalOutput(), "");
		assert.equal((await h.worker.steer("redirect")).ok, true);
		assert.equal(sends[1]!.delivery, "steer");
		assert.equal((await h.worker.steer("later", undefined, "followUp")).ok, true);
		assert.equal(sends[2]!.delivery, "followUp");
		assert.equal(new Set(sends.map((s) => s.key)).size, 3, "each send its own key");
		await h.worker.dispose();
	});

	test(`a rejected steer reports ok:false and changes nothing (its marker rolled back) [${feed}]`, async () => {
		const h = make({}, { failSend: () => "message too long" }, undefined, feed);
		await boot(h);
		assistant(h, "answer");
		settle(h);
		const before = h.worker.transcriptRevision;
		const result = await h.worker.steer("new plan");
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /too long/);
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.worker.taskOutcome, "success");
		assert.equal(h.worker.steerCount, 0);
		assert.equal(h.worker.transcriptRevision, before + 2, "arm push + rollback splice");
		await h.worker.dispose();
	});

	test(`a steer the server never answers leaves the worker running and unstopped, reports delivery unknown, and sends nothing again [${feed}]`, async () => {
		let down = true;
		const NO_SERVER = "The Sova server isn't answering, so this action didn't run. Try it again in a minute.";
		const h = make({}, { failSend: () => (down ? noAnswer(NO_SERVER) : undefined) }, undefined, feed);
		await boot(h);
		assistant(h, "working");
		const r = await h.worker.steer("new plan");
		assert.equal(r.ok, false);
		assert.equal(r.unknown, true);
		assert.match(r.reason ?? "", /delivery unknown/);
		assert.match(r.reason ?? "", /not stopped/);
		assert.doesNotMatch(r.reason ?? "", /didn't run/, "never claims the message didn't run");
		await flush();
		assert.equal(h.worker.status, "running", "the task in flight stays the current one");
		assert.equal(h.worker.isFinished(), false);
		assert.equal(h.host.get(h.chatId()).stops.length, 0, "no stop");
		assert.equal(h.worker.steerCount, 0, "the arm is undone");
		assert.ok(!h.worker.transcript.some((t) => t.kind === "steer"));
		const last = h.worker.transcript.at(-1)!;
		assert.equal(last.kind, "error");
		assert.match(last.text, /may not have been delivered; the worker was not stopped/);
		assert.match(last.text, /new plan/);
		assert.equal(h.host.get(h.chatId()).sends.length, 1, "sent once, never again");
		// The task in flight ends as it would have; a later steer once the server is back is delivered.
		settle(h);
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.worker.taskOutcome, "success");
		down = false;
		assert.equal((await h.worker.steer("again")).ok, true);
		assert.equal(h.host.get(h.chatId()).sends.length, 2);
		await h.worker.dispose();
	});

	test(`an idle worker whose steer goes unanswered stays waiting with its last outcome [${feed}]`, async () => {
		const h = make({}, { failSend: () => noAnswer("The Sova server isn't answering, so this action didn't run. Try it again in a minute.") }, undefined, feed);
		await boot(h);
		assistant(h, "answer");
		settle(h);
		const settled = h.counts.settled;
		const r = await h.worker.steer("next");
		assert.equal(r.unknown, true);
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.worker.taskOutcome, "success");
		assert.equal(h.counts.settled, settled, "no new settle announced");
		assert.equal(h.host.get(h.chatId()).stops.length, 0);
		await h.worker.dispose();
	});

	test(`a second steer while acceptance is pending is rejected; the first then lands [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		h.host.gate.open = false;
		const first = h.worker.steer("first");
		await flush();
		const second = await h.worker.steer("second");
		assert.equal(second.ok, false);
		assert.match(second.reason ?? "", /another steer/);
		h.host.answer();
		assert.equal((await first).ok, true);
		await h.worker.dispose();
	});

	test(`events that race a steer's acceptance land in the new task [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		assistant(h, "old");
		settle(h);
		h.host.gate.open = false;
		const p = h.worker.steer("second task");
		await flush();
		h.ev({ type: "agent_start" });
		userMessage(h, "second task");
		assistant(h, "new answer");
		settle(h);
		h.host.answer();
		assert.equal((await p).ok, true);
		assert.equal(h.counts.settled, 2);
		assert.equal(h.counts.snapshots[1]!.finalOutput, "new answer");
		await h.worker.dispose();
	});

	test(`steer is refused while starting and once finished [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		assert.match((await h.worker.steer("too early")).reason ?? "", /still starting/);
		await boot(h);
		await h.worker.kill();
		assert.equal((await h.worker.steer("too late")).ok, false);
	});

	test(`finalOutput is scoped to the current task after an accepted steer [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		assistant(h, "old answer");
		settle(h);
		assert.equal(h.worker.finalOutput(), "old answer");
		await h.worker.steer("second task");
		assert.equal(h.worker.finalOutput(), "");
		assistant(h, "new answer");
		assert.equal(h.worker.finalOutput(), "new answer");
		await h.worker.dispose();
	});

	// ── task boundaries across queued continuation ─────────────────────────────

	for (const mode of ["followUp", "redirect"] as const) {
		test(`failed run followed by the queued continuation reports the failure (${mode}) [${feed}]`, async () => {
			const h = make({}, {}, undefined, feed);
			await boot(h);
			h.ev({ type: "agent_start" });
			assert.equal((await h.worker.steer("FOLLOW", undefined, mode)).ok, true);
			assistant(h, "partial", { stopReason: "error", errorMessage: "400 invalid request" });
			h.ev({ type: "agent_end", messages: [], willRetry: false });
			h.ev({ type: "agent_start" });
			userMessage(h, "FOLLOW");
			assistant(h, "follow-up done", { stopReason: "stop" });
			h.ev({ type: "agent_end", messages: [], willRetry: false });
			settle(h);
			assert.equal(h.counts.settled, 1);
			assert.deepEqual(h.counts.snapshots[0], { status: "waiting", taskOutcome: "error", finalOutput: "follow-up done" });
			assert.match(h.worker.error ?? "", /Earlier instructions failed.*400 invalid request/);
			assert.equal((await h.worker.steer("NEXT")).ok, true);
			h.ev({ type: "agent_start" });
			assistant(h, "clean");
			settle(h);
			assert.equal(h.worker.taskOutcome, "success");
			assert.equal(h.worker.error, undefined);
			await h.worker.dispose();
		});
	}

	test(`continuation failure after a carried failure keeps both errors [${feed}]`, async () => {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		h.ev({ type: "agent_start" });
		assistant(h, "", { stopReason: "error", errorMessage: "first failure" });
		h.ev({ type: "agent_start" });
		assistant(h, "", { stopReason: "error", errorMessage: "second failure" });
		settle(h);
		assert.equal(h.worker.taskOutcome, "error");
		assert.match(h.worker.error ?? "", /first failure.*final run error: second failure/);
		await h.worker.dispose();
	});

	test(`auto-retry and overflow-compaction runs are recovery, not carried failures [${feed}]`, async () => {
		for (const recovery of ["retry", "agent_end", "compaction"] as const) {
			const h = make({}, {}, undefined, feed);
			await boot(h);
			h.ev({ type: "agent_start" });
			assistant(h, "", { stopReason: "error", errorMessage: "transient" });
			if (recovery === "retry") h.ev({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "transient" });
			if (recovery === "agent_end") h.ev({ type: "agent_end", messages: [], willRetry: true });
			if (recovery === "compaction") h.ev({ type: "compaction_end", reason: "overflow", result: {}, aborted: false, willRetry: true });
			h.ev({ type: "agent_start" });
			assistant(h, "recovered");
			settle(h);
			assert.equal(h.worker.taskOutcome, "success", recovery);
			assert.equal(h.worker.error, undefined);
			await h.worker.dispose();
		}
	});
}

// ── exact steer keys (§app.chat-processes/worker-instructions) ───────────────

test("two identical instructions are two tasks: each begins at the message its own key names, never the other's", async () => {
	for (const feed of FEEDS) {
		const h = make({}, {}, undefined, feed);
		await boot(h);
		assert.equal((await h.worker.steer("same", undefined, "followUp")).ok, true);
		assert.equal((await h.worker.steer("same", undefined, "followUp")).ok, true);
		const [first, second] = [sendKeyOf(h, 0), sendKeyOf(h, 1)];
		assert.notEqual(first, second, "each send its own key");
		assistant(h, "task answer");
		settleRun(h);
		assert.equal(h.counts.settled, 1, "the task's own settle");
		// The FIRST "same" runs: it is not the second instruction's run.
		h.ev({ type: "agent_start" });
		userMessage(h, "same", first);
		assistant(h, "answer one");
		settleRun(h);
		h.ev({ type: "agent_start" });
		userMessage(h, "same", second);
		assistant(h, "answer two");
		settleRun(h);
		if (feed === "keyed") {
			assert.equal(h.counts.settled, 2, "the first run is not the armed instruction's: no settle for it");
			assert.equal(h.counts.snapshots[1]!.finalOutput, "answer two", "the second instruction's task reports its own answer");
			assert.equal(h.worker.finalOutput(), "answer two");
		} else {
			// LEGACY (best-effort): the text match takes the first "same" for the second instruction.
			assert.equal(h.counts.snapshots[1]!.finalOutput, "answer one");
		}
		await h.worker.dispose();
	}
});

test("a keyed delivery moves the boundary on its key alone: another run's start or an equal text never does", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	assistant(h, "old");
	settleRun(h);
	assert.equal((await h.worker.steer("go on")).ok, true);
	// A run an extension's message started (no key), with the same text: not the instruction's. Its
	// settle completes what ran before the instruction, which is still to come.
	h.ev({ type: "agent_start" });
	h.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "go on" }] } });
	assistant(h, "someone else's run");
	settleRun(h);
	assert.equal(h.counts.settled, 2);
	h.ev({ type: "agent_start" });
	userMessage(h, "go on");
	assert.equal(h.worker.finalOutput(), "", "the instruction's task begins at its own message");
	assistant(h, "the instruction's answer");
	settleRun(h);
	assert.equal(h.counts.settled, 3, "the instruction's own settle");
	assert.equal(h.counts.snapshots[2]!.finalOutput, "the instruction's answer");
	await h.worker.dispose();
});

test("an instruction Stop dropped from the queue is reported plainly with the run's settle: one line, never a wait", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	h_start(h);
	assistant(h, "working");
	assert.equal((await h.worker.steer("then do the second part")).ok, true);
	// Stop: the queue is drained (the feed tells the key that never ran), the run aborted and settled.
	h.ev({ type: "send_dropped", sendKey: sendKeyOf(h, 0) });
	assistant(h, "", { stopReason: "aborted" });
	settleRun(h);
	const lines = h.worker.transcript.filter((t) => /accepted but never ran/.test(t.text));
	assert.equal(lines.length, 1, "one line");
	assert.equal(lines[0]!.text, "This instruction was accepted but never ran: then do the second part");
	assert.equal(h.counts.settled, 1, "reported once, with the run's settle");
	assert.equal(h.worker.status, "waiting", "not waiting for a delivery that can't come");
	assert.equal(h.worker.taskOutcome, "aborted");
	assert.match(h.worker.error ?? "", /accepted but never ran: then do the second part/);
	// A drop told again (a replay) changes nothing.
	h.ev({ type: "send_dropped", sendKey: sendKeyOf(h, 0) });
	assert.equal(h.counts.settled, 1);
	assert.equal(h.worker.transcript.filter((t) => /accepted but never ran/.test(t.text)).length, 1);
	// The next instruction is armed and delivered as usual.
	assert.equal((await h.worker.steer("again")).ok, true);
	h.ev({ type: "agent_start" });
	userMessage(h, "again");
	assistant(h, "done again");
	settleRun(h);
	assert.equal(h.counts.snapshots.at(-1)!.finalOutput, "done again");
	assert.equal(h.worker.taskOutcome, "success");
	await h.worker.dispose();
});

test("instructions that land together in one step: the task starts at the last of them, one settle reports the reply to all", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	h_start(h);
	assistant(h, "working on the task");
	assert.equal((await h.worker.steer("also check the docs")).ok, true);
	assert.equal((await h.worker.steer("and the tests")).ok, true);
	// pi's next step takes both steers: two user messages, each naming its own key, then one reply.
	userMessage(h, "also check the docs");
	userMessage(h, "and the tests");
	assistant(h, "checked docs and tests");
	settleRun(h);
	assert.equal(h.counts.settled, 1, "one settle for the batch");
	assert.equal(h.counts.snapshots[0]!.finalOutput, "checked docs and tests", "the task begun at the last instruction: the earlier output is not in it");
	assert.equal(h.worker.taskOutcome, "success");
	const steers = h.worker.transcript.filter((t) => t.kind === "steer").map((t) => t.text);
	assert.deepEqual(steers, ["also check the docs", "and the tests"], "each instruction its own line, in order");
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)), "both ran");
	// Both delivered: a later death owes no never-ran line for either.
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (exit 1)" });
	await h.worker.whenClosed;
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)));
});

test("Stop with several instructions in pi's queue: one never-ran line each, in order, reported with the run's settle", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	h_start(h);
	assistant(h, "working");
	assert.equal((await h.worker.steer("part two")).ok, true);
	assert.equal((await h.worker.steer("part three")).ok, true);
	h.ev({ type: "send_dropped", sendKey: sendKeyOf(h, 0) });
	h.ev({ type: "send_dropped", sendKey: sendKeyOf(h, 1) });
	assistant(h, "", { stopReason: "aborted" });
	settleRun(h);
	const lines = h.worker.transcript.filter((t) => /accepted but never ran/.test(t.text)).map((t) => t.text);
	assert.deepEqual(lines, ["This instruction was accepted but never ran: part two", "This instruction was accepted but never ran: part three"]);
	assert.equal(h.counts.settled, 1, "reported once, with the run's settle");
	assert.equal(h.worker.status, "waiting");
	assert.match(h.worker.error ?? "", /never ran: part two; .*never ran: part three/);
	await h.worker.dispose();
});

test("an instruction to an idle worker whose turn never started is reported at once, as an error", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	assistant(h, "answer");
	settleRun(h);
	assert.equal((await h.worker.steer("next task")).ok, true);
	assert.equal(h.worker.status, "running");
	h.ev({ type: "send_dropped", sendKey: sendKeyOf(h, 0) });
	assert.equal(h.counts.settled, 2, "announced now");
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.worker.taskOutcome, "error");
	assert.equal(h.worker.error, "This instruction was accepted but never ran: next task");
	await h.worker.dispose();
});

test("a keyed worker's process that dies with an accepted instruction unseen: never ran, reported with the resumed run, or with its end", async () => {
	const resumed = make({}, {}, undefined, "keyed");
	await boot(resumed);
	h_start(resumed);
	assert.equal((await resumed.worker.steer("part two")).ok, true);
	resumed.host.end(resumed.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (signal KILL)", resuming: true });
	resumed.host.state(resumed.chatId(), { keys: true });
	assert.equal(resumed.worker.transcript.filter((t) => t.text === "This instruction was accepted but never ran: part two").length, 1);
	assert.equal(resumed.counts.settled, 0, "the resumed run is still going");
	resumed.ev({ type: "agent_start" });
	userMessage(resumed, "This chat's process stopped unexpectedly and cut off your last turn. Continue where you left off.", "crash-key");
	assistant(resumed, "continued");
	settleRun(resumed);
	assert.equal(resumed.counts.settled, 1);
	assert.match(resumed.worker.error ?? "", /accepted but never ran: part two/);
	assert.equal(resumed.worker.status, "waiting");
	await resumed.worker.dispose();

	const ended = make({}, {}, undefined, "keyed");
	await boot(ended);
	h_start(ended);
	assert.equal((await ended.worker.steer("part two")).ok, true);
	ended.host.end(ended.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (exit 1)" });
	await ended.worker.whenClosed;
	assert.equal(ended.worker.status, "error");
	assert.equal(ended.counts.settled, 1, "its end, once");
	assert.match(ended.worker.error ?? "", /exit 1/);
	assert.match(ended.worker.error ?? "", /accepted but never ran: part two/);
	assert.equal(ended.worker.transcript.filter((t) => /accepted but never ran/.test(t.text)).length, 1);
});

test("an idle stop or a new process noted (\"reload\") never drops an accepted instruction: it runs in the new process", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	assistant(h, "first");
	settleRun(h);
	h.host.end(h.chatId(), { cause: "idle" });
	assert.equal((await h.worker.steer("wake up")).ok, true);
	// The server reopens it: the registry notes the new process with an "ended: reload" for the old one.
	h.host.end(h.chatId(), { cause: "reload" });
	h.host.state(h.chatId(), { keys: true });
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)));
	h.ev({ type: "agent_start" });
	userMessage(h, "wake up");
	assistant(h, "awake");
	settleRun(h);
	assert.equal(h.counts.settled, 2);
	assert.equal(h.counts.snapshots[1]!.finalOutput, "awake");
	assert.equal(h.worker.taskOutcome, "success");
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)));
	await h.worker.dispose();
});

test("a death while a steer awaits its acceptance leaves that steer to its send's answer: no never-ran line for it", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	h_start(h);
	h.host.gate.open = false;
	const p = h.worker.steer("racing");
	await flush();
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (signal KILL)", resuming: true });
	h.host.answer("This chat is closed.");
	assert.equal((await p).ok, false);
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)));
	await h.worker.dispose();
});

test("a steer that ran on an unkeyed feed is never reported as never run after its worker moves to keyed code and dies", async () => {
	const h = make({}, {}, undefined, "legacy");
	await boot(h);
	h_start(h);
	assert.equal((await h.worker.steer("go on")).ok, true);
	// Delivered on the unkeyed feed: the text match begins its run.
	userMessage(h, "go on");
	assistant(h, "went on");
	settleRun(h);
	assert.equal(h.counts.snapshots.at(-1)!.finalOutput, "went on");
	// The worker reloads onto code with keys (a new process, keys: true), then dies mid-run.
	h.host.newProcess(h.chatId());
	h.host.state(h.chatId(), { keys: true });
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (signal KILL)", resuming: true });
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)), JSON.stringify(h.worker.transcript.map((t) => t.text)));
	await h.worker.dispose();
});

test("a keyed steer delivered after its worker's feed turned unkeyed is never reported as never run when keyed code later dies", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	h_start(h);
	assert.equal((await h.worker.steer("go on")).ok, true);
	// A process on code from before keys takes over (its state names none) and runs the steer, matched by its text.
	h.host.newProcess(h.chatId());
	h.host.state(h.chatId(), { keys: undefined });
	h.feed = "legacy";
	userMessage(h, "go on");
	assistant(h, "went on");
	settleRun(h);
	assert.equal(h.counts.snapshots.at(-1)!.finalOutput, "went on");
	// Keyed code again, then a death: the steer that ran is not reported.
	h.host.newProcess(h.chatId());
	h.host.state(h.chatId(), { keys: true });
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (signal KILL)", resuming: true });
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)), JSON.stringify(h.worker.transcript.map((t) => t.text)));
	await h.worker.dispose();
});

test("an unkeyed feed's process death keeps today's report: no never-ran line", async () => {
	const h = make({}, {}, undefined, "legacy");
	await boot(h);
	h_start(h);
	assert.equal((await h.worker.steer("part two")).ok, true);
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (exit 1)" });
	await h.worker.whenClosed;
	assert.ok(!h.worker.transcript.some((t) => /accepted but never ran/.test(t.text)));
	assert.equal(h.worker.error, "This worker's process stopped unexpectedly (exit 1)");
});

test("events read again after a dropped link (feedSince) carry the same keys: the task moves once", async () => {
	const h = make({}, {}, undefined, "keyed");
	await boot(h);
	assistant(h, "old");
	settleRun(h);
	assert.equal((await h.worker.steer("second task")).ok, true);
	const w = h.host.get(h.chatId());
	const from = w.frames.length;
	h.ev({ type: "agent_start" });
	userMessage(h, "second task");
	assistant(h, "new answer");
	// The link drops and the server reads the process's ring again: the same frames come once more.
	for (const f of w.frames.slice(from)) for (const fn of [...w.watchers]) fn(f);
	assert.equal(h.worker.finalOutput(), "new answer");
	assert.equal(h.worker.transcript.filter((t) => t.kind === "steer").length, 1, "one marker");
	settleRun(h);
	assert.equal(h.counts.settled, 2);
	assert.equal(h.counts.snapshots[1]!.finalOutput, "new answer");
	await h.worker.dispose();
});

test("a parent reattached to an OLD-format feed (no keys) steering inside a running reply, no new agent_start: the boundary and the final output still advance", async () => {
	const host = new GatedHost();
	const ref = await host.start(workerStartOf({ id: "ag_06", groupId: "g", name: "n", task: "t", cwd: "/w" }, PARENT, "k6", () => "/s"));
	host.state(ref.chatId, { status: "running" });
	const a = await attached(host, ref);
	assert.equal(a.worker.status, "running");
	host.event(ref.chatId, { type: "message_end", message: { role: "assistant", content: "before the steer" } });
	assert.equal((await a.worker.steer("change course")).ok, true);
	assert.equal(host.get(ref.chatId).sends[0]!.delivery, "steer");
	assert.equal(a.worker.finalOutput(), "", "the steer's task has nothing yet");
	// pi delivers the steer inside the running reply: its user message, no agent_start, no key.
	host.event(ref.chatId, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "change course" }] } });
	host.event(ref.chatId, { type: "message_end", message: { role: "assistant", content: "after the steer" } });
	assert.equal(a.worker.finalOutput(), "after the steer");
	host.event(ref.chatId, { type: "agent_settled" });
	assert.equal(a.counts.settled, 1);
	assert.deepEqual(a.counts.outputs, ["after the steer"]);
	assert.equal(a.worker.status, "waiting");
	await a.worker.dispose();
});

// ── the transcript and usage ───────────────────────────────────────────────

test("the transcript tail is bounded in UTF-8 bytes with an omission marker; one revision per push", async () => {
	const h = make({ limits: { maxTranscriptBytes: 3000 } });
	await boot(h);
	const start = h.worker.transcriptRevision;
	for (let i = 0; i < 40; i++) assistant(h, "計".repeat(100));
	assert.ok(h.worker.transcriptOmitted.items > 0);
	assert.equal(h.worker.transcript[0]!.kind, "task", "the task item is never trimmed");
	assert.match(h.worker.transcript[1]!.text, /trimmed/);
	let bytes = 0;
	for (const item of h.worker.transcript) bytes += Buffer.byteLength(item.text, "utf8");
	assert.ok(bytes <= 3000, `within the cap (got ${bytes})`);
	assert.equal(h.worker.transcriptRevision, start + 40);
	await h.worker.dispose();
});

test("individual transcript items are truncated in memory", async () => {
	const h = make({ limits: { maxItemChars: 50 } });
	await boot(h);
	assistant(h, "y".repeat(500));
	const item = h.worker.transcript.find((t) => t.kind === "assistant");
	assert.ok(item && item.text.length < 200);
	assert.match(item!.text, /truncated/);
	await h.worker.dispose();
});

test("usage accumulates across assistant turns and tool results", async () => {
	const h = make();
	await boot(h);
	assistant(h, "one");
	h.ev({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } } } });
	assistant(h, "two");
	assert.equal(h.worker.usage.turns, 2);
	assert.equal(h.worker.usage.input, 21);
	assert.equal(h.worker.usage.output, 12);
	assert.equal(h.worker.usage.cost, 0.52);
	assert.equal(h.worker.usage.contextTokens, 15);
	assert.equal(h.worker.usageScope, "process");
	await h.worker.dispose();
});

// ── kill, dispose and how its chat ends ────────────────────────────────────

test("kill: its chat stopped, late events dropped, one completion, then killed", async () => {
	const h = make();
	await boot(h);
	const killed = h.worker.kill();
	assert.ok(["stopping", "killed"].includes(h.worker.status), h.worker.status);
	h.ev({ type: "agent_start" });
	h.ev({ type: "message_end", message: { role: "assistant", content: "ghost output" } });
	await killed;
	assert.equal(h.worker.status, "killed");
	assert.equal(h.worker.taskOutcome, "aborted");
	assert.equal(h.worker.finalOutput(), "");
	assert.deepEqual(h.host.get(h.chatId()).stops, ["killed by user"]);
	assert.equal(h.counts.settled, 1);
	assert.equal(h.counts.exits, 1);
});

test("killing an idle settled worker does not emit a second completion", async () => {
	const h = make();
	await boot(h);
	assistant(h, "done");
	settle(h);
	await h.worker.kill();
	assert.equal(h.counts.settled, 1);
	assert.equal(h.worker.taskOutcome, "success");
});

test("a kill while the start is in flight stops the chat once it is known, and ends the worker", async () => {
	const h = make();
	const killed = h.worker.kill("not needed");
	await killed;
	assert.equal(h.worker.status, "killed");
	assert.deepEqual(h.host.get("ag_01").stops, ["not needed"]);
});

test("dispose lets go of the worker: its chat runs on, nothing is stopped, nothing announced", async () => {
	const h = make();
	await boot(h);
	await h.worker.dispose();
	assert.deepEqual(h.host.get(h.chatId()).stops, []);
	assert.equal(h.host.get(h.chatId()).watchers.size, 0);
	assert.equal(h.counts.settled, 0);
	assistant(h, "after the parent left");
	assert.equal(h.worker.finalOutput(), "", "no longer folded here");
});

test("its chat's death: once resumed it runs on with a note; otherwise it ends in error with the death text", async () => {
	const h = make();
	await boot(h);
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (signal KILL)\nLast output: x", resuming: true });
	assert.equal(h.worker.isFinished(), false);
	assert.ok(h.worker.transcript.some((t) => t.kind === "system" && /continuing once/.test(t.text) && /signal KILL/.test(t.text)));
	h.host.end(h.chatId(), { cause: "died", detail: "This worker's process stopped unexpectedly (exit 1)" });
	await h.worker.whenClosed;
	assert.equal(h.worker.status, "error");
	assert.match(h.worker.error ?? "", /exit 1/);
	assert.equal(h.counts.settled, 1);
});

test("an idle stop and a reload change nothing the parent sees", async () => {
	const h = make();
	await boot(h);
	h.host.end(h.chatId(), { cause: "idle" });
	h.host.end(h.chatId(), { cause: "reload" });
	assert.equal(h.worker.status, "running");
});

// ── a gap in the feed ──────────────────────────────────────────────────────

test("after a gap the next state is read as a first one: a run that settled in the gap is announced once, a known one never", async () => {
	const h = make();
	await boot(h);
	h.host.state(h.chatId(), { status: "running" });
	for (const fn of [...h.host.get(h.chatId()).watchers]) fn({ t: "gap" });
	h.host.state(h.chatId(), { status: "idle", lastSettled: { key: "parent-1:ag_01:x.1:task#1", outcome: "success" } });
	assert.equal(h.counts.settled, 1);
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.worker.settleKey, "parent-1:ag_01:x.1:task#1");
	// Another gap, the same settle: nothing more.
	for (const fn of [...h.host.get(h.chatId()).watchers]) fn({ t: "gap" });
	h.host.state(h.chatId(), { status: "idle", lastSettled: { key: "parent-1:ag_01:x.1:task#1", outcome: "success" } });
	assert.equal(h.counts.settled, 1);
	await h.worker.dispose();
});

test("without a gap, a state alone never announces (the feed's settle event does)", async () => {
	const h = make();
	await boot(h);
	h.host.state(h.chatId(), { status: "idle", lastSettled: { key: "x#1", outcome: "success" } });
	assert.equal(h.counts.settled, 0);
	await h.worker.dispose();
});

// ── picked back up (attach) ────────────────────────────────────────────────

async function attached(host: FakeWorkerHost, ref: WorkerRef, attach: Partial<NonNullable<ConstructorParameters<typeof ChatWorker>[2]["attach"]>> = {}) {
	const counts = { settled: 0, outputs: [] as string[] };
	const worker = new ChatWorker(
		{ id: ref.workerId, groupId: "run_01", name: "test", task: "count", cwd: "/work" },
		{ onChange() {}, onSettled: (w) => { counts.settled++; counts.outputs.push(w.finalOutput()); }, onExit() {} },
		{ host, parent: PARENT, attach: { ref, ...attach } },
	);
	await flush();
	return { worker, counts };
}

test("picked back up: a run that settled while no parent watched is announced once; the recorded one never", async () => {
	const host = new FakeWorkerHost();
	const ref = await host.start(workerStartOf({ id: "ag_03", groupId: "g", name: "n", task: "t", cwd: "/w" }, PARENT, "k3", () => "/s"));
	host.turn(ref.chatId, { user: "t", reply: "done while away", key: "k3:task#1" });
	const fresh = await attached(host, ref, { settleKey: "k3:task#0" });
	assert.equal(fresh.counts.settled, 1);
	assert.equal(fresh.worker.status, "waiting");
	assert.equal(fresh.worker.settleKey, "k3:task#1");
	assert.equal(fresh.worker.usageScope, "session");
	await fresh.worker.dispose();
	const again = await attached(host, ref, { settleKey: "k3:task#1" });
	assert.equal(again.counts.settled, 0);
	await again.worker.dispose();
});

test("picked back up mid-run: its settle is owed and announced when it comes", async () => {
	const host = new FakeWorkerHost();
	const ref = await host.start(workerStartOf({ id: "ag_04", groupId: "g", name: "n", task: "t", cwd: "/w" }, PARENT, "k4", () => "/s"));
	host.state(ref.chatId, { status: "running" });
	const a = await attached(host, ref);
	assert.equal(a.worker.status, "running");
	host.turn(ref.chatId, { reply: "finished", key: "k4:task#1" });
	assert.equal(a.counts.settled, 1);
	assert.equal(a.worker.settleKey, "k4:task#1");
	assert.equal(a.worker.settleEntryId !== undefined, true);
	await a.worker.dispose();
});

test("picked back up after its process was reopened: the file tells a run settled after the recorded one", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-worker-"));
	try {
		const file = path.join(dir, "w.jsonl");
		const line = (id: string, at: string, stopReason: string) => JSON.stringify({ type: "message", id, timestamp: at, message: { role: "assistant", content: [], stopReason } });
		fs.writeFileSync(file, [line("a1", "2026-10-12T10:00:00.000Z", "stop"), line("a2", "2026-10-12T11:00:00.000Z", "toolUse"), line("a3", "2026-10-12T11:05:00.000Z", "stop")].join("\n") + "\n");
		assert.deepEqual(lastSettledRun(file), { entryId: "a3", at: Date.parse("2026-10-12T11:05:00.000Z") });
		const host = new FakeWorkerHost();
		const ref = await host.start({ ...workerStartOf({ id: "ag_05", groupId: "g", name: "n", task: "t", cwd: "/w", resume: { sessionFile: file } }, PARENT, "k5", () => dir) });
		host.state(ref.chatId, { status: "idle", lastSettled: null });
		const owed = await attached(host, ref, { settleEntryId: "a1", settledAt: Date.parse("2026-10-12T10:00:01.000Z") });
		assert.equal(owed.counts.settled, 1);
		assert.equal(owed.worker.settleEntryId, "a3");
		await owed.worker.dispose();
		const known = await attached(host, ref, { settleEntryId: "a3", settledAt: Date.parse("2026-10-12T11:05:01.000Z") });
		assert.equal(known.counts.settled, 0);
		await known.worker.dispose();
		// A worker resumed after its last run (its record newer than the file's run): nothing owed.
		const resumed = await attached(host, ref, { settledAt: Date.parse("2026-10-12T12:00:00.000Z") });
		assert.equal(resumed.counts.settled, 0);
		await resumed.worker.dispose();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
