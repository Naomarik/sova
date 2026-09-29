// OrgHost: one org's engine and its runtime (design §2, §5.3; engine API §4).
//
// One engine per org, one serialized queue: every step and its journal commit are synchronous, so
// two acts never interleave (a route may trial, call something synchronous, then `actNow`, and
// nothing steps in between). Effects and invocations run outside the step; their answers come back
// as events through the same queue. The only asynchronous stretch is open (journal replay, loading,
// resume in chunks), during which `actNow` throws `busy` and `act` waits.
//
// Durability: each committed call is a redo journal (store.ts); pending effects live in the
// snapshots (`sova/pending`), so at open every un-answered effect is run again with its key (every
// effect handler is idempotent by key). One timer follows the engine's `nextDueAt`.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import {
  chartInfo as chartInfoOf,
  chartVersions,
  createOrgCharts,
  type SnapshotPeek,
  type EnabledEvent,
  type EngineOptions,
  type Hold,
  type InvocationRecord,
  type Json,
  type JsonObject,
  type OrgCharts,
  type Refusal,
  type StampContext,
  type Step,
  type StepResult,
} from "../org-charts";
import { DEFAULT_REDACT, lastAt, readRows, rowOfStep, scrub, segmentFile, type LogProblem, type LogRow, type RedactRule, type RowFilter } from "./log";
import { commitJournal, hostPaths, journalId, replayJournals, scanSnapshots, snapshotFile, type HostPaths, type Journal, type JournalProblem } from "./store";

export type Envelope = Record<string, unknown>;

export interface ActResult {
  /** The chart took the act (or holds it: `held`). */
  taken: boolean;
  refusal: Refusal | null;
  /** The act waits in a hold (q10); it goes ahead at `held.until` unless cancelled. */
  held?: Hold;
  result: StepResult | null;
  /** With `settle`: every effect this call emitted, once answered. */
  effects?: EffectOutcome[];
}

export interface EffectOutcome {
  kind: string;
  key: string;
  result?: unknown;
  error?: string;
}

export interface Effect {
  kind: string;
  key: string;
  sessionId: string;
  [field: string]: unknown;
}

export interface Invocation {
  sessionId: string;
  /** The run id: the report goes back with it. */
  invokeId: string;
  type: string;
  params?: Record<string, unknown>;
}

/** How a runner reports: `data` goes into the result event with `detail` (e.g. wrapup/finished
    {applied, refused}, reconcile/finished {decisions, conflicts, …}). */
export type InvocationReport = (outcome: "finished" | "stopped" | "not-started", detail?: string, data?: Record<string, unknown>) => void;

export interface InvocationRunner {
  start(inv: Invocation, report: InvocationReport): void;
  stop(inv: Invocation): void;
}

/** One entry of a project's feed (q12). */
export interface FeedEntry {
  at: number;
  session: string | null;
  chart: string | null;
  event: string;
  by: string | null;
  before: string[];
  after: string[];
  effects: string[];
  feed: "feed" | "quiet";
  refused?: string;
  held?: LogRow["held"];
  reason?: string;
}

export interface SessionInfo {
  id: string;
  chart: string;
  configuration: string[];
  data: Record<string, unknown>;
  running: boolean;
}

export interface HostChange {
  sessions: string[];
  steps: Step[];
}

export interface HostProblem {
  kind: "snapshot" | "journal" | "log" | "resume";
  file: string;
  why: string;
  sessionId?: string;
}

export type Stamp = (sid: string, event: string, payload: Record<string, unknown>, who?: StampContext) => Envelope;

export interface OrgHostOptions {
  orgId: string;
  workspaceDir: string;
  /** Sova's state root: host-local charts live in `<stateDir>/org-charts/<orgId>/`. */
  stateDir: string;
  /** A fresh envelope for an act the engine delivers itself (a held act's release, a chart's drive). */
  stamp?: Stamp;
  clock?: () => number;
  /** fsync journals and snapshots (default true; tests turn it off). */
  durable?: boolean;
  /** Sessions resumed per macrotask at open (default 50). */
  chunk?: number;
  /** Tests: more charts (JS trees), passed to the engine. */
  charts?: EngineOptions["charts"];
  /** Tests (kill-9 fuzz): called between the journal write and applying it, and after applying it. */
  commitHooks?: { afterJournal?: () => void; afterApply?: () => void };
}

