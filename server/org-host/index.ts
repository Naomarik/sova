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
import { join } from "node:path";
import {
  statechartInfo as statechartInfoOf,
  statechartVersions,
  createStatecharts,
  type SnapshotPeek,
  type EnabledEvent,
  type EngineOptions,
  type Hold,
  type InvocationRecord,
  type Json,
  type JsonObject,
  type Statecharts,
  type Refusal,
  type StampContext,
  type Step,
  type StepResult,
} from "../statecharts";
import { SAFETY_ACTS, type ActorBundle, type ActorRef, type EventId, type HistoryInput } from "../../shared/org-history";
import { OrgHistory } from "../org-history/service";
import type { Prepared } from "../org-history/record";
import { noteProblem } from "../org-history/store";
import { DEFAULT_REDACT, lastAt, readRows, rowOfStep, scrub, segmentFile, type LogProblem, type LogRow, type RedactRule, type RowFilter, type TornTail } from "./log";
import { applyJournal, commitJournal, hostPaths, journalId, JournalWriteError, missingOf, replayJournals, scanSnapshots, snapshotFile, writeAtomic, type HostPaths, type Journal, type JournalProblem } from "./store";

export type Envelope = Record<string, unknown>;

export interface ActResult {
  /** The statechart took the act (or holds it: `held`). */
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
  statechart: string | null;
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
  statechart: string;
  configuration: string[];
  data: Record<string, unknown>;
  running: boolean;
}

export interface HostChange {
  sessions: string[];
  steps: Step[];
}

/** What a caller knows about its act that the step can't: handed to
    the history composer with the act's own step, never with a timer's that fired first. */
export interface Provenance extends Pick<HistoryInput, "triggeredBy" | "parentKeys" | "relations" | "relationKeys" | "rationale" | "evidence"> {
  actors?: Partial<ActorBundle>;
  sourceKey?: string;
}

/** What kind of engine call a step came from. */
export type StepCall = "act" | "start" | "set-state" | "timers" | "resume" | "effect" | "invocation" | "rewindow" | "adopt" | "reload" | "log" | "record";

export interface ComposeContext {
  orgId: string;
  /** The recorded time of this commit. */
  at: number;
  journalId: string;
  call: StepCall;
  /** The call's own act (an act's step is found by session and event, never by position: due timers fire first). */
  act?: { sessionId: string; event: string };
  provenance?: Provenance;
  invocations: InvocationRecord[];
  outbox: Effect[];
  /** logAct's row, scrubbed (no step wrote it). */
  plain?: Record<string, Json>;
  /** An attribution the composer couldn't make cleanly: shown as a workspace problem, the step goes on. */
  onProblem(why: string): void;
}

/** Turns a call's steps into history inputs, inside the step's commit. Pure and synchronous; a throw is a
    history save failure (the act is refused, nothing changes). */
export type HistoryComposer = (steps: Step[], ctx: ComposeContext) => HistoryInput[];

/** A step saved in its journal but not applied to the files: not refused, it takes effect when the
    workspace reloads (or the host opens again). Nothing of it has started. */
export class PendingApplyError extends Error {
  readonly status = 409;
  readonly code = "pending-apply";
  constructor(readonly file: string) {
    super("Saved, but not applied yet: it takes effect when the workspace reloads.");
    this.name = "PendingApplyError";
  }
  get refusal(): Refusal {
    return { sentence: this.message, stage: "pending-apply", status: 409, code: "pending-apply" };
  }
}

/** History can't be saved: the act is refused whole. */
export class HistorySaveError extends Error {
  readonly status = 503;
  readonly code = "history";
  constructor(readonly why: string) {
    super(`History can't be saved right now: ${why}. Nothing was done.`);
    this.name = "HistorySaveError";
  }
  get refusal(): Refusal {
    return { sentence: this.message, stage: "history", status: 503, code: "history" };
  }
}

interface CallInfo {
  call: StepCall;
  act?: { sessionId: string; event: string };
  provenance?: Provenance;
}

export interface HostProblem {
  kind: "snapshot" | "journal" | "log" | "resume" | "timer" | "history";
  file: string;
  why: string;
  sessionId?: string;
}

/** `host`: the host stamping (set before open resolves, so a stamp during boot can read it). */
export type Stamp = (sid: string, event: string, payload: Record<string, unknown>, who?: StampContext, host?: OrgHost) => Envelope;

