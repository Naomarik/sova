/**
 * What a worker's own replies mean to its parent, at the fold, over both feeds: any reply a worker
 * makes on its own after finishing is a new report (a background job's end wakes it from inside its
 * own process, so no steer precedes that run), and a report carries every final answer since the last
 * one. Over the in-memory FakeWorkerHost; the manager's side is in worker-settle-report.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChatWorker, sessionDirName, workerStartOf } from "./chat-worker.ts";
import type { SpawnOptions } from "./runner.ts";
import { noAnswer, type WorkerHost, type WorkerRef } from "./worker-host.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";

const PARENT = { sessionId: "parent-1", path: "/sessions/parent-1.jsonl" };
const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host whose sends can be held open (an acceptance still in flight) and answered by the test. */
class GatedHost extends FakeWorkerHost {
	gate: { open: boolean; waiting: { resolve: () => void; reject: (e: Error) => void }[] } = { open: true, waiting: [] };
	async send(chatId: string, input: Parameters<WorkerHost["send"]>[1]): Promise<{ queued: boolean }> {
		if (!this.gate.open) await new Promise<void>((resolve, reject) => this.gate.waiting.push({ resolve, reject }));
		return super.send(chatId, input);
	}
	answer(error?: Error): void {
		const w = this.gate.waiting.shift()!;
		if (error) w.reject(error);
		else w.resolve();
	}
}

type Feed = "legacy" | "keyed";
const FEEDS: Feed[] = ["legacy", "keyed"];

function make(feed: Feed, options: Partial<SpawnOptions> = {}, host = new GatedHost()) {
	const counts = { settled: 0, snapshots: [] as { status: string; taskOutcome?: string; finalOutput: string; error?: string }[] };
	const worker = new ChatWorker(
		{ id: "ag_01", groupId: "run_01", name: "test", task: "do the work", cwd: "/work", ...options },
		{
			onChange() {},
			onSettled: (w) => {
				counts.settled++;
				counts.snapshots.push({ status: w.status, taskOutcome: w.taskOutcome, finalOutput: w.finalOutput(), error: w.error });
			},
			onExit() {},
		},
		{ host, parent: PARENT, start: { key: "parent-1:ag_01:x.1", defaultSessionDir: (cwd) => `/agent/sessions/${sessionDirName(cwd)}` } },
	);
	const chatId = () => worker.chatId!;
	const ev = (event: Record<string, unknown>) => host.event(chatId(), event);
	return { feed, worker, host, counts, chatId, ev };
}
type H = ReturnType<typeof make>;

async function boot(h: H): Promise<void> {
	await flush();
	assert.ok(h.worker.chatId, "bound");
	if (h.feed === "keyed") h.host.state(h.chatId(), { keys: true });
}
function assistant(h: H, text: string, extra: Record<string, unknown> = {}): void {
	h.ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } });
}
/** A job's end card: pi delivers it as a user message nobody's send names (wake-nudge.ts, pi.sendUserMessage). */
function card(h: H, text = "[job j1] It passed (exit code 0)."): void {
	h.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
}
const settleRun = (h: H) => (h.ev({ type: "agent_end", messages: [] }), h.ev({ type: "agent_settled" }));
/** The task's run: its answer, then its settle. */
function firstReport(h: H, text = "first report"): void {
	h.ev({ type: "agent_start" });
	assistant(h, text);
	settleRun(h);
	assert.equal(h.counts.settled, 1, "the task's own report");
}
/** A whole run the worker started by itself: a job's end card, its reply, its settle. */
function selfRun(h: H, reply: string | null): void {
	h.ev({ type: "agent_start" });
	card(h);
	if (reply !== null) assistant(h, reply);
	settleRun(h);
}
/** Delivered as the steer's own key on a keyed feed, by text on the other. */
function delivered(h: H, text: string): void {
	const message = { role: "user", content: [{ type: "text", text }] };
	if (h.feed !== "keyed") return h.ev({ type: "message_end", message });
	const key = h.host.get(h.chatId()).sends.find((s) => s.text === text)!.key;
	h.ev({ type: "message_end", message, sendKey: key });
}

function inOrder(text: string, ...parts: string[]): void {
	let from = 0;
	for (const part of parts) {
		const at = text.indexOf(part, from);
		assert.notEqual(at, -1, `${JSON.stringify(part)} after offset ${from} in ${JSON.stringify(text)}`);
		from = at + part.length;
	}
}

