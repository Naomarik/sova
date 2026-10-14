import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolsHashOf } from "./project-discovery.ts";
import type { ProjectModeTool } from "./project-format.ts";
import { approvalsFile, APPROVALS_KEPT, isApproved, projectKey, readApprovals, recordApproval } from "./project-tools-approval.ts";
import { changedText, PROJECT_TOOLS_FILE_ENV, projectRootOfModeDir, projectToolDefinitions, readWorkerToolsFile, resolveCommand, runProjectTool, sandboxText, writeWorkerToolsFile } from "./project-tools.ts";
import projectToolsWorker from "./project-tools-worker.ts";

/** A checkout with one mode folder `<root>/.sova/minor-modes/<id>`, and a cwd beside it. */
function fixture(id = "release-check") {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "project-tools-")));
	const root = join(base, "repo");
	const dir = join(root, ".sova", "minor-modes", id);
	mkdirSync(dir, { recursive: true });
	const cwd = join(root, "sub");
	mkdirSync(cwd);
	return { base, root, dir, cwd, done: () => rmSync(base, { recursive: true, force: true }) };
}

function script(dir: string, rel: string, body: string): string {
	const path = join(dir, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

const tool = (over: Partial<ProjectModeTool> = {}): ProjectModeTool => ({
	name: "status",
	description: "Report status",
	params: { type: "object", properties: { q: { type: "string" } } },
	command: ["./bin/status"],
	timeoutS: 60,
	...over,
});

const snapshotOf = (dir: string, tools: ProjectModeTool[], id = "release-check") => ({ id, dir, tools, toolsHash: toolsHashOf(dir, tools) });

test("resolveCommand: ./ elements become absolute folder paths, bare ones pass through", () => {
	const f = fixture();
	try {
		const r = resolveCommand(f.dir, ["python3", "./tools/x.py", "--flag", "plain"]);
		assert.deepEqual(r, { argv: ["python3", join(f.dir, "tools/x.py"), "--flag", "plain"] });
		assert.ok("error" in resolveCommand(f.dir, ["node", "scripts/check.js"]), "a later argument with a / that isn't ./ is refused");
		assert.ok("error" in resolveCommand(f.dir, ["cat", "/etc/hosts"]), "an absolute argument is refused");
		assert.ok("error" in resolveCommand(f.dir, ["/usr/bin/env"]), "an absolute program is refused");
		assert.ok("error" in resolveCommand(f.dir, ["bin/x"]), "a program path without ./ is refused");
		assert.ok("error" in resolveCommand(f.dir, ["./../escape"]), "a .. segment is refused");
		assert.ok("error" in resolveCommand(f.dir, []), "an empty command is refused");
	} finally {
		f.done();
	}
});

test("resolveCommand refuses a ./ file that is a symlink out of the mode folder", () => {
	const f = fixture();
	try {
		const outside = script(f.base, "outside.sh", "echo out");
		symlinkSync(outside, join(f.dir, "link"));
		const r = resolveCommand(f.dir, ["./link"]);
		assert.ok("error" in r && /links outside/.test(r.error));
	} finally {
		f.done();
	}
});

test("runProjectTool: args arrive as JSON on stdin, cwd is the session's, env names the mode", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", 'cat; echo; pwd; echo "$SOVA_MODE_ID|$SOVA_MODE_DIR|$SOVA_PROJECT_ROOT|$SOVA_TOOL_NAME"; echo oops >&2; exit 3');
		const run = await runProjectTool({ dir: f.dir, modeId: "release-check", projectRoot: f.root, cwd: f.cwd, tool: tool(), args: { q: "héllo" } });
		assert.equal(run.exitCode, 3);
		assert.equal(run.stdout, `{"q":"héllo"}\n${f.cwd}\nrelease-check|${f.dir}|${f.root}|status\n`);
		assert.equal(run.stderr, "oops\n");
		assert.deepEqual(run.truncated, { stdout: false, stderr: false });
		assert.equal(run.timedOut, false);
	} finally {
		f.done();
	}
});

test("runProjectTool: a bare program comes from PATH and ./ arguments are mode-folder files", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.dir, "data.txt"), "from the folder\n");
		const run = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool({ command: ["cat", "./data.txt"] }), args: {} });
		assert.equal(run.exitCode, 0);
		assert.equal(run.stdout, "from the folder\n");
	} finally {
		f.done();
	}
});

