// Against pi's real ModelRuntime (tests/run.mjs aliases the pi packages): every way a process
// reaches a model goes through the instance runtime.ts wraps.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { writeProviderLimits } from "../provider-limits/gate.ts";
import { gateStreamSimple } from "../provider-limits/stream.ts";
import { instrumentModelRuntime, runtimeOf } from "./runtime.ts";
import { snapshot, subscribe } from "./tracker.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-rt-"));
const active = () => snapshot().active;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string) => {
	for (let i = 0; i < 400 && !cond(); i++) await tick(5);
	assert.ok(cond(), what);
};
const context = { messages: [{ role: "user" as const, content: "x", timestamp: 0 }] };

function message(model: { api: string; provider: string; id: string }, over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...over,
	};
}

/** A provider whose every request waits on the test: `gates[i]` resolves request i's phases. */
interface Step {
	/** Before onPayload: auth, a queue. */
	beforeSend?: Promise<unknown>;
	/** After onPayload, before the first event. */
	beforeReply?: Promise<unknown>;
	events?: (m: any) => AssistantMessageEvent[];
	/** Run inside the request, after onPayload (a nested call). */
	during?: () => Promise<unknown>;
	throwSync?: boolean;
}

function controllable(steps: Step[]) {
	const seen: { payloads: unknown[]; calls: number } = { payloads: [], calls: 0 };
	const streamSimple = (model: any, _ctx: any, options: any) => {
		const step = steps[Math.min(seen.calls, steps.length - 1)];
		seen.calls++;
		if (step.throwSync) throw new Error("provider setup failed");
		const s = createAssistantMessageEventStream();
		void (async () => {
			try {
				await step.beforeSend;
				const replaced = await options?.onPayload?.({ marker: 1 }, model);
				seen.payloads.push(replaced ?? { marker: 1 });
				await step.during?.();
				await step.beforeReply;
				if (options?.signal?.aborted) {
					s.push({ type: "error", reason: "aborted", error: message(model, { stopReason: "aborted", errorMessage: "aborted" }) });
					s.end();
					return;
				}
				for (const e of step.events?.(model) ?? [{ type: "start", partial: message(model) } as AssistantMessageEvent, { type: "done", reason: "stop", message: message(model) } as AssistantMessageEvent]) s.push(e);
				s.end();
			} catch (error) {
				s.push({ type: "error", reason: "error", error: message(model, { stopReason: "error", errorMessage: String(error) }) });
				s.end();
			}
		})();
		return s;
	};
	return { streamSimple, seen };
}

