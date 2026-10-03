// Archiving with worktree cleanup (§app.overseer/tools, `sova_archive` with `worktrees: "remove"`):
// the git worktrees a session tracks (its `worktrees` entry, read by the worktrees extension's own
// fold, server/worktrees-state.ts) that it created or attached itself go, after it is archived,
// through the cleanup service's own check and removal (server/worktree-cleanup.ts `removeTrees`,
// §chat.worktrees/cleanup), the same code as the Clean Up Merged button: only merged or empty trees
// are removed, every refusal is the service's, and the archived session itself counts for none of
// them. A tree that may go has its running copy torn down first (project services); a copy that
// can't be torn down keeps it. A session with uncommitted changes in any of them is refused before
// anything changes.
import { existsSync } from "node:fs";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import type { TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { uncommitted } from "./project-worktrees";
import { besideGone } from "./removed-worktrees";
import { checkTrees, removeTrees } from "./worktree-cleanup";
import { worktreesOf } from "./worktrees-state";

/** What a session's cleanup would act on, read before it is archived. */
export interface WorktreePlan {
  /** The session archived: left out of the service's session checks. */
  session: { id: string; path: string };
  /** The trees it created or attached itself (not detached): the ones offered for removal. */
  own: TrackedWorktree[];
  /** Trees it inherited from another session: left as they are. */
  inherited: TrackedWorktree[];
  /** Each own tree with uncommitted changes, as "<path> (<n> files, e.g. <file>)": any refuses the session. */
  dirty: string[];
}

export interface ArchiveWorktrees {
  plan(session: { id: string; path: string }): Promise<WorktreePlan>;
  /** Check and remove the plan's own trees; one line per tree (and per inherited one), for the tool's result. */
  remove(plan: WorktreePlan, cwd?: string): Promise<string[]>;
}

/** Tear down the running copy of a worktree, if any (throws with the reason): server/project-services/checkout-teardown.ts. */
export type CopyTeardown = (path: string) => Promise<unknown>;
const realTeardown: CopyTeardown = async (path) => (await import("./project-services/checkout-teardown")).teardownCopyOf(path);

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "git failed";

/** A service reason as the tool's line words it: "kept, not merged into master". */
const keptWords = (reason: string): string => `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`.replace(/\.$/, "");

export function archiveWorktrees(readBranch: (path: string) => Promise<readonly unknown[]>, git: Git = runGit, teardown: CopyTeardown = realTeardown): ArchiveWorktrees {
  return {
    async plan(session) {
      const trees = (worktreesOf(await readBranch(session.path))?.trees ?? []).filter((t) => t.status !== "dropped");
      const own = trees.filter((t) => t.session === session.id);
      const inherited = trees.filter((t) => t.session !== session.id);
      const dirty: string[] = [];
      for (const t of own) {
        if (!existsSync(t.path)) continue;
        const files = await uncommitted(git, t.path);
        if (files.length) dirty.push(`${t.path} (${files.length} file${files.length === 1 ? "" : "s"}, e.g. ${files[0]})`);
      }
      return { session: { id: session.id, path: session.path }, own, inherited, dirty };
    },
    async remove(plan, cwd) {
      const lines: string[] = [];
      for (const t of plan.own) {
        // Any folder of its repository: the tree itself, the session's, or one beside a gone tree.
        const dir = [t.path, cwd ?? "", ...besideGone(t.path)].find((d) => d && existsSync(d));
        const gone = !existsSync(t.path);
        // The service's checks first (its own running copy aside), so a tree that stays keeps its copy too.
        const pre = dir ? await checkTrees(dir, [t.path], { exclude: plan.session.path, ignoreProcesses: true }).catch(() => null) : null;
        const stays = pre?.get(t.path);
        if (pre && stays) {
          lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${keptWords(stays)}`);
          continue;
        }
        // Its running copy goes next (§app.overseer/tools); one that can't be torn down keeps the worktree.
        if (pre) {
          try {
            await teardown(t.path);
          } catch (err) {
            lines.push(`  - worktree ${t.path} (${t.branch}): kept, its running copy could not be torn down: ${firstLine((err instanceof Error ? err.message : String(err)).replace(/^Its running copy could not be torn down: /, ""))}`);
            continue;
          }
        }
        const r = dir ? await removeTrees(dir, [t.path], { exclude: plan.session.path }).catch((err: Error) => err) : null;
        if (r === null) lines.push(`  - worktree ${t.path} (${t.branch}): kept, its repository wasn't found`);
        else if (r === "busy") lines.push(`  - worktree ${t.path} (${t.branch}): kept, a cleanup of this repository is already running`);
        else if (r instanceof Error) lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${r.message.split("\n")[0]}`);
        else {
          const done = r.removed[0];
          const why = r.kept[0]?.reason ?? "not removed";
          if (!done) lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${keptWords(why)}`);
          else {
            const branch = !done.branch
              ? ""
              : done.branchDeleted
                ? `; branch ${done.branch} deleted (${done.kind === "empty" ? "no commits of its own" : "merged"})`
                : `; branch ${done.branch} kept (${done.kind === "content" ? "merged by content" : "git didn't delete it"})`;
            lines.push(`  - worktree ${t.path}: ${gone ? "already gone, dropped from git's list" : "removed"}${branch}`);
          }
        }
      }
      for (const t of plan.inherited) lines.push(`  - worktree ${t.path} (${t.branch}): left, it belongs to session ${t.session}`);
      if (!plan.own.length && !plan.inherited.length) lines.push("  - no worktrees to remove");
      return lines;
    },
  };
}
