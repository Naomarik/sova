import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	AGING_MS,
	AbortedWhileWaiting,
	DEFAULT_PROVIDER_LIMITS,
	LOWERED_MS,
	STALE_MS,
	acquireSlot,
	cooldownMs,
	effectiveLimit,
	holdsSlot,
	isRateLimit,
	kindOf,
	limitsInEffect,
	lowerAfterRateLimit,
	markBackground,
	queueOrder,
	queueSnapshot,
	readLowered,
	readProviderLimits,
	registerSession,
	unregisterSession,
	waitingBySession,
	waitingText,
	whileHolding,
	writeProviderLimits,
	type WaitInfo,
} from "./gate.ts";

const tmpAgent = () => fs.mkdtempSync(path.join(os.tmpdir(), "provider-limits-"));
const setLimits = (dir: string, limits: Record<string, number>) => writeProviderLimits(dir, { version: 1, limits });
const files = (dir: string, provider: string, kind: "slots" | "wants") => {
	try {
		return fs.readdirSync(path.join(dir, "provider-limits", provider, kind)).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** A pid that is not running. */
function deadPid(): number {
	for (let pid = 4_000_000; ; pid++) {
		try {
			process.kill(pid, 0);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
}
const writeRecord = (dir: string, provider: string, kind: "slots" | "wants", name: string, rec: object) => {
	const d = path.join(dir, "provider-limits", provider, kind);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(rec));
};

test("the file: absent means the defaults, a stored file is exact, a malformed one applies the defaults", () => {
	const dir = tmpAgent();
	assert.equal(readProviderLimits(dir).state, "absent");
	assert.deepEqual(limitsInEffect(dir), { zai: 5, "ollama-cloud": 10 });
	assert.deepEqual(DEFAULT_PROVIDER_LIMITS, { zai: 5, "ollama-cloud": 10 });
	setLimits(dir, { zai: 3 });
	assert.deepEqual(limitsInEffect(dir), { zai: 3 }, "a stored file names every limit; ollama-cloud now has none");
	setLimits(dir, {});
	assert.deepEqual(limitsInEffect(dir), {}, "an empty file means no limits at all");
	fs.writeFileSync(path.join(dir, "provider-limits.json"), '{"version":1,"limits":{"zai":0}}');
	const bad = readProviderLimits(dir);
	assert.equal(bad.state, "malformed");
	assert.deepEqual(limitsInEffect(dir), { zai: 5, "ollama-cloud": 10 });
	for (const value of [{ version: 2, limits: {} }, { version: 1, limits: { zai: 1.5 } }, { version: 1, limits: { zai: 1000 } }, { version: 1, limits: { "../x": 2 } }, { version: 1, limits: {}, extra: 1 }])
		assert.throws(() => writeProviderLimits(dir, value), /Refusing to write/);
	assert.equal(effectiveLimit(dir, "openai-codex"), null, "a provider the file doesn't name has no limit");
});

test("claim and release: at most the limit at once, the next waiter gets a freed slot", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 2 });
	const a = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	const b = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	assert.ok(a && b);
	assert.equal(files(dir, "zai", "slots").length, 2);
	const waits: (WaitInfo | null)[] = [];
	let got = false;
	const c = acquireSlot("zai", { agentDir: dir, kind: "interactive", onWait: (i) => waits.push(i), pollMs: 20 }).then((s) => ((got = true), s));
	await tick(80);
	assert.equal(got, false, "the third waits while two are in flight");
	assert.deepEqual(waits[0], { provider: "zai", inUse: 2, limit: 2, lowered: false });
	assert.equal(files(dir, "zai", "wants").length, 1);
	a.release();
	a.release(); // idempotent
	const slot = await c;
	assert.ok(slot);
	assert.equal(waits.at(-1), null, "the wait is cleared once the slot is had");
	assert.equal(files(dir, "zai", "wants").length, 0);
	assert.equal(files(dir, "zai", "slots").length, 2);
	b.release();
	slot.release();
	assert.equal(files(dir, "zai", "slots").length, 0);
	assert.equal(await acquireSlot("openai-codex", { agentDir: dir, kind: "interactive" }), null, "no limit: nothing to claim");
});

test("stopping while waiting leaves the queue at once", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	const ac = new AbortController();
	const waiting = acquireSlot("zai", { agentDir: dir, kind: "interactive", signal: ac.signal, pollMs: 5_000 });
	await tick(50);
	assert.equal(files(dir, "zai", "wants").length, 1);
	ac.abort();
	await assert.rejects(waiting, AbortedWhileWaiting);
	assert.equal(files(dir, "zai", "wants").length, 0);
	held!.release();
});

