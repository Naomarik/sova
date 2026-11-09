/**
 * A worker's own replies as its parent's manager delivers them: the real manager, real ChatWorkers,
 * the in-memory FakeWorkerHost and real session files. A report made after a job's end reaches the
 * parent or the coordinator, a wait on the worker ends, its team's messages flow again, a reload
 * delivers what the worker actually wrote, and a report made with jobs running names them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSubagents } from "./index.ts";
import { JOBS_DIR_ENV, type JobRecord, markCardDone, writeJob } from "./job-store.ts";
import { MEMBER_ENV, awaitResponse, decodeMemberContext, requestId, writeRequest } from "./mailbox.ts";
import { readMemberItems, writeInboxCaps } from "./inbox.ts";
import { WORKER_MANIFEST_ENTRY_TYPE } from "./registry.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";
import { profileOff } from "./tests/profile-off.ts";

const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");
const OWNER = { sessionId: "owner-1", path: "/sessions/owner-1.jsonl" };
const NO_OUTPUT = "(no output for this task)";

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => void listeners.get(name)?.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(listeners.get(name) ?? [])]) handler(data);
		},
	};
}

function sessionFile() {
	const entries: any[] = [];
	return { entries, append: (customType: string, data: unknown) => void entries.push({ type: "custom", id: `e${entries.length + 1}`, customType, data }) };
}

function manager(file: ReturnType<typeof sessionFile>, host: FakeWorkerHost, agentDir: string) {
	profileOff(agentDir);
	const bus = eventBus();
	host.announceOn(bus);
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const messages: any[] = [];
	const ctx: any = {
		cwd: agentDir, mode: "tui", hasUI: false, thinkingLevel: "high", isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [...file.entries], getBranch: () => [...file.entries], getSessionFile: () => OWNER.path, getSessionId: () => OWNER.sessionId },
		modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	registerSubagents(
		{
			events: bus,
			registerTool: (t: any) => tools.set(t.name, t),
			on: (e: string, f: any) => events.set(e, f),
			registerCommand() {},
			registerShortcut() {},
			appendEntry: (customType: string, data: unknown) => file.append(customType, data),
			getActiveTools: () => ["read", "bash"],
			sendMessage: (...m: any[]) => messages.push(m),
		} as any,
		undefined,
		{ policyFile: NO_POLICY_FILE, agentDir, mailboxPollMs: 10, inboxDebounceMs: 10, inboxRetryMs: [20, 40], setTimer: (fn, ms) => setTimeout(fn, ms) },
	);
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, () => {}, ctx);
	const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");
	return {
		messages,
		call,
		textOf,
		start: () => events.get("session_start")({}, ctx),
		shutdown: () => events.get("session_shutdown")({}, ctx),
		statusOf: async (id: string) => ((await call("agent_list", {})).details.agents as any[]).find((a) => a.id === id)?.status,
		readBack: async (id: string) => textOf(await call("agent_transcript", { id })),
		completions: () => messages.filter((m) => m[0]?.customType === "subagent-complete"),
	};
}

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

function inOrder(text: string, ...parts: string[]): void {
	let from = 0;
	for (const part of parts) {
		const at = text.indexOf(part, from);
		assert.notEqual(at, -1, `${JSON.stringify(part)} after offset ${from} in ${JSON.stringify(text.slice(0, 1500))}`);
		from = at + part.length;
	}
}

async function rig(fn: (r: { root: string; agentDir: string; sessions: string; jobs: string; host: FakeWorkerHost; file: ReturnType<typeof sessionFile> }) => Promise<void>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-settle-"));
	const agentDir = path.join(root, "agent");
	const sessions = path.join(root, "sessions");
	const jobs = path.join(root, "jobs");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(sessions);
	const before = process.env[JOBS_DIR_ENV];
	process.env[JOBS_DIR_ENV] = jobs;
	try {
		await fn({ root, agentDir, sessions, jobs, host: new FakeWorkerHost({ sessionDir: sessions }), file: sessionFile() });
	} finally {
		if (before === undefined) delete process.env[JOBS_DIR_ENV];
		else process.env[JOBS_DIR_ENV] = before;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** Spawn one worker and run its task to a first report. */
async function spawned(m: ReturnType<typeof manager>, host: FakeWorkerHost, reply = "first report") {
	await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
	await until(() => host.starts.length > 0, "the start");
	const chat = host.get("ag_01").ref.chatId;
	host.turn(chat, { user: "do the work", reply, key: `${host.starts[0]!.key}:task#1` });
	await until(() => m.completions().length === 1, "the first report");
	return chat;
}