async function runtimeWith(streamSimple: (...a: any[]) => any, opts: { instrument?: boolean; api?: string } = {}) {
	const dir = tmp();
	const rt = await (ModelRuntime as any).create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, modelsStorePath: path.join(dir, "models-store.json") });
	rt.registerProvider("fakeprov", {
		api: opts.api ?? "fake-api",
		apiKey: "unused",
		baseUrl: "http://127.0.0.1:9",
		streamSimple,
		models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	if (opts.instrument !== false) assert.equal(instrumentModelRuntime(rt), "instrumented");
	return { rt, model: rt.getModel("fakeprov", "m1"), dir };
}

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

test("pending until issued: auth and setup don't count; counted from onPayload before the first token to the end", async () => {
	const send = deferred();
	const reply = deferred();
	const p = controllable([{ beforeSend: send.promise, beforeReply: reply.promise }]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	const s = rt.streamSimple(model, context);
	await tick(10);
	assert.equal(active(), 0, "setup, auth, a queue: not in flight");
	send.resolve();
	await until(() => active() === 1, "issued: in flight before any event");
	reply.resolve();
	const final = await s.result();
	assert.equal(final.stopReason, "stop");
	await tick();
	assert.equal(active(), 0);
});

test("complete and completeSimple are one call each; concurrent same-provider calls count apart", async () => {
	const reply = deferred();
	const p = controllable([{ beforeReply: reply.promise }]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	let peak = 0;
	const off = subscribe(() => (peak = Math.max(peak, active())));
	const a = rt.complete(model, context);
	const b = rt.completeSimple(model, context);
	const c = rt.streamSimple(model, context).result();
	await until(() => active() === 3, "three calls of one provider, three in flight");
	reply.resolve();
	await Promise.all([a, b, c]);
	off();
	assert.equal(peak, 3, "never more than the three calls: the aliases add none");
	await tick();
	assert.equal(active(), 0);
});

test("a nested call made during a call (warming, a tool's own completion) counts too", async () => {
	const inner = deferred();
	let rt: any;
	let model: any;
	const p = controllable([
		{ during: () => rt.completeSimple(model, context) },
		{ beforeReply: inner.promise },
	]);
	({ rt, model } = await runtimeWith(p.streamSimple));
	const outer = rt.streamSimple(model, context);
	await until(() => active() === 2, "the outer call and the nested one");
	inner.resolve();
	await outer.result();
	await tick();
	assert.equal(active(), 0);
});

test("failures end the call: provider error, setup throw, unknown provider, abort, a consumer that stops reading", async () => {
	const p = controllable([{ events: (m) => [{ type: "error", reason: "error", error: message(m, { stopReason: "error", errorMessage: "boom" }) }] }]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	assert.equal((await rt.completeSimple(model, context)).stopReason, "error");
	await tick();
	assert.equal(active(), 0);

	const t = controllable([{ throwSync: true }]);
	const { rt: rt2, model: model2 } = await runtimeWith(t.streamSimple);
	let peak = 0;
	const off = subscribe(() => (peak = Math.max(peak, active())));
	const r = await rt2.completeSimple(model2, context);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage, /provider setup failed/);
	const unknown = await rt2.completeSimple({ ...model2, provider: "nope" }, context);
	assert.equal(unknown.stopReason, "error", "unknown provider: pi's own setup error");
	off();
	assert.equal(peak, 0, "a request never sent was never in flight");

	const hold = deferred();
	const a = controllable([{ beforeReply: hold.promise }]);
	const { rt: rt3, model: model3 } = await runtimeWith(a.streamSimple);
	const controller = new AbortController();
	const aborted = rt3.streamSimple(model3, context, { signal: controller.signal });
	await until(() => active() === 1, "in flight");
	controller.abort();
	hold.resolve();
	assert.equal((await aborted.result()).stopReason, "aborted");
	await tick();
	assert.equal(active(), 0);

	const b = controllable([{}]);
	const { rt: rt4, model: model4 } = await runtimeWith(b.streamSimple);
	for await (const _e of rt4.streamSimple(model4, context)) break;
	await until(() => active() === 0, "the stream ends on its own after the consumer left");
});

test("a synchronous throw passes through unchanged and counts nothing", () => {
	const err = new Error("sync");
	const fake = { stream: () => { throw err; }, streamSimple: () => { throw err; } };
	assert.equal(instrumentModelRuntime(fake), "instrumented");
	assert.throws(() => fake.streamSimple(), (e) => e === err);
	assert.equal(active(), 0);
	assert.equal(instrumentModelRuntime({}), "unsupported");
	assert.equal(instrumentModelRuntime(null), "unsupported");
	assert.equal(runtimeOf({ runtime: fake }), fake);
	assert.equal(runtimeOf(undefined), undefined);
});

test("output unchanged: same events, same result, the caller's onPayload still replaces the payload", async () => {
	const events = (m: any): AssistantMessageEvent[] => [
		{ type: "start", partial: message(m) },
		{ type: "text_start", contentIndex: 0, partial: message(m) },
		{ type: "text_delta", contentIndex: 0, delta: "hi", partial: message(m) },
		{ type: "done", reason: "stop", message: message(m) },
	];
	const plain = controllable([{ events }]);
	const counted = controllable([{ events }]);
	const { rt: rtPlain, model } = await runtimeWith(plain.streamSimple, { instrument: false });
	const { rt } = await runtimeWith(counted.streamSimple);
	const read = async (s: AsyncIterable<AssistantMessageEvent>) => {
		const out: AssistantMessageEvent[] = [];
		for await (const e of s) out.push(e);
		return out;
	};
	let calls = 0;
	const onPayload = async (payload: any) => {
		calls++;
		return { ...payload, replaced: true };
	};
	const a = rtPlain.streamSimple(model, context, { onPayload });
	const b = rt.streamSimple(model, context, { onPayload });
	assert.deepEqual(await read(b), await read(a));
	assert.deepEqual(await b.result(), await a.result());
	assert.equal(calls, 2, "the caller's hook ran once per request");
	assert.deepEqual(counted.seen.payloads, plain.seen.payloads);
	assert.deepEqual(counted.seen.payloads, [{ marker: 1, replaced: true }]);
	const noHook = controllable([{}]);
	const { rt: rt2, model: m2 } = await runtimeWith(noHook.streamSimple);
	await rt2.completeSimple(m2, context);
	assert.deepEqual(noHook.seen.payloads, [{ marker: 1 }], "no hook of the caller's: no replacement");
});

test("idempotent: instrumenting the same runtime again (a reload, Sova and its extension) changes nothing", async () => {
	const p = controllable([{}]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	const wrapped = rt.streamSimple;
	assert.equal(instrumentModelRuntime(rt), "already");
	assert.equal(rt.streamSimple, wrapped);
	let peak = 0;
	const off = subscribe(() => (peak = Math.max(peak, active())));
	await rt.completeSimple(model, context);
	off();
	assert.equal(peak, 1);
});

test("bounded: two notifications a call however many tokens, and nothing left on the stream after the first event", async () => {
	const many = (m: any): AssistantMessageEvent[] => [
		{ type: "start", partial: message(m) },
		{ type: "text_start", contentIndex: 0, partial: message(m) },
		...Array.from({ length: 2000 }, () => ({ type: "text_delta", contentIndex: 0, delta: "x", partial: message(m) }) as AssistantMessageEvent),
		{ type: "done", reason: "stop", message: message(m) },
	];
	const p = controllable([{ events: many }]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	let n = 0;
	const off = subscribe(() => n++);
	const s = rt.streamSimple(model, context);
	await s.result();
	await tick();
	off();
	assert.equal(n, 2, "issued, ended");
	assert.equal(Object.hasOwn(s, "push"), false, "the first-event watch is gone");
});

test("a provider without onPayload (faux) counts from its first event; a deferred handle degrades until its final reply, and fetching never counts", async () => {
	const faux = fauxProvider({ deferred: { pendingFetches: 1 } } as any);
	const dir = tmp();
	const rt = await (ModelRuntime as any).create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, modelsStorePath: path.join(dir, "ms.json") });
	rt.registerNativeProvider(faux.provider);
	instrumentModelRuntime(rt);
	const model = faux.models[0];
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("later")]);
	let peak = 0;
	const off = subscribe(() => (peak = Math.max(peak, active())));
	const plain = await rt.completeSimple(model, context);
	assert.equal(plain.stopReason, "stop");
	assert.equal(peak, 1, "counted from its first event");
	await tick();
	assert.equal(active(), 0);

	const submitted = await rt.completeSimple(model, context, { deferred: true });
	assert.equal(submitted.stopReason, "deferred");
	await tick();
	assert.equal(active(), 0);
	assert.equal(snapshot().degraded, true, "remote work nobody here sees");
	peak = 0;
	const pending = await rt.fetchDeferred(model, submitted.deferred);
	assert.equal(pending.stopReason, "deferred", "still pending");
	assert.equal(snapshot().degraded, true);
	const final = await rt.fetchDeferred(model, submitted.deferred);
	assert.equal(final.stopReason, "stop");
	await tick();
	off();
	assert.equal(peak, 0, "retrieving a handle is never an active call");
	assert.equal(snapshot().degraded, false, "the final reply retires the handle");

	faux.setResponses([fauxAssistantMessage("cancel me")]);
	const again = await rt.completeSimple(model, context, { deferred: true });
	assert.equal(snapshot().degraded, true);
	await rt.cancelDeferred(model, again.deferred);
	await tick();
	assert.equal(snapshot().degraded, false, "a cancel retires it too");
});

test("the API-specific stream path counts the same", async () => {
	const faux = fauxProvider();
	const dir = tmp();
	const rt = await (ModelRuntime as any).create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, modelsStorePath: path.join(dir, "ms.json") });
	rt.registerNativeProvider(faux.provider);
	instrumentModelRuntime(rt);
	faux.setResponses([fauxAssistantMessage("a")]);
	let peak = 0;
	const off = subscribe(() => (peak = Math.max(peak, active())));
	assert.equal((await rt.complete(faux.models[0], context)).stopReason, "stop");
	off();
	assert.equal(peak, 1);
});

