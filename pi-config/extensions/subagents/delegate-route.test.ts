/**
 * Delegate starts no worker of its own (mode/delegate.ts is routing preferences only): its
 * orchestrator calls agent_spawn with a profile's backend, model and effort, exactly as written.
 * Such a spawn is an ordinary worker chat on the session's worker host (al_3 stage 4 H3). Over the
 * in-memory FakeWorkerHost; no process, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { delegateDefaults, type WorkerChoice } from "../mode/delegate.ts";
import { registerSubagents } from "./index.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";

const NO_POLICY_FILE = path.join(os.tmpdir(), "subagents-tests-absent-policy.json");

function manager(host: FakeWorkerHost, agentDir: string) {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => void listeners.get(name)?.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(listeners.get(name) ?? [])]) handler(data);
		},
	};
	host.announceOn(bus);
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const entries: any[] = [];
	const ctx: any = {
		cwd: agentDir, mode: "tui", hasUI: false, thinkingLevel: "medium", isIdle: () => true,
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
			sendMessage() {},
		} as any,
		undefined,
		{ policyFile: NO_POLICY_FILE, agentDir, mailboxPollMs: 10, setTimer: (fn, ms) => setTimeout(fn, ms) },
	);
	return {
		start: () => events.get("session_start")({}, ctx),
		shutdown: () => events.get("session_shutdown")({}, ctx),
		/** The spawn Delegate's prompt asks for: the profile's backend, model and effort, as written. */
		spawn: (choice: WorkerChoice) => tools.get("agent_spawn").execute("t", { prompt: "routine work", backend: choice.backend, model: choice.model, effort: choice.effort, wake: false }, undefined, () => {}, ctx),
	};
}

const until = async (check: () => boolean, what: string, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

for (const [label, choice] of [
	["the default routine profile (Claude Code)", delegateDefaults().profiles.routine.primary!],
	["a pi profile", { backend: "pi", model: "test/model", effort: "high" } as WorkerChoice],
] as const) {
	test(`a Delegate-routed agent_spawn (${label}) starts an ordinary worker chat on the worker host, on the profile's model and effort`, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-delegate-"));
		try {
			const host = new FakeWorkerHost();
			const m = manager(host, agentDir);
			m.start();
			await m.spawn(choice);
			await until(() => host.starts.length === 1, "the start");
			const { spec, key } = host.starts[0]!;
			assert.equal(spec.kind, "worker", "the normal worker path: no start path of Delegate's own");
			assert.match(key, /^owner:ag_01:/);
			assert.equal(spec.thinking, choice.effort);
			if (choice.backend === "pi") assert.equal(spec.model, choice.model);
			else assert.equal(spec.model, `claude-code-cli/${choice.model}`, "a Claude Code worker is a pi worker on the claude-code-cli provider");
			await m.shutdown();
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
}
