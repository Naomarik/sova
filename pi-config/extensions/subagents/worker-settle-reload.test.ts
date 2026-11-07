/**
 * A worker picked back up reads its report from its session file: a missed report carries every answer
 * since the recorded settle, an idle worker's latest report reads back, and a run seen only in part
 * reports each answer once. Over FakeWorkerHost and real session files; no process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answersInFile, ChatWorker, workerStartOf } from "./chat-worker.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";
import { readWorkerManifests, WORKER_MANIFEST_ENTRY_TYPE } from "./worker-transcript.ts";
import type { WorkerRef } from "./worker-host.ts";

const PARENT = { sessionId: "parent-1", path: "/sessions/parent-1.jsonl" };
const LONG_B = `The real report\n${"b".repeat(4000)}`;
const C = "No action needed";
const T0 = Date.parse("2026-10-12T10:00:00.000Z");

type Line = { id: string; role: "user" | "assistant"; text: string; stopReason?: string };

const entry = (l: Line, i: number) =>
	JSON.stringify({
		type: "message",
		id: l.id,
		timestamp: new Date(T0 + i * 1000).toISOString(),
		message: { role: l.role, content: [{ type: "text", text: l.text }], ...(l.role === "assistant" ? { stopReason: l.stopReason ?? "stop" } : {}) },
	});
const write = (file: string, lines: Line[]) => fs.writeFileSync(file, lines.map(entry).join("\n") + "\n");

/** A recorded, then B (4,000 chars) after a job's card, then C after another. */
const ABC: Line[] = [
	{ id: "u0", role: "user", text: "do the work" },
	{ id: "A", role: "assistant", text: "The answer already reported" },
	{ id: "u1", role: "user", text: "[job j1] ended" },
	{ id: "t1", role: "assistant", text: "checking the log", stopReason: "toolUse" },
	{ id: "B", role: "assistant", text: LONG_B },
	{ id: "u2", role: "user", text: "[job j2] ended" },
	{ id: "C", role: "assistant", text: C },
];

async function rig(fn: (r: { file: string; host: FakeWorkerHost; ref: WorkerRef }) => Promise<void>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-reload-"));
	try {
		const file = path.join(dir, "w.jsonl");
		fs.writeFileSync(file, "");
		const host = new FakeWorkerHost();
		const ref = await host.start(workerStartOf({ id: "ag_01", groupId: "g", name: "n", task: "t", cwd: "/w", resume: { sessionFile: file } }, PARENT, "k", () => dir));
		await fn({ file, host, ref });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Attach, past the first state's answer to the watch, and keep what it announces. */
async function attached(host: FakeWorkerHost, ref: WorkerRef, attach: Record<string, unknown> = {}) {
	const settles: string[] = [];
	const quiet = { count: 0 };
	const worker = new ChatWorker(
		{ id: ref.workerId, groupId: "g", name: "n", task: "t", cwd: "/w" },
		{ onChange() {}, onSettled: (w) => void settles.push(w.finalOutput()), onQuietSettled: () => void quiet.count++, onExit() {} },
		{ host, parent: PARENT, attach: { ref, ...attach } },
	);
	// The watch starts in a microtask and a host answers it at once.
	await new Promise((resolve) => setImmediate(resolve));
	return { worker, settles, quiet };
}

const assertBC = (report: string | undefined) => {
	assert.ok(report);
	assert.ok(report.includes(LONG_B), "B whole");
	assert.ok(report.indexOf(LONG_B) < report.indexOf(C), "oldest first");
	assert.ok(report.endsWith(C), "C last");
	assert.ok(!report.includes("already reported"), "A isn't sent again");
	assert.ok(!report.includes("checking the log"), "commentary is no answer");
};

test("reload: a missed report holds every answer since the record, by the process's own settle", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, ABC);
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#2", entryId: "C", outcome: "success" } });
		const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "A", settledAt: T0 + 2000 });
		assert.equal(settles.length, 1);
		assertBC(settles[0]);
		assert.equal(worker.status, "waiting");
		await worker.dispose();
	});
});

