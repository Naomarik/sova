/**
 * Offline tests for a background fork's request mirror, its call gate and policies, and the fork
 * copy. The prompt mirror is checked against pi's OWN section builder (`dist/core/system-prompt.js`
 * of the pi the harness resolves), so "the diff is empty" is pi's verdict, not ours. Run with the
 * subagents runner (`node tests/run.mjs`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { jiti, packageDir } from "../tests/runtime.mjs";
import { copyForFork, forkable, sweepStale } from "./copy.ts";
import {
	applyMirror,
	callable,
	declaredState,
	decodePolicy,
	gateToolCall,
	mirrorPrompt,
	readOnlyShellCommand,
	shellPipeline,
	planTools,
	sameDeclaration,
	withoutBtwNotes,
	type ForkPolicy,
	type ToolDeclaration,
} from "./mirror.ts";

/** /explain's policy: web, and writes into its store only. */
const storePolicy = (writeDir: string): ForkPolicy => ({ label: "The /explain worker", web: true, writeDir, writeHint: "Write index.html and meta.json there; nothing else on disk." });
/** A read-only fork (the handoff writer's shape): no web, no writes. */
const readOnly: ForkPolicy = { label: "The handoff writer" };

const pi = (await jiti.import(join(packageDir, "dist/core/system-prompt.js"))) as {
	buildSystemPromptSections(input: Record<string, unknown>): Record<string, string>;
	diffSystemPromptSections(previous: Record<string, string>, current: Record<string, string>): Record<string, string | null> | undefined;
	normalizeBuildSystemPromptOptions(input: Record<string, unknown>): Record<string, any>;
};

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "fork-mirror-"));
}

const tool = (name: string, description = `${name} tool`): ToolDeclaration => ({
	name,
	description,
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
});

/** A parent's prompt as pi builds it: every optional section present. */
function parentSections(): Record<string, string> {
	return pi.buildSystemPromptSections({
		cwd: "/repo",
		selectedTools: ["read", "bash", "edit", "write", "agent_spawn"],
		toolSnippets: { read: "Read files", bash: "Run shell commands", agent_spawn: "Spawn a worker" },
		toolGuidelines: { bash: ["Prefer rg over grep"] },
		promptGuidelines: ["Keep it short"],
		appendSystemPrompt: "# Mode: normal\nDo the thing.",
		contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rules." }],
		skills: [{ name: "playwright", description: "Drive a browser", filePath: "/repo/.claude/skills/playwright/SKILL.md", baseDir: "/repo/.claude/skills/playwright", source: "project", disableModelInvocation: false }],
		sections: { mode: "Minor mode: spec is on." },
	});
}

test("the mirror rebuilds the parent's sections exactly, by pi's own builder: the diff is empty", () => {
	const parent = parentSections();
	assert.ok(parent.project_context && parent.skills && parent.addendum && parent.mode, "the fixture exercises every optional section");
	const mirror = mirrorPrompt(parent);
	assert.ok(mirror);
	// The child's own options: a different pi, fewer tools, no context files, another cwd.
	const options = pi.normalizeBuildSystemPromptOptions({ cwd: "/elsewhere", selectedTools: ["read", "write"], contextFiles: [{ path: "/x", content: "other" }], appendSystemPrompt: "child addendum" });
	applyMirror(options as never, mirror);
	const child = pi.buildSystemPromptSections(options);
	assert.deepEqual(child, parent);
	assert.equal(pi.diffSystemPromptSections(parent, child), undefined, "pi appends no system message");
});

test("a replay that cannot be reproduced gives no mirror", () => {
	const parent = parentSections();
	assert.equal(mirrorPrompt({ ...parent, preamble: "" }), undefined, "no preamble");
	const { cwd: _cwd, ...noCwd } = parent;
	assert.equal(mirrorPrompt(noCwd), undefined, "pi would add a cwd section");
	assert.equal(mirrorPrompt({ ...parent, odd: "not framed" }), undefined);
});

