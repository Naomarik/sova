// The writing procedure a codemode script's call hands over reaches the script's own result, whole
// (§chat.mode-menu/codemode, §tools.spec/writing-on-demand), driven through the real index.ts with a
// fake ExtensionAPI on a real Git tree. No model requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "codemode-handover-"));
const specDir = path.resolve(new URL("../../spec", import.meta.url).pathname);
const agentDir = path.join(scratch, "agent");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
symlinkSync(specDir, path.join(agentDir, "extensions/spec"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SPEC_CENSUS_HOOK;

const cwd = path.join(scratch, "project");
const put = (rel, text) => {
	mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
	writeFileSync(path.join(cwd, rel), text);
};
const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args]).status, 0, `git ${args.join(" ")}`);
put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } } }));
put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
put("src/App.tsx", "1\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "base");

const here = (p) => pathToFileURL(path.resolve(new URL(p, import.meta.url).pathname)).href;
const modeExtension = (await jiti.import(here("../index.ts"))).default;
const { PROCEDURE_HEAD } = await jiti.import(here("../spec-guard.ts"));

const hooks = new Map();
let active = ["read", "bash", "edit", "write", "grep"];
const flags = { minor: "spec" };
const api = {
	events: { on: () => () => {}, emit() {} },
	on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
	registerFlag: (name, options) => api.flags.set(name, options),
	getFlag: (name) => flags[name] ?? api.flags.get(name)?.default,
	registerCommand() {},
	registerShortcut() {},
	appendEntry() {},
	registerEntryRenderer() {},
	registerMessageRenderer() {},
	registerTool() {},
	sendMessage() {},
	sendUserMessage() {},
	getActiveTools: () => [...active],
	setActiveTools: (next) => (active = [...next]),
	getAllTools: () => active.map((name) => ({ name })),
	flags: new Map(),
};
const branch = [];
const ctx = {
	hasUI: false,
	mode: "rpc",
	cwd,
	isIdle: () => true,
	signal: undefined,
	sessionManager: { getBranch: () => branch, getEntries: () => branch, getHeader: () => ({ timestamp: new Date().toISOString() }), getSessionFile: () => undefined, getSessionId: () => "s1" },
	ui: { setStatus() {}, notify() {}, setWidget() {}, custom: async () => undefined, theme: { fg: (_t, s) => s, bold: (s) => s, bg: (_t, s) => s } },
};
modeExtension(api);
const fire = async (name, event = {}) => {
	let out;
	for (const h of hooks.get(name) ?? []) out = (await h(event, ctx)) ?? out;
	return out;
};
const text = (result) => (result?.content ?? []).map((c) => c.text ?? "").join("\n");

try {
	await fire("session_start", { reason: "startup" });
	await fire("agent_start");
	// A script (the codemode call) runs one nested bash call that edits in the boundary.
	const script = { toolCallId: "s1", toolName: "codemode", input: { code: "await bash(...)" } };
	const nested = { toolCallId: "s1/1", parentToolCallId: "s1", toolName: "bash", input: { command: "printf '2\\n' > src/App.tsx" } };
	await fire("tool_call", script);
	await fire("tool_call", nested);
	put("src/App.tsx", "2\n");
	const inner = await fire("tool_result", { ...nested, content: [{ type: "text", text: "" }], isError: false });
	assert.match(text(inner), /\[spec census\]/, "the nested call got the census note");
	const outer = await fire("tool_result", { ...script, content: [{ type: "text", text: "script output" }], isError: false });
	const seen = text(outer);
	assert.match(seen, /\[spec census\] 1 changed file\(s\) in the boundary/, "the note is repeated on the script's result");
	const writing = readFileSync(path.join(specDir, "WRITING.md"), "utf8").trimEnd();
	assert.ok(seen.includes(`${PROCEDURE_HEAD}; also at ${path.join(agentDir, "extensions/spec/WRITING.md")}):\n\n${writing}`), "the procedure reaches the script's result whole, blank lines kept");
	assert.equal(seen.split(PROCEDURE_HEAD).length - 1, 1, "once");
	// The next script's note doesn't repeat it.
	await fire("tool_call", { ...script, toolCallId: "s2" });
	await fire("tool_call", { ...nested, toolCallId: "s2/1", parentToolCallId: "s2" });
	put("src/Other.tsx", "x\n");
	await fire("tool_result", { ...nested, toolCallId: "s2/1", parentToolCallId: "s2", content: [], isError: false });
	const again = text(await fire("tool_result", { ...script, toolCallId: "s2", content: [{ type: "text", text: "ok" }], isError: false }));
	assert.match(again, /\[spec census\]/);
	assert.ok(!again.includes(PROCEDURE_HEAD), "said once per chat");
	console.log("codemode-handover: ok");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