test("reload: a missed report holds every answer since the record, by the file when the process was reopened", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, ABC);
		host.state(ref.chatId, { status: "idle", lastSettled: null });
		const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 2000 });
		assert.equal(settles.length, 1);
		assertBC(settles[0]);
		assert.equal(worker.settleEntryId, "C");
		await worker.dispose();
	});
});

test("reload: a settle's report stops at its own entry, not at what a later run wrote", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, [...ABC, { id: "u3", role: "user", text: "next" }, { id: "D", role: "assistant", text: "a later run" }]);
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#2", entryId: "C", outcome: "success" } });
		const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "A" });
		assertBC(settles[0]);
		await worker.dispose();
	});
});

test("reload: a recorded entry older than the file's tail is still found, so nothing older is sent", async () => {
	await rig(async ({ file, host, ref }) => {
		const padding: Line[] = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, role: "assistant" as const, text: "x".repeat(20_000), stopReason: "toolUse" }));
		write(file, [{ id: "old", role: "assistant", text: "older than the record" }, { id: "A", role: "assistant", text: "the record" }, ...padding, { id: "B", role: "assistant", text: "the new one" }]);
		assert.deepEqual(answersInFile(file, { after: "A" }), ["the new one"]);
		assert.equal(answersInFile(file, { after: "A", upTo: "nope" }), null);
		host.state(ref.chatId, { status: "idle", lastSettled: null });
		const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 1 });
		assert.deepEqual(settles, ["the new one"]);
		await worker.dispose();
	});
});

for (const [path_, lastSettled] of [["its process's settle", { key: "k#1", entryId: "C", outcome: "success" }], ["the file", null]] as const) {
	test(`reload: an idle worker with nothing new reads back its latest answer and announces nothing (${path_})`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, ABC);
			host.state(ref.chatId, { status: "idle", lastSettled });
			const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "C", settledAt: T0 + 60_000 });
			assert.equal(settles.length, 0);
			assert.equal(worker.finalOutput(), C, "older records: the newest answer");
			assert.equal(worker.status, "waiting");
			await worker.dispose();
		});
	});

	test(`reload: a report of answer, card, note reads back whole, the note never hiding it (${path_})`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, ABC);
			host.state(ref.chatId, { status: "idle", lastSettled });
			const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "C", settledAt: T0 + 60_000, priorSettle: { entryId: "A" } });
			assert.equal(settles.length, 0);
			assertBC(worker.finalOutput());
			await worker.dispose();
		});
	});
}

test("reload: a first report reads back from the start of the file", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, ABC);
		host.state(ref.chatId, { status: "idle", lastSettled: null });
		const { worker } = await attached(host, ref, { settleEntryId: "C", settledAt: T0 + 60_000, priorSettle: {} });
		const report = worker.finalOutput();
		assert.ok(report.startsWith("The answer already reported"));
		assert.ok(report.endsWith(C));
		await worker.dispose();
	});
});

test("reload: an instruction not answered yet reads back as nothing, never the answer before it", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, [...ABC, { id: "u3", role: "user", text: "next" }]);
		host.state(ref.chatId, { status: "idle", lastSettled: null });
		const { worker, settles } = await attached(host, ref, { settleEntryId: "C", settledAt: T0 + 60_000 });
		assert.equal(settles.length, 0);
		assert.equal(worker.finalOutput(), "");
		await worker.dispose();
	});
});

test("reload: an unreadable file leaves the report as it was, as no output", async () => {
	await rig(async ({ file, host, ref }) => {
		fs.rmSync(file);
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#2", entryId: "C", outcome: "success" } });
		const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "A" });
		assert.deepEqual(settles, [""]);
		await worker.dispose();
	});
});

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

