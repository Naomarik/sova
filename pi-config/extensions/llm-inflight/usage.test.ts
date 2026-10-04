// The usage ledger's pi side, against pi's real ModelRuntime (tests/run.mjs aliases the pi
// packages): one record per call at its end, owned per attribution.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { noteUsageSession, registerUsageSession, resolveUsageAttribution, setUsageSessionPurpose, withUsageContext, withUsagePurpose } from "./attribution.ts";
import { createClaudeRequestObserver } from "./claude.ts";
import { recordClaudeEnvelope } from "./record.ts";
import { instrumentModelRuntime } from "./runtime.ts";
import { producerId } from "./tracker.ts";
import { parseUsageLine, usageFilePath, type UsageRecord } from "./usage-record.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-usage-"));
const context = { messages: [{ role: "user" as const, content: "x", timestamp: 0 }] };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fresh agent dir for the records; returns a reader of this process's records. */
function ledger() {
	const dir = tmp();
	process.env.PI_CODING_AGENT_DIR = dir;
	return (): UsageRecord[] => {
		try {
			return fs.readFileSync(usageFilePath(dir, Date.now(), producerId()), "utf8").split("\n").filter(Boolean).map((l) => parseUsageLine(l)!);
		} catch {
			return [];
		}
	};
}

type Reply = { usage?: Partial<AssistantMessage["usage"]>; stopReason?: AssistantMessage["stopReason"]; provider?: string; wait?: Promise<void>; timestamp?: number };

