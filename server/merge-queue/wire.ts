import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_FILE_NAME } from "../../pi-config/extensions/worktrees/landing.ts";
import { stateRoot } from "../state-root";
import { type BranchSummary, branchQueueOf, type MergeQueueView, type WorktreeMergeProject, type WorktreeMergeStats, type WorktreeQueueInfo } from "../../shared/merge-queue";
import type { RunMerge, ThreadEvent, WakeThread } from "./contract";
import { type IngestDeps, startIngest } from "./ingest";
import { setLandingNoteSource, setMergeCardNoteSource } from "./card-note";
import { MergeCards } from "./cards";
import { MergeFailure, MergeQueues } from "./queue";
import { merger, recordedRoots } from "./routes";
import { countBetween, realGit, revParse, worktreesOf } from "./guard";
import { canonical } from "../../pi-config/extensions/worktrees/state.ts";
import type { QueueSubject } from "../git-diff";
import { type Owner, WorktreeOwners } from "./owners";
import { engineServices, makeRunMerge } from "./run";
import { worktreeQueueInfo } from "./view";
import type { SessionBranchQueue, SessionBranchRow, SessionWorktreeInfo } from "../../shared/protocol";
import { BranchSummaries, branchBulletWriter, readBranchFacts } from "./branch-summaries";
import { projectKey } from "./store";
import { sessionsChanged } from "../list-generation";
import { LandingNotes, SERVED_FILE_NAME, ServedRule, servedKey, servedRule, setServedRule, type SetupOf, startServedWriter } from "./served";
import type { ProjectOf } from "../project-root";
import { gitRefsStamp } from "../worktrees";

/**
 * The server's merge queue: its queues (every project with records loaded and recovered at start), the `merge.*`
 * verbs on the project engine, the typed go-ahead door (landing.json), the feed event, the notices, the merge
 * thread's wake and the review step's verdicts. Called once at server start (server/index.ts).
 */

let queues: MergeQueues | null = null;
/** The branch summaries (branch-summaries.ts), one store for every queue. */
let summaries: BranchSummaries | null = null;
type RowFields = { queue?: WorktreeQueueInfo; mergeProject?: WorktreeMergeProject; mergeStats?: WorktreeMergeStats; mergeServed?: true; mergeSummary?: BranchSummary; mergeOwner?: SessionWorktreeInfo["mergeOwner"] };
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

/** What the session list's background reads need from the server's queues: no call here but `view` and `setupOf` runs
 *  more than a stat, and those only when `stamp` moved (or can't say). */
export interface QueueListDeps {
  /** The project of a tree (project-root.ts projectOf). */
  projectOf: (path: string) => Promise<ProjectOf>;
  /** A stat of the tree's `.git`, null when it has none: its project stands while this does. */
  treeStamp: (path: string) => string | null;
  /** The listed project's id at `root`, null when it isn't listed (ServedRule.projectIdOf). */
  projectIdOf: (root: string) => string | null;
  /** The repo's merge setup read now, past ServedRule's own brief cache. */
  setupOf: (root: string) => Promise<SetupOf>;
  /** The root's HEAD, packed-refs and these refs as stat stamps (worktrees.ts gitRefsStamp); null: nothing pins them. */
  stamp: (root: string, refs: readonly string[]) => string | null;
  /** The queue's view read now, null when the queue doesn't serve the root any more. */
  view: (root: string) => Promise<MergeQueueView | null>;
  /** Whether a sent-back entry's worktree is there. */
  exists: (path: string) => boolean;
  /** A stamp of a worktree's spec drafts folder (spec-drafts-state.ts draftsStamp): an entry sent back for its drafts
   *  is fixed with no commit, so its drafts are watched. Absent: not watched. */
  draftsStamp?: (worktree: string) => string;
  now: () => number;
}
let listDeps: QueueListDeps | null = null;

/** A view stands this long at most with what it rests on unmoved: the bound on anything no stamp sees. */
export const VIEW_BACKSTOP_MS = 30 * 60_000;
/** Where nothing pins a view (a reftable repo), it is re-read this often. */
const VIEW_UNPINNED_MS = 20_000;

type BranchProject = NonNullable<SessionBranchRow["mergeProject"]>;
const projectCut = (p: Pick<WorktreeMergeProject, "target" | "checks" | "invalid">): BranchProject => ({ target: p.target, checks: p.checks, ...(p.invalid ? { invalid: p.invalid } : {}) });

