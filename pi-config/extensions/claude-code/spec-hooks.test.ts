import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ALSO_CHANGES_OVERRIDE, localIO } from "../mode/spec-guard.ts";
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
	write(root, ".gitignore", ".hook-state/\n.sova/spec/drafts/\n");
	git(root, "init", "-q", "-b", "main");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
	return { root, stateDir: path.join(root, ".hook-state") };
}
const event = (root: string, extra: Partial<HookInput>): HookInput => ({ session_id: "s1", prompt_id: "p1", cwd: root, ...extra });

test("specHookSettings: the three events, after ANY tool, run by node with the core and state dirs; withClaudeSettings keeps a sandbox's settings and hooks", () => {
	const settings = specHookSettings({ node: "/usr/bin/node", coreDir: "/c ore", stateDir: "/s" }) as any;
	assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
	assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
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

/** A committed project whose src/a.txt five § map and src/b.txt, src/c.txt one each. */
function manyProject(): { root: string; stateDir: string } {
	const { root, stateDir } = project();
	const claims: Record<string, unknown> = {};
	for (const n of ["a", "b", "c", "d", "e"]) claims[`§app/a${n}`] = { kind: "behavior", requires: [], code: ["src/a.txt"] };
	for (const f of ["b", "c"]) claims[`§app/${f}`] = { kind: "surface", code: [`src/${f}.txt`] };
	write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims }));
	for (const id of Object.keys(claims)) write(root, `.sova/spec/claims/app/${id.slice(5)}.md`, `# ${id}\n\nText.\n`);
	fs.rmSync(path.join(root, ".sova/spec/claims/app/x.md"));
	for (const f of ["b", "c"]) write(root, `src/${f}.txt`, "1\n");
	git(root, "add", "-A");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "many");
	return { root, stateDir };
}

test("the census note: New: shows 3 § a file, the Stop check still accepts the rest; the Rule prints once in a session; an old state file loads", async () => {
	const { root, stateDir } = manyProject();
	const o = { core: CORE, stateDir };
	const context = (out: any): string => out?.hookSpecificOutput?.additionalContext ?? "";
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "2\n");
	const first = context(await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o));
	assert.match(first, /New: src\/a\.txt → §app\/aa, §app\/ab, §app\/ac \(\+2 more\)/);
	assert.match(first, /Rule: /);
	assert.deepEqual(readState(statePath(stateDir, "s1")!).census.foreign, ["§app/aa", "§app/ab", "§app/ac", "§app/ad", "§app/ae"]);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/ae — tweak" }), o), undefined, "a § the note held back is still one the census saw");
	await runHook("turn", event(root, { prompt_id: "p2" }), o);
	write(root, "src/b.txt", "2\n");
	const second = context(await runHook("post", event(root, { prompt_id: "p2", tool_name: "Edit", tool_input: { file_path: "src/b.txt" } }), o));
	assert.match(second, /Foreign §: §app\/b/);
	assert.doesNotMatch(second, /Rule: |No draft yet/, "said once in the session");
	// A state file from before the note was shortened (no `said`): it loads, and says the Rule again.
	const file = statePath(stateDir, "s1")!;
	const old = JSON.parse(fs.readFileSync(file, "utf8"));
	delete old.census.said;
	fs.writeFileSync(file, JSON.stringify(old));
	write(root, "src/c.txt", "2\n");
	const third = context(await runHook("post", event(root, { prompt_id: "p2", tool_name: "Edit", tool_input: { file_path: "src/c.txt" } }), o));
	assert.match(third, /Foreign §: §app\/c/);
	assert.match(third, /Rule: /);
});