test("runProjectTool: the output cap cuts each stream and says so", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "head -c 100000 /dev/zero | tr '\\0' a; head -c 10 /dev/zero | tr '\\0' b >&2");
		const run = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool(), args: {}, maxOutputBytes: 1000 });
		assert.equal(run.stdout.length, 1000);
		assert.equal(run.stderr, "bbbbbbbbbb");
		assert.deepEqual(run.truncated, { stdout: true, stderr: false });
		assert.equal(run.exitCode, 0);
	} finally {
		f.done();
	}
});

test("runProjectTool: past its time limit the whole process group is killed", async () => {
	const f = fixture();
	try {
		const marker = join(f.base, "child-alive");
		// A grandchild that would write the marker after 3 s: killing only the shell would leave it running.
		script(f.dir, "bin/status", `(sleep 3; touch ${marker}) & sleep 30`);
		const started = Date.now();
		const run = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool(), args: {}, timeoutMs: 300 });
		assert.equal(run.timedOut, true);
		assert.equal(run.exitCode, null);
		assert.ok(Date.now() - started < 5000);
		await new Promise((r) => setTimeout(r, 3500));
		assert.throws(() => readFileSync(marker), "the grandchild died with its group");
	} finally {
		f.done();
	}
});

test("runProjectTool: an abort kills the program", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "sleep 30");
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		const run = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool(), args: {}, signal: ac.signal });
		assert.equal(run.aborted, true);
		assert.equal(run.timedOut, false);
	} finally {
		f.done();
	}
});

test("runProjectTool: a missing or non-executable program reports why, never rejects", async () => {
	const f = fixture();
	try {
		const missing = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool(), args: {} });
		assert.match(missing.spawnError ?? "", /program not found/);
		writeFileSync(join(f.dir, "plain"), "echo hi\n");
		const plain = await runProjectTool({ dir: f.dir, modeId: "m", projectRoot: f.root, cwd: f.cwd, tool: tool({ command: ["./plain"] }), args: {} });
		assert.match(plain.spawnError ?? "", /not executable/);
	} finally {
		f.done();
	}
});

test("projectToolDefinitions: names, schema and a run's result", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "cat");
		const tools = [tool()];
		const [def] = projectToolDefinitions(snapshotOf(f.dir, tools), { cwd: () => f.cwd, sandboxOn: () => false });
		assert.equal(def!.name, "release_check__status");
		assert.equal(def!.defaultActive, false);
		assert.deepEqual(def!.parameters, tools[0]!.params);
		const result = await def!.execute("call-1", { q: "x" });
		assert.equal(result.content[0]!.text, 'Exit code 0.\n\nstdout:\n{"q":"x"}');
		assert.equal(result.details.exitCode, 0);
		assert.equal(projectRootOfModeDir(f.dir), f.root);
	} finally {
		f.done();
	}
});

test("projectToolDefinitions: a program edited after approval refuses the call (t18)", async () => {
	const f = fixture();
	try {
		const marker = join(f.base, "ran");
		script(f.dir, "bin/status", `touch ${marker}`);
		const snapshot = snapshotOf(f.dir, [tool()]);
		script(f.dir, "bin/status", `touch ${marker}; echo changed`);
		const [def] = projectToolDefinitions(snapshot, { cwd: () => f.cwd, sandboxOn: () => false });
		await assert.rejects(() => def!.execute("c", {}), { message: changedText("release_check__status", "release-check") });
		assert.throws(() => readFileSync(marker), "nothing ran");
		assert.equal(
			changedText("release_check__status", "release-check"),
			"release_check__status wasn't run: the files of release-check changed since it was approved. Ask the user to approve release-check again in the mode menu.",
		);
	} finally {
		f.done();
	}
});

