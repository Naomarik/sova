// A project mode's commands and hooks, the format half (§chat.mode-menu/project-mode-commands,
// §chat.mode-menu/project-mode-hooks): MODE.md's `commands` and `hooks` keys, what the approval hash covers, the
// call-time check of a copy that has them, and who approved (hooks need the user). The runner and the gate are
// Sova's (server/mode-commands.ts) and tested there.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProjectMode, sha256, toolsHashOf } from "./project-discovery.ts";
import { ModeFileError, parseModeFile, projectModeBlock, snapshotShaInput, toolsHashInput, type ProjectModeSnapshot } from "./project-format.ts";
import { isApproved, isApprovedByUser, readApprovals, projectKey, recordApproval } from "./project-tools-approval.ts";
import { refuseCall, runProjectTool } from "./project-tools.ts";

// Taken on the base (9d508bba) with its own project-format.ts: a mode without commands or hooks must hash and
// parse exactly as it did there, so no approval given before this change is asked again.
const OLD_MD = `---\ndescription: Release checks\nworkers: yes\ntools: [{"name": "status", "description": "Show status", "command": ["./status.sh", "--short"], "timeoutS": 20}, {"name": "run_tests", "description": "Run tests", "params": {"type": "object", "properties": {"filter": {"type": "string"}}}, "command": ["node", "./t.mjs"]}]\n---\nDo the release.\n`;
const OLD_SHAS = { "./status.sh": "1".repeat(64), "./t.mjs": "2".repeat(64), "./ref/notes.md": "3".repeat(64) };
const BASE_TOOLS_HASH = "a8351136c3e40cedb260545d7375c6e9f4441ebd6eeda57876fc158f4a62ad0d";
const BASE_SNAPSHOT_SHA = "183881590b7c6e3a50dfbb4ece41eabda8622e55346f8e7ab40f2222eb193e60";
const BASE_PARSED =
	'{"description":"Release checks","workers":true,"tools":[{"name":"status","description":"Show status","params":{"type":"object","properties":{}},"command":["./status.sh","--short"],"timeoutS":20},{"name":"run_tests","description":"Run tests","params":{"type":"object","properties":{"filter":{"type":"string"}}},"command":["node","./t.mjs"],"timeoutS":60}],"body":"Do the release."}';

const withKeys = (extra: string) => `---\ndescription: Release\ntools: [{"name": "status", "description": "Show status", "command": ["./status.sh"]}]\n${extra}\n---\nBody.\n`;
const CMD = `commands: [{"name": "release_check", "description": "Run the checks", "run": ["./check.sh", "--all"], "timeoutS": 120}]`;
const HOOK = `hooks: [{"on": "turn.ended", "run": ["./notify.sh"]}]`;

test("a MODE.md without commands or hooks parses, hashes and copies exactly as on the base", () => {
	const parsed = parseModeFile(OLD_MD);
	assert.equal(JSON.stringify(parsed), BASE_PARSED);
	assert.equal("commands" in parsed || "hooks" in parsed, false);
	const toolsHash = sha256(toolsHashInput(parsed.tools, OLD_SHAS));
	assert.equal(toolsHash, BASE_TOOLS_HASH);
	// An empty actions object is "none" too.
	assert.equal(sha256(toolsHashInput(parsed.tools, OLD_SHAS, { commands: [], hooks: [] })), BASE_TOOLS_HASH);
	const text = projectModeBlock("release", "/x/.sova/minor-modes/release", parsed.body);
	assert.equal(sha256(snapshotShaInput({ text, description: parsed.description, workers: parsed.workers, tools: parsed.tools, toolsHash })), BASE_SNAPSHOT_SHA);
});

test("commands and hooks parse into the runner's shape", () => {
	const parsed = parseModeFile(withKeys(`${CMD}\n${HOOK}`));
	assert.deepEqual(parsed.commands, [{ name: "release_check", description: "Run the checks", params: { type: "object", properties: {} }, command: ["./check.sh", "--all"], timeoutS: 120 }]);
	assert.deepEqual(parsed.hooks, [{ on: "turn.ended", command: ["./notify.sh"], timeoutS: 30 }]);
	const started = parseModeFile(withKeys(`hooks: [{"on": "turn.started", "run": ["sh", "./a.sh"], "timeoutS": 5}]`));
	assert.deepEqual(started.hooks, [{ on: "turn.started", command: ["sh", "./a.sh"], timeoutS: 5 }]);
});

