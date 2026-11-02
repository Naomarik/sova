/**
 * Tests only. The one place the merge-queue scenarios meet the queue: every scenario drives it through this, so when
 * the engine's shapes move only this file changes. It builds the REAL queue (MergeQueues) on the REAL run
 * (makeRunMerge: merge copy, setup, docs, checks, attribution, review step) with the real definition reader, drafts
 * hash and typed-go-ahead ingest. Only what stands outside Sova is stood in for: the branch's chat (notices are
 * captured), the merge thread (a scripted stand-in that answers through the queue's own verb methods) and the
 * reviewer chat (a stand-in that reads the commit and answers through merge.review's method).
 *
 * The crash case runs the queue in a child process (testing/queue-child.ts) that SIGKILLs itself right before or
 * right after the landing's fast-forward (an injected git wrapper; no product hook), then a fresh queue recovers.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, MergeQueueView, MergeRun } from "../../../shared/merge-queue";
import { recordGoAhead } from "../../../pi-config/extensions/worktrees/landing.ts";
import { definitionAt } from "../../project-services/deploy-recipe";
import { draftsHash } from "../../spec-drafts-state";
import { checksOf } from "../checks";
import type { ThreadEvent } from "../contract";
import type { Git } from "../guard";
import { realGit } from "../guard";
import { ingestOnce } from "../ingest";
import { noticeText } from "../notices";
import { MergeQueues, type ProjectQueue, type QueueDeps } from "../queue";
import { makeRunMerge, stepLog } from "../run";
import type { StartReviewer } from "../review-step";
import { type Fixture, REPO_ROOT, until } from "./repo";

export type QState = MergeEntry["state"];

export interface Notice {
  kind: string;
  to: string;
  branch: string;
  text: string;
}

export interface ThreadStandIn {
  queued?: (h: QueueHarness, e: MergeEntry, ev: ThreadEvent) => Promise<void>;
  conflict?: (h: QueueHarness, e: MergeEntry, ev: ThreadEvent) => Promise<void>;
  failed?: (h: QueueHarness, e: MergeEntry, ev: ThreadEvent) => Promise<void>;
  landed?: (h: QueueHarness, e: MergeEntry, ev: ThreadEvent) => Promise<void>;
  /** The names interview (a push held for want of the project's private names). */
  names?: (h: QueueHarness, e: MergeEntry, ev: ThreadEvent) => Promise<void>;
}

/** What the stand-in reviewer answers for a commit (read in the merge copy). */
export type ReviewerStandIn = (o: { commit: string; copy: string; runId: string }) => Promise<{ verdict: "ok" | "notes" | "blocking"; text?: string } | "crash" | "hang">;

export interface HarnessOptions {
  thread?: ThreadStandIn;
  reviewer?: ReviewerStandIn;
  /** Reviewer timeout (ms) for the hang case. */
  reviewTimeoutMs?: number;
  /** How long a conflict waits for the thread before it is handed back. */
  conflictWaitMs?: number;
  /** The project's private names (its names file in the queue's records). Default: an empty list, set up. null: none
   *  set up yet (pushes are held until the names interview). */
  names?: string[] | null;
  /** Sova's legacy names file (`<state>/merge-round.json`), for the project at `root`. */
  legacyNames?: { root: string; file: string };
}

/** The queue's dependencies for one fixture: the same in this process and in the crash child. */
export function queueDeps(stateRoot: string, extra: Partial<QueueDeps> & { git?: Git; reviewer?: StartReviewer; reviewTimeoutMs?: number } = {}): QueueDeps {
  const { reviewer, reviewTimeoutMs, ...rest } = extra;
  return {
    base: join(stateRoot, "merge-queue"),
    runMerge: makeRunMerge({
      state: stateRoot,
      specCore: join(REPO_ROOT, "pi-config/extensions/spec/core"),
      ...(reviewer ? { startReviewer: reviewer } : {}),
      ...(reviewTimeoutMs ? { reviewTimeoutMs } : {}),
    }),
    checksOf,
    definitionAt: async (root, ref) => {
      const r = await definitionAt(root, ref, extra.git ?? realGit);
      return { def: r.def, error: r.error };
    },
    draftsHash: (dir) => draftsHash(dir),
    retryDelayMs: 200,
    watchMs: 200,
    conflictWaitMs: 60_000,
    log: () => {},
    ...rest,
  };
}

export class QueueHarness {
  readonly notices: Notice[] = [];
  readonly threadErrors: unknown[] = [];
  readonly reviews: { commit: string; runId: string }[] = [];
  queues!: MergeQueues;
  private q!: ProjectQueue;
  private readonly ingestSeen: string;
  private readonly landingFile: string;