test("projectToolDefinitions: a helper the program sources, or a reference file, edited after approval refuses the call", async () => {
	const f = fixture();
	try {
		const marker = join(f.base, "ran");
		writeFileSync(join(f.dir, "lib.sh"), "x=1\n");
		writeFileSync(join(f.dir, "notes.md"), "reference\n");
		script(f.dir, "bin/status", `. "$SOVA_MODE_DIR/lib.sh"; touch ${marker}`);
		const snapshot = snapshotOf(f.dir, [tool()]);
		const [def] = projectToolDefinitions(snapshot, { cwd: () => f.cwd, sandboxOn: () => false });
		writeFileSync(join(f.dir, "lib.sh"), "x=2\n");
		await assert.rejects(() => def!.execute("c", {}), { message: changedText("release_check__status", "release-check") });
		writeFileSync(join(f.dir, "lib.sh"), "x=1\n");
		writeFileSync(join(f.dir, "notes.md"), "reference, edited\n");
		await assert.rejects(() => def!.execute("c", {}), { message: changedText("release_check__status", "release-check") });
		writeFileSync(join(f.dir, "notes.md"), "reference\n");
		writeFileSync(join(f.dir, "MODE.md"), "instructions edited\n");
		await def!.execute("c", {});
		assert.ok(readFileSync(marker), "MODE.md alone never refuses; restored files run again");
	} finally {
		f.done();
	}
});

test("projectToolDefinitions: the sandbox on, or the mode off, refuses before anything runs", async () => {
	const f = fixture();
	try {
		const marker = join(f.base, "ran");
		script(f.dir, "bin/status", `touch ${marker}`);
		const snapshot = snapshotOf(f.dir, [tool()]);
		const [sandboxed] = projectToolDefinitions(snapshot, { cwd: () => f.cwd, sandboxOn: () => true });
		await assert.rejects(() => sandboxed!.execute("c", {}), { message: sandboxText("release_check__status", "release-check") });
		const [off] = projectToolDefinitions(snapshot, { cwd: () => f.cwd, sandboxOn: () => false, isOn: () => false });
		await assert.rejects(() => off!.execute("c", {}), /is off/);
		assert.throws(() => readFileSync(marker), "nothing ran");
	} finally {
		f.done();
	}
});

test("projectToolDefinitions: a nonzero exit is a result; a timeout is a failed call", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "echo bad >&2; exit 2");
		const [def] = projectToolDefinitions(snapshotOf(f.dir, [tool()]), { cwd: () => f.cwd, sandboxOn: () => false });
		const r = await def!.execute("c", {});
		assert.equal(r.content[0]!.text, "Exit code 2.\n\nstderr:\nbad\n");
		script(f.dir, "bin/status", "sleep 10");
		const [slow] = projectToolDefinitions(snapshotOf(f.dir, [tool()]), { cwd: () => f.cwd, sandboxOn: () => false, timeoutMs: 200 });
		await assert.rejects(() => slow!.execute("c", {}), /ran past its/);
	} finally {
		f.done();
	}
});

test("approval store: approve exactly a hash, per checkout and mode; '' never needs one", () => {
	const f = fixture();
	try {
		const file = join(f.base, "state", "project-mode-approvals.json");
		const h1 = "a".repeat(64);
		const h2 = "b".repeat(64);
		assert.equal(isApproved(f.root, "m", "", file), true);
		assert.equal(isApproved(f.root, "m", h1, file), false);
		recordApproval(f.root, "m", h1, "user", file);
		assert.equal(isApproved(f.root, "m", h1, file), true);
		assert.equal(isApproved(f.root, "m", h2, file), false, "another tool set is not approved");
		assert.equal(isApproved(f.root, "other", h1, file), false, "another mode is not approved");
		assert.equal(isApproved(f.cwd, "m", h1, file), false, "another checkout is not approved");
		// A symlinked path to the same checkout is the same key.
		const link = join(f.base, "repo-link");
		symlinkSync(f.root, link);
		assert.equal(isApproved(link, "m", h1, file), true);
		recordApproval(f.root, "m", h2, "overseer", file);
		const list = readApprovals(file).approvals[projectKey(f.root)]!.m!;
		assert.deepEqual(list.map((r) => [r.hash, r.by]), [[h2, "overseer"], [h1, "user"]]);
		assert.throws(() => recordApproval(f.root, "m", "nothex", "user", file));
	} finally {
		f.done();
	}
});

test("approval store: keeps the last few hashes, and a damaged file reads as none and is replaced", () => {
	const f = fixture();
	try {
		const file = join(f.base, "project-mode-approvals.json");
		const hashes = Array.from({ length: APPROVALS_KEPT + 2 }, (_, i) => i.toString(16).padStart(64, "0"));
		for (const h of hashes) recordApproval(f.root, "m", h, "user", file);
		assert.equal(isApproved(f.root, "m", hashes[0]!, file), false, "the oldest fell off");
		assert.equal(isApproved(f.root, "m", hashes.at(-1)!, file), true);
		assert.equal(readApprovals(file).approvals[projectKey(f.root)]!.m!.length, APPROVALS_KEPT);
		writeFileSync(file, "{not json");
		assert.equal(isApproved(f.root, "m", hashes.at(-1)!, file), false);
		recordApproval(f.root, "m", hashes[1]!, "user", file);
		assert.equal(isApproved(f.root, "m", hashes[1]!, file), true);
	} finally {
		f.done();
	}
});

