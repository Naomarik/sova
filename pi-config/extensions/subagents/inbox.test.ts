import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InboxStore, MAIN_THREAD, SOVA, foldItemsFile, foldItemsText, isOpen, itemsFile, readMemberItems, readTeamInboxes, subjectOf } from "./inbox.ts";

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
