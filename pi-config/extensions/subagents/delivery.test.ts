import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryLanes, WAKE_FOOTER, WakeScheduler, gatedIds, steerUntilTaken, wakeText, type LaneResult, type WakeHost, type WakeState } from "./delivery.ts";

import type { InboxItem } from "./inbox.ts";

const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

test("lane: deliveries to one worker run one at a time in order; both concurrent ones are accepted", async () => {
	const lanes = new DeliveryLanes();
	const order: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	// A worker with fold's single-steer guard: a second steer while one awaits acceptance is refused.
	let pending = false;
	const steer = async (name: string): Promise<LaneResult> => {
		if (pending) return { ok: false, reason: "another steer is still awaiting acceptance" };
		pending = true;
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		order.push(name);
		await new Promise((r) => setTimeout(r, 10));
		inFlight--;
		pending = false;
		return { ok: true };
	};
	const results = await Promise.all([lanes.run("ag_01", () => steer("a")), lanes.run("ag_01", () => steer("b")), lanes.run("ag_02", () => steer("other"))].slice(0, 2));
	assert.deepEqual(results.map((r) => r.ok), [true, true], "neither is refused for busyness");
	assert.deepEqual(order, ["a", "b"]);
	assert.equal(maxInFlight, 1);
	assert.equal(lanes.busy("ag_01"), false);
});

test("lane: a redirect goes ahead of queued entries, never ahead of the one in flight", async () => {
	const lanes = new DeliveryLanes();
	const order: string[] = [];
	const first = deferred<void>();
	const run = (name: string, gate?: Promise<void>) => async () => {
		order.push(`start ${name}`);
		await gate;
		return name;
	};
	const p1 = lanes.run("w", run("followUp-1", first.promise));
	const p2 = lanes.run("w", run("followUp-2"));
	const p3 = lanes.run("w", run("followUp-3"));
	const r1 = lanes.run("w", run("redirect-1"), { jump: true });
	const r2 = lanes.run("w", run("redirect-2"), { jump: true });
	await tick();
	assert.deepEqual(order, ["start followUp-1"], "the in-flight delivery is not cut off");
	assert.equal(lanes.queued("w"), 4);
	first.resolve();
	await Promise.all([p1, p2, p3, r1, r2]);
	assert.deepEqual(order, ["start followUp-1", "start redirect-1", "start redirect-2", "start followUp-2", "start followUp-3"]);
});

test("lane: a failing delivery does not block the next one", async () => {
	const lanes = new DeliveryLanes();
	await assert.rejects(lanes.run("w", async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await lanes.run("w", async () => "next"), "next");
});

test("steerUntilTaken waits out 'still starting' while live, and stops at a real refusal or when the worker ends", async () => {
	const answers: LaneResult[] = [{ ok: false, reason: "agent is still starting" }, { ok: false, reason: "another steer is still awaiting acceptance" }, { ok: true }];
	const sleeps: number[] = [];
	const sleep = async (ms: number) => { sleeps.push(ms); };
	assert.deepEqual(await steerUntilTaken(async () => answers.shift()!, () => true, { sleep }), { ok: true });
	assert.deepEqual(sleeps, [250, 500]);
	assert.equal((await steerUntilTaken(async () => ({ ok: false, reason: "agent process exited" }), () => true, { sleep })).reason, "agent process exited");
	let live = true;
	const ended = await steerUntilTaken(async () => { live = false; return { ok: false, reason: "agent is still starting" }; }, () => live, { sleep });
	assert.equal(ended.ok, false);
});

// ── Wake scheduler ─────────────────────────────────────────────────────────

let seq = 0;
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
	id: `i_${(++seq).toString(36)}`, teamId: "team_01", from: { role: "lead", workerId: "ag_01" }, to: { role: "dev", workerId: "ag_02" },
	kind: "message", urgent: false, subject: "hello", sentAt: 1, status: "new", ...over, body: over.body ?? over.subject ?? "hello",
});

