import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgGitStatus } from "../shared/orgs";

/**
 * Git for an organization's workspace repo (§app.organizations/workspace-repo): init, commit (the
 * hourly committer in server/workspace-commits.ts, Commit Now, shutdown), push to the repo's own
 * `origin` when one is set. Every call is argv (no shell), bounded, non-interactive, and serialized
 * per repo, so two commits never race on the index. A failure is recorded as the repo's last error
 * and never thrown at the caller.
 */

const TIMEOUT_MS = 30_000;
/** Read by the workspace repo's own .gitignore: temp files of the atomic writers, nothing else. */
const GITIGNORE = "# Written by Sova. Link tokens, credentials and Sova's settings never live in this repo.\n*.tmp\n*.lock\n";

/** Automated commits must never block on a signing prompt or a hook asking for input. */
const NON_INTERACTIVE = ["-c", "commit.gpgsign=false", "-c", "core.editor=true"];

function git(dir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...NON_INTERACTIVE, "-C", dir, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extraEnv } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      },
    );
  });
}

const queues = new Map<string, Promise<unknown>>();
const lastErrors = new Map<string, string | null>();

/** Run `job` after every earlier job of the same repo. */
function serial<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(dir) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(
    dir,
    next.catch(() => {}),
  );
  return next;
}

/** A new repo with Sova's .gitignore (kept when the dir already has one). */
export async function initRepo(dir: string): Promise<void> {
  const r = await git(dir, ["init", "-q", "-b", "main"]);
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
}

export const isRepo = async (dir: string): Promise<boolean> => (await git(dir, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";

/** The repo's `origin` URL, or null. */
export async function remoteOf(dir: string): Promise<string | null> {
  const r = await git(dir, ["remote", "get-url", "origin"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Set (or with "" remove) the repo's `origin`. */
export function setRemote(dir: string, url: string): Promise<void> {
  return serial(dir, async () => {
    const had = await remoteOf(dir);
    if (!url) {
      if (had) await git(dir, ["remote", "remove", "origin"]);
      return;
    }
    const r = await git(dir, had ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
    if (r.code !== 0) throw new Error(`git remote failed: ${r.stderr.trim()}`);
    // Another remote: what the old one had says nothing about it, so Commit Now pushes everything.
    if (had && had !== url) {
      const refs = await git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]);
      for (const ref of refs.stdout.split("\n").filter(Boolean)) await git(dir, ["update-ref", "-d", ref]);
    }
  });
}

/** An identity for the commit when the repo (or the user's global config) has none. */
async function identityEnv(dir: string): Promise<Record<string, string>> {
  const email = (await git(dir, ["config", "user.email"])).stdout.trim();
  if (email) return {};
  return { GIT_AUTHOR_NAME: "Sova", GIT_AUTHOR_EMAIL: "sova@localhost", GIT_COMMITTER_NAME: "Sova", GIT_COMMITTER_EMAIL: "sova@localhost" };
}

export interface CommitOutcome {
  committed: boolean;
  sha?: string;
  pushed?: boolean;
  error?: string;
}

/**
 * Stage everything and commit with `message` when anything changed, then push to `origin` if set.
 * Nothing to commit is not an error. Never throws: the outcome says what happened.
 */
export function commitAll(dir: string, message: string): Promise<CommitOutcome> {
  return serial(dir, async () => {
    const out: CommitOutcome = { committed: false };
    try {
      const add = await git(dir, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
      const staged = await git(dir, ["diff", "--cached", "--quiet"]);
      if (staged.code === 0) {
        // Nothing new, but the remote may lack commits (one just set, or commits made without it):
        // push them. Only Commit Now gets here; the committer calls this only with changes.
        if ((await remoteOf(dir)) && (await unpushed(dir))) {
          const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
          if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
          out.pushed = true;
        }
        lastErrors.set(dir, null);
        return out;
      }
      const commit = await git(dir, ["commit", "-q", "--no-verify", "-m", message], await identityEnv(dir));
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      out.committed = true;
      out.sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      if (await remoteOf(dir)) {
        const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
        if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
        out.pushed = true;
      }
      lastErrors.set(dir, null);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      lastErrors.set(dir, out.error);
      console.warn(`[workspace] ${out.error}`);
    }
    return out;
  });
}

/** Whether HEAD has commits `origin` lacks, going by the remote-tracking branch (no network):
    none known for this branch counts as all of them. False without a commit or on a detached HEAD. */
async function unpushed(dir: string): Promise<boolean> {
  const branch = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branch.code !== 0 || (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).code !== 0) return false;
  const ref = `refs/remotes/origin/${branch.stdout.trim()}`;
  if ((await git(dir, ["rev-parse", "-q", "--verify", ref])).code !== 0) return true;
  const ahead = await git(dir, ["rev-list", "--count", `${ref}..HEAD`]);
  return ahead.code === 0 && Number(ahead.stdout.trim()) > 0;
}

/** The paths `git status` reports as changed (tracked or not), or [] when clean or not a repo. */
export async function changedPaths(dir: string): Promise<string[]> {
  const r = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (r.code !== 0) return [];
  // -z: "XY path\0", a rename adds its source as the next field; keep the destinations.
  const out: string[] = [];
  const fields = r.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    out.push(f.slice(3));
    if (f[0] === "R" || f[0] === "C") i++;
  }
  return out;
}

/** When HEAD was committed (ms), or null when the repo has no commit yet. */
export async function headCommitMs(dir: string): Promise<number | null> {
  const r = await git(dir, ["log", "-1", "--format=%ct"]);
  const s = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

/** Push HEAD to `origin` again after a failed push, when nothing new was committed since. */
export function retryPush(dir: string): Promise<CommitOutcome> {
  return serial(dir, async () => {
    const out: CommitOutcome = { committed: false };
    if (!lastErrors.get(dir)?.startsWith("git push failed") || !(await remoteOf(dir))) return out;
    const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
    if (push.code !== 0) {
      out.error = `git push failed: ${push.stderr.trim()}`;
      lastErrors.set(dir, out.error);
      return out;
    }
    out.pushed = true;
    lastErrors.set(dir, null);
    return out;
  });
}

/** Everything the org page shows about the repo's git state. */
export async function gitStatus(dir: string): Promise<OrgGitStatus> {
  const [remote, log, porcelain] = await Promise.all([
    remoteOf(dir),
    git(dir, ["log", "-1", "--format=%h%x00%cI%x00%s"]),
    git(dir, ["status", "--porcelain"]),
  ]);
  const [sha, at, message] = log.code === 0 ? log.stdout.trim().split("\0") : [];
  return {
    remote,
    lastCommit: sha && at ? { sha, at, message: message ?? "" } : null,
    lastError: lastErrors.get(dir) ?? null,
    dirty: porcelain.code === 0 && porcelain.stdout.trim().length > 0,
  };
}

/** Whether `dir` is ignored by the git repo at `repo` (for the "never inside Sova" rule). */
export async function isIgnoredBy(repo: string, dir: string): Promise<boolean> {
  return (await git(repo, ["check-ignore", "-q", "--no-index", dir])).code === 0;
}

/** Whether `dir` is inside a git work tree (a Sova install may be a plain copy, not a checkout). */
export async function isInGitWorkTree(dir: string): Promise<boolean> {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Wait for every queued job of `dir` (tests). */
export const settled = (dir: string): Promise<unknown> => queues.get(dir) ?? Promise.resolve();