/** One settle whose run answered, then took a job's end card, then answered again. */
function answerThenCard(host: FakeWorkerHost, chat: string, answers: string[], key: string): void {
	const w = host.get(chat);
	host.state(chat, { status: "running" });
	host.event(chat, { type: "agent_start" });
	let entryId = "";
	answers.forEach((text, i) => {
		if (i) host.event(chat, { type: "message_end", message: { role: "user", content: [{ type: "text", text: `[job j${i}] It passed (exit code 0).` }] } });
		entryId = `e${w.seq + 1}`;
		host.event(chat, { type: "message_end", entryId, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
	});
	host.event(chat, { type: "agent_end", messages: [] });
	host.event(chat, { type: "agent_settled", settleKey: key, settleEntryId: entryId });
	host.state(chat, { status: "idle", lastSettled: { key, entryId, outcome: "success" } });
}

// ── t14/t15: the report reaches the parent ─────────────────────────────────

test("settle report: a job's end wakes a finished worker: its reply reaches the parent with a turn, the worker is idle and a wait ends at once", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		const chat = await spawned(m, host);
		host.turn(chat, { user: "[job j1] It passed (exit code 0).", reply: "The job passed; the suite is green.", key: "job#1" });
		assert.equal(m.completions().length, 2, "completions");
		const [message, delivery] = m.completions()[1]!;
		assert.match(message.content, /The job passed; the suite is green\./);
		assert.ok(!message.content.includes("first report"), "the last report isn't sent again");
		assert.deepEqual(delivery, { deliverAs: "followUp", triggerTurn: true });
		assert.equal(await m.statusOf("ag_01"), "waiting");
		const started = Date.now();
		const waited = m.textOf(await m.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 5 }));
		assert.match(waited, /^All requested tasks settled/, waited);
		assert.ok(Date.now() - started < 2000, "at once");
		assert.match(waited, /The job passed; the suite is green\./);
		const records = file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.workerId === "ag_01");
		assert.equal(records.at(-1).data.status, "waiting", "the record says idle too");
		await m.shutdown();
	});
});

test("settle report: a wait begun during a card's run returns its reply, and it isn't sent a second time", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		const chat = await spawned(m, host);
		host.state(chat, { status: "running" });
		host.event(chat, { type: "agent_start" });
		const waiting = m.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 5 });
		host.event(chat, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "woken and done" }], stopReason: "stop" } });
		host.event(chat, { type: "agent_end", messages: [] });
		host.event(chat, { type: "agent_settled", settleKey: "job#1", settleEntryId: "x" });
		host.state(chat, { status: "idle", lastSettled: { key: "job#1", entryId: "x", outcome: "success" } });
		const text = m.textOf(await waiting);
		assert.match(text, /^All requested tasks settled/, text);
		assert.match(text, /woken and done/);
		assert.equal(m.completions().length, 1, "the wait carried it");
		await m.shutdown();
	});
});

test("settle report (guard): a wait during a run the worker hasn't finished doesn't return early", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		const chat = await spawned(m, host);
		host.state(chat, { status: "running" });
		host.event(chat, { type: "agent_start" });
		const text = m.textOf(await m.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 0.1 }));
		assert.match(text, /^Timed out; still working: ag_01/, text);
		await m.shutdown();
	});
});

test("settle report: a run that wrote nothing sends nothing and read-back keeps the last report; a failed run reports", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		const chat = await spawned(m, host, "the report that stands");
		host.state(chat, { status: "running" });
		host.event(chat, { type: "agent_start" });
		host.event(chat, { type: "agent_end", messages: [] });
		host.event(chat, { type: "agent_settled", settleKey: "job#1" });
		assert.equal(m.completions().length, 1, "nothing sent");
		assert.equal(await m.statusOf("ag_01"), "waiting");
		const records = file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.workerId === "ag_01" && e.data.status);
		assert.equal(records.at(-1).data.status, "waiting", "the record says idle too, not the run's running");
		const back = await m.readBack("ag_01");
		assert.match(back, /the report that stands/);
		assert.ok(!back.includes(NO_OUTPUT), back);
		host.turn(chat, { reply: "", error: "provider 500", key: "job#2" });
		assert.equal(m.completions().length, 2, "a failed run reports");
		assert.match(m.completions()[1]![0].content, /provider 500/);
		await m.shutdown();
	});
});

// ── t23: one report, every answer, everywhere ──────────────────────────────

test("settle report: a card after a final answer can't replace the report: completion, read-back and wait show both, first line first", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
		await until(() => host.starts.length > 0, "the start");
		const chat = host.get("ag_01").ref.chatId;
		answerThenCard(host, chat, ["The real report\nwith findings", "No action needed"], "task#1");
		assert.equal(m.completions().length, 1);
		const content = m.completions()[0]![0].content;
		inOrder(content, "The real report\nwith findings", "No action needed");
		assert.match(content.split("\n").find((l: string) => /real report|No action/.test(l)), /The real report/, "the report's first answer line is the earlier answer's");
		inOrder(await m.readBack("ag_01"), "The real report\nwith findings", "No action needed");
		inOrder(m.textOf(await m.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 1 })), "The real report\nwith findings", "No action needed");
		await m.shutdown();
	});
});

