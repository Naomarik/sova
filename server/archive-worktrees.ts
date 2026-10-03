// Archiving with worktree cleanup (§app.overseer/tools, `sova_archive` with `worktrees: "remove"`):
// the git worktrees a session tracks (its `worktrees` entry, read by the worktrees extension's own
// fold, server/worktrees-state.ts) that it created or attached itself are removed after it is
// archived, by the same rules as a coding session's Remove Worktree (server/project-worktrees.ts
// `removeWorktree`): git's own `worktree remove`, the branch deleted only when merged. A session
// with uncommitted changes in any of them is refused before anything changes. Git by argv, never
// a shell, through the extension's own runner.
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import type { TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { removeWorktree, uncommitted } from "./project-worktrees";
import { worktreesOf } from "./worktrees-state";

/** What a session's cleanup would act on, read before it is archived. */
export interface WorktreePlan {
  /** The trees it created or attached itself (not detached): the ones removed. */
  own: TrackedWorktree[];
  /** Trees it inherited from another session: left as they are. */
  inherited: TrackedWorktree[];
  /** Each own tree with uncommitted changes, as "<path> (<n> files, e.g. <file>)": any refuses the session. */
  dirty: string[];
}

export interface ArchiveWorktrees {
  plan(session: { id: string; path: string }): Promise<WorktreePlan>;
  /** Remove the plan's own trees; one line per tree (and per inherited one), for the tool's result. */
  remove(plan: WorktreePlan, cwd?: string): Promise<string[]>;
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "git failed";

/** The main checkout of the repository `dir` belongs to: the folder holding its common git dir. */
async function repoRootOf(git: Git, dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  const common = r.code === 0 ? r.stdout.trim() : "";
  return common && basename(common) === ".git" ? dirname(common) : null;
}

/** Tear down the running copy of a worktree, if any (throws with the reason): server/project-services/checkout-teardown.ts. */
export type CopyTeardown = (path: string) => Promise<unknown>;
const realTeardown: CopyTeardown = async (path) => (await import("./project-services/checkout-teardown")).teardownCopyOf(path);

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
      return { own, inherited, dirty };
    },
    async remove(plan, cwd) {
      const lines: string[] = [];
      for (const t of plan.own) {
        const root = (await repoRootOf(git, t.path)) ?? (await repoRootOf(git, cwd ?? ""));
        if (!root) {
          lines.push(`  - worktree ${t.path} (${t.branch}): kept, its repository wasn't found`);
          continue;
        }
        const gone = !existsSync(t.path);
        // Its running copy goes first (§app.overseer/tools); one that can't be torn down keeps the worktree.
        try {
          await teardown(t.path);
        } catch (err) {
          lines.push(`  - worktree ${t.path} (${t.branch}): kept, its running copy could not be torn down: ${firstLine((err instanceof Error ? err.message : String(err)).replace(/^Its running copy could not be torn down: /, ""))}`);
          continue;
        }
        try {
          const target = t.merge?.target ?? t.baseBranch ?? "";
          const { branchDeleted } = await removeWorktree({ path: t.path, branch: t.branch, base: t.base, target }, root, git);
          lines.push(
            `  - worktree ${t.path}: ${gone ? "already gone, pruned from git's list" : "removed"}; branch ${t.branch} ${branchDeleted ? "deleted (merged)" : "kept (not merged, its commits stay)"}`,
          );
        } catch (err) {
          lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${firstLine(err instanceof Error ? err.message : String(err))}`);
        }
      }
      for (const t of plan.inherited) lines.push(`  - worktree ${t.path} (${t.branch}): left, it belongs to session ${t.session}`);
      if (!plan.own.length && !plan.inherited.length) lines.push("  - no worktrees to remove");
      return lines;
    },
  };
}