test("the team MCP tools skip the census, by exact name: no git call, and the next Edit reports the change; another team tool still runs it", async () => {
	const { root, stateDir } = project();
	const calls: string[][] = [];
	const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => (calls.push([cmd, ...args]), localIO.exec(cmd, args, opts)) };
	const o = { core: CORE, stateDir, io };
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "changed by a teammate\n");
	calls.length = 0;
	for (const tool of ["mcp__team__team_inbox", "mcp__team__team_msg", "mcp__team__team_ask", "mcp__team__team_roster", "mcp__team__team_report", "mcp__team__wake_nudge"])
		assert.equal(await runHook("post", event(root, { tool_name: tool, tool_input: {} }), o), undefined, tool);
	assert.deepEqual(calls, [], "a skipped tool never looks");
	const out = await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o) as any;
	assert.match(out?.hookSpecificOutput?.additionalContext ?? "", /New: src\/a\.txt → §app\/x/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.wrote, true);
	write(root, "src/new.txt", "n\n");
	const other = await runHook("post", event(root, { tool_name: "mcp__team__future_tool", tool_input: {} }), o) as any;
	assert.match(other?.hookSpecificOutput?.additionalContext ?? "", /New: src\/new\.txt → unclaimed/, "an unlisted team tool is never skipped");
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

/** B3's shape: base has §app/x and §app/w; feat rewords §app/x; main (master) rewords §app/w meanwhile. */
function b3(): { root: string; stateDir: string; c: string[] } {
	const p = project();
	const c = ["-c", "user.email=t@t", "-c", "user.name=t"];
	const m = JSON.parse(fs.readFileSync(path.join(p.root, ".sova/spec/manifest.json"), "utf8"));
	m.claims["§app/w"] = { kind: "note" };
	write(p.root, ".sova/spec/manifest.json", JSON.stringify(m));
	write(p.root, ".sova/spec/claims/app/w.md", "# §app/w\n\nW is a note.\n");
	git(p.root, ...c, "add", ".");
	git(p.root, ...c, "commit", "-qm", "w");
	git(p.root, "checkout", "-qb", "feat");
	write(p.root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a better thing.\n");
	git(p.root, ...c, "commit", "-qam", "feat: reword x");
	git(p.root, "checkout", "-q", "main");
	write(p.root, ".sova/spec/claims/app/w.md", "# §app/w\n\nW is another note.\n");
	git(p.root, ...c, "commit", "-qam", "main: reword w");
	git(p.root, "checkout", "-q", "feat");
	return { ...p, c };
}

test("B3: merging master into the branch lands nothing; the merge into master lands only the branch's §", async () => {
	const { root, stateDir, c } = b3();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	git(root, ...c, "merge", "-q", "--no-edit", "main");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit main" } }), o);
	let turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.landed, turn.foreign], [false, []], "master's §app/w is not this branch's");
	git(root, "checkout", "-q", "main");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git checkout main" } }), o);
	git(root, ...c, "merge", "-q", "--no-edit", "feat");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit feat" } }), o);
	turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.landed, turn.foreign], [true, ["§app/x"]]);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded" }), o), undefined);
});

test("B3: a promote without --json after merging master in counts only what it wrote, not master's §", async () => {
	const { root, stateDir, c } = b3();
	const o = { core: CORE, stateDir };
	git(root, "checkout", "-q", "main");
	git(root, "branch", "-qf", "feat", "main~1");
	git(root, "checkout", "-q", "feat");
	await runHook("turn", event(root, {}), o);
	git(root, ...c, "merge", "-q", "--no-edit", "main");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit main" } }), o);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a promoted thing.\n");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: `node "$core/sova-spec-draft.mjs" promote feat --plan abc --write --root ${root}` } }), o);
	const turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.landed, turn.foreign], [true, ["§app/x"]]);
});

test("promote through a variable (R3-B-s3-3's `node $d promote … --write`) lands; the same words in a heredoc don't", async () => {
	for (const [command, lands] of [
		[`cd ROOT && d=/c/core/sova-spec-draft.mjs; node "$d" promote feat --id '§app/x' --plan abc --write 2>&1 | tail -2`, true],
		["cat > ROOT/notes.md <<'EOF'\nnode \"$d\" promote feat --plan abc --write\nEOF", false],
	] as const) {
		const { root, stateDir } = b3();
		const o = { core: CORE, stateDir };
		git(root, "checkout", "-q", "main");
		await runHook("turn", event(root, {}), o);
		write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a promoted thing.\n");
		await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: command.replaceAll("ROOT", root) } }), o);
		const turn = readState(statePath(stateDir, "s1")!).turn;
		assert.equal(Boolean(turn.landed), lands, command);
		if (lands) assert.deepEqual([turn.landings?.[0]?.kind, turn.foreign], ["promote", ["§app/x"]]);
	}
});

