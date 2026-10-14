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

/**
 * The limits both engines that read a review diff share: the `show_changes` tool and Sova's diff
 * endpoint (server/git-diff.ts), so the agent's card never promises more than the viewer shows.
 * `gitTimeoutMs` bounds each listing read (resolve, changed files, untracked files); `maxFiles` is
 * the most files a comparison lists (past it the tool refuses unless `paths` narrows it);
 * `patchCap` is one file's patch (past it the file is one whole-file unit); `untrackedRead` is the
 * most of one untracked file read, and `untrackedBudget` the untracked bytes one comparison reads.
 */
export const REVIEW_LIMITS = Object.freeze({
	gitTimeoutMs: 5_000,
	maxFiles: 3_000,
	patchCap: 1024 * 1024,
	untrackedRead: 1024 * 1024,
	untrackedBudget: 16 * 1024 * 1024,
});

/** What reviewBase knows of the tracked worktree at that folder, if the session tracks one. */
export interface ReviewBaseTracked {
	/** The branch it was created from. */
	baseBranch?: string;
	/** The commit it was created from (a full sha). */
	base?: string;
}

export interface ReviewBaseFound {
	ok: true;
	/** Full sha of the comparison's base side. */
	base: string;
	/**
	 * How the base was chosen: `merge-base` with a base branch, `merged` (what the merge that
	 * brought the branch in added, mergedReviewBase), or `created-from` (the tracked base commit).
	 */
	how: "merge-base" | "merged" | "created-from";
	/**
	 * The tool's name for the base: the branch (`master`, `origin/main`), `<branch> before <sha7>`
	 * for a merged branch with a landing commit, else `<sha7> (created from)`.
	 */
	label: string;
	/** The base branch's short name (`master`, `origin/main`); absent for `created-from`. */
	ref?: string;
	/** Its full ref (`refs/heads/master`, `refs/remotes/origin/main`) and tip sha; absent for `created-from`. */
	tipRef?: string;
	tip?: string;
	/** For `merged`: the commit that brought the branch in, when there is one. */
	landing?: string;
}

/**
 * Why there is no base: `detached` (HEAD on no branch); `on-base-branch` (the checkout is on a base
 * candidate itself, e.g. master, and nothing else applied); `no-history` (a base branch exists but
 * none shares history with HEAD, and no tracked base commit applied); `no-base` (no base branch
 * and no usable tracked base commit).
 */
export interface ReviewBaseRefused {
	ok: false;
	refusal: "detached" | "on-base-branch" | "no-history" | "no-base";
}

export type ReviewBase = ReviewBaseFound | ReviewBaseRefused;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The one rule for what a branch is reviewed against, shared by the `show_changes` tool and Sova's
 * diff endpoint. `head` is HEAD's full sha in `root`, `branch` its short branch name (none:
 * detached). The base is the merge-base of HEAD with the first of: the tracked base branch (a
 * plain name), `master`, `main` (each skipped when it is the current branch, missing, or shares
 * no history), then the branch `origin/HEAD` names (unless it is `origin/<branch>`). Once found,
 * an already merged branch is compared against what its merge brought in (mergedReviewBase). With
 * no base branch that shares history, the tracked base commit when it is a full sha, an ancestor
 * of HEAD and not HEAD itself (`<sha7> (created from)`). Never throws: a failing git reads as
 * "not there".
 */
