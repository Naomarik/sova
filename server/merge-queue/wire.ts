import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_FILE_NAME } from "../../pi-config/extensions/worktrees/landing.ts";
import { stateRoot } from "../state-root";
import type { MergeQueueView, WorktreeMergeProject, WorktreeMergeStats, WorktreeQueueInfo } from "../../shared/merge-queue";
import type { RunMerge, ThreadEvent, WakeThread } from "./contract";
import { type IngestDeps, startIngest } from "./ingest";
import { setLandingNoteSource, setMergeCardNoteSource } from "./card-note";
import { MergeCards } from "./cards";
import { MergeQueues } from "./queue";
import { merger, recordedRoots } from "./routes";
import { countBetween, realGit, revParse } from "./guard";
import { engineServices, makeRunMerge } from "./run";
import { worktreeQueueInfo } from "./view";
import { LandingNotes, SERVED_FILE_NAME, ServedRule, servedKey, servedRule, setServedRule, startServedWriter } from "./served";

/**
 * The server's merge queue: its queues (every project with records loaded and recovered at start), the `merge.*`
 * verbs on the project engine, the typed go-ahead door (landing.json), the feed event, the notices, the merge
 * thread's wake and the review step's verdicts. Called once at server start (server/index.ts).
 */

let queues: MergeQueues | null = null;
type RowFields = { queue?: WorktreeQueueInfo; mergeProject?: WorktreeMergeProject; mergeStats?: WorktreeMergeStats; mergeServed?: true };
let servedWriter: { refresh(): Promise<void>; stop(): void } | null = null;
/** The served roots as last computed (the writer's pass): the thread wake's synchronous check. */
let servedNow = new Set<string>();
let rowsOf: ((path: string, branch: string) => Promise<RowFields>) | null = null;

/** A worktree row's queue fields (SessionWorktreeInfo.queue / mergeProject / mergeServed): mergeProject for a
 *  registered project's repo, the rest only where the queue serves it (served.ts). */
export async function worktreeQueueOf(path: string, branch: string): Promise<RowFields> {
  if (!rowsOf) return {};
  try {
    return await rowsOf(path, branch);
  } catch {
    return {};
  }
}
let ingest: { poke(): void; stop(): void } | null = null;
let cards: MergeCards | null = null;

/** A chat's merge queue cards (server/merge-queue/cards.ts); [] while the queue isn't started. */
export function mergeCardsOf(session: string): import("../../shared/merge-queue").MergeCard[] {
  return cards?.cardsOf(session) ?? [];
}

/** The merge queue's hidden lines for a chat's next turn since its last card note; null: none. */
export function mergeCardNote(session: string, since: string | null): string | null {
  return cards?.noteFor(session, since) ?? null;
}

/** Tests only: stand a cards store in for the server's (null: none). */
export function setMergeCardsForTest(c: MergeCards | null): void {
  cards = c;
}

export function mergeQueues(): MergeQueues | null {
  return queues;
}

/** Whether `target` of the project at `root` lands only through its merge queue: the queue serves the project
 *  (served.ts) and lands into that branch. A direct merge into it is refused then. False while the queue isn't
 *  started. Never creates a queue. */
export async function queueManages(root: string, target: string): Promise<boolean> {
  if (!queues) return false;
  return (await (await servedRule()).servedTarget(root)) === target;
}

/** The served rule's answer changed (a setup ran, a project was added): re-read it and rewrite the chats' file. */
export function refreshServed(): Promise<void> {
  return servedWriter?.refresh() ?? Promise.resolve();
}

/** The ingest's deps over the served rule: the go-ahead's branch is looked for in listed and recorded roots alike,
 *  and taken only where `rule` serves it (a recorded root off the list is refused, never queued). */