test("declaredState replays system messages like pi-ai: sections patched by name, tools removed then added", () => {
	const messages = [
		{ role: "system", sections: { preamble: "P", cwd: "<cwd>\n/a\n</cwd>", mode: "<mode>\nm\n</mode>" }, toolsAdded: [tool("read"), tool("bash"), tool("agent_spawn")] },
		{ role: "user", content: "hi" },
		{ role: "system", sections: { mode: null, cwd: "<cwd>\n/b\n</cwd>" }, toolsRemoved: [{ name: "bash" }], toolsAdded: [tool("worktree"), tool("read", "read v2")] },
	];
	const state = declaredState(messages);
	assert.deepEqual(state?.sections, { preamble: "P", cwd: "<cwd>\n/b\n</cwd>" });
	assert.deepEqual(state?.tools.map((t) => [t.name, t.description]), [["read", "read v2"], ["agent_spawn", "agent_spawn tool"], ["worktree", "worktree tool"]]);
	assert.equal(declaredState([{ role: "user" }]), undefined, "an unforked child declares nothing");
});

test("planTools keeps every declared tool, in order, and only callable ones can run", () => {
	const declared = [tool("read"), tool("bash"), tool("grep", "parent grep"), tool("agent_spawn"), tool("write"), tool("web_search")];
	const own = new Map<string, ToolDeclaration>([
		["read", tool("read")],
		["bash", tool("bash")],
		["grep", tool("grep", "child grep: another pi version")],
		["write", tool("write")],
		["web_search", tool("web_search")],
		["ls", tool("ls")],
	]);
	const plan = planTools(declared, own, new Set(["read", "grep", "find", "ls", "write", "edit"]), storePolicy("/s"));
	assert.deepEqual(
		plan.map((entry) => [entry.name, entry.action]),
		[["read", "own"], ["bash", "own"], ["grep", "wrap"], ["agent_spawn", "stub"], ["write", "own"], ["web_search", "own"]],
	);
	assert.equal(plan.find((entry) => entry.name === "grep")?.declaration.description, "parent grep", "a wrap carries the parent's words");
	assert.equal(plan.some((entry) => entry.name === "ls"), false, "a tool the parent never declared is not added: it would change the prefix");

	// A parent in strict mode has no write: the child adds it, at the end (additive).
	const strict = planTools([tool("read"), tool("bash")], own, new Set(["read", "write"]), storePolicy("/s"));
	assert.deepEqual(strict.map((entry) => [entry.name, entry.action]), [["read", "own"], ["bash", "own"], ["write", "own"]]);

	// Unforked: nothing to mirror, the callable tools the child has.
	assert.deepEqual(planTools(undefined, own, new Set(), storePolicy("/s")).map((entry) => entry.name), ["read", "grep", "ls", "write", "web_search"]);
});

test("a read-only policy stubs writes and web tools, adds no write, and declares the parent's tools all the same", () => {
	const declared = [tool("read"), tool("bash"), tool("edit"), tool("write"), tool("web_search"), tool("agent_spawn")];
	const own = new Map<string, ToolDeclaration>(["read", "bash", "edit", "write", "web_search", "grep", "ls"].map((name) => [name, tool(name)]));
	const plan = planTools(declared, own, new Set(["read", "edit", "write", "bash"]), readOnly);
	assert.deepEqual(
		plan.map((entry) => [entry.name, entry.action]),
		[["read", "own"], ["bash", "own"], ["edit", "stub"], ["write", "stub"], ["web_search", "stub"], ["agent_spawn", "stub"]],
		"the declared set and order are the parent's: the prefix is unchanged",
	);
	assert.deepEqual(planTools([tool("bash")], own, new Set(), readOnly).map((entry) => entry.name), ["bash", "read"], "only read is required");
	assert.deepEqual(planTools(undefined, own, new Set(), readOnly).map((entry) => entry.name), ["read", "grep", "ls"], "unforked: reading tools only");
	for (const name of ["read", "grep", "find", "ls", "bash"]) assert.equal(callable(name, readOnly), true, name);
	for (const name of ["write", "edit", "web_search", "fetch_content", "agent_spawn"]) assert.equal(callable(name, readOnly), false, name);
});

