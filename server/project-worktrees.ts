import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { PromoteCommit } from "../shared/decisions";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { LOCAL_ONLY_IGNORE } from "./spec-draft-writer";

/**
 * The project's coding sessions each run in their own git worktree and branch of the client
 * repository (§app.project-overseer/coding-worktrees), and promotions are committed in its root
 * (§app.requirements/promotion-commit). Git by argv, never a shell, through the worktree
 * extension's own runner (pi-config/extensions/worktrees/git.ts). Branches are `sova/<name>`, in
 * `<parent of the repo's top level>/.worktrees/<repo folder>-<name>`, as the `worktree` tool places
 * its own. Sova never pushes.
 */

/** Why coding sessions run in the project root: tails the page prefixes ("Coding sessions run in the project root: …"). */
export const NOT_GIT = "it isn't a Git repository.";
export const NO_COMMITS = "the repository has no commits yet.";
export const DETACHED = "its checkout is on a detached HEAD.";

/** Sova's own identity: always for a promotion commit; for Merge Branch (the operator's gesture) only when the repo has none configured. */
const SOVA_ID = ["-c", "user.name=Sova", "-c", "user.email=sova@localhost"];

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "git failed";

export interface GitRoot {
  /** The repository's top level (the root or a folder above it). */
  top: string;
  /** The root checkout's branch. */
  branch: string;
  head: string;
}

/** The root's repository, when a coding session can have a worktree there; else the reason (a tail). */
export async function gitRootOf(root: string, git: Git = runGit): Promise<GitRoot | { reason: string }> {
  if (!existsSync(root)) return { reason: NOT_GIT };
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (top.code !== 0 || !top.stdout.trim()) return { reason: NOT_GIT };
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root);
  if (head.code !== 0 || !head.stdout.trim()) return { reason: NO_COMMITS };
  const br = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (br.code !== 0 || !br.stdout.trim()) return { reason: DETACHED };
  return { top: canonical(top.stdout.trim()), branch: br.stdout.trim(), head: head.stdout.trim() };
}

/** A branch-safe slug of a title: lowercase letters, digits and hyphens, at most 40. */
export function worktreeSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "coding";
}

/** A coding session's worktree as started.json records it (`path` is host-local). */
export interface WorktreeRecord {
  path: string;
  branch: string;
  base: string;
  target: string;
}

export interface CutWorktree {
  worktree: WorktreeRecord;
  /** Where the session runs: the worktree, or the same folder inside it that it was asked to run in. */
  cwd: string;
}

export class WorktreeRefusal extends Error {}

/**
 * A new worktree on a new branch `sova/<slug>-<6 hex>`, cut from the root checkout's HEAD. `cwd` is
 * the folder the session was asked for (the root or inside it); the session runs in the matching
 * folder of the new worktree. Throws a WorktreeRefusal with git's reason when git refuses.
 */
export async function cutWorktree(repo: GitRoot, cwd: string, title: string, git: Git = runGit, suffix = randomBytes(3).toString("hex")): Promise<CutWorktree> {
  const name = `${worktreeSlug(title)}-${suffix}`;
  const branch = `sova/${name}`;
  const path = join(dirname(repo.top), ".worktrees", `${basename(repo.top)}-${name}`);
  if (existsSync(path)) throw new WorktreeRefusal(`${path} already exists`);
  const r = await git(["worktree", "add", "-b", branch, "--", path, repo.head], repo.top);
  if (r.code !== 0) throw new WorktreeRefusal(firstLine(r.stderr || r.stdout));
  const top = canonical(path);
  const inside = relative(repo.top, canonical(cwd));
  const at = inside && !inside.startsWith("..") ? join(top, inside) : top;
  return { worktree: { path: top, branch, base: repo.head, target: repo.branch }, cwd: existsSync(at) ? at : top };
}

