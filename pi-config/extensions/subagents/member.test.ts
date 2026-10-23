import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import teamMemberExtension, { MEMBER_TOOLS, ORCHESTRATOR_TOOLS, registerInboxGate, registerMemberTools } from "./member.ts";
import { wakeText } from "./delivery.ts";
import type { InboxItem } from "./inbox.ts";

import { MEMBER_ENV, MESSAGE_LIMIT_TEXT, appendInbox, encodeMemberContext, initMemberDir, memberToolText, takeRequests, writeResponse, type MemberContext } from "./mailbox.ts";
import { hasInboxCaps } from "./inbox.ts";

function fakePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, ((e: any) => any)[]>();
	return {
		tools,
		handlers,
		emit: (name: string, event: any) => (handlers.get(name) ?? []).map((f) => f(event)).find((r) => r !== undefined),
		pi: { registerTool: (t: any) => tools.set(t.name, t), on: (name: string, f: (e: any) => any) => { handlers.set(name, [...(handlers.get(name) ?? []), f]); } } as any,
		call: (name: string, params: any = {}, signal?: AbortSignal) => tools.get(name).execute("id", params, signal, () => {}, {} as any),
	};
}
const setup = (orchestrator: boolean) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-member-test-"));
	const dir = path.join(root, "team_01", "ag_02");
	initMemberDir(dir);
	const me: MemberContext = { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_02", role: "dev", orchestrator, dir };
	return { root, dir, me, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};
/** Stand-in for the parent: answer the next request in the member's directory. */
async function parentAnswers(dir: string, respond: (request: any) => { ok: boolean; text: string; details?: unknown }) {
	for (let i = 0; i < 200; i++) {
		const [taken] = takeRequests(dir);
		if (taken?.request) {
			writeResponse(dir, { version: 1, id: taken.request.id, ...respond(taken.request) });
			return taken.request;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("no request appeared");
}

test("the default export is inert without a parent-issued identity and registers member-safe tools with one", () => {
	const saved = process.env[MEMBER_ENV];
	const s = setup(true);
	try {
		delete process.env[MEMBER_ENV];
		const none = fakePi();
		teamMemberExtension(none.pi);
		assert.equal(none.tools.size, 0);
		process.env[MEMBER_ENV] = "{broken";
		teamMemberExtension(none.pi);
		assert.equal(none.tools.size, 0, "a malformed identity registers nothing");
		assert.equal(hasInboxCaps(s.dir), false, "an inert load announces nothing");
		process.env[MEMBER_ENV] = encodeMemberContext(s.me);
		const orchestrator = fakePi();
		teamMemberExtension(orchestrator.pi);
		assert.equal(hasInboxCaps(s.dir), true, "a member on this code announces that it opens inboxes (caps.json)");
		assert.deepEqual([...orchestrator.tools.keys()].sort(), [...MEMBER_TOOLS, ...ORCHESTRATOR_TOOLS].sort());
		const plain = fakePi();
		registerMemberTools(plain.pi, { ...s.me, orchestrator: false });
		assert.deepEqual([...plain.tools.keys()].sort(), [...MEMBER_TOOLS].sort());
		// The recursion guard in words: no member tool can create, list, or stop workers.
		for (const name of orchestrator.tools.keys()) assert.doesNotMatch(name, /agent_|spawn|kill|create|add/);
		for (const tool of orchestrator.tools.values()) assert.equal(tool.parameters.additionalProperties, false);
	} finally {
		if (saved === undefined) delete process.env[MEMBER_ENV];
		else process.env[MEMBER_ENV] = saved;
		s.cleanup();
	}
});

test("tools write one request into the member's own directory and return the parent's answer", async () => {
	const s = setup(true);
	const h = fakePi();
	registerMemberTools(h.pi, s.me, { timeoutMs: 2000, pollMs: 5 });
	try {
		const answered = parentAnswers(s.dir, () => ({ ok: true, text: "Delivered", details: { deliveries: [{ to: "lead", ok: true }] } }));
		const result = await h.call("team_msg", { to: " lead ", message: "hello" });
		const request = await answered;
		assert.deepEqual([request.type, request.to, request.message], ["message", "lead", "hello"]);
		assert.equal(result.content[0].text, "Delivered");
		assert.deepEqual(result.details, { request: "message", deliveries: [{ to: "lead", ok: true }] });
		const steered = parentAnswers(s.dir, () => ({ ok: true, text: "Accepted" }));
		await h.call("team_steer", { to: "qa", message: "run tests", mode: "followUp" });
		assert.deepEqual((await steered).mode, "followUp");
		const roster = parentAnswers(s.dir, () => ({ ok: true, text: "team_01 — Crew" }));
		assert.equal((await h.call("team_roster")).content[0].text, "team_01 — Crew");
		assert.equal((await roster).type, "roster");
		const asked = parentAnswers(s.dir, () => ({ ok: true, text: "Surfaced" }));
		await h.call("team_ask", { question: "Which DB?" });
		assert.deepEqual([(await asked).type, (await asked).message], ["question", "Which DB?"]);
		// The inbox fields travel as written; the parent derives the sender, never the body.
		const queued = parentAnswers(s.dir, () => ({ ok: true, text: "Queued for lead (ag_01): item i_7" }));
		const sent = await h.call("team_msg", { to: "lead", message: "re: schema", subject: "Schema answer", urgent: true, replyTo: "i_3" });
		assert.equal(sent.content[0].text, "Queued for lead (ag_01): item i_7");
		const q = await queued;
		assert.deepEqual([q.subject, q.urgent, q.replyTo], ["Schema answer", true, "i_3"]);
		assert.equal(h.tools.get("team_msg").parameters.properties.replyTo.pattern, "^i_[0-9a-z]{1,12}$");
		for (const name of ["team_msg", "team_ask", "team_steer"]) assert.ok(h.tools.get(name).description.includes(MESSAGE_LIMIT_TEXT), `${name} states the 8,000-character limit`);
		// A negative response becomes a tool error with the parent's exact reason.
		void parentAnswers(s.dir, () => ({ ok: false, text: "No member with role ghost in team_01." }));
		await assert.rejects(h.call("team_msg", { to: "ghost", message: "x" }), /No member with role ghost/);
		await assert.rejects(h.call("team_msg", { to: "lead", message: "   " }), /must not be blank/);
		assert.deepEqual(takeRequests(s.dir), [], "a blank message never reaches the mailbox");
	} finally {
		s.cleanup();
	}
});

test("timeouts and cancellation report unknown handling instead of pretending success", async () => {
	const s = setup(false);
	const h = fakePi();
	registerMemberTools(h.pi, s.me, { timeoutMs: 60, pollMs: 5 });
	try {
		await assert.rejects(h.call("team_msg", { to: "lead", message: "hello" }), /No response from the parent session within 0s.*may still be handled/);
		assert.equal(takeRequests(s.dir).length, 1, "the request stays queued for the parent");
		const controller = new AbortController();
		const pending = h.call("team_ask", { question: "q" }, controller.signal);
		controller.abort();
		await assert.rejects(pending, /Cancelled while waiting/);
		await assert.rejects(h.call("team_ask", { question: "q" }, AbortSignal.abort()), /abort/i);
		assert.equal(h.tools.has("team_steer"), false);
	} finally {
		s.cleanup();
	}
});

test("team_inbox is a request the parent serves (it is the only writer); a parent on older code falls back to the delivered records", async () => {
	const s = setup(false);
	const h = fakePi();
	registerMemberTools(h.pi, s.me, { timeoutMs: 2000, inboxTimeoutMs: 80, pollMs: 5 });
	try {
		// list, open, done and sent each go to the parent, with their fields.
		for (const [params, want] of [
			[{}, { action: "list" }],
			[{ action: "open", ids: ["i_4", "i_5"] }, { action: "open", ids: ["i_4", "i_5"] }],
			[{ action: "done", ids: ["i_4"], note: " merged " }, { action: "done", ids: ["i_4"], note: "merged" }],
			[{ action: "sent", limit: 5 }, { action: "sent", limit: 5 }],
		] as const) {
			const served = parentAnswers(s.dir, () => ({ ok: true, text: "served" }));
			assert.equal((await h.call("team_inbox", params)).content[0].text, "served");
			const r = await served;
			assert.equal(r.type, "inbox");
			assert.deepEqual({ action: r.action, ...(r.ids ? { ids: r.ids } : {}), ...(r.note ? { note: r.note } : {}), ...(r.limit ? { limit: r.limit } : {}) }, want);
		}
		await assert.rejects(h.call("team_inbox", { action: "open" }), /needs ids/);
		assert.deepEqual(takeRequests(s.dir), [], "a refused call never reaches the mailbox");
		// No answer (a parent on older code drops the unknown request): list shows the delivered copies.
		assert.match((await h.call("team_inbox")).content[0].text, /No messages delivered/);
		appendInbox(s.dir, { at: 1, kind: "message", from: "lead", fromId: "ag_01", text: "first" });
		appendInbox(s.dir, { at: 2, kind: "instruction", from: "lead", fromId: "ag_01", text: "second" });
		const all = await h.call("team_inbox");
		assert.match(all.content[0].text, /^\[[^\]]+\] message from lead \(ag_01\):\nfirst\n\n\[[^\]]+\] instruction from lead \(ag_01\):\nsecond$/);
		assert.equal(all.details.legacy, true);
		assert.deepEqual((await h.call("team_inbox", { limit: 1 })).details.records.map((r: any) => r.text), ["second"]);
		// open/done have no legacy form: no answer is an error, never a guess.
		await assert.rejects(h.call("team_inbox", { action: "done", ids: ["i_1"] }), /No response from the parent session/);
		assert.match(memberToolText(s.me).team_inbox, /served by the parent session/);
	} finally {
		s.cleanup();
	}
});

test("inbox gate (§app.teams/inbox-gate): a gated wake that starts the turn refuses other tools until an item is opened; an instruction lifts it", () => {
	const h = fakePi();
	const gate = registerInboxGate(h.pi);
	const it = (id: string): InboxItem => ({ id, teamId: "team_01", from: { role: "lead", workerId: "ag_01" }, to: { role: "dev", workerId: "ag_02" }, kind: "message", urgent: false, subject: id, body: id, sentAt: 1, status: "new" });
	const gated = wakeText([it("i_4"), it("i_5")], { gate: true }).text;
	const user = (text: string) => ({ message: { role: "user", content: [{ type: "text", text }] } });
	const call = (toolName: string, input: any = {}) => h.emit("tool_call", { toolName, input });
	// A turn started by a gated wake.
	h.emit("agent_start", {});
	h.emit("message_end", user(gated));
	assert.deepEqual(gate.state(), ["i_4", "i_5"]);
	assert.deepEqual(call("bash", { command: "ls" }), { block: true, reason: "Open your inbox first (team_inbox open i_4 i_5)" });
	for (const name of ["team_msg", "team_ask"]) assert.equal(call(name), undefined, `${name} stays allowed`);
	assert.equal(call("team_inbox", { action: "list" }), undefined, "team_inbox stays allowed");
	assert.ok(call("read"), "listing is not opening: still gated");
	assert.equal(call("team_inbox", { action: "open", ids: ["i_5"] }), undefined);
	assert.equal(call("bash"), undefined, "opened one item: the gate lifts");
	// The turn ends; the next turn starts with something else: no gate.
	h.emit("agent_end", {});
	h.emit("agent_start", {});
	h.emit("message_end", user("[Instruction from orchestrator lead (ag_01), team_01]\nRun the tests"));
	assert.equal(call("bash"), undefined, "a turn started by anything else is never gated");
	// A direct instruction mid-turn lifts the gate; a mid-turn wake never sets it.
	h.emit("agent_start", {});
	h.emit("message_end", user(gated));
	assert.ok(call("bash"));
	h.emit("message_end", user("Please run pnpm test now"));
	assert.equal(call("bash"), undefined, "nothing a direct instruction asks for is refused");
	h.emit("agent_start", {});
	h.emit("message_end", user("[Instruction] start"));
	h.emit("message_end", user(gated));
	assert.equal(call("bash"), undefined, "a wake reaching a busy member mid-turn never gates");
	// An ungated wake (setting off, or a single item shown in full) never gates.
	h.emit("agent_start", {});
	h.emit("message_end", user(wakeText([it("i_6"), it("i_7")]).text));
	assert.equal(call("bash"), undefined);
});
