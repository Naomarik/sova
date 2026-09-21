import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeWorkers, WORKERS_REQUEST_EVENT, WORKERS_SNAPSHOT_EVENT, type WorkerSummary, type WorkerUsageTotal } from "./workers.ts";

function harness() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const lifecycle = new Map<string, Array<() => void>>();
	const events = {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => { listeners.get(name)!.delete(handler); };
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(listeners.get(name) ?? [])]) handler(data);
		},
	};
	const pi = { events, on(name: string, handler: () => void) {
		if (!lifecycle.has(name)) lifecycle.set(name, []);
		lifecycle.get(name)!.push(handler);
	} } as unknown as ExtensionAPI;
	return { pi, events, listeners, lifecycle,
		fire(name: string) { for (const handler of lifecycle.get(name) ?? []) handler(); },
		snapshot(workers: WorkerSummary[]) { events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers }); },
	};
}
const worker = (status = "running"): WorkerSummary => ({ id: "ag_01", name: "background", status, model: "pi/model", preview: "Working" });

test("initial empty state, synchronous snapshot recovery, all backends and background updates", () => {
	const h = harness();
	const changes: WorkerSummary[][] = [];
	h.events.on(WORKERS_REQUEST_EVENT, data => {
		assert.deepEqual(data, { version: 1 });
		h.snapshot([worker(), { id: "ag_02", name: "Claude", status: "starting", model: "sonnet" }]);
	});
	const off = subscribeWorkers(h.pi, workers => changes.push(workers));
	assert.deepEqual(changes[0], []);
	assert.equal(changes[1].length, 2);
	for (const status of ["waiting", "running", "stopping", "killed", "error", "done"]) {
		h.snapshot([worker(status)]);
		assert.equal(changes.at(-1)![0].status, status);
	}
	h.snapshot([]);
	assert.deepEqual(changes.at(-1), []);
	// Only session lifecycle is subscribed: no inference from tool calls/results.
	assert.deepEqual([...h.lifecycle.keys()], ["session_start", "session_shutdown"]);
	off();
});

test("subscriber before manager load retries at session_start; late publisher startup works", () => {
	const h = harness();
	const changes: WorkerSummary[][] = [];
	subscribeWorkers(h.pi, workers => changes.push(workers));
	h.events.on(WORKERS_REQUEST_EVENT, () => h.snapshot([worker()]));
	h.fire("session_start");
	assert.equal(changes.at(-1)![0].status, "running");
	h.snapshot([worker("waiting")]);
	assert.equal(changes.at(-1)![0].status, "waiting");
	h.fire("session_shutdown");
});

test("malformed and unsupported snapshots cannot erase valid state", () => {
	const h = harness();
	const changes: WorkerSummary[][] = [];
	subscribeWorkers(h.pi, workers => changes.push(workers));
	h.snapshot([worker()]);
	for (const data of [null, undefined, [], {}, { version: 2, workers: [] },
		{ version: 1, workers: null }, ...[null, {}, { ...worker(), id: "" },
		{ ...worker(), name: 1 }, { ...worker(), status: false },
		{ ...worker(), model: 7 }, { ...worker(), preview: {} }].map(bad => ({ version: 1, workers: [bad] })),
		{ version: 1, workers: [worker(), worker()] }]) {
		h.events.emit(WORKERS_SNAPSHOT_EVENT, data);
	}
	assert.equal(changes.length, 2);
	h.fire("session_shutdown");
});

test("deduplicates refreshes and isolates subscriber and publisher mutations", () => {
	const h = harness();
	const source = worker();
	const changes: WorkerSummary[][] = [];
	subscribeWorkers(h.pi, workers => changes.push(workers));
	h.snapshot([source]);
	h.snapshot([{ ...source }]);
	assert.equal(changes.length, 2);
	changes[1][0].name = "UI mutation";
	h.snapshot([source]);
	assert.equal(changes.length, 2);
	assert.equal(source.name, "background");
	source.status = "waiting";
	assert.equal(changes[1][0].status, "running");
	h.snapshot([source]);
	assert.equal(changes.length, 3);
	assert.equal(changes[2][0].name, "background");
	h.fire("session_shutdown");
});

test("explicit disposal and shutdown are idempotent, prevent requests, and release listeners", () => {
	for (const shutdown of [false, true]) {
		const h = harness();
		let requests = 0;
		let changes = 0;
		h.events.on(WORKERS_REQUEST_EVENT, () => requests++);
		const off = subscribeWorkers(h.pi, () => changes++);
		if (shutdown) h.fire("session_shutdown"); else off();
		off();
		h.fire("session_start");
		h.snapshot([worker()]);
		assert.equal(requests, 1);
		assert.equal(changes, 1);
		assert.equal(h.listeners.get(WORKERS_SNAPSHOT_EVENT)!.size, 0);
	}
});

test("absent manager is harmless; concurrent subscriptions clean up independently", () => {
	const h = harness();
	const a: WorkerSummary[][] = [], b: WorkerSummary[][] = [];
	const offA = subscribeWorkers(h.pi, workers => a.push(workers));
	const offB = subscribeWorkers(h.pi, workers => b.push(workers));
	assert.deepEqual(a, [[]]);
	offA();
	h.snapshot([worker()]);
	assert.equal(a.length, 1);
	assert.equal(b.length, 2);
	offB();
});

test("throwing initial callback does not leak an event-bus listener", () => {
	const h = harness();
	assert.throws(() => subscribeWorkers(h.pi, () => { throw new Error("view failed"); }), /view failed/);
	assert.equal(h.listeners.get(WORKERS_SNAPSHOT_EVENT)!.size, 0);
	assert.doesNotThrow(() => h.fire("session_start"));
});