/** Each tree's project while its `.git` stays put: a worktree doesn't change repo, and sessions share a tree. A folder
 *  with no `.git` left has nothing to stat: its answer stands TREE_UNPINNED_MS. */
const TREE_UNPINNED_MS = 5 * 60_000;
const treeProjects = new Map<string, { stamp: string | null; at: number; p: ProjectOf }>();
async function treeProject(d: QueueListDeps, path: string): Promise<ProjectOf> {
  const stamp = d.treeStamp(path);
  const hit = treeProjects.get(path);
  if (hit && hit.stamp === stamp && (stamp !== null || d.now() - hit.at < TREE_UNPINNED_MS)) return hit.p;
  const p = await d.projectOf(path);
  if (stamp === null || (p.state === "ok" && p.git)) treeProjects.set(path, { stamp, at: d.now(), p });
  if (treeProjects.size > 5000) treeProjects.delete(treeProjects.keys().next().value!);
  return p;
}

/** Each root's merge setup while its refs stay put, VIEW_BACKSTOP_MS at most. The stamp is taken before Git is read: a
 *  move during it is never certified. A target not yet known is stamped on the next read (one extra read per root). An
 *  answer with no head is a read that failed, or a target with no commit: never kept. */
const rootSetups = new Map<string, { stamp: string; at: number; target?: string; v: Promise<SetupOf> }>();
async function setupByStamp(d: QueueListDeps, root: string): Promise<SetupOf> {
  const key = servedKey(root);
  const hit = rootSetups.get(key);
  const stamp = d.stamp(root, targetRefs(hit?.target));
  if (stamp !== null && hit?.stamp === stamp && d.now() - hit.at < VIEW_BACKSTOP_MS) return hit.v;
  const v = d.setupOf(root);
  const entry = { stamp: stamp ?? "", at: d.now(), ...(hit?.target ? { target: hit.target } : {}), v };
  if (stamp === null) rootSetups.delete(key);
  else rootSetups.set(key, entry);
  const s = await v.catch((err) => {
    if (rootSetups.get(key) === entry) rootSetups.delete(key);
    throw err;
  });
  entry.target = s.target;
  if (!s.head && rootSetups.get(key) === entry) rootSetups.delete(key);
  return s;
}
const targetRefs = (target: string | undefined): string[] => ["refs/heads/master", "refs/heads/main", ...(target ? [`refs/heads/${target}`] : [])];

/** A branch's row fields as the session list carries them (SessionBranchRow): the chat's own (worktreeQueueOf), with
 *  no size read, and the project root its queue entry is joined by at listing time (root: none while unserved). Read
 *  from what the queue last said: a row read never builds a queue's view, except the first ever of that queue. */
export async function branchQueueFields(path: string, branch: string): Promise<{ root?: string; fields: Pick<SessionBranchRow, "queue" | "mergeServed" | "mergeProject"> }> {
  const d = listDeps;
  if (!d) return { fields: {} };
  try {
    const p = await treeProject(d, path);
    if (p.state !== "ok" || !p.git) return { fields: {} };
    // Off the Projects list (or archived): a plain repo, no queue fields at all.
    if (!d.projectIdOf(p.root)) return { fields: {} };
    const setup = await setupByStamp(d, p.root);
    // Listed, setup not done: Set Up, never Land; no queue is made for it.
    if (!setup.setUp) return { fields: { mergeProject: projectCut(setup) } };
    const key = servedKey(p.root);
    const v = latestViews.get(key) ?? (await readView(d, key, lookAt(d, key, targetRefs(setup.target), [])));
    if (!v) return { fields: {} };
    const q = v.byBranch.get(branch);
    return { root: p.root, fields: { ...(q ? { queue: q } : {}), mergeServed: true, mergeProject: v.project } };
  } catch {
    return { fields: {} };
  }
}

/** A queue's view as the session list keeps it. */
interface KeptView {
  at: string;
  byBranch: Map<string, SessionBranchQueue>;
  project: BranchProject;
  digest: string;
  /** What a change no `save()` tells of would move (checkQueueViews): the target and the sent-back branches. */
  refs: string[];
  worktrees: string[];
  /** The worktrees of entries sent back for their drafts: a drafts edit, with no commit, may bring Land back. */
  drafts: string[];
  /** The look taken before the newest view read for the list: at those refs, its stamp, and when. */
  seen?: { refs: string; stamp: string | null; at: number };
}

/** Each queue's newest view, indexed by branch (the session list joins its rows' entries here, no Git read): kept from
 *  every view the queue publishes and every one a row read. */
