// Offline test that no backend runs spec assessments by itself: a pi session with spec on (mode/index.ts),
// a worktree-config worker (the same file, with the worker role and its launch flags), a pi worker
// (spec-worker.ts alone, as the spawn path's -e loads it) and Claude Code's spec hooks (spec-hooks.ts,
// a fresh process per event, run by the command specHookSettings gives Claude). Each runs against a
// spec core whose sova-spec-assess.mjs is a trap: it appends its argv to a marker file before anything
// else, then runs the real companion. The trap is proven first by calling it directly, a call that
// fails included. Real AgentSessions, a scripted provider, scratch Git projects; no model requests.
//
// Through idle, read, informational bash, a failing bash, a coordination-style tool, edit, the same
// path again, write, a change made outside the session before the settle, the settle and a reopen, with
// a second tracked root, the marker stays empty: no capture, initial-baseline previews included. No
// assessment task or error entry is added (seeded old ones stay as they were), no receipt store appears,
// and no session or worker has an assessment tool, through strict toggles and the reopen too. The
// census digest still rides the edits, and the worker's commit still reaches the parent's ledger, so
// the spec checks ran throughout. Native: old hook state that still carries assessment keys (one a
// corrupt task) loads without a failure note, and keeps those keys as they were.
//
// Calibration: ASSESS_ABSENCE_EXT=<an older pi-config/extensions, a whole extracted tree> with
// ASSESS_ABSENCE_EXPECT=fire runs the same sequences against that tree and requires the trap to fire in
// every backend with its initial-baseline previews, so the harness sees automatic work when there is
// some (c8b5d902's tree fires).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(process.env.ASSESS_ABSENCE_EXT ?? path.join(here, "../.."));
const fire = process.env.ASSESS_ABSENCE_EXPECT === "fire";
const realCore = path.join(ext, "spec/core");
const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "assessment-absence-"));
const marker = path.join(scratch, "assess-calls.jsonl");

// The trap core: every real tool by symlink, the assessment companion replaced by a recorder that then
// runs the real one, so an older tree's capture behaves as it did.
const agentDir = path.join(scratch, "agent");
const core = path.join(agentDir, "extensions/spec/core");
mkdirSync(core, { recursive: true });
for (const name of readdirSync(realCore)) if (name !== "sova-spec-assess.mjs") symlinkSync(path.join(realCore, name), path.join(core, name));
writeFileSync(
	path.join(core, "sova-spec-assess.mjs"),
	`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nawait import(${JSON.stringify(path.join(realCore, "sova-spec-assess.mjs"))});\n`,
);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SPEC_CENSUS_HOOK;
delete process.env.PI_SPEC_CHECK;
delete process.env.SOVA_SPEC_LEDGER;
const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function project(name) {
	const cwd = path.join(scratch, name);
	const put = (rel, text) => {
		mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
		writeFileSync(path.join(cwd, rel), text);
	};
	const git = (...args) => assert.equal(spawnSync("git", ["-C", cwd, ...args]).status, 0, `git ${args.join(" ")}`);
	put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "behavior", code: ["src/App.tsx"], requires: [], authority: "accepted", evidence: "verified" } } }));
	put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
	put(".sova/spec/.gitignore", "/drafts/\n/assessments/\n");
	put("src/App.tsx", "1\n");
	put("src/Other.tsx", "1\n");
	git("init", "-q", "-b", "master");
	git("config", "user.name", "t");
	git("config", "user.email", "t@t");
	git("config", "commit.gpgsign", "false");
	git("add", "-A");
	git("commit", "-qm", "base");
	// Dirty before any session starts: an automatic task-start capture would snapshot it.
	put("src/Other.tsx", "dirty before the task\n");
	return { cwd, put, git, store: path.join(cwd, ".sova/spec/assessments") };
}

// 1. The trap records every call that reaches the companion, one that fails included.
{
	const p = project("calibration");
	const ok = spawnSync(process.execPath, [path.join(core, "sova-spec-assess.mjs"), "status", "--root", p.cwd, "--owner-session", "nobody", "--json"], { encoding: "utf8" });
	assert.ok(ok.stdout.includes('"sova-spec-assess"'), "the trap ran the real companion");
	const failed = spawnSync(process.execPath, [path.join(core, "sova-spec-assess.mjs"), "prepare", "initial-x", "--root", path.join(p.cwd, "absent"), "--json"], { encoding: "utf8" });
	assert.equal(failed.status, 2, "a refused preview");
	assert.deepEqual(calls().map((a) => a[0]), ["status", "prepare"], "both calls are recorded, the refused one too");
	assert.ok(!existsSync(p.store), "and neither wrote a receipt: the marker, not the store, is the instrument");
	rmSync(marker);
}

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");

