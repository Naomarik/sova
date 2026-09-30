import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { RATE_LIMIT_RETRIES, acquireSlot, effectiveLimit, holdsSlot, limitsInEffect, registerSession, unregisterSession, writeProviderLimits, type WaitInfo } from "./gate.ts";
import { gateStreamSimple, type StreamSimple } from "./stream.ts";

const tmpAgent = () => fs.mkdtempSync(path.join(os.tmpdir(), "provider-limits-stream-"));
const slotCount = (dir: string, provider = "zai") => {
	try {
		return fs.readdirSync(path.join(dir, "provider-limits", provider, "slots")).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
};
const model = { id: "glm-5.3", provider: "zai", api: "openai-completions" } as any;
const message = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "zai",
	model: "glm-5.3",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
	...over,
});
/** A scripted provider: each call takes the next script (events pushed after a tick). */
function scripted(scripts: ((signal?: AbortSignal) => AssistantMessageEvent[] | Promise<AssistantMessageEvent[]>)[], seen: { slots: number[] }, dir: string): StreamSimple & { calls: number } {
	const fn = ((_m, _c, options) => {
		const script = scripts[Math.min(fn.calls, scripts.length - 1)];
		fn.calls++;
		seen.slots.push(slotCount(dir));
		const s = createAssistantMessageEventStream();
		void (async () => {
			await new Promise((r) => setTimeout(r, 5));
			for (const e of await script(options?.signal)) s.push(e);
			s.end();
		})();
		return s;
	}) as StreamSimple & { calls: number };
	fn.calls = 0;
	return fn;
}
const ok = (text = "hi"): AssistantMessageEvent[] => [
	{ type: "start", partial: message() },
	{ type: "text_start", contentIndex: 0, partial: message() },
	{ type: "text_delta", contentIndex: 0, delta: text, partial: message() },
	{ type: "done", reason: "stop", message: message({ content: [{ type: "text", text }] }) },
];
const fail = (errorMessage: string): AssistantMessageEvent[] => [{ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage }) }];
const RATE = '429: {"code":"1302","message":"Rate limit reached for requests"}';
const collect = async (s: AsyncIterable<AssistantMessageEvent>) => {
	const out: AssistantMessageEvent[] = [];
	for await (const e of s) out.push(e);
	return out;
};

test("a request holds one slot from send to the end of its stream: done, error or abort", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 2 } });
	const seen = { slots: [] as number[] };
	const inner = scripted([() => ok(), () => fail("500 boom"), (signal) => new Promise((resolve) => signal!.addEventListener("abort", () => resolve([{ type: "error", reason: "aborted", error: message({ stopReason: "aborted" }) }])))], seen, dir);
	const gated = gateStreamSimple(inner, { agentDir: () => dir, retry: true });
	const done = await collect(gated(model, { messages: [] } as any));
	assert.deepEqual(done.map((e) => e.type), ["start", "text_start", "text_delta", "done"]);
	assert.equal(slotCount(dir), 0, "released on done");
	const errored = await collect(gated(model, { messages: [] } as any));
	assert.deepEqual(errored.map((e) => e.type), ["error"]);
	assert.equal(slotCount(dir), 0, "released on error");
	const ac = new AbortController();
	const pending = collect(gated(model, { messages: [] } as any, { signal: ac.signal }));
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(slotCount(dir), 1, "held while the request runs");
	ac.abort();
	const aborted = await pending;
	assert.equal(aborted.at(-1)?.type, "error");
	assert.equal(slotCount(dir), 0, "released on abort");
	assert.deepEqual(seen.slots, [1, 1, 1], "each call ran holding exactly its own slot");
});

test("a request over the limit waits, reports it to its session, and stopping it ends the turn as a stop", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 1 } });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	const said: (WaitInfo | null)[] = [];
	registerSession("s-1", "interactive", (i) => said.push(i));
	const inner = scripted([() => ok()], { slots: [] }, dir);
	const gated = gateStreamSimple(inner, { agentDir: () => dir, retry: true });
	const ac = new AbortController();
	const pending = collect(gated(model, { messages: [] } as any, { sessionId: "s-1", signal: ac.signal }));
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(inner.calls, 0, "nothing sent while full");
	assert.deepEqual(said, [{ provider: "zai", inUse: 1, limit: 1, lowered: false }]);
	ac.abort();
	const events = await pending;
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal((events[0] as any).reason, "aborted");
	assert.equal(said.at(-1), null, "the status is cleared");
	held!.release();
	unregisterSession("s-1");
});

