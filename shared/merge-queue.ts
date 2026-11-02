/**
 * The merge queue's shared shapes: one queue per project, one branch checked at a time in a merge copy beside the
 * project, master fast-forwarded to exactly the tested commit. Types and small pure helpers only (no imports, no fs):
 * the server (server/merge-queue/), the verbs' results (shared/project-contract.ts `VerbResult.merge`), the WS feed
 * (shared/protocol.ts `merge_queue`) and the screens (src/lib/merge-queue.ts) read them alike.
 *
 * Words: an ENTRY is one approved branch at one pinned commit; a RUN is one attempt to check it (a merge copy reset
 * to the target's head, the branch merged, docs made, checks run); a STEP is one logged part of a run.
 */

// ---- entries ------------------------------------------------------------------------------------

/**
 * Where an entry stands.
 * - `queued`: approved, waiting its turn (`position` 1-based).
 * - `checking`: its run is the one running now.
 * - `conflict`: the merge onto the target conflicted; the merge thread is judging it. The line moves on meanwhile.
 * - `behaviour-differs`: the thread judged the two sides want different behaviour: waits for the user (Accept /
 *   Send Back), with both sides in plain words and the proposed resolution (`conflict`).
 * - `review-flagged`: the review step said blocking: waits for the user (Land Anyway / Send Back).
 * - `drafts-changed`: the branch's spec drafts changed since the user approved: waits for a new Land.
 * - `needs-fix`: handed back to the branch's chat (a failure blamed on the branch, a conflict sent back, or the
 *   user's Send Back); a new Land queues it again.
 * - `landed`: master holds it (`landed`).
 * - `cancelled`: the user (or the branch's chat, on the user's word) took it out of the line.
 */
export type MergeEntryState = "queued" | "checking" | "conflict" | "behaviour-differs" | "review-flagged" | "drafts-changed" | "needs-fix" | "landed" | "cancelled";
/** The states that wait for the user's answer (the "needs you" list). */
export const WAITING_FOR_USER: readonly MergeEntryState[] = ["behaviour-differs", "review-flagged", "drafts-changed"];
/** The states an entry never leaves by itself. */
export const ENTRY_FINAL: readonly MergeEntryState[] = ["landed", "cancelled", "needs-fix"];
/** States that hold a place in the line (one live entry per branch at a time). */
export const ENTRY_OPEN: readonly MergeEntryState[] = ["queued", "checking", "conflict", "behaviour-differs", "review-flagged", "drafts-changed"];

/** How the user approved: the Land button (composer modal, session pane, Merge Queue view) or "land it" typed in the
 *  branch's own chat (ingested from the worktree tool's go-ahead record). */
export type ApprovalBy = "land-button" | "typed";

export interface MergeApproval {
  by: ApprovalBy;
  /** ISO time. */
  at: string;
  /** The commit approved (full sha): the one that lands, whatever the branch does after. */
  commit: string;
  /** The chat it was approved in (the branch's own chat for a typed word). */
  chat?: string;
  /** The branch's spec drafts at approval: one hash over every draft file and their names. A change after
   *  approval makes the entry `drafts-changed`. Absent: it had none (or `withoutSpecs`). */
  drafts?: { hash: string; names: string[] };
  /** "Land without its specs…": the drafts stay behind; nothing is made official. */
  withoutSpecs?: true;
  /** "Land without review" / "land it, skip review": no review step for this merge. */
  withoutReview?: true;
}

/** A note on an entry, shown on its row (queue view, composer popup, pane). Sova attaches no meaning to the text. */
export type MergeNoteKind =
  /** The merge thread's free text ("changes server code; restart Sova to pick it up"); one per entry, latest wins. */
  | "thread"
  /** The operator's own text; replaces the thread's. */
  | "operator"
  /** The review step's notes (verdict `notes`), or the user's Land Anyway over a blocking review. */
  | "review"
  /** A check failed, then passed on a rerun: noted, not blocking. */
  | "flaky"
  /** A check failed on the target too, in the same copy: noted, not blocking. */
  | "master-red"
  /** The thread resolved a conflict judged to change no behaviour: what it resolved and why that is safe. */
  | "resolved"
  /** The project declares no automated tests: it landed after a clean merge alone. */
  | "no-checks";
export interface MergeNote {
  kind: MergeNoteKind;
  text: string;
  at: string;
}
export const NOTE_MAX = 300;

