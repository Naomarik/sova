import type { SessionSummary } from "../../shared/protocol";
import type { TrackedWorktree } from "../../pi-config/extensions/worktrees/state.ts";

/**
 * Which chat a worktree's branch belongs to: the one rule the Merge Queue tab's Ready rows show and Land
 * records (who hears about it), so the two never disagree.
 *
 * 1. A chat that tracks the worktree (its `worktrees` records, created before attached), not archived;
 * 2. else the newest chat working in its folder (cwd the folder or inside it), not archived, a main chat
 *    before a worker;
 * 3. else the same two among archived chats, flagged `archived`.
 *
 * Who tracks what comes from the merge readiness reads' own records (merge-readiness.ts trackedWorktrees):
 * the index from it is rebuilt only when its `version` moves (a session's tracked set changed), so a view
 * polled every few seconds reads no transcript and rebuilds nothing.
 */

export interface Owner {
  /** The session id. */
  session: string;
  archived?: true;
}

export interface OwnerDeps {
  sessions: () => Promise<readonly SessionSummary[]>;
  tracked: () => { version: number; each(): Iterable<[string, readonly TrackedWorktree[]]> };
  /** A path's canonical form (symlinks resolved), as tracked paths are recorded. */
  canonical: (path: string) => string;
}

interface Tracker {
  sessionPath: string;
  created: boolean;
}

export class WorktreeOwners {
  private index: { version: number; byTree: Map<string, Tracker[]> } | null = null;
  /** How many times the index was built (tests). */
  builds = 0;
  constructor(private readonly deps: OwnerDeps) {}

  private trackers(tree: string): Tracker[] {
    const t = this.deps.tracked();
    if (!this.index || this.index.version !== t.version) {
      const byTree = new Map<string, Tracker[]>();
      for (const [sessionPath, trees] of t.each())
        for (const w of trees) {
          if (w.status === "dropped") continue;
          const key = this.deps.canonical(w.path);
          const list = byTree.get(key) ?? [];
          if (!list.some((x) => x.sessionPath === sessionPath)) list.push({ sessionPath, created: w.how === "created" });
          byTree.set(key, list);
        }
      this.index = { version: t.version, byTree };
      this.builds++;
    }
    return this.index.byTree.get(tree) ?? [];
  }

  async ownerOf(worktree: string): Promise<Owner | null> {
    const sessions = await this.deps.sessions();
    const tree = this.deps.canonical(worktree);
    return pickOwner([tree, worktree], sessions, this.trackers(tree));
  }
}

const active = (s: SessionSummary) => Date.parse(s.lastActiveAt) || 0;
const newest = (a: SessionSummary, b: SessionSummary) => active(b) - active(a);

/** The rule above, over a session list and the worktree's trackers. `folders`: the worktree's path as
    git lists it and canonical (a chat's cwd is compared to both, never resolved: no file system call per chat). */
export function pickOwner(folders: readonly string[], sessions: readonly SessionSummary[], trackers: readonly Tracker[]): Owner | null {
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const tracking = trackers
    .map((t) => ({ s: byPath.get(t.sessionPath), created: t.created }))
    .filter((t): t is { s: SessionSummary; created: boolean } => !!t.s)
    .sort((a, b) => Number(b.created) - Number(a.created) || newest(a.s, b.s))
    .map((t) => t.s);
  const inTree = (s: SessionSummary) => !s.target && folders.some((f) => s.cwd === f || s.cwd.startsWith(`${f}/`));
  const inside = sessions
    .filter(inTree)
    .sort((a, b) => Number(!!a.workerSession) - Number(!!b.workerSession) || newest(a, b));
  const live = (s: SessionSummary) => !s.archived;
  const pick = tracking.find(live) ?? inside.find(live);
  if (pick) return { session: pick.id };
  const old = tracking[0] ?? inside[0];
  return old ? { session: old.id, archived: true } : null;
}
