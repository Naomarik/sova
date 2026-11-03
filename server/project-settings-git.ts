import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * The git a settings card runs (§app.project-overseer/settings): an argument list, never a shell.
 * A propose writes its file changes as one commit on a Sova-owned ref through a temporary index,
 * so the project folder's files and index stay untouched; Apply lands them on the folder's branch.
 */

export interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, opts: { env?: Record<string, string>; input?: string } = {}): Promise<GitOut> {
  return new Promise((done) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...(opts.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => done({ code: 1, stdout, stderr: err.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

export class SettingsGitError extends Error {}

async function must(args: string[], cwd: string, opts?: { env?: Record<string, string>; input?: string }): Promise<string> {
  const r = await git(args, cwd, opts);
  if (r.code !== 0) throw new SettingsGitError((r.stderr || r.stdout).trim().split("\n")[0] || `git ${args[0]} failed`);
  return r.stdout;
}

/** Sova's identity: the commit is Sova's act at the operator's click. */
export const SOVA_ID = ["-c", "user.name=Sova", "-c", "user.email=sova@localhost", "-c", "commit.gpgsign=false"];

export interface Repo {
  /** The work tree's top level (real path). */
  top: string;
  /** The project root relative to top, "/"-separated ("" when it is the top). */
  prefix: string;
  /** The checked-out branch, or null (detached). */
  branch: string | null;
  head: string | null;
}

const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The project root's repository, or null when it isn't in a Git work tree. */
export async function repoOf(root: string): Promise<Repo | null> {
  const t = await git(["rev-parse", "--show-toplevel"], root);
  if (t.code !== 0 || !t.stdout.trim()) return null;
  const top = canonical(t.stdout.trim());
  const prefix = relative(top, canonical(root)).split(sep).join("/");
  const br = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], top);
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], top);
  return { top, prefix, branch: br.code === 0 && br.stdout.trim() ? br.stdout.trim() : null, head: head.code === 0 ? head.stdout.trim() : null };
}

/** A path relative to the project root, as the repository names it. */
export const repoPath = (repo: Repo, rel: string): string => (repo.prefix ? `${repo.prefix}/${rel}` : rel);

/** The blob id of `rel` at `rev`, or null when it has none there. */
export async function blobAt(repo: Repo, rev: string | null, rel: string): Promise<string | null> {
  if (!rev) return null;
  const r = await git(["rev-parse", "--verify", "--quiet", `${rev}:${repoPath(repo, rel)}`], repo.top);
  return r.code === 0 ? r.stdout.trim() : null;
}

export const writeBlob = async (repo: Repo, text: string): Promise<string> => (await must(["hash-object", "-w", "--stdin"], repo.top, { input: text })).trim();
export const readBlob = (repo: Repo, sha: string): Promise<string> => must(["cat-file", "blob", sha], repo.top);

/** A commit of `parent`'s tree with each path set to its blob (null: removed), made through a temporary index. */
export async function commitOnto(repo: Repo, parent: string | null, changes: { rel: string; blob: string | null }[], message: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sova-settings-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    if (parent) await must(["read-tree", parent], repo.top, { env });
    else await must(["read-tree", "--empty"], repo.top, { env });
    for (const c of changes) {
      const path = repoPath(repo, c.rel);
      if (c.blob) await must(["update-index", "--add", "--cacheinfo", `100644,${c.blob},${path}`], repo.top, { env });
      else await must(["update-index", "--force-remove", "--", path], repo.top, { env });
    }
    const tree = (await must(["write-tree"], repo.top, { env })).trim();
    return (await must([...SOVA_ID, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], repo.top)).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const setRef = (repo: Repo, ref: string, sha: string): Promise<string> => must(["update-ref", ref, sha], repo.top);
export const deleteRef = async (repo: Repo, ref: string): Promise<void> => void (await git(["update-ref", "-d", ref], repo.top));

/** The diff of a commit against its parent, limited to `rels` (the card's Show File Changes). */
export async function diffOf(repo: Repo, parent: string | null, commit: string, max = 64 * 1024): Promise<string> {
  const r = parent ? await git(["diff", "--no-color", "--no-ext-diff", parent, commit], repo.top) : await git(["show", "--no-color", "--format=", commit], repo.top);
  const out = r.stdout;
  return out.length > max ? `${out.slice(0, max)}\n… (cut at ${max} bytes)` : out;
}

/** The project root's settings paths (relative to the root) with uncommitted changes: staged, unstaged or untracked. */
export async function dirtyPaths(repo: Repo, rels: string[]): Promise<string[]> {
  if (!rels.length) return [];
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...rels.map((x) => repoPath(repo, x))], repo.top);
  if (r.code !== 0) throw new SettingsGitError((r.stderr || "git status failed").trim().split("\n")[0]!);
  const out: string[] = [];
  const parts = r.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the rename's source follows
    const rel = repo.prefix ? (path.startsWith(`${repo.prefix}/`) ? path.slice(repo.prefix.length + 1) : null) : path;
    if (rel) out.push(rel);
  }
  return [...new Set(out)].sort();
}

/** What the project root is in the middle of (a merge, a rebase…), or null. */
export async function busyWith(repo: Repo): Promise<string | null> {
  const gd = (await git(["rev-parse", "--git-dir"], repo.top)).stdout.trim();
  const { existsSync } = await import("node:fs");
  const dir = resolve(repo.top, gd);
  for (const [f, what] of [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const)
    if (existsSync(join(dir, f))) return what;
  return null;
}

/** Move the branch from `from` to `to` (refused when it moved meanwhile), then set the folder's index entries of `changes` to match. */
export async function advanceBranch(repo: Repo, from: string, to: string, changes: { rel: string; blob: string | null }[]): Promise<void> {
  if (!repo.branch) throw new SettingsGitError("The project folder isn't on a branch.");
  await must(["update-ref", "-m", "sova settings: apply", `refs/heads/${repo.branch}`, to, from], repo.top);
  for (const c of changes) {
    const path = repoPath(repo, c.rel);
    if (c.blob) await must(["update-index", "--add", "--cacheinfo", `100644,${c.blob},${path}`], repo.top);
    else await git(["update-index", "--force-remove", "--", path], repo.top);
  }
}
