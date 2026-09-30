import { changedPaths, commitAll, type CommitOutcome } from "./workspace-git";

/**
 * The workspace repo's commit interval and message (§app.organizations/workspace-repo). The residence
 * statechart decides when to commit (every minute it looks; an hour since HEAD's commit, counting Commit
 * Now, a restart and other hosts' commits); its `commit` effect (server/org-effects.ts) names the
 * changed paths. On a graceful shutdown every repo with changes is committed, due or not.
 */

export const COMMIT_EVERY_MS = 3_600_000;
/** The interval: an hour, or SOVA_WORKSPACE_COMMIT_MS (a positive whole number; tests only). */
export function commitEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SOVA_WORKSPACE_COMMIT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : COMMIT_EVERY_MS;
}

export interface CommitTarget {
  id: string;
  dir: string;
}

/** "charts/, sessions/ (3 files)": the changed paths by their first segment, for the message. */
export function changeSummary(paths: string[]): string {
  const tops = new Map<string, number>();
  for (const p of paths) {
    const i = p.indexOf("/");
    const top = i >= 0 ? `${p.slice(0, i)}/` : p;
    tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const parts = [...tops.keys()].sort().map((t) => (t.endsWith("/") ? `${t} (${tops.get(t)} file${tops.get(t) === 1 ? "" : "s"})` : t));
  return parts.length > 6 ? `${parts.slice(0, 6).join(", ")}, …` : parts.join(", ");
}

/** Commit every repo with changes now, due or not (a graceful shutdown, after the runtimes' last writes). */
export async function flushWorkspaces(list: CommitTarget[], reason: string): Promise<CommitOutcome[]> {
  const out: CommitOutcome[] = [];
  for (const t of list) {
    const changed = await changedPaths(t.dir).catch(() => []);
    if (changed.length) out.push(await commitAll(t.dir, `Workspace changes (${reason}): ${changeSummary(changed)}`));
  }
  return out;
}
