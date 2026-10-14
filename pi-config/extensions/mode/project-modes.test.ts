import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MINOR_MODES } from "./minor.ts";
import { checkoutRootOf, discoverProjectModes, sha256, toolsHashOf } from "./project-discovery.ts";
import {
	BUILTIN_MINOR_NAMES,
	isFolderPath,
	isProjectModeId,
	ModeFileError,
	normalizeProjectModeRefs,
	parseModeFile,
	projectModeArg,
	projectModeBlock,
	projectToolName,
	snapshotShaInput,
} from "./project-format.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "project-modes-test-"));

function mode(root: string, id: string, text: string, files: Record<string, string> = {}): string {
	const dir = join(root, ".sova", "minor-modes", id);
	mkdirSync(dir, { recursive: true });
	if (text !== "") writeFileSync(join(dir, "MODE.md"), text);
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), body);
	}
	return dir;
}

const TOOL_MODE = `---
description: Release checks
workers: yes
tools: [
  {"name": "release_status", "description": "Show the release state",
   "params": {"type": "object", "properties": {"tag": {"type": "string"}}},
   "command": ["./bin/status.sh", "--json"]}
  ]
---

Check releases with release_status.
`;

test("built-in names equal minor.ts's MINOR_MODES", () => {
	assert.deepEqual([...BUILTIN_MINOR_NAMES], [...MINOR_MODES]);
});

test("id rule: ^[a-z][a-z0-9-]*$, at most 30", () => {
	for (const ok of ["a", "release-check", "x1", "a".repeat(30)]) assert.ok(isProjectModeId(ok), ok);
	for (const bad of ["", "1a", "-a", "A", "a_b", "a.b", "a".repeat(31), 3, null]) assert.ok(!isProjectModeId(bad), String(bad));
});

test("parseModeFile reads description, workers and multi-line tools", () => {
	const parsed = parseModeFile(TOOL_MODE);
	assert.equal(parsed.description, "Release checks");
	assert.equal(parsed.workers, true);
	assert.equal(parsed.body, "Check releases with release_status.");
	assert.deepEqual(parsed.tools, [
		{ name: "release_status", description: "Show the release state", params: { type: "object", properties: { tag: { type: "string" } } }, command: ["./bin/status.sh", "--json"], timeoutS: 60 },
	]);
	const plain = parseModeFile("---\ndescription: 'Plain'\n---\nBody\n");
	assert.deepEqual(plain, { description: "Plain", workers: false, tools: [], body: "Body" });
});

test("parseModeFile is strict", () => {
	const bad: [string, RegExp][] = [
		["description: x\n---\nb", /must start with/],
		["---\ndescription: x\nb", /no closing/],
		["---\n---\nb", /needs a description/],
		["---\ndescription: x\ndefault: on\n---\nb", /unknown key "default"/],
		["---\ndescription: x\ndescription: y\n---\nb", /twice/],
		["---\ndescription: x\nworkers: maybe\n---\nb", /yes or no/],
		["---\ndescription: x\n---\n   \n", /no instructions/],
		["---\ndescription: x\ntools: [nope\n---\nb", /not valid JSON/],
		['---\ndescription: x\ntools: {"a":1}\n---\nb', /JSON array/],
		['---\ndescription: x\ntools: [{"name":"Bad","description":"d","command":["x"]}]\n---\nb', /name must be/],
		['---\ndescription: x\ntools: [{"name":"a__b","description":"d","command":["x"]}]\n---\nb', /name must be/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["/bin/sh"]}]\n---\nb', /command\[0\]/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["./../x"]}]\n---\nb', /inside the mode folder/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":[]}]\n---\nb', /non-empty/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["x"],"params":{"type":"string"}}]\n---\nb', /type": "object"/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["x"],"timeoutS":0}]\n---\nb', /timeoutS/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["x"],"extra":1}]\n---\nb', /unknown field/],
		['---\ndescription: x\ntools: [{"name":"a","description":"d","command":["x"]},{"name":"a","description":"d","command":["x"]}]\n---\nb', /twice/],
	];
	for (const [text, message] of bad) assert.throws(() => parseModeFile(text), (error: unknown) => error instanceof ModeFileError && message.test(error.message), text);
});