test("a Git-computed list: a § named beyond it is an extra, sent back even behind an override", async () => {
	const { root, stateDir, c } = b3();
	const o = { core: CORE, stateDir };
	git(root, "checkout", "-q", "main");
	await runHook("turn", event(root, {}), o);
	git(root, ...c, "merge", "-q", "--no-edit", "feat");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit feat" } }), o);
	assert.deepEqual(readState(statePath(stateDir, "s1")!).turn.foreign, ["§app/x"]);
	const reply = `Merged.\n${ALSO_CHANGES_OVERRIDE} §app/w changed too\nAlso changes: §app/x — reworded; §app/w — reworded`;
	const out = await runHook("stop", event(root, { last_assistant_message: reply }), o) as any;
	assert.equal(out?.decision, "block");
	assert.match(out.reason, /§app\/w isn't changed by this diff/);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded", stop_hook_active: true }), o), undefined);
});

test("write guard: an Edit on the current manifest, or a shell write to claims/, is a direct write", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	const manifest = path.join(root, ".sova/spec/manifest.json");
	fs.appendFileSync(manifest, "\n");
	const out = await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: manifest } }), o) as any;
	assert.match(out.hookSpecificOutput.additionalContext, /you wrote the current spec directly \(.*manifest\.json\): undo it; change claims in a draft and promote/);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX by hand.\n");
	const sh = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "python3 fix.py" } }), o) as any;
	assert.match(sh.hookSpecificOutput.additionalContext, /you wrote the current spec directly \(\.sova\/spec\/claims\/app\/x\.md\)/);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX by git.\n");
	const g = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git checkout main -- .sova" } }), o) as any;
	assert.doesNotMatch(g?.hookSpecificOutput?.additionalContext ?? "", /wrote the current spec directly/, "git is sanctioned");
});