test("each bad command or hook makes the mode broken, with its sentence", () => {
	const bad: [string, RegExp][] = [
		[`commands: {"name": "x"}`, /commands must be a JSON array/],
		[`commands: [{"name": "Bad-Name", "description": "d", "run": ["sh"]}]`, /command 1: name must be/],
		[`commands: [{"name": "a", "description": "d", "run": ["sh"]}, {"name": "a", "description": "d", "run": ["sh"]}]`, /name "a" given twice/],
		[`commands: [{"name": "a", "run": ["sh"]}]`, /command "a" needs a description/],
		[`commands: [{"name": "a", "description": "d", "command": ["sh"]}]`, /unknown field "command"/],
		[`commands: [{"name": "a", "description": "d", "run": ["sh", "scripts/x.sh"]}]`, /must be a \.\/path inside the mode folder/],
		[`commands: [{"name": "a", "description": "d", "run": []}]`, /run must be a non-empty array/],
		[`commands: [{"name": "a", "description": "d", "run": ["sh"], "timeoutS": 0}]`, /timeoutS must be a whole number/],
		[`commands: [${Array.from({ length: 17 }, (_, i) => `{"name": "c${i}", "description": "d", "run": ["sh"]}`).join(",")}]`, /declares 17 commands; at most 16/],
		[`hooks: [{"on": "session.created", "run": ["sh"]}]`, /on must be one of turn\.started, turn\.ended/],
		[`hooks: [{"on": "turn.ended"}]`, /hook 1: run must be a non-empty array/],
		[`hooks: [{"on": "turn.ended", "run": ["sh", "../x.sh"]}]`, /must be a \.\/path inside the mode folder/],
		[`hooks: [{"on": "turn.ended", "run": ["sh"], "name": "x"}]`, /unknown field "name"/],
		[`hooks: [{"on": "turn.ended", "run": ["sh"], "timeoutS": 601}]`, /timeoutS must be a whole number/],
		[`hooks: [${Array.from({ length: 9 }, () => `{"on": "turn.ended", "run": ["sh"]}`).join(",")}]`, /declares 9 hooks; at most 8/],
		[`hooks: [1]`, /hook 1 must be an object/],
	];
	for (const [extra, re] of bad) assert.throws(() => parseModeFile(withKeys(extra)), (e: unknown) => e instanceof ModeFileError && re.test(e.message), extra);
});

test("the approval hash covers commands and hooks: each change is a new hash; a hooks-only mode has one", () => {
	const shas = { "./status.sh": "1".repeat(64) };
	const hashOf = (md: string) => {
		const p = parseModeFile(md);
		return sha256(toolsHashInput(p.tools, shas, { commands: p.commands, hooks: p.hooks }));
	};
	const plain = hashOf(withKeys(""));
	const withCmd = hashOf(withKeys(CMD));
	const cmdArgv = hashOf(withKeys(CMD.replace("--all", "--fast")));
	const withHook = hashOf(withKeys(`${CMD}\n${HOOK}`));
	const hookOn = hashOf(withKeys(`${CMD}\n${HOOK.replace("turn.ended", "turn.started")}`));
	assert.equal(new Set([plain, withCmd, cmdArgv, withHook, hookOn]).size, 5);
	// A mode with only a hook (no tools) still runs something: it needs approval.
	const hooksOnly = parseModeFile(`---\ndescription: d\n${HOOK}\n---\nBody.\n`);
	assert.equal(hooksOnly.tools.length, 0);
	const f = folder({ "MODE.md": `---\ndescription: d\n${HOOK}\n---\nBody.\n`, "notify.sh": "#!/bin/sh\n" });
	try {
		const read = readProjectMode(f.modes, "m") as ProjectModeSnapshot;
		assert.ok("toolsHash" in read && /^[0-9a-f]{64}$/.test(read.toolsHash), "a hooks-only mode has an approval hash");
		assert.deepEqual(read.hooks, hooksOnly.hooks);
		assert.equal(read.commands, undefined, "no commands key on a copy without commands");
	} finally {
		f.done();
	}
});

test("a missing ./ file of a command or hook makes the mode broken", () => {
	const f = folder({ "MODE.md": withKeys(HOOK), "status.sh": "#!/bin/sh\n" });
	try {
		const read = readProjectMode(f.modes, "m");
		assert.ok("kind" in read && /tool file \.\/notify\.sh is not a file/.test(read.error));
	} finally {
		f.done();
	}
});

