/**
 * The background fork (background.ts) against a fake worker host: the loadout it starts, extension
 * order, settle, stop, detach and reattach. Run with the subagents runner (`node tests/run.mjs`).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_FORK_ENV, decodeForkPoint } from "../../claude-code/provider/fork-point.ts";
import {
	NO_WORKER_HOST,
	WORKER_HOST_DISCOVER_EVENT,
	WORKER_HOST_EVENT,
	type WorkerCursor,
	type WorkerFeedFrame,
	type WorkerHost,
	type WorkerRef,
	type WorkerStart,
	type WorkerState,
} from "../worker-host.ts";
import {
	CHILD_EXTENSION,
	claudeForkPointFor,
	forkResultFromFile,
	reattachBackgroundForks,
	startBackgroundFork,
	workerHostOf,
	WORKER_MARK_EXTENSION,
	type BackgroundForkResult,
	type BackgroundForkSpec,
} from "./background.ts";
import { decodePolicy, FORK_POLICY_ENV } from "./mirror.ts";

/** An in-memory worker host: records starts and stops, and lets a test push feed frames. */
class FakeHost implements WorkerHost {
	starts: WorkerStart[] = [];
	stops: { chatId: string; reason: string }[] = [];
	watchers = new Map<string, (f: WorkerFeedFrame) => void>();
	refs: WorkerRef[] = [];
	refuse?: string;
	private seq = 0;

	refFor(workerId: string, kind: WorkerRef["kind"] = "explain", extra: Partial<WorkerRef> = {}): WorkerRef {
		return { chatId: `chat-${workerId}`, sessionId: `sid-${workerId}`, sessionFile: `/sessions/${workerId}.jsonl`, workerId, kind, placement: "unit", pid: 77, state: "open", ...extra };
	}
	async start(req: WorkerStart): Promise<WorkerRef> {
		this.starts.push(req);
		if (this.refuse) throw new Error(this.refuse);
		const ref = this.refFor(req.spec.parent.workerId, req.spec.kind);
		this.refs.push(ref);
		return ref;
	}
	async send(): Promise<{ queued: boolean }> {
		return { queued: false };
	}
	async abort(): Promise<void> {}
	async stop(chatId: string, reason: string): Promise<void> {
		this.stops.push({ chatId, reason });
		this.refs = this.refs.filter((ref) => ref.chatId !== chatId);
	}
	watch(chatId: string, _cursor: WorkerCursor | null, fn: (f: WorkerFeedFrame) => void): () => void {
		this.watchers.set(chatId, fn);
		return () => {
			if (this.watchers.get(chatId) === fn) this.watchers.delete(chatId);
		};
	}
	async list(): Promise<WorkerRef[]> {
		return [...this.refs];
	}
	cursor(): WorkerCursor {
		return { proc: "p1", seq: ++this.seq };
	}
	event(chatId: string, event: Record<string, unknown>): void {
		this.watchers.get(chatId)?.({ t: "event", cursor: this.cursor(), event });
	}
	state(chatId: string, state: Partial<WorkerState>): void {
		this.watchers.get(chatId)?.({
			t: "state",
			cursor: this.cursor(),
			state: { status: "running", sessionId: "", sessionFile: "", pid: 77, model: null, thinking: null, lastSettled: null, queue: { steering: [], followUp: [] }, ...state },
		});
	}
	ended(chatId: string, frame: Omit<Extract<WorkerFeedFrame, { t: "ended" }>, "t">): void {
		this.watchers.get(chatId)?.({ t: "ended", ...frame });
	}
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function spec(host: WorkerHost | undefined, extra: Partial<BackgroundForkSpec> = {}): BackgroundForkSpec {
	return {
		host,
		kind: "explain",
		parent: { sessionId: "parent-sid", path: "/sessions/parent.jsonl" },
		id: "vector-clocks-1",
		name: "explain",
		task: "write the page",
		cwd: "/repo",
		sessionDir: "/agent/explanations/.forks/vector-clocks-1",
		policy: { label: "The /explain worker", web: true, writeDir: "/agent/explanations/vector-clocks-1" },
		...extra,
	};
}

test("a background fork starts one hidden chat that forks the copy with the parent's tools, the marker first and child.ts last, and reports its outcome once", async () => {
	const host = new FakeHost();
	const settles: BackgroundForkResult[] = [];
	const handle = startBackgroundFork(spec(host, { model: "zai/glm-5.3", effort: "high", forkSession: "/agent/explanations/.forks/vector-clocks-1.jsonl" }), { onSettled: (r) => settles.push(r) });
	await flush();

	assert.equal(host.starts.length, 1);
	const start = host.starts[0]!;
	assert.equal(start.key, "parent-sid:explain-vector-clocks-1", "one key per parent and run: a re-sent start opens no second chat");
	assert.deepEqual(start.spec.parent, { sessionId: "parent-sid", path: "/sessions/parent.jsonl", workerId: "vector-clocks-1" });
	assert.equal(start.spec.kind, "explain");
	assert.equal(start.spec.builtins, null, "no tool restriction: child.ts declares the parent's tools, so the prefix stays cached");
	assert.deepEqual(start.spec.extensions, [WORKER_MARK_EXTENSION, CHILD_EXTENSION], "the marker first, child.ts last");
	assert.deepEqual(decodePolicy(start.spec.env[FORK_POLICY_ENV]), { label: "The /explain worker", web: true, writeDir: "/agent/explanations/vector-clocks-1" }, "the policy travels to child.ts");
	assert.equal(start.spec.env[CLAUDE_FORK_ENV], undefined, "no Claude fork point for a pi model");
	assert.equal(start.spec.model, "zai/glm-5.3");
	assert.equal(start.spec.thinking, "high");
	assert.equal(start.spec.appendSystemPrompt, null);
	assert.equal(start.spec.lowered, true);
	assert.deepEqual(start.session, { fork: { from: "/agent/explanations/.forks/vector-clocks-1.jsonl", dir: "/agent/explanations/.forks/vector-clocks-1" } });
	assert.equal(start.task, "write the page");
	assert.equal(handle.sessionId, "sid-vector-clocks-1");
	assert.equal(handle.sessionFile, "/sessions/vector-clocks-1.jsonl");

	const chat = "chat-vector-clocks-1";
	host.event(chat, { type: "agent_start" });
	host.event(chat, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "wrote the page" }], provider: "zai", model: "glm-5.4", stopReason: "stop" } });
	host.event(chat, { type: "agent_settled" });
	assert.equal(settles.length, 1);
	assert.deepEqual(settles[0], { outcome: "success", finalOutput: "wrote the page", model: "zai/glm-5.4" });
	assert.equal(host.watchers.size, 0, "a settled fork is no longer watched");

	await handle.stop();
	assert.deepEqual(host.stops, [{ chatId: chat, reason: "explain stopped" }], "stop ends the fork's chat");
	assert.equal(settles.length, 1, "stopping after a recorded run does not settle twice");
});

