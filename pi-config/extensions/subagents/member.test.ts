import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import teamMemberExtension, { MEMBER_TOOLS, ORCHESTRATOR_TOOLS, registerMemberTools } from "./member.ts";
import { MEMBER_ENV, appendInbox, encodeMemberContext, initMemberDir, takeRequests, writeResponse, type MemberContext } from "./mailbox.ts";

function fakePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		pi: { registerTool: (t: any) => tools.set(t.name, t) } as any,
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
		process.env[MEMBER_ENV] = encodeMemberContext(s.me);
		const orchestrator = fakePi();
		teamMemberExtension(orchestrator.pi);
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

test("team_inbox reads delivered records newest-last without touching the mailbox", async () => {
	const s = setup(false);
	const h = fakePi();
	registerMemberTools(h.pi, s.me, { timeoutMs: 100, pollMs: 5 });
	try {
		assert.match((await h.call("team_inbox")).content[0].text, /No messages delivered/);
		appendInbox(s.dir, { at: 1, kind: "message", from: "lead", fromId: "ag_01", text: "first" });
		appendInbox(s.dir, { at: 2, kind: "instruction", from: "lead", fromId: "ag_01", text: "second" });
		const all = await h.call("team_inbox");
		assert.match(all.content[0].text, /^\[[^\]]+\] message from lead \(ag_01\):\nfirst\n\n\[[^\]]+\] instruction from lead \(ag_01\):\nsecond$/);
		assert.equal(all.details.count, 2);
		assert.deepEqual((await h.call("team_inbox", { limit: 1 })).details.records.map((r: any) => r.text), ["second"]);
		assert.deepEqual(takeRequests(s.dir), [], "reading the inbox sends nothing to the parent");
	} finally {
		s.cleanup();
	}
});
