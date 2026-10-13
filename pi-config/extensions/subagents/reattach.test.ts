/**
 * The manager on chat workers (al_3 stage 4, §app.chat-processes/workers): agent_spawn starts every
 * worker through the session's worker host, a closing session lets go of its workers, and the next
 * manager picks back up those still running: listed live, and a run that settled meanwhile announced
 * once. Team mailboxes and wake_nudges are kept. Over the in-memory FakeWorkerHost; no process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSubagents } from "./index.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";
import { NO_WORKER_HOST } from "./worker-host.ts";
import { WORKER_MANIFEST_ENTRY_TYPE } from "./registry.ts";

const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");
const OWNER = { sessionId: "owner-1", path: "/sessions/owner-1.jsonl" };

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

/** One parent session: its entries outlive each manager (a reload = a new manager). */
function sessionFile() {
	const entries: any[] = [];
	return { entries, append: (customType: string, data: unknown) => void entries.push({ type: "custom", id: `e${entries.length + 1}`, customType, data }) };
}

function manager(file: ReturnType<typeof sessionFile>, host: FakeWorkerHost | null, agentDir: string) {
	const bus = eventBus();
	if (host) host.announceOn(bus);
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
		{ policyFile: NO_POLICY_FILE, agentDir, mailboxPollMs: 10, setTimer: (fn, ms) => setTimeout(fn, ms) },
	);
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, () => {}, ctx);
	return {
		messages,
		call,
		start: () => events.get("session_start")({}, ctx),
		shutdown: () => events.get("session_shutdown")({}, ctx),
		list: async () => (await call("agent_list", {})).details.agents as any[],
		completions: () => messages.filter((m) => m[0]?.customType === "subagent-complete"),
	};
}

const until = async (check: () => boolean, what: string, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

function tmpAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "subagents-reattach-"));
}

test("agent_spawn starts the worker through the session's worker host: its loadout, keyed by this session; no counter extension, no usage env", async () => {
	const agentDir = tmpAgentDir();
	try {
		const host = new FakeWorkerHost();
		const m = manager(sessionFile(), host, agentDir);
		m.start();
		await m.call("agent_spawn", { prompt: "count", name: "counter" });
		await until(() => host.starts.length === 1, "the start");
		const req = host.starts[0]!;
		assert.match(req.key, /^owner-1:ag_01:/);
		assert.deepEqual(req.spec.parent, { ...OWNER, workerId: "ag_01" });
		assert.equal(req.task, "count");
		assert.ok(!req.spec.extensions.some((e) => e.includes("llm-inflight")), "a worker chat counts its own calls");
		assert.ok(!Object.keys(req.spec.env).includes("PI_USAGE_PARENT"));
		assert.deepEqual(req.session, { new: { dir: path.join(agentDir, "sessions", `--${agentDir.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`) } });
		await m.shutdown();
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("with no worker host announced, a spawn fails with one plain reason", async () => {
	const agentDir = tmpAgentDir();
	try {
		const m = manager(sessionFile(), null, agentDir);
		m.start();
		const out = await m.call("agent_spawn", { prompt: "count" }).catch((err: Error) => ({ error: err.message }));
		const text = "error" in out ? out.error : JSON.stringify(out);
		assert.ok(text.includes(NO_WORKER_HOST) || (await m.list()).some((a) => a.error?.includes(NO_WORKER_HOST)), text);
		await m.shutdown();
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a reload keeps the worker: shutdown lets go of it; the next manager lists it live and announces a run that settled meanwhile once", async () => {
	const agentDir = tmpAgentDir();
	try {
		const host = new FakeWorkerHost();
		const file = sessionFile();
		const first = manager(file, host, agentDir);
		first.start();
		await first.call("agent_spawn", { prompt: "count", name: "counter" });
		await until(() => host.starts.length === 1, "the start");
		const chatId = host.get("ag_01").ref.chatId;
		await until(() => file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.ref), "its record names its session");
		await first.shutdown();
		assert.deepEqual(host.get(chatId).stops, [], "never stopped by a reload");
		assert.equal(host.get(chatId).watchers.size, 0, "let go of");

		// It finishes while no parent is there.
		host.turn(chatId, { user: "count", reply: "one two three", key: `${host.starts[0]!.key}:task#1` });

		const second = manager(file, host, agentDir);
		second.start();
		await until(() => second.completions().length === 1, "the announcement");
		const listed = (await second.list()).find((a) => a.id === "ag_01");
		assert.ok(listed, "listed");
		assert.notEqual(listed.status, "restored", "live, not restored");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(second.completions().length, 1, "once");
		assert.ok(file.entries.some((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE && e.data.settleKey === `${host.starts[0]!.key}:task#1`), "the settle recorded with its key");
		await second.shutdown();

		// A third manager: the same settle is never announced again.
		const third = manager(file, host, agentDir);
		third.start();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(third.completions().length, 0);
		assert.ok((await third.list()).some((a) => a.id === "ag_01" && a.status !== "restored"));
		// A steer after the reattach reaches it once.
		await third.call("agent_steer", { id: "ag_01", message: "again" });
		assert.equal(host.get(chatId).sends.filter((s) => s.text === "again").length, 1);
		await third.shutdown();
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a worker killed by its parent is stopped; one that ended while away stays listed restored", async () => {
	const agentDir = tmpAgentDir();
	try {
		const host = new FakeWorkerHost();
		const file = sessionFile();
		const first = manager(file, host, agentDir);
		first.start();
		await first.call("agent_spawn", { agents: [{ prompt: "a", name: "a" }, { prompt: "b", name: "b" }] });
		await until(() => host.starts.length === 2, "the starts");
		await first.call("agent_kill", { id: "ag_01" });
		assert.equal(host.get("ag_01").stops.length, 1);
		await until(() => file.entries.some((e) => e.data?.workerId === "ag_02" && e.data.ref), "ag_02's ref");
		await first.shutdown();
		host.end(host.get("ag_02").ref.chatId, { cause: "killed" });
		const second = manager(file, host, agentDir);
		second.start();
		await new Promise((r) => setTimeout(r, 100));
		const b = (await second.list()).find((a) => a.id === "ag_02");
		assert.equal(b?.status, "restored");
		await second.shutdown();
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
