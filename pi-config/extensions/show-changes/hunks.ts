/**
 * The hunks of a scope's diff, as Sova's changes viewer cuts them (server/git-diff.ts, read, not
 * imported): the same plumbing (`diff-index` against the working tree, `diff-tree -r` between
 * commits, never porcelain `git diff`, whose config could change the context), `-p --histogram -M
 * --full-index` at git's default context, untracked files of a dirty scope as one added hunk each,
 * and a file whose patch is binary or past Sova's 1 MB patch cap as one whole-file unit. Only the
 * `@@` headers and each hunk's first changed line are kept. Read-only, through the extension's
 * git runner (execFile, timeout, output cap). Node builtins only.
 */
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ShowChangesScope } from "./details.ts";
import type { DiffFileHunks, DiffHunk } from "./coverage.ts";
import { changedFiles, type Git } from "./git.ts";
import { ShowChangesError } from "./input.ts";

/** Sova's PATCH_CAP: one file's patch past it isn't drawn, so the file is one unit. */
const PATCH_CAP = 1024 * 1024;
/** Sova's MAX_UNTRACKED_READ and UNTRACKED_BUDGET: an untracked file past either is one unit. */
const UNTRACKED_READ = PATCH_CAP;
const UNTRACKED_BUDGET = 16 * 1024 * 1024;
/** The whole diff's output cap; past it every file counts as one unit. */
const DIFF_CAP = 64 * 1024 * 1024;
/** First changed line, cut to this many characters. */
const FIRST_MAX = 80;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const PATCH = ["-c", "core.quotePath=false", "--literal-pathspecs"];
const OPTS = ["-p", "--histogram", "-M", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv"];

export function firstChangedText(line: string): string {
	const t = line.trimEnd();
	return t.length > FIRST_MAX ? `${t.slice(0, FIRST_MAX - 1)}…` : t;
}

/** Git's C-style quoted path (core.quotePath=false: only control characters, `"` and `\` are escaped). */
function unquote(s: string): string {
	if (!s.startsWith('"') || !s.endsWith('"')) return s;
	const body = s.slice(1, -1);
	const bytes: number[] = [];
	const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	for (let i = 0; i < body.length; i++) {
		const c = body[i]!;
		if (c !== "\\") {
			bytes.push(...Buffer.from(c, "utf8"));
			continue;
		}
		const n = body[i + 1] ?? "";
		if (/[0-7]/.test(n)) {
			bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
			i += 3;
		} else {
			bytes.push(map[n] ?? n.charCodeAt(0));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** `diff --git a/X b/Y` with X = Y (the only case with no ---/+++ or rename lines to name it). */
function headerPath(line: string): string | undefined {
	const rest = line.slice("diff --git ".length);
	if (rest.startsWith('"')) return unquote(/^"(?:[^"\\]|\\.)*" (.*)$/.exec(rest)?.[1] ?? "").replace(/^b\//, "") || undefined;
	const n = (rest.length - 5) / 2;
	if (!Number.isInteger(n) || n < 1) return undefined;
	const a = rest.slice(2, 2 + n);
	return a === rest.slice(n + 5) ? a : undefined;
}

const side = (l: string, prefix: RegExp) => unquote(l.slice(4).replace(/\t$/, "")).replace(prefix, "");

/**
 * Parse `diff -p` output into files and hunks. A file's path is its new path (the old one for a
 * deletion), named from `rename to` / `+++` / `---` lines, else the `diff --git` line. A path seen
 * twice (a type change: delete then add) keeps its first section's hunks, as Sova's parser does.
 */
export function parseHunks(text: string): DiffFileHunks[] {
	const out: DiffFileHunks[] = [];
	const seen = new Map<string, DiffFileHunks>();
	const starts: number[] = [];
	const re = /^diff --git /gm;
	for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index);
	starts.forEach((at, i) => {
		const body = text.slice(at, starts[i + 1] ?? text.length);
		const lines = body.split("\n");
		let oldPath: string | undefined;
		let newPath: string | undefined;
		let binary = false;
		let deleted = false;
		const hunks: DiffHunk[] = [];
		let cur: DiffHunk | undefined;
		for (const l of lines.slice(1)) {
			const m = HUNK.exec(l);
			if (m) {
				cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), firstChanged: "" };
				hunks.push(cur);
				continue;
			}
			if (cur) {
				if (!cur.firstChanged && (l.startsWith("+") || l.startsWith("-"))) cur.firstChanged = firstChangedText(l);
				continue;
			}
			if (l.startsWith("rename from ")) oldPath = unquote(l.slice(12));
			else if (l.startsWith("rename to ")) newPath = unquote(l.slice(10));
			else if (l.startsWith("--- ")) oldPath ??= l === "--- /dev/null" ? undefined : side(l, /^a\//);
			else if (l.startsWith("+++ ")) newPath ??= l === "+++ /dev/null" ? undefined : side(l, /^b\//);
			else if (l.startsWith("deleted file mode")) deleted = true;
			else if (l.startsWith("Binary files ") || l === "GIT binary patch") binary = true;
		}
		const path = (deleted ? oldPath : newPath) ?? newPath ?? oldPath ?? headerPath(lines[0]!);
		if (!path) return;
		const prior = seen.get(path);
		if (prior) {
			if (binary) prior.hunks = null;
			return;
		}
		const file: DiffFileHunks = { path, hunks: binary || body.length > PATCH_CAP ? null : hunks };
		if (oldPath && oldPath !== path && !deleted) file.oldPath = oldPath;
		seen.set(path, file);
		out.push(file);
	});
	return out;
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/** An untracked file as Sova's viewer draws it: one added hunk, none when empty, one unit when binary or too big. */
async function untrackedFile(top: string, path: string, budget: { bytes: number }): Promise<DiffFileHunks> {
	const abs = join(top, path);
	let st;
	try {
		st = await lstat(abs);
	} catch {
		return { path, hunks: [] };
	}
	const added = (text: string): DiffFileHunks => {
		const lines = text === "" ? [] : text.split("\n");
		if (lines.length && lines.at(-1) === "") lines.pop();
		return { path, hunks: lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, firstChanged: firstChangedText(`+${lines[0]}`) }] : [] };
	};
	if (st.isSymbolicLink()) return added(await readlink(abs).catch(() => ""));
	if (!st.isFile()) return { path, hunks: [] };
	const limit = Math.max(0, Math.min(UNTRACKED_READ, budget.bytes));
	const want = Math.min(st.size, limit);
	const buf = Buffer.alloc(want);
	let got = 0;
	if (want > 0) {
		const fh = await open(abs, "r").catch(() => undefined);
		try {
			while (fh && got < want) {
				const { bytesRead } = await fh.read(buf, got, want - got, got);
				if (bytesRead === 0) break;
				got += bytesRead;
			}
		} finally {
			await fh?.close().catch(() => {});
		}
	}
	budget.bytes -= got;
	const read = buf.subarray(0, got);
	if (looksBinary(read) || st.size > got) return { path, hunks: null };
	return added(read.toString("utf8"));
}

/** Every file of the scope's diff with its hunks, sorted by path. */
export async function readHunks(git: Git, scope: ShowChangesScope): Promise<DiffFileHunks[]> {
	const args =
		scope.kind === "dirty"
			? ["diff-index", ...OPTS, scope.head, "--"]
			: scope.kind === "worktree"
				? ["diff-tree", "-r", ...OPTS, scope.base, scope.head, "--"]
				: scope.parent
					? ["diff-tree", "-r", ...OPTS, scope.parent, scope.sha, "--"]
					: ["diff-tree", "--root", "-r", ...OPTS, scope.sha, "--"];
	const r = await git([...PATCH, ...args], scope.root, { maxBuffer: DIFF_CAP });
	if (r.cut) {
		// Too big to read here: every file is one unit, named by path.
		return (await changedFiles(git, scope)).map((path) => ({ path, hunks: null }));
	}
	if (r.code !== 0) throw new ShowChangesError(`git ${args[0]} -p failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
	const files = parseHunks(r.stdout);
	if (scope.kind === "dirty") {
		const u = await git(["ls-files", "--others", "--exclude-standard", "-z"], scope.root);
		if (u.code !== 0) throw new ShowChangesError(`git ls-files failed: ${(u.stderr || u.stdout).trim().split("\n")[0]}`);
		const listed = new Set(files.map((f) => f.path));
		const budget = { bytes: UNTRACKED_BUDGET };
		for (const path of u.stdout.split("\0").filter(Boolean)) if (!listed.has(path)) files.push(await untrackedFile(scope.root, path, budget));
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