test("an unforked child starts a new session; web search loads after the marker and before child.ts", async () => {
	const host = new FakeHost();
	startBackgroundFork(spec(host, { extensions: ["/agent/npm/node_modules/pi-web-access"] }), { onSettled: () => {} });
	await flush();
	assert.deepEqual(host.starts[0]!.session, { new: { dir: "/agent/explanations/.forks/vector-clocks-1" } });
	assert.deepEqual(host.starts[0]!.spec.extensions, [WORKER_MARK_EXTENSION, "/agent/npm/node_modules/pi-web-access", CHILD_EXTENSION]);
	assert.ok(WORKER_MARK_EXTENSION.endsWith(join("subagents", "worker-mark.ts")));
	assert.ok(existsSync(WORKER_MARK_EXTENSION), "resolved from background.ts's own location");
	assert.ok(existsSync(CHILD_EXTENSION));
});

test("a claude-code-cli model loads the claude-code extension before child.ts, with its provider flag; the fork point travels only with a fork", async () => {
	const fork = { v: 1 as const, claudeSessionId: "3708bfa3-4e74-5f1f-a32e-cd209e9231e1", messages: 4, prefix: "abc", cwd: "/repo" };
	const host = new FakeHost();
	startBackgroundFork(spec(host, { model: "claude-code-cli/opus[1m]", forkSession: "/tmp/copy.jsonl", claudeFork: fork, extensions: ["/web"] }), { onSettled: () => {} });
	startBackgroundFork(spec(host, { id: "plain", model: "zai/glm-5.3", forkSession: "/tmp/copy.jsonl", extensions: ["/web"] }), { onSettled: () => {} });
	startBackgroundFork(spec(host, { id: "unforked", model: "claude-code-cli/opus", claudeFork: fork }), { onSettled: () => {} });
	await flush();
	const claudeCode = join(realpathSync(fileURLToPath(new URL("../../claude-code", import.meta.url))), "index.ts");
	const [scoped, plain, unforked] = host.starts;
	assert.deepEqual(scoped!.spec.extensions, [WORKER_MARK_EXTENSION, "/web", claudeCode, CHILD_EXTENSION], "the claude-code extension by real path, then child.ts");
	assert.equal(scoped!.spec.flags["claude-code-provider"], true);
	assert.deepEqual(decodeForkPoint(scoped!.spec.env[CLAUDE_FORK_ENV]), fork, "the fork point travels in the environment");
	assert.deepEqual(plain!.spec.extensions, [WORKER_MARK_EXTENSION, "/web", CHILD_EXTENSION]);
	assert.deepEqual(plain!.spec.flags, {});
	assert.equal(unforked!.spec.env[CLAUDE_FORK_ENV], undefined, "an unforked child has no parent conversation to resume");
});

