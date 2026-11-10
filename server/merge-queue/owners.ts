import type { SessionSummary } from "../../shared/protocol";
import type { TrackedWorktree } from "../../pi-config/extensions/worktrees/state.ts";

/**
 * Which chat a worktree's branch belongs to: the one rule the Merge Queue tab's Ready rows show and Land
 * records (who hears about it), so the two never disagree.
 *
 * 1. the chat that created the worktree and still tracks it (its own `worktrees` record, not dropped), not archived;
 * 2. else the newest main chat working in its folder (cwd the folder or inside it), not archived;
 * 3. else the chat that runs the newest worker working there (up through workers of workers), not archived;
 * 4. else the same three, in that order, among archived chats, flagged `archived`;
 * 5. else none.
 * A worker is never the owner: wherever one turns up (it created the worktree, it works there) its top chat stands in
 * for it (SessionSummary.workerOf), and a worker with no known parent counts for nothing. The merge queue's own
 * chats (queueChat) never own a branch.
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
  /** The worktrees these chats' own files record as created by them, still kept (worktree-cleanup.ts createdByChats:
      a file is read again only when it changed). `tracked` covers only the sessions readiness reads, and it reads no
      queue chat, so what one created is asked of its file. `key` moves whenever any of their files changed. */
  createdBy?: (sessionPaths: readonly string[]) => Promise<{ key: string; trees: readonly string[] }>;
}

interface Tracker {
  sessionPath: string;
}

export class WorktreeOwners {
  private index: { version: number; byTree: Map<string, Tracker[]> } | null = null;
  /** The queue's own set (canonical), remembered while its key holds: the index's version, the queue chats and their files. */
  private made: { key: string; trees: ReadonlySet<string> } | null = null;
  /** How many times the index was built (tests). */
  builds = 0;
  constructor(private readonly deps: OwnerDeps) {}

  private trackers(tree: string): Tracker[] {
    return this.byTree().get(tree) ?? [];
  }

  private byTree(): Map<string, Tracker[]> {
    const t = this.deps.tracked();
    if (!this.index || this.index.version !== t.version) {
      const byTree = new Map<string, Tracker[]>();
      for (const [sessionPath, trees] of t.each())
        for (const w of trees) {
          // Only the chat that created it: one that attached an existing worktree doesn't own it.
          if (w.status === "dropped" || w.how !== "created") continue;
          const key = this.deps.canonical(w.path);
          const list = byTree.get(key) ?? [];
          if (!list.some((x) => x.sessionPath === sessionPath)) list.push({ sessionPath });
          byTree.set(key, list);
        }
      this.index = { version: t.version, byTree };
      this.builds++;
    }
    return this.index.byTree;
  }

  async ownerOf(worktree: string): Promise<Owner | null> {
    const sessions = await this.deps.sessions();
    const tree = this.deps.canonical(worktree);
    return pickOwner([tree, worktree], sessions, this.trackers(tree));
  }

  /** Whether one of the merge queue's own chats (queueChat) created the worktree: a conflict's scratch copy the merge
      thread made itself, before Sova made them (merge-queue/scratch.ts). Never anyone's work to land. */
  async queueMade(worktree: string): Promise<boolean> {
    return (await this.queueMadeNow())(worktree);
  }

  /** The answer to queueMade for any number of worktrees, from one look: a list asks this once, then each row. The set
      is built again only when a queue chat's file, the queue chats or the index changed; else the remembered one. */
  async queueMadeNow(): Promise<(worktree: string) => boolean> {
    const sessions = await this.deps.sessions();
    const queue = sessions.filter((s) => s.queueChat).map((s) => s.path);
    const byTree = this.byTree();
    const files = this.deps.createdBy ? await this.deps.createdBy(queue).catch(() => null) : null;
    const key = `${this.index!.version}\0${files?.key ?? "-"}\0${queue.join("\0")}`;
    if (this.made?.key !== key) {
      const ours = new Set(queue);
      const trees = new Set<string>();
      for (const [tree, list] of byTree) if (list.some((t) => ours.has(t.sessionPath))) trees.add(tree);
      for (const p of files?.trees ?? []) trees.add(this.deps.canonical(p));
      this.made = { key, trees };
    }
    const trees = this.made.trees;
    return (worktree) => trees.has(this.deps.canonical(worktree));
  }
}

const active = (s: SessionSummary) => Date.parse(s.lastActiveAt) || 0;
const newest = (a: SessionSummary, b: SessionSummary) => active(b) - active(a);

/** Workers of workers this deep at most: past it the chain is taken as broken. */
const MAX_HOPS = 8;

/** The chat that runs `s`, up through workers of workers; `s` itself for a main chat; null: a worker with no known
    parent, a broken chain, or one of the queue's own chats. */
export function topChat(s: SessionSummary, byPath: ReadonlyMap<string, SessionSummary>): SessionSummary | null {
  let cur: SessionSummary | undefined = s;
  for (let hops = 0; cur?.workerSession; hops++) cur = hops < MAX_HOPS && cur.workerOf ? byPath.get(cur.workerOf.path) : undefined;
  return cur && !cur.queueChat ? cur : null;
}

/** The rule above, over a session list and the worktree's trackers. `folders`: the worktree's path as
    git lists it and canonical (a chat's cwd is compared to both, never resolved: no file system call per chat). */
export function pickOwner(folders: readonly string[], sessions: readonly SessionSummary[], trackers: readonly Tracker[]): Owner | null {
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const up = (list: readonly SessionSummary[]) => list.map((s) => topChat(s, byPath)).filter((s): s is SessionSummary => !!s);
  const tracking = up(
    trackers
      .map((t) => byPath.get(t.sessionPath))
      .filter((s): s is SessionSummary => !!s)
      .sort(newest),
  );
  const inTree = (s: SessionSummary) => !s.target && !s.queueChat && folders.some((f) => s.cwd === f || s.cwd.startsWith(`${f}/`));
  const inside = sessions.filter(inTree).sort(newest);
  const mains = inside.filter((s) => !s.workerSession);
  const workersUp = up(inside.filter((s) => s.workerSession));
  const order = [...tracking, ...mains, ...workersUp];
  const pick = order.find((s) => !s.archived);
  if (pick) return { session: pick.id };
  // Only archived ones are left: the creating chat first, then the newest main chat in the folder, then a worker's chat.
  const old = order[0];
  return old ? { session: old.id, archived: true } : null;
}
