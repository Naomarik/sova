// Where a stored session opens when its local working directory is gone (§app.shell/missing-folder-home).
// Pure apart from the one stat: what a folder is now, and the note the agent is given.
import { statSync } from "node:fs";
import type { CwdFallback } from "../shared/protocol";

export type { CwdFallback };

/**
 * What a folder is now. `missing`: genuinely absent (ENOENT: it, or a link to it, is gone; ENOTDIR:
 * a parent is no longer a folder). `unreachable`: it may well be there, but this user can't reach it
 * (EACCES, EPERM, ELOOP, an I/O error, …): never treated as missing.
 */
export type FolderProbe = { state: "present" } | { state: "missing" } | { state: "unreachable"; code: string };

export function probeFolder(dir: string): FolderProbe {
  try {
    statSync(dir);
    return { state: "present" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "unreachable", code };
  }
}

/** The agent's system prompt note while its chat runs in the home folder instead of its own. */
export function cwdFallbackNote(f: CwdFallback): string {
  return [
    "# Working directory notice",
    "",
    `This session was started in ${f.original}, and that folder no longer exists on this machine (it was deleted or moved).`,
    `The session now runs in the home folder, ${f.cwd}: that is your working directory, and every tool runs there.`,
    `Earlier messages in this conversation describe files, a repository and a state in ${f.original} that may no longer exist.`,
    "Don't assume that repository or its files are still there: check before you rely on them, and say so when you can't find them.",
  ].join("\n");
}
