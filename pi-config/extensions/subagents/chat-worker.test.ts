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

interface Harness {
	worker: ChatWorker;
	host: GatedHost;
	counts: { change: number; settled: number; exits: number; snapshots: { status: string; taskOutcome?: string; finalOutput: string }[] };
	ev(event: Record<string, unknown>): void;
	chatId(): string;
}

function make(options: Partial<SpawnOptions> = {}, hostOptions: FakeWorkerHostOptions = {}, host = new GatedHost(hostOptions)): Harness {
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
	return { worker, host, counts, chatId, ev: (event) => host.event(chatId(), event) };
}

/** The start answered: the worker is bound to its chat and its task accepted. */
async function boot(h: Harness): Promise<void> {
	await flush();
	assert.ok(h.worker.chatId, "bound");
}

function assistant(h: Harness, text: string, extra: Record<string, unknown> = {}): void {
	h.ev({ type: "message_end", message: { role: "assistant", content: text, usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } }, ...extra } });
}
const settle = (h: Harness) => h.ev({ type: "agent_settled" });
const userMessage = (h: Harness, text: string) => h.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });

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

test("a steer from waiting is a fresh prompt and clears the stale outcome; while running it steers; a follow-up queues", async () => {
	const h = make();
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

test("a rejected steer reports ok:false and changes nothing (its marker rolled back)", async () => {
	const h = make({}, { failSend: () => "message too long" });
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

test("a steer the server never answers leaves the worker running and unstopped, reports delivery unknown, and sends nothing again", async () => {
	let down = true;
	const NO_SERVER = "The Sova server isn't answering, so this action didn't run. Try it again in a minute.";
	const h = make({}, { failSend: () => (down ? noAnswer(NO_SERVER) : undefined) });
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

test("an idle worker whose steer goes unanswered stays waiting with its last outcome", async () => {
	const h = make({}, { failSend: () => noAnswer("The Sova server isn't answering, so this action didn't run. Try it again in a minute.") });
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

test("a second steer while acceptance is pending is rejected; the first then lands", async () => {
	const h = make();
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

test("events that race a steer's acceptance land in the new task", async () => {
	const h = make();
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

test("steer is refused while starting and once finished", async () => {
	const h = make();
	assert.match((await h.worker.steer("too early")).reason ?? "", /still starting/);
	await boot(h);
	await h.worker.kill();
	assert.equal((await h.worker.steer("too late")).ok, false);
});

test("finalOutput is scoped to the current task after an accepted steer", async () => {
	const h = make();
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
	test(`failed run followed by the queued continuation reports the failure (${mode})`, async () => {
		const h = make();
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

test("continuation failure after a carried failure keeps both errors", async () => {
	const h = make();
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

test("auto-retry and overflow-compaction runs are recovery, not carried failures", async () => {
	for (const recovery of ["retry", "agent_end", "compaction"] as const) {
		const h = make();
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
