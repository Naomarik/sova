// Offline SDK test of the spec minor mode's mechanical checks in a real AgentSession, with a scripted
// provider, the real mode extension and the real spec tools (through the agent dir, like the prompt's
// $core) on a scratch Git project. No model requests. It checks:
// - a bash write in the spec boundary gets a `[spec census]` digest appended to that tool result, with
//   the no-draft note, and the same file again gets none;
// - a turn ends when the model stops: an edit, a promote and a Q&A reply with an old closing line all end
//   without a re-prompt, warning, record or card, and nothing says `[spec check]`;
// - a hand write of the current spec (write tool, shell) and a reset past a draft's evidence commit are
//   said in the digest of the call that made them; promote's drift warnings are relayed, never a block;
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
// A draft tool that does nothing: `node <it> promote … --write` is a promote to the census, and the test
// writes the current spec itself right after, as the real tool would.
const noopDraft = path.join(scratch, "noop", "sova-spec-draft.mjs");
mkdirSync(path.dirname(noopDraft), { recursive: true });
writeFileSync(noopDraft, "");
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
	const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step.outcome ?? "stop", timestamp: Date.now() };
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
	assert.equal(requests.length, at + 2, "an edit turn ends when the model stops: no continuation");
	assert.match(seen(requests[at + 1]), /\[spec census\] 1 changed file\(s\) in the boundary/, "the digest reached the model");
	assert.match(seen(requests[at + 1]), /No draft yet/);
	assert.match(seen(requests[at + 1]), /§app\/shell/);

	// The same file again: no second digest, and still nothing at the turn's end.
	at = requests.length;
	script.push({ tool: "bash", args: { command: "printf '3\\n' > src/App.tsx" } }, { text: "Again." });
	await session.prompt("once more");
	assert.equal(requests.length, at + 2);
	assert.doesNotMatch(seen(requests[at + 1]).split("once more")[1] ?? "", /\[spec census\]/, "no digest for a file already reported");

	// A promote --write that changes a claim's text: no re-prompt, warning or line asked for.
	git("add", "-A");
	git("commit", "-qm", "work");
	at = requests.length;
	const promote = `node ${noopDraft} promote feat --write; printf '# §app/shell\\n\\nShell, v2.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote } }, { text: "Promoted." });
	await session.prompt("promote it");
	assert.equal(requests.length, at + 2, "a landing ends when the model stops");
	git("add", "-A");
	git("commit", "-qm", "promoted");

	// A reply that still writes an old closing line is left alone too.
	at = requests.length;
	script.push({ text: "It renders the shell.\nAlso changes: none" });
	await session.prompt("what does the shell render?");
	assert.equal(requests.length, at + 1);

	// Forbidden writes, said by the call that made them: the current spec written by hand (the write tool,
	// then a shell append), and a reset past a commit a draft's evidence names.
	at = requests.length;
	script.push(
		{ tool: "write", args: { path: ".sova/spec/claims/app/shell.md", content: "# §app/shell\n\nShell, by hand.\n" } },
		{ tool: "bash", args: { command: "printf 'x\\n' >> .sova/spec/claims/app/shell.md" } },
		{ text: "Wrote it." },
	);
	await session.prompt("fix the shell claim");
	for (const i of [1, 2]) assert.match(seen(requests[at + i]), /\[spec census\] you wrote the current spec directly \(\.sova\/spec\/claims\/app\/shell\.md\): undo it; change claims in a draft and promote \(manifest conflicts: merge-manifest\)\./);
	git("checkout", "--", ".sova/spec/claims/app/shell.md");
	const evidenced = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	put(".sova/spec/drafts/ev/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: evidenced, ids: [{ id: "§app/shell" }] }] }));
	at = requests.length;
	script.push({ tool: "bash", args: { command: "git reset -q --hard HEAD~1" } }, { text: "Reset." });
	await session.prompt("drop the last commit");
	assert.match(seen(requests[at + 1]), new RegExp(`\\[spec census\\] never rebase after evidence \\(PROMOTE\\.md\\): draft ev's evidence commit ${evidenced.slice(0, 12)} \\(§app/shell\\) is no longer on this branch\\. With no uncommitted changes \\(commit them first\\), restore the old tip: \`git reset --hard [0-9a-f]{40}\``));
	assert.equal(seen(requests[at + 1]).split("is no longer on this branch").length, 2, "said once: the census does not repeat the guard's line");
	git("reset", "-q", "--hard", evidenced);

	// promote's drift warnings reach the model with that tool result, as a warning: no continuation.
	at = requests.length;
	const drifted = `node ${noopDraft} promote feat --write; printf '  warn drift: the draft removed 80%% from §app/shell, but §app/other still says it\\n'`;
	script.push({ tool: "bash", args: { command: drifted } }, { text: "Promoted." });
	await session.prompt("promote the drift");
	assert.match(seen(requests[at + 1]), /\[spec census\] promote's drift warnings: \(1\) the draft removed 80% from §app\/shell, but §app\/other still says it/);
	assert.equal(requests.length, at + 2, "not a block");

	// No turn left a spec note, record or card behind, and nothing said "[spec check]".
	const branch = sessionManager.getBranch();
	assert.deepEqual(branch.filter((e) => e.customType === "spec-check" || e.customType === "spec-turn" || e.customType === "spec-check-error"), []);
	assert.doesNotMatch(JSON.stringify(requests.map((r) => r.messages)), /\[spec check\]|Also changes: §|Plumbing:|Deferred:/);
	console.log("spec-turn: ok");
} finally {
	session.dispose?.();
	rmSync(scratch, { recursive: true, force: true });
}
