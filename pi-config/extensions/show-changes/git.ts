/**
 * The git `show_changes` runs: resolving a scope to shas, and listing the changed files so the
 * reply can name them and point out step refs to files outside the diff. Read-only plumbing,
 * always an argument list through execFile (never a shell), with a timeout and an output cap.
 * Node builtins only, so the tests drive it against throwaway repositories without pi.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { mergedReviewBase } from "../worktrees/git.ts";
import { isSha, type ShowChangesScope } from "./details.ts";
import { ShowChangesError, type ShowChangesRequest } from "./input.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout passed `maxBuffer` and git was stopped; `stdout` is then cut short. */
	cut?: boolean;
}

export type Git = (args: string[], cwd: string, opts?: { maxBuffer?: number }) => Promise<GitResult>;

/** Global options on every call: no fsmonitor hook, no index refresh writes. */
const SAFE = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

/** Run git with `args` in `cwd`. Never throws: a missing git, a timeout or a signal is a nonzero code. */
export const runGit: Git = (args, cwd, opts) =>
	new Promise((done) => {
		execFile(
			"git",
			[...SAFE, ...args],
			{ cwd, maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
				const cut = (err as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
				done({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 && !stderr ? err.message : ""), ...(cut ? { cut } : {}) });
			},
		);
	});

async function must(git: Git, args: string[], cwd: string, what: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new ShowChangesError(`${what}: ${(r.stderr || r.stdout).trim().split("\n")[0] || `git exit ${r.code}`}`);
	return r.stdout.trim();
}

