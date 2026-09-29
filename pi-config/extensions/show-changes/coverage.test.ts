import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coverageRefusal, type DiffFileHunks, type DiffHunk, placeSteps, REFUSAL_MAX } from "./coverage.ts";
import { runGit } from "./git.ts";
import { parseHunks, readHunks } from "./hunks.ts";

const h = (newStart: number, newLines: number, first = "+x", oldStart = newStart, oldLines = newLines): DiffHunk => ({ oldStart, oldLines, newStart, newLines, firstChanged: first });

const files: DiffFileHunks[] = [
	{ path: "a.ts", hunks: [h(1, 5, "+import x"), h(40, 7, "-old()")] },
	{ path: "new.ts", oldPath: "old.ts", hunks: [h(10, 3, "+renamed", 12)] },
	{ path: "logo.png", hunks: null },
	{ path: "moved.ts", oldPath: "was.ts", hunks: [] },
];

test("placeSteps: path alone takes a file, a start inside a range names one hunk, first step wins", () => {
	const p = placeSteps(
		[
			{ hunks: [{ path: "a.ts", newStart: 44 }, { path: "logo.png", newStart: 3 }] },
			{ hunks: [{ path: "a.ts" }, { path: "old.ts", oldStart: 14 }] },
		],
		files,
	);
	assert.equal(p.units, 4);
	assert.deepEqual(p.owner, [[1, 0], [1], [0], []]);
	assert.deepEqual(p.unplaced, []);
	assert.deepEqual(p.badRefs, []);
	const miss = placeSteps([{ hunks: [{ path: "a.ts", newStart: 47 }, { path: "gone.ts" }, { path: "moved.ts" }] }], files);
	assert.deepEqual(
		miss.badRefs.map((b) => b.ref.path),
		["a.ts", "gone.ts", "moved.ts"],
	);
	assert.equal(miss.unplaced.length, 4);
});

test("no refusal for one unit or none without steps, or full coverage", () => {
	assert.equal(coverageRefusal(undefined, []), undefined);
	assert.equal(coverageRefusal(undefined, [{ path: "a.ts", hunks: [h(3, 4)] }, { path: "b.ts", hunks: [] }]), undefined);
	assert.equal(coverageRefusal(undefined, [{ path: "logo.png", hunks: null }]), undefined);
	assert.equal(coverageRefusal([{ hunks: [{ path: "a.ts" }, { path: "new.ts" }, { path: "logo.png" }] }], files), undefined);
	// Steps over an empty diff: nothing to place, nothing refused.
	assert.equal(coverageRefusal([{ hunks: [{ path: "a.ts" }] }], []), undefined);
});

test("refusal a: several hunks and no steps lists them all by file", () => {
	const msg = coverageRefusal(undefined, files)!;
	assert.equal(
		msg,
		[
			"Nothing was shown: this diff has 4 hunks in 3 files and the call sent no steps.",
			"Resend show_changes with steps that place every hunk below. If the change is one idea, send one step naming every file by path alone ({path} with no start takes all of a file's hunks).",
			"Hunks (path, then @@ +newStart,newLines: first changed line):",
			"a.ts",
			"  @@ +1,5: +import x",
			"  @@ +40,7: -old()",
			"new.ts",
			"  @@ +10,3: +renamed",
			"logo.png",
			"  (binary or too large: one unit, name it by path)",
		].join("\n"),
	);
});

test("refusal b: unplaced hunks and refs naming nothing, each with what fixes it", () => {
	const msg = coverageRefusal([{ hunks: [{ path: "a.ts", newStart: 3 }, { path: "a.ts", newStart: 90 }, { path: "gone.ts" }] }, { hunks: [{ path: "logo.png" }] }], files)!;
	assert.equal(
		msg,
		[
			"Nothing was shown: the steps leave 2 of 4 hunks placed by no step and 2 refs naming no hunk. Every hunk must be in exactly one step (the first naming it).",
			"Resend show_changes with the same steps, fixed: add a ref for each hunk below to the step it belongs to (or a new step); {path} alone takes all of a file's hunks. newStart is any new-side line inside the hunk.",
			"Placed by no step (path, then @@ +newStart,newLines: first changed line):",
			"a.ts",
			"  @@ +40,7: -old()",
			"new.ts",
			"  @@ +10,3: +renamed",
			"Refs naming no hunk (fix or remove them):",
			'  step 1: {path: "a.ts", newStart: 90}: new-side line inside none of its hunks (+1,5 +40,7)',
			'  step 1: {path: "gone.ts"}: that file is not in this diff',
		].join("\n"),
	);
});