test("claudeForkPointFor: only a claude-code-cli model looks for the parent's live CLI session", () => {
	const fork = { v: 1 as const, claudeSessionId: "3708bfa3-4e74-5f1f-a32e-cd209e9231e1", messages: 4, prefix: "abc", cwd: "/repo" };
	const registry = Symbol.for("sova.claude-code.session-bridge");
	const global = globalThis as unknown as Record<symbol, unknown>;
	const saved = global[registry];
	global[registry] = { bridge: { forkPoint: (id: string) => (id === "parent" ? fork : undefined) } };
	try {
		assert.deepEqual(claudeForkPointFor("claude-code-cli/opus", "parent"), fork);
		assert.equal(claudeForkPointFor("zai/glm-5.3", "parent"), undefined, "a pi model never resumes a Claude session");
		assert.equal(claudeForkPointFor(undefined, "parent"), undefined);
		assert.equal(claudeForkPointFor("claude-code-cli/opus", "other"), undefined);
	} finally {
		if (saved === undefined) delete global[registry];
		else global[registry] = saved;
	}
});

test("no worker host refuses the start at once; a start the host refuses settles as an error", async () => {
	assert.throws(() => startBackgroundFork(spec(undefined), { onSettled: () => {} }), new RegExp(NO_WORKER_HOST));
	const host = new FakeHost();
	host.refuse = "Workers need Bun to run Sova's chat runtime";
	const settles: BackgroundForkResult[] = [];
	startBackgroundFork(spec(host), { onSettled: (r) => settles.push(r) });
	await flush();
	assert.deepEqual(settles, [{ outcome: "error", error: "Workers need Bun to run Sova's chat runtime", finalOutput: "" }]);
});