async function branchSha(git: Git, cwd: string, branch: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], cwd);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Whether `branch` has commits beyond `base` that are all in `target`. */
async function mergedInto(git: Git, cwd: string, w: WorktreeRecord): Promise<boolean> {
  const b = await branchSha(git, cwd, w.branch);
  const t = await branchSha(git, cwd, w.target);
  if (!b || !t || b === w.base) return false;
  return (await git(["merge-base", "--is-ancestor", b, t], cwd)).code === 0;
}

/** The worktree's uncommitted files (tracked changes and untracked files). */
async function uncommitted(git: Git, dir: string): Promise<string[]> {
  const st = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dir);
  if (st.code !== 0) throw new WorktreeRefusal(firstLine(st.stderr || st.stdout));
  const out: string[] = [];
  const parts = st.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

export interface WorktreeReading {
  /** open | merged | missing (removed is the record's, not git's). */
  state: "open" | "merged" | "missing";
  merged: boolean;
  /** The branch still exists in the repository. */
  branch: boolean;
  ahead: number;
  dirty: boolean;
  worktree: string | null;
  error?: string;
}

/** What the project page shows of one session's worktree, read from git on this host (from the root when its folder is gone). */
export async function readWorktree(w: WorktreeRecord, root: string, git: Git = runGit): Promise<WorktreeReading> {
  const here = existsSync(w.path);
  const cwd = here ? w.path : root;
  try {
    if (!existsSync(cwd)) return { state: "missing", merged: false, branch: false, ahead: 0, dirty: false, worktree: null };
    const branch = (await branchSha(git, cwd, w.branch)) !== null;
    const n = await git(["rev-list", "--count", `${w.base}..refs/heads/${w.branch}`], cwd);
    const ahead = n.code === 0 ? Number(n.stdout.trim()) || 0 : 0;
    const merged = await mergedInto(git, cwd, w);
    const dirty = here ? (await uncommitted(git, w.path)).length > 0 : false;
    return { state: !here ? "missing" : merged ? "merged" : "open", merged, branch, ahead, dirty, worktree: here ? w.path : null };
  } catch (err) {
    return { state: here ? "open" : "missing", merged: false, branch: true, ahead: 0, dirty: false, worktree: here ? w.path : null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A merge, rebase, cherry-pick or revert in progress in the checkout at `dir`, by name; null when none. */
async function inProgress(git: Git, dir: string): Promise<string | null> {
  for (const [f, what] of [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) {
    const p = await git(["rev-parse", "--git-path", f], dir);
    if (p.code === 0 && p.stdout.trim() && existsSync(resolve(dir, p.stdout.trim()))) return what;
  }
  return null;
}

/**
 * Merge Branch (the operator's gesture): merge `sova/<name>` into `target` in the project root's
 * checkout, which must have `target` checked out, no tracked changes and nothing in progress, and
 * the worktree (when its folder is here) must have nothing uncommitted. A
 * fast-forward when possible, else a merge commit "Merge sova/<name>: <title>"; a conflict is
 * aborted and reported. Works with the worktree folder gone: only the branch is needed.
 */
export async function mergeBack(w: WorktreeRecord, root: string, title: string, git: Git = runGit): Promise<{ sha: string }> {
  const at = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (at.code !== 0 || !at.stdout.trim()) throw new WorktreeRefusal(`The project root's checkout is on a detached HEAD, not ${w.target}. Check out ${w.target} there, then merge.`);
  const checkedOut = at.stdout.trim();
  if (checkedOut !== w.target) throw new WorktreeRefusal(`The project root has ${checkedOut} checked out, not ${w.target}. Check out ${w.target} there, then merge.`);
  // A partial build is never merged silently: what the session hasn't committed would be left out.
  // A folder that is gone has nothing to inspect.
  if (existsSync(w.path)) {
    const files = await uncommitted(git, w.path);
    if (files.length)
      throw new WorktreeRefusal(`The worktree has uncommitted changes in ${files.length} file${files.length === 1 ? "" : "s"} (${files[0]}). Commit them in the session first, then merge.`);
  }
  const busy = await inProgress(git, root);
  if (busy) throw new WorktreeRefusal(`The project root is in the middle of a ${busy}. Finish it, then merge.`);
  const tracked = await git(["status", "--porcelain", "--untracked-files=no"], root);
  if (tracked.code !== 0) throw new WorktreeRefusal(firstLine(tracked.stderr || tracked.stdout));
  if (tracked.stdout.trim()) throw new WorktreeRefusal("The project root has uncommitted changes to tracked files. Commit or stash them, then merge.");
  const b = await branchSha(git, root, w.branch);
  if (!b) throw new WorktreeRefusal(`The branch ${w.branch} no longer exists.`);
  if ((await git(["merge-base", "--is-ancestor", b, "HEAD"], root)).code === 0) throw new WorktreeRefusal(`${w.branch} has nothing to merge into ${w.target}.`);
  const who = await git(["config", "user.email"], root);
  const id = who.code === 0 && who.stdout.trim() ? [] : SOVA_ID;
  const r = await git([...id, "-c", "commit.gpgsign=false", "merge", "--no-edit", "-m", `Merge ${w.branch}: ${title}`, "--", `refs/heads/${w.branch}`], root);
  if (r.code !== 0) {
    const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], root);
    const n = conflicted.stdout.split("\n").filter(Boolean).length;
    await git(["merge", "--abort"], root);
    if (n > 0) throw new WorktreeRefusal(`${w.branch} conflicts with ${w.target} in ${n} file${n === 1 ? "" : "s"}. Nothing was merged. Resolve it in the worktree, then merge again.`);
    throw new WorktreeRefusal(`Nothing was merged: ${firstLine(r.stderr || r.stdout)}`);
  }
  const sha = await git(["rev-parse", "HEAD"], root);
  return { sha: sha.stdout.trim() };
}

/**
 * Remove Worktree: git's own `worktree remove` (refused with uncommitted changes, naming them), and
 * the branch deleted only when merged; an unmerged branch keeps its commits. A folder already gone
 * is pruned from git's list. Returns whether the branch was deleted.
 */
export async function removeWorktree(w: WorktreeRecord, root: string, git: Git = runGit): Promise<{ branchDeleted: boolean }> {
  if (existsSync(w.path)) {
    const files = await uncommitted(git, w.path);
    if (files.length)
      throw new WorktreeRefusal(`The worktree has uncommitted changes in ${files.length} file${files.length === 1 ? "" : "s"} (${files[0]}). Nothing was removed. Commit or discard them first.`);
    const rm = await git(["worktree", "remove", "--", w.path], root);
    if (rm.code !== 0) throw new WorktreeRefusal(`Nothing was removed: ${firstLine(rm.stderr || rm.stdout)}`);
  } else await git(["worktree", "prune"], root);
  if (!(await mergedInto(git, root, w))) return { branchDeleted: false };
  const del = await git(["branch", "-D", "--", w.branch], root);
  return { branchDeleted: del.code === 0 };
}

// ---- promotion commits ------------------------------------------------------------------------------

const SPEC_DIR = join(".sova", "spec");

/** The root's `.sova/spec/` files that differ from HEAD (tracked or untracked, never ignored), top-level relative, with git's XY code. */
async function specChanges(git: Git, top: string, specRel: string): Promise<Map<string, string>> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", specRel], top);
  if (r.code !== 0) throw new WorktreeRefusal(firstLine(r.stderr || r.stdout));
  const out = new Map<string, string>();
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    out.set(e.slice(3), e.slice(0, 2));
    // A rename or copy carries its source as the next field.
    if (e[0] === "R" || e[0] === "C") out.set(parts[++i] ?? "", e.slice(0, 2));
  }
  out.delete("");
  return out;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function contentHash(file: string): string {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return "absent";
  }
}

