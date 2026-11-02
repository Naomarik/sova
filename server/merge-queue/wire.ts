import { join } from "node:path";
import { LANDING_FILE_NAME } from "../../pi-config/extensions/worktrees/landing.ts";
import { stateRoot } from "../state-root";
import type { MergeQueueView } from "../../shared/merge-queue";
import type { RunMerge, ThreadEvent, WakeThread } from "./contract";
import { startIngest } from "./ingest";
import { notifier } from "./notices";
import { MergeQueues } from "./queue";
import { merger, recordedRoots } from "./routes";
import { makeRunMerge } from "./run";

/**
 * The server's merge queue: its queues (every project with records loaded and recovered at start), the `merge.*`
 * verbs on the project engine, the typed go-ahead door (landing.json), the feed event, the notices, the merge
 * thread's wake and the review step's verdicts. Called once at server start (server/index.ts).
 */

let queues: MergeQueues | null = null;
let ingest: { poke(): void; stop(): void } | null = null;

export function mergeQueues(): MergeQueues | null {
  return queues;
}

/** Tell the typed go-ahead door to look now (the worktree tool just wrote one). */
export function pokeMergeIngest(): void {
  ingest?.poke();
}

export async function startMergeQueue(): Promise<void> {
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
  const runMerge: RunMerge = makeRunMerge({ state: stateRoot() });
  const projectIdOf = (root: string): string | null => {
    try {
      return listProjects().find((p) => p.root === root)?.id ?? null;
    } catch {
      return null;
    }
  };
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
              : null;
    if (!mapped) return false;
    const r = keeper.notify(ev.root, mapped) as unknown;
    return r === false ? false : (threadMod as { hasMergeThread?: () => boolean }).hasMergeThread?.() ?? true;
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
  ingest?.stop();
  ingest = null;
  await queues?.stop();
  queues = null;
}
