import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { localIO } from "../mode/spec-guard.ts";
import {
	SPEC_HOOK_SCRIPT, readState, runHook, specHookSettings, statePath, withClaudeSettings,
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
const context = (out: any): string => out?.hookSpecificOutput?.additionalContext ?? "";
const C = ["-c", "user.email=t@t", "-c", "user.name=t"];

test("specHookSettings: turn, pre and post (after ANY tool), run by node with the core and state dirs, nothing at Stop; withClaudeSettings keeps a sandbox's settings and hooks", () => {
	const settings = specHookSettings({ node: "/usr/bin/node", coreDir: "/c ore", stateDir: "/s" }) as any;
	assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
	assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
	assert.equal(settings.hooks.PostToolUse[0].matcher, "*");
	assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, `/usr/bin/node ${SPEC_HOOK_SCRIPT} post --core '/c ore' --state /s`);
	const merged = JSON.parse(withClaudeSettings('{"sandbox":{"enabled":true},"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"own"}]}]}}', settings));
	assert.deepEqual(merged.sandbox, { enabled: true });
	assert.equal(merged.hooks.PostToolUse.length, 2, "appended after the base's own PostToolUse hook");
	assert.equal(merged.hooks.PostToolUse[0].hooks[0].command, "own");
	assert.throws(() => withClaudeSettings("[]", settings), /JSON object/);
	// buildClaudeArgv carries it in the one --settings, attribution merged over it.
	const built = buildClaudeArgv({ permissionMode: "bypassPermissions", permissionModes: ["bypassPermissions"], hostPermissions: false, settingsJson: withClaudeSettings(undefined, settings) });
	const flag = JSON.parse(built.args![built.args!.indexOf("--settings") + 1]);
	assert.deepEqual(flag, { ...settings, ...NO_ATTRIBUTION });
});

test("state paths: a session id never escapes the state dir", () => {
	assert.equal(statePath("/s", "../etc"), undefined);
	assert.equal(statePath("/s", "b5a20bf1-9dde"), "/s/b5a20bf1-9dde.json");
});

test("post after a Bash edit: a census digest; a read-only tool: nothing", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, { hook_event_name: "UserPromptSubmit" }), o);
	assert.equal(await runHook("post", event(root, { tool_name: "Read", tool_input: { file_path: "src/a.txt" } }), o), undefined);
	write(root, "src/a.txt", "changed by a heredoc\n");
	const out = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "cat > src/a.txt <<EOF" }, tool_response: { stdout: "" } }), o) as any;
	assert.equal(out?.hookSpecificOutput?.hookEventName, "PostToolUse");
	assert.match(context(out), /\[spec census\]/);
	assert.match(context(out), /New: src\/a\.txt → §app\/x/, "the § the change maps to");
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
	git(root, ...C, "commit", "-qm", "many");
	return { root, stateDir };
}

test("the census note: New: shows 3 § a file; No draft yet prints once per work tree; an old state file loads", async () => {
	const { root, stateDir } = manyProject();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	write(root, "src/a.txt", "2\n");
	const first = context(await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o));
	assert.match(first, /New: src\/a\.txt → §app\/aa, §app\/ab, §app\/ac \(\+2 more\)/);
	assert.match(first, /No draft yet/);
	assert.doesNotMatch(first, /Foreign §|Rule: /);
	await runHook("turn", event(root, { prompt_id: "p2" }), o);
	write(root, "src/b.txt", "2\n");
	const second = context(await runHook("post", event(root, { prompt_id: "p2", tool_name: "Edit", tool_input: { file_path: "src/b.txt" } }), o));
	assert.match(second, /New: src\/b\.txt → §app\/b/);
	assert.doesNotMatch(second, /No draft yet/, "said once in the session");
	// A state file from before the turn-end check went: its turn fields load and are dropped.
	const file = statePath(stateDir, "s1")!;
	const old = JSON.parse(fs.readFileSync(file, "utf8"));
	Object.assign(old.turn, { wrote: true, landed: true, foreign: ["§app/b"], blocks: 1, landings: [] });
	fs.writeFileSync(file, JSON.stringify(old));
	write(root, "src/c.txt", "2\n");
	const third = context(await runHook("post", event(root, { prompt_id: "p2", tool_name: "Edit", tool_input: { file_path: "src/c.txt" } }), o));
	assert.match(third, /New: src\/c\.txt → §app\/c/);
	assert.deepEqual(Object.keys(readState(file).turn).sort(), ["view", "views"]);
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
	assert.match(context(out), /New: src\/a\.txt → §app\/x/);
	write(root, "src/new.txt", "n\n");
	const other = await runHook("post", event(root, { tool_name: "mcp__team__future_tool", tool_input: {} }), o) as any;
	assert.match(context(other), /New: src\/new\.txt → unclaimed/, "an unlisted team tool is never skipped");
});

