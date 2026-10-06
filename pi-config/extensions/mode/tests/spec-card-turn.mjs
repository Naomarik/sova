// Offline SDK test of the spec card's record (§chat.spec-card/record) in a real AgentSession, with a
// scripted provider, the real mode extension and the real spec tools on a scratch Git project. No model
// requests. It checks:
// - a run that changed something leaves exactly one `spec-turn` custom entry, at the check's final verdict
//   (after its re-prompts), with the reply's own § and words; a Q&A run leaves none;
// - the record never reaches the model: pi's projection gives it no message, and no later request carries it;
// - an uncommitted promotion's changed claim is captured as text;
// - a § an earlier record described needs no repeat: the next reply that leaves it out passes at once.
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
const scratch = mkdtempSync(path.join(scratchRoot, "spec-card-"));
const noopDraft = path.join(scratch, "noop", "sova-spec-draft.mjs");
mkdirSync(path.dirname(noopDraft), { recursive: true });
writeFileSync(noopDraft, "");
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
const { normalizeSpecTurnDetails } = await jiti.import(path.resolve(here, "../spec-turn.ts"));

const requests = [];
const script = [];

function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	requests.push({ messages: context.messages });
	const step = script.shift() ?? { text: "ok" };
	step.effect?.();
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
const records = () => sessionManager.getBranch().filter((e) => e.customType === "spec-turn");
const checks = () => sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "spec-check" && /This turn/.test(e.content));
/** No model-bound message comes from a spec-turn entry: pi projects it to nothing. */
const neverContext = () => {
	const projection = sessionManager.buildSessionProjection();
	const fromRecords = projection.entries.filter((p) => p.sourceEntry.customType === "spec-turn");
	assert.equal(fromRecords.length, records().length, "every record is on the projected path");
	for (const p of fromRecords) assert.deepEqual(p.messages, [], "a spec-turn record projects to no model message");
};
const promote = (wording) => `node ${noopDraft} promote feat --write; printf '# §app/shell\\n\\nShell, ${wording}.\\n' > .sova/spec/claims/app/shell.md`;
try {
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	await session.setModel(model);
	await session.prompt("/mode spec on");

	// A pure question: no record.
	script.push({ text: "It renders the shell." });
	await session.prompt("what does App.tsx do?");
	assert.equal(records().length, 0, "a Q&A run leaves no record");

	// A promotion that needs two re-prompts: one record, written after them, at the final verdict.
	let at = requests.length;
	script.push({ tool: "bash", args: { command: promote("v2") } }, { text: "Promoted.\nAlso changes: none" }, { text: "Promoted.\nAlso changes: none" }, { text: "Promoted.\nAlso changes: none" });
	await session.prompt("promote it");
	assert.equal(requests.length, at + 4, "two continuations");
	assert.equal(checks().length, 2);
	assert.equal(records().length, 1, "one record for the whole run, re-prompts included");
	let d = normalizeSpecTurnDetails(records()[0].data);
	assert.ok(d, "the record passes its own check");
	assert.equal(records()[0].type, "custom", "a plain custom entry, never a custom message");
	assert.equal(d.check.ok, false);
	assert.equal(d.check.reprompts, 2);
	assert.deepEqual(d.own, []);
	assert.deepEqual(d.landed.map((it) => it.id), ["§app/shell"]);
	assert.equal(d.ops[0].kind, "promote");
	assert.match(d.prose?.["§app/shell"] ?? "", /Shell, v2\./, "an uncommitted promotion's claim is captured as text");
	neverContext();

	// The next run's requests carry nothing of the record.
	at = requests.length;
	git("add", "-A");
	git("commit", "-qm", "v2");
	script.push({ tool: "bash", args: { command: promote("v3") } }, { text: "Promoted.\nAlso changes: §app/shell — v3 wording" });
	await session.prompt("promote again");
	assert.equal(requests.length, at + 2, "a correct line settles at once");
	for (const r of requests.slice(at)) {
		const sent = JSON.stringify(r.messages);
		assert.doesNotMatch(sent, /spec-turn|"reprompts"|"landed"/, "no request carries a record");
		assert.doesNotMatch(sent, /Shell, v2\.\\n"?\}?\]?,?"?prose/, "nor its captured text");
	}
	assert.equal(records().length, 2);
	d = normalizeSpecTurnDetails(records()[1].data);
	assert.deepEqual(d.own, [{ id: "§app/shell", what: "v3 wording", ...(d.own[0].change ? { change: d.own[0].change } : {}), ...(d.own[0].op !== undefined ? { op: d.own[0].op } : {}) }]);
	assert.equal(d.check.ok, true);
	neverContext();

	// A § an earlier record described: the next reply may leave it out, and the record keeps the words.
	git("add", "-A");
	git("commit", "-qm", "v3");
	at = requests.length;
	script.push({ tool: "bash", args: { command: promote("v4") } }, { text: "Promoted the same claim again.\nAlso changes: none" });
	await session.prompt("promote once more");
	assert.equal(requests.length, at + 2, "a described § needs no repeat: no re-prompt");
	assert.equal(records().length, 3);
	d = normalizeSpecTurnDetails(records()[2].data);
	assert.equal(d.landed[0]?.id, "§app/shell");
	assert.equal(d.landed[0]?.what, "v3 wording", "an earlier record's words");
	neverContext();
	console.log("spec-card-turn: ok");
} finally {
	session.dispose?.();
	rmSync(scratch, { recursive: true, force: true });
}
