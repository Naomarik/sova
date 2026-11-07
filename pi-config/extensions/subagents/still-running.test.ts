/**
 * The line a worker's report carries while the worker still has background jobs (job-store.ts): the
 * report the main chat receives, what it reads back with agent_transcript, and what agent_wait returns.
 * The records are read from the worker's own session directory, written here as the host's keeper
 * writes them. Over the in-memory FakeWorkerHost, whose chat id is the worker's session id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSubagents } from "./index.ts";
import { cardFile, JOBS_DIR_ENV, writeJob, type JobRecord } from "./job-store.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";

const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");
const TRAILER = "[Use agent_transcript for more.]";
const MINUTES = 60_000;

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

const until = async (check: () => boolean, what: string, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

/** A manager with one worker that has spawned, in a state root with a jobs directory the env names. */
async function scene(body: (s: {
	jobs: string;
	session: string;
	host: FakeWorkerHost;
	call: (name: string, params: any) => Promise<any>;
	completions: () => { content: string; triggerTurn: boolean }[];
	job: (id: string, patch?: Partial<JobRecord>) => void;
	instructionTurn: (reply: string) => Promise<void>;
}) => Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-still-running-"));
	const saved = process.env[JOBS_DIR_ENV];
	const jobs = path.join(root, "jobs");
	process.env[JOBS_DIR_ENV] = jobs;
	const entries: any[] = [];
	const bus = eventBus();
	const host = new FakeWorkerHost();
	host.announceOn(bus);
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const messages: any[][] = [];
	const ctx: any = {
		cwd: root, mode: "tui", hasUI: false, thinkingLevel: "high", isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [...entries], getBranch: () => [...entries], getSessionFile: () => "/sessions/owner.jsonl", getSessionId: () => "owner" },
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
			appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", id: `e${entries.length + 1}`, customType, data }),
			getActiveTools: () => ["read", "bash"],
			sendMessage: (...m: any[]) => messages.push(m),
		} as any,
		undefined,
		{ policyFile: NO_POLICY_FILE, agentDir: root, mailboxPollMs: 10, setTimer: (fn, ms) => setTimeout(fn, ms) },
	);
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, () => {}, ctx);
	try {
		events.get("session_start")({}, ctx);
		await call("agent_spawn", { prompt: "build it", name: "builder" });
		await until(() => host.starts.length === 1, "the start");
		const session = host.get("ag_01").ref.chatId;
		let task = 0;
		await body({
			jobs,
			session,
			host,
			call,
			completions: () => messages.filter((m) => m[0]?.customType === "subagent-complete").map((m) => ({ content: m[0].content, triggerTurn: m[1].triggerTurn })),
			job: (id, patch = {}) =>
				writeJob(jobs, {
					v: 1, id, sessionId: session, path: "/sessions/worker.jsonl", kind: "requested", command: "npm run serve", cwd: root,
					unit: `${id}.service`, driver: "systemd", startedAt: Date.now() - 8 * MINUTES, bootId: "boot", worker: "ag_01", ...patch,
				}),
			instructionTurn: async (reply) => {
				// The spawn's task first; after that, an instruction the main chat sends.
				if (!task++) return host.turn(session, { user: "go", reply, key: `${host.starts[0]!.key}:task#1` });
				await call("agent_steer", { id: "ag_01", message: "go on" });
				host.turn(session, { user: "go on", reply, key: host.get(session).sends.at(-1)!.key });
			},
		});
		await events.get("session_shutdown")({}, ctx);
	} finally {
		if (saved === undefined) delete process.env[JOBS_DIR_ENV];
		else process.env[JOBS_DIR_ENV] = saved;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("a running job: the first report after an instruction names it after the answer, and starts a turn", async () => {
	await scene(async (s) => {
		s.job("j2", { command: "npm   run\n serve" });
		await s.instructionTurn("Built it.\nDetails here.");
		await until(() => s.completions().length === 1, "the report");
		const { content, triggerTurn } = s.completions()[0]!;
		assert.equal(triggerTurn, true);
		const lines = content.split("\n");
		assert.equal(lines.at(-1), "Still running: j2 (npm run serve), 8m. It wakes this worker when it ends.");
		assert.ok(content.indexOf("Built it.") < content.indexOf("Still running"), "after the answer: its first line stays the preview");
		assert.ok(!/unfinished|not finished|still working|another report/i.test(lines.at(-1)!), "says nothing about the work being unfinished");
	});
});

test("a kept job with no worker field counts: the read is by the worker's session directory", async () => {
	await scene(async (s) => {
		s.job("j13", { kind: "kept", worker: undefined });
		await s.instructionTurn("Done.");
		await until(() => s.completions().length === 1, "the report");
		assert.match(s.completions()[0]!.content, /\nStill running: j13 \(npm run serve\), 8m\. It wakes this worker when it ends\.$/);
	});
});

test("no job running: no line, whatever way the earlier ones ended", async () => {
	await scene(async (s) => {
		const at = Date.now() - MINUTES;
		s.job("j1", { ended: { at, how: "exited", exit: 0, card: "wake" } });
		fs.writeFileSync(cardFile(s.jobs, s.session, "j1"), "sent\n");
		s.job("j2", { ended: { at, how: "stopped", card: "note" }, kind: "kept" });
		s.job("j3", { ended: { at, how: "exited", exit: 1, card: "none" } });
		await s.instructionTurn("Done.");
		await until(() => s.completions().length === 1, "the report");
		assert.doesNotMatch(s.completions()[0]!.content, /Still running|Just ended/);
	});
});

test("no session directory at all, and no jobs directory in the env: no line, and the report still goes out", async () => {
	await scene(async (s) => {
		await s.instructionTurn("First.");
		await until(() => s.completions().length === 1, "the first report");
		assert.doesNotMatch(s.completions()[0]!.content, /Still running/);
		s.job("j1");
		delete process.env[JOBS_DIR_ENV];
		await s.instructionTurn("Second.");
		await until(() => s.completions().length === 2, "the second report");
		assert.match(s.completions()[1]!.content, /Second\./);
		assert.doesNotMatch(s.completions()[1]!.content, /Still running/);
	});
});

test("a job that ended with its wake still owed is named as ended, never as running", async () => {
	await scene(async (s) => {
		s.job("j2");
		s.job("j3", { command: "npm test", ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		await s.instructionTurn("Done.");
		await until(() => s.completions().length === 1, "the report");
		const last = s.completions()[0]!.content.split("\n").at(-1)!;
		assert.equal(last, "Still running: j2 (npm run serve), 8m. It wakes this worker when it ends. Just ended: j3 (npm test). Its end card wakes this worker.");
	});
});

test("several jobs: each named, oldest first, the line in the plural; a job past the 200-char command is cut", async () => {
	await scene(async (s) => {
		s.job("j1");
		s.job("j2", { command: "x".repeat(500), startedAt: Date.now() - 2 * MINUTES });
		s.job("j10", { command: "npm test", ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		s.job("j11", { command: "npm run lint", ended: { at: Date.now(), how: "exited", exit: 1, card: "wake" } });
		await s.instructionTurn("Done.");
		await until(() => s.completions().length === 1, "the report");
		const last = s.completions()[0]!.content.split("\n").at(-1)!;
		assert.equal(
			last,
			`Still running: j1 (npm run serve), 8m; j2 (${"x".repeat(199)}…), 2m. Each wakes this worker when it ends. Just ended: j10 (npm test); j11 (npm run lint). Their end cards wake this worker.`,
		);
	});
});

test("a cut report keeps the line, ahead of the trailer Sova's report parser anchors on", async () => {
	await scene(async (s) => {
		s.job("j2");
		const long = `Opening line.\n${"word ".repeat(4000)}`;
		await s.instructionTurn(long);
		await until(() => s.completions().length === 1, "the report");
		const lines = s.completions()[0]!.content.split("\n");
		assert.equal(lines.at(-1), TRAILER);
		assert.ok(lines.some((l) => l.startsWith("Still running: j2 (")), "not cut with the answer");
	});
});

test("what the main chat reads back and waits for: agent_transcript (page and full) and agent_wait carry the line", async () => {
	await scene(async (s) => {
		s.job("j2");
		await s.instructionTurn("Built it.");
		await until(() => s.completions().length === 1, "the report");
		const LINE = /Still running: j2 \(npm run serve\), 8m\. It wakes this worker when it ends\./;
		const text = async (name: string, params: any) => (await s.call(name, params)).content[0].text as string;
		assert.match(await text("agent_wait", { ids: ["ag_01"], timeoutSeconds: 1 }), LINE);
		const page = await text("agent_transcript", { id: "ag_01" });
		assert.match(page, LINE);
		assert.ok(page.includes("Built it."), "the answer stays");
		assert.match(await text("agent_transcript", { id: "ag_01", full: true }), LINE);
		assert.match(await text("agent_transcript", { id: "ag_01", offset: 0, limit: 3 }), LINE);
	});
});

test("a later report stops naming a job once its end card is on the worker's branch", async () => {
	await scene(async (s) => {
		s.job("j2");
		await s.instructionTurn("First.");
		await until(() => s.completions().length === 1, "the first report");
		assert.match(s.completions()[0]!.content, /Still running: j2/);
		s.job("j2", { ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		fs.writeFileSync(cardFile(s.jobs, s.session, "j2"), "sent\n");
		await s.instructionTurn("Second.");
		await until(() => s.completions().length === 2, "the second report");
		assert.doesNotMatch(s.completions()[1]!.content, /Still running|Just ended/);
	});
});

test("a reply to a job's end, with another job running, is a report: it names that job and starts a turn", async () => {
	await scene(async (s) => {
		s.job("j1", { command: "npm test", ended: { at: Date.now(), how: "exited", exit: 0, card: "wake" } });
		fs.writeFileSync(cardFile(s.jobs, s.session, "j1"), "sent\n");
		s.job("j2");
		await s.instructionTurn("Started both.");
		await until(() => s.completions().length === 1, "the first report");
		// No key: nothing asked for this run, the job's end card started it.
		s.host.turn(s.session, { user: "[job j1] Background job ended.", reply: "Tests pass." });
		await until(() => s.completions().length === 2, "the report of the card's run");
		const { content, triggerTurn } = s.completions()[1]!;
		assert.equal(triggerTurn, true);
		assert.match(content, /Tests pass\.\n\nStill running: j2 /);
	});
});

test("a worker stopped by its parent has nothing left to wake: no line", async () => {
	await scene(async (s) => {
		await s.instructionTurn("Done.");
		await until(() => s.completions().length === 1, "the report");
		s.job("j2");
		const stopped = (await s.call("agent_kill", { id: "ag_01" })).content[0].text as string;
		assert.doesNotMatch(stopped, /Still running/);
		await until(() => s.completions().length === 2 || s.host.get(s.session).ref.state === "ended", "it stops");
		assert.ok(s.completions().slice(1).every((c) => !/Still running/.test(c.content)));
	});
});
