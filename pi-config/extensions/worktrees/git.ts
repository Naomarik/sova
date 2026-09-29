/**
 * The git the `worktree` tool runs: always an argument list through execFile, never a shell, so no
 * path or branch name is ever parsed by one. Node builtins only (tests drive it against a
 * throwaway repository without pi).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonical, type TrackedWorktree, type WorktreeMergeDetails } from "./state.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Git = (args: string[], cwd: string) => Promise<GitResult>;

/** Run git with `args` in `cwd`. Never throws: a missing git or a signal is a nonzero code. */
export const runGit: Git = (args, cwd) =>
	new Promise((done) => {
		execFile(
			"git",
			args,
			{ cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } },
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
				done({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 && !stderr ? err.message : "") });
			},
		);
	});

export class GitError extends Error {}

async function must(git: Git, args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
	return r.stdout.trim();
}

/** A branch name git accepts (`git check-ref-format --branch`), else a thrown GitError. */
async function checkBranch(git: Git, name: string, cwd: string): Promise<void> {
	const r = await git(["check-ref-format", "--branch", name], cwd);
	if (r.code !== 0 || name.startsWith("-")) throw new GitError(`Not a valid branch name: ${name}`);
}

export interface WorktreeFacts {
	/** Canonical top level. */
	path: string;
	branch: string;
	head: string;
	/** Canonical git common dir: the repository the worktree belongs to. */
	commonDir: string;
}

/** What git says about the worktree at `path`, which must be its top level and on a branch. */
export async function inspectWorktree(git: Git, path: string): Promise<WorktreeFacts> {
	if (!isAbsolute(path)) throw new GitError(`Worktree path must be absolute: ${path}`);
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new GitError(`Not a directory: ${path}`);
	const top = canonical(await must(git, ["rev-parse", "--show-toplevel"], path));
	const want = canonical(path);
	if (top !== want) throw new GitError(`${want} is inside the worktree ${top}; name the worktree's top level`);
	const branch = await must(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], path).catch(() => {
		throw new GitError(`${top} is not on a branch (detached HEAD)`);
	});
	const head = await must(git, ["rev-parse", "HEAD"], path);
	const commonDir = canonical(resolve(top, await must(git, ["rev-parse", "--git-common-dir"], path)));
	return { path: top, branch, head, commonDir };
}

interface ListedWorktree {
	path: string;
	head?: string;
	branch?: string;
}

/** `git worktree list --porcelain`, first entry the main checkout. */
export async function listWorktrees(git: Git, cwd: string): Promise<ListedWorktree[]> {
	const out = await must(git, ["worktree", "list", "--porcelain"], cwd);
	const list: ListedWorktree[] = [];
	for (const block of out.split(/\n\n+/)) {
		const w: ListedWorktree = { path: "" };
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) w.path = line.slice("worktree ".length);
			else if (line.startsWith("HEAD ")) w.head = line.slice(5);
			else if (line.startsWith("branch refs/heads/")) w.branch = line.slice("branch refs/heads/".length);
		}
		if (w.path) list.push(w);
	}
	return list;
}

export interface CreateRequest {
	/** Any directory inside the repository (the session cwd). */
	repoCwd: string;
	name: string;
	/** Commit-ish to base on; default the repoCwd's HEAD. */
	base?: string;
	/** Absolute path; default <parent of the main checkout>/.worktrees/<repo>-<name>. */
	path?: string;
}

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `git worktree add -b feat/<name> <path> <base>`; returns the new worktree's facts, base and base branch. */
export async function createWorktree(git: Git, req: CreateRequest): Promise<WorktreeFacts & { base: string; baseBranch?: string }> {
	if (!NAME.test(req.name)) throw new GitError(`Worktree name must be letters, digits, ".", "_" or "-" (at most 64): ${req.name}`);
	const branch = `feat/${req.name}`;
	await checkBranch(git, branch, req.repoCwd);
	const main = (await listWorktrees(git, req.repoCwd))[0];
	if (!main) throw new GitError(`No git repository at ${req.repoCwd}`);
	const path = req.path ? resolve(req.repoCwd, req.path) : join(dirname(main.path), ".worktrees", `${basename(main.path)}-${req.name}`);
	if (existsSync(path)) throw new GitError(`${path} already exists`);
	const baseRef = req.base ?? "HEAD";
	if (baseRef.startsWith("-")) throw new GitError(`Not a valid base: ${baseRef}`);
	const base = await must(git, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], req.repoCwd);
	const baseBranch = req.base
		? (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${req.base}`], req.repoCwd)).code === 0 ? req.base : undefined
		: await git(["symbolic-ref", "--quiet", "--short", "HEAD"], req.repoCwd).then((r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined));
	await must(git, ["worktree", "add", "-b", branch, "--", path, base], req.repoCwd);
	const facts = await inspectWorktree(git, path);
	return { ...facts, base, ...(baseBranch ? { baseBranch } : {}) };
}

/** `master` when the repository has it, else `main`, else undefined. */
export async function defaultTarget(git: Git, cwd: string): Promise<string | undefined> {
	for (const b of ["master", "main"]) if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd)).code === 0) return b;
	return undefined;
}

async function refSha(git: Git, ref: string, cwd: string): Promise<string | undefined> {
	const r = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`], cwd);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/** `git merge-base <branch> <target>`, or undefined when they share no history. */
