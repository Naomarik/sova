/**
 * wake-nudge.ts delivering background jobs' end cards (job-store.ts), over a fake pi: a machine restart's
 * jobs in one card, sent once; the limit of 30 applied to cards; a busy chat gets its card after its
 * reply; what the card does to the wake count. Each `open` is a new process on the same session file.
 * The records are written as the host's keeper writes them (server/background-jobs.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import wakeNudge, { resetsWakeCount } from "../wake-nudge.ts";
import { cardFile, JOBS_DIR_ENV, readJob, writeJob, type JobRecord } from "./job-store.ts";
import { WAKE_DIR_ENV, WAKE_WORKER_ENV, readWakeRecords } from "./wake-store.ts";

const SESSION = "s-jobs";

function scratch() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-nudge-jobs-"));
	return { root, file: path.join(root, "chat.jsonl"), jobs: path.join(root, "jobs"), wakes: path.join(root, "wake"), entries: [] as any[] };
}
type S = ReturnType<typeof scratch>;

/** Run `body` as a chat its host started with jobs on. */
async function hosted<T>(s: S, body: () => Promise<T>, o: { worker?: boolean } = {}): Promise<T> {
	const keys = [WAKE_DIR_ENV, JOBS_DIR_ENV, "SOVA_CHAT_PATH", WAKE_WORKER_ENV, "SOVA_JOB_CARDS"] as const;
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	process.env[WAKE_DIR_ENV] = s.wakes;
	process.env[JOBS_DIR_ENV] = s.jobs;
	process.env.SOVA_CHAT_PATH = s.file;
	delete process.env.SOVA_JOB_CARDS;
	if (o.worker) process.env[WAKE_WORKER_ENV] = "1";
	else delete process.env[WAKE_WORKER_ENV];
	try {
		return await body();
	} finally {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

/** One process of the chat: its extension loaded, session_start run. `idle` is what pi's isIdle says. */
async function open(s: S, o: { idle?: () => boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const sent: { text: string; opts: any }[] = [];
	const ctx: any = {
		hasUI: false,
		isIdle: o.idle ?? (() => true),
		sessionManager: { getBranch: () => s.entries, getEntries: () => s.entries, getSessionId: () => SESSION, getSessionFile: () => s.file },
	};
	wakeNudge({
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerTool() {},
		registerCommand() {},
		appendEntry: (customType: string, data: unknown) => s.entries.push({ type: "custom", customType, data }),
		// pi hands an extension's message to the agent; it reaches the branch at its message_end.
		sendUserMessage: (text: string, opts: unknown) => sent.push({ text, opts }),
	} as any);
	await handlers.get("session_start")!({}, ctx);
	return {
		sent,
		/** pi wrote this sent message onto the branch. */
		land: async (text: string) => {
			s.entries.push({ type: "message", message: { role: "user", content: text } });
			await handlers.get("message_end")!({ message: { role: "user", content: text } }, ctx);
		},
		input: (source: string) => handlers.get("input")!({ source, text: "x" }, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, ctx),
	};
}

const job = (id: string, ended: JobRecord["ended"], o: Partial<JobRecord> = {}): JobRecord => ({
	v: 1, id, sessionId: SESSION, path: "", kind: "kept", command: `run-${id} > /w/${id}.log &`, cwd: "/w", unit: `u-${id}.scope`, driver: "systemd",
	startedAt: 1_000_000, bootId: "boot-old", output: `/w/${id}.log`, ended, ...o,
});
const count = (s: S) => {
	let n = 0;
	for (const e of s.entries) if (e.type === "custom" && e.customType === "wake-nudge-count") n = e.data.n;
	return n;
};
async function until(cond: () => boolean, what: string, ms = 10_000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
/** Long enough for the extension's settle (2 s) and one poll (5 s) to have come and gone. */
const pastAPoll = () => new Promise((r) => setTimeout(r, 6_000));

test("a machine restart's jobs reach the chat once, in one card that names them all; another job's end gets its own", async () => {
	const s = scratch();
	await hosted(s, async () => {
		const at = 5_000_000;
		writeJob(s.jobs, job("j1", { at, how: "restart", card: "wake" }));
		writeJob(s.jobs, job("j2", { at, how: "restart", card: "wake" }));
		writeJob(s.jobs, job("j3", { at, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		const p = await open(s);
		await until(() => p.sent.length >= 2, "the cards");
		const restart = p.sent.filter((m) => m.text.startsWith("[job j1,j2]"));
		assert.equal(restart.length, 1, `one card for both (${p.sent.map((m) => m.text.split("\n")[0])})`);
		assert.match(restart[0]!.text, /^\[job j1,j2\] 2 background jobs ended\./);
		assert.equal(restart[0]!.text.match(/The machine restarted or you logged out, which ended it\. Sova does not start it again\./g)?.length, 2);
		assert.ok(restart[0]!.text.includes("j1: `run-j1") && restart[0]!.text.includes("j2: `run-j2"));
		assert.equal(p.sent.filter((m) => m.text.startsWith("[job j3]")).length, 1, "the other job's card is its own");
		for (const m of p.sent) await p.land(m.text);
		for (const id of ["j1", "j2", "j3"]) assert.equal(fs.readFileSync(cardFile(s.jobs, SESSION, id), "utf8").trim(), "sent");
		await pastAPoll();
		assert.equal(p.sent.length, 2, "nothing sent again while it runs");
		await p.shutdown();
		// A new process: told once means never again.
		const q = await open(s);
		await pastAPoll();
		assert.equal(q.sent.length, 0, "nothing sent again after a restart of the chat");
		assert.deepEqual(readWakeRecords(s.wakes).flatMap((r) => (r.source === "jobs" ? r.items : [])), [], "no job card is still owed");
		// The records stay ended that way; nothing changed them back to running.
		assert.equal(readJob(s.jobs, SESSION, "j1")?.ended?.how, "restart");
		await q.shutdown();
	});
});

test("a card sent but not yet on the branch when the chat died is sent again at its next start", async () => {
	const s = scratch();
	await hosted(s, async () => {
		writeJob(s.jobs, job("j1", { at: 5_000_000, how: "restart", card: "wake" }));
		const p = await open(s);
		await until(() => p.sent.length === 1, "the card");
		await p.shutdown(); // died before pi wrote it
		const q = await open(s);
		await until(() => q.sent.length === 1, "the card again");
		await q.land(q.sent[0]!.text);
		await q.shutdown();
	});
});

test("the limit of 30 applies to cards: the 30th says the limit is reached; past it the job stays recorded and no card is sent", async () => {
	const s = scratch();
	await hosted(s, async () => {
		s.entries.push({ type: "custom", customType: "wake-nudge-count", data: { n: 29 } });
		writeJob(s.jobs, job("j1", { at: 5_000_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		const p = await open(s);
		await until(() => p.sent.length === 1, "the 30th wake");
		assert.match(p.sent[0]!.text, /^\[job j1\]/);
		assert.match(p.sent[0]!.text, /Wake limit \(30\) reached without user input/);
		assert.equal(count(s), 30, "the card counted as one wake");
		await p.land(p.sent[0]!.text);
		// A second job ends past the limit.
		writeJob(s.jobs, job("j2", { at: 5_100_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		await until(() => fs.existsSync(cardFile(s.jobs, SESSION, "j2")), "j2 settled");
		assert.equal(fs.readFileSync(cardFile(s.jobs, SESSION, "j2"), "utf8").trim(), "skipped");
		assert.equal(p.sent.length, 1, "no card past the limit");
		assert.equal(readJob(s.jobs, SESSION, "j2")?.ended?.how, "exited", "still recorded");
		assert.equal(count(s), 30);
		assert.deepEqual(readWakeRecords(s.wakes).flatMap((r) => (r.source === "jobs" ? r.items : [])), [], "nothing brings the chat back for it");
		// A typed message opens the chain again: the next end sends its card.
		await p.input("interactive");
		assert.equal(count(s), 0);
		writeJob(s.jobs, job("j3", { at: 5_200_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		await until(() => p.sent.length === 2, "j3's card");
		assert.match(p.sent[1]!.text, /^\[job j3\]/);
		assert.doesNotMatch(p.sent[1]!.text, /Wake limit/);
		await p.land(p.sent[1]!.text);
		await p.shutdown();
	});
});

test("a busy chat gets its card after its current reply (queued as a follow-up); an idle one at once", async () => {
	const s = scratch();
	await hosted(s, async () => {
		let idle = false;
		writeJob(s.jobs, job("j1", { at: 5_000_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		const p = await open(s, { idle: () => idle });
		await until(() => p.sent.length === 1, "the card");
		assert.deepEqual(p.sent[0]!.opts, { deliverAs: "followUp" }, "behind the running reply, never a steer into it");
		await p.land(p.sent[0]!.text);
		idle = true;
		writeJob(s.jobs, job("j2", { at: 5_100_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
		await until(() => p.sent.length === 2, "the idle chat's card");
		assert.equal(p.sent[1]!.opts, undefined, "an idle chat gets a new turn");
		await p.land(p.sent[1]!.text);
		await p.shutdown();
	});
});

test("a card is sent as the extension's own message: it never resets the wake count, for a chat or a worker", async () => {
	// pi gives sendUserMessage's message the input source `extension` (server/harness/pi/job-card-input-source.test.ts runs it in the real SDK).
	assert.equal(resetsWakeCount("extension", false), false);
	assert.equal(resetsWakeCount("extension", true), false);
	const s = scratch();
	await hosted(
		s,
		async () => {
			s.entries.push({ type: "custom", customType: "wake-nudge-count", data: { n: 5 } });
			writeJob(s.jobs, job("j1", { at: 5_000_000, how: "exited", card: "wake" }, { bootId: "boot-new" }));
			const p = await open(s);
			await until(() => p.sent.length === 1, "the card");
			await p.input("extension");
			await p.land(p.sent[0]!.text);
			assert.equal(count(s), 6, "the card counted, and its own input didn't reset it");
			await p.shutdown();
		},
		{ worker: true },
	);
});
