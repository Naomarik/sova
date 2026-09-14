import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerSubagents, boundedText, installedPackageDir } from "./index.ts";

function harness() {
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const workers: any[] = [];
	const notices: any[] = [];
	const messages: any[] = [];
	const updates: any[] = [];
	const ctx: any = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined as string | undefined },
		modelRegistry: {
			find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined),
		},
		ui: { setStatus() {}, notify: (...a: any[]) => notices.push(a) },
	};
	registerSubagents(
		{
			registerTool: (t: any) => tools.set(t.name, t),
			on: (e: string, f: any) => events.set(e, f),
			registerCommand() {},
			registerShortcut() {},
			appendEntry() {},
			getActiveTools: () => ["read", "bash", "agent_spawn"],
			sendMessage: (...m: any[]) => messages.push(m),
		} as any,
		(options, handlers) => {
			const worker: any = {
				...options,
				wake: options.wake ?? true,
				extensions: options.extensions ?? [],
				forked: Boolean(options.forkSession),
				status: "running",
				error: undefined,
				transcript: [],
				usage: { input: 0, output: 0, turns: 0 },
				steerCount: 0,
				isFinished() {
					return ["killed", "done", "error"].includes(this.status);
				},
				isSettled() {
					return this.isFinished() || this.status === "waiting";
				},
				finalOutput() {
					return this.output ?? "";
				},
				async steer() {
					this.steerCount++;
					this.status = "running";
					return { ok: true };
				},
				async kill() {
					await new Promise((r) => setTimeout(r, 5));
					this.status = "killed";
				},
				async dispose() {
					await this.kill();
					this.disposed = true;
				},
				settle(error?: string, status = "waiting") {
					this.status = status;
					this.error = error;
					handlers.onSettled(this);
				},
			};
			workers.push(worker);
			return worker;
		},
	);
	return {
		workers,
		ctx,
		notices,
		messages,
		updates,
		tools,
		call: (name: string, params: any = {}, signal?: AbortSignal) =>
			tools.get(name).execute("test", params, signal, (partial: any) => updates.push(partial), ctx),
		start: () => events.get("session_start")({}, ctx),
		close: () => events.get("session_shutdown")({}, ctx),
	};
}

test("spawn is non-blocking and inherits current parent model and effort", async () => {
	const h = harness();
	try {
		const r = await h.call("agent_spawn", { prompt: "task" });
		assert.equal(h.workers[0].status, "running");
		assert.equal(h.workers[0].model, "test/model");
		assert.equal(h.workers[0].effort, "high");
		assert.deepEqual(h.workers[0].tools, ["read", "bash"]);
		assert.equal(r.details.spawned[0].id, "ag_01");
	} finally {
		await h.close();
	}
});

test("batch validates before any process starts", async () => {
	const h = harness();
	try {
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "valid" }, { prompt: "bad", tools: ["agent_spawn"] }] }),
			/built-in/,
		);
		assert.equal(h.workers.length, 0);
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "valid" }, { prompt: "bad", model: "missing/model" }] }),
			/Unknown model/,
		);
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("empty allowlist remains empty and relative cwd resolves against parent", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task", tools: [], cwd: "." });
		assert.deepEqual(h.workers[0].tools, []);
		assert.equal(h.workers[0].cwd, path.resolve(h.ctx.cwd));
	} finally {
		await h.close();
	}
});

test("reject ambiguous spawn modes, fractions, missing definitions and blank tasks", async () => {
	const h = harness();
	try {
		for (const params of [
			{},
			{ prompt: "x", agents: [{ prompt: "x" }] },
			{ prompt: "x", count: 1.5 },
			{ prompt: "x", count: 9 },
			{ prompt: " " },
			{ agents: [{ prompt: "x", agentType: "../outside" }] },
			{ agents: [{ prompt: "x", agentType: "definitely-does-not-exist-734892" }] },
			{ agents: [{ prompt: "x" }], model: "test/model" },
		]) {
			await assert.rejects(h.call("agent_spawn", params));
		}
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("live cap includes waiting workers", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x", count: 8 });
		await h.call("agent_spawn", { prompt: "x", count: 4 });
		h.workers.forEach((w) => w.settle());
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /cap/);
	} finally {
		await h.close();
	}
});