function fakeHost(opts: { state?: WakeState; nextStep?: boolean; legacy?: boolean } = {}) {
	const items: InboxItem[] = [];
	const timers: { fn: () => void; ms: number; cleared?: boolean }[] = [];
	const sent: string[] = [];
	const retries: string[] = [];
	let answer: (() => Promise<LaneResult>) | undefined;
	const host = {
		state: opts.state ?? "idle" as WakeState,
		nextStep: opts.nextStep ?? true,
		legacy: opts.legacy ?? false,
	};
	const wake: WakeHost = {
		state: () => host.state,
		nextStep: () => host.nextStep,
		legacy: () => host.legacy,
		unlisted: () => items.filter((i) => i.status === "new" && i.listedAt === undefined),
		unread: () => items.filter((i) => i.status === "new"),
		markListed: (_w, ids) => { for (const i of items) if (ids.includes(i.id)) i.listedAt = 1; },
		markRead: (_w, ids) => { for (const i of items) if (ids.includes(i.id)) i.status = "read"; },
		deliver: async (_w, text) => {
			sent.push(text);
			return answer ? answer() : { ok: true };
		},
		legacyText: (_w, i) => `[full] ${i.body}`,
		retrying: (_w, attempt, reason) => { retries.push(`${attempt}:${reason}`); },
		setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
		clearTimer: (t) => { (t as { cleared?: boolean }).cleared = true; },
	};
	const fire = async (ms?: number) => {
		const live = timers.filter((t) => !t.cleared && (ms === undefined || t.ms === ms));
		for (const t of live) { t.cleared = true; t.fn(); }
		await tick();
	};
	return { items, timers, sent, retries, host, wake, fire, answerWith: (f: () => Promise<LaneResult>) => (answer = f) };
}

test("idle: normal items are gathered (~3 s) into one list; an urgent item wakes at once", async () => {
	const f = fakeHost();
	const s = new WakeScheduler(f.wake);
	f.items.push(item({ subject: "first", body: "first" }));
	s.notify("ag_02");
	f.items.push(item({ subject: "second", body: "second" }));
	s.notify("ag_02");
	assert.equal(f.sent.length, 0, "gathering");
	assert.deepEqual(f.timers.filter((t) => !t.cleared).map((t) => t.ms), [3000], "one debounce, not one per item");
	await f.fire(3000);
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0], /^\[Team inbox: 2 new — .*\]\n- i_\w+ message from lead — first\n- i_\w+ message from lead — second\n/);
	assert.deepEqual(f.items.map((i) => [i.status, i.listedAt]), [["new", 1], ["new", 1]], "two items: subjects only, nothing counts as opened");
	f.items.push(item({ urgent: true, subject: "now", body: "now" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 2, "urgent: no gathering");
	assert.match(f.sent[1], /^\[Team inbox: 3 new \(1 urgent\) — .*\]\n! i_\w+ message from lead — now\n- i_\w+ message from lead \(unopened\) — first\n/, "items listed before and still unopened come again, marked");
});

