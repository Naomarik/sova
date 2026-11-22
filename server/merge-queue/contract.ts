/**
 * The seam between the queue (queue-engine: store, queue, land, recover, ingest, notices, routes, view) and one run
 * (copy-checks: copy, run, checks, attribute, estimate, review-step). Types only.
 *
 * The queue decides WHICH entry runs and WHEN, and owns master: it never lets a run move the target. A run owns the
 * merge copy: reset it to `base`, set up, merge the pinned commit (or take the thread's resolution), make the docs,
 * run the checks (and the review step beside them), attribute any red, and answer an outcome. It never touches the
 * project's main checkout, the target branch or the remote.
 */
import type { ProjectDef } from "../../shared/project-contract";
import type { Blame, CheckPick, MergeEntry, MergeNote, ReviewVerdict, RunStep } from "../../shared/merge-queue";

export interface RunInput {
  /** mr_… */
  runId: string;
  /** Every commit the queue has recorded landing for this branch. The run skips its merge for a commit exactly on this
      list, or one the merge copy finds on the base (§app.merge-queue/run); absent on a resolved conflict's run. */
  landingPins?: readonly string[];
  entry: MergeEntry;
  project: {
    id: string;
    /** The main checkout. */
    root: string;
    /** The branch it lands into. */
    target: string;
    /** The definition read from the TARGET's head (never the branch's). null: none. */
    def: ProjectDef | null;
  };
  /** The target's head sha the run starts on. */
  base: string;
  /** The commit to merge: the entry's pinned commit. */
  commit: string;
  /** A conflict resolution to take instead of merging: a merge commit whose parents are an ancestor of `base` (or
   *  `base`) and `commit`, sanity-checked already by the queue. When its first parent isn't `base`, the run merges
   *  `base` into it (a clean merge, else conflict). */
  resolution?: string;
  /** The run's own folder under the state root: every step's log is `<runDir>/<step.log>`. Records only, never a
   *  copy. */
  runDir: string;
  /** The branch's spec drafts, copied at run start (after the queue checked their hash against the approval):
   *  `<draftsDir>/<name>/…`. Absent: none, or the approval said without specs. */
  draftsDir?: string;
  /** A dry run of a bare commit (merge.try with no branch, so no worktree to read): its drafts are the ones committed
   *  in it, read from the copy at that commit, never a folder's untracked ones. Ignored when `draftsDir` is given. */
  draftsFromCommit?: true;
  /** The checks the merge thread added for this entry (merge.extend), on top of required + triggers. */
  picks: CheckPick[];
  /** The entry's picks as they are now (§app.merge-queue/checks, q9): the run reads it between checks and while it
   *  waits for the review, and runs each new one too, before it answers. Absent: only `picks`. */
  latePicks?(): CheckPick[];
  /** A release entry: the release's own gating checks (its `release.checks`, captured at the release's start), run
   *  after the merge set. Absent: not a release entry. */
  releaseChecks?: import("../../shared/project-contract").MergeCheckDecl[];
  /** The project's private names file (store.ts namesFileOf): the leak scan reads it (`--names` / SOVA_LEAK_NAMES).
   *  Absent: none yet (pushes are held until the merge thread's interview writes it). */
  namesFile?: string;
  /** The landing pushes (names-step.ts scanPlanned): the run ends with the "Private names and secrets" step over what
   *  it adds, reading this names file (absent: none yet, secrets only) and skipping the matches in `allowFile`. */
  scan?: { namesFile?: string; allowFile: string };
  /** A dry run (merge.setup dryRun): reset to `base`, set up, run `project.def`'s checks there; no merge, no
   *  reruns, no review. The entry is a stand-in (its branch is the target). A trial (`trialOf`) runs the landing's
   *  docs step first, on `draftsDir` (or the commit's own drafts), and keeps nothing it made. */
  tryOnly?: true;
  /** A trial (merge.try) of this branch or commit: the try runs on it, not on the target, and its words say so. */
  trialOf?: string;
  /** A dry run: the target's definition and head, so a check that fails again and the target also declares is run on
   *  the target alone with the target's own definition of it (whose failure). Absent: no comparison. */
  trialTarget?: { def: ProjectDef; head: string };
  /** Run the review step (the project declares a kit and the approval didn't skip it). */
  review: boolean;
  /** Start from an empty merge copy (Clean Run, or the weekly one): everything beyond the tracked files removed (ignored
   *  ones too), the setup cache forgotten, every check fresh. Absent: the copy is reused. */
  clean?: import("../../shared/merge-queue-health").CleanWhy;
  /** Aborted when the run is voided (master moved, cancelled, server stopping). */
  signal: AbortSignal;
  /** The review step's agent posts its verdict through `merge.review {run}`: this resolves with it (rejects on the
   *  signal). The review step may also answer from its own subprocess and never call it. */
  awaitReview(): Promise<ReviewVerdict>;
  /** The run's plan, worked out before it started (plan.ts): saved on the run (MergeRun.plan). */
  plan?: import("../../shared/merge-queue").RunPlan;
  /** The plan's exact check list: the run runs these (and the picks that arrive late), never a list of its own. */
  planned?: import("./checks").PlannedCheck[];
}