test("stale: a dead process's slot, or one not refreshed for 30 s, is freed by the next reader", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	writeRecord(dir, "zai", "slots", "dead-1", { v: 1, pid: deadPid(), kind: "interactive", at: Date.now() });
	const s1 = await acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 20 });
	assert.ok(s1, "a dead pid's slot doesn't count");
	assert.deepEqual(files(dir, "zai", "slots").filter((f) => f.startsWith("dead")), [], "and it was removed");
	s1.release();
	writeRecord(dir, "zai", "slots", "old-1", { v: 1, pid: process.ppid, kind: "interactive", at: Date.now() - STALE_MS - 1 });
	writeRecord(dir, "zai", "wants", "old-2", { v: 1, pid: process.ppid, kind: "interactive", since: 0, at: Date.now() - STALE_MS - 1 });
	const s2 = await acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 20 });
	assert.ok(s2, "an unrefreshed slot and want don't count either");
	assert.deepEqual(files(dir, "zai", "slots").filter((f) => f.startsWith("old")), []);
	assert.deepEqual(files(dir, "zai", "wants"), []);
	s2.release();
});

test("queue order: interactive first, FCFS within a class, background aged past 2 minutes ranks as interactive", () => {
	const now = 1_000_000;
	const w = (name: string, kind: "interactive" | "background", since: number) => ({ name, v: 1 as const, pid: 1, kind, since, at: now });
	const order = queueOrder([w("b1", "background", now - 10), w("i2", "interactive", now - 5), w("i1", "interactive", now - 8), w("b0", "background", now - AGING_MS - 1)], now);
	assert.deepEqual(order.map((x) => x.name), ["b0", "i1", "i2", "b1"]);
});

test("priority through the gate: an interactive waiter goes ahead of an earlier background one", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	const order: string[] = [];
	const bg = acquireSlot("zai", { agentDir: dir, kind: "background", pollMs: 15 }).then((s) => (order.push("background"), s));
	await tick(40);
	const fg = acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 15 }).then((s) => (order.push("interactive"), s));
	await tick(40);
	held!.release();
	const first = await Promise.race([bg, fg]);
	await tick(60);
	assert.deepEqual(order, ["interactive"], "only the interactive request got the one slot");
	first!.release();
	(await bg)!.release();
	assert.deepEqual(order, ["interactive", "background"]);
});

test("aging through the gate: background waiting over 2 minutes is served before a later interactive request", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	// Another live process's background want, 2+ minutes old (refreshed: `at` is now).
	writeRecord(dir, "zai", "wants", "aged", { v: 1, pid: process.ppid, kind: "background", since: Date.now() - AGING_MS - 1_000, at: Date.now() });
	let got = false;
	const fg = acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 15 }).then((s) => ((got = true), s));
	held!.release();
	await tick(80);
	assert.equal(got, false, "the aged background request is ahead");
	fs.unlinkSync(path.join(dir, "provider-limits", "zai", "wants", "aged.json")); // it claimed and left
	(await fg)!.release();
});

test("lowering the limit while requests are in flight: none is cut off, new ones wait until under the new limit", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 3 });
	const slots = [];
	for (let i = 0; i < 3; i++) slots.push((await acquireSlot("zai", { agentDir: dir, kind: "interactive" }))!);
	setLimits(dir, { zai: 1 });
	let got = false;
	const next = acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 15 }).then((s) => ((got = true), s));
	slots[0].release();
	await tick(60);
	assert.equal(got, false, "2 in use, limit 1");
	slots[1].release();
	await tick(60);
	assert.equal(got, false, "1 in use, limit 1");
	slots[2].release();
	(await next)!.release();
	assert.equal(got, true);
});

test("removing the limit while waiting lets the request through", async () => {
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive" });
	const waiting = acquireSlot("zai", { agentDir: dir, kind: "interactive", pollMs: 15 });
	await tick(40);
	setLimits(dir, {});
	assert.equal(await waiting, null);
	held!.release();
});

