import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckPick,
  type ChecksDeclared,
  ENTRY_OPEN,
  type MergeAnswer,
  type MergeApproval,
  type MergeEntry,
  type MergeNote,
  type MergeQueueView,
  type MergeRun,
  NOTE_MAX,
  type PauseInfo,
  type PauseKind,
  type ReviewVerdict,
  type RunStep,
} from "../../shared/merge-queue";
import type { ProjectDef } from "../../shared/project-contract";
import type { ChecksOf, EstimateRun, RunInput, RunMerge, RunOutcome, WakeThread } from "./contract";
import { countBetween, type Git, isAncestor, realGit, revParse, worktreesOf } from "./guard";
import { canLand, firstParents, landTip, pushTip } from "./land";
import type { MergeNoticeKind } from "./notices";
import { sanityCheck } from "./conflicts";
import { estimateFromRuns } from "./estimate";
import { deliverReview } from "./review-step";
import { isFinal, newId, type QueueFile, QueueStore } from "./store";
import { buildView } from "./view";

/**
 * One merge queue per project: approved branches wait in line and are checked one at a time; a passed run lands
 * (master fast-forwards to exactly the tested tip), then pushes. The queue owns the target; a run (contract.ts,
 * copy-checks) owns the merge copy. Every change is written to the store before it is told to anyone.
 */

/** The push hold while a project has no private names file (operator decision: exactly these words). */
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
  /** A queue's view changed. */
  publish?: (view: MergeQueueView) => void;
  /** Tell the branch's chat (server/merge-queue/notices.ts). */
  notify?: (kind: MergeNoticeKind, entry: MergeEntry, extra: { run?: MergeRun; root: string; logDir?: string }) => void;
  /** Wake the merge thread; false: none was asked. */
  thread?: WakeThread;
  /** The worktree's spec drafts hash (server/spec-drafts-state.ts draftsHash). */
  draftsHash?: (dir: string) => { hash: string; names: string[] } | undefined;
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
  /** Hand a reviewer's verdict to the review step (default review-step.ts deliverReview). */
  deliverReview?: typeof deliverReview;
  /** The mechanical sanity check of a resolution (default conflicts.ts sanityCheck). */
  sanity?: typeof sanityCheck;
  /** Sova's own project keeps the merge round's names file (`<state>/merge-round.json`) until it has its own. */
  legacyNames?: { root: string; file: string };
  /** Logs (default console). */
  log?: (line: string) => void;
}

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
}

interface Current {
  run: MergeRun;
  entry: string;
  ac: AbortController;
  /** Why it was aborted, if it was. */
  voidWhy: null | "master-moved" | "cancelled" | "superseded" | "stopping";
  watch: ReturnType<typeof setInterval> | null;
  done: Promise<void>;
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
  private checksCache: { head: string; def: ProjectDef | null; checks: ChecksDeclared; review: boolean } | null = null;

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