const script = [];
const requests = [];
function streamSimple(model, context, options) {
	const stream = createAssistantMessageEventStream();
	requests.push(context.messages);
	const step = script.shift() ?? { text: "Done.\nAlso changes: none" };
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
const host = (pi) => {
	pi.registerProvider("scripted", {
		baseUrl: "http://localhost",
		apiKey: "unused",
		api: "openai-completions",
		models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple,
	});
	// A stand-in for a coordination tool (team_msg): any non-read tool once triggered an observation.
	pi.registerTool({ name: "team_msg", label: "team_msg", description: "Send a team message.", parameters: { type: "object", properties: { text: { type: "string" } } }, execute: async () => ({ content: [{ type: "text", text: "sent" }], details: {} }) });
};
/** worktrees/state.ts's bus answer: the session tracks this second root (said now and on discovery, whichever loads first). */
const tracking = (dir) => (pi) => {
	const say = () => pi.events.emit("worktrees:state", { version: 1, active: [dir] });
	pi.events.on("worktrees:discover", say);
	say();
};

async function open(cwd, extension, sessionManager, extra = [], flags = {}) {
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [extension], extensionFactories: [host, ...extra] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager });
	for (const [name, value] of Object.entries(flags)) session.extensionRunner.setFlagValue(name, value);
	await session.bindExtensions({});
	await session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"));
	return session;
}

const work = (p) => [
	{ tool: "read", args: { path: "src/App.tsx" } },
	{ tool: "bash", args: { command: "git status --short && ls src" } },
	{ tool: "bash", args: { command: "false" } },
	{ tool: "team_msg", args: { text: "status" } },
	{ tool: "edit", args: { path: "src/App.tsx", edits: [{ oldText: "1", newText: "2" }] } },
	{ tool: "edit", args: { path: "src/App.tsx", edits: [{ oldText: "2", newText: "22" }] } },
	{ tool: "write", args: { path: "src/New.tsx", content: "new\n" } },
	// Changed outside the session just before the run settles.
	{ before: () => p.put("src/Late.tsx", "late\n"), text: "Done.\nAlso changes: §app/shell — the shell value" },
];

const isAssessment = (e) => e.type === "custom" && /^spec-assessment/.test(e.customType ?? "");
/** What one backend left behind: trap calls, assessment entries beyond the seeded ones, receipt stores. */
function verdict(label, roots, entries, seeded = []) {
	const recorded = calls();
	const stored = roots.flatMap((p) => (existsSync(p.store) ? readdirSync(p.store).filter((n) => !n.startsWith(".")) : []));
	if (fire) {
		assert.ok(recorded.length > 0, `${label}: the older tree's automatic capture reaches the trap`);
		assert.ok(recorded.some((a) => a[0] === "prepare" && /^initial-/.test(a[1] ?? "")), `${label}: its initial-baseline previews included`);
		console.log(`${label}: fired ${recorded.length} call(s): ${[...new Set(recorded.map((a) => a[0]))].join(", ")}; receipts ${stored.length}`);
	} else {
		assert.deepEqual(recorded, [], `${label}: no assessment subprocess, initial-baseline preview included`);
		assert.deepEqual(entries.filter(isAssessment).map((e) => e.id), seeded.map((e) => e.id), `${label}: no assessment task or error entry beyond the seeded old ones`);
		for (const old of seeded) assert.deepEqual(entries.find((e) => e.id === old.id).data, old.data, `${label}: an old ${old.customType} entry stays as it was`);
		assert.deepEqual(stored, [], `${label}: no receipt written`);
	}
	rmSync(marker, { force: true });
}

const censusSeen = () => requests.some((messages) => JSON.stringify(messages).includes("[spec census]"));
const noAssessTool = (session, label) => {
	if (!fire) assert.ok(!session.getAllTools().some((t) => t.name === "spec_assess"), `${label}: no assessment tool`);
};