export interface OrgHostOptions {
  orgId: string;
  workspaceDir: string;
  /** Sova's state root: host-local statecharts live in `<stateDir>/statecharts/<orgId>/`. */
  stateDir: string;
  /** A fresh envelope for an act the engine delivers itself (a held act's release, a statechart's drive). */
  stamp?: Stamp;
  clock?: () => number;
  /** fsync journals and snapshots (default true; tests turn it off). */
  durable?: boolean;
  /** Sessions resumed per macrotask at open (default 50). */
  chunk?: number;
  /** Tests: more statecharts (JS trees), passed to the engine. */
  statecharts?: EngineOptions["statecharts"];
  /** Tests (kill-9 fuzz, save failures): called before the journal write, between it and applying it, and after applying it. */
  /** The history composer, from the first step of the open on (boot's resume and due timers included). */
  historyComposer?: HistoryComposer;
  commitHooks?: { beforeJournal?: () => void; afterJournal?: () => void; afterApply?: () => void; retryApply?: () => void };
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

/** A caller's bug, never a refusal: an act's payload key that the envelope also carries with another
    value (the engine sees them merged, so one would silently hide the other: baton/extend's `by`). */
export class OrgPayloadError extends Error {
  readonly code = "payload-shadows-envelope";
  constructor(readonly event: string, readonly keys: string[]) {
    super(`${event}: payload key${keys.length > 1 ? "s" : ""} ${keys.map((k) => `\`${k}\``).join(", ")} shadow${keys.length > 1 ? "" : "s"} the envelope's.`);
    this.name = "OrgPayloadError";
  }
}

/** An act's engine data: payload and envelope merged. A key in both with different values throws
    OrgPayloadError; equal values pass (a `reason` may be both). */
