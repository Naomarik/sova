import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ALSO_CHANGES_OVERRIDE } from "../mode/spec-guard.ts";
import {
	MERGE_BLOCKS, SPEC_HOOK_SCRIPT, alsoChangesOf, readState, runHook, specHookSettings, statePath, withClaudeSettings,
	type HookInput,
} from "./spec-hooks.ts";
import { buildClaudeArgv, NO_ATTRIBUTION } from "./transport.ts";

const CORE = fs.realpathSync(fileURLToPath(new URL("../spec/core", import.meta.url)));
const roots: string[] = [];
process.on("exit", () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}
function write(root: string, rel: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
}
/** A committed project: boundary `src`, §app/x claiming src/a.txt. */
function project(): { root: string; stateDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-hooks-"));
	roots.push(root);
	write(root, ".sova/spec/manifest.json", JSON.stringify({
		formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] },
		claims: { "§app/x": { kind: "behavior", requires: [], code: ["src/a.txt"] } },
	}));
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a thing.\n");
	write(root, "src/a.txt", "a\n");
	git(root, "init", "-q", "-b", "main");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
	return { root, stateDir: path.join(root, ".hook-state") };
}
const event = (root: string, extra: Partial<HookInput>): HookInput => ({ session_id: "s1", prompt_id: "p1", cwd: root, ...extra });

test("specHookSettings: the three events, after ANY tool, run by node with the core and state dirs; withClaudeSettings keeps a sandbox's settings and hooks", () => {
	const settings = specHookSettings({ node: "/usr/bin/node", coreDir: "/c ore", stateDir: "/s" }) as any;
	assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "Stop", "UserPromptSubmit"]);
	assert.equal(settings.hooks.PostToolUse[0].matcher, "*");
	assert.equal(settings.hooks.Stop[0].hooks[0].command, `/usr/bin/node ${SPEC_HOOK_SCRIPT} stop --core '/c ore' --state /s`);
	const merged = JSON.parse(withClaudeSettings('{"sandbox":{"enabled":true},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"own"}]}]}}', settings));
	assert.deepEqual(merged.sandbox, { enabled: true });
	assert.equal(merged.hooks.Stop.length, 2, "appended after the base's own Stop hook");
	assert.equal(merged.hooks.Stop[0].hooks[0].command, "own");
	assert.throws(() => withClaudeSettings("[]", settings), /JSON object/);
	// buildClaudeArgv carries it in the one --settings, attribution merged over it.
	const built = buildClaudeArgv({ permissionMode: "bypassPermissions", permissionModes: ["bypassPermissions"], hostPermissions: false, settingsJson: withClaudeSettings(undefined, settings) });
	const flag = JSON.parse(built.args![built.args!.indexOf("--settings") + 1]);
	assert.deepEqual(flag, { ...settings, ...NO_ATTRIBUTION });
});

test("helpers: alsoChanges from promote JSON, state paths", () => {
	assert.deepEqual(alsoChangesOf('{"alsoChanges":["§a/b",3]}'), ["§a/b"]);
	assert.equal(alsoChangesOf("not json"), undefined);
	assert.equal(alsoChangesOf('{"ok":true}'), undefined);
	assert.equal(statePath("/s", "../etc"), undefined, "a session id never escapes the state dir");
	assert.equal(statePath("/s", "b5a20bf1-9dde"), "/s/b5a20bf1-9dde.json");
});

test("post after a Bash edit: a census digest; a read-only tool: nothing; the turn is marked as writing", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, { hook_event_name: "UserPromptSubmit" }), o);
	assert.equal(await runHook("post", event(root, { tool_name: "Read", tool_input: { file_path: "src/a.txt" } }), o), undefined);
	write(root, "src/a.txt", "changed by a heredoc\n");
	const out = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "cat > src/a.txt <<EOF" }, tool_response: { stdout: "" } }), o) as any;
	assert.equal(out?.hookSpecificOutput?.hookEventName, "PostToolUse");
	assert.match(out.hookSpecificOutput.additionalContext, /\[spec census\]/);
	assert.match(out.hookSpecificOutput.additionalContext, /§app\/x/, "the foreign § the change maps to");
	const state = readState(statePath(stateDir, "s1")!);
	assert.equal(state.turn.wrote, true);
	assert.ok(fs.readFileSync(path.join(stateDir, "s1.log.jsonl"), "utf8").includes("[spec census]"), "the event log records what was said");
});

