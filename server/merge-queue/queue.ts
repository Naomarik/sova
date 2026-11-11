import { retirementViewOf } from "../worktree-retire-view";
import { pendingWhileOff, viewWhileOff } from "../cleanup-switch";
import { queueQuietWork } from "./card-port";
import { hostProblem } from "./host-sendback";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type LandHow,
  type CheckPick,
  type ChecksDeclared,
  ENTRY_OPEN,
  WAITING_FOR_USER,
  type LandingQueueCut,
  type MergeAnswer,
  type MergeApproval,
  type MergeChatAnswer,
  type MergeChatRequest,
  type MergeRequestKind,
  type MergeStanding,
  MERGE_TRIES,
  type MergeDecision,
  type MergeEntry,
  type MergeNote,
  type MergeQueueView,
  type MergeReady,
  type MergeRun,
  type MergeTrial,
  MERGE_TRIALS_KEPT,
  NOTE_MAX,
  type PauseInfo,
  type PauseKind,
  type PushState,
  type ReviewFinding,
  type ReviewVerdict,
  type RunStep,
  type SentBackFor,
  type MergeHistoryRow,
} from "../../shared/merge-queue";
import { historyWords } from "./history";
import { HOOK_TIMEOUT_MAX, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import type { ChecksOf, EstimateRun, RunInput, RunMerge, RunOutcome, ThreadEvent, WakeThread } from "./contract";
import { countBetween, type Git, isAncestor, ownCommitsPast, realGit, revParse, statusArgs, worktreesOf } from "./guard";
import { type BranchLeft, branchLanded, branchLeft, type LandingRecords, NO_LANDINGS, registerQueueReading } from "../nothing-left";
import type { GitRunner } from "../worktrees";
import { canLand, checkoutOf, dirtyWhy, firstParents, landTip, pushTip } from "./land";
import { recordLandedDrafts } from "./landed-drafts";
import { type MergeNoticeKind, nothingToLandWords } from "./notices";
import { sanityCheck } from "./conflicts";
import { cleanChoices, fingerprintOf, isRuling, resolveVerdict, RULING_TEXT_MAX, RULING_WAIT_MS, type Ruling, sendBackText } from "./rulings";
import { estimateFromRuns } from "./estimate";
import { deliverReview } from "./review-step";
import { applyReviewEvent, openReview, reportText, reviewNoteText, reviewRecord, type ReviewEvent } from "./review-record";
import { invalidOf, resolveTarget, setUpOf } from "./served";
import { isFinal, newId, type QueueFile, QueueStore } from "./store";
import { hasOrigin, publishGit, revertCommit, withdrawGit } from "./release-git";
import type { MergeCheckDecl } from "../../shared/project-contract";
import { settledFacts } from "./settled";
import { buildView, superseded } from "./view";
import { type MergeQueueSettings, type MergeSettingsChange, type MergeSettingsSaveResult, SETTINGS_DIRTY_WORDS } from "../../shared/merge-queue-settings";
import { effectiveModel, type ModelCheck, readModels } from "./models";
import { buildSettings, fixedValues, playbookDiffers } from "./settings";
import { approvalHow, effectiveHow, landHowSetting, opensRequest, publishes, type RequestHow, writeOverride } from "./strategy";
import { checkPublishText, draftText, type Hosting, hostMismatch, pollRequest, publishEntry, type PublishOutcome, publishSettings as publishSettingsRequest, reconcilePublish, requestInfo } from "./strategy-run";
import { fetchTarget, localBehind, updateLocalMain as updateMainTip } from "./publish";
import type { Drafter } from "./hosts/request-kit";
import { type HostAdapter, type HostKind, type HostRepo, NO_HOST_WORDS, NO_ORIGIN_WORDS } from "./hosts/types";
import { githubAdapter } from "./hosts/github";
import { gitlabAdapter } from "./hosts/gitlab";
import { suggestLanding } from "./hosts/repo";
import { changeWords, editSettingsText, isEmptyChange, REVIEW_KIT_DIR, SettingsEditError } from "./settings-edit";
import { PROJECT_PLAYBOOK } from "./thread";
import { dropScratch, isScratchCopy, makeScratchCopy, pinResolution, scratchCopyPath, scratchMarkOf, sweepScratch } from "./scratch";
import { commitResolution } from "./resolve-content";
import { isSetupChange, SETUP_UNREADABLE, setupChangeOf, trialReleaseChecks, untriedWhy } from "./setup-branch";

/** Land's refusal of a worktree the merge queue made for itself (a conflict's scratch copy). */
export const scratchRefusal = (what: string): string =>
  `${what} is a scratch copy the merge queue made to resolve a conflict, not work of yours to land: land the branch it was made for instead`;

/**
 * One merge queue per project: approved branches wait in line and are checked one at a time; a passed run lands
 * (master fast-forwards to exactly the tested tip), then pushes. The queue owns the target; a run (contract.ts,
 * copy-checks) owns the merge copy. Every change is written to the store before it is told to anyone.
 */

/** The push hold while a project has no private names file (operator decision: exactly these words). */
/** What the queue says when the target's .sova/project.json doesn't parse (`error`: the parser's path and message). */
export const invalidWords = (error: string): string => `The project's .sova/project.json is invalid: ${error}. Fix it on the target, or land a branch that fixes it; nothing else lands until it parses`;

/** heads.pushWhy while the checks' setup commit waits for the next landing's push. */
export const PUSH_WAITS_NEXT_LANDING = "not pushed yet: goes out with the next landing";
export const PUSH_HELD_NAMES = "push held: private names not set up yet";
/** How long the merge thread's hold (merge.hold) lasts unless it is set again or cleared. */
export const HOLD_MS = 5 * 60_000;

/** A ruling's text (a question, a diagnosis, an approach), trimmed and clipped. */
const clip = (t?: string): string => (t ?? "").trim().slice(0, RULING_TEXT_MAX);
/** How long one answer to "why isn't the newest commit Ready to land" is kept (view() runs often). */
const NEWEST_MEMO_MS = 5_000;
/** The reason a waiting entry shows while the merge thread holds the queue. */
export const HOLD_WORDS = "Waiting: Sova is restarting";
/** Requests kept per entry (the newest). */
const REQUESTS_KEPT = 30;
/** entry.fix.request while a conflict waits for the merge thread (no request of the chat's is involved). */
const CONFLICT_WAIT = "conflict";
/** The states Remove from Queue ends as "removed by you" under a standing approval (out of line, waiting on someone). */
/** A merge thread's note on a blocking review: short, and never the findings again (Sova sends them as written). */
export const REVIEW_NOTE_MAX = 500;
function reviewNoteOk(r: { summary: string; findings: { text: string }[] }, note: string): void {
  if (!note) return;
  const said = "the findings already go to the chat as the reviewer wrote them; add only what they don't say";
  if (note.length > REVIEW_NOTE_MAX) throw new MergeFailure("invalid-request", `a note on a review is at most ${REVIEW_NOTE_MAX} characters: ${said}`);
  const flat = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const n = flat(note);
  // Any 40 characters of the summary or a finding, repeated: refused (a short finding may still be named by its words).
  const repeats = [r.summary, ...r.findings.map((f) => f.text)].some((t) => {
    const f = flat(t);
    if (f.length < 40) return false;
    for (let i = 0; i + 40 <= f.length; i += 20) if (n.includes(f.slice(i, i + 40))) return true;
    return false;
  });
  if (repeats) throw new MergeFailure("invalid-request", `the note repeats the review: ${said}`);
}

/** Blocking reviews kept per entry (each its own card); the tries bound them well below this. */
const REVIEWS_KEPT = 10;
/** Why a run stopped before its review, one line (the review card's Stopped). */
function stoppedWhy(out: { verdict: string; cause?: string; why?: string }, target: string): string {
  if (out.verdict === "conflict") return `a conflict with ${target}`;
  if (out.cause === "drafts") return "its spec drafts didn't fit";
  return `a check failed${out.why ? `: ${out.why.split("\n")[0]!.slice(0, 160)}` : ""}`;
}
const REMOVABLE: readonly string[] = ["needs-user", "drafts-changed", "behaviour-differs", "unattributed", "review-flagged", "conflict"];
/** The states a chat's answer is taken in: back with it, its drafts changed, or in line (a fix then waits for the run). */
const ANSWERABLE: readonly string[] = ["with-chat", "queued", "checking"];
/** How often entries with their chats are looked at again (a block gone, a thread back). */
export const FIX_RECHECK_MS = 60_000;
/** A fix the merge thread was told of but hasn't ruled on is handed to it again after this long. */
export const FIX_REWAKE_MS = 15 * 60_000;

/** A request telling the chat what still keeps its approved branch out of line (§app.merge-queue/approve, q7). */
export function blockedText(e: Pick<MergeEntry, "branch" | "target" | "commit">, why: string): string {
  return (
    `The user pressed Land on ${e.branch} at ${e.commit.slice(0, 7)}, and their Land stands, but it can't join the line yet: ${why}. ` +
    `Fix it, then answer this request. Once nothing blocks it and the merge thread has checked your fix, Sova puts ${e.branch} in line by itself: the user doesn't press Land again.`
  );
}

export class MergeFailure extends Error {
  constructor(
    readonly code: "invalid-request" | "not-found" | "forbidden" | "busy" | "unsupported" | "needs-confirm",
    message: string,
  ) {
    super(message);
  }
}

export interface QueueDeps {
  /** The records' folder (`<state>/merge-queue`). */
  base: string;
  runMerge: RunMerge;
  checksOf: ChecksOf;
  estimate?: EstimateRun;
  git?: Git;
  /** The definition at a ref of the project (the target's head). */
  definitionAt: (root: string, ref: string) => Promise<{ def: ProjectDef | null; error: string | null }>;
  /** The project's id, when registered. */
  projectIdOf?: (root: string) => string | null;
  /** The project is on Sova's Projects list (with its setup done, the queue serves it: served.ts). Default: yes. */
  listed?: (root: string) => boolean;
  /** A queue's view changed. */
  publish?: (view: MergeQueueView) => void;
  /** Why the branch's newest commit `tip` isn't Ready to land, from its chat's readiness reading (read only, never a
   *  fresh read): words, null when it is, undefined when no reading can say (the queue's own checks then answer). */
  newestReading?: (worktree: string, tip: string) => Promise<string | null | undefined>;
  /** A test check was found broken on the target (heads.targetBroken): one notification for the user, so a session
   *  can be started to fix the target. Called once per check until a later run lifts it. */
  flagBroken?: (b: import("../../shared/merge-queue").TargetBroken, root: string) => void;
  /** Tell the branch's chat (server/merge-queue/notices.ts). */
  /** `press`: the time of the user's own Land press this notice reports (add, a decision's Land); never on an automatic re-queue. */
  notify?: (kind: MergeNoticeKind, entry: MergeEntry, extra: { run?: MergeRun; root: string; logDir?: string; request?: MergeChatRequest; press?: string }) => void;
  /** The user's answer to a merge thread question, sent from the branch's chat with its decision: the question is
   *  closed and the answer goes to the thread (thread.ts MergeThread.answer). */
  answerAsk?: (root: string, ask: string, text: string, session?: string) => void;
  /** A new decision waits for the user: its one notification (rulings.ts decisionPush; wire.ts sends it). */
  decided?: (e: MergeEntry, root: string) => void;
  /** The chat's own newest check run fails (Ready to land's "the session's newest check run isn't failing"): its
   *  words ("this chat's last test run failed: …"), else null. Absent: not read. */
  chatCheckFailing?: (session: string, worktree: string | undefined) => Promise<string | null>;
  /** A trial (merge.try) ended: the chat that started it is told (wire.ts). */
  trialEnded?: (trial: MergeTrial, run: MergeRun, root: string) => void;
  /** Wake the merge thread; false: none was asked. */
  thread?: WakeThread;
  /** The chat that owns a branch, when the approval named none (Land on the Merge Queue tab); null: no known chat. */
  ownerOf?: (root: string, branch: string, worktree: string | undefined) => Promise<string | { session: string; archived?: boolean } | null>;
  /** The worktree's spec drafts hash (server/spec-drafts-state.ts draftsHash). */
  draftsHash?: (dir: string) => { hash: string; names: string[]; each?: Record<string, string> } | undefined;
  /** Sova's docs check of a worktree's drafts at a commit (server/docs-preview.ts previewDocs, cached by tree, commit
   *  and drafts hash): the problems that would keep them from landing, or "pending" while it runs (`done` is called
   *  when it ends). Absent: no check (every redrafted entry reads clean). */
  docsCheck?: (dir: string, commit: string, hash: string, done: () => void) => { problems: string[] } | "pending";
  /** A content hash of the worktree's whole drafts folder, notes included (spec-drafts-state.ts draftsFingerprint):
   *  kept at a drafts hand-back, so a fix that only records a note reads as a change. */
  draftsFingerprint?: (dir: string) => string | undefined;
  now?: () => number;
  /** A machine failure's retry waits this long (default 60 s). */
  retryDelayMs?: number;
  /** A conflict waits this long for the thread's judgement before it is handed back (default 20 min). */
  conflictWaitMs?: number;
  /** A failure blamed on the branch waits this long for the thread's diagnosis before it goes back without one, and a
   *  chat's Can't this long for the thread's ruling before it is raised to the user (default RULING_WAIT_MS). */
  rulingWaitMs?: number;
  /** How often a running run checks the target hasn't moved (default 2 s). */
  watchMs?: number;
  /** Runs kept per project (default 200). */
  keepRuns?: number;
  /** The project's review kit is declared (and readable). Default: `def.merge.review` set. */
  hasReviewKit?: (def: ProjectDef | null, root: string) => boolean;
  /** The project's merge thread chat (thread.ts threadInfo): the Merge thread card's facts. */
  threadOf?: (root: string) => import("../../shared/merge-queue").MergeThreadInfo | null;
  /** The queue's own chats (chats.ts): the reviewer running now and the History's rows. */
  chatsOf?: (root: string) => Pick<MergeQueueView, "reviewing" | "chats">;
  /** Hand a reviewer's verdict to the review step (default review-step.ts deliverReview). */
  deliverReview?: typeof deliverReview;
  /** The mechanical sanity check of a resolution (default conflicts.ts sanityCheck). */
  sanity?: typeof sanityCheck;
  /** Sova's own project keeps the merge round's names file (`<state>/merge-round.json`) until it has its own. */
  legacyNames?: { root: string; file: string };
  /** Logs (default console). */
  log?: (line: string) => void;
  /** A release entry moved (landed, handed back, waits for the user, cancelled): the releaser follows its release. */
  releaseEvent?: (ev: ReleaseQueueEvent) => void;
  /** What a branch does (branch-summaries.ts), for a row at a commit; never starts a write. */
  summaryOf?: (root: string, branch: string, commit: string) => import("../../shared/merge-queue").BranchSummary | undefined;
  /** Drop the summaries no row needs: `live` branches have a ref and haven't landed at it; `shown` commits a row shows. */
  pruneSummaries?: (root: string, live: ReadonlySet<string>, shown: ReadonlySet<string>) => void;
  /** The review and thread models' check: the new-chat default and why a pick can't be used (models.ts
   *  liveModelCheck; default: no default read, every pick usable). */
  modelCheck?: ModelCheck;
  /** The hosts how-it-lands reads (strategy.ts landHowSetting; default server/merge-queue/hosts/). */
  hosts?: Parameters<typeof landHowSetting>[0]["hosts"];
  /** A host's adapter (request strategies; default hosts/github.ts or hosts/gitlab.ts with the real CLI). */
  hostAdapter?: (kind: HostKind) => HostAdapter;
  /** The project's repository on its host (default: origin's URL read by hosts/repo.ts repoOf). */
  hostRepo?: (root: string) => Promise<HostRepo | null>;
  /** Whether the chat that owns a branch is idle (nothing running): the docs commit waits for it (q9 = c). Default: idle. */
  chatIdle?: (session: string) => Promise<boolean>;
  /** A chat's title (a request's title, a5); null: unknown. */
  chatTitle?: (session: string) => Promise<string | null>;
  /** Writes a request's text from the request kit's brief (default: Sova's plain text). */
  drafter?: Drafter;
  /** How often open requests are read on the host (default 3 min). */
  pollMs?: number;
  /** The worktree was made by one of the merge queue's own chats (its creating tracker is a queue chat, owners.ts
   *  queueMadeNow), asked once per list and then of each row: one of the scratch copies the merge thread made itself
   *  before Sova made them. Default: none is. */
  queueMade?: () => Promise<(worktree: string) => boolean>;
}

/** What the queue tells the releaser about one of a release's entries. */
export interface ReleaseQueueEvent {
  /** The project's main checkout. */
  root: string;
  release: string;
  kind: "release" | "revert";
  entry: MergeEntry;
  /** landed: on the target (not pushed); failed: handed back (`why`); waiting: needs the user (review, can't tell
   *  whose failure); checking: its run started; cancelled. */
  what: "checking" | "landed" | "failed" | "waiting" | "cancelled";
  why?: string;
  run?: string;
}

const SETTINGS_FILE = ".sova/project.json";
type QueueSettingsPublish = { state: "requested"; branch: string; url: string; number: number; commit: string } | { state: "pushed"; branch: string; commit: string };

export interface AddRequest {
  branch?: string;
  checkout?: string;
  commit?: string;
  withoutSpecs?: boolean;
  withoutReview?: boolean;
  chat?: string;
  /** The session whose branch it is (notices go there). */
  session?: string;
  by: MergeApproval["by"];
  at?: string;
  /** Typed "open a PR" / "open an MR": this approval opens that request, whatever the project's setting. */
  via?: "github-pr" | "gitlab-mr";
}

interface Current {
  run: MergeRun;
  entry: string;
  ac: AbortController;
  /** Why it was aborted, if it was. */
  voidWhy: null | "master-moved" | "cancelled" | "superseded" | "stopping" | "release";
  watch: ReturnType<typeof setInterval> | null;
  done: Promise<void>;
  /** The local target's head at the run's start: what the watch compares (a request project's base is origin's). */
  localBase: string;
}

type Entry = QueueFile["entries"][number];

/** A trial's picks: every optional merge check its definition declares (a landing runs those only when picked). */
function optionalPicks(def: ProjectDef): CheckPick[] {
  const checks = def.merge?.checks;
  return Array.isArray(checks) ? checks.filter((c) => c.optional).map((c) => ({ id: c.id, label: c.label, source: "picked" as const, why: "a trial runs every proposed check" })) : [];
}

export class ProjectQueue {
  readonly store: QueueStore;
  private q!: QueueFile;
  private readonly git: Git;
  private current: Current | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private holdUntil = 0;
  /** The entry whose run started or that was cancelled last since the thread was last told the queue went idle
   *  (wakeIdle); null: nothing to tell. */
  private idleOwed: string | null = null;
  /** The merge thread's hold has its expiry kick armed. */
  private holdKick = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private conflictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Send-backs waiting for the merge thread's ruling (rulings.ts RULING_WAIT_MS), and Can'ts it is ruling on. */
  private rulingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reviewWaiters = new Map<string, { resolve: (v: ReviewVerdict) => void; reject: (e: Error) => void }>();
  private landing = false;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private checksCache: { head: string; def: ProjectDef | null; checks: ChecksDeclared; review: boolean; invalid?: string } | null = null;
  /** Entries that may have a scratch copy or a pinned resolution (scratch.ts): each is removed once the entry is final. */
  private scratchIds = new Set<string>();
  /** Scratch copies are made and removed one at a time, in order (a retry's new copy never races the old one's removal). */
  private scratchChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: QueueDeps,
    readonly root: string,
    readonly id: string,
  ) {
    this.git = deps.git ?? realGit;
    this.store = new QueueStore(deps.base, root);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private log(line: string): void {
    (this.deps.log ?? ((l) => console.log(l)))(`[merge-queue] ${this.id}: ${line}`);
  }
  /** A line in this queue's log (restart.ts). */
  logLine(line: string): void {
    this.log(line);
  }

  /** What merge.restart reads (restart.ts): anything queued or checking (or a run, trial or landing going on), the
   *  release holding the queue, and the newest landing. */
  restartFacts(): { busy: boolean; release: boolean; landed: { id: string; branch: string } | null } {
    const busy = !!this.current || !!this.trying || !!this.landing || this.q.entries.some((e) => e.state === "queued" || e.state === "checking");
    const l = this.newestLanded();
    return { busy, release: !!this.q.release, landed: l ? { id: l.id, branch: l.branch } : null };
  }

  /** The thread's or operator's note on an entry now ("" when none). */
  entryNote(entryId: string): string {
    return this.entry(entryId)?.notes.find((n) => n.kind === "thread" || n.kind === "operator")?.text ?? "";
  }

  /** Load the records and work out the target. Recovery (recover.ts) runs after. */
  async load(): Promise<void> {
    registerQueueReading(this.root, {
      landings: (branch) => this.landingsOf(branch),
      target: () => this.q?.target ?? null,
      // Anything but landed, closed or cancelled: an entry still under way keeps its branch from retiring.
      open: (branch) => {
        const e = this.q?.entries.find((x) => x.branch === branch && (ENTRY_OPEN.includes(x.state) || (x.state === "needs-fix" && !superseded(this.q.entries, x))));
        return e ? { id: e.id, state: e.state } : null;
      },
      // In line, checking or waiting for the user, or landed: never Approved · waiting for a fix or back with its chat,
      // which still get their requests (§chat.worktrees/blocks-landing).
      approvedAt: (branch, head) => !!this.q?.entries.some((x) => x.branch === branch && x.commit === head && x.state !== "with-chat" && (ENTRY_OPEN.includes(x.state) || x.state === "landed" || x.state === "requested" || x.state === "pushed")),
    });
    const target = await this.resolveTarget();
    this.q = this.store.read({ project: this.id, target });
    this.q.project = this.id;
    this.q.target = target;
    // Once per project: the entries only runs/ remembers get partial history rows (history.ts).
    try {
      this.store.backfillHistory(this.q);
    } catch (err) {
      console.warn(`[merge-queue] history backfill for ${this.root} failed: ${err instanceof Error ? err.message : err}`);
    }
    // Host landings recorded before their pins were kept: read now, while their entries are still here to read.
    for (const e of [...this.q.entries].filter((x) => x.state === "landed" && x.landed?.via === "host").sort((a, b) => a.landed!.at.localeCompare(b.landed!.at))) {
      if (!this.q.hostPins?.[e.branch]?.includes(e.commit)) this.keepHostPin(e.branch, e.commit);
    }
    // Entries with their chats are looked at again: a fix the merge thread wasn't told of, a block that went away.
    if (this.q.entries.some((e) => e.state === "with-chat" || !!e.fix)) this.armFixTimer();
  }

  get target(): string {
    return this.q.target;
  }
  get file(): QueueFile {
    return this.q;
  }

  private resolveTarget(): Promise<string> {
    return resolveTarget(this.git, this.root, this.deps.definitionAt);
  }

  async targetHead(): Promise<string | null> {
    return revParse(this.git, this.root, `refs/heads/${this.q.target}`);
  }

  /** Serialize every change: verbs, outcomes and kicks never interleave. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  save(): void {
    this.viewCache = null;
    const merged = this.settledCache ? new Set([...this.settledCache.facts].filter(([, f]) => f === "merged").map(([id]) => id)) : undefined;
    this.store.write(this.q, { ...(merged ? { merged } : {}), now: this.iso() });
    this.schedulePublish();
    this.tidyScratch();
  }

  // ---- scratch copies (scratch.ts) --------------------------------------------------------------

  private scratchStep<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.scratchChain.then(fn, fn);
    this.scratchChain = p.catch(() => {});
    return p;
  }

  /** Each entry whose attempt ended (final: landed, sent back, cancelled, superseded) loses its copy and its ref. */
  private tidyScratch(): void {
    for (const id of [...this.scratchIds]) {
      if (this.keepsScratch(id)) continue;
      this.scratchIds.delete(id);
      void this.scratchStep(async () => {
        const r = await dropScratch(this.git, this.root, id);
        if (r.copy || r.ref) this.log(`removed ${[r.copy ? "the scratch copy" : "", r.ref ? "the pinned resolution" : ""].filter(Boolean).join(" and ")} of ${id}`);
      });
    }
  }

  /** A scratch copy (and its pinned resolution) lasts while its attempt does: the thread judging the conflict, the user
   *  deciding on it, or the resolution in line or checking. Sent back to the chat, decided otherwise or final: it goes. */
  private keepsScratch(id: string): boolean {
    const e = this.entry(id);
    return !!e && (e.state === "conflict" || e.state === "behaviour-differs" || e.state === "queued" || e.state === "checking");
  }

  /** The conflict's scratch copy for the merge thread, at the target's head: its path, or why it couldn't be made. */
  private makeScratch(e: Entry, base: string): Promise<{ scratch: string } | { scratchError: string }> {
    this.scratchIds.add(e.id);
    return this.scratchStep(async () => {
      try {
        return { scratch: await makeScratchCopy(this.git, { root: this.root, entry: e.id, base }) };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.log(`the scratch copy of ${e.id} couldn't be made: ${why}`);
        return { scratchError: why };
      }
    });
  }

  /** Where the sanity probe runs: the entry's scratch copy, made at `base` if it isn't there; never the main
   *  checkout. Throws when no copy can be made (the resolution then isn't judged). */
  private async probeDir(e: Entry, base: string): Promise<string> {
    const path = scratchCopyPath(this.root, e.id);
    if (scratchMarkOf(path)?.entry === e.id) return path;
    const made = await this.makeScratch(e, base);
    if ("scratchError" in made) throw new MergeFailure("busy", `the resolution can't be checked: its scratch copy couldn't be made (${made.scratchError})`);
    return made.scratch;
  }

  /** At start: drop every copy and ref whose entry is final or gone from the queue file (pruned: final); keep the
   *  open ones', and remember them for when they end. */
  async sweepScratch(): Promise<string[]> {
    const open = (id: string) => {
      const keep = this.keepsScratch(id);
      if (keep) this.scratchIds.add(id);
      return keep;
    };
    return this.scratchStep(() => sweepScratch(this.git, this.root, open)).catch(() => [] as string[]);
  }

  /** Tests: wait for the scratch copies' makes and removals in flight. */
  scratchIdle(): Promise<unknown> {
    return this.scratchChain;
  }

  /** A worktree the merge queue made for itself: a scratch copy (by its mark), or one a queue chat created. */
  private async queueOwned(path: string, made?: (worktree: string) => boolean): Promise<boolean> {
    if (isScratchCopy(path)) return true;
    return !!(made ?? (await this.queueMadeNow()))(path);
  }

  /** Which worktrees the queue's chats made, from one look: a list asks it once, then each row. Can't be read: none. */
  private async queueMadeNow(): Promise<(worktree: string) => boolean> {
    return (await this.deps.queueMade?.().catch(() => null)) ?? (() => false);
  }

  private schedulePublish(): void {
    if (!this.deps.publish || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.view()
        .then((v) => this.deps.publish?.(v))
        .catch((err) => this.log(`view failed: ${err instanceof Error ? err.message : err}`));
    }, 150);
  }

  // ---- reading ----------------------------------------------------------------------------------

  entries(): Entry[] {
    return this.q.entries;
  }
  entry(id: string): Entry | undefined {
    return this.q.entries.find((e) => e.id === id);
  }
  /** An entry only the history holds (no longer in the working list): read-only. */
  historyEntry(id: string): MergeHistoryRow | null {
    if (!/^mq_[0-9a-z]+$/.test(id) || this.entry(id)) return null;
    return this.store.historyRow(id);
  }
  /** Refuses an entry only the history holds: no verb changes a finished entry kept there. */
  refuseHistory(id: string | undefined): void {
    const h = id ? this.historyEntry(id) : null;
    if (h) throw new MergeFailure("invalid-request", historyWords(h));
  }
  queued(): Entry[] {
    return this.q.entries.filter((e) => e.state === "queued").sort((a, b) => a.seq - b.seq);
  }
  currentRun(): MergeRun | null {
    return this.current?.run ?? null;
  }
  isPaused(): boolean {
    return !!this.q.paused;
  }

  /** The target's definition and what it declares, cached per target head. */
  async declared(): Promise<{ head: string | null; def: ProjectDef | null; checks: ChecksDeclared; review: boolean; invalid?: string }> {
    const head = await this.targetHead();
    if (head && this.checksCache?.head === head) return this.checksCache;
    const at = head ? await this.deps.definitionAt(this.root, head) : { def: null, error: "no target" };
    const checks = this.deps.checksOf(at.def);
    const review = (this.deps.hasReviewKit ?? ((d) => !!d?.merge?.review))(at.def, this.root);
    // A definition that is there but doesn't parse is not "not set up": its error is kept and said (definitionAt's other
    // errors, "no commit …" and "no .sova/project.json at …", are a project with nothing declared).
    const invalid = invalidOf(at);
    const out = { head: head ?? "", def: at.def, checks, review, ...(invalid ? { invalid } : {}) };
    if (head) this.checksCache = out;
    return out;
  }

  private viewCache: { at: number; v: Promise<MergeQueueView> } | null = null;
  /** The view, re-read at most every `ttlMs` (the worktree rows ask often). */
  cachedView(ttlMs = 1500): Promise<MergeQueueView> {
    if (this.viewCache && this.now() - this.viewCache.at < ttlMs) return this.viewCache.v;
    const v = this.view();
    this.viewCache = { at: this.now(), v };
    v.catch(() => (this.viewCache = null));
    return v;
  }

  /** `fresh`: nothing timed is kept (a caller that keeps this view until its refs move again). */
  async view(opts?: { fresh?: boolean }): Promise<MergeQueueView> {
    if (opts?.fresh) this.settledCache = null;
    const d = await this.declared();
    const head = d.head || (await this.targetHead()) || "";
    // How far each open entry's branch moved past its pinned commit.
    const recentLanded = new Set(
      this.q.entries
        .filter((e) => e.state === "landed")
        .sort((a, b) => (b.landed?.at ?? "").localeCompare(a.landed?.at ?? ""))
        .slice(0, 20)
        .map((e) => e.id),
    );
    // Sent back (the newest 20 still to fix): Land This Commit Again lands the branch's newest commit, so its row says how
    // many of the branch's own commits it brings in, and why that commit can't be landed yet when it can't.
    const recentSentBack = new Set(
      this.q.entries
        .filter((e) => e.state === "needs-fix")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
        .map((e) => e.id),
    );
    for (const e of this.q.entries) {
      if (isFinal(e) && !recentLanded.has(e.id) && !recentSentBack.has(e.id)) continue;
      const tip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
      const moved = !!tip && tip !== e.commit;
      const descends = moved && (await isAncestor(this.git, this.root, e.commit, tip));
      // Only real work counts past an approval (§app.merge-queue/approve): a catch-up merge is nothing new.
      const n = descends ? await ownCommitsPast(this.git, this.root, e.commit, tip, head || undefined, true) : 0;
      if (n) e.newerCommits = n;
      else delete e.newerCommits;
      // Amended or rebased after the send-back: nothing to count, and the re-land still lands the tip.
      const rewritten = moved && !descends && e.state === "needs-fix";
      if (rewritten) e.newerRewritten = true;
      else delete e.newerRewritten;
      const blocked = (n || rewritten) && tip && e.state === "needs-fix" ? await this.newestBlocked(e.branch, tip) : null;
      if (blocked) e.newerBlocked = blocked;
      else delete e.newerBlocked;
    }
    const takes = this.deps.estimate ? this.deps.estimate(this.id, this.root) : this.estimateFromHistory();
    const redrafted = await this.redraftedFacts();
    const ready = await this.readyList(head, redrafted);
    const thread = this.deps.threadOf?.(this.root) ?? null;
    const tryRun = this.trying?.run ?? (this.lastTry ? this.store.readRun(this.lastTry) : null);
    const origin = await this.originFacts();
    const settled = await this.settledFacts(head);
    const v = buildView({
      q: this.q,
      root: this.root,
      current: this.current?.run ?? null,
      checks: d.checks,
      review: d.review,
      head,
      takesMs: takes,
      now: this.now(),
      readRun: (id) => this.store.readRun(id),
      origin,
      settled,
    });
    // Why each was sent back (an entry from before it was kept: inferred once), and which may land again as they are.
    for (const e of v.needsFix) {
      const cause = this.causeOf(e);
      if (cause) e.sentBackFor = cause;
      if (!e.settled && redrafted.has(e.id)) e.redrafted = true;
    }
    // A sent-back branch whose newest commit isn't Ready to land keeps its row, with why: no Ready row stands in for it.
    const heldBack = new Set(v.needsFix.filter((e) => !e.settled && e.newerBlocked).map((e) => e.branch));
    const settings = head ? await this.settings().catch((err) => (this.log(`settings unreadable: ${err instanceof Error ? err.message : err}`), null)) : null;
    // Landing by request or push (al_3): what waits on the host, and how far local main is behind origin's.
    const weekAgo = new Date(this.now() - 7 * 24 * 3600_000).toISOString();
    const onHost = this.q.entries
      .filter((e) => e.state === "requested" || ((e.state === "closed" || e.state === "pushed") && e.updatedAt >= weekAgo))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map(({ seq: _seq, ...rest }) => structuredClone(rest) as MergeEntry);
    if (onHost.length) v.waitingOnHost = onHost;
    const requestProject = publishes(effectiveHow(d.def?.merge?.land, this.store.dir).effective) || this.q.entries.some((e) => !!e.request && !isFinal(e));
    if (requestProject && head) {
      const behind = await localBehind(this.git, this.root, this.q.target);
      if (behind) {
        v.heads.behind = behind;
        const co = await checkoutOf(this.git, this.root, this.q.target);
        const why = co ? await dirtyWhy(this.git, co) : null;
        if (why) v.heads.behindBlocked = `${why}: commit or put them away, then Update Local Main`;
      }
    }
    // Opening the tab reads the host now (at most every 20 s), contracts §5.
    if (this.q.entries.some((e) => e.state === "requested") && this.now() - this.lastPoll > 20_000) {
      this.lastPoll = this.now();
      void this.pollHost().catch((err) => this.log(`host poll failed: ${err instanceof Error ? err.message : err}`));
    }
    // Served by the queue (team mq-served-only, served.ts): on Sova's Projects list with its setup done.
    const served = (this.deps.listed?.(this.root) ?? true) && setUpOf(d.checks, d.invalid);
    const hold = this.q.release ? (({ checks: _c, ...h }) => h)(this.q.release) : undefined;
    // An entry the hold keeps waiting has no start time: it starts once the release is published or abandoned.
    if (hold) for (const w of v.waiting) if (w.release !== hold.id) delete w.eta;
    const chats = this.deps.chatsOf?.(this.root) ?? {};
    const readyRows = this.attachSummaries(v, ready.filter((r) => !heldBack.has(r.branch)));
    // What retirement did here, as it last wrote it: no git (§chat.worktrees/retirement).
    // Switched off (../cleanup-switch.ts): the ledger only, never the saved list.
    const retirement = viewWhileOff(retirementViewOf(this.root, pendingWhileOff()));
    return { ...v, served, ...(hold ? { release: structuredClone(hold) } : {}), ...(d.invalid ? { invalid: d.invalid } : {}), ...(readyRows.length ? { ready: readyRows } : {}), ...(thread ? { thread } : {}), ...chats, ...(tryRun ? { tryRun: structuredClone(tryRun) } : {}), ...(this.q.trials?.length ? { trials: structuredClone(this.q.trials) } : {}), ...(settings ? { settings } : {}), ...(retirement ? { retirement } : {}) };
  }

  /**
   * The landing bar's starting picture (GET /api/merge-queue/landing-summary): the queue's own records and its current
   * run, with none of view()'s Git reads past the target's head (no Ready list, no newer-commit counts, no settled,
   * origin or settings reads). `recentMax`: the newest landed entries kept, and of what waits on the host.
   */
  async landingCut(recentMax = 5): Promise<LandingQueueCut> {
    const d = await this.declared();
    const head = d.head || (await this.targetHead()) || "";
    const takes = this.deps.estimate ? this.deps.estimate(this.id, this.root) : this.estimateFromHistory();
    const landed = this.q.entries.filter((e) => e.state === "landed").sort((a, b) => (b.landed?.at ?? b.updatedAt).localeCompare(a.landed?.at ?? a.updatedAt));
    const keep = new Set(landed.slice(0, recentMax).map((e) => e.id));
    const q = { ...this.q, entries: this.q.entries.filter((e) => e.state !== "landed" || keep.has(e.id)) };
    const v = buildView({ q, root: this.root, current: this.current?.run ?? null, checks: d.checks, review: d.review, head, takesMs: takes, now: this.now(), readRun: (id) => this.store.readRun(id) });
    const served = (this.deps.listed?.(this.root) ?? true) && setUpOf(d.checks, d.invalid);
    const hold = this.q.release ? (({ checks: _c, ...h }) => h)(this.q.release) : undefined;
    if (hold) for (const w of v.waiting) if (w.release !== hold.id) delete w.eta;
    const { reviewing } = this.deps.chatsOf?.(this.root) ?? {};
    // What waits on the host (a request open, closed or pushed this week), as view() keeps it: the newest few.
    const weekAgo = new Date(this.now() - 7 * 24 * 3600_000).toISOString();
    const onHost = this.q.entries
      .filter((e) => e.state === "requested" || ((e.state === "closed" || e.state === "pushed") && e.updatedAt >= weekAgo))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, recentMax)
      .map(({ seq: _seq, ...rest }) => structuredClone(rest) as MergeEntry);
    return {
      project: v.project,
      root: v.root,
      target: v.target,
      state: v.state,
      ...(v.paused ? { paused: v.paused } : {}),
      ...(d.invalid ? { invalid: d.invalid } : {}),
      served,
      ...(v.current ? { current: v.current } : {}),
      checking: v.checking,
      waiting: v.waiting,
      needsYou: v.needsYou,
      recent: v.recent,
      ...(onHost.length ? { waitingOnHost: onHost } : {}),
      ...(hold ? { release: structuredClone(hold) } : {}),
      ...(reviewing ? { reviewing } : {}),
      heads: v.heads,
      at: v.at,
    };
  }

  /** The view is read again and published (a branch summary started, was written or failed). */
  republish(): void {
    this.viewCache = null;
    this.schedulePublish();
  }

  private summariesPrunedAt = 0;
  /** Each row's branch summary (branch-summaries.ts): Ready rows at their head, entries at their approved commit
   *  (landed rows keep the one they had). Every 10 minutes at most, the summaries no row needs are dropped. */
  private attachSummaries(v: MergeQueueView, ready: MergeReady[]): MergeReady[] {
    const of = this.deps.summaryOf;
    if (!of) return ready;
    const entries = [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix, ...(v.waitingOnHost ?? []), ...v.recent.map((l) => l.entry)];
    const rows = ready.map((r) => {
      const s = of(this.root, r.branch, r.commit);
      return s ? { ...r, summary: s } : r;
    });
    for (const e of entries) {
      const s = of(this.root, e.branch, e.commit);
      if (s) e.summary = s;
    }
    if (this.deps.pruneSummaries && this.now() - this.summariesPrunedAt > 10 * 60_000) {
      this.summariesPrunedAt = this.now();
      const prune = this.deps.pruneSummaries;
      const shown = new Set([...rows.map((r) => r.commit), ...rows.map((r) => r.summary?.stale?.commit).filter((c): c is string => !!c), ...entries.map((e) => e.commit), ...entries.map((e) => e.summary?.stale?.commit).filter((c): c is string => !!c)]);
      void (async () => {
        const refs = await this.git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"], this.root);
        if (refs.code !== 0) return;
        const landedAt = new Set(this.q.entries.filter((e) => e.state === "landed").map((e) => `${e.branch} ${e.commit}`));
        const live = new Set(refs.stdout.split("\n").filter((l) => l && !landedAt.has(l)).map((l) => l.slice(0, l.lastIndexOf(" "))));
        prune(this.root, live, shown);
      })().catch((err) => this.log(`summaries prune failed: ${err instanceof Error ? err.message : err}`));
    }
    return rows;
  }

  /** Whether the project has origin, and origin's copy of the target as last fetched (its remote-tracking ref; never a fetch). */
  private async originFacts(): Promise<{ has: boolean; tracking: string | null }> {
    const has = (await this.git(["remote"], this.root)).stdout.split("\n").includes("origin");
    return { has, tracking: has ? await revParse(this.git, this.root, `refs/remotes/origin/${this.q.target}`) : null };
  }

  // ---- settings (the Settings dialog's Merge Queue tab) ----------------------------------------------

  private settingsCache: { key: string; at: number; v: MergeQueueSettings } | null = null;

  /** Every setting the queue uses, read from the target's head; re-read at most every 10 s or when anything it shows changes. */
  async settings(): Promise<MergeQueueSettings> {
    const d = await this.declared();
    const head = d.head || "";
    const heldBy = this.q.release ? this.releaseName() : undefined;
    const key = `${head}|${JSON.stringify(this.q.pendingSave ?? null)}|${heldBy ?? ""}`;
    if (this.settingsCache && this.settingsCache.key === key && this.now() - this.settingsCache.at < 10_000) return structuredClone(this.settingsCache.v);
    const at = async (path: string) => (await this.git(["cat-file", "-e", `${head}:${path}`], this.root)).code === 0;
    const kit = d.review ? d.def?.merge?.review : undefined;
    const kitFiles = kit ? (await this.git(["ls-tree", "-r", "--name-only", "-z", head, "--", `${kit}/`], this.root)).stdout.split("\0").filter(Boolean).map((f) => f.slice(kit.length + 1)) : [];
    const namesOf = this.names();
    let count = 0;
    if (namesOf.exists) {
      try {
        const raw = JSON.parse((await import("node:fs")).readFileSync(namesOf.file, "utf8")) as { privateNames?: unknown[] };
        count = Array.isArray(raw.privateNames) ? raw.privateNames.length : 0;
      } catch {}
    }
    const picks = readModels(this.store.dir);
    const check = this.deps.modelCheck ?? { defaults: () => ({}), denial: () => null };
    const file = await this.settingsFileState(head);
    const v = buildSettings({
      root: this.root,
      projectId: this.deps.projectIdOf?.(this.root) ?? null,
      head,
      target: this.q.target,
      def: d.def,
      checks: d.checks,
      review: d.review,
      kitFiles,
      kitOnTarget: await at(REVIEW_KIT_DIR),
      projectPlaybook: existsSync(join(this.root, PROJECT_PLAYBOOK, "PLAYBOOK.md")),
      projectPlaybookDiffers: await playbookDiffers(this.git, this.root, head),
      names: { setUp: namesOf.exists, count },
      models: { review: await effectiveModel(picks.review, check), thread: await effectiveModel(picks.thread, check) },
      projectFileDiffers: file.differs,
      ...(file.blocked ? { editBlocked: file.blocked } : {}),
      ...(this.q.pendingSave ? { pendingSave: { ...this.q.pendingSave, ...(heldBy && !this.q.pendingSave.failed ? { release: heldBy } : {}) } } : {}),
      fixed: fixedValues(this.root, { ...(this.deps.retryDelayMs !== undefined ? { retryDelayMs: this.deps.retryDelayMs } : {}) }),
      how: await landHowSetting({ dir: this.store.dir, root: this.root, projectHow: d.def?.merge?.land, ...(this.deps.hosts ? { hosts: this.deps.hosts } : {}) }),
    });
    this.settingsCache = { key, at: this.now(), v };
    return structuredClone(v);
  }

  /** A save or a model pick changed what the settings show. */
  settingsChanged(): void {
    this.settingsCache = null;
    this.viewCache = null;
    this.schedulePublish();
  }

  /** The main checkout's settings file against the target's: differs (an edit not committed, or another branch out), and
   *  why a save can't be made now (its uncommitted edit, or other uncommitted edits in the checkout holding the target). */
  private async settingsFileState(head: string): Promise<{ differs: boolean; blocked?: string }> {
    const shown = await this.git(["show", `${head}:${SETTINGS_FILE}`], this.root);
    let local: string | null = null;
    try {
      local = (await import("node:fs")).readFileSync(join(this.root, SETTINGS_FILE), "utf8");
    } catch {}
    const differs = (shown.code === 0 ? shown.stdout : null) !== local;
    const co = await checkoutOf(this.git, this.root, this.q.target);
    if (!co) return { differs };
    const st = await this.git(statusArgs("--porcelain", "--untracked-files=no", "--", SETTINGS_FILE), co);
    if (st.stdout.trim()) return { differs, blocked: SETTINGS_DIRTY_WORDS };
    const why = await dirtyWhy(this.git, co);
    return why ? { differs, blocked: `${why}: commit or put them away first (nothing is forced)` } : { differs };
  }

  /**
   * Save a settings change (push, review on or off, each check's time limit, rerun and optional) as one commit on the
   * target, after the user's confirm. Never under a branch being checked: while a run (or a dry run, or a
   * landing) holds the target it waits (`pendingSave`, kept in queue.json) and is made at the next quiet point.
   */
  saveSettings(changes: MergeSettingsChange): Promise<MergeSettingsSaveResult> {
    return this.serial(async () => {
      if (isEmptyChange(changes)) throw new MergeFailure("invalid-request", "the change names nothing to save");
      const head = await this.targetHead();
      if (!head) throw new MergeFailure("not-found", `no branch ${this.q.target} in ${this.root}`);
      // Checked now, so a change that can't apply is refused at once, not when it is due.
      await this.settingsText(head, changes);
      const file = await this.settingsFileState(head);
      if (file.blocked) throw new MergeFailure("invalid-request", file.blocked);
      // A project that lands by request or by pushing a branch never moves the target with a save: nothing to wait for.
      const how = effectiveHow((await this.declared()).def?.merge?.land, this.store.dir).effective;
      // While a release holds the queue the target stays on the release commit: a save waits for Publish or Abandon.
      if (this.q.release || (!publishes(how) && (this.current || this.trying || this.landing))) {
        // A second save while one waits joins it (the later value of each setting wins).
        const was = this.q.pendingSave && !this.q.pendingSave.failed ? this.q.pendingSave.changes : {};
        const checks = { ...(was.checks ?? {}) };
        for (const [id, c] of Object.entries(changes.checks ?? {})) checks[id] = { ...(checks[id] ?? {}), ...c };
        const joined: MergeSettingsChange = { ...was, ...changes, ...(Object.keys(checks).length ? { checks } : {}) };
        await this.settingsText(head, joined);
        this.q.pendingSave = { at: this.iso(), changes: joined };
        this.save();
        this.settingsChanged();
        return { state: "waiting" as const, ...(this.q.release ? { release: this.releaseName() } : {}) };
      }
      this.lastSettingsPublish = null;
      const commit = await this.publishSettings(head, changes);
      // A request (or push-branch) project published it as its own branch: the answer says where.
      const pub = this.lastSettingsPublish as QueueSettingsPublish | null;
      if (pub?.state === "requested") return { state: "requested" as const, commit, branch: pub.branch, url: pub.url, number: pub.number };
      if (pub?.state === "pushed") return { state: "pushed" as const, commit, branch: pub.branch };
      return { state: "saved" as const, commit, pushed: false as const };
    });
  }

  /** The release holding the target, as shown, or undefined. */
  heldByRelease(): string | undefined {
    return this.q.release ? this.releaseName() : undefined;
  }

  /** Busy for a commit on the target: a branch or a release holds it, or it moved from outside and waits for the resume. */
  private async targetHeld(): Promise<boolean> {
    if (this.current || this.trying || this.landing || this.q.release) return true;
    const head = await this.targetHead();
    return !!this.q.knownTarget && head !== null && head !== this.q.knownTarget;
  }

  /** After a commit made at a quiet point: it is the queue's own, so it raises no "moved outside the queue". */
  private async ownTargetMove(): Promise<void> {
    const head = await this.targetHead();
    if (!head || head === this.q.knownTarget) return;
    this.q.knownTarget = head;
    this.save();
    this.settingsChanged();
  }

  /**
   * Run `fn`, a commit a settings card makes on `branch`, at a moment nothing holds the target (in the queue's own
   * order, so no run starts under it). False: a branch checks, or the target waits for a resume; nothing ran.
   */
  runWhenQuiet(branch: string, fn: () => Promise<void>): Promise<boolean> {
    return this.serial(async () => {
      if (branch !== this.q.target) {
        await fn();
        return true;
      }
      if (await this.targetHeld()) return false;
      try {
        await fn();
      } finally {
        await this.ownTargetMove();
      }
      return true;
    });
  }

  /** The cards held for this quiet point (§app.merge-queue/master-moved): each settles itself, a failure stays on its card. */
  private async quietCards(): Promise<void> {
    const work = queueQuietWork();
    if (!work || (await this.targetHeld())) return;
    try {
      await work(this.root);
    } catch (err) {
      this.log(`a held settings card failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.ownTargetMove();
  }

  /** Cancel a save waiting for the current branch; false: none waits. */
  cancelPendingSave(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.q.pendingSave) return false;
      delete this.q.pendingSave;
      this.save();
      this.settingsChanged();
      return true;
    });
  }

  /** The settings file's new text at `head` with `changes`; a change that can't apply is refused with why. */
  private async settingsText(head: string, changes: MergeSettingsChange): Promise<string> {
    const shown = await this.git(["show", `${head}:${SETTINGS_FILE}`], this.root);
    const text = shown.code === 0 ? shown.stdout : '{\n  "version": 1\n}\n';
    try {
      return editSettingsText(text, changes, { kitExists: (await this.git(["cat-file", "-e", `${head}:${REVIEW_KIT_DIR}`], this.root)).code === 0 });
    } catch (err) {
      if (err instanceof SettingsEditError) throw new MergeFailure("invalid-request", err.message);
      throw err;
    }
  }

  /**
   * Where a settings save goes: a project that lands locally commits it onto the target (commitSettings). The one seam
   * for how-it-lands strategies (a request project publishes it as a request): until those exist, they refuse.
   */
  private async publishSettings(head: string, changes: MergeSettingsChange): Promise<string> {
    // A project that lands by request (or push) takes its settings save the same way, as its own branch and request
    // (al_3 q7): local main never moves; the change applies once the host merges it.
    const how = effectiveHow((await this.declared()).def?.merge?.land, this.store.dir).effective;
    if (publishes(how)) {
      const message = `Merge queue settings: ${changeWords(changes)}`;
      const plain = `Changes the merge queue's settings in ${SETTINGS_FILE}: ${changeWords(changes)}.`;
      let body = `${plain}\n\nOpened by Sova`;
      if (opensRequest(how)) {
        const d = await this.declared();
        const t = await draftText({ root: this.root, folder: d.def?.merge?.request ?? null, how, input: { branch: "sova/settings", base: this.q.target, chatTitle: message }, drafter: async () => ({ title: message, body: plain }) });
        if (!t.ok) throw new MergeFailure("invalid-request", t.why);
        body = t.text.body;
      }
      const r = await publishSettingsRequest(await this.publishCtx(how), { how, file: SETTINGS_FILE, textAt: (base) => this.settingsText(base, changes), message, body, at: new Date(this.now()), scratch: this.store.dir });
      if (r.state === "refused") throw new MergeFailure("invalid-request", r.why);
      this.log(`settings ${r.state === "requested" ? `opened as request #${r.number} (${r.url})` : `pushed as ${r.branch}`}: ${message}`);
      this.lastSettingsPublish = r;
      this.settingsChanged();
      return r.commit;
    }
    const text = await this.settingsText(head, changes);
    return this.commitSettings(head, text, `Merge queue settings: ${changeWords(changes)}`);
  }

  /** The last settings save published as a request or a pushed branch (q7), for the save's answer. */
  lastSettingsPublish: { state: "requested"; branch: string; url: string; number: number; commit: string } | { state: "pushed"; branch: string; commit: string } | null = null;

  /** One commit on the target holding `text` as the settings file, moved to like a landing; the queue knows it as its own. */
  private async commitSettings(head: string, text: string, message: string): Promise<string> {
    if (this.q.knownTarget && head !== this.q.knownTarget) throw new MergeFailure("busy", `${this.q.target} moved outside the queue (${this.q.knownTarget.slice(0, 7)} → ${head.slice(0, 7)}): resume the queue first`);
    const tmp = join(this.store.dir, `settings-${Date.now()}`);
    mkdirSync(this.store.dir, { recursive: true });
    writeFileSync(`${tmp}.json`, text);
    try {
      const blob = (await this.git(["hash-object", "-w", `${tmp}.json`], this.root)).stdout.trim();
      const env = { ...process.env, GIT_INDEX_FILE: `${tmp}.index` };
      for (const a of [["read-tree", head], ["update-index", "--add", "--cacheinfo", `100644,${blob},${SETTINGS_FILE}`]]) {
        const r = await this.git(a, this.root, { env });
        if (r.code !== 0) throw new MergeFailure("busy", `git ${a[0]} failed: ${r.stderr.trim()}`);
      }
      const tree = (await this.git(["write-tree"], this.root, { env })).stdout.trim();
      const name = (await this.git(["config", "user.name"], this.root)).stdout.trim();
      const email = (await this.git(["config", "user.email"], this.root)).stdout.trim();
      const ident = name && email ? {} : { GIT_AUTHOR_NAME: name || "Sova merge queue", GIT_AUTHOR_EMAIL: email || "merge-queue@sova.invalid", GIT_COMMITTER_NAME: name || "Sova merge queue", GIT_COMMITTER_EMAIL: email || "merge-queue@sova.invalid" };
      const c = await this.git(["commit-tree", tree, "-p", head, "-m", message], this.root, { env: { ...process.env, ...ident } });
      if (c.code !== 0) throw new MergeFailure("busy", `git commit-tree failed: ${c.stderr.trim()}`);
      const commit = c.stdout.trim();
      this.landing = true;
      try {
        const r = await landTip(this.git, this.root, this.q.target, head, commit);
        if (r.kind !== "landed") throw new MergeFailure(r.kind === "dirty" ? "invalid-request" : "busy", r.kind === "dirty" ? `${r.why}: commit or put them away first (nothing is forced)` : `${this.q.target} moved meanwhile: try again`);
      } finally {
        this.landing = false;
      }
      this.q.landed.push(commit);
      this.q.knownTarget = commit;
      this.checksCache = null;
      // Not pushed on its own: it goes out with the next landing; the view says so meanwhile.
      const origin = await this.originFacts();
      if (origin.has) {
        if (!this.q.heads.pushed && origin.tracking) this.q.heads.pushed = origin.tracking;
        if (!this.q.heads.pushWhy) this.q.heads.pushWhy = PUSH_WAITS_NEXT_LANDING;
      }
      this.log(`settings saved as ${commit.slice(0, 7)}: ${message}`);
      this.save();
      this.settingsChanged();
      this.kickSoon();
      return commit;
    } finally {
      rmSync(`${tmp}.json`, { force: true });
      rmSync(`${tmp}.index`, { force: true });
    }
  }

  /** The waiting save, at a quiet point (nothing checking, landing or trying). One that fails is kept with why, not retried. */
  private async applyPendingSave(): Promise<void> {
    const p = this.q.pendingSave;
    if (!p || p.failed || this.current || this.trying || this.landing || this.q.release) return;
    const head = await this.targetHead();
    if (!head) return;
    // A target moved from outside waits for the resume, like the line.
    if (this.q.knownTarget && head !== this.q.knownTarget) return;
    try {
      const file = await this.settingsFileState(head);
      if (file.blocked) throw new MergeFailure("invalid-request", file.blocked);
      await this.publishSettings(head, p.changes);
      delete this.q.pendingSave;
      this.save();
      this.settingsChanged();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log(`the waiting settings save failed: ${why}`);
      this.q.pendingSave = { ...p, failed: why };
      this.save();
      this.settingsChanged();
    }
  }

  private settledCache: { at: number; head: string; facts: Map<string, "merged" | "gone"> } | null = null;
  /** Sent-back entries git says need no fix any more (settled.ts), re-read at most every 15 s or when the target moves. */
  private async settledFacts(head: string): Promise<Map<string, "merged" | "gone">> {
    if (this.settledCache && this.settledCache.head === head && this.now() - this.settledCache.at < 15_000) return this.settledCache.facts;
    const facts = await settledFacts(this.git, this.root, head, this.q.entries);
    this.settledCache = { at: this.now(), head, facts };
    return facts;
  }

  private readyCache: { at: number; head: string; list: MergeReady[] } | null = null;
  /** The next view reads the Ready list afresh: a branch went outside the queue (Discard Branch…). */
  forgetReady(): void {
    this.readyCache = null;
  }
  /** Ready, not approved (the view's Land list), re-read at most every 15 s or when the target moves. */
  private async readyList(head: string, redrafted: ReadonlySet<string> = new Set()): Promise<MergeReady[]> {
    if (this.readyCache && this.readyCache.head === head && this.now() - this.readyCache.at < 15_000) return this.filterReady(this.readyCache.list, redrafted);
    const out: MergeReady[] = [];
    const trees = await worktreesOf(this.git, this.root);
    const made = await this.queueMadeNow();
    // The answers are kept per head and target, so only a move of the target reads any again: a few at a time, since
    // the heads with work each run a trial merge.
    const asked = trees.filter((w) => w.branch && w.head && w.path !== this.root && existsSync(w.path));
    for (let i = 0; i < asked.length; i += 4) await Promise.all(asked.slice(i, i + 4).map((w) => this.leftOf(w.branch!, w.head!, w.path, head)));
    for (const w of trees) {
      if (!w.branch || !w.head || w.path === this.root || w.branch === this.q.target || w.branch === "master" || w.branch === "main" || !existsSync(w.path)) continue;
      if (w.branch.startsWith("sova/")) continue;
      // The queue's own scratch copies are never work to land, whatever branch one is on.
      if (await this.queueOwned(w.path, made)) continue;
      // The one answer (§chat.worktrees/nothing-left): nothing left is on no list, drafts alone keep the row, and a branch
      // git can't read stays listed.
      const left = await this.leftOf(w.branch, w.head, w.path, head);
      if (left?.nothingLeft) continue;
      const draftsOnly = left && !left.code.left ? left.drafts.length : 0;
      const ahead = await countBetween(this.git, this.root, head, w.head);
      // Its subject and when it last changed (the head's committer date), in one read.
      const [subjectRaw = "", headAtRaw = ""] = (await this.git(["log", "-1", "--format=%s%x1f%cI", w.head], this.root)).stdout.trim().split("\u001f");
      const subject = subjectRaw.trim();
      const headAt = headAtRaw.trim();
      if (!draftsOnly && /^temp\b/i.test(subject)) continue;
      const st = await this.git(statusArgs("--porcelain"), w.path);
      if (st.code !== 0 || st.stdout.trim()) continue;
      const owner = ownerId(await this.deps.ownerOf?.(this.root, w.branch, w.path).catch(() => null));
      const short = await this.git(["diff", "--shortstat", `${head}...${w.head}`], this.root);
      const lines = short.code === 0 ? { added: Number(/(\d+) insertion/.exec(short.stdout)?.[1] ?? 0), removed: Number(/(\d+) deletion/.exec(short.stdout)?.[1] ?? 0) } : {};
      out.push({ branch: w.branch, worktree: w.path, commit: w.head, ahead, ...lines, ...(draftsOnly ? { draftsOnly } : {}), ...(left ? { left: { whole: left.whole, code: left.codeOnly } } : { left: { whole: "unknown", code: "unknown" } }), ...(headAt ? { headAt } : {}), ...(owner ? { session: owner.session, ...(owner.archived ? { sessionArchived: true as const } : {}) } : {}) });
    }
    this.readyCache = { at: this.now(), head, list: out };
    return this.filterReady(out, redrafted);
  }

  /** The shared answer for a commit of this project's (§chat.worktrees/nothing-left), from every entry and git; null: it
   *  couldn't be read at all, which is never nothing. */
  private leftOf(branch: string, head: string, folder: string | undefined, targetHead: string): Promise<BranchLeft | null> {
    const git: GitRunner = async (args, o) => {
      const r = await this.git([...args], o.cwd, o.env ? { env: { ...process.env, ...o.env } } : undefined);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    };
    return branchLeft({ root: this.root, folder, branch, head, target: { name: this.q.target, oid: targetHead }, git }).catch(() => null);
  }

  /** What the shared answer reads of this queue: all its entries, never the view's newest 20. */
  private landingsOf(branch: string): LandingRecords {
    // Still loading: the reading is registered before the records are read.
    if (!this.q) return NO_LANDINGS;
    const here = this.q.entries.filter((e) => e.branch === branch && e.state === "landed").sort((a, b) => (b.landed?.at ?? b.updatedAt).localeCompare(a.landed?.at ?? a.updatedAt)).map((e) => e.commit);
    return { pins: [...new Set([...here, ...(this.q.hostPins?.[branch] ?? [])])], landed: this.q.landed };
  }

  /** The Ready to land, not approved rows as the view lists them, read from git only: no view is built, nothing is
   *  published, no summary is asked for (the summaries' sweep, summary-sweep.ts). */
  async readyRows(): Promise<MergeReady[]> {
    const head = (await this.declared()).head || (await this.targetHead()) || "";
    if (!head) return [];
    return this.readyList(head, await this.redraftedFacts());
  }
  /** A branch sent back (needs-fix) is Ready again at a newer commit, or at the same commit once it was sent back for
   *  its drafts and they are fixed (`redrafted`: changed since the approval, and Sova's docs check reads clean). */
  filterReady(list: MergeReady[], redrafted: ReadonlySet<string> = new Set()): MergeReady[] {
    return list.filter((r) => !this.q.entries.some((e) => e.branch === r.branch && (ENTRY_OPEN.includes(e.state) || (((e.state === "landed" && !r.draftsOnly) || (e.state === "needs-fix" && !redrafted.has(e.id))) && e.commit === r.commit))));
  }

  /** Why a sent-back entry was sent back: as stored, else inferred once from its last run (a failed docs step: its
   *  drafts), else unknown (read as not the drafts'). */
  private causeMemo = new Map<string, SentBackFor | null>();
  causeOf(e: Pick<Entry, "id" | "state" | "sentBackFor" | "run">): SentBackFor | undefined {
    if (e.state !== "needs-fix") return undefined;
    if (e.sentBackFor) return e.sentBackFor;
    if (!this.causeMemo.has(e.id)) {
      let run: MergeRun | null = null;
      try {
        run = e.run ? this.store.readRun(e.run) : null;
      } catch {
        run = null;
      }
      this.causeMemo.set(e.id, run?.verdict === "failed" && run.steps.some((st) => st.kind === "docs" && st.result === "failed") ? "drafts" : null);
    }
    return this.causeMemo.get(e.id) ?? undefined;
  }

  /** The last redrafted set the view read: a change publishes the view (a drafts edit makes no save). */
  private redraftedKey = "";
  /**
   * Sent-back entries that may land again at the same commit: sent back for their drafts, the branch still at that
   * commit with its worktree there, its drafts changed since the approval pinned them, and Sova's docs check of them
   * finding no problem (none left counts as clean). A check still running counts as not yet; its end publishes.
   */
  async redraftedFacts(): Promise<Set<string>> {
    const out = new Set<string>();
    if (this.deps.draftsHash) {
      for (const e of this.q.entries) {
        if (e.state !== "needs-fix" || this.causeOf(e) !== "drafts" || superseded(this.q.entries, e)) continue;
        if (!e.approval.drafts || e.approval.withoutSpecs || !e.worktree || !existsSync(e.worktree)) continue;
        if ((await revParse(this.git, this.root, `refs/heads/${e.branch}`)) !== e.commit) continue;
        let now: { hash: string; names: string[] } | undefined;
        try {
          now = await this.branchDrafts(e.worktree, e.commit);
        } catch {
          continue;
        }
        // Changed since the hand-back (the whole folder, notes included); an entry from before that was kept: since the
        // approval pinned its drafts.
        const print = this.deps.draftsFingerprint?.(e.worktree);
        if (e.sentBackDrafts !== undefined && print !== undefined ? print === e.sentBackDrafts : now?.hash === e.approval.drafts.hash) continue;
        if (now && this.deps.docsCheck) {
          const r = this.deps.docsCheck(e.worktree, e.commit, print ?? this.deps.draftsHash(e.worktree)?.hash ?? "", () => this.docsChecked());
          if (r === "pending" || r.problems.length) continue;
        }
        out.add(e.id);
      }
    }
    const key = [...out].sort().join(",");
    if (key !== this.redraftedKey) {
      this.redraftedKey = key;
      this.viewCache = null;
      this.schedulePublish();
    }
    return out;
  }
  /** A docs check ended: the view is read again, and published when what it found moves an entry. */
  private docsChecked(): void {
    this.viewCache = null;
    void this.redraftedFacts().catch((err) => this.log(`docs check: ${err instanceof Error ? err.message : err}`));
  }

  private newestMemo = new Map<string, { at: number; why: Promise<string | null> }>();
  /** Why the branch's newest commit `tip` isn't Ready to land (the chat's readiness reading, deps.newestReading), or
   *  null when it is. No reading: what Land would refuse (a temporary commit, uncommitted files in its folder). Read
   *  only; each answer is kept a few seconds, since view() runs often. */
  private async newestBlocked(branch: string, tip: string): Promise<string | null> {
    const key = `${branch}\0${tip}`;
    const hit = this.newestMemo.get(key);
    if (hit && this.now() - hit.at < NEWEST_MEMO_MS) return hit.why;
    // Kept from the start, so two views reading at once ask once.
    const why = this.newestBlockedNow(branch, tip);
    if (this.newestMemo.size > 100) this.newestMemo.clear();
    this.newestMemo.set(key, { at: this.now(), why });
    why.catch(() => this.newestMemo.delete(key));
    return why;
  }

  private async newestBlockedNow(branch: string, tip: string): Promise<string | null> {
    const wt = (await worktreesOf(this.git, this.root)).find((w) => w.branch === branch && w.path !== this.root)?.path;
    const reading = wt ? await this.deps.newestReading?.(wt, tip).catch(() => undefined) : undefined;
    if (reading !== undefined) return reading;
    const subject = (await this.git(["log", "-1", "--format=%s", tip], this.root)).stdout.trim();
    if (/^temp\b/i.test(subject)) return `its newest commit is a temporary commit ("${subject.slice(0, 60)}")`;
    if (wt && existsSync(wt)) {
      const st = await this.git(statusArgs("--porcelain"), wt);
      const n = st.code === 0 ? st.stdout.split("\n").filter(Boolean).length : 0;
      if (n) return `${n} uncommitted file${n === 1 ? "" : "s"} in its folder: commit or remove them first`;
    }
    return null;
  }

  private estimateCache: { at: number; ms: number | null } | null = null;
  /** The median of recent passed runs (estimate.ts), re-read at most once a minute. */
  private estimateFromHistory(): number | null {
    if (this.estimateCache && this.now() - this.estimateCache.at < 60_000) return this.estimateCache.ms;
    const runs = this.store
      .runIds()
      .slice(-40)
      .map((id) => this.store.readRun(id))
      .filter((r): r is MergeRun => !!r);
    const ms = estimateFromRuns(runs);
    this.estimateCache = { at: this.now(), ms };
    return ms;
  }

  // ---- the verbs --------------------------------------------------------------------------------

  /** merge.add: approve a branch at a commit (the Land button, or a typed "land it" ingested). */
  add(req: AddRequest): Promise<{ entry: MergeEntry; changed: boolean }> {
    return this.serial(() => this.addNow(req));
  }

  private async addNow(req: AddRequest): Promise<{ entry: MergeEntry; changed: boolean }> {
    {
      let branch = req.branch?.replace(/^refs\/heads\//, "");
      // A queue copy named by its folder is refused, but after "nothing to land" below (it says nothing about the project).
      const scratch = req.checkout && (await this.queueOwned(req.checkout)) ? req.checkout : null;
      if (!branch && req.checkout) {
        const r = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], req.checkout);
        if (r.code !== 0 || !r.stdout.trim()) throw new MergeFailure("invalid-request", scratch ? scratchRefusal(scratch) : `${req.checkout} isn't on a branch`);
        branch = r.stdout.trim();
      }
      if (!branch) throw new MergeFailure("invalid-request", "name the branch (or a checkout of it)");
      const target = this.q.target;
      if (branch === target || branch === "master" || branch === "main") throw new MergeFailure("invalid-request", `${branch} is the branch others land into: there is nothing to land`);
      const tip = await revParse(this.git, this.root, `refs/heads/${branch}`);
      if (!tip) throw new MergeFailure("not-found", `no branch ${branch} in ${this.root}`);
      const commit = req.commit ? await revParse(this.git, this.root, req.commit) : tip;
      if (!commit) throw new MergeFailure("not-found", `no commit ${req.commit} in ${this.root}`);
      if (commit !== tip && !(await isAncestor(this.git, this.root, commit, tip))) throw new MergeFailure("invalid-request", `${commit.slice(0, 7)} isn't on ${branch}`);
      const d = await this.declared();
      // A branch whose own commit has a valid definition is the fix: it is taken, and checked by its own declaration.
      const fix = d.invalid ? await this.fixesDefinition(commit) : null;
      if (d.invalid && !fix) throw new MergeFailure("invalid-request", invalidWords(d.invalid));
      if (!fix && d.checks === "unset") throw new MergeFailure("unsupported", `Not set up: ${this.root} declares no checks for the merge queue yet (its merge section, a test command, or "no automated tests")`);
      const head = d.head || (await this.targetHead());
      if (!head) throw new MergeFailure("not-found", `no branch ${target} in ${this.root}`);
      const wt = (await worktreesOf(this.git, this.root)).find((w) => w.branch === branch && w.path !== this.root)?.path;
      // First of all (§app.merge-queue/approve): nothing is recorded, nothing runs, no trial is ever asked for. Unknown isn't nothing.
      const left = await this.leftOf(branch, commit, wt, head);
      if (left && (left.nothingLeft || (left.codeOnly === "nothing" && req.withoutSpecs))) throw new MergeFailure("invalid-request", nothingToLandWords(target));
      if (scratch) throw new MergeFailure("invalid-request", scratchRefusal(scratch));
      const subject = (await this.git(["log", "-1", "--format=%s", commit], this.root)).stdout.trim();
      if (/^temp\b/i.test(subject)) throw new MergeFailure("invalid-request", `${branch}'s head is a TEMP commit ("${subject.slice(0, 60)}"): it isn't finished`);
      // Before the trial gate: a queue copy is never landed, so "run a trial" would be the wrong thing to tell anyone.
      if (wt && (await this.queueOwned(wt))) throw new MergeFailure("invalid-request", scratchRefusal(branch));
      // A setup branch is checked by the target's checks, not its own: it lands only once a trial of this exact commit passed.
      const untried = await this.setupUntried(head, commit);
      if (untried) throw new MergeFailure("invalid-request", untried);
      if (wt && commit === tip) {
        const st = await this.git(statusArgs("--porcelain"), wt);
        const n = st.stdout.split("\n").filter(Boolean).length;
        if (st.code === 0 && n) throw new MergeFailure("invalid-request", `${branch} has ${n} uncommitted file${n === 1 ? "" : "s"} in ${wt}: Land is for a commit; commit or remove them first`);
      }
      const drafts = !req.withoutSpecs && wt ? await this.branchDrafts(wt, commit) : undefined;
      // No chat named: the branch's owner, by the one rule the Ready rows show (owners.ts), an archived one included;
      // none, no card.
      if (!req.session) {
        const owner = ownerId(await this.deps.ownerOf?.(this.root, branch, wt).catch(() => null))?.session;
        if (owner) req = { ...req, session: owner };
      }
      const approval: MergeApproval = {
        by: req.by,
        at: req.at ?? this.iso(),
        commit,
        ...(req.chat ? { chat: req.chat } : {}),
        ...(drafts ? { drafts: { hash: drafts.hash, names: drafts.names } } : {}),
        ...(req.withoutSpecs ? { withoutSpecs: true as const } : {}),
        ...(req.withoutReview ? { withoutReview: true as const } : {}),
        // The user's one Land stands until the branch lands, they remove it, or it waits for their decision (al_3).
        ...(req.by !== "release" ? { standing: true as const, userCommit: commit } : {}),
      };
      // How it lands, pinned now (a later settings edit never redirects it); local is recorded as nothing, as before.
      const how = effectiveHow(d.def?.merge?.land, this.store.dir).effective;
      if (how !== "local") approval.how = how;
      if (req.via) approval.via = req.via;
      // A request is checked against origin's host when it is approved, never only after the run (a11): a typed "open
      // a PR / an MR" opens the request on origin's own host (a PR on GitHub, an MR on GitLab), and a project, or a
      // typed word, that can't open one there, or a computer not signed in to it, is refused now.
      if (opensRequest(approvalHow(approval))) {
        const host = await this.hosting();
        if (!host) throw new MergeFailure("invalid-request", (await this.git(["remote", "get-url", "origin"], this.root)).code === 0 ? NO_HOST_WORDS : NO_ORIGIN_WORDS);
        if (approval.via) approval.via = host.repo.kind === "github" ? "github-pr" : "gitlab-mr";
        const mismatch = hostMismatch(approvalHow(approval) as RequestHow, host);
        if (mismatch) throw new MergeFailure("invalid-request", mismatch);
        const a = await host.adapter.auth(host.repo);
        if (!a.ok) throw new MergeFailure("invalid-request", a.why);
      }
      // Land Again on a branch whose request is published or waiting to be (al_3 b1): the same entry goes back in line,
      // its request kept, so the new work is added on top of what origin has.
      const onHost = this.q.entries.find((e) => e.branch === branch && (e.state === "requested" || e.state === "request-review" || e.state === "closed") && e.request);
      if (onHost && !this.q.entries.some((e) => e.branch === branch && ENTRY_OPEN.includes(e.state))) {
        onHost.commit = commit;
        onHost.approval = approval;
        if (req.session) onHost.session = req.session;
        if (wt) onHost.worktree = wt;
        onHost.state = "queued";
        onHost.seq = ++this.q.seq;
        delete onHost.reason;
        delete onHost.newerCommits;
        onHost.updatedAt = this.iso();
        if (!this.current && !this.q.entries.some((x) => x.state === "queued" || x.state === "checking")) this.q.knownTarget = head;
        this.save();
        this.wake("queued", onHost);
        this.deps.notify?.("approved", this.withPosition(onHost), { root: this.root, press: onHost.approval.at });
        this.kickSoon();
        return { entry: this.withPosition(onHost), changed: true };
      }
      const open = this.q.entries.find((e) => e.branch === branch && ENTRY_OPEN.includes(e.state));
      if (open) {
        const same = open.commit === commit && !!open.approval.withoutReview === !!req.withoutReview && !!open.approval.withoutSpecs === !!req.withoutSpecs && open.approval.drafts?.hash === approval.drafts?.hash && open.approval.how === approval.how && open.approval.via === approval.via;
        if (same && (open.state === "queued" || open.state === "checking")) return { entry: this.withPosition(open), changed: false };
        if (open.state === "queued") {
          open.commit = commit;
          open.approval = approval;
          if (req.session) open.session = req.session;
          if (wt) open.worktree = wt;
          open.updatedAt = this.iso();
          delete open.reason;
          this.save();
          this.wake("queued", open);
          this.deps.notify?.("approved", this.withPosition(open), { root: this.root, press: open.approval.at });
          return { entry: this.withPosition(open), changed: true };
        }
        if (open.state === "checking" && this.current?.entry === open.id) {
          // A new approval while its run is checking: that run is voided and the new commit goes first.
          this.current.voidWhy = "superseded";
          this.current.ac.abort();
        }
        open.state = "cancelled";
        open.reason = "approved again";
        open.updatedAt = this.iso();
      }
      // Nothing in line and nothing running: a move of the target from outside since is simply taken (there is no run
      // to void); from here on, a move is flagged.
      if (!this.current && !this.q.entries.some((x) => x.state === "queued" || x.state === "checking")) this.q.knownTarget = head;
      const e: Entry = {
        id: newId("mq"),
        project: this.id,
        target,
        branch,
        ...(wt ? { worktree: wt } : {}),
        ...(req.session ? { session: req.session } : {}),
        commit,
        approval,
        state: "queued",
        runs: [],
        picks: [],
        notes: [],
        createdAt: this.iso(),
        updatedAt: this.iso(),
        seq: ++this.q.seq,
      };
      // Land on a finished branch blocked only for what its chat can fix (conflicts, its failing check, drafts that
      // don't fit): Approved · waiting for a fix. It joins the line by itself once nothing blocks it (al_3 q7).
      const blocked = approval.standing && wt ? await this.fixBlocked(e, commit, approval.drafts) : null;
      // Already conflicting at the Land: it goes in line for the merge thread to judge, and sending it back for that
      // conflict counts no try (it is the wait Land on a blocked branch is, not a failed try).
      if (approval.standing && (await this.git(["merge-tree", "--write-tree", "--name-only", "--no-messages", head, commit], this.root)).code === 1) e.approval.conflictAtLand = true;
      if (blocked) {
        e.state = "with-chat";
        e.approval.blocked = true;
        e.standing = { phase: "waiting-fix", why: blocked };
        e.reason = blocked;
      }
      this.q.entries.push(e);
      // Approved again while checking: the newer commit goes first.
      if (open && this.current?.entry === open.id && !blocked) this.toFront(e);
      this.save();
      if (blocked) {
        this.deps.notify?.("approved", this.withPosition(e), { root: this.root, press: e.approval.at });
        this.tellBlocked(e, blocked);
        this.armFixTimer();
        return { entry: this.withPosition(e), changed: true };
      }
      this.wake("queued", e);
      this.deps.notify?.("approved", this.withPosition(e), { root: this.root, press: e.approval.at });
      this.kickSoon();
      return { entry: this.withPosition(e), changed: true };
    }
  }

  /** A copy of the entry with its place in line (queued). */
  withPosition(e: Entry): MergeEntry {
    const i = this.queued().findIndex((x) => x.id === e.id);
    const { seq: _seq, ...rest } = e;
    return { ...structuredClone(rest), ...(i >= 0 ? { position: i + 1 } : {}) };
  }

  private minQueuedSeq(): number {
    return Math.min(Infinity, ...this.queued().map((e) => e.seq));
  }
  /** Put an entry first in line. */
  private toFront(e: Entry): void {
    const min = this.minQueuedSeq();
    e.seq = Number.isFinite(min) ? Math.min(e.seq, min - 1) : e.seq;
    e.state = "queued";
    e.updatedAt = this.iso();
  }

  cancel(entryId: string, note?: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      // Remove from Queue: a sent-back entry leaves the queue; nothing of the branch's is deleted (its folder, commits,
      // drafts and run logs stay), and its chat's card gets a Removed revision.
      // Under the user's standing Land, an entry out of line (with its chat, waiting for their decision) is Removed too.
      // Remove from Queue is one act at every stage of a standing Land, in line and checking too (a release's isn't).
      const removable = e.state === "needs-fix" || e.state === "with-chat" || (!!e.approval.standing && !e.release && (REMOVABLE.includes(e.state) || e.state === "queued" || e.state === "checking"));
      if (removable) {
        const inLine = e.state === "queued" || e.state === "checking";
        if (inLine) this.idleOwed = e.id;
        if (this.current?.entry === e.id) {
          this.current.voidWhy = "cancelled";
          this.current.ac.abort();
        }
        this.clearConflictTimer(e.id);
        this.clearRulingTimer(e.id);
        this.answerDecision(e, "remove");
        // The standing approval ends with it: a fix arriving later revives nothing (al_3).
        delete e.standing;
        delete e.fix;
        delete e.pausedFrom;
        e.state = "cancelled";
        e.reason = "removed by you";
        this.reviewEvent(e, { kind: "removed" });
        e.updatedAt = this.iso();
        if (note !== undefined) this.setNote(e, note, "thread");
        this.save();
        this.deps.notify?.("removed", e, { root: this.root });
        this.releaseEvent(e, "cancelled");
        if (inLine) this.kickSoon();
        return e;
      }
      if (isFinal(e)) throw new MergeFailure("invalid-request", `${e.branch} is ${e.state === "landed" ? "landed" : e.state === "cancelled" ? "already cancelled" : "handed back already"}`);
      this.idleOwed = e.id;
      if (this.current?.entry === e.id) {
        this.current.voidWhy = "cancelled";
        this.current.ac.abort();
      }
      this.clearConflictTimer(e.id);
      e.state = "cancelled";
      e.reason = "cancelled";
      e.updatedAt = this.iso();
      if (note !== undefined) this.setNote(e, note, "thread");
      this.save();
      this.releaseEvent(e, "cancelled");
      this.kickSoon();
      return e;
    });
  }

  pause(why: string | undefined, kind: PauseKind = "operator"): Promise<void> {
    return this.serial(async () => this.pauseNow(kind, why?.trim() || "paused by you"));
  }

  private pauseNow(kind: PauseKind, why: string, run?: string): void {
    this.q.paused = { kind, why, at: this.iso(), ...(run ? { run } : {}) };
    this.save();
    this.log(`paused (${kind}): ${why}`);
  }

  /** merge.resume / merge.retry: lift the pause. A move of the target from outside is accepted from here on. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const p = this.q.paused;
      if (!p) return;
      delete this.q.paused;
      this.q.knownTarget = (await this.targetHead()) ?? this.q.knownTarget;
      this.q.machineTries = {};
      this.holdUntil = 0;
      this.save();
      // A tested run held back (a dirty main folder) lands now if the target is still where it was.
      if (p.kind === "main-checkout-dirty" && p.run) {
        const e = this.q.entries.find((x) => x.run === p.run && x.state === "checking");
        const run = this.store.readRun(p.run);
        if (e && run) await this.landTested(e, run);
      }
      await this.pushHeld();
      this.kickSoon();
    });
  }

  note(entryId: string, text: string, by: "thread" | "operator"): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      this.setNote(e, text, by);
      e.updatedAt = this.iso();
      this.save();
      // The thread's explanation of a failure handed back reaches the branch's chat too.
      if (by === "thread" && e.state === "needs-fix" && text.trim()) this.deps.notify?.("explained", e, { root: this.root });
      return e;
    });
  }

  private setNote(e: Entry, text: string, by: "thread" | "operator"): void {
    const t = text.trim();
    if (t.length > NOTE_MAX) throw new MergeFailure("invalid-request", `a note is at most ${NOTE_MAX} characters (this one is ${t.length})`);
    // One note per entry from the thread or the operator: the latest wins; an empty one clears it. The operator's
    // stands over the thread's.
    const hasOperator = e.notes.some((n) => n.kind === "operator");
    if (by === "thread" && hasOperator) return;
    e.notes = e.notes.filter((n) => n.kind !== "thread" && n.kind !== "operator");
    if (t) e.notes.unshift({ kind: by, text: t, at: this.iso() });
  }

  extend(entryId: string, checks: string[], why: string, select?: string[], note?: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (isFinal(e)) throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: nothing to extend`);
      if (!checks.length) throw new MergeFailure("invalid-request", "name the checks to add");
      if (!why.trim()) throw new MergeFailure("invalid-request", "say why (one line, shown beside the check)");
      const d = await this.declared();
      const declared = Array.isArray(d.def?.merge?.checks) ? d.def!.merge!.checks : [];
      const extra = (d.def?.merge as { optional?: { id: string; label: string }[] } | undefined)?.optional ?? [];
      for (const id of checks) {
        const c = declared.find((x) => x.id === id) ?? extra.find((x) => x.id === id) ?? (id === "test" && d.def?.test ? { id: "test", label: "Tests" } : null);
        if (!c) throw new MergeFailure("invalid-request", `no check "${id}" in the project's merge section`);
        e.picks = e.picks.filter((p) => !(p.id === id && JSON.stringify(p.select ?? []) === JSON.stringify(select ?? [])));
        e.picks.push({ id, label: c.label, source: "picked", why: why.trim().slice(0, 200), ...(select?.length ? { select } : {}) });
      }
      if (note !== undefined) this.setNote(e, note, "thread");
      e.updatedAt = this.iso();
      this.save();
      return e;
    });
  }

  /**
   * merge.resolve: the merge thread's judgement of a conflict, one of three: no behaviour change (the thread's merged
   * file contents, which Sova commits in the entry's scratch copy, land through the full checks), the chat fixes it
   * (sent back with the conflict as it is now and the thread's diagnosis), or it needs the user (a decision with the
   * thread's question and choices; "behaviour-differs" is the old word for it). Only "no-behaviour-change" carries
   * contents. A decision a chat raised can't be overruled.
   */
  resolve(entryId: string, j: { verdict: string; files?: string[]; ours: string; theirs: string; proposal: string; commit?: string; contents?: Record<string, string>; note?: string; text?: string; choices?: string[] }): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (e.state !== "conflict" && e.state !== "behaviour-differs") throw new MergeFailure("invalid-request", `${e.branch} has no conflict to resolve (it is ${e.state})`);
      const asked = resolveVerdict(j.verdict);
      if (!asked) throw new MergeFailure("invalid-request", 'verdict is "no-behaviour-change", "chat-fixes" or "needs-user"');
      this.mustNotOverrule(e, "resolve");
      for (const k of ["ours", "theirs", "proposal"] as const) if (!j[k]?.trim()) throw new MergeFailure("invalid-request", `say ${k === "ours" ? "what the target's side does" : k === "theirs" ? "what the branch's side does" : asked === "chat-fixes" ? "your diagnosis: what the chat should change" : "what the resolution does"}, in plain words`);
      const head = (await this.targetHead()) ?? "";
      const files = j.files?.length ? j.files : (e.conflictFiles ?? e.conflict?.files ?? []);
      let verdict = asked;
      let sanity: { ok: boolean; why?: string } | undefined;
      let commit: string | undefined;
      if (j.contents && j.commit) throw new MergeFailure("invalid-request", "give the merged contents or a commit, not both");
      if (j.contents && asked !== "no-behaviour-change") throw new MergeFailure("invalid-request", 'only verdict "no-behaviour-change" carries contents: "chat-fixes" and "needs-user" carry none');
      if (j.contents) {
        // The thread's merged files, committed by Sova in the entry's scratch copy (no branch moves).
        const contents = j.contents;
        const made = await this.scratchStep(() =>
          commitResolution(this.git, { copy: scratchCopyPath(this.root, e.id), entry: e.id, base: head, commit: e.commit, target: this.q.target, branch: e.branch, contents }),
        ).catch((err: unknown) => {
          throw new MergeFailure("invalid-request", err instanceof Error ? err.message : String(err));
        });
        j = { ...j, commit: made };
      }
      if (j.commit && asked !== "chat-fixes") {
        commit = (await revParse(this.git, this.root, j.commit)) ?? undefined;
        if (!commit) throw new MergeFailure("not-found", `no commit ${j.commit} in ${this.root}`);
        // The probe's content merge runs git's merge drivers in its working directory, and git leaves their
        // .merge_file_* temp files behind when it is cut off: so it runs in the entry's scratch copy (made now
        // if it is gone), a work tree with the project's files that isn't the main checkout, never in this.root.
        const probe = await this.probeDir(e, head);
        const s = await (this.deps.sanity ?? sanityCheck)(probe, { base: head, commit: e.commit, resolution: commit });
        sanity = { ok: s.ok, ...(s.why ? { why: s.why } : {}) };
        if (!s.ok) verdict = "needs-user";
      } else if (verdict === "no-behaviour-change") throw new MergeFailure("invalid-request", "a resolution judged to change no behaviour gives its contents: each conflicted file's whole merged text by its path");
      this.clearConflictTimer(e.id);
      // The resolution stays reachable under a hidden ref until the run uses it (or the attempt ends).
      if (commit) {
        this.scratchIds.add(e.id);
        await this.scratchStep(() => pinResolution(this.git, this.root, e.id, commit!)).catch((err) => this.log(`pinning the resolution of ${e.id} failed: ${err instanceof Error ? err.message : err}`));
      }
      const stored = verdict === "needs-user" ? "behaviour-differs" : verdict;
      e.conflict = { files, verdict: stored, ours: j.ours.trim(), theirs: j.theirs.trim(), proposal: j.proposal.trim(), ...(commit ? { commit } : {}), ...(sanity ? { sanity } : {}), at: this.iso() };
      if (j.note !== undefined) this.setNote(e, j.note, "thread");
      if (e.ruling?.resolutionFailed) delete e.ruling.resolutionFailed;
      // The thread judged it: no longer waiting for the thread.
      if (e.fix?.request === CONFLICT_WAIT) delete e.fix;
      if (verdict === "no-behaviour-change") {
        // Resolved by the thread: the conflict there at the Land never went back to the chat; a later one counts.
        delete e.approval.conflictAtLand;
        e.notes = e.notes.filter((n) => n.kind !== "resolved");
        e.notes.push({ kind: "resolved", text: `Resolved a conflict in ${files.join(", ") || "the branch"}: ${j.proposal.trim()}`.slice(0, NOTE_MAX), at: this.iso() });
        delete e.reason;
        // A waiting-for-a-fix mark from the Land, if any, goes: it joins the line by itself.
        delete e.approval.blocked;
        delete e.standing;
        this.toFront(e);
        this.kickSoon();
      } else if (verdict === "chat-fixes") {
        // The chat merges the newest target itself: no resolution of the thread's is kept for it.
        delete e.conflict.commit;
        const diagnosis = [j.proposal.trim(), j.text?.trim()].filter(Boolean).join("\n");
        this.sendBack(e, { cause: "conflict", why: this.conflictWhy(files), files, diagnosis, ...(e.run ? { runId: e.run } : {}) });
      } else {
        const why = sanity && !sanity.ok ? `the resolution needs your look: ${sanity.why}` : "the two sides want different behaviour";
        this.raiseDecision(
          e,
          {
            kind: "behaviour-differs",
            question: clip(j.text) || `${e.branch} and ${e.target} want different behaviour in ${files.join(", ") || "the same code"}: which should it do?`,
            choices: cleanChoices(j.choices),
            // The thread judged it safe and Sova's mechanical check didn't: the thread may still bring a resolution that passes.
            raisedBy: asked === "no-behaviour-change" ? "queue" : "merge-thread",
            actions: commit ? ["accept"] : [],
            sides: { ours: j.ours.trim(), theirs: j.theirs.trim(), proposal: j.proposal.trim() },
            heldNote: {
              request: newId("rq"),
              text: `The user decides how ${e.branch}'s conflict with ${e.target} in ${files.join(", ") || "its files"} is resolved; their answer comes with this note.\n${e.target}'s side: ${j.ours.trim()}\nThis branch's side: ${j.theirs.trim()}\nThe merge thread proposed: ${j.proposal.trim()}\nMerge ${e.target} into ${e.branch}, resolve it the way the user says, and commit; then answer this request Fixed.`,
            },
          },
          "behaviour-differs",
          why,
        );
      }
      e.updatedAt = this.iso();
      this.save();
      return e;
    });
  }

  /**
   * merge.rule: the merge thread's ruling on anything but a conflict's resolution (rulings.ts RULINGS). A decision
   * waiting for the user (raised by the thread or the chat) is never overruled: only "needs-user" is taken then.
   * `checked` / `beyond` rule on a chat's fix (the standing approval's, by its request).
   */
  async rule(entryId: string, r: { ruling: string; text?: string; choices?: string[]; request?: string; note?: string }): Promise<MergeEntry> {
    if (!isRuling(r.ruling)) throw new MergeFailure("invalid-request", 'ruling is "chat-fixes", "try-again", "needs-user", "checked" or "beyond"');
    const ruling: Ruling = r.ruling;
    if (ruling === "checked" || ruling === "beyond") {
      if (!r.request) throw new MergeFailure("invalid-request", "name the fix's request (rq_…) the ruling checks");
      if (ruling === "beyond" && !r.text?.trim()) throw new MergeFailure("invalid-request", "say what more the fix changes than was asked (text)");
      this.mustNotOverrule(this.mustEntry(entryId), "rule");
      if (r.note !== undefined) await this.note(entryId, r.note, "thread");
      await this.fixRuling(entryId, r.request, ruling === "checked", r.text?.trim() ?? "");
      return this.mustEntry(entryId);
    }
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (isFinal(e) || e.state === "checking") throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: nothing to rule on`);
      this.mustNotOverrule(e, "rule");
      const text = clip(r.text);
      if (r.note !== undefined) this.setNote(e, r.note, "thread");
      switch (ruling) {
        case "chat-fixes": {
          // A blocking review is handed on with no text (Sova sends the reviewer's words); its text is the thread's note.
          const review = e.ruling?.pending?.cause === "review" ? openReview(e) : undefined;
          const later = !e.ruling?.pending && e.state === "with-chat" && e.sentBackFor === "review" ? openReview(e) : undefined;
          if (review || later) reviewNoteOk(review ?? later!, text);
          if (review) {
            const p = e.ruling!.pending!;
            this.sendBack(e, { cause: "review", why: p.why, ...(p.run ? { runId: p.run } : {}), ...(p.review ? { review: p.review } : {}), ...(text ? { diagnosis: text } : {}) });
            break;
          }
          if (later) {
            if (!text) throw new MergeFailure("invalid-request", "the review went to the chat already: give your note (text) to add to it");
            // A note after the hand-off: on that review's record and card, and to the chat as a short request, no try.
            later.note = { text, at: this.iso() };
            later.updatedAt = this.iso();
            this.request(e, "fix", reviewNoteText(e, later, text), {});
            break;
          }
          if (!text) throw new MergeFailure("invalid-request", "give your diagnosis (text): what failed, what in the branch causes it, what to change");
          if (e.state === "conflict") {
            const files = e.conflictFiles ?? [];
            this.sendBack(e, { cause: "conflict", why: this.conflictWhy(files), files, diagnosis: text, ...(e.run ? { runId: e.run } : {}) });
          } else if (e.ruling?.pending) {
            // The failure waiting for this diagnosis goes back now, with it.
            const p = e.ruling.pending;
            this.sendBack(e, { cause: p.cause, why: p.why, ...(p.run ? { runId: p.run } : {}), ...(p.files ? { files: p.files } : {}), ...(p.review ? { review: p.review } : {}), diagnosis: text });
          } else if (e.state === "unattributed" && e.ruling?.unattributed) {
            // Ruled before it reached the user: the logs show the branch's own errors, so it is the branch's after all.
            delete e.ruling.unattributed;
            this.sendBack(e, { cause: "checks", why: e.reason ?? "a check failed with the branch", ...(e.run ? { runId: e.run } : {}), diagnosis: text });
          } else if (e.state === "with-chat") {
            // Sent back already, without it: the diagnosis follows as its own request (no try counted).
            this.request(e, "fix", `The merge thread's diagnosis for ${e.branch}'s last request: ${text}`, {});
          } else throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: nothing waits for a diagnosis`);
          break;
        }
        case "try-again": {
          if (e.ruling?.cant) {
            if (!text) throw new MergeFailure("invalid-request", "say the other approach (text), for the chat");
            if (e.ruling.otherTried) throw new MergeFailure("invalid-request", "you already tried another approach for it: rule needs-user");
            const cant = e.ruling.cant;
            delete e.ruling.cant;
            e.ruling.otherTried = true;
            this.clearRulingTimer(e.id);
            this.request(e, "other-approach", `The merge thread has another approach for what you answered Can't (${cant.why}):\n${text}\nTry it, then answer this request Fixed, Needs you or Can't.`, {});
          } else if (e.state === "unattributed" && e.ruling?.unattributed) {
            // Ruled before it reached the user: not the branch's failure (the machine, a flake), so rerun it, counting no try.
            this.clearRulingTimer(e.id);
            delete e.ruling.unattributed;
            delete e.unclear;
            delete e.reason;
            this.toFront(e);
            this.kickSoon();
          } else if (e.state === "with-chat") {
            // A failure waiting for the thread's diagnosis counted its try already (awaitDiagnosis): never twice.
            const t = e.ruling?.pending?.counted ? { tries: e.ruling.pending.counted.tries, max: e.ruling.pending.counted.max } : this.countTry(e, `retry:${this.now()}`);
            if ("out" in t && t.out) {
              this.outOfTries(e, `tried ${t.tries} times`);
              break;
            }
            this.backInLine(e);
          } else throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: nothing to try again`);
          break;
        }
        case "needs-user": {
          if (!text) throw new MergeFailure("invalid-request", "give the question for the user (text) and its choices");
          if (e.state === "unattributed" && e.ruling?.unattributed) {
            this.raiseUnattributed(e, e.ruling.unattributed.run, text);
            break;
          }
          const cant = e.ruling?.cant;
          this.raiseDecision(e, {
            kind: "needs-you",
            question: text,
            choices: cleanChoices(r.choices),
            raisedBy: "merge-thread",
            actions: [],
            ...(cant ? { cantSettle: true as const } : {}),
            heldNote: { request: newId("rq"), text: `The user decided this for ${e.branch}: ${text}\nTheir answer comes with this note. Do it their way, then answer this request Fixed (or Can't).` },
          });
          break;
        }
      }
      e.updatedAt = this.iso();
      this.save();
      return e;
    });
  }

  /** A decision waiting for the user stands until they answer it: neither the thread nor the chat overrules it. */
  /** The queue's own waits that the thread may still settle from the logs: Can't tell whose failure, and a resolution
   *  the mechanical check turned down (another resolution may pass it). Everything else raised is the user's alone. */
  private mustNotOverrule(e: Entry, by: "resolve" | "rule"): void {
    const d = e.decision && !e.decision.answered ? e.decision : null;
    if (!d) return;
    // Only a resolution the mechanical check turned down may still be replaced by another resolution of the thread's.
    // Every other raised decision (the thread's, the chat's, Can't tell whose failure once it reached the user) is the
    // user's alone: no ruling replaces it, another "needs-user" included.
    const settleable = d.raisedBy === "queue" && d.kind === "behaviour-differs" && e.state === "behaviour-differs" && by === "resolve";
    if (!settleable) throw new MergeFailure("invalid-request", `${e.branch} already waits for the user's decision ("${d.question.split("\n")[0]!.slice(0, 120)}"): neither the merge thread nor the chat overrules it or adds another`);
  }

  /** Can't tell whose failure, raised to the user: one decision (Land Anyway, Try Again, Remove from Queue). */
  private raiseUnattributed(e: Entry, run: string, question?: string): void {
    if (e.ruling) delete e.ruling.unattributed;
    this.raiseDecision(e, { kind: "unattributed", question: question || `Can't tell whose failure: ${e.reason}. Land it anyway, try again, or remove it from the queue?`, choices: [], raisedBy: question ? "merge-thread" : "queue", actions: ["land-anyway", "try-again"], run }, "unattributed", e.reason);
  }

  /** The thread's try-again on an entry back with its chat: in line again at its commit (its try already counted). */
  private backInLine(e: Entry): void {
    this.reviewEvent(e, { kind: "checked" });
    this.clearRulingTimer(e.id);
    delete e.ruling;
    delete e.standing;
    delete e.reason;
    delete e.sentBackFor;
    delete e.sentBackDrafts;
    this.toFront(e);
    this.kickSoon();
  }

  private conflictWhy(files: string[]): string {
    return `conflicts with ${this.q.target}${files.length ? ` in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` : ""}`;
  }

  /**
   * The one way a problem that is the branch's goes back to its chat (al_3): counts a try (the same failure twice, or
   * out of tries, waits for the user instead), sets the entry back with the chat, and puts one request on the chat's
   * merge queue chat queue with what failed, its log and the thread's diagnosis. Built from this send-back's facts
   * only: no earlier conflict's or review's text. Entries with no standing approval (a release's) keep handBack.
   */
  private sendBack(e: Entry, f: { cause: SentBackFor; why: string; runId?: string; files?: string[]; review?: string; diagnosis?: string }): void {
    this.clearConflictTimer(e.id);
    this.clearRulingTimer(e.id);
    const run = f.runId ? (this.store.readRun(f.runId) ?? undefined) : undefined;
    if (e.release || !e.approval.standing) {
      this.handBack(e, run, f.why, f.cause);
      return;
    }
    // A failure that waited for the thread's diagnosis had its try counted when it happened (awaitDiagnosis).
    const counted = e.ruling?.pending?.counted && e.ruling.pending.run === f.runId ? e.ruling.pending.counted : undefined;
    const diagnosis = f.diagnosis ?? e.ruling?.diagnosis;
    // A review's request is Sova's, from its saved record: the reviewer's words whole, the thread's note after them.
    const rec = f.cause === "review" ? openReview(e) : undefined;
    if (rec) {
      f = { ...f, review: reportText(rec) };
      if (diagnosis?.trim()) rec.note = { text: diagnosis.trim(), at: this.iso() };
    }
    const fingerprint = counted?.fingerprint ?? this.failurePrint(f, run, rec?.findings);
    const ruling = e.ruling ? { ...(e.ruling.otherTried ? { otherTried: true as const } : {}) } : undefined;
    if (ruling && Object.keys(ruling).length) e.ruling = ruling;
    else delete e.ruling;
    // Stale facts of an earlier attempt never ride along: a conflict's judgement only with this conflict.
    if (f.cause !== "conflict") {
      // The resolution was of the merge at the old commit: the chat's fix is merged afresh, so its note goes with it.
      if (e.conflict) e.notes = e.notes.filter((n) => n.kind !== "resolved");
      delete e.conflict;
      delete e.conflictFiles;
    }
    if (f.cause !== "review") delete e.review;
    const t = counted ? { tries: counted.tries, max: counted.max } : this.countTry(e, fingerprint);
    if (rec) {
      rec.try = t.tries;
      rec.of = t.max;
    }
    if ("out" in t && t.out) {
      this.outOfTries(e, t.out === "same-twice" ? `Failed the same way twice: ${f.why}` : `Tried ${t.tries} times: ${f.why}`);
      return;
    }
    e.state = "with-chat";
    e.sentBackFor = f.cause;
    e.reason = f.why;
    e.standing = { phase: "with-chat", try: t.tries, of: t.max, why: f.why };
    e.updatedAt = this.iso();
    const text = sendBackText(e, { cause: f.cause, why: f.why, ...(run ? { run, logDir: this.store.runDir(run.id) } : {}), ...(f.files ? { files: f.files } : {}), ...(f.review ? { review: f.review } : {}), ...(diagnosis ? { diagnosis } : {}), attempt: { try: t.tries, of: t.max } });
    // Every send-back reaches the newest review's card: Fixing for its own, a Stopped card's cause keeps it Stopped.
    this.reviewEvent(e, { kind: "handed" });
    this.save();
    const req = this.request(e, "fix", text, { try: t.tries, fingerprint, ...(run ? { run } : {}) });
    if (rec) {
      rec.request = req.id;
      this.save();
    }
  }

  /** The entry's newest review record takes an event (review-record.ts): its card follows; the caller saves. */
  private reviewEvent(e: Entry, ev: ReviewEvent): void {
    applyReviewEvent(e, ev, this.iso());
  }

  /** A send-back's same-failure fingerprint (rulings.ts fingerprintOf). */
  private failurePrint(f: { cause: SentBackFor; why: string; files?: string[]; review?: string }, run: MergeRun | undefined, findings?: readonly ReviewFinding[]): string {
    return fingerprintOf({ cause: f.cause, ...(run ? { run, tails: this.failedTails(run) } : {}), ...(f.files ? { files: f.files } : {}), ...(f.review ? { review: f.review } : {}), ...(findings?.length ? { findings } : {}), why: f.why });
  }

  /** The last lines of each failed step's log that names no failing test (a typecheck, a build): what tells two such
   *  failures apart (rulings.ts fingerprintOf). */
  private failedTails(run: MergeRun): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of run.steps) {
      if (s.result !== "failed" || s.failures?.length || !s.log) continue;
      try {
        out[s.id] = readFileSync(join(this.store.runDir(run.id), s.log), "utf8").split("\n").filter(Boolean).slice(-20).join("\n");
      } catch {
        /* no log: its detail stands alone */
      }
    }
    return out;
  }

  /** A failure blamed on the branch waits for the thread's diagnosis (at most rulingWaitMs), then goes back as it is:
   *  with the thread's note as its diagnosis when it wrote one, else without. */
  private awaitDiagnosis(e: Entry, p: NonNullable<NonNullable<MergeEntry["ruling"]>["pending"]>): void {
    // The failure is the branch's: its try counts now, whatever the thread rules (a diagnosis, or a decision for the
    // user), and the same failure twice, or out of tries, stops here (q2): the user decides, nothing more to the chat.
    const run = p.run ? (this.store.readRun(p.run) ?? undefined) : undefined;
    const rec = p.cause === "review" ? openReview(e) : undefined;
    const fingerprint = p.counted?.fingerprint ?? this.failurePrint(p, run, rec?.findings);
    // Re-armed after a restart (recover): counted already, never twice.
    const t = p.counted ? { tries: p.counted.tries, max: p.counted.max } : this.countTry(e, fingerprint);
    if (rec) {
      rec.try = t.tries;
      rec.of = t.max;
    }
    if ("out" in t && t.out) {
      this.clearRulingTimer(e.id);
      if (e.ruling) delete e.ruling.pending;
      this.outOfTries(e, t.out === "same-twice" ? `Failed the same way twice: ${p.why}` : `Tried ${t.tries} times: ${p.why}`);
      return;
    }
    p = { ...p, counted: { tries: t.tries, max: t.max, fingerprint } };
    e.ruling = { ...(e.ruling ?? {}), pending: p };
    e.state = "with-chat";
    e.reason = p.why;
    e.standing = { phase: "with-chat", try: t.tries, of: t.max, why: p.why };
    e.updatedAt = this.iso();
    this.save();
    this.armRulingTimer(e.id, () => {
      const x = this.entry(e.id);
      const q = x?.ruling?.pending;
      if (!x || !q) return;
      // Only a note the thread wrote for this failure (after it was called in), never the landing note it wrote earlier.
      // A review goes without one: the thread's note on a review is its hand-off's (merge.note stays the landing note).
      const note = q.cause === "review" ? undefined : x.notes.find((n) => n.kind === "thread" && n.at >= q.at)?.text;
      this.sendBack(x, { cause: q.cause, why: q.why, ...(q.run ? { runId: q.run } : {}), ...(q.files ? { files: q.files } : {}), ...(q.review ? { review: q.review } : {}), ...(note ? { diagnosis: note } : {}) });
    });
  }

  private armRulingTimer(id: string, fn: () => void): void {
    this.clearRulingTimer(id);
    const t = setTimeout(() => {
      this.rulingTimers.delete(id);
      void this.serial(async () => fn()).catch((err) => this.log(`ruling wait of ${id}: ${err instanceof Error ? err.message : err}`));
    }, this.deps.rulingWaitMs ?? RULING_WAIT_MS);
    t.unref?.();
    this.rulingTimers.set(id, t);
  }
  private clearRulingTimer(id: string): void {
    const t = this.rulingTimers.get(id);
    if (t) clearTimeout(t);
    this.rulingTimers.delete(id);
  }

  /**
   * One decision waiting for the user (§app.merge-queue/needs-user): the only writer of `entry.decision`. Sets the
   * entry waiting (`needs-user`, or the named state), stops whatever waited for a ruling, and raises one card revision
   * and exactly one notification (notify "decision"); raising the same open question again changes nothing.
   */
  raiseDecision(e: Entry, d: Omit<MergeDecision, "id" | "at">, state: "needs-user" | "behaviour-differs" | "unattributed" | "keep" = "needs-user", reason?: string): void {
    const keep = state === "keep";
    if (!keep) {
      this.clearConflictTimer(e.id);
      this.clearRulingTimer(e.id);
      if (e.ruling) {
        delete e.ruling.pending;
        delete e.ruling.cant;
      }
    }
    const open = e.decision && !e.decision.answered ? e.decision : null;
    if (open && open.kind === d.kind && open.question === d.question && (keep || e.state === state)) return;
    // A decision already waits (q3: neither the thread nor the chat overrules the other's raise): the later question
    // joins it, with its choices, and no second notification. Only a resolution the mechanical check turned down is
    // replaced, by the thread's next judgement of it.
    if (open && !(open.raisedBy === "queue" && open.kind === "behaviour-differs")) {
      const who = d.raisedBy === "chat" ? "the branch's chat" : d.raisedBy === "merge-thread" ? "the merge thread" : "the queue";
      const question = open.question.includes(d.question) ? open.question : `${open.question}\nAlso, from ${who}: ${d.question}`;
      // Its click-only answers join too (a later Land, say), so the answer it needs is never refused.
      const actions = [...new Set([...open.actions, ...d.actions])];
      const choices = [...new Set([...open.choices, ...d.choices])].slice(0, 6);
      if (question !== open.question || actions.length !== open.actions.length || choices.length !== open.choices.length || (d.cantSettle && !open.cantSettle)) {
        e.decision = { ...open, question, choices, actions, ...(d.cantSettle ? { cantSettle: true as const } : {}) };
        e.updatedAt = this.iso();
        this.save();
        this.republish();
      }
      return;
    }
    e.decision = { ...d, id: newId("dc"), at: this.iso() };
    this.reviewEvent(e, { kind: "waiting" });
    if (!keep) {
      e.state = state;
      e.reason = reason ?? d.question.split("\n")[0]!.slice(0, 200);
    }
    e.updatedAt = this.iso();
    this.save();
    // Exactly one notification per decision (a question joining an open one sent none above).
    this.deps.decided?.(structuredClone(e), this.root);
    // behaviour-differs and unattributed raise their own revision from the view (cards.ts sync); the rest raise
    // "decision" here, once per decision.
    if (state === "needs-user" || keep) this.deps.notify?.("decision", e, { ...(d.run ? { run: this.store.readRun(d.run) ?? undefined } : {}), root: this.root } as { run?: MergeRun; root: string });
    else this.republish();
  }

  /**
   * merge.ask about an entry whose branch chat can take it (asks.ts decide, al_3 v7): the thread's question waits as a
   * decision on that entry's card, answered from the chat's message box; the answer reaches the thread
   * (decisionAnswered). The entry keeps its state (landed, in line, back with its chat): only its card asks.
   */
  askDecision(entryId: string, a: { id: string; question: string; choices: string[] }): Promise<boolean> {
    return this.serial(async () => {
      const e = this.entry(entryId);
      // A decision already waits on its card: the question is held on the tab instead, its answer kept apart.
      if (!e || (e.decision && !e.decision.answered)) return false;
      this.raiseDecision(
        e,
        {
          kind: "needs-you",
          question: clip(a.question),
          choices: cleanChoices(a.choices),
          raisedBy: "merge-thread",
          actions: [],
          ask: a.id,
          heldNote: { request: newId("rq"), text: `The merge thread asked the user (question ${a.id}): ${clip(a.question)}\nTheir answer is the message with this note; Sova passed it to the merge thread too. Nothing to relay: go on with your own work.` },
        },
        // The entry keeps its state: the question is the thread's, not a stop of the landing.
        "keep",
      );
      return true;
    });
  }

  /** The user answered the entry's decision (a click on it, or their message sent with its held note). */
  private answerDecision(e: Entry, how: NonNullable<MergeDecision["answered"]>["how"]): void {
    if (e.decision && !e.decision.answered) e.decision = { ...e.decision, answered: { at: this.iso(), how } };
  }

  /**
   * The user sent their answer to a decision from the chat's message box (channel: the held note went with it, in one
   * turn). The decision is answered and the entry is back with the chat; the held note is its request now.
   * Answers the held note (to record as delivered), or null when nothing waits.
   */
  decisionAnswered(entryId: string, decisionId: string, text?: string, from?: { session?: string }): Promise<{ request: string; text: string } | null> {
    return this.serial(async () => {
      const e = this.entry(entryId);
      if (!e?.decision || e.decision.id !== decisionId || e.decision.answered) return null;
      const held = e.decision.heldNote ?? null;
      const ask = e.decision.ask;
      this.answerDecision(e, "message");
      // A merge thread question: its answer goes to the thread, and the entry stays where it was.
      if (ask) {
        if (text?.trim()) this.deps.answerAsk?.(this.root, ask, text.trim(), from?.session);
        e.updatedAt = this.iso();
        this.save();
        this.republish();
        return held;
      }
      if (e.ruling) delete e.ruling.cant;
      e.state = "with-chat";
      e.standing = { phase: "with-chat", try: e.tries?.used ?? 1, of: e.tries?.max ?? 3, why: e.reason ?? "your answer went to the chat" };
      // A blocking review the user decided before it ever reached the chat: its report goes with their answer, as Sova
      // wrote it from the saved record (the reviewer's words, then the thread's note); its card is Fixing from here.
      const rec = openReview(e);
      let note = held;
      if (rec && held && !rec.request) {
        note = { ...held, text: `${held.text}\nThe review's findings, as the reviewer wrote them:\n${reportText(rec)}${rec.note ? `\nMerge thread: ${rec.note.text}` : ""}` };
        e.decision = { ...e.decision, heldNote: note };
      }
      if (rec && held) {
        rec.request ??= held.request;
        this.reviewEvent(e, { kind: "handed" });
      }
      // The held note is a request from now on, under the id the chat answers it by (merge.respond): recorded here,
      // delivered with the user's message (channel stamps its delivery), never sent a second time.
      if (note && !e.requests?.some((r) => r.id === note.request)) {
        const req = this.addRequest(e, { kind: "decision", text: note.text, ...(e.sentBackFor ? { cause: e.sentBackFor } : {}) });
        req.id = note.request;
        req.delivery = "delivered";
      }
      e.updatedAt = this.iso();
      this.save();
      return note;
    });
  }

  /** The branch's chat answered a request "Needs you" (merge.respond, carry): a decision the thread can't overrule. */
  chatNeedsYou(e: Entry, request: string, question: string, options: string[]): void {
    const q = clip(question) || "The branch's chat needs your decision.";
    this.raiseDecision(e, {
      kind: "needs-you",
      question: q,
      choices: cleanChoices(options),
      raisedBy: "chat",
      actions: [],
      heldNote: { request: newId("rq"), text: `The user's answer to what you asked (request ${request}): it comes with this note. Do it their way, then answer this request Fixed (or Can't).` },
    });
    this.wake("chat-answer", e, undefined, { request, answer: "needs-you", text: q });
  }

  /**
   * The branch's chat answered a request "Can't" (merge.respond, carry): the merge thread rules first and may try one
   * other approach; with no thread, after its other approach, or with no ruling in time, it is the user's: "can't be
   * settled without you".
   */
  chatCant(e: Entry, request: string, why: string): void {
    const w = clip(why) || "it gave no reason";
    const otherTried = !!e.ruling?.otherTried;
    const asked = this.wake("chat-answer", e, undefined, { request, answer: "cant", text: w, ...(otherTried ? { otherTried: true } : {}) });
    if (!asked || otherTried) {
      this.raiseCant(e, request, w);
      return;
    }
    e.ruling = { ...(e.ruling ?? {}), cant: { request, why: w, at: this.iso() } };
    e.updatedAt = this.iso();
    this.save();
    this.armRulingTimer(e.id, () => {
      const x = this.entry(e.id);
      if (x?.ruling?.cant) this.raiseCant(x, x.ruling.cant.request, x.ruling.cant.why);
    });
  }

  /** A Can't the thread couldn't settle: the user's, "can't be settled without you". */
  private raiseCant(e: Entry, request: string, why: string): void {
    this.raiseDecision(e, {
      kind: "needs-you",
      question: `${e.branch}'s chat can't fix it: ${why}. This can't be settled without you: how should it go?`,
      choices: [],
      raisedBy: "chat",
      actions: [],
      cantSettle: true,
      heldNote: { request: newId("rq"), text: `The user's answer to what you couldn't do (request ${request}): it comes with this note. Do it their way, then answer this request Fixed (or Can't).` },
    });
  }

  /** The user's click on a decision (merge.answer, their own click only): Accept, Land Anyway, Try Again or Land.
   *  Remove from Queue is merge.cancel. Nothing goes to the chat. */
  answer(entryId: string, answer: MergeAnswer, why?: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      void why;
      if (answer === "accept") {
        if (e.state !== "behaviour-differs") throw new MergeFailure("invalid-request", `Accept answers a conflict whose sides differ; ${e.branch} is ${e.state}`);
        if (!e.conflict?.commit) throw new MergeFailure("invalid-request", "there is no proposed resolution to accept: answer in the branch's chat, or Remove from Queue");
        this.answerDecision(e, "accept");
        e.notes = e.notes.filter((n) => n.kind !== "resolved");
        e.notes.push({ kind: "resolved", text: `You accepted the resolution of ${e.conflict.files.join(", ") || "its conflict"}: ${e.conflict.proposal}`.slice(0, NOTE_MAX), at: this.iso() });
        delete e.reason;
        this.toFront(e);
        this.save();
        this.kickSoon();
        return e;
      }
      if (answer === "try-again") {
        if (e.state !== "unattributed") throw new MergeFailure("invalid-request", `Try Again answers a failure no one can be blamed for; ${e.branch} is ${e.state}`);
        // Not the branch's: back in line at the same commit, every check afresh, counting no try.
        this.answerDecision(e, "try-again");
        delete e.unclear;
        delete e.reason;
        this.toFront(e);
        this.save();
        this.kickSoon();
        return e;
      }
      if (answer === "land") return this.answerLand(e);
      if (answer === "land-anyway") {
        if (e.state !== "unattributed") throw new MergeFailure("invalid-request", `Land Anyway answers a failure no one can be blamed for; ${e.branch} is ${e.state}`);
        this.answerDecision(e, "land-anyway");
        e.notes.push({ kind: "master-red", text: `Landed anyway: ${e.reason ?? "a check failed on the merge and on the target alone"}`.slice(0, NOTE_MAX), at: this.iso() });
        e.approval.overUnattributed = true;
        const run = e.run ? this.store.readRun(e.run) : null;
        // The tested tip lands only onto the target it was tested on; the line moved on meanwhile: rerun it first.
        if (run?.tip && !this.current && (await this.targetHead()) === run.base) {
          e.state = "checking";
          e.updatedAt = this.iso();
          this.save();
          await this.landTested(e, run);
        } else {
          this.toFront(e);
          this.save();
          this.kickSoon();
        }
        return e;
      }
      throw new MergeFailure("invalid-request", 'answer is "accept", "land-anyway", "try-again" or "land"');
    });
  }

  // ---- al_3 carry: the standing approval and the chat's answers (§app.merge-queue/standing-approval,
  // §app.merge-queue/tries, §chat.merge-queue/answers, §chat.worktrees/ready-to-land) ----------------------------

  /** A new request of the branch's chat, recorded on its entry (oldest first). The caller saves. */
  addRequest(e: Entry, r: { kind: MergeRequestKind; text: string; cause?: SentBackFor; try?: number; fingerprint?: string }): MergeChatRequest {
    const req: MergeChatRequest = {
      id: newId("rq"),
      kind: r.kind,
      entry: e.id,
      branch: e.branch,
      ...(e.session ? { session: e.session } : {}),
      text: r.text,
      ...(r.cause ? { cause: r.cause } : {}),
      ...(r.try ? { try: r.try } : {}),
      ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
      at: this.iso(),
      delivery: "queued",
    };
    e.requests = [...(e.requests ?? []), req].slice(-REQUESTS_KEPT);
    e.updatedAt = this.iso();
    return req;
  }

  /** A request recorded, saved and sent to the branch's chat (deps.notify with `{request}`: a fix as "needs-fix",
   *  anything else as "request"). */
  private request(e: Entry, kind: MergeRequestKind, text: string, o: { try?: number; fingerprint?: string; run?: MergeRun; cause?: SentBackFor }): MergeChatRequest {
    const req = this.addRequest(e, { kind, text, ...(o.try ? { try: o.try } : {}), ...(o.fingerprint ? { fingerprint: o.fingerprint } : {}), ...(o.cause ?? e.sentBackFor ? { cause: o.cause ?? e.sentBackFor } : {}) });
    this.save();
    this.deps.notify?.(kind === "fix" ? "needs-fix" : "request", e, { ...(o.run ? { run: o.run, logDir: this.store.runDir(o.run.id) } : {}), root: this.root, request: req });
    return req;
  }

  /** How a request reached its chat (the chat queue, or the fallback for a chat that can't take notes). */
  requestDelivered(requestId: string, delivery: NonNullable<MergeChatRequest["delivery"]>, to?: string): void {
    const r = this.requestOf(requestId)?.request;
    if (!r || (r.delivery === delivery && (!to || r.to === to))) return;
    r.delivery = delivery;
    if (to) r.to = to;
    this.save();
  }

  /** The request `id` and its entry, wherever it is. */
  requestOf(id: string): { entry: Entry; request: MergeChatRequest } | undefined {
    for (const e of this.q.entries) {
      const r = e.requests?.find((x) => x.id === id);
      if (r) return { entry: e, request: r };
    }
    return undefined;
  }

  /**
   * A run that ends sent back to the chat counts one of the standing approval's tries (§app.merge-queue/tries). `out`:
   * this was the last try, or the run failed the same way as the one before it (`fingerprint`, rulings.ts). Callers
   * count only runs whose failure is the branch's (never a void run, a machine failure, or one nobody can be blamed for).
   */
  /** Whether a try counted now with `fingerprint` would run out (countTry's rule, changing nothing). */
  private triesOut(e: Entry, fingerprint: string): "out-of-tries" | "same-twice" | undefined {
    const t = e.tries ?? { used: 0, max: MERGE_TRIES, fingerprints: [] };
    if (t.fingerprints.length > 0 && t.fingerprints[t.fingerprints.length - 1] === fingerprint) return "same-twice";
    return t.used + 1 >= t.max ? "out-of-tries" : undefined;
  }

  countTry(e: Entry, fingerprint?: string): { tries: number; max: number; out?: "out-of-tries" | "same-twice" } {
    const t = e.tries ?? { used: 0, max: MERGE_TRIES, fingerprints: [] };
    const same = !!fingerprint && t.fingerprints.length > 0 && t.fingerprints[t.fingerprints.length - 1] === fingerprint;
    // The conflict that was already there at the Land counts no try, once.
    const free = !!e.approval.conflictAtLand && !!fingerprint?.startsWith("conflict:");
    if (free) {
      delete e.approval.conflictAtLand;
      if (fingerprint) t.fingerprints = [...t.fingerprints, fingerprint].slice(-t.max);
      e.tries = t;
      // Counts no try, and shows none: the chat's next send-back that counts reads "try 1 of 3".
      return { tries: t.used, max: t.max };
    }
    t.used += 1;
    if (fingerprint) t.fingerprints = [...t.fingerprints, fingerprint].slice(-t.max);
    e.tries = t;
    const out = same ? ("same-twice" as const) : t.used >= t.max ? ("out-of-tries" as const) : undefined;
    return { tries: t.used, max: t.max, ...(out ? { out } : {}) };
  }

  /** Out of tries: the entry waits for the user (Land, a new standing approval with 3 new tries, or Remove from
   *  Queue); nothing more goes to its chat; one notification (raiseDecision). */
  private outOfTries(e: Entry, reason: string): void {
    delete e.standing;
    delete e.fix;
    delete e.pausedFrom;
    this.raiseDecision(e, { kind: "out-of-tries", question: reason, choices: [], raisedBy: "queue", actions: ["land", "remove"] });
  }

  /**
   * merge.respond: the branch's chat answers a request by its id, once: Fixed (a commit, drafts, or both), Needs you
   * (a question and its options for the user), or Can't (why). Only the chat the request went to answers it; a merge
   * thread's question is the user's (merge.reply). An answer never approves anything: it moves only an entry whose
   * standing approval still holds, and a fix lands only once the merge thread checked it.
   */
  respond(requestId: string, from: string | null, a: { answer: string; text?: string; commit?: string; drafts?: boolean; options?: string[] }): Promise<{ entry: MergeEntry; request: MergeChatRequest }> {
    return this.serial(async () => {
      const found = this.requestOf(requestId);
      if (!found) throw new MergeFailure("not-found", `no merge queue request ${requestId}`);
      const e = found.entry;
      const r = found.request;
      if (r.kind === "thread-ask") throw new MergeFailure("forbidden", "that is the merge thread's question to your user: they answer it with their own next message; nothing for you to answer or relay");
      if (!from || (r.session !== from && r.to !== from)) throw new MergeFailure("forbidden", "only the chat the request was sent to answers it");
      if (r.answer) throw new MergeFailure("invalid-request", `request ${requestId} is answered already (${r.answer.kind})`);
      const text = a.text?.trim() ?? "";
      if (text.length > 2000) throw new MergeFailure("invalid-request", "keep the answer under 2000 characters");
      if (a.answer !== "fixed" && a.answer !== "needs-you" && a.answer !== "cant") throw new MergeFailure("invalid-request", 'answer is "fixed", "needs-you" or "cant"');
      // The user's Land must still stand: one they ended, that landed, or that waits for their decision is never moved
      // by an answer.
      if (!e.approval.standing || !ANSWERABLE.includes(e.state))
        throw new MergeFailure(
          "invalid-request",
          `${e.branch} ${e.state === "landed" ? "landed already: a newer commit is later work, landed only by the user's Land Again" : e.state === "cancelled" ? "was removed from the queue by the user: nothing to answer" : e.state === "needs-user" || e.state === "needs-fix" ? "waits for the user's decision now: nothing to answer" : `is ${e.state}: nothing to answer`}`,
        );
      if (a.answer === "needs-you") {
        if (!text) throw new MergeFailure("invalid-request", "say the question for your user (text)");
        const options = (a.options ?? []).map((o) => o.trim()).filter(Boolean);
        r.answer = { kind: "needs-you", question: text, options, at: this.iso() };
        delete e.fix;
        delete e.pausedFrom;
        this.chatNeedsYou(e, r.id, text, options);
        this.save();
        return { entry: this.withPosition(e), request: structuredClone(r) };
      }
      if (a.answer === "cant") {
        if (!text) throw new MergeFailure("invalid-request", "say why you can't (text)");
        r.answer = { kind: "cant", why: text, at: this.iso() };
        delete e.fix;
        if (e.state === "with-chat") this.setPhase(e, { phase: "waiting-thread", answer: r.answer });
        this.chatCant(e, r.id, text);
        this.save();
        return { entry: this.withPosition(e), request: structuredClone(r) };
      }
      // Fixed: what changed, read from the branch itself (the chat never sends a hash).
      const tip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
      if (!tip) throw new MergeFailure("not-found", `no branch ${e.branch} in ${this.root}`);
      let commit: string | undefined;
      if (a.commit) {
        const c = await revParse(this.git, this.root, a.commit);
        if (!c) throw new MergeFailure("not-found", `no commit ${a.commit} in ${this.root}`);
        if (c !== tip && !(await isAncestor(this.git, this.root, c, tip))) throw new MergeFailure("invalid-request", `${c.slice(0, 7)} isn't on ${e.branch}`);
        if (c !== e.commit) commit = c;
      } else if (!a.drafts && tip !== e.commit) commit = tip;
      const wt = e.worktree && existsSync(e.worktree) ? e.worktree : undefined;
      const drafts = !e.approval.withoutSpecs && wt ? await this.branchDrafts(wt, commit ?? e.commit) : undefined;
      const draftsMoved = (drafts?.hash ?? null) !== (e.approval.drafts?.hash ?? null);
      const draftsFix = !!a.drafts || (draftsMoved && !commit);
      if (!commit && !draftsFix) throw new MergeFailure("invalid-request", `nothing changed on ${e.branch} since the request: name the commit you made (commit), or say drafts: true once you changed its spec drafts`);
      const answer: MergeChatAnswer = {
        kind: "fixed",
        changed: commit && draftsFix ? "both" : commit ? "commit" : "drafts",
        ...(commit ? { commit } : {}),
        ...(draftsFix && drafts ? { drafts: { hash: drafts.hash, names: drafts.names } } : {}),
        summary: text || (commit ? `commit ${commit.slice(0, 7)}` : "its spec drafts"),
        at: this.iso(),
      };
      r.answer = answer;
      e.updatedAt = this.iso();
      // A fix that arrives while the entry's run is checking waits for that run: never voided for it. If the run lands,
      // the fix is later work (Land Again); if not, the merge thread is handed it once the run ends (recheckWithChat).
      if (e.state === "checking") {
        e.fix = { request: r.id, told: false, at: this.iso() };
        this.save();
        this.armFixTimer();
        return { entry: this.withPosition(e), request: structuredClone(r) };
      }
      // In line, not started: out of line until the thread has checked the fix (it goes back in at the fix's commit).
      if (e.state === "queued") e.state = "with-chat";
      // The merge thread checks it changes only what was asked; until it rules (or while it isn't running) it waits.
      const fixBase = commit ? await this.mergeBase(commit) : undefined;
      const told = this.wake("fix", e, undefined, { request: r.id, asked: r.text, ...(commit ? { fixCommit: commit } : {}), ...(draftsFix ? { drafts: true } : {}), summary: answer.summary, ...(fixBase ? { base: fixBase } : {}) });
      e.fix = { request: r.id, told, at: this.iso() };
      if (e.state === "with-chat") this.setPhase(e, { phase: "waiting-thread", answer });
      this.save();
      this.armFixTimer();
      return { entry: this.withPosition(e), request: structuredClone(r) };
    });
  }

  /** Set a with-chat entry's phase; while the user's Stop pauses it, the phase it returns to. */
  private setPhase(e: Entry, s: MergeStanding): void {
    if (e.standing?.phase === "paused") e.pausedFrom = s;
    else e.standing = s;
    e.updatedAt = this.iso();
  }

  /**
   * The merge thread's ruling on a fix (merge.rule checked | beyond): `request` is the fix it checked. Checked: Sova
   * runs Land's checks on the fix and, when they pass, re-pins the approval's commit and drafts and puts it back in
   * line, with no new Land. Beyond: it changes more than was asked, so it waits for the user. A drafts-changed entry
   * (drafts changed since the Land, with no request) is ruled by its entry: checked re-pins its drafts.
   */
  fixRuling(entryId: string, request: string | undefined, ok: boolean, text: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const found = request ? this.requestOf(request) : undefined;
      if (request && !found) throw new MergeFailure("not-found", `no merge queue request ${request}`);
      const e = found?.entry ?? this.mustEntry(entryId);
      if (found && found.entry.id !== entryId) throw new MergeFailure("invalid-request", `request ${request} is ${found.entry.branch}'s, not entry ${entryId}'s`);
      const r = found?.request;
      if (!e.approval.standing || e.state !== "with-chat") throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: no fix waits for your check`);
      if (r && r.answer?.kind !== "fixed") throw new MergeFailure("invalid-request", `request ${r.id} wasn't answered Fixed${r.answer ? ` (it was ${r.answer.kind})` : ""}: nothing to check`);
      if (!r) throw new MergeFailure("invalid-request", "name the request (rq_…) whose fix you checked");
      const answer = r?.answer?.kind === "fixed" ? r.answer : undefined;
      delete e.fix;
      if (!ok) {
        const what = text.trim() || "more than the request asked";
        this.raiseDecision(e, { kind: answer ? "fix-ok" : "drafts-changed", question: `${answer ? "The fix changes" : "Its spec drafts change"} more than was asked: ${what}`, choices: [], raisedBy: "merge-thread", actions: ["land", "remove"] });
        this.save();
        return this.withPosition(e);
      }
      // A fix that rewrote the branch (a rebase, an amend): the approved commit isn't under it, so nothing can tell its
      // commits from work the user asked for (a rebase rewrites their dates too). Never covered by the Land: the user
      // decides once.
      if (answer?.commit && r && !(await isAncestor(this.git, this.root, e.commit, answer.commit))) {
        this.raiseDecision(e, { kind: "fix-ok", question: `The fix rewrote ${e.branch}'s history (a rebase or an amend), so Sova can't tell the fix from other work on it: Land takes ${e.branch} at ${answer.commit.slice(0, 7)} as it is now`, choices: [], raisedBy: "queue", actions: ["land", "remove"] });
        e.fix = { request: r.id, told: true, at: this.iso() };
        this.save();
        return this.withPosition(e);
      }
      // A fix on top of work the user asked for meanwhile (their commit came first): the card asks them once.
      if (answer?.commit && r) {
        // Counted from the newest commit the Land already covers: the pinned commit, or an earlier request's fix the
        // thread checked (its requeue may have been held, so the pin didn't move) that this fix builds on.
        let from = e.commit;
        for (const x of [...(e.requests ?? [])].reverse()) {
          const c = x.id !== r.id && x.checkedAt && x.answer?.kind === "fixed" ? x.answer.commit : undefined;
          if (c && c !== answer.commit && (await isAncestor(this.git, this.root, c, answer.commit)) && (await isAncestor(this.git, this.root, from, c))) {
            from = c;
            break;
          }
        }
        const unasked = await this.unaskedWork(from, answer.commit, r.at);
        if (unasked) {
          this.raiseDecision(e, { kind: "fix-ok", question: `The fix sits on top of ${unasked} the merge queue didn't ask for: Land takes ${e.branch} at ${answer.commit.slice(0, 7)}, that work included`, choices: [], raisedBy: "queue", actions: ["land", "remove"] });
          e.fix = { request: r.id, told: true, at: this.iso() };
          this.save();
          return this.withPosition(e);
        }
      }
      // Only what the thread checked is pinned: the drafts as the answer recorded them (a commit-only fix: as the approval
      // pinned them). Drafts edited since the answer are a change nobody checked: the user's to decide (q8), never
      // landed on the standing Land.
      if (answer) {
        const wt = e.worktree && existsSync(e.worktree) ? e.worktree : undefined;
        const now = !e.approval.withoutSpecs && wt ? await this.branchDrafts(wt, answer.commit ?? e.commit) : undefined;
        const checked = answer.changed === "commit" ? e.approval.drafts?.hash : answer.drafts?.hash;
        if ((now?.hash ?? null) !== (checked ?? null)) {
          this.raiseDecision(e, { kind: "drafts-changed", question: `${e.branch}'s spec drafts changed after its chat answered Fixed, so the merge thread never checked them as they are now: Land takes them as they are now`, choices: [], raisedBy: "queue", actions: ["land", "remove"] });
          this.save();
          return this.withPosition(e);
        }
      }
      // Checked: covered by the Land from here on, whether or not it goes back in line now.
      if (r) r.checkedAt = this.iso();
      await this.requeueFix(e, answer?.commit ?? e.commit, r?.id);
      return this.withPosition(e);
    });
  }

  /** The fix's merge base with the target: what the merge thread diffs the fix against (never two-dot from the old
   *  approved commit, which after a rebase holds the target's own changes). */
  private async mergeBase(commit: string): Promise<string | undefined> {
    const r = await this.git(["merge-base", `refs/heads/${this.q.target}`, commit], this.root);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** How many commits in `from..to` were made before the request (`since`): work the user asked for, not the fix. */
  private async unaskedWork(from: string, to: string, since: string): Promise<string | null> {
    // The branch's own commits only: a merge of the target into the branch (the fix for a conflict) brings the target's
    // commits, which are nobody's unasked work; the merge commit itself is the fix's.
    // Author dates: a rebase or a cherry-pick keeps them (it rewrites committer dates).
    const r = await this.git(["log", "--first-parent", "--format=%at", `${from}..${to}`, "--not", `refs/heads/${this.q.target}`], this.root);
    if (r.code !== 0) return null;
    const at = Math.floor(Date.parse(since) / 1000);
    const n = r.stdout.split("\n").filter(Boolean).filter((t) => Number(t) < at).length;
    return n ? `${n} commit${n === 1 ? "" : "s"}` : null;
  }

  /**
   * Land on a decision (the user's own click): out of tries, a new standing approval at the branch's newest commit
   * with 3 new tries; a fix that needs their OK (on top of their own work, or changing more than was asked), it goes
   * back in line at the fix's commit, that work included; drafts changed beyond fitting, re-pinned as they are now.
   * The caller is inside serial.
   */
  private async answerLand(e: Entry): Promise<MergeEntry> {
    const d = e.decision && !e.decision.answered ? e.decision : null;
    if (!d || !d.actions.includes("land")) throw new MergeFailure("invalid-request", `Land answers a decision that offers it; ${e.branch} is ${e.state}`);
    if (d.kind === "out-of-tries") {
      this.answerDecision(e, "land");
      e.state = "cancelled";
      e.reason = "landed again by you";
      e.updatedAt = this.iso();
      this.save();
      const r = await this.addNow({ branch: e.branch, by: "land-button", ...(e.session ? { session: e.session } : {}), ...(e.approval.withoutSpecs ? { withoutSpecs: true } : {}), ...(e.approval.withoutReview ? { withoutReview: true } : {}), ...(e.approval.via ? { via: e.approval.via } : {}) });
      return r.entry;
    }
    // fix-ok / drafts-changed: the fix's commit (the newest Fixed answer's), else the commit as pinned.
    const r = [...(e.requests ?? [])].reverse().find((x) => x.answer?.kind === "fixed");
    const a = r?.answer?.kind === "fixed" ? r.answer : undefined;
    this.answerDecision(e, "land");
    delete e.fix;
    e.state = "with-chat";
    // A fix that rewrote the branch: the user's Land takes the branch as it is now, as their own approval of it (not a
    // fix the Land carried), so the Landed card lists no rewritten commits as fixes.
    if (a?.commit && !(await isAncestor(this.git, this.root, e.commit, a.commit))) {
      e.approval.userCommit = a.commit;
      await this.requeueFix(e, a.commit, undefined, this.iso());
      return this.withPosition(e);
    }
    await this.requeueFix(e, a?.commit ?? e.commit, r?.id, this.iso());
    return this.withPosition(e);
  }

  /**
   * What keeps the commit from going back in line by itself (Land's refusals, and what Ready to land checks itself:
   * conflicts with the target, the chat's own failing check run, drafts that don't fit), in words; null when nothing.
   */
  private async fixBlocked(e: Pick<Entry, "branch" | "worktree" | "session" | "approval">, commit: string, drafts: { hash: string; names: string[] } | undefined): Promise<string | null> {
    const tip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
    if (!tip) return `${e.branch} is gone`;
    const wt = e.worktree && existsSync(e.worktree) ? e.worktree : undefined;
    if (wt && commit === tip) {
      const st = await this.git(statusArgs("--porcelain"), wt);
      const n = st.code === 0 ? st.stdout.split("\n").filter(Boolean).length : 0;
      if (n) return `${n} uncommitted file${n === 1 ? "" : "s"} in its folder: commit or remove them`;
    }
    const subject = (await this.git(["log", "-1", "--format=%s", commit], this.root)).stdout.trim();
    if (/^temp\b/i.test(subject)) return `its commit is a temporary commit ("${subject.slice(0, 60)}"): reword or squash it`;
    const head = await this.targetHead();
    if (head && (await this.leftOf(e.branch, commit, wt, head))?.nothingLeft) return nothingToLandWords(this.q.target);
    // A conflict with the target never blocks here: it goes in line, and its run's merge step hands it to the merge
    // thread's conflict judgement (resolved by the thread, the chat's to fix with the thread's diagnosis, or the user's
    // to decide), never straight to the chat unjudged (q3).
    if (e.session) {
      const failing = await this.deps.chatCheckFailing?.(e.session, wt).catch(() => null);
      if (failing) return `${failing}: fix it and run it again`;
    }
    if (wt && drafts && !e.approval.withoutSpecs && this.deps.docsCheck) {
      const d = this.deps.docsCheck(wt, commit, drafts.hash, () => this.armFixTimer(1000));
      if (d !== "pending" && d.problems.length) return `its spec drafts don't fit: ${d.problems.slice(0, 4).join("; ")}${d.problems.length > 4 ? `; and ${d.problems.length - 4} more` : ""}. Fix them in the drafts: that needs no commit`;
    }
    return null;
  }

  /** Tell the chat, as a request, what still keeps its approved branch out of line (once per reason). */
  private tellBlocked(e: Entry, why: string): void {
    const last = e.requests?.[e.requests.length - 1];
    if (last?.kind === "blocked" && !last.answer && last.text.includes(why)) return;
    this.request(e, "blocked", blockedText(e, why), {});
  }

  /**
   * A checked fix (or an approval nothing blocks any more) goes back in line by itself at `commit`: Land's checks
   * first; then the approval's commit and drafts are re-pinned, its options and tries kept, and it joins the end of
   * the line. Still blocked: it stays with the chat, told what blocks it. The caller is inside serial.
   */
  /** `press`: the user's Land on a decision put it back (its time), else an automatic re-queue of a checked fix. */
  private async requeueFix(e: Entry, commit: string, request?: string, press?: string): Promise<void> {
    const wt = e.worktree && existsSync(e.worktree) ? e.worktree : undefined;
    const drafts = !e.approval.withoutSpecs && wt ? await this.branchDrafts(wt, commit) : undefined;
    const blocked = await this.fixBlocked(e, commit, drafts);
    if (blocked) {
      e.state = "with-chat";
      this.setPhase(e, { phase: "waiting-fix", why: blocked });
      e.reason = blocked;
      this.save();
      this.tellBlocked(e, blocked);
      this.armFixTimer();
      return;
    }
    this.reviewEvent(e, { kind: "checked" });
    const moved = commit !== e.commit;
    e.commit = commit;
    e.approval.commit = commit;
    if (drafts) e.approval.drafts = { hash: drafts.hash, names: drafts.names };
    else delete e.approval.drafts;
    delete e.approval.blocked;
    if (request) e.approval.fixes = [...(e.approval.fixes ?? []), { request, ...(moved ? { commit } : {}), ...(drafts ? { drafts: drafts.hash } : {}), checkedAt: this.iso() }];
    // A resolution of the old commit's conflict doesn't fit the new one: the next run judges afresh.
    if (moved) {
      delete e.conflict;
      delete e.conflictFiles;
      e.notes = e.notes.filter((n) => n.kind !== "resolved");
    }
    delete e.standing;
    delete e.fix;
    delete e.pausedFrom;
    delete e.reason;
    delete e.sentBackFor;
    delete e.sentBackDrafts;
    delete e.newerCommits;
    delete e.ruling;
    this.clearRulingTimer(e.id);
    e.state = "queued";
    e.seq = ++this.q.seq;
    e.updatedAt = this.iso();
    if (!this.current && !this.q.entries.some((x) => x !== e && (x.state === "queued" || x.state === "checking"))) this.q.knownTarget = (await this.targetHead()) ?? this.q.knownTarget;
    this.save();
    this.wake("queued", e);
    this.deps.notify?.("approved", this.withPosition(e), { root: this.root, ...(press ? { press } : {}) });
    this.kickSoon();
  }

  /**
   * Stop in the branch's chat pauses its requests (q11): the card reads "Paused: you stopped the chat" and nothing
   * of it moves until the user's next message (`paused` false), when the phase it had comes back.
   */
  chatPaused(session: string, paused: boolean): Promise<void> {
    return this.serial(async () => {
      let changed = false;
      for (const e of this.q.entries) {
        // The branch's chat, or the chat its requests reach (a worker's branch: the chat running the worker).
        if (e.state !== "with-chat" || (e.session !== session && !e.requests?.some((r) => r.to === session))) continue;
        if (paused && e.standing?.phase !== "paused") {
          if (e.standing) e.pausedFrom = e.standing;
          e.standing = { phase: "paused" };
        } else if (!paused && e.standing?.phase === "paused") {
          e.standing = e.pausedFrom ?? { phase: "waiting-fix", why: e.reason ?? "" };
          delete e.pausedFrom;
        } else continue;
        e.updatedAt = this.iso();
        changed = true;
      }
      if (!changed) return;
      this.save();
      if (!paused) this.armFixTimer(0);
    });
  }

  private fixTimer: ReturnType<typeof setTimeout> | null = null;
  private fixTimerAt = 0;
  /** Look at the entries with their chats again in `ms` (default a minute): a blocked approval nothing blocks any
   *  more goes in line; a fix or Can't the merge thread wasn't told of is handed to it once it runs (q14). */
  private armFixTimer(ms = FIX_RECHECK_MS): void {
    if (this.stopped) return;
    const at = this.now() + ms;
    if (this.fixTimer && this.fixTimerAt <= at) return;
    if (this.fixTimer) clearTimeout(this.fixTimer);
    this.fixTimerAt = at;
    this.fixTimer = setTimeout(() => {
      this.fixTimer = null;
      void this.serial(() => this.recheckWithChat()).catch((err) => this.log(`recheck failed: ${err instanceof Error ? err.message : err}`));
    }, ms);
    this.fixTimer.unref?.();
  }

  /** A conflict no merge thread took (none running, or no ruling in time): it waits for the thread, and recheckWithChat
   *  hands it over again once the thread runs (threadActed, or every minute). The caller saves after. */
  private waitForThread(e: Entry): void {
    this.clearConflictTimer(e.id);
    e.fix = { request: CONFLICT_WAIT, told: false, at: this.iso() };
    if (!/waiting for the merge thread/.test(e.reason ?? "")) e.reason = `${e.reason ?? `conflicts with ${this.q.target}`}; waiting for the merge thread`;
    e.updatedAt = this.iso();
    this.save();
    this.armFixTimer();
  }

  /** Look at the entries with their chats again now (tests; a thread that just started). */
  recheckNow(): Promise<void> {
    return this.serial(() => this.recheckWithChat());
  }

  /** The project's merge thread called a merge verb: it runs, so a fix it wasn't told of is handed to it now (q14). */
  threadActed(): void {
    if (this.q.entries.some((e) => e.fix && !e.fix.told)) this.armFixTimer(0);
  }

  private async recheckWithChat(): Promise<void> {
    let more = false;
    for (const e of this.q.entries) {
      // A conflict's wait for the thread ends once the thread judged it (or it left the conflict state any other way).
      if (e.fix?.request === CONFLICT_WAIT && e.state !== "conflict") {
        delete e.fix;
        this.save();
      }
      // A conflict waiting for the merge thread: handed to it (with a fresh scratch copy) once it runs.
      if (e.state === "conflict" && e.fix?.request === CONFLICT_WAIT && e.approval.standing) {
        more = true;
        if (e.fix.told) continue;
        const scratch = this.deps.thread ? await this.makeScratch(e, (await this.targetHead()) ?? e.commit) : {};
        const told = this.wake("conflict", e, e.run, { files: e.conflictFiles ?? [], ...scratch });
        if (told) {
          e.fix = { ...e.fix, told: true, at: this.iso() };
          this.save();
          this.armConflictTimer(e, e.run ? { id: e.run } : undefined);
        }
        continue;
      }
      if (!e.approval.standing || (e.state !== "with-chat" && !((e.state === "queued" || e.state === "checking") && e.fix))) continue;
      more = true;
      // A fix that came while its run was checking waits for that run to end.
      if (e.state === "checking") continue;
      // That run ended in line again (voided, a machine failure): the fix comes out of line until the thread checks it.
      if (e.state === "queued" && e.fix) {
        e.state = "with-chat";
        e.fix = { ...e.fix, told: false };
        const a = e.requests?.find((x) => x.id === e.fix!.request)?.answer;
        e.standing = { phase: "waiting-thread", ...(a ? { answer: a } : {}) };
        e.updatedAt = this.iso();
      }
      if (e.standing?.phase === "paused") continue;
      // The merge thread wasn't running when the chat answered Fixed, or hasn't ruled for a while (a wake into a thread
      // that crashed still reads as told): hand it the fix again. Never land unchecked, never ask the user for this.
      if (e.fix && e.fix.told && this.now() - Date.parse(e.fix.at) >= FIX_REWAKE_MS) e.fix = { ...e.fix, told: false, at: this.iso() };
      if (e.fix && !e.fix.told) {
        const r = e.requests?.find((x) => x.id === e.fix!.request);
        const a = r?.answer;
        if (r && a?.kind === "fixed") {
          const fixBase = a.commit ? await this.mergeBase(a.commit) : undefined;
          e.fix.told = this.wake("fix", e, undefined, { request: r.id, asked: r.text, ...(a.commit ? { fixCommit: a.commit } : {}), ...(a.changed !== "commit" ? { drafts: true } : {}), summary: a.summary, ...(fixBase ? { base: fixBase } : {}) });
          if (e.fix.told) this.save();
        }
        continue;
      }
      // Approved · waiting for a fix, at the same commit and drafts: once nothing blocks it, in line it goes.
      if (e.standing?.phase === "waiting-fix" && !e.fix) {
        const tip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
        if (tip !== e.commit) continue; // a new commit is a fix only once the chat answers for it
        const wt = e.worktree && existsSync(e.worktree) ? e.worktree : undefined;
        const drafts = !e.approval.withoutSpecs && wt ? await this.branchDrafts(wt, e.commit) : undefined;
        if ((drafts?.hash ?? null) !== (e.approval.drafts?.hash ?? null)) continue;
        const blocked = await this.fixBlocked(e, e.commit, drafts);
        if (!blocked) await this.requeueFix(e, e.commit);
        else if (blocked !== e.reason) {
          this.setPhase(e, { phase: "waiting-fix", why: blocked });
          e.reason = blocked;
          this.save();
        }
      }
    }
    if (more) this.armFixTimer();
  }

  /** merge.review: the review step's agent posts its verdict on the run. */
  review(runId: string, v: { verdict: string; text?: string; summary?: string; findings?: ReviewFinding[] }): Promise<MergeRun> {
    return this.serial(async () => {
      if (!["ok", "notes", "blocking"].includes(v.verdict)) throw new MergeFailure("invalid-request", 'verdict is "ok", "notes" or "blocking"');
      const cur = this.current?.run.id === runId ? this.current.run : null;
      if (!cur) throw new MergeFailure("invalid-request", `run ${runId} isn't checking now`);
      if ((v.verdict === "notes" || v.verdict === "blocking") && !v.text?.trim()) throw new MergeFailure("invalid-request", "say what the review found (text)");
      // Whole: merge.review checked its shape, and the format bounds it (§app.merge-queue/review-report).
      const report = v.text?.trim() ? { text: v.text.trim(), ...(v.summary !== undefined ? { summary: v.summary } : {}), ...(v.findings ? { findings: v.findings } : {}) } : {};
      const verdict: ReviewVerdict = { verdict: v.verdict as ReviewVerdict["verdict"], ...report, commit: cur.mergeSha ?? cur.commit, at: this.iso() };
      // The review step (review-step.ts) waits on its own; the run's awaitReview() is the other door.
      if ((this.deps.deliverReview ?? deliverReview)(runId, { verdict: verdict.verdict, ...report })) return cur;
      const w = this.reviewWaiters.get(runId);
      if (!w) throw new MergeFailure("invalid-request", `run ${runId} isn't waiting for a review`);
      this.reviewWaiters.delete(runId);
      w.resolve(verdict);
      return cur;
    });
  }

  /**
   * merge.retry: rerun now: after a machine pause, or an entry whose user's Land still stands (back with its chat),
   * put back in line at its commit and counted against its tries. Never an entry the user removed, one out of tries
   * (needs-fix) or one waiting for the user's decision: those are the user's.
   */
  retry(entryId?: string, note?: string): Promise<void> {
    return this.serial(async () => {
      if (entryId) {
        const e = this.mustEntry(entryId);
        if (e.state !== "with-chat" && e.state !== "queued") {
          const whose = WAITING_FOR_USER.includes(e.state) ? "it waits for the user's decision" : e.state === "needs-fix" ? "it is out of tries or its Land no longer stands: only the user's Land puts it back" : e.state === "cancelled" ? "the user removed it" : `it is ${e.state}`;
          throw new MergeFailure("invalid-request", `${e.branch} can't be retried: ${whose}`);
        }
        // A failure waiting for the thread's diagnosis counted its try already (awaitDiagnosis): never twice.
        if (e.state === "with-chat" && !e.ruling?.pending?.counted) {
          const t = this.countTry(e, `retry:${this.now()}`);
          if (t.out) {
            this.outOfTries(e, `Tried ${t.tries} times: ${e.reason ?? "it failed each time"}`);
            this.save();
            return;
          }
        }
        if (note !== undefined) this.setNote(e, note, "thread");
        this.clearRulingTimer(e.id);
        delete e.ruling;
        delete e.standing;
        delete e.reason;
        delete e.sentBackFor;
        delete e.sentBackDrafts;
        // Its resolution's pin went when it was sent back: one git no longer has is judged afresh by the next run.
        if (e.conflict?.commit && (await this.git(["cat-file", "-e", `${e.conflict.commit}^{commit}`], this.root)).code !== 0) {
          delete e.conflict;
          e.notes = e.notes.filter((n) => n.kind !== "resolved");
        }
        this.toFront(e);
      }
      if (this.q.paused && this.q.paused.kind !== "main-checkout-dirty") {
        delete this.q.paused;
        this.q.knownTarget = (await this.targetHead()) ?? this.q.knownTarget;
      }
      this.q.machineTries = {};
      this.holdUntil = 0;
      this.save();
      await this.pushHeld();
      this.kickSoon();
    });
  }

  private trying: { run: MergeRun; ac: AbortController; done: Promise<void> } | null = null;
  private lastTry: string | null = null;

  /**
   * merge.setup: the onboarding answer (one test command, a list of checks "Label: command", or no automated tests).
   * `dryRun` (a dry run) runs those checks on the target alone in the merge copy and answers the run (it goes on in
   * the background; merge.logs reads it); a failure there is the project's, never a branch's. Without `dryRun` the
   * answer is written into the definition's `merge` section on the target, as one commit the queue moves the target to
   * (the main folder fast-forwarded with it, never forced).
   */
  setup(req: { command?: string; commands?: string[]; none?: boolean; takesMin?: number; requires?: string[]; dryRun?: boolean }): Promise<{ run?: MergeRun; commit?: string }> {
    return this.serial(async () => {
      const kinds = [req.command ? 1 : 0, req.commands?.length ? 1 : 0, req.none ? 1 : 0].reduce((a, b) => a + b, 0);
      if (kinds !== 1) throw new MergeFailure("invalid-request", "give one answer: a test command, a list of checks, or none (no automated tests)");
      const head = await this.targetHead();
      if (!head) throw new MergeFailure("not-found", `no branch ${this.q.target} in ${this.root}`);
      // No definition yet: the answer makes a minimal one (version plus the merge section), saved the same way.
      const exists = (await this.git(["cat-file", "-e", `${head}:.sova/project.json`], this.root)).code === 0;
      let raw: Record<string, unknown> = { version: 1 };
      if (exists) {
        const shown = await this.git(["show", `${head}:.sova/project.json`], this.root);
        if (shown.code !== 0) throw new MergeFailure("busy", `can't read .sova/project.json on ${this.q.target}: ${shown.stderr.trim()}`);
        try {
          raw = JSON.parse(shown.stdout) as Record<string, unknown>;
        } catch {
          throw new MergeFailure("invalid-request", `.sova/project.json on ${this.q.target} isn't JSON`);
        }
      }
      const timeout = req.takesMin ? Math.min(HOOK_TIMEOUT_MAX, Math.max(60, req.takesMin * 60 * 2)) : undefined;
      const slug = (label: string, i: number) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `check-${i + 1}`;
      const checks = req.none
        ? ("none" as const)
        : req.command
          ? [{ id: "tests", label: "Tests", run: ["sh", "-c", req.command.trim()], ...(timeout ? { timeout } : {}), ...(req.requires?.length ? { requires: req.requires } : {}) }]
          : req.commands!.map((c, i) => {
              const m = /^\s*([^:]{1,60}):\s+(.+)$/.exec(c);
              const label = (m ? m[1]! : c.trim().split(/\s+/).slice(0, 3).join(" ")).trim().slice(0, 60);
              return { id: slug(label, i), label, run: ["sh", "-c", (m ? m[2]! : c).trim()], ...(timeout ? { timeout } : {}), ...(req.requires?.length ? { requires: req.requires } : {}) };
            });
      if (Array.isArray(checks)) {
        const ids = new Set<string>();
        for (const c of checks) {
          while (ids.has(c.id)) c.id = `${c.id}-2`;
          ids.add(c.id);
        }
      }
      const merge = { ...((raw.merge as Record<string, unknown> | undefined) ?? {}), checks };
      const text = `${JSON.stringify({ ...raw, merge }, null, 2)}\n`;
      let def: ProjectDef;
      try {
        def = parseDefinition(text);
      } catch (err) {
        throw new MergeFailure("invalid-request", `that answer doesn't make a valid definition: ${err instanceof Error ? err.message : err}`);
      }
      if (req.dryRun) {
        if (this.current || this.trying) throw new MergeFailure("busy", "a run is using the merge copy now: try again when it ends");
        const runId = newId("mr");
        const runDir = this.store.runDir(runId);
        mkdirSync(runDir, { recursive: true });
        const run: MergeRun = { id: runId, entry: "setup", project: this.id, branch: this.q.target, base: head, commit: head, steps: [], checks: [], verdict: "running", startedAt: this.iso(), why: "A dry run of the checks on the target" };
        this.store.writeRun(run);
        const ac = new AbortController();
        const stand: MergeEntry = { id: "setup", project: this.id, target: this.q.target, branch: this.q.target, commit: head, approval: { by: "land-button", at: this.iso(), commit: head }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: this.iso(), updatedAt: this.iso() };
        const input: RunInput = {
          runId,
          entry: stand,
          project: { id: this.id, root: this.root, target: this.q.target, def },
          base: head,
          commit: head,
          runDir,
          picks: [],
          review: false,
          tryOnly: true,
          signal: ac.signal,
          awaitReview: () => Promise.reject(new Error("no review in a try")),
        };
        const hooks = {
          step: (st: RunStep) => {
            const i = run.steps.findIndex((x) => x.id === st.id);
            if (i >= 0) run.steps[i] = { ...st };
            else run.steps.push({ ...st });
            this.store.writeRun(run);
          },
          checks: (list: CheckPick[]) => void (run.checks = list),
          copy: (path: string) => void (run.copy = path),
        };
        const done = (async () => {
          let out: RunOutcome;
          try {
            out = await this.deps.runMerge(input, hooks);
          } catch (err) {
            out = { verdict: "machine", why: err instanceof Error ? err.message : String(err), notes: [], checks: [] };
          }
          run.verdict = out.verdict === "passed" ? "passed" : out.verdict === "void" ? "void" : out.verdict === "machine" ? "machine" : "failed";
          run.why = out.verdict === "passed" ? `the checks pass on ${this.q.target}` : `${out.why ?? "a check failed"}: it fails on ${this.q.target} itself, so it is the project's setup to fix, not any branch's`;
          run.endedAt = this.iso();
          if (out.noChecks) run.noChecks = true;
          this.store.writeRun(run);
          await this.serial(async () => {
            this.trying = null;
            this.schedulePublish();
            this.kickSoon();
          });
        })();
        this.trying = { run, ac, done };
        this.lastTry = runId;
        this.schedulePublish();
        return { run: structuredClone(run) };
      }
      // Save: one commit on the target holding the new definition, moved to like a landing.
      if (this.q.release) throw new MergeFailure("invalid-request", `${this.q.target} stays on the release commit ${this.whileOpen()}: save the checks after Publish or Abandon`);
      const co = await checkoutOf(this.git, this.root, this.q.target);
      if (co) {
        const why = await dirtyWhy(this.git, co);
        if (why) throw new MergeFailure("invalid-request", `${why}: commit or put them away first (nothing is forced)`);
      }
      const tmp = join(this.store.dir, `setup-${Date.now()}`);
      mkdirSync(this.store.dir, { recursive: true });
      writeFileSync(`${tmp}.json`, text);
      try {
        const blob = (await this.git(["hash-object", "-w", `${tmp}.json`], this.root)).stdout.trim();
        const env = { ...process.env, GIT_INDEX_FILE: `${tmp}.index` };
        const steps: string[][] = [["read-tree", head], ["update-index", "--add", "--cacheinfo", `100644,${blob},.sova/project.json`]];
        for (const a of steps) {
          const r = await this.git(a, this.root, { env });
          if (r.code !== 0) throw new MergeFailure("busy", `git ${a[0]} failed: ${r.stderr.trim()}`);
        }
        const tree = (await this.git(["write-tree"], this.root, { env })).stdout.trim();
        const label = req.none ? "no automated tests" : req.command ? "one test command" : `${req.commands!.length} check${req.commands!.length === 1 ? "" : "s"}`;
        // Who commits: the repository's own identity, else Sova's (as the run's commits in the copy).
        const name = (await this.git(["config", "user.name"], this.root)).stdout.trim();
        const email = (await this.git(["config", "user.email"], this.root)).stdout.trim();
        const ident = name && email ? {} : { GIT_AUTHOR_NAME: name || "Sova merge queue", GIT_AUTHOR_EMAIL: email || "merge-queue@sova.invalid", GIT_COMMITTER_NAME: name || "Sova merge queue", GIT_COMMITTER_EMAIL: email || "merge-queue@sova.invalid" };
        const c = await this.git(["commit-tree", tree, "-p", head, "-m", `Merge queue: set up checks (${label})${exists ? "" : "; new .sova/project.json"}`], this.root, { env: { ...process.env, ...ident } });
        if (c.code !== 0) throw new MergeFailure("busy", `git commit-tree failed: ${c.stderr.trim()}`);
        const commit = c.stdout.trim();
        this.landing = true;
        try {
          const r = await landTip(this.git, this.root, this.q.target, head, commit);
          if (r.kind !== "landed") throw new MergeFailure("busy", r.kind === "dirty" ? r.why : `${this.q.target} moved meanwhile: try again`);
        } finally {
          this.landing = false;
        }
        this.q.landed.push(commit);
        this.q.knownTarget = commit;
        this.checksCache = null;
        // The setup commit isn't pushed on its own: it goes out with the next landing. The view says so meanwhile,
        // from the sha origin had (its remote-tracking ref), unless a push is already held for its own reason.
        if ((await this.git(["remote"], this.root)).stdout.split("\n").includes("origin")) {
          if (!this.q.heads.pushed) {
            const remote = await revParse(this.git, this.root, `refs/remotes/origin/${this.q.target}`);
            if (remote) this.q.heads.pushed = remote;
          }
          if (!this.q.heads.pushWhy) this.q.heads.pushWhy = PUSH_WAITS_NEXT_LANDING;
        }
        this.save();
        this.kickSoon();
        return { commit };
      } finally {
        rmSync(`${tmp}.json`, { force: true });
        rmSync(`${tmp}.index`, { force: true });
      }
    });
  }

  /** Why `commit` can't land without a trial (a setup branch with no passing trial of that exact commit), or null. */
  async setupUntried(head: string, commit: string): Promise<string | null> {
    const change = await setupChangeOf(this.git, this.root, head, commit);
    // Git can't tell whether it changes the setup: it waits, as a setup branch would (fail closed).
    if (!change) return SETUP_UNREADABLE;
    return isSetupChange(change) ? untriedWhy(this.q.trials, commit) : null;
  }

  /** The trials, newest first. */
  trials(): MergeTrial[] {
    return structuredClone(this.q.trials ?? []);
  }

  /**
   * merge.try: a trial of a setup branch's head (or any commit) in the merge copy. The copy is reset to that commit,
   * nothing is merged and nothing saved; the checks are that commit's own definition's (its merge checks and the
   * services they require, then its release checks). It answers at once and runs on in the background (merge.logs
   * reads its run). Refused while a landing, a run or another trial holds the copy, or while a release holds the queue.
   */
  trial(req: { branch?: string; commit?: string; checkout?: string; checks?: string[]; by: MergeTrial["by"] }): Promise<{ trial: MergeTrial; run: MergeRun }> {
    return this.serial(async () => {
      if (this.current || this.trying || this.landing) throw new MergeFailure("busy", "a landing or a run is using the merge copy now: try again when it ends");
      let branch = req.branch?.replace(/^refs\/heads\//, "");
      if (!branch && !req.commit && req.checkout) {
        const r = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], req.checkout);
        if (r.code === 0 && r.stdout.trim()) branch = r.stdout.trim();
      }
      if (!branch && !req.commit) throw new MergeFailure("invalid-request", "name the branch or the commit to try");
      const commit = req.commit ? await revParse(this.git, this.root, req.commit) : await revParse(this.git, this.root, `refs/heads/${branch}`);
      if (!commit) throw new MergeFailure("not-found", req.commit ? `no commit ${req.commit} in ${this.root}` : `no branch ${branch} in ${this.root}`);
      if (branch && req.commit) {
        const tip = await revParse(this.git, this.root, `refs/heads/${branch}`);
        if (tip && commit !== tip && !(await isAncestor(this.git, this.root, commit, tip))) throw new MergeFailure("invalid-request", `${commit.slice(0, 7)} isn't on ${branch}`);
      }
      const shown = await this.git(["show", `${commit}:.sova/project.json`], this.root);
      if (shown.code !== 0) throw new MergeFailure("invalid-request", `${commit.slice(0, 7)} has no .sova/project.json: there is nothing to try`);
      let def: ProjectDef;
      try {
        def = parseDefinition(shown.stdout);
      } catch (err) {
        throw new MergeFailure("invalid-request", `.sova/project.json at ${commit.slice(0, 7)} is invalid: ${err instanceof Error ? err.message : err}`);
      }
      // No merge checks declared: the trial is the copy and the setup alone, as "no automated tests" is.
      if (this.deps.checksOf(def) === "unset") def = { ...def, merge: { ...(def.merge ?? {}), checks: "none" } } as ProjectDef;
      // Release checks are long: a trial runs those new or changed against the target's release section, and the ones
      // named for it; the rest are reported not run (unchanged).
      const onTarget = (await this.declared()).def?.release?.checks ?? [];
      const { run: releaseRun, notRun } = trialReleaseChecks(def.release?.checks ?? [], onTarget, req.checks ?? []);
      const unknown = (req.checks ?? []).filter((id) => !(def.release?.checks ?? []).some((c) => c.id === id) && !(Array.isArray(def.merge?.checks) && def.merge.checks.some((c) => c.id === id)));
      if (unknown.length) throw new MergeFailure("invalid-request", `${commit.slice(0, 7)} declares no check ${unknown.map((u) => `"${u}"`).join(", ")}`);
      const runId = newId("mr");
      const runDir = this.store.runDir(runId);
      mkdirSync(runDir, { recursive: true });
      const label = branch ?? commit.slice(0, 7);
      const run: MergeRun = { id: runId, entry: "trial", project: this.id, branch: label, base: commit, commit, steps: [], checks: [], verdict: "running", startedAt: this.iso(), why: `Trial of ${label}` };
      this.store.writeRun(run);
      const trial: MergeTrial = { run: runId, commit, ...(branch ? { branch } : {}), verdict: "running", by: req.by, startedAt: run.startedAt, ...(notRun.length ? { notRun: notRun.map((c) => ({ id: c.id, label: c.label })) } : {}) };
      this.q.trials = [trial, ...(this.q.trials ?? []).filter((t) => t.run !== runId)].slice(0, MERGE_TRIALS_KEPT);
      this.save();
      const ac = new AbortController();
      const stand: MergeEntry = { id: "trial", project: this.id, target: this.q.target, branch: label, commit, approval: { by: "land-button", at: this.iso(), commit }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: this.iso(), updatedAt: this.iso() };
      const input: RunInput = {
        runId,
        entry: stand,
        project: { id: this.id, root: this.root, target: this.q.target, def },
        base: commit,
        commit,
        runDir,
        // A trial runs every proposed check, the optional ones too.
        picks: optionalPicks(def),
        review: false,
        tryOnly: true,
        trialOf: label,
        ...(releaseRun.length ? { releaseChecks: releaseRun } : {}),
        signal: ac.signal,
        awaitReview: () => Promise.reject(new Error("no review in a trial")),
      };
      const hooks = {
        step: (st: RunStep) => {
          const i = run.steps.findIndex((x) => x.id === st.id);
          if (i >= 0) run.steps[i] = { ...st };
          else run.steps.push({ ...st });
          this.store.writeRun(run);
        },
        checks: (list: CheckPick[]) => void (run.checks = list),
        copy: (path: string) => void (run.copy = path),
      };
      const done = (async () => {
        let out: RunOutcome;
        try {
          out = await this.deps.runMerge(input, hooks);
        } catch (err) {
          out = { verdict: "machine", why: err instanceof Error ? err.message : String(err), notes: [], checks: [] };
        }
        run.verdict = out.verdict === "passed" ? "passed" : out.verdict === "void" ? "void" : out.verdict === "machine" ? "machine" : "failed";
        run.why = out.verdict === "passed" ? `the proposed checks pass on ${label} at ${commit.slice(0, 7)}` : (out.why ?? "a check failed");
        run.endedAt = this.iso();
        if (out.noChecks) run.noChecks = true;
        this.store.writeRun(run);
        await this.serial(async () => {
          const t = (this.q.trials ?? []).find((x) => x.run === runId);
          if (t) {
            t.verdict = run.verdict === "passed" ? "passed" : run.verdict === "void" ? "void" : run.verdict === "machine" ? "machine" : "failed";
            t.why = run.why;
            t.endedAt = run.endedAt;
            this.save();
            if (t.verdict !== "void") this.deps.trialEnded?.(structuredClone(t), structuredClone(run), this.root);
          }
          this.trying = null;
          this.schedulePublish();
          this.kickSoon();
        });
      })();
      this.trying = { run, ac, done };
      this.schedulePublish();
      return { trial: structuredClone(trial), run: structuredClone(run) };
    });
  }

  /** Tests: the dry run in flight, if any. */
  tryingNow(): Promise<void> | null {
    return this.trying?.done ?? null;
  }

  private mustEntry(id: string): Entry {
    const e = this.entry(id);
    if (!e) this.refuseHistory(id);
    if (!e) throw new MergeFailure("not-found", `no queue entry ${id}`);
    return e;
  }

  // ---- running ----------------------------------------------------------------------------------

  /** Start the next run when nothing runs and the queue isn't paused. */
  kickSoon(): void {
    if (this.stopped) return;
    queueMicrotask(() => void this.serial(() => this.startNext()).catch((err) => this.log(`start failed: ${err instanceof Error ? err.stack : err}`)));
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private async startNext(): Promise<void> {
    await this.startNextRun();
    this.wakeIdle();
  }

  /** Nothing left to check and nothing running: the thread hears it once per busy stretch (`idle`). An entry waiting for
   *  the user (a judgement, a review) is not checked by the queue and doesn't keep it busy; a conflict waiting for the
   *  thread's judgement does. */
  private wakeIdle(): void {
    if (!this.idleOwed || this.stopped || this.current || this.trying || this.landing) return;
    // A conflict the thread is judging holds the idle back; one waiting for a thread that isn't there doesn't.
    if (this.q.entries.some((e) => e.state === "queued" || e.state === "checking" || (e.state === "conflict" && e.fix?.request !== CONFLICT_WAIT))) return;
    const last = this.entry(this.idleOwed);
    this.idleOwed = null;
    if (!last) return;
    const landed = this.newestLanded();
    this.wake("idle", last, undefined, {
      ...(landed ? { lastLanded: { id: landed.id, branch: landed.branch, sha: landed.landed!.sha } } : {}),
      ...(this.q.knownTarget ? { head: this.q.knownTarget } : {}),
    });
  }

  /** The queue's newest landing, if any. */
  private newestLanded(): Entry | undefined {
    return this.q.entries.filter((e) => e.state === "landed" && e.landed).sort((a, b) => (a.landed!.at < b.landed!.at ? 1 : a.landed!.at > b.landed!.at ? -1 : 0))[0];
  }

  // ---- the merge thread's hold (merge.hold) -------------------------------------------------------

  /** Whether the thread's hold keeps new runs from starting now; an expired one is lifted here. */
  private held(): boolean {
    const h = this.q.hold;
    if (!h) return false;
    if (h.until <= this.now()) {
      this.liftHold();
      this.log("the merge thread's hold expired");
      return false;
    }
    let changed = false;
    for (const e of this.queued()) {
      if (e.reason === HOLD_WORDS) continue;
      e.reason = HOLD_WORDS;
      changed = true;
    }
    if (changed) this.save();
    if (!this.holdKick) {
      this.holdKick = true;
      this.later(Math.max(0, h.until - this.now()) + 10, () => {
        this.holdKick = false;
        this.kickSoon();
      });
    }
    return true;
  }

  private liftHold(): boolean {
    if (!this.q.hold) return false;
    delete this.q.hold;
    for (const e of this.queued()) if (e.reason === HOLD_WORDS) delete e.reason;
    this.save();
    return true;
  }

  /** merge.hold (the merge thread's): `set` holds every new run for HOLD_MS (set again: renewed); `clear` lifts it.
   *  A run already checking or landing goes on. Answers whether anything changed and the hold now. */
  hold(action: "set" | "clear"): Promise<{ changed: boolean; hold: { at: string; until: string } | null }> {
    return this.serial(async () => {
      let changed: boolean;
      if (action === "set") {
        this.q.hold = { at: this.iso(), until: this.now() + HOLD_MS };
        this.save();
        this.log("held by the merge thread");
        changed = true;
      } else {
        changed = this.liftHold();
        if (changed) this.log("lifted the merge thread's hold");
      }
      this.kickSoon();
      return { changed, hold: this.holdNow() };
    });
  }

  /** The thread's hold as the verb answers it, or null. */
  holdNow(): { at: string; until: string } | null {
    const h = this.q.hold;
    return h && h.until > this.now() ? { at: h.at, until: new Date(h.until).toISOString() } : null;
  }

  private async startNextRun(): Promise<void> {
    if (this.stopped || this.current || this.trying || this.landing) return;
    // A settings card held for the branch just checked, then a settings save, go before the next branch starts on the target.
    await this.quietCards();
    if (this.q.pendingSave) await this.applyPendingSave();
    if (this.q.paused) return;
    if (this.holdUntil > this.now()) return;
    if (this.held()) return;
    const head = await this.targetHead();
    if (!head) return;
    const line = this.releaseLine(this.queued());
    if (this.q.knownTarget && head !== this.q.knownTarget) {
      if (line.length) {
        this.pauseNow("master-moved", `${this.q.target} moved outside the queue (${this.q.knownTarget.slice(0, 7)} → ${head.slice(0, 7)}): resume once that is intended`);
        return;
      }
    }
    if (this.q.knownTarget !== head) {
      this.q.knownTarget = head;
      this.save();
    }
    // The definition doesn't parse: nothing is checked against a guess. Only a branch that fixes it runs (checked by its
    // own declaration); with none in line the queue pauses and says why.
    const invalid = line.length ? (await this.declared()).invalid : undefined;
    for (const e of line) {
      const own = invalid ? await this.fixesDefinition(e.commit) : null;
      if (invalid && !own) continue;
      // Drafts changed since the user's approval: wait for a new Land.
      if (e.approval.drafts && !e.approval.withoutSpecs && this.deps.draftsHash) {
        const now = e.worktree && existsSync(e.worktree) ? await this.branchDrafts(e.worktree, e.commit) : undefined;
        if (now?.hash !== e.approval.drafts.hash) {
          e.state = "drafts-changed";
          e.reason = now ? "drafts changed since you approved" : "its worktree is gone, so its approved drafts can't be copied";
          e.updatedAt = this.iso();
          // Under the user's standing Land (q8): drafts re-pin with no new Land only as a fix the chat answered Fixed to
          // the queue's request and the thread checked. Drafts that changed with no such answer (the user's edit, or the
          // chat's own) wait for the user: one decision, Land taking them as they are now.
          if (now && e.approval.standing && !e.release) {
            this.raiseDecision(e, { kind: "drafts-changed", question: `${e.branch}'s spec drafts changed since your Land, and not as a fix the merge queue asked for: Land takes them as they are now`, choices: [], raisedBy: "queue", actions: ["land", "remove"] });
            continue;
          }
          this.save();
          this.deps.notify?.("drafts-changed", e, { root: this.root });
          continue;
        }
      }
      // A branch that lands by request or push is tested against the host's target as it is now (al_3 b2): origin's,
      // fetched just before, never the local one (which only Update Local Main moves).
      let base = head;
      if (publishes(approvalHow(e.approval))) {
        const f = await fetchTarget(this.git, this.root, this.q.target);
        if ("why" in f) {
          const tries = (this.q.machineTries[e.id] ?? 0) + 1;
          this.q.machineTries[e.id] = tries;
          e.reason = f.why;
          e.updatedAt = this.iso();
          if (tries <= 1) {
            this.holdUntil = this.now() + (this.deps.retryDelayMs ?? 60_000);
            this.save();
            this.later(this.deps.retryDelayMs ?? 60_000, () => this.kickSoon());
          } else this.pauseNow("machine", `${f.why}: ${e.branch} can't be tested against origin's ${this.q.target}. No branch is blamed.`);
          return;
        }
        base = f.sha;
      }
      await this.startRun(e, base, own ?? undefined, head);
      return;
    }
    if (invalid) this.pauseNow("definition-invalid", invalidWords(invalid));
  }

  /** The definition at `commit` when it parses and declares checks (a branch that fixes an invalid one); else null. */
  private async fixesDefinition(commit: string): Promise<ProjectDef | null> {
    const at = await this.deps.definitionAt(this.root, commit).catch(() => ({ def: null, error: "unreadable" }));
    return at.def && this.deps.checksOf(at.def) !== "unset" ? at.def : null;
  }

  /**
   * The branch's own spec drafts in its worktree, hashed: an untracked draft is the branch's (as ever); a draft tracked
   * in Git is the branch's only when the branch adds or changes it (`target...commit` touches it). Drafts already on
   * the target and left alone are never hashed, named, landed or deleted. undefined: the branch has none.
   */
  private async branchDrafts(wt: string, commit: string): Promise<{ hash: string; names: string[] } | undefined> {
    const all = this.deps.draftsHash?.(wt);
    if (!all) return undefined;
    const dir = ".sova/spec/drafts/";
    const nameOf = (path: string) => (path.startsWith(dir) ? path.slice(dir.length).split("/")[0] : undefined);
    const tracked = new Set<string>();
    for (const ref of [commit, `refs/heads/${this.q.target}`]) {
      const r = await this.git(["ls-tree", "-r", "--name-only", ref, "--", dir], this.root);
      if (r.code === 0) for (const l of r.stdout.split("\n")) { const n = nameOf(l.trim()); if (n) tracked.add(n); }
    }
    if (!all.names.some((n) => tracked.has(n))) return { hash: all.hash, names: all.names };
    const changed = new Set<string>();
    const d = await this.git(["diff", "--name-only", `refs/heads/${this.q.target}...${commit}`, "--", dir], this.root);
    if (d.code !== 0) throw new MergeFailure("busy", `git diff of ${commit.slice(0, 7)}'s drafts failed: ${d.stderr.trim()}`);
    for (const l of d.stdout.split("\n")) { const n = nameOf(l.trim()); if (n) changed.add(n); }
    const names = all.names.filter((n) => !tracked.has(n) || changed.has(n));
    if (!names.length) return undefined;
    if (names.length === all.names.length) return { hash: all.hash, names };
    const hash = createHash("sha256").update(names.map((n) => `${n} ${all.each?.[n] ?? ""}`).join("\n")).digest("hex");
    return { hash, names };
  }

  /** `own`: the branch's own definition, when the target's doesn't parse and this branch fixes it. */
  private async startRun(e: Entry, base: string, own?: ProjectDef, localBase: string = base): Promise<void> {
    this.idleOwed = e.id;
    const declared = await this.declared();
    const d = own ? { ...declared, def: own, review: (this.deps.hasReviewKit ?? ((x) => !!x?.merge?.review))(own, this.root) } : declared;
    const runId = newId("mr");
    const runDir = this.store.runDir(runId);
    mkdirSync(runDir, { recursive: true });
    const left = await this.leftOf(e.branch, e.commit, e.worktree, base);
    let draftsDir: string | undefined;
    if (e.approval.drafts && !e.approval.withoutSpecs && e.worktree) {
      draftsDir = join(runDir, "drafts");
      // A draft proved landed has landed: never tried again (§chat.worktrees/ready-to-land). An unread answer tries them all.
      for (const n of e.approval.drafts.names.filter((x) => !left || left.drafts.includes(x))) {
        const from = join(e.worktree, ".sova", "spec", "drafts", n);
        if (existsSync(from)) cpSync(from, join(draftsDir, n), { recursive: true });
      }
    }
    const run: MergeRun = { id: runId, entry: e.id, project: this.id, branch: e.branch, base, commit: e.commit, steps: [], checks: [], verdict: "running", startedAt: this.iso() };
    e.state = "checking";
    e.run = runId;
    this.reviewEvent(e, { kind: "checking" });
    // Only the first run meets the conflict that was there at the Land; a later run (another target, a fix) counts.
    if (e.runs.length > 0) delete e.approval.conflictAtLand;
    e.runs = [...e.runs, runId];
    delete e.reason;
    delete e.unclear;
    e.updatedAt = this.iso();
    this.store.writeRun(run);
    const ac = new AbortController();
    const cur: Current = { run, entry: e.id, ac, voidWhy: null, watch: null, done: Promise.resolve(), localBase };
    this.current = cur;
    this.save();
    this.log(`run ${runId}: ${e.branch} at ${e.commit.slice(0, 7)} onto ${this.q.target} ${base.slice(0, 7)}`);
    this.releaseEvent(e, "checking", undefined, runId);
    const resolution = e.conflict?.commit && (e.conflict.verdict === "no-behaviour-change" || e.notes.some((n) => n.kind === "resolved")) ? e.conflict.commit : undefined;
    const input: RunInput = {
      runId,
      entry: structuredClone(e),
      project: { id: this.id, root: this.root, target: this.q.target, def: d.def },
      base,
      commit: e.commit,
      ...(resolution ? { resolution } : { landingPins: this.landingsOf(e.branch).pins }),
      runDir,
      ...(draftsDir ? { draftsDir } : {}),
      picks: [...e.picks],
      // A tag-only release's entry is the frozen target itself: its checks run there, nothing is merged or moved.
      ...(this.tagOnly(e, base) ? { tryOnly: true as const } : {}),
      ...(e.release && e.releaseKind === "release" && this.q.release?.id === e.release && this.q.release.checks?.length ? { releaseChecks: structuredClone(this.q.release.checks) } : {}),
      ...(this.names().exists ? { namesFile: this.names().file } : {}),
      review: d.review && !e.approval.withoutReview,
      signal: ac.signal,
      awaitReview: () =>
        new Promise<ReviewVerdict>((resolve, reject) => {
          if (ac.signal.aborted) return reject(new Error("aborted"));
          this.reviewWaiters.set(runId, { resolve, reject });
          ac.signal.addEventListener("abort", () => {
            this.reviewWaiters.delete(runId);
            reject(new Error("aborted"));
          });
        }),
    };
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        if (this.current?.run.id === runId) this.store.writeRun(run);
        this.schedulePublish();
      }, 100);
    };
    const hooks = {
      step: (s: RunStep) => {
        const i = run.steps.findIndex((x) => x.id === s.id);
        if (i >= 0) run.steps[i] = { ...s };
        else run.steps.push({ ...s });
        persist();
      },
      checks: (list: CheckPick[]) => {
        run.checks = list.map((c) => ({ ...c }));
        persist();
      },
      merged: (sha: string) => {
        run.mergeSha = sha;
        persist();
      },
      copy: (path: string) => {
        run.copy = path;
        persist();
      },
    };
    // The target moving under a run voids it (the queue pauses and flags it).
    cur.watch = setInterval(() => {
      void (async () => {
        if (this.current !== cur || cur.voidWhy || this.landing) return;
        const h = await this.targetHead();
        if (h && h !== cur.localBase && this.current === cur && !this.landing && !cur.voidWhy) {
          cur.voidWhy = "master-moved";
          cur.ac.abort();
        }
      })();
    }, this.deps.watchMs ?? 2000);
    cur.watch.unref?.();
    cur.done = (async () => {
      let out: RunOutcome;
      try {
        out = await this.deps.runMerge(input, hooks);
      } catch (err) {
        out = { verdict: "machine", why: `the run failed: ${err instanceof Error ? err.message : String(err)}`, notes: [], checks: run.checks };
      }
      if (persistTimer) clearTimeout(persistTimer);
      await this.serial(() => this.finish(cur, out));
    })();
  }

  private async finish(cur: Current, out: RunOutcome): Promise<void> {
    if (cur.watch) clearInterval(cur.watch);
    const run = cur.run;
    const w = this.reviewWaiters.get(run.id);
    if (w) {
      this.reviewWaiters.delete(run.id);
      w.reject(new Error("run ended"));
    }
    run.endedAt = this.iso();
    if (out.mergeSha) run.mergeSha = out.mergeSha;
    if (out.tip) run.tip = out.tip;
    if (out.copy) run.copy = out.copy;
    if (out.checks?.length) run.checks = out.checks;
    if (out.noChecks) run.noChecks = true;
    if (out.blame) run.blame = out.blame;
    if (out.why) run.why = out.why;
    if (out.targetRed) this.q.heads.targetRed = out.targetRed;
    else if (out.verdict === "passed") delete this.q.heads.targetRed;
    // A run the queue voided (the target moved, a stop, a cancel) proves nothing about a broken check.
    this.noteBroken(run, cur.voidWhy ? { ...out, verdict: "void", broken: [] } : out);
    const e = this.entry(cur.entry);
    this.current = null;
    if (!e) {
      run.verdict = "void";
      this.store.writeRun(run);
      this.save();
      this.kickSoon();
      return;
    }
    if (cur.voidWhy || e.state === "cancelled") {
      const why = cur.voidWhy ?? "cancelled";
      run.verdict = why === "cancelled" ? "cancelled" : "void";
      run.why = why === "master-moved" ? `${this.q.target} moved outside the queue` : why === "superseded" ? "approved again at a newer commit" : why === "stopping" ? "Sova stopped" : why === "release" ? "a release started: it waits for the release" : "cancelled";
      this.store.writeRun(run);
      if (why === "master-moved" && e.state === "checking") {
        this.toFront(e);
        const head = await this.targetHead();
        this.pauseNow("master-moved", `${this.q.target} moved outside the queue (${run.base.slice(0, 7)} → ${(head ?? "?").slice(0, 7)}) while ${e.branch} was checking: that run was voided; resume once that is intended`, run.id);
      } else if ((why === "stopping" || why === "release") && e.state === "checking") {
        this.toFront(e);
        if (why === "release") e.reason = this.waitingWords();
      }
      this.save();
      this.kickSoon();
      return;
    }
    // The review card of the entry's last blocking review follows this run (never a voided one): a new review answered,
    // or the run stopped before one.
    if (out.verdict === "failed" || out.verdict === "conflict") this.reviewEvent(e, { kind: "stopped", why: stoppedWhy(out, this.q.target) });
    else if (out.review && out.verdict !== "machine") this.reviewEvent(e, { kind: "reviewed", verdict: out.review.verdict });
    switch (out.verdict) {
      case "nothing":
        // A landing that changes nothing stops here: not sent back, nothing blamed, and the target never moved.
        run.verdict = "cancelled";
        this.store.writeRun(run);
        e.state = "cancelled";
        e.reason = out.why ?? nothingToLandWords(this.q.target);
        e.updatedAt = this.iso();
        this.save();
        this.deps.notify?.("nothing-to-land", e, { run, root: this.root });
        this.releaseEvent(e, "cancelled", undefined, run.id);
        this.kickSoon();
        return;
      case "void":
        run.verdict = "void";
        this.store.writeRun(run);
        this.toFront(e);
        this.save();
        this.kickSoon();
        return;
      case "machine": {
        run.verdict = "machine";
        run.blame = out.blame ?? "machine";
        this.store.writeRun(run);
        const tries = (this.q.machineTries[e.id] ?? 0) + 1;
        this.q.machineTries[e.id] = tries;
        this.toFront(e);
        e.reason = out.why ?? "a machine failure";
        if (tries <= 1) {
          this.holdUntil = this.now() + (this.deps.retryDelayMs ?? 60_000);
          this.save();
          this.later(this.deps.retryDelayMs ?? 60_000, () => this.kickSoon());
        } else {
          const kind: PauseKind = out.blame === "reviewer" ? "reviewer" : "machine";
          this.pauseNow(kind, `${kind === "reviewer" ? "The reviewer" : "Setup or the machine"} failed twice, on ${this.q.target} alone too: ${out.why ?? "see the run's log"}. No branch is blamed.`, run.id);
          this.wake("paused", e, run.id, { why: out.why ?? "machine failure" });
        }
        return;
      }
      case "conflict": {
        run.verdict = "conflict";
        this.store.writeRun(run);
        if (e.release) {
          // A release's commit was cut from the frozen target: a conflict is a fault of the release, never judged.
          this.handBack(e, run, `the release commit conflicts with ${this.q.target}${out.conflict?.files?.length ? ` in ${out.conflict.files.slice(0, 3).join(", ")}` : ""}`, "conflict");
          this.kickSoon();
          return;
        }
        // The thread's scratch copy, made by Sova at the target's head (the thread never makes its own), before the
        // entry reads as a conflict: once it does, the thread has been told where to work. Only when a thread is there.
        const scratch = this.deps.thread ? await this.makeScratch(e, (await this.targetHead()) ?? run.base) : {};
        e.state = "conflict";
        const files = out.conflict?.files ?? [];
        delete e.conflict;
        e.conflictFiles = files;
        e.reason = `conflicts with ${this.q.target}${files.length ? ` in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` : ""}`;
        e.updatedAt = this.iso();
        this.save();
        if (e.ruling?.resolutionFailed) delete e.ruling.resolutionFailed;
        const asked = this.wake("conflict", e, run.id, { files, ...scratch });
        // No thread took it: under the user's standing Land the conflict waits for the merge thread (q14), never sent to the
        // chat unjudged (q3); it is handed to the thread again once it runs. An approval from before the standing Land
        // goes back to its chat at once, as it did.
        if (!asked && e.approval.standing) this.waitForThread(e);
        else if (!asked) this.sendBack(e, { cause: "conflict", why: `${e.reason}; no merge thread is there to judge it`, runId: run.id, files });
        else this.armConflictTimer(e, run);
        this.kickSoon();
        return;
      }
      case "failed": {
        run.verdict = "failed";
        this.store.writeRun(run);
        const why = out.why ?? "a check failed with your branch and passes on the target";
        if (out.blame === "resolution") await this.resolutionFailed(e, run, out.why ?? "a check");
        else if (e.release || !e.approval.standing) {
          this.handBack(e, run, why, out.cause ?? "checks");
          this.wake("failed", e, run.id, { why: out.why ?? "failed" });
        } else {
          // The branch's: the thread is asked for its diagnosis first; the request waits for it (at most rulingWaitMs).
          const cause: SentBackFor = out.cause ?? "checks";
          const asked = this.wake("failed", e, run.id, { why: out.why ?? "failed" });
          if (asked) this.awaitDiagnosis(e, { cause, why, run: run.id, at: this.iso() });
          else this.sendBack(e, { cause, why, runId: run.id });
        }
        delete this.q.machineTries[e.id];
        this.kickSoon();
        return;
      }
      case "unattributed": {
        // Land Anyway said yes to exactly this: the rerun again can't tell, so its tested tip lands.
        if (e.approval.overUnattributed && run.tip) {
          run.verdict = "passed";
          this.store.writeRun(run);
          this.addNotes(e, out.notes);
          await this.landTested(e, run);
          return;
        }
        run.verdict = "waiting";
        this.store.writeRun(run);
        e.state = "unattributed";
        e.reason = out.why ?? `a check failed on the merge and on ${e.target} alone`;
        if (out.unclear?.length) e.unclear = out.unclear.map((u) => ({ check: u.check, label: u.label, run: run.id, step: u.step, ...(u.why ? { why: u.why } : {}) }));
        this.addNotes(e, out.notes);
        if (out.targetRed?.length) this.q.heads.targetRed = [...out.targetRed];
        e.updatedAt = this.iso();
        this.save();
        this.releaseEvent(e, "waiting", e.reason, run.id);
        if (!e.release) {
          // Never the branch's, and nothing goes to its chat. The thread rules first (q3), within the same wait as a
          // send-back's diagnosis: chat-fixes or try-again settle it with no word to the user. No ruling, no thread, or
          // needs-user: the user decides, one decision and one notification, and from then on only the user settles it.
          const asked = this.wake("unattributed", e, run.id, { why: e.reason });
          if (asked) {
            e.ruling = { ...(e.ruling ?? {}), unattributed: { run: run.id, at: this.iso() } };
            this.save();
            this.armRulingTimer(e.id, () => {
              const x = this.entry(e.id);
              if (x?.state === "unattributed" && x.ruling?.unattributed) this.raiseUnattributed(x, x.ruling.unattributed.run);
            });
          } else this.raiseUnattributed(e, run.id);
        }
        this.kickSoon();
        return;
      }
      case "review-flagged": {
        if (!e.release && e.approval.standing) {
          // Its whole report goes to the merge thread first, which hands it on (merge.rule chat-fixes, its note optional);
          // Sova writes the request from the saved record. With no thread, or after the wait, it goes by itself.
          run.verdict = "failed";
          this.store.writeRun(run);
          if (out.review) e.review = out.review;
          this.addNotes(e, out.notes);
          const rec = reviewRecord({ entry: e.id, run: run.id, commit: e.commit, base: run.base, verdict: out.review ?? { verdict: "blocking", text: "the review flagged it", commit: run.tip ?? e.commit, at: this.iso() }, at: this.iso() });
          e.reviews = [...(e.reviews ?? []), rec].slice(-REVIEWS_KEPT);
          const why = `the review flagged it: ${rec.summary.slice(0, 160) || "see its findings"}`;
          const report = reportText(rec);
          // Its try would run out (the last one, or the same findings twice): it waits for the user, nothing to hand on.
          const waits = this.triesOut(e, this.failurePrint({ cause: "review", why, review: report }, run, rec.findings));
          if (waits) {
            this.sendBack(e, { cause: "review", why, runId: run.id, review: report });
            this.wake("review", e, run.id, { findings: report, waits });
          } else {
            const asked = this.wake("review", e, run.id, { findings: report });
            if (asked) this.awaitDiagnosis(e, { cause: "review", why, run: run.id, review: report, at: this.iso() });
            else this.sendBack(e, { cause: "review", why, runId: run.id, review: report });
          }
          this.kickSoon();
          return;
        }
        run.verdict = "waiting";
        this.store.writeRun(run);
        e.state = "review-flagged";
        if (out.review) e.review = out.review;
        e.reason = `the review flagged it${out.review?.text ? `: ${out.review.text.split("\n")[0]!.slice(0, 160)}` : ""}`;
        this.addNotes(e, out.notes);
        e.updatedAt = this.iso();
        this.save();
        this.releaseEvent(e, "waiting", e.reason, run.id);
        this.kickSoon();
        return;
      }
      case "passed": {
        run.verdict = "passed";
        this.store.writeRun(run);
        if (out.review) e.review = out.review;
        this.addNotes(e, out.notes);
        if (out.noChecks && !e.notes.some((n) => n.kind === "no-checks")) e.notes.push({ kind: "no-checks", text: "No checks declared", at: this.iso() });
        delete this.q.machineTries[e.id];
        // A tag-only release lands nothing: what passed is the target as it stands.
        if (this.tagOnly(e, run.base)) run.tip = run.base;
        if (!run.tip) {
          run.verdict = "machine";
          run.why = "the run passed but named no tip to land";
          this.store.writeRun(run);
          this.toFront(e);
          this.pauseNow("machine", run.why, run.id);
          return;
        }
        await this.landTested(e, run);
        return;
      }
    }
  }

  /**
   * The broken-on-target flags (heads.targetBroken): one this run found is added (and the user told once, by
   * notification), one it ran tests with again is lifted. A void or cancelled run proves nothing either way.
   */
  private noteBroken(run: MergeRun, out: RunOutcome): void {
    const had = this.q.heads.targetBroken ?? [];
    const found = out.broken ?? [];
    const ranTests = (id: string) =>
      run.steps.some((s) => s.id === `check:${id}` && (s.result === "passed" || (s.counts && (s.counts.passed ?? 0) + (s.counts.failed ?? 0) > 0)));
    const kept = out.verdict === "void" ? had : had.filter((b) => found.some((f) => f.check === b.check) || !ranTests(b.check));
    const fresh = found.filter((f) => !kept.some((b) => b.check === f.check));
    const next = [...kept.map((b) => ({ ...b, ...(found.find((f) => f.check === b.check) ? { why: found.find((f) => f.check === b.check)!.why, run: run.id } : {}) })), ...fresh.map((f) => ({ check: f.check, label: f.label, why: f.why, run: run.id, step: f.step, at: this.iso() }))];
    if (next.length) this.q.heads.targetBroken = next;
    else delete this.q.heads.targetBroken;
    for (const f of fresh) {
      this.log(`${f.why} (run ${run.id})`);
      this.deps.flagBroken?.({ ...f, run: run.id, at: this.iso() }, this.root);
    }
  }

  private addNotes(e: Entry, notes: MergeNote[] | undefined): void {
    for (const n of notes ?? []) if (!e.notes.some((x) => x.kind === n.kind && x.text === n.text)) e.notes.push({ ...n, text: n.text.slice(0, NOTE_MAX) });
  }

  private handBack(e: Entry, run: MergeRun | undefined, why: string, cause: SentBackFor): void {
    this.clearConflictTimer(e.id);
    e.state = "needs-fix";
    e.sentBackFor = cause;
    const print = cause === "drafts" && e.worktree && existsSync(e.worktree) ? this.deps.draftsFingerprint?.(e.worktree) : undefined;
    if (print !== undefined) e.sentBackDrafts = print;
    else delete e.sentBackDrafts;
    e.reason = why;
    e.updatedAt = this.iso();
    this.save();
    this.deps.notify?.("needs-fix", e, { ...(run ? { run, logDir: this.store.runDir(run.id) } : {}), root: this.root });
    this.releaseEvent(e, "failed", why, run?.id);
  }

  private armConflictTimer(e: Entry, run?: Pick<MergeRun, "id">): void {
    this.clearConflictTimer(e.id);
    const ms = this.deps.conflictWaitMs ?? 20 * 60_000;
    const t = setTimeout(() => {
      this.conflictTimers.delete(e.id);
      void this.serial(async () => {
        const x = this.entry(e.id);
        if (x?.state !== "conflict") return;
        // The thread's own resolution failed and it didn't rule again: never the branch's, so the user decides.
        if (x.ruling?.resolutionFailed && run) this.raiseResolutionFailed(x, run.id);
        // No ruling in time: the thread is handed it again (q14); under the standing Land it never goes to the chat unjudged.
        else if (x.approval.standing) {
          this.waitForThread(x);
          this.armFixTimer(0);
        } else this.sendBack(x, { cause: "conflict", why: `${x.reason ?? "a conflict"}; the merge thread didn't judge it in time`, ...(run ? { runId: run.id } : {}), files: x.conflictFiles ?? [] });
      });
    }, ms);
    t.unref?.();
    this.conflictTimers.set(e.id, t);
  }

  /**
   * A resolution the thread judged safe failed a check: never the branch's, and nothing goes to its chat. The thread is
   * told, with a fresh scratch copy, and rules again (another resolution, the chat fixes it, or the user); with no
   * thread, or none in time, the user decides.
   */
  private async resolutionFailed(e: Entry, run: MergeRun, why: string): Promise<void> {
    const files = e.conflict?.files ?? e.conflictFiles ?? [];
    e.conflictFiles = files;
    e.reason = `the merge thread's resolution failed: ${why}; your branch isn't blamed`;
    if (e.release) {
      this.raiseResolutionFailed(e, run.id);
      return;
    }
    const scratch = this.deps.thread ? await this.makeScratch(e, (await this.targetHead()) ?? run.base) : {};
    e.state = "conflict";
    e.ruling = { ...(e.ruling ?? {}), resolutionFailed: true };
    e.updatedAt = this.iso();
    this.save();
    const asked = this.wake("resolution-failed", e, run.id, { files, why, ...scratch });
    if (asked) this.armConflictTimer(e, run);
    else this.raiseResolutionFailed(e, run.id);
  }

  private raiseResolutionFailed(e: Entry, run: string): void {
    const c = e.conflict;
    if (e.ruling) delete e.ruling.resolutionFailed;
    if (c) e.conflict = { ...c, verdict: "behaviour-differs" };
    delete e.conflict?.commit;
    this.raiseDecision(
      e,
      {
        kind: "behaviour-differs",
        question: `The merge thread's resolution of ${e.branch}'s conflict with ${e.target}${c?.files.length ? ` in ${c.files.join(", ")}` : ""} failed a check. How should it be resolved?`,
        choices: [],
        raisedBy: "queue",
        actions: [],
        run,
        ...(c ? { sides: { ours: c.ours, theirs: c.theirs, proposal: c.proposal } } : {}),
        heldNote: { request: newId("rq"), text: `The user decides how ${e.branch}'s conflict with ${e.target} is resolved; their answer comes with this note. Merge ${e.target} into ${e.branch}, resolve it their way, and commit; then answer this request Fixed.` },
      },
      "behaviour-differs",
      e.reason,
    );
  }
  private clearConflictTimer(id: string): void {
    const t = this.conflictTimers.get(id);
    if (t) clearTimeout(t);
    this.conflictTimers.delete(id);
  }

  /** Land a passed run's tip (the entry is `checking`). */
  async landTested(e: Entry, run: MergeRun): Promise<void> {
    // Landing by request or by push (al_3): the target never moves here; the tested work is published instead.
    if (publishes(approvalHow(e.approval))) return this.landByRequest(e, run);
    const tip = run.tip!;
    const d = await this.declared();
    this.landing = true;
    try {
      const pre = await canLand(this.git, this.root, this.q.target, run.base);
      if (pre?.kind === "dirty") {
        e.state = "checking";
        e.reason = `tested; waiting to land: ${pre.why}`;
        this.pauseNow("main-checkout-dirty", `${run.branch} passed, but ${pre.why}: it lands once the folder is clean and you resume (never forced)`, run.id);
        return;
      }
      if (pre?.kind === "moved") {
        run.verdict = "void";
        run.why = `${this.q.target} moved outside the queue before the landing`;
        this.store.writeRun(run);
        this.toFront(e);
        this.pauseNow("master-moved", `${this.q.target} moved outside the queue (${run.base.slice(0, 7)} → ${(pre.head ?? "?").slice(0, 7)}) before ${e.branch} landed: that run was voided; resume once that is intended`, run.id);
        return;
      }
      const parents = await firstParents(this.git, this.root, run.base, tip);
      this.q.intent = { run: run.id, entry: e.id, from: run.base, to: tip, at: this.iso() };
      this.save();
      const r = await landTip(this.git, this.root, this.q.target, run.base, tip);
      if (r.kind === "landed") {
        await this.markLanded(e, run, parents, d.def);
        return;
      }
      delete this.q.intent;
      if (r.kind === "dirty") {
        e.reason = `tested; waiting to land: ${r.why}`;
        this.pauseNow("main-checkout-dirty", `${run.branch} passed, but ${r.why}: it lands once that is sorted and you resume (never forced)`, run.id);
        return;
      }
      run.verdict = "void";
      run.why = `${this.q.target} moved outside the queue during the landing`;
      this.store.writeRun(run);
      this.toFront(e);
      this.pauseNow("master-moved", `${this.q.target} moved outside the queue during ${e.branch}'s landing: that run was voided; resume once that is intended`, run.id);
    } finally {
      this.landing = false;
    }
  }

  // ---- landing by request or by push (al_3) ------------------------------------------------------

  /** origin's repository on its host, and that host's adapter; null: origin isn't on a host Sova opens requests on. */
  private async hosting(): Promise<Hosting | null> {
    let repo: HostRepo | null;
    try {
      if (this.deps.hostRepo) repo = await this.deps.hostRepo(this.root);
      else {
        const url = await this.git(["remote", "get-url", "origin"], this.root);
        repo = url.code === 0 && url.stdout.trim() ? ((await suggestLanding(url.stdout.trim())).repo ?? null) : null;
      }
    } catch {
      repo = null;
    }
    if (!repo) return null;
    const adapter = this.deps.hostAdapter ? this.deps.hostAdapter(repo.kind) : repo.kind === "github" ? githubAdapter() : gitlabAdapter();
    return { adapter, repo };
  }

  private async publishCtx(how: RequestHow): Promise<import("./strategy-run").PublishCtx> {
    const names = this.names();
    return { git: this.git, root: this.root, target: this.q.target, namesFile: names.exists ? names.file : undefined, holdFile: join(this.store.dir, "push-hold"), host: how === "push-branch" ? null : await this.hosting() };
  }

  /** A passed run on a request or push project (the entry is `checking`): its request's text drafted for the user's
   *  look (q10), or, onto a request already open (Land Again) or for Push branch only, published at once. */
  private async landByRequest(e: Entry, run: MergeRun): Promise<void> {
    const how = approvalHow(e.approval) as RequestHow;
    run.verdict = "passed";
    this.store.writeRun(run);
    const host = how === "github-pr" ? ("github" as const) : how === "gitlab-mr" ? ("gitlab" as const) : undefined;
    const sameHow = e.request?.how === how;
    e.request = { ...(sameHow ? e.request : {}), how, ...(host ? { host } : {}), branch: e.branch, base: this.q.target };
    delete e.reason;
    e.updatedAt = this.iso();
    const open = sameHow && !!e.request.number && e.request.facts?.state !== "closed" && e.request.facts?.state !== "merged";
    if (opensRequest(how) && !open) {
      const d = await this.declared();
      const title = (e.session && this.deps.chatTitle ? await this.deps.chatTitle(e.session).catch(() => null) : null) ?? e.branch;
      const note = e.notes.find((n) => n.kind === "thread" || n.kind === "operator")?.text;
      const t = await draftText({
        root: this.root,
        folder: d.def?.merge?.request ?? null,
        how,
        input: { branch: e.branch, base: this.q.target, chatTitle: title, ...(note ? { note } : {}), checksPassed: run.checks.map((c) => c.label), ...(e.review?.text ? { reviewNotes: e.review.text } : {}) },
        ...(this.deps.drafter ? { drafter: this.deps.drafter } : {}),
      }).catch((err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) }));
      e.state = "request-review";
      if (t.ok) {
        e.request.text = t.text;
        if (t.folder) e.request.folder = t.folder;
      } else e.reason = `the request's text couldn't be written: ${t.why}; write it yourself, then Publish`;
      this.save();
      this.kickSoon();
      return;
    }
    // Published at once: it stays `checking` until the outcome is known (a wait reads request-review, with why).
    this.q.awaitingPublish = { ...(this.q.awaitingPublish ?? {}), [e.id]: null };
    e.request.publishRequested = true;
    this.save();
    await this.publishNow(e);
    this.kickSoon();
  }

  /** q10's Publish: the user's reviewed title and description; the request goes out once the chat's folder is quiet. */
  publish(entryId: string, t: { title: string; body: string; draft: boolean }): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (e.state !== "request-review" || !e.request) throw new MergeFailure("invalid-request", `${e.branch} isn't waiting for its request's text (it is ${e.state})`);
      let text = { title: t.title.trim(), body: t.body, draft: t.draft };
      if (opensRequest(e.request.how)) {
        const d = await this.declared();
        // A folder check that fails is shown on the request's text, never a lock (lead's ruling): only Sova's own limits
        // and a check that can't run stop it.
        const c = await checkPublishText({ root: this.root, folder: d.def?.merge?.request ?? null, how: e.request.how, branch: e.branch, base: this.q.target, text });
        if (!c.ok) throw new MergeFailure("invalid-request", c.why);
        text = { title: c.title, body: c.body, draft: t.draft };
        e.request.text = { title: c.title, body: c.body, draft: t.draft, checks: c.checks };
      }
      this.q.awaitingPublish = { ...(this.q.awaitingPublish ?? {}), [e.id]: text };
      e.request.publishRequested = true;
      e.reason = "publishing";
      e.updatedAt = this.iso();
      this.save();
      await this.publishNow(e);
      this.kickSoon();
      return this.withPosition(e);
    });
  }

  /** Publish an approved entry now (serial): the docs commit, the scanned push, the request; each step's intent first. */
  private async publishNow(e: Entry): Promise<void> {
    const waiting = this.q.awaitingPublish ?? {};
    if (!(e.id in waiting)) return;
    const job = waiting[e.id] ?? null;
    const drop = () => {
      const { [e.id]: _gone, ...rest } = this.q.awaitingPublish ?? {};
      this.q.awaitingPublish = rest;
      if (e.request) delete e.request.publishRequested;
    };
    const run = e.run ? this.store.readRun(e.run) : null;
    if ((e.state !== "request-review" && e.state !== "checking") || !e.request || !run?.tip) {
      drop();
      if (e.state === "request-review") e.reason = "its tested run is gone: land it again";
      this.save();
      return;
    }
    const how = e.request.how;
    const ctx = await this.publishCtx(how);
    const session = e.session;
    const out = await publishEntry(
      ctx,
      {
        how,
        branch: e.branch,
        commit: e.commit,
        mergeSha: run.mergeSha ?? run.tip,
        tip: run.tip,
        runId: run.id,
        worktree: e.worktree,
        base: run.base,
        text: job ? { title: job.title, body: job.body } : e.request.text ? { title: e.request.text.title, body: e.request.text.body } : undefined,
        number: e.request.number,
        chatIdle: session && this.deps.chatIdle ? () => this.deps.chatIdle!(session) : undefined,
      },
      (step, head) => {
        this.q.publish = { entry: e.id, run: run.id, how, branch: e.branch, step, head, at: this.iso() };
        this.save();
      },
    );
    await this.afterPublish(e, out, run);
    this.recordPublish(e, out, run);
  }

  /** Published: the docs commit is in the branch folder, so its drafts get what the landing wrote for them. */
  private async afterPublish(e: Entry, out: PublishOutcome, run: MergeRun | null): Promise<void> {
    if ((out.kind === "pushed" || out.kind === "requested") && run?.tip) await this.markDrafts(e, run, "in-folder", run.tip);
  }

  /** What a publication came to, on the entry (then told). */
  private recordPublish(e: Entry, out: PublishOutcome, run: MergeRun | null): void {
    const drop = () => {
      const { [e.id]: _gone, ...rest } = this.q.awaitingPublish ?? {};
      this.q.awaitingPublish = rest;
      if (e.request) delete e.request.publishRequested;
    };
    delete this.q.publish;
    e.updatedAt = this.iso();
    switch (out.kind) {
      case "wait":
        e.state = "request-review";
        e.reason = out.why;
        this.save();
        this.armPoll();
        return;
      case "refused":
        drop();
        if (out.blame === "branch") {
          // The branch's to fix: back to its chat by itself, as a request (al_3), through the one send-back.
          this.sendBack(e, { cause: "host", why: out.why, ...(run ? { runId: run.id } : {}) });
          return;
        }
        e.state = "request-review";
        e.reason = out.why;
        this.save();
        if (/private names not set up/.test(out.why)) this.wake("names", e, undefined, { namesFile: this.names().file });
        return;
      case "pushed":
        drop();
        e.request = { ...e.request!, publishedHead: out.head };
        e.state = "pushed";
        delete e.reason;
        this.save();
        this.log(`pushed ${e.branch} at ${out.head.slice(0, 7)}`);
        this.deps.notify?.("pushed", e, { ...(run ? { run } : {}), root: this.root });
        return;
      case "requested":
        drop();
        e.request = { ...requestInfo(e.request!, out.request, this.iso()), publishedHead: out.head };
        e.state = "requested";
        delete e.reason;
        this.save();
        this.log(`${e.branch} at ${out.head.slice(0, 7)}: request #${out.request.number} ${out.opened ? "opened" : "updated"}`);
        this.deps.notify?.("requested", e, { ...(run ? { run } : {}), root: this.root });
        this.armPoll();
        return;
    }
  }

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPoll = 0;
  /** Read the host again in a while, while anything waits on it. */
  private armPoll(): void {
    if (this.stopped || this.pollTimer) return;
    if (!this.q.entries.some((e) => e.state === "requested" || (e.state === "request-review" && e.id in (this.q.awaitingPublish ?? {})))) return;
    const t = setTimeout(() => {
      this.pollTimer = null;
      void this.pollHost().catch((err) => this.log(`host poll failed: ${err instanceof Error ? err.message : err}`));
    }, this.deps.pollMs ?? 180_000);
    t.unref?.();
    this.pollTimer = t;
  }

  /** Read every open request on the host now (and retry publications that waited): merged → Landed on the host's word,
   *  closed → Closed; the host's facts kept on the entry. Results are written before anyone is told. */
  pollHost(): Promise<void> {
    return this.serial(async () => {
      this.lastPoll = this.now();
      for (const e of [...this.q.entries]) {
        if (e.state === "request-review" && e.id in (this.q.awaitingPublish ?? {})) {
          await this.publishNow(e);
          continue;
        }
        if (e.state !== "requested" || !e.request?.number) continue;
        const ctx = await this.publishCtx(e.request.how);
        const from = await revParse(this.git, this.root, `refs/remotes/origin/${this.q.target}`);
        const r = await pollRequest(ctx, { number: e.request.number, from });
        if (r.kind === "unknown") {
          this.log(`${e.branch}: the host couldn't be read: ${r.why}`);
          continue;
        }
        const before = JSON.stringify(e.request.facts ?? null);
        e.request = requestInfo(e.request, r.request, this.iso());
        const run = e.run ? this.store.readRun(e.run) : null;
        if (r.kind === "open") {
          // What the host says is the branch's (conflicts, its checks failed, changes requested) goes back to the
          // chat by itself under the standing Land, once per problem and head (§app.merge-queue/send-back).
          // Only a requested entry is polled (never one checking); one with an open decision waits for the user.
          const problem = e.approval.standing && !(e.decision && !e.decision.answered) ? hostProblem(e.request.facts, e.request, this.q.target) : null;
          if (problem && problem.key !== e.request.hostSentBack) {
            e.request.hostSentBack = problem.key;
            this.log(`${e.branch}: request #${e.request.number}: ${problem.why}`);
            this.sendBack(e, { cause: "host", why: problem.why });
            continue;
          }
          if (JSON.stringify(e.request.facts) !== before) {
            e.updatedAt = this.iso();
            this.save();
          }
          continue;
        }
        e.updatedAt = this.iso();
        if (r.kind === "merged") {
          for (const c of r.parents) if (!this.q.landed.includes(c)) this.q.landed.push(c);
          this.keepHostPin(e.branch, e.commit);
          e.request.mergeCommit = r.sha;
          e.state = "landed";
          this.reviewEvent(e, { kind: "landed" });
          delete e.reason;
          e.landed = { sha: r.sha, from: run?.base ?? from ?? "", at: this.iso(), pushed: "pushed", via: "host" };
          this.save();
          this.log(`${e.branch}: request #${e.request.number} merged on the host at ${r.sha.slice(0, 7)}`);
          this.deps.notify?.("landed", e, { ...(run ? { run } : {}), root: this.root });
          this.wake("landed", e, run?.id);
          branchLanded(this.root, e.branch);
        } else {
          e.state = "closed";
          e.reason = "closed on the host without merging";
          this.save();
          this.deps.notify?.("closed", e, { ...(run ? { run } : {}), root: this.root });
        }
      }
      this.armPoll();
    });
  }

  /** Update Local Main (q11): the local target fast-forwarded to origin's by the queue itself, so it never reads as a
   *  move from outside; refused with the reason on a dirty checkout, never pausing the line. */
  updateLocalMain(): Promise<{ kind: "updated" | "current"; head: string }> {
    return this.serial(async () => {
      if (this.landing) throw new MergeFailure("busy", "a landing is moving the target now: try again in a moment");
      if (this.q.release) throw new MergeFailure("invalid-request", `${this.q.target} stays on the release commit ${this.whileOpen()}: update it after Publish or Abandon`);
      this.landing = true;
      try {
        const r = await updateMainTip(this.git, this.root, this.q.target);
        if (r.kind === "refused") throw new MergeFailure("invalid-request", r.why);
        if (r.kind === "current") return { kind: "current" as const, head: r.head };
        for (const c of r.parents) if (!this.q.landed.includes(c)) this.q.landed.push(c);
        if (!this.q.knownTarget || this.q.knownTarget === r.from) this.q.knownTarget = r.to;
        if (this.current && this.current.localBase === r.from) this.current.localBase = r.to;
        this.checksCache = null;
        this.save();
        this.settingsChanged();
        this.log(`local ${this.q.target} updated to origin's ${r.to.slice(0, 7)}`);
        this.kickSoon();
        return { kind: "updated" as const, head: r.to };
      } finally {
        this.landing = false;
      }
    });
  }

  /** How it lands, saved on this computer (wins over the project file) or in the project file (through the settings
   *  save path). A pinned approval keeps its own. */
  setLandHow(how: LandHow, where: "project" | "computer"): Promise<{ state: "saved"; commit?: string } | { state: "waiting"; release?: string }> {
    if (where === "computer") {
      return this.serial(async () => {
        this.refuseHowChangeWhileHeld();
        writeOverride(this.store.dir, how);
        this.settingsChanged();
        this.save();
        return { state: "saved" as const };
      });
    }
    return this.saveSettings({ land: how }) as Promise<{ state: "saved"; commit?: string } | { state: "waiting"; release?: string }>;
  }

  clearLandHowOverride(): Promise<void> {
    return this.serial(async () => {
      this.refuseHowChangeWhileHeld();
      writeOverride(this.store.dir, null);
      this.settingsChanged();
      this.save();
    });
  }

  /** The target is at the tip: record the landing, clear the intent, tell the branch, push. Recovery calls it too. */
  async markLanded(e: Entry, run: MergeRun, parents: string[], def: ProjectDef | null): Promise<void> {
    const tip = run.tip!;
    run.verdict = "passed";
    this.store.writeRun(run);
    for (const c of parents.length ? parents : [tip]) if (!this.q.landed.includes(c)) this.q.landed.push(c);
    this.q.knownTarget = tip;
    e.state = "landed";
    this.reviewEvent(e, { kind: "landed" });
    delete e.reason;
    e.landed = { sha: tip, from: run.base, at: this.iso(), pushed: "pending" };
    e.updatedAt = this.iso();
    const branchTip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
    const newer = branchTip && branchTip !== e.commit && (await isAncestor(this.git, this.root, e.commit, branchTip)) ? await ownCommitsPast(this.git, this.root, e.commit, branchTip, tip, true) : 0;
    if (newer) e.newerCommits = newer;
    else delete e.newerCommits;
    // Before the intent goes: a stop here finishes the landing at the next start, and with it this (idempotent) write.
    await this.markDrafts(e, run, "on-target", tip);
    delete this.q.intent;
    // The revert of an abandoned release lands: the release's hold is lifted with it (its push goes out as any).
    if (e.release && e.releaseKind === "revert" && this.q.release?.id === e.release) this.liftNow();
    this.save();
    this.log(`landed ${e.branch} at ${tip.slice(0, 7)}`);
    this.releaseEvent(e, "landed", undefined, run.id);
    await this.push(tip, def, e);
    this.deps.notify?.("landed", e, { run, root: this.root });
    this.wake("landed", e, run.id);
    branchLanded(this.root, e.branch);
    this.kickSoon();
  }

  /** A host's landing, kept past its entry. Bounded: the newest branches. */
  private keepHostPin(branch: string, commit: string): void {
    const pins = (this.q.hostPins ??= {});
    const had = pins[branch] ?? [];
    delete pins[branch];
    pins[branch] = [commit, ...had.filter((c) => c !== commit)].slice(0, 8);
    for (const k of Object.keys(pins).slice(0, Math.max(0, Object.keys(pins).length - 500))) delete pins[k];
  }

  /** The drafts a landing made official stay in the branch folder, marked landed (§chat.worktrees/readiness). */
  private async markDrafts(e: Entry, run: MergeRun, docs: "on-target" | "in-folder", tip: string): Promise<void> {
    if (e.approval.withoutSpecs) return;
    const marked = await recordLandedDrafts({ git: this.git, root: this.root, runDir: this.store.runDir(run.id), worktree: e.worktree, docs, target: this.q.target, tip, run: run.id, now: this.iso(), log: (s) => this.log(s) }).catch(() => []);
    if (marked.length) this.log(`${e.branch}: marked landed in its folder: ${marked.join(", ")}`);
  }

  /** The private names file this project's leak scan and push read. */
  names(): { file: string; exists: boolean; legacy: boolean } {
    return this.store.namesFileOf(this.deps.legacyNames);
  }

  /** Push the target at `tip` (after a landing, or on resume/retry for one held back). `e`: the landing it is for. */
  private async push(tip: string, def: ProjectDef | null, e?: Entry): Promise<void> {
    const names = this.names();
    let p: Awaited<ReturnType<typeof pushTip>>;
    const origin = (await this.git(["remote"], this.root)).stdout.split("\n").includes("origin");
    if (this.q.release && def?.merge?.push !== false && origin) {
      p = { state: "not-pushed", why: `held: ${this.holdWords()}` };
    } else if (!names.exists && def?.merge?.push !== false && origin) {
      p = { state: "not-pushed", why: PUSH_HELD_NAMES };
      if (e) this.wake("names", e, undefined, { namesFile: names.file });
    } else p = await pushTip(this.git, this.root, this.q.target, tip, { landed: new Set(this.q.landed), ...(def?.merge?.push === false ? { push: false } : {}), holdFile: join(this.store.dir, "push-hold") });
    if (p.state === "pushed") {
      this.q.heads.pushed = tip;
      delete this.q.heads.pushWhy;
      // Every landing up to the tip is pushed with it.
      for (const x of this.q.entries) if (x.state === "landed" && x.landed && x.landed.pushed !== "pushed" && (x.landed.sha === tip || (await isAncestor(this.git, this.root, x.landed.sha, tip)))) x.landed = { ...x.landed, pushed: "pushed" };
      if (e?.landed) e.landed = { ...e.landed, pushed: "pushed" };
      if (e?.landed) delete e.landed.pushWhy;
    } else {
      if (e?.landed) e.landed = { ...e.landed, pushed: p.state, pushWhy: p.why };
      this.q.heads.pushWhy = p.why;
      if (p.state === "not-pushed" && "remote" in p && p.remote) this.q.heads.pushed = p.remote;
    }
    this.save();
  }

  /** A push held back earlier goes now if it can (resume, retry). */
  private async pushHeld(): Promise<void> {
    if (!this.q.heads.pushWhy) return;
    const head = await this.targetHead();
    if (!head || !this.q.landed.includes(head)) return;
    await this.push(head, (await this.declared()).def);
  }

  private wake(
    kind: ThreadEvent["kind"],
    e: Entry,
    run?: string,
    extra: Omit<Partial<ThreadEvent>, "kind" | "project" | "root" | "target" | "entry" | "run"> = {},
  ): boolean {
    if (!this.deps.thread) return false;
    // What the thread diffs against: the run's base, else the target as the queue last saw it.
    const runBase = run ? (this.current?.run.id === run ? this.current.run.base : this.store.readRun(run)?.base) : undefined;
    const base = runBase ?? this.q.knownTarget;
    if (base && !(extra as { base?: string }).base) (extra as { base?: string }).base = base;
    try {
      return this.deps.thread({ kind, project: this.id, root: this.root, target: this.q.target, entry: structuredClone(e), ...(run ? { run } : {}), ...extra });
    } catch (err) {
      this.log(`thread wake failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // ---- releases (q9, a5, a6, t22, t24) ------------------------------------------------------------

  /** While a release holds the queue, only its own entries run; every other one waits with the release named. */
  private releaseLine(line: Entry[]): Entry[] {
    const hold = this.q.release;
    if (!hold) return line;
    const words = this.waitingWords();
    let changed = false;
    for (const e of line) {
      if (e.release === hold.id || e.reason === words) continue;
      e.reason = words;
      changed = true;
    }
    if (changed) this.save();
    return line.filter((e) => e.release === hold.id);
  }

  /** A tag-only release's entry: its commit is the frozen target's own head (no release commit). */
  private tagOnly(e: Entry, base: string): boolean {
    return !!e.release && (e.releaseKind ?? "release") === "release" && e.commit === base && this.q.release?.id === e.release;
  }

  private waitingWords(): string {
    const h = this.q.release;
    return h ? `waits for ${h.tag ?? (h.version ? `release ${h.version}` : "the open release")} to be published or abandoned` : "waiting";
  }
  /** A reason the hold wrote (it is rewritten as the release's tag becomes known, and dropped when the hold lifts). */
  private isWaitingWords(r: string | undefined): boolean {
    return !!r && r.startsWith("waits for ") && r.endsWith(" to be published or abandoned");
  }
  /** The holding release as the screens name it: its tag once picked, never its id ("the open release" until then). */
  private releaseName(): string {
    const h = this.q.release;
    const named = h?.tag ?? h?.version;
    return named ? `release ${named}` : "the open release";
  }
  /** "while release vX is open"; before a version is picked, "while a release is open". */
  private whileOpen(): string {
    const name = this.releaseName();
    return `while ${name === "the open release" ? "a release" : name} is open`;
  }

  /** Set or cleared, this computer's how-it-lands can't change under an open release: Publish must land as it started. */
  private refuseHowChangeWhileHeld(): void {
    if (this.q.release) throw new MergeFailure("invalid-request", `how it lands can't change ${this.whileOpen()}: change it after Publish or Abandon`);
  }

  /** Release lands its commit on the target here and pushes it itself: a project that lands by request or by pushing a
   *  branch (no direct push to the target) can't release (yet). */
  private async mustLandLocally(): Promise<void> {
    const how = effectiveHow((await this.declared()).def?.merge?.land, this.store.dir).effective;
    if (publishes(how)) throw new MergeFailure("unsupported", `this project lands ${how === "push-branch" ? "by pushing a branch" : "by request"}, and a release lands its commit on ${this.q.target} and pushes it itself: set how it lands to local (Settings → Merge Queue) to release here`);
  }

  private holdWords(): string {
    const h = this.q.release;
    return h ? `${this.whileOpen().slice("while ".length)}: nothing is pushed until it is published or abandoned` : "";
  }
  private holdFile(): string {
    return join(this.store.dir, "push-hold");
  }

  private releaseEvent(e: Entry, what: ReleaseQueueEvent["what"], why?: string, run?: string): void {
    if (!e.release || !this.deps.releaseEvent) return;
    try {
      this.deps.releaseEvent({ root: this.root, release: e.release, kind: e.releaseKind ?? "release", entry: this.withPosition(e), what, ...(why ? { why } : {}), ...(run ? { run } : {}) });
    } catch (err) {
      this.log(`release event failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** The release holding the queue, if any. */
  releaseHold(): QueueFile["release"] | null {
    return this.q.release ? structuredClone(this.q.release) : null;
  }

  /**
   * Hold the queue for release `id`: from now on only its entries land, and nothing is pushed (the push-hold file is
   * set too) until publishRelease or abandonRelease lifts it. A run of another branch in flight is voided and waits at
   * the front of the line. Answers the target's head: the release's base. Idempotent for the same release.
   */
  freezeForRelease(release: { id: string; version?: string | null; state?: string; checks?: MergeCheckDecl[] }): Promise<{ base: string }> {
    return this.serial(async () => {
      const held = this.q.release;
      if (held && held.id !== release.id) throw new MergeFailure("busy", `${this.releaseName()} already holds the queue`);
      if (!held) await this.mustLandLocally();
      const head = await this.targetHead();
      if (!head) throw new MergeFailure("invalid-request", `${this.q.target} has no commit to release`);
      if (this.q.intent) throw new MergeFailure("busy", "a landing is in flight: try again in a moment");
      if (!held) {
        this.q.release = { id: release.id, version: release.version ?? null, state: release.state ?? "preparing", base: head, since: this.iso(), ...(release.checks?.length ? { checks: structuredClone(release.checks) } : {}) };
        if (this.current) {
          const cur = this.current;
          const e = this.entry(cur.entry);
          if (!e?.release) {
            cur.voidWhy = "release";
            cur.ac.abort();
          }
        }
        this.q.knownTarget = head;
      } else if (release.checks) this.q.release!.checks = structuredClone(release.checks);
      mkdirSync(this.store.dir, { recursive: true });
      writeFileSync(this.holdFile(), `${this.holdWords()}\n`, { mode: 0o600 });
      this.releaseLine(this.queued());
      this.save();
      if (this.q.pendingSave) this.settingsChanged();
      this.log(`held for release ${release.id} at ${head.slice(0, 7)}`);
      return { base: this.q.release!.base };
    });
  }

  /** The hold's banner follows the release (its version once picked, its state). */
  updateReleaseHold(id: string, u: { version?: string | null; tag?: string | null; state?: string }): Promise<void> {
    return this.serial(async () => {
      const h = this.q.release;
      if (!h || h.id !== id) return;
      if (u.version !== undefined) h.version = u.version;
      if (u.tag !== undefined) h.tag = u.tag;
      if (u.state !== undefined) h.state = u.state;
      writeFileSync(this.holdFile(), `${this.holdWords()}\n`, { mode: 0o600 });
      // Waiting rows name the release by its version once it has one.
      for (const e of this.queued()) if (e.release !== h.id && this.isWaitingWords(e.reason)) e.reason = this.waitingWords();
      if (this.q.pendingSave) this.settingsChanged();
      this.save();
    });
  }

  /** Lift the hold in the serial chain's step that ends it (publish, the revert landing, abandon with nothing landed). */
  private liftNow(): void {
    const h = this.q.release;
    if (!h) return;
    delete this.q.release;
    rmSync(this.holdFile(), { force: true });
    for (const e of this.queued()) if (this.isWaitingWords(e.reason)) delete e.reason;
    if (this.q.pendingSave) this.settingsChanged();
    this.log(`hold of release ${h.id} lifted`);
    // The thread hears Idle again once the line is quiet: what it put off during the release (a restart) is owed now.
    this.idleOwed = this.newestLanded()?.id ?? this.idleOwed;
    this.kickSoon();
  }

  /**
   * A release entry, added by Sova (never a person's Land): the release commit (`kind: "release"`, it runs the merge
   * checks plus the release's own) or an abandoned release's revert. It goes first in line and runs without a review.
   */
  addReleaseEntry(r: { release: string; branch: string; commit: string; kind?: "release" | "revert"; session?: string; worktree?: string }): Promise<MergeEntry> {
    return this.serial(async () => {
      const hold = this.q.release;
      if (!hold || hold.id !== r.release) throw new MergeFailure("invalid-request", "that release doesn't hold this queue");
      const kind = r.kind ?? "release";
      const open = this.q.entries.find((e) => e.release === r.release && (e.releaseKind ?? "release") === kind && !isFinal(e));
      if (open) {
        if (open.commit === r.commit) return this.withPosition(open);
        throw new MergeFailure("busy", `this release already has ${kind === "revert" ? "a revert" : "a release commit"} in line`);
      }
      const sha = await revParse(this.git, this.root, r.commit);
      if (!sha) throw new MergeFailure("invalid-request", `no commit ${r.commit}`);
      if (kind === "release" && !(await isAncestor(this.git, this.root, hold.base, sha))) throw new MergeFailure("invalid-request", `${sha.slice(0, 7)} isn't cut from the release's base ${hold.base.slice(0, 7)}`);
      const at = this.iso();
      const e: Entry = {
        id: newId("mq"),
        project: this.id,
        target: this.q.target,
        branch: r.branch.replace(/^refs\/heads\//, ""),
        ...(r.worktree ? { worktree: r.worktree } : {}),
        ...(r.session ? { session: r.session } : {}),
        commit: sha,
        approval: { by: "release", at, commit: sha, withoutReview: true },
        state: "queued",
        runs: [],
        picks: [],
        notes: [],
        release: r.release,
        releaseKind: kind,
        createdAt: at,
        updatedAt: at,
        seq: ++this.q.seq,
      };
      this.q.entries.push(e);
      this.toFront(e);
      this.save();
      this.kickSoon();
      return this.withPosition(e);
    });
  }

  /** Retry a release entry handed back (Retry Step on checks): back in line at the same commit. */
  retryReleaseEntry(release: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = [...this.q.entries].reverse().find((x) => x.release === release && (x.releaseKind ?? "release") === "release");
      if (!e) throw new MergeFailure("not-found", `release ${release} has no release commit in the queue`);
      if (e.state === "landed") throw new MergeFailure("invalid-request", "its release commit already landed");
      if (e.state === "checking" || e.state === "queued") return this.withPosition(e);
      delete this.q.machineTries[e.id];
      this.toFront(e);
      delete e.reason;
      this.save();
      this.kickSoon();
      return this.withPosition(e);
    });
  }

  /**
   * Publish: all or none. The numbered tag at the release commit (its message the notes), each channel moved to it,
   * and, for a project that pushes (merge.push not false, an origin), master with both in one atomic push (channels
   * leased on origin's old value). A local-only project tags and moves its channels on this machine. On success the
   * hold is lifted and the waiting landings go on; on failure every local ref is as before and the hold stays.
   */
  publishRelease(p: { release: string; tag: string; channels: string[]; commit: string; notes: string }): Promise<{ pushed: PushState; why?: string; channelsFrom: Record<string, string | null> }> {
    return this.serial(async () => {
      const hold = this.q.release;
      if (!hold || hold.id !== p.release) throw new MergeFailure("invalid-request", "that release doesn't hold this queue");
      if (this.current) throw new MergeFailure("busy", "a run is checking: publish once it is done");
      const head = await this.targetHead();
      if (head !== p.commit) throw new MergeFailure("invalid-request", `${this.q.target} is at ${(head ?? "?").slice(0, 7)}, not the release commit ${p.commit.slice(0, 7)}`);
      await this.mustLandLocally();
      const def = (await this.declared()).def;
      const pushes = def?.merge?.push !== false && (await hasOrigin(this.git, this.root));
      if (pushes && !this.names().exists) throw new MergeFailure("invalid-request", PUSH_HELD_NAMES);
      const r = await publishGit(this.git, { root: this.root, target: this.q.target, commit: p.commit, tag: p.tag, channels: p.channels, message: p.notes, push: pushes, landed: new Set(this.q.landed) });
      if (!r.ok) {
        this.log(`publish of ${p.tag} failed: ${r.why}`);
        throw new MergeFailure("busy", r.why);
      }
      if (r.pushed === "pushed") {
        this.q.heads.pushed = p.commit;
        delete this.q.heads.pushWhy;
        for (const x of this.q.entries) if (x.state === "landed" && x.landed && x.landed.pushed !== "pushed" && (x.landed.sha === p.commit || (await isAncestor(this.git, this.root, x.landed.sha, p.commit)))) x.landed = { ...x.landed, pushed: "pushed" };
        for (const x of this.q.entries) if (x.landed?.pushed === "pushed") delete x.landed.pushWhy;
      } else {
        for (const x of this.q.entries) if (x.release === p.release && x.landed) x.landed = { ...x.landed, pushed: r.pushed, ...(r.why ? { pushWhy: r.why } : {}) };
        if (r.why) this.q.heads.pushWhy = r.why;
      }
      this.liftNow();
      this.save();
      this.log(`published ${p.tag} at ${p.commit.slice(0, 7)} (${r.pushed})`);
      return { pushed: r.pushed, ...(r.why ? { why: r.why } : {}), channelsFrom: r.channelsFrom };
    });
  }

  /**
   * Abandon: a release entry still in line is cancelled; one that landed is undone by a revert entry the queue lands
   * first (never a reset of the shared checkout), and that landing lifts the hold. Nothing landed: the hold lifts now.
   */
  abandonRelease(r: { release: string; why?: string }): Promise<{ revert: string | null }> {
    return this.serial(async () => {
      const hold = this.q.release;
      if (!hold || hold.id !== r.release) return { revert: null };
      const mine = this.q.entries.filter((e) => e.release === r.release);
      const revertOpen = mine.find((e) => e.releaseKind === "revert" && !isFinal(e));
      if (revertOpen) return { revert: revertOpen.id };
      for (const e of mine) {
        if (isFinal(e) || (e.releaseKind ?? "release") !== "release") continue;
        if (this.current?.entry === e.id) {
          this.current.voidWhy = "cancelled";
          this.current.ac.abort();
        }
        e.state = "cancelled";
        e.reason = `release abandoned${r.why ? `: ${r.why.split("\n")[0]!.slice(0, 160)}` : ""}`;
        e.updatedAt = this.iso();
      }
      const landed = [...mine].reverse().find((e) => (e.releaseKind ?? "release") === "release" && e.state === "landed" && e.landed);
      const head = await this.targetHead();
      if (!landed || !head || head === hold.base) {
        this.liftNow();
        this.save();
        return { revert: null };
      }
      if (head !== landed.landed!.sha) throw new MergeFailure("invalid-request", `${this.q.target} is at ${head.slice(0, 7)}, not the release commit ${landed.landed!.sha.slice(0, 7)}: undo it by hand`);
      const sha = await revertCommit(this.git, this.root, head, landed.landed!.from, `Revert ${this.releaseName()} (abandoned)${r.why ? `\n\n${r.why}` : ""}`);
      if (typeof sha !== "string") throw new MergeFailure("busy", sha.error);
      const branch = `sova/release-revert-${r.release}`;
      const u = await this.git(["update-ref", `refs/heads/${branch}`, sha], this.root);
      if (u.code !== 0) throw new MergeFailure("busy", `couldn't name the revert: ${u.stderr.trim()}`);
      const at = this.iso();
      const e: Entry = {
        id: newId("mq"),
        project: this.id,
        target: this.q.target,
        branch,
        commit: sha,
        approval: { by: "release", at, commit: sha, withoutReview: true },
        state: "queued",
        runs: [],
        picks: [],
        notes: [],
        release: r.release,
        releaseKind: "revert",
        createdAt: at,
        updatedAt: at,
        seq: ++this.q.seq,
      };
      this.q.entries.push(e);
      this.toFront(e);
      hold.state = "abandoned";
      this.save();
      this.kickSoon();
      return { revert: e.id };
    });
  }

  /** Withdraw: each channel back to its previous release (or removed), pushed with a lease when the project pushes.
   *  The numbered tag never moves. */
  withdrawRelease(w: { tag: string; sha: string; channels: Record<string, string | null>; why: string }): Promise<{ pushed: "pushed" | "not-pushed" | "no-remote"; channelsFrom: Record<string, string | null> }> {
    return this.serial(async () => {
      const def = (await this.declared()).def;
      const pushes = def?.merge?.push !== false && (await hasOrigin(this.git, this.root));
      const r = await withdrawGit(this.git, { root: this.root, channels: w.channels, tag: w.tag, sha: w.sha, why: w.why, push: pushes });
      if (!r.ok) throw new MergeFailure("busy", r.why);
      this.log(`withdrew ${w.tag}: ${Object.entries(w.channels).map(([c, to]) => `${c} → ${to ? to.slice(0, 7) : "none"}`).join(", ")}`);
      return { pushed: r.pushed === "pending" ? "not-pushed" : r.pushed, channelsFrom: r.channelsFrom };
    });
  }

  // ---- recovery and stop ------------------------------------------------------------------------

  /** At load: reconcile a landing intent left by a stop, requeue runs a stop interrupted, re-arm conflict waits. */
  async recover(): Promise<string[]> {
    const did: string[] = [];
    // The merge thread's hold is for a restart of the server: this start is its end.
    if (this.q.hold) {
      this.liftHold();
      did.push("lifted the merge thread's hold");
    }
    const head = await this.targetHead();
    const intent = this.q.intent;
    if (intent) {
      const e = this.entry(intent.entry);
      const run = this.store.readRun(intent.run);
      if (head === intent.to && e && run) {
        run.tip = intent.to;
        const parents = await firstParents(this.git, this.root, intent.from, intent.to);
        const d = await this.declared();
        await this.markLanded(e, run, parents, d.def);
        did.push(`finished the landing of ${e.branch} at ${intent.to.slice(0, 7)} (Sova stopped after the target moved)`);
      } else {
        delete this.q.intent;
        if (e && !isFinal(e)) this.toFront(e);
        if (run) {
          run.verdict = "void";
          run.why = head === intent.from ? "Sova stopped before the landing" : `${this.q.target} was elsewhere after a stop`;
          run.endedAt ??= this.iso();
          this.store.writeRun(run);
        }
        if (head !== intent.from) this.pauseNow("recovery", `a landing was in flight when Sova stopped, and ${this.q.target} is now at ${(head ?? "?").slice(0, 7)} (neither before nor after it): run again once you have looked`, intent.run);
        did.push(head === intent.from ? `requeued ${e?.branch ?? intent.entry}: Sova stopped before its landing` : `voided ${intent.run}: ${this.q.target} moved elsewhere`);
        this.save();
      }
    }
    for (const e of this.q.entries) {
      if (e.state !== "checking") continue;
      if (this.q.paused?.kind === "main-checkout-dirty" && this.q.paused.run === e.run) continue;
      // Stopped while publishing a tested run (Land Again onto an open request, Push branch only): its docs commit may
      // be on the chat's branch already, so it is finished from that run, never rerun.
      if (e.id in (this.q.awaitingPublish ?? {}) && e.request && e.run && this.store.readRun(e.run)?.tip) {
        e.state = "request-review";
        e.reason = "Sova stopped while publishing it: finishing it";
        e.updatedAt = this.iso();
        did.push(`kept ${e.branch}'s publication: Sova stopped during it`);
        continue;
      }
      const run = e.run ? this.store.readRun(e.run) : null;
      if (run && run.verdict === "running") {
        run.verdict = "void";
        run.why = "Sova stopped during the run";
        run.endedAt = this.iso();
        this.store.writeRun(run);
      }
      this.toFront(e);
      did.push(`requeued ${e.branch}: Sova stopped during its run`);
    }
    // A publication Sova stopped in the middle of (al_3, a17): what origin and the host have now decides, never a blind
    // retry; one that can't be settled waits for the user's Publish again.
    const pub = this.q.publish;
    if (pub) {
      const e = this.entry(pub.entry);
      const run = this.store.readRun(pub.run);
      if (e && e.state === "request-review" && e.request) {
        const out = await reconcilePublish(await this.publishCtx(pub.how), { how: pub.how, branch: pub.branch, head: pub.head, text: e.request.text ? { title: e.request.text.title, body: e.request.text.body } : undefined }).catch((err: unknown) => ({ kind: "wait" as const, why: err instanceof Error ? err.message : String(err) }));
        await this.afterPublish(e, out, run);
        this.recordPublish(e, out.kind === "refused" && out.blame === "branch" ? { ...out, blame: "setup" } : out, run);
        did.push(`settled the publication of ${e.branch} Sova stopped in: ${e.state}`);
      } else {
        delete this.q.publish;
        this.save();
      }
    }
    this.armPoll();
    for (const e of this.q.entries) if (e.state === "conflict") {
      // One whose run is gone is still judged: its timer runs with no run.
      const run = e.run ? this.store.readRun(e.run) : null;
      this.armConflictTimer(e, run ?? undefined);
    }
    // A send-back that waited for the thread's diagnosis, or a Can't waiting for its ruling, when Sova stopped: each
    // waits its full time again (the thread may still answer), then goes on as it would have.
    for (const e of this.q.entries) {
      const p = e.ruling?.pending;
      if (p && e.state === "with-chat") this.awaitDiagnosis(e, p);
      const u = e.ruling?.unattributed;
      if (u && e.state === "unattributed")
        this.armRulingTimer(e.id, () => {
          const x = this.entry(e.id);
          if (x?.state === "unattributed" && x.ruling?.unattributed) this.raiseUnattributed(x, x.ruling.unattributed.run);
        });
      const c = e.ruling?.cant;
      if (c && e.state === "with-chat") this.armRulingTimer(e.id, () => {
        const x = this.entry(e.id);
        if (x?.ruling?.cant) this.raiseCant(x, x.ruling.cant.request, x.ruling.cant.why);
      });
    }
    if (did.length) this.save();
    return did;
  }

  /** Stop: abort the run (it is rerun from the start at the next load), drop timers. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const t of this.conflictTimers.values()) clearTimeout(t);
    for (const t of this.rulingTimers.values()) clearTimeout(t);
    this.rulingTimers.clear();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.fixTimer) clearTimeout(this.fixTimer);
    if (this.trying) {
      this.trying.ac.abort();
      await this.trying.done.catch(() => {});
    }
    const cur = this.current;
    if (cur) {
      cur.voidWhy = "stopping";
      cur.ac.abort();
      await cur.done.catch(() => {});
    }
    await this.chain.catch(() => {});
  }

  /** Tests: wait for whatever is in flight. */
  async idle(): Promise<void> {
    for (;;) {
      const cur = this.current;
      await this.chain.catch(() => {});
      if (cur) await cur.done.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      if (!this.current && cur === this.current) {
        await this.chain.catch(() => {});
        if (!this.current) return;
      }
    }
  }
}

// ---- every project's queue ----------------------------------------------------------------------

/** An owner as the deps answer it (a bare id, or with its archived flag). */
function ownerId(o: string | { session: string; archived?: boolean } | null | undefined): { session: string; archived?: boolean } | null {
  if (!o) return null;
  return typeof o === "string" ? { session: o } : o;
}

export class MergeQueues {
  private readonly queues = new Map<string, Promise<ProjectQueue>>();
  constructor(readonly deps: QueueDeps) {}

  /** The queue of the project whose main checkout is `root` (loaded and recovered once). */
  get(root: string): Promise<ProjectQueue> {
    let p = this.queues.get(root);
    if (!p) {
      p = (async () => {
        const q = new ProjectQueue(this.deps, root, this.deps.projectIdOf?.(root) ?? root);
        await q.load();
        const did = await q.recover();
        const swept = await q.sweepScratch();
        if (swept.length) did.push(`removed the scratch copies and pinned resolutions of ${swept.length} finished entr${swept.length === 1 ? "y" : "ies"} (${swept.join(", ")})`);
        for (const d of did) (this.deps.log ?? console.log)(`[merge-queue] ${q.id}: ${d}`);
        q.kickSoon();
        return q;
      })();
      this.queues.set(root, p);
      p.catch(() => this.queues.delete(root));
    }
    return p;
  }

  /** The queue of `root` when it is already loaded (never loads one). */
  peek(root: string): Promise<ProjectQueue> | null {
    return this.queues.get(root) ?? null;
  }

  loaded(): Promise<ProjectQueue[]> {
    return Promise.all([...this.queues.values()]);
  }

  /** Find the queue holding an entry or a run, among the loaded ones. */
  async findEntry(id: string): Promise<ProjectQueue | null> {
    for (const q of await this.loaded()) if (q.entry(id)) return q;
    // Then each queue's history (read-only: every verb that changes an entry refuses one found there).
    for (const q of await this.loaded()) if (q.historyEntry(id)) return q;
    return null;
  }
  /** The queue holding a request of a branch's chat (rq_…), by id. */
  async findRequest(id: string): Promise<ProjectQueue | null> {
    for (const q of await this.loaded()) if (q.requestOf(id)) return q;
    return null;
  }
  async findRun(id: string): Promise<ProjectQueue | null> {
    for (const q of await this.loaded()) if (q.currentRun()?.id === id || q.store.readRun(id)) return q;
    return null;
  }

  async stop(): Promise<void> {
    for (const q of await this.loaded()) await q.stop();
  }
}
