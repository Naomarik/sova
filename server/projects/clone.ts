import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { RegistryError } from "./registry";

/**
 * Clone from GitHub (§app/projects): `git clone` by argv (no shell, `--` before the URL) into a new
 * folder under a chosen parent, with a timeout and git's own credentials (no prompt: a private repo
 * git can't reach fails instead of waiting). An existing destination is refused; on failure only the
 * folder this clone created is deleted. Operator only: the route checks localRequest. Registration of
 * the clone is the folder path's.
 */

export const CLONE_TIMEOUT_MS = 10 * 60_000;
const STDERR_MAX = 4_000;

export interface CloneRequest {
  repo: unknown;
  parent: unknown;
  folder?: unknown;
  timeoutMs?: number;
}

/** The folder name a repository URL clones into: its last path segment without `.git`. */
export function folderOfRepo(repo: string): string {
  const last = basename(repo.replace(/[/\\]+$/, "").replace(/^.*:/, "")).replace(/\.git$/, "");
  return last;
}

const FOLDER = /^(?!\.{1,2}$)[^/\\\0]{1,200}$/;

/** A URL git may clone: https, ssh, git@host:path or file:// (the automated runs use file://). */
function repoProblem(repo: string): string | null {
  if (!repo || repo.length > 2_000 || /[\0\n\r]/.test(repo)) return "repo must be a repository URL";
  if (repo.startsWith("-")) return "repo must be a repository URL";
  if (/^(https?|ssh|git|file):\/\//.test(repo) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(repo)) return null;
  return "repo must be a repository URL (https://…, ssh://…, git@host:owner/repo or file://…)";
}

/** Clone `repo` into `<parent>/<folder>`; resolves to the new folder, or throws a RegistryError. */
export async function cloneRepo(req: CloneRequest): Promise<{ dir: string }> {
  const repo = typeof req.repo === "string" ? req.repo.trim() : "";
  const why = repoProblem(repo);
  if (why) throw new RegistryError(why);
  const parent = typeof req.parent === "string" ? req.parent.trim() : "";
  if (!parent || !isAbsolute(parent)) throw new RegistryError("parent must be an absolute folder path");
  try {
    if (!statSync(parent).isDirectory()) throw new Error();
  } catch {
    throw new RegistryError(`${parent} isn't a folder`);
  }
  const folder = typeof req.folder === "string" && req.folder.trim() ? req.folder.trim() : folderOfRepo(repo);
  if (!FOLDER.test(folder)) throw new RegistryError("folder must be a plain folder name");
  const dest = join(resolve(parent), folder);
  if (existsSync(dest) || isLink(dest)) throw new RegistryError(`${dest} already exists; pick another folder name`, 409);

  // Create the folder ourselves so a failure deletes exactly what this clone made (mkdir without
  // `recursive` fails when another writer took the name in between).
  try {
    mkdirSync(dest);
  } catch (err) {
    throw new RegistryError(`Sova can't create ${dest} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    await runClone(repo, dest, req.timeoutMs ?? CLONE_TIMEOUT_MS);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return { dir: dest };
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function runClone(repo: string, dest: string, timeoutMs: number): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("git", ["clone", "--quiet", "--", repo, dest], {
      stdio: ["ignore", "ignore", "pipe"],
      // git's own credentials (helpers, ssh agent) work; a prompt never blocks the clone.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(new RegistryError(`git clone could not start (${err.message})`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return done();
      const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      fail(new RegistryError(signal ? `git clone timed out after ${Math.round(timeoutMs / 1000)} s` : `git clone failed${tail ? `: ${tail}` : ""}`));
    });
  });
}
