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
