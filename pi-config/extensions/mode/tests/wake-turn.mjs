// Offline SDK test: the system prompt is the same whether a turn was started by the user or by an
// extension's message (`pi.sendMessage(…, { triggerTurn: true })`, e.g. a subagent settling).
//
// pi builds a user turn's prompt in before_agent_start, where the mode extension writes its block
// into the prompt sections. A turn an extension's message starts skips that hook; pi's own
// next-turn refresh then rebuilds the prompt from the session's base options, which know nothing
// of extension sections, and patches the mode section out mid-turn (`mode: null` in the
// transcript). The claude-code provider restarts its CLI on every such prompt change. This test
// drives a real AgentSession with a scripted provider and the real mode extension. No model requests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const agentDir = mkdtempSync(path.join(scratchRoot, "wake-turn-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = mkdtempSync(path.join(scratchRoot, "wake-turn-cwd-"));

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");
const { Type } = await jiti.import("typebox");

/** One prompt per provider request, in order. */
const prompts = [];
let calls = 0;
const script = ["tool", "text", "tool", "text"]; // user turn: call + reply; wake turn: call + reply

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	prompts.push(getCurrentSystemPrompt(context.messages) ?? "");
	const step = script[calls++] ?? "text";
	const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	(async () => {
		options?.onPayload?.({});
		stream.push({ type: "start", partial: message });
		if (step === "tool") {
			message.content.push({ type: "toolCall", id: `call-${calls}`, name: "echo", arguments: { text: "ping" } });
			message.stopReason = "toolUse";
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
		} else {
			message.content.push({ type: "text", text: "done" });
			stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: message });
		}
		stream.push({ type: "done", reason: message.stopReason, message });
	})();
	return stream;
}

let api;
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	additionalExtensionPaths: [path.resolve(new URL("../index.ts", import.meta.url).pathname)],
	extensionFactories: [
		(pi) => {
			api = pi;
			pi.registerProvider("scripted", {
				baseUrl: "http://localhost",
				apiKey: "unused",
				api: "openai-completions",
				models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
				streamSimple,
			});
			pi.registerTool({
				name: "echo",
				label: "Echo",
				description: "Echoes",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }], details: {} }),
			});
		},
	],
});
await resourceLoader.reload();
const settingsManager = SettingsManager.inMemory ? SettingsManager.inMemory() : SettingsManager.create(cwd, agentDir);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
try {
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	assert.ok(model, "the scripted provider registered its model");
	await session.setModel(model);

	// A mode with a prompt block, set the way Sova and `/mode` set it: through the command.
	await session.prompt("/mode align on");
	await session.prompt("first");
	assert.equal(prompts.length, 2, "the user turn made two requests (tool call, then reply)");
	assert.match(prompts[0], /# Minor mode: align/, "the user turn's prompt carries the mode block");
	assert.equal(prompts[1], prompts[0], "the prompt holds across the user turn's tool call");

	// A worker settling: an extension message starts the next turn.
	await session.sendCustomMessage({ customType: "subagent-complete", content: "worker done", display: true }, { deliverAs: "followUp", triggerTurn: true });
	await session.waitForIdle?.();
	assert.equal(prompts.length, 4, "the wake turn made two requests");
	const nulls = session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "system" && e.message.sections && e.message.sections.mode === null);
	assert.equal(prompts[2], prompts[0], "the wake turn's first request has the user turn's prompt");
	assert.equal(prompts[3], prompts[0], "the wake turn's prompt holds across its tool call (no mode: null patch)");
	assert.equal(nulls.length, 0, "no transcript patch removed the mode section");
	console.log("wake-turn: ok");
} finally {
	session.dispose();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
