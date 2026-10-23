import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InboxStore, MAIN_THREAD, SOVA, closedByOf, foldItemsFile, foldItemsText, isOpen, itemsFile, readMemberItems, readTeamInboxes, subjectOf } from "./inbox.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-inbox-"));
const dev = { role: "dev", workerId: "ag_02" };
const lead = { role: "lead", workerId: "ag_01" };
const dev2 = { role: "dev-2", workerId: "ag_05" };

test("ids are unique and increasing across the whole main chat, and survive a new store over the same root", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root);
		const a = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "one" });
		const b = s.add({ teamId: "team_02", from: { role: "x", workerId: "ag_09" }, to: { role: "y", workerId: "ag_10" }, kind: "message", body: "two" });
		const c = s.add({ teamId: "team_01", from: dev, to: lead, kind: "question", body: "three" });
		assert.deepEqual([a.id, b.id, c.id], ["i_1", "i_2", "i_3"], "one sequence for every team and member");
		const again = new InboxStore(root);
		assert.equal(again.add({ teamId: "team_01", from: SOVA, to: dev, kind: "notice", body: "four" }).id, "i_4", "never reused after a reload");
		assert.deepEqual(again.list("ag_02").map((i) => [i.id, i.from.role, i.status]), [["i_1", "lead", "new"], ["i_4", "Sova", "new"]]);
		assert.deepEqual([...readTeamInboxes(root, "team_01").keys()], ["ag_01", "ag_02"]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("subjects are one line of at most 120 characters, defaulting to the first non-blank line", () => {
	assert.equal(subjectOf("\n\n  Hello world  \nmore"), "Hello world");
	assert.equal(subjectOf("body", " Given\tsubject\u0007 "), "Given subject");
	assert.equal(subjectOf("x".repeat(300)).length, 120);
	assert.equal(subjectOf("   "), "(no subject)");
});

test("the fold skips torn and unknown lines, and a missing file is an empty inbox", () => {
	const root = tmp();
	try {
		assert.equal(foldItemsFile(path.join(root, "nope", "items.jsonl")).size, 0);
		const s = new InboxStore(root);
		s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "kept" });
		const file = itemsFile(path.join(root, "team_01", "ag_02"));
		fs.appendFileSync(file, '{"v":1,"op":"status","id":"i_1","status":"read","at":5}\n{"v":1,"op":"add","item":{"id":"i_9"\n{"v":2,"op":"add"}\nnot json\n');
		const items = readMemberItems(path.join(root, "team_01", "ag_02"));
		assert.deepEqual(items.map((i) => [i.id, i.status, i.readAt]), [["i_1", "read", 5]]);
		assert.equal(foldItemsText('{"v":1,"op":"add","item":{"id":"bad"}}').size, 0, "a malformed item is never adopted");
		// The torn tail does not stop the next append from being read.
		const s2 = new InboxStore(root);
		s2.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "after" });
		assert.deepEqual(readMemberItems(path.join(root, "team_01", "ag_02")).map((i) => i.body), ["kept", "after"]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("statuses go new → read → addressed (or straight to addressed); instructions and returned items are never open", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root);
		const m = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "do x" });
		const hist = s.add({ teamId: "team_01", from: MAIN_THREAD, to: dev, kind: "instruction", body: "steer", status: "read" });
		assert.equal(isOpen(hist), false);
		assert.equal(s.openCount("ag_02"), 1);
		assert.deepEqual(s.setStatus("ag_02", [m.id], "read").map((r) => r.ok), [true]);
		assert.equal(s.get(m.id)!.status, "read");
		const done = s.setStatus("ag_02", [m.id, "i_99", hist.id], "addressed", "done\nin #3");
		assert.deepEqual(done.map((r) => [r.id, r.ok]), [[m.id, true], ["i_99", false], [hist.id, false]]);
		assert.equal(s.get(m.id)!.note, "done in #3", "a one-line note");
		assert.equal(s.setStatus("ag_02", [m.id], "read")[0].item!.status, "addressed", "read never undoes addressed");
		assert.equal(s.openCount("ag_02"), 0);
		const q = s.add({ teamId: "team_01", from: lead, to: dev, kind: "question", body: "?" });
		assert.equal(s.setStatus("ag_01", [q.id], "addressed")[0].ok, false, "only the holder marks an item");
		const back = s.returnItem(q.id, "dev stopped");
		assert.ok(back?.returned);
		assert.equal(isOpen(s.get(q.id)!), false);
		assert.equal(s.returnItem(q.id, "again"), undefined, "returned once");
		// Everything persisted: a fresh fold agrees.
		const again = new InboxStore(root);
		assert.deepEqual(again.list("ag_02").map((i) => [i.id, i.status, Boolean(i.returned)]), [["i_1", "addressed", false], ["i_2", "read", false], ["i_3", "new", true]]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a moved item keeps its id, sender and status, leaves the old inbox, records the move, and lookups follow it", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root);
		const q = s.add({ teamId: "team_01", from: lead, to: dev, kind: "question", body: "which schema?" });
		const other = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "fyi" });
		s.markListed("ag_02", [q.id, other.id]);
		s.setStatus("ag_02", [q.id], "read");
		s.setStatus("ag_02", [other.id], "addressed");
		const moved = s.moveOpen("ag_02", dev2, "handover");
		assert.deepEqual(moved.map((i) => i.id), [q.id], "only open items move");
		assert.deepEqual(moved[0].from, lead);
		assert.deepEqual(moved[0].to, dev2);
		assert.equal(moved[0].listedAt, undefined, "listed again to its new holder");
		assert.deepEqual([moved[0].status, moved[0].readAt], ["new", undefined], "read by the old holder, new to the successor");
		assert.deepEqual(moved[0].movedFrom?.map((m) => [m.workerId, m.why]), [["ag_02", "handover"]]);
		assert.equal(s.holderOf(q.id), "ag_05");
		assert.deepEqual(s.list("ag_02").map((i) => i.id), [other.id], "it left the old inbox");
		assert.deepEqual(s.unlisted("ag_05").map((i) => i.id), [q.id]);
		assert.deepEqual(s.sentBy("ag_01").map((i) => [i.id, i.to.workerId]), [[q.id, "ag_02"], [other.id, "ag_02"]].map(([id, w]) => [id, id === q.id ? "ag_05" : w]));
		const reload = new InboxStore(root);
		assert.equal(reload.holderOf(q.id), "ag_05");
		assert.equal(reload.get(q.id)!.status, "new", "persisted in the destination's add");
		assert.deepEqual(readMemberItems(path.join(root, "team_01", "ag_02")).map((i) => i.id), [other.id]);
		// A move torn after its first write (the destination add) keeps the newer holder.
		const t = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "torn" });
		const fake = { ...s.get(t.id)!, to: dev2, movedFrom: [{ workerId: "ag_02", role: "dev", at: 1, why: "handover" as const }] };
		fs.appendFileSync(itemsFile(path.join(root, "team_01", "ag_05")), `${JSON.stringify({ v: 1, op: "add", item: fake })}\n`);
		assert.equal(new InboxStore(root).holderOf(t.id), "ag_05");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("compaction keeps every open item and the newest addressed ones, and never lets an id come back", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root, { keepClosed: 3 });
		const open = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "keep me" });
		for (let i = 0; i < 6; i++) {
			const it = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: `m${i}` });
			s.setStatus("ag_02", [it.id], "addressed");
		}
		s.compact("ag_02");
		assert.deepEqual(readMemberItems(path.join(root, "team_01", "ag_02")).map((i) => i.body), ["keep me", "m3", "m4", "m5"]);
		assert.equal(s.get(open.id)!.status, "new");
		// Drop the newest too (a returned item past the window) and reload: the next id is still new.
		const before = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "last" });
		s.setStatus("ag_02", [before.id], "addressed");
		const tiny = new InboxStore(root, { keepClosed: 0 });
		tiny.compact("ag_02");
		assert.deepEqual(readMemberItems(path.join(root, "team_01", "ag_02")).map((i) => i.body), ["keep me"]);
		assert.equal(new InboxStore(root).add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "next" }).id, `i_${(parseInt(before.id.slice(2), 36) + 1).toString(36)}`);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── Inbox zero (§app.teams/inbox-zero) ──────────