test("a census that can't run is said once per cause per work tree, and again after a census there succeeds; never a [spec check]", async () => {
	const { root, stateDir } = project();
	let failing = true;
	const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => failing && cmd === "node" && args.includes("census") ? Promise.resolve({ stdout: "", code: 1 }) : localIO.exec(cmd, args, opts) };
	const o = { core: CORE, stateDir, io };
	await runHook("turn", event(root, {}), o);
	const post = async (file: string) => { write(root, file, `${file}\n`); return context(await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: file } }), o)); };
	const first = await post("src/one.txt");
	assert.match(first, /^\[spec census\] incomplete: .+; run census by hand$/m);
	const second = await post("src/two.txt");
	assert.doesNotMatch(second, /incomplete/, "the same cause, the same tree: said once");
	failing = false;
	assert.match(await post("src/three.txt"), /New: /, "a census that runs");
	failing = true;
	assert.match(await post("src/four.txt"), /\[spec census\] incomplete: /, "said again after a census succeeded");
	assert.doesNotMatch(first + second, /\[spec check\]/);
	assert.doesNotMatch(fs.readFileSync(path.join(stateDir, "s1.log.jsonl"), "utf8"), /\[spec check\]/);
});

test("a census failure first hit by the turn hook's baseline is still said by the next post, once", async () => {
	const { root, stateDir } = project();
	const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => cmd === "node" && args.includes("census") ? Promise.resolve({ stdout: "", code: 1 }) : localIO.exec(cmd, args, opts) };
	const o = { core: CORE, stateDir, io };
	write(root, "src/pre.txt", "p\n");
	await runHook("turn", event(root, {}), o);
	const post = async (file: string) => { write(root, file, `${file}\n`); return context(await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: file } }), o)); };
	assert.match(await post("src/one.txt"), /\[spec census\] incomplete: /, "the turn's failure was never shown: said now");
	assert.doesNotMatch(await post("src/two.txt"), /incomplete/, "then said once");
});

test("a corrupt draft makes the census incomplete: one [spec census] line, no [spec check]", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	write(root, ".sova/spec/drafts/corrupt/draft.json", "{");
	write(root, "src/a.txt", "changed\n");
	const text = context(await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: "src/a.txt" } }), o));
	assert.match(text, /\[spec census\] incomplete: .*; run census by hand/);
	assert.doesNotMatch(text, /\[spec check\]/);
});

test("an explicit destination whose Git view is unavailable says nothing about it", async () => {
	const { root, stateDir } = project();
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spec-unavailable-")), "wt"); roots.push(path.dirname(wt));
	git(root, "worktree", "add", "-qb", "unavailable", wt);
	let unavailable = false;
	const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => unavailable && opts.cwd === wt ? Promise.resolve({ stdout: "", code: 1 }) : localIO.exec(cmd, args, opts) };
	const o = { core: CORE, stateDir, io }, call = event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } });
	await runHook("turn", event(root, {}), o); await runHook("pre", call, o);
	write(wt, "src/a.txt", "changed\n"); unavailable = true;
	assert.equal(await runHook("post", call, o), undefined);
});

test("an explicit other-worktree uncommitted Bash edit gets the census", async () => {
	const { root, stateDir } = project();
	const wt = path.join(root, "linked");
	git(root, "worktree", "add", "-qb", "other", wt);
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	assert.equal(await runHook("pre", event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } }), o), undefined);
	write(wt, "src/a.txt", "changed in linked tree\n");
	const post = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: `cd '${wt}' && printf changed > src/a.txt` } }), o) as any;
	assert.match(context(post), /New: src\/a\.txt → §app\/x/);
});

test("write guard: an Edit on the current manifest, or a shell write to claims/, is a direct write", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	await runHook("turn", event(root, {}), o);
	const manifest = path.join(root, ".sova/spec/manifest.json");
	fs.appendFileSync(manifest, "\n");
	const out = await runHook("post", event(root, { tool_name: "Edit", tool_input: { file_path: manifest } }), o) as any;
	assert.match(context(out), /you wrote the current spec directly \(.*manifest\.json\): undo it; change claims in a draft and promote/);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX by hand.\n");
	const sh = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "python3 fix.py" } }), o) as any;
	assert.match(context(sh), /you wrote the current spec directly \(\.sova\/spec\/claims\/app\/x\.md\)/);
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX by git.\n");
	const g = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git checkout main -- .sova" } }), o) as any;
	assert.doesNotMatch(context(g), /wrote the current spec directly/, "git is sanctioned");
});

