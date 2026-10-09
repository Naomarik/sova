import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	CensusHook,
	censusStep,
	freshCensusState,
	manifestConflict,
	unmergedPaths,
	coreDir,
	CENSUS_SKIP_TOOLS,
	DIGEST_TAG,
	digest,
	digestSaying,
	draftsCreated,
	draftToolRuns,
	localIO,
	NO_DRAFT_NOTE,
	unmappedNote,
	parsePorcelain,
	ranCensus,
	driftNote,
	driftWarningsIn,
	currentSpecPath,
	SpecWriteGuard,
	viewChanged,
	type CensusView,
	type SpecIO,
} from "./spec-guard.ts";
import { SPEC_CORE_SHELL } from "./minor.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, "../spec/core");
const scratchRoot = process.env.MODE_TEST_SCRATCH ?? join(homedir(), ".cache", "mode-tests");

test("coreDir resolves like spec-mode.md's $core line", () => {
	assert.equal(coreDir({}, "/home/u"), "/home/u/.pi/agent/extensions/spec/core");
	assert.equal(coreDir({ PI_CODING_AGENT_DIR: "/x/agent" }, "/home/u"), "/x/agent/extensions/spec/core");
	assert.equal(coreDir({ PI_CODING_AGENT_DIR: "~/a" }, "/home/u"), "/home/u/a/extensions/spec/core");
	assert.ok(SPEC_CORE_SHELL.includes("/extensions/spec/core"), "the prompt's line names the same directory");
});

test("parsePorcelain: plain entries, and a rename's source is skipped", () => {
	assert.deepEqual(parsePorcelain(" M src/a.ts\0?? new file.md\0R  b2.ts\0b.ts\0 D gone.ts\0"), ["src/a.ts", "new file.md", "b2.ts", "gone.ts"]);
	assert.deepEqual(parsePorcelain(""), []);
});

test("viewChanged: HEAD, the path set, or a changed file's mtime", () => {
	const v = { top: "/r", head: "a", files: { x: 1 } };
	assert.ok(!viewChanged(v, { ...v, files: { x: 1 } }));
	assert.ok(viewChanged(v, { ...v, head: "b" }));
	assert.ok(viewChanged(v, { ...v, files: { x: 2 } }), "an already-dirty file edited again");
	assert.ok(viewChanged(v, { ...v, files: { x: 1, y: 1 } }));
	assert.ok(!viewChanged(undefined, v));
});

/** A promote that writes the current spec, as draftToolRuns reads it (the drift note and the write guard read commands the same way). */
const promoteWrites = (command: string) => draftToolRuns(command).some((r) => r.verb === "promote" && r.args.includes("--write"));

test("command detection: promote --write, draft names, a census already run", () => {
	assert.ok(promoteWrites('node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --plan abc --write --root . --json'));
	assert.ok(!promoteWrites('node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --json'), "a preview writes nothing");
	assert.deepEqual(draftsCreated(['node "$core/sova-spec-draft.mjs" new feat-a --write --root .', 'node "$core/sova-spec-draft.mjs" new dry --root .']), ["feat-a"]);
	assert.ok(ranCensus("bash", { command: 'node "$core/sova-spec.mjs" census --changed --json' }));
	assert.ok(!ranCensus("edit", { path: "a" }));
});

test("promoteWrites: every argv that runs the draft tool (named, or through a variable) with promote … --write; never heredoc, echo or quoted text", () => {
	const hits = [
		// R3-B-s3-2 / s3-3: the path in $d, set in the same command (`;` or a newline), output piped.
		"d=/r/cfg/.agent/extensions/spec/core/sova-spec-draft.mjs; node $d promote quiet-hold  --id '§app.notifications/delivery' --id '§app.notifications/settings' --plan 0206f1a8 --root . --write 2>&1 | tail -2",
		"d=/r/cfg/.agent/extensions/spec/core/sova-spec-draft.mjs\nnode $d promote no-send-test  --id '§app.notifications/send-test' --plan 9f1c --root . --write",
		// R3-B-s2-1: --all.
		"cd /r/repo && node $d promote usage-90-remerge --all --plan 0206f1a810c97b2ea4a1 --root . --write",
		// The quoted variable, and d set in an earlier call.
		'node "$d" promote feat --id \'§a/b\' --plan abc --write',
		"node ${d} promote feat --plan abc --write --root /w/t",
		// The path through $core, quoted or not; ids and the plan in variables (R3-B-s2-2's near-limit-90b).
		'node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --plan abc --write --root . --json',
		"node $core/sova-spec-draft.mjs promote feat --plan abc --write",
		'plan=$(node "$core/sova-spec-draft.mjs" promote near-limit-90b $IDS --root . --json 2>/dev/null | jq -r .plan); echo plan=$plan; node "$core/sova-spec-draft.mjs" promote near-limit-90b $IDS --plan $plan --root . --write 2>&1 | tail -12',
		// The script run directly, node options, a line continuation, an env assignment, a subshell.
		"$DRAFT promote feat --plan abc --write",
		"node --import ./kill.mjs \"$d\" promote f1 --id x --write --root . --json",
		"node \"$d\" promote feat \\\n  --plan abc \\\n  --write",
		"SOVA_X=1 node $d promote feat --plan abc --write",
		"(cd /w/t && node \"$d\" promote feat --plan abc --write)",
	];
	for (const command of hits) assert.ok(promoteWrites(command), command);
	const misses = [
		"node $d promote feat --id '§a/b' --root .", // a preview writes nothing
		'node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --json',
		'echo "node $d promote feat --write"',
		"printf 'node $d promote feat --write\\n'",
		"cat > notes.md <<'EOF'\nnode $d promote feat --plan abc --write\nEOF",
		"cat > notes.md <<-EOF\n\tnode \"$core/sova-spec-draft.mjs\" promote feat --write\n\tEOF\ngit add notes.md",
		'git commit -m "node $d promote feat --write"',
		"grep -n 'promote --write' README.md",
		"node $d new feat --write --root .",
		'node "$core/sova-spec.mjs" census --changed --root . --json # then promote --write',
		": sova-spec-draft.mjs promote feat --write",
		"node $d status feat --json; echo promote --write",
	];
	for (const command of misses) assert.ok(!promoteWrites(command), command);
	// A heredoc body is dropped, and the command after it is still read.
	assert.ok(promoteWrites("cat > n.md <<'EOF'\nnotes\nEOF\nnode $d promote feat --plan abc --write"));
	assert.deepEqual(draftsCreated(["d=/c/sova-spec-draft.mjs; node $d new feat-b --write --root .", "echo node $d new fake --write"]), ["feat-b"]);
});

