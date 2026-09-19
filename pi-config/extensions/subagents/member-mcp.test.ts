import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MEMBER_TOOLS, ORCHESTRATOR_TOOLS, createMemberMcpServer, mcpToolName, memberMcpTools, serveMemberMcp } from "./member-mcp.ts";
import { MEMBER_ENV, appendInbox, encodeMemberContext, initMemberDir, takeRequests, writeResponse, type MemberContext } from "./mailbox.ts";
import { MEMBER_TOOLS as PI_MEMBER_TOOLS, ORCHESTRATOR_TOOLS as PI_ORCHESTRATOR_TOOLS } from "./member.ts";
import { PassThrough } from "node:stream";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "member-mcp.ts");
const setup = (orchestrator: boolean) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-member-mcp-test-"));
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
const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const callTool = (id: number, name: string, args?: unknown) => rpc(id, "tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });

test("the server speaks the MCP handshake, lists member tools per identity, and exposes the same surface as member.ts", async () => {
	const s = setup(true);
	try {
		const server = createMemberMcpServer(s.me);
		const init = await server.handle(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude", version: "x" } }));
		assert.equal(init!.id, 1);
		const result = init!.result as any;
		assert.equal(result.protocolVersion, "2024-11-05", "a known client version is echoed");
		assert.deepEqual(result.capabilities, { tools: {} });
		assert.equal(typeof result.serverInfo.name, "string");
		assert.match(result.instructions, /dev \(ag_02\) in team_01/);
		const unknownVersion = (await server.handle(rpc(2, "initialize", { protocolVersion: "1999-01-01" })))!.result as any;
		assert.equal(unknownVersion.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined, "notifications get no response");
		assert.deepEqual(await server.handle(rpc(3, "ping")), { jsonrpc: "2.0", id: 3, result: {} });
		const missing = await server.handle(rpc(4, "resources/list"));
		assert.equal(missing!.error!.code, -32601);
		assert.equal((await server.handleLine("{broken"))!.error!.code, -32700);
		assert.equal((await server.handle({ id: 5, method: "ping" }))!.error!.code, -32600, "jsonrpc 2.0 is required");
		assert.equal(await server.handleLine("   "), undefined);
		// Tool listing follows the identity: orchestrators get the sibling powers, nobody gets spawn/kill.
		const listed = ((await server.handle(rpc(6, "tools/list")))!.result as any).tools;
		assert.deepEqual(listed.map((t: any) => t.name), [...MEMBER_TOOLS, ...ORCHESTRATOR_TOOLS]);
		assert.deepEqual([...MEMBER_TOOLS], [...PI_MEMBER_TOOLS]);
		assert.deepEqual([...ORCHESTRATOR_TOOLS], [...PI_ORCHESTRATOR_TOOLS]);
		for (const tool of listed) {
			assert.doesNotMatch(tool.name, /agent_|spawn|kill|create|add/);
			assert.equal(tool.inputSchema.type, "object");
			assert.equal(tool.inputSchema.additionalProperties, false);
			assert.ok(tool.description.length > 20);
		}
		assert.deepEqual(memberMcpTools({ ...s.me, orchestrator: false }).map((t) => t.name), [...MEMBER_TOOLS]);
		assert.equal(mcpToolName("team_msg"), `mcp__${MCP_SERVER_NAME}__team_msg`);
		assert.equal(MCP_SERVER_NAME, "team", "the header text and the runner's allow rule depend on this name");
	} finally {
		s.cleanup();
	}
});

test("tools/call writes one request into the member's own directory and returns the parent's answer or its refusal", async () => {
	const s = setup(true);
	const server = createMemberMcpServer(s.me, { timeoutMs: 2000, pollMs: 5 });
	try {
		const answered = parentAnswers(s.dir, () => ({ ok: true, text: "Delivered", details: { deliveries: [{ to: "lead", ok: true }] } }));
		const result = (await server.handle(callTool(1, "team_msg", { to: " lead ", message: "hello" })))!.result as any;
		const request = await answered;
		assert.deepEqual([request.type, request.to, request.message], ["message", "lead", "hello"]);
		assert.deepEqual(result, { content: [{ type: "text", text: "Delivered" }] });
		const steered = parentAnswers(s.dir, () => ({ ok: true, text: "Accepted" }));
		assert.equal(((await server.handle(callTool(2, "team_steer", { to: "qa", message: "run tests", mode: "followUp" })))!.result as any).content[0].text, "Accepted");
		assert.deepEqual((await steered).mode, "followUp");
		const roster = parentAnswers(s.dir, () => ({ ok: true, text: "team_01 — Crew" }));
		assert.equal(((await server.handle(callTool(3, "team_roster")))!.result as any).content[0].text, "team_01 — Crew");
		assert.equal((await roster).type, "roster");
		const asked = parentAnswers(s.dir, () => ({ ok: true, text: "Surfaced" }));
		await server.handle(callTool(4, "team_ask", { question: "Which DB?" }));
		assert.deepEqual([(await asked).type, (await asked).message], ["question", "Which DB?"]);
		// A negative response becomes a tool error (isError, never a protocol error) with the parent's exact reason.
		void parentAnswers(s.dir, () => ({ ok: false, text: "No member with role ghost in team_01." }));
		const refused = (await server.handle(callTool(5, "team_msg", { to: "ghost", message: "x" })))!.result as any;
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /No member with role ghost/);
		// Argument validation happens before anything reaches the mailbox.
		for (const [name, args, pattern] of [
			["team_msg", { to: "lead", message: "   " }, /message must be a non-blank string/],
			["team_msg", { message: "x" }, /to must be a non-blank string/],
			["team_msg", { to: "lead", message: "x".repeat(8001) }, /exceeds 8000/],
			["team_steer", { to: "qa", message: "x", mode: "now" }, /mode must be redirect or followUp/],
			["team_inbox", { limit: 0 }, /limit must be an integer/],
			["agent_spawn", { prompt: "x" }, /Unknown tool: agent_spawn/],
		] as const) {
			const bad = (await server.handle(callTool(9, name, args)))!.result as any;
			assert.equal(bad.isError, true, name);
			assert.match(bad.content[0].text, pattern);
		}
		assert.deepEqual(takeRequests(s.dir), [], "invalid calls never reach the mailbox");
		assert.equal((await server.handle(rpc(10, "tools/call", { arguments: {} })))!.error!.code, -32602);
		assert.equal((await server.handle(callTool(11, "team_msg", "nope")))!.error!.code, -32602);
	} finally {
		s.cleanup();
	}
});

test("non-orchestrators cannot reach the sibling powers, timeouts admit unknown handling, and cancellation aborts a wait", async () => {
	const s = setup(false);
	const server = createMemberMcpServer(s.me, { timeoutMs: 60, pollMs: 5 });
	try {
		const steer = (await server.handle(callTool(1, "team_steer", { to: "lead", message: "x" })))!.result as any;
		assert.equal(steer.isError, true);
		assert.match(steer.content[0].text, /Unknown tool: team_steer/);
		assert.equal(((await server.handle(callTool(2, "team_roster")))!.result as any).isError, true);
		assert.deepEqual(takeRequests(s.dir), []);
		const timedOut = (await server.handle(callTool(3, "team_msg", { to: "lead", message: "hello" })))!.result as any;
		assert.equal(timedOut.isError, true);
		assert.match(timedOut.content[0].text, /No response from the parent session within 0s.*may still be handled/);
		assert.equal(takeRequests(s.dir).length, 1, "the request stays queued for the parent");
		const slow = createMemberMcpServer(s.me, { timeoutMs: 5000, pollMs: 5 });
		const pending = slow.handle(callTool("abc", "team_ask", { question: "q" }));
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(slow.pending(), 1);
		await slow.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "abc" } });
		const cancelled = (await pending)!.result as any;
		assert.equal(cancelled.isError, true);
		assert.match(cancelled.content[0].text, /Cancelled while waiting/);
		assert.equal(slow.pending(), 0);
	} finally {
		s.cleanup();
	}
});

