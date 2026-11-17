// Whether a chat looks below its own folder at all: the subfolder instruction files
// (server/deeper-context.ts) and skills (server/subfolder-skills.ts) it is offered as it works, a typed
// `/skill:name` that names a subfolder's skill, and every walk that lists them (the Context tab, the
// approval list's scan, the setup file read). Decided from the chat's own folder alone, never the file a
// call touched. Harness-neutral and from the disk alone: no git program, so a tool result's hook can ask.
import { resolve } from "node:path";
import { real } from "./mcp/folder";
import { gitTopBelowHome, homeOrAbove, homesOf } from "./context-scope";

export interface DescentFacts {
  /** The home folder (handed in: Bun's homedir() ignores a later HOME change). */
  home: string;
  /** The folder belongs to a project added to Sova (its root, a folder inside it, or a worktree of it). */
  inProject: boolean;
}

/**
 * Descent is on for a chat in `cwd` only when its folder is inside a git repository whose top is below the home
 * folder (the top, any folder inside it, a worktree: a `.git` folder or file), or belongs to a project added to
 * Sova. It is always off in the home folder and every folder above it, a repository or a project there
 * included, by its typed and its real path alike (a home reached through a link is the home). The `.git` walk
 * stops before the home folder and never considers it or a folder above it: a repository at home (dotfiles)
 * makes no plain folder below it one.
 */
export function skillDescentAllowed(cwd: string, facts: DescentFacts): boolean {
  if (!cwd) return false;
  const typed = resolve(cwd);
  const actual = real(typed);
  const homes = homesOf(facts.home);
  if (homeOrAbove(typed, homes) || homeOrAbove(actual, homes)) return false;
  if (facts.inProject) return true;
  return gitTopBelowHome(actual, homes) !== null;
}

/** Whether a chat in `cwd` is in a project added to Sova, read in this process: the server's engines (a chat's
    own process opens none, so it hears the server's word with its open instead). False when it can't be told. */
export async function inProjectHere(cwd: string): Promise<boolean> {
  try {
    return (await import("./approvals")).projectForCwd(cwd) !== null;
  } catch {
    return false;
  }
}

/** The same for a chat of session file `path`: in `cwd` when its open gives one (a special chat's own folder),
    else its header's. */
export async function inProjectForSession(path: string, cwd?: string | null): Promise<boolean> {
  try {
    const at = cwd ?? (await (await import("./git-summary")).readStoredCwd(path));
    return at ? await inProjectHere(at) : false;
  } catch {
    return false;
  }
}
