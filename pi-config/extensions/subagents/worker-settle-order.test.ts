/**
 * When a parent is picked back up against a worker's run, whichever moment it lands on: the report holds
 * what the worker wrote, once. Every ordering of the attach against the worker's run (started, answered,
 * settled, process stopped), forced, with a real session file: nothing here depends on timing. A parent
 * attaching after the settle is what delivered "(no output for this task)" before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatWorker, workerStartOf } from "./chat-worker.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";

const PARENT = { sessionId: "parent-1", path: "/sessions/parent-1.jsonl" };
const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const REPORTED = "already reported";
const REPLY = "the reply to the job's end";

type Line = { id: string; role: "user" | "assistant"; text: string };
const BEFORE: Line[] = [{ id: "A", role: "assistant", text: REPORTED }, { id: "u1", role: "user", text: "[job j1] It passed (exit code 0)." }];
const ANSWERED: Line[] = [...BEFORE, { id: "B", role: "assistant", text: REPLY }];

function write(file: string, lines: Line[]): void {
	fs.writeFileSync(
		file,
		lines.map((l, i) => JSON.stringify({ type: "message", id: l.id, timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: l.role, content: [{ type: "text", text: l.text }], ...(l.role === "assistant" ? { stopReason: "stop" } : {}) } })).join("\n") + "\n",
	);
}
const answer = { role: "assistant", content: [{ type: "text", text: REPLY }], stopReason: "stop" };

async function rig(keys: boolean, fn: (r: { host: FakeWorkerHost; chat: string; file: string; attach: () => Promise<{ worker: ChatWorker; reports: string[] }> }) => Promise<void>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-settle-order-"));
	try {
		const host = new FakeWorkerHost({ sessionDir: dir });
		const ref = await host.start(workerStartOf({ id: "ag_01", groupId: "g", name: "n", task: "t", cwd: "/w" }, PARENT, "k", () => dir));
		host.state(ref.chatId, { status: "idle", keys, lastSettled: { key: "k#1", entryId: "A", outcome: "success" } });
		const file = ref.sessionFile!;
		write(file, BEFORE.slice(0, 1));
		const attach = async () => {
			const reports: string[] = [];
			const worker = new ChatWorker(
				{ id: "ag_01", groupId: "g", name: "n", task: "t", cwd: "/w" },
				{ onChange() {}, onSettled: (w) => void reports.push(w.finalOutput()), onExit() {} },
				{ host, parent: PARENT, attach: { ref, settleKey: "k#1", settleEntryId: "A", settledAt: T0 + 500 } },
			);
			await flush();
			return { worker, reports };
		};
		await fn({ host, chat: ref.chatId, file, attach });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function assertReported(a: { worker: ChatWorker; reports: string[] }, ordering: string): void {
	assert.equal(a.reports.length, 1, `${ordering}: one report (${JSON.stringify(a.reports)})`);
	assert.equal(a.reports[0], REPLY, `${ordering}: the reply, once, and nothing already reported`);
	assert.equal(a.worker.status, "waiting", ordering);
}

for (const keys of [false, true]) {
	const feed = keys ? "keyed" : "legacy";

	test(`attach order (guard): idle, before the run starts: the feed shows it all [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			const a = await attach();
			host.state(chat, { status: "running" });
			host.event(chat, { type: "agent_start" });
			write(file, ANSWERED);
			host.event(chat, { type: "message_end", message: answer, entryId: "B" });
			host.event(chat, { type: "agent_settled", settleKey: "k#2", settleEntryId: "B" });
			assertReported(a, "before the run");
			await a.worker.dispose();
		});
	});

	test(`attach order (guard): the run under way, before its answer: the feed shows the answer [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, BEFORE);
			host.state(chat, { status: "running" });
			const a = await attach();
			assert.equal(a.worker.status, "running");
			write(file, ANSWERED);
			host.event(chat, { type: "message_end", message: answer, entryId: "B" });
			host.event(chat, { type: "agent_settled", settleKey: "k#2", settleEntryId: "B" });
			assertReported(a, "before the answer");
			await a.worker.dispose();
		});
	});

	test(`attach order: after the answer, before the settle: the file has the answer the feed didn't show [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "running" });
			const a = await attach();
			host.event(chat, { type: "agent_settled", settleKey: "k#2", settleEntryId: "B" });
			assertReported(a, "between answer and settle");
			await a.worker.dispose();
		});
	});

	test(`attach order: after the answer, before a settle that names no entry: the file still has it [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "running" });
			const a = await attach();
			host.event(chat, { type: "agent_settled", settleKey: "k#2" });
			assertReported(a, "settle with no entry id");
			await a.worker.dispose();
		});
	});

	test(`attach order: after the settle, its process still up: the state names the settle, the file has the reply [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "idle", lastSettled: { key: "k#2", entryId: "B", outcome: "success" } });
			assertReported(await attach(), "after the settle");
		});
	});

	test(`attach order: after the settle, its state naming no entry: the file has the reply [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "idle", lastSettled: { key: "k#2", outcome: "success" } });
			assertReported(await attach(), "state with no entry id");
		});
	});

	test(`attach order: after the settle, its process stopped idle: the file alone says so [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "idle", lastSettled: null });
			assertReported(await attach(), "process stopped");
		});
	});

	test(`attach order: the feed repeats an answer the file already gave: once [${feed}]`, async () => {
		await rig(keys, async ({ host, chat, file, attach }) => {
			write(file, ANSWERED);
			host.state(chat, { status: "running" });
			const a = await attach();
			host.event(chat, { type: "message_end", message: answer, entryId: "B" });
			host.event(chat, { type: "agent_settled", settleKey: "k#2", settleEntryId: "B" });
			assertReported(a, "repeated by the feed");
			await a.worker.dispose();
		});
	});
}