// 2. A pi session with spec on, and a worktree-config worker: the same file with the worker role.
for (const role of ["session", "worktree-config worker"]) {
	const name = role === "session" ? "parent" : "tree-worker";
	const p = project(name);
	const second = project(`${name}-second`);
	const extra = [tracking(second.cwd), ...(role === "session" ? [] : [(pi) => pi.events.on("subagents:worker-discover", () => pi.events.emit("subagents:worker", { version: 1 }))])];
	// A worktree-config worker's launch flags: normal mode with spec (subagents' modeFlags).
	const flags = role === "session" ? {} : { major: "normal", minor: "spec" };
	const manager = SessionManager.create(p.cwd, path.join(scratch, `${name}-sessions`));
	let session = await open(p.cwd, path.join(ext, "mode/index.ts"), manager, extra, flags);
	try {
		if (role === "session") {
			await session.prompt("/mode spec on");
			noAssessTool(session, role);
			// Strict hides edit/write and restores a snapshot; neither may bring an assessment tool.
			for (const command of ["/mode delegate", "/mode strict on", "/mode strict off", "/mode normal"]) {
				await session.prompt(command);
				noAssessTool(session, `${role} after ${command}`);
			}
			assert.ok(["edit", "write"].every((t) => session.getActiveToolNames().includes(t)), "ordinary edit/write are back");
		}
		await new Promise((r) => setTimeout(r, 50)); // idle
		noAssessTool(session, role);
		requests.length = 0;
		script.push(...work(p));
		await session.prompt("change the shell");
		assert.ok(censusSeen(), `${role}: spec was on (the census digest rode an edit)`);
		const file = manager.getSessionFile();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		// History from the removed observer, as an older session file carries it.
		const reopened = SessionManager.open(file);
		const seeded = [
			["spec-assessment-task-v1", { v: 1, root: p.cwd, task: { v: 1, sessionId: reopened.getSessionId(), taskId: "old", base: null, baseline: { inputs: [] }, paths: [], unknowns: [] }, attemptId: null }],
			["spec-assessment-error", { v: 1, message: "automatic assessment observation unavailable", sessionId: reopened.getSessionId(), taskId: "old", attemptId: null }],
		].map(([type, data]) => ({ id: reopened.appendCustomEntry(type, data), customType: type, data: structuredClone(data) }));
		session = await open(p.cwd, path.join(ext, "mode/index.ts"), reopened, extra, flags);
		noAssessTool(session, `${role} reopened`);
		script.push({ tool: "read", args: { path: "src/App.tsx" } }, { tool: "edit", args: { path: "src/App.tsx", edits: [{ oldText: "22", newText: "3" }] } }, { text: "Done.\nAlso changes: §app/shell — the shell value" });
		await session.prompt("again");
		verdict(`pi ${role}`, [p, second], reopened.getEntries(), fire ? [] : seeded);
	} finally {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose?.();
	}
}

// 3. A pi worker: spec-worker.ts alone. Its commit still reaches the parent's ledger.
{
	const p = project("worker");
	const ledger = path.join(scratch, "worker-ledger.jsonl");
	process.env.SOVA_SPEC_LEDGER = ledger;
	const manager = SessionManager.create(p.cwd, path.join(scratch, "worker-sessions"));
	let session = await open(p.cwd, path.join(ext, "mode/spec-worker.ts"), manager);
	try {
		await new Promise((r) => setTimeout(r, 50));
		noAssessTool(session, "pi worker");
		requests.length = 0;
		script.push(...work(p));
		await session.prompt("change the shell");
		assert.ok(censusSeen(), "pi worker: the census digest still rode an edit");
		const file = manager.getSessionFile();
		session.dispose();
		const reopened = SessionManager.open(file);
		session = await open(p.cwd, path.join(ext, "mode/spec-worker.ts"), reopened);
		noAssessTool(session, "pi worker reopened");
		script.push({ tool: "edit", args: { path: "src/App.tsx", edits: [{ oldText: "22", newText: "3" }] } }, { tool: "bash", args: { command: "git add -A && git commit -qm work" } }, { text: "Done.\nAlso changes: §app/shell — the shell value" });
		await session.prompt("again, and commit");
		const entries = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
		assert.equal(entries.at(-1)?.kind, "commit", "pi worker: its commit is in the parent's ledger");
		verdict("pi worker", [p], reopened.getEntries());
	} finally {
		session.dispose?.();
		delete process.env.SOVA_SPEC_LEDGER;
	}
}

