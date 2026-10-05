import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	beginClaudeTurn,
	beginLlmCall,
	currentLlmCall,
	isCounting,
	markCounting,
	markDegraded,
	MAX_FOLDED,
	parseCounts,
	setChildCounts,
	snapshot,
	subscribe,
	withinLlmCall,
} from "./tracker.ts";

const counts = () => {
	const { active, approximate, claudeTurns, degraded } = snapshot();
	return { active, approximate, claudeTurns, degraded };
};
const zero = { active: 0, approximate: 0, claudeTurns: 0, degraded: false };

test("a call counts from begin to end; end is idempotent", () => {
	const end = beginLlmCall({ source: "runtime" });
	const end2 = beginLlmCall({ source: "claude-oneshot", approximate: true });
	assert.deepEqual(counts(), { ...zero, active: 2, approximate: 1 });
	end();
	end();
	assert.equal(end.ended, true);
	assert.deepEqual(counts(), { ...zero, active: 1, approximate: 1 });
	end2();
	assert.deepEqual(counts(), zero);
});

test("a waiting call is not in flight; a pending call starts waiting", () => {
	const end = beginLlmCall({ source: "runtime", pending: true });
	assert.equal(snapshot().active, 0, "pending: not issued yet");
	end.waiting(false);
	assert.equal(snapshot().active, 1);
	end.waiting(true);
	assert.equal(snapshot().active, 0, "a cooldown");
	end.waiting(false);
	end();
	end.waiting(false);
	assert.deepEqual(counts(), zero, "waiting() after the end changes nothing");
});

test("subscribe fires only when the published counts change, never for bookkeeping", () => {
	let n = 0;
	const off = subscribe(() => n++);
	const pending = beginLlmCall({ source: "runtime", pending: true });
	assert.equal(n, 0, "a pending call changes nothing published");
	pending.waiting(false);
	assert.equal(n, 1);
	pending.waiting(false);
	assert.equal(n, 1);
	pending();
	assert.equal(n, 2);
	const t = beginClaudeTurn();
	t();
	t();
	assert.equal(n, 4);
	off();
	beginLlmCall({ source: "runtime" })();
	assert.equal(n, 4, "unsubscribed");
});

test("a listener's throw is its own", () => {
	const off = subscribe(() => {
		throw new Error("boom");
	});
	const end = beginLlmCall({ source: "runtime" });
	end();
	off();
	assert.deepEqual(counts(), zero);
});

test("withinLlmCall scopes one call to the code under it; a nested call is a call of its own", async () => {
	assert.equal(currentLlmCall(), undefined);
	const outer = beginLlmCall({ source: "runtime" });
	await withinLlmCall(outer, async () => {
		await new Promise((r) => setTimeout(r, 1));
		assert.equal(currentLlmCall(), outer, "survives an await");
		const inner = beginLlmCall({ source: "runtime" });
		withinLlmCall(inner, () => assert.equal(currentLlmCall(), inner));
		assert.equal(snapshot().active, 2, "the nested call is counted, not suppressed");
		inner();
		outer();
		assert.equal(currentLlmCall(), undefined, "an ended call is no longer current");
	});
	assert.deepEqual(counts(), zero);
});

test("child counts are replaced, never added; undefined forgets the child", () => {
	setChildCounts("w1", { active: 2, approximate: 0, claudeTurns: 1, degraded: false });
	setChildCounts("w1", { active: 2, approximate: 0, claudeTurns: 1, degraded: false });
	setChildCounts("w2", { active: 1, approximate: 1, claudeTurns: 0, degraded: true });
	assert.deepEqual(counts(), { active: 3, approximate: 1, claudeTurns: 1, degraded: true });
	setChildCounts("w1", { active: 0, approximate: 0, claudeTurns: 0, degraded: false });
	setChildCounts("w2", undefined);
	setChildCounts("w1", undefined);
	assert.deepEqual(counts(), zero);
});

