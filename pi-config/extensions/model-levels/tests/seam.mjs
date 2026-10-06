// The seam with a real pi (PI_PACKAGE_DIR, default the global install): a ModelRuntime over a copy of
// pi-config/models.json gets the cached levels (tests/fixture-cache.json, Ollama's answers of
// 2026-10-06) and keeps the provider's compat; then a real AgentSession loading the extension sends
// each level to a local capture server standing in for ollama.com. Offline: no model is ever called.
// `--table` prints what each level sent.
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti, packageDir } from "../../subagents/tests/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "..", "index.ts");
const PROVIDER = "ollama-cloud";
const UNMAPPED = "seam-unmapped";

const { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { getSupportedThinkingLevels } = await jiti.import("@earendil-works/pi-ai");
const { applyModelLevels } = await jiti.import(path.join(HERE, "..", "core.ts"));
const version = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version;

// The capture server: every request body, answered with one short streamed reply.
const bodies = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		bodies.push(JSON.parse(body));
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "m" };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-levels-seam-"));
const models = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "models.json"), "utf8"));
const oc = models.providers[PROVIDER];
oc.baseUrl = baseUrl;
oc.apiKey = "test";
oc.models.push({ id: UNMAPPED, reasoning: true });
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models));
const cache = JSON.parse(fs.readFileSync(path.join(HERE, "fixture-cache.json"), "utf8"));
cache.providers[PROVIDER].baseUrl = baseUrl;
cache.providers[PROVIDER].fetchedAt = Date.now();
fs.writeFileSync(path.join(agentDir, "model-levels.json"), JSON.stringify(cache));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1"; // the seam model has no metadata: never fetch it

// 1. The runtime seam: overlay over pi's composed models.
const runtime = await ModelRuntime.create({ modelsPath: path.join(agentDir, "models.json"), authPath: path.join(agentDir, "auth.json") });
const before = runtime.getModel(PROVIDER, "glm-5.3");
assert.equal(before.compat.supportsDeveloperRole, false, "precondition: models.json's provider compat");
const registered = applyModelLevels(
	{ models: () => runtime.getModels(), register: (id, defs) => runtime.registerProvider(id, { models: defs }) },
	{ agentDir },
);
assert.deepEqual(registered, [PROVIDER]);
const glm = runtime.getModel(PROVIDER, "glm-5.3");
assert.equal(glm.compat.supportsDeveloperRole, false, "provider-level compat survives the registration");
assert.equal(glm.compat.supportsReasoningEffort, true);
const unmapped = runtime.getModel(PROVIDER, UNMAPPED);
assert.equal(unmapped.compat.supportsReasoningEffort, false, "a model with no metadata keeps the provider's flag");
assert.equal(unmapped.compat.supportsDeveloperRole, false);
assert.equal(runtime.getModel(PROVIDER, "glm-5.1"), undefined, "retired: left out");
assert.equal(runtime.getModel(PROVIDER, "deepseek-v4-flash:0731"), undefined, "retired: left out");
assert.equal(runtime.getModel("ollama", "qwen3:4b").reasoning, false, "no metadata for local ollama: untouched");
assert.deepEqual(
	applyModelLevels({ models: () => runtime.getModels(), register: () => assert.fail("re-registered an unchanged overlay") }, { agentDir }),
	[],
);

const EXPECTED = {
	"deepseek-v4.1-flash": ["off", "low", "high", "max"],
	"kimi-k3": ["off", "low", "high", "max"],
	"glm-5.3": ["low", "high", "max"],
	"gpt-oss:20b": ["low", "medium", "high"],
	"nemotron-3-super": ["off", "high"],
	"gemma4:31b": ["off", "high"],
	"minimax-m2.7": ["high"],
	"minimax-m3": ["off", "low", "medium", "high", "max"],
	"mistral-large-3:675b": ["off"],
	[UNMAPPED]: ["off", "minimal", "low", "medium", "high"],
};
for (const [id, want] of Object.entries(EXPECTED)) assert.deepEqual(getSupportedThinkingLevels(runtime.getModel(PROVIDER, id)), want, `${id} levels`);

// 2. The wire: a real session with the extension, every level of each model.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "model-levels-cwd-"));
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [EXTENSION] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd) });
await session.bindExtensions({ mode: "rpc" });
const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const table = [];
for (const id of Object.keys(EXPECTED)) {
	const model = session.modelRuntime.getModel(PROVIDER, id);
	assert.ok(model, `${id} is listed in the session's runtime`);
	await session.setModel(model);
	assert.deepEqual(session.getAvailableThinkingLevels(), EXPECTED[id], `${id}: the session offers its levels`);
	for (const level of LADDER) {
		session.setThinkingLevel(level);
		const effective = session.thinkingLevel;
		await session.prompt(`hi ${id} ${level}`);
		const body = bodies.at(-1);
		assert.equal(body.model, id);
		assert.equal(body.messages[0].role, "system", `${id}: the system prompt goes as system, never developer`);
		table.push({ model: id, asked: level, effective, sent: body.reasoning_effort ?? null });
	}
}
session.dispose();
server.close();

const sent = (model, level) => table.find((r) => r.model === model && r.effective === level)?.sent;
assert.equal(sent("deepseek-v4.1-flash", "off"), "none");
for (const l of ["low", "high", "max"]) assert.equal(sent("deepseek-v4.1-flash", l), l);
for (const l of ["low", "high", "max"]) assert.equal(sent("glm-5.3", l), l);
for (const l of ["low", "medium", "high"]) assert.equal(sent("gpt-oss:20b", l), l);
assert.equal(sent("nemotron-3-super", "off"), "none");
assert.equal(sent("nemotron-3-super", "high"), "high");
assert.equal(sent("gemma4:31b", "high"), "high");
assert.equal(sent("minimax-m2.7", "high"), "high");
assert.equal(sent("minimax-m3", "medium"), "medium");
for (const r of table.filter((r) => r.model === UNMAPPED || r.model === "mistral-large-3:675b")) assert.equal(r.sent, null, `${r.model} ${r.asked}: nothing sent`);
for (const r of table) assert.ok(EXPECTED[r.model].includes(r.effective), `${r.model}: ${r.asked} clamps onto its ladder`);

if (process.argv.includes("--table")) {
	console.log(`pi ${version}`);
	for (const r of table) console.log(`${r.model.padEnd(22)} ${r.asked.padEnd(8)} → ${r.effective.padEnd(8)} reasoning_effort=${JSON.stringify(r.sent)}`);
}
console.log(`model-levels seam: ok on pi ${version} (${table.length} requests)`);
process.exit(0);