test("settle report: a long report is cut to a preview whose whole text, and read-back, hold every answer", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
		await until(() => host.starts.length > 0, "the start");
		const chat = host.get("ag_01").ref.chatId;
		const long = `The real report\n${"finding ".repeat(800)}\nend of report`;
		answerThenCard(host, chat, [long, "No action needed"], "task#1");
		const content: string = m.completions()[0]![0].content;
		assert.ok(content.includes("The real report"), "the preview opens on the report");
		assert.ok(content.length < long.length, "cut");
		assert.match(content, /\[Use agent_transcript for more\.\]\s*$/, "the trailer stays last");
		const snapshot = /whole in (.+?); or page/.exec(content)?.[1];
		assert.ok(snapshot, content.slice(-400));
		inOrder(fs.readFileSync(snapshot!, "utf8"), long, "No action needed");
		const size = /Final answer: ([\d,]+) chars/.exec(content)?.[1];
		assert.ok(Number(size!.replaceAll(",", "")) > long.length, "its size counts every answer");
		const paged = await m.call("agent_transcript", { id: "ag_01", offset: long.length - 200 });
		assert.match(m.textOf(paged), /No action needed/, "the page past the first answer reaches the second");
		assert.ok(paged.details.finalAnswer.total > long.length, "read-back's total counts every answer");
		await m.shutdown();
	});
});

test("settle report: read-back shows the latest report, even a short one", async () => {
	await rig(async ({ agentDir, host, file }) => {
		const m = manager(file, host, agentDir);
		m.start();
		const chat = await spawned(m, host, `A long first report ${"x".repeat(2000)}`);
		host.turn(chat, { user: "[job j1] ended", reply: "No action needed", key: "job#1" });
		const back = await m.readBack("ag_01");
		assert.match(back, /No action needed/);
		assert.ok(!back.includes("A long first report"), back.slice(0, 400));
		assert.ok(/— waiting/.test(back), back.slice(0, 200));
		await m.shutdown();
	});
});

// ── t16: teams ─────────────────────────────────────────────────────────────

const TEAM_DEFAULTS = {
	version: 1,
	coordinator: { enabled: true, role: "coordinator", primary: { backend: "pi", model: "test/model", effort: "medium" }, fallback: null, instructions: "" },
	monitor: { enabled: true, role: "monitor", primary: { backend: "pi", model: "test/model", effort: "medium" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: false, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
	handover: { retireTimeoutMinutes: 10 },
};

async function team(r: { agentDir: string; host: FakeWorkerHost; file: ReturnType<typeof sessionFile> }) {
	fs.writeFileSync(path.join(r.agentDir, "team-defaults.json"), JSON.stringify(TEAM_DEFAULTS));
	const m = manager(r.file, r.host, r.agentDir);
	m.start();
	const created = await m.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }, { role: "qa", prompt: "test" }] });
	const members: { workerId: string; role: string; duty?: string }[] = created.details.members;
	const id = (role: string) => members.find((x) => x.role === role)!.workerId;
	await until(() => r.host.starts.length === 4, "the starts");
	const chat = (role: string) => r.host.get(id(role)).ref.chatId;
	const startOf = (role: string) => r.host.starts.find((s) => s.spec.parent.workerId === id(role))!;
	const dir = (role: string) => decodeMemberContext(startOf(role).spec.env[MEMBER_ENV])!.dir;
	for (const role of ["coordinator", "dev", "qa", "monitor"]) writeInboxCaps(dir(role));
	return { m, id, chat, startOf, dir };
}

const reportsIn = (dir: string) => readMemberItems(dir).filter((i) => i.kind === "report");

/** Both members report, dev's self-started run goes, the coordinator plays its task and its inbox run: its finish holds its wake. */
async function heldFinish(r: { host: FakeWorkerHost }, t: Awaited<ReturnType<typeof team>>) {
	const [dev, qa, lead] = [t.chat("dev"), t.chat("qa"), t.chat("coordinator")];
	r.host.turn(dev, { user: "build", reply: "built it", key: `${t.startOf("dev").key}:task#1` });
	r.host.turn(qa, { user: "test", reply: "tested it", key: `${t.startOf("qa").key}:task#1` });
	await until(() => reportsIn(t.dir("coordinator")).length === 2, "both first reports");
	selfStart(r.host, dev);
	r.host.turn(lead, { user: "plan", reply: "the objective is done", key: `${t.startOf("coordinator").key}:task#1` });
	await until(() => t.m.completions().length === 1, "the coordinator's finish");
	await until(() => r.host.get(lead).sends.length === 1, "the first reports listed to the coordinator");
	r.host.turn(lead, { user: r.host.get(lead).sends[0]!.text, reply: "still done", key: "lead#2" });
	await until(() => t.m.completions().length === 2, "the coordinator's finish after its inbox");
	assert.equal(t.m.completions()[1]![1].triggerTurn, false, "dev still works: the wake is held");
	return { dev, qa, lead };
}
function selfStart(host: FakeWorkerHost, chat: string): void {
	host.state(chat, { status: "running" });
	host.event(chat, { type: "agent_start" });
	host.event(chat, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "[job j1] It passed (exit code 0)." }] } });
}
function endQuietly(host: FakeWorkerHost, chat: string, key: string): void {
	host.event(chat, { type: "agent_end", messages: [] });
	host.event(chat, { type: "agent_settled", settleKey: key, settleEntryId: key });
	host.state(chat, { status: "idle", lastSettled: { key, entryId: key, outcome: "success" } });
}
const wakesOf = (t: Awaited<ReturnType<typeof team>>) => t.m.completions().filter((c) => c[1].triggerTurn === true);

