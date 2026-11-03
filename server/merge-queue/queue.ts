import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type LandHow,
  type CheckPick,
  type ChecksDeclared,
  ENTRY_OPEN,
  type MergeAnswer,
  type MergeApproval,
  type MergeEntry,
  type MergeNote,
  type MergeQueueView,
  type MergeReady,
  type MergeRun,
  NOTE_MAX,
  type PauseInfo,
  type PauseKind,
  type PushState,
  type ReviewVerdict,
  type RunStep,
} from "../../shared/merge-queue";
import { HOOK_TIMEOUT_MAX, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import type { ChecksOf, EstimateRun, RunInput, RunMerge, RunOutcome, WakeThread } from "./contract";
import { countBetween, type Git, isAncestor, realGit, revParse, statusArgs, worktreesOf } from "./guard";
import { canLand, checkoutOf, dirtyWhy, firstParents, landTip, pushTip } from "./land";
import type { MergeNoticeKind } from "./notices";
import { sanityCheck } from "./conflicts";
import { estimateFromRuns } from "./estimate";
import { deliverReview } from "./review-step";
import { invalidOf, resolveTarget, setUpOf } from "./served";
import { isFinal, newId, type QueueFile, QueueStore } from "./store";
import { hasOrigin, publishGit, revertCommit, withdrawGit } from "./release-git";
import type { MergeCheckDecl } from "../../shared/project-contract";
import { settledFacts } from "./settled";
import { buildView } from "./view";
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
  /** Tell the branch's chat (server/merge-queue/notices.ts). */
  notify?: (kind: MergeNoticeKind, entry: MergeEntry, extra: { run?: MergeRun; root: string; logDir?: string }) => void;
  /** Wake the merge thread; false: none was asked. */
  thread?: WakeThread;
  /** The chat that owns a branch, when the approval named none (Land on the Merge Queue tab); null: no known chat. */
  ownerOf?: (root: string, branch: string, worktree: string | undefined) => Promise<string | { session: string; archived?: boolean } | null>;
  /** The worktree's spec drafts hash (server/spec-drafts-state.ts draftsHash). */
  draftsHash?: (dir: string) => { hash: string; names: string[]; each?: Record<string, string> } | undefined;
  now?: () => number;
  /** A machine failure's retry waits this long (default 60 s). */
  retryDelayMs?: number;
  /** A conflict waits this long for the thread's judgement before it is handed back (default 20 min). */
  conflictWaitMs?: number;
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

export class ProjectQueue {
  readonly store: QueueStore;
  private q!: QueueFile;
  private readonly git: Git;
  private current: Current | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private holdUntil = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private conflictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reviewWaiters = new Map<string, { resolve: (v: ReviewVerdict) => void; reject: (e: Error) => void }>();
  private landing = false;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private checksCache: { head: string; def: ProjectDef | null; checks: ChecksDeclared; review: boolean; invalid?: string } | null = null;

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

  /** Load the records and work out the target. Recovery (recover.ts) runs after. */
  async load(): Promise<void> {
    const target = await this.resolveTarget();
    this.q = this.store.read({ project: this.id, target });
    this.q.project = this.id;
    this.q.target = target;
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
    this.store.write(this.q);
    this.schedulePublish();
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

  async view(): Promise<MergeQueueView> {
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
    for (const e of this.q.entries) {
      if (isFinal(e) && !recentLanded.has(e.id)) continue;
      const tip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
      const n = tip && tip !== e.commit && (await isAncestor(this.git, this.root, e.commit, tip)) ? await countBetween(this.git, this.root, e.commit, tip) : 0;
      if (n) e.newerCommits = n;
      else delete e.newerCommits;
    }
    const takes = this.deps.estimate ? this.deps.estimate(this.id, this.root) : this.estimateFromHistory();
    const ready = await this.readyList(head);
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
    return { ...v, served, ...(hold ? { release: structuredClone(hold) } : {}), ...(d.invalid ? { invalid: d.invalid } : {}), ...(ready.length ? { ready } : {}), ...(thread ? { thread } : {}), ...chats, ...(tryRun ? { tryRun: structuredClone(tryRun) } : {}), ...(settings ? { settings } : {}) };
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
   * target, after the user's confirm. Never under a branch being checked: while a run (or Try It on Main, or a
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
  /** Ready, not approved (the view's Land list), re-read at most every 15 s or when the target moves. */
  private async readyList(head: string): Promise<MergeReady[]> {
    if (this.readyCache && this.readyCache.head === head && this.now() - this.readyCache.at < 15_000) return this.filterReady(this.readyCache.list);
    const out: MergeReady[] = [];
    for (const w of await worktreesOf(this.git, this.root)) {
      if (!w.branch || !w.head || w.path === this.root || w.branch === this.q.target || w.branch === "master" || w.branch === "main" || !existsSync(w.path)) continue;
      if (w.branch.startsWith("sova/")) continue;
      const ahead = await countBetween(this.git, this.root, head, w.head);
      if (!ahead) continue;
      const subject = (await this.git(["log", "-1", "--format=%s", w.head], this.root)).stdout.trim();
      if (/^temp\b/i.test(subject)) continue;
      const st = await this.git(statusArgs("--porcelain"), w.path);
      if (st.code !== 0 || st.stdout.trim()) continue;
      const owner = ownerId(await this.deps.ownerOf?.(this.root, w.branch, w.path).catch(() => null));
      const short = await this.git(["diff", "--shortstat", `${head}...${w.head}`], this.root);
      const lines = short.code === 0 ? { added: Number(/(\d+) insertion/.exec(short.stdout)?.[1] ?? 0), removed: Number(/(\d+) deletion/.exec(short.stdout)?.[1] ?? 0) } : {};
      out.push({ branch: w.branch, worktree: w.path, commit: w.head, ahead, ...lines, ...(owner ? { session: owner.session, ...(owner.archived ? { sessionArchived: true as const } : {}) } : {}) });
    }
    this.readyCache = { at: this.now(), head, list: out };
    return this.filterReady(out);
  }
  private filterReady(list: MergeReady[]): MergeReady[] {
    // A branch sent back (needs-fix) is Ready again only at a newer commit: never Land at the commit it was sent back at.
    return list.filter((r) => !this.q.entries.some((e) => e.branch === r.branch && (ENTRY_OPEN.includes(e.state) || ((e.state === "landed" || e.state === "needs-fix") && e.commit === r.commit))));
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
    return this.serial(async () => {
      let branch = req.branch?.replace(/^refs\/heads\//, "");
      if (!branch && req.checkout) {
        const r = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], req.checkout);
        if (r.code !== 0 || !r.stdout.trim()) throw new MergeFailure("invalid-request", `${req.checkout} isn't on a branch`);
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
      if ((await countBetween(this.git, this.root, head, commit)) === 0) throw new MergeFailure("invalid-request", `nothing to land: ${branch} at ${commit.slice(0, 7)} has no commit ${target} doesn't`);
      const subject = (await this.git(["log", "-1", "--format=%s", commit], this.root)).stdout.trim();
      if (/^temp\b/i.test(subject)) throw new MergeFailure("invalid-request", `${branch}'s head is a TEMP commit ("${subject.slice(0, 60)}"): it isn't finished`);
      const wt = (await worktreesOf(this.git, this.root)).find((w) => w.branch === branch && w.path !== this.root)?.path;
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
        this.deps.notify?.("approved", this.withPosition(onHost), { root: this.root });
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
          this.deps.notify?.("approved", this.withPosition(open), { root: this.root });
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
      this.q.entries.push(e);
      // Approved again while checking: the newer commit goes first.
      if (open && this.current?.entry === open.id) this.toFront(e);
      this.save();
      this.wake("queued", e);
      this.deps.notify?.("approved", this.withPosition(e), { root: this.root });
      this.kickSoon();
      return { entry: this.withPosition(e), changed: true };
    });
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
      if (isFinal(e)) throw new MergeFailure("invalid-request", `${e.branch} is ${e.state === "landed" ? "landed" : e.state === "cancelled" ? "already cancelled" : "handed back already"}`);
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

  /** merge.resolve: the merge thread's judgement of a conflict. */
  resolve(entryId: string, j: { verdict: string; files?: string[]; ours: string; theirs: string; proposal: string; commit?: string; note?: string }): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (e.state !== "conflict" && e.state !== "behaviour-differs") throw new MergeFailure("invalid-request", `${e.branch} has no conflict to resolve (it is ${e.state})`);
      if (j.verdict !== "no-behaviour-change" && j.verdict !== "behaviour-differs") throw new MergeFailure("invalid-request", 'verdict is "no-behaviour-change" or "behaviour-differs"');
      for (const k of ["ours", "theirs", "proposal"] as const) if (!j[k]?.trim()) throw new MergeFailure("invalid-request", `say ${k === "ours" ? "what the target's side does" : k === "theirs" ? "what the branch's side does" : "what the resolution does"}, in plain words`);
      const head = (await this.targetHead()) ?? "";
      const files = j.files?.length ? j.files : (e.conflict?.files ?? e.conflictFiles ?? []);
      let verdict = j.verdict as "no-behaviour-change" | "behaviour-differs";
      let sanity: { ok: boolean; why?: string } | undefined;
      let commit: string | undefined;
      if (j.commit) {
        commit = (await revParse(this.git, this.root, j.commit)) ?? undefined;
        if (!commit) throw new MergeFailure("not-found", `no commit ${j.commit} in ${this.root}`);
        const s = await (this.deps.sanity ?? sanityCheck)(this.root, { base: head, commit: e.commit, resolution: commit });
        sanity = { ok: s.ok, ...(s.why ? { why: s.why } : {}) };
        if (!s.ok) verdict = "behaviour-differs";
      } else if (verdict === "no-behaviour-change") throw new MergeFailure("invalid-request", "a resolution judged to change no behaviour names its commit (a merge of the target and the approved commit)");
      this.clearConflictTimer(e.id);
      e.conflict = { files, verdict, ours: j.ours.trim(), theirs: j.theirs.trim(), proposal: j.proposal.trim(), ...(commit ? { commit } : {}), ...(sanity ? { sanity } : {}), at: this.iso() };
      if (j.note !== undefined) this.setNote(e, j.note, "thread");
      if (verdict === "no-behaviour-change") {
        e.notes = e.notes.filter((n) => n.kind !== "resolved");
        e.notes.push({ kind: "resolved", text: `Resolved a conflict in ${files.join(", ") || "the branch"}: ${j.proposal.trim()}`.slice(0, NOTE_MAX), at: this.iso() });
        delete e.reason;
        this.toFront(e);
        this.kickSoon();
      } else {
        e.state = "behaviour-differs";
        e.reason = sanity && !sanity.ok ? `the resolution needs your look: ${sanity.why}` : "the two sides want different behaviour";
        e.updatedAt = this.iso();
      }
      this.save();
      return e;
    });
  }

  /** merge.answer: the user's Accept / Send Back / Land Anyway. */
  answer(entryId: string, answer: MergeAnswer, why?: string): Promise<MergeEntry> {
    return this.serial(async () => {
      const e = this.mustEntry(entryId);
      if (answer === "send-back") {
        if (!["behaviour-differs", "review-flagged", "unattributed", "conflict", "drafts-changed", "request-review", "requested"].includes(e.state)) throw new MergeFailure("invalid-request", `${e.branch} isn't waiting for you (it is ${e.state})`);
        this.clearConflictTimer(e.id);
        const was = e.state;
        e.state = "needs-fix";
        e.reason = why?.trim() || (was === "unattributed" ? `a check failed on the merge and on ${e.target} alone, and couldn't say whose failure it is${e.reason ? ` (${e.reason})` : ""}` : was === "review-flagged" ? `the review flagged it: ${e.review?.text ?? ""}`.trim() : was === "drafts-changed" ? "its spec drafts changed since you approved" : was === "request-review" || was === "requested" ? `its request needs another look${e.request?.facts?.checks === "fail" ? ": the host's checks failed" : e.request?.facts?.review === "changes-requested" ? ": changes were requested on the host" : e.request?.facts?.mergeable === "conflicts" ? `: it conflicts with ${e.target} on the host` : ""}` : `conflicts with ${e.target}${e.conflict?.files.length ? ` in ${e.conflict.files.join(", ")}` : ""}`);
        e.updatedAt = this.iso();
        this.save();
        this.deps.notify?.("sent-back", e, { root: this.root });
        return e;
      }
      if (answer === "accept") {
        if (e.state !== "behaviour-differs") throw new MergeFailure("invalid-request", `Accept answers a conflict whose sides differ; ${e.branch} is ${e.state}`);
        if (!e.conflict?.commit) throw new MergeFailure("invalid-request", "there is no proposed resolution to accept yet: Send Back, or wait for the merge thread's proposal");
        e.notes = e.notes.filter((n) => n.kind !== "resolved");
        e.notes.push({ kind: "resolved", text: `You accepted the resolution of ${e.conflict.files.join(", ") || "its conflict"}: ${e.conflict.proposal}`.slice(0, NOTE_MAX), at: this.iso() });
        delete e.reason;
        this.toFront(e);
        this.save();
        this.kickSoon();
        return e;
      }
      if (answer === "land-anyway") {
        if (e.state !== "review-flagged" && e.state !== "unattributed") throw new MergeFailure("invalid-request", `Land Anyway answers a flagged review or a failure no one can be blamed for; ${e.branch} is ${e.state}`);
        if (e.state === "unattributed") {
          e.notes.push({ kind: "master-red", text: `Landed anyway: ${e.reason ?? "a check failed on the merge and on the target alone"}`.slice(0, NOTE_MAX), at: this.iso() });
          e.approval.overUnattributed = true;
        } else {
          e.notes = e.notes.filter((n) => n.kind !== "review");
          e.notes.push({ kind: "review", text: `Landed over the review: ${e.review?.text ?? "flagged"}`.slice(0, NOTE_MAX), at: this.iso() });
          e.approval.withoutReview = true;
        }
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
      throw new MergeFailure("invalid-request", 'answer is "accept", "send-back" or "land-anyway"');
    });
  }

  /** merge.review: the review step's agent posts its verdict on the run. */
  review(runId: string, v: { verdict: string; text?: string }): Promise<MergeRun> {
    return this.serial(async () => {
      if (!["ok", "notes", "blocking"].includes(v.verdict)) throw new MergeFailure("invalid-request", 'verdict is "ok", "notes" or "blocking"');
      const cur = this.current?.run.id === runId ? this.current.run : null;
      if (!cur) throw new MergeFailure("invalid-request", `run ${runId} isn't checking now`);
      if ((v.verdict === "notes" || v.verdict === "blocking") && !v.text?.trim()) throw new MergeFailure("invalid-request", "say what the review found (text)");
      const verdict: ReviewVerdict = { verdict: v.verdict as ReviewVerdict["verdict"], ...(v.text?.trim() ? { text: v.text.trim().slice(0, 2000) } : {}), commit: cur.mergeSha ?? cur.commit, at: this.iso() };
      // The review step (review-step.ts) waits on its own; the run's awaitReview() is the other door.
      if ((this.deps.deliverReview ?? deliverReview)(runId, { verdict: verdict.verdict, ...(verdict.text ? { text: verdict.text } : {}) })) return cur;
      const w = this.reviewWaiters.get(runId);
      if (!w) throw new MergeFailure("invalid-request", `run ${runId} isn't waiting for a review`);
      this.reviewWaiters.delete(runId);
      w.resolve(verdict);
      return cur;
    });
  }

  /** merge.retry: rerun now (after a machine pause, or an entry's failed run when asked). */
  retry(entryId?: string, note?: string): Promise<void> {
    return this.serial(async () => {
      if (entryId) {
        const e = this.mustEntry(entryId);
        if (e.state !== "needs-fix" && e.state !== "queued") throw new MergeFailure("invalid-request", `${e.branch} is ${e.state}: nothing to retry`);
        if (note !== undefined) this.setNote(e, note, "thread");
        delete e.reason;
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
   * `dryRun` (Try It on Main) runs those checks on the target alone in the merge copy and answers the run (it goes on in
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
        const run: MergeRun = { id: runId, entry: "setup", project: this.id, branch: this.q.target, base: head, commit: head, steps: [], checks: [], verdict: "running", startedAt: this.iso(), why: "Try It on Main" };
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

  /** Tests: the Try It on Main run in flight, if any. */
  tryingNow(): Promise<void> | null {
    return this.trying?.done ?? null;
  }

  private mustEntry(id: string): Entry {
    const e = this.entry(id);
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
    if (this.stopped || this.current || this.trying || this.landing) return;
    // A settings save that waited for the branch just checked goes first, before the next branch starts on the target.
    if (this.q.pendingSave) await this.applyPendingSave();
    if (this.q.paused) return;
    if (this.holdUntil > this.now()) return;
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
    const declared = await this.declared();
    const d = own ? { ...declared, def: own, review: (this.deps.hasReviewKit ?? ((x) => !!x?.merge?.review))(own, this.root) } : declared;
    const runId = newId("mr");
    const runDir = this.store.runDir(runId);
    mkdirSync(runDir, { recursive: true });
    let draftsDir: string | undefined;
    if (e.approval.drafts && !e.approval.withoutSpecs && e.worktree) {
      draftsDir = join(runDir, "drafts");
      for (const n of e.approval.drafts.names) {
        const from = join(e.worktree, ".sova", "spec", "drafts", n);
        if (existsSync(from)) cpSync(from, join(draftsDir, n), { recursive: true });
      }
    }
    const run: MergeRun = { id: runId, entry: e.id, project: this.id, branch: e.branch, base, commit: e.commit, steps: [], checks: [], verdict: "running", startedAt: this.iso() };
    e.state = "checking";
    e.run = runId;
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
      ...(resolution ? { resolution } : {}),
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
    switch (out.verdict) {
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
          this.handBack(e, run, `the release commit conflicts with ${this.q.target}${out.conflict?.files?.length ? ` in ${out.conflict.files.slice(0, 3).join(", ")}` : ""}`);
          this.kickSoon();
          return;
        }
        e.state = "conflict";
        const files = out.conflict?.files ?? [];
        delete e.conflict;
        e.conflictFiles = files;
        e.reason = `conflicts with ${this.q.target}${files.length ? ` in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` : ""}`;
        e.updatedAt = this.iso();
        this.save();
        const asked = this.wake("conflict", e, run.id, { files });
        if (!asked) this.handBack(e, run, `${e.reason}; no merge thread is there to judge it`);
        else this.armConflictTimer(e, run);
        this.kickSoon();
        return;
      }
      case "failed": {
        run.verdict = "failed";
        this.store.writeRun(run);
        if (out.blame === "resolution") {
          e.state = "behaviour-differs";
          e.reason = `the resolution judged safe failed: ${out.why ?? "a check"}; your branch isn't blamed`;
          if (e.conflict) e.conflict = { ...e.conflict, verdict: "behaviour-differs" };
          e.updatedAt = this.iso();
          this.save();
        } else {
          this.handBack(e, run, out.why ?? "a check failed with your branch and passes on the target");
          this.wake("failed", e, run.id, { why: out.why ?? "failed" });
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
        this.kickSoon();
        return;
      }
      case "review-flagged": {
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

  private addNotes(e: Entry, notes: MergeNote[] | undefined): void {
    for (const n of notes ?? []) if (!e.notes.some((x) => x.kind === n.kind && x.text === n.text)) e.notes.push({ ...n, text: n.text.slice(0, NOTE_MAX) });
  }

  private handBack(e: Entry, run: MergeRun | undefined, why: string): void {
    this.clearConflictTimer(e.id);
    e.state = "needs-fix";
    e.reason = why;
    e.updatedAt = this.iso();
    this.save();
    this.deps.notify?.("needs-fix", e, { ...(run ? { run, logDir: this.store.runDir(run.id) } : {}), root: this.root });
    this.releaseEvent(e, "failed", why, run?.id);
  }

  private armConflictTimer(e: Entry, run: MergeRun): void {
    this.clearConflictTimer(e.id);
    const ms = this.deps.conflictWaitMs ?? 20 * 60_000;
    const t = setTimeout(() => {
      this.conflictTimers.delete(e.id);
      void this.serial(async () => {
        const x = this.entry(e.id);
        if (x?.state === "conflict") this.handBack(x, run, `${x.reason ?? "a conflict"}; the merge thread didn't judge it in time`);
      });
    }, ms);
    t.unref?.();
    this.conflictTimers.set(e.id, t);
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
    this.recordPublish(e, out, run);
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
          this.handBack(e, run ?? undefined, out.why);
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
          if (JSON.stringify(e.request.facts) !== before) {
            e.updatedAt = this.iso();
            this.save();
          }
          continue;
        }
        e.updatedAt = this.iso();
        if (r.kind === "merged") {
          for (const c of r.parents) if (!this.q.landed.includes(c)) this.q.landed.push(c);
          e.request.mergeCommit = r.sha;
          e.state = "landed";
          delete e.reason;
          e.landed = { sha: r.sha, from: run?.base ?? from ?? "", at: this.iso(), pushed: "pushed", via: "host" };
          this.save();
          this.log(`${e.branch}: request #${e.request.number} merged on the host at ${r.sha.slice(0, 7)}`);
          this.deps.notify?.("landed", e, { ...(run ? { run } : {}), root: this.root });
          this.wake("landed", e, run?.id);
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
    delete e.reason;
    e.landed = { sha: tip, from: run.base, at: this.iso(), pushed: "pending" };
    e.updatedAt = this.iso();
    const branchTip = await revParse(this.git, this.root, `refs/heads/${e.branch}`);
    const newer = branchTip && branchTip !== e.commit && (await isAncestor(this.git, this.root, e.commit, branchTip)) ? await countBetween(this.git, this.root, e.commit, branchTip) : 0;
    if (newer) e.newerCommits = newer;
    else delete e.newerCommits;
    delete this.q.intent;
    // The revert of an abandoned release lands: the release's hold is lifted with it (its push goes out as any).
    if (e.release && e.releaseKind === "revert" && this.q.release?.id === e.release) this.liftNow();
    this.save();
    this.log(`landed ${e.branch} at ${tip.slice(0, 7)}`);
    this.releaseEvent(e, "landed", undefined, run.id);
    await this.push(tip, def, e);
    this.deps.notify?.("landed", e, { run, root: this.root });
    this.wake("landed", e, run.id);
    this.kickSoon();
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

  private wake(kind: "queued" | "conflict" | "failed" | "paused" | "landed" | "names", e: Entry, run?: string, extra: { files?: string[]; why?: string; namesFile?: string } = {}): boolean {
    if (!this.deps.thread) return false;
    // What the thread diffs against: the run's base, else the target as the queue last saw it.
    const runBase = run ? (this.current?.run.id === run ? this.current.run.base : this.store.readRun(run)?.base) : undefined;
    const base = runBase ?? this.q.knownTarget;
    if (base) (extra as { base?: string }).base = base;
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
    this.kickSoon();
  }

  /**
   * A release entry, added by Sova (never a person's Land): the release commit (`kind: "release"`, it runs the merge
   * checks plus the release's own) or an abandoned release's revert. It goes first in line and runs without a review.
   */
  addReleaseEntry(r: { release: string; branch: string; commit: string; kind?: "release" | "revert"; session?: string; worktree?: string }): Promise<MergeEntry> {
    return this.serial(async () => {
      const hold = this.q.release;
      if (!hold || hold.id !== r.release) throw new MergeFailure("invalid-request", `release ${r.release} doesn't hold this queue`);
      const kind = r.kind ?? "release";
      const open = this.q.entries.find((e) => e.release === r.release && (e.releaseKind ?? "release") === kind && !isFinal(e));
      if (open) {
        if (open.commit === r.commit) return this.withPosition(open);
        throw new MergeFailure("busy", `release ${r.release} already has ${kind === "revert" ? "a revert" : "a release commit"} in line (${open.id})`);
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
      if (!hold || hold.id !== p.release) throw new MergeFailure("invalid-request", `release ${p.release} doesn't hold this queue`);
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
      const sha = await revertCommit(this.git, this.root, head, landed.landed!.from, `Revert release ${hold.version ?? hold.id} (abandoned)${r.why ? `\n\n${r.why}` : ""}`);
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
        this.recordPublish(e, out.kind === "refused" && out.blame === "branch" ? { ...out, blame: "setup" } : out, run);
        did.push(`settled the publication of ${e.branch} Sova stopped in: ${e.state}`);
      } else {
        delete this.q.publish;
        this.save();
      }
    }
    this.armPoll();
    for (const e of this.q.entries) if (e.state === "conflict" && e.run) {
      const run = this.store.readRun(e.run);
      if (run) this.armConflictTimer(e, run);
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
    if (this.publishTimer) clearTimeout(this.publishTimer);
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
