import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../test-scratch";

/**
 * Tests only: a stand-in for Sova's repository (`origin`, a plain git repository with numbered
 * release tags and the moving `stable` tag) and checkouts of it, under a scratch root. Local git
 * only: no network, no other program.
 */
export interface Repos {
  root: string;
  origin: string;
  /** The origin as a URL (`file://`), so a shallow clone works. */
  url: string;
  git(dir: string, ...args: string[]): string;
  /** A commit on `dir`'s current branch, touching `file`: its sha. */
  commit(dir: string, message: string, file?: string): string;
  /** An annotated tag (moved when it exists). */
  tag(dir: string, name: string, at?: string): void;
  clone(name: string, opts?: { ref?: string; depth?: number }): string;
}

export function makeRepos(prefix = "sova-updates-"): Repos {
  const root = scratchRoot(prefix);
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=master", "-c", "advice.detachedHead=false", "-c", "protocol.file.allow=always", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "--quiet", "-b", "master");
  let n = 0;
  const commit = (dir: string, message: string, file = "file.txt") => {
    writeFileSync(join(dir, file), `${message} ${++n}\n`);
    git(dir, "add", file);
    git(dir, "commit", "--quiet", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const tag = (dir: string, name: string, at = "HEAD") => git(dir, "tag", "-f", "-a", name, "-m", name, at) as unknown as void;
  return {
    root,
    origin,
    url: `file://${origin}`,
    git,
    commit,
    tag,
    clone: (name, opts = {}) => {
      const to = join(root, name);
      git(root, "clone", "--quiet", ...(opts.depth ? ["--depth", String(opts.depth)] : []), ...(opts.ref ? ["--branch", opts.ref] : []), `file://${origin}`, to);
      return to;
    },
  };
}