test("a copy with commands still runs its unchanged tools; an edited file still refuses them", () => {
	const f = folder({ "MODE.md": withKeys(`${CMD}\n${HOOK}`), "status.sh": "#!/bin/sh\n", "check.sh": "#!/bin/sh\n", "notify.sh": "#!/bin/sh\n" });
	try {
		const copy = readProjectMode(f.modes, "m") as ProjectModeSnapshot;
		assert.equal(toolsHashOf(copy.dir, copy.tools, { commands: copy.commands, hooks: copy.hooks }), copy.toolsHash);
		const opts = { sandboxOn: () => false, isOn: () => true };
		assert.equal(refuseCall(copy, "m__status", opts), undefined, "the whole approved declaration is re-hashed, not the tools alone");
		writeFileSync(join(copy.dir, "notify.sh"), "#!/bin/sh\necho changed\n");
		assert.match(refuseCall(copy, "m__status", opts) ?? "", /changed since it was approved/);
	} finally {
		f.done();
	}
});

test("approval: hooks need the user's own record; the Overseer never takes a user's approval over", () => {
	const base = mkdtempSync(join(tmpdir(), "project-actions-"));
	try {
		const root = join(base, "repo");
		mkdirSync(root);
		const file = join(base, "approvals.json");
		const h = "c".repeat(64);
		// Overseer then user: the user's Approve Hooks makes the record the user's.
		recordApproval(root, "m", h, "overseer", file);
		assert.equal(isApproved(root, "m", h, file), true);
		assert.equal(isApprovedByUser(root, "m", h, file), false, "an Overseer approval never approves hooks");
		recordApproval(root, "m", h, "user", file);
		assert.equal(isApprovedByUser(root, "m", h, file), true);
		// User then Overseer: the record stays the user's.
		const h2 = "d".repeat(64);
		recordApproval(root, "m", h2, "user", file);
		recordApproval(root, "m", h2, "overseer", file);
		assert.equal(isApprovedByUser(root, "m", h2, file), true);
		assert.deepEqual(readApprovals(file).approvals[projectKey(root)]!.m!.map((r) => [r.hash, r.by]), [[h2, "user"], [h, "user"]]);
		assert.equal(isApprovedByUser(root, "m", "", file), true, "a mode that runs nothing needs nothing");
		// Any other caller of the approval route: kept (tools and commands run on it), never the user's.
		const h3 = "e".repeat(64);
		recordApproval(root, "m", h3, "caller", file);
		assert.equal(isApproved(root, "m", h3, file), true);
		assert.equal(isApprovedByUser(root, "m", h3, file), false);
		recordApproval(root, "m", h3, "user", file);
		assert.equal(isApprovedByUser(root, "m", h3, file), true);
		recordApproval(root, "m", h3, "caller", file);
		assert.equal(isApprovedByUser(root, "m", h3, file), true, "a caller never takes the user's approval over");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a hook run gets SOVA_HOOK_EVENT, never SOVA_TOOL_NAME; a tool keeps SOVA_TOOL_NAME", async () => {
	const f = folder({ "MODE.md": withKeys(""), "status.sh": "#!/bin/sh\nenv\n" });
	try {
		const dir = join(f.modes, "m");
		chmodSync(join(dir, "status.sh"), 0o755);
		const hook = await runProjectTool({ dir, modeId: "m", projectRoot: f.root, cwd: f.root, tool: { command: ["./status.sh"], timeoutS: 5 }, args: {}, hookEvent: "turn.ended", env: { PATH: process.env.PATH } });
		assert.match(hook.stdout, /^SOVA_HOOK_EVENT=turn\.ended$/m);
		assert.doesNotMatch(hook.stdout, /SOVA_TOOL_NAME/);
		const tool = await runProjectTool({ dir, modeId: "m", projectRoot: f.root, cwd: f.root, tool: { name: "status", command: ["./status.sh"], timeoutS: 5 }, args: {}, env: { PATH: process.env.PATH } });
		assert.match(tool.stdout, /^SOVA_TOOL_NAME=status$/m);
		assert.doesNotMatch(tool.stdout, /SOVA_HOOK_EVENT/);
	} finally {
		f.done();
	}
});

/** A checkout with one mode folder `m` holding `files`. */
function folder(files: Record<string, string>) {
	const base = mkdtempSync(join(tmpdir(), "project-actions-"));
	const root = join(base, "repo");
	const modes = join(root, ".sova", "minor-modes");
	mkdirSync(join(modes, "m"), { recursive: true });
	mkdirSync(join(root, ".git"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(modes, "m", name), body);
	return { root, modes, done: () => rmSync(base, { recursive: true, force: true }) };
}
