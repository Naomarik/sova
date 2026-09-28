// Offline SDK test of the spec minor mode's mechanical checks in a real AgentSession, with a scripted
// provider, the real mode extension and the real spec tools (through the agent dir, like the prompt's
// $core) on a scratch Git project. No model requests. It checks:
// - a bash write in the spec boundary gets a `[spec census]` digest appended to that tool result, with
//   the no-draft note, and the same file again gets none;
// - a turn that edited but ended without the line only warns: no continuation;
// - a turn that ran promote --write and missed a foreign § computed from Git gets one hidden re-prompt
//   naming it, and never a second; a reply that names it settles at once;
// - a pure Q&A turn needs no line and gets no re-prompt;
// - the active triple is published on the bus (mode:state), and again on mode:discover.
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
const scratch = mkdtempSync(path.join(scratchRoot, "spec-turn-"));
const agentDir = path.join(scratch, "agent");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
symlinkSync(path.resolve(here, "../../spec"), path.join(agentDir, "extensions/spec"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SPEC_CENSUS_HOOK;
delete process.env.PI_SPEC_CHECK;

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
		claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } },
	}),
);
put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
put("src/App.tsx", "1\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "base");

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");

let hostPi;
const requests = [];
const script = [];
const states = [];

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	requests.push({ messages: context.messages });
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
		(pi) => {
			hostPi = pi;
			pi.events.on("mode:state", (data) => states.push(data));
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
const seen = (req) => JSON.stringify(req.messages);
const checks = () => sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "spec-check");
try {
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	await session.setModel(model);

	await session.prompt("/mode spec on");
	assert.deepEqual(states.at(-1)?.minorModes, ["spec"], "a toggle publishes the active triple");
	const count = states.length;
	hostPi.events.emit("mode:discover", { version: 1 });
	assert.equal(states.length, count + 1, "mode:discover re-publishes");

	// A bash write in the boundary: the digest rides that tool result.
	let at = requests.length;
	script.push({ tool: "bash", args: { command: "printf '2\\n' > src/App.tsx" } }, { text: "Edited the shell." });
	await session.prompt("change the shell");
	assert.equal(requests.length, at + 2, "an edit turn without the line only warns: no continuation");
	assert.match(seen(requests[at + 1]), /\[spec census\] 1 changed file\(s\) in the boundary/, "the digest reached the model");
	assert.match(seen(requests[at + 1]), /No draft yet/);
	assert.match(seen(requests[at + 1]), /§app\/shell/);
	assert.equal(checks().length, 0);

	// The same file again: no second digest.
	at = requests.length;
	script.push({ tool: "bash", args: { command: "printf '3\\n' > src/App.tsx" } }, { text: "Again.\nAlso changes: none" });
	await session.prompt("once more");
	assert.doesNotMatch(seen(requests[at + 1]).split("once more")[1] ?? "", /\[spec census\]/, "no digest for a file already reported");

	// A pure question: no line needed, no re-prompt.
	at = requests.length;
	script.push({ text: "It renders the shell." });
	await session.prompt("what does App.tsx do?");
	assert.equal(requests.length, at + 1);

	// promote --write that changes a foreign §'s text: one re-prompt naming it.
	git("add", "-A");
	git("commit", "-qm", "work");
	at = requests.length;
	const promote = `: sova-spec-draft.mjs promote feat --write; printf '# §app/shell\\n\\nShell, v2.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote } }, { text: "Promoted.\nAlso changes: none" }, { text: "Promoted.\nAlso changes: none" });
	await session.prompt("promote it");
	assert.equal(requests.length, at + 3, "exactly one continuation");
	assert.equal(checks().length, 1);
	assert.equal(checks()[0].display, false, "hidden from the transcript");
	assert.match(checks()[0].content, /promote --write/);
	assert.match(checks()[0].content, /computed from Git: §app\/shell/);
	assert.match(seen(requests[at + 2]), /Also changes: §app\/shell — <what changed>/, "the continuation carried the computed line");

	// The same kind of turn, naming it: settles at once.
	at = requests.length;
	const promote2 = `: sova-spec-draft.mjs promote feat --write; printf '# §app/shell\\n\\nShell, v3.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote2 } }, { text: "Promoted.\nAlso changes: §app/shell — v3 wording" });
	await session.prompt("promote again");
	assert.equal(requests.length, at + 2, "a correct line needs no continuation");
	assert.equal(checks().length, 1);

	// PI_SPEC_CHECK=0 turns the line check off.
	process.env.PI_SPEC_CHECK = "0";
	at = requests.length;
	script.push({ tool: "bash", args: { command: promote.replace("v2", "v4") } }, { text: "Promoted." });
	await session.prompt("and again");
	assert.equal(requests.length, at + 2);
	delete process.env.PI_SPEC_CHECK;
	console.log("spec-turn: ok");
} finally {
	session.dispose?.();
	rmSync(scratch, { recursive: true, force: true });
}