  constructor(
    readonly fx: Fixture,
    readonly stateRoot: string,
    readonly o: HarnessOptions = {},
  ) {
    this.ingestSeen = join(stateRoot, "merge-queue", "typed-seen.json");
    this.landingFile = join(stateRoot, "landing.json");
  }

  private deps(): QueueDeps {
    return queueDeps(this.stateRoot, {
      notify: (kind, e, extra) => this.notices.push({ kind, to: e.session ?? "", branch: e.branch, text: noticeText(kind, e, extra) }),
      thread: (ev) => this.wakeThread(ev),
      ...(this.o.reviewer ? { reviewer: this.startReviewer } : {}),
      ...(this.o.reviewTimeoutMs ? { reviewTimeoutMs: this.o.reviewTimeoutMs } : {}),
      ...(this.o.conflictWaitMs ? { conflictWaitMs: this.o.conflictWaitMs } : {}),
      ...(this.o.legacyNames ? { legacyNames: this.o.legacyNames } : {}),
    });
  }

  /** The project's names file in the queue's records (store.ts namesFileOf). */
  namesFile(): string {
    return join(this.q.store.dir, "names.json");
  }
  setNames(names: string[]): void {
    mkdirSync(this.q.store.dir, { recursive: true });
    writeFileSync(this.namesFile(), JSON.stringify({ privateNames: names }) + "\n");
  }

  async start(): Promise<this> {
    mkdirSync(join(this.stateRoot, "merge-queue"), { recursive: true });
    this.queues = new MergeQueues(this.deps());
    this.q = await this.queues.get(this.fx.project);
    if (this.o.names !== null) this.setNames(this.o.names ?? []);
    // The first ingest read marks everything already in landing.json as old (as the server does at start).
    await this.ingest();
    return this;
  }

  // ---- stand-ins ----------------------------------------------------------------------------------

  private wakeThread(ev: ThreadEvent): boolean {
    const fn = this.o.thread?.[ev.kind as keyof ThreadStandIn];
    if (!fn) return false;
    setTimeout(() => {
      fn(this, ev.entry, ev).catch((e) => this.threadErrors.push(e));
    }, 0);
    return true;
  }

  private startReviewer: StartReviewer = async (o) => {
    const answerFn = this.o.reviewer!;
    this.reviews.push({ commit: o.commit, runId: o.runId });
    const a = await answerFn({ commit: o.commit, copy: o.copy, runId: o.runId });
    if (a === "crash") throw new Error("the stand-in reviewer crashed");
    if (a !== "hang") {
      // Answer as a reviewer chat does: through merge.review (the queue's own verb method), after it started.
      setTimeout(() => {
        this.q.review(o.runId, a).catch((e) => this.threadErrors.push(e));
      }, 20);
    }
    return { sessionId: `reviewer-${o.runId}-${o.attempt}`, stop: async () => {} };
  };

  // ---- the verbs ------------------------------------------------------------------------------------

