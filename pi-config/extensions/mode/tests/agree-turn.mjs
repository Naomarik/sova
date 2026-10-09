// Offline SDK test of the Agree step's instruction in a real AgentSession, with a scripted provider, the real
// mode extension and the real spec tools (through the agent dir) on a scratch Git project. No model requests.
// After the user's go-ahead moves an alignment to implementing, what the model reads next (system prompt and
// messages) tells it to run the spec tools' `agree` with align and spec both on, and not with only one of them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "a-turn-"));
const agentDir = path.join(scratch, "agent");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
symlinkSync(path.resolve(here, "../../spec"), path.join(agentDir, "extensions/spec"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SPEC_CENSUS_HOOK;

const cwd = path.join(scratch, "project");
const put = (rel, text) => {
	mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
	writeFileSync(path.join(cwd, rel), text);
};
const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args]).status, 0, `git ${args.join(" ")}`);
put(
	".sova/spec/manifest.json",
	JSON.stringify({
		formatVersion: 1,
		grammar: { claimsRoot: "claims/", directoryKinds: ["section"] },
		boundary: { include: ["src"], exclude: [] },
		claims: { "§app/list": { kind: "surface", code: ["src/list.js"] } },
	}),
);
put(".sova/spec/claims/app/list.md", "# §app/list\n\nThe session list.\n");
put("src/list.js", "export const MAX = 60;\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "base");

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");

/** The Agree step's instruction: the word "agree" anywhere (absent without both modes), and with both its stable phrase and the command. */
const AGREE = /\bagree\b/;
const AGREE_STEP = /this go-ahead is the Agree step[\s\S]*sova-spec-draft\.mjs\\*"? agree\b/;

const CREATE = {
	ops: [
		{
			op: "create",
			title: "Title cap",
			summary: "Cap session titles in the list.",
			questions: [{ topic: "Cap", ask: "How many characters?", recommendation: { choice: "64", why: "fits the column" } }],
		},
	],
};

async function session(modes) {
	const requests = [];
	const script = [];
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
		additionalExtensionPaths: [path.resolve(here, "../index.ts")],
		extensionFactories: [
			(pi) =>
				pi.registerProvider("scripted", {
					baseUrl: "http://localhost",
					apiKey: "unused",
					api: "openai-completions",
					models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
					streamSimple,
				}),
		],
	});
	await resourceLoader.reload();
	const settingsManager = SettingsManager.inMemory ? SettingsManager.inMemory() : SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.inMemory(cwd);
	const { session: s } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
	await s.setModel(s.modelRuntime.getModel("scripted", "scripted-1"));
	for (const m of modes) await s.prompt(`/mode ${m} on`);
	return { s, requests, script };
}

/** What the model reads after the go-ahead: the system prompt and every message from the go-ahead on. */
async function afterGoAhead(modes) {
	const { s, requests, script } = await session(modes);
	try {
		if (modes.includes("align")) {
			script.push({ tool: "align", args: CREATE }, { text: "Recorded as al_1: one question for you." });
			await s.prompt("cap the session titles in the list");
			script.push({ tool: "align", args: { doc: "al_1", ops: [{ op: "accept_all" }, { op: "status", to: "implementing" }] } }, { text: "Building." });
		} else {
			script.push({ text: "Building." });
		}
		const at = requests.length;
		await s.prompt("your recs, go ahead");
		assert.ok(requests.length > at, "the go-ahead reached the model");
		const tail = requests.slice(at).map((r) => r.prompt + JSON.stringify(r.messages).split("your recs, go ahead").slice(1).join(""));
		if (modes.includes("align")) assert.match(JSON.stringify(requests.at(-1).messages), /implementing/, "the alignment moved to implementing");
		return tail.join("\n");
	} finally {
		s.dispose?.();
	}
}

try {
	const both = await afterGoAhead(["align", "spec"]);
	const alignOnly = await afterGoAhead(["align"]);
	const specOnly = await afterGoAhead(["spec"]);
	const seen = { both: AGREE.test(both), alignOnly: AGREE.test(alignOnly), specOnly: AGREE.test(specOnly) };
	console.log(`agree-turn: instruction seen ${JSON.stringify(seen)}`);
	if (process.env.AGREE_DEBUG) for (const [k, t] of Object.entries({ both, alignOnly, specOnly })) console.log(k, [...t.matchAll(/.{80}\bagree\b.{80}/gs)].map((m) => m[0]));
	assert.equal(seen.alignOnly, false, "align alone never asks for the spec's agree step");
	assert.equal(seen.specOnly, false, "spec alone never asks for the agree step");
	assert.equal(seen.both, true, "align and spec on: the go-ahead's turn carries the agree instruction");
	assert.match(both, AGREE_STEP, "in its stable words, naming the command");
	console.log("agree-turn: ok");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