test("provider-limits: a queued request isn't in flight; a 429 cooldown isn't either; the retry is the same call again", async () => {
	const agentDir = tmp();
	writeProviderLimits(agentDir, { version: 1, limits: { fakeprov: 1 } });
	const rate = (m: any): AssistantMessageEvent[] => [{ type: "error", reason: "error", error: message(m, { stopReason: "error", errorMessage: '429: {"code":"1302","message":"Rate limit reached for requests"}' }) }];
	const first = deferred();
	const retry = deferred();
	const p = controllable([{ beforeReply: first.promise }, { events: rate }, { beforeReply: retry.promise }]);
	const cooled = deferred();
	const released = deferred();
	const gated = gateStreamSimple(p.streamSimple as any, {
		provider: "fakeprov",
		agentDir: () => agentDir,
		retry: true,
		sleep: async () => {
			cooled.resolve();
			await released.promise;
		},
	});
	const { rt, model } = await runtimeWith(gated);
	const holder = rt.streamSimple(model, context);
	await until(() => active() === 1, "the first request holds the only slot");
	const queued = rt.streamSimple(model, context);
	await tick(50);
	assert.equal(active(), 1, "the second waits in the queue: not in flight");
	first.resolve();
	await holder.result();
	await cooled.promise;
	assert.equal(active(), 0, "429 then cooldown: not in flight");
	await tick(20);
	assert.equal(active(), 0, "still cooling down: still not in flight");
	released.resolve();
	await until(() => active() === 1, "the retry was sent again: in flight again, before its reply");
	retry.resolve();
	const final = await queued.result();
	assert.equal(final.stopReason, "stop");
	assert.equal(p.seen.calls, 3, "one re-queued request");
	await tick();
	assert.equal(active(), 0);
});