test("degraded and Claude turns are reference counted", () => {
	const a = markDegraded("x");
	const b = markDegraded("x");
	a();
	a();
	assert.equal(snapshot().degraded, true);
	b();
	assert.equal(snapshot().degraded, false);
	const t1 = beginClaudeTurn();
	const t2 = beginClaudeTurn();
	assert.equal(snapshot().claudeTurns, 2);
	t1();
	t2();
	assert.deepEqual(counts(), zero);
});

test("parseCounts takes a child's report (object or JSON) and nothing else", () => {
	assert.deepEqual(parseCounts('{"v":1,"active":3,"approximate":5,"claudeTurns":1,"degraded":true}'), { active: 3, approximate: 3, claudeTurns: 1, degraded: true });
	assert.deepEqual(parseCounts({ v: 1, active: -1, approximate: "x" }), zero);
	assert.equal(parseCounts('{"v":2,"active":1}'), undefined);
	assert.equal(parseCounts("not json"), undefined);
	assert.equal(parseCounts(undefined), undefined);
	assert.equal(parseCounts("x".repeat(5000)), undefined);
});

test("one table per process, whichever copy of the module counts", async () => {
	// A second copy of the file, as jiti loads one per extension (and Sova's server its own).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-copy-"));
	const file = path.join(dir, "tracker.ts");
	fs.copyFileSync(new URL("./tracker.ts", import.meta.url), file);
	const copy = (await import(file)) as typeof import("./tracker.ts");
	assert.notEqual(copy.beginLlmCall, beginLlmCall, "really another module instance");
	const end = copy.beginLlmCall({ source: "runtime" });
	assert.equal(snapshot().active, 1);
	assert.equal(snapshot().producer, copy.snapshot().producer);
	end();
	fs.rmSync(dir, { recursive: true, force: true });
	assert.equal(snapshot().pid, process.pid);
	assert.equal(snapshot().v, 1);
});

test("counting is off until a runtime is instrumented", () => {
	// runtime.test.ts may have turned it on in this process already; it never turns off.
	if (!isCounting()) {
		let n = 0;
		const off = subscribe(() => n++);
		markCounting();
		off();
		assert.equal(n, 1, "a process that starts counting republishes");
	}
	assert.equal(isCounting(), true);
});

test("folded cap: children that fit are summed and named; the rest are neither, so no reader counts one twice", () => {
	// 70 children of 1 call each, one id apiece: 64 fit, 6 don't
	for (let i = 0; i < 70; i++) setChildCounts(`k${String(i).padStart(3, "0")}`, { active: 1, approximate: 0, claudeTurns: 0, degraded: false, producer: `c${i}` });
	const snap = snapshot();
	assert.equal(snap.folded.length, MAX_FOLDED);
	assert.equal(snap.active, MAX_FOLDED, "only the named children are in the count");
	assert.equal(snap.degraded, true);
	// every summed child is named, so its own record (if it writes one) is excluded; an unnamed one is
	// counted only from its own record: parent + children sum to 70, never more
	const named = new Set(snap.folded);
	const fromOwnRecords = Array.from({ length: 70 }, (_, i) => `c${i}`).filter((p) => !named.has(p)).length;
	assert.equal(snap.active + fromOwnRecords, 70);
	// stable: the same children fit on every snapshot
	assert.deepEqual(snapshot().folded, snap.folded);
	for (let i = 0; i < 70; i++) setChildCounts(`k${String(i).padStart(3, "0")}`, undefined);
	assert.deepEqual(counts(), zero);
	assert.equal(snapshot().degraded, false);
});