export interface SpecSnapshot {
  top: string;
  /** The project root, for paths in messages. */
  root: string;
  specRel: string;
  branch: string | null;
  /** Why no commit will follow, known before the promotion ("Not committed: …"). */
  blocked?: string;
  /** Files differing from HEAD before the promotion (top-level relative), with a hash of their content then. */
  before: Map<string, string>;
  /** Sova's own `.gitignore`, untracked and as Sova wrote it before the promotion (drafting adds it): committed with it. */
  ownIgnore?: string;
}

/** Before a promotion: the root's repository and its `.sova/spec/` changes so far. Null: the root isn't in a Git work tree. */
export async function specSnapshot(root: string, git: Git = runGit): Promise<SpecSnapshot | null> {
  if (!existsSync(root)) return null;
  const t = await git(["rev-parse", "--show-toplevel"], root);
  if (t.code !== 0 || !t.stdout.trim()) return null;
  const top = canonical(t.stdout.trim());
  const specRel = relative(top, resolve(canonical(root), SPEC_DIR)).split(sep).join("/");
  const br = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const snap: SpecSnapshot = { top, root: canonical(root), specRel, branch: br.code === 0 && br.stdout.trim() ? br.stdout.trim() : null, before: new Map() };
  const busy = await inProgress(git, root);
  if (busy) snap.blocked = `Not committed: the project root is in the middle of a ${busy}.`;
  else if (!snap.branch) snap.blocked = "Not committed: the project root's checkout is on a detached HEAD.";
  else
    try {
      for (const [f, xy] of await specChanges(git, top, specRel)) {
        snap.before.set(f, contentHash(join(top, f)));
        if (xy === "??" && f === `${specRel}/.gitignore` && readText(join(top, f)) === LOCAL_ONLY_IGNORE) snap.ownIgnore = f;
      }
    } catch (err) {
      snap.blocked = `Not committed: ${err instanceof Error ? err.message : String(err)}`;
    }
  return snap;
}