test("reload mid-run: an answer written before the attach is in the next settle exactly once, whether or not the feed repeats it", async () => {
	for (const repeats of [false, true]) {
		await rig(async ({ file, host, ref }) => {
			const before = "The report written before the attach";
			const lines: Line[] = [
				{ id: "A", role: "assistant", text: "already reported" },
				{ id: "u1", role: "user", text: "[job j1] ended" },
				{ id: "B", role: "assistant", text: before },
				{ id: "u2", role: "user", text: "[job j2] ended" },
			];
			write(file, lines);
			host.state(ref.chatId, { status: "running", lastSettled: null });
			const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 500 });
			assert.equal(worker.status, "running");
			if (repeats) host.event(ref.chatId, { type: "message_end", message: assistant(before), entryId: "B" });
			host.event(ref.chatId, { type: "message_end", message: assistant(C), entryId: "C" });
			write(file, [...lines, { id: "C", role: "assistant", text: C }]);
			host.event(ref.chatId, { type: "agent_settled", settleKey: "k#2", settleEntryId: "C" });
			assert.equal(settles.length, 1);
			const report = settles[0]!;
			assert.equal(report.split(before).length - 1, 1, `once (feed repeats: ${repeats}): ${report}`);
			assert.ok(report.endsWith(C));
			assert.ok(!report.includes("already reported"));
			assert.equal(worker.status, "waiting");
			await worker.dispose();
		});
	}
});

test("reload mid-run: a file that doesn't hold the settle's entry yet leaves what the feed showed", async () => {
	await rig(async ({ file, host, ref }) => {
		write(file, [{ id: "A", role: "assistant", text: "already reported" }]);
		host.state(ref.chatId, { status: "running", lastSettled: null });
		const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 500 });
		host.event(ref.chatId, { type: "message_end", message: assistant("from the feed"), entryId: "C" });
		host.event(ref.chatId, { type: "agent_settled", settleKey: "k#2", settleEntryId: "C" });
		assert.deepEqual(settles, ["from the feed"]);
		await worker.dispose();
	});
});

test("reload mid-run: a settle the file can't place reports what the file holds when the feed showed nothing, and what the feed showed otherwise", async () => {
	const lines: Line[] = [{ id: "A", role: "assistant", text: "already reported" }, { id: "B", role: "assistant", text: "from the file" }];
	for (const settleEntryId of [undefined, "not-written-yet"]) {
		for (const fed of [false, true]) {
			await rig(async ({ file, host, ref }) => {
				write(file, lines);
				host.state(ref.chatId, { status: "running", lastSettled: null });
				const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 500 });
				if (fed) host.event(ref.chatId, { type: "message_end", message: assistant("from the feed"), entryId: "C" });
				host.event(ref.chatId, { type: "agent_settled", settleKey: "k#2", ...(settleEntryId ? { settleEntryId } : {}) });
				assert.deepEqual(settles, [fed ? "from the feed" : "from the file"]);
				await worker.dispose();
			});
		}
	}
});

test("reload mid-run: only the run under way at the attach reads the file; the next one reports what it wrote", async () => {
	await rig(async ({ file, host, ref }) => {
		const lines: Line[] = [{ id: "A", role: "assistant", text: "already reported" }, { id: "B", role: "assistant", text: "first run" }];
		write(file, lines);
		host.state(ref.chatId, { status: "running", lastSettled: null });
		const { worker, settles } = await attached(host, ref, { settleEntryId: "A", settledAt: T0 + 500 });
		host.event(ref.chatId, { type: "agent_settled", settleKey: "k#2", settleEntryId: "B" });
		assert.deepEqual(settles, ["first run"]);
		host.event(ref.chatId, { type: "agent_start" });
		host.event(ref.chatId, { type: "message_end", message: assistant("second run"), entryId: "D" });
		write(file, [...lines, { id: "D", role: "assistant", text: "second run" }]);
		host.event(ref.chatId, { type: "agent_settled", settleKey: "k#3", settleEntryId: "D" });
		assert.equal(settles[1], "second run");
		await worker.dispose();
	});
});