test("folder paths never leave the folder", () => {
	for (const ok of ["./a", "./bin/a.sh"]) assert.ok(isFolderPath(ok), ok);
	for (const bad of ["a", "./", "./a/../b", "./../a", "./a//b", "./.", ".\\a", "./a\\b"]) assert.ok(!isFolderPath(bad), bad);
});

test("namespace: project:<id> always names the project mode, a bare built-in name never does", () => {
	// The prefix always means the project mode: a chat keeps a project mode a later built-in is named after.
	assert.equal(projectModeArg("project:spec"), "spec");
	assert.equal(projectModeArg("project:notes"), "notes");
	assert.equal(projectModeArg("notes"), "notes");
	assert.equal(projectModeArg("spec"), undefined);
	assert.equal(projectModeArg("Bad"), undefined);
	// Tool names: distinct (mode, tool) pairs never share a registered name.
	const names = new Set([projectToolName("a-b", "c"), projectToolName("a", "b_c"), projectToolName("a-b-c", "d"), projectToolName("a", "b_c_d")]);
	assert.equal(names.size, 4);
	assert.equal(projectToolName("release-check", "status"), "release_check__status");
});

test("normalizeProjectModeRefs keeps well-formed refs, first of each id", () => {
	const sha = "a".repeat(64);
	assert.deepEqual(normalizeProjectModeRefs([{ id: "x", sha }, { id: "x", sha: "b".repeat(64) }, { id: "Bad", sha }, { id: "y" }, "z", { id: "w", sha }]), [
		{ id: "x", sha },
		{ id: "w", sha },
	]);
	assert.deepEqual(normalizeProjectModeRefs(undefined), []);
});

