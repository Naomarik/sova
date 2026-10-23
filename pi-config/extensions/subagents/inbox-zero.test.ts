/**
 * Inbox zero (§app.teams/inbox-zero): the turn record and the safety net, end to end over a real
 * fold (a ChatWorker on the in-memory FakeWorkerHost, the host ordering the events) and the store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatWorker, sessionDirName } from "./chat-worker.ts";
import { FakeWorkerHost } from "./tests/fake-worker-host.ts";
import { InboxStore, type SeenTag } from "./inbox.ts";
import { wakeText } from "./delivery.ts";

const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PARENT = { sessionId: "parent-1", path: "/sessions/parent-1.jsonl" };

function rig() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-inbox-zero-"));
	const store = new InboxStore(root);
	const host = new FakeWorkerHost();
	const closedAt: string[][] = [];
	let worker!: ChatWorker;
	worker = new ChatWorker(
		{ id: "ag_02", groupId: "run_01", name: "dev", task: "build", cwd: "/work" },
		{
			onChange: () => {},
			// The manager's sweep: the task that just ended, steers resolved by the fold.
			onSettled: (w) => closedAt.push(store.closeSeen("ag_02", w.inboxTurn!().task, (no) => w.steerTask!(no)).map((i) => i.id)),
			onExit: () => {},
		},
		{ host, parent: PARENT, start: { key: "parent-1:ag_02:x.1", defaultSessionDir: (cwd) => `/agent/sessions/${sessionDirName(cwd)}` } },
	);
	store.steerTask = (_w, no) => worker.steerTask(no);
	const ev = (event: Record<string, unknown>) => host.event(worker.chatId!, event);
	const add = (subject: string, kind: "message" | "question" = "message") =>
		store.add({ teamId: "team_01", from: { role: "qa", workerId: "ag_03" }, to: { role: "dev", workerId: "ag_02" }, kind, body: subject, subject }).id;
	const status = (id: string) => [store.get(id)!.status, store.get(id)!.closedBy];
	/** What the wake host records for a wake taken now. */
	const wakeTag = (): SeenTag => {
		const t = worker.inboxTurn();
		return t.steer !== undefined ? { steer: t.steer } : { task: t.task };
	};
	return { root, store, host, worker, ev, add, status, wakeTag, closedAt, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("late-settle race: a wake accepted after the member's run ended but before its settle was handled is never closed by that settle", async () => {
	const r = rig();
	try {
		await flush();
		r.ev({ type: "agent_start" });
		const opened = r.add("FYI: CI is green");
		const fresh = r.add("Docs moved");
		// Opened during task 0.
		r.store.markSeen("ag_02", [opened], { task: r.worker.inboxTurn().task });
		// Run 0 ends; its settle has not been handled yet.
		r.ev({ type: "message_end", message: { role: "assistant", content: "done" } });
		r.ev({ type: "agent_end", messages: [] });
		assert.equal(r.worker.isSettled(), false);
		// The wake is accepted now (a single item: shown in full, so seen in the steer's task).
		const accepted = await r.worker.steer(wakeText([r.store.get(fresh)!]).text);
		assert.equal(accepted.ok, true);
		const tag = r.wakeTag();
		assert.ok("steer" in tag, "the steer's run has not begun: its task is not known yet");
		r.store.markSeen("ag_02", [fresh], tag);
		// The settle of run 0 is handled now: only what task 0 showed closes.
		r.ev({ type: "agent_settled" });
		assert.deepEqual(r.closedAt, [[opened]]);
		assert.deepEqual(r.status(opened), ["addressed", "auto"]);
		assert.equal(r.store.get(opened)!.note, "closed automatically: seen, not closed by dev");
		assert.deepEqual(r.status(fresh), ["read", undefined], "the wake belongs to the next turn");
		// The wake's run begins and ends: now it closes.
		r.ev({ type: "agent_start" });
		r.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "[Team inbox: 1 new]" }] } });
		r.ev({ type: "message_end", message: { role: "assistant", content: "ok" } });
		r.ev({ type: "agent_end", messages: [] });
		r.ev({ type: "agent_settled" });
		assert.deepEqual(r.closedAt.at(-1), [fresh]);
		assert.deepEqual(r.status(fresh), ["addressed", "auto"]);
	} finally { r.cleanup(); }
});

test("a mid-turn wake delivered inside the running run closes when that run ends; an idle member's wake closes at its own run's end", async () => {
	const r = rig();
	try {
		await flush();
		r.ev({ type: "agent_start" });
		const mid = r.add("urgent: stop the deploy");
		assert.equal((await r.worker.steer("[Team inbox: 1 new (1 urgent)]")).ok, true);
		r.store.markSeen("ag_02", [mid], r.wakeTag());
		// Pi delivers the steer at the next step of the same run.
		r.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "[Team inbox: 1 new (1 urgent)]" }] } });
		r.ev({ type: "agent_end", messages: [] });
		r.ev({ type: "agent_settled" });
		assert.deepEqual(r.status(mid), ["addressed", "auto"], "seen in the run that ended");
		// Idle now: a wake starts a new run.
		const idle = r.add("next task notes");
		assert.equal((await r.worker.steer("[Team inbox: 1 new]")).ok, true);
		r.store.markSeen("ag_02", [idle], r.wakeTag());
		r.ev({ type: "agent_start" });
		r.ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "[Team inbox: 1 new]" }] } });
		const q = r.add("Which port?", "question");
		r.store.markSeen("ag_02", [q], { task: r.worker.inboxTurn().task });
		r.ev({ type: "agent_end", messages: [] });
		r.ev({ type: "agent_settled" });
		assert.deepEqual(r.status(idle), ["addressed", "auto"]);
		assert.deepEqual(r.status(q), ["read", undefined], "a question is never closed automatically");
	} finally { r.cleanup(); }
});
