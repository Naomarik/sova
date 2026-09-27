// Offline SDK test of the align tool in a real AgentSession, with a scripted provider and the real
// mode extension. No model requests. It checks what only a live session can show:
// - the tool is in the loadout with align on, its guideline is in the prompt, and a call's result
//   carries the document's snapshot in `details`, which the next session start folds back;
// - the hidden `align-state` note reaches the model on the next user prompt, and no alignment text
//   enters the system prompt;
// - a run that ends in a prose plan gets one hidden `align-nudge` and exactly one more request.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jiti } from "../../subagents/tests/runtime.mjs";

const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const agentDir = mkdtempSync(path.join(scratchRoot, "align-turn-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = mkdtempSync(path.join(scratchRoot, "align-turn-cwd-"));

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");

/** Every provider request: the system prompt and the messages it was sent. */
const requests = [];
/** What the scripted model does, one step per request. */
const script = [];

const CREATE = {
	ops: [
		{
			op: "create",
			title: "Export",
			summary: "Download a session.",
			questions: [{ topic: "Format", ask: "JSONL or markdown?", recommendation: { choice: "JSONL", why: "lossless" } }],
		},
	],
};
const PLAN = "The plan is ready.\n\n**Open questions, with my suggested answers:**\n1. **Cap:** 400\n2. **Group:** by worker\n\nShould I go ahead with those answers?";

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	requests.push({ prompt: getCurrentSystemPrompt(context.messages) ?? "", messages: context.messages });
	const step = script.shift() ?? { text: "ok" };
	const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	(async () => {
		options?.onPayload?.({});
		stream.push({ type: "start", partial: message });
		if (step.tool) {
			message.content.push({ type: "toolCall", id: `call-${requests.length}`, name: step.tool, arguments: step.args });
			message.stopReason = "toolUse";
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
		} else {
			message.content.push({ type: "text", text: step.text });
			stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message });
		}
		stream.push({ type: "done", reason: message.stopReason, message });
	})();
	return stream;
}

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
		},
	],
});
await resourceLoader.reload();
const settingsManager = SettingsManager.inMemory ? SettingsManager.inMemory() : SettingsManager.create(cwd, agentDir);
const sessionManager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
/** The text of every message of a request, flattened, for "did the model see X". */
const seen = (req) => JSON.stringify(req.messages);
try {
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	assert.ok(model, "the scripted provider registered its model");
	await session.setModel(model);

	await session.prompt("/mode align on");
	script.push({ tool: "align", args: CREATE }, { text: "Recorded as al_1: one question for you." });
	await session.prompt("add an export");
	assert.equal(requests.length, 2);
	assert.match(requests[0].prompt, /never as reply text/, "the tool's guideline is in the prompt while align is on");
	const results = sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "align");
	assert.equal(results.length, 1, "the call ran");
	assert.equal(results[0].message.isError, false);
	assert.equal(results[0].message.details.doc.id, "al_1", "the result carries the snapshot");
	assert.match(seen(requests[1]), /al_1 \\"Export\\" · aligning · 1 of 1 open/, "the model read the echo");

	// The next user prompt carries the hidden note; the system prompt carries no alignment.
	script.push({ tool: "align", args: { ops: [{ op: "accept", q: "open" }] } }, { text: "Recorded." });
	await session.prompt("your recs");
	const noteReq = requests[2];
	assert.match(seen(noteReq), /\[align\] Open alignments on this branch/, "the note reached the model");
	assert.match(seen(noteReq), /q1 Format: JSONL or markdown\? \(rec: JSONL\)/);
	assert.doesNotMatch(noteReq.prompt, /Export|JSONL/, "nothing about the alignment is in the system prompt");
	assert.equal(noteReq.prompt, requests[0].prompt, "the system prompt did not change because of an alignment");

	// A prose plan with no align call: one nudge, one more request, never a second.
	const before = requests.length;
	script.push({ text: PLAN }, { text: PLAN });
	await session.prompt("plan the next thing");
	assert.equal(requests.length, before + 2, "exactly one continuation");
	assert.match(seen(requests[before + 1]), /\[align\] Your last reply reads like a plan/, "the continuation carried the nudge");
	const nudges = sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "align-nudge");
	assert.equal(nudges.length, 1);
	assert.equal(nudges[0].display, false, "hidden from the transcript");

	// A new session start folds the branch back.
	const { foldAlignments } = await import("../align.ts");
	const fold = foldAlignments(sessionManager.getBranch());
	assert.deepEqual(fold.docs.map((d) => [d.id, d.rev, d.questions[0].decision?.by]), [["al_1", 2, "accepted-recommendation"]]);
	console.log("align-turn: ok");
} finally {
	session.dispose();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