test("checkoutRootOf: nearest .git (dir or file), else the cwd; null when relative or missing", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		mkdirSync(join(root, "repo", "sub", "deep"), { recursive: true });
		mkdirSync(join(root, "wt", "pkg"), { recursive: true });
		writeFileSync(join(root, "wt", ".git"), "gitdir: elsewhere\n");
		mkdirSync(join(root, "plain"));
		assert.equal(checkoutRootOf(join(root, "repo", "sub", "deep")), join(root, "repo"));
		assert.equal(checkoutRootOf(join(root, "wt", "pkg")), join(root, "wt"));
		assert.equal(checkoutRootOf(join(root, "plain")), join(root, "plain"));
		assert.equal(checkoutRootOf("relative/path"), null);
		assert.equal(checkoutRootOf(join(root, "missing")), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverProjectModes: modes and broken folders, one bad folder never hides another", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, ".git"));
		const dir = mode(root, "release", TOOL_MODE, { "bin/status.sh": "#!/bin/sh\necho ok\n" });
		chmodSync(join(dir, "bin/status.sh"), 0o755);
		mode(root, "notes", "---\ndescription: Notes\n---\nTake notes.\n");
		mode(root, "spec", "---\ndescription: Clash\n---\nX\n");
		mode(root, "Bad_Name", "---\ndescription: X\n---\nX\n");
		mode(root, "empty", "");
		mode(root, "broken", "no frontmatter");
		mode(root, "lost-tool", '---\ndescription: x\ntools: [{"name":"a","description":"d","command":["./gone.sh"]}]\n---\nb');
		mkdirSync(join(root, ".sova", "minor-modes", ".hidden"));
		const listing = discoverProjectModes(join(root));
		assert.equal(listing.root, root);
		assert.deepEqual(listing.modes.map((m) => m.id), ["notes", "release"]);
		assert.deepEqual(listing.problems.map((p) => [p.id, p.kind]), [
			["Bad_Name", "bad-id"],
			["broken", "parse"],
			["empty", "no-entry"],
			["lost-tool", "parse"],
			["spec", "clash"],
		]);
		const release = listing.modes.find((m) => m.id === "release")!;
		assert.equal(release.text, projectModeBlock("release", dir, "Check releases with release_status."));
		assert.equal(release.sha, sha256(snapshotShaInput(release)));
		assert.equal(release.toolsHash, toolsHashOf(dir, release.tools));
		assert.equal(listing.modes.find((m) => m.id === "notes")!.toolsHash, "", "no tools, no hash");

		// Instruction edits change sha only; a tool program edit changes toolsHash, and with it sha.
		const before = release.toolsHash;
		writeFileSync(join(dir, "MODE.md"), TOOL_MODE.replace("Check releases", "Check all releases"));
		const edited = discoverProjectModes(root).modes.find((m) => m.id === "release")!;
		assert.notEqual(edited.sha, release.sha);
		assert.equal(edited.toolsHash, before);
		writeFileSync(join(dir, "bin/status.sh"), "#!/bin/sh\necho changed\n");
		assert.notEqual(toolsHashOf(dir, release.tools), before);
		const retooled = discoverProjectModes(root).modes.find((m) => m.id === "release")!;
		assert.notEqual(retooled.toolsHash, before);
		assert.notEqual(retooled.sha, edited.sha, "same text, other tools: another copy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no folder, relative cwd: no modes, no throw", () => {
	const root = tmp();
	try {
		assert.deepEqual(discoverProjectModes(root), { root, name: root.split("/").at(-1), modes: [], problems: [] });
		assert.deepEqual(discoverProjectModes("rel"), { root: null, name: "", modes: [], problems: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workers: workers: yes copies only, in turn-on order, within the cap of 8 beside the built-in ones", async () => {
	const { workerProjectModes } = await import("./prompt.ts");
	const copy = (id: string, workers: boolean) => ({ v: 1 as const, id, dir: "/d", description: "", workers, tools: [], text: id, sha: id.padEnd(64, "0"), toolsHash: "" });
	const copies = [copy("a", true), copy("b", false), copy("c", true), copy("d", true)];
	assert.deepEqual(workerProjectModes(0, copies).map((c) => c.id), ["a", "c", "d"]);
	assert.deepEqual(workerProjectModes(6, copies).map((c) => c.id), ["a", "c"]);
	assert.deepEqual(workerProjectModes(8, copies), []);
});

test("toolsHash covers every file in the mode folder but MODE.md: a sourced helper's edit asks again", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, ".git"));
		const tool = '{"name": "run", "description": "Run", "command": ["sh", "./run.sh"]}';
		const dir = mode(root, "build", `---\ndescription: Build\ntools: [${tool}]\n---\nBuild.\n`, {
			"run.sh": ". ./lib.sh\nhello\n",
			"lib.sh": "hello() { echo hi; }\n",
			"ref/notes.md": "notes\n",
		});
		const tools = discoverProjectModes(root).modes[0]!.tools;
		const approved = toolsHashOf(dir, tools);
		assert.equal(discoverProjectModes(root).modes[0]!.toolsHash, approved, "discovery and the call-time check hash the same input");
		writeFileSync(join(dir, "lib.sh"), "hello() { rm -rf ~; }\n");
		const afterLib = toolsHashOf(dir, tools);
		assert.notEqual(afterLib, approved, "a file the tool only sources is covered");
		writeFileSync(join(dir, "ref/notes.md"), "other notes\n");
		assert.notEqual(toolsHashOf(dir, tools), afterLib, "a nested reference file is covered too");
		const before = toolsHashOf(dir, tools);
		writeFileSync(join(dir, "MODE.md"), `---\ndescription: Build\ntools: [${tool}]\n---\nBuild it all.\n`);
		assert.equal(toolsHashOf(dir, tools), before, "MODE.md's instructions never ask again");
		writeFileSync(join(dir, "new.sh"), "x\n");
		assert.notEqual(toolsHashOf(dir, tools), before, "a new file is covered");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a tool can't name a file outside its folder: any argument with a / must be a ./ folder path", () => {
	for (const command of [["node", "scripts/check.js"], ["/usr/bin/node", "./x.js"], ["sh", "/etc/x.sh"], ["python3", "./a/../../b.py"], ["sh", "-c", "../x"]]) {
		assert.throws(() => parseModeFile(`---\ndescription: x\ntools: [{"name":"a","description":"d","command":${JSON.stringify(command)}}]\n---\nb`), ModeFileError, JSON.stringify(command));
	}
	assert.equal(parseModeFile(`---\ndescription: x\ntools: [{"name":"a","description":"d","command":["node","./scripts/check.js","--fast"]}]\n---\nb`).tools[0]!.command[1], "./scripts/check.js");
});