test("past 150 hunks the refusal lists files with counts, and stays under the cap", () => {
	const many: DiffFileHunks[] = Array.from({ length: 900 }, (_, i) => ({ path: `src/module-${i}/file-with-a-long-name-${i}.ts`, hunks: [h(1, 3, `+${"y".repeat(79)}`), h(50, 3)] }));
	const msg = coverageRefusal(undefined, many)!;
	assert.ok(msg.length <= REFUSAL_MAX, `${msg.length}`);
	assert.match(msg, /this diff has 1800 hunks in 900 files/);
	assert.match(msg, /Too many to list one by one; by file \(naming a file by path alone places all its hunks\):\nsrc\/module-0\/file-with-a-long-name-0\.ts \(2 hunks\)\n/);
	assert.match(msg, /… and \d+ more files$/);
	const b = coverageRefusal([{ hunks: [{ path: many[0]!.path }] }], many)!;
	assert.ok(b.length <= REFUSAL_MAX);
	assert.match(b, /1798 of 1800 hunks placed by no step/);
});

test("parseHunks: headers, first changed line cut to 80, quoted paths, binary", () => {
	const text = [
		"diff --git a/a.ts b/a.ts",
		"index 1111111..2222222 100644",
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -3 +3,2 @@ fn",
		" ctx",
		`+${"z".repeat(120)}`,
		"diff --git \"a/sp\\tace.ts\" \"b/sp\\tace.ts\"",
		"new file mode 100644",
		"--- /dev/null",
		"+++ \"b/sp\\tace.ts\"",
		"@@ -0,0 +1 @@",
		"+x",
		"diff --git a/img.png b/img.png",
		"index 1111111..2222222 100644",
		"Binary files a/img.png and b/img.png differ",
		"",
	].join("\n");
	const out = parseHunks(text);
	assert.deepEqual(out.map((f) => f.path), ["a.ts", "sp\tace.ts", "img.png"]);
	assert.deepEqual(out[0]!.hunks, [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, firstChanged: `+${"z".repeat(78)}…` }]);
	assert.equal(out[2]!.hunks, null);
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("readHunks against a repository: rename, deletion, binary, untracked in a dirty scope", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "show-changes-hunks-")));
	try {
		sh(root, "init", "-q", "-b", "master");
		sh(root, "config", "user.email", "t@example.invalid");
		sh(root, "config", "user.name", "t");
		sh(root, "config", "commit.gpgsign", "false");
		const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		writeFileSync(join(root, "keep.txt"), `${body.join("\n")}\n`);
		writeFileSync(join(root, "old-name.txt"), `${body.join("\n")}\n`);
		writeFileSync(join(root, "gone.txt"), "a\nb\n");
		writeFileSync(join(root, "img.bin"), Buffer.from([0, 1, 2, 3]));
		sh(root, "add", ".");
		sh(root, "commit", "-q", "-m", "one");
		const parent = sh(root, "rev-parse", "HEAD");
		const edited = [...body];
		edited[1] = "line two";
		edited[35] = "line thirty-six";
		writeFileSync(join(root, "keep.txt"), `${edited.join("\n")}\n`);
		sh(root, "mv", "old-name.txt", "new-name.txt");
		writeFileSync(join(root, "new-name.txt"), `${body.join("\n")}\nline 41\n`);
		sh(root, "rm", "-q", "gone.txt");
		writeFileSync(join(root, "img.bin"), Buffer.from([0, 9, 9, 9]));
		sh(root, "add", "-A");
		sh(root, "commit", "-q", "-m", "two");
		const sha = sh(root, "rev-parse", "HEAD");
		const c = await readHunks(runGit, { kind: "commit", repoPath: root, root, sha, parent });
		assert.deepEqual(c, [
			{ path: "gone.txt", hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, firstChanged: "-a" }] },
			{ path: "img.bin", hunks: null },
			{
				path: "keep.txt",
				hunks: [
					{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, firstChanged: "-line 2" },
					{ oldStart: 33, oldLines: 7, newStart: 33, newLines: 7, firstChanged: "-line 36" },
				],
			},
			{ path: "new-name.txt", oldPath: "old-name.txt", hunks: [{ oldStart: 38, oldLines: 3, newStart: 38, newLines: 4, firstChanged: "+line 41" }] },
		]);
		// The root commit is diffed against the empty tree.
		const first = await readHunks(runGit, { kind: "commit", repoPath: root, root, sha: parent });
		assert.deepEqual(first.map((f) => [f.path, f.hunks === null ? null : f.hunks.length]), [["gone.txt", 1], ["img.bin", null], ["keep.txt", 1], ["old-name.txt", 1]]);

		writeFileSync(join(root, "keep.txt"), `${body.join("\n")}\n`);
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "fresh.ts"), "export const a = 1;\nexport const b = 2;\n");
		writeFileSync(join(root, "sub", "empty.ts"), "");
		writeFileSync(join(root, "sub", "blob.bin"), Buffer.from([1, 0, 1]));
		const d = await readHunks(runGit, { kind: "dirty", cwd: root, root, head: sha });
		assert.deepEqual(d, [
			{ path: "keep.txt", hunks: [h(1, 5, "-line two", 1, 5), h(33, 7, "-line thirty-six", 33, 7)] },
			{ path: "sub/blob.bin", hunks: null },
			{ path: "sub/empty.ts", hunks: [] },
			{ path: "sub/fresh.ts", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, firstChanged: "+export const a = 1;" }] },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