test("agent IDs win over names; duplicate names require IDs", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", {
			agents: [
				{ prompt: "x", name: "ag_02" },
				{ prompt: "y", name: "same" },
				{ prompt: "z", name: "same" },
			],
		});
		await h.call("agent_steer", { id: "ag_02", message: "new" });
		assert.equal(h.workers[0].steerCount, 0);
		assert.equal(h.workers[1].steerCount, 1);
		await assert.rejects(h.call("agent_transcript", { id: "same" }), /Ambiguous/);
	} finally {
		await h.close();
	}
});

test("wait handles success, task failure, and timeout without killing workers", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		let r = await h.call("agent_wait", { ids: ["ag_01"], timeoutSeconds: 0 });
		assert.equal(r.details.timedOut, true);
		assert.equal(h.workers[0].status, "running");
		h.workers[0].settle("provider failed");
		r = await h.call("agent_wait", { ids: ["ag_01"] });
		assert.equal(r.details.timedOut, false);
		assert.match(r.content[0].text, /provider failed/);
		assert.equal(h.notices.at(-1)[1], "warning");
		h.workers[0].settle();
		assert.equal(h.notices.at(-1)[1], "info");
	} finally {
		await h.close();
	}
});

test("abort interrupts wait promptly but does not stop worker", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		const controller = new AbortController();
		const waiting = h.call("agent_wait", { ids: ["ag_01"] }, controller.signal);
		assert.equal(h.updates.length, 1);
		assert.match(h.updates[0].content[0].text, /Waiting: ag_01/);
		controller.abort();
		const r = await waiting;
		assert.equal(r.details.cancelled, true);
		assert.equal(h.workers[0].status, "running");
	} finally {
		await h.close();
	}
});

test("pre-aborted spawn starts no workers", async () => {
	const h = harness();
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "x" }, AbortSignal.abort()));
		assert.equal(h.workers.length, 0);
	} finally {
		await h.close();
	}
});

test("kill selectors are exclusive and termination is awaited", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "x" });
		await assert.rejects(h.call("agent_kill", { id: "ag_01", all: true }), /exactly one/);
		await h.call("agent_kill", { id: "ag_01" });
		assert.equal(h.workers[0].status, "killed");
	} finally {
		await h.close();
	}
});

test("shutdown awaits children and suppresses late notifications", async () => {
	const h = harness();
	await h.call("agent_spawn", { prompt: "x" });
	await h.close();
	assert.equal(h.workers[0].disposed, true);
	h.workers[0].settle();
	assert.equal(h.messages.length, 0);
	assert.equal(h.notices.length, 0);
	await assert.rejects(h.call("agent_spawn", { prompt: "x" }), /shutting down/);
});

test("reload does not reuse IDs from this version or older tool results", async () => {
	const h = harness();
	try {
		h.ctx.sessionManager.getEntries = () => [
			{ type: "custom", customType: "subagents-counters-v2", data: { agentCounter: 5, groupCounter: 2 } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent_spawn",
					details: { groupId: "run_04", spawned: [{ id: "ag_07" }] },
				},
			},
		];
		await h.start();
		const r = await h.call("agent_spawn", { prompt: "x" });
		assert.equal(r.details.groupId, "run_05");
		assert.equal(h.workers[0].id, "ag_08");
	} finally {
		await h.close();
	}
});

test("large output is truncated with a private complete snapshot", () => {
	const original = "🌍".repeat(20000);
	const output = boundedText(original);
	const match = output.match(/Full snapshot: (.+)\]/);
	assert.ok(match);
	try {
		assert.equal(fs.readFileSync(match[1], "utf8"), original);
		assert.equal(fs.statSync(match[1]).mode & 0o777, 0o600);
		assert.ok(Buffer.byteLength(output) < 52000);
	} finally {
		fs.rmSync(path.dirname(match[1]), { recursive: true });
	}
});

