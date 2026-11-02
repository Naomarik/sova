import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_FILE_NAME } from "../../pi-config/extensions/worktrees/landing.ts";
import { stateRoot } from "../state-root";
import type { MergeQueueView, WorktreeMergeProject, WorktreeMergeStats, WorktreeQueueInfo } from "../../shared/merge-queue";
import type { RunMerge, ThreadEvent, WakeThread } from "./contract";
import { startIngest } from "./ingest";
import { notifier } from "./notices";
import { MergeQueues } from "./queue";
import { merger, recordedRoots } from "./routes";
import { countBetween, realGit, revParse } from "./guard";
import { engineServices, makeRunMerge } from "./run";
import { worktreeQueueInfo } from "./view";

/**
 * The server's merge queue: its queues (every project with records loaded and recovered at start), the `merge.*`
 * verbs on the project engine, the typed go-ahead door (landing.json), the feed event, the notices, the merge
 * thread's wake and the review step's verdicts. Called once at server start (server/index.ts).
 */

let queues: MergeQueues | null = null;
type RowFields = { queue?: WorktreeQueueInfo; mergeProject?: WorktreeMergeProject; mergeStats?: WorktreeMergeStats };
let rowsOf: ((path: string, branch: string) => Promise<RowFields>) | null = null;

/** A worktree row's queue fields (SessionWorktreeInfo.queue / mergeProject): only for a registered project's repo. */
export async function worktreeQueueOf(path: string, branch: string): Promise<RowFields> {
  if (!rowsOf) return {};
  try {
    return await rowsOf(path, branch);
  } catch {
    return {};
  }
}
let ingest: { poke(): void; stop(): void } | null = null;

export function mergeQueues(): MergeQueues | null {
  return queues;
}

/** Whether `target` of the project at `root` lands only through its merge queue (the queue is set up and lands
 *  into that branch). A direct merge into it is refused then. False while the queue isn't started. */
export async function queueManages(root: string, target: string): Promise<boolean> {
  if (!queues) return false;
  const q = await queues.get(root);
  return q.target === target && (await q.declared()).checks !== "unset";
}

/** Tests only: stand a set of queues in for the server's (null: none). */
export function setMergeQueuesForTest(q: MergeQueues | null): void {
  queues = q;
}

/** Tell the typed go-ahead door to look now (the worktree tool just wrote one). */
export function pokeMergeIngest(): void {
  ingest?.poke();
}

/** `request`: Sova's own routes in-process (app.request), for the merge thread's and the reviewer's chats. */
const statsCache = new Map<string, WorktreeMergeStats | null>();
/** The branch against the target: commits ahead and lines +/−, cached per (target head, branch head). */
export async function statsOf(root: string, targetHead: string, branch: string): Promise<WorktreeMergeStats | null> {
  if (!targetHead) return null;
  const head = await revParse(realGit, root, `refs/heads/${branch}`);
  if (!head) return null;
  const key = `${root}\0${targetHead}\0${head}`;
  if (statsCache.has(key)) return statsCache.get(key)!;
  const ahead = await countBetween(realGit, root, targetHead, head);
  const short = await realGit(["diff", "--shortstat", `${targetHead}...${head}`], root);
  const added = Number(/(\d+) insertion/.exec(short.stdout)?.[1] ?? 0);
  const removed = Number(/(\d+) deletion/.exec(short.stdout)?.[1] ?? 0);
  const out = short.code === 0 ? { head, ahead, added, removed } : null;
  if (statsCache.size > 500) statsCache.clear();
  statsCache.set(key, out);
  return out;
}

