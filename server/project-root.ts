import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { defaultRemoteOf, type RemoteCwd } from "./files";

/**
 * A session's project (§chat.profiles/projects): where its profiles and playbooks come from. A
 * folder inside a git checkout belongs to that repository's MAIN checkout (a linked worktree maps to
 * the checkout owning its git directory), so the main checkout, its worktrees and their subfolders
 * are one project. Any other local folder is its own project, never walked up. A relative or remote
 * cwd has none, decided lexically before any fs call (as server/files.ts decides it).
 */

export type ProjectOf =
  | { state: "ok"; root: string; name: string; git: boolean }
  | { state: "none" }
  | { state: "remote" | "missing"; message: string };

export interface ProjectDeps {
  /** The remote reading of a cwd (default: server/files.ts's, lexical). */
  remoteOf?: (path: string) => RemoteCwd | null;
}

const TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
const cache = new Map<string, { at: number; value: Promise<ProjectOf> }>();

/** Tests only. */
export function clearProjectCache(): void {
  cache.clear();
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
      done({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

const canonical = (p: string) => realpath(p).catch(() => resolve(p));

async function find(path: string): Promise<ProjectOf> {
  try {
    if (!(await stat(path)).isDirectory()) return { state: "missing", message: `${path} is not a folder` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" || code === "ENOTDIR" ? `${path} doesn't exist` : `Sova can't read ${path} (${code ?? "unknown error"})`;
    return { state: "missing", message };
  }
  const r = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], path);
  const [top, common] = r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()) : [];
  if (!top || !common) {
    const root = await canonical(path);
    return { state: "ok", root, name: basename(root) || root, git: false };
  }
  // The common dir of a non-bare repository is `<main checkout>/.git`; a worktree of a bare
  // repository has no main checkout, so its own top level stands in.
  const root = await canonical(basename(common) === ".git" ? dirname(common) : top);
  return { state: "ok", root, name: basename(root) || root, git: true };
}

/** The project of `rawCwd`, cached briefly per cwd. */
export function projectOf(rawCwd: string | undefined | null, deps: ProjectDeps = {}): Promise<ProjectOf> {
  if (rawCwd === undefined || rawCwd === null || rawCwd === "") return Promise.resolve({ state: "none" });
  if (!isAbsolute(rawCwd)) return Promise.resolve({ state: "missing", message: "cwd must be an absolute path" });
  const path = resolve(rawCwd);
  const remote = (deps.remoteOf ?? defaultRemoteOf)(path);
  if (remote) return Promise.resolve({ state: "remote", message: `This session's files live on ${remote.target}. Project profiles and playbooks are read from local folders only` });
  const hit = cache.get(path);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = find(path);
  cache.set(path, { at: now, value });
  return value;
}

/** The project root of `cwd`, or null when it has none. */
export async function projectRootOf(cwd: string | undefined | null): Promise<string | null> {
  const p = await projectOf(cwd);
  return p.state === "ok" ? p.root : null;
}
