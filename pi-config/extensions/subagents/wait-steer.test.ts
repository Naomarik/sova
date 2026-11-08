/**
 * A steer ends agent_wait early: a team question the coordinator sends the main chat, or a message
 * the user typed during the run. The wait names who, the workers go on, and a settle the wait did not
 * return reaches the chat as after a timeout. A team report, a member's question routed to its
 * coordinator, and follow-ups that are not the user's never end it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSubagents } from "./index.ts";
import { MEMBER_ENV, type MailboxRequest, awaitResponse, decodeMemberContext, requestId, writeRequest } from "./mailbox.ts";

const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");
/** Both roles named on the chat's own test model, so the team has a coordinator whatever the default. */
const DEFAULTS_FILE = {
	version: 1,
	coordinator: { enabled: true, role: "coordinator", primary: { backend: "pi", model: "test/model" }, fallback: null, instructions: "" },
	monitor: { enabled: true, role: "monitor", primary: { backend: "pi", model: "test/model" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
	handover: { retireTimeoutMinutes: 10 },
};

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

function harness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-wait-steer-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "team-defaults.json"), JSON.stringify(DEFAULTS_FILE));
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const workers: any[] = [];
	const messages: any[] = [];
	/** What pi's text queues hold (ctx.hasPendingMessages reads them). */
	let pending = 0;
	const ctx: any = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		thinkingLevel: "high",
		isIdle: () => false,
		hasPendingMessages: () => pending > 0,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "0199aaaa-0000-7000-8000-00000000wait" },
		modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	registerSubagents(
		{
			events: eventBus(),
			registerTool: (t: any) => tools.set(t.name, t),
			on: (e: string, f: any) => events.set(e, f),
			registerCommand() {},
			registerShortcut() {},
			appendEntry() {},
			getAgentDir: () => agentDir,
			getActiveTools: () => ["read", "bash", "agent_spawn"],
			sendMessage: (...m: any[]) => messages.push(m),
			sendUserMessage() {},
		} as any,
		(options, handlers) => {
			const worker: any = {
				...options,
				wake: options.wake ?? true,
				extensions: options.extensions ?? [],
				status: "running",
				transcript: [],
				usage: { input: 0, output: 0, turns: 0 },
				steerCount: 0,
				isFinished() { return ["killed", "done", "error"].includes(this.status); },
				isSettled() { return this.isFinished() || this.status === "waiting"; },
				finalOutput() { return this.output ?? ""; },
				async steer(message: string) { this.lastSteer = { message }; this.steerCount++; this.status = "running"; return { ok: true }; },
				async kill() { this.status = "killed"; },
				async dispose() { this.status = "killed"; },
				settle(error?: string) { this.status = "waiting"; this.error = error; handlers.onSettled(this); },
			};
			workers.push(worker);
			return worker;
		},
		{ policyFile: NO_POLICY_FILE, agentDir, mailboxRoot: path.join(root, "mail"), mailboxPollMs: 10, inboxDebounceMs: 30, inboxRetryMs: [30, 60], setTimer: (fn, ms) => setTimeout(fn, ms) as any },
	);
	const memberOf = (id: string) => decodeMemberContext(workers.find((w) => w.id === id)?.env?.[MEMBER_ENV]);
	const ask = async (id: string, request: Omit<MailboxRequest, "version" | "id" | "at">) => {
		const me = memberOf(id)!;
		const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
		writeRequest(me.dir, full);
		const response = await awaitResponse(me.dir, full.id, 3000, undefined, 5);
		assert.ok(response, `parent answered ${request.type} from ${id}`);
		return response!;
	};
	return {
		workers,
		messages,
		ask,
		setPending: (n: number) => void (pending = n),
		worker: (role: string) => workers.find((w) => w.role === role || memberOf(w.id)?.role === role),
		of: (customType: string) => messages.filter((m) => m[0]?.customType === customType),
		call: (name: string, params: any = {}, signal?: AbortSignal) => tools.get(name).execute("test", params, signal, () => {}, ctx),
		event: (name: string, data: any) => events.get(name)?.(data, ctx),
		cleanup: async () => {
			await events.get("session_shutdown")?.({}, ctx);
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

const textOf = (r: any) => r.content[0].text as string;
/** The wait is still running after `ms` (it would have returned by then if it stopped early). */
const stillWaiting = async (p: Promise<unknown>, ms = 700) => {
	let done = false;
	void p.then(() => (done = true), () => (done = true));
	await new Promise((r) => setTimeout(r, ms));
	return !done;
};

async function crew(h: ReturnType<typeof harness>) {
	await h.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build" }] });
	const coordinator = h.worker("coordinator"), dev = h.worker("dev");
	assert.ok(coordinator && dev, "the team has Sova's coordinator and the named worker");
	return { coordinator, dev };
}

test("team_ask from the coordinator is steered into the main chat, waking it when idle", async () => {
	const h = harness();
	try {
		const { coordinator } = await crew(h);
		const asked = await h.ask(coordinator.id, { type: "question", message: "Ship now?" });
		assert.equal(asked.ok, true);
		assert.match(asked.text, /reads it after its current step, or at once if it is idle/);
		const [[message, delivery]] = h.of("team-question");
		assert.deepEqual(delivery, { deliverAs: "steer", triggerTurn: true });
		assert.match(message.content, /^\[Team question from coordinator[^\n]*\(/);
	} finally { await h.cleanup(); }
});

test("agent_wait stops early for a team question: who, deal with it, workers go on, a later settle is sent as after a timeout", async () => {
	const h = harness();
	try {
		const { coordinator, dev } = await crew(h);
		h.event("agent_start", {});
		const waiting = h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 30 });
		assert.equal(await stillWaiting(waiting, 200), true, "nothing to stop it yet");
		await h.ask(coordinator.id, { type: "question", message: "Ship now?" });
		const r = await waiting;
		assert.match(textOf(r), new RegExp(`^Stopped waiting early: a team question from coordinator \\(${coordinator.id}\\) of the team Crew is waiting for you\\. Deal with it, then go back to waiting \\(agent_wait\\); workers were not stopped\\. Still working: ${coordinator.id}`));
		assert.equal(r.details.timedOut, false);
		assert.match(r.details.steered, /team question/);
		assert.equal(coordinator.isSettled(), false, "the target was not stopped");
		assert.equal(dev.status, "running");
		// The question is read at the next step; the run then ends with the coordinator still working.
		h.event("message_end", { message: { role: "custom", customType: "team-question", content: "q" } });
		h.event("agent_end", { messages: [] });
		coordinator.output = "all done";
		coordinator.settle();
		const sent = h.of("subagent-complete");
		assert.equal(sent.length, 1, "a settle the wait never returned is sent as usual");
		assert.match(sent[0][0].content, /all done/);
		// Once read, a new wait is not stopped again.
		h.event("agent_start", {});
		coordinator.status = "running";
		assert.equal(await stillWaiting(h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 1.5 })), true);
	} finally { await h.cleanup(); }
});