test("sameDeclaration is pi-ai's comparison: key order and typebox symbols do not matter, words do", () => {
	const withSymbol = { ...tool("read"), parameters: Object.assign({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }, { [Symbol("kind")]: "Object" }) };
	assert.equal(sameDeclaration(withSymbol, tool("read")), true);
	assert.equal(sameDeclaration(tool("read", "a"), tool("read", "b")), false);
	assert.equal(sameDeclaration({ ...tool("read"), constrainedSampling: true }, tool("read")), false);
});

test("the gate lets the child read, look things up, and write only inside its store", () => {
	const store = "/agent/explanations/x-1";
	const policy = storePolicy(store);
	const at = (...parts: string[]) => resolve("/repo", ...parts);
	for (const name of ["read", "grep", "find", "ls", "web_search", "fetch_content"]) assert.equal(gateToolCall(name, { path: "/etc/passwd" }, policy, at), undefined, name);
	assert.equal(gateToolCall("write", { path: `${store}/index.html` }, policy, at), undefined);
	assert.equal(gateToolCall("edit", { path: `${store}/meta.json` }, policy, at), undefined);
	assert.equal(
		gateToolCall("write", { path: "src/app.ts" }, policy, at),
		`The /explain worker writes only inside ${store}. Write index.html and meta.json there; nothing else on disk.`,
	);
	assert.match(gateToolCall("write", { path: `${store}/../x-2/index.html` }, policy, at) ?? "", /writes only inside/, "no escape by ..");
	assert.match(gateToolCall("write", { path: `${store}-evil/index.html` }, policy, at) ?? "", /writes only inside/, "a sibling with the same prefix is outside");
	assert.match(gateToolCall("write", {}, policy, at) ?? "", /writes only inside/);
	for (const name of ["agent_spawn", "worktree", "powershell"]) assert.match(gateToolCall(name, { command: "ls" }, policy, at) ?? "", /read-only/, name);
	assert.equal(
		gateToolCall("agent_spawn", {}, policy, at),
		`The /explain worker is read-only: "agent_spawn" is not available here. Research with read (and grep, find, ls, or read-only bash, whichever you have), and write only inside ${store}.`,
	);
	assert.equal(gateToolCall("bash", { command: "rg -n 'forkFrom|fork' pi-config | head -20" }, policy, at), undefined);
	assert.match(gateToolCall("bash", { command: "rm -rf /" }, policy, at) ?? "", /^The \/explain worker runs bash only for one read-only command line/);
});

test("a read-only policy reads and runs read-only bash, and writes nothing and reaches no web anywhere", () => {
	const at = (...parts: string[]) => resolve("/repo", ...parts);
	for (const name of ["read", "grep", "find", "ls"]) assert.equal(gateToolCall(name, { path: "/etc/passwd" }, readOnly, at), undefined, name);
	assert.equal(gateToolCall("bash", { command: "git log --oneline -5" }, readOnly, at), undefined);
	assert.match(gateToolCall("bash", { command: "echo x > notes.md" }, readOnly, at) ?? "", /^The handoff writer runs bash only for one read-only command line/);
	for (const name of ["write", "edit"]) {
		const why = gateToolCall(name, { path: "/repo/notes.md" }, readOnly, at);
		assert.equal(why, `The handoff writer is read-only: "${name}" is not available here. Research with read (and grep, find, ls, or read-only bash, whichever you have); it writes nothing on disk.`);
	}
	for (const name of ["web_search", "fetch_content", "get_search_content", "source_check", "agent_spawn"]) assert.match(gateToolCall(name, {}, readOnly, at) ?? "", /is read-only/, name);
});

test("a policy travels as JSON and anything that is not one is refused", () => {
	assert.deepEqual(decodePolicy(JSON.stringify(storePolicy("/s"))), storePolicy("/s"));
	assert.deepEqual(decodePolicy(JSON.stringify(readOnly)), readOnly);
	assert.deepEqual(decodePolicy(JSON.stringify({ label: "x", web: "yes", writeDir: "/d" })), { label: "x", writeDir: "/d" }, "only a literal true turns the web on");
	for (const raw of [undefined, "", "  ", "{", "[]", "null", JSON.stringify({}), JSON.stringify({ label: "" }), JSON.stringify({ label: "x", writeDir: "" }), JSON.stringify({ label: "x", writeDir: 1 })])
		assert.equal(decodePolicy(raw), undefined, String(raw));
});