for (const feed of FEEDS) {
	// ── a self-started run is a new report ────────────────────────────────────

	test(`settle: a job's end wakes a worker that finished: its reply is a second report and it goes back to idle [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		selfRun(h, "final");
		assert.equal(h.counts.settled, 2, "settled");
		assert.equal(h.worker.status, "waiting", "status");
		assert.equal(h.worker.isSettled(), true);
		assert.equal(h.worker.taskOutcome, "success");
		assert.equal(h.counts.snapshots[1]!.status, "waiting");
		assert.equal(h.counts.snapshots[1]!.finalOutput, "final", "only what it wrote since its last report");
		await h.worker.dispose();
	});

	test(`settle: each of several wakes reports once, each with its own reply [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		selfRun(h, "second");
		selfRun(h, "third");
		assert.deepEqual(h.counts.snapshots.map((s) => s.finalOutput), ["first report", "second", "third"]);
		assert.equal(h.worker.status, "waiting");
		await h.worker.dispose();
	});

	test(`settle: while a self-started run goes, the worker has no outcome yet and isn't idle [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "agent_start" });
		card(h);
		assert.equal(h.worker.status, "running");
		assert.equal(h.worker.isSettled(), false);
		assert.equal(h.worker.taskOutcome, undefined, "'running' with 'task success' never shows");
		assistant(h, "final");
		settleRun(h);
		await h.worker.dispose();
	});

	test(`settle: a worker reopened idle owes nothing, but a job's end on it reports once [${feed}]`, async () => {
		const h = make(feed, { resume: { sessionFile: "/s/old.jsonl", startedAt: 1 } });
		await boot(h);
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.counts.settled, 0);
		selfRun(h, "woken on a reopened worker");
		assert.equal(h.counts.settled, 1, "settled");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.counts.snapshots[0]!.finalOutput, "woken on a reopened worker");
		await h.worker.dispose();
	});

	test(`settle: a self-started run that ends well with nothing written: idle, nothing sent, the last report stays readable [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		selfRun(h, null);
		assert.equal(h.counts.settled, 1, "nothing is sent");
		assert.equal(h.worker.status, "waiting", "status");
		assert.equal(h.worker.taskOutcome, "success", "the last report's outcome stands");
		assert.equal(h.worker.finalOutput(), "first report");
		// The same with a turn that only called tools and then said nothing.
		h.ev({ type: "agent_start" });
		card(h);
		assistant(h, "checking the log", { stopReason: "toolUse" });
		h.ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
		settleRun(h);
		assert.equal(h.counts.settled, 1, "commentary on the way to a tool is no answer");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.worker.finalOutput(), "first report");
		await h.worker.dispose();
	});

	test(`settle: a self-started run that fails always reports, even with nothing written [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "agent_start" });
		card(h);
		h.ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider 500" } });
		settleRun(h);
		assert.equal(h.counts.settled, 2, "settled");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.counts.snapshots[1]!.taskOutcome, "error");
		assert.equal(h.counts.snapshots[1]!.error, "provider 500");
		// An aborted one too, and the next good reply clears the failure.
		h.ev({ type: "agent_start" });
		card(h);
		h.ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
		settleRun(h);
		assert.equal(h.counts.settled, 3);
		assert.equal(h.counts.snapshots[2]!.taskOutcome, "aborted");
		selfRun(h, "fine again");
		assert.equal(h.counts.snapshots[3]?.taskOutcome, "success");
		assert.equal(h.worker.error, undefined);
		await h.worker.dispose();
	});

	test(`settle: a retry's run after a settle was announced ends idle, never stuck [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "agent_end", messages: [], willRetry: true });
		h.ev({ type: "agent_start" });
		assistant(h, "after the retry");
		settleRun(h);
		assert.equal(h.worker.status, "waiting", "status");
		assert.equal(h.worker.isSettled(), true);
		await h.worker.dispose();
	});

	// ── the steer race ────────────────────────────────────────────────────────

	for (const [how, error] of [["rejected", new Error("message too long")], ["unanswered", noAnswer("The Sova server isn't answering")]] as const) {
		test(`settle: a card's run starting while a steer awaits its answer still reports when the steer is ${how} [${feed}]`, async () => {
			const h = make(feed);
			await boot(h);
			firstReport(h);
			h.host.gate.open = false;
			const steer = h.worker.steer("change course");
			await flush();
			h.ev({ type: "agent_start" });
			card(h);
			h.host.answer(error);
			assert.equal((await steer).ok, false);
			assert.equal(h.worker.status, "running", "the card's run goes on");
			assistant(h, "replied to the card");
			settleRun(h);
			assert.equal(h.counts.settled, 2, "settled");
			assert.equal(h.worker.status, "waiting", "status");
			assert.equal(h.counts.snapshots[1]!.finalOutput, "replied to the card");
			await h.worker.dispose();
		});
	}

	// ── a report carries every answer since the last ──────────────────────────

	test(`settle: a card landing right after a final answer shares its settle: the report holds both, oldest first [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		h.ev({ type: "agent_start" });
		assistant(h, "Real report\nwith its findings");
		card(h);
		assistant(h, "No action needed");
		settleRun(h);
		assert.equal(h.counts.settled, 1, "one settle");
		const report = h.counts.snapshots[0]!.finalOutput;
		inOrder(report, "Real report\nwith its findings", "No action needed");
		assert.equal(report.split("\n")[0], "Real report", "the first line stays the earlier answer's");
		assert.equal(h.worker.finalOutput(), report, "read-back shows the same answers");
		await h.worker.dispose();
	});

	test(`settle: three answers with two cards keep their order, and the next report starts fresh [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		h.ev({ type: "agent_start" });
		assistant(h, "one");
		card(h, "[job j1] ended");
		assistant(h, "two");
		card(h, "[job j2] ended");
		assistant(h, "three");
		settleRun(h);
		inOrder(h.counts.snapshots[0]!.finalOutput, "one", "two", "three");
		selfRun(h, "four");
		assert.equal(h.counts.snapshots[1]!.finalOutput, "four", "what the last report carried isn't sent again");
		await h.worker.dispose();
	});

	test(`settle (guard): commentary on the way to a tool is no answer, whatever follows it [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		h.ev({ type: "agent_start" });
		assistant(h, "let me check the log", { stopReason: "toolUse" });
		card(h);
		assistant(h, "the real answer");
		settleRun(h);
		assert.equal(h.counts.snapshots[0]!.finalOutput, "the real answer");
		await h.worker.dispose();
	});

	test(`settle (guard): an answer an instruction superseded isn't in that instruction's report [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h, "old report");
		assert.equal((await h.worker.steer("new instruction")).ok, true);
		h.ev({ type: "agent_start" });
		delivered(h, "new instruction");
		assistant(h, "new report");
		settleRun(h);
		assert.equal(h.counts.settled, 2);
		assert.equal(h.counts.snapshots[1]!.finalOutput, "new report");
		await h.worker.dispose();
	});

	test(`settle (guard): a steer during a card's run reports once, with the steer's answer [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "agent_start" });
		card(h);
		assert.equal((await h.worker.steer("look at this too")).ok, true);
		delivered(h, "look at this too");
		assistant(h, "looked");
		settleRun(h);
		assert.equal(h.counts.settled, 2);
		assert.equal(h.counts.snapshots[1]!.finalOutput, "looked");
		assert.equal(h.worker.status, "waiting");
		await h.worker.dispose();
	});

	// ── nothing doubled ───────────────────────────────────────────────────────

	test(`settle (guard): frames read again after a dropped link never announce a settled run twice [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		const w = h.host.get(h.chatId());
		const from = w.frames.length;
		firstReport(h);
		for (const f of w.frames.slice(from)) for (const fn of [...w.watchers]) fn(f);
		assert.equal(h.counts.settled, 1, "settled");
		await h.worker.dispose();
	});

	test(`settle: frames read again leave the worker as it was: idle, no doubled answer [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		const w = h.host.get(h.chatId());
		const from = w.frames.length;
		firstReport(h);
		for (const f of w.frames.slice(from)) for (const fn of [...w.watchers]) fn(f);
		assert.equal(h.worker.status, "waiting", "status");
		assert.equal(h.worker.transcript.filter((t) => t.kind === "assistant").length, 1, "one answer");
		await h.worker.dispose();
	});

	test(`settle: a new process's frames count again though their numbers restart: its reply reports [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.host.end(h.chatId(), { cause: "reload" });
		if (feed === "keyed") h.host.state(h.chatId(), { keys: true });
		selfRun(h, "reply from the new process");
		assert.equal(h.counts.settled, 2, "settled");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.counts.snapshots[1]!.finalOutput, "reply from the new process");
		await h.worker.dispose();
	});

	test(`settle: a gap with a run going, whose file can't be read: its report is that run's reply, once, not the last report again [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		const w = h.host.get(h.chatId());
		for (const fn of [...w.watchers]) fn({ t: "gap" });
		h.host.state(h.chatId(), { status: "running" });
		assert.equal(h.worker.status, "running");
		card(h);
		assistant(h, "reply after the gap");
		settleRun(h);
		assert.equal(h.counts.settled, 2, "settled");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.counts.snapshots[1]!.finalOutput, "reply after the gap");
		await h.worker.dispose();
	});

	test(`settle (guard): a compaction after a settle starts no report [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "compaction_start", reason: "threshold" });
		h.ev({ type: "compaction_end", reason: "threshold", result: {}, aborted: false });
		h.ev({ type: "agent_settled" });
		assert.equal(h.counts.settled, 1, "settled");
		assert.equal(h.worker.status, "waiting");
		assert.equal(h.worker.finalOutput(), "first report");
		await h.worker.dispose();
	});

	test(`settle (guard): a settle with no run after it is not a report [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.ev({ type: "agent_settled" });
		h.host.state(h.chatId(), { status: "idle" });
		assert.equal(h.counts.settled, 1);
		await h.worker.dispose();
	});
}

// ── a queued instruction: as today ─────────────────────────────────────────

for (const feed of FEEDS) {
	test(`settle: a run nothing is owed for, once a held steer is refused, ends idle with no second report [${feed}]`, async () => {
		const h = make(feed);
		await boot(h);
		firstReport(h);
		h.host.gate.open = false;
		const steer = h.worker.steer("change course");
		await flush();
		// A run settles and reports while the steer's answer is still out; another run starts; then the refusal.
		h.ev({ type: "agent_start" });
		card(h);
		assistant(h, "replied to the card");
		settleRun(h);
		assert.equal(h.counts.settled, 2);
		h.ev({ type: "agent_start" });
		h.host.answer(new Error("message too long"));
		assert.equal((await steer).ok, false);
		assert.equal(h.worker.status, "running");
		settleRun(h);
		assert.equal(h.counts.settled, 2, "nothing more to say");
		assert.equal(h.worker.status, "waiting", "status");
		assert.equal(h.worker.isSettled(), true);
		await h.worker.dispose();
	});
}

test("settle (guard): a superseded instruction's run settles silently while the armed one is due; the status stays running until it ends", async () => {
	const h = make("keyed");
	await boot(h);
	assert.equal((await h.worker.steer("one", undefined, "followUp")).ok, true);
	assert.equal((await h.worker.steer("two", undefined, "followUp")).ok, true);
	assistant(h, "task answer");
	settleRun(h);
	assert.equal(h.counts.settled, 1);
	// "one" runs: it isn't the armed instruction, so no report and no idle yet.
	h.ev({ type: "agent_start" });
	delivered(h, "one");
	assistant(h, "answer one");
	settleRun(h);
	assert.equal(h.counts.settled, 1, "no settle for it");
	assert.equal(h.worker.status, "running", "still owed the armed instruction's report");
	h.ev({ type: "agent_start" });
	delivered(h, "two");
	assistant(h, "answer two");
	settleRun(h);
	assert.equal(h.counts.settled, 2);
	assert.equal(h.worker.status, "waiting");
	assert.equal(h.counts.snapshots[1]!.finalOutput, "answer two");
	await h.worker.dispose();
});

test("settle (guard): a worker picked back up reports a run nobody here steered, once", async () => {
	const host = new FakeWorkerHost();
	const ref: WorkerRef = await host.start(workerStartOf({ id: "ag_03", groupId: "g", name: "n", task: "t", cwd: "/w" }, PARENT, "k3", () => "/s"));
	host.turn(ref.chatId, { user: "t", reply: "done", key: "k3:task#1" });
	const outputs: string[] = [];
	const worker = new ChatWorker(
		{ id: ref.workerId, groupId: "run_01", name: "test", task: "t", cwd: "/w" },
		{ onChange() {}, onSettled: (w) => void outputs.push(w.finalOutput()), onExit() {} },
		{ host, parent: PARENT, attach: { ref, settleKey: "k3:task#1" } },
	);
	await flush();
	assert.equal(outputs.length, 0, "the recorded settle isn't announced again");
	host.turn(ref.chatId, { user: "[job j1] ended", reply: "woken", key: "k3:job" });
	assert.deepEqual(outputs, ["woken"]);
	assert.equal(worker.status, "waiting");
	await worker.dispose();
});
