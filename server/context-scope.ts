// Which of the context files pi finds a chat starts with: the agent folder's own, and those of the folders from the
// chat's folder up to its repository's top, never one at or above the home folder. pi itself reads every folder from
// the chat's typed folder up to `/` (server/harness/pi/QUIRKS.md, P44); this decides which of those folders count.
// An allowlist by folder: it only ever leaves files out, so a pi that finds more can't widen what loads.
// Harness-neutral and from the disk alone (no git program), the same walk the subfolder rule takes
// (server/skill-descent.ts). Applied in the pi adapter's funnel (server/harness/pi/resources.ts withContextScope).
// A project's context files and skills are real files in the project: one whose real place lies outside the project's
// top (a link out of it) never loads (projectFileKeeper); the agent folder, whose files are links, is no project.
import { existsSync, lstatSync, realpathSync } from "node:fs";
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

/** `p` is `dir` or lies inside it. */
const atOrInside = (dir: string, p: string): boolean => atOrAbove(dir, p);

/** The top of the project a chat in `cwd` works in (a real path): its repository's top below home, else its own
    folder; null for a chat at the home folder or above it, which works in no project. */
export function projectTopOf(cwd: string, home: string): string | null {
  const typed = resolve(cwd);
  const actual = real(typed);
  const homes = homesOf(home);
  if (homeOrAbove(typed, homes) || homeOrAbove(actual, homes)) return null;
  return gitTopBelowHome(actual, homes) ?? actual;
}

/**
 * The test a project's context file or skill (an absolute path, as it was found) passes for a chat in `cwd`: an item
 * found inside the project (by its real top, or by a folder of the chat's typed path that is that top) loads only when
 * its own real place lies inside the project's top too, so a link out of the project (to home, to another folder) never
 * loads, while one that stays inside (CLAUDE.md -> AGENTS.md) does. Anything found elsewhere, the agent folder's
 * (whose files are links into the user's config) and every item of a chat with no project pass untouched. An item
 * inside the project whose real place can't be told (a dangling link) doesn't load.
 */
export function projectFileKeeper(cwd: string, facts: { home: string; agentDir?: string }): (path: string) => boolean {
  const top = projectTopOf(cwd, facts.home);
  if (!top) return () => true;
  const agent = facts.agentDir ? [resolve(facts.agentDir), real(resolve(facts.agentDir))] : [];
  // The project's top as the chat's typed path names it (a link to the repository), besides its real path.
  const tops = new Set([top]);
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (real(d) === top) tops.add(d);
    if (dirname(d) === d) break;
  }
  return (path: string) => {
    if (!isAbsolute(path)) return true;
    const p = resolve(path);
    if (agent.some((a) => atOrInside(a, p))) return true;
    if (![...tops].some((t) => atOrInside(t, p))) return true;
    let actual: string;
    try {
      actual = realpathSync(p);
    } catch {
      return !isLink(p); // nothing there loads nothing; a dangling link never loads
    }
    return atOrInside(top, actual);
  };
}

/** A path that is a link (dangling or not). */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
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
    folder's own, and any whose folder, by its real path, is one of contextFolders and that is a real file of the
    project (projectFileKeeper). */
export function contextFileKeeper(cwd: string, facts: ScopeFacts): (path: string) => boolean {
  const folders = contextFolders(cwd, facts.home);
  const agent = new Set([resolve(facts.agentDir), real(resolve(facts.agentDir))]);
  const inProject = projectFileKeeper(cwd, { home: facts.home });
  return (path: string) => {
    if (!isAbsolute(path)) return false;
    const dir = dirname(resolve(path));
    return agent.has(dir) || (folders.has(real(dir)) && inProject(path));
  };
}