test("a 429 before any output is retried through the queue after a cooldown, and lowers the limit", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 5 } });
	const naps: number[] = [];
	const inner = scripted([() => fail(RATE), () => ok("second")], { slots: [] }, dir);
	const gated = gateStreamSimple(inner, { agentDir: () => dir, retry: true, sleep: async (ms) => void naps.push(ms) });
	const events = await collect(gated(model, { messages: [] } as any));
	assert.equal(inner.calls, 2);
	assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "text_delta", "done"], "the 429 never reached pi");
	assert.deepEqual(naps, [10_000], "no Retry-After: 10 s");
	const eff = effectiveLimit(dir, "zai")!;
	assert.equal(eff.limit, 4, "lowered to one below the limit it was sent under");
	assert.ok(eff.lowered && eff.lowered.until > Date.now() + 4 * 60_000);
	assert.deepEqual(limitsInEffect(dir), { zai: 5 }, "the Settings value is unchanged");
	assert.equal(slotCount(dir), 0);
});

test("after 5 re-queues the 429 reaches pi unchanged; a quota 429 and a 429 after output are never retried", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 5 } });
	const always = scripted([() => fail(RATE)], { slots: [] }, dir);
	const events = await collect(gateStreamSimple(always, { agentDir: () => dir, retry: true, sleep: async () => {} })(model, { messages: [] } as any));
	assert.equal(always.calls, RATE_LIMIT_RETRIES + 1);
	assert.deepEqual(events.map((e) => e.type), ["error"]);
	assert.equal((events[0] as any).error.errorMessage, RATE);
	assert.equal(effectiveLimit(dir, "zai")!.limit, 1, "each retry was sent under the lowered limit and lowered it again, never below 1");

	const quota = scripted([() => fail("429 You exceeded your current quota")], { slots: [] }, dir);
	await collect(gateStreamSimple(quota, { agentDir: () => dir, retry: true, sleep: async () => {} })(model, { messages: [] } as any));
	assert.equal(quota.calls, 1);

	const midway = scripted([() => [...ok().slice(0, 3), ...fail(RATE)]], { slots: [] }, dir);
	const partial = await collect(gateStreamSimple(midway, { agentDir: () => dir, retry: true, sleep: async () => {} })(model, { messages: [] } as any));
	assert.equal(midway.calls, 1);
	assert.deepEqual(partial.map((e) => e.type), ["start", "text_start", "text_delta", "error"]);

	const noRetry = scripted([() => fail(RATE)], { slots: [] }, dir);
	await collect(gateStreamSimple(noRetry, { agentDir: () => dir, retry: false })(model, { messages: [] } as any));
	assert.equal(noRetry.calls, 1, "retry off (claude-code): errors pass straight through");
	assert.equal(slotCount(dir), 0);
});

test("a provider without a limit, and a request that already holds its slot, pass straight through", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: {} });
	const seen = { slots: [] as number[] };
	const inner = scripted([() => ok()], seen, dir);
	await collect(gateStreamSimple(inner, { agentDir: () => dir, retry: true })(model, { messages: [] } as any));
	assert.deepEqual(seen.slots, [0]);
	writeProviderLimits(dir, { version: 1, limits: { zai: 1 } });
	const slot = await acquireSlot("zai", { agentDir: dir, kind: "background" });
	let inside = false;
	const probe: StreamSimple = (m, c, o) => {
		inside = holdsSlot("zai");
		return inner(m, c, o);
	};
	const { whileHolding } = await import("./gate.ts");
	const events = await whileHolding("zai", () => collect(gateStreamSimple(probe, { agentDir: () => dir, retry: true })(model, { messages: [] } as any)));
	assert.equal(events.at(-1)?.type, "done", "not blocked by its own slot");
	assert.equal(inside, true);
	assert.equal(slotCount(dir), 1, "no second slot was claimed");
	slot!.release();
});
