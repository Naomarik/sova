// End to end with real pi sessions: several processes, each a pi AgentSession loading this
// extension, send turns to a provider defined in models.json (`fakeprov`, openai-completions) that
// points at a local fake server. The server counts requests in flight. The limit is 2: the server
// must never see more than 2 at once (and does see 2), the fifth request gets a 429 with Retry-After (re-queued by
// the gate, never shown to pi), and every turn must end with the server's reply. No model requests.
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = fileURLToPath(new URL("../index.ts", import.meta.url));

if (process.env.PL_E2E_CHILD) {
	const { jiti } = await import("../../subagents/tests/runtime.mjs");
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
	const agentDir = process.env.PL_AGENT;
	// hermetic-env (imported above) cleared it; the extension reads the agent dir the way pi does.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pl-e2e-cwd-"));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [EXTENSION] });
	await resourceLoader.reload();
	const settingsManager = SettingsManager.inMemory();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
	await session.bindExtensions({ mode: "rpc" });
	const model = session.modelRuntime.getModel("fakeprov", "fake-1");
	if (!model) throw new Error("fakeprov/fake-1 is not registered");
	await session.setModel(model);
	const replies = [];
	for (let i = 0; i < Number(process.env.PL_TURNS); i++) {
		await session.prompt(`turn ${i}`);
		const last = session.messages.filter((m) => m.role === "assistant").at(-1);
		replies.push({ stopReason: last?.stopReason, error: last?.errorMessage, text: last?.content?.map((c) => c.text ?? "").join("") });
	}
	session.dispose();
	process.stdout.write(JSON.stringify(replies));
	process.exit(0);
}

const PROCS = 4;
const TURNS = 3;
const LIMIT = 2;
let inFlight = 0;
let peak = 0;
let requests = 0;
let rejected = 0;
const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		requests++;
		// The fifth request, once the processes run at the limit.
		if (requests === 5) {
			rejected++;
			res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
			res.end(JSON.stringify({ error: { code: "1302", message: "Rate limit reached for requests" } }));
			return;
		}
		inFlight++;
		peak = Math.max(peak, inFlight);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "fake-1" };
		setTimeout(() => {
			res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] }));
			setTimeout(() => {
				res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
				res.write("data: [DONE]\n\n");
				inFlight--;
				res.end();
			}, 60);
		}, 60);
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pl-e2e-agent-"));
fs.writeFileSync(
	path.join(agent, "models.json"),
	JSON.stringify({
		providers: {
			fakeprov: {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-completions",
				apiKey: "unused",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		},
	}),
);
fs.writeFileSync(path.join(agent, "provider-limits.json"), JSON.stringify({ version: 1, limits: { fakeprov: LIMIT } }));

const started = Date.now();
const outputs = await Promise.all(
	Array.from({ length: PROCS }, () => {
		const p = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
			env: { ...process.env, PL_E2E_CHILD: "1", PL_AGENT: agent, PI_CODING_AGENT_DIR: agent, PL_TURNS: String(TURNS) },
			stdio: ["ignore", "pipe", "inherit"],
		});
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		return new Promise((resolve) => p.on("exit", (code) => resolve({ code, out })));
	}),
);
server.close();
try {
	assert.deepEqual(outputs.map((o) => o.code), Array(PROCS).fill(0), "every pi process finished");
	const replies = outputs.flatMap((o) => JSON.parse(o.out));
	assert.equal(replies.length, PROCS * TURNS);
	for (const r of replies) assert.deepEqual(r, { stopReason: "stop", text: "pong" }, "every turn got the reply, with no error; the 429 never reached pi");
	assert.equal(rejected, 1);
	assert.equal(requests, PROCS * TURNS + 1, "one re-queued request, no pi retries");
	assert.ok(peak <= LIMIT, `the server saw ${peak} at once; the limit is ${LIMIT}`);
	assert.equal(peak, LIMIT, "the processes did run side by side, up to the limit");
	const lowered = JSON.parse(fs.readFileSync(path.join(agent, "provider-limits", "fakeprov", "lowered.json"), "utf8"));
	assert.equal(lowered.limit, LIMIT - 1, "the 429 lowered the limit by one");
	assert.ok(lowered.until > started + 4 * 60_000);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, "provider-limits.json"), "utf8")).limits, { fakeprov: LIMIT }, "the Settings value is untouched");
	console.log(`✔ pi e2e: ${PROCS} pi processes × ${TURNS} turns over one limited provider, peak ${peak} ≤ ${LIMIT}, one 429 re-queued and the limit lowered`);
} finally {
	fs.rmSync(agent, { recursive: true, force: true });
}
