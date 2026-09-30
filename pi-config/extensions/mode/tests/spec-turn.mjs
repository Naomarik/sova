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
// - a hand write of the current spec (write tool, shell) and a reset past a draft's evidence commit are
//   said in the digest of the call that made them; promote's drift warnings are relayed, never a block;
// - a Q&A line is re-prompted once; two merges in one turn list both; an unmapped file needs a Plumbing
//   line and an unpromoted draft a Deferred line (at a landing on main only the override); a worker's ledger commit in the own tree counts;
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
// A draft tool that does nothing: `node <it> promote … --write` is a promote to the checks, and the test
// writes the current spec itself right after, as the real tool would.
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

	// promote --write that changes a foreign §'s text: re-prompts naming it, two at most (the Stop hook's MERGE_BLOCKS).
	git("add", "-A");
	git("commit", "-qm", "work");
	at = requests.length;
	const promote = `node ${noopDraft} promote feat --write; printf '# §app/shell\\n\\nShell, v2.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote } }, { text: "Promoted.\nAlso changes: none" }, { text: "Promoted.\nAlso changes: none" }, { text: "Promoted.\nAlso changes: none" });
	await session.prompt("promote it");
	assert.equal(requests.length, at + 4, "exactly two continuations");
	assert.equal(checks().length, 2);
	assert.equal(checks()[0].display, false, "hidden from the transcript");
	assert.match(checks()[0].content, /promote --write/);
	assert.match(checks()[0].content, /computed from Git: §app\/shell/);
	assert.match(seen(requests[at + 2]), /Also changes: §app\/shell — <what changed>/, "the continuation carried the computed line");

	// The same kind of turn, naming it: settles at once.
	at = requests.length;
	const promote2 = `node ${noopDraft} promote feat --write; printf '# §app/shell\\n\\nShell, v3.\\n' > .sova/spec/claims/app/shell.md`;
	script.push({ tool: "bash", args: { command: promote2 } }, { text: "Promoted.\nAlso changes: §app/shell — v3 wording" });
	await session.prompt("promote again");
	assert.equal(requests.length, at + 2, "a correct line needs no continuation");
	assert.equal(checks().length, 2);

	// A worker commits a promotion in a worktree the session tracks while the parent answers a question
	// (M5/F9): that Q&A turn gets no line forced. Its report then starts a relay run, which lands the
	// foreign §: one re-prompt.
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
	script.push({ effect: workerLands, text: "It renders the shell." });
	await session.prompt("while the worker runs: what does App.tsx do?");
	assert.equal(requests.length, at + 1, "a background promotion forces no line on a Q&A turn");
	assert.equal(checks().length, 2);
	at = requests.length;
	script.push({ text: "The worker finished and promoted. Say when you want it merged." }, { text: "Done.\nAlso changes: §app/shell — worker wording" });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_01 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 2, "exactly one continuation");
	assert.equal(checks().length, 3);
	assert.match(checks().at(-1).content, /changed the current spec in wt/);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell/);

	// The live B2 sequence: the worktree is created during the run (worktrees:state arrives mid-run), and
	// the worker commits its promotion there; its report's relay run gets exactly one re-prompt.
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
		{ effect: worker2Lands, text: "The worker is on it." },
		{ text: "The worker committed code and spec. Tell me when you want it merged." },
		{ text: "Done.\nAlso changes: §app/shell — second worker wording" },
	);
	await session.prompt("create a worktree and have a worker do it there");
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_02 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 4, "exactly one continuation for a worktree created mid-run");
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

	// A worker's report naming a § while no tree changed in this run (B2 merge-4 class): the line is
	// required, but the list is Git's (empty): "none" passes, with no warning.
	const warnsBefore2 = warns();
	script.push({ text: "The worker reported.\nAlso changes: none" });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "Merged master into the branch.\nAlso changes: §app/shell — earlier wording", display: true }, { triggerTurn: true });
	script.push({ text: "Nothing else." });
	await session.prompt("anything else?");
	assert.equal(warns(), warnsBefore2, "a report's § never join Git's list");
	// The same report and a reply without any line: the line was required, so a warning.
	script.push({ text: "The worker reported." });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "Done.\nAlso changes: §app/shell — x", display: true }, { triggerTurn: true });
	script.push({ text: "Ok." });
	await session.prompt("and?");
	assert.equal(warns(), warnsBefore2 + 1, "a named report still makes the line required");

	// B2 work-3's under-count: a worker promotes 2 foreign § in a worktree created mid-run, and its
	// report (cut short by the relay) names only 1. The list is Git's: both.
	const wt4 = path.join(scratch, "wt4");
	const wt4Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt4, ...args]).status, 0, `git ${args.join(" ")}`);
	const put4 = (rel, text) => {
		mkdirSync(path.dirname(path.join(wt4, rel)), { recursive: true });
		writeFileSync(path.join(wt4, rel), text);
	};
	const create4 = () => {
		put4(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] }, "§design/deck": { kind: "note" } } }));
		put4(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
		put4(".sova/spec/claims/design/deck.md", "# §design/deck\n\nDeck.\n");
		put4("src/App.tsx", "1\n");
		wt4Git("init", "-q");
		wt4Git("add", "-A");
		wt4Git("commit", "-qm", "base");
		hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3, wt4] });
	};
	const worker4 = () => {
		put4(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, 4.\n");
		put4(".sova/spec/claims/design/deck.md", "# §design/deck\n\nDeck, 4.\n");
		wt4Git("commit", "-qam", "spec: promoted by a worker");
	};
	at = requests.length;
	const before4 = checks().length;
	script.push(
		{ effect: create4, tool: "bash", args: { command: "true" } },
		{ effect: worker4, text: "The worker is on it." },
		{ text: "Worker report: Also changes: §app/shell — 4 [Final answer: 3,938 chars, whole in /tmp/x]\nAlso changes: §app/shell — 4" },
		{ text: "Done.\nAlso changes: §app/shell — 4; §design/deck — 4" },
	);
	await session.prompt("have a worker do both in a new worktree");
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_04\nAlso changes: §app/shell — 4 [Final answer: 3,938 chars, whole in /tmp/x]", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 4, "one continuation");
	assert.equal(checks().length, before4 + 1);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell, §design\/deck\./, "Git's list, not the truncated line");
	assert.match(checks().at(-1).content, /omits §design\/deck/);

	// M1-B-v21-1: the worker runs in the background. It promotes and commits in a tracked worktree while
	// the session is idle, between runs; its report then starts a run that has no line. The relay run
	// compares against the tree as the last run left it: one re-prompt naming the landed §.
	const wt5 = path.join(scratch, "wt5");
	const wt5Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt5, ...args]).status, 0, `git ${args.join(" ")}`);
	mkdirSync(wt5, { recursive: true });
	wt5Git("init", "-q");
	for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", "src/App.tsx"]) {
		mkdirSync(path.dirname(path.join(wt5, rel)), { recursive: true });
		writeFileSync(path.join(wt5, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel}`], { encoding: "utf8" }).stdout);
	}
	wt5Git("add", "-A");
	wt5Git("commit", "-qm", "base");
	hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3, wt4, wt5] });
	script.push({ text: "The worker is running; I'll check its work when it reports." });
	await session.prompt("have a worker do it in wt5");
	const before5 = checks().length;
	// The session is idle: the worker writes now.
	writeFileSync(path.join(wt5, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, background worker.\n");
	wt5Git("commit", "-qam", "spec: promoted by a background worker");
	at = requests.length;
	script.push({ text: "The worker finished. Tell me when you want it merged." }, { text: "Done.\nAlso changes: §app/shell — background worker" });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_02 finished\n[Final answer: 3,938 chars, whole in /tmp/x]", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 2, "one continuation for the relay run");
	assert.equal(checks().length, before5 + 1);
	assert.match(checks().at(-1).content, /changed the current spec in wt5/);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./);
	// The next run starts from where that one settled: nothing new, no re-prompt.
	script.push({ text: "Nothing new." });
	await session.prompt("status?");
	assert.equal(checks().length, before5 + 1);

	// M1-B-v21-2/-3: the same background commit, but the relay run also does work of its own (here an
	// edit in the session's tree), which used to make it a change turn with an EMPTY Git list: a
	// deferred warning without the landed §. Now: one re-prompt naming them.
	const wt6 = path.join(scratch, "wt6");
	const wt6Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt6, ...args]).status, 0, `git ${args.join(" ")}`);
	mkdirSync(wt6, { recursive: true });
	wt6Git("init", "-q");
	for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", "src/App.tsx"]) {
		mkdirSync(path.dirname(path.join(wt6, rel)), { recursive: true });
		writeFileSync(path.join(wt6, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel}`], { encoding: "utf8" }).stdout);
	}
	wt6Git("add", "-A");
	wt6Git("commit", "-qm", "base");
	hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3, wt4, wt5, wt6] });
	script.push({ text: "The worker is running." });
	await session.prompt("have a worker do it in wt6");
	const before6 = checks().length;
	writeFileSync(path.join(wt6, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, wt6 worker.\n");
	wt6Git("commit", "-qam", "spec: promoted by a background worker");
	at = requests.length;
	script.push(
		{ tool: "bash", args: { command: "printf 'relay\\n' > notes-relay.txt" } },
		{ text: "Checked the worker's work. Say when you want it merged." },
		{ text: "Done.\nAlso changes: §app/shell — wt6 worker" },
	);
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_03 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 3, "a re-prompt, not a deferred warning");
	assert.equal(checks().length, before6 + 1);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./, "the list is not empty");

	// M1-B-s2-1/-3: while the session promotes in its worktree, ANOTHER task lands a spec commit on master
	// in the session's own checkout. That commit is not this turn's: the list is the worktree's § only.
	const addOther = JSON.parse(spawnSync("git", ["-C", cwd, "show", "HEAD:.sova/spec/manifest.json"], { encoding: "utf8" }).stdout);
	addOther.claims["§app/other"] = { kind: "note" };
	put(".sova/spec/manifest.json", JSON.stringify(addOther));
	put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther.\n");
	git("add", "-A");
	git("commit", "-qm", "other claim");
	const wt7 = path.join(scratch, "wt7");
	const wt7Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt7, ...args]).status, 0, `git ${args.join(" ")}`);
	mkdirSync(wt7, { recursive: true });
	wt7Git("init", "-q");
	for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", "src/App.tsx"]) {
		mkdirSync(path.dirname(path.join(wt7, rel)), { recursive: true });
		writeFileSync(path.join(wt7, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel === ".sova/spec/manifest.json" ? rel : rel}`], { encoding: "utf8" }).stdout);
	}
	mkdirSync(path.join(wt7, ".sova/spec/claims/app"), { recursive: true });
	writeFileSync(path.join(wt7, ".sova/spec/claims/app/other.md"), "# §app/other\n\nOther.\n");
	wt7Git("add", "-A");
	wt7Git("commit", "-qm", "base");
	hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3, wt4, wt5, wt6, wt7] });
	const otherTask = () => {
		put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther, by another task.\n");
		git("commit", "-qam", "spec: another task on master");
	};
	at = requests.length;
	const before7 = checks().length;
	script.push(
		{ tool: "bash", args: { command: `node ${noopDraft} promote feat --root ${wt7} --write; printf '# §app/shell\\n\\nShell, wt7.\\n' > ${wt7}/.sova/spec/claims/app/shell.md` } },
		{ effect: otherTask, text: "Promoted.\nAlso changes: none" },
		{ text: "Promoted.\nAlso changes: §app/shell — wt7 wording" },
	);
	await session.prompt("promote it in wt7");
	assert.equal(requests.length, at + 3);
	assert.equal(checks().length, before7 + 1);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./, "another task's §app/other on master is not this turn's");

	// Per-operation ranges: the parent itself merges a branch into master in its root checkout while a
	// third party commits spec changes on master in the same run, before and after the merge. The
	// merge's range (HEAD just before vs just after) is what landed: only the branch's §app/shell.
	const wt8 = path.join(scratch, "wt8");
	git("worktree", "add", "-q", "-b", "feat8", wt8);
	writeFileSync(path.join(wt8, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, feat8.\n");
	assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt8, "commit", "-qam", "feat8 spec"]).status, 0);
	const thirdParty = (text) => () => {
		put(".sova/spec/claims/app/other.md", `# §app/other\n\n${text}\n`);
		git("commit", "-qam", `spec: a third party (${text})`);
	};
	at = requests.length;
	const before8 = checks().length;
	script.push(
		{ effect: thirdParty("Other, before the merge."), tool: "bash", args: { command: "git merge --no-ff --no-edit feat8" } },
		{ effect: thirdParty("Other, after the merge."), text: "Merged.\nAlso changes: none" },
		{ text: "Merged.\nAlso changes: §app/shell — feat8" },
	);
	await session.prompt("merge feat8 into master");
	assert.equal(requests.length, at + 3, "one re-prompt");
	assert.equal(checks().length, before8 + 1);
	assert.match(checks().at(-1).content, /This turn merged\./);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./, "the third party's §app/other, before or after the merge, is not this turn's");
	git("worktree", "remove", "--force", wt8);

	// M2-B-v21-1 (a): a worker promotes in a tracked worktree while the session is idle, and a third party
	// commits spec on master in the ROOT tree; the relay run lists only the worktree's §. (b): the reply
	// names an extra § with an override line; the override never excuses an extra: one re-prompt.
	const wt9 = path.join(scratch, "wt9");
	const wt9Git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wt9, ...args]).status, 0, `git ${args.join(" ")}`);
	mkdirSync(wt9, { recursive: true });
	wt9Git("init", "-q");
	for (const rel of [".sova/spec/manifest.json", ".sova/spec/claims/app/shell.md", ".sova/spec/claims/app/other.md", "src/App.tsx"]) {
		mkdirSync(path.dirname(path.join(wt9, rel)), { recursive: true });
		writeFileSync(path.join(wt9, rel), spawnSync("git", ["-C", cwd, "show", `HEAD:${rel}`], { encoding: "utf8" }).stdout);
	}
	wt9Git("add", "-A");
	wt9Git("commit", "-qm", "base");
	hostPi.events.emit("worktrees:state", { version: 1, active: [wt, wt2, wt3, wt4, wt5, wt6, wt7, wt9] });
	script.push({ text: "The worker is running." });
	await session.prompt("have a worker do it in wt9");
	writeFileSync(path.join(wt9, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, wt9 worker.\n");
	wt9Git("commit", "-qam", "spec: promoted by the worker");
	put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther, third party during the worker.\n");
	git("commit", "-qam", "spec: a third party on master");
	at = requests.length;
	const before9 = checks().length;
	script.push(
		{ text: `Done.\n${"Spec check override:"} §app/other is what users see change too\nAlso changes: §app/shell — wt9; §app/other — users see it` },
		{ text: "Done.\nAlso changes: §app/shell — wt9" },
	);
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_09 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 2, "the override did not pass an extra: one re-prompt");
	assert.equal(checks().length, before9 + 1);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./, "the third party's §app/other on master is not listed");
	assert.match(checks().at(-1).content, /§app\/other isn't changed by this diff: if its user-visible behavior changed, update its claim in a draft and promote; otherwise drop it from the line/);

	// Forbidden writes, said by the call that made them: the current spec written by hand (the write tool,
	// then a shell append), and a reset past a commit a draft's evidence names.
	at = requests.length;
	script.push(
		{ tool: "write", args: { path: ".sova/spec/claims/app/shell.md", content: "# §app/shell\n\nShell, by hand.\n" } },
		{ tool: "bash", args: { command: "printf 'x\\n' >> .sova/spec/claims/app/shell.md" } },
		{ text: "Wrote it.\nAlso changes: §app/shell — by hand" },
	);
	await session.prompt("fix the shell claim");
	for (const i of [1, 2]) assert.match(seen(requests[at + i]), /\[spec census\] you wrote the current spec directly \(\.sova\/spec\/claims\/app\/shell\.md\): undo it; change claims in a draft and promote \(manifest conflicts: merge-manifest\)\./);
	git("checkout", "--", ".sova/spec/claims/app/shell.md");
	const evidenced = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	put(".sova/spec/drafts/ev/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: evidenced, ids: [{ id: "§app/shell" }] }] }));
	at = requests.length;
	script.push({ tool: "bash", args: { command: "git reset -q --hard HEAD~1" } }, { text: "Reset.\nAlso changes: none" });
	await session.prompt("drop the last commit");
	assert.match(seen(requests[at + 1]), new RegExp(`\\[spec census\\] never rebase after evidence \\(PROMOTE\\.md\\): draft ev's evidence commit ${evidenced.slice(0, 12)} \\(§app/shell\\) is no longer on this branch\\. With no uncommitted changes \\(commit them first\\), restore the old tip: \`git reset --hard [0-9a-f]{40}\``));
	assert.equal(seen(requests[at + 1]).split("is no longer on this branch").length, 2, "said once: the census does not repeat the guard's line");
	git("reset", "-q", "--hard", evidenced);

	// promote's drift warnings reach the model with that tool result, as a warning: no continuation.
	at = requests.length;
	const drifted = `node ${noopDraft} promote feat --write; printf '  warn drift: the draft removed 80%% from §app/shell, but §app/other still says it\\n'`;
	script.push({ tool: "bash", args: { command: drifted } }, { text: "Promoted.\nAlso changes: none" });
	await session.prompt("promote the drift");
	assert.match(seen(requests[at + 1]), /\[spec check\] promote's drift warnings \(a warning, not a block\): \(1\) the draft removed 80% from §app\/shell, but §app\/other still says it/);
	assert.equal(requests.length, at + 2, "not a block");

	// M6 (F4): a Q&A turn that writes the line is re-prompted once to drop it.
	at = requests.length;
	script.push({ text: "It renders the shell.\nAlso changes: none" }, { text: "It renders the shell." });
	await session.prompt("what does the shell render?");
	assert.equal(requests.length, at + 2, "one re-prompt for a line on a Q&A turn");
	assert.match(specChecks().at(-1).content, /this turn changed nothing, so it takes no `Also changes:` line: drop it/);

	const main = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const branch = (name, change) => {
		git("checkout", "-q", "-b", name);
		change();
		git("add", "-A");
		git("commit", "-qm", name);
		git("checkout", "-q", main);
	};
	// M5: two merges in one turn: the list is the union of both landings, and (M1) a changed file no claim
	// maps needs a Plumbing line.
	branch("featA", () => put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, featA.\n"));
	branch("featB", () => {
		put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther, featB.\n");
		put("tools/x.sh", "echo build\n");
	});
	at = requests.length;
	const beforeAB = checks().length;
	script.push(
		{ tool: "bash", args: { command: "git merge --no-ff --no-edit featA" } },
		{ tool: "bash", args: { command: "git merge --no-ff --no-edit featB" } },
		{ text: "Merged both.\nAlso changes: §app/shell — featA wording" },
		{ text: "Merged both.\nPlumbing: tools/x.sh — a build helper, no user-visible output\nAlso changes: §app/shell — featA wording; §app/other — featB wording" },
	);
	await session.prompt("merge featA and featB");
	assert.equal(requests.length, at + 4, "one re-prompt, then the right line settles");
	assert.equal(checks().length, beforeAB + 1);
	assert.match(checks().at(-1).content, /computed from Git: §app\/other, §app\/shell\./, "both merges' §");
	assert.match(checks().at(-1).content, /omits §app\/other/);
	assert.match(checks().at(-1).content, /tools\/x\.sh changed and no claim maps it: .*"Plumbing: <path> — <why>"/);

	// M1 (the public-links shape): code under a foreign § changes on a branch whose draft is never
	// promoted. The merge lands on main, the default branch (q14): a Deferred line naming the stale § is
	// re-prompted, and only the override line passes; naming the mapped-untouched § on the last line is no extra.
	const wtC = path.join(scratch, "wtC");
	git("worktree", "add", "-q", "-b", "featC", wtC);
	const draftTool = path.join(agentDir, "extensions/spec/core/sova-spec-draft.mjs");
	assert.equal(spawnSync("node", [draftTool, "new", "links", "--write", "--root", wtC, "--json"], { encoding: "utf8" }).status, 0, "draft new");
	writeFileSync(path.join(wtC, ".sova/spec/drafts/links/spec/claims/app/shell.md"), "# §app/shell\n\nShell, with public links.\n");
	writeFileSync(path.join(wtC, "src/App.tsx"), "public links\n");
	assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", wtC, "commit", "-qam", "public links"]).status, 0);
	at = requests.length;
	const beforeC = checks().length;
	script.push(
		{ tool: "bash", args: { command: "git merge --no-ff --no-edit featC" } },
		{ text: "Merged.\nDeferred: §app/shell — the public-links wording waits for the copy review\nAlso changes: §app/shell — its code now serves public links" },
		{ text: "Merged.\nDeferred: §app/shell — the public-links wording waits for the copy review\nSpec check override: the user ruled §app/shell stays stale until the copy review\nAlso changes: §app/shell — its code now serves public links" },
	);
	await session.prompt("merge featC");
	assert.equal(requests.length, at + 3, "one re-prompt: the Deferred line didn't pass the landing on main, the override did");
	assert.equal(checks().length, beforeC + 1);
	assert.match(checks().at(-1).content, /lands on the default branch with draft records unpromoted: §app\/shell: .*a "Deferred:" line doesn't pass a landing on the default branch/);
	git("worktree", "remove", "--force", wtC);

	// M4: a worker commits a promotion in the session's OWN checkout and says so in its ledger file; a third
	// party's commit right after is not in the ledger. The relay run lists the worker's § only.
	const sid = sessionManager.getSessionId();
	const ledger = path.join(agentDir, "sova", "spec-ledger", `${sid.replace(/[^\w.-]/g, "_")}.jsonl`);
	const headNow = () => spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const topNow = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
	const w0 = headNow();
	put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, own-tree worker.\n");
	git("commit", "-qam", "spec: a worker's promotion in the root");
	// A confined Claude worker writes its own ledger file beside the session's (spec-guard.ts workerLedgerPath).
	const ownLedger = path.join(path.dirname(ledger), `${sid.replace(/[^\w.-]/g, "_")}.workers`, `${sid.replace(/[^\w.-]/g, "_")}-ag_07.jsonl`);
	mkdirSync(path.dirname(ownLedger), { recursive: true });
	writeFileSync(ownLedger, `${JSON.stringify({ v: 1, at: Date.now(), actor: { runtime: "claude-code", session: "ag_07" }, top: topNow, before: w0, after: headNow(), kind: "commit" })}\n`, { flag: "a" });
	put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther, third party.\n");
	git("commit", "-qam", "spec: a third party");
	at = requests.length;
	const beforeD = checks().length;
	script.push({ text: "The worker finished.\nAlso changes: none" }, { text: "The worker finished.\nAlso changes: §app/shell — own-tree worker wording" });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_07 finished", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 2, "one re-prompt for the worker's own-tree commit");
	assert.equal(checks().length, beforeD + 1);
	assert.match(checks().at(-1).content, /commit by ag_07 in project/);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./, "the third party's §app/other is not listed");

	// M5: a run that merges is pinned to its merges. A worker's wake starts it and the parent merges featE
	// (§app/other); the worker's own ledger commit in wt5 (§app/shell) is no part of this list. It is the
	// next change run's.
	branch("featE", () => put(".sova/spec/claims/app/other.md", "# §app/other\n\nOther, featE.\n"));
	const w5 = spawnSync("git", ["-C", wt5, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	writeFileSync(path.join(wt5, ".sova/spec/claims/app/shell.md"), "# §app/shell\n\nShell, wt5 ledger worker.\n");
	wt5Git("commit", "-qam", "spec: a worker's promotion in wt5");
	const w5Top = spawnSync("git", ["-C", wt5, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
	mkdirSync(path.dirname(ledger), { recursive: true });
	writeFileSync(ledger, `${JSON.stringify({ v: 1, at: Date.now(), actor: { runtime: "pi", session: "ag_05" }, top: w5Top, before: w5, after: spawnSync("git", ["-C", wt5, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), kind: "commit" })}\n`, { flag: "a" });
	at = requests.length;
	const beforeE = checks().length;
	script.push({ tool: "bash", args: { command: "git merge --no-ff --no-edit featE" } }, { text: "Merged featE.\nAlso changes: §app/other — featE wording" });
	await session.sendCustomMessage({ customType: "subagent-complete", content: "### ag_05 finished; merge featE now", display: true }, { triggerTurn: true });
	assert.equal(requests.length, at + 2, "the merge's list only: no re-prompt");
	assert.equal(checks().length, beforeE);
	at = requests.length;
	script.push({ tool: "bash", args: { command: "printf 'x\\n' > notes-e.txt" } }, { text: "Noted.\nAlso changes: none" }, { text: "Noted.\nAlso changes: §app/shell — wt5 ledger worker" });
	await session.prompt("note it");
	assert.equal(requests.length, at + 3, "the worker's landing is the next change run's");
	assert.match(checks().at(-1).content, /commit by ag_05 in wt5/);
	assert.match(checks().at(-1).content, /computed from Git: §app\/shell\./);

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