test("reload after a gap: a run settled in the gap reports what the feed never showed, and what it did show once", async () => {
	await rig(async ({ file, host, ref }) => {
		const lines: Line[] = [{ id: "A", role: "assistant", text: "already reported" }, { id: "u1", role: "user", text: "next" }, { id: "B", role: "assistant", text: "seen on the feed" }, { id: "C", role: "assistant", text: "missed in the gap" }];
		write(file, lines.slice(0, 1));
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#1", entryId: "A", outcome: "success" } });
		const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "A", settledAt: T0 });
		host.event(ref.chatId, { type: "agent_start" });
		host.event(ref.chatId, { type: "message_end", message: assistant("seen on the feed"), entryId: "B" });
		write(file, lines);
		for (const fn of [...host.get(ref.chatId).watchers]) fn({ t: "gap" });
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#2", entryId: "C", outcome: "success" } });
		assert.equal(settles.length, 1);
		assert.equal(settles[0]!.split("seen on the feed").length - 1, 1);
		assert.ok(settles[0]!.endsWith("missed in the gap"));
		await worker.dispose();
	});
});

test("reload: a missed run that failed or was aborted is reported as that, by its process's settle and by the file", async () => {
	const cases = [
		{ stopReason: "error", errorMessage: "provider 500", outcome: "error", error: "provider 500" },
		{ stopReason: "error", outcome: "error", error: "assistant turn failed (stopReason: error)" },
		{ stopReason: "aborted", outcome: "aborted", error: undefined },
	] as const;
	for (const c of cases) {
		for (const viaFile of [false, true]) {
			await rig(async ({ file, host, ref }) => {
				const failed = (id: string, i: number) =>
					JSON.stringify({ type: "message", id, timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "partial reply" }], stopReason: c.stopReason, ...("errorMessage" in c ? { errorMessage: c.errorMessage } : {}) } });
				fs.writeFileSync(file, [entry({ id: "A", role: "assistant", text: "the record" }, 0), failed("B", 5)].join("\n") + "\n");
				host.state(ref.chatId, { status: "idle", lastSettled: viaFile ? null : { key: "k#2", entryId: "B", outcome: c.outcome, ...(c.error ? { error: c.error } : {}) } });
				const { worker, settles } = await attached(host, ref, { settleKey: "k#1", settleEntryId: "A", settledAt: T0 + 500 });
				assert.deepEqual(settles, ["partial reply"]);
				assert.equal(worker.taskOutcome, c.outcome);
				assert.equal(worker.error, c.error);
				await worker.dispose();
			});
		}
	}
});