test("closedBy: written on the status op, folded from disk, kept by compaction; an old addressed line reads as closed by the member", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root, { keepClosed: 10 });
		const a = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "one" });
		const b = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "two" });
		const c = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "three" });
		s.setStatus("ag_02", [a.id], "addressed", "merged");
		s.setStatus("ag_02", [b.id], "addressed", "answered in i_9", "reply");
		s.markSeen("ag_02", [c.id], { task: 0 });
		assert.deepEqual(s.closeSeen("ag_02", 0).map((i) => i.id), [c.id]);
		const fold = () => readMemberItems(path.join(root, "team_01", "ag_02")).map((i) => [i.id, i.status, i.closedBy, closedByOf(i)]);
		const want = [[a.id, "addressed", "member", "member"], [b.id, "addressed", "reply", "reply"], [c.id, "addressed", "auto", "auto"]];
		assert.deepEqual(fold(), want);
		s.compact("ag_02");
		assert.deepEqual(fold(), want, "compaction rewrites items as add ops and keeps closedBy");
		assert.deepEqual(new InboxStore(root).list("ag_02").map((i) => i.closedBy), ["member", "reply", "auto"]);
		const old = foldItemsText(`${JSON.stringify({ v: 1, op: "add", item: { ...a, status: "new" } })}\n${JSON.stringify({ v: 1, op: "status", id: a.id, status: "addressed", at: 5 })}\n`).get(a.id)!;
		assert.equal(old.closedBy, undefined);
		assert.equal(closedByOf(old), "member", "older lines: Addressed, closed by the member");
		assert.deepEqual(s.closedCounts("team_01"), { member: 1, reply: 1, auto: 1, byWorker: new Map([["ag_02", { member: 1, reply: 1, auto: 1 }]]) });
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("closeSeen: only seen, open, non-question items with a turn record, seen in a task that has ended", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root);
		const mk = (kind: "message" | "question" | "report" | "notice" = "message") => s.add({ teamId: "team_01", from: lead, to: dev, kind, body: kind }).id;
		const seen0 = mk(), report0 = mk("report"), notice0 = mk("notice"), question0 = mk("question"), unseen = mk(), seen1 = mk(), pending = mk(), returned = mk();
		s.markSeen("ag_02", [seen0, report0, notice0, question0, returned], { task: 0 });
		s.markSeen("ag_02", [seen1], { task: 1 });
		s.markSeen("ag_02", [pending], { steer: 7 });
		s.returnItem(returned, "not addressed: stopped");
		const resolver = (no: number) => (no === 7 ? undefined : 0);
		assert.deepEqual(s.closeSeen("ag_02", 0, resolver).map((i) => i.id), [seen0, report0, notice0]);
		const st = (id: string) => s.get(id)!.status;
		assert.deepEqual([st(question0), st(unseen), st(seen1), st(pending)], ["read", "new", "read", "read"], "never a question, an unseen item, a later task, a wake whose run has not begun");
		assert.equal(s.get(returned)!.closedBy, undefined, "a returned item is not open: never closed");
		// The steer's run began in task 1: it closes when task 1 ends.
		assert.deepEqual(s.closeSeen("ag_02", 1, () => 1).map((i) => i.id), [seen1, pending]);
		// Read before this change: no turn record, never closed automatically, even at the member's end.
		const pre = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "old" }).id;
		s.setStatus("ag_02", [pre], "read");
		assert.deepEqual(s.closeSeen("ag_02", 99), []);
		assert.deepEqual(s.closeSeen("ag_02", "all"), []);
		assert.ok(s.stillOpen("ag_02").some((i) => i.id === pre), "it is named in Still open instead");
		assert.equal(s.stillOpen("ag_02")[0].id, question0, "questions first");
		// Opened again now, it gets its record.
		s.markSeen("ag_02", [pre], { task: 5 });
		assert.deepEqual(s.closeSeen("ag_02", 5).map((i) => i.id), [pre]);
		// After a reload, an item seen with a record (from before it) closes at the next settle.
		const later = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "later" }).id;
		s.markSeen("ag_02", [later], { task: 40 });
		const again = new InboxStore(root);
		assert.equal(again.get(later)!.readTurn, 40);
		assert.deepEqual(again.closeSeen("ag_02", 0).map((i) => i.id), [later]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a moved item loses its turn record (its new holder has seen nothing)", () => {
	const root = tmp();
	try {
		const s = new InboxStore(root);
		const a = s.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "one" }).id;
		s.markSeen("ag_02", [a], { task: 0 });
		const moved = s.move(a, dev2, "handover")!;
		assert.deepEqual([moved.status, moved.readTurn], ["new", undefined]);
		assert.deepEqual(s.closeSeen("ag_05", 9), []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