  async add(p: { branch: string; commit?: string; withoutSpecs?: boolean; withoutReview?: boolean; session?: string }): Promise<MergeEntry> {
    const { entry } = await this.q.add({ ...p, by: "land-button", ...(p.session ? { session: p.session } : { session: `chat-${p.branch}` }) });
    return entry;
  }
  async tryAdd(p: { branch: string; commit?: string; withoutSpecs?: boolean; withoutReview?: boolean }): Promise<{ ok: true; entry: MergeEntry } | { ok: false; code: string; message: string }> {
    try {
      return { ok: true, entry: await this.add(p) };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? "error", message: (e as Error).message };
    }
  }
  /** The user's typed word in the branch's own chat: the worktree tool's own record, then the server's ingest. */
  async typed(p: { branch: string; commit: string; withoutReview?: boolean; withoutSpecs?: boolean; session?: string }): Promise<string[]> {
    recordGoAhead(
      { branch: p.branch, commit: p.commit, session: p.session ?? `chat-${p.branch}`, at: new Date().toISOString(), by: "owner-chat", ...(p.withoutSpecs ? { withoutSpecs: true } : {}), ...(p.withoutReview ? { withoutReview: true } : {}) } as Parameters<typeof recordGoAhead>[0],
      this.landingFile,
    );
    return this.ingest();
  }
  ingest(): Promise<string[]> {
    return ingestOnce({ file: this.landingFile, seenFile: this.ingestSeen, roots: () => [this.fx.project], queue: (root) => this.queues.get(root), refused: (s, text) => this.notices.push({ kind: "refused", to: s, branch: "", text }) });
  }
  cancel(entry: string): Promise<MergeEntry> {
    return this.q.cancel(entry);
  }
  pause(why?: string): Promise<void> {
    return this.q.pause(why);
  }
  resume(): Promise<void> {
    return this.q.resume();
  }
  answer(entry: string, answer: "accept" | "send-back" | "land-anyway"): Promise<MergeEntry> {
    return this.q.answer(entry, answer);
  }
  note(entry: string, text: string): Promise<MergeEntry> {
    return this.q.note(entry, text, "thread");
  }
  extend(entry: string, checks: string[], why: string, select?: string[]): Promise<MergeEntry> {
    return this.q.extend(entry, checks, why, select);
  }
  resolve(entry: string, j: { verdict: "no-behaviour-change" | "behaviour-differs"; files?: string[]; ours: string; theirs: string; proposal: string; commit?: string; note?: string }): Promise<MergeEntry> {
    return this.q.resolve(entry, j);
  }

  // ---- reads ----------------------------------------------------------------------------------------

  view(): Promise<MergeQueueView> {
    return this.q.view();
  }
  async entry(id: string): Promise<MergeEntry> {
    const e = this.q.entry(id);
    if (!e) throw new Error(`no entry ${id}`);
    return structuredClone(e) as MergeEntry;
  }
  run(id: string): MergeRun {
    const cur = this.q.currentRun();
    if (cur?.id === id) return structuredClone(cur);
    const r = this.q.store.readRun(id);
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }
  /** A step's log, whole (every step has one from its first line). */
  log(runId: string, stepId: string): string {
    const run = this.run(runId);
    const st = run.steps.find((s) => s.id === stepId);
    if (!st) throw new Error(`no step ${stepId} in ${runId}: ${run.steps.map((s) => s.id).join(", ")}`);
    return stepLog(this.runDir(runId), st, 100_000).join("\n");
  }
  runDir(runId: string): string {
    return this.q.store.runDir(runId);
  }
  async waitEntry(id: string, states: QState[] | ((e: MergeEntry) => boolean), ms = 120_000): Promise<MergeEntry> {
    const pred = typeof states === "function" ? states : (e: MergeEntry) => states.includes(e.state);
    let last: MergeEntry | undefined;
    return until(`entry ${id} ${typeof states === "function" ? "to match" : `in ${states.join("|")}`} (last: ${JSON.stringify(() => last?.state)})`, async () => {
      last = await this.entry(id);
      if (this.threadErrors.length) throw new Error(`the stand-in thread or reviewer failed: ${String(this.threadErrors[0])}`);
      return pred(last) ? last : null;
    }, ms, 50).catch((e) => {
      throw new Error(`${(e as Error).message}; entry now ${JSON.stringify({ state: last?.state, reason: last?.reason, run: last?.run })}`);
    });
  }
  async waitView(pred: (v: MergeQueueView) => boolean, what: string, ms = 120_000): Promise<MergeQueueView> {
    let last: MergeQueueView | undefined;
    return until(what, async () => {
      last = await this.view();
      return pred(last) ? last : null;
    }, ms, 50).catch((e) => {
      throw new Error(`${(e as Error).message}; view state ${last?.state} paused ${JSON.stringify(last?.paused)}`);
    });
  }
  idle(): Promise<void> {
    return this.q.idle();
  }

  // ---- stop and crash -------------------------------------------------------------------------------

  async stop(): Promise<void> {
    await this.queues?.stop();
  }

  /** Sova stops (the queue's stop: the run aborted) and starts again on the same records, in this process. */
  async restart(): Promise<void> {
    await this.queues.stop();
    this.queues = new MergeQueues(this.deps());
    this.q = await this.queues.get(this.fx.project);
  }

  /**
   * The queue runs in a child process that SIGKILLs itself right before (`before-ff`) or right after (`after-ff`)
   * the landing's fast-forward of the target; then a fresh queue in this process loads the same records and recovers.
   */
  async crashAt(fault: "before-ff" | "after-ff", o: { resume?: boolean } = {}): Promise<{ childExit: string; childLog: string }> {
    await this.queues.stop();
    const child = spawn(process.execPath, [join(REPO_ROOT, "server/merge-queue/testing/queue-child.ts"), JSON.stringify({ stateRoot: this.stateRoot, root: this.fx.project, fault, resume: o.resume === true })], {
      env: { ...process.env, PI_CODING_AGENT_DIR: this.stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childLog = "";
    child.stdout.on("data", (d) => (childLog += d));
    child.stderr.on("data", (d) => (childLog += d));
    const childExit = await new Promise<string>((done) => child.on("exit", (code, sig) => done(sig ?? String(code))));
    this.queues = new MergeQueues(this.deps());
    this.q = await this.queues.get(this.fx.project);
    return { childExit, childLog };
  }
}

export async function startHarness(fx: Fixture, stateRoot: string, o: HarnessOptions = {}): Promise<QueueHarness> {
  return new QueueHarness(fx, stateRoot, o).start();
}
