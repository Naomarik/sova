import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	ALSO_CHANGES_OVERRIDE,
	CensusHook,
	censusStep,
	freshCensusState,
	manifestConflict,
	unmergedPaths,
	checkAlsoChanges,
	commandRoot,
	coreDir,
	DIGEST_TAG,
	digest,
	draftForeign,
	draftStamps,
	draftsTouched,
	draftsCreated,
	foreignBetween,
	gitCommits,
	gitMerges,
	lastLine,
	localIO,
	NO_DRAFT_NOTE,
	parseAlsoChanges,
	parsePorcelain,
	promoteWrites,
	ranCensus,
	repromptText,
	reportedAlsoChanges,
	treeStart,
	treeTurn,
	stripAlsoChanges,
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

test("command detection: promote --write, git commit / merge, --root, draft names, a census already run", () => {
	assert.ok(promoteWrites('node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --plan abc --write --root . --json'));
	assert.ok(!promoteWrites('node "$core/sova-spec-draft.mjs" promote feat --id \'§a/b\' --json'), "a preview writes nothing");
	assert.ok(gitCommits("git add x && git commit -qm y"));
	assert.ok(gitCommits("git -C /r commit -m y"));
	assert.ok(!gitCommits("git log --oneline"));
	assert.ok(gitMerges("git merge --no-ff feat/x"));
	assert.ok(!gitMerges("git merge-base --is-ancestor a b"));
	assert.equal(commandRoot("node x promote f --root /w/t --write"), "/w/t");
	assert.equal(commandRoot("node x promote f --root '/w/a b' --write"), "/w/a b");
	assert.equal(commandRoot("node x promote f --write"), undefined);
	assert.deepEqual(draftsCreated(['node "$core/sova-spec-draft.mjs" new feat-a --write --root .', 'node "$core/sova-spec-draft.mjs" new dry --root .']), ["feat-a"]);
	assert.ok(ranCensus("bash", { command: 'node "$core/sova-spec.mjs" census --changed --json' }));
	assert.ok(!ranCensus("edit", { path: "a" }));
});

test("parseAlsoChanges: none, ids, markdown emphasis; anything else is not the line", () => {
	assert.deepEqual(parseAlsoChanges("Also changes: none"), []);
	assert.deepEqual(parseAlsoChanges("Also changes: §chat.alignment/card — lettered options; §design.copy-deck/sidebar — count only"), [
		"§chat.alignment/card",
		"§design.copy-deck/sidebar",
	]);
	assert.deepEqual(parseAlsoChanges("**Also changes: none**"), []);
	assert.equal(parseAlsoChanges("Also changes: the card"), undefined);
	assert.equal(parseAlsoChanges("Also changed: none"), undefined);
	assert.equal(lastLine("a\nAlso changes: none\n\n  "), "Also changes: none");
});

test("checkAlsoChanges: not required passes; required needs the last line naming every computed §", () => {
	const foreign = ["§a/one", "§b/two"];
	assert.ok(checkAlsoChanges("just an answer", { required: false, foreign }).ok);
	assert.equal(checkAlsoChanges("done", { required: true, foreign: [] }).problem, "missing");
	assert.equal(checkAlsoChanges("Also changes: none\nreport at /x.md", { required: true, foreign: [] }).problem, "not-last");
	assert.equal(checkAlsoChanges("done\nAlso changes: nothing much", { required: true, foreign: [] }).problem, "malformed");
	assert.ok(checkAlsoChanges("done\nAlso changes: none", { required: true, foreign: [] }).ok);
	const omits = checkAlsoChanges("done\nAlso changes: §a/one — x", { required: true, foreign });
	assert.equal(omits.problem, "omits");
	assert.deepEqual(omits.missing, ["§b/two"]);
	assert.equal(checkAlsoChanges("done\nAlso changes: none", { required: true, foreign }).problem, "none-but-changed");
	assert.ok(checkAlsoChanges("done\nAlso changes: §a/one — x; §b/two — y; §c/own — z", { required: true, foreign }).ok, "naming more is fine");
	const over = checkAlsoChanges(`done\n${ALSO_CHANGES_OVERRIDE} §b/two was created by this task's earlier merge\nAlso changes: §a/one — x`, { required: true, foreign });
	assert.ok(over.ok && over.overridden);
	assert.ok(!checkAlsoChanges(`done\n${ALSO_CHANGES_OVERRIDE} no\n`, { required: true, foreign }).ok, "an override never replaces the line itself");
	const text = repromptText(omits, foreign, "merged a worktree");
	assert.ok(text.includes("Also changes: §a/one — <what changed>; §b/two — <what changed>"));
	assert.ok(text.includes(ALSO_CHANGES_OVERRIDE));
});