async function runtimeWith(replies: (options: any) => Reply) {
	const dir = tmp();
	const rt = await (ModelRuntime as any).create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, modelsStorePath: path.join(dir, "ms.json") });
	const streamSimple = (model: any, _ctx: any, options: any) => {
		const r = replies(options);
		const s = createAssistantMessageEventStream();
		void (async () => {
			await options?.onPayload?.({}, model);
			await r.wait;
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: "hi" }], api: model.api, provider: r.provider ?? model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...r.usage },
				stopReason: r.stopReason ?? "stop", timestamp: r.timestamp ?? Date.now(),
			};
			if (message.stopReason === "error") s.push({ type: "error", reason: "error", error: message });
			else s.push({ type: "done", reason: "stop", message } as any);
			s.end();
		})();
		return s;
	};
	rt.registerProvider("fakeprov", {
		api: "fake-api", apiKey: "unused", baseUrl: "http://127.0.0.1:9", streamSimple,
		models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	assert.equal(instrumentModelRuntime(rt), "instrumented");
	return { rt, model: rt.getModel("fakeprov", "m1") };
}

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test("a registered session's turn: one record keyed by its session and the reply's stream-start time", async () => {
	const read = ledger();
	const done = registerUsageSession("sess-main", { kind: "main", cwd: "/w/main", parent: null });
	const { rt, model } = await runtimeWith(() => ({ usage: { ...tokens(120, 30, 1000, 50), cacheWrite1h: 50 }, timestamp: 1_791_000_000_000 }));
	await rt.streamSimple(model, context, { sessionId: "sess-main" }).result();
	await tick();
	done();
	const [r, ...more] = read();
	assert.deepEqual(more, []);
	assert.deepEqual(
		{ ...r, ts: 0, device: null },
		{
			v: 1, key: "pi:sess-main:1791000000000:fakeprov/m1", ts: 0, device: null, producer: producerId(), src: "pi", provider: "fakeprov", model: "m1",
			input: 120, output: 30, cacheRead: 1000, cacheWrite: 50, cacheWrite1h: 50, owner: "sess-main", parent: null, kind: "main", cwd: "/w/main", stop: "stop",
		},
	);
});

test("b2: concurrent side calls with fresh routing ids keep their caller's owner, cwd and purpose, whatever order they end in", async () => {
	const read = ledger();
	const a = registerUsageSession("sess-A", { kind: "main", cwd: "/w/a", parent: null });
	const b = registerUsageSession("sess-B", { kind: "main", cwd: "/w/b", parent: null });
	const gates: (() => void)[] = [];
	const { rt, model } = await runtimeWith(() => ({ usage: tokens(10 + gates.length, 1), wait: new Promise<void>((r) => gates.push(r)) }));
	const one = withUsageContext({ owner: "sess-A", cwd: "/w/a", purpose: "outline", kind: "oneshot" }, () => rt.completeSimple(model, context, { sessionId: crypto.randomUUID() }));
	const two = withUsageContext({ owner: "sess-B", cwd: "/w/b-sub", purpose: "title", kind: "oneshot" }, () => rt.completeSimple(model, context, { sessionId: crypto.randomUUID() }));
	for (let i = 0; i < 100 && gates.length < 2; i++) await tick(2);
	gates[1]!();
	await two;
	gates[0]!();
	await one;
	await tick();
	a();
	b();
	assert.deepEqual(
		read().map((r) => [r.input, r.owner, r.cwd, r.purpose, r.kind, r.key.startsWith(`${producerId()}:`)]),
		[
			[11, "sess-B", "/w/b-sub", "title", "oneshot", true],
			[10, "sess-A", "/w/a", "outline", "oneshot", true],
		],
	);
});

test("no context: an unregistered routing id falls back to the process's only session (a one-shot), and with two sessions to no one", async () => {
	const read = ledger();
	const { rt, model } = await runtimeWith(() => ({ usage: tokens(5, 5) }));
	const only = registerUsageSession("sess-tui", { kind: "main", cwd: "/w/tui", parent: null });
	await rt.completeSimple(model, context, { sessionId: "fresh-1" });
	const second = registerUsageSession("sess-other", { kind: "main", parent: null });
	await rt.completeSimple(model, context);
	// A side call Sova makes for itself never falls back, even with one session open.
	second();
	await withUsagePurpose("decide", () => rt.completeSimple(model, context));
	only();
	await tick();
	assert.deepEqual(
		read().map((r) => [r.owner, r.kind, r.cwd ?? null, r.purpose ?? null]),
		[
			["sess-tui", "oneshot", "/w/tui", null],
			[null, "oneshot", null, null],
			[null, "oneshot", null, "decide"],
		],
	);
});

test("a cache warm (one token asked) keeps its session's kind with purpose cache-warm; a worker's call names its parent", async () => {
	const read = ledger();
	const w = registerUsageSession("sess-w", { kind: "worker", cwd: "/w/x", parent: "sess-parent", worker: "ag_03" });
	const { rt, model } = await runtimeWith(() => ({ usage: tokens(0, 1, 9000) }));
	await rt.streamSimple(model, context, { sessionId: "sess-w", maxTokens: 1 }).result();
	await withUsageContext({ purpose: "compaction" }, () => rt.streamSimple(model, context, { sessionId: "sess-w" }).result());
	await tick();
	w();
	assert.deepEqual(
		read().map((r) => [r.owner, r.kind, r.purpose, r.parent, r.worker]),
		[
			["sess-w", "worker", "cache-warm", "sess-parent", "ag_03"],
			["sess-w", "worker", "compaction", "sess-parent", "ag_03"],
		],
	);
});

test("a host-marked turn (a baton's wrap-up) keeps the session's kind with its purpose, until cleared; an overseer note gives its kind", async () => {
	const read = ledger();
	const done = registerUsageSession("sess-baton", { kind: "main", cwd: "/w/baton", parent: null });
	const ov = registerUsageSession("sess-ov", { kind: "main", parent: null });
	noteUsageSession("sess-ov", { kind: "overseer" });
	const { rt, model } = await runtimeWith(() => ({ usage: tokens(1, 1) }));
	setUsageSessionPurpose("sess-baton", "wrapup");
	await rt.streamSimple(model, context, { sessionId: "sess-baton" }).result();
	setUsageSessionPurpose("sess-baton", undefined);
	await rt.streamSimple(model, context, { sessionId: "sess-baton" }).result();
	await rt.streamSimple(model, context, { sessionId: "sess-ov" }).result();
	await tick();
	done();
	ov();
	noteUsageSession("sess-ov", undefined);
	assert.deepEqual(
		read().map((r) => [r.owner, r.kind, r.purpose ?? null]),
		[
			["sess-baton", "main", "wrapup"],
			["sess-baton", "main", null],
			["sess-ov", "overseer", null],
		],
	);
});

test("every attempt with tokens is recorded (an error reply too); a reply without tokens writes nothing", async () => {
	const read = ledger();
	let n = 0;
	const { rt, model } = await runtimeWith(() => (n++ === 0 ? { usage: tokens(40, 0), stopReason: "error" } : { usage: tokens(0, 0) }));
	await rt.streamSimple(model, context).result();
	await rt.streamSimple(model, context).result();
	await tick();
	assert.deepEqual(read().map((r) => [r.input, r.stop]), [[40, "error"]]);
});

test("claude-code-cli: once a bridge observer records it, the runtime leaves its replies out (never twice)", async () => {
	const read = ledger();
	const done = registerUsageSession("sess-cc", { kind: "main", cwd: "/w/cc", parent: null });
	const { rt, model } = await runtimeWith(() => ({ usage: tokens(3, 3), provider: "claude-code-cli" }));
	await rt.streamSimple(model, context, { sessionId: "sess-cc" }).result();
	await tick();
	assert.equal(read().length, 1, "no bridge yet: the runtime records it");
	const o = createClaudeRequestObserver({ countRequests: false, usage: { bridge: true, model: "opus[1m]", fresh: true, baselineDir: tmp(), who: () => resolveUsageAttribution("sess-cc") } });
	o.frame({ type: "stream_event", session_id: "cc-1", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_A", model: "claude-opus-5-5", usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 100 } } } });
	o.frame({ type: "stream_event", session_id: "cc-1", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 12, cache_read_input_tokens: 100 } } });
	o.frame({ type: "result", subtype: "success", session_id: "cc-1", modelUsage: { "claude-opus-5-5": { inputTokens: 9, outputTokens: 12, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 } } });
	o.close();
	await rt.streamSimple(model, context, { sessionId: "sess-cc" }).result();
	await tick();
	done();
	const recs = read();
	assert.deepEqual(
		recs.slice(1).map((r) => [r.key, r.src, r.provider, r.model, r.responseModel, r.input, r.output, r.cacheRead, r.owner, r.kind, r.cwd]),
		[
			["cc:msg_A", "claude", "claude-code-cli", "opus[1m]", "claude-opus-5-5", 7, 12, 100, "sess-cc", "main", "/w/cc"],
			[`ccr:cc-1:121:claude-opus-5-5`, "claude-residual", "claude-code-cli", "opus[1m]", "claude-opus-5-5", 2, 0, 0, "sess-cc", "main", "/w/cc"],
		],
		"the runtime's second reply is not recorded",
	);
});

test("a deferred request: the handle records nothing, its final reply once", async () => {
	const read = ledger();
	const faux = fauxProvider({ deferred: { pendingFetches: 0 } } as any);
	const dir = tmp();
	const rt = await (ModelRuntime as any).create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, modelsStorePath: path.join(dir, "ms.json") });
	rt.registerNativeProvider(faux.provider);
	instrumentModelRuntime(rt);
	const model = faux.models[0];
	faux.setResponses([fauxAssistantMessage("later")]);
	const submitted = await rt.completeSimple(model, context, { deferred: true });
	assert.equal(submitted.stopReason, "deferred");
	await tick();
	const before = read().length;
	const final = await rt.fetchDeferred(model, submitted.deferred);
	assert.equal(final.stopReason, "stop");
	await tick();
	const after = read();
	const finalTokens = final.usage.input + final.usage.output + final.usage.cacheRead + final.usage.cacheWrite;
	assert.equal(after.length - before, finalTokens > 0 ? 1 : 0);
	assert.equal(before, 0, "the handle itself is never recorded");
});

test("a `claude -p` envelope: one record per model, keyed by its session; garbage records nothing", () => {
	const read = ledger();
	const who = { owner: "sess-o", parent: null, kind: "oneshot" as const, purpose: "outline", cwd: "/w/o", routed: false };
	assert.equal(recordClaudeEnvelope("not json", who), 0);
	const env = { type: "result", is_error: true, subtype: "error_max_budget_usd", session_id: "e-9", modelUsage: { "claude-haiku-4-5": { inputTokens: 30, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
	assert.equal(recordClaudeEnvelope(JSON.stringify(env), who, "haiku"), 1, "a failed run spent its tokens too");
	assert.deepEqual(read().map((r) => [r.key, r.model, r.responseModel, r.input, r.output, r.purpose, r.owner, r.stop]), [["cp:e-9:claude-haiku-4-5", "haiku", "claude-haiku-4-5", 30, 2, "outline", "sess-o", "error_max_budget_usd"]]);
});