const latestViews = new Map<string, KeptView>();
/** The views being read for the list, one per queue. */
const viewing = new Map<string, Promise<KeptView | undefined>>();

/** What a queue's view rests on, as of now. */
function lookAt(d: QueueListDeps, key: string, refs: readonly string[], worktrees: readonly string[], drafts: readonly string[] = []): NonNullable<KeptView["seen"]> {
  const raw = d.stamp(key, refs);
  const draftsPart = d.draftsStamp && drafts.length ? `\0${drafts.map((w) => d.draftsStamp!(w)).join("\0")}` : "";
  return { refs: refs.join("\n"), stamp: raw === null ? null : `${raw}\0${worktrees.map((w) => d.exists(w)).join()}${draftsPart}`, at: d.now() };
}

/** Read a queue's view for the list. `seen` is the look taken before it: a move during the read is never certified,
 *  and a read that failed spends no look. A queue gone from service loses its view, and its rows their queue facts. */
function readView(d: QueueListDeps, key: string, seen: NonNullable<KeptView["seen"]>): Promise<KeptView | undefined> {
  const flight = viewing.get(key);
  if (flight) return flight;
  const p = d
    .view(key)
    .then((v) => {
      if (v) noteQueueView(v);
      else if (latestViews.delete(key)) void import("../merge-readiness").then((m) => m.rereadBranches(key));
      const kept = latestViews.get(key);
      if (kept) kept.seen = seen;
      return kept;
    })
    .catch((err) => {
      const kept = latestViews.get(key);
      if (kept) delete kept.seen;
      throw err;
    })
    .finally(() => viewing.delete(key));
  viewing.set(key, p);
  return p;
}

/** Keep a view's entries per branch; a change in what a row reads re-lists the sessions (their rows push). */
export function noteQueueView(view: Pick<MergeQueueView, "root" | "at" | "project"> & Parameters<typeof worktreeQueueInfo>[0]): void {
  const key = servedKey(view.root);
  const prev = latestViews.get(key);
  if (prev && prev.at > view.at) return;
  const branches = new Set([...view.checking, ...view.waiting, ...view.needsYou, ...view.needsFix, ...(view.waitingOnHost ?? []), ...view.recent.map((r) => r.entry)].map((e) => e.branch));
  const byBranch = new Map<string, SessionBranchQueue>();
  for (const b of branches) {
    const q = worktreeQueueInfo(view, b);
    if (q) byBranch.set(b, branchQueueOf(q));
  }
  const project = projectCut(view);
  const digest = JSON.stringify([project, ...[...byBranch].sort(([a], [b]) => a.localeCompare(b))]);
  latestViews.set(key, {
    at: view.at,
    byBranch,
    project,
    digest,
    refs: [...targetRefs(view.target), ...view.needsFix.map((e) => `refs/heads/${e.branch}`)],
    worktrees: view.needsFix.flatMap((e) => (e.worktree ? [e.worktree] : [])),
    drafts: view.needsFix.flatMap((e) => (e.worktree && !e.settled && e.sentBackFor === "drafts" ? [e.worktree] : [])),
    ...(prev?.seen ? { seen: prev.seen } : {}),
  });
  // A change re-lists; so does a queue's first view after a start when it holds entries: the rows' background reads
  // may be up to an idle cycle old, and the listing joins this view at once.
  if (prev ? prev.digest !== digest : byBranch.size > 0) sessionsChanged();
}

/**
 * The session feed's queue watch, every few seconds while the feed runs: stats only. Every change the queue makes
 * reaches the list by its publish; this catches what moves with no `save()`, which is the target's head (its checks,
 * its invalid definition, what the sent-back entries settled into), a sent-back branch or its worktree going, and a
 * project leaving the list. A queue with a move, or with a look not taken yet (a view published or a send-back since
 * the last look), has its view read once; VIEW_BACKSTOP_MS bounds what no stamp sees. Returns how many views it started.
 */
export function checkQueueViews(): number {
  const d = listDeps;
  if (!d) return 0;
  let n = 0;
  for (const [key, v] of latestViews) {
    if (viewing.has(key)) continue;
    const look = lookAt(d, key, v.refs, v.worktrees, v.drafts);
    const seen = v.seen;
    const unmoved = seen?.refs === look.refs && d.projectIdOf(key) !== null && (look.stamp === null ? look.at - seen.at < VIEW_UNPINNED_MS : look.stamp === seen.stamp && look.at - seen.at < VIEW_BACKSTOP_MS);
    if (unmoved) continue;
    void readView(d, key, look).catch((err) => console.warn(`[merge-queue] ${key}: view failed: ${err instanceof Error ? err.message : err}`));
    n++;
  }
  return n;
}

