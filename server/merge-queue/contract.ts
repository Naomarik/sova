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
  /** The checks the merge thread added for this entry (merge.extend), on top of required + triggers. */
  picks: CheckPick[];
  /** A release entry: the release's own gating checks (its `release.checks`, captured at the release's start), run
   *  after the merge set. Absent: not a release entry. */
  releaseChecks?: import("../../shared/project-contract").MergeCheckDecl[];
  /** The project's private names file (store.ts namesFileOf): the leak scan reads it (`--names` / SOVA_LEAK_NAMES).
   *  Absent: none yet (pushes are held until the merge thread's interview writes it). */
  namesFile?: string;
  /** A dry run (merge.setup dryRun): reset to `base`, set up, run `project.def`'s checks there; no merge, no
   *  docs, no reruns, no review. The entry is a stand-in (its branch is the target). */
  tryOnly?: true;
  /** A trial (merge.try) of this branch or commit: the try runs on it, not on the target, and its words say so. */
  trialOf?: string;
  /** Run the review step (the project declares a kit and the approval didn't skip it). */
  review: boolean;
  /** Aborted when the run is voided (master moved, cancelled, server stopping). */
  signal: AbortSignal;
  /** The review step's agent posts its verdict through `merge.review {run}`: this resolves with it (rejects on the
   *  signal). The review step may also answer from its own subprocess and never call it. */
  awaitReview(): Promise<ReviewVerdict>;
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
  | "void";

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
  kind: "queued" | "conflict" | "failed" | "paused" | "landed" | "names" | "idle";
  project: string;
  root: string;
  target: string;
  entry: import("../../shared/merge-queue").MergeEntry;
  run?: string;
  /** conflict: the files. failed/paused: the one-line why. */
  files?: string[];
  /** names: the private names file the interview writes. */
  namesFile?: string;
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
}
export type WakeThread = (ev: ThreadEvent) => boolean;
