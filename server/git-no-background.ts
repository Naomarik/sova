/**
 * The server's own git commands start no git background cleanup:
 * `git maintenance run --auto --detach`, started after a commit, a merge, a fetch or a push into a
 * local repository, runs in the server's process tree, outside git's own schedule, and is cut off
 * whenever that tree goes. Sova registers its projects with git's scheduled maintenance instead
 * (server/git-maintenance.ts).
 *
 * Per command, never in the server's environment: a GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS in
 * process.env turns the idle git cache off (server/worktrees.ts).
 */
import { join } from "node:path";
import { writeGitCleanupConfig } from "../pi-config/extensions/sandbox/env.ts";
import { agentRoot } from "./state-root";

/** The flags for a commit, a merge or a fetch. */
export const NO_BACKGROUND_CLEANUP: readonly string[] = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];

/** Sova's git system config (the machine's own, then maintenance.auto=false and gc.auto=0): what a
    chat process gets as GIT_CONFIG_SYSTEM, and a push below. */
export const gitCleanupConfigPath = (agentDir: string): string => join(agentDir, "sova", "git", "no-background-cleanup.gitconfig");

/**
 * The env for a push. Git drops `-c` (and GIT_CONFIG_COUNT/PARAMETERS) when it starts the receiving
 * side of a push into a local repository, whose receive-pack would then start a background cleanup
 * of its own; GIT_CONFIG_SYSTEM crosses. Empty when the file can't be written.
 */
export function noBackgroundCleanupEnv(): Record<string, string> {
  const file = gitCleanupConfigPath(agentRoot());
  return writeGitCleanupConfig(file, process.env) ? { GIT_CONFIG_SYSTEM: file, GIT_CONFIG_NOSYSTEM: "0" } : {};
}