test("a team question queued before agent_wait starts stops it at once", async () => {
	const h = harness();
	try {
		const { coordinator } = await crew(h);
		h.event("agent_start", {});
		await h.ask(coordinator.id, { type: "question", message: "Which schema?" });
		const started = Date.now();
		const r = await h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 30 });
		assert.ok(Date.now() - started < 1000, "returned without waiting");
		assert.match(textOf(r), /^Stopped waiting early: a team question from coordinator/);
	} finally { await h.cleanup(); }
});

test("a team report and a member's question routed to the coordinator do not end agent_wait", async () => {
	const h = harness();
	try {
		const { coordinator, dev } = await crew(h);
		h.event("agent_start", {});
		const waiting = h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 2 });
		const rep = await h.ask(coordinator.id, { type: "report", message: "Milestone: schema merged." });
		assert.equal(rep.ok, true);
		const q = await h.ask(dev.id, { type: "question", message: "Which schema?" });
		assert.match(q.text, /^Question queued for your coordinator/);
		assert.equal(h.of("team-question").length, 0);
		assert.equal(await stillWaiting(waiting), true, "neither stopped the wait");
		assert.match(textOf(await waiting), /^Timed out; still working/);
	} finally { await h.cleanup(); }
});

test("agent_wait stops for a message the user typed during the run, not for a follow-up nor a steer someone else sent", async () => {
	const h = harness();
	try {
		const { coordinator } = await crew(h);
		h.event("agent_start", {});
		const waiting = h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 30 });
		// Queued follow-ups (an extension's or a playbook's) and a program's steer sit in pi's queues too.
		h.event("input", { type: "input", text: "nudge", source: "extension", streamingBehavior: "followUp" });
		h.event("input", { type: "input", text: "later", source: "interactive", streamingBehavior: "followUp" });
		h.event("input", { type: "input", text: "from a program", source: "rpc", streamingBehavior: "steer" });
		h.setPending(3);
		assert.equal(await stillWaiting(waiting), true, "follow-ups and others' steers do not stop it");
		h.event("input", { type: "input", text: "stop, use SQLite", source: "interactive", streamingBehavior: "steer" });
		h.setPending(4);
		const r = await waiting;
		assert.match(textOf(r), /^Stopped waiting early: a message from the user is waiting for you\. Deal with it, then go back to waiting/);
		assert.equal(coordinator.isSettled(), false);
		// Read: the next wait runs on.
		h.event("message_end", { message: { role: "user", content: [{ type: "text", text: "stop, use SQLite" }] } });
		h.setPending(3);
		assert.equal(await stillWaiting(h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 1.5 })), true);
	} finally { await h.cleanup(); }
});

test("a typed steer that never reached pi's queue does not end agent_wait", async () => {
	const h = harness();
	try {
		const { coordinator } = await crew(h);
		h.event("agent_start", {});
		// Another input handler took it ("handled"): nothing waits in pi.
		h.event("input", { type: "input", text: "/thing", source: "interactive", streamingBehavior: "steer" });
		h.setPending(0);
		assert.equal(await stillWaiting(h.call("agent_wait", { ids: [coordinator.id], timeoutSeconds: 1.5 })), true);
	} finally { await h.cleanup(); }
});