export interface RunHooks {
  /** Every new step and every change of one (result, ms, counts…): the queue keeps the run's step list, persists it
   *  and tells the screens. Call it with the step's full current shape; `id` matches. */
  step(step: RunStep): void;
  /** The list of checks this run will run, once known (before the first check starts). */
  checks(list: CheckPick[]): void;
  /** The merge commit, once made (before docs). */
  merged?(sha: string): void;
  /** Where the copy lives (once the copy step has it). */
  copy?(path: string): void;
  /** A change worth the event memory (§app.merge-queue/activity), from inside the run: its run, entry and branch are
   *  filled in; give `step` the plan step it belongs to ("check:<id>", "review", "scan"…). */
  event?(ev: import("../../shared/merge-queue").MergeEventInput): void;
  /** What the run ran with, as it learns it (MergeRun.ranWith): merged into what the queue recorded at the start. */
  ranWith?(patch: Partial<import("../../shared/merge-queue").RunRanWith>): void;
  /** The folder rules the run applies (§app.merge-queue/rules), once read (before the first check). */
  rules?(r: import("../../shared/merge-queue").RunRules): void;
  /** The review kit the review runs with (§app.merge-queue/review-kit), once read, and again with the model it ran on. */
  review?(stamp: import("../../shared/merge-queue").ReviewKitStamp): void;
}

export type RunOutcomeVerdict =
  /** Tested: `tip` is what master fast-forwards to. Flaky / target-red failures are in `notes`, never blocking. */
  | "passed"
  /** Red, blamed: `blame` "branch" (hand back) or "resolution" (back to the user, the branch isn't blamed). */
  | "failed"
  /** The merge conflicted (`conflict.files`); nothing ran past the merge. */
  | "conflict"
  /** Setup / machine failure on the target alone too, or the reviewer failed: the queue retries once, then pauses.
   *  Never sent to a branch. */
  | "machine"
  /** The checks passed and the review said blocking: waits for the user (Land Anyway / Send Back). `tip` is set. */
  | "review-flagged"
  /** A check that can't name its failures (a whole-check rerun) failed on the merge AND on the target alone: neither
   *  side can be blamed. `why` says which check; `tip` is the tested merge (what Land Anyway lands); `targetRed` names
   *  the check. Never auto-landed, never handed back, and the queue doesn't pause: it waits for the user. */
  | "unattributed"
  /** Aborted (signal), or a timeout of the run as a whole: nothing blamed, run again. */
  | "void"
  /** Changes neither code nor specs (§app.merge-queue/run): no check ran, the target doesn't move, nothing is blamed. */
  | "nothing";

export interface RunOutcome {
  verdict: RunOutcomeVerdict;
  blame?: Blame;
  /** One line for the row ("unit failed: src/a.test.ts", "setup fails with your branch and passes on master"). */
  why?: string;
  /** failed, blamed on the branch: its spec drafts didn't fit (the docs step), fixable with no commit. Absent: a check. */
  cause?: "drafts";
  /** The merge commit. */
  mergeSha?: string;
  /** The commit that lands (the merge, plus the docs commit when drafts landed). passed / review-flagged / unattributed. */
  tip?: string;
  /** The merge copy's path. */
  copy?: string;
  conflict?: { files: string[] };
  /** Notes for the landing: flaky, master-red, review notes, no-checks. */
  notes: MergeNote[];
  /** The folder rules the run applied. */
  rules?: import("../../shared/merge-queue").RunRules;
  /** machine: checks that ran past their time limit with the branch AND on the target alone (§app.merge-queue/time-limit):
   *  not the branch's; the queue pauses at once and asks the user (never retried, never voided). */
  overTime?: { check: string; label: string; limitSec: number }[];
  /** Each test (or file, or whole check) that failed and then passed on its rerun: the flaky store counts them. */
  flaky?: import("./flaky").FlakySeen[];
  /** The run started from an empty copy, and why (asked for, weekly, or the copy was cut new). Absent: it reused it. */
  clean?: import("../../shared/merge-queue-health").CleanWhy;
  review?: ReviewVerdict;
  /** unattributed: each check that couldn't name its failures and failed on both sides (`step`: its log, merge.logs). */
  unclear?: { check: string; label: string; step: string; why?: string }[];
  /** Checks red on the target alone (shown on the strip). */
  targetRed?: string[];
  /** Test checks broken on the target (attribute.ts brokenOnTarget): skipped for this branch; the queue flags each
   *  until a later run of it runs tests again. `why`: "<label> is broken on <target>: no test ran (<first line>)". */
  broken?: { check: string; label: string; why: string; step: string }[];
  /** The project declares no automated tests. */
  noChecks?: true;
  /** The checks it ran, with sources. */
  checks: CheckPick[];
  /** A dry run that failed (or couldn't run): what holds the branch up, its run id filled in by the queue. */
  trialFailure?: Omit<import("../../shared/merge-queue").BranchFailure, "run">;
  /** The "Private names and secrets" step's facts, when the run had it (RunInput.scan). */
  scan?: import("../../shared/merge-queue").ScanFacts;
}