test("rate limits: which 429s count, the cooldown, and lowering by one below the limit sent under, for 5 minutes", async () => {
	assert.ok(isRateLimit('429: {"code":"1302","message":"Rate limit reached for requests"}'));
	assert.ok(isRateLimit("Too many requests", 429));
	assert.ok(!isRateLimit("429 You exceeded your current quota, please check your plan and billing details"));
	assert.ok(!isRateLimit('429: {"code":"1113","message":"Insufficient balance or no resource package"}'));
	assert.ok(!isRateLimit("500 internal error"));
	assert.equal(cooldownMs(null), 10_000);
	assert.equal(cooldownMs("3"), 3_000);
	assert.equal(cooldownMs("0"), 1_000);
	assert.equal(cooldownMs("9999"), 120_000);
	assert.equal(cooldownMs(new Date(Date.now() + 5_000).toUTCString()) > 3_000, true);

	const dir = tmpAgent();
	setLimits(dir, { zai: 5 });
	const now = Date.now();
	const first = await lowerAfterRateLimit(dir, "zai", 5, now);
	assert.deepEqual(first, { v: 1, limit: 4, until: now + LOWERED_MS });
	assert.deepEqual(effectiveLimit(dir, "zai", now), { limit: 4, settings: 5, lowered: first });
	// The rest of the same burst, sent under 5 too, doesn't lower further.
	assert.equal((await lowerAfterRateLimit(dir, "zai", 5, now + 10))!.limit, 4);
	// A 429 on a request sent under the lowered limit lowers again and restarts the 5 minutes.
	const again = await lowerAfterRateLimit(dir, "zai", 4, now + 60_000);
	assert.deepEqual(again, { v: 1, limit: 3, until: now + 60_000 + LOWERED_MS });
	assert.equal(readProviderLimits(dir).state, "ok");
	assert.deepEqual(limitsInEffect(dir), { zai: 5 }, "the Settings value is never rewritten");
	// Never below 1.
	setLimits(dir, { zai: 1 });
	assert.equal((await lowerAfterRateLimit(dir, "zai", 1, now))!.limit, 1);
	// Expiry: back to the Settings number.
	setLimits(dir, { zai: 5 });
	assert.equal(readLowered(dir, "zai", now + 60_000 + LOWERED_MS + 1), null);
	assert.deepEqual(effectiveLimit(dir, "zai", now + 60_000 + LOWERED_MS + 1), { limit: 5, settings: 5 });
	assert.equal(await lowerAfterRateLimit(dir, "openai-codex", 3, now), null, "no limit: nothing to lower");
});

test("the waiting text, and Sova's read of the queue by session id", async () => {
	assert.equal(waitingText({ provider: "zai", inUse: 5, limit: 5, lowered: false }), "Waiting for zai · 5 of 5 in use");
	assert.equal(waitingText({ provider: "zai", inUse: 4, limit: 4, lowered: true }), "Waiting for zai · 4 of 4 in use (lowered after a rate limit)");
	const dir = tmpAgent();
	setLimits(dir, { zai: 1 });
	const held = await acquireSlot("zai", { agentDir: dir, kind: "interactive", sessionId: "s-run" });
	const waiting = acquireSlot("zai", { agentDir: dir, kind: "interactive", sessionId: "s-wait", pollMs: 15 });
	await tick(40);
	const snap = queueSnapshot(dir);
	assert.equal(snap.length, 1);
	assert.equal(snap[0].provider, "zai");
	assert.equal(snap[0].inUse, 1);
	assert.deepEqual(snap[0].waiting.map((w) => w.sessionId), ["s-wait"]);
	assert.deepEqual(waitingBySession(snap).get("s-wait"), { provider: "zai", inUse: 1, limit: 1, lowered: false });
	assert.equal(waitingBySession(snap).has("s-run"), false, "a session whose request is in flight isn't waiting");
	held!.release();
	(await waiting)!.release();
	assert.equal(waitingBySession(queueSnapshot(dir)).size, 0);
});

test("request classes: registered sessions by their class, markBackground wins, anything else is background", () => {
	registerSession("tui-1", "interactive");
	registerSession("worker-1", "background");
	registerSession("overseer-1", "interactive");
	markBackground("overseer-1");
	assert.equal(kindOf("tui-1"), "interactive");
	assert.equal(kindOf("worker-1"), "background");
	assert.equal(kindOf("overseer-1"), "background");
	assert.equal(kindOf("one-shot"), "background");
	assert.equal(kindOf(undefined), "background");
	unregisterSession("tui-1");
	assert.equal(kindOf("tui-1"), "background");
});

test("holding a slot is scoped to its async context", async () => {
	assert.equal(holdsSlot("zai"), false);
	await whileHolding("zai", async () => {
		await tick(1);
		assert.equal(holdsSlot("zai"), true);
		assert.equal(holdsSlot("ollama-cloud"), false);
	});
	assert.equal(holdsSlot("zai"), false);
});
