// End to end with the real pi CLI (PI_PACKAGE_DIR's dist/bundle/cli.js) against a local fake
// openai-completions provider. No model requests.
//
// 1. Print mode, a turn that runs a tool: the call is in flight (1) when the provider receives it,
//    before any response byte; 0 while the tool runs; 1 again for the follow-up; 0 at the end.
//    A probe extension records the counts from its own copy of tracker.ts (the singleton holds
//    across jiti's per-extension module copies).
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
if (!packageDir) throw new Error("run through tests/run.mjs (PI_PACKAGE_DIR)");
const CLI = path.join(packageDir, "dist/bundle/cli.js");
const EXT = fileURLToPath(new URL("../index.ts", import.meta.url));
const TRACKER = fileURLToPath(new URL("../tracker.ts", import.meta.url));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-e2e-"));
const log = path.join(work, "probe.jsonl");
const probe = path.join(work, "probe.ts");
fs.writeFileSync(
	probe,
	`import fs from "node:fs";
import { snapshot, subscribe } from ${JSON.stringify(TRACKER)};
const write = (ev) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ev, active: snapshot().active }) + "\\n");
export default function (pi) {
	subscribe(() => write("change"));
	pi.on("tool_execution_start", () => write("tool_start"));
	pi.on("tool_execution_end", () => write("tool_end"));
}
`,
);
const lastActive = () => {
	const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	return lines.length ? JSON.parse(lines.at(-1)).active : 0;
};

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "fake-1" };
let requests = 0;
const seenAtRecv = [];
const server = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const n = ++requests;
		seenAtRecv.push(lastActive());
		// Nothing sent back yet: the count must already say 1.
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (n === 1) {
				res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 0.5" }) } }] }, finish_reason: null }] }));
				res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			} else {
				res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] }));
				res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		}, 150);
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const agent = path.join(work, "agent");
fs.mkdirSync(agent, { recursive: true });
fs.writeFileSync(
	path.join(agent, "models.json"),
	JSON.stringify({
		providers: {
			fakeprov: {
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				api: "openai-completions",
				apiKey: "unused",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		},
	}),
);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: agent };
const run = (args, input) =>
	new Promise((resolve) => {
		const p = spawn(process.execPath, [CLI, "--no-session", "--provider", "fakeprov", "--model", "fake-1", ...args], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
			input?.(out, p);
		});
		p.stderr.on("data", (d) => (err += d));
		if (!input) p.stdin.end();
		p.on("exit", (code) => resolve({ code, out, err }));
	});

try {
	// 1. print mode, with a tool between two requests
	const printed = await run(["-e", EXT, "-e", probe, "-p", "run the tool"]);
	assert.equal(printed.code, 0, printed.err);
	assert.match(printed.out, /pong/);
	assert.equal(requests, 2);
	assert.deepEqual(seenAtRecv, [1, 1], "in flight when the provider got each request, before any response byte");
	const events = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const tools = events.filter((e) => e.ev !== "change");
	assert.deepEqual(tools.map((e) => [e.ev, e.active]), [["tool_start", 0], ["tool_end", 0]], "no call in flight while the tool runs");
	// The first change is the process starting to count (its runtime instrumented), at 0.
	assert.deepEqual(events.filter((e) => e.ev === "change").map((e) => e.active), [0, 1, 0, 1, 0], "two calls, each one change up and one down");
	console.log("✔ pi e2e (print): counted from issue, before the first byte; 0 while the tool ran; 0 at the end");
} finally {
	server.close();
	fs.rmSync(work, { recursive: true, force: true });
}