/** copy-checks' entry point: one run, start to verdict. Never throws for a red check: every outcome is a value
 *  (a thrown error is read as `machine`). */
export type RunMerge = (input: RunInput, hooks: RunHooks) => Promise<RunOutcome>;

/** copy-checks: what a project declares for its checks (the view's `checks`), from the target's definition. */
export type ChecksOf = (def: ProjectDef | null) => "declared" | "test-command" | "none" | "unset";

/** copy-checks: estimates from this project's run history: how long one run takes (ms); null: no history yet. */
export type EstimateRun = (projectId: string, root: string) => number | null;

/** What the queue tells the merge thread (merge-thread: server/merge-queue/thread.ts wakes the project's thread).
 *  `queued`: read the branch, maybe pick checks (merge.extend) and write a note (merge.note). `conflict`: judge it
 *  (merge.resolve). `failed`: explain the failure (merge.note). `paused`: a machine pause to look at. `landed`: the note
 *  may still be written. `idle`: nothing is left to check and nothing runs (after a landing, a failure, a conflict or a
 *  cancel); `entry` is the one that changed last, `lastLanded` the newest landing. Answers whether a thread was asked:
 *  false (none, or off) never delays anything. */
export interface ThreadEvent {
  kind: "queued" | "conflict" | "failed" | "paused" | "landed" | "names" | "names-hit" | "idle" | ThreadRulingKind;
  project: string;
  root: string;
  target: string;
  entry: import("../../shared/merge-queue").MergeEntry;
  run?: string;
  /** conflict: the files. failed/paused: the one-line why. */
  files?: string[];
  /** names: the private names file the interview writes. */
  namesFile?: string;
  /** names-hit: where the scan found each thing that looks private ("<where> · <what>"), never the matched text. */
  hits?: string[];
  /** Start a fresh thread for this event instead of waking the one there: why (it didn't answer in time). */
  fresh?: string;
  /** The target's commit the entry was queued against (queued) or its run started on (conflict, failed): the thread
   *  diffs `base...entry.commit`, which stays right after the entry lands. */
  base?: string;
  why?: string;
  /** idle: the newest landed entry of the queue, and the commit it landed as. */
  lastLanded?: { id: string; branch: string; sha: string };
  /** idle: the target's head now. */
  head?: string;
  /** conflict: the scratch copy Sova made for the thread to resolve in (scratch.ts), or why it couldn't. */
  scratch?: string;
  scratchError?: string;
  /** review: the blocking verdict's whole report. */
  findings?: string;
  /** review: it already waits for the user (out of tries, or the same findings twice): nothing to hand on. */
  waits?: "out-of-tries" | "same-twice";
  /** fix / chat-answer / drafts-changed: the request (rq_…) it is about; fix: what it asked. */
  request?: string;
  asked?: string;
  /** fix: the fix's commit, and whether it changed the drafts; its one-line summary. */
  fixCommit?: string;
  drafts?: boolean;
  summary?: string;
  /** fix: the run's reviewer made it itself (merge.reviewFixes), not the chat. */
  by?: "reviewer";
  /** drafts-changed: the drafts' names now. */
  names?: string[];
  /** chat-answer: which answer, its text, and whether the thread already tried another approach for it. */
  answer?: "cant" | "needs-you";
  text?: string;
  otherTried?: boolean;
}
/** The moments the thread rules on (al_3): a failure whose owner can't be told, a blocking review, its own resolution
 *  that failed a check, drafts changed since the Land, a chat's fix to check, a chat's Can't or Needs you. */
export type ThreadRulingKind = "unattributed" | "review" | "resolution-failed" | "drafts-changed" | "fix" | "chat-answer";
export type WakeThread = (ev: ThreadEvent) => boolean;