export async function startMergeQueue(opts: { request?: (path: string, init?: RequestInit) => Response | Promise<Response> } = {}): Promise<void> {
  if (queues) return;
  const base = join(stateRoot(), "merge-queue");
  const [{ projectEngine }, { publishFeed }, { projectOf }, { definitionAt }, { draftsHash }, { listProjects }, checks, threadMod, review] = await Promise.all([
    import("../project-services/routes"),
    import("../session-feed"),
    import("../project-root"),
    import("../project-services/deploy-recipe"),
    import("../spec-drafts-state"),
    import("../projects/spaces"),
    import("./checks"),
    import("./thread"),
    import("./review-step"),
  ]);
  const runMerge: RunMerge = makeRunMerge({ state: stateRoot(), services: engineServices(projectEngine()) });
  const projectIdOf = (root: string): string | null => {
    try {
      return listProjects().find((p) => p.root === root)?.id ?? null;
    } catch {
      return null;
    }
  };
  if (opts.request) {
    await threadMod.startMergeThread(opts.request);
    const { startMergeReviewer } = await import("./reviewer");
    await startMergeReviewer(opts.request);
  }
  // Sova's own project keeps the merge round's names file until it has its own.
  const self = await projectOf(fileURLToPath(new URL("../..", import.meta.url)));
  const legacyNames = self.state === "ok" ? { root: self.root, file: join(stateRoot(), "merge-round.json") } : undefined;
  const sendTo = async (session: string, text: string): Promise<void> => {
    const [{ listSessions }, { sendToSession }] = await Promise.all([import("../sessions-index"), import("../session-offers")]);
    const s = (await listSessions()).find((x) => x.id === session);
    if (!s) throw new Error(`no session ${session}`);
    await sendToSession(s.path, text);
  };
  const thread: WakeThread = (ev: ThreadEvent) => {
    const keeper = threadMod.mergeThread();
    const entry = { id: ev.entry.id, branch: ev.entry.branch, commit: ev.entry.commit, target: ev.entry.target };
    const mapped =
      ev.kind === "queued"
        ? { kind: "queued" as const, entry }
        : ev.kind === "conflict"
          ? { kind: "conflict" as const, entry, run: ev.run ?? "", files: ev.files ?? [] }
          : ev.kind === "failed"
            ? { kind: "failed" as const, entry, run: ev.run ?? "", ...(ev.why ? { summary: ev.why } : {}) }
            : ev.kind === "paused"
              ? { kind: "paused" as const, why: ev.why ?? "paused" }
              : ev.kind === "names"
                ? { kind: "names" as const, file: ev.namesFile ?? "", target: ev.target }
                : null;
    if (!mapped) return false;
    if (!threadMod.hasMergeThread()) return false;
    keeper.notify(ev.root, mapped as Parameters<typeof keeper.notify>[1]);
    return true;
  };
  queues = new MergeQueues({
    base,
    runMerge,
    checksOf: checks.checksOf,
    definitionAt: (root, ref) => definitionAt(root, ref),
    projectIdOf,
    publish: (view: MergeQueueView) => publishFeed({ type: "merge_queue", project: view.project, view }),
    notify: notifier({ send: sendTo }),
    thread,
    draftsHash: (dir) => draftsHash(dir),
    threadOf: (root) => (threadMod as { threadOf?: (r: string) => { session: string; startedAt: string } | null }).threadOf?.(root) ?? null,
    ...(legacyNames ? { legacyNames } : {}),
  });
  const q = queues;
  projectEngine().merger = merger({
    queues: q,
    rootOf: async (path) => {
      const p = await projectOf(path);
      return p.state === "ok" && p.git ? p.root : null;
    },
    isThreadChat: (root, sid) => threadMod.mergeThread().isThreadChat(root, sid),
    reviewerOf: review.reviewerOf,
    deliverReview: review.deliverReview,
  });
  rowsOf = async (path, branch) => {
    const p = await projectOf(path);
    if (p.state !== "ok" || !p.git) return {};
    const id = projectIdOf(p.root);
    if (!id) return {};
    const v = await (await q.get(p.root)).cachedView();
    const queue = worktreeQueueInfo(v, branch);
    const stats = await statsOf(p.root, v.heads.target, branch);
    return { ...(queue ? { queue } : {}), mergeProject: { id, root: p.root, target: v.target, checks: v.checks, review: v.review, ...(v.paused ? { paused: v.paused.why } : {}) }, ...(stats ? { mergeStats: stats } : {}) };
  };
  for (const root of recordedRoots(base)) void q.get(root).catch((err) => console.warn(`[merge-queue] ${root}: ${err instanceof Error ? err.message : err}`));
  ingest = startIngest({
    file: join(stateRoot(), LANDING_FILE_NAME),
    seenFile: join(base, "ingest.json"),
    roots: () => {
      let roots: string[] = [];
      try {
        roots = listProjects().map((p) => p.root);
      } catch {}
      return [...new Set([...roots, ...recordedRoots(base)])];
    },
    queue: (root) => q.get(root),
    refused: (session, text) => void sendTo(session, text).catch(() => {}),
  });
}

export async function stopMergeQueue(): Promise<void> {
  rowsOf = null;
  ingest?.stop();
  ingest = null;
  await queues?.stop();
  queues = null;
}
