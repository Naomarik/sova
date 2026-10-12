import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";
import { WORKER_FEED_EVENTS, WORKER_HOST_DISCOVER_EVENT, WORKER_HOST_EVENT, type WorkerFeedFrame, type WorkerHostAnnouncement, type WorkerStart } from "./worker-host.ts";

const start = (over: Partial<WorkerStart> = {}): WorkerStart => ({
	key: "sid:ag_01:1",
	spec: {
		kind: "worker",
		parent: { sessionId: "sid", path: "/s/parent.jsonl", workerId: "ag_01" },
		cwd: "/w",
		model: "zai/glm-5.3",
		thinking: "low",
		builtins: null,
		extensions: [],
		flags: {},
		appendSystemPrompt: null,
		env: {},
		agentDir: null,
		lowered: true,
	},
	session: { new: { dir: "/s/workers" } },
	task: "do it",
	...over,
});

test("the feed carries the event set the worker fold consumes, never message_update", () => {
	assert.ok(WORKER_FEED_EVENTS.includes("queue_update"));
	assert.ok(WORKER_FEED_EVENTS.includes("agent_settled"));
	assert.ok(!(WORKER_FEED_EVENTS as readonly string[]).includes("message_update"));
});

test("fake host: a start is idempotent by key", async () => {
	const host = new FakeWorkerHost();
	const a = await host.start(start());
	const b = await host.start(start());
	assert.equal(a.chatId, b.chatId);
	assert.equal(host.starts.length, 2);
	assert.equal(host.workers.size, 1);
	assert.equal(a.workerId, "ag_01");
	assert.equal((await host.list()).length, 1);
});

test("fake host: a watch from a cursor replays the frames after it; another process gets a gap and the state", async () => {
	const host = new FakeWorkerHost();
	const ref = await host.start(start());
	const seen: WorkerFeedFrame[] = [];
	const un = host.watch(ref.chatId, null, (f) => seen.push(f));
	assert.equal(seen[0]!.t, "state");
	host.turn(ref.chatId, { user: "do it", reply: "done", key: "k1" });
	un();
	const mid = seen.find((f) => f.t === "event")! as Extract<WorkerFeedFrame, { t: "event" }>;
	const replay: WorkerFeedFrame[] = [];
	host.watch(ref.chatId, mid.cursor, (f) => replay.push(f));
	const after = seen.slice(seen.indexOf(mid) + 1);
	assert.deepEqual(replay.slice(0, after.length), after);
	const last = replay.at(-1)! as Extract<WorkerFeedFrame, { t: "state" }>;
	assert.equal(last.state.lastSettled?.key, "k1");

	host.newProcess(ref.chatId);
	const other: WorkerFeedFrame[] = [];
	host.watch(ref.chatId, mid.cursor, (f) => other.push(f));
	assert.deepEqual(other.map((f) => f.t), ["gap", "state"]);
});

test("fake host: stop ends the record; a send to an ended worker throws", async () => {
	const host = new FakeWorkerHost();
	const ref = await host.start(start());
	const seen: string[] = [];
	host.watch(ref.chatId, null, (f) => seen.push(f.t === "ended" ? `ended:${f.cause}` : f.t));
	await host.stop(ref.chatId, "test");
	assert.ok(seen.includes("ended:killed"));
	assert.deepEqual(await host.list(), []);
	await assert.rejects(host.send(ref.chatId, { text: "x", delivery: "steer", key: "k" }), /has ended/);
});

test("fake host: announced on the bus now and on discover", () => {
	const host = new FakeWorkerHost();
	const bus = new EventEmitter();
	const got: WorkerHostAnnouncement[] = [];
	bus.on(WORKER_HOST_EVENT, (a) => got.push(a));
	const events = { on: (n: string, fn: (d: unknown) => void) => (bus.on(n, fn), () => void bus.off(n, fn)), emit: (n: string, d: unknown) => void bus.emit(n, d) };
	const off = host.announceOn(events);
	bus.emit(WORKER_HOST_DISCOVER_EVENT, { version: 1 });
	assert.equal(got.length, 2);
	assert.equal(got[0]!.host, host);
	off();
	bus.emit(WORKER_HOST_DISCOVER_EVENT, { version: 1 });
	assert.equal(got.length, 2);
});
