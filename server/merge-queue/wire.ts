import { recordLand } from "../message-labels";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_FILE_NAME } from "../../pi-config/extensions/worktrees/landing.ts";
import { defaultTarget, runGit } from "../../pi-config/extensions/worktrees/git.ts";
import { stateRoot } from "../state-root";
import { type BranchPlace, type BranchSummary, branchQueueOf, type LandingSummary, type MergeChatRequest, type MergeEntry, type LandingSummaryProject, type MergeQueueView, type WorktreeMergeProject, type WorktreeMergeStats, type WorktreeQueueInfo } from "../../shared/merge-queue";
import type { RunMerge, ThreadEvent, WakeThread } from "./contract";
import type { ThreadEntry, ThreadEvent as ThreadMessage } from "./thread";
import { type IngestDeps, startIngest } from "./ingest";
import { setLandingNoteSource, setMergeCardNoteSource } from "./card-note";
import { MergeCards } from "./cards";
import { MergeFailure, MergeQueues } from "./queue";
import { merger, recordedRoots } from "./routes";
import { countBetween, realGit, revParse, worktreesOf } from "./guard";
import { canonical } from "../../pi-config/extensions/worktrees/state.ts";
import type { QueueSubject } from "../git-diff";
import { type Owner, WorktreeOwners } from "./owners";
import { branchPlace, placeLabel } from "./place";
import { parseTargetCwd } from "../targets";
import { engineServices, makeRunMerge } from "./run";
import { queueGlanceOf, worktreeQueueInfo } from "./view";
import type { ProjectGlanceQueue } from "../../shared/projects";
import type { SessionBranchQueue, SessionBranchRow, SessionWorktreeInfo } from "../../shared/protocol";
import { BranchSummaries, branchBulletWriter, readBranchFacts } from "./branch-summaries";
import { SummarySweep } from "./summary-sweep";
import { projectKey } from "./store";
import { sessionsChanged } from "../list-generation";
import { LandingNotes, SERVED_FILE_NAME, ServedRule, servedKey, servedRule, setServedRule, type SetupOf, startServedWriter } from "./served";
import type { ProjectOf } from "../project-root";
import { trialEndedText } from "./setup-branch";
import { gitRefsStamp } from "../worktrees";

/**
 * The server's merge queue: its queues (every project with records loaded and recovered at start), the `merge.*`
 * verbs on the project engine, the typed go-ahead door (landing.json), the feed event, the notices, the merge
 * thread's wake and the review step's verdicts. Called once at server start (server/index.ts).
 */

let queues: MergeQueues | null = null;
/** A request's delivery stamped on its entry (ProjectQueue.requestDelivered), once the queues exist. */
let stampDelivery: (request: string, delivery: "queued" | "delivered" | "fallback-tab" | "fallback-line", session?: string) => Promise<void> = async () => {};
type ProjectQueueOf<Q> = Q extends { loaded(): Promise<(infer P)[]> } ? P : never;
/** The branch summaries (branch-summaries.ts), one store for every queue. */
let summaries: BranchSummaries | null = null;
/** The summaries' background sweep (summary-sweep.ts): every Ready row's bullets once its chat is idle. */
let sweep: SummarySweep | null = null;
/** The run logs' packing (run-logs.ts): finished runs' logs gzipped a day after they ended, hourly. */
let logSweep: { stop(): void } | null = null;
type RowFields = { queue?: WorktreeQueueInfo; mergeProject?: WorktreeMergeProject; mergeStats?: WorktreeMergeStats; mergeServed?: true; mergeSummary?: BranchSummary; mergeOwner?: SessionWorktreeInfo["mergeOwner"] };
let servedWriter: { refresh(): Promise<void>; stop(): void } | null = null;
/** The served roots as last computed (the writer's pass): the thread wake's synchronous check. */
let servedNow = new Set<string>();
/** The served roots as the served rule names them (queues are made by these). */
let servedRootsNow: string[] = [];
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

/** What a repository's branches merge into now (§chat.worktrees/place): the queue's target where it serves the repo,
 *  else what the worktree tool merges into. The tool's answer is kept briefly: the Session tab's rows are polled. */
const TOOL_TARGET_MS = 10_000;
const toolTargets = new Map<string, { at: number; v: Promise<string | undefined> }>();
function toolTarget(root: string): Promise<string | undefined> {
  const hit = toolTargets.get(root);
  if (hit && Date.now() - hit.at < TOOL_TARGET_MS) return hit.v;
  const v = defaultTarget(runGit, root).catch(() => undefined);
  toolTargets.set(root, { at: Date.now(), v });
  if (toolTargets.size > 500) toolTargets.delete(toolTargets.keys().next().value!);
  return v;
}

/** The place of the branch whose folder is (or was) `path`, its target included (the Session tab's row). */
export async function worktreePlaceOf(path: string): Promise<BranchPlace> {
  const [rule, { projectOf }] = await Promise.all([servedRule(), import("../project-root")]);
  return branchPlace({ listed: () => rule.everyProject(), projectOf: (p) => projectOf(p), exists: existsSync, remote: parseTargetCwd, targetOf: async (root) => (await rule.servedTarget(root)) ?? toolTarget(root) }, path);
}

