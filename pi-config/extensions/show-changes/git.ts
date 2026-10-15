/**
 * The git `show_changes` runs: resolving a scope to shas, and listing the changed files so the
 * reply can name them and point out step refs to files outside the diff. Read-only plumbing,
 * always an argument list through execFile (never a shell), with a timeout and an output cap.
 * Node builtins only, so the tests drive it against throwaway repositories without pi.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { REVIEW_LIMITS, reviewBase } from "../worktrees/git.ts";
import { canonical, isWithin, normalizeActive, normalizeMergeDetails, WORKTREE_MERGE_MESSAGE, WORKTREES_ENTRY_TYPE } from "../worktrees/state.ts";
import { isSha, type ShowChangesScope } from "./details.ts";
import { ShowChangesError, type ShowChangesRequest } from "./input.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout passed `maxBuffer` and git was stopped; `stdout` is then cut short. */
	cut?: boolean;
	/** git ran past its time and was stopped. */
	timedOut?: boolean;
}

/** `timeoutMs`: default REVIEW_LIMITS.gitTimeoutMs (5 s), the viewer's limit for every read but the whole patch. */
export type Git = (args: string[], cwd: string, opts?: { maxBuffer?: number; timeoutMs?: number }) => Promise<GitResult>;

/** Global options on every call: no fsmonitor hook, no index refresh writes. */
const SAFE = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

/** Run git with `args` in `cwd`. Never throws: a missing git, a timeout or a signal is a nonzero code. */
export const runGit: Git = (args, cwd, opts) =>
	new Promise((done) => {
		execFile(
			"git",
			[...SAFE, ...args],
			{
				cwd,
				maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
				timeout: opts?.timeoutMs ?? REVIEW_LIMITS.gitTimeoutMs,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
			},
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
				const cut = (err as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
				const timedOut = !cut && !!err && (err as { killed?: boolean }).killed === true;
				const why = timedOut ? `timed out after ${Math.round((opts?.timeoutMs ?? REVIEW_LIMITS.gitTimeoutMs) / 1000)} s` : "";
				done({
					code,
					stdout: String(stdout),
					stderr: why || String(stderr) || (err && code !== 0 && !stderr ? err.message : ""),
					...(cut ? { cut } : {}),
					...(timedOut ? { timedOut } : {}),
				});
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

/**
 * The folders Sova's viewer opens for this session (server/git-diff.ts `knownFoldersOf`): the
 * session's folder, every worktree any `worktrees` entry in the file names (any status), and every
 * merge card's folder. Its workers' folders are left out: the subagents gate starts a worker only
 * inside the session's folder or an active tracked worktree, which this list already holds.
 */
export function knownFolders(cwd: string, entries: readonly unknown[]): string[] {
	const roots = [cwd];
	for (const raw of entries) {
		const e = raw as { type?: unknown; customType?: unknown; data?: unknown; details?: unknown } | null;
		if (e?.type === "custom" && e.customType === WORKTREES_ENTRY_TYPE) for (const t of normalizeActive(e.data)?.trees ?? []) roots.push(t.path);
		else if (e?.type === "custom_message" && e.customType === WORKTREE_MERGE_MESSAGE) {
			const m = normalizeMergeDetails(e.details);
			if (m) roots.push(m.path);
		}
	}
	return [...new Set(roots)];
}

/** Why the viewer would refuse `dir` (a folder outside every known one), or undefined. */
export function unknownFolderRefusal(dir: string, roots: readonly string[]): string | undefined {
	const at = canonical(dir);
	if (roots.some((r) => isWithin(at, canonical(r)))) return undefined;
	return `${at} is outside this session's folder and its worktrees, so the viewer can't open it. Put the changes in a worktree (the worktree tool) and show that`;
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
			// The one rule the viewer's worktree comparison uses (../worktrees/git.ts), so a card never opens a refusal.
			const tracked = tree ? { base: tree.base, ...(tree.baseBranch ? { baseBranch: tree.baseBranch } : {}) } : undefined;
			const found = await reviewBase(git, root, { head, branch, ...(tracked ? { tracked } : {}) });
			if (!found.ok) {
				throw new ShowChangesError(
					found.refusal === "detached"
						? `${root} is not on a branch (detached HEAD); use scope commit or dirty`
						: found.refusal === "on-base-branch"
							? `${root} is on ${branch}, the base branch itself: use scope dirty for uncommitted work, scope commit for one commit, or name a worktree`
							: found.refusal === "no-history"
								? `No base branch shares history with ${branch} in ${root}, and it has no tracked commit it was created from; use scope commit or dirty`
								: `${branch} in ${root} has no base to compare against (no master, main or origin/HEAD, and no tracked commit it was created from); use scope commit or dirty`,
				);
			}
			if (!isSha(found.base)) throw new ShowChangesError(`The base of ${branch} in ${root} did not resolve to a commit`);
			const base = found.base;
			const baseRef = found.label;
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