const censusView = (over: Partial<CensusView> = {}): CensusView => ({
	claimed: [],
	unclaimed: [],
	mappedOutside: [],
	...over,
});

test("digest: the first in-boundary change and each new file; says when there is no draft; no foreign count", () => {
	const v = censusView({ claimed: [{ path: "src/App.tsx", claims: ["§app/shell"] }], unclaimed: ["src/new.ts"] });
	const first = digest(v, ["src/App.tsx"], { reported: false }, false);
	assert.ok(first?.startsWith(`${DIGEST_TAG} 2 changed file(s) in the boundary, 1 unclaimed.\n`), first);
	assert.ok(first?.includes(NO_DRAFT_NOTE));
	assert.ok(first?.includes("New: src/App.tsx → §app/shell"));
	assert.doesNotMatch(first ?? "", /Foreign|Rule:|foreign §/);
	assert.equal(digest(v, ["docs/notes.md"], { reported: true }, true), undefined, "nothing new in the boundary: silent");
	const again = digest(v, ["src/new.ts"], { reported: true }, true);
	assert.ok(again?.includes("New: src/new.ts → unclaimed"));
	assert.ok(!again?.includes(NO_DRAFT_NOTE));
	const outside = digest(censusView({ mappedOutside: [{ path: "pi-config/x.ts", claims: ["§app/worker"] }] }), ["pi-config/x.ts"], { reported: false }, true);
	assert.ok(outside?.startsWith(`${DIGEST_TAG} 0 changed file(s) in the boundary, 0 unclaimed; 1 mapped outside the boundary.`), outside);
	assert.ok(outside?.includes("pi-config/x.ts → outside the boundary, mapped by §app/worker"));
	assert.equal(digest(censusView(), ["README.md"], { reported: false }, false), undefined, "no in-boundary change: silent");
});

test("digest: each file in New: names at most 3 §, mapped outside the boundary too; at most 8 files; unclaimed stays", () => {
	const five = ["§a/1", "§a/2", "§a/3", "§a/4", "§a/5"];
	const v = censusView({ claimed: [{ path: "src/f.ts", claims: five }, { path: "src/t.ts", claims: five.slice(0, 3) }], unclaimed: ["src/u.ts"], mappedOutside: [{ path: "pi-config/g.ts", claims: five }] });
	const text = digest(v, ["src/f.ts", "src/t.ts", "src/u.ts", "pi-config/g.ts"], { reported: false }, true);
	assert.ok(
		text?.includes("New: src/f.ts → §a/1, §a/2, §a/3 (+2 more); src/t.ts → §a/1, §a/2, §a/3; src/u.ts → unclaimed; pi-config/g.ts → outside the boundary, mapped by §a/1, §a/2, §a/3 (+2 more)"),
		text,
	);
	const ten = Array.from({ length: 10 }, (_, i) => `src/n${i}.ts`);
	const many = digest(censusView({ unclaimed: ten }), ten, { reported: true }, true);
	assert.ok(many?.includes("src/n7.ts → unclaimed (+2 more)") && !many.includes("src/n8.ts"), many);
});

test("digest: the No draft line prints once, on the note that has it; the header every time", () => {
	const a = { path: "src/a.ts", claims: ["§a/x"] };
	const one = digestSaying(censusView({ claimed: [a] }), ["src/a.ts"], { reported: false }, false);
	assert.ok(one.text?.includes(NO_DRAFT_NOTE), one.text);
	assert.deepEqual(one.said, { noDraft: true });
	const two = digestSaying(censusView({ claimed: [a, { path: "src/b.ts", claims: ["§a/y"] }] }), ["src/b.ts"], { reported: true, said: one.said }, false);
	assert.ok(two.text?.startsWith(`${DIGEST_TAG} 2 changed file(s) in the boundary, 0 unclaimed.`), two.text);
	assert.ok(!two.text?.includes(NO_DRAFT_NOTE), two.text);
	// Not printed, not marked.
	const quiet = digestSaying(censusView({ claimed: [a] }), ["src/a.ts"], { reported: false }, true);
	assert.deepEqual(quiet.said, {});
});

test("digest: it fires on a first in-boundary change, a new file in the boundary or a new unmapped file outside, never on anything else", () => {
	const said = { noDraft: true };
	const cases: [string, CensusView, string[], { reported: boolean }, boolean][] = [
		["nothing new", censusView({ unclaimed: ["src/u.ts"] }), [], { reported: true }, false],
		["first in-boundary change", censusView({ unclaimed: ["src/u.ts"] }), [], { reported: false }, true],
		["a new file in the boundary", censusView({ unclaimed: ["src/u.ts"] }), ["src/u.ts"], { reported: true }, true],
		["a new unmapped file outside", censusView({ outside: ["README.md"] }), ["README.md"], { reported: true }, true],
		["the spec's own files", censusView({ outside: [".sova/spec/drafts/x/spec/manifest.json"] }), [".sova/spec/drafts/x/spec/manifest.json"], { reported: true }, false],
	];
	for (const [name, v, fresh, state, fires] of cases) {
		for (const s of [state, { ...state, said }]) assert.equal(digest(v, fresh, s, false) !== undefined, fires, name);
	}
});