test("write guard: a git rebase that takes a draft's evidence commit off the branch names the sha and the restore", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	const c = ["-c", "user.email=t@t", "-c", "user.name=t"];
	write(root, ".gitignore", ".sova/spec/drafts/\n.hook-state/\n");
	git(root, ...c, "add", ".gitignore");
	git(root, ...c, "commit", "-qm", "ignore");
	git(root, "checkout", "-qb", "feat");
	write(root, "src/a.txt", "b\n");
	git(root, ...c, "commit", "-qam", "code");
	const ev = git(root, "rev-parse", "HEAD");
	write(root, ".sova/spec/drafts/d/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: ev, ids: [{ id: "§app/x" }] }] }));
	git(root, "checkout", "-q", "main");
	write(root, "src/b.txt", "m\n");
	git(root, ...c, "add", "src/b.txt");
	git(root, ...c, "commit", "-qm", "main moves");
	git(root, "checkout", "-q", "feat");
	await runHook("turn", event(root, {}), o);
	git(root, ...c, "rebase", "-q", "main");
	const out = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git rebase main" } }), o) as any;
	const text = out.hookSpecificOutput.additionalContext as string;
	assert.match(text, new RegExp(`never rebase after evidence \\(PROMOTE\\.md\\): draft d's evidence commit ${ev.slice(0, 12)} \\(§app/x\\) is no longer on this branch`));
	assert.match(text, new RegExp(`git reset --hard ${ev}\``), "the exact old tip, reset only with a clean tree");
	assert.match(text, /With no uncommitted changes/);
	assert.equal(text.split("never rebase after evidence").length - 1, 1, "said once, not again by the census");
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

test("a draft edit alone (gitignored, no git delta) makes the turn a writing one, and the foreign § it edits must be named", async () => {
	const { root, stateDir } = project();
	fs.writeFileSync(path.join(root, ".gitignore"), ".sova/spec/drafts/\n.hook-state/\n");
	git(root, "add", ".gitignore");
	git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore drafts");
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	const made = spawnSync(process.execPath, [path.join(CORE, "sova-spec-draft.mjs"), "new", "feat", "--write", "--root", root, "--json"], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stdout + made.stderr);
	write(root, ".sova/spec/drafts/feat/spec/claims/app/x.md", "# §app/x\n\nX does a different thing.\n");
	assert.equal(git(root, "status", "--porcelain"), "", "git sees nothing");
	const out = await runHook("stop", event(root, { last_assistant_message: "Drafted.\nAlso changes: none" }), o) as any;
	assert.equal(out?.decision, "block");
	assert.match(out.reason, /§app\/x/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.wrote, true);
	await runHook("turn", event(root, { prompt_id: "p2" }), o);
	write(root, ".sova/spec/drafts/feat/spec/claims/app/x.md", "# §app/x\n\nX does another thing.\n");
	assert.equal(await runHook("stop", event(root, { prompt_id: "p2", last_assistant_message: "Drafted.\nAlso changes: §app/x — reworded" }), o), undefined);
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

// ---------------------------------------------------------------------------
// Phase 3: landings by tree (M5), the landing gate (M1), own claims (M2), the ledger (M4), the shared parser (M3)
// ---------------------------------------------------------------------------
const C = ["-c", "user.email=t@t", "-c", "user.name=t"];
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function editManifest(root: string, fn: (claims: Record<string, any>) => void): void {
	const file = path.join(root, ".sova/spec/manifest.json");
	const m = readJson(file);
	fn(m.claims);
	fs.writeFileSync(file, JSON.stringify(m));
}
/** The project plus a worktree on `feat` that rewords §app/x; the worker's session runs in the worktree. */
function withWorktree(): { root: string; wt: string; stateDir: string } {
	const p = project();
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spec-hooks-wt-")), "wt");
	roots.push(path.dirname(wt));
	git(p.root, "worktree", "add", "-q", "-b", "feat", wt);
	write(wt, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a better thing.\n");
	git(wt, ...C, "commit", "-qam", "feat: reword x");
	return { ...p, wt, stateDir: path.join(path.dirname(wt), ".hook-state") };
}

test("cross-tree fast-forward: a worker in its worktree runs `cd <root> && git merge`; the root's reflog gives the landing", async () => {
	const { root, wt, stateDir } = withWorktree();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(wt, {}), o);
	assert.equal(await runHook("pre", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o), undefined, "observation never blocks");
	git(root, "merge", "-q", "--ff-only", "feat");
	await runHook("post", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	const turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.landed, turn.foreign], [true, ["§app/x"]]);
	assert.equal(turn.landings?.[0]?.kind, "ff");
	const out = await runHook("stop", event(wt, { last_assistant_message: "Merged.\nAlso changes: none" }), o) as any;
	assert.equal(out?.decision, "block");
	assert.equal(await runHook("stop", event(wt, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded", stop_hook_active: true }), o), undefined);
});

test("cross-tree non-ff with `git -C <root>` while master moved: only the branch's §, never master's", async () => {
	const { root, wt, stateDir } = withWorktree();
	const o = { core: CORE, stateDir };
	editManifest(root, (c) => { c["§app/w"] = { kind: "note" }; });
	write(root, ".sova/spec/claims/app/w.md", "# §app/w\n\nW.\n");
	git(root, ...C, "add", "."); git(root, ...C, "commit", "-qm", "master: w");
	await runHook("turn", event(wt, {}), o);
	await runHook("pre", event(wt, { tool_name: "Bash", tool_input: { command: `git -C ${root} merge --no-ff -m "merge feat" feat` } }), o);
	git(root, ...C, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
	await runHook("post", event(wt, { tool_name: "Bash", tool_input: { command: `git -C ${root} merge --no-ff -m "merge feat" feat` } }), o);
	const turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.landed, turn.foreign, turn.landings?.[0]?.kind], [true, ["§app/x"], "merge"]);
	assert.equal(await runHook("stop", event(wt, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded" }), o), undefined);
});

test("two merges in one turn (one command): the list is the union of both landings", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	editManifest(root, (c) => { c["§app/w"] = { kind: "note" }; });
	write(root, ".sova/spec/claims/app/w.md", "# §app/w\n\nW.\n");
	git(root, ...C, "add", "."); git(root, ...C, "commit", "-qm", "w");
	for (const [b, f, t] of [["a", "x", "X does a better thing."], ["b", "w", "W, reworded."]]) {
		git(root, "checkout", "-qb", b!);
		write(root, `.sova/spec/claims/app/${f}.md`, `# §app/${f}\n\n${t}\n`);
		git(root, ...C, "commit", "-qam", b!);
		git(root, "checkout", "-q", "main");
	}
	await runHook("turn", event(root, {}), o);
	git(root, ...C, "merge", "-q", "--no-edit", "a");
	git(root, ...C, "merge", "-q", "--no-edit", "b");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit a && git merge --no-edit b" } }), o);
	const turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual([turn.foreign, turn.landings?.length], [["§app/w", "§app/x"], 2]);
	const out = await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded" }), o) as any;
	assert.match(out?.reason ?? "", /omits §app\/w/);
});

test("the s2-3 comma line: a § inside a description is not named, so it is no extra", async () => {
	const { root, stateDir } = b3();
	const o = { core: CORE, stateDir };
	git(root, "checkout", "-q", "main");
	await runHook("turn", event(root, {}), o);
	git(root, ...C, "merge", "-q", "--no-edit", "feat");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-edit feat" } }), o);
	const line = "Merged.\nAlso changes: §app/x — gains a new child claim, §app/w (a new behavior under it)";
	assert.equal(await runHook("stop", event(root, { last_assistant_message: line }), o), undefined);
});

test("the landing gate: an unmapped file needs a Plumbing line; an unpromoted draft record at a landing on main takes the override, never a Deferred line (public-links shape)", async () => {
	const { root, wt, stateDir } = withWorktree();
	const o = { core: CORE, stateDir };
	const draft = path.join(CORE, "sova-spec-draft.mjs");
	assert.equal(spawnSync(process.execPath, [draft, "new", "links", "--write", "--root", wt]).status, 0);
	write(wt, ".sova/spec/drafts/links/spec/claims/app/x.md", "# §app/x\n\nX links out.\n");
	write(wt, "scripts/links.sh", "echo\n");
	write(wt, "src/a.txt", "links\n");
	git(wt, ...C, "add", "-A"); git(wt, ...C, "commit", "-qm", "links, spec deferred");
	await runHook("turn", event(wt, {}), o);
	await runHook("pre", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	git(root, "merge", "-q", "--ff-only", "feat");
	await runHook("post", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	const l = readState(statePath(stateDir, "s1")!).turn.landings![0]!;
	assert.deepEqual([l.unmapped, l.unpromoted.map((d) => d.ids), l.advisory], [["scripts/links.sh"], [["§app/x"]], []]);
	// q14: this landed on main, the default branch, so the Deferred line passes nothing; only the override does.
	const deferred = "Merged.\nDeferred: §app/x — the links prose waits for review\nAlso changes: §app/x — reworded";
	const stale = await runHook("stop", event(wt, { last_assistant_message: deferred }), o) as any;
	assert.equal(stale?.decision, "block");
	assert.match(stale.reason, /scripts\/links\.sh changed and no claim maps it/);
	assert.match(stale.reason, /lands on the default branch with draft records unpromoted: §app\/x: .*a "Deferred:" line doesn't pass/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.blocks, 1, "under MERGE_BLOCKS: the next Stop is really checked");
	const ok = deferred.replace("\nDeferred", "\nPlumbing: scripts/links.sh — a dev helper\nDeferred").replace("\nAlso changes", "\nSpec check override: the user ruled §app/x stays stale until the copy review\nAlso changes");
	assert.equal(await runHook("stop", event(wt, { last_assistant_message: ok, stop_hook_active: true }), o), undefined);
});

test("q14: the same landing into a non-default branch (a team integration branch): the Deferred line passes", async () => {
	const { root, wt, stateDir } = withWorktree();
	const o = { core: CORE, stateDir };
	const draft = path.join(CORE, "sova-spec-draft.mjs");
	assert.equal(spawnSync(process.execPath, [draft, "new", "links", "--write", "--root", wt]).status, 0);
	write(wt, ".sova/spec/drafts/links/spec/claims/app/x.md", "# §app/x\n\nX links out.\n");
	write(wt, "src/a.txt", "links\n");
	git(wt, ...C, "add", "-A"); git(wt, ...C, "commit", "-qm", "links, spec deferred");
	git(root, "checkout", "-q", "-b", "team/links");
	await runHook("turn", event(wt, {}), o);
	await runHook("pre", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	git(root, "merge", "-q", "--ff-only", "feat");
	await runHook("post", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	const l = readState(statePath(stateDir, "s1")!).turn.landings![0]!;
	assert.deepEqual([l.unpromoted.map((d) => d.ids), l.onDefault], [[["§app/x"]], undefined]);
	const bare = await runHook("stop", event(wt, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded" }), o) as any;
	assert.match(bare?.reason ?? "", /left unpromoted: §app\/x: promote what shipped, or say which § stay stale on a line "Deferred: §X — <why>"/);
	const ok = "Merged.\nDeferred: §app/x — the links prose waits for review\nAlso changes: §app/x — reworded";
	assert.equal(await runHook("stop", event(wt, { last_assistant_message: ok, stop_hook_active: true }), o), undefined);
});

test("M3-B-s2-2: a claim the task created and promoted earlier, relabelled after merging master in, is never demanded at the ff merge", async () => {
	const { root, wt, stateDir } = withWorktree();
	const o = { core: CORE, stateDir };
	// Turn 1 (earlier): the branch creates §app/y and commits it.
	editManifest(wt, (c) => { c["§app/y"] = { kind: "behavior", requires: [], code: ["src/y.txt"] }; });
	write(wt, ".sova/spec/claims/app/y.md", "# §app/y\n\nY is new.\n");
	write(wt, "src/y.txt", "y\n");
	git(wt, ...C, "add", "-A"); git(wt, ...C, "commit", "-qm", "spec: y");
	// Master moves (another task), the branch merges it in, then relabels §app/y.
	write(root, "src/a.txt", "master\n");
	git(root, ...C, "commit", "-qam", "master: a");
	git(wt, ...C, "merge", "-q", "--no-edit", "main");
	editManifest(wt, (c) => { c["§app/y"].evidence = "verified"; });
	git(wt, ...C, "commit", "-qam", "relabel y");
	await runHook("turn", event(wt, {}), o);
	await runHook("pre", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	git(root, "merge", "-q", "--ff-only", "feat");
	await runHook("post", event(wt, { tool_name: "Bash", tool_input: { command: `cd ${root} && git merge --ff-only feat` } }), o);
	const turn = readState(statePath(stateDir, "s1")!).turn;
	assert.deepEqual(turn.foreign, ["§app/x"], "§app/y is the task's own (absent at the tip and the fork point)");
	assert.equal(await runHook("stop", event(wt, { last_assistant_message: "Merged.\nAlso changes: §app/x — reworded" }), o), undefined);
});

test("the ledger: each git operation a worker's hook sees is appended for the parent (SOVA_SPEC_LEDGER)", async () => {
	const { root, stateDir } = project();
	const ledger = path.join(stateDir, "ledger.jsonl");
	const o = { core: CORE, stateDir, ledger };
	await runHook("turn", event(root, {}), o);
	const before = git(root, "rev-parse", "HEAD");
	write(root, "src/a.txt", "b\n");
	git(root, ...C, "commit", "-qam", "code");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git commit -qam code" } }), o);
	const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	assert.deepEqual([lines[0].v, lines[0].actor, lines[0].top, lines[0].before, lines[0].after, lines[0].kind], [1, { runtime: "claude-code", session: "s1" }, fs.realpathSync(root), before, git(root, "rev-parse", "HEAD"), "commit"]);
	const settings = specHookSettings({ node: "node", coreDir: "/c", stateDir: "/s", ledger: "/l/x.jsonl" }) as any;
	assert.match(settings.hooks.Stop[0].hooks[0].command, / --ledger \/l\/x\.jsonl$/);
});

test("a deleted mapped file lands in its claim: advisory (never an extra), not unmapped", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	git(root, "checkout", "-qb", "feat");
	git(root, "rm", "-q", "src/a.txt");
	git(root, ...C, "commit", "-qm", "drop a");
	git(root, "checkout", "-q", "main");
	await runHook("turn", event(root, {}), o);
	git(root, ...C, "merge", "-q", "--no-ff", "-m", "m", "feat");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-ff -m m feat" } }), o);
	const l = readState(statePath(stateDir, "s1")!).turn.landings![0]!;
	assert.deepEqual([l.unmapped, l.advisory], [[], ["§app/x"]]);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: §app/x — its file is gone" }), o), undefined);
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Merged.\nAlso changes: none" }), o), undefined);
});

test("explicit other-worktree uncommitted Bash edit gets census and a required truthful footer", async () => {
	const { root, stateDir } = project();
	const wt = path.join(root, "linked");
	git(root, "worktree", "add", "-qb", "other", wt);
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	assert.equal(await runHook("pre", event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } }), o), undefined);
	write(wt, "src/a.txt", "changed in linked tree\n");
	const post = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } }), o) as any;
	assert.match(post?.hookSpecificOutput?.additionalContext ?? "", /Foreign §: §app\/x/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.wrote, true);
	assert.equal(git(wt, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD"), "edit remains uncommitted");
	const stop = await runHook("stop", event(root, { last_assistant_message: "Done." }), o) as any;
	assert.equal(stop?.decision, "block", "not invisible completion without a footer");
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — linked-tree edit" }), o), undefined);
});

test("another actor's spec commit followed by Bash true is never attributed or appended to worker ledger", async () => {
	const { root, stateDir } = project();
	const ledger = path.join(stateDir, "parent.jsonl");
	const o = { core: CORE, stateDir, ledger };
	await runHook("turn", event(root, {}), o);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nAnother actor changed this.\n");
	git(root, ...C, "commit", "-qam", "other actor");
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "true" } }), o);
	const state = readState(statePath(stateDir, "s1")!);
	assert.equal(state.turn.wrote, false);
	assert.equal(state.turn.landed, false);
	assert.deepEqual(state.turn.foreign, []);
	assert.equal(fs.existsSync(ledger), false, "forbidden effect: no attribution record was written");
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Nothing changed." }), o), undefined);
});

test("turn and cwd calls never inspect unrelated worktrees; explicit pre-call destination is observed without blocking", async () => {
	const { root, stateDir } = project();
	const other: string[] = [];
	for (let i = 0; i < 4; i++) {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spec-lazy-")), "wt");
		roots.push(path.dirname(dir)); other.push(dir);
		git(root, "worktree", "add", "-qb", `lazy${i}`, dir);
	}
	const inspected: string[] = [];
	const observe = (p: string) => { if (other.some((dir) => p === dir || p.startsWith(`${dir}/`))) inspected.push(p); };
	const io = { ...localIO,
		exec: (cmd: string, args: string[], opts: any) => { observe(opts.cwd); return localIO.exec(cmd, args, opts); },
		readFile: (p: string) => { observe(p); return localIO.readFile(p); },
		readDir: (p: string) => { observe(p); return localIO.readDir(p); },
		mtime: (p: string) => { observe(p); return localIO.mtime(p); },
	};
	const o = { core: CORE, stateDir, io };
	await runHook("turn", event(root, {}), o);
	await runHook("pre", event(root, { tool_name: "Bash", tool_input: { command: "true" } }), o);
	await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "true" } }), o);
	assert.deepEqual(inspected, [], "forbidden effect: no per-tree Git/source/census/spec scan of unrelated trees");
	const call = event(root, { tool_name: "Bash", tool_input: { command: `git -C '${other[0]}' status` } });
	assert.equal(await runHook("pre", call, o), undefined, "no permission decision");
	assert.ok(inspected.some((p) => p.startsWith(other[0]!)), "positive control: explicit destination actually inspected");
	assert.ok(inspected.every((p) => p.startsWith(other[0]!)), "other unrelated trees remain untouched");
});

test("dirty-baseline and repeated-path names use bounded current mappings; an unrelated known ID remains rejected", async () => {
	const { root, stateDir } = project();
	editManifest(root, (c) => { c["§app/unrelated"] = { kind: "behavior", requires: [], code: ["src/b.txt"] }; });
	write(root, ".sova/spec/claims/app/unrelated.md", "# §app/unrelated\n\nOther.\n");
	write(root, "src/b.txt", "b\n"); git(root, ...C, "add", "."); git(root, ...C, "commit", "-qm", "other mapping");
	const o = { core: CORE, stateDir };
	write(root, "src/a.txt", "dirty baseline\n");
	for (const prompt_id of ["dirty", "repeat"]) {
		await runHook("turn", event(root, { prompt_id }), o);
		const input = event(root, { prompt_id, tool_name: "Edit", tool_input: { file_path: "src/a.txt" } });
		await runHook("pre", input, o); write(root, "src/a.txt", `${prompt_id} edit\n`); await runHook("post", input, o);
		assert.deepEqual(readState(statePath(stateDir, "s1")!).census.foreign, [], "no fresh-path census: mapping proof is independent");
		assert.equal(await runHook("stop", event(root, { prompt_id, last_assistant_message: "Done.\nAlso changes: §app/x — truthful mapped edit" }), o), undefined);
	}
	assert.equal(git(root, "diff", "--", ".sova/spec/claims/app/x.md"), "", "prose unchanged");
	const extra = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/unrelated — invented" }), o) as any;
	assert.equal(extra?.decision, "block"); assert.match(extra.reason, /§app\/unrelated.*never saw/);
});

test("real core corrupt draft census is incomplete; failed mapping input never falsely accuses a truthful name", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	write(root, ".sova/spec/drafts/corrupt/draft.json", "{");
	write(root, "src/a.txt", "changed\n");
	const out = await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o) as any;
	assert.match(out?.hookSpecificOutput?.additionalContext ?? "", /incomplete check.*partial draft scan/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.partial, true);
	const stop = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — truthful edit" }), o) as any;
	assert.match(stop?.systemMessage ?? "", /incomplete check/); assert.equal(stop?.decision, undefined);
	fs.rmSync(path.join(root, ".sova/spec/drafts/corrupt"), { recursive: true });
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "again\n");
	await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o);
	const unread = { ...localIO, readFile: (p: string) => { if (p.endsWith("manifest.json")) throw new Error("fixture unreadable"); return localIO.readFile(p); } };
	const unavailable = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — truthful edit" }), { ...o, io: unread }) as any;
	assert.match(unavailable?.systemMessage ?? "", /incomplete check/); assert.equal(unavailable?.decision, undefined);
});

