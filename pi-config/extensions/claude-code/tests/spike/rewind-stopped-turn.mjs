// CANARY, not a gate: the undocumented `rewind_conversation` request the bridge sends when a
// stopped reply comes back unchanged (session-bridge.ts rewindPlan, README "A stopped reply sent
// back"). Spawns the REAL Claude CLI and spends a few cheap turns of subscription quota; run it
// by hand after a CLI update: `node tests/spike/rewind-stopped-turn.mjs --live`.
// Out of reach of tests/run.mjs, which scans only the extension root and provider/ for *.test.ts.
//
// CLAUDE_BIN overrides the binary (never the `claude` shell alias), CLAUDE_MODEL the model
// (default claude-haiku-5-5). It prints frames and numbers, never the environment.
//
// What it checks, each an assertion:
//   1. a user message we send comes back as `{type:"user", uuid, isReplay:true}`;
//   2. after an interrupt, `rewind_conversation` aimed at the stopped prompt answers `rewound: true`;
//   3. aimed at an unknown uuid it does not rewind;
//   4. the prompt and the new message sent as one get a reply that read the earlier chat from the
//      cache (cache_read_input_tokens > 0).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--live")) throw Error("Pass --live to authorize real Claude requests.");

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-5-5";
const CWD = mkdtempSync(join(tmpdir(), "cc-rewind-"));
const env = { ...process.env, DISABLE_AUTO_COMPACT: "1" };
delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;

const child = spawn(CLAUDE, [
	"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
	"--include-partial-messages", "--replay-user-messages", "--tools", "", "--strict-mcp-config",
	"--setting-sources", "", "--session-id", randomUUID(), "--model", MODEL, "--permission-mode", "dontAsk",
], { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });

const waiters = [];
let buffer = "";
child.stdout.on("data", (data) => {
	buffer += data;
	for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
		const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
		if (!line.trim()) continue;
		const frame = JSON.parse(line);
		for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
	}
});
child.stderr.on("data", (data) => process.stderr.write(String(data).slice(0, 500)));

const wait = (match, ms = 90_000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("timed out")), ms);
	waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
});
const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
let id = 0;
const control = (request) => {
	const request_id = `rq${++id}`;
	const answered = wait((f) => f.type === "control_response" && f.response?.request_id === request_id);
	send({ type: "control_request", request_id, request });
	return answered;
};
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("") : String(m?.content ?? ""));
const user = (text) => {
	const replay = wait((f) => f.type === "user" && f.isReplay === true && textOf(f.message) === text);
	send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
	return replay;
};
const check = (ok, what) => { if (!ok) { console.error(`FAIL: ${what}`); process.exitCode = 1; } else console.log(`ok: ${what}`); };

try {
	await control({ subtype: "initialize", systemPrompt: "You are a terse assistant." });
	await user("Say exactly: ready.");
	await wait((f) => f.type === "result");

	const prompt = "Write the lines a1, a2, a3 ... up to a80, one per line, nothing else.";
	const replay = await user(prompt);
	check(typeof replay.uuid === "string", `the prompt's replay names its uuid (${replay.uuid})`);
	let partial = "";
	await wait((f) => {
		if (f.type === "stream_event" && f.event?.delta?.type === "text_delta") partial += f.event.delta.text;
		return partial.split("\n").length > 12;
	});
	await control({ subtype: "interrupt" });
	await wait((f) => f.type === "result");

	const t0 = performance.now();
	const rewound = await control({ subtype: "rewind_conversation", target_message_uuid: replay.uuid });
	const ms = performance.now() - t0;
	console.log("rewind:", JSON.stringify(rewound.response), `${ms.toFixed(1)} ms`);
	check(rewound.response?.subtype === "success" && rewound.response?.response?.rewound === true, "a rewind to the stopped prompt answers rewound: true");

	const unknown = await control({ subtype: "rewind_conversation", target_message_uuid: randomUUID() });
	console.log("unknown target:", JSON.stringify(unknown.response));
	check(unknown.response?.response?.rewound !== true, "a rewind to an unknown uuid does not rewind");

	const typed = `${partial.trim()}\n\nStop that. Instead: how many times in this whole conversation have I asked you for the a-lines? Reply "asks=N" only.`;
	await user(`${prompt}\n\n${typed}`);
	const assistant = await wait((f) => f.type === "assistant");
	const result = await wait((f) => f.type === "result");
	const usage = assistant.message?.usage ?? {};
	console.log("answer:", JSON.stringify(result.result), "cache read", usage.cache_read_input_tokens, "write", usage.cache_creation_input_tokens);
	check((usage.cache_read_input_tokens ?? 0) > 0, "the turn after the rewind reads the earlier chat from the cache");
	check(/asks=1\b/.test(String(result.result)), "the model saw the stopped prompt once");
} finally {
	child.stdin.end();
	rmSync(CWD, { recursive: true, force: true });
}