/** A check the run will run, and why it is in the list. */
export type CheckSource = "required" | "trigger" | "picked";
export interface CheckPick {
  /** A check id from the project's merge section (required or optional), or `test` for its test command. */
  id: string;
  label: string;
  source: CheckSource;
  /** required: absent; trigger: the paths that set it off ("statecharts/** changed"); picked: the merge thread's reason. */
  why?: string;
  /** picked: test selectors for that check (files, names), when the thread narrows it. */
  select?: string[];
}

/** The merge thread's judgement of a conflict (merge.resolve). */
export interface ConflictJudgement {
  /** The files that conflicted. */
  files: string[];
  verdict: "no-behaviour-change" | "behaviour-differs";
  /** The target's side, in plain words. */
  ours: string;
  /** The branch's side, in plain words. */
  theirs: string;
  /** What the resolution does, in plain words. */
  proposal: string;
  /** The resolution: a merge commit whose parents are a commit of the target and the pinned commit. */
  commit?: string;
  /** The mechanical sanity check of `commit` (remerge-diff confined to the conflict hunks; no mode, rename, binary or
   *  delete changes). Failing it turns a "no-behaviour-change" into "behaviour-differs". */
  sanity?: { ok: boolean; why?: string };
  at: string;
}

/** The review step's verdict on one commit (merge.review, or the review step's own result). */
export interface ReviewVerdict {
  verdict: "ok" | "notes" | "blocking";
  /** notes / blocking: what the reviewer says, short. */
  text?: string;
  /** The merge commit it reviewed. */
  commit: string;
  at: string;
}

/** Blame for a red run, earned the way the decisions say: a failure is the branch's only once the same check passes
 *  on the target alone in the same copy. */
export type Blame =
  /** Passes on the target alone, fails with the branch: handed back to the branch's chat. */
  | "branch"
  /** Fails on the target too: noted (a whole check red on the target pauses the queue). */
  | "master"
  /** Setup / machine / timeout on the target too: retried once, then paused; never sent to a branch. */
  | "machine"
  /** Passed on a rerun: noted, not blocking. */
  | "flaky"
  /** A resolution the thread judged safe failed a check: back to the user, the branch isn't blamed. */
  | "resolution"
  /** The reviewer itself failed (error, timeout): retried, then paused; never blamed on the branch. */
  | "reviewer";

export interface MergeEntry {
  id: string;
  /** The project's id (server/projects). */
  project: string;
  /** The branch it lands into (master; motorsaif: main). */
  target: string;
  branch: string;
  /** The worktree it was approved from, when known. */
  worktree?: string;
  /** The session whose branch it is, when known (notices go there). */
  session?: string;
  /** The pinned commit (full sha) = approval.commit. */
  commit: string;
  approval: MergeApproval;
  state: MergeEntryState;
  /** queued: 1-based place in the line. */
  position?: number;
  /** One line: why it stands where it stands ("conflicts in 2 files", "unit failed: src/a.test.ts"). */
  reason?: string;
  /** The branch moved past the pinned commit since approval: how many commits are not included. */
  newerCommits?: number;
  /** The run now checking it, or the last one that did. */
  run?: string;
  /** Every run it had, oldest first. */
  runs: string[];
  /** Checks the merge thread added (merge.extend); never removes a required one. */
  picks: CheckPick[];
  /** conflict: the files the last merge conflicted on (before any judgement). */
  conflictFiles?: string[];
  conflict?: ConflictJudgement;
  review?: ReviewVerdict;
  notes: MergeNote[];
  /** landed: where master went. */
  landed?: { sha: string; from: string; at: string; pushed: PushState; pushWhy?: string };
  /** Estimates (ms): when it should start from now, and how long its run takes. */
  eta?: { startsInMs: number; takesMs: number };
  createdAt: string;
  updatedAt: string;
}

export type PushState = "pending" | "pushed" | "not-pushed" | "no-remote";

// ---- runs and steps -----------------------------------------------------------------------------

export type RunStepKind =
  | "copy" // the merge copy reset to the target's head (git reset/clean)
  | "setup" // the project's setup steps in the copy
  | "install" // an offline dependency install when the branch changes a lockfile
  | "merge" // the pinned commit merged onto the target's head (or the thread's resolution taken)
  | "docs" // the spec drafts made official in the copy, before any check
  | "check" // one check (required, trigger or picked)
  | "review" // the review step, in parallel with the checks
  | "rerun-tip" // a failed check rerun on the merge (flaky?)
  | "rerun-master" // a failed check rerun on the target alone in the same copy (whose?)
  | "land" // master fast-forwarded to the tip
  | "main-checkout" // the project's main folder fast-forwarded too
  | "push" // pushed, ff only, leak-scan gated
  | "notice"; // the branch's chat told