/** A branch's newest entry in its queue's newest view: undefined when it has none there, null when no view of that
 *  queue has been seen yet (the caller keeps what its last read found). Synchronous, no Git. */
export function branchQueueNow(root: string, branch: string): SessionBranchQueue | undefined | null {
  const v = latestViews.get(servedKey(root));
  return v ? v.byBranch.get(branch) : null;
}

/** A queue's project facts in its newest view; null when none has been seen yet. Synchronous, no Git. */
export function branchProjectNow(root: string): BranchProject | null {
  return latestViews.get(servedKey(root))?.project ?? null;
}

/** Re-read the queue fields of the rows no queue joins. */
const rereadUnrooted = (): Promise<void> => import("../merge-readiness").then((m) => m.rereadBranches()).catch((err) => console.warn(`[merge-queue] rows: ${err instanceof Error ? err.message : err}`));

/** Tests only: stand these in for the server's queues (null: none). */
export function setQueueListForTest(d: QueueListDeps | null): void {
  listDeps = d;
}

/** Tests only: forget every view kept. */
export function resetQueueViewsForTest(): void {
  latestViews.clear();
  viewing.clear();
  treeProjects.clear();
  rootSetups.clear();
}
let ingest: { poke(): void; stop(): void } | null = null;
let cards: MergeCards | null = null;
let bareSettingsOf: ((root: string) => Promise<import("../../shared/merge-queue-settings").MergeQueueSettings | null>) | null = null;

/** A listed project's settings while the queue doesn't serve it, made without a queue (settings.ts bareSettings);
 *  null while the queue isn't started or its target has no commit. */
export function mergeBareSettings(root: string): Promise<import("../../shared/merge-queue-settings").MergeQueueSettings | null> {
  return bareSettingsOf ? bareSettingsOf(root) : Promise.resolve(null);
}

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

let chatsStore: import("./chats").QueueChats | null = null;
/** The server's record of the queue's own chats (chats.ts), made once. */
async function queueChats(): Promise<import("./chats").QueueChats> {
  if (!chatsStore) {
    const { QueueChats } = await import("./chats");
    chatsStore = new QueueChats(join(stateRoot(), "merge-queue", "chats.json"));
  }
  return chatsStore;
}

/** The view's reviewer running now and the History's rows (sync: the store is made at wiring). */
function chatsView(root: string): Pick<MergeQueueView, "reviewing" | "chats"> {
  const c = chatsStore;
  if (!c) return {};
  const keeper = threadModRef?.mergeThreadKeeper() ?? null;
  const r = c.running(root);
  const chats = c.list(root, keeper?.record(root), keeper?.history(root) ?? []);
  return {
    ...(r ? { reviewing: { run: r.run, branch: r.branch, session: r.session, path: r.path, attempt: r.attempt, startedAt: r.startedAt } } : {}),
    ...(chats.length ? { chats } : {}),
  };
}

/** The run's newest reviewer chat, for a branch's Worktrees row. */
export function reviewerOfRun(root: string, run: string | undefined): WorktreeQueueInfo["reviewer"] | undefined {
  if (!run || !chatsStore) return undefined;
  const r = [...chatsStore.reviewers(root)].reverse().find((x) => x.run === run);
  if (!r) return undefined;
  return { session: r.session, path: r.path, state: r.endedAt ? (r.verdict ?? "failed") : "running", ...(r.cleared ? { cleared: true as const } : {}) };
}

let threadModRef: typeof import("./thread") | null = null;

