// Offline SDK test: a worker's ledger operation is charged to one run only (§tools.spec/ledger-once), through
// a server restart (the session reopened from its file), and a run that only starts workers asks for no line.
// The live sequence it pins: worker ops settled at turn N came back at a later turn that only ran agent_spawn,
// with a re-prompt reciting their foreign § again, twice. Scripted provider, real mode extension and spec tools,
// scratch Git project; no model requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "ledger-turn-"));
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
const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const must = (...args) => assert.equal(git(...args).status, 0, `git ${args.join(" ")}`);
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
put(".gitignore", "notes*.txt\n");
must("init", "-q");
must("add", "-A");
must("commit", "-qm", "base");

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");

const requests = [];
const script = [];
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
const host = (pi) =>
	pi.registerProvider("scripted", {
		baseUrl: "http://localhost",
		apiKey: "unused",
		api: "openai-completions",
		models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple,
	});
/** One server's life: a fresh extension instance on the session (a restart reopens the same file). */
async function open(sessionManager) {
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../index.ts")], extensionFactories: [host] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager });
	await session.bindExtensions({});
	await session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"));
	return session;
}
const reprompts = (manager) => manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "spec-check" && /This turn/.test(e.content));

let session;
try {
	const manager = SessionManager.create(cwd, path.join(scratch, "sessions"));
	session = await open(manager);
	await session.prompt("/mode spec on");
	const sid = manager.getSessionId();
	const ledger = path.join(agentDir, "sova", "spec-ledger", `${sid.replace(/[^\w.-]/g, "_")}.jsonl`);
	const charged = path.join(path.dirname(ledger), `${sid.replace(/[^\w.-]/g, "_")}.charged`);
	assert.ok(existsSync(charged), "a session's charged file is started with it");

	// Turn N: a worker commits a promotion in the session's checkout (its ledger says so) while the parent
	// edits a file itself. The run lands the worker's § and the reply's line names it: settled, no re-prompt.
	const before = git("rev-parse", "HEAD").stdout.trim();
	put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, by the worker.\n");
	must("commit", "-qam", "spec: a worker's promotion");
	const top = git("rev-parse", "--show-toplevel").stdout.trim();
	const entry = { v: 1, at: Date.now(), actor: { runtime: "claude-code", session: "ag_01" }, top, before, after: git("rev-parse", "HEAD").stdout.trim(), kind: "commit" };
	mkdirSync(path.dirname(ledger), { recursive: true });
	writeFileSync(ledger, `${JSON.stringify(entry)}\n`, { flag: "a" });
	let at = requests.length;
	script.push({ tool: "bash", args: { command: "printf '2\\n' > src/App.tsx" } }, { text: "Edited, and the worker promoted.\nAlso changes: §app/shell — the worker's wording" });
	await session.prompt("edit the shell; the worker has finished");
	assert.equal(requests.length, at + 2, "turn N settles on its line: no continuation");
	assert.equal(reprompts(manager).length, 0);
	assert.match(readFileSync(charged, "utf8"), new RegExp(`${entry.at}:`), "the op is recorded as charged beside the ledger");
	must("add", "-A");
	must("commit", "-qm", "the parent's edit");

	// A restart: the extension starts again on the same session file; its in-memory state is gone.
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	session = await open(SessionManager.open(manager.getSessionFile()));
	const reopened = session.sessionManager;

	// Turn N+1 only starts workers: no edit, commit, promote or merge. No line is required, nothing re-prompts,
	// and the worker op settled at turn N is not taken again.
	at = requests.length;
	script.push({ tool: "agent_spawn", args: { task: "diagnose, read only" } }, { text: "Started a read-only worker." });
	await session.prompt("start a worker to diagnose the tests");
	assert.equal(requests.length, at + 2, "turn N+1: no continuation");
	assert.equal(reprompts(reopened).length, 0, "turn N+1 gets no re-prompt");
	assert.ok(!reopened.getBranch().some((e) => e.type === "custom_message" && e.customType === "spec-check" && /§app\/shell/.test(e.content)), "nothing recites turn N's list");

	// Turn N+2: the worker reports (a relay), having changed nothing; the parent changes nothing either.
	at = requests.length;
	script.push({ text: "The worker found the cause; nothing changed." });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_02 finished (read only)", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 1, "a relay of a read-only worker: no continuation");
	assert.equal(reprompts(reopened).length, 0);

	// A worker op arriving now is charged to the next run that takes it, and only kept on its record when the
	// parent itself changed nothing: still no re-prompt.
	const before2 = git("rev-parse", "HEAD").stdout.trim();
	put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, by a second worker.\n");
	must("commit", "-qam", "spec: a second worker's promotion");
	writeFileSync(ledger, `${JSON.stringify({ ...entry, at: Date.now(), actor: { runtime: "claude-code", session: "ag_03" }, before: before2, after: git("rev-parse", "HEAD").stdout.trim() })}\n`, { flag: "a" });
	at = requests.length;
	script.push({ text: "The second worker promoted the shell wording." });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_03 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 1, "a relay that changed nothing itself is never re-prompted");
	assert.equal(reprompts(reopened).length, 0);
	const record = reopened.getBranch().filter((e) => e.type === "custom" && e.customType === "spec-turn").at(-1);
	if (record) assert.ok(JSON.stringify(record.data).includes("ag_03"), "the worker's op is on that run's record");
	assert.equal(readFileSync(charged, "utf8").split("\n").filter(Boolean).length, 2, "each op charged once");
	console.log("ledger-turn: ok");
} finally {
	await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
	session?.dispose?.();
	rmSync(scratch, { recursive: true, force: true });
}