test("a settled worker wakes an idle parent by default; wake:false and kills only queue", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { agents: [{ prompt: "a" }, { prompt: "b", wake: false }, { prompt: "c" }] });
		assert.equal(h.workers[0].wake, true);
		assert.equal(h.workers[1].wake, false);
		h.workers[0].settle();
		h.workers[1].settle();
		h.workers[2].settle("stopped", "killed");
		assert.equal(h.messages.length, 3);
		assert.deepEqual(
			h.messages.map((m) => m[1]),
			[
				{ deliverAs: "followUp", triggerTurn: true },
				{ deliverAs: "followUp", triggerTurn: false },
				{ deliverAs: "followUp", triggerTurn: false },
			],
		);
		assert.equal(h.messages[0][0].customType, "subagent-complete");
	} finally {
		await h.close();
	}
});

test("fork needs a persisted parent session and passes its file to the child", async () => {
	const h = harness();
	try {
		await assert.rejects(h.call("agent_spawn", { prompt: "task", fork: true }), /persisted parent session/);
		assert.equal(h.workers.length, 0);
		const dir = fs.mkdtempSync(path.join(process.cwd(), ".fork-test-"));
		const file = path.join(dir, "session.jsonl");
		try {
			fs.writeFileSync(file, "{}\n");
			h.ctx.sessionManager.getSessionFile = () => file;
			const r = await h.call("agent_spawn", { prompt: "task", fork: true });
			assert.equal(h.workers[0].forkSession, file);
			assert.equal(h.workers[0].forked, true);
			assert.match(r.content[0].text, /forked/);
			await h.call("agent_spawn", { prompt: "fresh" });
			assert.equal(h.workers[1].forkSession, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		await h.close();
	}
});

test("child extensions: remote sources pass, missing paths fail, this extension is refused", async () => {
	const h = harness();
	try {
		await h.call("agent_spawn", { prompt: "task", extensions: ["npm:definitely-not-installed-xyz", "git:github.com/x/y"] });
		assert.deepEqual(h.workers[0].extensions, ["npm:definitely-not-installed-xyz", "git:github.com/x/y"]);
		await assert.rejects(
			h.call("agent_spawn", { prompt: "task", extensions: ["./definitely-missing-extension.ts"] }),
			/not found/,
		);
		const self = path.join(path.dirname(new URL(import.meta.url).pathname), "index.ts");
		await assert.rejects(h.call("agent_spawn", { prompt: "task", extensions: [self] }), /do not nest/);
		await assert.rejects(
			h.call("agent_spawn", { prompt: "task", extensions: [path.dirname(self)] }),
			/do not nest/,
		);
		assert.equal(h.workers.length, 1);
		// Whole-batch validation: a bad source in the second spec starts nothing.
		await assert.rejects(
			h.call("agent_spawn", { agents: [{ prompt: "ok" }, { prompt: "bad", extensions: [self] }] }),
			/do not nest/,
		);
		assert.equal(h.workers.length, 1);
	} finally {
		await h.close();
	}
});

test("installed npm and git sources map to Pi's user-scope directories; others pass through", () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), ".pkg-test-"));
	try {
		fs.mkdirSync(path.join(dir, "npm", "node_modules", "@scope", "name"), { recursive: true });
		fs.mkdirSync(path.join(dir, "npm", "node_modules", "plain"), { recursive: true });
		fs.mkdirSync(path.join(dir, "git", "github.com", "owner", "repo"), { recursive: true });
		assert.equal(installedPackageDir("npm:plain", dir), path.join(dir, "npm", "node_modules", "plain"));
		assert.equal(installedPackageDir("npm:plain@1.2.3", dir), path.join(dir, "npm", "node_modules", "plain"));
		assert.equal(installedPackageDir("npm:@scope/name@2", dir), path.join(dir, "npm", "node_modules", "@scope", "name"));
		assert.equal(installedPackageDir("git:github.com/owner/repo", dir), path.join(dir, "git", "github.com", "owner", "repo"));
		assert.equal(installedPackageDir("git:github.com/owner/repo.git", dir), path.join(dir, "git", "github.com", "owner", "repo"));
		assert.equal(installedPackageDir("npm:missing", dir), undefined);
		assert.equal(installedPackageDir("git:github.com/owner/other", dir), undefined);
		assert.equal(installedPackageDir("npm:../escape", dir), undefined);
		assert.equal(installedPackageDir("git:github.com/../x", dir), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
