// Tests only. RetireDeps on the real git, the real process scan and the real shared answer, with no chats and no copies:
// the coast is clear, an hour ahead so nothing is brand new. For a test that wants the pass's own reading, unsteered.
import { join } from "node:path";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { git } from "./merge-queue/testing/repo";
import { branchLeft, openQueueEntry } from "./nothing-left";
import { appendLedger, markLedger, readLedger } from "./removed-worktrees";
import { classifyRepo, pidAlive, scanProcesses } from "./worktree-cleanup";
import type { RetireDeps } from "./worktree-retire";
import { execGit } from "./worktrees";

export function plainRetireDeps(o: { project: string; target: string; state: string }): RetireDeps {
  const ledgerFile = join(o.state, "removed-worktrees.json");
  const targetOf = async (main: string) => ({ name: o.target, oid: git(main, ["rev-parse", o.target]) });
  const later = Date.now() + 3_600_000;
  return {
    allowed: () => ({ on: true }),
    repos: () => [o.project],
    git: execGit,
    gitWrite: runGit,
    gitRemove: runGit,
    classify: (root, only) => classifyRepo(root, { git: execGit, withQueueMade: true, ...(only ? { only } : {}) }),
    chats: async () => ({ uses: [], unreadable: [] }),
    records: async () => ({ records: [], unreadable: [] }),
    processes: () => scanProcesses(),
    alive: pidAlive,
    openEntry: (root, branch) => openQueueEntry(root, branch),
    draftsUnproved: async (main, folder, branch) => {
      const tip = branch ? await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main }) : null;
      const target = await targetOf(main);
      return (await branchLeft({ root: main, folder, ...(branch ? { branch } : {}), head: tip?.code === 0 ? tip.stdout.trim() : target.oid, target })).drafts;
    },
    branchFinished: async (main, branch) => {
      const tip = await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main });
      if (tip.code !== 0) return false;
      const left = await branchLeft({ root: main, branch, head: tip.stdout.trim(), target: await targetOf(main) });
      return !left.code.left && left.code.kind !== "unknown";
    },
    copies: { of: () => null, teardown: async () => {} },
    ledger: () => readLedger(ledgerFile),
    appendLedger: (add) => appendLedger(add, ledgerFile),
    markLedger: (m, patch) => markLedger(m, patch, ledgerFile),
    removed: async () => {},
    now: () => later,
    deleteBranches: () => true,
    pendingFile: () => join(o.state, "retire-pending.json"),
  };
}