test("stripAlsoChanges drops the closing line (and an override above it), nothing else", () => {
	assert.equal(stripAlsoChanges("Done.\n\nAlso changes: none\n"), "Done.");
	assert.equal(stripAlsoChanges(`Done.\n${ALSO_CHANGES_OVERRIDE} created here\nAlso changes: §a/b — x`), "Done.");
	assert.equal(stripAlsoChanges("Also changes: none, it said\nDone."), "Also changes: none, it said\nDone.");
	assert.equal(stripAlsoChanges("Done."), "Done.");
});

const censusView = (over: Partial<CensusView> = {}): CensusView => ({
	foreignNote: "flag only a contradiction",
	foreign: [],
	claimed: [],
	unclaimed: [],
	mappedOutside: [],
	childUnderForeign: [],
	...over,
});

test("digest: the first in-boundary change, each new file, new foreign §; says when there is no draft", () => {
	const v = censusView({ foreign: ["§app/shell"], claimed: [{ path: "src/App.tsx", claims: ["§app/shell"] }], unclaimed: ["src/new.ts"] });
	const first = digest(v, ["src/App.tsx"], { reported: false, foreign: [] }, false);
	assert.ok(first?.startsWith(`${DIGEST_TAG} 2 changed file(s) in the boundary, 1 unclaimed; 1 foreign § touched.`));
	assert.ok(first?.includes(NO_DRAFT_NOTE));
	assert.ok(first?.includes("New: src/App.tsx → §app/shell"));
	assert.ok(first?.includes("Foreign §: §app/shell"));
	assert.equal(digest(v, ["docs/notes.md"], { reported: true, foreign: ["§app/shell"] }, true), undefined, "nothing new in the boundary: silent");
	const again = digest(v, ["src/new.ts"], { reported: true, foreign: ["§app/shell"] }, true);
	assert.ok(again?.includes("New: src/new.ts → unclaimed"));
	assert.ok(!again?.includes(NO_DRAFT_NOTE) && !again?.includes("Foreign §:"));
	const outside = digest(censusView({ mappedOutside: [{ path: "pi-config/x.ts", claims: ["§app/worker"] }] }), ["pi-config/x.ts"], { reported: false, foreign: [] }, true);
	assert.ok(outside?.includes("pi-config/x.ts → outside the boundary, mapped by §app/worker"));
	assert.equal(digest(censusView(), ["README.md"], { reported: false, foreign: [] }, false), undefined, "no in-boundary change: silent");
});

