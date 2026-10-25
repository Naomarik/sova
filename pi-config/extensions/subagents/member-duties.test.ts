import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerMemberTools } from "./member.ts";
import { decodeMemberContext, decodeRequest, encodeMemberContext, initMemberDir, memberToolNames, takeRequests, writeResponse, type MemberContext } from "./mailbox.ts";

const base = (dir: string, extra: Partial<MemberContext> = {}): MemberContext =>
	({ version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_02", role: "dev", orchestrator: false, dir, ...extra });
const piTools = (me: MemberContext) => {
	const tools = new Map<string, any>();
	registerMemberTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, me, { timeoutMs: 2000, pollMs: 5 });
	return tools;
};
async function parentAnswers(dir: string, respond: (request: any) => { ok: boolean; text: string }) {
	for (let i = 0; i < 400; i++) {
		const [taken] = takeRequests(dir);
		if (taken?.request) {
			writeResponse(dir, { version: 1, id: taken.request.id, ...respond(taken.request) });
			return taken.request;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("no request appeared");
}

test("each duty gets its own tool set (every member, a Claude one included, loads member.ts); only the monitor has wake_nudge", () => {
	const dir = "/tmp/never-used";
	const cases: [string, Partial<MemberContext>, string[]][] = [
		["plain", {}, ["team_msg", "team_inbox", "team_ask"]],
		["coordinated worker", { coordinated: true }, ["team_msg", "team_inbox", "team_ask"]],
		["orchestrator", { orchestrator: true }, ["team_msg", "team_inbox", "team_ask", "team_roster", "team_steer"]],
		["coordinator", { orchestrator: true, duty: "coordinator" }, ["team_msg", "team_inbox", "team_ask", "team_roster", "team_steer", "team_report", "team_succeed"]],
		["monitor", { duty: "monitor", coordinated: true }, ["team_msg", "team_inbox", "team_roster", "wake_nudge"]],
		["monitor successor", { duty: "monitor", coordinated: true, successorOf: "monitor" }, ["team_msg", "team_inbox", "team_roster", "wake_nudge", "team_ready"]],
		["successor", { coordinated: true, successorOf: "dev" }, ["team_msg", "team_inbox", "team_ask", "team_ready"]],
		["coordinator successor", { orchestrator: true, duty: "coordinator", successorOf: "coordinator" }, ["team_msg", "team_inbox", "team_ask", "team_roster", "team_steer", "team_report", "team_succeed", "team_ready"]],
	];
	for (const [name, extra, expected] of cases) {
		const me = base(dir, extra);
		assert.deepEqual([...piTools(me).keys()].sort(), [...expected].sort(), `pi ${name}`);
		assert.deepEqual(memberToolNames(me).sort(), [...expected].sort(), `names ${name}`);
		assert.equal(memberToolNames(me).includes("wake_nudge"), extra.duty === "monitor", `${name}: wake_nudge only for the monitor`);
	}
	// The monitor's team_msg carries the notice enum; nobody else's does.
	const monitor = base(dir, { duty: "monitor" });
	assert.ok(piTools(monitor).get("team_msg").parameters.properties.notice);
	assert.equal(piTools(base(dir)).get("team_msg").parameters.properties.notice, undefined);
	// A successor monitor confirms its takeover like any successor, and its text names no note.
	const monitorSuccessor = base(dir, { duty: "monitor", coordinated: true, successorOf: "monitor" });
	assert.doesNotMatch(piTools(monitorSuccessor).get("team_ready").description, /handover note/);
	// A coordinated worker's team_ask says where the question goes.
	assert.match(piTools(base(dir, { coordinated: true })).get("team_ask").description, /coordinator \(not the operator/);
});

test("the identity carries duty, coordination and succession, strictly", () => {
	const me = base("/abs/dir", { duty: "monitor", coordinated: true, successorOf: "monitor" });
	assert.deepEqual(decodeMemberContext(encodeMemberContext(me)), me);
	assert.equal(decodeMemberContext(JSON.stringify({ ...me, duty: "boss" })), undefined);
	assert.equal(decodeMemberContext(JSON.stringify({ ...me, coordinated: "yes" })), undefined);
	assert.equal(decodeMemberContext(JSON.stringify({ ...me, successorOf: "a\nb" })), undefined);
	const plain = base("/abs/dir");
	assert.deepEqual(decodeMemberContext(encodeMemberContext(plain)), plain, "older identities decode unchanged");
});

test("new requests decode strictly: notices, nudges, report/succeed/ready", () => {
	const ok = (r: object) => decodeRequest({ version: 1, id: "abcdef12", at: 1, ...r });
	assert.deepEqual(ok({ type: "message", to: "lead", message: "m", notice: "pause" })?.notice, "pause");
	assert.equal(ok({ type: "message", to: "lead", message: "m", notice: "stop" }), undefined);
	assert.deepEqual(ok({ type: "nudge", nudge: { action: "schedule", delay: "5m", reason: "check" } })?.nudge, { action: "schedule", delay: "5m", reason: "check" });
	assert.equal(ok({ type: "nudge", nudge: { action: "snooze" } }), undefined);
	assert.equal(ok({ type: "nudge", nudge: { action: "schedule", delay: 5 } }), undefined);
	for (const type of ["report", "succeed", "ready"]) assert.equal(ok({ type })?.type, type);
	assert.equal(ok({ type: "report", message: "m", reportKind: "concern" })?.reportKind, "concern");
	assert.equal(ok({ type: "report", message: "m" })?.reportKind, undefined);
	assert.equal(ok({ type: "report", message: "m", reportKind: "blocker" }), undefined, "only milestone or concern");
});

test("contract: team_report takes an optional kind (milestone | concern) and sends it as reportKind", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-duties-"));
	try {
		const dir = path.join(root, "team_01", "ag_01");
		initMemberDir(dir);
		const me = base(dir, { workerId: "ag_01", role: "coordinator", orchestrator: true, duty: "coordinator" });
		const pi = piTools(me);
		assert.deepEqual(Object.keys(pi.get("team_report").parameters.properties), ["report", "kind"]);
		const piCall = pi.get("team_report").execute("id", { report: "Tests flaky.", kind: "concern" }, undefined, () => {}, {});
		const piRequest = await parentAnswers(dir, () => ({ ok: true, text: "Report shown" }));
		await piCall;
		const plainCall = pi.get("team_report").execute("id", { report: "Done." }, undefined, () => {}, {});
		const plainRequest = await parentAnswers(dir, () => ({ ok: true, text: "Report shown" }));
		await plainCall;
		assert.deepEqual([piRequest.type, piRequest.message, piRequest.reportKind], ["report", "Tests flaky.", "concern"]);
		assert.equal("reportKind" in plainRequest, false, "no kind: none sent");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