test("folded: every child producer counted here, transitively, so a reader never counts one twice", () => {
	assert.deepEqual(snapshot().folded, []);
	// parent ← child (which itself folded a grandchild)
	setChildCounts("w1", { active: 1, approximate: 0, claudeTurns: 0, degraded: false, producer: "child", folded: ["grandchild"] });
	setChildCounts("w2", parseCounts(JSON.stringify({ v: 1, producer: "other", active: 1, approximate: 0, claudeTurns: 0, degraded: false, folded: ["bad id!", "grandchild"] })));
	assert.deepEqual(snapshot().folded, ["child", "grandchild", "other"]);
	assert.equal(snapshot().active, 2);
	const many = Array.from({ length: 300 }, (_, i) => `p${i}`);
	setChildCounts("w3", { active: 5, approximate: 0, claudeTurns: 0, degraded: false, producer: "big", folded: many });
	assert.ok(snapshot().folded.length <= MAX_FOLDED, "bounded");
	assert.equal(snapshot().active, 2, "a child past the bound is not summed: its calls stay with its own records");
	assert.equal(snapshot().degraded, true, "and says it is missing some");
	setChildCounts("w1", undefined);
	setChildCounts("w2", undefined);
	setChildCounts("w3", undefined);
	assert.deepEqual(snapshot().folded, []);
	assert.deepEqual(counts(), zero);
});

import { MAX_SLOT_TOKENS, parseTokenRing, slotOf, TOKEN_BUCKET_MS, TOKEN_SLOTS } from "./tracker.ts";

const ring = (now: number) => snapshot(now).tokens;
const diff = (a: number[], b: number[]) => b.map((n, i) => n - (a[i] ?? 0));
const ringOf = (end: number, slots: Record<number, number>) => ({ bucketMs: TOKEN_BUCKET_MS, end, out: Array.from({ length: TOKEN_SLOTS }, (_, i) => slots[i] ?? 0) });

test("tokens: epoch-aligned slots; a call's tokens spread evenly back from its first event to its end, exactly", () => {
	const at = (slotOf(Date.now()) + 1) * TOKEN_BUCKET_MS - 1; // the current slot's last ms
	const before = ring(at).out;
	const r0 = ring(at);
	assert.equal(r0.end, slotOf(at));
	assert.equal(r0.bucketMs, 30_000);
	assert.equal(r0.out.length, 60);
	// 90 s of reply ending in slot `end`: 1/3 in each of the last three slots.
	const end = beginLlmCall({ source: "runtime" });
	end({ output: 301, since: at - 90_000 + 1, at });
	const d = diff(before, ring(at).out);
	assert.equal(d[56], 0);
	assert.ok(d.slice(57).every((n) => n === 100 || n === 101), "a third in each of its three slots");
	assert.equal(d.reduce((a, b) => a + b, 0), 301, "the shares add up to the call's tokens exactly");
	// A call without a first event (since absent): all at its end.
	const b2 = ring(at).out;
	beginLlmCall({ source: "runtime" })({ output: 5, at });
	assert.deepEqual(diff(b2, ring(at).out).slice(58), [0, 5]);
	// Older than 30 minutes: that part is gone.
	const b3 = ring(at).out;
	beginLlmCall({ source: "runtime" })({ output: 1000, since: at - 60 * 60_000, at });
	const d3 = diff(b3, ring(at).out);
	const kept = d3.reduce((a, b) => a + b, 0);
	assert.ok(kept >= 499 && kept <= 501 && d3.every((n) => n === 8 || n === 9), "only the last 30 minutes' share, evenly");
	// Ageing: 5 slots later the ring has moved, dropping the oldest.
	const later = ring(at + 5 * TOKEN_BUCKET_MS);
	assert.equal(later.end, slotOf(at) + 5);
	assert.deepEqual(later.out.slice(50, 55), ring(at).out.slice(55));
	assert.deepEqual(later.out.slice(55), [0, 0, 0, 0, 0]);
	// No tokens, no change; a waiting call's end with tokens is still one change.
	let n = 0;
	const off = subscribe(() => n++);
	beginLlmCall({ source: "runtime", pending: true })();
	assert.equal(n, 0);
	beginLlmCall({ source: "runtime", pending: true })({ output: 3 });
	assert.equal(n, 1);
	off();
});