test("settle report: a member woken by a job's end goes idle again: normal team messages reach it, and its reply reaches the coordinator", async () => {
	await rig(async (r) => {
		const t = await team(r);
		r.host.turn(t.chat("dev"), { user: "build", reply: "built it", key: `${t.startOf("dev").key}:task#1` });
		await until(() => reportsIn(t.dir("coordinator")).length === 1, "dev's first report");
		r.host.turn(t.chat("dev"), { user: "[job j1] It passed (exit code 0).", reply: "the job passed too", key: "job#1" });
		await until(() => reportsIn(t.dir("coordinator")).length === 2, "dev's second report");
		const second = reportsIn(t.dir("coordinator"))[1]!;
		assert.match(second.body, /the job passed too/);
		assert.match(second.subject, /^finished: the job passed too/);
		const sent = r.host.get(t.chat("dev")).sends.length;
		const id = requestId();
		writeRequest(t.dir("qa"), { version: 1, id, at: Date.now(), type: "message", to: "dev", message: "API is ready" } as any);
		assert.match((await awaitResponse(t.dir("qa"), id, 3000, undefined, 5))!.text, /^Queued for dev/);
		await until(() => r.host.get(t.chat("dev")).sends.length === sent + 1, "the normal item listed to dev");
		assert.match(r.host.get(t.chat("dev")).sends.at(-1)!.text, /API is ready/);
		await t.m.shutdown();
	});
});

test("settle report: a member whose card's run wrote nothing goes idle: an item that waited for that run is listed to it", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const dev = t.chat("dev");
		r.host.turn(dev, { user: "build", reply: "built it", key: `${t.startOf("dev").key}:task#1` });
		await until(() => reportsIn(t.dir("coordinator")).length === 1, "dev's first report");
		r.host.state(dev, { status: "running" });
		r.host.event(dev, { type: "agent_start" });
		const sent = r.host.get(dev).sends.length;
		const id = requestId();
		writeRequest(t.dir("qa"), { version: 1, id, at: Date.now(), type: "message", to: "dev", message: "API is ready" } as any);
		assert.match((await awaitResponse(t.dir("qa"), id, 3000, undefined, 5))!.text, /^Queued for dev/);
		assert.equal(r.host.get(dev).sends.length, sent, "busy: a normal item waits for the run's end");
		r.host.event(dev, { type: "agent_end", messages: [] });
		r.host.event(dev, { type: "agent_settled", settleKey: "job#1" });
		await until(() => r.host.get(dev).sends.length === sent + 1, "the item listed once the run ended");
		assert.match(r.host.get(dev).sends.at(-1)!.text, /API is ready/);
		assert.equal(reportsIn(t.dir("coordinator")).length, 1, "the quiet run reported nothing");
		await t.m.shutdown();
	});
});

test("settle report: a coordinator finishing during a member's card run wakes the main chat once that member's report has reached it", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const [dev, qa, lead] = [t.chat("dev"), t.chat("qa"), t.chat("coordinator")];
		r.host.turn(dev, { user: "build", reply: "built it", key: `${t.startOf("dev").key}:task#1` });
		r.host.turn(qa, { user: "test", reply: "tested it", key: `${t.startOf("qa").key}:task#1` });
		await until(() => reportsIn(t.dir("coordinator")).length === 2, "both first reports");
		// A job's end wakes dev; the coordinator finishes while that run goes.
		r.host.state(dev, { status: "running" });
		r.host.event(dev, { type: "agent_start" });
		r.host.turn(lead, { user: "plan", reply: "the objective is done", key: `${t.startOf("coordinator").key}:task#1` });
		await until(() => t.m.completions().length === 1, "the coordinator's completion");
		assert.equal(t.m.completions()[0]![1].triggerTurn, false, "a teammate still works: no wake yet");
		// The two first reports were listed to the coordinator: that listing's run plays out, still with dev at work.
		const listed = (text: string, reply: string, key: string) => {
			r.host.event(lead, { type: "agent_start" });
			r.host.event(lead, { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
			r.host.event(lead, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" } });
			r.host.event(lead, { type: "agent_end", messages: [] });
			r.host.event(lead, { type: "agent_settled", settleKey: key, settleEntryId: `${key}-e` });
		};
		await until(() => r.host.get(lead).sends.length >= 1, "the first reports listed to the coordinator");
		listed(r.host.get(lead).sends.at(-1)!.text, "noted both", "lead#2");
		await until(() => t.m.completions().length === 2, "the coordinator's reply to that listing");
		assert.equal(t.m.completions()[1]![1].triggerTurn, false, "dev still works: still no wake");
		// Dev's run ends: its report is recorded and reaches the coordinator, whose next settle wakes the main chat.
		r.host.event(dev, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the job passed too" }], stopReason: "stop" } });
		r.host.event(dev, { type: "agent_end", messages: [] });
		r.host.event(dev, { type: "agent_settled", settleKey: "job#1", settleEntryId: "x" });
		r.host.state(dev, { status: "idle", lastSettled: { key: "job#1", entryId: "x", outcome: "success" } });
		await until(() => reportsIn(t.dir("coordinator")).some((i) => /the job passed too/.test(i.body)), "dev's report at the coordinator");
		assert.equal(await t.m.statusOf(t.id("dev")), "waiting");
		await until(() => r.host.get(lead).sends.some((s) => /the job passed too/.test(s.text)), "the report listed to the coordinator");
		const send = r.host.get(lead).sends.find((s) => /the job passed too/.test(s.text))!;
		listed(send.text, "all done now", "lead#3");
		await until(() => t.m.completions().length === 3, "the coordinator's last completion");
		assert.equal(t.m.completions()[2]![1].triggerTurn, true, "no teammate works: the main chat wakes");
		await t.m.shutdown();
	});
});

test("settle report: a coordinator's report item from a member holds every answer; its subject is the first answer's first line", async () => {
	await rig(async (r) => {
		const t = await team(r);
		answerThenCard(r.host, t.chat("dev"), ["Real findings\nin detail", "No action needed"], "task#1");
		await until(() => reportsIn(t.dir("coordinator")).length === 1, "the report");
		const item = reportsIn(t.dir("coordinator"))[0]!;
		assert.equal(item.subject, "finished: Real findings");
		inOrder(item.body, "Real findings\nin detail", "No action needed");
		await t.m.shutdown();
	});
});

test("settle report: a member's long report: its coordinator's whole-answer file holds every answer", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const long = `Real findings\n${"finding ".repeat(800)}`;
		answerThenCard(r.host, t.chat("dev"), [long, "No action needed"], "task#1");
		await until(() => reportsIn(t.dir("coordinator")).length === 1, "the report");
		const item = reportsIn(t.dir("coordinator"))[0]!;
		const whole = /Whole answer: (\S+\.md)\./.exec(item.body)?.[1];
		assert.ok(whole, item.body.slice(-400));
		inOrder(fs.readFileSync(whole!, "utf8"), long.trim(), "No action needed");
		await t.m.shutdown();
	});
});