/**
 * After a promotion: commit exactly the `.sova/spec/` files it changed that were clean before it,
 * by explicit path (`commit --only`: other staged or unstaged changes stay as they were), on the
 * root's branch. Skipped with the reason when the root was mid-merge (or rebase, cherry-pick,
 * revert) or detached, when a file the promotion changed already differed from HEAD, or when git
 * fails. Undefined: nothing to commit.
 */
export async function commitSpec(snap: SpecSnapshot, message: string, git: Git = runGit): Promise<PromoteCommit | undefined> {
  if (snap.blocked) return { skipped: snap.blocked };
  let after: Map<string, string>;
  try {
    after = await specChanges(git, snap.top, snap.specRel);
  } catch (err) {
    return { skipped: `Not committed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Changed before AND by the promotion: the two can't be told apart, so nothing is committed.
  // Changed before and left alone by it: not ours, left out.
  const theirs = [...snap.before.keys()].filter((f) => after.has(f) && contentHash(join(snap.top, f)) !== snap.before.get(f)).sort();
  if (theirs.length) {
    const shown = relative(snap.root, join(snap.top, theirs[0]!)).split(sep).join("/");
    return { skipped: `Not committed: ${shown} had changes Sova didn't make. Commit or discard them, and later promotions are committed again.` };
  }
  const files = [...after.keys()].filter((f) => !snap.before.has(f) || f === snap.ownIgnore).sort();
  if (!files.length) return undefined;
  const add = await git(["add", "--", ...files], snap.top);
  if (add.code !== 0) return { skipped: `Not committed: ${firstLine(add.stderr || add.stdout)}` };
  // Sova's identity, never the repo's or the host's: the commit is Sova's act, not the operator's.
  const c = await git([...SOVA_ID, "-c", "commit.gpgsign=false", "commit", "--only", "-m", message, "--", ...files], snap.top);
  if (c.code !== 0) return { skipped: `Not committed: ${firstLine(c.stderr || c.stdout)}` };
  const sha = await git(["rev-parse", "HEAD"], snap.top);
  return { sha: sha.stdout.trim(), branch: snap.branch ?? "", files, message };
}