test("team_inbox reads delivered records newest-last without touching the mailbox", async () => {
	const s = setup(false);
	const server = createMemberMcpServer(s.me, { timeoutMs: 100, pollMs: 5 });
	try {
		const text = async (args?: unknown) => ((await server.handle(callTool(1, "team_inbox", args)))!.result as any).content[0].text as string;
		assert.match(await text(), /No messages delivered/);
		appendInbox(s.dir, { at: 1, kind: "message", from: "lead", fromId: "ag_01", text: "first" });
		appendInbox(s.dir, { at: 2, kind: "instruction", from: "lead", fromId: "ag_01", text: "second" });
		assert.match(await text(), /^\[[^\]]+\] message from lead \(ag_01\):\nfirst\n\n\[[^\]]+\] instruction from lead \(ag_01\):\nsecond$/);
		assert.match(await text({ limit: 1 }), /^\[[^\]]+\] instruction from lead \(ag_01\):\nsecond$/);
		assert.deepEqual(takeRequests(s.dir), [], "reading the inbox sends nothing to the parent");
	} finally {
		s.cleanup();
	}
});

test("the stdio transport frames newline-delimited JSON, answers requests concurrently and ends with the input", async () => {
	const s = setup(false);
	try {
		const input = new PassThrough();
		const output = new PassThrough();
		let out = "";
		output.on("data", (chunk) => { out += String(chunk); });
		const served = serveMemberMcp(s.me, input, output, { timeoutMs: 2000, pollMs: 5 });
		input.write(`${JSON.stringify(rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION }))}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		// A slow tool call must not block the ping that arrives after it.
		input.write(`${JSON.stringify(callTool(2, "team_msg", { to: "lead", message: "hi" }))}\n`);
		input.write(`${JSON.stringify(rpc(3, "ping"))}\nnot json\n`);
		await new Promise((r) => setTimeout(r, 30));
		const before = out.trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(before.map((r) => r.id).sort(), [1, 3, null].sort(), "the slow call has not answered yet; the rest have");
		assert.equal(before.find((r) => r.id === null).error.code, -32700);
		await parentAnswers(s.dir, () => ({ ok: true, text: "Delivered" }));
		await new Promise((r) => setTimeout(r, 30));
		const lines = out.trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(lines.at(-1), { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Delivered" }] } });
		input.end();
		await served;
	} finally {
		s.cleanup();
	}
});

test("as a process, the server runs directly under the current runtime with the identity from its environment and refuses to run without one", async () => {
	const s = setup(true);
	try {
		const run = (env: NodeJS.ProcessEnv, lines: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = ""; let stderr = "";
			child.stdout.on("data", (c) => { stdout += String(c); });
			child.stderr.on("data", (c) => { stderr += String(c); });
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stdout, stderr }));
			child.stdin.end(lines.map((l) => `${l}\n`).join(""));
		});
		const { CLAUDECODE: _c, ...env } = process.env;
		const ok = await run({ ...env, [MEMBER_ENV]: encodeMemberContext(s.me) }, [JSON.stringify(rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION })), JSON.stringify(rpc(2, "tools/list"))]);
		assert.equal(ok.code, 0, ok.stderr);
		const responses = ok.stdout.trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(responses[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.deepEqual(responses[1].result.tools.map((t: any) => t.name), [...MEMBER_TOOLS, ...ORCHESTRATOR_TOOLS]);
		const none = await run({ ...env, [MEMBER_ENV]: "" }, [JSON.stringify(rpc(1, "tools/list"))]);
		assert.equal(none.code, 1);
		assert.equal(none.stdout, "");
		assert.match(none.stderr, /PI_SUBAGENTS_TEAM_MEMBER is missing or malformed/);
	} finally {
		s.cleanup();
	}
});