// ── a3: reload ─────────────────────────────────────────────────────────────

function sessionLines(file: string, lines: { id: string; at: number; role: "assistant" | "user"; text: string; stopReason?: string; errorMessage?: string }[]): void {
	fs.writeFileSync(
		file,
		lines
			.map((l) =>
				JSON.stringify({
					type: "message",
					id: l.id,
					timestamp: new Date(l.at).toISOString(),
					message: { role: l.role, content: [{ type: "text", text: l.text }], ...(l.role === "assistant" ? { stopReason: l.stopReason ?? "stop" } : {}), ...(l.errorMessage ? { errorMessage: l.errorMessage } : {}) },
				}),
			)
			.join("\n") + "\n",
	);
}

/** A worker that reported once and then wrote more while no parent was there (or nobody delivered it). */
async function missed(r: { agentDir: string; host: FakeWorkerHost; file: ReturnType<typeof sessionFile> }) {
	const first = manager(r.file, r.host, r.agentDir);
	first.start();
	const chat = await spawned(first, r.host, "first report");
	await until(() => r.file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId), "its record names the settled entry");
	const record = r.file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId).at(-1).data;
	await first.shutdown();
	const at = Date.now() + 60_000;
	sessionLines(r.host.get(chat).ref.sessionFile!, [
		{ id: "u0", at: at - 9000, role: "user", text: "do the work" },
		{ id: record.settleEntryId, at: at - 8000, role: "assistant", text: "first report" },
		{ id: "u1", at: at - 7000, role: "user", text: "[job j1] It passed (exit code 0)." },
		{ id: "c1", at: at - 6000, role: "assistant", text: "checking the log", stopReason: "toolUse" },
		{ id: "a2", at: at - 5000, role: "assistant", text: "The missed report" },
		{ id: "u2", at: at - 4000, role: "user", text: "[job j2] It passed (exit code 0)." },
		{ id: "a3", at: at - 3000, role: "assistant", text: "No action needed" },
	]);
	return { chat, at };
}

const assertMissedDelivered = (content: string) => {
	inOrder(content, "The missed report", "No action needed");
	assert.ok(!content.includes(NO_OUTPUT), content);
	assert.ok(!content.includes("first report"), "what was reported isn't sent again");
	assert.ok(!content.includes("checking the log"), "commentary is no answer");
};

test("settle report: a reload delivers a missed report with what the worker wrote, starting a turn however old (the process still knows its settle)", async () => {
	await rig(async (r) => {
		const { chat } = await missed(r);
		r.host.state(chat, { status: "idle", lastSettled: { key: "job#9", entryId: "a3", outcome: "success" } });
		const second = manager(r.file, r.host, r.agentDir);
		second.start();
		await until(() => second.completions().length === 1, "the missed report");
		const [message, delivery] = second.completions()[0]!;
		assertMissedDelivered(message.content);
		assert.equal(delivery.triggerTurn, true);
		assert.equal(await second.statusOf("ag_01"), "waiting");
		inOrder(await second.readBack("ag_01"), "The missed report", "No action needed");
		await second.shutdown();
		// The next manager has nothing more to say.
		const third = manager(r.file, r.host, r.agentDir);
		third.start();
		await until(async () => (await third.statusOf("ag_01")) === "waiting", "picked back up");
		await new Promise((res) => setTimeout(res, 50)); // the first state answers the watch in a microtask; one poll holds it
		assert.equal(third.completions().length, 0, "once");
		await third.shutdown();
	});
});