/** The merge verbs the thread's questions, Start Fresh and the History's clear go through (asks.ts, thread.ts, chats.ts). */
async function threadVerbDeps(served: { projectIdOf(root: string): string | null }): Promise<Pick<import("./routes").MergerDeps, "threadAsk" | "askOf" | "threadAnswer" | "threadFresh" | "clearChats">> {
  const threadMod = await import("./thread");
  threadModRef = threadMod;
  await queueChats();
  const keeper = () => {
    const k = threadMod.mergeThreadKeeper();
    if (!k) throw new MergeFailure("unsupported", "no merge thread runs on this server");
    return k;
  };
  return {
    async threadAsk(root, q) {
      const [{ askUser }, { listSessions }, { sendQueueWake }, { notifyOnce }, { listProjects }] = await Promise.all([import("./asks"), import("../sessions-index"), import("./wake"), import("../push"), import("../projects/spaces")]);
      let projects: { id: string; name: string }[] = [];
      try {
        projects = listProjects();
      } catch {
        projects = [];
      }
      return askUser(keeper(), root, q, {
        sessions: () => listSessions(),
        send: (path, text) => sendQueueWake(path, text),
        notify: async (n) => void (await notifyOnce(n)),
        project: (r) => {
          const id = served.projectIdOf(r);
          const p = id ? projects.find((x) => x.id === id) : undefined;
          return id ? { id, name: p?.name ?? r.split("/").pop() ?? r } : null;
        },
        log: (l) => console.warn(`[merge-thread] ${l}`),
      });
    },
    askOf: (root, id) => threadMod.mergeThreadKeeper()?.asks(root).find((a) => a.id === id),
    async threadAnswer(root, id, text, by) {
      let from = by.kind === "operator" ? "the user, on the Merge Queue tab" : "the user, relayed by the branch's chat";
      if (by.session) {
        const { listSessions } = await import("../sessions-index");
        const s = (await listSessions().catch(() => [])).find((x) => x.id === by.session);
        if (s) from = `the user, relayed by their chat "${s.title}"`;
      }
      const r = keeper().answer(root, id, text, { ...by, from });
      if (!r.ok) throw new MergeFailure(/already/.test(r.error) ? "invalid-request" : "not-found", r.error);
      return r.ask;
    },
    async threadFresh(root) {
      return keeper().startFresh(root);
    },
    async clearChats(root, which) {
      const [{ clearQueueChats }, { archiveSession, cleanupSessions }] = await Promise.all([import("./chats"), import("../sessions-index")]);
      const k = threadMod.mergeThreadKeeper();
      return clearQueueChats(await queueChats(), root, k?.record(root), k?.history(root) ?? [], which, {
        async archive(path) {
          const r = await archiveSession(path, true);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
        async remove(paths) {
          const r = await cleanupSessions({ mode: "paths", paths, dryRun: false }, { queueChats: true });
          const refused = new Map((r.refused ?? []).map((x) => [x.path, x.reason]));
          // A file already gone counts as cleared; any other refusal keeps the row.
          return paths.filter((p) => !refused.has(p) || refused.get(p) === "Session file not found.");
        },
      });
    },
  };
}

let owners: WorktreeOwners | null = null;
/** The chat a worktree's branch belongs to (owners.ts), the rule Ready rows and Land share. */
export async function worktreeOwnerOf(worktree: string): Promise<Owner | null> {
  if (!owners) {
    const [{ listSessions }, { trackedWorktrees }] = await Promise.all([import("../sessions-index"), import("../merge-readiness")]);
    owners = new WorktreeOwners({ sessions: () => listSessions(), tracked: trackedWorktrees, canonical });
  }
  return owners.ownerOf(worktree);
}

/** A worktree row's owner: its chat's id, file, title and archived mark. */
async function ownerRowOf(o: Owner): Promise<SessionWorktreeInfo["mergeOwner"]> {
  const { listSessions } = await import("../sessions-index");
  const s = (await listSessions().catch(() => [])).find((x) => x.id === o.session);
  const title = s?.title && s.title !== "Untitled" ? s.title : undefined;
  return { session: o.session, ...(s?.path ? { path: s.path } : {}), ...(title ? { title } : {}), ...(o.archived || s?.archived ? { archived: true as const } : {}) };
}

/** The root of the registered project `id`, or null. */
async function projectRootOf(id: string): Promise<string | null> {
  const { listProjects } = await import("../projects/spaces");
  try {
    return listProjects().find((p) => p.id === id)?.root ?? null;
  } catch {
    return null;
  }
}

/** What a queue diff scope names (server/git-diff.ts), from this queue's records only: an entry of project `id`, or a
 *  branch checked out in a worktree of its main checkout (its own `git worktree list`, never the checkout itself). */
export async function queueSubjectOf(id: string, sel: { entry?: string; branch?: string }): Promise<QueueSubject | null> {
  if (!queues) return null;
  // A queue already read (the tab's own read loads it), else the registered project's.
  let q = (await queues.loaded()).find((x) => x.id === id);
  if (!q) {
    const root = await projectRootOf(id);
    if (!root) return null;
    const rule = await servedRule();
    if (!(await rule.served(root))) {
      // Not served (no setup): no queue is made for it (a4); it has no entries, and a branch is diffed against the
      // target the queue would have.
      if (!sel.branch) return null;
      const target = (await rule.setupOf(root)).target;
      const w = (await worktreesOf(realGit, root)).find((x) => x.branch === sel.branch && canonical(x.path) !== canonical(root));
      return w ? { kind: "ready", root, target, branch: sel.branch, worktree: w.path } : null;
    }
    q = await queues.get(root);
  }
  const root = q.root;
  if (sel.entry) {
    const e = q.entry(sel.entry);
    if (!e || e.project !== q.id) return null;
    if (e.state === "landed" && e.landed) return { kind: "landed", root, target: e.target, branch: e.branch, sha: e.landed.sha, from: e.landed.from };
    return { kind: "entry", root, target: e.target, branch: e.branch, commit: e.commit };
  }
  if (!sel.branch) return null;
  const w = (await worktreesOf(realGit, root)).find((x) => x.branch === sel.branch && canonical(x.path) !== canonical(root));
  return w ? { kind: "ready", root, target: q.target, branch: sel.branch, worktree: w.path } : null;
}

/** The branch the registered project holding `dir` (a checkout or one of its worktrees) lands into: its merge queue's
 *  target. Null when no registered project holds it or the queue isn't started. */
export async function landingTargetOf(dir: string): Promise<string | null> {
  if (!queues) return null;
  const { projectOf } = await import("../project-root");
  const p = await projectOf(dir);
  if (p.state !== "ok" || !p.git) return null;
  const { listProjects } = await import("../projects/spaces");
  let known = false;
  try {
    known = listProjects().some((x) => x.root === p.root);
  } catch {}
  if (!known) return null;
  // The queue's target rule, read from Git: asking never makes a queue for a project it doesn't serve (a4).
  return (await (await servedRule()).setupOf(p.root)).target;
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
  const [{ projectEngine }, { publishFeed }, { projectOf }, { definitionAt }, { draftsHash, draftsStamp, draftsFingerprint }, { listProjects }, checks, threadMod, review, { previewDocs }] = await Promise.all([
    import("../project-services/routes"),
    import("../session-feed"),
    import("../project-root"),
    import("../project-services/deploy-recipe"),
    import("../spec-drafts-state"),
    import("../projects/spaces"),
    import("./checks"),
    import("./thread"),
    import("./review-step"),
    import("../docs-preview"),
  ]);
  const releaseWire = await import("../project-services/release-wire");
  const served = new ServedRule({ listed: opts.listed ?? (() => listProjects()), definitionAt: (root, ref) => definitionAt(root, ref), checksOf: checks.checksOf });
  setServedRule(served);
  const writer = startServedWriter(served, join(stateRoot(), SERVED_FILE_NAME), {
    onRoots: (roots) => {
      const was = servedNow;
      servedNow = new Set(roots.map((r) => servedKey(r.root)));
      // A root gaining service: its rows have no root to join by, and an archived one has no read coming.
      if (listDeps && [...servedNow].some((r) => !was.has(r))) void rereadUnrooted();
    },
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
  const { isSessionBusy: busyOf } = await import("../chat-handle");
  const chatsRec = await queueChats();
  review.setReviewerRecorder({
    started: (o) => chatsRec.reviewerStarted(o.root, { session: o.session, path: o.path, run: o.run, branch: o.branch, attempt: o.attempt }),
    ended: (o) => chatsRec.reviewerEnded(o.root, o.session, { ...(o.verdict ? { verdict: o.verdict } : {}), ...(o.why ? { why: o.why } : {}) }),
  });
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
                : ev.kind === "idle"
                  ? { kind: "idle" as const, entry, ...(ev.lastLanded ? { lastLanded: ev.lastLanded } : {}), ...(ev.head ? { head: ev.head } : {}) }
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
  // What each branch does (branch-summaries.ts): written once a served branch reads Ready to land at a commit, or is
  // approved at one; the queue's rows and the Worktrees rows read them, and a change publishes the view again.
  const bs: BranchSummaries = new BranchSummaries({
    // Beside the queue's own records (store.ts): `<state>/merge-queue/<project key>/branch-summaries.json`.
    fileOf: (root) => join(base, projectKey(root), "branch-summaries.json"),
    facts: async (root, branch, commit): Promise<import("./branch-summaries").BranchFacts | null> => {
      const pq = await queues!.get(root);
      const head = (await pq.declared()).head;
      return head ? readBranchFacts(realGit, root, { branch, commit, target: pq.target, targetHead: head }) : null;
    },
    writer: branchBulletWriter,
    projectOf: (root) => projectIdOf(root) ?? root,
    changed: (root) => void queues?.peek(root)?.then((pq) => pq.republish()).catch(() => {}),
    log: (line) => console.warn(line),
  });
  summaries = bs;
  const summaryFor = (root: string, branch: string, commit: string) => {
    if (!servedNow.has(servedKey(root))) return;
    bs.ensure(root, branch, commit);
  };
  const cardsDo = (p: Promise<void>) => void p.catch((err) => console.warn(`[merge-queue] card: ${err instanceof Error ? err.stack : err}`));
  queues = new MergeQueues({
    base,
    runMerge,
    checksOf: checks.checksOf,
    definitionAt: (root, ref) => definitionAt(root, ref),
    projectIdOf,
    listed: (root) => served.isListed(root),
    publish: (view: MergeQueueView) => {
      noteQueueView(view);
      publishFeed({ type: "merge_queue", project: view.project, view });
      cardsDo(mc.sync(view));
    },
    // The branch's card in its own chat: raised at the approval, a revision at each outcome (cards.ts).
    notify: (kind, e, extra) => {
      // An approved branch was Ready to land at its commit: its summary is written if it has none yet.
      if (kind === "approved") summaryFor(extra.root, e.branch, e.commit);
      cardsDo(kind === "approved" ? mc.approved(e, extra.root) : mc.outcome(kind, e, { ...(extra.run ? { run: extra.run } : {}), root: extra.root }));
    },
    summaryOf: (root, branch, commit): BranchSummary | undefined => bs.summaryOf(root, branch, commit),
    pruneSummaries: (root, live, shown) => void bs.prune(root, live, shown),
    // The branch's chat (owners.ts): the Ready rows show it, and a Land naming no chat records it.
    ownerOf: async (_root, _branch, worktree) => (worktree ? worktreeOwnerOf(worktree) : null),
    thread,
    draftsHash: (dir) => draftsHash(dir),
    // A branch sent back for its drafts: Sova's docs check of them, the one readiness runs (one cache).
    docsCheck: (dir, commit, hash, done) => previewDocs(dir, commit, hash, done),
    draftsFingerprint: (dir) => draftsFingerprint(dir),
    threadOf: (root) => threadMod.threadInfo(threadMod.mergeThreadKeeper(), root, busyOf),
    chatsOf: (root) => chatsView(root),
    // Landing by request (al_3): the docs commit goes into a chat's folder only while it is idle, read as the worktree
    // readiness reads it (server/merge-readiness.ts runningNow: busy, working, or a worker working); an unknown chat
    // can't be interrupted. A request's title is its chat's.
    chatIdle: async (session) => {
      const { listSessions } = await import("../sessions-index");
      const x = (await listSessions()).find((y) => y.id === session);
      return !x || !(x.busy || x.activity?.state === "working" || (x.workers?.working ?? x.live?.workers?.working ?? 0) > 0);
    },
    chatTitle: async (session) => {
      const { listSessions } = await import("../sessions-index");
      const t = (await listSessions()).find((y) => y.id === session)?.title;
      return t && t !== "Untitled" ? t : null;
    },
    ...(legacyNames ? { legacyNames } : {}),
    // The review and thread models: the new-chat default and Settings → Models' policy (models.ts).
    modelCheck: (await import("./models")).liveModelCheck(),
    releaseEvent: (ev) => releaseWire.releaseEvent(ev),
  });
  const q = queues;
  // A served tree that reads Ready to land at a commit (merge-readiness.ts): its branch summary is written.
  const { configureReadiness } = await import("../merge-readiness");
  configureReadiness({
    readyToLand: (t) =>
      void projectOf(t.path)
        .then((p) => (p.state === "ok" && p.git ? summaryFor(p.root, t.branch, t.commit) : undefined))
        .catch(() => {}),
  });
  // Releases (server/project-services/release.ts): their verbs, the queue's hold and Publish go through these queues.
  await releaseWire.startReleaser({
    stateRoot: stateRoot(),
    queues: () => q,
    ...(opts.request ? { request: opts.request } : {}),
    rootOf: async (path) => {
      const p = await projectOf(path);
      return p.state === "ok" && p.git ? p.root : null;
    },
    definitionAt: (root, ref) => definitionAt(root, ref),
    projectIdOf,
    publishFeed: (msg) => publishFeed(msg),
  });
  const bareDeps = { base, git: realGit, setupOf: (root: string) => served.setupOf(root), definitionAt: (root: string, ref: string) => definitionAt(root, ref), projectIdOf, modelCheck: (await import("./models")).liveModelCheck(), ...(legacyNames ? { legacyNames } : {}) };
  const { bareSettings } = await import("./settings");
  bareSettingsOf = (root) => bareSettings(root, bareDeps).catch((err) => (console.warn(`[merge-queue] ${root}: settings unreadable: ${err instanceof Error ? err.message : err}`), null));
  const verbs = merger({
    queues: q,
    served,
    bareSettings: (root) => mergeBareSettings(root),
    rootOf: async (path) => {
      const p = await projectOf(path);
      return p.state === "ok" && p.git ? p.root : null;
    },
    isThreadChat: (root, sid) => threadMod.mergeThread().isThreadChat(root, sid),
    reviewerOf: review.reviewerOf,
    deliverReview: review.deliverReview,
    ...(await threadVerbDeps(served)),
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
    noteQueueView(v);
    const info = worktreeQueueInfo(v, branch);
    // Open Reviewer Chat on the branch's own Worktrees row: its run's newest reviewer, running or done.
    const reviewer = info ? reviewerOfRun(p.root, info.run) : undefined;
    const queue = info && reviewer ? { ...info, reviewer } : info;
    const stats = await statsOf(p.root, v.heads.target, branch);
    // Its summary at its entry's commit while it has one, else at its head; and the chat that owns it, for the title.
    const at = queue?.commit ?? stats?.head;
    const summary = at ? bs.summaryOf(p.root, branch, at) : undefined;
    const owner = await worktreeOwnerOf(path).catch(() => null);
    const ownerRow = owner ? await ownerRowOf(owner) : undefined;
    return { ...(summary ? { mergeSummary: summary } : {}), ...(ownerRow ? { mergeOwner: ownerRow } : {}), ...(queue ? { queue } : {}), mergeProject: { id, root: p.root, target: v.target, checks: v.checks, review: v.review, ...(v.invalid ? { invalid: v.invalid } : {}), ...(v.paused ? { paused: v.paused.why } : {}) }, ...(stats ? { mergeStats: stats } : {}), mergeServed: true };
  };
  listDeps = {
    projectOf: (path) => projectOf(path),
    treeStamp: (path) => {
      try {
        const st = statSync(join(path, ".git"));
        return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        return null;
      }
    },
    projectIdOf: (root) => served.projectIdOf(root),
    setupOf: (root) => {
      served.forget(root);
      return served.setupOf(root);
    },
    stamp: gitRefsStamp,
    // Uncached: a view from before a move must not be kept as the view after it.
    view: async (root) => {
      served.forget(root);
      return (await served.served(root)) ? (await q.get(root)).view({ fresh: true }) : null;
    },
    exists: existsSync,
    draftsStamp: (worktree) => draftsStamp(worktree),
    now: Date.now,
  };
  // Rows read before this line have no queue fields, and nothing else re-reads an archived one.
  void rereadUnrooted();
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

/** Try Again on a branch summary that failed (POST /api/merge-queue/projects/:project/branch-summary). */
export async function retryBranchSummary(projectId: string, branch: string, commit: string): Promise<{ ok: true } | { ok: false; code: "not-found" | "invalid-request" | "busy" | "unsupported"; message: string }> {
  if (!queues || !summaries) return { ok: false, code: "unsupported", message: "The merge queue isn't running." };
  const root = await projectRootOf(projectId);
  if (!root) return { ok: false, code: "not-found", message: `no project ${projectId}` };
  const r = summaries.retry(root, branch, commit);
  return r.ok ? { ok: true } : r;
}

/** Tests: the store the server writes branch summaries with. */
export const branchSummariesNow = (): BranchSummaries | null => summaries;

export async function stopMergeQueue(): Promise<void> {
  summaries = null;
  rowsOf = null;
  listDeps = null;
  resetQueueViewsForTest();
  owners = null;
  servedWriter?.stop();
  servedWriter = null;
  setServedRule(null);
  servedNow = new Set();
  cards = null;
  bareSettingsOf = null;
  setMergeCardNoteSource(null);
  setLandingNoteSource(null);
  ingest?.stop();
  ingest = null;
  (await import("../project-services/release-wire")).stopReleaser();
  await queues?.stop();
  queues = null;
}