test("additive fields pass through; invalid values are omitted without rejecting the snapshot", () => {
	const h = harness();
	const changes: WorkerSummary[][] = [];
	subscribeWorkers(h.pi, workers => changes.push(workers));
	h.snapshot([{ ...worker("done"), backend: "claude", startedAt: 1, lastActivity: 2, endedAt: 3, outcome: "success" }]);
	assert.deepEqual(changes.at(-1), [{ id: "ag_01", name: "background", status: "done", model: "pi/model", preview: "Working",
		backend: "claude", startedAt: 1, lastActivity: 2, endedAt: 3, outcome: "success" }]);
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [{ ...worker("error"), backend: 7, startedAt: "1",
		lastActivity: Number.NaN, endedAt: Infinity, outcome: "meh", unknownKey: { mutable: true } }] });
	assert.deepEqual(changes.at(-1), [worker("error")]);
	for (const outcome of ["error", "aborted"] as const) {
		h.snapshot([{ ...worker("killed"), outcome }]);
		assert.equal(changes.at(-1)![0].outcome, outcome);
	}
	// Worker transcript path and backend session id: kept whole when valid.
	const file = "/home/u/.pi/agent/sessions/--home-u-app--/2026-09-20T00-00-00-000Z_abc.jsonl";
	h.snapshot([{ ...worker("running"), sessionFile: file, sessionId: "s".repeat(64) }]);
	assert.deepEqual(changes.at(-1), [{ ...worker("running"), sessionFile: file, sessionId: "s".repeat(64) }]);
	// Non-string, empty, or over-limit values are dropped per field (never truncated); the worker survives.
	for (const [sessionFile, sessionId] of [[42, {}], ["", ""], ["/" + "x".repeat(1024), "s".repeat(65)]]) {
		h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [{ ...worker("waiting"), sessionFile, sessionId }] });
		assert.deepEqual(changes.at(-1), [worker("waiting")]);
		h.snapshot([worker("running")]);
	}
	h.snapshot([{ ...worker("running"), sessionFile: "/" + "x".repeat(1023), sessionId: 7 as unknown as string }]);
	assert.deepEqual(changes.at(-1), [{ ...worker("running"), sessionFile: "/" + "x".repeat(1023) }]);
	// Spawned effort: a valid level is copied; non-string, empty or over-limit is dropped; absent stays absent.
	h.snapshot([{ ...worker("running"), effort: "xhigh" }]);
	assert.deepEqual(changes.at(-1), [{ ...worker("running"), effort: "xhigh" }]);
	for (const effort of [7, "", "e".repeat(33), { level: "high" }]) {
		h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [{ ...worker("waiting"), effort }] });
		assert.deepEqual(changes.at(-1), [worker("waiting")], JSON.stringify(effort));
		h.snapshot([worker("running")]);
	}
	h.snapshot([{ ...worker("running"), effort: "e".repeat(32) }]);
	assert.equal(changes.at(-1)![0].effort, "e".repeat(32));
	h.snapshot([worker("waiting")]);
	assert.ok(!("effort" in changes.at(-1)![0]), "an older manager's worker stays without effort");
	h.fire("session_shutdown");
});

test("token counts pass through per worker, and the lifetime total arrives beside the list", () => {
	const h = harness();
	const changes: Array<[WorkerSummary[], WorkerUsageTotal | undefined]> = [];
	subscribeWorkers(h.pi, (workers, usage) => changes.push([workers, usage]));
	const usage = { input: 120, output: 30, cacheRead: 4000, cacheWrite: 250, cost: 0.75 };
	h.snapshot([{ ...worker(), usage }]);
	assert.deepEqual(changes.at(-1)![0], [{ ...worker(), usage }]);
	assert.equal(changes.at(-1)![1], undefined, "a manager without a total sends none");
	// Counts are advisory: bad ones read as 0, a non-object usage is dropped, the worker survives.
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [{ ...worker("waiting"),
		usage: { input: -3, output: "9", cacheRead: Number.NaN, cacheWrite: 12.9, cost: 0 } }] });
	assert.deepEqual(changes.at(-1)![0], [{ ...worker("waiting"), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 12 } }]);
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [{ ...worker("done"), usage: "lots" }] });
	assert.deepEqual(changes.at(-1)![0], [worker("done")]);
	// The Σ covers evicted workers, so it is independent of the list and of its own ordering.
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [worker()],
		workerUsage: { input: 9000, output: 800, cacheRead: 70_000, cacheWrite: 6000, cost: 4.2, workers: 63 } });
	assert.deepEqual(changes.at(-1)![1], { input: 9000, output: 800, cacheRead: 70_000, cacheWrite: 6000, cost: 4.2, workers: 63 });
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [worker()],
		workerUsage: { input: 9000, output: 800, cacheRead: 70_000, cacheWrite: 6000, cost: 4.2, workers: "many" } });
	assert.equal(changes.at(-1)![1]!.workers, 0, "a bad lifetime count reads as 0");
	// A changed total alone is still a change worth reporting.
	const before = changes.length;
	h.events.emit(WORKERS_SNAPSHOT_EVENT, { version: 1, workers: [worker()],
		workerUsage: { input: 9001, output: 800, cacheRead: 70_000, cacheWrite: 6000, workers: 63 } });
	assert.equal(changes.length, before + 1);
	h.fire("session_shutdown");
});