test("bash runs only one read-only command line: listed programs, pipes, quotes; nothing that writes or chains", () => {
	assert.deepEqual(shellPipeline(`rg -n "a|b" 'c d' src\\ dir | head -5`), [["rg", "-n", "a|b", "c d", "src dir"], ["head", "-5"]]);
	for (const ok of [
		"ls -la pi-config/extensions",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"grep -rn fork pi-config/extensions/explain",
		"git log --oneline -5 -- pi-config",
		"git show HEAD:server/index.ts | head -5",
		"cat package.json | jq .scripts",
		"wc -l pi-config/extensions/explain/*.ts",
	]) assert.equal(readOnlyShellCommand(ok), undefined, ok);
	for (const bad of [
		"rm -rf /",
		"ls > out.txt",
		"ls; rm x",
		"ls && rm x",
		"cat $(echo /etc/passwd)",
		"echo `id`",
		'grep "$HOME" x',
		"find . -delete",
		"find . -exec rm {} +",
		"rg --pre=sh pattern",
		"sort -o /tmp/x file",
		"git checkout -- .",
		"git -c core.pager=sh log",
		"git diff --output=/tmp/x",
		"curl https://example.com",
		"sed -i s/a/b/ f",
		"tail -f log",
		"ls |",
		"(ls)",
		"ls\nrm x",
		"",
	]) assert.notEqual(readOnlyShellCommand(bad), undefined, bad);
});

test("btw notes are dropped like the parent's btw extension drops them; other messages are untouched", () => {
	const messages = [{ role: "user" }, { role: "custom", customType: "btw-note" }, { role: "custom", customType: "other" }];
	assert.deepEqual(withoutBtwNotes(messages), [{ role: "user" }, { role: "custom", customType: "other" }]);
	assert.equal(withoutBtwNotes([{ role: "user" }]), undefined, "no change, no replacement");
});

test("the fork copy is cut after the last complete line: a parent mid-append is never written to", () => {
	const root = tmp();
	try {
		const source = join(root, "parent.jsonl");
		const target = join(root, "copy.jsonl");
		const partial = '{"type":"session"}\n{"type":"message","id":"a"}\n{"type":"mess';
		writeFileSync(source, partial);
		assert.equal(copyForFork(source, target), true);
		assert.equal(readFileSync(target, "utf8"), '{"type":"session"}\n{"type":"message","id":"a"}\n');
		assert.equal(readFileSync(source, "utf8"), partial, "the source is untouched");
		writeFileSync(source, "no newline at all");
		assert.equal(copyForFork(source, join(root, "none.jsonl")), false);
		assert.equal(copyForFork(join(root, "missing.jsonl"), join(root, "none.jsonl")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a parent is forkable only once it holds a message; anything unreadable is not", () => {
	const root = tmp();
	try {
		const file = join(root, "s.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		assert.equal(forkable(file), false, "a header alone forks into an empty child");
		writeFileSync(file, `{"type":"session"}\n${"x".repeat(70 * 1024 - 3)}{"type":"message","id":"a"}\n`);
		assert.equal(forkable(file), true, "found across a chunk boundary");
		assert.equal(forkable(join(root, "missing.jsonl")), false);
		assert.equal(forkable(root), false);
		assert.equal(forkable(undefined), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sweepStale removes what a dead parent left, past the age limit, and keeps the live runs", () => {
	const root = tmp();
	try {
		for (const name of ["old.jsonl", "live.jsonl", "fresh.jsonl"]) writeFileSync(join(root, name), "x");
		mkdirSync(join(root, "old-dir"));
		writeFileSync(join(root, "old-dir", "s.jsonl"), "x");
		sweepStale(root, 60_000, Date.now(), (name) => name === "live.jsonl");
		assert.deepEqual(readdirSync(root).sort(), ["fresh.jsonl", "live.jsonl", "old-dir", "old.jsonl"], "nothing is old yet");
		const now = Date.now() + 120_000;
		sweepStale(root, 60_000, now, (name) => name === "live.jsonl");
		assert.deepEqual(readdirSync(root).sort(), ["live.jsonl"], "files and session dirs alike");
		sweepStale(join(root, "missing"), 0, now);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