test("write guard: a git rebase that takes a draft's evidence commit off the branch names the sha and the restore", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir };
	write(root, ".gitignore", ".sova/spec/drafts/\n.hook-state/\n");
	git(root, ...C, "add", ".gitignore");
	git(root, ...C, "commit", "-qm", "ignore");
	git(root, "checkout", "-qb", "feat");
	write(root, "src/a.txt", "b\n");
	git(root, ...C, "commit", "-qam", "code");
	const ev = git(root, "rev-parse", "HEAD");
	write(root, ".sova/spec/drafts/d/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: ev, ids: [{ id: "§app/x" }] }] }));
	git(root, "checkout", "-q", "main");
	write(root, "src/b.txt", "m\n");
	git(root, ...C, "add", "src/b.txt");
	git(root, ...C, "commit", "-qm", "main moves");
	git(root, "checkout", "-q", "feat");
	await runHook("turn", event(root, {}), o);
	git(root, ...C, "rebase", "-q", "main");
	const text = context(await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git rebase main" } }), o));
	assert.match(text, new RegExp(`never rebase after evidence \\(PROMOTE\\.md\\): draft d's evidence commit ${ev.slice(0, 12)} \\(§app/x\\) is no longer on this branch`));
	assert.match(text, new RegExp(`git reset --hard ${ev}\``), "the exact old tip, reset only with a clean tree");
	assert.match(text, /With no uncommitted changes/);
	assert.equal(text.split("never rebase after evidence").length - 1, 1, "said once, not again by the census");
});

test("a merge or promote says nothing beyond the census: no landing list, no ledger", async () => {
	const { root, stateDir } = project();
	const o = { core: CORE, stateDir, ledger: path.join(stateDir, "ledger.jsonl") };
	git(root, "checkout", "-qb", "feat");
	write(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does a better thing.\n");
	git(root, ...C, "commit", "-qam", "reword");
	git(root, "checkout", "-q", "main");
	await runHook("turn", event(root, {}), o);
	git(root, ...C, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
	const out = await runHook("post", event(root, { tool_name: "Bash", tool_input: { command: "git merge --no-ff feat" } }), o);
	assert.doesNotMatch(context(out), /\[spec check\]|Also changes|foreign/i);
	assert.equal(fs.existsSync(o.ledger), false, "no ledger is written");
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

test("the script entry: reads the event on stdin, prints Claude's JSON, and never fails a worker; `stop` and --ledger from older workers print nothing", () => {
	const { root, stateDir } = project();
	const run = (ev: string, input: unknown, extra: string[] = []) => spawnSync(process.execPath, [SPEC_HOOK_SCRIPT, ev, "--core", CORE, "--state", stateDir, ...extra], { input: JSON.stringify(input), encoding: "utf8" });
	assert.equal(run("turn", event(root, {})).status, 0);
	write(root, "src/new.txt", "n\n");
	const post = run("post", event(root, { tool_name: "Bash", tool_input: { command: "touch src/new.txt" } }));
	assert.equal(post.status, 0, post.stderr);
	assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /\[spec census\]/);
	const ledger = path.join(stateDir, "old-ledger.jsonl");
	const stop = run("stop", event(root, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." }), ["--ledger", ledger]);
	assert.deepEqual([stop.status, stop.stdout, stop.stderr], [0, "", ""]);
	assert.equal(fs.existsSync(ledger), false);
	write(root, "src/later.txt", "l\n");
	const withLedger = run("post", event(root, { tool_name: "Bash", tool_input: { command: "touch src/later.txt" } }), ["--ledger", ledger]);
	assert.equal(withLedger.status, 0, withLedger.stderr);
	assert.match(JSON.parse(withLedger.stdout).hookSpecificOutput.additionalContext, /src\/later\.txt/, "--ledger still parses");
	assert.equal(fs.existsSync(ledger), false);
	const bad = spawnSync(process.execPath, [SPEC_HOOK_SCRIPT, "post", "--core", CORE, "--state", stateDir], { input: "not json", encoding: "utf8" });
	assert.equal(bad.status, 0);
	assert.equal(bad.stdout, "");
});

test("runHook('stop') with a ledger is a no-op: nothing said, no state written", async () => {
	const { root, stateDir } = project();
	const ledger = path.join(stateDir, "ledger.jsonl");
	assert.equal(await runHook("stop", event(root, { last_assistant_message: "Done." }), { core: CORE, stateDir, ledger }), undefined);
	assert.equal(fs.existsSync(statePath(stateDir, "s1")!), false);
	assert.equal(fs.existsSync(ledger), false);
});
