/**
 * Offline tests for the explain child's cache mirror, the call gate, the fork copy and the
 * interrupted-run reconcile. The prompt mirror is checked against pi's OWN section builder
 * (`dist/core/system-prompt.js` of the pi the harness resolves), so "the diff is empty" is pi's
 * verdict, not ours. Run with `node tests/run.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { jiti, packageDir } from "./tests/runtime.mjs";
import { ExplainRuns, FORK_DIR, type ExplainHost } from "./explain.ts";
import {
	applyMirror,
	declaredState,
	gateToolCall,
	mirrorPrompt,
	readOnlyShellCommand,
	shellPipeline,
	planTools,
	sameDeclaration,
	withoutBtwNotes,
	withParentCacheKey,
	type ToolDeclaration,
} from "./mirror.ts";
import { EXPLAIN_ENTRY_TYPE, INTERRUPTED_NO_PAGE, INTERRUPTED_WITH_PAGE, runningEntryData, storeDir, writeMeta, type ExplainEntryData, type KnownMeta } from "./store.ts";
import { copyForFork } from "./worker.ts";

const pi = (await jiti.import(join(packageDir, "dist/core/system-prompt.js"))) as {
	buildSystemPromptSections(input: Record<string, unknown>): Record<string, string>;
	diffSystemPromptSections(previous: Record<string, string>, current: Record<string, string>): Record<string, string | null> | undefined;
	normalizeBuildSystemPromptOptions(input: Record<string, unknown>): Record<string, any>;
};

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "explain-mirror-"));
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
	const plan = planTools(declared, own, new Set(["read", "grep", "find", "ls", "write", "edit"]));
	assert.deepEqual(
		plan.map((entry) => [entry.name, entry.action]),
		[["read", "own"], ["bash", "own"], ["grep", "wrap"], ["agent_spawn", "stub"], ["write", "own"], ["web_search", "own"]],
	);
	assert.equal(plan.find((entry) => entry.name === "grep")?.declaration.description, "parent grep", "a wrap carries the parent's words");
	assert.equal(plan.some((entry) => entry.name === "ls"), false, "a tool the parent never declared is not added: it would change the prefix");

	// A parent in strict mode has no write: the child adds it, at the end (additive).
	const strict = planTools([tool("read"), tool("bash")], own, new Set(["read", "write"]));
	assert.deepEqual(strict.map((entry) => [entry.name, entry.action]), [["read", "own"], ["bash", "own"], ["write", "own"]]);

	// Unforked: nothing to mirror, the callable tools the child has.
	assert.deepEqual(planTools(undefined, own, new Set()).map((entry) => entry.name), ["read", "grep", "ls", "write", "web_search"]);
});

test("sameDeclaration is pi-ai's comparison: key order and typebox symbols do not matter, words do", () => {
	const withSymbol = { ...tool("read"), parameters: Object.assign({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }, { [Symbol("kind")]: "Object" }) };
	assert.equal(sameDeclaration(withSymbol, tool("read")), true);
	assert.equal(sameDeclaration(tool("read", "a"), tool("read", "b")), false);
	assert.equal(sameDeclaration({ ...tool("read"), constrainedSampling: true }, tool("read")), false);
});

test("the gate lets the child read, look things up, and write only inside its store", () => {
	const store = "/agent/explanations/x-1";
	const at = (...parts: string[]) => resolve("/repo", ...parts);
	for (const name of ["read", "grep", "find", "ls", "web_search", "fetch_content"]) assert.equal(gateToolCall(name, { path: "/etc/passwd" }, store, at), undefined, name);
	assert.equal(gateToolCall("write", { path: `${store}/index.html` }, store, at), undefined);
	assert.equal(gateToolCall("edit", { path: `${store}/meta.json` }, store, at), undefined);
	assert.match(gateToolCall("write", { path: "src/app.ts" }, store, at) ?? "", /writes only inside/);
	assert.match(gateToolCall("write", { path: `${store}/../x-2/index.html` }, store, at) ?? "", /writes only inside/, "no escape by ..");
	assert.match(gateToolCall("write", { path: `${store}-evil/index.html` }, store, at) ?? "", /writes only inside/, "a sibling with the same prefix is outside");
	assert.match(gateToolCall("write", {}, store, at) ?? "", /writes only inside/);
	for (const name of ["agent_spawn", "worktree", "powershell"]) assert.match(gateToolCall(name, { command: "ls" }, store, at) ?? "", /read-only/, name);
	assert.equal(gateToolCall("bash", { command: "rg -n 'forkFrom|fork' pi-config | head -20" }, store, at), undefined);
	assert.match(gateToolCall("bash", { command: "rm -rf /" }, store, at) ?? "", /read-only command line/);
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

test("the provider cache key is the parent's, and only when pi set it to the child's own session", () => {
	assert.deepEqual(withParentCacheKey({ model: "m", prompt_cache_key: "child" }, "child", "parent"), { model: "m", prompt_cache_key: "parent" });
	assert.equal(withParentCacheKey({ model: "m" }, "child", "parent"), undefined);
	assert.equal(withParentCacheKey({ prompt_cache_key: "other" }, "child", "parent"), undefined);
	assert.equal(withParentCacheKey({ prompt_cache_key: "child" }, "child", undefined), undefined);
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

function harness(env: NodeJS.ProcessEnv) {
	const entries: ExplainEntryData[] = [];
	const started: { spec: any; settle: (r: any) => void }[] = [];
	const host: ExplainHost = {
		env,
		now: () => Date.parse("2026-09-28T10:00:00.000Z"),
		appendEntry: (data) => entries.push(data),
		notify: () => {},
		wake: () => {},
		start: (spec, handlers) => {
			started.push({ spec, settle: handlers.onSettled });
			return { kill: async () => {} };
		},
	};
	return { runs: new ExplainRuns(host), entries, started };
}

const known = (id: string): KnownMeta => ({ id, topic: `topic ${id}`, parentSessionId: "sess-1", cwd: "/repo", createdAt: "2026-09-28T09:00:00.000Z", model: "zai/glm-5.3" });

test("reconcile settles leftover running entries as interrupted: linked when the page is there, not otherwise", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const { runs, entries } = harness(env);
		// "paged": the child finished its page right before the kill. "blank": it never wrote one.
		const paged = storeDir("paged-1", env);
		mkdirSync(paged, { recursive: true });
		writeFileSync(join(paged, "index.html"), "<!doctype html><h1>t</h1><p>Explained by x</p>");
		writeMeta(paged, { ...known("paged-1"), summary: "What the page says." });
		mkdirSync(storeDir("blank-1", env), { recursive: true });
		const branch: ExplainEntryData[] = [
			runningEntryData(known("paged-1")),
			runningEntryData(known("blank-1")),
			runningEntryData(known("done-1")),
			{ ...runningEntryData(known("done-1")), status: undefined, summary: "finished" },
			runningEntryData(known("gone-1")),
		];
		assert.equal(runs.reconcile(branch), 3);
		assert.deepEqual(entries.map((e) => [e.id, e.status, e.note ?? null, e.error ?? null]), [
			["paged-1", "interrupted", INTERRUPTED_WITH_PAGE, null],
			["blank-1", "interrupted", null, INTERRUPTED_NO_PAGE],
			["gone-1", "interrupted", null, INTERRUPTED_NO_PAGE],
		]);
		assert.equal(entries[0]!.summary, "What the page says.", "the store's summary, for the card");
		assert.equal(runs.reconcile([...branch, ...entries]), 0, "settled entries stay settled");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile leaves a run this process is still running alone", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const { runs, entries } = harness(env);
		runs.begin({ topic: "live one", cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		const running = entries[0]!;
		assert.equal(running.status, "running");
		assert.equal(runs.reconcile([running]), 0);
		assert.equal(entries.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a forked run's session copy is deleted when it settles and when it is stopped", async () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	try {
		const parent = join(root, "parent.jsonl");
		writeFileSync(parent, '{"type":"session"}\n{"type":"message","message":{"role":"user"}}\n');
		const { runs, started } = harness(env);
		runs.begin({ topic: "a", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: parent, model: "m" });
		runs.begin({ topic: "b", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: parent, model: "m" });
		const [a, b] = started.map((s) => s.spec.forkSession as string);
		assert.ok(a!.startsWith(join(root, "explanations", FORK_DIR)) && readFileSync(a!, "utf8").length > 0);
		started[0]!.settle({ outcome: "error", error: "x", finalOutput: "" });
		assert.throws(() => readFileSync(a!), /ENOENT/);
		await runs.stopAll();
		assert.throws(() => readFileSync(b!), /ENOENT/);
		assert.equal(EXPLAIN_ENTRY_TYPE, "explain-doc");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the prompt names the search tools the child actually has", async () => {
	const { searchTools } = await import("./prompt.ts");
	assert.equal(searchTools({ forked: false }), "read/grep/find/ls", "unforked: the child's own tools");
	assert.equal(searchTools({ forked: true, parentTools: ["read", "grep", "find", "ls", "bash"] }), "read/grep/find/ls");
	const shell = searchTools({ forked: true, parentTools: ["read", "bash", "edit", "write", "agent_spawn"] });
	assert.ok(shell.startsWith("read, and `bash` for ONE read-only command line"), shell);
	assert.equal(searchTools({ forked: true, parentTools: ["read", "write"] }), "read");
});
