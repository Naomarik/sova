import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { RegistryError } from "./registry";

/**
 * Clone from GitHub (§app/projects): a repository URL or GitHub's `owner/name`, `git clone` by argv (no shell, `--` before the URL) into a new
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
  return basename(repo.replace(/[/\\]+$/, "").replace(/^.*:/, "")).replace(/\.git$/, "");
}

const FOLDER = /^(?!\.{1,2}$)[^/\\\0]{1,200}$/;

const GITHUB_SHORT = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/** The URL git clones: `owner/name` is GitHub's https URL; anything else must already be a URL. */
export function repoUrlOf(repo: string): string {
  const m = GITHUB_SHORT.exec(repo);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : repo;
}

/** A URL git may clone: https, ssh, git@host:path or file:// (the automated runs use file://). */
function repoProblem(repo: string): string | null {
  if (!repo || repo.length > 2_000 || /[\0\n\r]/.test(repo)) return "repo must be a repository URL";
  if (repo.startsWith("-")) return "repo must be a repository URL";
  if (/^(https?|ssh|git|file):\/\//.test(repo) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(repo)) return null;
  return "repo must be a repository URL (https://…, ssh://…, git@host:owner/repo, file://…) or GitHub's owner/name";
}

/** A host that is this machine: a clone from it could copy a folder the Overseer may not read. */
const isLocalHost = (raw: string): boolean => {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "localhost.localdomain" || /^127\./.test(h) || h === "0.0.0.0" || h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1";
};

/**
 * The global Overseer's narrower rule (§app.overseer/org-project-add): https:// with no user or password, ssh://,
 * scp-style `user@host:path`, or GitHub's `owner/name` (already an https URL here); never file://, git://, http://,
 * ext::, a local path, or this machine. Applied by the route to a sender-marked request only.
 */
export function overseerRepoProblem(repo: string): string | null {
  const refused = "The Overseer clones only https:// (no user or password in the URL), ssh://, user@host:path or GitHub's owner/name.";
  if (!repo || repo.length > 2_000 || /[\0\n\r\s]/.test(repo) || repo.startsWith("-")) return refused;
  let host: string;
  if (/^(https|ssh):\/\//i.test(repo)) {
    let u: URL;
    try {
      u = new URL(repo);
    } catch {
      return refused;
    }
    if (u.protocol === "https:" && (u.username || u.password)) return "A repository URL with a user or password in it never goes through the Overseer: git's own credentials are used.";
    if (u.password) return refused;
    host = u.hostname;
  } else {
    const m = /^[\w.-]+@([\w.-]+):(?!\/\/)[^\s]+$/.exec(repo);
    if (!m) return refused;
    host = m[1]!;
  }
  if (!host || isLocalHost(host)) return "The Overseer never clones from this machine.";
  return null;
}

/** Clone `repo` into `<parent>/<folder>`; resolves to the new folder, or throws a RegistryError. `check`: run on
    the repository URL and the destination before anything is made (the Overseer's rule and pre-check). */
export async function cloneRepo(req: CloneRequest, check?: { repo?(url: string): string | null; dest?(dest: string): string | null }): Promise<{ dir: string }> {
  const repo = repoUrlOf(typeof req.repo === "string" ? req.repo.trim() : "");
  const why = check?.repo?.(repo) ?? repoProblem(repo);
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
  if (existsSync(dest) || isLink(dest)) throw new RegistryError(`${dest} already exists.`, 409);
  const destWhy = check?.dest?.(dest);
  if (destWhy) throw new RegistryError(destWhy);

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
