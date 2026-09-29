// Offline SDK test of the spec minor mode's mechanical checks in a real AgentSession, with a scripted
// provider, the real mode extension and the real spec tools (through the agent dir, like the prompt's
// $core) on a scratch Git project. No model requests. It checks:
// - a bash write in the spec boundary gets a `[spec census]` digest appended to that tool result, with
//   the no-draft note, and the same file again gets none;
// - a turn that edited but ended without the line only warns: no continuation;
// - a turn that ran promote --write and missed a foreign § computed from Git gets one hidden re-prompt
//   naming it, and never a second; a reply that names it settles at once;
// - a pure Q&A turn needs no line and gets no re-prompt;
// - a worker's promotion committed in a tracked worktree (no tool call of the parent's) makes the turn a
//   blocking one: one re-prompt naming the foreign § computed from that worktree;
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
const specChecks = () => sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "spec-check");
/** Re-prompts (a blocking turn); the warnings that ride the next prompt say "Your previous reply". */
const checks = () => specChecks().filter((e) => /This turn/.test(e.content));
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
	assert.match(seen(requests[at]), /\[spec check\] Your previous reply: your reply has no `Also changes:` line/, "the warning reached the model with the next prompt");
	assert.equal(specChecks().filter((e) => e.display === false && /Your previous reply/.test(e.content)).length, 1, "one hidden warning");
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

	// A worker (simulated: the change lands while the parent waits) commits a promotion in a worktree
	// the session tracks. The parent ran nothing itself, yet the turn lands a foreign §: one re-prompt.
	const wt = path.join(scratch, "wt");
	const wtGit = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt, ...args]).status, 0, `git ${args.join(" ")}`);
	mkdirSync(wt, { recursive: true });
	wtGit("init", "-q");
	for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", "src/App.tsx"]) {
		mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
		writeFileSync(path.join(wt, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel}`], { encoding: "utf8" }).stdout);
	}
	wtGit("add", "-A");
	wtGit("commit", "-qm", "base");
	hostPi.events.emit("worktrees:state", { version: 1, active: [wt] });
	at = requests.length;
	const workerLands = () => {
		writeFileSync(path.join(wt, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, worker wording.\n");
		wtGit("commit", "-qam", "spec: promoted by a worker");
	};
	script.push({ effect: workerLands, text: "The worker finished and promoted. Say when you want it merged." }, { text: "Done.\nAlso changes: §app/shell — worker wording" });
	await session.prompt("have a worker do it in the worktree");
	assert.equal(requests.length, at + 2, "exactly one continuation");
	assert.equal(checks().length, 2);
	assert.match(checks()[1].content, /changed the current spec in wt/);
	assert.match(checks()[1].content, /computed from Git: §app\/shell/);

	// The live B2 sequence: the worktree is created during the run (worktrees:state arrives mid-run), and
	// the worker commits its promotion there later in the same run. Still exactly one re-prompt.
	const wt2 = path.join(scratch, "wt2");
	const wt2Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt2, ...args]).status, 0, `git ${args.join(" ")}`);
	const createWorktree = () => {
		mkdirSync(wt2, { recursive: true });
		wt2Git("init", "-q");
		for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", "src/App.tsx"]) {
			mkdirSync(path.dirname(path.join(wt2, rel)), { recursive: true });
			writeFileSync(path.join(wt2, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel}`], { encoding: "utf8" }).stdout);
		}
		wt2Git("add", "-A");
		wt2Git("commit", "-qm", "base");
		hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2] });
	};
	const worker2Lands = () => {
		writeFileSync(path.join(wt2, "src/App.tsx"), "worker\n");
		wt2Git("commit", "-qam", "code");
		writeFileSync(path.join(wt2, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, second worker wording.\n");
		wt2Git("commit", "-qam", "spec: promoted by a worker");
	};
	at = requests.length;
	const before2 = checks().length;
	script.push(
		{ effect: createWorktree, tool: "bash", args: { command: "true" } },
		{ effect: worker2Lands, text: "The worker committed code and spec. Tell me when you want it merged." },
		{ text: "Done.\nAlso changes: §app/shell — second worker wording" },
	);
	await session.prompt("create a worktree and have a worker do it there");
	assert.equal(requests.length, at + 3, "exactly one continuation for a worktree created mid-run");
	assert.equal(checks().length, before2 + 1);
	assert.match(checks().at(-1).content, /changed the current spec in wt2/);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell/);

	// A planning turn (B3 01:45): a worktree is created (empty) and a planning worker reports
	// "Also changes: none"; the reply has no line. Not a change turn: no warning, now or with the next prompt.
	const wt3 = path.join(scratch, "wt3");
	const createEmpty = () => {
		mkdirSync(wt3, { recursive: true });
		spawnSync("git", ["-C", wt3, "init", "-q"]);
		spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", wt3, "commit", "-q", "--allow-empty", "-m", "base"]);
		hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3] });
	};
	const warns = () => specChecks().filter((e) => /Your previous reply/.test(e.content)).length;
	const warnsBefore = warns();
	const reprompts = checks().length;
	at = requests.length;
	script.push({ effect: createEmpty, tool: "bash", args: { command: "true" } }, { text: "Planned; the worker will start once you confirm." });
	await session.prompt("plan it in a new worktree");
	script.push({ text: "Noted the plan." });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "Planner done: a plan, no edits.\nAlso changes: none", display: true }, { triggerTurn: true });
	script.push({ text: "It is a plan." });
	await session.prompt("what did the planner say?");
	assert.equal(requests.length, at + 4, "no continuation anywhere");
	assert.equal(checks().length, reprompts);
	assert.equal(warns(), warnsBefore, "no warning for a planning turn or a worker's none");

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
