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

/** One prompt per provider request, in order; reset per scenario. */
let prompts = [];
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

/** A real AgentSession with the real mode extension, a scripted provider and an `echo` tool. */
async function open(sessionManager) {
	prompts = [];
	calls = 0;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [path.resolve(new URL("../index.ts", import.meta.url).pathname)],
		extensionFactories: [
			(pi) => {
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
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
	// Extensions (and their session_start, where the mode extension restores the session's mode)
	// run only once bound, as Sova binds a chat.
	await session.bindExtensions({ mode: "rpc" });
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	assert.ok(model, "the scripted provider registered its model");
	await session.setModel(model);
	return session;
}

/** A user turn, then a wake turn (a worker settling), each a tool call and a reply. */
async function userTurnThenWakeTurn(session) {
	await session.prompt("first");
	assert.equal(prompts.length, 2, "the user turn made two requests (tool call, then reply)");
	await session.sendCustomMessage({ customType: "subagent-complete", content: "worker done", display: true }, { deliverAs: "followUp", triggerTurn: true });
	await session.waitForIdle?.();
	assert.equal(prompts.length, 4, "the wake turn made two requests");
	return session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "system" && e.message.sections && e.message.sections.mode === null);
}

/** A session reopened with a pinned mode: the `mode` entry Sova (pinEntryFor) and the extension write. */
function pinnedAlign() {
	const sm = SessionManager.inMemory(cwd);
	sm.appendCustomEntry("mode", { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: ["align"] } });
	return sm;
}

/** `/mode sync` as Sova's bind() runs it: the command's own handler with a command context. */
async function modeSync(session) {
	const cmd = session.extensionRunner.getCommand("mode");
	assert.ok(cmd, "the mode extension registered /mode");
	await cmd.handler("sync", session.extensionRunner.createCommandContext());
}

try {
	// 1. A mode with a prompt block, set the way `/mode` sets it: through the command.
	{
		const session = await open(SessionManager.inMemory(cwd));
		try {
			await session.prompt("/mode align on");
			const nulls = await userTurnThenWakeTurn(session);
			assert.match(prompts[0], /# Minor mode: align/, "the user turn's prompt carries the mode block");
			assert.equal(prompts[1], prompts[0], "the prompt holds across the user turn's tool call");
			assert.equal(prompts[2], prompts[0], "the wake turn's first request has the user turn's prompt");
			assert.equal(prompts[3], prompts[0], "the wake turn's prompt holds across its tool call (no mode: null patch)");
			assert.equal(nulls.length, 0, "no transcript patch removed the mode section");
		} finally {
			session.dispose();
		}
	}

	// 2. A session reopened with its mode pinned and never switched, no /mode run: the old
	// behaviour the README documents for a terminal session (the wake turn's tool call drops the
	// section). This is what every hosted chat did before Sova ran `/mode sync` at open.
	{
		const session = await open(pinnedAlign());
		try {
			const nulls = await userTurnThenWakeTurn(session);
			assert.match(prompts[0], /# Minor mode: align/, "the restored mode reaches the user turn");
			assert.doesNotMatch(prompts[3], /# Minor mode: align/, "without the getter, the wake turn's refresh loses the block");
			assert.equal(nulls.length, 1, "and the transcript records the mode: null patch");
		} finally {
			session.dispose();
		}
	}

	// 3. The same pinned session, opened as Sova opens a chat: `/mode sync` right after binding.
	{
		const session = await open(pinnedAlign());
		try {
			const before = session.sessionManager.getEntries().length;
			await modeSync(session);
			assert.equal(session.sessionManager.getEntries().length, before, "/mode sync writes nothing to the session");
			const nulls = await userTurnThenWakeTurn(session);
			assert.match(prompts[0], /# Minor mode: align/, "the first turn carries the restored mode block");
			for (let i = 1; i < prompts.length; i++) assert.equal(prompts[i], prompts[0], `request ${i + 1} has the first request's prompt, byte for byte`);
			assert.equal(nulls.length, 0, "no transcript patch removed the mode section");
			const systems = session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "system");
			assert.equal(systems.length, 1, "one prompt version for the whole session: no patch after the first");
			assert.equal(typeof systems[0].message.sections.mode, "string", "and it carries the mode section");
		} finally {
			session.dispose();
		}
	}
	console.log("wake-turn: ok");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