  private async resolveTarget(): Promise<string> {
    const head = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], this.root);
    const main = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;
    const ref = main ?? "HEAD";
    const at = await this.deps.definitionAt(this.root, ref);
    if (at.def?.merge?.target) return at.def.merge.target;
    if (main) return main;
    for (const b of ["master", "main"]) if (await revParse(this.git, this.root, `refs/heads/${b}`)) return b;
    return "master";
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
  async declared(): Promise<{ head: string | null; def: ProjectDef | null; checks: ChecksDeclared; review: boolean }> {
    const head = await this.targetHead();
    if (head && this.checksCache?.head === head) return this.checksCache;
    const at = head ? await this.deps.definitionAt(this.root, head) : { def: null, error: "no target" };
    const checks = this.deps.checksOf(at.def);
    const review = (this.deps.hasReviewKit ?? ((d) => !!d?.merge?.review))(at.def, this.root);
    const out = { head: head ?? "", def: at.def, checks, review };
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
    return buildView({
      q: this.q,
      root: this.root,
      current: this.current?.run ?? null,
      checks: d.checks,
      review: d.review,
      head,
      takesMs: takes,
      now: this.now(),
      readRun: (id) => this.store.readRun(id),
    });
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
      if (d.checks === "unset") throw new MergeFailure("unsupported", `Not set up: ${this.root} declares no checks for the merge queue yet (its merge section, a test command, or "no automated tests")`);
      const head = d.head || (await this.targetHead());
      if (!head) throw new MergeFailure("not-found", `no branch ${target} in ${this.root}`);
      if ((await countBetween(this.git, this.root, head, commit)) === 0) throw new MergeFailure("invalid-request", `nothing to land: ${branch} at ${commit.slice(0, 7)} has no commit ${target} doesn't`);
      const subject = (await this.git(["log", "-1", "--format=%s", commit], this.root)).stdout.trim();
      if (/^temp\b/i.test(subject)) throw new MergeFailure("invalid-request", `${branch}'s head is a TEMP commit ("${subject.slice(0, 60)}"): it isn't finished`);
      const wt = (await worktreesOf(this.git, this.root)).find((w) => w.branch === branch && w.path !== this.root)?.path;
      if (wt && commit === tip) {
        const st = await this.git(["status", "--porcelain"], wt);
        const n = st.stdout.split("\n").filter(Boolean).length;
        if (st.code === 0 && n) throw new MergeFailure("invalid-request", `${branch} has ${n} uncommitted file${n === 1 ? "" : "s"} in ${wt}: Land is for a commit; commit or remove them first`);
      }
      const drafts = !req.withoutSpecs && wt ? this.deps.draftsHash?.(wt) : undefined;
      const approval: MergeApproval = {
        by: req.by,
        at: req.at ?? this.iso(),
        commit,
        ...(req.chat ? { chat: req.chat } : {}),
        ...(drafts ? { drafts: { hash: drafts.hash, names: drafts.names } } : {}),
        ...(req.withoutSpecs ? { withoutSpecs: true as const } : {}),
        ...(req.withoutReview ? { withoutReview: true as const } : {}),
      };
      const open = this.q.entries.find((e) => e.branch === branch && ENTRY_OPEN.includes(e.state));
      if (open) {
        const same = open.commit === commit && !!open.approval.withoutReview === !!req.withoutReview && !!open.approval.withoutSpecs === !!req.withoutSpecs && open.approval.drafts?.hash === approval.drafts?.hash;
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
        if (!["behaviour-differs", "review-flagged", "conflict", "drafts-changed"].includes(e.state)) throw new MergeFailure("invalid-request", `${e.branch} isn't waiting for you (it is ${e.state})`);
        this.clearConflictTimer(e.id);
        const was = e.state;
        e.state = "needs-fix";
        e.reason = why?.trim() || (was === "review-flagged" ? `the review flagged it: ${e.review?.text ?? ""}`.trim() : was === "drafts-changed" ? "its spec drafts changed since you approved" : `conflicts with ${e.target}${e.conflict?.files.length ? ` in ${e.conflict.files.join(", ")}` : ""}`);
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
        if (e.state !== "review-flagged") throw new MergeFailure("invalid-request", `Land Anyway answers a flagged review; ${e.branch} is ${e.state}`);
        e.notes = e.notes.filter((n) => n.kind !== "review");
        e.notes.push({ kind: "review", text: `Landed over the review: ${e.review?.text ?? "flagged"}`.slice(0, NOTE_MAX), at: this.iso() });
        e.approval.withoutReview = true;
        const run = e.run ? this.store.readRun(e.run) : null;
        if (run?.tip && !this.current) {
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
    if (this.stopped || this.current || this.q.paused || this.landing) return;
    if (this.holdUntil > this.now()) return;
    const head = await this.targetHead();
    if (!head) return;
    const line = this.queued();
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
    for (const e of line) {
      // Drafts changed since the user's approval: wait for a new Land.
      if (e.approval.drafts && !e.approval.withoutSpecs && this.deps.draftsHash) {
        const now = e.worktree && existsSync(e.worktree) ? this.deps.draftsHash(e.worktree) : undefined;
        if (now?.hash !== e.approval.drafts.hash) {
          e.state = "drafts-changed";
          e.reason = now ? "drafts changed since you approved" : "its worktree is gone, so its approved drafts can't be copied";
          e.updatedAt = this.iso();
          this.save();
          this.deps.notify?.("drafts-changed", e, { root: this.root });
          continue;
        }
      }
      await this.startRun(e, head);
      return;
    }
  }

  private async startRun(e: Entry, base: string): Promise<void> {
    const d = await this.declared();
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
    e.updatedAt = this.iso();
    this.store.writeRun(run);
    const ac = new AbortController();
    const cur: Current = { run, entry: e.id, ac, voidWhy: null, watch: null, done: Promise.resolve() };
    this.current = cur;
    this.save();
    this.log(`run ${runId}: ${e.branch} at ${e.commit.slice(0, 7)} onto ${this.q.target} ${base.slice(0, 7)}`);
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
        if (h && h !== base && this.current === cur && !this.landing && !cur.voidWhy) {
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
      run.why = why === "master-moved" ? `${this.q.target} moved outside the queue` : why === "superseded" ? "approved again at a newer commit" : why === "stopping" ? "Sova stopped" : "cancelled";
      this.store.writeRun(run);
      if (why === "master-moved" && e.state === "checking") {
        this.toFront(e);
        const head = await this.targetHead();
        this.pauseNow("master-moved", `${this.q.target} moved outside the queue (${run.base.slice(0, 7)} → ${(head ?? "?").slice(0, 7)}) while ${e.branch} was checking: that run was voided; resume once that is intended`, run.id);
      } else if (why === "stopping" && e.state === "checking") {
        this.toFront(e);
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
      case "review-flagged": {
        run.verdict = "waiting";
        this.store.writeRun(run);
        e.state = "review-flagged";
        if (out.review) e.review = out.review;
        e.reason = `the review flagged it${out.review?.text ? `: ${out.review.text.split("\n")[0]!.slice(0, 160)}` : ""}`;
        this.addNotes(e, out.notes);
        e.updatedAt = this.iso();
        this.save();
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
    this.save();
    this.log(`landed ${e.branch} at ${tip.slice(0, 7)}`);
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
    const hasOrigin = (await this.git(["remote"], this.root)).stdout.split("\n").includes("origin");
    if (!names.exists && def?.merge?.push !== false && hasOrigin) {
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
    try {
      return this.deps.thread({ kind, project: this.id, root: this.root, target: this.q.target, entry: structuredClone(e), ...(run ? { run } : {}), ...extra });
    } catch (err) {
      this.log(`thread wake failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
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
    for (const t of this.conflictTimers.values()) clearTimeout(t);
    if (this.publishTimer) clearTimeout(this.publishTimer);
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