export type StepResult = "pending" | "running" | "passed" | "failed" | "skipped";

export interface RunStep {
  /** Unique within the run ("copy", "check:unit", "rerun-master:unit"). */
  id: string;
  kind: RunStepKind;
  label: string;
  result: StepResult;
  startedAt?: string;
  ms: number;
  /** check: where it came from and why. */
  source?: CheckSource;
  why?: string;
  /** One line on what happened ("skipped: no change to its paths", "3 failed"). */
  detail?: string;
  /** The step's log file, relative to the run's folder (every step has one from its first line). */
  log: string;
  counts?: { passed: number | null; failed: number | null; skipped: number | null } | null;
  failures?: { file?: string; name?: string; message?: string; blame?: Blame }[];
}

export type RunVerdict =
  | "running"
  | "passed" // tested; landed or about to
  | "failed" // red, blamed (see `blame`)
  | "conflict" // the merge conflicted
  | "waiting" // waiting for the user (behaviour differs, review flagged)
  | "machine" // setup / machine / reviewer failure on the target too
  | "void" // the target moved, the server stopped, cancelled: nothing blamed, rerun from the start
  | "cancelled";

export interface MergeRun {
  id: string;
  entry: string;
  project: string;
  branch: string;
  /** The target's head the run started on. */
  base: string;
  /** The pinned commit it merged. */
  commit: string;
  /** The merge commit, then (docs) the tip that lands. */
  mergeSha?: string;
  tip?: string;
  /** The merge copy it ran in (always beside the project, never under the state root). */
  copy?: string;
  steps: RunStep[];
  checks: CheckPick[];
  verdict: RunVerdict;
  blame?: Blame;
  /** One line: why the verdict. */
  why?: string;
  startedAt: string;
  endedAt?: string;
  /** "No checks declared": the project said so. */
  noChecks?: true;
}

// ---- the queue ----------------------------------------------------------------------------------

/** Why the queue is paused: approvals are still accepted, runs wait. */
export type PauseKind =
  | "operator" // merge.pause
  | "master-moved" // the target moved outside the queue: the run was voided; resume to go on
  | "machine" // setup / machine failure on the target too, twice
  | "master-red" // a whole check is red on the target alone
  | "main-checkout-dirty" // the project's main folder has uncommitted edits: master landed, the folder not moved
  | "reviewer" // the reviewer failed twice
  | "recovery"; // a landing in flight at a stop could not be reconciled
export interface PauseInfo {
  kind: PauseKind;
  why: string;
  at: string;
  /** The run it concerns, when one. */
  run?: string;
}

/** What the project declares for its checks: a `merge` section list, one test command, "no automated tests", or
 *  nothing yet (onboarding; no approval accepted). */
export type ChecksDeclared = "declared" | "test-command" | "none" | "unset";

export interface MergeQueueHeads {
  /** The target's head now. */
  target: string;
  /** origin's copy of the target, when known. */
  pushed?: string;
  /** Why the last landing wasn't pushed ("held for a release", "leak scan: …", "origin moved"). */
  pushWhy?: string;
  /** Checks red on the target alone, by label. */
  targetRed?: string[];
}

/** The landed row of the view: the entry and its run summary. */
export interface MergeLanded {
  entry: MergeEntry;
  run?: Pick<MergeRun, "id" | "verdict" | "startedAt" | "endedAt" | "noChecks">;
}

export interface MergeQueueView {
  project: string;
  /** The project's main checkout. */
  root: string;
  target: string;
  /** Branches tested together: fixed at 1, not shown. */
  batch: 1;
  state: "idle" | "running" | "paused";
  paused?: PauseInfo;
  checks: ChecksDeclared;
  /** The project declares a review kit. */
  review: boolean;
  /** The run checking now. */
  current?: MergeRun;
  /** Entries in state `checking`: the one whose run is `current`, or one tested and held (a paused landing). */
  checking: MergeEntry[];
  /** Queued entries in line order (`position` 1…). */
  waiting: MergeEntry[];
  /** Entries waiting for the user (behaviour differs, review flagged, drafts changed) and conflicts the thread
   *  judges. */
  needsYou: MergeEntry[];
  /** Handed back to their chats, newest first (last 20). */
  needsFix: MergeEntry[];
  /** Landed, newest first (last 20), each with its notes. */
  recent: MergeLanded[];
  heads: MergeQueueHeads;
  /** The merge thread's chat for this project, when one is recorded. */
  thread?: { session: string; startedAt: string };
  /** Ready, not approved: this project's worktree branches with commits the target hasn't, a clean tree, a head that
   *  isn't TEMP, and no entry in line or landed at that commit (the view's Land list). */
  ready?: MergeReady[];
  /** Try It on Main (merge.setup dryRun): the run in flight, or the last one. */
  tryRun?: MergeRun;
  at: string;
}