export async function reviewBase(git: Git, root: string, at: { head: string; branch?: string | null; tracked?: ReviewBaseTracked }): Promise<ReviewBase> {
	const { head, tracked } = at;
	const branch = at.branch || undefined;
	if (!branch) return { ok: false, refusal: "detached" };
	const out = async (args: string[]) => {
		const r = await git(args, root);
		return r.code === 0 ? r.stdout.trim() || undefined : undefined;
	};
	const wanted = tracked?.baseBranch && /^[\w./-]+$/.test(tracked.baseBranch) && !tracked.baseBranch.startsWith("-") ? tracked.baseBranch : undefined;
	let onBase = false;
	let sawBranch = false;
	let found: { ref: string; tipRef: string; tip: string; mergeBase: string } | undefined;
	const seen = new Set<string>();
	for (const name of [wanted, "master", "main"]) {
		if (!name || seen.has(name)) continue;
		seen.add(name);
		if (name === branch) {
			onBase = true;
			continue;
		}
		const tipRef = `refs/heads/${name}`;
		const tip = await out(["rev-parse", "--verify", "--quiet", `${tipRef}^{commit}`]);
		if (!tip) continue;
		sawBranch = true;
		const mergeBase = await out(["merge-base", head, tip]);
		if (mergeBase) {
			found = { ref: name, tipRef, tip, mergeBase };
			break;
		}
	}
	if (!found) {
		const origin = await out(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
		if (origin?.startsWith("refs/remotes/")) {
			if (origin === `refs/remotes/origin/${branch}`) onBase = true;
			else {
				const tip = await out(["rev-parse", "--verify", "--quiet", `${origin}^{commit}`]);
				if (tip) {
					sawBranch = true;
					const mergeBase = await out(["merge-base", head, tip]);
					if (mergeBase) found = { ref: origin.slice("refs/remotes/".length), tipRef: origin, tip, mergeBase };
				}
			}
		}
	}
	if (found) {
		const { ref, tipRef, tip, mergeBase } = found;
		const merged = await mergedReviewBase(git, root, head, tip, mergeBase, tracked?.base);
		if (merged && FULL_SHA.test(merged.base)) {
			return merged.landing
				? { ok: true, base: merged.base, how: "merged", label: `${ref} before ${merged.landing.slice(0, 7)}`, ref, tipRef, tip, landing: merged.landing }
				: { ok: true, base: merged.base, how: "merged", label: `${merged.base.slice(0, 7)} (created from)`, ref, tipRef, tip };
		}
		return { ok: true, base: mergeBase, how: "merge-base", label: ref, ref, tipRef, tip };
	}
	const created = tracked?.base;
	if (created && FULL_SHA.test(created) && created !== head && (await git(["merge-base", "--is-ancestor", created, head], root)).code === 0) {
		return { ok: true, base: created, how: "created-from", label: `${created.slice(0, 7)} (created from)` };
	}
	return { ok: false, refusal: onBase ? "on-base-branch" : sawBranch ? "no-history" : "no-base" };
}

export interface MergeRequest {
	tree: Pick<TrackedWorktree, "path" | "branch">;
	target: string;
}

/**
 * Merge the worktree's branch into `target`. Where `target` is checked out, that checkout must have
 * no tracked changes and the merge runs there (fast-forward when possible, else a merge commit; a
 * conflict is aborted, leaving everything as it was). Where it is not checked out, only a
 * fast-forward is done (update-ref, guarded by the old value). `before` and `branchSha` are the target's old tip and
 * the branch tip merged.
 */
export async function mergeWorktree(git: Git, req: MergeRequest): Promise<Omit<WorktreeMergeDetails, "version" | "how"> & { before: string; branchSha: string }> {
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
	return { path: req.tree.path, branch: req.tree.branch, target: req.target, sha: after, ...stats, before, branchSha };
}

/** One worktree's merge state: `merged` when its branch has commits beyond its base and all of them are in `target`. */
export interface MergeProbe {
	target: string;
	targetSha: string;
	branchSha: string;
	merged: boolean;
}

/**
 * Without `targetOverride`, the branch is checked against its base branch and the repo's main
 * branch: merged when either has it, and `target` is the one that does (the base branch first).
 * Merged into neither, `target` is the base branch, else the main branch. An override is the only
 * target checked.
 */
export async function probeMerge(git: Git, tree: Pick<TrackedWorktree, "path" | "branch" | "base" | "baseBranch">, targetOverride?: string): Promise<MergeProbe | undefined> {
	const cwd = existsSync(tree.path) ? tree.path : undefined;
	if (!cwd) return undefined;
	const main = targetOverride ? undefined : await defaultTarget(git, cwd);
	const targets = [...new Set([targetOverride ?? tree.baseBranch ?? main, main])].filter((t): t is string => !!t && t !== tree.branch);
	const branchSha = await refSha(git, tree.branch, cwd);
	if (!branchSha) return undefined;
	let first: MergeProbe | undefined;
	for (const target of targets) {
		const targetSha = await refSha(git, target, cwd);
		if (!targetSha) continue;
		const merged = branchSha !== tree.base && (await git(["merge-base", "--is-ancestor", branchSha, targetSha], cwd)).code === 0;
		const probe = { target, targetSha, branchSha, merged };
		if (merged) return probe;
		first ??= probe;
	}
	return first;
}