test("approvalsFile: the server's state root when a chat names it, else <agent dir>/sova", () => {
	assert.equal(approvalsFile({ SOVA_CHAT_STATE_ROOT: "/srv/state" }), "/srv/state/project-mode-approvals.json");
	assert.equal(approvalsFile({ PI_CODING_AGENT_DIR: "/a/agent" }), "/a/agent/sova/project-mode-approvals.json");
	assert.equal(approvalsFile({}, "/x"), "/x/sova/project-mode-approvals.json");
});

const fullCopy = (dir: string, tools: ProjectModeTool[], id = "release-check") => ({
	v: 1 as const,
	id,
	dir,
	description: "d",
	workers: true,
	tools,
	text: "t",
	sha: "e".repeat(64),
	toolsHash: toolsHashOf(dir, tools),
});

test("worker hand-off: the file holds the copies with tools, content-addressed, and reads back", () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "cat");
		const copies = [fullCopy(f.dir, [tool()]), fullCopy(f.dir, [], "no-tools")];
		const file = writeWorkerToolsFile(join(f.base, "agent"), copies)!;
		assert.ok(file.startsWith(join(f.base, "agent", "sova", "project-tools")));
		assert.equal(writeWorkerToolsFile(join(f.base, "agent"), copies), file, "the same set is the same file");
		assert.deepEqual(readWorkerToolsFile(file).map((c) => c.id), ["release-check"]);
		assert.equal(writeWorkerToolsFile(join(f.base, "agent"), [fullCopy(f.dir, [], "no-tools")]), undefined);
		writeFileSync(file, "{broken");
		assert.deepEqual(readWorkerToolsFile(file), []);
	} finally {
		f.done();
	}
});

test("worker extension: registers the parent's copies, puts them in the loadout, runs them in the worker's cwd", async () => {
	const f = fixture();
	try {
		script(f.dir, "bin/status", "pwd");
		const file = writeWorkerToolsFile(join(f.base, "agent"), [fullCopy(f.dir, [tool()])])!;
		const registered = new Map<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }>();
		let active = ["read", "bash"];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const listeners = new Map<string, (data: unknown) => void>();
		const pi = {
			registerTool: (def: { name: string }) => registered.set(def.name, def as never),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => (active = names),
			on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
			events: { on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn), emit: () => {} },
		};
		const before = process.env[PROJECT_TOOLS_FILE_ENV];
		process.env[PROJECT_TOOLS_FILE_ENV] = file;
		try {
			projectToolsWorker(pi as never);
		} finally {
			if (before === undefined) delete process.env[PROJECT_TOOLS_FILE_ENV];
			else process.env[PROJECT_TOOLS_FILE_ENV] = before;
		}
		assert.deepEqual([...registered.keys()], ["release_check__status"]);
		await handlers.get("session_start")!({}, { cwd: f.cwd });
		assert.deepEqual(active, ["read", "bash", "release_check__status"]);
		const r = await registered.get("release_check__status")!.execute("c", {});
		assert.equal(r.content[0]!.text, `Exit code 0.\n\nstdout:\n${f.cwd}\n`);
		listeners.get("sandbox:state")!({ version: 1, on: true });
		await assert.rejects(() => registered.get("release_check__status")!.execute("c", {}), /sandbox is on/);
	} finally {
		f.done();
	}
});

test("worker extension: no hand-off file, nothing registered", () => {
	const before = process.env[PROJECT_TOOLS_FILE_ENV];
	delete process.env[PROJECT_TOOLS_FILE_ENV];
	let calls = 0;
	const pi = { registerTool: () => calls++, on: () => calls++, events: { on: () => calls++, emit: () => calls++ } };
	projectToolsWorker(pi as never);
	if (before !== undefined) process.env[PROJECT_TOOLS_FILE_ENV] = before;
	assert.equal(calls, 0);
});