export function ingestDepsFor(a: {
  base: string;
  file: string;
  rule: Pick<ServedRule, "listedRoots" | "served">;
  queue: IngestDeps["queue"];
  repoOf: IngestDeps["repoOf"];
  refused?: IngestDeps["refused"];
  log?: IngestDeps["log"];
}): IngestDeps {
  return {
    file: a.file,
    seenFile: join(a.base, "ingest.json"),
    roots: () => [...new Set([...a.rule.listedRoots(), ...recordedRoots(a.base)])],
    served: (root) => a.rule.served(root),
    repoOf: a.repoOf,
    queue: a.queue,
    ...(a.refused ? { refused: a.refused } : {}),
    ...(a.log ? { log: a.log } : {}),
  };
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

export async function startMergeQueue(
  opts: {
    request?: (path: string, init?: RequestInit) => Response | Promise<Response>;
    /** Tests only: the Projects list the served rule reads (default listProjects). */
    listed?: () => { root: string }[];
  } = {},
): Promise<void> {
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
  const served = new ServedRule({ listed: opts.listed ?? (() => listProjects()), definitionAt: (root, ref) => definitionAt(root, ref), checksOf: checks.checksOf });
  setServedRule(served);
  const writer = startServedWriter(served, join(stateRoot(), SERVED_FILE_NAME), {
    onRoots: (roots) => (servedNow = new Set(roots.map((r) => servedKey(r.root)))),
  });
  servedWriter = writer;
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
  // Sova's own project keeps its old private-names file (merge-round.json) until it has its own.
  const self = await projectOf(fileURLToPath(new URL("../..", import.meta.url)));
  const legacyNames = self.state === "ok" ? { root: self.root, file: join(stateRoot(), "merge-round.json") } : undefined;
  const sendTo = async (session: string, text: string): Promise<void> => {
    const { listSessions } = await import("../sessions-index");
    const s = (await listSessions()).find((x) => x.id === session);
    if (!s) throw new Error(`no session ${session}`);
    await (await import("./wake")).sendQueueWake(s.path, text);
  };
  const thread: WakeThread = (ev: ThreadEvent) => {
    const keeper = threadMod.mergeThread();
    const entry = { id: ev.entry.id, branch: ev.entry.branch, commit: ev.entry.commit, target: ev.entry.target };
    const base = ev.base ? { base: ev.base } : {};
    const mapped =
      ev.kind === "queued"
        ? { kind: "queued" as const, entry, ...base }
        : ev.kind === "conflict"
          ? { kind: "conflict" as const, entry, run: ev.run ?? "", files: ev.files ?? [], ...base }
          : ev.kind === "failed"
            ? { kind: "failed" as const, entry, run: ev.run ?? "", ...(ev.why ? { summary: ev.why } : {}), ...base }
            : ev.kind === "paused"
              ? { kind: "paused" as const, why: ev.why ?? "paused" }
              : ev.kind === "names"
                ? { kind: "names" as const, file: ev.namesFile ?? "", target: ev.target }
                : null;
    if (!mapped) return false;
    if (!servedNow.has(servedKey(ev.root))) return false;
    if (!threadMod.hasMergeThread()) return false;
    keeper.notify(ev.root, mapped as Parameters<typeof keeper.notify>[1]);
    return true;
  };
  const sessionPath = async (session: string): Promise<string | null> => {
    const { listSessions } = await import("../sessions-index");
    return (await listSessions()).find((x) => x.id === session)?.path ?? null;
  };
  const mc = new MergeCards({
    dir: join(base, "cards"),
    lastEntry: async (session) => {
      const path = await sessionPath(session);
      if (!path) return null;
      return (await import("../transcript-cards")).lastRowEntry(path);
    },
    // A hand-back's wake: a normal message (queued after a turn in flight), its text marked as the queue's.
    wake: sendTo,
    publish: (session, list) => publishFeed({ type: "merge_cards", session, cards: list }),
    log: (line) => console.warn(line),
  });
  cards = mc;
  setMergeCardNoteSource((session, since) => mc.noteFor(session, since));
  // Each chat's landing lines: whether each repo it works in lands through the queue (a6).
  const { MERGE_QUEUE_PROFILES } = await import("../merge-readiness");
  const notes = new LandingNotes({
    repos: async (session) => {
      const { listSessions } = await import("../sessions-index");
      const s = (await listSessions()).find((x) => x.id === session);
      if (!s || (s.profile && MERGE_QUEUE_PROFILES.includes(s.profile.id))) return null;
      const roots: string[] = [];
      for (const dir of [s.cwd, ...(s.readiness?.trees ?? []).map((t) => t.path)]) {
        const p = await projectOf(dir).catch(() => null);
        if (p?.state === "ok" && p.git) roots.push(servedKey(p.root));
      }
      return roots;
    },
    targetOf: (root) => served.servedTarget(root),
  });
  setLandingNoteSource((session) => notes.noteFor(session));
  const cardsDo = (p: Promise<void>) => void p.catch((err) => console.warn(`[merge-queue] card: ${err instanceof Error ? err.stack : err}`));
  queues = new MergeQueues({
    base,
    runMerge,
    checksOf: checks.checksOf,
    definitionAt: (root, ref) => definitionAt(root, ref),
    projectIdOf,
    listed: (root) => served.isListed(root),
    publish: (view: MergeQueueView) => {
      publishFeed({ type: "merge_queue", project: view.project, view });
      cardsDo(mc.sync(view));
    },
    // The branch's card in its own chat: raised at the approval, a revision at each outcome (cards.ts).
    notify: (kind, e, extra) => cardsDo(kind === "approved" ? mc.approved(e, extra.root) : mc.outcome(kind, e, { ...(extra.run ? { run: extra.run } : {}), root: extra.root })),
    ownerOf: async (_root, _branch, worktree) => {
      // Land from the Merge Queue tab names no chat: the newest chat working in the branch's worktree.
      if (!worktree) return null;
      const { listSessions } = await import("../sessions-index");
      const inside = (await listSessions()).filter((x) => !x.archived && (x.cwd === worktree || x.cwd.startsWith(`${worktree}/`)));
      return inside.sort((a, b) => (Date.parse(b.lastActiveAt) || 0) - (Date.parse(a.lastActiveAt) || 0))[0]?.id ?? null;
    },
    thread,
    draftsHash: (dir) => draftsHash(dir),
    threadOf: (root) => (threadMod as { threadOf?: (r: string) => { session: string; startedAt: string } | null }).threadOf?.(root) ?? null,
    ...(legacyNames ? { legacyNames } : {}),
  });
  const q = queues;
  const verbs = merger({
    queues: q,
    served,
    rootOf: async (path) => {
      const p = await projectOf(path);
      return p.state === "ok" && p.git ? p.root : null;
    },
    isThreadChat: (root, sid) => threadMod.mergeThread().isThreadChat(root, sid),
    reviewerOf: review.reviewerOf,
    deliverReview: review.deliverReview,
  });
  // A setup run changes the answer: the chats' file follows at once.
  projectEngine().merger = async (verb, body, caller) => {
    const r = await verbs(verb, body, caller);
    if (verb === "merge.setup" && r.ok && r.changed) void writer.refresh();
    return r;
  };
  rowsOf = async (path, branch) => {
    const p = await projectOf(path);
    if (p.state !== "ok" || !p.git) return {};
    // Off the Projects list (or archived): a plain repo, no queue fields at all.
    const id = served.projectIdOf(p.root);
    if (!id) return {};
    if (!(await served.served(p.root))) {
      // Listed, setup not done: Set Up, never Land; no queue is made for it.
      const s = await served.setupOf(p.root);
      return { mergeProject: { id, root: p.root, target: s.target, checks: s.checks, review: false, ...(s.invalid ? { invalid: s.invalid } : {}) } };
    }
    const v = await (await q.get(p.root)).cachedView();
    const queue = worktreeQueueInfo(v, branch);
    const stats = await statsOf(p.root, v.heads.target, branch);
    return { ...(queue ? { queue } : {}), mergeProject: { id, root: p.root, target: v.target, checks: v.checks, review: v.review, ...(v.invalid ? { invalid: v.invalid } : {}), ...(v.paused ? { paused: v.paused.why } : {}) }, ...(stats ? { mergeStats: stats } : {}), mergeServed: true };
  };
  // The chats' file is current before the typed go-ahead door opens.
  await writer.first;
  // Leftover records of a repo the queue doesn't serve stay on disk, never loaded.
  for (const root of recordedRoots(base))
    void served
      .served(root)
      .then((yes) => (yes ? q.get(root) : null))
      .catch((err) => console.warn(`[merge-queue] ${root}: ${err instanceof Error ? err.message : err}`));
  ingest = startIngest(
    ingestDepsFor({
      base,
      file: join(stateRoot(), LANDING_FILE_NAME),
      rule: served,
      queue: (root) => q.get(root),
      // The chat's repo: its cwd's main checkout.
      repoOf: async (session) => {
        const { listSessions } = await import("../sessions-index");
        const s = (await listSessions().catch(() => [])).find((x) => x.id === session);
        const p = s?.cwd ? await projectOf(s.cwd).catch(() => null) : null;
        return p?.state === "ok" && p.git ? p.root : null;
      },
      // A typed "land it" that couldn't be queued: the chat's model hears it at its next turn (no message is sent).
      refused: (session, text) => mc.addLine(session, `refused:${Date.now()}`, text),
    }),
  );
}

export async function stopMergeQueue(): Promise<void> {
  rowsOf = null;
  servedWriter?.stop();
  servedWriter = null;
  setServedRule(null);
  servedNow = new Set();
  cards = null;
  setMergeCardNoteSource(null);
  setLandingNoteSource(null);
  ingest?.stop();
  ingest = null;
  await queues?.stop();
  queues = null;
}