test("busy on the pi backend: urgent at its next step, normal at the turn's end; elsewhere urgent waits for the end too", async () => {
	const f = fakeHost({ state: "busy" });
	const s = new WakeScheduler(f.wake);
	f.items.push(item({ subject: "later" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 0, "a busy member is never interrupted for a normal item");
	assert.equal(f.timers.length, 0, "and nothing is timed: the turn's end lists it");
	f.items.push(item({ urgent: true, subject: "urgent one" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 1, "urgent: at its next step (a mid-turn steer)");
	assert.match(f.sent[0], /^\[Team inbox: 1 new \(1 urgent\) — [^\n]*\]\n! i_\w+ message from lead — urgent one\n\(Handle each item/, "only the urgent item mid-turn; the normal one waits for the turn's end");
	await tick();
	assert.equal(f.sent.length, 1, "the waiting normal item is not sent mid-turn after the urgent wake either");
	// Another normal item while busy: listed when the turn ends, at once (no gathering).
	f.items.push(item({ subject: "third" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 1);
	f.host.state = "idle";
	s.settled("ag_02");
	await tick();
	assert.equal(f.sent.length, 2);
	assert.match(f.sent[1], /^\[Team inbox: 2 new — .*\]\n- i_\w+ message from lead — later\n- i_\w+ message from lead — third\n/, "the turn's end lists every normal item that waited");
	// No next-step delivery on this backend: urgent waits for the turn's end too.
	const g = fakeHost({ state: "busy", nextStep: false });
	const s2 = new WakeScheduler(g.wake);
	g.items.push(item({ urgent: true }));
	s2.notify("ag_02");
	await tick();
	assert.equal(g.sent.length, 0);
	g.host.state = "idle";
	s2.settled("ag_02");
	await tick();
	assert.equal(g.sent.length, 1);
});

test("one wake in flight per member; items arriving meanwhile join the next list", async () => {
	const f = fakeHost();
	const s = new WakeScheduler(f.wake);
	const gate = deferred<LaneResult>();
	f.answerWith(() => gate.promise);
	f.items.push(item({ urgent: true, subject: "a" }));
	s.notify("ag_02");
	await tick();
	f.items.push(item({ urgent: true, subject: "b" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 1, "the second waits for the first");
	f.answerWith(async () => ({ ok: true }));
	f.host.state = "busy";
	gate.resolve({ ok: true });
	await tick();
	await tick();
	assert.equal(f.sent.length, 2);
	assert.match(f.sent[1], /^\[Team inbox: 1 new \(1 urgent\)[^\n]*\n! i_\w+ message from lead — b/, "only what is still new");
});

test("a failed wake keeps its items and is retried with backoff while live; the first failure is recorded once", async () => {
	const f = fakeHost();
	const s = new WakeScheduler(f.wake, { retryMs: [5000, 15000, 60000, 300000] });
	f.answerWith(async () => ({ ok: false, reason: "The worker's process did not start" }));
	f.items.push(item({ urgent: true }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 1);
	assert.deepEqual(f.retries, ["1:The worker's process did not start"]);
	assert.equal(f.items[0].listedAt, undefined, "still stored, not listed");
	const delays: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t = f.timers.filter((x) => !x.cleared).at(-1)!;
		delays.push(t.ms);
		// A new item meanwhile does not jump the backoff.
		s.notify("ag_02");
		await f.fire(t.ms);
	}
	assert.deepEqual(delays, [5000, 15000, 60000, 300000, 300000]);
	assert.equal(f.retries.length, 1, "recorded at the first failure only");
	f.answerWith(async () => ({ ok: true }));
	await f.fire();
	assert.equal(f.items[0].listedAt, 1, "taken at last");
	assert.equal(s.pending("ag_02").attempt, 0);
	// A member that ended is not retried.
	const g = fakeHost();
	const s2 = new WakeScheduler(g.wake);
	g.answerWith(async () => { g.host.state = "gone"; return { ok: false, reason: "agent process exited" }; });
	g.items.push(item({ urgent: true }));
	s2.notify("ag_02");
	await tick();
	assert.equal(g.timers.filter((t) => !t.cleared).length, 0);
});

test("legacy members (older code, no caps marker) get each item in full at once, busy or not", async () => {
	const f = fakeHost({ state: "busy", legacy: true });
	const s = new WakeScheduler(f.wake);
	f.items.push(item({ body: "one" }), item({ body: "two" }));
	s.notify("ag_02");
	await tick();
	await tick();
	assert.deepEqual(f.sent, ["[full] one", "[full] two"]);
	assert.deepEqual(f.items.map((i) => i.status), ["read", "read"]);
});

test("the list: at most 20 lines, urgent first, subjects only whatever the length, '… and M more'", () => {
	const items = [
		...Array.from({ length: 22 }, (_, i) => item({ subject: `s${i}`, body: `s${i}\nshort` })),
		item({ urgent: true, subject: "U", body: "U" }),
	];
	const { text, listed, full, unopened } = wakeText(items);
	const lines = text.split("\n");
	assert.match(lines[0], /^\[Team inbox: 23 new \(1 urgent\) — team_inbox open <ids> to read, done <ids> to mark addressed\]$/);
	assert.match(lines[1], /^! i_\w+ message from lead — U$/);
	assert.equal(listed.length, 20);
	assert.ok(text.includes("… and 3 more"));
	assert.deepEqual(full, [], "a member must open an item to see it: no body, however short");
	assert.ok(!text.includes("    short"));
	assert.equal(unopened.length, 20);
	assert.equal(lines.at(-1), WAKE_FOOTER);
	assert.doesNotMatch(text, /Open your inbox first/, "no gate unless asked");
});

test("the list: exactly one item is shown in full and counts as opened, however long", () => {
	const long = item({ subject: "report", body: `report\n${"y".repeat(5000)}` });
	const { text, full, unopened } = wakeText([long], { gate: true });
	assert.deepEqual(full, [long.id]);
	assert.deepEqual(unopened, []);
	assert.ok(text.includes(`    ${"y".repeat(5000)}`));
	assert.doesNotMatch(text, /Open your inbox first/, "a single-item wake never gates: it showed the item");
	const two = wakeText([item({ subject: "a" }), item({ subject: "b" })], { gate: true });
	assert.equal(two.full.length, 0);
	assert.match(two.text, /\n\[Open your inbox first: team_inbox open i_\w+ i_\w+ — other tools are refused until you open one\]\n/);
	assert.deepEqual(gatedIds(two.text), two.unopened);
	assert.equal(gatedIds(`quoted: ${two.text}`), undefined, "only a wake list itself");
});

test("the list: the Still open block names opened items, questions first, at most 5 lines inside the 20-line cap", () => {
	const fresh = Array.from({ length: 20 }, (_, i) => item({ subject: `n${i}` }));
	const opened = [item({ status: "read", subject: "m1" }), item({ status: "read", kind: "question", subject: "q1" })];
	const r = wakeText(fresh, { stillOpen: [opened[1], opened[0]] });
	const lines = r.text.split("\n");
	assert.equal(r.listed.length, 18, "two Still open lines take two of the 20 places");
	assert.ok(r.text.includes("… and 2 more"));
	const at = lines.indexOf("Still open (opened, not closed):");
	assert.deepEqual(lines.slice(at + 1, at + 3), [`- ${opened[1].id} question from lead — opened, not answered`, `- ${opened[0].id} message from lead — opened, not closed`]);
	const many = Array.from({ length: 8 }, () => item({ status: "read" }));
	const r2 = wakeText([item()], { stillOpen: many });
	assert.equal(r2.text.split("\n").filter((l) => /opened, not closed$/.test(l)).length, 4);
	assert.ok(r2.text.includes("… and 4 more"));
	// Never-listed items take the places first, so each wake lists every waiting item in turn.
	const old = Array.from({ length: 20 }, () => item({ listedAt: 1 }));
	const newer = item({ subject: "latest" });
	const r3 = wakeText([...old, newer]);
	assert.ok(r3.listed.includes(newer.id));
	assert.match(r3.text, /- i_\w+ message from lead \(unopened\) — hello/);
});

test("gate: only a wake that starts an idle member's turn carries the gate line, never one reaching a busy member mid-turn", async () => {
	const f = fakeHost();
	const opened = item({ status: "read", subject: "seen" });
	const s = new WakeScheduler({ ...f.wake, stillOpen: () => [opened] });
	f.items.push(item({ subject: "a" }), item({ subject: "b" }));
	s.notify("ag_02");
	await f.fire(3000);
	assert.match(f.sent[0], /\[Open your inbox first: team_inbox open i_\w+ i_\w+ /);
	assert.ok(f.sent[0].includes(`- ${opened.id} message from lead — opened, not closed`), "the Still open block names it");
	// Mid-turn (urgent to a busy member): never gated.
	f.host.state = "busy";
	f.items.push(item({ urgent: true, subject: "u1" }), item({ urgent: true, subject: "u2" }));
	s.notify("ag_02");
	await tick();
	assert.equal(f.sent.length, 2);
	assert.doesNotMatch(f.sent[1], /Open your inbox first/);
});