/** A session file the host can't read: every event to it is refused with this sentence (409). */
export class OrgWorkspaceError extends Error {
  readonly status = 409;
  readonly code = "workspace";
  constructor(readonly file: string) {
    super(`The workspace repo has a problem: ${file} can't be read. Fix or restore it, then reload.`);
    this.name = "OrgWorkspaceError";
  }
  get refusal(): Refusal {
    return { sentence: this.message, stage: "workspace", status: 409, code: "workspace" };
  }
}

export class OrgHostBusyError extends Error {
  readonly code = "busy";
  constructor() {
    super("The organization's engine is resuming; try again in a moment.");
    this.name = "OrgHostBusyError";
  }
}

const STALE: Refusal = { sentence: "That result is for a run that has ended.", stage: "stale" };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outcomeEvent(type: string, outcome: string): string {
  const name = type.includes("/") ? type.slice(type.indexOf("/") + 1) : type;
  return `${name}/${outcome}`;
}

export class OrgHost {
  readonly orgId: string;
  readonly paths: HostPaths;
  private readonly engine: OrgCharts;
  private readonly durable: boolean;
  private readonly clock: () => number;
  private readonly storage = new Map<string, "portable" | "host-local">();
  private readonly redact = new Map<string, Record<string, RedactRule>>();
  /** Every session file known (warm or cold): sid → {file, chart}. */
  private readonly index = new Map<string, { file: string; chart: string }>();
  private readonly broken = new Map<string, HostProblem>();
  private journalProblem: JournalProblem | null = null;
  /** Sessions whose resume (or the past-due timers) threw at open: reported, boot went on. */
  private readonly stuck: HostProblem[] = [];
  private readonly logProblems: LogProblem[] = [];
  private resuming = true;
  private readyWaiters: (() => void)[] = [];
  private readonly effectHandlers = new Map<string, (effect: Effect) => Promise<unknown>>();
  private readonly runners = new Map<string, InvocationRunner>();
  private readonly running = new Map<string, Promise<EffectOutcome>>();
  private readonly listeners: ((change: HostChange) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private lastRowAt = 0;
  private readonly peeks = new Map<string, { mtime: number; peek: SnapshotPeek }>();
  private closed = false;

  readonly effects = {
    /** Every effect of `kind` still pending (e.g. from before a crash) runs as its handler registers. */
    register: (kind: string, fn: (effect: Effect) => Promise<unknown>): void => {
      this.effectHandlers.set(kind, fn);
      this.runPending(kind);
    },
  };

  readonly invocations = {
    register: (type: string, runner: InvocationRunner): void => {
      this.runners.set(type, runner);
    },
  };

  readonly log = {
    rows: (filter: RowFilter = {}): LogRow[] => readRows([this.paths.portableLog, this.paths.localLog], filter, this.logProblems),
    row: (at: number): LogRow | null => this.log.rows({ since: at, until: at })[0] ?? null,
  };

  /** q12/r8a: a project's feed, the transitions of its sessions as the log holds them (redacted by the
      same rules), feed-class rows only unless `includeQuiet`. It raises nothing: the overseer reads it. */
  feed(projectId: string, opts: { since?: number; limit?: number; includeQuiet?: boolean; newestFirst?: boolean } = {}): FeedEntry[] {
    const rows = readRows([this.paths.portableLog, this.paths.localLog], { since: opts.since, newestFirst: opts.newestFirst }, this.logProblems)
      .filter((r) => r.project === projectId && (opts.includeQuiet || r.feed !== "quiet"));
    return (opts.limit != null ? rows.slice(0, opts.limit) : rows).map((r) => ({
      at: r.at,
      session: r.session,
      chart: r.chart,
      event: r.event,
      by: r.by,
      before: r.before,
      after: r.after,
      effects: r.effects,
      feed: r.feed ?? "feed",
      ...(r.refused ? { refused: r.refused } : {}),
      ...(r.held ? { held: r.held } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }

  static async open(opts: OrgHostOptions): Promise<OrgHost> {
    const host = new OrgHost(opts);
    await host.boot(opts.chunk ?? 50);
    return host;
  }

  private constructor(private readonly opts: OrgHostOptions) {
    this.orgId = opts.orgId;
    this.paths = hostPaths(opts.orgId, opts.workspaceDir, opts.stateDir);
    this.durable = opts.durable ?? true;
    this.clock = opts.clock ?? Date.now;
    this.engine = createOrgCharts({
      charts: opts.charts,
      loadCold: (sid) => this.loadCold(sid),
      stamp: (sid, event, payload, ctx) => (opts.stamp ? (opts.stamp(sid, event, payload, ctx) as JsonObject) : {}),
    });
    for (const c of chartVersions()) this.storage.set(c.name, c.storage ?? "portable");
    for (const [name, c] of Object.entries(opts.charts ?? {})) this.storage.set(name, ((c as { storage?: string }).storage as "host-local") ?? "portable");
  }

  // ---- open ------------------------------------------------------------------------------------

  private async boot(chunk: number): Promise<void> {
    mkdirSync(this.paths.journal, { recursive: true });
    const { problem } = replayJournals(this.paths.journal, this.durable);
    this.journalProblem = problem;
    this.lastRowAt = lastAt([this.paths.portableLog, this.paths.localLog]);
    const sids: string[] = [];
    let loaded = 0;
    for (const root of [this.paths.portable, this.paths.local]) {
      for (const { sid, chart, file } of scanSnapshots(root)) {
        // loading is chunked like resume: no single blocking slice (C09)
        if (++loaded % chunk === 0) await new Promise<void>((r) => setImmediate(r));
        this.index.set(sid, { file, chart });
        try {
          this.engine.load(sid, readFileSync(file, "utf8"));
          sids.push(sid);
        } catch (err) {
          this.broken.set(sid, { kind: "snapshot", file, why: message(err), sessionId: sid });
        }
      }
    }
    const started: InvocationRecord[] = [];
    if (!this.journalProblem) {
      // One session never aborts an org's boot: a chunk that throws is resumed one session at a
      // time, and a session whose resume still throws is a problem (it stays readable).
      const resume = (part: string[]): void => {
        const r = this.engine.resume(part, { now: this.clock() });
        this.commit(r);
        started.push(...r.invocations);
      };
      for (let i = 0; i < sids.length; i += chunk) {
        await new Promise<void>((r) => setImmediate(r));
        const part = sids.slice(i, i + chunk);
        try {
          resume(part);
        } catch {
          for (const sid of part)
            try {
              resume([sid]);
            } catch (err) {
              this.stuck.push({ kind: "resume", file: this.index.get(sid)?.file ?? sid, why: message(err), sessionId: sid });
            }
        }
      }
      try {
        const r = this.engine.fireDue(this.clock());
        this.commit(r);
        started.push(...r.invocations);
      } catch (err) {
        this.stuck.push({ kind: "resume", file: this.paths.journal, why: `past-due timers: ${message(err)}` });
      }
    }
    this.resuming = false;
    for (const w of this.readyWaiters.splice(0)) w();
    // runners are registered right after open resolves: start any invocation resume entered then.
    // (Pending effects run as each kind's handler registers: `effects.register`.)
    setImmediate(() => {
      for (const inv of started) this.runInvocation(inv);
    });
    this.arm();
    this.sweeper = setInterval(() => this.sweepCold(), 3600_000);
    this.sweeper.unref?.();
  }

  private ready(): Promise<void> {
    return this.resuming ? new Promise((r) => this.readyWaiters.push(r)) : Promise.resolve();
  }

  private loadCold(sid: string): string | null {
    const bad = this.broken.get(sid);
    if (bad) throw new OrgWorkspaceError(bad.file);
    const entry = this.index.get(sid);
    if (!entry || !existsSync(entry.file)) return null;
    try {
      return readFileSync(entry.file, "utf8");
    } catch (err) {
      this.broken.set(sid, { kind: "snapshot", file: entry.file, why: message(err), sessionId: sid });
      throw new OrgWorkspaceError(entry.file);
    }
  }

  // ---- the step --------------------------------------------------------------------------------

  private chartOfSid(sid: string): string {
    return this.engine.chartOf(sid) ?? this.index.get(sid)?.chart ?? sid.split("/")[0] ?? "unknown";
  }

  private isLocal(chart: string | null | undefined): boolean {
    return this.storage.get(chart ?? "") === "host-local";
  }

  private rulesOf(chart: string | null | undefined): Record<string, RedactRule> {
    const name = chart ?? "";
    let r = this.redact.get(name);
    if (!r) {
      const runtime = (this.opts.charts as Record<string, { redact?: Record<string, RedactRule> }> | undefined)?.[name]?.redact;
      const info = runtime ? null : chartInfoOf(name);
      r = { ...DEFAULT_REDACT, ...((runtime ?? info?.redact ?? {}) as Record<string, RedactRule>) };
      this.redact.set(name, r);
    }
    return r;
  }

  private uniqueAt(at: number): number {
    const t = Math.max(at, this.lastRowAt + 1);
    this.lastRowAt = t;
    return t;
  }

  private logFileFor(chart: string | null | undefined, at: number): string {
    return segmentFile(this.isLocal(chart) ? this.paths.localLog : this.paths.portableLog, at);
  }

  /** Journal and apply one call's snapshots and log rows (synchronous). */
  private commit(r: StepResult, extra?: { startEnvelope?: Envelope }): void {
    const id = journalId(this.clock());
    const rows = r.steps
      .filter((s) => s.saved || s.refused || s.held)
      .map((s) => {
        const row = rowOfStep(this.orgId, s, this.rulesOf(s.chart));
        if (s.event === "sova/started" && extra?.startEnvelope) {
          row.start = row.envelope;
          row.envelope = scrub(extra.startEnvelope, this.rulesOf(s.chart));
        }
        row.at = this.uniqueAt(s.at);
        if (row.at !== s.at) row.t = s.at;
        row.j = id;
        return { file: this.logFileFor(s.chart, row.at), row };
      });
    const snapshots = Object.entries(r.snapshots).map(([sessionId, text]) => {
      const chart = this.chartOfSid(sessionId);
      const file = snapshotFile(this.isLocal(chart) ? this.paths.local : this.paths.portable, chart, sessionId);
      this.index.set(sessionId, { file, chart });
      return { sessionId, file, text };
    });
    if (!rows.length && !snapshots.length) return;
    const j: Journal = { id, at: this.clock(), snapshots, rows };
    commitJournal(this.paths.journal, j, this.durable, this.opts.commitHooks);
  }

  /** A synchronous engine call, committed, then its effects, invocations, listeners and timer. */
  private step<R extends StepResult>(f: () => R, extra?: { startEnvelope?: Envelope }): R {
    if (this.closed) throw new Error("The organization's engine is closed.");
    if (this.journalProblem) throw new OrgWorkspaceError(this.journalProblem.file);
    const r = f();
    this.commit(r, extra);
    this.after(r);
    return r;
  }

  private after(r: StepResult): void {
    for (const e of r.outbox) this.runEffect(e as Effect);
    for (const inv of r.invocations) this.runInvocation(inv);
    const sessions = [...new Set(r.steps.filter((s) => s.saved).map((s) => s.sessionId))];
    if (sessions.length || r.steps.length) {
      for (const fn of this.listeners)
        try {
          fn({ sessions, steps: r.steps });
        } catch (err) {
          console.warn(`[org-host] change listener: ${message(err)}`);
        }
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.journalProblem) return;
    const due = this.engine.nextDueAt();
    if (due == null) return;
    const wait = Math.min(Math.max(0, due - this.clock()), 24 * 3600_000);
    this.timer = setTimeout(() => this.fire(), wait);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.closed || this.resuming) return;
    try {
      this.step(() => this.engine.fireDue(this.clock()));
    } catch (err) {
      console.warn(`[org-host] ${this.orgId}: timers: ${message(err)}`);
      this.arm();
    }
  }

  // ---- effects and invocations -------------------------------------------------------------------

  private runPending(kind: string): void {
    if (this.closed || this.journalProblem) return;
    for (const sid of this.engine.sessions()) {
      const pending = (this.engine.data(sid)?.["sova/pending"] ?? {}) as Record<string, JsonObject>;
      for (const [key, e] of Object.entries(pending)) {
        if (e["kind"] !== kind) continue;
        this.runEffect({ ...(e as Record<string, unknown>), key, sessionId: sid } as Effect);
      }
    }
  }

  private runEffect(e: Effect): Promise<EffectOutcome> {
    const have = this.running.get(e.key);
    if (have) return have;
    const handler = this.effectHandlers.get(e.kind);
    if (!handler) return Promise.resolve({ kind: e.kind, key: e.key, error: `No handler for effect ${e.kind} on this host.` });
    const p = (async (): Promise<EffectOutcome> => {
      let out: EffectOutcome;
      try {
        const result = await handler(e);
        out = { kind: e.kind, key: e.key, result };
      } catch (err) {
        out = { kind: e.kind, key: e.key, error: message(err) };
      }
      await this.ready();
      if (this.closed) return out;
      try {
        this.step(() =>
          this.engine.send(e.sessionId, out.error == null ? "effect/done" : "effect/failed", out.error == null ? { key: e.key, result: (out.result ?? null) as Json } : { key: e.key, detail: out.error }, { now: this.clock() }),
        );
      } catch (err) {
        console.warn(`[org-host] ${this.orgId}: answering effect ${e.key}: ${message(err)}`);
      }
      return out;
    })();
    this.running.set(e.key, p);
    void p.finally(() => this.running.delete(e.key));
    return p;
  }

  private runInvocation(rec: InvocationRecord): void {
    const inv: Invocation = { sessionId: rec.sessionId, invokeId: rec.runId ?? rec.invokeId, type: rec.type, ...(rec.params ? { params: rec.params } : {}) };
    const runner = this.runners.get(rec.type);
    if (rec.op === "stop") {
      runner?.stop(inv);
      return;
    }
    const report: InvocationReport = (outcome, detail, data) => {
      void (async () => {
        await this.ready();
        if (this.closed) return;
        try {
          const payload = { ...(data ?? {}), ...(detail ? { detail } : {}) } as JsonObject;
          this.step(() => this.engine.send(inv.sessionId, outcomeEvent(inv.type, outcome), payload, { now: this.clock(), invokeId: inv.invokeId }));
        } catch (err) {
          console.warn(`[org-host] ${this.orgId}: reporting ${inv.type}: ${message(err)}`);
        }
      })();
    };
    if (!runner) {
      report("not-started", `Nothing runs ${rec.type} on this host.`);
      return;
    }
    try {
      runner.start(inv, report);
    } catch (err) {
      report("not-started", message(err));
    }
  }

  // ---- acts ------------------------------------------------------------------------------------------

  private answer(sid: string, event: string, r: StepResult): ActResult {
    const mine = r.steps.find((s) => s.sessionId === sid && s.event === event);
    if (!mine) return { taken: false, refusal: STALE, result: r };
    if (mine.refused) return { taken: false, refusal: mine.refused, result: r };
    if (mine.held) return { taken: true, held: mine.held, refusal: null, result: r };
    if (mine.ignored) return { taken: false, refusal: { sentence: "That can't be done now.", stage: "state" }, result: r };
    return { taken: true, refusal: null, result: r };
  }

  private guard<T extends ActResult>(f: () => T): T | ActResult {
    try {
      return f();
    } catch (err) {
      if (err instanceof OrgWorkspaceError) return { taken: false, refusal: err.refusal, result: null };
      throw err;
    }
  }

  /** Step an act now, synchronously (the share route's one synchronous stretch). Throws `busy` while resuming. */
  actNow(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): ActResult {
    if (this.resuming) throw new OrgHostBusyError();
    return this.guard(() => {
      const r = this.step(() => this.engine.send(sid, event, { ...payload, ...envelope } as JsonObject, { now: this.clock() }));
      return this.answer(sid, event, r);
    });
  }

  /** Step an act (after open finished). `settle`: resolve once this call's effects were answered. */
  async act(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope, opts: { settle?: boolean } = {}): Promise<ActResult> {
    await this.ready();
    const out = this.actNow(sid, event, payload, envelope);
    if (opts.settle && out.result) out.effects = await this.settle(out.result);
    return out;
  }

  /** Every effect `r` emitted, answered. */
  async settle(r: StepResult): Promise<EffectOutcome[]> {
    return Promise.all(r.outbox.map((e) => this.runEffect(e as Effect)));
  }

  async start(sid: string, chart: string, data: Record<string, unknown>, envelope: Envelope = {}): Promise<StepResult> {
    await this.ready();
    return this.step(() => this.engine.start(sid, chart, data as JsonObject, { now: this.clock() }), { startEnvelope: envelope });
  }

  /** q9/r5 free set-state (the engine refuses anyone but the project overseer in an attended turn). */
  async setState(sid: string, change: { states: string[]; patch?: Record<string, unknown>; reason: string }, envelope: Envelope): Promise<ActResult> {
    await this.ready();
    return this.guard(() => {
      const r = this.step(() => this.engine.setState(sid, { states: change.states, patch: change.patch as JsonObject, reason: change.reason }, envelope as JsonObject, { now: this.clock() }));
      return this.answer(sid, "sova/set-state", r);
    });
  }

  /** A log row for an act no chart takes (note, idea, to-do, confirm). */
  async logAct(row: Record<string, unknown>): Promise<void> {
    const at = this.uniqueAt(typeof row["at"] === "number" ? (row["at"] as number) : this.clock());
    const chart = typeof row["chart"] === "string" ? (row["chart"] as string) : null;
    // `plain`: no chart step wrote it (a log replay skips it)
    const full = { feed: "feed", ...(scrub(row, this.rulesOf(chart)) as Record<string, Json>), at, org: this.orgId, plain: true } as LogRow;
    const j: Journal = { id: journalId(this.clock()), at, snapshots: [], rows: [{ file: this.logFileFor(chart, at), row: full }] };
    commitJournal(this.paths.journal, j, this.durable);
  }

  /** The earliest pending delayed event (the host's own timer follows it). */
  nextDueAt(): number | null {
    return this.engine.nextDueAt();
  }

  /** Fire everything due at `clock()` now (a virtual-clock replay; in production the host's timer does
      this itself). Throws busy while resuming. */
  fireDue(): StepResult {
    if (this.resuming) throw new OrgHostBusyError();
    return this.step(() => this.engine.fireDue(this.clock()));
  }

  // ---- reads -------------------------------------------------------------------------------------------

  trial(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): ActResult {
    try {
      const r = this.engine.trial(sid, event, { ...payload, ...envelope } as JsonObject, { now: this.clock() });
      return { taken: r.taken, refusal: r.taken ? null : (r.refusalInfo ?? { sentence: r.refusal ?? "That can't be done now." }), result: r };
    } catch (err) {
      if (err instanceof OrgWorkspaceError) return { taken: false, refusal: err.refusal, result: null };
      throw err;
    }
  }

  explain(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): Refusal | null {
    return this.engine.explain(sid, event, { ...payload, ...envelope } as JsonObject, { now: this.clock() });
  }

  enabledEvents(sid: string, envelope: Envelope): EnabledEvent[] {
    return this.engine.enabledEvents(sid, envelope as JsonObject, { now: this.clock() });
  }

  /** A cold session's snapshot, read (not loaded) and cached by file mtime; null when unknown or unreadable. */
  private peek(sid: string): SnapshotPeek | null {
    const entry = this.index.get(sid);
    if (!entry || this.broken.has(sid)) return null;
    try {
      const mtime = statSync(entry.file).mtimeMs;
      const have = this.peeks.get(sid);
      if (have && have.mtime === mtime) return have.peek;
      const peek = this.engine.peek(readFileSync(entry.file, "utf8"));
      this.peeks.set(sid, { mtime, peek });
      return peek;
    } catch {
      return null;
    }
  }

  /** Warm sessions from the engine; cold ones (unloaded by retention) from their snapshot, read-only. */
  configuration(sid: string): string[] | null {
    return this.engine.configuration(sid) ?? this.peek(sid)?.configuration ?? null;
  }

  data(sid: string): Record<string, unknown> | null {
    return this.engine.data(sid) ?? this.peek(sid)?.data ?? null;
  }

  chartOf(sid: string): string | null {
    return this.engine.chartOf(sid) ?? this.index.get(sid)?.chart ?? null;
  }

  chartInfo(name: string): ReturnType<typeof chartInfoOf> {
    return chartInfoOf(name);
  }

  /** Every session of the org (of `chart`): warm ones from the engine and, unless `warmOnly`, cold
      ones from their snapshots (lists keep settled batons, builds, decisions). Broken ones are not
      listed (they are in `problems()`). */
  sessions(chart?: string, opts: { warmOnly?: boolean } = {}): SessionInfo[] {
    const warm = new Set(this.engine.sessions());
    const out: SessionInfo[] = [...warm]
      .filter((sid) => !chart || this.engine.chartOf(sid) === chart)
      .map((id) => ({ id, chart: this.engine.chartOf(id) ?? "", configuration: this.engine.configuration(id) ?? [], data: this.engine.data(id) ?? {}, running: this.engine.running(id) }));
    if (!opts.warmOnly) {
      for (const [id, entry] of this.index) {
        if (warm.has(id) || (chart && entry.chart !== chart)) continue;
        const p = this.peek(id);
        if (p) out.push({ id, chart: p.chart, configuration: p.configuration, data: p.data, running: p.running });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  holds(): Hold[] {
    return this.engine.holds(null);
  }

  problems(): HostProblem[] {
    return [
      ...(this.journalProblem ? [{ kind: "journal" as const, ...this.journalProblem }] : []),
      ...this.broken.values(),
      ...this.stuck,
      ...this.logProblems.map((p) => ({ kind: "log" as const, ...p })),
    ];
  }

  onChange(fn: (change: HostChange) => void): void {
    this.listeners.push(fn);
  }

  /** Retry what did not load (the Workspace tab's Reload): a fixed journal, broken snapshots. */
  async reload(): Promise<HostProblem[]> {
    if (this.journalProblem) {
      const { problem } = replayJournals(this.paths.journal, this.durable);
      this.journalProblem = problem;
    }
    const retry = [...this.broken.keys()];
    const fixed: string[] = [];
    for (const sid of retry) {
      const b = this.broken.get(sid)!;
      try {
        this.engine.load(sid, readFileSync(b.file, "utf8"));
        this.broken.delete(sid);
        fixed.push(sid);
      } catch (err) {
        this.broken.set(sid, { ...b, why: message(err) });
      }
    }
    if (fixed.length && !this.journalProblem) this.commit(this.engine.resume(fixed, { now: this.clock() }));
    this.arm();
    return this.problems();
  }

  /** Retention (design §5.3): unload settled sessions idle a day with nothing pending; their snapshots
      are on disk, and an event or link notification to one loads it again first. */
  sweepCold(now = this.clock(), minAge?: number): string[] {
    if (this.closed || this.resuming) return [];
    const cold = this.engine.coldSessions(now, minAge ?? null);
    for (const sid of cold) this.engine.unload(sid);
    return cold;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Tests: remove this org's host-local state (a fresh clone+attach starts host-local sessions fresh). */
  static forgetLocal(orgId: string, stateDir: string): void {
    rmSync(hostPaths(orgId, "", stateDir).local, { recursive: true, force: true });
  }
}