test("custom streams are preserved exactly: an own push, a prototype push, a frozen stream, a push that throws", async () => {
	const settle = () => {
		let resolve!: (m: unknown) => void;
		const result = new Promise((r) => (resolve = r));
		return { result: () => result, resolve };
	};
	// An own push: wrapped while watching, then the very same property put back.
	const ownPush = function push(this: any, e: unknown) {
		this.events.push(e);
	};
	const own = { events: [] as unknown[], push: ownPush, ...settle() };
	const before = Object.getOwnPropertyDescriptor(own, "push");
	const rtOwn = { stream: () => own, streamSimple: () => own };
	instrumentModelRuntime(rtOwn);
	assert.equal(rtOwn.streamSimple(), own, "the stream itself is returned");
	assert.equal(active(), 0, "pending until its first event");
	own.push({ type: "start" });
	assert.equal(active(), 1);
	assert.deepEqual(Object.getOwnPropertyDescriptor(own, "push"), before, "own push restored exactly");
	own.push({ type: "done" });
	assert.deepEqual(own.events, [{ type: "start" }, { type: "done" }]);
	own.resolve({});
	await tick();
	assert.equal(active(), 0);

	// A prototype push: no own property left behind.
	class Proto {
		events: unknown[] = [];
		s = settle();
		push(e: unknown) {
			this.events.push(e);
		}
		result() {
			return this.s.result();
		}
	}
	const proto = new Proto();
	const rtProto = { stream: () => proto, streamSimple: () => proto };
	instrumentModelRuntime(rtProto);
	rtProto.streamSimple();
	proto.push({ type: "start" });
	assert.equal(Object.hasOwn(proto, "push"), false);
	assert.equal(active(), 1);
	proto.s.resolve({});
	await tick();
	assert.equal(active(), 0);

	// Frozen: never touched; counted from onPayload, ended by its result.
	const frozenSettle = settle();
	let options: any;
	const frozen = Object.freeze({ push() {}, result: frozenSettle.result });
	const rtFrozen = { stream: () => frozen, streamSimple: (_m: unknown, _c: unknown, o: unknown) => ((options = o), frozen) };
	instrumentModelRuntime(rtFrozen);
	assert.equal(rtFrozen.streamSimple(undefined, undefined, {}), frozen);
	assert.ok(Object.isFrozen(frozen));
	assert.equal(active(), 0);
	await options.onPayload({}, {});
	assert.equal(active(), 1);
	frozenSettle.resolve({});
	await tick();
	assert.equal(active(), 0);

	// A push that throws: the same error reaches the caller.
	const boom = new Error("push failed");
	const thrower = { push(_e: unknown) { throw boom; }, ...settle() };
	const rtThrow = { stream: () => thrower, streamSimple: () => thrower };
	instrumentModelRuntime(rtThrow);
	rtThrow.streamSimple();
	assert.throws(() => thrower.push({ type: "start" }), (e) => e === boom);
	thrower.resolve({});
	await tick();
	assert.equal(active(), 0);
});