test("the run's outcome: a failed turn is an error, a successful auto-retry clears it, an aborted turn is aborted", async () => {
	const host = new FakeHost();
	const settles: BackgroundForkResult[] = [];
	startBackgroundFork(spec(host, { id: "a" }), { onSettled: (r) => settles.push(r) });
	startBackgroundFork(spec(host, { id: "b" }), { onSettled: (r) => settles.push(r) });
	startBackgroundFork(spec(host, { id: "c" }), { onSettled: (r) => settles.push(r) });
	await flush();
	host.event("chat-a", { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } });
	host.event("chat-a", { type: "agent_settled" });
	host.event("chat-b", { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" } });
	host.event("chat-b", { type: "auto_retry_end", success: true });
	host.event("chat-b", { type: "agent_settled" });
	host.event("chat-c", { type: "message_end", message: { role: "assistant", content: "half", stopReason: "aborted" } });
	host.event("chat-c", { type: "agent_settled" });
	assert.deepEqual(
		settles.map((r) => [r.outcome, r.error, r.finalOutput]),
		[
			["error", "429", ""],
			["success", undefined, ""],
			["aborted", undefined, "half"],
		],
	);
});

test("the fork's chat ending: a final death settles as an error with its detail, a stop as aborted; idle, reload and a crash resume do not settle", async () => {
	const host = new FakeHost();
	const settles: BackgroundForkResult[] = [];
	startBackgroundFork(spec(host, { id: "d" }), { onSettled: (r) => settles.push(r) });
	startBackgroundFork(spec(host, { id: "k" }), { onSettled: (r) => settles.push(r) });
	await flush();
	host.ended("chat-d", { cause: "idle" });
	host.ended("chat-d", { cause: "reload" });
	host.ended("chat-d", { cause: "died", resuming: true, detail: "exit 1" });
	assert.equal(settles.length, 0);
	host.ended("chat-d", { cause: "died", detail: "This worker's process stopped unexpectedly (exit 1)" });
	host.ended("chat-k", { cause: "killed" });
	assert.deepEqual(
		settles.map((r) => [r.outcome, r.error]),
		[
			["error", "This worker's process stopped unexpectedly (exit 1)"],
			["aborted", undefined],
		],
	);
});

test("stop before the run settles ends its chat and settles it once, as aborted", async () => {
	const host = new FakeHost();
	const settles: BackgroundForkResult[] = [];
	const handle = startBackgroundFork(spec(host), { onSettled: (r) => settles.push(r) });
	await handle.stop();
	host.ended("chat-vector-clocks-1", { cause: "killed" });
	assert.deepEqual(host.stops.map((s) => s.chatId), ["chat-vector-clocks-1"]);
	assert.deepEqual(settles.map((r) => r.outcome), ["aborted"]);
});

test("detach stops watching and leaves the fork running", async () => {
	const host = new FakeHost();
	const settles: BackgroundForkResult[] = [];
	const handle = startBackgroundFork(spec(host), { onSettled: (r) => settles.push(r) });
	await flush();
	handle.detach();
	host.event("chat-vector-clocks-1", { type: "agent_settled" });
	assert.equal(settles.length, 0);
	assert.equal(host.stops.length, 0);
	assert.equal(host.refs.length, 1);
});

test("reattach watches the parent's running forks of its kind again, stops the ones no run claims, and settles a fork that finished meanwhile from its file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bgfork-"));
	try {
		const file = join(dir, "done.jsonl");
		writeFileSync(
			file,
			[
				{ type: "session", id: "s" },
				{ type: "message", id: "1", message: { role: "user", content: "write" } },
				{ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "the page is written" }], provider: "zai", model: "glm-5.3" } },
				{ type: "message", id: "3", message: { role: "assistant", content: [], provider: "zai", model: "glm-5.3" } },
			]
				.map((e) => JSON.stringify(e))
				.join("\n"),
		);
		const host = new FakeHost();
		host.refs = [
			host.refFor("live"),
			host.refFor("done", "explain", { sessionFile: file, state: "idle" }),
			host.refFor("orphan"),
			host.refFor("other-kind", "handoff"),
			host.refFor("gone", "explain", { state: "ended" }),
		];
		const settles = new Map<string, BackgroundForkResult>();
		const handles = await reattachBackgroundForks(host, "explain", "explain", (id) => (id === "live" || id === "done" ? { onSettled: (r) => settles.set(id, r) } : undefined));
		assert.deepEqual([...handles.keys()].sort(), ["done", "live"]);
		assert.deepEqual(host.stops, [{ chatId: "chat-orphan", reason: "no explain run records it" }], "a fork no run claims is stopped; another kind and an ended chat are left alone");

		host.state("chat-done", { status: "idle", sessionFile: file, lastSettled: { key: "k:task", outcome: "success" } });
		assert.deepEqual(settles.get("done"), { outcome: "success", finalOutput: "the page is written", model: "zai/glm-5.3" });

		host.state("chat-live", { status: "running" });
		assert.equal(settles.has("live"), false);
		host.event("chat-live", { type: "message_end", message: { role: "assistant", content: "done", stopReason: "stop" } });
		host.event("chat-live", { type: "agent_settled" });
		assert.equal(settles.get("live")?.outcome, "success");
		assert.equal(settles.get("live")?.finalOutput, "done");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("forkResultFromFile: an error run carries the host's error, a missing file gives no output", () => {
	assert.deepEqual(forkResultFromFile("/nonexistent/x.jsonl", { key: "k", outcome: "error", error: "boom" }), { outcome: "error", error: "boom", finalOutput: "" });
	assert.equal(forkResultFromFile("/nonexistent/x.jsonl", null).outcome, "error");
});

test("workerHostOf takes the host Sova announces on the session's events, and asks for it once", () => {
	const handlers = new Map<string, (data: unknown) => void>();
	const emitted: string[] = [];
	const host = new FakeHost();
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			handlers.set(channel, handler);
			return () => handlers.delete(channel);
		},
		emit: (channel: string) => {
			emitted.push(channel);
			if (channel === WORKER_HOST_DISCOVER_EVENT) handlers.get(WORKER_HOST_EVENT)?.({ version: 1, host });
		},
	};
	const found = workerHostOf(events);
	assert.deepEqual(emitted, [WORKER_HOST_DISCOVER_EVENT]);
	assert.equal(found.current(), host);
	handlers.get(WORKER_HOST_EVENT)?.({ version: 2, host: {} });
	assert.equal(found.current(), host, "an announcement of another version is ignored");
	found.dispose();
	assert.equal(handlers.size, 0);
});