test("stop: a writing turn needs the Also changes line (sent back once, then let through); a pure Q&A turn must not carry it", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "b\n");
	await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o);
	const miss = await runHook("stop", event(root, { last_assistant_message: "Done.", stop_hook_active: false }), o) as any;
	assert.equal(miss?.decision, "block");
	assert.match(miss.reason, /^\[spec check\] This turn changed files/);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done.", stop_hook_active: true }), o), undefined, "a warning: let through on the retry");
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: none", stop_hook_active: false }), o), undefined);

	await runHook("turn", event(root, { prompt_id: "p2" }), o);
	assert.equal(await runHook("stop", event(root, { prompt_id: "p2", last_assistant_message: "It does X." }), o), undefined, "Q&A without the line");
	const qa = await runHook("stop", event(root, { prompt_id: "p2", last_assistant_message: "It does X.\nAlso changes: none" }), o) as any;
	assert.equal(qa?.decision, "block", "Q&A with the line is sent back once");
});

test("stop after a promote: the computed foreign list is the authority, blocking up to MERGE_BLOCKS times unless overridden", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	const promote = `node "$core/sova-spec-draft.mjs" promote feat --plan abc --write --root ${root} --json`;
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: promote }, tool_response: { stdout: '{"alsoChanges":["§app/x"]}' } }), o);
	const reply = { last_assistant_message: "Promoted.\nAlso changes: none" };
	for (let i = 0; i < MERGE_BLOCKS; i++) {
		const out = await runHook("stop", event(root, { ...reply, stop_hook_active: i > 0 }), o) as any;
		assert.equal(out?.decision, "block", `send-back ${i + 1}`);
		assert.match(out.reason, /§app\/x/);
	}
	assert.equal(await runHook("stop", event(root, { ...reply, stop_hook_active: true }), o), undefined, "bounded: never a loop");
	await runHook("turn", event(root, { prompt_id: "p3" }), o);
	await runHook("post", event(root, { prompt_id: "p3", tool_name: "Bash", tool_input: { command: promote }, tool_response: { stdout: '{"alsoChanges":["§app/x"]}' } }), o);
	assert.equal(await runHook("stop", event(root, { prompt_id: "p3", last_assistant_message: "Promoted.\nAlso changes: §app/x — renamed" }), o), undefined);
	assert.equal(await runHook("stop", event(root, { prompt_id: "p3", last_assistant_message: `Promoted.\n${ALSO_CHANGES_OVERRIDE} §app/x was created by this task in an earlier merge\nAlso changes: none` }), o), undefined, "the override lets it through");
});

test("a git merge that lands claim text: the foreign list comes from `sova-spec.mjs foreign` over the merge", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	const c = ["-c", "user.email=t@t", "-c", "user.name=t"];
	git(root, "checkout", "-qb", "feat");
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a better thing.\n");
	git(root, ...c, "commit", "-qam", "reword");
	git(root, "checkout", "-q", "main");
	await runHook("turn", event(root, {}), o);
	git(root, ...c, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-ff feat" } }), o);
	const state = readState(statePath(stateDir, "s1")!);
	assert.equal(state.turn.landed, true);
	assert.deepEqual(state.turn.foreign, ["§app/x"]);
	const out = await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: none" }), o) as any;
	assert.equal(out?.decision, "block");
	assert.match(out.reason, /Also changes: §app\/x — <what changed>/);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded", stop_hook_active: true }), o), undefined);
});

test("stop on a normal turn: a line naming a § the census never saw touched is sent back once", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "c\n");
	await runHook("post", event(root, { tool_name: "Edit" }), o);
	const out = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/new — added" }), o) as any;
	assert.equal(out?.decision, "block");
	assert.match(out.reason, /names §app\/new, which the census never saw/);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — tweak" }), o), undefined, "one send-back per turn");
});

test("the script entry: reads the event on stdin, prints Claude's JSON, and never fails a worker", () => {
	const { root, stateDir } = project();
	const run = (ev: string, input: unknown) => spawnSync(process.execPath, [SPEC_HOOK_SCRIPT, ev, "--core", CORE, "--state", stateDir], { input: JSON.stringify(input), encoding: "utf8" });
	assert.equal(run("turn", event(root, {})).status, 0);
	write(root, "src/new.txt", "n\n");
	const post = run("post", event(root, { tool_name: "Bash", tool_input: { command: "touch src/new.txt" } }));
	assert.equal(post.status, 0, post.stderr);
	assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /\[spec census\]/);
	const bad = spawnSync(process.execPath, [SPEC_HOOK_SCRIPT, "post", "--core", CORE, "--state", stateDir], { input: "not json", encoding: "utf8" });
	assert.equal(bad.status, 0);
	assert.equal(bad.stdout, "");
});
