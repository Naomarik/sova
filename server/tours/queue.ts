import { randomUUID } from "node:crypto";
import { normalizeTourJob, type TourFailure, type TourJob, type TourSignInRequirement } from "../../shared/tour";
import { TourJobStore, tourJobTerminal } from "./job";

export type TourJobPatch = Partial<Pick<TourJob, "phase" | "completed" | "total" | "stepId" | "viewId" | "size" | "failure" | "editionId" | "requirements" | "quietAborts">>;
export type TourQueueTask = (job: TourJob, signal: AbortSignal, progress: (patch: TourJobPatch) => void) => Promise<{ phase?: "checking" | "ready"; editionId?: string } | void>;
export interface TourQueueRequest { tourId: string; sessionId: string; title: string; total: number; requirements?: TourJob["requirements"] }
export class TourJobBlocked extends Error {
  constructor(readonly requirements: NonNullable<TourJob["requirements"]>) { super("Recording needs operator input."); }
}
/** Only deliberate, bounded recorder findings may enter a report. Raw errors are never persisted. */
export class TourJobFailure extends Error {
  constructor(readonly failure: TourFailure) { super("Recording failed."); }
}
/** A patch applied to a job; a sign-in requirement goes with the needs-sign-in phase it belongs to. */
function merged(job: TourJob, patch: TourJobPatch): TourJob {
  const next: TourJob = { ...job, ...patch, queuePosition: undefined };
  if (next.phase !== "needs-sign-in" && next.requirements?.signIn) {
    const { signIn: _gone, ...rest } = next.requirements;
    next.requirements = Object.keys(rest).length ? rest : undefined;
  }
  return next;
}
export function readTourConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SOVA_TOUR_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 2;
}