test("reopened on a job's end: a worker whose process stopped idle reports its reply once, with no earlier answer, however the parent meets it", async () => {
	const reply = "The reply to the job's end";
	const lines: Line[] = [
		{ id: "A", role: "assistant", text: "already reported" },
		{ id: "u1", role: "user", text: "[job j1] ended" },
		{ id: "R", role: "assistant", text: reply },
	];
	const run = (host: FakeWorkerHost, ref: WorkerRef, file: string) => {
		host.state(ref.chatId, { status: "running", lastSettled: null });
		host.event(ref.chatId, { type: "agent_start" });
		host.event(ref.chatId, { type: "message_end", message: assistant(reply), entryId: "R" });
		write(file, lines);
		host.event(ref.chatId, { type: "agent_settled", settleKey: "job#1", settleEntryId: "R" });
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "job#1", entryId: "R", outcome: "success" } });
	};
	const record = { settleKey: "k#1", settleEntryId: "A", settledAt: T0 + 500 };

	// The parent stayed up: it saw the idle stop and the new process.
	await rig(async ({ file, host, ref }) => {
		write(file, lines.slice(0, 1));
		host.state(ref.chatId, { status: "idle", lastSettled: { key: "k#1", entryId: "A", outcome: "success" } });
		const { worker, settles } = await attached(host, ref, record);
		host.end(ref.chatId, { cause: "idle" });
		host.end(ref.chatId, { cause: "reload" });
		run(host, ref, file);
		assert.deepEqual(settles, [reply]);
		assert.equal(worker.status, "waiting");
		assert.equal(worker.finalOutput(), reply);
		await worker.dispose();
	});

	// The parent came back during the reopened run.
	await rig(async ({ file, host, ref }) => {
		write(file, lines);
		host.state(ref.chatId, { status: "running", lastSettled: null });
		const { worker, settles } = await attached(host, ref, record);
		host.event(ref.chatId, { type: "agent_settled", settleKey: "job#1", settleEntryId: "R" });
		assert.deepEqual(settles, [reply]);
		assert.equal(worker.status, "waiting");
		await worker.dispose();
	});

	// The parent came back after it, the process up or stopped idle again.
	for (const lastSettled of [{ key: "job#1", entryId: "R", outcome: "success" as const }, null]) {
		await rig(async ({ file, host, ref }) => {
			write(file, lines);
			host.state(ref.chatId, { status: "idle", lastSettled });
			const { worker, settles } = await attached(host, ref, record);
			assert.deepEqual(settles, [reply]);
			assert.equal(worker.status, "waiting");
			await worker.dispose();
		});
	}
});

// ── a run that wrote nothing, found by a reload or a gap ────────────────────

const CARD: Line = { id: "u1", role: "user", text: "[job j1] Background job ended." };
const REPORTED_A: Line[] = [{ id: "u0", role: "user", text: "do the work" }, { id: "A", role: "assistant", text: "The real report" }];
const SILENT: Line = { id: "E", role: "assistant", text: "" };
const SETTLED_E = { key: "job#2", entryId: "E", outcome: "success" as const };
const RECORD = { settleKey: "job#1", settleEntryId: "A", settledAt: T0 + 1500 };
const FEEDS = [["legacy", {}], ["keyed", { keys: true as const }]] as const;

/** Every way a parent finds a run: `arrive` brings it to the settle, from an attach with the record. */
const FINDINGS: [string, (r: { host: FakeWorkerHost; ref: WorkerRef; feed: object }, lines: Line[], file: string, settled: typeof SETTLED_E | { key: string; outcome: "error"; entryId: string; error: string }) => Promise<Awaited<ReturnType<typeof attached>>>][] = [
	["a reload after the settle, its process knowing it", async ({ host, ref, feed }, lines, file, settled) => {
		write(file, lines);
		host.state(ref.chatId, { ...feed, status: "idle", lastSettled: settled });
		return attached(host, ref, RECORD);
	}],
	["a reload after the settle, its process reopened", async ({ host, ref, feed }, lines, file) => {
		write(file, lines);
		host.state(ref.chatId, { ...feed, status: "idle", lastSettled: null });
		return attached(host, ref, RECORD);
	}],
	["a reload during the run", async ({ host, ref, feed }, lines, file, settled) => {
		write(file, lines);
		host.state(ref.chatId, { ...feed, status: "running", lastSettled: null });
		const a = await attached(host, ref, RECORD);
		host.event(ref.chatId, { type: "agent_settled", settleKey: settled.key, settleEntryId: settled.entryId });
		host.state(ref.chatId, { status: "idle", lastSettled: settled });
		return a;
	}],
	["a gap over the settle", async ({ host, ref, feed }, lines, file, settled) => {
		write(file, REPORTED_A);
		host.state(ref.chatId, { ...feed, status: "idle", lastSettled: { key: "job#1", entryId: "A", outcome: "success" } });
		const a = await attached(host, ref, RECORD);
		write(file, lines);
		for (const fn of [...host.get(ref.chatId).watchers]) fn({ t: "gap" });
		host.state(ref.chatId, { status: "idle", lastSettled: settled });
		return a;
	}],
	["a gap into the run", async ({ host, ref, feed }, lines, file, settled) => {
		write(file, REPORTED_A);
		host.state(ref.chatId, { ...feed, status: "idle", lastSettled: { key: "job#1", entryId: "A", outcome: "success" } });
		const a = await attached(host, ref, RECORD);
		write(file, lines);
		for (const fn of [...host.get(ref.chatId).watchers]) fn({ t: "gap" });
		host.state(ref.chatId, { status: "running", lastSettled: { key: "job#1", entryId: "A", outcome: "success" } });
		host.event(ref.chatId, { type: "agent_settled", settleKey: settled.key, settleEntryId: settled.entryId });
		host.state(ref.chatId, { status: "idle", lastSettled: settled });
		return a;
	}],
];