export async function forkPoint(git: Git, cwd: string, branch: string, target: string): Promise<string | undefined> {
	const r = await git(["merge-base", `refs/heads/${branch}`, `refs/heads/${target}`], cwd);
	return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Lines added and removed over `git diff --numstat <range...>`. */
async function lineCounts(git: Git, cwd: string, range: string[]): Promise<{ added: number; removed: number }> {
	let added = 0;
	let removed = 0;
	for (const line of (await must(git, ["diff", "--numstat", ...range], cwd)).split("\n")) {
		const [a, r] = line.split("\t");
		// Binary files read "-\t-": no line counts.
		if (a && /^\d+$/.test(a)) added += Number(a);
		if (r && /^\d+$/.test(r)) removed += Number(r);
	}
	return { added, removed };
}

/** Numbers of a merge that moved `target` from `before` to `after` by bringing in `branchSha`. */
export async function mergeStats(git: Git, cwd: string, before: string, after: string, branchSha: string): Promise<{ commits: number; added: number; removed: number; fastForward: boolean }> {
	const commits = Number(await must(git, ["rev-list", "--count", `${before}..${branchSha}`], cwd)) || 0;
	return { commits, ...(await lineCounts(git, cwd, [before, after])), fastForward: after === branchSha };
}

/**
 * A merge seen after a run, where `target` moved from `before` to `after` and now contains
 * `branchSha`, perhaps together with other branches. `sha` is the landing commit: the first commit
 * on the target's first-parent history since `before` that contains the branch (`after` if none
 * does); the branch tip itself means the target fast-forwarded through it. The numbers are the
 * branch's own: its commits beyond `before`, and its change against their merge base.
 */
export async function landedStats(git: Git, cwd: string, before: string, after: string, branchSha: string): Promise<{ sha: string; commits: number; added: number; removed: number; fastForward: boolean }> {
	const lines = (out: string) => out.split("\n").filter(Boolean);
	const firstParent = lines(await must(git, ["rev-list", "--first-parent", "--reverse", `${before}..${after}`], cwd));
	const containing = new Set([branchSha, ...lines(await must(git, ["rev-list", "--ancestry-path", `${branchSha}..${after}`], cwd))]);
	const sha = firstParent.find((c) => containing.has(c)) ?? after;
	const commits = Number(await must(git, ["rev-list", "--count", `${before}..${branchSha}`], cwd)) || 0;
	return { sha, commits, ...(await lineCounts(git, cwd, [`${before}...${branchSha}`])), fastForward: sha === branchSha };
}

/** Where a review of an already merged branch starts: `landing` names the commit that brought it in; without it, the tracked base. */
export interface MergedReviewBase {
	base: string;
	landing?: string;
}

/**
 * The base side for reviewing `head` once it is in `target` (`mergeBase`, their merge-base, is
 * `head` itself). The landing commit is the first commit on the target's first-parent history
 * since `head` that contains it, as landedStats finds it; the review is `head` against its
 * merge-base with that commit's first parent, so the target's own work beside the branch stays
 * out. A target that fast-forwarded to `head` has no such commit: `trackedBase` then, when it is a
 * full sha, an ancestor of `head` and not `head`. Undefined when neither applies, when `head` is
 * not in `target`, when `head` is `trackedBase` (no commits of its own) or when git fails.
 */
export async function mergedReviewBase(git: Git, cwd: string, head: string, target: string, mergeBase: string, trackedBase?: string): Promise<MergedReviewBase | undefined> {
	if (mergeBase !== head || head === trackedBase) return undefined;
	const lines = async (args: string[]) => {
		const r = await git(args, cwd);
		return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : undefined;
	};
	const firstParent = await lines(["rev-list", "--first-parent", "--reverse", `${head}..${target}`]);
	const containing = await lines(["rev-list", "--ancestry-path", `${head}..${target}`]);
	if (!firstParent || !containing) return undefined;
	const has = new Set(containing);
	const landing = firstParent.find((c) => has.has(c));
	if (landing) {
		const p1 = (await lines(["rev-parse", "--verify", "--quiet", `${landing}^1^{commit}`]))?.[0];
		if (p1 && p1 !== head) {
			const base = (await lines(["merge-base", head, p1]))?.[0];
			if (base) return { base, landing };
		}
	}
	if (!trackedBase || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(trackedBase)) return undefined;
	return (await git(["merge-base", "--is-ancestor", trackedBase, head], cwd)).code === 0 ? { base: trackedBase } : undefined;
}

export interface MergeRequest {
	tree: Pick<TrackedWorktree, "path" | "branch">;
	target: string;
}

/**
 * Merge the worktree's branch into `target`. Where `target` is checked out, that checkout must have
 * no tracked changes and the merge runs there (fast-forward when possible, else a merge commit; a
 * conflict is aborted, leaving everything as it was). Where it is not checked out, only a
 * fast-forward is done (update-ref, guarded by the old value).
 */
export async function mergeWorktree(git: Git, req: MergeRequest): Promise<Omit<WorktreeMergeDetails, "version" | "how">> {
	const cwd = req.tree.path;
	await checkBranch(git, req.target, cwd);
	if (req.target === req.tree.branch) throw new GitError(`Cannot merge ${req.target} into itself`);
	const branchSha = await refSha(git, req.tree.branch, cwd);
	if (!branchSha) throw new GitError(`Branch ${req.tree.branch} does not exist`);
	const before = await refSha(git, req.target, cwd);
	if (!before) throw new GitError(`Target branch ${req.target} does not exist`);
	if ((await git(["merge-base", "--is-ancestor", branchSha, before], cwd)).code === 0) throw new GitError(`${req.tree.branch} is already merged into ${req.target} (nothing to merge)`);
	const checkout = (await listWorktrees(git, cwd)).find((w) => w.branch === req.target);
	if (checkout) {
		const dirty = await must(git, ["status", "--porcelain", "--untracked-files=no"], checkout.path);
		if (dirty) throw new GitError(`${req.target} is checked out at ${checkout.path} with uncommitted changes; commit or clean them first`);
		const r = await git(["merge", "--no-edit", "-m", `Merge branch '${req.tree.branch}'`, branchSha], checkout.path);
		if (r.code !== 0) {
			await git(["merge", "--abort"], checkout.path);
			throw new GitError(`Merging ${req.tree.branch} into ${req.target} failed and was aborted: ${(r.stdout + r.stderr).trim().split("\n").slice(-4).join(" ")}`);
		}
	} else {
		if ((await git(["merge-base", "--is-ancestor", before, branchSha], cwd)).code !== 0)
			throw new GitError(`${req.target} is not checked out anywhere and ${req.tree.branch} does not fast-forward it; check out ${req.target} in a worktree first`);
		await must(git, ["update-ref", "-m", `worktree merge ${req.tree.branch}`, `refs/heads/${req.target}`, branchSha, before], cwd);
	}
	const after = await refSha(git, req.target, cwd);
	if (!after) throw new GitError(`Target branch ${req.target} vanished during the merge`);
	const stats = await mergeStats(git, cwd, before, after, branchSha);
	return { path: req.tree.path, branch: req.tree.branch, target: req.target, sha: after, ...stats };
}

/** One worktree's merge state: `merged` when its branch has commits beyond its base and all of them are in `target`. */
export interface MergeProbe {
	target: string;
	targetSha: string;
	branchSha: string;
	merged: boolean;
}

export async function probeMerge(git: Git, tree: Pick<TrackedWorktree, "path" | "branch" | "base" | "baseBranch">, targetOverride?: string): Promise<MergeProbe | undefined> {
	const cwd = existsSync(tree.path) ? tree.path : undefined;
	if (!cwd) return undefined;
	const target = targetOverride ?? tree.baseBranch ?? (await defaultTarget(git, cwd));
	if (!target || target === tree.branch) return undefined;
	const [branchSha, targetSha] = [await refSha(git, tree.branch, cwd), await refSha(git, target, cwd)];
	if (!branchSha || !targetSha) return undefined;
	const merged = branchSha !== tree.base && (await git(["merge-base", "--is-ancestor", branchSha, targetSha], cwd)).code === 0;
	return { target, targetSha, branchSha, merged };
}