export class TourJobQueue {
  private readonly store: TourJobStore;
  private readonly jobs = new Map<string, TourJob>();
  private readonly tasks = new Map<string, TourQueueTask>();
  private readonly running = new Map<string, AbortController>();
  private readonly waiting: string[] = [];
  /** Running jobs waiting for a sign-in: they keep their child and browser but not their slot. */
  private readonly parked = new Set<string>();
  private readonly listeners = new Set<(job: TourJob) => void>();
  private readonly deletedSessions = new Set<string>();
  private readonly idleWaiters = new Set<{ sessionId: string; resolve: () => void }>();
  private scheduled = false;
  private closed = false;
  readonly limit: number;
  readonly maxWaiting: number;
  /** `log`: where an unexplained failure's message goes (default the server log); never into the job. */
  constructor(private readonly options: { root: string; limit?: number; maxWaiting?: number; runner?: TourQueueTask; onChange?: (job: TourJob) => void; log?: (line: string) => void }) {
    this.limit = options.limit ?? readTourConcurrency();
    this.maxWaiting = options.maxWaiting ?? 32;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 4 || !Number.isInteger(this.maxWaiting) || this.maxWaiting < 1 || this.maxWaiting > 256) throw new Error("Invalid recording queue limits.");
    this.store = new TourJobStore(options.root);
    for (const job of this.store.recover()) this.jobs.set(job.id, job);
    if (options.onChange) this.listeners.add(options.onChange);
  }
  subscribe(listener: (job: TourJob) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(sessionId: string, id: string): TourJob | null {
    const job = this.jobs.get(id);
    return job?.sessionId === sessionId ? structuredClone(job) : null;
  }
  list(sessionId: string): TourJob[] { return [...this.jobs.values()].filter(j => j.sessionId === sessionId).map(j => structuredClone(j)); }
  enqueue(input: TourQueueRequest, task: TourQueueTask | undefined = this.options.runner): TourJob {
    if (this.deletedSessions.has(input.sessionId)) throw new Error("This chat was deleted. Its recording requests are no longer available.");
    if (this.closed) throw new Error("Recording queue is shutting down. Request Retry after restart.");
    if (!task) throw new Error("Recording runner is unavailable.");
    if ([...this.jobs.values()].filter(j => ["queued", "needs-site-approval", "needs-test-account"].includes(j.phase)).length + this.parked.size >= this.maxWaiting) {
      const parked = [...this.parked].map(id => this.jobs.get(id)?.title).filter(Boolean)[0];
      throw new Error(parked ? `The recording queue is full while \u201c${parked}\u201d waits for a sign-in. Answer or cancel it, then retry.` : "The recording queue is full. Wait for a recording to finish, then retry; split oversized tours into smaller tours.");
    }
    const now = new Date().toISOString();
    const requirements = input.requirements;
    const phase = requirements?.origins?.length ? "needs-site-approval" : requirements?.testAccount ? "needs-test-account" : "queued";
    // Explicit fields prevent caller-owned context and secrets being spread into the record.
    const job = this.put({ v: 1, id: randomUUID(), tourId: input.tourId, sessionId: input.sessionId, title: input.title, total: input.total, completed: 0, phase, requirements, ...(phase === "queued" ? { queuePosition: this.waiting.length + 1 } : {}), createdAt: now, updatedAt: now });
    this.tasks.set(job.id, task);
    if (phase === "queued") this.waiting.push(job.id);
    this.positions(); this.schedule();
    return this.get(job.sessionId, job.id)!;
  }
  /** Called only after fresh consent/account preflight. Never replays interrupted jobs. */
  resume(sessionId: string, id: string): TourJob | null {
    const job = this.get(sessionId, id);
    if (!job || !["needs-site-approval", "needs-test-account"].includes(job.phase) || this.running.has(id)) return null;
    if (this.closed || this.deletedSessions.has(sessionId) || !this.tasks.has(id)) return null;
    if (this.waiting.length >= this.maxWaiting) throw new Error("The recording queue is full. Retry when a place is available.");
    this.put({ ...job, phase: "queued", requirements: undefined, queuePosition: this.waiting.length + 1 });
    this.waiting.push(id); this.positions(); this.schedule();
    return this.get(sessionId, id);
  }
  /**
   * A running job waits for a sign-in: it keeps its child and browser, and frees its slot. Parked
   * browsers are capped at the concurrency limit; past it the job fails, naming the waiting ones.
   */
  park(id: string, signIn: TourSignInRequirement): TourJob {
    const job = this.jobs.get(id);
    if (!job || !this.running.has(id) || tourJobTerminal(job)) throw new Error("Recording job not found.");
    if (!this.parked.has(id) && this.parked.size >= this.limit) {
      const titles = [...this.parked].map(p => `\u201c${this.jobs.get(p)?.title ?? "a recording"}\u201d`).join(", ");
      throw new TourJobFailure({ message: `Too many recordings are waiting for a sign-in (${titles}). Answer or cancel one, then record again.`, guidance: "The previous checked edition is unchanged." });
    }
    const changed = this.put({ ...job, phase: "needs-sign-in", requirements: { signIn }, queuePosition: undefined });
    this.parked.add(id); this.schedule();
    return structuredClone(changed);
  }
  /** Answered: the parked job continues at once with the browser it kept, even while every slot is busy. */
  unpark(id: string, phase: "dry-run" | "recording"): void {
    if (!this.parked.delete(id)) return;
    const job = this.jobs.get(id);
    if (job && job.phase === "needs-sign-in") this.put({ ...job, phase, requirements: undefined });
  }
  update(id: string, patch: TourJobPatch): TourJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Recording job not found.");
    if (tourJobTerminal(job)) return structuredClone(job);
    if (patch.phase === "ready" && !(patch.editionId ?? job.editionId)) throw new Error("A ready recording requires a checked edition reference.");
    const changed = this.put(merged(job, patch));
    return structuredClone(changed);
  }
  cancel(sessionId: string, id: string): TourJob | null {
    const job = this.get(sessionId, id);
    if (!job || tourJobTerminal(job)) return job;
    const i = this.waiting.indexOf(id); if (i !== -1) this.waiting.splice(i, 1);
    this.put({ ...job, phase: "cancelled", queuePosition: undefined, requirements: undefined, failure: undefined });
    this.tasks.delete(id);
    // Slot is held until the runner confirms cleanup by settling. Abort alone is not cleanup.
    this.running.get(id)?.abort();
    this.positions(); this.schedule();
    return this.get(sessionId, id);
  }
  /** Settlement means the task's runner finally/cleanup has returned, not merely abort signalled. */
  waitForSessionIdle(sessionId: string): Promise<void> {
    if (![...this.running.keys()].some(id => this.jobs.get(id)?.sessionId === sessionId)) return Promise.resolve();
    return new Promise(resolve => { this.idleWaiters.add({ sessionId, resolve }); });
  }
  async cancelSession(sessionId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const job of this.list(sessionId)) {
      try { this.cancel(sessionId, job.id); } catch (error) { errors.push(error); }
    }
    // Persistence failure must not skip abort or let rejection masquerade as completed cleanup.
    // Also abort a still-settling runner even if it prematurely reported a terminal phase.
    for (const [id, abort] of this.running) if (this.jobs.get(id)?.sessionId === sessionId) {
      try { abort.abort(); } catch (error) { errors.push(error); }
    }
    await this.waitForSessionIdle(sessionId);
    if (errors.length) throw new AggregateError(errors, "Some recording cancellation state could not be saved after runner cleanup.");
  }
  /** Actual deletion only. Caller first revokes links and guards its separate private writes. */
  async removeSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    const errors: unknown[] = [];
    try { await this.cancelSession(sessionId); } catch (error) { errors.push(error); }
    // Cancellation errors are reported only after idle, and cannot skip the remaining cleanup.
    try { this.store.removeSession(sessionId); } catch (error) { errors.push(error); }
    for (const job of this.list(sessionId)) { this.jobs.delete(job.id); this.tasks.delete(job.id); }
    if (errors.length) throw new AggregateError(errors, "Some tour job state could not be removed after runner cleanup.");
  }
  /** Stop scheduling and abort children; recovery on next startup makes interruption explicit. */
  close(): void { this.closed = true; for (const abort of this.running.values()) abort.abort(); }
  private put(job: TourJob): TourJob {
    const checked = normalizeTourJob({ ...job, updatedAt: new Date().toISOString() });
    if (!checked) throw new Error("Invalid recording job update.");
    this.store.save(checked); this.jobs.set(checked.id, checked);
    for (const listener of this.listeners) { try { listener(structuredClone(checked)); } catch { /* a disconnected card cannot fail a recording */ } }
    return checked;
  }
  private positions(): void {
    this.waiting.forEach((id, i) => {
      const job = this.jobs.get(id)!;
      if (job.queuePosition !== i + 1) this.put({ ...job, queuePosition: i + 1 });
    });
  }
  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }
  private drain(): void {
    if (this.closed) return;
    while (this.running.size - this.parked.size < this.limit) {
      const active = [...this.running.keys()].map(id => this.jobs.get(id)!);
      const index = this.waiting.findIndex(id => { const j = this.jobs.get(id)!; return !active.some(a => a.sessionId === j.sessionId && a.tourId === j.tourId); });
      if (index === -1) break;
      const [id] = this.waiting.splice(index, 1); const job = this.jobs.get(id!)!;
      const abort = new AbortController(); this.running.set(job.id, abort);
      this.put({ ...job, phase: "dry-run", queuePosition: undefined });
      this.positions();
      void this.execute(job.id, abort);
    }
  }
  private async execute(id: string, abort: AbortController): Promise<void> {
    try {
      const result = await this.tasks.get(id)!(structuredClone(this.jobs.get(id)!), abort.signal, patch => {
        if (!abort.signal.aborted && !this.closed) this.update(id, patch);
      });
      if (!abort.signal.aborted && !this.closed) this.update(id, { phase: result?.phase ?? "checking", ...(result?.editionId ? { editionId: result.editionId } : {}) });
    } catch (error) {
      if (!abort.signal.aborted && !this.closed) {
        const generic: TourJobPatch = { phase: "failed", failure: { message: "Recording could not finish.", guidance: "The previous checked edition is unchanged. Review the recording setup and request Retry." } };
        // The job says only "could not finish"; the log says what threw (its message alone, bounded; the
        // runtime has already replaced a message carrying a sign-in detail).
        if (!(error instanceof TourJobBlocked) && !(error instanceof TourJobFailure)) {
          const what = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
          try { (this.options.log ?? (line => console.warn(line)))(`[tours] recording ${id} could not finish: ${what}`); } catch { /* logging can't fail a recording */ }
        }
        const patch: TourJobPatch = error instanceof TourJobBlocked
          ? { phase: error.requirements.origins?.length ? "needs-site-approval" : "needs-test-account", requirements: error.requirements }
          : error instanceof TourJobFailure ? { phase: "failed", failure: error.failure } : generic;
        // A malformed recorder finding must still fail and free the slot, never reject this task's catch handler.
        this.update(id, normalizeTourJob(merged(this.jobs.get(id)!, patch)) ? patch : generic);
      }
    } finally {
      this.running.delete(id); this.parked.delete(id);
      const phase = this.jobs.get(id)?.phase;
      if (phase !== "needs-site-approval" && phase !== "needs-test-account") this.tasks.delete(id);
      try { this.positions(); this.schedule(); }
      finally {
        for (const waiter of this.idleWaiters) {
          if (![...this.running.keys()].some(jobId => this.jobs.get(jobId)?.sessionId === waiter.sessionId)) {
            this.idleWaiters.delete(waiter); waiter.resolve();
          }
        }
      }
    }
  }
}
