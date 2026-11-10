// Archiving with worktree cleanup (§app.overseer/tools, `sova_archive` with `worktrees: "remove"`):
// the git worktrees a session tracks (its `worktrees` entry, read by the worktrees extension's own
// fold, server/worktrees-state.ts) that it created or attached itself go, after it is archived,
// through the retirement service at once (server/worktree-retire.ts `retireNow`, §chat.worktrees/retirement)
// and its one removal step (§chat.worktrees/cleanup): only a tree with nothing left, or with no commits of
// its own, is removed, every refusal is the service's, and the archived session itself counts for none of
// them. A running copy is stopped by that same step; one that can't be stopped keeps the worktree. A
// session with uncommitted changes in any of them is refused before anything changes.
import { existsSync } from "node:fs";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import type { TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { uncommitted } from "./project-worktrees";
import { besideGone } from "./removed-worktrees";
import { retireNow } from "./worktree-retire";
import { archiveRemovalRefusal } from "./worktree-retire-gate";
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

/** One tree through the retirement service, at once (server/worktree-retire.ts `retireNow`). Tests swap it. */
export type RetireOne = (dir: string, path: string, exclude: string) => ReturnType<typeof retireNow>;

/** A service reason as the tool's line words it: "kept, not merged into master". */
const keptWords = (reason: string): string => `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`.replace(/\.$/, "");

/** Why this server may not remove the worktree (server/worktree-retire-gate.ts), or null. Tests swap it. */
export type RemovalRefusal = (path: string, commonDir: string | null) => string | null;

export function archiveWorktrees(readBranch: (path: string) => Promise<readonly unknown[]>, git: Git = runGit, retire: RetireOne = (dir, path, exclude) => retireNow(dir, path, exclude), refusal: RemovalRefusal = archiveRemovalRefusal): ArchiveWorktrees {
  /** Any folder of its repository: the tree itself, the session's, or one beside a gone tree. */
  const folderOf = (t: TrackedWorktree, cwd?: string): string | undefined => [t.path, cwd ?? "", ...besideGone(t.path)].find((d) => d && existsSync(d));
  /** A test copy keeps a worktree outside its own test data, whatever git says of it. Git's silence refuses. */
  const keptHere = async (t: TrackedWorktree, cwd?: string): Promise<string | null> => {
    const dir = folderOf(t, cwd);
    const cd = dir ? await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir).catch(() => null) : null;
    return refusal(t.path, cd?.code === 0 && cd.stdout.trim() ? cd.stdout.trim() : null);
  };
  return {
    async plan(session) {
      const trees = (worktreesOf(await readBranch(session.path))?.trees ?? []).filter((t) => t.status !== "dropped");
      const own = trees.filter((t) => t.session === session.id);
      const inherited = trees.filter((t) => t.session !== session.id);
      const dirty: string[] = [];
      for (const t of own) {
        if (!existsSync(t.path)) continue;
        // It stays whatever it holds, so it can't stop the session from being archived.
        if (await keptHere(t)) continue;
        const files = await uncommitted(git, t.path);
        if (files.length) dirty.push(`${t.path} (${files.length} file${files.length === 1 ? "" : "s"}, e.g. ${files[0]})`);
      }
      return { session: { id: session.id, path: session.path }, own, inherited, dirty };
    },
    async remove(plan, cwd) {
      const lines: string[] = [];
      for (const t of plan.own) {
        const refused = await keptHere(t, cwd);
        if (refused) {
          lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${refused}`);
          continue;
        }
        const dir = folderOf(t, cwd);
        const gone = !existsSync(t.path);
        const r = dir ? await retire(dir, t.path, plan.session.path).catch((err: Error) => err) : null;
        if (r === null) lines.push(`  - worktree ${t.path} (${t.branch}): kept, its repository wasn't found`);
        else if (r instanceof Error) lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${r.message.split("\n")[0]}`);
        else if (r.state === "kept") lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${keptWords(r.reason)}`);
        else if (r.state === "held") lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${keptWords(r.row.reason)}`);
        else if (r.state === "waiting") lines.push(`  - worktree ${t.path} (${t.branch}): kept, ${keptWords(r.row.why)}`);
        else if (r.state === "skip") lines.push(`  - worktree ${t.path} (${t.branch}): kept, it has work to land`);
        else {
          const row = r.row;
          const branch = !row.branch ? "" : row.branchDeleted ? `; branch ${row.branch} deleted (${row.merged === "empty" ? "no commits of its own" : "nothing left"}, its last commit kept)` : `; branch ${row.branch} kept`;
          lines.push(`  - worktree ${t.path}: ${gone ? "already gone, dropped from git's list" : "removed"}${branch}`);
        }
      }
      for (const t of plan.inherited) lines.push(`  - worktree ${t.path} (${t.branch}): left, it belongs to session ${t.session}`);
      if (!plan.own.length && !plan.inherited.length) lines.push("  - no worktrees to remove");
      return lines;
    },
  };
}
