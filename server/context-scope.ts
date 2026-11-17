// Which of the context files pi finds a chat starts with: the agent folder's own, and those of the folders from the
// chat's folder up to its repository's top, never one at or above the home folder. pi itself reads every folder from
// the chat's typed folder up to `/` (server/harness/pi/QUIRKS.md, P44); this decides which of those folders count.
// An allowlist by folder: it only ever leaves files out, so a pi that finds more can't widen what loads.
// Harness-neutral and from the disk alone (no git program), the same walk the subfolder rule takes
// (server/skill-descent.ts). Applied in the pi adapter's funnel (server/harness/pi/resources.ts withContextScope).
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { real } from "./mcp/folder";

/** `dir` is `of` itself or a folder above it. */
export const atOrAbove = (dir: string, of: string): boolean => {
  const rel = relative(dir, of);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The home folder by its typed and its real path (a home reached through a link is the home). None for no home. */
export function homesOf(home: string): string[] {
  if (!home) return [];
  const typed = resolve(home);
  return [...new Set([typed, real(typed)])];
}

/** Whether `dir` is the home folder or a folder above it, by either of its paths. */
export const homeOrAbove = (dir: string, homes: readonly string[]): boolean => homes.some((h) => atOrAbove(dir, h));

/**
 * The nearest folder from `actual` (a real path) upward holding `.git` (a folder, or a worktree's or submodule's
 * file: each stops at its own top), never the home folder or a folder above it: the walk stops before them, so a
 * repository at home (dotfiles) makes no folder below it one. Null outside any repository below home; a repository
 * outside home altogether (`/srv/repo`) is found as any other. The one walk the context scope and the subfolder rule
 * (server/skill-descent.ts) share.
 */
export function gitTopBelowHome(actual: string, homes: readonly string[]): string | null {
  for (let dir = actual; !homeOrAbove(dir, homes); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
  return null;
}

export interface ScopeFacts {
  /** The home folder (handed in: Bun's homedir() ignores a later HOME change). */
  home: string;
  /** pi's settings folder: its own context file always loads. */
  agentDir: string;
}

/**
 * The folders (real paths) whose context file a chat in `cwd` may start with, besides the agent folder's: from its
 * folder up to its repository's top (gitTopBelowHome). Its own folder only outside any repository, and when it is the
 * home folder or a folder above it (by its typed or its real path), so the home folder's file loads only for a chat
 * there, never by climbing.
 */
export function contextFolders(cwd: string, home: string): Set<string> {
  const typed = resolve(cwd);
  const actual = real(typed);
  const homes = homesOf(home);
  const out = new Set<string>([actual]);
  if (homeOrAbove(typed, homes) || homeOrAbove(actual, homes)) return out;
  const top = gitTopBelowHome(actual, homes);
  if (!top) return out;
  for (let dir = actual; dir !== top; dir = dirname(dir)) out.add(dir);
  out.add(top);
  return out;
}

/** The test a chat in `cwd` keeps each of pi's context files by (absolute paths, as pi lists them): the agent
    folder's own, and any whose folder, by its real path, is one of contextFolders. */
export function contextFileKeeper(cwd: string, facts: ScopeFacts): (path: string) => boolean {
  const folders = contextFolders(cwd, facts.home);
  const agent = new Set([resolve(facts.agentDir), real(resolve(facts.agentDir))]);
  return (path: string) => {
    if (!isAbsolute(path)) return false;
    const dir = dirname(resolve(path));
    return agent.has(dir) || folders.has(real(dir));
  };
}