/** What the session's worktree rows read (SessionWorktreeInfo.queue): the newest entry for that branch. */
export type WorktreeQueueInfo = Pick<MergeEntry, "id" | "state" | "position" | "commit" | "reason" | "newerCommits" | "eta" | "notes" | "landed" | "conflict" | "review"> & {
  project: string;
  run?: string;
  /** The project has a review kit (the Land menu shows "Land without review"). */
  reviewKit?: boolean;
};

export interface MergeReady {
  branch: string;
  worktree: string;
  commit: string;
  /** Commits ahead of the target. */
  ahead: number;
}

/** SessionWorktreeInfo.mergeProject: the project a worktree lands into, whatever its entry. */
export interface WorktreeMergeProject {
  /** The registered project's id. */
  id: string;
  /** Its main checkout. */
  root: string;
  target: string;
  checks: ChecksDeclared;
  review: boolean;
  /** The queue is paused (why). */
  paused?: string;
}

// ---- the verbs (POST /api/project-services/merge.<x>; shared/project-contract.ts MERGE_VERBS) ---

/**
 * merge.status  {project}                                     → view
 * merge.logs    {run, step?, lines?}                          → run + lines
 * merge.add     {project?, branch | checkout, commit?, withoutSpecs?, withoutReview?, chat?}  → entry (+ view)
 * merge.cancel  {entry, note?}                                → entry
 * merge.pause   {project, why?}                               → view
 * merge.resume  {project}                                     → view
 * merge.note    {entry, note}                                 → entry (empty note clears the thread's)
 * merge.extend  {entry, checks, select?, why, note?}          → entry (adds picks; never drops)
 * merge.resolve {entry, verdict, files?, ours, theirs, proposal, commit?, note?}  → entry (the thread's judgement)
 * merge.answer  {entry, answer: accept | send-back | land-anyway, why?}          → entry (the user's)
 * merge.review  {run, verdict, text?}                         → entry (the review step's verdict)
 * merge.retry   {project | entry, note?}                      → view (rerun after a machine pause)
 */
export const MERGE_ANSWERS = ["accept", "send-back", "land-anyway"] as const;
export type MergeAnswer = (typeof MERGE_ANSWERS)[number];

/** `VerbResult.merge`: what a merge verb answers. */
export interface MergeReport {
  view?: MergeQueueView;
  entry?: MergeEntry;
  run?: MergeRun;
  /** merge.logs: the step's log lines (newest last). */
  lines?: string[];
}

// ---- the WS feed --------------------------------------------------------------------------------

/** On the session feed (shared/protocol.ts SessionFeedMessage): a project's queue changed. */
export interface MergeQueueFeed {
  type: "merge_queue";
  project: string;
  view: MergeQueueView;
}

// ---- small pure helpers -------------------------------------------------------------------------

/** The words a row shows for an entry's state ("Queued · 2nd"). */
export function entryStateWords(e: Pick<MergeEntry, "state" | "position">): string {
  switch (e.state) {
    case "queued":
      return e.position ? `Queued · ${ordinal(e.position)}` : "Queued";
    case "checking":
      return "Checking";
    case "conflict":
      return "Conflict";
    case "behaviour-differs":
      return "Behaviour differs · waiting for you";
    case "review-flagged":
      return "Review flagged · waiting for you";
    case "drafts-changed":
      return "Drafts changed since you approved";
    case "needs-fix":
      return "Needs a fix";
    case "landed":
      return "Landed";
    case "cancelled":
      return "Cancelled";
  }
}

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "1 newer commit not included". */
export function newerWords(n: number | undefined): string | null {
  if (!n) return null;
  return `${n} newer commit${n === 1 ? "" : "s"} not included`;
}