for (const [feedName, feed] of FEEDS) {
	for (const [how, find] of FINDINGS) {
		test(`quiet: a job's run that wrote nothing sends nothing and its last report stays, found by ${how} [${feedName}]`, async () => {
			await rig(async ({ file, host, ref }) => {
				const { worker, settles, quiet } = await find({ host, ref, feed }, [...REPORTED_A, CARD, SILENT], file, SETTLED_E);
				assert.deepEqual(settles, [], "no report");
				assert.equal(quiet.count, 1, "the settle is recorded, and a held team wake goes on");
				assert.equal(worker.finalOutput(), "The real report");
				assert.equal(worker.status, "waiting");
				assert.equal(worker.settleEntryId, "E");
				await worker.dispose();
			});
		});

		test(`quiet: a job's run that failed with nothing written still reports its failure, never the old answer, found by ${how} [${feedName}]`, async () => {
			await rig(async ({ file, host, ref }) => {
				const failed = (id: string) => ({ id, role: "assistant" as const, text: "", stopReason: "error" });
				const { worker, settles, quiet } = await find({ host, ref, feed }, [...REPORTED_A, CARD, failed("E")], file, { key: "job#2", entryId: "E", outcome: "error", error: "provider 500" });
				assert.equal(quiet.count, 0);
				assert.equal(settles.length, 1, "reported");
				assert.ok(!settles[0]!.includes("The real report"), settles[0]);
				assert.equal(worker.taskOutcome, "error");
				await worker.dispose();
			});
		});

		test(`quiet: a run an instruction started that wrote nothing still reports, found by ${how} [${feedName}]`, async () => {
			await rig(async ({ file, host, ref }) => {
				const { worker, settles, quiet } = await find({ host, ref, feed }, [...REPORTED_A, { id: "u1", role: "user", text: "look again" }, SILENT], file, SETTLED_E);
				assert.equal(quiet.count, 0, "never quiet");
				assert.equal(settles.length, 1);
				await worker.dispose();
			});
		});
	}

	test(`quiet: a card and an instruction in one run: the instruction decides, it reports [${feedName}]`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, [...REPORTED_A, CARD, { id: "u2", role: "user", text: "look again" }, SILENT]);
			host.state(ref.chatId, { ...feed, status: "idle", lastSettled: SETTLED_E });
			const { worker, settles, quiet } = await attached(host, ref, RECORD);
			assert.equal(quiet.count, 0);
			assert.equal(settles.length, 1);
			await worker.dispose();
		});
	});

	test(`quiet: a job's run that did write reports what it wrote [${feedName}]`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, [...REPORTED_A, CARD, { id: "E", role: "assistant", text: "the card's answer" }]);
			host.state(ref.chatId, { ...feed, status: "idle", lastSettled: SETTLED_E });
			const { worker, settles, quiet } = await attached(host, ref, RECORD);
			assert.equal(quiet.count, 0);
			assert.deepEqual(settles, ["the card's answer"]);
			await worker.dispose();
		});
	});

	test(`quiet against the fallback: a settle the file can't place reports text it finds; an entry it can't read is never quiet; no entry and no text is [${feedName}]`, async () => {
		const mid = async (lines: Line[], settleEntryId?: string) => {
			let out: { settles: string[]; quiet: number } | undefined;
			await rig(async ({ file, host, ref }) => {
				write(file, lines);
				host.state(ref.chatId, { ...feed, status: "running", lastSettled: null });
				const a = await attached(host, ref, RECORD);
				host.event(ref.chatId, { type: "agent_settled", settleKey: "job#2", ...(settleEntryId ? { settleEntryId } : {}) });
				out = { settles: a.settles, quiet: a.quiet.count };
				await a.worker.dispose();
			});
			return out!;
		};
		assert.deepEqual(await mid([...REPORTED_A, CARD, { id: "B", role: "assistant", text: "in the file" }]), { settles: ["in the file"], quiet: 0 }, "no entry named, text found: the fallback reports it");
		assert.deepEqual(await mid([...REPORTED_A, CARD, { id: "B", role: "assistant", text: "in the file" }], "unwritten"), { settles: ["in the file"], quiet: 0 }, "entry unwritten, text found: the fallback reports it");
		assert.equal((await mid([...REPORTED_A, CARD], "unwritten")).quiet, 0, "an answer may be on its way: it reports");
		assert.deepEqual(await mid([...REPORTED_A, CARD]), { settles: [], quiet: 1 }, "no entry named, nothing written: quiet");
	});

	test(`quiet needs the record found: a file that doesn't hold it can't vouch for a run, which reports [${feedName}]`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, [CARD, SILENT]);
			host.state(ref.chatId, { ...feed, status: "idle", lastSettled: SETTLED_E });
			const { worker, settles, quiet } = await attached(host, ref, { settleKey: "job#1", settleEntryId: "gone" });
			assert.equal(quiet.count, 0);
			assert.equal(settles.length, 1);
			await worker.dispose();
		});
	});

	test(`quiet: after a quiet settle, the next reload still reads the last report back [${feedName}]`, async () => {
		await rig(async ({ file, host, ref }) => {
			write(file, [...REPORTED_A, CARD, SILENT]);
			host.state(ref.chatId, { ...feed, status: "idle", lastSettled: SETTLED_E });
			const { worker, settles, quiet } = await attached(host, ref, { settleKey: "job#2", settleEntryId: "E", settledAt: T0 + 60_000, priorSettle: { entryId: "A" } });
			assert.deepEqual([settles.length, quiet.count], [0, 0]);
			assert.equal(worker.finalOutput(), "The real report");
			await worker.dispose();
		});
	});
}