test("nonthrowing missing/malformed census output and unavailable destination remain incomplete, never exact-empty QA", async () => {
	for (const stdout of ["", "{}", "not JSON"]) {
		const { root, stateDir } = project();
		const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => cmd === "node" && args.includes("census") ? Promise.resolve({ stdout, code: 1 }) : localIO.exec(cmd, args, opts) };
		const o = { core: CORE, stateDir, io };
		await runHook("turn", event(root, {}), o);
		write(root, "src/a.txt", "changed\n");
		const result = await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o) as any;
		assert.match(result?.hookSpecificOutput?.additionalContext ?? "", /incomplete check/);
		const stopped = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — truthful" }), o) as any;
		assert.match(stopped?.systemMessage ?? "", /incomplete check/); assert.equal(stopped?.decision, undefined);
	}
	const { root, stateDir } = project();
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spec-unavailable-")), "wt"); roots.push(path.dirname(wt));
	git(root, "worktree", "add", "-qb", "unavailable", wt);
	let unavailable = false;
	const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => unavailable && opts.cwd === wt ? Promise.resolve({ stdout: "", code: 1 }) : localIO.exec(cmd, args, opts) };
	const o = { core: CORE, stateDir, io }, call = event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } });
	await runHook("turn", event(root, {}), o); await runHook("pre", call, o);
	write(wt, "src/a.txt", "changed\n"); unavailable = true;
	const post = await runHook("post", call, o) as any;
	assert.match(post?.hookSpecificOutput?.additionalContext ?? "", /incomplete check: Git view unavailable/);
	assert.equal(readState(statePath(stateDir, "s1")!).turn.wrote, false, "observation really cannot classify the Bash write");
	const stop = await runHook("stop", event(root, { last_assistant_message: "Done.\nAlso changes: §app/x — truthful linked edit" }), o) as any;
	assert.match(stop?.systemMessage ?? "", /incomplete check/); assert.equal(stop?.decision, undefined, "never claims that unknown means no files changed");
});