test("census on a real Git tree: New: shows 3 §; a read-only tool is skipped, bash never; reset says No draft again; a failure is said once per cause until a census runs", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const project = mkdtempSync(join(scratchRoot, "census-note-"));
	try {
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(project, rel)), { recursive: true });
			writeFileSync(join(project, rel), text);
		};
		const git = (...args: string[]) =>
			assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", project, ...args]).status, 0, `git ${args.join(" ")}`);
		const claims: Record<string, { kind: string; code: string[] }> = {};
		for (const n of ["a", "b", "c", "d", "e"]) claims[`§app/a${n}`] = { kind: "surface", code: ["src/a.ts"] };
		for (const f of ["b", "c", "d"]) claims[`§app/${f}`] = { kind: "surface", code: [`src/${f}.ts`] };
		put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims }));
		for (const id of Object.keys(claims)) put(`.sova/spec/claims/app/${id.slice(5)}.md`, `# ${id}\n\nText.\n`);
		for (const f of ["a", "b", "c", "d"]) put(`src/${f}.ts`, "1\n");
		put(".sova/spec/.gitignore", "/drafts/\n");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "base");

		let state = (await censusStep(freshCensusState(), { cwd: project, toolName: "", input: undefined }, CORE)).state;
		put("src/a.ts", "2\n");
		const step = await censusStep(state, { cwd: project, toolName: "edit", input: {} }, CORE);
		assert.ok(step.result.text?.includes("New: src/a.ts → §app/aa, §app/ab, §app/ac (+2 more)"), step.result.text);
		assert.doesNotMatch(step.result.text ?? "", /Foreign|Rule:|foreign/);
		assert.deepEqual(step.state.said, { noDraft: true });
		state = step.state;

		// The census can't run (no trusted tool): one line, once per cause, until a census runs again.
		const missing = join(project, "no-core");
		const line = `${DIGEST_TAG} incomplete: trusted census unavailable; run census by hand`;
		put("src/x1.ts", "1\n");
		const f1 = await censusStep(state, { cwd: project, toolName: "edit", input: {} }, missing);
		assert.equal(f1.result.failure, line);
		put("src/x2.ts", "1\n");
		const f2 = await censusStep(f1.state, { cwd: project, toolName: "edit", input: {} }, missing);
		assert.equal(f2.result.failure, undefined, "the same cause again: silent");
		put("src/x3.ts", "1\n");
		const ok = await censusStep(f2.state, { cwd: project, toolName: "edit", input: {} }, CORE);
		assert.equal(ok.result.failure, undefined);
		assert.ok(ok.result.text?.includes("src/x3.ts"), ok.result.text);
		assert.equal(ok.state.failSaid, undefined, "a census that ran clears what was said");
		put("src/x4.ts", "1\n");
		const f3 = await censusStep(ok.state, { cwd: project, toolName: "edit", input: {} }, missing);
		assert.equal(f3.result.failure, line, "said again after a census ran");
		assert.doesNotMatch(JSON.stringify([f1, f2, f3]), /\[spec check\]/);

		const execs: string[][] = [];
		const io: SpecIO = { ...localIO, exec: (cmd, args, o) => (execs.push([cmd, ...args]), localIO.exec(cmd, args, o)) };
		const hook = new CensusHook({ io, core: () => CORE });
		await hook.prime(project);
		put("src/b.ts", "2\n");
		execs.length = 0;
		for (const toolName of CENSUS_SKIP_TOOLS) {
			await hook.before({ cwd: project, toolName, input: { path: "src/b.ts" } });
			assert.deepEqual(await hook.after({ cwd: project, toolName, input: { path: "src/b.ts" } }), {}, toolName);
		}
		assert.deepEqual(execs, [], "a skipped tool neither looks nor runs the census");
		assert.ok(!CENSUS_SKIP_TOOLS.has("bash") && !CENSUS_SKIP_TOOLS.has("edit") && !CENSUS_SKIP_TOOLS.has("write"));
		const first = await hook.after({ cwd: project, toolName: "bash", input: { command: "true" } });
		assert.ok(first.text?.includes("New: src/b.ts → §app/b") && first.text.includes(NO_DRAFT_NOTE), `the next writing call reports it: ${first.text}`);
		put("src/c.ts", "2\n");
		const second = await hook.after({ cwd: project, toolName: "edit", input: { path: "src/c.ts" } });
		assert.ok(second.text?.includes("New: src/c.ts → §app/c") && !second.text.includes(NO_DRAFT_NOTE), second.text);
		hook.reset();
		await hook.prime(project);
		put("src/d.ts", "2\n");
		const fresh = await hook.after({ cwd: project, toolName: "edit", input: { path: "src/d.ts" } });
		assert.ok(fresh.text?.includes(NO_DRAFT_NOTE), `a new session says it again: ${fresh.text}`);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("CensusHook on a real Git tree: bash-style writes are caught by the git delta; one digest per new file", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const project = mkdtempSync(join(scratchRoot, "spec-guard-"));
	try {
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(project, rel)), { recursive: true });
			writeFileSync(join(project, rel), text);
		};
		const git = (...args: string[]) =>
			assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", project, ...args]).status, 0, `git ${args.join(" ")}`);
		put(
			".sova/spec/manifest.json",
			JSON.stringify({
				formatVersion: 1,
				grammar: { claimsRoot: "claims/", directoryKinds: ["section"] },
				boundary: { include: ["src"], exclude: [] },
				claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } },
			}),
		);
		put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
		put("src/App.tsx", "1\n");
		put("README.md", "r\n");
		put(".sova/spec/.gitignore", "/drafts/\n");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "base");

		const hook = new CensusHook({ core: () => CORE });
		const after = (toolName = "bash") => hook.after({ cwd: project, toolName, input: { command: "cat > f <<EOF" } });
		assert.deepEqual(await hook.prime(project), {}, "the baseline says nothing");
		put("README.md", "changed\n");
		const outside = await after();
		assert.equal(outside.text, `${DIGEST_TAG} 0 changed file(s) in the boundary, 0 unclaimed.\n${unmappedNote(["README.md"])}`, "a change outside the boundary no claim maps: one line");
		put("src/App.tsx", "2\n");
		const first = await after("edit");
		assert.ok(first.text?.startsWith(DIGEST_TAG), `first in-boundary change: ${JSON.stringify(first)}`);
		assert.ok(first.text?.includes("§app/shell"));
		assert.ok(first.text?.includes(NO_DRAFT_NOTE));
		put("src/App.tsx", "3\n");
		assert.deepEqual(await after(), {}, "the same file again: silent");
		put("src/extra.ts", "x\n");
		const fresh = await after();
		assert.ok(fresh.text?.includes("New: src/extra.ts → unclaimed"), JSON.stringify(fresh));
		git("add", "-A");
		git("commit", "-qm", "work");
		put("src/later.ts", "y\n");
		git("add", "-A");
		git("commit", "-qm", "more");
		const committed = await after();
		assert.ok(committed.text?.includes("src/later.ts"), `a file created and committed in one call still counts: ${JSON.stringify(committed)}`);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("a manifest.json in a Git conflict: the census says to run merge-manifest, once per conflict", async () => {
	assert.deepEqual(unmergedPaths("UU .sova/spec/manifest.json\0 M src/a.ts\0AA b\0"), [".sova/spec/manifest.json", "b"]);
	assert.equal(manifestConflict({ top: "/r", head: "a", files: {}, unmerged: ["sub/.sova/spec/manifest.json"] }), "sub/.sova/spec/manifest.json");
	assert.equal(manifestConflict({ top: "/r", head: "a", files: {} }), undefined);
	mkdirSync(scratchRoot, { recursive: true });
	const repo = mkdtempSync(join(scratchRoot, "spec-conflict-"));
	try {
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(repo, rel)), { recursive: true });
			writeFileSync(join(repo, rel), text);
		};
		const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args], { encoding: "utf8" });
		const manifest = (id: string) => JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, claims: { [id]: { kind: "note" } } }, null, 1);
		put(".sova/spec/manifest.json", manifest("§a/base"));
		git("init", "-q", "-b", "master");
		git("add", "-A");
		git("commit", "-qm", "base");
		git("checkout", "-qb", "side");
		put(".sova/spec/manifest.json", manifest("§a/side"));
		git("commit", "-qam", "side");
		git("checkout", "-q", "master");
		put(".sova/spec/manifest.json", manifest("§a/main"));
		git("commit", "-qam", "main");
		let state = (await censusStep(freshCensusState(), { cwd: repo, toolName: "", input: undefined }, CORE)).state;
		assert.notEqual(git("merge", "side").status, 0, "the merge conflicts");
		const first = await censusStep(state, { cwd: repo, toolName: "bash", input: { command: "git merge side" } }, CORE);
		assert.match(first.result.text ?? "", /\.sova\/spec\/manifest\.json is in conflict: run `node ".*sova-spec-draft\.mjs" merge-manifest --root .* --write --json` first/);
		assert.match(first.result.text ?? "", /If it refuses \(manifest-conflict\): take master's manifest and matching claims \(git checkout master -- …\), re-apply the branch's spec changes in a new draft, and promote\. Never take a side before merge-manifest has run\./);
		state = first.state;
		assert.equal((await censusStep(state, { cwd: repo, toolName: "read", input: {} }, CORE)).result.text, undefined, "said once per conflict");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("digest: the new changed files outside the boundary that no claim maps get one line; mapped ones and the spec's own files don't", () => {
	const v = censusView({ outside: ["pi-config/usage-status/index.ts", "pi-config/x.ts", ".sova/spec/claims/app/a.md", "docs/a.md"], mappedOutside: [{ path: "pi-config/x.ts", claims: ["§app/worker"] }] });
	const text = digest(v, ["pi-config/usage-status/index.ts", "pi-config/x.ts", ".sova/spec/claims/app/a.md", "docs/a.md"], { reported: false }, true);
	assert.ok(text?.includes("Outside the boundary, no claim maps: pi-config/usage-status/index.ts, docs/a.md: spec any whose change a user sees"), text);
	assert.equal(text?.split("\n").filter((l) => l.startsWith("Outside the boundary")).length, 1, "one line");
	assert.doesNotMatch(text ?? "", /plumbing/);
	const many = Array.from({ length: 10 }, (_, i) => `docs/d${i}.md`);
	assert.equal(unmappedNote(many), `Outside the boundary, no claim maps: ${many.slice(0, 8).join(", ")} (+2 more): spec any whose change a user sees`);
	assert.ok(!text?.includes(".sova/spec/claims/app/a.md"), "the spec's own files are not behavior");
	assert.equal(digest(v, ["README.md"], { reported: true }, true), undefined, "only new files: said once per file");
	assert.equal(digest(censusView({ outside: null }), ["a.ts"], { reported: false }, true), undefined, "no boundary: nothing is outside");
});