test("settle report: a reload delivers a missed report read from the file when the worker's process was reopened since", async () => {
	await rig(async (r) => {
		const { chat } = await missed(r);
		r.host.state(chat, { status: "idle", lastSettled: null });
		const second = manager(r.file, r.host, r.agentDir);
		second.start();
		await until(() => second.completions().length === 1, "the missed report");
		assertMissedDelivered(second.completions()[0]![0].content);
		await second.shutdown();
	});
});

test("settle report: a missed failed run reloads as a failure with its error, its text carried", async () => {
	await rig(async (r) => {
		const first = manager(r.file, r.host, r.agentDir);
		first.start();
		const chat = await spawned(first, r.host, "first report");
		await until(() => r.file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId), "the record");
		const record = r.file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId).at(-1).data;
		await first.shutdown();
		const at = Date.now() + 60_000;
		sessionLines(r.host.get(chat).ref.sessionFile!, [
			{ id: record.settleEntryId, at: at - 8000, role: "assistant", text: "first report" },
			{ id: "u1", at: at - 7000, role: "user", text: "[job j1] ended" },
			{ id: "a2", at: at - 5000, role: "assistant", text: "partial reply", stopReason: "error", errorMessage: "provider 500" },
		]);
		r.host.state(chat, { status: "idle", lastSettled: null });
		const second = manager(r.file, r.host, r.agentDir);
		second.start();
		await until(() => second.completions().length === 1, "the missed report");
		const content = second.completions()[0]![0].content;
		assert.match(content, /provider 500/);
		assert.match(content, /partial reply/);
		await second.shutdown();
	});
});

test("settle report: a reload restores an idle worker's latest report: read-back never says it had no output when it answered", async () => {
	await rig(async (r) => {
		const first = manager(r.file, r.host, r.agentDir);
		first.start();
		const chat = await spawned(first, r.host, "the latest report");
		await until(() => r.file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId), "the record");
		const record = r.file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId).at(-1).data;
		await first.shutdown();
		sessionLines(r.host.get(chat).ref.sessionFile!, [
			{ id: "u0", at: Date.now() - 9000, role: "user", text: "do the work" },
			{ id: record.settleEntryId, at: Date.now() - 8000, role: "assistant", text: "the latest report" },
		]);
		const second = manager(r.file, r.host, r.agentDir);
		second.start();
		await until(async () => (await second.statusOf("ag_01")) === "waiting", "picked back up");
		assert.equal(second.completions().length, 0, "nothing owed");
		const back = await second.readBack("ag_01");
		assert.ok(!back.includes(NO_OUTPUT), back);
		assert.match(back, /the latest report/);
		await second.shutdown();
	});
});

test("settle report: a job's run that wrote nothing found by a reload sends nothing: the record moves on and the last report reads back, through another reload too", async () => {
	await rig(async (r) => {
		const first = manager(r.file, r.host, r.agentDir);
		first.start();
		const chat = await spawned(first, r.host, "the real report");
		await until(() => r.file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId), "the record");
		const record = r.file.entries.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId).at(-1).data;
		await first.shutdown();
		const at = Date.now() + 60_000;
		sessionLines(r.host.get(chat).ref.sessionFile!, [
			{ id: "u0", at: at - 9000, role: "user", text: "do the work" },
			{ id: record.settleEntryId, at: at - 8000, role: "assistant", text: "the real report" },
			{ id: "u1", at: at - 7000, role: "user", text: "[job j1] Background job ended." },
			{ id: "e1", at: at - 5000, role: "assistant", text: "" },
		]);
		r.host.state(chat, { status: "idle", lastSettled: { key: "job#9", entryId: "e1", outcome: "success" } });
		const second = manager(r.file, r.host, r.agentDir);
		second.start();
		await until(() => r.file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleEntryId === "e1"), "the settle recorded");
		assert.equal(second.completions().length, 0, "nothing sent");
		assert.equal(await second.statusOf("ag_01"), "waiting");
		const back = await second.readBack("ag_01");
		assert.ok(!back.includes(NO_OUTPUT), back);
		assert.match(back, /the real report/);
		await second.shutdown();
		const third = manager(r.file, r.host, r.agentDir);
		third.start();
		await until(async () => (await third.statusOf("ag_01")) === "waiting", "picked back up");
		assert.equal(third.completions().length, 0, "still nothing");
		assert.match(await third.readBack("ag_01"), /the real report/);
		await third.shutdown();
	});
});

// ── a4: the jobs still running ─────────────────────────────────────────────