// 4. Claude Code's hooks: each event runs the command the spawn path's --settings gives Claude.
{
	const p = project("native");
	const state = path.join(scratch, "native-state");
	const { specHookSettings } = await jiti.import(path.join(ext, "claude-code/spec-hooks.ts"));
	const settings = specHookSettings({ node: process.execPath, coreDir: core, stateDir: state });
	const command = { turn: settings.hooks.UserPromptSubmit[0].hooks[0].command, pre: settings.hooks.PreToolUse[0].hooks[0].command, post: settings.hooks.PostToolUse[0].hooks[0].command, stop: settings.hooks.Stop[0].hooks[0].command };
	assert.ok(command.post.includes(path.join(ext, "claude-code/spec-hooks.ts")), "the settings run this tree's hook script");
	const run = (event, input) => {
		const r = spawnSync("/bin/sh", ["-c", command[event]], { cwd: p.cwd, encoding: "utf8", input: JSON.stringify({ cwd: p.cwd, ...input }), env: { ...process.env, SOVA_SPEC_OWNER_SESSION: "owner", SOVA_SPEC_WORKER_ID: "ag_01" }, timeout: 60_000 });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
	};
	const hook = (event, input) => run(event, { session_id: "native-session", prompt_id: "prompt-1", ...input });
	const app = path.join(p.cwd, "src/App.tsx");
	const outs = [];
	hook("turn", {});
	outs.push(hook("pre", { tool_name: "Read", tool_input: { file_path: app } }), hook("post", { tool_name: "Read", tool_input: { file_path: app } }));
	outs.push(hook("pre", { tool_name: "Bash", tool_input: { command: "git status --short" } }), hook("post", { tool_name: "Bash", tool_input: { command: "git status --short" } }));
	outs.push(hook("pre", { tool_name: "Edit", tool_input: { file_path: app } }));
	p.put("src/App.tsx", "2\n");
	outs.push(hook("post", { tool_name: "Edit", tool_input: { file_path: app } }));
	outs.push(hook("pre", { tool_name: "Edit", tool_input: { file_path: app } }));
	p.put("src/App.tsx", "22\n");
	outs.push(hook("post", { tool_name: "Edit", tool_input: { file_path: app } }));
	outs.push(hook("stop", { last_assistant_message: "Done.\nAlso changes: §app/shell — the shell value" }));
	const said = JSON.stringify(outs);
	assert.match(said, /\[spec census\]/, "native: the census digest still rides the edit");
	if (!fire) {
		assert.doesNotMatch(said, /\[spec observation\]|assessment observation/i, "native: no assessment note");
		const saved = JSON.parse(readFileSync(path.join(state, "native-session.json"), "utf8"));
		assert.deepEqual(Object.keys(saved).filter((k) => /assessment/i.test(k)), [], "native: no assessment state");
	}
	// Old state written while observation ran (its task corrupt): it loads, says nothing about
	// assessments, captures nothing, and keeps those keys as they were.
	const old = { version: 1, sessionStart: new Date().toISOString(), census: { top: null }, commands: [], turn: { wrote: false, landed: false, foreign: [], blocks: 0 }, assessment: { task: { v: 1, sessionId: "old-session", taskId: 7 }, attemptId: "a", error: "earlier failure" }, assessmentUnavailable: true, assessmentError: "earlier failure" };
	writeFileSync(path.join(state, "old-session.json"), JSON.stringify(old));
	const oldHook = (event, input) => run(event, { session_id: "old-session", ...input });
	const oldOut = [oldHook("pre", { tool_name: "Bash", tool_input: { command: "printf 3 > src/App.tsx" } })];
	p.put("src/App.tsx", "3\n");
	oldOut.push(oldHook("post", { tool_name: "Bash", tool_input: { command: "printf 3 > src/App.tsx" } }), oldHook("stop", { last_assistant_message: "Done.\nAlso changes: §app/shell — the shell value" }));
	if (!fire) {
		assert.doesNotMatch(JSON.stringify(oldOut), /\[spec observation\]|assessment observation/i, "native old state: no failure note");
		const kept = JSON.parse(readFileSync(path.join(state, "old-session.json"), "utf8"));
		assert.deepEqual(kept.assessment, old.assessment, "native old state: its assessment keys are kept as they were, never migrated");
		assert.equal(kept.assessmentError, old.assessmentError);
		assert.equal(kept.assessmentUnavailable, old.assessmentUnavailable);
	}
	verdict("native hooks", [p], []);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`assessment-absence: ok${fire ? " (calibration: the trap fired in every backend)" : ""}`);