test("foreignBetween wraps `sova-spec.mjs foreign`; unusable output is undefined", async () => {
	const calls: string[][] = [];
	const io = (stdout: string): SpecIO => ({
		...localIO,
		exists: () => true,
		exec: async (_cmd, args) => {
			calls.push(args);
			return { stdout, code: 0 };
		},
	});
	assert.deepEqual(await foreignBetween("/r", "abc", undefined, "/core", io(JSON.stringify({ exit: 0, foreign: ["§a/b"] }))), ["§a/b"]);
	assert.deepEqual(calls[0], ["/core/sova-spec.mjs", "foreign", "--base", "abc", "--root", "/r", "--json"]);
	await foreignBetween("/r", "abc", "def", "/core", io("{}"));
	assert.deepEqual(calls[1].slice(3, 6), ["abc", "--head", "def"]);
	assert.equal(await foreignBetween("/r", "abc", undefined, "/core", io(JSON.stringify({ exit: 2, foreign: [] }))), undefined);
	assert.equal(await foreignBetween("/r", "abc", undefined, "/core", io("not json")), undefined);
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
		assert.deepEqual(await after(), {}, "a change outside the boundary is silent");
		put("src/App.tsx", "2\n");
		const first = await after("read");
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
		// A draft (ignored by Git): its edits show only in the stamps; draftForeign names the foreign § it edits.
		const draft = spawnSync(process.execPath, [join(CORE, "sova-spec-draft.mjs"), "new", "feat", "--root", project, "--write", "--json"], { encoding: "utf8" });
		assert.equal(draft.status, 0, draft.stdout + draft.stderr);
		const before = await draftStamps(project);
		assert.deepEqual(Object.keys(before), ["feat"]);
		assert.deepEqual(await draftForeign(project, "feat", CORE), [], "a fresh copy changes nothing");
		await new Promise((r) => setTimeout(r, 20));
		put(".sova/spec/drafts/feat/spec/claims/app/shell.md", "# §app/shell\n\nShell, now blue.\n");
		assert.deepEqual(draftsTouched(before, await draftStamps(project)), ["feat"]);
		assert.deepEqual(draftsTouched(before, before), []);
		assert.deepEqual(await draftForeign(project, "feat", CORE), ["§app/shell"]);
		assert.equal(await draftForeign(project, "missing", CORE), undefined);
		const meta = join(project, ".sova/spec/drafts/feat/draft.json");
		const record = JSON.parse(readFileSync(meta, "utf8"));
		delete record.base.commit;
		writeFileSync(meta, JSON.stringify(record));
		assert.equal(await draftForeign(project, "feat", CORE), undefined, "an older draft without base.commit and no fallback: unknown");
		const head = spawnSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		assert.deepEqual(await draftForeign(project, "feat", CORE, localIO, undefined, head), ["§app/shell"], "the run's starting HEAD stands in");
		const committed = await after();
		assert.ok(committed.text?.includes("src/later.ts"), `a file created and committed in one call still counts: ${JSON.stringify(committed)}`);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("reportedAlsoChanges: a worker's line in a custom message or a worker tool's result; never other tools or our own re-prompt", () => {
	assert.equal(reportedAlsoChanges([]), undefined);
	const complete = { type: "custom_message", customType: "subagent-complete", content: "Worker done.\nAlso changes: §chat.sandbox/toggle — new wording" };
	assert.deepEqual(reportedAlsoChanges([complete]), ["§chat.sandbox/toggle"]);
	assert.equal(reportedAlsoChanges([{ type: "custom_message", customType: "team-report", content: [{ type: "text", text: "ok\nAlso changes: none" }] }]), undefined, "a planning worker's none is no change turn");
	const spawn = { type: "message", message: { role: "toolResult", toolName: "agent_spawn", content: [{ type: "text", text: "report\nAlso changes: §a/b — x" }] } };
	assert.deepEqual(reportedAlsoChanges([spawn, complete]), ["§a/b", "§chat.sandbox/toggle"]);
	const bash = { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Also changes: §x/y — grep hit" }] } };
	assert.equal(reportedAlsoChanges([bash]), undefined);
	assert.equal(reportedAlsoChanges([{ type: "custom_message", customType: "spec-check", content: "x\nAlso changes: §x/y — z" }]), undefined);
	assert.equal(reportedAlsoChanges([{ type: "message", message: { role: "user", content: "Also changes: §x/y — z" } }]), undefined);
});

test("treeTurn: a worker's commit of a promotion in a tracked tree is a change that lands the current spec, with its foreign §", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const tree = mkdtempSync(join(scratchRoot, "spec-tree-"));
	try {
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(tree, rel)), { recursive: true });
			writeFileSync(join(tree, rel), text);
		};
		const git = (...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", tree, ...args]).status, 0);
		put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } } }));
		put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell.\n");
		put(".sova/spec/.gitignore", "/drafts/\n");
		put("src/App.tsx", "1\n");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "base");
		const quiet = await treeStart(join(tree, "src"));
		assert.ok(quiet?.root === tree, "found from a subdirectory");
		assert.deepEqual(await treeTurn(quiet!, CORE), { changed: false, specChanged: false, foreign: [] });

		const start = await treeStart(tree);
		put("src/App.tsx", "2\n");
		git("commit", "-qam", "code");
		const code = await treeTurn(start!, CORE);
		assert.ok(code.changed && !code.specChanged, "a code commit alone lands no spec");

		put(".sova/spec/claims/app/shell.md", "# §app/shell\n\nShell, v2.\n");
		git("commit", "-qam", "spec");
		const landed = await treeTurn(start!, CORE);
		assert.deepEqual(landed, { changed: true, specChanged: true, foreign: ["§app/shell"] });

		const before = await treeStart(tree);
		const draft = spawnSync(process.execPath, [join(CORE, "sova-spec-draft.mjs"), "new", "feat", "--root", tree, "--write", "--json"], { encoding: "utf8" });
		assert.equal(draft.status, 0);
		await new Promise((r) => setTimeout(r, 20));
		put(".sova/spec/drafts/feat/spec/claims/app/shell.md", "# §app/shell\n\nShell, v3.\n");
		const drafted = await treeTurn(before!, CORE);
		assert.deepEqual(drafted, { changed: true, specChanged: false, foreign: ["§app/shell"] }, "a draft edit (ignored by Git) still counts");
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a manifest.json in a Git conflict: the census says to run merge-manifest, once per conflict; treeTurn carries it", async () => {
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
		const tree = await treeStart(repo);
		let state = (await censusStep(freshCensusState(), { cwd: repo, toolName: "", input: undefined }, CORE)).state;
		assert.notEqual(git("merge", "side").status, 0, "the merge conflicts");
		const first = await censusStep(state, { cwd: repo, toolName: "bash", input: { command: "git merge side" } }, CORE);
		assert.match(first.result.text ?? "", /\.sova\/spec\/manifest\.json is in conflict: run `node ".*sova-spec-draft\.mjs" merge-manifest --root .* --write --json` first/);
		assert.match(first.result.text ?? "", /If it refuses \(manifest-conflict\): take master's manifest and matching claims \(git checkout master -- …\), re-apply the branch's spec changes in a new draft, and promote\. Never take a side before merge-manifest has run\./);
		state = first.state;
		assert.equal((await censusStep(state, { cwd: repo, toolName: "read", input: {} }, CORE)).result.text, undefined, "said once per conflict");
		const turn = await treeTurn(tree!, CORE);
		assert.match(turn.conflict ?? "", /merge-manifest/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("B3's shape: merging master into the branch lands nothing; the landing merge's list is only the branch's §", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "spec-b3-"));
	const main = join(dir, "main");
	const wt = join(dir, "wt");
	try {
		const put = (at: string, rel: string, text: string) => {
			mkdirSync(dirname(join(at, rel)), { recursive: true });
			writeFileSync(join(at, rel), text);
		};
		const git = (at: string, ...args: string[]) => {
			const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", at, ...args], { encoding: "utf8" });
			assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		};
		const claims = { "§app/a": { kind: "surface", code: ["src/a.ts"] }, "§app/b": { kind: "surface", code: ["src/b.ts"] } };
		put(main, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims }));
		put(main, ".sova/spec/claims/app/a.md", "# §app/a\n\nA.\n");
		put(main, ".sova/spec/claims/app/b.md", "# §app/b\n\nB.\n");
		put(main, ".sova/spec/.gitignore", "/drafts/\n");
		put(main, "src/a.ts", "a\n");
		put(main, "src/b.ts", "b\n");
		git(main, "init", "-q", "-b", "master");
		git(main, "add", "-A");
		git(main, "commit", "-qm", "base");
		git(main, "worktree", "add", "-q", "-b", "feat/x", wt);
		// The branch changes §app/a; another task changes §app/b on master meanwhile.
		put(wt, ".sova/spec/claims/app/a.md", "# §app/a\n\nA, by the branch.\n");
		git(wt, "commit", "-qam", "branch spec");
		put(main, ".sova/spec/claims/app/b.md", "# §app/b\n\nB, by the other task.\n");
		git(main, "commit", "-qam", "other task spec");

		// A turn that only merges master into the branch: nothing lands, nothing is foreign.
		const branchStart = await treeStart(wt);
		git(wt, "merge", "--no-edit", "-q", "master");
		const absorbed = await treeTurn(branchStart!, CORE);
		assert.equal(absorbed.changed, true);
		assert.equal(absorbed.specChanged, false, "an absorbed merge is no promotion of this branch's");
		assert.deepEqual(absorbed.foreign, []);

		// Later in the same run the branch changes its own § again: only that one is listed.
		put(wt, ".sova/spec/claims/app/a.md", "# §app/a\n\nA, by the branch, again.\n");
		git(wt, "commit", "-qam", "branch spec 2");
		const mixed = await treeTurn(branchStart!, CORE);
		assert.equal(mixed.specChanged, true);
		assert.deepEqual(mixed.foreign, ["§app/a"], "master's §app/b, absorbed, is not the branch's");

		// The landing merge into master (fast-forward): the target's own diff, §app/a only.
		const mainStart = await treeStart(main);
		git(main, "merge", "--ff-only", "-q", "feat/x");
		const landed = await treeTurn(mainStart!, CORE);
		assert.equal(landed.specChanged, true);
		assert.deepEqual(landed.foreign, ["§app/a"]);
	} finally {
		spawnSync("git", ["-C", main, "worktree", "remove", "--force", wt]);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a merge commit into master (no fast-forward) lands the branch's §: the target keeps its whole diff", async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const repo = mkdtempSync(join(scratchRoot, "spec-noff-"));
	try {
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(repo, rel)), { recursive: true });
			writeFileSync(join(repo, rel), text);
		};
		const git = (...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args]).status, 0, args.join(" "));
		put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, claims: { "§app/a": { kind: "surface", code: ["src/a.ts"] } } }));
		put(".sova/spec/claims/app/a.md", "# §app/a\n\nA.\n");
		put("src/a.ts", "a\n");
		git("init", "-q", "-b", "master");
		git("add", "-A");
		git("commit", "-qm", "base");
		git("checkout", "-qb", "feat/y");
		put(".sova/spec/claims/app/a.md", "# §app/a\n\nA, y.\n");
		git("commit", "-qam", "y");
		git("checkout", "-q", "master");
		const start = await treeStart(repo);
		git("merge", "--no-ff", "--no-edit", "-q", "feat/y");
		assert.deepEqual((await treeTurn(start!, CORE)).foreign, ["§app/a"]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
