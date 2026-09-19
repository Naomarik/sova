import assert from "node:assert/strict";
import test from "node:test";
import { PermissionQueue } from "./permissions.ts";
import type { ClaudePermissionDecision } from "./runner.ts";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const allow: ClaudePermissionDecision = { behavior: "allow", updatedInput: {} };

test("each concurrent worker gets a full permission deadline after its dialog opens", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const queue = new PermissionQueue(100);
	const signal = new AbortController().signal;
	const shown: string[] = [];
	let resolveFirst!: (decision: ClaudePermissionDecision) => void;
	const first = queue.run(signal, async () => { shown.push("first"); return new Promise(resolve => { resolveFirst = resolve; }); });
	await flush();
	t.mock.timers.tick(10);
	let secondDone = false;
	const second = queue.run(signal, async () => { shown.push("second"); return new Promise(() => {}); });
	void second.then(() => { secondDone = true; });
	t.mock.timers.tick(80);
	await flush();
	assert.deepEqual(shown, ["first"]);
	resolveFirst(allow); assert.deepEqual(await first, allow); await flush();
	assert.deepEqual(shown, ["first", "second"]);
	t.mock.timers.tick(30); await flush();
	assert.equal(secondDone, false, "queue wait must not use up response time");
	t.mock.timers.tick(70);
	const result = await second;
	assert.equal(result.behavior, "deny");
	assert.match(result.behavior === "deny" ? result.message : "", /after the dialog was shown/);
	queue.dispose();
});

test("queued cancellation resolves immediately and never opens its dialog", async () => {
	const queue = new PermissionQueue();
	const firstSignal = new AbortController();
	const secondSignal = new AbortController();
	const first = queue.run(firstSignal.signal, async () => new Promise(() => {}));
	let opened = false;
	const second = queue.run(secondSignal.signal, async () => { opened = true; return allow; });
	secondSignal.abort();
	const result = await second;
	assert.equal(result.behavior, "deny");
	assert.match(result.behavior === "deny" ? result.message : "", /before it was shown/);
	assert.equal(opened, false);
	queue.dispose(); await first;
});

test("timeout releases a stuck host callback and ignores its late approval", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const queue = new PermissionQueue(100);
	const signal = new AbortController().signal;
	let late!: (decision: ClaudePermissionDecision) => void;
	let dialogSignal!: AbortSignal;
	const first = queue.run(signal, async s => { dialogSignal = s; return new Promise(resolve => { late = resolve; }); });
	const next = queue.run(signal, async () => allow);
	await flush();t.mock.timers.tick(100);
	assert.equal((await first).behavior, "deny");
	assert.equal(dialogSignal.aborted, true);
	assert.deepEqual(await next, allow);
	late(allow);await flush();
	queue.dispose();
});

test("permission queue bounds pending work and disposes all active and queued requests", async () => {
	const queue = new PermissionQueue(100, 1);
	const signal = new AbortController().signal;
	const first = queue.run(signal, async () => new Promise(() => {}));
	const second = queue.run(signal, async () => new Promise(() => {}));
	const overflow = await queue.run(signal, async () => allow);
	assert.equal(overflow.behavior, "deny");
	assert.match(overflow.behavior === "deny" ? overflow.message : "", /queue is full/);
	queue.dispose();
	assert.equal((await first).behavior, "deny");
	assert.equal((await second).behavior, "deny");
	assert.equal((await queue.run(signal, async () => allow)).behavior, "deny");
});
