/**
 * wake-nudge.ts over a fake pi: what it publishes to the wake store, the durable cancel, and the wake
 * count across process ends. Each `open` is a new process on the same session file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import wakeNudge, { resetsWakeCount } from "../wake-nudge.ts";
import { WAKE_DIR_ENV, WAKE_WORKER_ENV, cancelWakesBefore, publishWakes, readWakeRecords, wakeStoreOf, wakesCancelledBefore } from "./wake-store.ts";

const SESSION = "s-1";

function scratch() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-nudge-"));
	const file = path.join(root, "chat.jsonl");
	const dir = path.join(root, "wake");
	return { root, file, dir, entries: [] as any[] };
}

/** Run `body` as a chat its host started: the two variables set, whatever the test's own env says. */
async function hosted<T>(s: ReturnType<typeof scratch>, body: () => Promise<T>, o: { worker?: boolean } = {}): Promise<T> {
	const saved = { dir: process.env[WAKE_DIR_ENV], path: process.env.SOVA_CHAT_PATH, worker: process.env[WAKE_WORKER_ENV] };
	process.env[WAKE_DIR_ENV] = s.dir;
	process.env.SOVA_CHAT_PATH = s.file;
	if (o.worker) process.env[WAKE_WORKER_ENV] = "1";
	else delete process.env[WAKE_WORKER_ENV];
	try {
		return await body();
	} finally {
		for (const [k, v] of [[WAKE_DIR_ENV, saved.dir], ["SOVA_CHAT_PATH", saved.path], [WAKE_WORKER_ENV, saved.worker]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** One process of the chat: its extension loaded, session_start run. */
async function open(s: ReturnType<typeof scratch>) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let tool: any;
	const sent: { text: string; opts: unknown }[] = [];
	const ctx: any = {
		hasUI: false,
		isIdle: () => true,
		sessionManager: { getBranch: () => s.entries, getEntries: () => s.entries, getSessionId: () => SESSION, getSessionFile: () => s.file },
	};
	wakeNudge({
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerTool: (t: any) => (tool = t),
		registerCommand() {},
		appendEntry: (customType: string, data: unknown) => s.entries.push({ type: "custom", customType, data }),
		// As pi writes a sent message onto the branch.
		sendUserMessage: (text: string, opts: unknown) => {
			sent.push({ text, opts });
			s.entries.push({ type: "message", message: { role: "user", content: text } });
		},
	} as any);
	await handlers.get("session_start")!({}, ctx);
	return {
		sent,
		schedule: async (params: any) => {
			const r = await tool.execute("c", { action: "schedule", ...params }, undefined, undefined, ctx);
			s.entries.push({ type: "message", message: { role: "toolResult", toolName: "wake_nudge", details: r.details } });
			return r;
		},
		cancel: async (id: string) => {
			const r = await tool.execute("c", { action: "cancel", id }, undefined, undefined, ctx);
			s.entries.push({ type: "message", message: { role: "toolResult", toolName: "wake_nudge", details: r.details } });
			return r;
		},
		list: () => tool.execute("c", { action: "list" }, undefined, undefined, ctx),
		input: (source: string) => handlers.get("input")!({ source, text: "x" }, ctx),
		tree: () => handlers.get("session_tree")!({}, ctx),
		messageEnd: (text: string) => handlers.get("message_end")!({ message: { role: "user", content: text } }, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, ctx),
	};
}

const scheduled = (id: string, fireAt: number, createdAt = fireAt - 60_000) => ({ type: "message", message: { role: "toolResult", toolName: "wake_nudge", details: { action: "schedule", nudge: { id, reason: "check", fireAt, createdAt }, active: [] } } });
const due = (s: ReturnType<typeof scratch>) => readWakeRecords(s.dir).flatMap((r) => r.items.map((i) => i.id));
async function until(cond: () => boolean, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("a chat its host started publishes each change; shutting down keeps the record", async () => {
	const s = scratch();
	await hosted(s, async () => {
		const chat = await open(s);
		await chat.schedule({ delay: "1h", reason: "first" });
		const n2 = await chat.schedule({ delay: "2h" });
		assert.deepEqual(due(s), ["n1", "n2"]);
		assert.equal(readWakeRecords(s.dir)[0]!.path, s.file);
		await chat.cancel(n2.details.nudge.id);
		assert.deepEqual(due(s), ["n1"]);
		await chat.shutdown();
		assert.deepEqual(due(s), ["n1"], "the record is what brings it back");
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("a chat no host started writes nothing: no SOVA_CHAT_PATH, or another session's file", async () => {
	const s = scratch();
	assert.equal(wakeStoreOf(SESSION, s.file, { [WAKE_DIR_ENV]: s.dir }), undefined, "no SOVA_CHAT_PATH");
	assert.equal(wakeStoreOf(SESSION, s.file, { SOVA_CHAT_PATH: s.file }), undefined, "no directory");
	assert.equal(wakeStoreOf(SESSION, s.file, { [WAKE_DIR_ENV]: s.dir, SOVA_CHAT_PATH: "/other/file.jsonl" }), undefined, "a pi run by a chat's own bash");
	assert.ok(wakeStoreOf(SESSION, s.file, { [WAKE_DIR_ENV]: s.dir, SOVA_CHAT_PATH: s.file }));
	const saved = { dir: process.env[WAKE_DIR_ENV], path: process.env.SOVA_CHAT_PATH };
	delete process.env.SOVA_CHAT_PATH;
	process.env[WAKE_DIR_ENV] = s.dir;
	try {
		const chat = await open(s);
		await chat.schedule({ delay: "1h" });
		assert.equal(fs.existsSync(s.dir), false, "a terminal pi leaves no store");
		await chat.shutdown();
	} finally {
		if (saved.dir === undefined) delete process.env[WAKE_DIR_ENV];
		else process.env[WAKE_DIR_ENV] = saved.dir;
		if (saved.path !== undefined) process.env.SOVA_CHAT_PATH = saved.path;
	}
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("a nudge stays published until its message is on the branch", async () => {
	const s = scratch();
	await hosted(s, async () => {
		s.entries.push(scheduled("n1", Date.now() - 1000));
		const chat = await open(s);
		await until(() => chat.sent.length === 1, "the overdue nudge fired");
		assert.deepEqual(due(s), ["n1"], "fired, and a death now must not lose it");
		await chat.messageEnd(chat.sent[0]!.text);
		assert.deepEqual(due(s), []);
		await chat.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("a rebuild reconciles the store with the branch: a record for a nudge the chat no longer has goes", async () => {
	const s = scratch();
	await hosted(s, async () => {
		publishWakes({ dir: s.dir, sessionId: SESSION, path: s.file }, "nudges", [{ id: "n9", at: Date.now() - 1000 }]);
		const chat = await open(s);
		assert.deepEqual(due(s), [], "dropped at the start");
		assert.equal(chat.sent.length, 0);
		// A rewind past a nudge drops it too.
		await chat.schedule({ delay: "1h" });
		assert.deepEqual(due(s), ["n1"]);
		s.entries.length = 0;
		await chat.tree();
		assert.deepEqual(due(s), []);
		await chat.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("a nudge cancelled while the chat was shut down doesn't come back; one set afterwards stands", async () => {
	const s = scratch();
	await hosted(s, async () => {
		const first = await open(s);
		await first.schedule({ delay: "1h" });
		await first.shutdown();
		// Archived with no process: only the tombstone says so, and the entry is still on the branch.
		const archivedAt = Date.now();
		cancelWakesBefore(s.dir, SESSION, archivedAt);
		assert.ok(wakesCancelledBefore(s.dir, SESSION) > 0);
		// The nudge set below comes after the archive, never in its millisecond.
		await until(() => Date.now() > archivedAt, "the clock past the archive");
		const again = await open(s);
		assert.match((await again.list()).content[0].text, /No pending nudges/);
		assert.deepEqual(due(s), []);
		await again.schedule({ delay: "2h" });
		assert.equal(due(s).length, 1);
		await again.shutdown();
		const third = await open(s);
		assert.doesNotMatch((await third.list()).content[0].text, /No pending/, "a later nudge is not the cancelled one");
		await third.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("the wake limit holds across a shutdown: 29 fires, a queued prompt, a restart, one fire", async () => {
	const s = scratch();
	await hosted(s, async () => {
		for (let i = 1; i <= 29; i++) s.entries.push({ type: "custom", customType: "wake-nudge-count", data: { n: i } });
		const before = await open(s);
		await before.input("rpc"); // a brief, sova_send, another chat: never a reset
		await before.schedule({ delay: "1h" });
		await before.shutdown();
		s.entries.push(scheduled("n7", Date.now() - 1000));
		const after = await open(s);
		await until(() => after.sent.length >= 1, "the fire");
		const fired = after.sent.find((m) => m.text.startsWith("[wake_nudge n7]"))!;
		assert.match(fired.text, /^Wake limit \(30\) reached without user input: do not schedule more nudges; summarize status and wait for the user\.$/m);
		await assert.rejects(after.schedule({ delay: "1h" }), /Wake limit \(30\) reached without user input; wait for the user\./);
		// That 30th fire is on the file: the next process is still at the limit.
		await after.shutdown();
		const still = await open(s);
		await assert.rejects(still.schedule({ delay: "1h" }), /Wake limit \(30\) reached/, "the fire's count outlives its process");
		// A typed message is what opens it again, and that lasts past a restart too.
		await still.input("interactive");
		await still.shutdown();
		const reset = await open(s);
		await reset.schedule({ delay: "1h" });
		await reset.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("the count survives a rewind: the newest entry in the file holds, on whichever branch", async () => {
	const s = scratch();
	await hosted(s, async () => {
		const entries = [{ type: "custom", customType: "wake-nudge-count", data: { n: 30 } }];
		s.entries.push(...entries);
		const chat = await open(s);
		await assert.rejects(chat.schedule({ delay: "1h" }), /Wake limit/);
		await chat.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("what resets the count, in one place: a typed message; for a worker, its main chat's instruction too", async () => {
	assert.equal(resetsWakeCount("interactive", false), true);
	assert.equal(resetsWakeCount("rpc", false), false, "another chat, the Overseer or a brief");
	assert.equal(resetsWakeCount("extension", false), false, "the nudge's own message");
	assert.equal(resetsWakeCount("rpc", true), true, "a worker has no composer");
	assert.equal(resetsWakeCount("extension", true), false);
	const s = scratch();
	await hosted(s, async () => {
		s.entries.push({ type: "custom", customType: "wake-nudge-count", data: { n: 30 } });
		const worker = await open(s);
		await assert.rejects(worker.schedule({ delay: "1h" }), /Wake limit/);
		await worker.input("rpc");
		await worker.schedule({ delay: "1h" });
		await worker.shutdown();
	}, { worker: true });
	fs.rmSync(s.root, { recursive: true, force: true });
});

test("a late nudge says so in the line shared/wake.ts parses", async () => {
	const s = scratch();
	await hosted(s, async () => {
		s.entries.push(scheduled("n1", Date.now() - 3_600_000, Date.now() - 7_200_000));
		const chat = await open(s);
		await until(() => chat.sent.length === 1, "the late fire");
		assert.match(chat.sent[0]!.text, /^Overdue by (.+?) \(pi was not running\)\.$/m);
		await chat.shutdown();
	});
	fs.rmSync(s.root, { recursive: true, force: true });
});
