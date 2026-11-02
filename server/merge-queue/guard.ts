import { execFile } from "node:child_process";

/** Small git helpers of the queue (the copy's own live in copy.ts; its guard against the state root too). */

// ---- git, small ---------------------------------------------------------------------------------

export type Git = (args: string[], cwd: string, opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realGit: Git = (args, cwd, opts = {}) =>
  new Promise((done) => {
    execFile("git", args, { cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The full sha `ref` names, or null. */
export async function revParse(git: Git, cwd: string, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export async function isAncestor(git: Git, cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", a, b], cwd)).code === 0;
}

export async function countBetween(git: Git, cwd: string, from: string, to: string): Promise<number> {
  const r = await git(["rev-list", "--count", `${from}..${to}`], cwd);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** Each worktree of the repo: path and branch (short), from `git worktree list --porcelain`. */
export async function worktreesOf(git: Git, root: string): Promise<{ path: string; branch: string | null; head: string | null }[]> {
  const r = await git(["worktree", "list", "--porcelain"], root);
  if (r.code !== 0) return [];
  const out: { path: string; branch: string | null; head: string | null }[] = [];
  let cur: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), branch: null, head: null };
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  if (cur) out.push(cur);
  return out;
}
