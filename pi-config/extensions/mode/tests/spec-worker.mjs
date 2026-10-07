// Offline SDK test of spec-worker.ts, the census a spec-on session's code-writing pi WORKER loads with
// `-e` (workers start with --no-extensions, so the mode extension is absent): a real AgentSession that
// loads only this file, a scripted provider, the real spec tools through the agent dir, a scratch Git
// project. No model requests. The worker's first edit carries the `[spec census]` digest (with the
// no-draft note), the same file again none, and a new unmapped file outside the boundary its own line.
// A turn ends when the model stops: an edit run, a promote and a merge into master end without a
// re-prompt, whatever the reply says, and a worker started with an old parent's SOVA_SPEC_LEDGER set
// writes no ledger.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "spec-worker-"));
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
const ledger = path.join(scratch, "parent-ledger.jsonl");
process.env.SOVA_SPEC_LEDGER = ledger;

const cwd = path.join(scratch, "worktree");
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
put(".sova/spec/.gitignore", "/drafts/\n");
put("src/App.tsx", "1\n");
put("tools/footer.ts", "1\n");
git("init", "-q", "-b", "master");
git("add", "-A");
git("commit", "-qm", "base");

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");

const requests = [];
const script = [];
function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	requests.push({ messages: context.messages });
	const step = script.shift() ?? { text: "ok" };
	step.before?.();
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

// Only spec-worker.ts, as the spawn path's `-e` loads it into a --no-extensions worker.
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	noExtensions: true,
	additionalExtensionPaths: [path.resolve(here, "../spec-worker.ts")],
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
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
const seen = (req) => JSON.stringify(req.messages);
const toolText = (req) => JSON.stringify(req.messages.filter((m) => m.role === "toolResult").at(-1) ?? {});
try {
	await session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"));

	// A read after the tree changed mid-run says nothing and moves no baseline; the worker's first edit, a
	// bash heredoc in the boundary, then carries the digest.
	script.push(
		{ before: () => put("src/App.tsx", "2\n"), tool: "read", args: { path: "src/App.tsx" } },
		{ tool: "bash", args: { command: "cat > src/App.tsx <<'EOF'\n2\nEOF" } },
		{ tool: "bash", args: { command: "printf '3\\n' > src/App.tsx" } },
		{ tool: "bash", args: { command: "printf '2\\n' > tools/footer.ts" } },
		{ text: "Done." },
	);
	await session.prompt("change the shell and the footer");
	assert.equal(requests.length, 5, "an edit run ends when the model stops");
	assert.doesNotMatch(toolText(requests[1]), /\[spec census\]/, "a read is skipped");
	assert.match(toolText(requests[2]), /\[spec census\] 1 changed file\(s\) in the boundary/, "the first edit carries the digest");
	assert.match(toolText(requests[2]), /No draft yet/);
	assert.match(toolText(requests[2]), /§app\/shell/);
	assert.doesNotMatch(toolText(requests[3]), /\[spec census\]/, "the same file again: no digest");
	assert.match(toolText(requests[4]), /Outside the boundary, no claim maps: tools\/footer\.ts: spec any whose change a user sees/, "a new unmapped file outside the boundary: its line");
	assert.ok(seen(requests[4]).includes("spec census"));

	// A promote: no re-prompt, and no ledger.
	git("add", "-A");
	git("commit", "-qm", "work");
	let at = requests.length;
	// The tool through a path held in $d (R3-B-s3-3's form): still a promote.
	const promote = `d=${noopDraft}; node "$d" promote feat --write; printf '# §app/shell\\n\\nShell, v2.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote } }, { text: "Promoted." });
	await session.prompt("promote it");
	assert.equal(requests.length, at + 2, "a landing ends when the model stops");

	// A merge into master with a draft left unpromoted: no re-prompt either.
	git("commit", "-qam", "promoted");
	const wtD = path.join(scratch, "wtD");
	git("worktree", "add", "-q", "-b", "featD", wtD);
	const draftTool = path.join(agentDir, "extensions/spec/core/sova-spec-draft.mjs");
	assert.equal(spawnSync("node", [draftTool, "new", "links", "--write", "--root", wtD, "--json"]).status, 0, "draft new");
	writeFileSync(path.join(wtD, ".sova/spec/drafts/links/spec/claims/app/shell.md"), "# §app/shell\n\nShell, with public links.\n");
	writeFileSync(path.join(wtD, "src/App.tsx"), "public links\n");
	assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wtD, "commit", "-qam", "public links"]).status, 0);
	at = requests.length;
	script.push({ tool: "bash", args: { command: "git merge --no-ff --no-edit featD" } }, { text: "Merged." });
	await session.prompt("merge featD into master");
	assert.equal(requests.length, at + 2);

	assert.ok(!existsSync(ledger), "no ledger is written");
	assert.deepEqual(sessionManager.getBranch().filter((e) => e.customType === "spec-check"), []);
	assert.doesNotMatch(JSON.stringify(requests.map((r) => r.messages)), /\[spec check\]|Also changes/);
	console.log("spec-worker: ok");
} finally {
	session.dispose?.();
	rmSync(scratch, { recursive: true, force: true });
}