test("SpecWriteGuard (M2-B-s2-1's shape): a rebase after evidence and a hand edit of the manifest are said at once; a merge, git and the draft tools are not", async () => {
	assert.ok(currentSpecPath("/w/.sova/spec/manifest.json") && currentSpecPath(".sova/spec/claims/app/x.md") && currentSpecPath("sub/.sova/spec/claims/a.md"));
	assert.ok(!currentSpecPath("/w/.sova/spec/drafts/d/spec/manifest.json") && !currentSpecPath("/w/.sova/spec/drafts/d/spec/claims/a.md") && !currentSpecPath("/w/src/claims/a.ts"));
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "spec-writes-"));
	const repo = join(dir, "repo");
	const wt = join(dir, "wt");
	try {
		const put = (at: string, rel: string, text: string) => {
			mkdirSync(dirname(join(at, rel)), { recursive: true });
			writeFileSync(join(at, rel), text);
		};
		const git = (at: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", at, ...args], { encoding: "utf8" });
		const head = (at: string) => git(at, "rev-parse", "HEAD").stdout.trim();
		const manifest = (evidence: string) =>
			JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§a/x": { kind: "behavior", evidence, code: ["src/a.ts"] } } }, null, 1);
		mkdirSync(repo);
		put(repo, ".sova/spec/manifest.json", manifest("unreviewed"));
		put(repo, ".sova/spec/.gitignore", "drafts/\n");
		put(repo, "src/a.ts", "1\n");
		put(repo, ".sova/spec/claims/a/x.md", "# §a/x\n\nX.\n");
		git(repo, "init", "-q", "-b", "master");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		git(repo, "worktree", "add", "-q", "-b", "feat", wt);
		put(wt, "src/a.ts", "2\n");
		git(wt, "commit", "-qam", "code");
		const code = head(wt);
		put(wt, ".sova/spec/drafts/d/draft.json", JSON.stringify({ evidence: [{ mode: "commit", commit: code, ids: [{ id: "§a/x" }] }] }));
		put(wt, ".sova/spec/manifest.json", manifest("verified"));
		git(wt, "commit", "-qam", "spec: promote d");
		put(repo, ".sova/spec/manifest.json", manifest("reviewed"));
		git(repo, "commit", "-qam", "master moves");

		const guard = new SpecWriteGuard();
		const bash = async (id: string, command: string, run: () => void) => {
			const call = { cwd: dir, toolName: "bash", input: { command } };
			await guard.before(id, call);
			run();
			return (await guard.after(id, call)).text;
		};
		// The merge PROMOTE.md asks for: evidence stays on the branch, nothing to say.
		const merged = await bash("m", `cd ${wt} && git merge master`, () => git(wt, "merge", "master"));
		assert.equal(merged, undefined);
		git(wt, "merge", "--abort");
		// The rebase: it stops on the manifest, and the evidence commit is already off the branch.
		const tip = head(wt);
		const census = new CensusHook({ core: () => CORE });
		const relay = new CensusHook({ core: () => CORE });
		for (const h of [census, relay]) await h.prime(wt);
		const call = { cwd: dir, toolName: "bash", input: { command: `cd ${wt} && git rebase master` } };
		await guard.before("r", call);
		assert.notEqual(git(wt, "rebase", "master").status, 0);
		const guarded = await guard.after("r", call);
		const rebased = guarded.text;
		assert.deepEqual(guarded.lost, [code]);
		// The census sees the same orphan (census --changed orphanedEvidence): said once, by the guard when it
		// saw the call; relayed by the census when it didn't (a worker's rebase, a later look).
		assert.doesNotMatch((await census.after({ cwd: wt, toolName: "bash", input: call.input, orphansSaid: guarded.lost })).text ?? "", /is no longer on this branch/);
		// Mid-rebase the manifest is in conflict (the census can't read it): the conflict note says abort, not merge-manifest.
		const midway = (await relay.after({ cwd: wt, toolName: "bash", input: call.input })).text ?? "";
		assert.match(midway, /\.sova\/spec\/manifest\.json is in conflict\. A rebase is under way: abort it \(`git rebase --abort`\) and merge master in instead/);
		assert.doesNotMatch(midway, /merge-manifest --root/);
		assert.equal(
			rebased,
			`${DIGEST_TAG} never rebase after evidence (PROMOTE.md): draft d's evidence commit ${code.slice(0, 12)} (§a/x) is no longer on this branch. Abort it (\`git rebase --abort\`) and merge master in instead.`,
		);
		// Resolving the conflict by hand is a direct write; so is a shell write; a draft's own files are not.
		const edit = (await guard.after("e", { cwd: dir, toolName: "edit", input: { path: join(wt, ".sova/spec/manifest.json") } })).text;
		assert.equal(edit, `${DIGEST_TAG} you wrote the current spec directly (${join(wt, ".sova/spec/manifest.json")}): undo it; change claims in a draft and promote (manifest conflicts: merge-manifest).`);
		assert.equal((await guard.after("e2", { cwd: wt, toolName: "write", input: { path: ".sova/spec/drafts/d/spec/manifest.json" } })).text, undefined);
		// Mid-rebase a shell write is the rebase's resolution: the file state (a Git operation under way) excuses it, whatever the command says.
		assert.equal(await bash("s", `cd ${wt} && printf x >> .sova/spec/claims/a.md`, () => put(wt, ".sova/spec/claims/a.md", "x")), undefined);
		assert.equal(await bash("p", `cd ${wt} && node "$core/sova-spec-draft.mjs" promote d --write`, () => put(wt, ".sova/spec/claims/a.md", "y")), undefined, "the draft tools write the current spec");
		assert.equal(await bash("c", `cd ${wt} && git checkout master -- .sova/spec/manifest.json`, () => git(wt, "checkout", "master", "--", ".sova/spec/manifest.json")), undefined);
		git(wt, "rebase", "--abort");
		assert.equal(head(wt), tip);
		// With no Git operation under way, a shell write is a direct write; git restoring HEAD's bytes is not.
		const shell = await bash("s2", `cd ${wt} && printf x >> .sova/spec/claims/a.md`, () => put(wt, ".sova/spec/claims/a.md", "x"));
		assert.match(shell ?? "", /you wrote the current spec directly \(\.sova\/spec\/claims\/a\.md\)/);
		assert.equal(await bash("s3", `cd ${wt} && git checkout -- .sova/spec/claims/a.md`, () => git(wt, "checkout", "--", ".sova/spec/claims/a.md")), undefined);
		// A reset (no rebase under way) past the evidence: restore the branch.
		const later = new CensusHook({ core: () => CORE });
		await later.prime(wt);
		const reset = await bash("h", `git -C ${wt} reset -q --hard HEAD~2`, () => git(wt, "reset", "-q", "--hard", "HEAD~2"));
		// A census that didn't see the guard's line relays census --changed orphanedEvidence, once.
		const relayed = (await later.after({ cwd: wt, toolName: "bash", input: {} })).text ?? "";
		assert.match(relayed, new RegExp(`never rebase after evidence \\(PROMOTE\\.md\\): draft d's evidence commit ${code.slice(0, 12)} \\(§a/x\\) is no longer on this branch\\. If a rebase is under way: Abort it \\(\`git rebase --abort\`\\) and merge master in instead\\. If not: find the pre-rebase tip in \`git reflog\`\\. With no uncommitted changes \\(commit them first\\), restore the old tip: \`git reset --hard <that tip>\`; then merge master in instead\\.`));
		assert.doesNotMatch(relayed, /ORIG_HEAD/);
		put(wt, "src/c.ts", "c\n");
		assert.doesNotMatch((await later.after({ cwd: wt, toolName: "bash", input: {} })).text ?? "", /is no longer on this branch/, "said once");
		assert.match(reset ?? "", new RegExp(`evidence commit ${code.slice(0, 12)} \\(§a/x\\) is no longer on this branch\\. With no uncommitted changes \\(commit them first\\), restore the old tip: \`git reset --hard ${tip}\`; then merge master in instead\\.$`));
		// A commit on top keeps the evidence: silent.
		git(wt, "reset", "-q", "--hard", tip);
		assert.equal(await bash("k", `cd ${wt} && git commit -q --allow-empty -m more`, () => git(wt, "commit", "-q", "--allow-empty", "-m", "more")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("driftNote: promote's driftWarnings (--json or text form) are relayed as a warning; other calls and an empty list stay silent", () => {
	const w = 'the draft removed "≥80%" from §a/x, but §a/y still says it: read them; if the fact changed, change it there too (each is a foreign §)';
	const json = JSON.stringify({ name: "d", ids: ["§a/x"], driftWarnings: [w, 'a "quoted ] bracket"'], meta: [] }, null, 2);
	assert.deepEqual(driftWarningsIn(`noise [1]\n${json}`), [w, 'a "quoted ] bracket"']);
	assert.deepEqual(driftWarningsIn(`promote d: §a/x (written)\n  warn drift: ${w}\n`), [w]);
	const promote = { command: 'node "$core/sova-spec-draft.mjs" promote d --plan abc --write --json' };
	const note = driftNote("bash", promote, [{ type: "text", text: json }]);
	assert.match(note ?? "", /^\[spec census\] promote's drift warnings: \(1\) the draft removed "≥80%" from §a\/x, but §a\/y still says it/);
	assert.match(note ?? "", /For each: change the stale § in a draft and promote, or say why it stays\.$/);
	assert.doesNotMatch(note ?? "", /Also changes|\[spec check\]/);
	assert.equal(driftNote("bash", promote, [{ type: "text", text: JSON.stringify({ driftWarnings: [] }) }]), undefined);
	assert.equal(driftNote("bash", { command: "cat out.json" }, [{ type: "text", text: json }]), undefined);
	assert.equal(driftNote("read", promote, [{ type: "text", text: json }]), undefined);
});

test("F6/F7: the census follows the tree a call writes in (a parent's `cd <worktree> && …`, an edit's path); a worktree's draft is its workers' too", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "spec-f6-"));
	const repo = join(dir, "repo");
	const wt = join(dir, "wt");
	try {
		const put = (at: string, rel: string, text: string) => {
			mkdirSync(dirname(join(at, rel)), { recursive: true });
			writeFileSync(join(at, rel), text);
		};
		const git = (at: string, ...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", at, ...args]).status, 0, args.join(" "));
		mkdirSync(repo);
		put(repo, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } } }));
		put(repo, ".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
		put(repo, "src/App.tsx", "1\n");
		put(repo, "src/Other.tsx", "1\n");
		git(repo, "init", "-q", "-b", "master");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		git(repo, "worktree", "add", "-q", "-b", "feat", wt);
		const hook = new CensusHook({ core: () => CORE });
		await hook.prime(repo);
		const bash = { cwd: repo, toolName: "bash", input: { command: `cd ${wt} && printf '2\\n' > src/App.tsx` } };
		await hook.before(bash);
		writeFileSync(join(wt, "src/App.tsx"), "2\n");
		const r = await hook.after(bash);
		assert.match(r.text ?? "", /\[spec census\] 1 changed file\(s\) in the boundary/, "the worktree's first edit is a delta, not its baseline");
		assert.match(r.text ?? "", /src\/App\.tsx → §app\/shell/);
		const edit = { cwd: repo, toolName: "edit", input: { path: join(wt, "src/Other.tsx") } };
		await hook.before(edit);
		writeFileSync(join(wt, "src/Other.tsx"), "2\n");
		assert.match((await hook.after(edit)).text ?? "", /New: src\/Other\.tsx → unclaimed/);
		// F7: a draft the parent made in the worktree is the worker's too (its session started later, its
		// commands never created it): no false "No draft yet".
		assert.equal(spawnSync("node", [join(CORE, "sova-spec-draft.mjs"), "new", "task", "--write", "--root", wt, "--json"]).status, 0);
		const worker = new CensusHook({ core: () => CORE });
		await worker.prime(wt);
		writeFileSync(join(wt, "src/New.tsx"), "new\n");
		const w = await worker.after({ cwd: wt, toolName: "bash", input: { command: "true" }, commands: [], sessionStart: new Date(Date.now() + 60_000).toISOString() });
		assert.match(w.text ?? "", /changed file\(s\) in the boundary/);
		assert.doesNotMatch(w.text ?? "", /No draft yet/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two trees failing with different causes in one call: both lines are said", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "spec-2fail-"));
	try {
		const make = (name: string) => {
			const at = join(dir, name);
			mkdirSync(join(at, ".sova/spec/claims"), { recursive: true });
			mkdirSync(join(at, "src"), { recursive: true });
			writeFileSync(join(at, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: {} }));
			writeFileSync(join(at, "src/a.ts"), "1\n");
			for (const args of [["init", "-q", "-b", "master"], ["add", "-A"], ["commit", "-qm", "base"]])
				assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", at, ...args]).status, 0);
			return at;
		};
		const a = make("a");
		const b = make("b");
		const io = { ...localIO, exec: (cmd: string, args: string[], opts: any) => cmd === "node" && args.includes("census") ? Promise.resolve(args.some((x) => x.endsWith("/a")) ? { stdout: "", code: 1 } : { stdout: "not json", code: 0 }) : localIO.exec(cmd, args, opts) };
		const hook = new CensusHook({ io, core: () => CORE });
		const edit = { cwd: a, toolName: "edit", input: { path: join(b, "src/a.ts") } };
		await hook.before(edit);
		writeFileSync(join(a, "src/a.ts"), "2\n");
		writeFileSync(join(b, "src/a.ts"), "2\n");
		const r = await hook.after(edit);
		assert.match(r.failure ?? "", /incomplete: the census produced no output/);
		assert.match(r.failure ?? "", /incomplete: unusable census output/);
		assert.equal((r.failure ?? "").split("\n").length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Quiet notes: only the session's own changes, the census failure's cause, the write guard on file state ──

const G = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
/** A committed project under the scratch root: boundary src, §app/x claims src/a.txt; drafts ignored. */
function quietProject(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const at = mkdtempSync(join(scratchRoot, "spec-quiet-"));
	const put = (rel: string, text: string) => (mkdirSync(dirname(join(at, rel)), { recursive: true }), writeFileSync(join(at, rel), text));
	put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/x": { kind: "behavior", requires: [], code: ["src/a.txt"] } } }, null, 2));
	put(".sova/spec/claims/app/x.md", "# §app/x\n\nX does a thing.\n");
	put("src/a.txt", "a\n");
	put(".gitignore", ".sova/spec/drafts/\n");
	for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "base"]]) assert.equal(spawnSync("git", [...G, "-C", at, ...args]).status, 0);
	return at;
}
/** pi's two hooks around one tool call, as mode/index.ts runs them; a bash call's command really runs in between. */
function quietSession(core = CORE) {
	const census = new CensusHook({ core: () => core });
	const guard = new SpecWriteGuard();
	const commands: string[] = [];
	let n = 0;
	const call = async (cwd: string, toolName: string, input: Record<string, unknown>, effect: () => void) => {
		const id = `q${n++}`;
		const c = { cwd, toolName, input };
		await guard.before(id, c);
		await census.before(c);
		effect();
		if (toolName === "bash") commands.push(input.command as string);
		const g = await guard.after(id, c);
		const r = await census.after({ ...c, orphansSaid: g.lost, commands });
		return [g.text, r.text, r.failure].filter(Boolean).join("\n");
	};
	return {
		prime: (cwd: string) => census.prime(cwd),
		bash: (cwd: string, command: string) => call(cwd, "bash", { command }, () => void spawnSync("bash", ["-c", command], { cwd })),
		edit: (cwd: string, rel: string, text: string) => call(cwd, "edit", { path: rel }, () => (mkdirSync(dirname(join(cwd, rel)), { recursive: true }), writeFileSync(join(cwd, rel), text))),
	};
}
const DRAFT_TOOL = join(CORE, "sova-spec-draft.mjs");
const directWrites = (text: string) => (text.match(/you wrote the current spec directly/g) ?? []).length;

test("a commit another process made between calls is no census note; the session's own edit and own commit still are, naming only its files", async () => {
	const foreign = (at: string) => {
		writeFileSync(join(at, "src/b.txt"), "theirs\n");
		writeFileSync(join(at, "src/a.txt"), "theirs\n");
		for (const args of [["add", "-A"], ["commit", "-qm", "elsewhere"]]) assert.equal(spawnSync("git", [...G, "-C", at, ...args]).status, 0);
	};
	const roots = [quietProject(), quietProject(), quietProject(), quietProject()];
	try {
		const [r1, r2, r3, r4] = roots as [string, string, string, string];
		let s = quietSession();
		await s.prime(r1);
		foreign(r1);
		const quiet = [await s.bash(r1, "ls"), await s.bash(r1, "git log -1 --oneline")].join("\n");
		assert.doesNotMatch(quiet, /\[spec census\]|No draft yet/, `read-only calls after another process's commit: ${quiet}`);

		s = quietSession();
		await s.prime(r2);
		foreign(r2);
		const own = await s.edit(r2, "src/c.txt", "mine\n");
		const neu = own.split("\n").find((l) => l.startsWith("New:")) ?? "";
		assert.match(neu, /src\/c\.txt → unclaimed/, own);
		assert.doesNotMatch(neu, /src\/a\.txt|src\/b\.txt/, `another process's files are not this session's: ${own}`);

		s = quietSession();
		await s.prime(r3);
		const committed = await s.bash(r3, `echo d > src/d.txt && git ${G.join(" ")} add src/d.txt && git ${G.join(" ")} commit -qm d`);
		assert.match(committed, /New: src\/d\.txt → unclaimed/, "a commit the session's own call made still counts");

		s = quietSession();
		await s.prime(r4);
		assert.match(await s.bash(r4, "echo n > src/new.txt"), /src\/new\.txt → unclaimed/, "a planted unclaimed file is still flagged");
	} finally {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	}
});

test("a call that never ran (blocked or aborted: no tool_result) is closed by its id: another process's later commit is no note; an errored call's own write still is", async () => {
	const foreign = (at: string) => {
		writeFileSync(join(at, "src/b.txt"), "theirs\n");
		writeFileSync(join(at, "src/a.txt"), "theirs\n");
		for (const args of [["add", "-A"], ["commit", "-qm", "elsewhere"]]) assert.equal(spawnSync("git", [...G, "-C", at, ...args]).status, 0);
	};
	const roots = [quietProject(), quietProject()];
	try {
		const [r1, r2] = roots as [string, string];
		let hook = new CensusHook({ core: () => CORE });
		await hook.prime(r1);
		await hook.before({ id: "a", cwd: r1, toolName: "bash", input: { command: "true" } });
		hook.close("a");
		foreign(r1);
		const b = { id: "b", cwd: r1, toolName: "bash", input: { command: "git log -1 --oneline" } };
		await hook.before(b);
		const quiet = await hook.after(b);
		assert.doesNotMatch(`${quiet.text ?? ""}`, /\[spec census\]|No draft yet/, `after a closed call and another process's commit: ${quiet.text}`);

		// An errored call (its tool_result comes): its own write is still its own.
		hook = new CensusHook({ core: () => CORE });
		await hook.prime(r2);
		const c = { id: "c", cwd: r2, toolName: "bash", input: { command: "echo own > src/own.txt && false" } };
		await hook.before(c);
		writeFileSync(join(r2, "src/own.txt"), "own\n");
		const own = await hook.after(c);
		hook.close("c");
		assert.match(own.text ?? "", /New: src\/own\.txt → unclaimed/, `${own.text}`);
	} finally {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	}
});

test("a `node` on PATH that exits 1 (an untrusted mise.toml's shim) doesn't stop the census; a census that does crash says why: its first stderr line", async () => {
	const at = quietProject();
	const shim = mkdtempSync(join(scratchRoot, "node-shim-"));
	const broken = mkdtempSync(join(scratchRoot, "broken-core-"));
	const path = process.env.PATH;
	try {
		writeFileSync(join(shim, "node"), "#!/bin/sh\necho 'mise ERROR Config file /x/mise.toml is not trusted. Trust it with `mise trust`.' >&2\nexit 1\n", { mode: 0o755 });
		let s = quietSession();
		await s.prime(at);
		process.env.PATH = `${shim}:${path}`;
		const ran = await s.edit(at, "src/c.txt", "mine\n");
		process.env.PATH = path;
		assert.match(ran, /New: src\/c\.txt → unclaimed/, `the census ran: ${ran}`);
		assert.doesNotMatch(ran, /incomplete/);
		writeFileSync(join(broken, "sova-spec.mjs"), "process.stderr.write('warming up\\nError: cannot read the claim map (EACCES)\\n'); process.exit(1);\n");
		s = quietSession(broken);
		await s.prime(at);
		const text = await s.edit(at, "src/e.txt", "mine\n");
		assert.match(text, /\[spec census\] incomplete: .*cannot read the claim map \(EACCES\)/, text);
	} finally {
		process.env.PATH = path;
		for (const d of [at, shim, broken]) rmSync(d, { recursive: true, force: true });
	}
});

test("the write guard reads file state: a promote through a wrapper script and `git checkout --ours` through a shell function in a merge are not direct writes; sed -i on claims and an Edit still are", async () => {
	const roots = [quietProject(), quietProject(), quietProject()];
	const bin = mkdtempSync(join(scratchRoot, "wrapper-"));
	try {
		const [r1, r2, r3] = roots as [string, string, string];
		const claim = (at: string) => readFileSync(join(at, ".sova/spec/claims/app/x.md"), "utf8");
		// A draft rewriting §app/x, accepted, evidence on HEAD; promoted by ship.sh, whose text names no draft tool.
		let s = quietSession();
		await s.prime(r1);
		const setup = [await s.bash(r1, `node ${DRAFT_TOOL} new d1 --write --root . --json >/dev/null`)];
		setup.push(await s.edit(r1, ".sova/spec/drafts/d1/spec/claims/app/x.md", "# §app/x\n\nX does two things.\n"));
		const m = JSON.parse(readFileSync(join(r1, ".sova/spec/drafts/d1/spec/manifest.json"), "utf8"));
		m.claims["§app/x"].authority = "accepted";
		setup.push(await s.edit(r1, ".sova/spec/drafts/d1/spec/manifest.json", JSON.stringify(m, null, 2)));
		setup.push(await s.bash(r1, `node ${DRAFT_TOOL} evidence d1 --id '§app/x' --by t --verification v --commit HEAD --write --root . --json >/dev/null`));
		assert.equal(directWrites(setup.join("\n")), 0);
		const ship = join(bin, "ship.sh");
		writeFileSync(ship, `#!/bin/sh\nT="${DRAFT_TOOL}"\nP=$(node "$T" promote "$1" --id "$2" --root . --json | grep -o '"plan": *"[0-9a-f]*"' | grep -o '[0-9a-f]\\{64\\}')\nnode "$T" promote "$1" --id "$2" --root . --plan "$P" --write --json >/dev/null\n`, { mode: 0o755 });
		const promoted = await s.bash(r1, `${ship} d1 '§app/x'`);
		assert.match(claim(r1), /two things/, "the wrapper promoted");
		assert.equal(directWrites(promoted), 0, `bytes a promotion wrote: ${promoted}`);
		assert.equal(directWrites(await s.bash(r1, "sed -i 's/two/three/' .sova/spec/claims/app/x.md")), 1, "a hand edit after the promotion is still said");

		// A claims conflict, resolved with --ours through a function whose text names no git subcommand.
		const git = (...args: string[]) => assert.equal(spawnSync("git", [...G, "-C", r2, ...args]).status, 0, args.join(" "));
		git("checkout", "-qb", "feat");
		writeFileSync(join(r2, ".sova/spec/claims/app/x.md"), "# §app/x\n\nX does a feat thing.\n");
		git("commit", "-qam", "feat");
		git("checkout", "-q", "main");
		writeFileSync(join(r2, ".sova/spec/claims/app/x.md"), "# §app/x\n\nX does a main thing.\n");
		git("commit", "-qam", "main");
		git("checkout", "-q", "feat");
		s = quietSession();
		await s.prime(r2);
		const merge = await s.bash(r2, `git ${G.join(" ")} merge main`);
		assert.ok(existsSync(join(r2, ".git/MERGE_HEAD")), "a merge is in progress");
		const ours = await s.bash(r2, `g() { command git "$@"; }; g checkout --ours -- .sova/spec/claims/app/x.md`);
		assert.match(claim(r2), /feat thing/);
		assert.equal(directWrites(`${merge}\n${ours}`), 0, `merge resolution: ${merge} | ${ours}`);

		s = quietSession();
		await s.prime(r3);
		assert.equal(directWrites(await s.bash(r3, "sed -i 's/a thing/a hand thing/' .sova/spec/claims/app/x.md")), 1, "sed -i on claims is a direct write");
		assert.equal(directWrites(await s.edit(r3, ".sova/spec/claims/app/x.md", "# §app/x\n\nEdited.\n")), 1, "an Edit on claims is a direct write");
	} finally {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});