/** The place as a session list row reads it: only stats while its repository's refs stay put. */
export async function branchPlaceRead(path: string): Promise<BranchPlace | undefined> {
  const d = listDeps;
  if (!d) return undefined;
  const rule = await servedRule();
  return branchPlace({ listed: () => rule.everyProject(), projectOf: (p) => treeProject(d, p), exists: existsSync, remote: parseTargetCwd, targetOf: (root) => targetByStamp(d, root) }, path);
}

const toolTargetsSeen = new Map<string, { stamp: string; at: number; v: Promise<string | undefined> }>();
/** branchPlaceRead's target: the queue's where it serves the repo, else the worktree tool's, asked again when the refs move. */
async function targetByStamp(d: QueueListDeps, root: string): Promise<string | undefined> {
  if (d.projectIdOf(root)) {
    const s = await setupByStamp(d, root);
    if (s.setUp) return s.target;
  }
  const key = servedKey(root);
  const stamp = d.stamp(root, targetRefs(undefined));
  const hit = toolTargetsSeen.get(key);
  if (stamp !== null && hit?.stamp === stamp && d.now() - hit.at < VIEW_BACKSTOP_MS) return hit.v;
  const v = toolTarget(root);
  if (stamp !== null) toolTargetsSeen.set(key, { stamp, at: d.now(), v });
  if (toolTargetsSeen.size > 500) toolTargetsSeen.delete(toolTargetsSeen.keys().next().value!);
  return v;
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
  /** When each branch's newest entry was approved (ms epoch): never on the wire. */
  began: Map<string, number>;
  project: BranchProject;
  digest: string;
  /** What a change no `save()` tells of would move (checkQueueViews): the target and the sent-back branches. */
  refs: string[];
  worktrees: string[];
  /** The worktrees of entries sent back for their drafts: a drafts edit, with no commit, may bring Land back. */
  drafts: string[];
  /** The look taken before the newest view read for the list: at those refs, its stamp, and when. */
  seen?: { refs: string; stamp: string | null; at: number };
  /** The project cards' cut of it (§app.projects/home-glance). */
  glance: ProjectGlanceQueue | null;
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
  const entries = [...view.checking, ...view.waiting, ...view.needsYou, ...view.needsFix, ...(view.waitingOnHost ?? []), ...view.recent.map((r) => r.entry)];
  const byBranch = new Map<string, SessionBranchQueue>();
  const began = new Map<string, number>();
  for (const b of branches) {
    const q = worktreeQueueInfo(view, b);
    if (!q) continue;
    byBranch.set(b, branchQueueOf(q));
    const at = Date.parse(entries.find((e) => e.id === q.id)?.approval?.at ?? "");
    if (Number.isFinite(at)) began.set(b, at);
  }
  const project = projectCut(view);
  const digest = JSON.stringify([project, ...[...byBranch].sort(([a], [b]) => a.localeCompare(b))]);
  latestViews.set(key, {
    at: view.at,
    byBranch,
    began,
    project,
    digest,
    refs: [...targetRefs(view.target), ...view.needsFix.map((e) => `refs/heads/${e.branch}`)],
    worktrees: view.needsFix.flatMap((e) => (e.worktree ? [e.worktree] : [])),
    drafts: view.needsFix.flatMap((e) => (e.worktree && !e.settled && e.sentBackFor === "drafts" ? [e.worktree] : [])),
    ...(prev?.seen ? { seen: prev.seen } : {}),
    glance: queueGlanceOf(view),
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

/** A project card's figures from its queue's newest kept view (§app.projects/home-glance): null when no view of that
 *  queue is kept (a queue that doesn't serve the project keeps none). Synchronous: never builds a view, never makes a
 *  queue, no Git. */
export function queueGlanceNow(root: string): ProjectGlanceQueue | null {
  return latestViews.get(servedKey(root))?.glance ?? null;
}

/**
 * A project card's queue state (§app.projects/home-glance): `served` with the kept view's cut; `reading` for a root the
 * queue serves (listed and set up, as the served writer last named them) whose view isn't kept yet, which starts that
 * view's one read here (deduped with any read in flight; once kept, the list's watch maintains it like every kept
 * view); `unserved` otherwise, which reads nothing and makes no queue. Synchronous: the first read of a served root is
 * the only one that leads to Git, and it runs in the background.
 */
export function queueGlanceState(root: string): { state: "served"; cut: ProjectGlanceQueue } | { state: "reading" | "unserved" } {
  const key = servedKey(root);
  const kept = latestViews.get(key)?.glance;
  if (kept) return { state: "served", cut: kept };
  if (!servedNow.has(key)) return { state: "unserved" };
  const d = listDeps;
  if (d && !viewing.has(key)) void readView(d, key, lookAt(d, key, [], [])).catch((err) => console.warn(`[merge-queue] ${key}: glance view failed: ${err instanceof Error ? err.message : err}`));
  return { state: "reading" };
}

/** A branch's newest entry in its queue's newest view: undefined when it has none there, null when no view of that
 *  queue has been seen yet (the caller keeps what its last read found). Synchronous, no Git. */
export function branchQueueNow(root: string, branch: string): SessionBranchQueue | undefined | null {
  const v = latestViews.get(servedKey(root));
  return v ? v.byBranch.get(branch) : null;
}

/** When a branch's newest entry in its queue's newest view was approved (ms epoch). Synchronous, no Git. */
export function branchQueueBegan(root: string, branch: string): number | undefined {
  return latestViews.get(servedKey(root))?.began.get(branch);
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
/** The gate's answer when it can't read what it needs: never a quiet pass. */
export const TRIAL_UNREADABLE = "Sova can't confirm a passing trial of this branch now: try again in a moment.";

/**
 * Why a branch head can't merge or land yet as a setup branch (setup-branch.ts): it changes the project's setup and no
 * trial of exactly `head` passed; null when it isn't a setup branch or its trial passed. Merge Branch on a project the
 * queue doesn't serve asks this too. Fails closed: when the trials can't be read, a setup branch is refused.
 */
export async function setupUntriedAt(root: string, head: string): Promise<string | null> {
  if (!head || !root) return TRIAL_UNREADABLE;
  const q = queues ? ((await queues.peek(root)) ?? (await queues.get(root).catch(() => null))) : null;
  if (q) {
    const target = await q.targetHead();
    return target ? q.setupUntried(target, head) : TRIAL_UNREADABLE;
  }
  // No queue here: a branch that leaves the setup alone needs none; a setup branch can't be checked, so it waits.
  const { isSetupChange, setupChangeOf } = await import("./setup-branch");
  const { resolveTarget } = await import("./served");
  const { definitionAt } = await import("../project-services/deploy-recipe");
  const target = await resolveTarget(realGit, root, (r, ref) => definitionAt(r, ref)).catch(() => null);
  const change = target ? await setupChangeOf(realGit, root, target, head) : null;
  return change && !isSetupChange(change) ? null : TRIAL_UNREADABLE;
}

/** A project's trials and target as its queue keeps them (the Setup chat's tab reads them); null: no queue here. */
export async function setupTrialsAt(root: string): Promise<{ target: string; trials: import("../../shared/merge-queue").MergeTrial[]; readRun: (id: string) => import("../../shared/merge-queue").MergeRun | null } | null> {
  if (!queues || !root) return null;
  const q = await queues.peek(root);
  if (!q) return null;
  return { target: q.target, trials: q.trials(), readRun: (id) => q.store.readRun(id) };
}

export function mergeBareSettings(root: string): Promise<import("../../shared/merge-queue-settings").MergeQueueSettings | null> {
  return bareSettingsOf ? bareSettingsOf(root) : Promise.resolve(null);
}

/** A chat's merge queue cards (server/merge-queue/cards.ts); [] while the queue isn't started. */
export function mergeCardsOf(session: string): import("../../shared/merge-queue").MergeCard[] {
  return cards?.cardsOf(session) ?? [];
}

/** A chat's review cards (§chat.merge-queue/review-card); [] while the queue isn't started. */
export async function mergeReviewCardsOf(session: string): Promise<import("../../shared/merge-queue").ReviewCard[]> {
  return (await cards?.reviewsRead(session)) ?? [];
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
      const [{ askUser }, { listSessions }, { notifyOnce }, { listProjects }] = await Promise.all([import("./asks"), import("../sessions-index"), import("../push"), import("../projects/spaces")]);
      let projects: { id: string; name: string }[] = [];
      try {
        projects = listProjects();
      } catch {
        projects = [];
      }
      return askUser(keeper(), root, q, {
        ...(q.decide ? { decide: q.decide } : {}),
        sessions: () => listSessions(),
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
        const { listedSession } = await import("../sessions-index");
        const s = await listedSession(by.session).catch(() => undefined);
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
  return (await ownersNow()).ownerOf(worktree);
}
async function ownersNow(): Promise<WorktreeOwners> {
  if (!owners) {
    const [{ listSessions }, { trackedWorktrees }] = await Promise.all([import("../sessions-index"), import("../merge-readiness")]);
    const { createdByChats } = await import("../worktree-cleanup");
    owners = new WorktreeOwners({ sessions: () => listSessions(), tracked: trackedWorktrees, canonical, createdBy: createdByChats });
  }
  return owners;
}
/** A worktree one of the merge queue's own chats created (owners.ts queueMade): never on a list you land from. */
export async function worktreeQueueMade(worktree: string): Promise<boolean> {
  return (await ownersNow()).queueMade(worktree);
}
/** The same, for a whole list: one look (owners.ts queueMadeNow), then a lookup per row. */
export async function worktreeQueueMadeNow(): Promise<(worktree: string) => boolean> {
  return (await ownersNow()).queueMadeNow();
}

/** A worktree row's owner: its chat's id, file, title and archived mark. */
async function ownerRowOf(o: Owner): Promise<SessionWorktreeInfo["mergeOwner"]> {
  const { listedSession } = await import("../sessions-index");
  const s = await listedSession(o.session).catch(() => undefined);
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
export async function queueSubjectOf(id: string, sel: { entry?: string; branch?: string; review?: string }): Promise<QueueSubject | null> {
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
  if (sel.review) {
    // A finding's file (§chat.merge-queue/review-card): what that review read, while its commit is kept; then the branch now.
    const e = q.entry(sel.review.split(":")[0]!);
    const r = e?.project === q.id ? e.reviews?.find((x) => x.id === sel.review) : undefined;
    if (!e || !r) return null;
    const kept = async (sha: string) => (await realGit(["cat-file", "-e", `${sha}^{commit}`], root).catch(() => null))?.code === 0;
    if ((await kept(r.tip)) && (await kept(r.base))) return { kind: "reviewed", root, target: e.target, branch: e.branch, tip: r.tip, base: r.base };
    const w = (await worktreesOf(realGit, root)).find((x) => x.branch === e.branch && canonical(x.path) !== canonical(root));
    return w ? { kind: "ready", root, target: e.target, branch: e.branch, worktree: w.path } : { kind: "entry", root, target: e.target, branch: e.branch, commit: e.commit };
  }
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
  // When the branch last changed: its head's committer date (the Ready rows' own).
  const when = (await realGit(["log", "-1", "--format=%cI", head], root)).stdout.trim();
  const out = short.code === 0 ? { head, ahead, added, removed, ...(when ? { headAt: when } : {}) } : null;
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
      servedRootsNow = roots.map((r) => r.root);
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
  // A request to the branch's chat, on the merge queue's chat queue there (§chat.merge-queue/requests).
  const sendTo = async (session: string, text: string, info?: { kind?: string; branch?: string; entry?: string; place?: string }): Promise<void> => {
    const { listedSession } = await import("../sessions-index");
    const s = await listedSession(session);
    if (!s) throw new Error(`no session ${session}`);
    await (await import("./wake")).sendQueueWake(s.path, text, undefined, info);
  };
  // The moments the thread rules on (rulings.ts): the queue's event as the thread's message reads it.
  const rulingEvent = (ev: ThreadEvent, entry: ThreadEntry, base: { base?: string }): ThreadMessage | null => {
    const run = ev.run ?? "";
    const why = ev.why ? { summary: ev.why } : {};
    switch (ev.kind) {
      case "unattributed":
        return { kind: "unattributed", entry, run, ...why, ...base };
      case "review":
        return { kind: "review", entry, run, findings: ev.findings ?? "", ...(ev.waits ? { waits: ev.waits } : {}), ...base };
      case "resolution-failed":
        return { kind: "resolution-failed", entry, run, files: ev.files ?? [], ...why, ...base, ...(ev.scratch ? { scratch: ev.scratch } : {}), ...(ev.scratchError ? { scratchError: ev.scratchError } : {}) };
      case "drafts-changed":
        return { kind: "drafts-changed", entry, ...(ev.names ? { names: ev.names } : {}), ...(ev.request ? { request: ev.request } : {}), ...base };
      case "fix":
        return { kind: "fix", entry, request: ev.request ?? "", asked: ev.asked ?? "", ...(ev.fixCommit ? { commit: ev.fixCommit } : {}), ...(ev.drafts ? { drafts: true } : {}), ...(ev.summary ? { summary: ev.summary } : {}), ...base };
      case "chat-answer":
        return { kind: "chat-answer", entry, request: ev.request ?? "", answer: ev.answer ?? "cant", text: ev.text ?? "", ...(ev.otherTried ? { otherTried: true } : {}) };
      default:
        return null;
    }
  };
  const thread: WakeThread = (ev: ThreadEvent) => {
    const keeper = threadMod.mergeThread();
    const entry = { id: ev.entry.id, branch: ev.entry.branch, commit: ev.entry.commit, target: ev.entry.target };
    const base = ev.base ? { base: ev.base } : {};
    const mapped =
      ev.kind === "queued"
        ? { kind: "queued" as const, entry, ...base }
        : ev.kind === "conflict"
          ? { kind: "conflict" as const, entry, run: ev.run ?? "", files: ev.files ?? [], ...base, ...(ev.scratch ? { scratch: ev.scratch } : {}), ...(ev.scratchError ? { scratchError: ev.scratchError } : {}) }
          : ev.kind === "failed"
            ? { kind: "failed" as const, entry, run: ev.run ?? "", ...(ev.why ? { summary: ev.why } : {}), ...base }
            : ev.kind === "paused"
              ? { kind: "paused" as const, why: ev.why ?? "paused" }
              : ev.kind === "names"
                ? { kind: "names" as const, file: ev.namesFile ?? "", target: ev.target }
                : ev.kind === "idle"
                  ? { kind: "idle" as const, entry, ...(ev.lastLanded ? { lastLanded: ev.lastLanded } : {}), ...(ev.head ? { head: ev.head } : {}) }
                  : rulingEvent(ev, entry, base);
    if (!mapped) return false;
    if (!servedNow.has(servedKey(ev.root))) return false;
    if (!threadMod.hasMergeThread()) return false;
    keeper.notify(ev.root, mapped as Parameters<typeof keeper.notify>[1]);
    return true;
  };
  const sessionPath = async (session: string): Promise<string | null> => {
    const { listedSession } = await import("../sessions-index");
    return (await listedSession(session))?.path ?? null;
  };
  const mc = new MergeCards({
    dir: join(base, "cards"),
    lastEntry: async (session) => {
      const path = await sessionPath(session);
      if (!path) return null;
      return (await import("../transcript-cards")).lastRowEntry(path);
    },
    // A hand-back: a request on the merge queue's chat queue in the branch's chat (§chat.merge-queue/requests).
    wake: sendTo,
    placeOf: (root, target) => ({ label: placeLabel(root, served.everyProject()), root, target }),
    dropRequests: (entry) => void import("../topics").then((t) => t.dropMergeRequests(entry)),
    delivered: (request, delivery) => void stampDelivery(request, delivery),
    publish: (session, list, reviews) => publishFeed({ type: "merge_cards", session, cards: list, ...(reviews ? { reviews } : {}) }),
    // A review card stands where its request goes: a worker's in the chat that runs it (wake.ts sendQueueWake).
    homeOf: async (session) => {
      const { getSessionSummary, workerParentOf } = await import("../sessions-index");
      let path = await sessionPath(session);
      for (let hops = 0; path && hops <= 8; hops++) {
        const s = await getSessionSummary(path).catch(() => null);
        if (!s) return null;
        if (!s.workerSession) return { id: s.id, path: s.path };
        path = await workerParentOf(path);
      }
      return null;
    },
    reviewerOf: (root, run) => {
      const r = reviewerOfRun(root, run);
      return r ? { session: r.session, path: r.path, ...(r.cleared ? { cleared: true as const } : {}) } : undefined;
    },
    log: (line) => console.warn(line),
  });
  cards = mc;
  setMergeCardNoteSource((session, since) => mc.noteFor(session, since));
  // Each chat's landing lines: whether each repo it works in lands through the queue (a6).
  const { MERGE_QUEUE_PROFILES } = await import("../merge-readiness");
  const notes = new LandingNotes({
    repos: async (session) => {
      const { listedSession } = await import("../sessions-index");
      const s = await listedSession(session);
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
  const summaryFor = (root: string, branch: string, commit: string, front = false) => {
    if (!servedNow.has(servedKey(root))) return;
    bs.ensure(root, branch, commit, { front });
  };
  // A chat is idle read as the worktree readiness reads it (server/merge-readiness.ts runningNow: busy, working, or a
  // worker working); an unknown chat counts as idle.
  const chatIdle = async (session: string): Promise<boolean> => {
    const { listedSession } = await import("../sessions-index");
    const x = await listedSession(session);
    return !x || !(x.busy || x.activity?.state === "working" || (x.workers?.working ?? x.live?.workers?.working ?? 0) > 0);
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
    // A trial's end reaches the chat that started it, as a request on its merge queue chat queue (between turns).
    trialEnded: (t, run, root) => {
      if (t.by.kind !== "chat" || !t.by.session) return;
      const session = t.by.session;
      void (async () => {
        const path = await sessionPath(session);
        if (!path) return;
        (await import("../merge-readiness")).rereadReadiness(path);
        await (await import("./wake")).sendQueueWake(path, trialEndedText(t, run), undefined, { kind: "trial", ...(t.branch ? { branch: t.branch, place: placeLabel(root, served.everyProject()) } : {}) });
      })().catch((err) => console.warn(`[merge-queue] trial note to ${session}: ${err instanceof Error ? err.message : err}`));
    },
    // Why a sent-back branch's newest commit isn't Ready to land: its chat's last readiness reading, never a fresh read.
    // The chat's own newest check run, as its last readiness reading saw it (never a fresh read): a failing one keeps a
    // fix out of line (§app.merge-queue/standing-approval), in the words Ready to land uses.
    chatCheckFailing: async (session) => {
      const [{ listedSession }, { readinessChecksOf }, { lastCheckWords }] = await Promise.all([import("../sessions-index"), import("../merge-readiness"), import("../ready-to-land")]);
      const path = (await listedSession(session))?.path;
      const c = path ? readinessChecksOf(path)?.lastCheck : undefined;
      return c && !c.ok ? lastCheckWords(c) : null;
    },
    newestReading: async (worktree, tip) => {
      const [{ listedSession }, { readinessReading }, { newestReadingOf }] = await Promise.all([import("../sessions-index"), import("../merge-readiness"), import("../ready-to-land")]);
      return newestReadingOf(worktree, tip, { owner: worktreeOwnerOf, pathOf: async (id) => (await listedSession(id))?.path, reading: readinessReading, canonical });
    },
    // A test check broken on the target: one notification that opens the project's Merge Queue tab (its Needs you
    // holds the flag), so the user can start a chat to fix the target.
    flagBroken: (b, root) => {
      const id = projectIdOf(root);
      void import("../push")
        .then(({ notifyOnce }) =>
          notifyOnce({ title: `The merge queue needs you · ${root.split("/").pop() ?? root}`, body: `${b.why}. Branches skip it until it's fixed: start a chat to fix it.`, hash: id ? `#/projects/${encodeURIComponent(id)}/merge-queue` : "#/projects", tag: `sova:merge-broken:${id ?? root}:${b.check}` }),
        )
        .catch((err) => console.warn(`[merge-queue] ${root}: notification not sent: ${err instanceof Error ? err.message : String(err)}`));
    },
    // The branch's card in its own chat: raised at the approval, a revision at each outcome (cards.ts).
    // A decision's one notification: a tap opens the branch's chat at its card (the tab when no chat shows it).
    decided: (e, root) => {
      // The chat that shows the decision (a worker's: the chat running it); none that can (archived, open in a terminal,
      // an Overseer, a baton chat): the decision waits on the tab, and the tap opens the tab.
      void Promise.all([import("../push"), import("./rulings"), import("./asks"), import("../sessions-index")])
        .then(async ([{ notifyOnce }, { decisionPush }, { askTarget }, { listSessions }]) => {
          const chat = askTarget(e, await listSessions().catch(() => []));
          return notifyOnce(decisionPush(chat ? { ...e, session: chat.id } : e, projectIdOf(root), { onTab: !chat }));
        })
        .catch((err) => console.warn(`[merge-queue] ${root}: decision notification not sent: ${err instanceof Error ? err.message : String(err)}`));
    },
    // A merge thread question answered from the branch's chat with its decision: closed, and handed to the thread.
    answerAsk: (root, ask, text, session) => {
      const r = threadMod.mergeThreadKeeper()?.answer(root, ask, text, { kind: "chat", ...(session ? { session } : {}), from: "the user, in the branch's chat" });
      if (r && !r.ok) console.warn(`[merge-queue] ${root}: answer to ${ask} not passed on: ${r.error}`);
    },
    notify: (kind, e, extra) => {
      // An approved branch was Ready to land at its commit: its summary is written if it has none yet.
      // An approval's goes to the front of the line.
      if (kind === "approved") summaryFor(extra.root, e.branch, e.commit, true);
      const request = (extra as { request?: MergeChatRequest }).request;
      // A request that is no outcome of its own goes to the chat as itself (§chat.merge-queue/requests).
      if (request && kind !== "needs-fix" && kind !== "sent-back") return cardsDo(mc.request(e, request, extra.run));
      // A Land press closes the stretch before it (§app.message-labels/labelling), at the press's time; a typed "land it" is a
      // message of its own, and an automatic re-queue of a checked fix is no press.
      if (kind === "approved" && extra.press && e.approval.by === "land-button" && e.session) recordLand(e.session, Date.parse(extra.press));
      cardsDo(kind === "approved" ? mc.approved(e, extra.root) : mc.outcome(kind as never, e, { ...(extra.run ? { run: extra.run } : {}), root: extra.root, ...(request ? { request } : {}) }));
    },
    summaryOf: (root, branch, commit): BranchSummary | undefined => bs.summaryOf(root, branch, commit),
    pruneSummaries: (root, live, shown) => void bs.prune(root, live, shown),
    // The branch's chat (owners.ts): the Ready rows show it, and a Land naming no chat records it.
    ownerOf: async (_root, _branch, worktree) => (worktree ? worktreeOwnerOf(worktree) : null),
    // A conflict's scratch copy the merge thread made itself (old style): hidden from Ready, refused by Land.
    queueMade: () => worktreeQueueMadeNow(),
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
    chatIdle,
    chatTitle: async (session) => {
      const { listedSession } = await import("../sessions-index");
      const t = (await listedSession(session))?.title;
      return t && t !== "Untitled" ? t : null;
    },
    ...(legacyNames ? { legacyNames } : {}),
    // The review and thread models: the new-chat default and Settings → Models' policy (models.ts).
    modelCheck: (await import("./models")).liveModelCheck(),
    releaseEvent: (ev) => releaseWire.releaseEvent(ev),
  });
  const q = queues;
  // The merge queue's chat queue (§chat.merge-queue/requests, channel.ts): delivery stamps, Stop's pause, and the held
  // note of a decision going with the user's own message.
  stampDelivery = async (request, delivery, session) => {
    for (const pq of await q.loaded()) if (pq.requestOf(request)) return pq.requestDelivered(request, delivery, session);
    // A before-Land request (readiness's notes, no entry): the chat it reached may answer it (answers.ts).
    if (delivery === "delivered" && session) (await import("./answers")).looseDelivered(request, session);
  };
  const { setChannelHooks } = await import("./channel");
  setChannelHooks({
    requestDelivered: (request, delivery, session) => void stampDelivery(request, delivery, session).catch(() => {}),
    chatPaused: (sessionId, paused) =>
      void q
        .loaded()
        .then((all) => Promise.all(all.map((pq) => pq.chatPaused(sessionId, paused))))
        .catch((err) => console.warn(`[merge-queue] pause of ${sessionId}: ${err instanceof Error ? err.message : err}`)),
    takeHeldNote: async (chat, userText, decision) => {
      const loaded = await q.loaded();
      // A question held on the tab (q15): the user answers in the merge thread's own chat; their message carries it.
      const keeper = threadMod.mergeThreadKeeper();
      for (const pq of loaded) {
        if (!keeper?.isThreadChat(pq.root, chat.sessionId)) continue;
        // The question the composer named (`ak_…`), else the newest one held on the tab; a decision id is no question.
        if (decision && !decision.startsWith("ak_")) break;
        const ask = decision ? keeper.asks(pq.root).find((x) => x.id === decision && !x.answered) : keeper.openAsk(pq.root);
        if (!ask?.onTab) continue;
        const r = keeper.answer(pq.root, ask.id, userText, { kind: "operator", from: "the user, in the merge thread", quiet: true });
        if (r.ok) return { request: ask.id, ...(ask.branch ? { branch: ask.branch } : {}), text: `The question you asked the user (${ask.id}${ask.branch ? `, about ${ask.branch}` : ""}): ${ask.question}\nTheir message above is their answer.` };
      }
      const waiting: { pq: ProjectQueueOf<typeof q>; e: MergeEntry }[] = [];
      for (const pq of loaded) for (const e of pq.entries()) if (e.decision && !e.decision.answered && e.decision.heldNote) waiting.push({ pq, e });
      if (!waiting.length) return null;
      const [{ listSessions }, { askTarget }] = await Promise.all([import("../sessions-index"), import("./asks")]);
      const sessions = await listSessions();
      // The decision the user answered: the one their composer named, else the newest waiting here (the card nearest
      // the message box). Never another chat's, never an older one by queue order.
      const { pickHeldDecision } = await import("./channel");
      const pick = pickHeldDecision(waiting, chat.sessionId, decision, (e) => askTarget(e, sessions)?.id);
      for (const { pq, e } of pick ? [pick] : []) {
        const d = e.decision!;
        const held = await pq.decisionAnswered(e.id, d.id, userText, { session: chat.sessionId });
        if (!held) continue;
        void stampDelivery(held.request, "delivered", chat.sessionId).catch(() => {});
        return { request: held.request, branch: e.branch, text: held.text };
      }
      return null;
    },
  });
  // A served tree that reads Ready to land at a commit (merge-readiness.ts): its branch summary is written.
  const { configureReadiness } = await import("../merge-readiness");
  configureReadiness({
    // A setup branch is Ready to land only once a trial of its exact head passed (setup-branch.ts).
    setupUntried: async (dir, head) => {
      const p = await projectOf(dir);
      if (p.state !== "ok" || !p.git || !served.isListed(p.root)) return null;
      const queue = (await q.peek(p.root)) ?? (await q.get(p.root));
      const target = await queue.targetHead();
      return target ? queue.setupUntried(target, head) : null;
    },
    readyToLand: (t) =>
      void projectOf(t.path)
        .then((p) => (p.state === "ok" && p.git ? summaryFor(p.root, t.branch, t.commit) : undefined))
        .catch(() => {}),
    // A served tree's chat read idle: the sweep's next look passes over its project.
    treeIdle: (t) =>
      void projectOf(t.path)
        .then((p) => (p.state === "ok" && p.git && servedNow.has(servedKey(p.root)) ? sweep?.poke(servedRootsNow.find((r) => servedKey(r) === servedKey(p.root)) ?? p.root) : undefined))
        .catch(() => {}),
  });
  // Every branch on a served project's Ready list gets its bullets once its chat is idle; its first pass is the
  // backfill. Never started by a view or a page read.
  sweep = new SummarySweep({
    roots: () => servedRootsNow,
    readyOf: async (root) => (await q.get(root)).readyRows(),
    targetHead: async (root) => (await (await q.get(root)).declared()).head || null,
    chatIdle,
    summaries: bs,
    log: (line) => console.warn(line),
  });
  sweep.start();
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
    isReviewerChat: review.isReviewerChat,
    deliverReview: review.deliverReview,
    ...(await threadVerbDeps(served)),
    // merge.live / merge.restart (restart.ts) and merge.names (names-verb.ts): what the sandboxed thread can't reach.
    restart: await (await import("./restart")).liveRestartDeps(),
    names: async (pq, action, text) => (await import("./names-verb")).namesStep(pq, action, text, join(threadMod.DEFAULT_PLAYBOOK_DIR, "scripts", "discover-names.mjs")),
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
    return { ...(summary ? { mergeSummary: summary } : {}), ...(ownerRow ? { mergeOwner: ownerRow } : {}), ...(queue ? { queue } : {}), mergeProject: { id, root: p.root, target: v.target, checks: v.checks, review: v.review, ...(v.invalid ? { invalid: v.invalid } : {}), ...(v.paused ? { paused: v.paused.why } : {}), ...(v.settings?.how?.effective ? { how: v.settings.how.effective } : {}) }, ...(stats ? { mergeStats: stats } : {}), mergeServed: true };
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
  logSweep = (await import("./run-logs")).startRunLogSweep({ queues: async () => (queues ? queues.loaded() : []) });
  // Rows read before this line have no queue fields, and nothing else re-reads an archived one.
  void rereadUnrooted();
  // The chats' file is current before the typed go-ahead door opens.
  await writer.first;
  // Leftover records of a repo the queue doesn't serve stay on disk, never loaded.
  for (const root of recordedRoots(base))
    void served
      .served(root)
      .then((yes) => (yes ? q.get(root) : null))
      // A restart this queue asked for: checked against the commit this start runs (restart.ts).
      .then(async (pq) => (pq ? (await import("./restart")).checkRestartAtStart((await import("./restart")).restartQueueOf(pq), await (await import("./restart")).liveRestartDeps()) : null))
      .catch((err) => console.warn(`[merge-queue] ${root}: ${err instanceof Error ? err.message : err}`));
  ingest = startIngest(
    ingestDepsFor({
      base,
      file: join(stateRoot(), LANDING_FILE_NAME),
      rule: served,
      queue: (root) => q.get(root),
      // The chat's repo: its cwd's main checkout.
      repoOf: async (session) => {
        const { listedSession } = await import("../sessions-index");
        const s = await listedSession(session).catch(() => undefined);
        const p = s?.cwd ? await projectOf(s.cwd).catch(() => null) : null;
        return p?.state === "ok" && p.git ? p.root : null;
      },
      // A typed "land it" that couldn't be queued: the chat's model hears it at its next turn (no message is sent).
      refused: (session, text) => mc.addLine(session, `refused:${Date.now()}`, text),
    }),
  );
}

type LandingListed = { id: string; root: string; name: string; archived?: unknown };
let landingList: (() => LandingListed[]) | null = null;
/** Tests only: the Projects list the landing summary names projects from (null: listProjects). */
export function setLandingListForTest(f: (() => LandingListed[]) | null): void {
  landingList = f;
}

/**
 * GET /api/merge-queue/landing-summary: every listed project's queue cut (ProjectQueue.landingCut, loaded queues that
 * serve it) and release cut (Releaser.landingCut), one answer, no Ready-list or tag-history reads. A project with
 * neither is left out; one whose read fails has null there. Empty while the queue isn't started.
 */
export async function landingSummary(): Promise<LandingSummary> {
  const at = new Date().toISOString();
  const q = queues;
  if (!q) return { projects: [], at };
  const [{ listProjects }, { releaser }] = await Promise.all([import("../projects/spaces"), import("../project-services/release-wire")]);
  const listed = new Map(
    (landingList ?? listProjects)()
      .filter((p) => !p.archived)
      .map((p) => [servedKey(p.root), p] as const),
  );
  const loaded = new Map((await q.loaded().catch(() => [])).map((pq) => [servedKey(pq.root), pq] as const));
  const r = releaser();
  const releaseRoots = new Map((r?.roots() ?? []).map((root) => [servedKey(root), root] as const));
  const keys = [...new Set([...loaded.keys(), ...releaseRoots.keys()])].filter((k) => listed.has(k));
  const warn = (what: string, root: string) => (err: unknown) => (console.warn(`[merge-queue] ${root}: landing summary ${what}: ${err instanceof Error ? err.message : err}`), null);
  const projects = await Promise.all(
    keys.map(async (key): Promise<LandingSummaryProject | null> => {
      const p = listed.get(key)!;
      const pq = loaded.get(key);
      const relRoot = releaseRoots.get(key);
      const [queue, release] = await Promise.all([
        pq ? pq.landingCut().then((c) => (c.served ? c : null), warn("queue", key)) : Promise.resolve(null),
        r && relRoot ? r.landingCut(relRoot).catch(warn("release", key)) : Promise.resolve(null),
      ]);
      return queue || release ? { id: p.id, root: p.root, name: p.name || p.id, queue, release } : null;
    }),
  );
  return { projects: projects.filter((x): x is LandingSummaryProject => !!x), at };
}

/** Try Again on a branch summary that failed (POST /api/merge-queue/projects/:project/branch-summary). */
export async function retryBranchSummary(projectId: string, branch: string, commit: string): Promise<{ ok: true } | { ok: false; code: "not-found" | "invalid-request" | "busy" | "unsupported"; message: string }> {
  if (!queues || !summaries) return { ok: false, code: "unsupported", message: "The merge queue isn't running." };
  const root = await projectRootOf(projectId);
  if (!root) return { ok: false, code: "not-found", message: `no project ${projectId}` };
  const r = summaries.retry(root, branch, commit);
  return r.ok ? { ok: true } : r;
}

/** Tests: the summaries' sweep the server runs. */
export const summarySweepNow = (): SummarySweep | null => sweep;

/** Tests: the store the server writes branch summaries with. */
export const branchSummariesNow = (): BranchSummaries | null => summaries;

export async function stopMergeQueue(): Promise<void> {
  sweep?.stop();
  sweep = null;
  logSweep?.stop();
  logSweep = null;
  summaries = null;
  rowsOf = null;
  listDeps = null;
  resetQueueViewsForTest();
  owners = null;
  servedWriter?.stop();
  servedWriter = null;
  setServedRule(null);
  servedNow = new Set();
  servedRootsNow = [];
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