test("a caller's onPayload that throws or rejects behaves exactly as without the counter, and the call still ends", async () => {
	for (const hook of [
		() => {
			throw new Error("hook threw");
		},
		async () => {
			throw new Error("hook rejected");
		},
	]) {
		const plain = controllable([{}]);
		const counted = controllable([{}]);
		const { rt: rtPlain, model } = await runtimeWith(plain.streamSimple, { instrument: false });
		const { rt } = await runtimeWith(counted.streamSimple);
		const a = await rtPlain.completeSimple(model, context, { onPayload: hook });
		const b = await rt.completeSimple(model, context, { onPayload: hook });
		assert.deepEqual({ ...b, timestamp: 0 }, { ...a, timestamp: 0 });
		assert.equal(b.stopReason, "error");
		await tick();
		assert.equal(active(), 0);
	}
});

test("an own getter push is restored exactly; a non-configurable own push is left alone and the stream works", async () => {
	const settle = () => {
		let resolve!: (m: unknown) => void;
		const result = new Promise((r) => (resolve = r));
		return { result: () => result, resolve };
	};
	const seen: unknown[] = [];
	const impl = (e: unknown) => void seen.push(e);
	const getter = { ...settle() } as any;
	Object.defineProperty(getter, "push", { get: () => impl, configurable: true, enumerable: true });
	const descriptor = Object.getOwnPropertyDescriptor(getter, "push");
	const rtGet = { stream: () => getter, streamSimple: () => getter };
	instrumentModelRuntime(rtGet);
	rtGet.streamSimple();
	getter.push({ type: "start" });
	assert.equal(active(), 1);
	assert.deepEqual(Object.getOwnPropertyDescriptor(getter, "push"), descriptor, "the getter itself is back");
	getter.resolve({});
	await tick();

	let options: any;
	const fixed = { ...settle() } as any;
	Object.defineProperty(fixed, "push", { value: impl, writable: false, configurable: false });
	const rtFixed = { stream: () => fixed, streamSimple: (_m: unknown, _c: unknown, o: unknown) => ((options = o), fixed) };
	instrumentModelRuntime(rtFixed);
	rtFixed.streamSimple(undefined, undefined, {});
	assert.equal(fixed.push, impl, "untouched");
	fixed.push({ type: "start" });
	assert.equal(active(), 0, "not watchable: issue comes from onPayload");
	await options.onPayload({}, {});
	assert.equal(active(), 1);
	fixed.resolve({});
	await tick();
	assert.equal(active(), 0);
	assert.equal(seen.length, 2);
});

test("cache warming (pi's own CacheWarmer on the instrumented runtime) is counted while it warms", async () => {
	const packageDir = process.env.PI_PACKAGE_DIR;
	assert.ok(packageDir, "run through tests/run.mjs");
	const { CacheWarmer } = (await import(path.join(packageDir, "dist/core/cache-warmer.js"))) as any;
	const reply = deferred();
	const p = controllable([{ beforeReply: reply.promise }]);
	const { rt, model } = await runtimeWith(p.streamSimple);
	const warmModel = { ...model, promptCache: { short: 10.002 } };
	const warmer = new CacheWarmer(rt, (SessionManager as any).inMemory(tmp()), () => "streaming", async (event: { action: string }) => event.action === "stop" ? "warm" : event.action);
	warmer.start({ model: warmModel, context, options: {} }, () => true);
	await until(() => active() === 1, "the warming request is in flight");
	assert.equal(p.seen.calls, 1);
	reply.resolve();
	await until(() => active() === 0, "and ends with its reply");
	warmer.cancel();
});