function job(r: { jobs: string }, sessionId: string, id: string, over: Partial<JobRecord> = {}): void {
	writeJob(r.jobs, {
		v: 1, id, sessionId, path: `/s/${sessionId}.jsonl`, kind: "requested", command: "npm run serve", cwd: "/w", unit: `u-${id}.service`, driver: "detached",
		startedAt: Date.now() - 8 * 60_000, bootId: "boot-1", worker: "ag_01", ...over,
	});
}
/** The job, what it runs and how long, then what its end does: "8 min" or "8m", as long as it's that sentence. */
const STILL = /Still running: j2 \(npm run serve\), 8 ?m[a-z0-9 ]*\. It wakes this worker when it ends\./;

test("settle report: a report made with a job running names it after the answer: completion, read-back and wait; it starts a turn", async () => {
	await rig(async (r) => {
		const m = manager(r.file, r.host, r.agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
		await until(() => r.host.starts.length > 0, "the start");
		const chat = r.host.get("ag_01").ref.chatId;
		job(r, chat, "j2");
		r.host.turn(chat, { user: "do the work", reply: "The answer\nin two lines", key: "task#1" });
		await until(() => m.completions().length === 1, "the report");
		const [message, delivery] = m.completions()[0]!;
		assert.match(message.content, STILL, message.content);
		inOrder(message.content, "The answer\nin two lines", "Still running: j2");
		assert.equal(delivery.triggerTurn, true, "the first report of an instruction always starts a turn");
		const back = await m.readBack("ag_01");
		assert.match(back, STILL, back);
		inOrder(back, "The answer\nin two lines", "Still running: j2");
		assert.match(m.textOf(await m.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 1 })), STILL);
		await m.shutdown();
	});
});

test("settle report: a kept job with no worker field counts; a job that ended counts only while its wake card is still owed", async () => {
	await rig(async (r) => {
		const m = manager(r.file, r.host, r.agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
		await until(() => r.host.starts.length > 0, "the start");
		const chat = r.host.get("ag_01").ref.chatId;
		job(r, chat, "j2", { kind: "kept", worker: undefined });
		job(r, chat, "j3", { command: "owed card", ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		job(r, chat, "j4", { command: "card sent", ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		markCardDone(r.jobs, chat, "j4", "sent");
		job(r, chat, "j5", { command: "a quiet note", ended: { at: Date.now(), how: "exited", exit: 0, card: "note" } });
		job(r, chat, "j6", { command: "stopped quietly", ended: { at: Date.now(), how: "stopped", card: "none" } });
		r.host.turn(chat, { user: "do the work", reply: "done", key: "task#1" });
		await until(() => m.completions().length === 1, "the report");
		const content: string = m.completions()[0]![0].content;
		assert.match(content, /Still running: .*j2 \(npm run serve\)/, content);
		assert.match(content, /j3 \(owed card\)/, "its card will wake this worker");
		for (const gone of ["j4", "j5", "j6", "card sent", "quiet note", "stopped quietly"]) assert.ok(!content.includes(gone), `${gone} isn't running: ${content}`);
		await m.shutdown();
	});
});

test("settle report: a card's report names the job still running; it doesn't imply the work is unfinished", async () => {
	await rig(async (r) => {
		const m = manager(r.file, r.host, r.agentDir);
		m.start();
		const chat = await spawned(m, r.host);
		job(r, chat, "j2");
		r.host.turn(chat, { user: "[job j1] It passed (exit code 0).", reply: "j1 passed", key: "job#1" });
		await until(() => m.completions().length === 2, "the second report");
		const [message, delivery] = m.completions()[1]!;
		assert.match(message.content, STILL, message.content);
		assert.equal(delivery.triggerTurn, true, "every reply starts a turn");
		const line = message.content.split("\n").find((l: string) => l.startsWith("Still running"))!;
		assert.ok(!/not (yet )?(done|finished|final)|unfinished|in progress|more to come|another report/i.test(line), line);
		await m.shutdown();
	});
});

test("settle report: a cut report keeps the jobs line, and the trailer stays the last line", async () => {
	await rig(async (r) => {
		const m = manager(r.file, r.host, r.agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "do the work", name: "worker" });
		await until(() => r.host.starts.length > 0, "the start");
		const chat = r.host.get("ag_01").ref.chatId;
		job(r, chat, "j2");
		r.host.turn(chat, { user: "do the work", reply: `Long report\n${"finding ".repeat(800)}`, key: "task#1" });
		await until(() => m.completions().length === 1, "the report");
		const content: string = m.completions()[0]![0].content;
		assert.match(content, STILL, content.slice(-600));
		assert.match(content, /\[Use agent_transcript for more\.\]\s*$/);
		await m.shutdown();
	});
});

test("settle report: a member's report to its coordinator names its jobs too", async () => {
	await rig(async (r) => {
		const t = await team(r);
		job(r, t.chat("dev"), "j2");
		r.host.turn(t.chat("dev"), { user: "build", reply: "built it", key: "task#1" });
		await until(() => reportsIn(t.dir("coordinator")).length === 1, "the report");
		assert.match(reportsIn(t.dir("coordinator"))[0]!.body, STILL);
		await t.m.shutdown();
	});
});

test("settle report (guard): with no jobs at all, a report has no jobs line", async () => {
	await rig(async (r) => {
		const m = manager(r.file, r.host, r.agentDir);
		m.start();
		await spawned(m, r.host);
		assert.ok(!m.completions()[0]![0].content.includes("Still running"));
		assert.ok(!(await m.readBack("ag_01")).includes("Still running"));
		await m.shutdown();
	});
});

// ── a held team wake: a quiet settle sends no report, so nothing else would wake the main chat ───

test("settle report: the last teammate going idle with nothing written sends a coordinator's held wake, once", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const { dev, qa } = await heldFinish(r, t);
		// Another teammate is still working: it isn't due yet.
		selfStart(r.host, qa);
		endQuietly(r.host, dev, "dev#quiet");
		await until(async () => (await t.m.statusOf(t.id("dev"))) === "waiting", "dev idle");
		assert.equal(wakesOf(t).length, 0, "qa still works");
		endQuietly(r.host, qa, "qa#quiet");
		await until(() => wakesOf(t).length === 1, "the held wake");
		assert.equal(reportsIn(t.dir("coordinator")).length, 2, "no report came of either run");
		// At most once per held finish.
		selfStart(r.host, dev);
		endQuietly(r.host, dev, "dev#quiet2");
		await until(async () => (await t.m.statusOf(t.id("dev"))) === "waiting", "dev idle again");
		assert.equal(wakesOf(t).length, 1);
		await t.m.shutdown();
	});
});

test("settle report (guard): a normal wake clears the held one: no second wake when a teammate later goes idle with nothing written", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const { dev, lead } = await heldFinish(r, t);
		// Dev reports; the coordinator runs on it and its settle is the normal wake.
		r.host.event(dev, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the job passed too" }], stopReason: "stop" } });
		endQuietly(r.host, dev, "dev#report");
		await until(() => r.host.get(lead).sends.some((s) => /the job passed too/.test(s.text)), "dev's report listed to the coordinator");
		r.host.turn(lead, { user: r.host.get(lead).sends.at(-1)!.text, reply: "all done now", key: "lead#3" });
		await until(() => wakesOf(t).length === 1, "the normal wake");
		selfStart(r.host, dev);
		endQuietly(r.host, dev, "dev#quiet");
		await until(async () => (await t.m.statusOf(t.id("dev"))) === "waiting", "dev idle");
		assert.equal(wakesOf(t).length, 1, "no second wake");
		await t.m.shutdown();
	});
});