test("tokens: a child's ring is summed (aligned), replaced not added, and folded into retired when it goes", () => {
	const now = Date.now();
	const s = slotOf(now);
	const base = ring(now).out;
	setChildCounts("tok-a", { ...zero, producer: "tok-a", tokens: ringOf(s - 1, { 59: 10, 58: 4 }) });
	assert.deepEqual(diff(base, ring(now).out).slice(57), [4, 10, 0], "aligned to this process's slot");
	let n = 0;
	const off = subscribe(() => n++);
	setChildCounts("tok-a", { ...zero, producer: "tok-a", tokens: ringOf(s, { 58: 10, 57: 4 }) });
	assert.equal(n, 0, "the same tokens a slot later: no change to publish");
	setChildCounts("tok-a", { ...zero, producer: "tok-a", tokens: ringOf(s, { 59: 6, 58: 10, 57: 4 }) });
	assert.equal(n, 1, "new tokens: one change");
	assert.deepEqual(diff(base, ring(now).out).slice(57), [4, 10, 6], "replaced, never added");
	setChildCounts("tok-a", undefined, { now });
	assert.deepEqual(diff(base, ring(now).out).slice(57), [4, 10, 6], "a child that goes leaves its tokens until they age out");
	assert.ok(ring(now + 60 * TOKEN_BUCKET_MS).out.every((n) => n === 0), "and then they are gone");
	off();
	// A detached child (retire: false): its tokens go with it, it reports them itself.
	const b2 = ring(now).out;
	setChildCounts("tok-b", { ...zero, producer: "tok-b", tokens: ringOf(s, { 59: 8 }) });
	setChildCounts("tok-b", undefined, { retire: false });
	assert.deepEqual(diff(b2, ring(now).out), new Array(60).fill(0));
	// A child that reports no ring: the tokens are partial while it is summed.
	setChildCounts("tok-c", { ...zero, producer: "tok-c" });
	assert.equal(ring(now).partial, true);
	setChildCounts("tok-c", undefined);
	assert.equal(ring(now).partial, undefined);
});

test("tokens: a child past the folded cap is not summed, nor retired; reported rings are bounded", () => {
	const now = Date.now();
	const s = slotOf(now);
	const many = Array.from({ length: MAX_FOLDED }, (_, i) => `tok-f${i}`);
	setChildCounts("!tok-x0", { ...zero, producer: "tok-x0", folded: many.slice(1) });
	const base = ring(now).out;
	setChildCounts("!tok-x1", { ...zero, producer: "tok-x1", tokens: ringOf(s, { 59: 77 }) });
	assert.deepEqual(diff(base, ring(now).out), new Array(60).fill(0), "over the cap: its tokens are not summed");
	setChildCounts("!tok-x1", undefined, { now });
	assert.deepEqual(diff(base, ring(now).out), new Array(60).fill(0), "nor kept when it goes");
	setChildCounts("!tok-x0", undefined);
	assert.equal(parseTokenRing({ bucketMs: 30_000, end: 5, out: new Array(59).fill(0) }), undefined, "60 slots or none");
	assert.equal(parseTokenRing({ bucketMs: 60_000, end: 5, out: new Array(60).fill(0) }), undefined);
	assert.equal(parseTokenRing({ bucketMs: 30_000, end: -1, out: new Array(60).fill(0) }), undefined);
	assert.equal(parseTokenRing({ bucketMs: 30_000, end: 5, out: new Array(60).fill(1e12) })!.out[0], MAX_SLOT_TOKENS, "each slot capped");
	assert.deepEqual(parseCounts(JSON.stringify({ v: 1, ...zero, tokens: ringOf(9, { 59: 3 }) }))!.tokens, ringOf(9, { 59: 3 }));
});