async function maybe(git: Git, args: string[], cwd: string): Promise<string | undefined> {
	const r = await git(args, cwd);
	return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** A worktree the session tracks (the `worktrees` entry's active trees; only what is used here). */
export interface KnownTree {
	path: string;
	branch: string;
	base: string;
	baseBranch?: string;
}

function real(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

const within = (child: string, root: string) => child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The directory to read and the tracked tree it is, if any. `worktree` names a tracked tree by
 * branch or path, or any directory; without it, the tracked tree holding the cwd, else for scope
 * worktree the only active tracked tree, else the cwd.
 */
export function pickDir(req: Pick<ShowChangesRequest, "scope" | "worktree">, cwd: string, trees: readonly KnownTree[]): { dir: string; tree?: KnownTree } {
	const canon = trees.map((t) => ({ t, real: real(t.path) }));
	const holding = (dir: string) => canon.filter((c) => within(dir, c.real)).sort((a, b) => b.real.length - a.real.length)[0]?.t;
	if (req.worktree !== undefined) {
		const byBranch = trees.filter((t) => t.branch === req.worktree).at(-1);
		if (byBranch) return { dir: byBranch.path, tree: byBranch };
		const home = process.env.HOME ?? "";
		const w = req.worktree;
		const dir = real(w === "~" ? home : w.startsWith("~/") ? `${home}/${w.slice(2)}` : resolve(cwd, w));
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			const known = trees.map((t) => `${t.branch} (${t.path})`).join(", ");
			throw new ShowChangesError(`worktree ${JSON.stringify(w)} is neither a tracked worktree's branch nor a directory${known ? `; tracked: ${known}` : ""}`);
		}
		const tree = holding(dir);
		return tree ? { dir, tree } : { dir };
	}
	const here = holding(real(cwd));
	if (here) return { dir: cwd, tree: here };
	if (req.scope === "worktree" && trees.length === 1) return { dir: trees[0]!.path, tree: trees[0]! };
	return { dir: cwd };
}

/** Resolve the request's scope against `dir`: the repository's top level and full shas. */
export async function resolveScope(git: Git, req: ShowChangesRequest, dir: string, tree?: KnownTree): Promise<ShowChangesScope> {
	const top = await must(git, ["rev-parse", "--show-toplevel"], dir, `${dir} is not in a git repository`);
	const root = real(top);
	const at = real(dir);
	const headSha = () => must(git, ["rev-parse", "--verify", "HEAD^{commit}"], root, "HEAD has no commit yet");
	switch (req.scope) {
		case "dirty":
			return { kind: "dirty", cwd: at, root, head: await headSha() };
		case "commit": {
			const sha = await must(git, ["rev-parse", "--verify", "--end-of-options", `${req.commit}^{commit}`], root, `No commit ${JSON.stringify(req.commit)} in ${root}`);
			const parent = await maybe(git, ["rev-parse", "--verify", "--quiet", `${sha}^1^{commit}`], root);
			return parent ? { kind: "commit", repoPath: at, root, sha, parent } : { kind: "commit", repoPath: at, root, sha };
		}
		case "worktree": {
			const branch = await maybe(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
			if (!branch) throw new ShowChangesError(`${root} is not on a branch (detached HEAD); use scope commit or dirty`);
			const head = await headSha();
			const has = async (b: string) => (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`], root)).code === 0;
			let baseRef: string | undefined;
			for (const b of [tree?.baseBranch, "master", "main"]) {
				if (b && b !== branch && (await has(b))) {
					baseRef = b;
					break;
				}
			}
			let baseTip = baseRef ? `refs/heads/${baseRef}` : undefined;
			let base = baseTip ? await maybe(git, ["merge-base", "HEAD", baseTip], root) : undefined;
			// Then origin/HEAD's target, as Sova's diff endpoint does; the tracked base commit last.
			if (!base) {
				const origin = await maybe(git, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root);
				if (origin?.startsWith("refs/remotes/") && origin !== `refs/remotes/origin/${branch}`) {
					base = await maybe(git, ["merge-base", "HEAD", origin], root);
					if (base) {
						baseRef = origin.slice("refs/remotes/".length);
						baseTip = origin;
					}
				}
			}
			// Already merged: what the merge brought in, as Sova's diff endpoint compares it.
			if (base && baseRef && baseTip) {
				const tip = await maybe(git, ["rev-parse", "--verify", "--quiet", `${baseTip}^{commit}`], root);
				const merged = tip ? await mergedReviewBase(git, root, head, tip, base, tree?.base) : undefined;
				if (merged && isSha(merged.base)) {
					base = merged.base;
					baseRef = merged.landing ? `${baseRef} before ${merged.landing.slice(0, 7)}` : `${merged.base.slice(0, 7)} (created from)`;
				}
			}
			if (!base && tree && isSha(tree.base) && (await git(["merge-base", "--is-ancestor", tree.base, "HEAD"], root)).code === 0) {
				base = tree.base;
				baseRef = tree.base.slice(0, 7);
			}
			if (!base || !baseRef) {
				throw new ShowChangesError(
					branch === "master" || branch === "main"
						? `${root} is on ${branch}, the base branch itself: use scope dirty for uncommitted work, scope commit for one commit, or name a worktree`
						: `No base branch (master or main) shares history with ${branch} in ${root}; use scope commit or dirty`,
				);
			}
			return { kind: "worktree", worktreePath: at, root, branch, head, base, baseRef };
		}
	}
}

const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", "--name-only", "-z"];
const split = (out: string) => out.split("\0").filter((s) => s !== "");

/** The changed files of a scope (new paths; a deletion's old path), untracked files included for dirty. Sorted. */
export async function changedFiles(git: Git, scope: ShowChangesScope): Promise<string[]> {
	const run = async (args: string[]) => {
		const r = await git(args, scope.root);
		if (r.code !== 0) throw new ShowChangesError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
		return split(r.stdout);
	};
	let files: string[];
	switch (scope.kind) {
		case "dirty":
			files = [...(await run(["diff", ...DIFF, scope.head, "--"])), ...(await run(["ls-files", "--others", "--exclude-standard", "-z"]))];
			break;
		case "worktree":
			files = await run(["diff", ...DIFF, scope.base, scope.head, "--"]);
			break;
		case "commit":
			files = scope.parent ? await run(["diff", ...DIFF, scope.parent, scope.sha, "--"]) : await run(["diff-tree", "--root", "-r", "--no-commit-id", ...DIFF, scope.sha, "--"]);
			break;
	}
	return [...new Set(files)].sort();
}

/** True when `file` is one of `paths` or under one of them (a directory, with or without "/"). */
export const inPaths = (file: string, paths: readonly string[] | undefined): boolean =>
	!paths || paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
