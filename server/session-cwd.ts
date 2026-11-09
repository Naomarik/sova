// Where a stored session opens when its local working directory is gone (§app.shell/missing-folder-home).
// Pure apart from the one stat: what a folder is now, and the note the agent is given.
import { statSync } from "node:fs";
import type { CwdFallback } from "../shared/protocol";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { heldPartialEntry, readLedger, retiredEntryCovering, type RemovedWorktree } from "./removed-worktrees";

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

/**
 * A fallback's facts for the banner, when the stored folder is in a retired worktree nothing has brought
 * back. Reads the ledger only: viewing never brings a folder back (§chat.worktrees/retirement).
 */
export function retiredFallbackFacts(original: string, ledger: () => readonly RemovedWorktree[] = readLedger): CwdFallback["retired"] | undefined {
  const e = retiredEntryCovering(ledger(), canonical(original));
  return e ? { branch: e.branch, target: e.target ?? "master" } : undefined;
}

/** Whether a folder that's there is what's left of a retired worktree, still held: a chat opens in the home folder instead. */
export function inHeldPartialFolder(dir: string, ledger: () => readonly RemovedWorktree[] = readLedger): boolean {
  return heldPartialEntry(ledger(), canonical(dir)) !== null;
}

/** The agent's system prompt note while its chat runs in the home folder instead of its own. */
export function cwdFallbackNote(f: CwdFallback): string {
  return [
    "# Working directory notice",
    "",
    f.held
      ? `This session was started in ${f.original}. Its worktree was retired, but files stayed in that folder and Sova hasn't proved them safe to delete, so nothing runs there for now. Once it has, a message brings the worktree back, fresh from its target.`
      : f.retired
      ? `This session was started in ${f.original}. Its worktree was retired after ${f.retired.branch} landed, so that folder doesn't exist right now. Your next message brings it back, fresh from ${f.retired.target}.`
      : `This session was started in ${f.original}, and that folder no longer exists on this machine (it was deleted or moved).`,
    `The session now runs in the home folder, ${f.cwd}: that is your working directory, and every tool runs there.`,
    `Earlier messages in this conversation describe files, a repository and a state in ${f.original} that may no longer exist.`,
    "Don't assume that repository or its files are still there: check before you rely on them, and say so when you can't find them.",
  ].join("\n");
}