export function merged(event: string, payload: Record<string, unknown>, envelope: Envelope): JsonObject {
  const env = envelope as Record<string, unknown>;
  const clash = Object.keys(payload ?? {}).filter(
    (k) => env[k] !== undefined && payload[k] !== undefined && JSON.stringify(payload[k]) !== JSON.stringify(env[k]),
  );
  if (clash.length) throw new OrgPayloadError(event, clash);
  return { ...payload, ...envelope } as JsonObject;
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
  private readonly engine: Statecharts;
  private readonly durable: boolean;
  private readonly clock: () => number;
  private readonly storage = new Map<string, "portable" | "host-local">();
  private readonly redact = new Map<string, Record<string, RedactRule>>();
  /** Every session file known (warm or cold): sid → {file, statechart}. */
  private readonly index = new Map<string, { file: string; statechart: string }>();
  private readonly broken = new Map<string, HostProblem>();
  private journalProblem: JournalProblem | null = null;
  /** Sessions whose resume (or the past-due timers) threw at open: reported, boot went on. */
  private readonly stuck: HostProblem[] = [];
  /** Sessions whose due timer throws: a `timer` problem each, set aside in the engine (no call
      delivers their due events, so no retry loop and no failed acts) until one of their steps commits. */
  private readonly stalled = new Map<string, HostProblem>();
  private readonly logProblems: LogProblem[] = [];
  private resuming = true;
  private readyWaiters: (() => void)[] = [];
  private readonly effectHandlers = new Map<string, (effect: Effect) => Promise<unknown>>();
  private readonly runners = new Map<string, InvocationRunner>();
  private readonly running = new Map<string, Promise<EffectOutcome>>();
  /** Invocation reports on their way to a step. */
  private readonly reporting = new Set<Promise<void>>();
  private readonly listeners: ((change: HostChange) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private lastRowAt = 0;
  private readonly peeks = new Map<string, { mtime: number; peek: SnapshotPeek }>();
  private closed = false;
  /** The org's history: its events go in each step's own journal. */
  readonly history: OrgHistory;
  private composer: HistoryComposer | null = null;
  /** History can't be saved: every act but a safety act is refused until a probe or Reload finds it can. */
  private saveProblem: { why: string; since: number } | null = null;
  /** Torn last lines kept as they were, and attributions the composer flagged. */
  private readonly historyProblems: HostProblem[] = [];
  /** Effect and run answers waiting for history to be saveable again, oldest first. */
  private readonly waiting: (() => void)[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

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
      statechart: r.statechart,
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
    this.engine = createStatecharts({
      statecharts: opts.statecharts,
      loadCold: (sid) => this.loadCold(sid),
      stamp: (sid, event, payload, ctx) => (opts.stamp ? (opts.stamp(sid, event, payload, ctx, this) as JsonObject) : {}),
    });
    for (const c of statechartVersions()) this.storage.set(c.name, c.storage ?? "portable");
    for (const [name, c] of Object.entries(opts.statecharts ?? {})) this.storage.set(name, ((c as { storage?: string }).storage as "host-local") ?? "portable");
    this.history = new OrgHistory(opts.orgId, opts.workspaceDir, opts.stateDir, this.clock);
    this.composer = opts.historyComposer ?? null;
  }

  /** The capture adapters' composer (server/org-history-capture.ts), called inside every commit. */
  setHistoryComposer(fn: HistoryComposer | null): void {
    this.composer = fn;
  }

  /** A torn last line found before an append: cut on a replay (the journal holds it whole), else kept
      and shown as a workspace problem. */
  private readonly onTorn = (t: TornTail): void => {
    if (t.cut) return;
    this.historyProblems.push({ kind: "log", file: t.file, why: `its last line was cut short (${t.fragment.length} characters); it is kept as it is and the next line starts after it` });
    noteProblem(this.history.paths, { at: this.clock(), kind: "torn-tail", file: t.file, fragment: t.fragment });
  };

  private isSafety(call: CallInfo | undefined): boolean {
    const act = call?.act;
    if (!act || (call.call !== "act" && call.call !== "set-state")) return false;
    const statechart = this.statechartOfSid(act.sessionId);
    return SAFETY_ACTS.some((s) => s.event === act.event && (s.statechart === "*" || s.statechart === statechart));
  }

  /** Whether history can be saved again: the history and host-local dirs take a durable write. */
  private probeSaving(): boolean {
    const prev = this.saveProblem;
    if (!prev) return true;
    try {
      if (!this.history.isOpen) this.history.open();
      for (const dir of [this.history.paths.events, this.history.paths.local]) {
        const f = join(dir, `.probe.${process.pid}.tmp`);
        writeAtomic(f, "probe", this.durable);
        rmSync(f, { force: true });
      }
      this.saveProblem = null;
      // answers that waited go in at once now
      if (this.waiting.length) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryWaiting();
      }
      return true;
    } catch (err) {
      this.saveProblem = { since: prev.since, why: message(err) };
      return false;
    }
  }

  // ---- open ------------------------------------------------------------------------------------

  private async boot(chunk: number): Promise<void> {
    mkdirSync(this.paths.journal, { recursive: true });
    const { problem } = replayJournals(this.paths.journal, this.durable, this.onTorn);
    this.journalProblem = problem;
    // the history's index is loaded (or rebuilt) before any step, so a source key is never taken for new
    // while the index is unknown; one that can't open refuses acts like a save failure
    try {
      this.history.open();
    } catch (err) {
      this.saveProblem = { why: `its index can't be read (${message(err)})`, since: this.clock() };
    }
    this.lastRowAt = lastAt([this.paths.portableLog, this.paths.localLog]);
    const sids: string[] = [];
    let loaded = 0;
    for (const root of [this.paths.portable, this.paths.local]) {
      for (const { sid, statechart, file } of scanSnapshots(root)) {
        // loading is chunked like resume: no single blocking slice (C09)
        if (++loaded % chunk === 0) await new Promise<void>((r) => setImmediate(r));
        this.index.set(sid, { file, statechart });
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
        this.commitOrFail(r, { call: "resume" });
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
      for (const r of this.fireTimers((f) => {
        const r = f();
        this.commitOrFail(r, { call: "timers" });
        return r;
      }))
        started.push(...r.invocations);
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

  /**
   * Take sessions whose snapshot files were just copied into this engine's places (an import) into the
   * running engine, as boot would: indexed and loaded, resumed, their pending effects run, timers armed.
   * Every sid must have a file here and none may be known already, or nothing is taken; one that does
   * not load unloads the others (the files stay: the next open loads them). Log segments copied with
   * them are read like the engine's own; `at` stays unique past their rows.
   */
  async adopt(sids: string[]): Promise<void> {
    await this.ready();
    if (this.closed) throw new Error("The organization's engine is closed.");
    if (this.journalProblem) throw new OrgWorkspaceError(this.journalProblem.file);
    const known = sids.filter((sid) => this.index.has(sid) || this.engine.statechartOf(sid) != null);
    if (known.length) throw new Error(`Already in this engine: ${known.join(", ")}.`);
    const found = new Map<string, { file: string; statechart: string }>();
    for (const root of [this.paths.portable, this.paths.local]) for (const s of scanSnapshots(root)) if (sids.includes(s.sid)) found.set(s.sid, { file: s.file, statechart: s.statechart });
    const missing = sids.filter((sid) => !found.has(sid));
    if (missing.length) throw new Error(`No snapshot file here for ${missing.join(", ")}.`);
    const loaded: string[] = [];
    try {
      for (const sid of sids) {
        this.engine.load(sid, readFileSync(found.get(sid)!.file, "utf8"));
        loaded.push(sid);
      }
    } catch (err) {
      for (const sid of loaded) this.engine.unload(sid);
      throw new Error(`Not taken in: ${message(err)}`);
    }
    for (const sid of sids) this.index.set(sid, found.get(sid)!);
    this.lastRowAt = Math.max(this.lastRowAt, lastAt([this.paths.portableLog, this.paths.localLog]));
    this.step(() => this.engine.resume(sids, { now: this.clock() }), undefined, { call: "adopt" });
    for (const sid of sids) {
      const pending = (this.engine.data(sid)?.["sova/pending"] ?? {}) as Record<string, JsonObject>;
      for (const [key, e] of Object.entries(pending)) this.runEffect({ ...(e as Record<string, unknown>), key, sessionId: sid } as Effect);
    }
    // the resume's listeners named only the sessions that saved: every adopted one is new to them
    for (const fn of this.listeners)
      try {
        fn({ sessions: sids, steps: [] });
      } catch (err) {
        console.warn(`[org-host] change listener: ${message(err)}`);
      }
    this.arm();
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

  private statechartOfSid(sid: string): string {
    return this.engine.statechartOf(sid) ?? this.index.get(sid)?.statechart ?? sid.split("/")[0] ?? "unknown";
  }

  private isLocal(statechart: string | null | undefined): boolean {
    return this.storage.get(statechart ?? "") === "host-local";
  }

  private rulesOf(statechart: string | null | undefined): Record<string, RedactRule> {
    const name = statechart ?? "";
    let r = this.redact.get(name);
    if (!r) {
      const runtime = (this.opts.statecharts as Record<string, { redact?: Record<string, RedactRule> }> | undefined)?.[name]?.redact;
      const info = runtime ? null : statechartInfoOf(name);
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

  private logFileFor(statechart: string | null | undefined, at: number): string {
    return segmentFile(this.isLocal(statechart) ? this.paths.localLog : this.paths.portableLog, at);
  }

  /** Journal and apply one call's snapshots, log rows and history (synchronous): all of it, or a throw.
      `call` says what the call was; while history can't be saved only a safety act gets here, and it
      commits without history, covered by a capture gap. */
  private commit(r: StepResult, extra?: { startEnvelope?: Envelope }, call: CallInfo = { call: "act" }): void {
    const id = journalId(this.clock());
    const rows = r.steps
      .filter((s) => s.saved || s.refused || s.held)
      .map((s, i) => {
        const row = rowOfStep(this.orgId, s, this.rulesOf(s.statechart));
        if (s.event === "sova/started" && extra?.startEnvelope) {
          row.start = row.envelope;
          row.envelope = scrub(extra.startEnvelope, this.rulesOf(s.statechart));
        }
        row.at = this.uniqueAt(s.at);
        if (row.at !== s.at) row.t = s.at;
        row.j = id;
        row.k = `${id}:${i}`;
        return { file: this.logFileFor(s.statechart, row.at), row };
      });
    const snapshots = Object.entries(r.snapshots).map(([sessionId, text]) => {
      const statechart = this.statechartOfSid(sessionId);
      const file = snapshotFile(this.isLocal(statechart) ? this.paths.local : this.paths.portable, statechart, sessionId);
      return { sessionId, file, text, statechart };
    });
    const prepared = this.saveProblem ? null : this.prepareHistory(id, r.steps, call, { invocations: r.invocations, outbox: r.outbox as Effect[] });
    if (!rows.length && !snapshots.length && !prepared?.history.lines.length) return;
    const j: Journal = { id, at: this.clock(), snapshots: snapshots.map(({ sessionId, file, text }) => ({ sessionId, file, text })), rows, ...(prepared?.history.lines.length ? { history: prepared.history } : {}) };
    this.commitDurably(j);
    for (const s of snapshots) this.index.set(s.sessionId, { file: s.file, statechart: s.statechart });
    if (prepared) this.historyCommitted(prepared);
    else if (this.saveProblem && this.isSafety(call)) this.history.extendGap(this.saveProblem.since, this.clock());
  }

  /** The history of a commit: the composer's inputs (and an open capture gap's event first), prepared. */
  private prepareHistory(txn: string, steps: Step[], call: CallInfo, more: { invocations?: InvocationRecord[]; outbox?: Effect[]; plain?: Record<string, Json>; inputs?: HistoryInput[] } = {}): Prepared {
    const at = this.clock();
    const inputs: HistoryInput[] = [];
    const gap = this.history.openGap();
    if (gap) inputs.push(this.history.gapInput(gap, at));
    if (this.composer && (steps.length || more.plain))
      inputs.push(
        ...this.composer(steps, {
          orgId: this.orgId,
          at,
          journalId: txn,
          call: call.call,
          ...(call.act ? { act: call.act } : {}),
          ...(call.provenance ? { provenance: call.provenance } : {}),
          invocations: more.invocations ?? [],
          outbox: more.outbox ?? [],
          ...(more.plain ? { plain: more.plain } : {}),
          onProblem: (why) => {
            this.historyProblems.push({ kind: "history", file: this.history.paths.events, why });
            noteProblem(this.history.paths, { at, kind: "attribution", why });
          },
        }),
      );
    if (more.inputs) inputs.push(...more.inputs);
    return this.history.prepare(inputs, at, txn);
  }

  private historyCommitted(p: Prepared): void {
    if (p.events.some((e) => e.kind === "history.gap")) this.history.closeGap();
    try {
      this.history.afterCommit(p);
    } catch (err) {
      // the index is rebuildable: the next read refreshes it from the event files
      console.warn(`[org-host] ${this.orgId}: history index: ${message(err)}`);
    }
  }

  /** A commit that threw. Before its journal was written nothing is on disk: the sessions it touched are
      loaded again from their files, and acts are refused until history can be saved. After: the journal
      holds the whole step, so it stands, and the host waits for Reload to replay it. */
  private failed(r: StepResult | null, err: unknown): never {
    // saved in its journal: memory already matches what the journal will make of the disk
    if (err instanceof PendingApplyError) throw err;
    if (r) this.restore(r);
    const why = err instanceof JournalWriteError ? err.message : message(err);
    this.saveProblem = { why: why.length > 200 ? `${why.slice(0, 199)}…` : why, since: this.saveProblem?.since ?? this.clock() };
    console.warn(`[org-host] ${this.orgId}: history can't be saved: ${why}`);
    throw new HistorySaveError(this.saveProblem.why);
  }

  /** Commit a journal; when applying it fails after it was written, apply it once more here (replay:
      each row and event once, then checked). Still failing: the host waits for Reload, and the act's
      answer says it was saved, not refused. */
  private commitDurably(j: Journal): void {
    try {
      commitJournal(this.paths.journal, j, this.durable, this.opts.commitHooks, this.onTorn);
      return;
    } catch (err) {
      if (!(err instanceof JournalWriteError) || err.phase !== "apply") throw err;
      try {
        this.opts.commitHooks?.retryApply?.();
        applyJournal(j, this.durable, true, this.onTorn);
        const missing = missingOf(j);
        if (missing.length) throw new Error(`still missing ${missing[0]}`);
        rmSync(err.file, { force: true });
      } catch (again) {
        this.journalProblem = { file: err.file, why: `it was saved but not applied (${message(again)}); Reload applies it` };
        console.warn(`[org-host] ${this.orgId}: journal ${err.file} saved but not applied: ${message(again)}`);
        throw new PendingApplyError(err.file);
      }
    }
  }

  /** Memory back to disk for the sessions a failed step touched: reloaded from their snapshot files, or
      unloaded when the step made them (they have no file). */
  private restore(r: StepResult): void {
    for (const sid of Object.keys(r.snapshots)) {
      const known = this.index.get(sid);
      try {
        this.engine.unload(sid);
      } catch {
        // not loaded
      }
      if (known && existsSync(known.file))
        try {
          this.engine.load(sid, readFileSync(known.file, "utf8"));
        } catch (err) {
          this.broken.set(sid, { kind: "snapshot", file: known.file, why: message(err), sessionId: sid });
        }
    }
    this.arm();
  }

  private commitOrFail(r: StepResult, call: CallInfo): void {
    try {
      this.commit(r, undefined, call);
    } catch (err) {
      this.failed(r, err);
    }
  }

  /** A synchronous engine call, committed, then its effects, invocations, listeners and timer. */
  private step<R extends StepResult>(f: () => R, extra?: { startEnvelope?: Envelope }, call: CallInfo = { call: "act" }): R {
    if (this.closed) throw new Error("The organization's engine is closed.");
    if (this.journalProblem) throw new OrgWorkspaceError(this.journalProblem.file);
    if (this.saveProblem && !this.isSafety(call) && !this.probeSaving()) throw new HistorySaveError(this.saveProblem.why);
    const r = f();
    try {
      this.commit(r, extra, call);
    } catch (err) {
      this.failed(r, err);
    }
    this.after(r);
    return r;
  }

  private after(r: StepResult): void {
    for (const e of r.outbox) this.runEffect(e as Effect);
    for (const inv of r.invocations) this.runInvocation(inv);
    const sessions = [...new Set(r.steps.filter((s) => s.saved).map((s) => s.sessionId))];
    // a stalled session that stepped gets its timers back (armed below); one that throws again is stalled again
    if (sessions.some((sid) => this.stalled.delete(sid))) this.engine.setAside([...this.stalled.keys()]);
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
    if (this.closed || this.resuming || this.journalProblem) return;
    // history can't be saved: due timers wait (they fire, in order, once it can)
    if (this.saveProblem && !this.probeSaving()) {
      this.timer = setTimeout(() => this.fire(), 30_000);
      this.timer.unref?.();
      return;
    }
    // answers that waited go first: they answer work that already happened
    this.deliverWaiting();
    this.fireTimers((f) => this.step(f, undefined, { call: "timers" }));
    this.arm();
  }

  /** Fire what is due (stalled sessions' timers aside). When that throws, each due session alone: one
      that still throws is stalled (a `timer` problem), the others fire. `run` commits a call. */
  private fireTimers(run: (f: () => StepResult) => StepResult): StepResult[] {
    const now = this.clock();
    try {
      return [run(() => this.engine.fireDue(now))];
    } catch {
      const out: StepResult[] = [];
      // (a session already set aside is delivered nothing: firing it alone is a no-op)
      for (const sid of this.engine.dueSessions(now))
        try {
          out.push(run(() => this.engine.fireDue(now, { only: [sid] })));
        } catch (err) {
          console.warn(`[org-host] ${this.orgId}: ${sid}'s timer: ${message(err)}`);
          this.stalled.set(sid, { kind: "timer", file: this.index.get(sid)?.file ?? sid, why: message(err), sessionId: sid });
          // every call fires what is due first: without this, its timer would fail every act in the org
          this.engine.setAside([...this.stalled.keys()]);
        }
      return out;
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
        this.answerOrWait(() =>
          this.step(
            () => this.engine.send(e.sessionId, out.error == null ? "effect/done" : "effect/failed", out.error == null ? { key: e.key, result: (out.result ?? null) as Json } : { key: e.key, detail: out.error }, { now: this.clock() }),
            undefined,
            { call: "effect" },
          ),
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

  /** An effect's or a run's answer: the outside work already happened, so while history can't be saved
      the answer waits, in order, and goes in once saving works again (never lost, never twice). */
  private answerOrWait(deliver: () => void): void {
    if (this.waiting.length) {
      this.waiting.push(deliver);
      this.retryWaiting();
      return;
    }
    try {
      deliver();
    } catch (err) {
      if (!(err instanceof HistorySaveError)) throw err;
      this.waiting.push(deliver);
      this.retryWaiting();
    }
  }

  /** Deliver waiting answers once saving works; else look again in 30 s. */
  private retryWaiting(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.deliverWaiting();
    }, this.saveProblem ? 30_000 : 0);
    this.retryTimer.unref?.();
  }

  private deliverWaiting(): void {
    if (this.closed || this.journalProblem || !this.waiting.length) return;
    if (this.saveProblem && !this.probeSaving()) return this.retryWaiting();
    while (this.waiting.length) {
      const next = this.waiting[0]!;
      try {
        next();
      } catch (err) {
        if (err instanceof HistorySaveError) return this.retryWaiting();
        console.warn(`[org-host] ${this.orgId}: a waiting answer: ${message(err)}`);
      }
      this.waiting.shift();
    }
  }

  private runInvocation(rec: InvocationRecord): void {
    const inv: Invocation = { sessionId: rec.sessionId, invokeId: rec.runId ?? rec.invokeId, type: rec.type, ...(rec.params ? { params: rec.params } : {}) };
    const runner = this.runners.get(rec.type);
    if (rec.op === "stop") {
      runner?.stop(inv);
      return;
    }
    const report: InvocationReport = (outcome, detail, data) => {
      const p = (async () => {
        await this.ready();
        if (this.closed) return;
        try {
          const payload = { ...(data ?? {}), ...(detail ? { detail } : {}) } as JsonObject;
          this.answerOrWait(() => this.step(() => this.engine.send(inv.sessionId, outcomeEvent(inv.type, outcome), payload, { now: this.clock(), invokeId: inv.invokeId }), undefined, { call: "invocation" }));
        } catch (err) {
          console.warn(`[org-host] ${this.orgId}: reporting ${inv.type}: ${message(err)}`);
        }
      })();
      this.reporting.add(p);
      void p.finally(() => this.reporting.delete(p));
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
    // the step's hold carries no session id; a Hold does (as host.holds() lists it)
    if (mine.held) return { taken: true, held: { ...mine.held, sessionId: sid }, refusal: null, result: r };
    if (mine.ignored) return { taken: false, refusal: { sentence: "That can't be done now.", stage: "state" }, result: r };
    return { taken: true, refusal: null, result: r };
  }

  private guard<T extends ActResult>(f: () => T): T | ActResult {
    try {
      return f();
    } catch (err) {
      if (err instanceof OrgWorkspaceError || err instanceof HistorySaveError || err instanceof PendingApplyError) return { taken: false, refusal: err.refusal, result: null };
      throw err;
    }
  }

  /** Step an act now, synchronously (the share route's one synchronous stretch). Throws `busy` while resuming. */
  actNow(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope, opts: { provenance?: Provenance } = {}): ActResult {
    if (this.resuming) throw new OrgHostBusyError();
    return this.guard(() => {
      const r = this.step(() => this.engine.send(sid, event, merged(event, payload, envelope), { now: this.clock() }), undefined, {
        call: "act",
        act: { sessionId: sid, event },
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
      });
      return this.answer(sid, event, r);
    });
  }

  /** Step an act (after open finished). `settle`: resolve once this call's effects were answered. */
  async act(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope, opts: { settle?: boolean; provenance?: Provenance } = {}): Promise<ActResult> {
    await this.ready();
    const out = this.actNow(sid, event, payload, envelope, opts.provenance ? { provenance: opts.provenance } : {});
    if (opts.settle && out.result) out.effects = await this.settle(out.result);
    return out;
  }

  /** Resolves once no effect and no invocation report is in flight, including those they started. */
  async idle(): Promise<void> {
    while (this.running.size || this.reporting.size) await Promise.allSettled([...this.running.values(), ...this.reporting]);
  }

  /** Every effect `r` emitted, answered. */
  async settle(r: StepResult): Promise<EffectOutcome[]> {
    return Promise.all(r.outbox.map((e) => this.runEffect(e as Effect)));
  }

  async start(sid: string, statechart: string, data: Record<string, unknown>, envelope: Envelope = {}, opts: { provenance?: Provenance } = {}): Promise<StepResult> {
    await this.ready();
    return this.step(() => this.engine.start(sid, statechart, data as JsonObject, { now: this.clock() }), { startEnvelope: envelope }, {
      call: "start",
      act: { sessionId: sid, event: "sova/started" },
      ...(opts.provenance ? { provenance: opts.provenance } : {}),
    });
  }

  /** q9/r5 free set-state (the engine refuses anyone but the project overseer in an attended turn). */
  async setState(sid: string, change: { states: string[]; patch?: Record<string, unknown>; reason: string }, envelope: Envelope, opts: { provenance?: Provenance } = {}): Promise<ActResult> {
    await this.ready();
    return this.guard(() => {
      const r = this.step(() => this.engine.setState(sid, { states: change.states, patch: change.patch as JsonObject, reason: change.reason }, envelope as JsonObject, { now: this.clock() }), undefined, {
        call: "set-state",
        act: { sessionId: sid, event: "sova/set-state" },
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
      });
      return this.answer(sid, "sova/set-state", r);
    });
  }

  /** A log row for an act no statechart takes (note, idea, to-do, confirm). */
  async logAct(row: Record<string, unknown>, opts: { provenance?: Provenance } = {}): Promise<void> {
    this.writable();
    const at = this.uniqueAt(typeof row["at"] === "number" ? (row["at"] as number) : this.clock());
    const statechart = typeof row["statechart"] === "string" ? (row["statechart"] as string) : null;
    const id = journalId(this.clock());
    // `plain`: no statechart step wrote it (a log replay skips it)
    const full = { feed: "feed", ...(scrub(row, this.rulesOf(statechart)) as Record<string, Json>), at, org: this.orgId, plain: true, j: id, k: `${id}:0` } as LogRow;
    const call: CallInfo = { call: "log", ...(opts.provenance ? { provenance: opts.provenance } : {}) };
    try {
      const prepared = this.prepareHistory(id, [], call, { plain: full as Record<string, Json> });
      const j: Journal = { id, at, snapshots: [], rows: [{ file: this.logFileFor(statechart, at), row: full }], ...(prepared.history.lines.length ? { history: prepared.history } : {}) };
      this.commitDurably(j);
      this.historyCommitted(prepared);
    } catch (err) {
      this.failed(null, err);
    }
  }

  /** History with no statechart step (an observed merge, an abstention, a purge): one journal of its
      own. Returns each input's event id (an input whose key was recorded before answers that id). */
  async record(inputs: HistoryInput[]): Promise<EventId[]> {
    await this.ready();
    this.writable();
    const id = journalId(this.clock());
    try {
      const prepared = this.prepareHistory(id, [], { call: "record" }, { inputs });
      if (prepared.history.lines.length) {
        this.commitDurably({ id, at: this.clock(), snapshots: [], rows: [], history: prepared.history });
        this.historyCommitted(prepared);
      }
      // the gap event (when one was open) comes first; the ids answer the inputs
      return prepared.ids.slice(prepared.ids.length - inputs.length);
    } catch (err) {
      this.failed(null, err);
    }
  }

  /** Purge Reason…: the rationale file and its index words removed, and a
      purge event with no words, in one step. */
  async purgeRationale(eventId: EventId, by: ActorRef): Promise<EventId> {
    const [id] = await this.record([this.history.purgeInput(eventId, by)]);
    return id!;
  }

  /** Throws when nothing may be written now (closed, a journal problem, history can't be saved). */
  private writable(): void {
    if (this.closed) throw new Error("The organization's engine is closed.");
    if (this.journalProblem) throw new OrgWorkspaceError(this.journalProblem.file);
    if (this.saveProblem && !this.probeSaving()) throw new HistorySaveError(this.saveProblem.why);
  }

  /** r13: after a working-hours edit (a person's or the company's), move every hours wait to its new
      window. `windowOf(hold)` → the instant the act's people are next in hours, or null (in hours now:
      released at once). The release re-checks the act under a fresh stamp, so `stamp` must give the
      people's current hours. Each moved hold is one committed step; returns how many changed. */
  async rewindowHours(windowOf: (hold: Hold) => number | null): Promise<number> {
    await this.ready();
    let n = 0;
    for (const h of this.engine.holds(null).filter((x) => x.wait === "hours")) {
      const until = windowOf(h);
      if (until === h.until) continue;
      this.step(() => this.engine.send(h.sessionId, "sova/rewindow", { id: h.id, until } as JsonObject, { now: this.clock() }), undefined, { call: "rewindow" });
      n++;
    }
    return n;
  }

  /** The channel a released act waits for came back (the WhatsApp sender, §app.outreach/send): every outage
      wait is released now, each one committed step. The release re-checks the act under a fresh stamp, so one
      whose channel is still down waits again, to the same 24 h bound. Returns how many were released. */
  async releaseOutageWaits(): Promise<number> {
    await this.ready();
    let n = 0;
    for (const h of this.engine.holds(null).filter((x) => x.wait === "outage")) {
      this.step(() => this.engine.send(h.sessionId, "sova/rewindow", { id: h.id, until: null } as JsonObject, { now: this.clock() }), undefined, { call: "rewindow" });
      n++;
    }
    return n;
  }

  /** The earliest pending delayed event (the host's own timer follows it). */
  nextDueAt(): number | null {
    return this.engine.nextDueAt();
  }

  /** Fire everything due at `clock()` now (a virtual-clock replay; in production the host's timer does
      this itself). Throws busy while resuming. */
  fireDue(): StepResult {
    if (this.resuming) throw new OrgHostBusyError();
    return this.step(() => this.engine.fireDue(this.clock()), undefined, { call: "timers" });
  }

  // ---- reads -------------------------------------------------------------------------------------------

  trial(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): ActResult {
    try {
      const r = this.engine.trial(sid, event, merged(event, payload, envelope), { now: this.clock() });
      return { taken: r.taken, refusal: r.taken ? null : (r.refusalInfo ?? { sentence: r.refusal ?? "That can't be done now." }), result: r };
    } catch (err) {
      if (err instanceof OrgWorkspaceError) return { taken: false, refusal: err.refusal, result: null };
      throw err;
    }
  }

  explain(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): Refusal | null {
    return this.engine.explain(sid, event, merged(event, payload, envelope), { now: this.clock() });
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

  statechartOf(sid: string): string | null {
    return this.engine.statechartOf(sid) ?? this.index.get(sid)?.statechart ?? null;
  }

  statechartInfo(name: string): ReturnType<typeof statechartInfoOf> {
    return statechartInfoOf(name);
  }

  /** Every session of the org (of `statechart`): warm ones from the engine and, unless `warmOnly`, cold
      ones from their snapshots (lists keep settled batons, builds, decisions). Broken ones are not
      listed (they are in `problems()`). */
  sessions(statechart?: string, opts: { warmOnly?: boolean } = {}): SessionInfo[] {
    const warm = new Set(this.engine.sessions());
    const out: SessionInfo[] = [...warm]
      .filter((sid) => !statechart || this.engine.statechartOf(sid) === statechart)
      .map((id) => ({ id, statechart: this.engine.statechartOf(id) ?? "", configuration: this.engine.configuration(id) ?? [], data: this.engine.data(id) ?? {}, running: this.engine.running(id) }));
    if (!opts.warmOnly) {
      for (const [id, entry] of this.index) {
        if (warm.has(id) || (statechart && entry.statechart !== statechart)) continue;
        const p = this.peek(id);
        if (p) out.push({ id, statechart: p.statechart, configuration: p.configuration, data: p.data, running: p.running });
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
      ...this.stalled.values(),
      ...this.logProblems.map((p) => ({ kind: "log" as const, ...p })),
      ...(this.saveProblem ? [{ kind: "history" as const, file: this.history.paths.root, why: `history can't be saved: ${this.saveProblem.why}` }] : []),
      ...this.historyProblems,
    ];
  }

  onChange(fn: (change: HostChange) => void): void {
    this.listeners.push(fn);
  }

  /** Retry what did not load (the Workspace tab's Reload): a fixed journal, broken snapshots. */
  async reload(): Promise<HostProblem[]> {
    const hadJournalProblem = !!this.journalProblem;
    if (this.journalProblem) {
      const { problem } = replayJournals(this.paths.journal, this.durable, this.onTorn);
      this.journalProblem = problem;
    }
    // history: the index reopened (it may have been the problem), saving probed again, notes cleared
    this.historyProblems.splice(0);
    try {
      this.history.open();
      if (this.saveProblem) this.probeSaving();
    } catch (err) {
      this.saveProblem = { why: `its index can't be read (${message(err)})`, since: this.saveProblem?.since ?? this.clock() };
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
    if (!this.journalProblem) {
      // Resume again every session that is a problem, not only the files fixed now: a session whose
      // resume failed because another one couldn't load (a link/moved to the broken org) is fine by now.
      // Each alone, so one still failing never holds the others back.
      const again = [...new Set([...fixed, ...this.stuck.flatMap((p) => (p.sessionId ? [p.sessionId] : []))])];
      this.stuck.splice(0, this.stuck.length, ...this.stuck.filter((p) => !p.sessionId));
      for (const sid of again)
        try {
          this.commitOrFail(this.engine.resume([sid], { now: this.clock() }), { call: "reload" });
        } catch (err) {
          this.stuck.push({ kind: "resume", file: this.index.get(sid)?.file ?? sid, why: message(err), sessionId: sid });
        }
      // a session whose file was just fixed missed the notifications of those it watches: catch it up
      if (fixed.length)
        try {
          this.commitOrFail(this.engine.renotify(fixed, { now: this.clock() }), { call: "reload" });
        } catch (err) {
          console.warn(`[org-host] ${this.orgId}: renotify after reload: ${message(err)}`);
        }
      // and give stalled timers another go (one still throwing is stalled again, once)
      if (this.stalled.size) {
        this.stalled.clear();
        this.engine.setAside([]);
        this.fireTimers((f) => this.step(f, undefined, { call: "timers" }));
      }
      // a journal replayed now may hold a step whose effects never started
      if (hadJournalProblem) for (const kind of this.effectHandlers.keys()) this.runPending(kind);
    }
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.history.close();
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
