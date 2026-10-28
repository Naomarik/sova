/**
 * Every folder that holds a project's code on this host besides its root: its git worktrees (git's
 * own list, and the folders Sova cuts beside the repository, `<parent>/.worktrees/<repo>-<name>`)
 * and the checkouts of its running copies (project-services instances). The project overseer's
 * read/grep/find/ls leave these out for another client's project, as they leave out its root.
 *
 * Git runs read-only: no optional lock, fsmonitor, hook or background cleanup, nothing from the
 * environment's GIT_* variables, a short timeout. A failure leaves only that project's git list
 * out (its Sova-cut folders and running copies are still found); it never throws.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NO_BACKGROUND_CLEANUP } from "./git-no-background";
import { readRegistry } from "./project-services/store";

/** No git location or config from outside, no prompt, no lazy fetch. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
}

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; sig: string; dirs: string[] }>();

/** What changes when a worktree is added or removed at a repository's top (`.git/worktrees`, else `.git`). */
function signature(root: string): string {
  for (const p of [join(root, ".git", "worktrees"), join(root, ".git")]) {
    try {
      return `${p}:${statSync(p).mtimeMs}`;
    } catch {}
  }
  return "";
}

/** git's worktrees of the repository `root` is in (the main one first), or [] when git can't say.
    Read again once `signature` changes, and at least every TTL_MS. */
function gitWorktrees(root: string): string[] {
  const sig = signature(root);
  const hit = cache.get(root);
  if (hit && hit.sig === sig && Date.now() - hit.at < TTL_MS) return hit.dirs;
  let dirs: string[] = [];
  try {
    const out = execFileSync(
      "git",
      ["--no-pager", "--no-optional-locks", ...NO_BACKGROUND_CLEANUP, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, "worktree", "list", "--porcelain", "-z"],
      { env: gitEnv(), encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 },
    );
    dirs = out.split("\0").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
  } catch {
    dirs = [];
  }
  cache.set(root, { at: Date.now(), sig, dirs });
  return dirs;
}

/** The folders Sova cuts for `top`'s worktrees, beside it (server/project-worktrees.ts worktreePathOf). */
function cutBeside(top: string): string[] {
  const dir = join(dirname(top), ".worktrees");
  const prefix = `${basename(top)}-`;
  try {
    return readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** `root`'s worktrees and running-copy checkouts, never `root` itself nor a folder `keep` is inside. */
export function projectCodeDirs(root: string, keep: string): string[] {
  const r = resolve(root);
  const git = gitWorktrees(r);
  const tops = [...new Set([r, ...(git[0] ? [resolve(git[0])] : [])])];
  let copies: string[] = [];
  try {
    copies = readRegistry().instances.filter((i) => resolve(i.project) === r).map((i) => i.checkout);
  } catch {
    copies = [];
  }
  // The main worktree may be a folder above `root` (a project in a repository's subfolder): only `root` of it is the project's.
  const linked = git.slice(1);
  const k = resolve(keep);
  const holdsKeep = (d: string) => k === d || k.startsWith(d.endsWith("/") ? d : `${d}/`);
  return [...new Set([...linked, ...tops.flatMap(cutBeside), ...copies].map((d) => resolve(d)))].filter((d) => d !== r && !holdsKeep(d));
}

export function clearProjectCodeDirsCache(): void {
  cache.clear();
}