test("settle report: a quiet coordinator run leaves the held wake owed: the last teammate going idle sends exactly one", async () => {
	await rig(async (r) => {
		const t = await team(r);
		const { dev, lead } = await heldFinish(r, t);
		selfStart(r.host, lead);
		endQuietly(r.host, lead, "lead#quiet");
		await until(async () => (await t.m.statusOf(t.id("coordinator"))) === "waiting", "the coordinator idle");
		assert.equal(wakesOf(t).length, 0, "dev still works");
		endQuietly(r.host, dev, "dev#quiet");
		await until(() => wakesOf(t).length === 1, "the held wake");
		// Anything after it finds nothing owed.
		selfStart(r.host, lead);
		endQuietly(r.host, lead, "lead#quiet2");
		await until(async () => (await t.m.statusOf(t.id("coordinator"))) === "waiting", "the coordinator idle again");
		assert.equal(wakesOf(t).length, 1);
		await t.m.shutdown();
	});
});

test("settle report: a coordinator run that writes something sends one wake in total, whichever ends first", async () => {
	const written = (host: FakeWorkerHost, chat: string, text: string) => host.event(chat, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
	// The coordinator ends first: its finish is held again, and dev's quiet end sends the wake.
	await rig(async (r) => {
		const t = await team(r);
		const { dev, lead } = await heldFinish(r, t);
		const before = t.m.completions().length;
		selfStart(r.host, lead);
		written(r.host, lead, "one more note");
		endQuietly(r.host, lead, "lead#note");
		await until(() => t.m.completions().length === before + 1, "the coordinator's note");
		assert.equal(wakesOf(t).length, 0, "dev still works");
		endQuietly(r.host, dev, "dev#quiet");
		await until(() => wakesOf(t).length === 1, "the wake");
		await until(async () => (await t.m.statusOf(t.id("dev"))) === "waiting", "dev idle");
		assert.equal(wakesOf(t).length, 1);
		await t.m.shutdown();
	});
	// Dev ends first, during the coordinator's run: the coordinator's own settle is the one wake.
	await rig(async (r) => {
		const t = await team(r);
		const { dev, lead } = await heldFinish(r, t);
		selfStart(r.host, lead);
		endQuietly(r.host, dev, "dev#quiet");
		await until(async () => (await t.m.statusOf(t.id("dev"))) === "waiting", "dev idle");
		assert.equal(wakesOf(t).length, 0, "the coordinator still works");
		written(r.host, lead, "one more note");
		endQuietly(r.host, lead, "lead#note");
		await until(() => wakesOf(t).length === 1, "the wake");
		await until(async () => (await t.m.statusOf(t.id("coordinator"))) === "waiting", "the coordinator idle");
		assert.equal(wakesOf(t).length, 1);
		await t.m.shutdown();
	});
});
