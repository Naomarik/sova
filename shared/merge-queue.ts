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
 * - `unattributed`: a check that can't name its failures failed on the merge and on the target alone: neither side is
 *   blamed and nothing lands on its own; waits for the user (Land Anyway / Send Back). The line moves on meanwhile.
 * - `drafts-changed`: the branch's spec drafts changed since the user approved: waits for a new Land.
 * - `needs-fix`: handed back to the branch's chat (a failure blamed on the branch, a conflict sent back, or the
 *   user's Send Back); a new Land queues it again.
 * - `landed`: master holds it (`landed`); on a request project, the host said merged (`landed.via` "host").
 * - `cancelled`: the user (or the branch's chat, on the user's word) took it out of the line.
 *
 * Landing by request or by pushing the branch alone (`approval.how`, al_3), after the checks pass:
 * - `request-review`: the request's title and description wait for the user's look (Publish); then, until the
 *   branch's chat is idle with a clean folder, `reason` says what it waits for. Never holds the copy.
 * - `requested`: the request is open on the host (`request`); the host decides. Never holds the line or the copy.
 * - `pushed`: Push branch only: the branch is on origin; the user opens the request.
 * - `closed`: the request was closed on the host without merging; Land Again opens or updates it.
 */
export type MergeEntryState = "queued" | "checking" | "conflict" | "behaviour-differs" | "review-flagged" | "unattributed" | "drafts-changed" | "needs-fix" | "with-chat" | "needs-user" | "landed" | "cancelled" | "request-review" | "requested" | "pushed" | "closed";
/** The states that wait for the user's answer (the "needs you" list). */
export const WAITING_FOR_USER: readonly MergeEntryState[] = ["behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "request-review", "needs-user"];
/** The states an entry never leaves by itself. */
export const ENTRY_FINAL: readonly MergeEntryState[] = ["landed", "cancelled", "needs-fix", "pushed", "closed"];
/** On the host: open there, followed by the queue; neither in line nor final. */
export const ENTRY_ON_HOST: readonly MergeEntryState[] = ["requested"];
/** States that hold a place in the line (one live entry per branch at a time). */
/** Does a branch have anything of its own left to land (§chat.worktrees/nothing-left)? "unknown": git couldn't say, or
 *  the histories don't connect; it is never read as nothing. */
export type LeftAnswer = "nothing" | "work" | "unknown";

export const ENTRY_OPEN: readonly MergeEntryState[] = ["queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "with-chat", "needs-user"];

// ---- al_3: the standing approval, the chat's requests and answers (§app.merge-queue/standing-approval,
// §chat.merge-queue/requests, §chat.merge-queue/answers) ----------------------------------------------

/** What a request asks of the branch's chat. */
export type MergeRequestKind =
  /** Needs a fix: a check failed, drafts don't fit, a conflict, review findings, a resolution that failed. */
  | "fix"
  /** Approved, but blocked before it can join the line (Approved · waiting for a fix), or a fix that still is. */
  | "blocked"
  /** Spec drafts that wouldn't land with a finished branch (before any Land). */
  | "drafts"
  /** A merge thread question (merge.ask): the user answers it in their own message, never the chat itself. */
  | "thread-ask"
  /** The held note of a decision, sent with the user's answer. */
  | "decision"
  /** The merge thread's other approach after a Can't. */
  | "other-approach"
  /** A trial finished. */
  | "trial";

/** The chat's answer to a request (merge.respond). */
export type MergeChatAnswer =
  | { kind: "fixed"; changed: "commit" | "drafts" | "both"; commit?: string; drafts?: { hash: string; names: string[] }; summary: string; at: string }
  | { kind: "needs-you"; question: string; options: string[]; at: string }
  | { kind: "cant"; why: string; at: string };

/** One request the merge queue made of a branch's chat, kept on its entry (oldest first). */
export interface MergeChatRequest {
  /** "rq_…": the id the chat answers by. */
  id: string;
  kind: MergeRequestKind;
  entry: string;
  branch: string;
  /** The branch's chat (the entry's session; a worker's branch: the worker). */
  session?: string;
  /** The chat it reached, once delivered (a worker's branch: the chat running the worker). It may answer too. */
  to?: string;
  text: string;
  /** fix: why it went back (the send-back's cause). */
  cause?: SentBackFor;
  /** fix: which try this is (1..3). */
  try?: number;
  /** fix: the same-failure fingerprint. */
  fingerprint?: string;
  at: string;
  delivery?: "queued" | "delivered" | "held" | "fallback-tab" | "fallback-line";
  answer?: MergeChatAnswer;
  /** fixed: when the merge thread checked the fix (it is the Land's from then on). */
  checkedAt?: string;
}

/** A standing approval's phase while it isn't in line (state `with-chat`). */
export type MergeStanding =
  /** Approved · waiting for a fix (Land on a finished but blocked branch, or a fix that still doesn't pass Land's checks). */
  | { phase: "waiting-fix"; why: string }
  /** Back with the chat: a request waits for its answer. */
  | { phase: "with-chat"; try: number; of: number; why: string; answer?: MergeChatAnswer; checked?: true }
  /** A fix waits for the merge thread to check it (it isn't running, or hasn't ruled). */
  | { phase: "waiting-thread"; answer?: MergeChatAnswer }
  /** A fix arrived while the entry's run is checking: it waits for that run to end. */
  | { phase: "waiting-run"; answer?: MergeChatAnswer }
  /** Stop in the chat: no request goes through until the user's next message. */
  | { phase: "paused" }
  /** Approved · dry run first: a setup branch's dry run of this commit runs at its turn in line, then it lands
   *  (`run` while it runs). The entry stays queued meanwhile. */
  | { phase: "dry-run"; run?: string };

/** A checked fix the standing approval carried: its commit (absent: drafts only) and the drafts it re-pinned. */
export interface MergeFix {
  request: string;
  commit?: string;
  drafts?: string;
  checkedAt: string;
  /** The merge thread's reason for accepting it, and what it read before it did (runs, steps, files). */
  why?: string;
  read?: string[];
}

export const MERGE_TRIES = 3;

// ---- al_3: decisions, the user's only (§app.merge-queue/needs-user, §chat.merge-queue/decision) -----------------

/** What the decision is about. */
export type MergeDecisionKind =
  /** A conflict whose two sides want different behaviour (the thread's merge.resolve "needs-user"). */
  | "behaviour-differs"
  /** The merge thread or the branch's chat raised it: only the user can decide. */
  | "needs-you"
  /** Can't tell whose failure: a check failed on the merge and on the target alone (Land Anyway / Try Again). */
  | "unattributed"
  /** Out of tries, or the same failure twice (Land, a new standing approval). */
  | "out-of-tries"
  /** A fix that needs the user's OK: on top of work they asked for, or changing more than was asked (Land). */
  | "fix-ok"
  /** Spec drafts changed beyond making them fit (Land). */
  | "drafts-changed";

/** A click on a decision, acted on the queue directly (merge.answer, the user's own click only). */
export type MergeDecisionAction = "accept" | "land-anyway" | "try-again" | "land" | "remove";

/** One decision waiting for the user (state `needs-user`): a question, choices that fill the chat's message box, and
 *  the queue's note held until the user answers there. */
export interface MergeDecision {
  /** "dc_…". */
  id: string;
  kind: MergeDecisionKind;
  /** The question, in plain words. */
  question: string;
  /** Choices: a button puts its words in the chat's message box (nothing is sent until the user sends). May be []. */
  choices: string[];
  /** The queue's note to the chat, held and "not sent yet": it goes with the user's answer, in one turn. */
  heldNote?: { request: string; text: string };
  /** It came from a chat's Can't the thread couldn't settle: "can't be settled without you". */
  cantSettle?: true;
  /** A merge thread question (merge.ask, ak_…): the user's answer goes to the thread (MergeThreadAsk.answered). */
  ask?: string;
  raisedBy: "merge-thread" | "chat" | "queue";
  /** The click-only answers it offers (Remove from Queue is always there). */
  actions: MergeDecisionAction[];
  /** behaviour-differs: both sides and the proposal, in plain words. */
  sides?: { ours: string; theirs: string; proposal: string };
  /** The run it came from, when one did. */
  run?: string;
  at: string;
  /** The user answered it (a click, or their message with the held note). */
  answered?: { at: string; how: MergeDecisionAction | "message" };
}

/** How a branch lands (al_3): merged locally (today's path), a pull request on GitHub, a merge request on GitLab,
 *  or the branch pushed and nothing more. Effective = this computer's choice ?? the project file's `merge.land` ??
 *  "local", pinned on each approval. */
export type LandHow = "local" | "github-pr" | "gitlab-mr" | "push-branch";
export const LAND_HOWS: readonly LandHow[] = ["local", "github-pr", "gitlab-mr", "push-branch"];

/** How the user approved: the Land button (composer modal, session pane, Merge Queue view) or "land it" typed in the
 *  branch's own chat (ingested from the worktree tool's go-ahead record). */
export type ApprovalBy = "land-button" | "typed" | "release";

export interface MergeApproval {
  /** Land Anyway on a setup branch's dry run that failed on the target too (or couldn't tell whose): the commit it
   *  counts as passed for, so the landing goes on with no dry run of it. */
  dryRunWaived?: string;
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
  /** Land Anyway on "Can't tell whose failure": a rerun that again can't tell lands its tested tip. */
  overUnattributed?: true;
  /** How it lands, pinned at approval (the project's effective choice then). Absent: local (approved before). */
  how?: LandHow;
  /** "open a PR" / "open an MR" typed in the branch's chat: wins over `how` for this approval. */
  via?: "github-pr" | "gitlab-mr";
  /** The user's one Land stands until the branch lands, they remove it, or it waits for their decision (al_3). */
  standing?: true;
  /** The commit the user's own Land (or typed word) pinned, before any fix moved `commit`. */
  userCommit?: string;
  /** Checked fixes the standing approval carried, oldest first. */
  fixes?: MergeFix[];
  /** Approved · waiting for a fix: taken on a finished but blocked branch; not yet in line. */
  blocked?: true;
  /** It already conflicted with the target at the Land: that conflict's send-back to the chat counts no try. */
  conflictAtLand?: true;
}

/** A branch published by the queue (a request, or the branch pushed alone), on its entry. */
export interface MergeRequestInfo {
  how: Exclude<LandHow, "local">;
  host?: import("./merge-queue-hosts").HostKind;
  /** The branch published (the chat's own branch) and the one it goes into. */
  branch: string;
  base: string;
  /** The request on the host, once opened. */
  number?: number;
  url?: string;
  /** The last tip pushed to origin's `branch`: Land Again adds on top of it (fast-forward, never forced). */
  publishedHead?: string;
  /** What the host last said, and when. */
  facts?: import("./merge-queue-hosts").HostFactsWire;
  checkedAt?: string;
  /** merged: the host's commit on the base branch. */
  mergeCommit?: string;
  /** The request's title and description: drafted after the checks, shown for review (request-review), then sent. */
  text?: { title: string; body: string; draft: boolean; checks?: { name: string; ok: boolean; why?: string }[] };
  /** The request skill folder the text was written by (relative to the project); absent: Sova's plain default. */
  folder?: string;
  /** Publish was given (or Land Again publishes onto an open request) and it is on its way: it goes out once the
   *  branch's chat is idle with a clean folder (`reason` says what it waits for). Absent: the text is the user's to
   *  review and Publish. */
  publishRequested?: true;
  /** The host problem (and the request head it was at) last sent back to the branch's chat: the same one goes once. */
  hostSentBack?: string;
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
export type CheckSource = "required" | "trigger" | "picked" | "release";
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
  /** "chat-fixes": the branch's chat fixes it (sent back with the diagnosis). "behaviour-differs": the user decides
   *  (merge.resolve's "needs-user"; its question and choices are the entry's decision). */
  verdict: "no-behaviour-change" | "chat-fixes" | "behaviour-differs";
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

/** A finding's kinds (server/merge-queue/review-verdict.ts checks them; the page draws each as a word). */
export const REVIEW_KINDS = ["dead-code", "duplication", "hack", "missing-test", "naming", "other"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
/** One finding of a review, as the reviewer wrote it. */
export interface ReviewFinding {
  kind: ReviewKind;
  file?: string;
  line?: number;
  text: string;
}

/** The review step's verdict on one commit (merge.review, or the review step's own result). */
export interface ReviewVerdict {
  verdict: "ok" | "notes" | "blocking";
  /** notes / blocking: what the reviewer says, whole (its summary, then one line per finding). */
  text?: string;
  /** The reviewer's summary line, whole. */
  summary?: string;
  /** Every finding, in the reviewer's order, whole. */
  findings?: ReviewFinding[];
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
  /** The branch moved past the pinned commit since approval: how many of its own commits (first-parent, none the
   *  target already has) are not included. On a sent-back entry: how many Land This Commit Again brings in. */
  newerCommits?: number;
  /** Sent back, and the branch was amended or rebased since: its tip isn't a descendant of the pinned commit. There is
   *  nothing to count (`newerCommits` absent); the re-land still lands the tip. */
  newerRewritten?: true;
  /** Sent back and moved on: why the branch's newest commit isn't Ready to land (its chat's readiness reading, else a
   *  temporary commit or uncommitted files); absent when it is. */
  newerBlocked?: string;
  /** The run now checking it, or the last one that did. */
  run?: string;
  /** Every run it had, oldest first. */
  runs: string[];
  /** How often its runs were voided and started again, by cause (restartCount for the row's total). */
  restarts?: Partial<Record<RestartCause, number>>;
  /** Checks the merge thread added (merge.extend); never removes a required one. */
  picks: CheckPick[];
  /** conflict: the files the last merge conflicted on (before any judgement). */
  conflictFiles?: string[];
  conflict?: ConflictJudgement;
  review?: ReviewVerdict;
  /** Each review that blocked it, oldest first, each whole and never overwritten (§app.merge-queue/review-report). */
  reviews?: MergeReviewRecord[];
  /** Can't tell whose failure (state `unattributed`): each check that failed on the merge and on the target alone and
   *  named no failures; its log is merge.logs {run, step}. */
  unclear?: MergeUnclear[];
  notes: MergeNote[];
  /** landed: where master went. `via` "host": the host merged the request (`sha` is the host's commit, which may be a
   *  squash or rebase of what Sova checked). */
  landed?: { sha: string; from: string; at: string; pushed: PushState; pushWhy?: string; via?: "host" };
  /** Landing by request or by push (approval.how not local): what was published, and the host's request. */
  request?: MergeRequestInfo;
  /** Estimates (ms): when it should start from now, and how long its run takes. */
  eta?: { startsInMs: number; takesMs: number };
  /** The release this entry belongs to (rl_…): its release commit, or the revert of an abandoned one. Sova adds it
   *  (approval `by: "release"`); it alone lands while that release holds the queue. */
  release?: string;
  /** A release entry's kind: the release commit, or the revert of an abandoned release's landed commit. */
  releaseKind?: "release" | "revert";
  /** needs-fix only, derived when the view is read (never stored): the entry no longer needs a fix. `superseded`: the
   *  branch has a later entry for the same target; `merged`: its sent-back commit or the branch's tip is already in the
   *  target; `gone`: the branch or its worktree folder was removed. A settled entry leaves the Sent back list. */
  settled?: MergeSettled;
  /** What the branch does at the approved commit (BranchSummary): the view's, never stored. Additive. */
  summary?: BranchSummary;
  /** needs-fix only, stored at the hand-back: why it was sent back. Absent on entries sent back before it was kept:
   *  read as not the drafts' (the queue infers `drafts` once from a run whose docs step failed). */
  sentBackFor?: SentBackFor;
  /** needs-fix for its drafts, stored at the hand-back: a fingerprint of its worktree's drafts folder then (notes
   *  included), so a fix that only records a note reads as a change. */
  sentBackDrafts?: string;
  /** The requests the queue made of the branch's chat, oldest first. */
  requests?: MergeChatRequest[];
  /** The standing approval's tries: sends back to the chat used, and each run's failure fingerprint. */
  tries?: { used: number; max: number; fingerprints: string[] };
  /** with-chat: where the standing approval stands. */
  standing?: MergeStanding;
  /** A Fixed answer, Can't or Needs you waiting on the merge thread: the request, and whether the thread was told yet
   *  (false: it wasn't running; Sova tells it again once it runs). */
  fix?: { request: string; told: boolean; at: string };
  /** Paused: you stopped the chat: the phase it goes back to at the user's next message. */
  pausedFrom?: MergeStanding;
  /** needs-user: the decision waiting for the user (the newest; an answered one stays until the entry moves on). */
  decision?: MergeDecision;
  /** The merge thread's rulings on this entry that the queue still acts on: its diagnosis for the next send-back, and
   *  that it already tried another approach after a Can't (one only). */
  ruling?: {
    diagnosis?: string;
    otherTried?: true;
    /** A send-back waiting for the thread's diagnosis (at most RULING_WAIT_MS), then sent with or without it. */
    /** `counted`: the failure's try, counted when it happened (whatever the thread then rules), with its fingerprint. */
    pending?: { cause: SentBackFor; why: string; run?: string; files?: string[]; review?: string; at: string; counted?: { tries: number; max: number; fingerprint: string } };
    /** The chat answered this request Can't: the thread rules on it (another approach, or the user). */
    cant?: { request: string; why: string; at: string };
    /** The thread's own resolution failed a check: it is ruling again; never the branch's. */
    resolutionFailed?: true;
    /** Can't tell whose failure, not yet raised to the user: the thread rules first (within RULING_WAIT_MS). */
    unattributed?: { run: string; at: string };
  };
  /** A failure holding it up (sent back for checks, can't tell whose, out of tries, its dry run failed): the Fix line and
   *  context. Derived when the view is read. Additive. */
  failure?: BranchFailure;
  /** Fix / Fix in New Chat on that failure. Derived when the view is read. Additive. */
  fixOffer?: FixOffer;
  /** A setup branch's dry run at this entry's commit. Derived when the view is read. Additive. */
  dryRun?: BranchDryRun;
  /** State unattributed, before any decision: the merge thread is ruling on whose failure it is (ruling.unattributed);
   *  it waits in Needs you as "Waiting for the merge thread", never Land. Derived when the view is read. Additive. */
  waitingRuling?: true;
  /** Its Land's dry run failed on the target too, or couldn't tell whose: it waits for the user (state unattributed)
   *  on that dry run (`run`) of `commit`. Land Anyway counts it passed; Try Again runs a new one. Additive. */
  dryRunHold?: { run: string; commit: string };
  /** needs-fix only, derived when the view is read (never stored): sent back for its drafts, its drafts changed since
   *  (since the hand-back; for an entry from before that was kept, since the approval pinned them), and Sova's docs
   *  check of them finds no problem. Land comes back at the same commit. */
  redrafted?: true;
  createdAt: string;
  updatedAt: string;
}
export type MergeSettled = "superseded" | "merged" | "gone";

/** Where one blocking review's card stands (§chat.merge-queue/review-card). */
export type ReviewCardState = "with-thread" | "fixing" | "re-reviewing" | "stopped" | "passed" | "waiting" | "removed";

/** One review that blocked an entry, kept whole on the entry (§app.merge-queue/review-report): its card, its request
 *  and its log line all read it. */
export interface MergeReviewRecord {
  /** `${entry}:${run}`, stable. */
  id: string;
  /** The run that reviewed it. */
  run: string;
  /** The branch's commit that was reviewed (the entry's pinned commit then). */
  commit: string;
  /** The commit the reviewer read (the merge copy's tip: the merge, its drafts made official) and the target commit it
   *  was merged onto. */
  tip: string;
  base: string;
  summary: string;
  findings: ReviewFinding[];
  /** The standing approval's try its send-back counted (0: none counted yet). */
  try: number;
  of: number;
  /** The merge thread's note on this review (merge.rule chat-fixes text). */
  note?: { text: string; at: string };
  state: ReviewCardState;
  /** stopped: what sent it back before a new review ran, one line. */
  stoppedFor?: string;
  /** The request that carried it to the chat, once it went. */
  request?: string;
  at: string;
  updatedAt: string;
}
/** Why an entry was sent back: its spec drafts didn't fit (`drafts`), a check failed with it (`checks`), a conflict
 *  nobody judged (`conflict`), the user's Send Back (`user`), or the host refused its publication (`host`). Only
 *  `drafts` can be fixed with no commit. */
export type SentBackFor = "drafts" | "checks" | "conflict" | "user" | "host" | "review";

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
  | "scan" // the publish scan "Private names and secrets", before the push (q8)
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
  /** rerun-master: the check is broken on the target (a test check that ran no test anywhere): skipped for this
   *  branch, `detail` the flag line. */
  broken?: true;
  /** check: how many of its test files already passed on identical code (the re-checked ones too); the step's log
   *  lists each and its source run. Its time says nothing about the check's full length (the estimate skips it). */
  reused?: number;
  /** The plan step it carries out (RunPlan.steps[].id), when that isn't its own id: a rerun names its check's
   *  ("rerun-tip:unit" → "check:unit"), a setup rerun its setup step's. Absent: its own `id`. */
  plan?: string;
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
  /** The plan worked out before the run started (§app.merge-queue/plan): every step it will take and every one it
   *  won't, each with why, and the fingerprint of its inputs. Absent on runs from before plans. */
  plan?: RunPlan;
  /** What the run ran with: tool versions, what it reused, the settings in force. Filled in as the run goes. */
  ranWith?: RunRanWith;
}

// ---- the run plan (al_1 step 11): worked out before a run starts ---------------------------------

/** Everything a run's plan depends on, each a separate field: the same inputs give the same plan (and fingerprint). */
export interface RunPlanInputs {
  /** The pinned commit merged (the entry's). */
  commit: string;
  /** The target's head the run starts on. */
  base: string;
  /** A conflict resolution taken instead of merging. */
  resolution?: string;
  /** Merge run or release run (a release entry adds its release checks). */
  scope: "merge" | "release";
  /** Hash of the TARGET's definition parts the step list comes from: its merge section (checks, install, review,
   *  push), setup steps and test command (the check LIST is main's, q10). */
  setup: string;
  /** Hash of the folder rules read from the BRANCH being landed (q10); "" when it declares none. */
  rules: string;
  /** The branch changed its own folder rules (against the base's): shown plainly on the run. */
  ownRules?: true;
  /** Hash of the review kit the run reviews with (the branch's own, from the merge); null: no review step. */
  review: string | null;
  /** The branch changed its own review kit. */
  ownReview?: true;
  /** Hash of the merge thread's picks at the start (id + select, in order); "" when none. */
  picks: string;
  /** The run starts from a fresh merge copy (Clean Run: operator or weekly), nothing reused. */
  clean: boolean;
  /** The changed paths the plan read (git diff base...commit), hashed: derived from commit and base, kept so a reader
   *  can see it is. */
  changed: string;
  /** Approval facts that change the steps, sorted: "without-review", "without-specs", "drafts:<hash>", "release:<id>",
   *  "how:<LandHow>", "push:<off|on|no-remote>", "names:<set|unset>". */
  flags: string[];
}

/** One step of a plan. `will`: it runs; it is left out (`why` says why); or it runs only if something happens. */
export interface PlanStep {
  /** The RunStep id it becomes when it runs ("copy", "setup:<id>", "install", "merge", "docs", "check:<id>", "review",
   *  "land", "main-checkout", "scan", "push"). Reruns are no plan steps: they name their check's (RunStep.plan). */
  id: string;
  kind: RunStepKind;
  label: string;
  will: "run" | "skip" | "if";
  /** skip: why not ("not picked; no folder rule matched"); if: on what ("only if a lockfile changes"); run: why it is in
   *  ("Triggered: statecharts/** changed (rule 3)", the thread's reason). Required checks run with none. */
  why?: string;
  /** check: where it came from. */
  source?: CheckSource;
  select?: string[];
  /** check, trigger: the folder rule that set it off. */
  rule?: string;
  /** A merge thread pick that arrived after the run started (q9): it still runs, before the push. */
  late?: true;
}

export interface RunPlan {
  /** 16 hex of sha256 over the canonical inputs, fixed at the start. */
  fingerprint: string;
  inputs: RunPlanInputs;
  /** In order: every step it will take, every one it won't, each with why. */
  steps: PlanStep[];
  /** An earlier run of the same entry whose plan had the same fingerprint (visibly the same plan). */
  sameAs?: string;
  /** Picks that arrived after the start (late steps in `steps`): their hash and the fingerprint with them included, so
   *  "same inputs, same plan" is never claimed of a plan that grew. */
  late?: { picks: string; fingerprint: string };
  at: string;
}

/** What a run ran with (§app.merge-queue/plan): recorded on the run so two runs can be told apart. */
export interface RunRanWith {
  /** Tool versions, from an allow-list of known tool names in the setup and check commands, plus git (a project's
   *  own script is never run for a version). `version` null: it didn't say. */
  tools: { name: string; version: string | null }[];
  /** The merge copy was reused (installed packages, build output) or made fresh (Clean Run). */
  copy: "reused" | "fresh";
  /** Each setup step: skipped as unchanged since the last run (reused) or run. */
  setup: { id: string; reused: boolean }[];
  /** Checks whose test files' earlier passes on identical code stood (RunStep.reused). */
  checksReused?: { id: string; files: number }[];
  /** The settings in force, in words ("Time limit · Unit tests" = "600 s", "How it lands" = "merge locally"). */
  settings: { name: string; value: string }[];
}

// ---- the event memory (al_1 step 1): every change to a branch or to the queue, for good ------------

/** Who made a change. */
export type MergeEventBy = "user" | "queue" | "thread" | "chat" | "reviewer" | "release";

/** Why a run was voided and its entry put back in line: counted per entry, by cause (MergeEntry.restarts). */
export type RestartCause =
  /** The target moved outside the queue under the run. */
  | "target-moved"
  /** Sova stopped mid-run. */
  | "server-stopped"
  /** A check, setup step or install ran past its time limit. */
  | "timed-out"
  /** A machine failure's one retry. */
  | "machine-retry"
  /** A release started and holds the line. */
  | "release"
  /** Approved again at a newer commit. */
  | "superseded"
  /** Clean Run started it again from a fresh copy. */
  | "clean-run"
  /** Anything else that voided it (named in the event's `why`). */
  | "aborted";
export const RESTART_CAUSES: readonly RestartCause[] = ["target-moved", "server-stopped", "timed-out", "machine-retry", "release", "superseded", "clean-run", "aborted"];

/** How many times an entry's runs were restarted, every cause together. Pure. */
export const restartCount = (e: Pick<MergeEntry, "restarts">): number => Object.values(e.restarts ?? {}).reduce((a: number, n) => a + (n ?? 0), 0);

/** What the merge thread did (its verbs): each is a `ruled` event with its reason and what it read. */
export type ThreadAct = "extend" | "resolve" | "rule" | "fix-checked" | "fix-refused" | "review" | "note" | "ask" | "hold" | "retry" | "names";

interface MergeEventBase<K extends string> {
  /** Per queue, ever increasing from 1: the order of record. */
  seq: number;
  at: string;
  kind: K;
  by: MergeEventBy;
  /** One plain line said to the user: what happened and why ("Run restarted: main moved 1a2b3c4 → 5d6e7f8"). */
  why: string;
  entry?: string;
  branch?: string;
  run?: string;
  /** The plan step it belongs to (RunPlan.steps[].id). */
  step?: string;
}

/** One recorded change (§app.merge-queue/activity). Kinds are added, never renamed (a reader skips one it doesn't know). */
export type MergeEvent =
  /** Land, a typed "land it", a release, a fix re-pinning the standing approval, a decision's Land. */
  | (MergeEventBase<"approved"> & { commit: string; via: ApprovalBy | "fix" | "decision" })
  /** Waiting its turn behind something: recorded when what it waits behind changes. */
  | (MergeEventBase<"waiting"> & { behind: string; ahead?: string; position?: number })
  | (MergeEventBase<"run-started"> & { fingerprint: string; base: string; commit: string; sameAs?: string })
  /** A run voided and the entry put back in line; `count`: that cause's count on the entry now. */
  | (MergeEventBase<"run-restarted"> & { cause: RestartCause; count: number })
  | (MergeEventBase<"run-ended"> & { verdict: RunVerdict; blame?: Blame })
  /** A run step ended (`step` its plan step, `runStep` its own id). */
  | (MergeEventBase<"step-ended"> & { runStep: string; result: StepResult; ms: number })
  /** The merge thread's pick (beside its `ruled` event, act extend); `late`: after the run started (q9). */
  | (MergeEventBase<"picked"> & { checks: string[]; late?: true })
  | (MergeEventBase<"sent-back"> & { cause: SentBackFor; request?: string; try?: number; of?: number })
  | (MergeEventBase<"answered"> & { request: string; answer: MergeChatAnswer["kind"] })
  /** Every merge thread decision, with its reason (`why`, `text` whole) and its evidence: what it read (runs, steps,
   *  logs, files) before it ruled. */
  | (MergeEventBase<"ruled"> & { act: ThreadAct; verdict?: string; read: string[]; text?: string })
  | (MergeEventBase<"decision"> & { decision: string; decisionKind: MergeDecisionKind; answered?: MergeDecisionAction | "message" })
  /** `self`: the queue paused itself (the user is notified), not the operator. */
  | (MergeEventBase<"paused"> & { pause: PauseKind; self: boolean })
  | MergeEventBase<"resumed">
  | (MergeEventBase<"landed"> & { sha: string; from: string })
  | (MergeEventBase<"pushed"> & { sha: string })
  | MergeEventBase<"push-held">
  | MergeEventBase<"cancelled">
  /** The merge thread's health: a fresh thread started by itself, that failed, a delivery failed or was refused,
   *  something waited on it too long. */
  | (MergeEventBase<"thread-health"> & { what: "fresh-thread" | "fresh-failed" | "delivery-failed" | "refused" | "waited-long"; waitedMs?: number })
  /** A Clean Run asked for or started. */
  | (MergeEventBase<"clean-run"> & { cleanWhy: "operator" | "weekly" | "first" })
  /** A flaky failure recorded: failed, then passed on its narrow rerun. */
  | (MergeEventBase<"flaky"> & { check: string; file?: string; name?: string })
  /** The publish scan "Private names and secrets": scanned, a hit, allowed, sent back, asked the thread. */
  | (MergeEventBase<"names"> & { what: "scanned" | "hit" | "allowed" | "sent-back" | "asked" | "unanswered"; hits?: number })
  /** The review: started, the branch changed its kit, the reviewer's own fix, the verdict recorded. */
  | (MergeEventBase<"review"> & { what: "started" | "kit-changed" | "fixed" | "verdict"; kit?: string; model?: string; sha?: string; verdict?: ReviewVerdict["verdict"] })
  /** Anything else worth the record, in words; `note` a short tag ("timeout-probe", "rules-changed"). */
  | (MergeEventBase<"note"> & { note: string });

export type MergeEventKind = MergeEvent["kind"];
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What a caller records: `seq` is given, `at` defaults to now. */
export type MergeEventInput = OmitEach<MergeEvent, "seq" | "at"> & { at?: string };

/** GET /api/merge-queue/events and merge.events: newest first; `before` a seq to page back (Show Older). */
export interface MergeEventsPage {
  events: MergeEvent[];
  /** Older ones are there: pass the last one's seq as `before`. */
  more: boolean;
}
/** How many of the newest events the view carries. */
export const VIEW_EVENTS = 40;

/**
 * A trial (merge.try): a setup branch's proposed checks run on its exact head in the merge copy, nothing merged and
 * nothing saved. The checks are that commit's own `.sova/project.json` merge checks (and the services they require),
 * then its `release.checks`. Each check's pass or fail, duration and log are the run's steps (`merge.logs {run}`).
 * A setup branch is offered Land only once a trial of its exact head passed.
 */
export interface MergeTrial {
  /** The run (mr_…) holding its steps and logs. */
  run: string;
  /** The commit tried (full sha): the result counts for this commit only. */
  commit: string;
  /** The branch it was asked for, when named by branch. */
  branch?: string;
  verdict: "running" | "passed" | "failed" | "machine" | "void";
  /** One line: why the verdict. */
  why?: string;
  /** Release checks the trial left out: unchanged against the target's release section and not named for it. */
  notRun?: { id: string; label: string }[];
  /** Who started it: the operator, a chat (its session id), or the user's Land (the entry it lands once it passes). */
  by: TrialBy;
  startedAt: string;
  endedAt?: string;
  /** Verdict void: who or what stopped it (the user's Stop Dry Run, a Sova restart, a newer dry run of the branch). */
  stopped?: { by: "operator" | "chat" | "restart" | "superseded"; session?: string; at: string };
  /** Why the branch needed it, from its setup change at the start: "adds the merge check Playbook tests". */
  needs?: DryRunWhy;
  /** The merge and release checks it runs (the ones the branch adds or changes), known at its start. */
  ran?: { id: string; label: string }[];
  /** The merge checks it leaves out: unchanged against the target, they run in the landing. */
  skipped?: { id: string; label: string }[];
  /** Verdict failed or machine: what holds the branch up (the Fix line and context). */
  failure?: BranchFailure;
}
export const MERGE_TRIALS_KEPT = 20;

/** Who started a dry run. `land`: the user's Land started it; that entry lands by itself once it passes. */
export type TrialBy = { kind: "operator" } | { kind: "chat"; session?: string } | { kind: "land"; entry: string };

/** Why a branch needs a dry run, from its setup change, one line with no leading capital ("adds the merge check
 *  Playbook tests", "changes the release step Site build", "changes the deploy targets"). */
export type DryRunWhy = string;

/** A failure holding a branch up, a dry run's or a landing's: the plain line beside Fix, and Fix's context. */
export interface BranchFailure {
  kind: "dry-run" | "landing";
  /** The run (mr_…): View Checks. */
  run: string;
  /** The commit the run was at (full sha). */
  commit: string;
  /** Whose it is: the branch's change, master's too, can't tell, or the machine (nothing of the branch's ran). */
  whose: "branch" | "master" | "unclear" | "machine";
  /** One plain line: "Playbook tests fails on master too: not this branch's", "This branch's change breaks Playbook
   *  tests", "Dry run couldn't run: …". */
  line: string;
  /** Each failing check, with its failing tests (as the run named them). */
  checks: { id: string; label: string; step: string; whose: "branch" | "master" | "unclear"; tests?: { file?: string; name?: string; message?: string }[] }[];
}

/** Fix and Fix in New Chat on a failure, each with why not when it can't now. */
export interface FixOffer {
  /** Fix: the failure's context sent to the branch's own chat. Refused while it works or is open in a terminal. */
  chat: { ok: true; session: string } | { ok: false; why: string };
  /** Fix in New Chat: a fresh chat on a new branch from the target (a failure the target shares) or on this branch. */
  newChat: { ok: boolean; why?: string; on: "new-branch" | "this-branch" };
}

/** A branch's dry run at its NEWEST commit (never an older commit's as current). */
export interface BranchDryRun {
  /** The branch head the row is about. */
  commit: string;
  /** waiting: asked for (Run Dry Run, or Land's) and waits for the merge copy (MergeQueueView.trialsWaiting). */
  state: "needed" | "waiting" | "running" | "passed" | "failed" | "stopped" | "machine";
  /** Why it needs one (always). */
  why: DryRunWhy;
  /** The dry run at this commit (absent when none ran): View Checks. */
  run?: string;
  by?: TrialBy;
  /** Running: check N of M (1-based). */
  progress?: { at: number; of: number };
  stopped?: MergeTrial["stopped"];
  /** Failed or machine. */
  failure?: BranchFailure;
  fixOffer?: FixOffer;
  /** An older commit's dry run, only for "(at an older commit)": it never sets `state`. */
  older?: { commit: string; verdict: MergeTrial["verdict"] };
  /** The user's Land stands and runs it first: that entry's id. Land Anyway is offered (merge.answer land-anyway on that
   *  entry) exactly when `land` is set, `state` is "failed" and `failure.whose` is "master". */
  land?: string;
  /** waiting: what holds the merge copy now, in words (MergeTrialWaiting.after), and its place among waiting dry runs (1…). */
  after?: string;
  position?: number;
  /** waiting: the MergeTrialWaiting id (tw_…) Stop Dry Run cancels it by. */
  waiting?: string;
}

// ---- the queue ----------------------------------------------------------------------------------

/** Why the queue is paused: approvals are still accepted, runs wait. */
export type PauseKind =
  | "operator" // merge.pause
  | "master-moved" // the target moved outside the queue: the run was voided; resume to go on
  | "machine" // setup / machine failure on the target too, twice
  | "main-checkout-dirty" // the project's main folder has uncommitted edits: master landed, the folder not moved
  | "reviewer" // the reviewer failed twice
  | "recovery" // a landing in flight at a stop could not be reconciled
  | "definition-invalid"; // the target's .sova/project.json doesn't parse: nothing runs until it is fixed
export interface PauseInfo {
  kind: PauseKind;
  why: string;
  at: string;
  /** The run it concerns, when one. */
  run?: string;
  /** The queue paused itself (every kind but the operator's own): the user was notified. */
  self?: true;
}

/** What the project declares for its checks: a `merge` section list, one test command, "no automated tests", or
 *  nothing yet (onboarding; no approval accepted). */
export type ChecksDeclared = "declared" | "test-command" | "none" | "unset";

/** One test check broken on the target: "<label> is broken on <target>: no test ran (<first log line>)". */
export interface TargetBroken {
  check: string;
  label: string;
  why: string;
  /** The run that found it, and its step on the target alone (its log). */
  run: string;
  step: string;
  /** When it was first found (ISO); later runs that find it again keep it. */
  at: string;
}

export interface MergeQueueHeads {
  /** The target's head now. */
  target: string;
  /** origin's copy of the target, when known: the queue's own push, else the remote-tracking ref (as last fetched). */
  pushed?: string;
  /** The project has a remote named origin (false: the strip says No remote). */
  hasOrigin?: boolean;
  /** Why the last landing wasn't pushed ("held for a release", "leak scan: …", "origin moved"). */
  pushWhy?: string;
  /** Checks red on the target alone, by label. */
  targetRed?: string[];
  /** Fix / Fix in New Chat on each broken-target check (by check id): a chat on a new branch from the target. Additive. */
  targetBrokenFix?: Record<string, FixOffer>;
  /** Test checks broken on the target (no test ran on the merge, the tip or the target alone, same exit each time):
   *  skipped for every branch meanwhile, shown in the tab's Needs you until a later run of that check runs tests. */
  targetBroken?: TargetBroken[];
  /** Request projects: how many commits local target is behind origin's (as last fetched); Update Local Main. */
  behind?: number;
  /** Update Local Main can't now: why (the main folder has uncommitted edits). */
  behindBlocked?: string;
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
  /** The target's .sova/project.json is there but invalid (the parser's path and message): the queue isn't "not set up",
      it can't read what was declared. `checks` then reads "unset"; show this instead of onboarding. */
  invalid?: string;
  paused?: PauseInfo;
  checks: ChecksDeclared;
  /** The project declares a review kit. */
  review: boolean;
  /** The merge queue serves this project: it is on the Projects list and its merge setup is done (checks declared,
      or a definition that doesn't parse). false: its chats merge plainly; the tab offers to initialize the setup. */
  served: boolean;
  /** The run checking now. */
  current?: MergeRun;
  /** Entries in state `checking`: the one whose run is `current`, or one tested and held (a paused landing). */
  checking: MergeEntry[];
  /** Queued entries in line order (`position` 1…). */
  waiting: MergeEntry[];
  /** Entries waiting for the user (behaviour differs, review flagged, drafts changed) and conflicts the thread
   *  judges. */
  needsYou: MergeEntry[];
  /** Handed back to their chats, newest first: the 20 newest that still need a fix (no `settled`), plus the settled
   *  ones among the 20 newest overall (kept so a run or card can still find its entry). */
  needsFix: MergeEntry[];
  /** Waiting on the host: open requests (`requested`), newest first; closed ones and pushed branches recently. */
  waitingOnHost?: MergeEntry[];
  /** Landed, newest first (last 20), each with its notes. */
  recent: MergeLanded[];
  heads: MergeQueueHeads;
  /** The merge thread's chat for this project, when one is recorded (the Merge thread card). */
  thread?: MergeThreadInfo;
  /** The reviewer chat running now, for the head's "Review running · <branch> · Open" (a retry: its current attempt). */
  reviewing?: { run: string; branch: string; session: string; path: string; attempt: number; startedAt: string };
  /** The queue's chats, newest first: the current thread, earlier ones, every reviewer chat (the History section). */
  chats?: MergeQueueChat[];
  /** Ready, not approved: this project's worktree branches with commits the target hasn't, a clean tree, a head that
   *  isn't TEMP, and no entry in line or landed at that commit (the view's Land list). */
  ready?: MergeReady[];
  /** A merge.setup dry run (the operator's, from the CLI): the run in flight, or the last one. */
  tryRun?: MergeRun;
  /** merge.try: the setup branches' trials, newest first (at most MERGE_TRIALS_KEPT), each pinned to its commit. */
  trials?: MergeTrial[];
  /** The branch's dry run holding the merge copy now (Checking now, the landing bar): absent when none runs. */
  trialNow?: MergeTrialNow;
  /** Dry runs asked for while the merge copy was busy, in the order they start: each starts once the copy is free.
   *  `after`: what holds the copy now, in words ("the landing of feat/x", "the dry run of feat/y"). */
  trialsWaiting?: MergeTrialWaiting[];
  /** A release holds the queue (the freeze banner): only its entries land and nothing is pushed until it is
   *  published or abandoned. */
  release?: MergeReleaseHold;
  /** Every setting the queue uses, where each is kept, and the saves the Settings tab may make. */
  settings?: import("./merge-queue-settings").MergeQueueSettings;
  /** What retirement did and holds in this project (§chat.worktrees/retirement). Additive. */
  retirement?: import("./protocol").RetirementView;
  /** The queue's newest recorded changes, newest first (at most VIEW_EVENTS): the first screen's activity. The rest:
   *  GET /api/merge-queue/events. Additive. */
  events?: MergeEvent[];
  at: string;
}

/** A project's queue as the landing bar starts from it (GET /api/merge-queue/landing-summary): the view's fields the bar
 *  reads, `recent` and `waitingOnHost` cut to the newest few. A whole MergeQueueView (the `merge_queue` feed frame) is one too. */
export type LandingQueueCut = Pick<MergeQueueView, "project" | "root" | "target" | "state" | "paused" | "invalid" | "served" | "current" | "checking" | "waiting" | "needsYou" | "recent" | "waitingOnHost" | "release" | "reviewing" | "heads" | "trialNow" | "trialsWaiting" | "at">;

/** A dry run waiting for the merge copy (Run Dry Run pressed while it was busy). Stop Dry Run cancels it. */
export interface MergeTrialWaiting {
  /** "tw_…": Stop Dry Run cancels it by this id. A branch waits at most once (asking again re-pins its commit). */
  id: string;
  branch: string;
  commit: string;
  by: TrialBy;
  at: string;
  after: string;
  /** Why the branch needs it (as BranchDryRun.why). */
  needs: DryRunWhy;
}

/** The dry run running now: its record, its run (steps live) and how far it is. */
export interface MergeTrialNow {
  trial: MergeTrial;
  run: MergeRun;
  /** Check N of M (1-based; `at` is the check running now, or `of` once all ran). */
  progress: { at: number; of: number };
}

/** A project's releases as the landing bar starts from them: the open record and the last one (steps without their
 *  `detail`), with Publish's gates and the quiet watch. `project` is the root, as in ReleaseView; a whole ReleaseView
 *  (the `release` feed frame) is one too. */
export type LandingReleaseCut = Pick<import("./release").ReleaseView, "project" | "initialized" | "open" | "last" | "gates" | "quiet" | "target" | "remote">;

/** One project of this computer's Projects list in the landing summary. `queue` null: the queue doesn't serve it (or
 *  has nothing loaded); `release` null: it has no release record. */
export interface LandingSummaryProject {
  id: string;
  root: string;
  name: string;
  queue: LandingQueueCut | null;
  release: LandingReleaseCut | null;
}

/** GET /api/merge-queue/landing-summary: every project's queue and releases in one quick read (no Ready-list or tag
 *  history reads), for the landing bar at page open and at each reconnect; the feed's frames carry it on from there. */
export interface LandingSummary {
  projects: LandingSummaryProject[];
  at: string;
}

/** The release holding a project's queue. `state`: the release record's (shared/release.ts ReleaseState). */
export interface MergeReleaseHold {
  id: string;
  /** The release's version (0.4.0) once picked, else null. */
  version: string | null;
  /** Its numbered tag (v0.4.0) once the version is picked, else null: what the screens name it by. */
  tag?: string | null;
  state: string;
  /** The target's commit at the release's start. */
  base: string;
  since: string;
}

/** What the session's worktree rows read (SessionWorktreeInfo.queue): the newest entry for that branch. */
/** One check that couldn't say whose failure it is. */
export interface MergeUnclear {
  check: string;
  label: string;
  run: string;
  step: string;
  why?: string;
}

export type WorktreeQueueInfo = Pick<MergeEntry, "id" | "state" | "position" | "commit" | "reason" | "newerCommits" | "newerRewritten" | "newerBlocked" | "eta" | "notes" | "landed" | "conflict" | "review" | "unclear" | "request" | "settled" | "redrafted" | "standing" | "decision" | "tries" | "failure" | "fixOffer" | "dryRun" | "waitingRuling"> & {
  project: string;
  /** The target this entry lands on. */
  target?: string;
  run?: string;
  /** The run's newest reviewer chat (Open Reviewer Chat on the branch's Worktrees row), while it runs and after. */
  reviewer?: { session: string; path: string; state: "running" | "ok" | "notes" | "blocking" | "failed"; cleared?: true };
  /** The project has a review kit (the Land menu shows "Land without review"). */
  reviewKit?: boolean;
};


/** A branch's entry as the session list carries it (protocol.ts SessionBranchQueue): its state, never a precomputed
 *  key, so a new state flows through, and the fields a row's words read. */
export type BranchQueueFacts = Pick<WorktreeQueueInfo, "state" | "commit" | "position" | "reason" | "conflict" | "review" | "request" | "settled" | "redrafted" | "standing" | "decision" | "waitingRuling">;

/** The session list's cut of a worktree row's queue entry. Pure. */
export const branchQueueOf = (q: WorktreeQueueInfo): BranchQueueFacts => ({
  state: q.state,
  commit: q.commit,
  ...(q.position ? { position: q.position } : {}),
  ...(q.reason ? { reason: q.reason } : {}),
  ...(q.conflict ? { conflict: q.conflict } : {}),
  ...(q.review ? { review: q.review } : {}),
  ...(q.request ? { request: q.request } : {}),
  ...(q.settled ? { settled: q.settled } : {}),
  ...(q.redrafted ? { redrafted: true as const } : {}),
  ...(q.standing ? { standing: q.standing } : {}),
  ...(q.decision ? { decision: q.decision } : {}),
  ...(q.waitingRuling ? { waitingRuling: true as const } : {}),
});

/**
 * What a branch does, in up to 5 plain bullets (the summary-line model writes them from the branch's commit messages
 * and the parts it changed, once it reads Ready to land for its commit). `commit`: the commit the row is about.
 * `writing`: the bullets for it are being written now; `failed`: they couldn't be (Try Again asks again); `ready`:
 * `bullets` are shown. `stale`: the bullets shown were written for an earlier commit of the branch. Additive.
 */
export interface BranchSummary {
  commit: string;
  state: "ready" | "writing" | "failed";
  bullets?: string[];
  stale?: { commit: string };
}

/** POST /api/merge-queue/projects/:project/discard-branch {branch, commit, dryRun: true}: what Discard Branch… would
 *  take (the Land ▾ menu's page-only action, on a Ready row or a chat's Worktrees row), and why it can't now. */
export interface DiscardBranchPreview {
  branch: string;
  /** The tip the row showed, as sent. */
  commit: string;
  /** The branch it lands into ("" when it couldn't be read). */
  target: string;
  /** Its commits the target hasn't: the exact count, and the newest ones by line (at most 20). */
  commits: { count: number; shown: { sha: string; subject: string }[] };
  /** Its folder; null: it has none, and that step is skipped. */
  folder: string | null;
  /** What the folder holds that git doesn't (Remove Anyway's listing); null: no folder, or it couldn't be read. */
  files: import("./protocol").WorktreeRemoveAnyway | null;
  /** Spec drafts in the folder, by name. */
  drafts: string[];
  /** Its chat, archived with it; null: none (or one already archived), and that step is skipped. */
  chat: { id: string; title: string; path: string } | null;
  /** Why the branch's chat stays when it isn't archived with it: it works in another folder. Absent: no such chat. */
  chatStays?: string;
  /** The other chats working in the folder (main chats, not archived, idle): archived with it ([] when none). A running
   *  one refuses the discard instead. */
  others: { id: string; title: string; path: string }[];
  /** Send it back on the confirm: the folder's files are deleted only while they are still this listing ("" with no folder). */
  digest: string;
  /** Why it can't go now, in words (the confirm's disabled reason); null: it may. */
  refused: string | null;
}

/** One step of a confirmed Discard Branch…, in order: folder, branch, chat. */
export interface DiscardBranchStep {
  step: "folder" | "branch" | "chat";
  /** skipped: the row has no folder or no chat; not-run: an earlier step stopped it. */
  state: "done" | "skipped" | "failed" | "not-run";
  detail?: string;
}

/** The confirm's answer (a refusal before anything went is a 409 {error: {code: "refused" | "changed", message}}). */
export interface DiscardBranchResult {
  outcome: "discarded" | "partial";
  /** Always the three steps, in order. */
  steps: DiscardBranchStep[];
  /** What went and what stayed, in a sentence. */
  message: string;
  /** One outcome per chat archived: the branch's chat first, then the others in the folder ([] when none). */
  chats: { id: string; title: string; state: "done" | "failed" | "not-run"; detail?: string }[];
}

export interface MergeReady {
  branch: string;
  worktree: string;
  commit: string;
  /** What the branch does (BranchSummary), once anything is known. Additive. */
  summary?: BranchSummary;
  /** Commits ahead of the target. */
  ahead: number;
  /** The chat the branch belongs to (its id), by the rule Land records too (server/merge-queue/owners.ts): the chat
   *  that tracks the worktree, else the newest chat working in it. Absent: no chat found. */
  session?: string;
  /** That chat is archived (only an archived one was found). */
  sessionArchived?: true;
  /** Lines added and removed on the branch's side (target...branch), when read. */
  added?: number;
  removed?: number;
  /** When the branch last changed: its head's committer date (ISO 8601, `git log -1 --format=%cI`), when read.
   *  Additive. */
  headAt?: string;
  /** Its code has nothing left to land: only this many spec drafts not proved landed, which Land lands alone
   *  (§chat.worktrees/nothing-left). Additive. */
  draftsOnly?: number;
  /** The shared answer for this branch (§chat.worktrees/nothing-left): whole counts its drafts, code counts commits
   *  alone. A Ready row's whole is only ever "work" or "unknown". Additive. */
  left?: { whole: LeftAnswer; code: LeftAnswer };
  /** This branch changes automatic cleanup and no rehearsal passed at this commit today: Land reads Rehearsal needed, disabled (§app.merge-queue/approve). Additive. */
  rehearsal?: true;
  /** A setup branch: its dry run at this commit (Land runs it first when it hasn't passed). Additive. */
  dryRun?: BranchDryRun;
}

/** SessionWorktreeInfo.mergeStats: the branch against the target, for the row's "N commits · +a −r". */
export interface WorktreeMergeStats {
  /** The branch head the numbers were read at (Land pins it). */
  head: string;
  /** Commits the target hasn't. */
  ahead: number;
  /** Lines added and removed, the branch's side only (target...branch). */
  added: number;
  removed: number;
  /** When the branch last changed: its head's committer date (ISO 8601), when read. Additive. */
  headAt?: string;
}

/** A branch's place (§chat.worktrees/place): which project it belongs to and where it merges. */
export interface BranchPlace {
  /** The final words: the project's name (with just enough of its folder when two listed projects share it: "Notes ·
   *  work/notes"), else the repository's main folder from home ("~/code/tools"); the folder as last recorded when the
   *  repository can't be worked out. */
  label: string;
  /** The repository's main folder, absolute. Absent: not known. */
  root?: string;
  /** What it merges into now: the queue's target where the queue serves it, else master, else main. Absent: not
   *  known, never guessed. */
  target?: string;
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
  /** The target's .sova/project.json doesn't parse (MergeQueueView.invalid): its path and message. */
  invalid?: string;
  /** The queue is paused (why). */
  paused?: string;
  /** How the queue lands its branches, where it serves the repo (the settings' effective method). */
  how?: LandHow;
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
 * merge.answer  {entry, answer: accept | land-anyway | try-again | land, why?}     → entry (the user's own click)
 * merge.rule    {entry, ruling, text?, choices?, request?, note?}                 → entry (the thread's ruling)
 * merge.review  {run, verdict, text?}                         → entry (the review step's verdict)
 * merge.retry   {project | entry, note?}                      → view (rerun after a machine pause)
 * merge.try     {project?, branch? | commit?, checks?}        → trial + run (a setup branch's checks on its head; saves nothing)
 */
export const MERGE_ANSWERS = ["accept", "land-anyway", "try-again", "land"] as const;
export type MergeAnswer = (typeof MERGE_ANSWERS)[number];

/**
 * One finished entry as the queue's history keeps it for good (`<state>/merge-queue/<key>/history/YYYY-MM.jsonl`, one
 * row per entry, filed by the month it first became truly final). Read-only: no verb changes it.
 */
export interface MergeHistoryRow {
  id: string;
  /** When it first became truly final (landed, cancelled, pushed; sent back and superseded or merged). */
  finalAt: string;
  branch: string;
  target: string;
  commit: string;
  state?: MergeEntryState;
  /** The entry as it last stood; absent on a partial row. */
  entry?: MergeEntry;
  /** Backfilled from its runs alone (its entry was gone from the queue's records): no tries, requests or review. */
  partial?: true;
  /** Partial rows: what its runs said, the newest run's verdict, blame and failures. */
  runs?: string[];
  verdict?: RunVerdict;
  blame?: Blame;
  failures?: { step: string; file?: string; name?: string; message?: string; blame?: Blame }[];
  startedAt?: string;
  endedAt?: string;
}

/** `VerbResult.merge`: what a merge verb answers. */
export interface MergeReport {
  /** merge.events: a page of recorded changes. */
  events?: MergeEventsPage;
  view?: MergeQueueView;
  entry?: MergeEntry;
  /** merge.status {entry} of an entry only the history holds (read-only). */
  history?: MergeHistoryRow;
  run?: MergeRun;
  /** merge.logs: the step's log lines (newest last). */
  lines?: string[];
  /** merge.ask / merge.reply: the question as recorded. */
  ask?: MergeThreadAsk;
  /** merge.respond: the request as answered. */
  request?: MergeChatRequest;
  /** merge.fresh: whether a thread was retired; merge.clear: the chats deleted. */
  fresh?: boolean;
  cleared?: number;
  /** merge.try: the trial as recorded (its run is `run`). */
  trial?: MergeTrial;
  /** merge.try while the merge copy is busy: the dry run waits its turn. */
  waiting?: MergeTrialWaiting;
  /** merge.hold: the merge thread's hold now (null: none); `until` when it lifts by itself. */
  hold?: { at: string; until: string } | null;
  /** merge.live: what the running server started on, the target's head, and the restart plan between them. */
  live?: MergeLive;
  /** merge.restart: what the restart verb did. */
  restart?: MergeRestart;
  /** merge.test: the tests run in an entry's scratch copy. */
  test?: MergeCopyTest;
  /** merge.names: what the names step did (kinds and counts; `list` only for show). */
  names?: MergeNamesReport;
}

/** The restart plan from the running server's commit to the target's head (server/restart-paths.ts's rule). */
export interface MergeRestartPlan {
  action: "nothing" | "build" | "restart" | "unknown";
  install: boolean;
  why: string;
  /** How many landed files, and how many of them need a restart / a page build. */
  counts?: { files: number; restart: number; build: number };
  /** Up to 20 of each. */
  restartFiles?: string[];
  buildFiles?: string[];
}

/** merge.live's answer. */
export interface MergeLive {
  /** The commit the running server started on (GET /api/health's head), null outside a checkout. */
  head: string | null;
  startedAt: string;
  target: string;
  /** The target's head now ("" when the branch doesn't exist). */
  tip: string;
  /** Whether this queue's project is the one the running server was loaded from. */
  self: boolean;
  plan: MergeRestartPlan;
}

/** merge.restart's answer. */
export interface MergeRestart {
  /** nothing: no restart owed or not now (`why`); built: page files only, built; failed: install or build failed;
   *  restarting: the unit restarts in a few seconds, expecting `expect`. */
  outcome: "nothing" | "built" | "failed" | "restarting";
  why: string;
  plan?: MergeRestartPlan;
  step?: "install" | "build" | "restart";
  /** The last lines of the failed step's output. */
  tail?: string;
  expect?: string;
  unit?: string;
}

/** merge.test's answer. */
export interface MergeCopyTest {
  pass: boolean;
  /** Which step: install (the merge install) or test. */
  step: "install" | "test";
  exit: number | null;
  timedOut?: boolean;
  ms: number;
  copy: string;
  /** The last lines of the output. */
  tail: string;
}

/** merge.names's answer: never a name, except `list` (show). */
export interface MergeNamesReport {
  action: "discover" | "add" | "show";
  /** The script's own summary (kinds and counts; masked public hits). */
  summary: string;
  count?: number;
  /** show: the list, one `<kind>: <value>` per line. */
  list?: string;
}

// ---- the WS feed --------------------------------------------------------------------------------

/** On the session feed (shared/protocol.ts SessionFeedMessage): a project's queue changed. */
export interface MergeQueueFeed {
  type: "merge_queue";
  project: string;
  view: MergeQueueView;
}

/** On the session feed: one chat's merge queue cards changed (all of them, newest data). */
export interface MergeCardsFeed {
  type: "merge_cards";
  session: string;
  cards: MergeCard[];
  /** That chat's review cards, all of them (absent from an older server). */
  reviews?: ReviewCard[];
}

/** A blocking review's own card (kind `sova.merge-review`, §chat.merge-queue/review-card), in the chat its request goes
 *  to. Drawn from the entry's review record; a newer card of the same entry folds the older ones. */
export interface ReviewCard {
  /** `${entry}:${run}`: the record's id. */
  id: string;
  entry: string;
  /** The chat it stands in. */
  session: string;
  project: string;
  root: string;
  branch: string;
  target: string;
  /** The branch's commit that was reviewed. */
  commit: string;
  /** The run that reviewed it (See Run). */
  run: string;
  try: number;
  of: number;
  summary: string;
  findings: ReviewFinding[];
  note?: { text: string; at: string };
  state: ReviewCardState;
  stoppedFor?: string;
  /** That review's reviewer chat (Open Reviewer Chat); cleared: deleted since. */
  reviewer?: { session?: string; path?: string; cleared?: true };
  /** What the reviewer read; kept false: the tip is gone, so a file opens on the branch now ("lines may have moved"). */
  reviewed: { base: string; tip: string; kept: boolean };
  at: string;
  /** The chat's last transcript entry when it was raised (as MergeCardRevision.after). */
  after?: string | null;
  updatedAt: string;
}

// ---- a branch's card in the chat that built it ---------------------------------------------------

/** An outcome that moves the card to the bottom of the chat as a new revision. */
export type MergeCardOutcome = "landed" | "needs-fix" | "conflict" | "behaviour-differs" | "review-flagged" | "unattributed" | "drafts-changed" | "sent-back" | "requested" | "pushed" | "closed" | "removed" | "decision" | "nothing-to-land";
export const MERGE_CARD_OUTCOMES: readonly MergeCardOutcome[] = ["landed", "needs-fix", "conflict", "behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "sent-back", "requested", "pushed", "closed", "removed", "decision", "nothing-to-land"];

/**
 * One copy of the card at its own point in the chat. The newest revision draws the whole card (the card's live data);
 * earlier ones fold to one line from their own frozen `state`/`position` ("feat/x · Queued 2nd").
 */
export interface MergeCardRevision {
  /** `<card id>:<n>`, stable. */
  id: string;
  /** What raised it: the approval (Land, or a typed "land it"), or an outcome. */
  kind: "approved" | MergeCardOutcome;
  /** The run the outcome came from, when one did. */
  run?: string;
  at: string;
  /** The chat's last transcript entry when it was raised (placeOutsideCards `after`); null: before every row; absent: by time. */
  after?: string | null;
  /** The entry's state and place in line when it was raised, for its folded line. */
  state: MergeEntryState;
  position?: number;
}

/** A step that failed with the branch, for Needs a fix: its log is merge.logs {run, step}. */
export interface MergeCardFailure {
  run: string;
  step: string;
  label: string;
  detail?: string;
  /** Failing tests, "file › name", at most a few. */
  tests?: string[];
}

/** A Sova built-in card (kind `sova.merge-queue`): one per branch, from its approval on, in the chat that owns it. */
export interface MergeCard {
  /** The card's key (its revisions share it): the first queue entry it was raised for. */
  id: string;
  /** The queue entry it follows now: a new approval of the branch after a hand-back moves the same card on. */
  entry: string;
  session: string;
  project: string;
  root: string;
  branch: string;
  target: string;
  /** The approved commit. */
  commit: string;
  /** The branch's head as last read (Land Again pins it); absent: unknown or the branch is gone. */
  head?: string;
  /** The branch's worktree, when it had one. */
  worktree?: string;
  /** The branch's place (§chat.worktrees/place). Absent on a card written before Sova had that line: it gets none. */
  place?: BranchPlace;
  approvedBy: ApprovalBy;
  /** Live, revised in place: the entry as the queue reads it now. */
  state: MergeEntryState;
  position?: number;
  eta?: MergeEntry["eta"];
  reason?: string;
  newerCommits?: number;
  newerRewritten?: true;
  newerBlocked?: string;
  run?: string;
  /** Checking: steps finished of all the run's steps. */
  progress?: { done: number; total: number };
  notes: MergeNote[];
  conflict?: ConflictJudgement;
  review?: ReviewVerdict;
  unclear?: MergeUnclear[];
  /** Can't tell whose failure, before any decision: the merge thread is ruling on it ("Waiting for the merge thread"). */
  waitingRuling?: true;
  landed?: MergeEntry["landed"];
  /** Landing by request or push: the entry's request, live. */
  request?: MergeRequestInfo;
  /** Commits and lines the branch brought, frozen at landing (absent before). */
  stats?: { commits: number; added: number; removed: number };
  failures?: MergeCardFailure[];
  /** Needs a fix: the merge thread's later diagnosis (its note), added to the same card in place. */
  explanation?: { text: string; at: string };
  /** Back with the chat for a review: its review card ("Review found {count} issues", which jumps there). */
  reviewFound?: { card: string; session: string; path?: string; count: number };
  /** A decision waiting for the user (the entry's `decision`, unanswered): the card shows its question, choices and held note. */
  decision?: MergeDecision;
  /** Back with its chat under the user's standing Land: where it stands (the entry's `standing`). */
  standing?: MergeStanding;
  /** The standing approval's tries (the entry's). */
  tries?: MergeEntry["tries"];
  /** Landed: the checked fixes that landed after the user's Land, oldest first (al_3 q6). */
  fixesLanded?: { sha: string; subject: string }[];
  /** Needs a fix: why it was sent back (the entry's `sentBackFor`). */
  sentBackFor?: SentBackFor;
  /** Needs a fix, sent back for its drafts: they are fixed (the entry's `redrafted`), so Land comes back at the same commit. */
  redrafted?: true;
  /** The user removed it from the queue (Remove from Queue): its last revision, until a new Land moves it on. */
  removed?: true;
  /** Needs a fix that no longer needs one (the entry's `settled`: superseded, merged, gone): it offers nothing. */
  settled?: MergeSettled;
  revisions: MergeCardRevision[];
  updatedAt: string;
}

/** A wake the merge queue sends a chat (Needs a fix, Send Back) starts with this: the page draws it as the queue's, never the user's. */
export const MERGE_QUEUE_SENT_PREFIX = "[merge-queue]";
export const isMergeQueueText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(MERGE_QUEUE_SENT_PREFIX);

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
    case "unattributed":
      return "Can't tell whose failure · waiting for you";
    case "drafts-changed":
      return "Drafts changed since you approved";
    case "needs-fix":
      return "Needs a fix";
    case "with-chat":
      return "Back with the chat";
    case "needs-user":
      return "Waiting for you";
    case "landed":
      return "Landed";
    case "cancelled":
      return "Cancelled";
    case "request-review":
      return "Request ready for your look";
    case "requested":
      return "Request open on the host";
    case "pushed":
      return "Pushed";
    case "closed":
      return "Closed on the host";
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

/** The merge queue's own chats, by the profile Sova started them on (never by title): the project's merge
    thread and each run's reviewer. A rename, a move or a restart keeps the mark; any other chat has none. */
export type QueueChatRole = "thread" | "reviewer";
export const QUEUE_CHAT_PROFILES: Readonly<Record<string, QueueChatRole>> = { "merge-thread": "thread", "merge-reviewer": "reviewer" };
export function queueChatRole(profile: { id?: string; source?: string; builtin?: boolean } | null | undefined): QueueChatRole | undefined {
  if (!profile || typeof profile.id !== "string") return undefined;
  const sova = profile.source === "sova" || (profile.source === undefined && profile.builtin === true);
  return sova ? QUEUE_CHAT_PROFILES[profile.id] : undefined;
}
/** Why a queue chat's modes can't be switched from a menu or a tool. */
export const QUEUE_CHAT_MODE_REFUSAL = "That is one of the merge queue's own chats: it keeps the modes and settings Sova starts it with.";

/** The Merge thread card's facts. `state`: asking (a question is open), working (its turn runs), else idle. */
export interface MergeThreadInfo {
  session: string;
  path?: string;
  startedAt: string;
  /** Its memory type as switched on at the start (UniiChat); absent: none. */
  memory?: string;
  state: "idle" | "working" | "asking";
  /** The last event Sova sent it. */
  lastEvent?: { kind: string; at: string; branch?: string };
  /** The open question, when it is asking. */
  ask?: MergeThreadAsk;
  /** Messages in its chat, when known. */
  messages?: number;
}

/** One History row: a merge thread (current or replaced) or a reviewer chat. `cleared`: its chat was deleted then
    (the row keeps what it was; a run keeps its verdict and findings). */
export interface MergeQueueChat {
  kind: "thread" | "reviewer";
  session: string;
  path?: string;
  startedAt: string;
  endedAt?: string;
  /** The current merge thread: never cleared. */
  current?: true;
  /** A reviewer still running: never cleared. */
  running?: true;
  memory?: string;
  /** A thread: why it was replaced; a reviewer that gave no verdict: why. */
  why?: string;
  run?: string;
  branch?: string;
  attempt?: number;
  verdict?: "ok" | "notes" | "blocking" | "failed";
  cleared?: string;
}

/** A question the merge thread asked through merge.ask (§chat/merge-queue): it never waits in its own chat. It
    waits as a decision on the card of the entry's branch in its chat; the user's own message there is the answer.
    No chat to ask (none, archived, gone): the Merge Queue tab shows it (`onTab`) and one notification opens the tab. */
export interface MergeThreadAsk {
  id: string;
  question: string;
  at: string;
  entry?: string;
  branch?: string;
  /** The chat it was sent to (the branch's owner; a worker's chat for a worker). */
  askedIn?: { session: string; path: string };
  /** No chat could take it: the tab is where it is answered. */
  onTab?: true;
  answered?: { at: string; by: "chat" | "operator"; session?: string };
}