const settleRecord = (fields: Record<string, unknown>, at: number) => ({
	type: "custom",
	customType: WORKER_MANIFEST_ENTRY_TYPE,
	data: { v: 1, kind: "worker-manifest", workerId: "ag_01", backend: "pi", at, status: "waiting", settledAt: at, ...fields },
});

test("the record fold says where the last report began: the settle before it, the start, or nothing for older records", () => {
	const fold = (...records: unknown[]) => readWorkerManifests(records).manifests.get("ag_01")!;
	const first = settleRecord({ settleEntryId: "e1" }, 1);
	const second = settleRecord({ settleEntryId: "e2" }, 2);
	assert.deepEqual(fold(first).priorSettle, {}, "its first report");
	assert.deepEqual(fold(first, second).priorSettle, { entryId: "e1" });
	assert.deepEqual(fold(first, second, settleRecord({ status: "running", settledAt: undefined }, 3)).priorSettle, { entryId: "e1" }, "a later record keeps it");
	assert.deepEqual(fold(first, second, settleRecord({ settleEntryId: "e2" }, 4)).priorSettle, { entryId: "e1" }, "the same settle again moves nothing");
	assert.equal(fold(settleRecord({}, 1), second).priorSettle, undefined, "an older settle named no entry: unknown");
	assert.equal(fold(settleRecord({}, 1)).priorSettle, undefined);
	assert.ok(!("priorSettle" in first.data) && !("priorSettle" in second.data), "folded, never written");
});
